import { AiError } from '../errors.js';
import { supportedYears } from '../checks/index.js';
import { jobPostingBlock } from '../text/fence.js';
import { PROMPT_VERSIONS } from '../promptVersions.js';
import { complete } from '../llm/index.js';
import { withFallback } from '../llm/routing.js';
import { models } from '../runtime.js';
import { interpretScoreAnswer } from './interpret.js';
import { buildScorePrompt } from './prompt.js';
import { pickRequirementItems } from './requirements.js';
import { JOB_REQUIREMENTS_RESPONSE_FORMAT, SCORE_RESPONSE_FORMAT } from './schema.js';

// The scoring calls: a posting's requirements read once, and a resume judged against them.

/**
 * What a cached score was produced by: the prompt version and the model. Stored on every
 * match row and compared on read, so a prompt or model change never serves an old-scale
 * number next to a new one.
 */
export function scoreVersion() {
  return `${PROMPT_VERSIONS.score}/${models().ats.model}`;
}

// Scoring runs the ATS model at temperature 0 (a reasoning model ignores that and takes the
// effort level instead), and tries the fallback model once when the call fails.
function scoreTries() {
  const { model, fallbackModel, effort, fallbackEffort } = models().ats;
  return {
    model: { model, reasoningEffort: effort },
    fallbackModel: fallbackModel && fallbackModel !== model ? { model: fallbackModel, reasoningEffort: fallbackEffort } : null,
  };
}

/**
 * Score a résumé against a job: 0-100 plus per-category breakdown, the keywords that drove it,
 * the requirements it lacks and what could be emphasized. `resume` is the saved form (an
 * object) or, for a tailored résumé, its text. `job` is a pool job, or any object with a
 * `description` (plus `title`, `skills`, `preferredSkills`… when known).
 *
 * @param {import('../types.js').ResumeForm | string} resume The saved form, or a tailored resume's text.
 * @param {import('../types.js').Job} job
 * @param {import('../types.js').CallMeta} [meta]
 * @param {{ prior?: { requirements: object[], resumeText: string } | null, serviceTier?: string }} [options] The source's own verdicts, for a rewrite's score; `serviceTier: 'flex'` for work nobody is waiting on (llm/complete.js).
 * @returns {Promise<import('../types.js').Scoring>}
 */
export async function quickScoreResume(resume, job, meta = {}, { prior = null, serviceTier } = {}) {
  const prompt = buildScorePrompt({ resume, job });
  const form = typeof resume === 'string' ? null : typeof resume?.toObject === 'function' ? resume.toObject() : resume;
  return withFallback(async ({ model, reasoningEffort }) => {
    const { data } = await complete(
      {
        model,
        reasoningEffort,
        system: prompt.system,
        user: prompt.user,
        json: true,
        responseFormat: SCORE_RESPONSE_FORMAT,
        temperature: 0,
        serviceTier,
      },
      { ...meta, kind: 'score', promptVersion: PROMPT_VERSIONS.score }
    );
    // An answer that skips most of the requirements would score them all missing; the fallback runs instead.
    const answered = new Set((Array.isArray(data?.verdicts) ? data.verdicts : []).map((v) => v?.id));
    if (prompt.requirements.length && prompt.requirements.filter((_, id) => answered.has(id)).length < prompt.requirements.length / 2) {
      throw AiError.upstream('The model did not judge the requirements');
    }
    const result = interpretScoreAnswer(data, { job, resume: form, resumeText: prompt.resumeText, requirements: prompt.requirements, supportedYears: form ? supportedYears(form) : null, prior });
    // Nothing to judge at all would otherwise read as 0.
    if (result.score === null) throw AiError.upstream('The model did not return a complete score');
    return { ...result, model };
  }, scoreTries());
}

const JOB_REQUIREMENTS_PROMPT = `List what this job posting asks of a candidate: its named skills, and its other requirements.

- required: named languages, frameworks, libraries, databases, platforms, tools and methods the posting requires or lists as what the person will work with.
- preferred: only the ones the posting itself marks as optional — nice to have, preferred, a plus, a bonus. When the posting marks no skill as optional, preferred is empty; a skill from a requirements sentence is required, however loosely it is worded.
- A category ("relational databases", "cloud platforms") is listed only when the posting names no specific product for it, and goes in the same list as the sentence it came from.
- One skill per item, 1-3 words, spelled as the posting spells it ("Node.js", "React Native", "CI/CD"). Split lists: "Jest and Cypress" is two items.
- Named things only. No soft skills, no years of experience, no degrees, no responsibilities ("mentoring", "code review"), no benefits.
- A skill appears once; if it is both required and preferred, it is required.
- items: every other requirement a candidate is judged on, most important first, at most 30:
  - experience: years or depth of experience, and domain or industry experience ("5+ years building backend services", "experience with payments or fintech").
  - responsibility: what the person will do, as it tests a candidate's past work ("design and run distributed systems in production", "lead a team of engineers"). A posting's duties and success metrics are requirements too: a candidate is judged on having done them, so they are not left out for its experience lines.
  - education: a degree, field of study or certification the posting asks for.
  Each one short statement, 4-15 words, in the posting's own words. priority is required unless the posting marks it optional (nice to have, preferred, a plus). Never a named skill on its own (those are the lists above), a soft skill (communication, teamwork, ownership), a benefit, or a fact about the company.`;

/**
 * What a posting asks of a candidate, read from its description: the required and preferred
 * skills (the anchor for a job with no structured skills), and `items`, its other requirements
 * [{ text, kind, priority }], which the scorer judges. The caller caches the answer, so a job is
 * read once.
 *
 * @param {import('../types.js').Job} job
 * @param {import('../types.js').CallMeta} [meta]
 * @returns {Promise<{ required: string[], preferred: string[], items: import('../types.js').Requirement[], version: string, model: string }>}
 */
export async function extractJobRequirements(job, meta = {}, { serviceTier } = {}) {
  const list = (value) => (Array.isArray(value) ? [...new Set(value.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))] : []);
  return withFallback(async ({ model, reasoningEffort }) => {
    const { data } = await complete(
      {
        model,
        reasoningEffort,
        system: 'You read job postings and list what they ask of a candidate. Respond with JSON only.',
        user: `${JOB_REQUIREMENTS_PROMPT}\n\nJOB TITLE: ${job?.title || 'Not specified'}\n\nJOB_DESCRIPTION:\n${jobPostingBlock(job?.description || '', 8000)}`,
        json: true,
        responseFormat: JOB_REQUIREMENTS_RESPONSE_FORMAT,
        temperature: 0,
        serviceTier,
      },
      { ...meta, kind: 'job_requirements', promptVersion: PROMPT_VERSIONS.jobRequirements }
    );
    const required = list(data?.required);
    const KINDS = ['experience', 'responsibility', 'education'];
    const items = pickRequirementItems(
      (Array.isArray(data?.items) ? data.items : [])
        .filter((i) => typeof i?.text === 'string' && i.text.trim() && KINDS.includes(i.kind))
        .map((i) => ({ text: i.text.trim().slice(0, 200), kind: i.kind, priority: i.priority === 'preferred' ? 'preferred' : 'required' }))
    );
    return {
      required,
      preferred: list(data?.preferred).filter((s) => !required.some((r) => r.toLowerCase() === s.toLowerCase())),
      items,
      version: PROMPT_VERSIONS.jobRequirements,
      model,
    };
  }, scoreTries());
}
