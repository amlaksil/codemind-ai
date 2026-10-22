import { AiError } from '../errors.js';
import { cleanStructuredResume, structuredResumeToText } from '../resume/structuredResume.js';
import { PROMPT_VERSIONS } from '../promptVersions.js';
import { complete } from '../llm/index.js';
import { tailorEffort, withFallback } from '../llm/routing.js';
import { applyGapLines, applyRepairs, buildGapPrompt, buildRepairPrompt, buildTailorPrompt, postingTerms, repairTargets, splitJobKeywords, tailoredResumeForm, tailorStyle } from './index.js';
import { GAP_RESPONSE_FORMAT, REPAIR_RESPONSE_FORMAT, TAILOR_RESPONSE_FORMAT } from './schema.js';

// The tailoring calls: the rewrite, its repair round, and the gap pass.

/**
 * Rewrite a resume form for a job. Returns the tailored form (the source's facts, the model's
 * wording — form.js), the job's keywords split by whether the source resume has them, and
 * suggestions. `scoring` is the source resume's score for this job, whose findings steer the
 * rewrite; `confirmedKeywords` (null when the user was not asked) limits what may be added,
 * `assumedKeywords` are missing ones the user left to the rewrite (added where plausible by
 * the mode's bar — or all of them, when `style` is 'ats': the score first, see style.js), and
 * `blockedKeywords` are the ones they declined; `evidence` is what they said about a confirmed
 * one ([{ keyword, role, note }]); `instructions` are the user's own style notes. `changes`
 * lists every experience bullet rewritten, added or removed.
 * A rewrite that kept none of the resume's roles is tried once more, cooler.
 *
 * @param {import('../types.js').ResumeForm} form
 * @param {import('../types.js').Job} job
 * @param {{ scoring?: import('../types.js').Scoring | null, confirmedKeywords?: string[] | null, assumedKeywords?: string[], optionalKeywords?: string[], evidence?: object[], blockedKeywords?: string[], instructions?: string, style?: import('../types.js').TailorStyle, model: string, meta?: import('../types.js').CallMeta }} [options]
 * @returns {Promise<{ form: import('../types.js').ResumeForm, changes: object[], droppedSkills: string[], estimates: object[], missingKeywords: string[], matchedKeywords: string[], suggestions: string[], promptVersion: string }>}
 */
export async function tailorResumeForm(
  form,
  job,
  { scoring = null, confirmedKeywords = null, assumedKeywords = [], optionalKeywords = [], evidence = [], blockedKeywords = [], instructions = '', style, model, meta = {}, serviceTier } = {}
) {
  style = tailorStyle(style);
  const prompt = buildTailorPrompt({ form, job, scoring, confirmedKeywords, assumedKeywords, optionalKeywords, evidence, instructions, style });
  const sourceText = structuredResumeToText(cleanStructuredResume(form));
  const reasoningEffort = tailorEffort(model);
  return withFallback(
    async ({ temperature }) => {
      const { data } = await complete(
        { model, reasoningEffort, system: prompt.system, user: prompt.user, json: true, responseFormat: TAILOR_RESPONSE_FORMAT, temperature, serviceTier },
        { ...meta, kind: 'tailor', promptVersion: PROMPT_VERSIONS.tailor }
      );
      // What the job asks for, by every account of it: a line or a skill that names one is kept.
      // The model's and the scorer's accounts count only where the posting's text bears them out.
      const protectedKeywords = [
        ...(job?.skills || []),
        ...(job?.preferredSkills || []),
        ...postingTerms(job?.description, [...(data?.jobKeywords || []), ...(scoring?.matchedKeywords || [])]),
      ].filter((k) => typeof k === 'string' && k.trim());
      const tailored = tailoredResumeForm(form, data?.resume, {
        confirmedKeywords,
        // Either kind may stand in a line, and either is listed for the user to keep or remove.
        assumedKeywords: [...assumedKeywords, ...optionalKeywords],
        evidence,
        blockedKeywords,
        protectedKeywords,
        style,
        headline: data?.headline,
        job,
      });
      if (!data?.resume || (tailored.form.experience.length > 0 && tailored.pairedExperience === 0)) {
        throw AiError.upstream('The model did not return a rewritten resume');
      }
      const final = await repairTailoring({ tailored, source: form, job, model, reasoningEffort, protectedKeywords, style, meta, serviceTier });
      return {
        form: final.form,
        changes: final.changes,
        droppedSkills: final.droppedSkills || [],
        estimates: final.estimates || [],
        ...splitJobKeywords(data.jobKeywords, sourceText),
        suggestions: Array.isArray(data.suggestions) ? data.suggestions.filter((t) => typeof t === 'string' && t.trim()) : [],
        promptVersion: PROMPT_VERSIONS.tailor,
      };
    },
    { model: { temperature: 0.4 }, fallbackModel: { temperature: 0.2 } }
  );
}

/**
 * The gap pass (gap.js): still short of the mode's target (`style`, style.js), one call writes
 * a line for each requirement `scoring` (the tailoring's own score) still finds weak or
 * missing, and the lines code accepts go into the tailoring. Returns the tailoring with
 * `applied`, how many lines went in — 0 when nothing was open or nothing passed; a failed call
 * throws, and the caller keeps the tailoring as it was. Recorded as the tailor prompt's "+gaps".
 *
 * @param {object} tailored A tailoring (tailorResumeForm's result).
 * @param {import('../types.js').ResumeForm} form The source resume.
 * @param {import('../types.js').Job} job
 * @param {{ scoring: import('../types.js').Scoring, confirmedKeywords?: string[], evidence?: object[], assumedKeywords?: string[], protectedKeywords?: string[], style?: import('../types.js').TailorStyle, model: string, meta?: import('../types.js').CallMeta }} options
 * @returns {Promise<object>} The tailoring with `applied`, how many lines went in, and `rejected`.
 */
export async function fillTailoringGaps(tailored, form, job, { scoring, confirmedKeywords = [], evidence = [], assumedKeywords = [], protectedKeywords = [], style, model, meta = {}, serviceTier }) {
  style = tailorStyle(style);
  // The skills it may write in: what the user confirmed and what the tailoring was allowed to assume.
  const prompt = buildGapPrompt({ tailoredForm: tailored.form, scoring, job, estimates: tailored.estimates, allowedTerms: [...confirmedKeywords, ...assumedKeywords], style });
  if (!prompt) return { ...tailored, applied: 0 };
  const { data } = await complete(
    { model, reasoningEffort: tailorEffort(model), system: prompt.system, user: prompt.user, json: true, responseFormat: GAP_RESPONSE_FORMAT, temperature: 0.3, serviceTier },
    { ...meta, kind: 'tailor', promptVersion: `${PROMPT_VERSIONS.tailor}+gaps` }
  );
  const requirements = Array.isArray(job?.requirements) ? job.requirements : [];
  const options = { confirmedKeywords, evidence, assumedKeywords, protectedKeywords, requirements, description: job?.description || '', style };
  let merged = applyGapLines(tailored, form, data, options);
  // A line refused for repeating the posting's wording is usually the right work in the
  // requirement's own phrase (the main refusal left on three prod cases once the figure and
  // length ones were fixed): one repair call rewords those lines, and the ones that come back
  // in the candidate's words go in after the rest. A failed repair leaves them out, as before.
  const copied = (merged.rejected || []).filter((r) => r.reason.startsWith('repeats the posting'));
  if (copied.length) {
    try {
      const lines = (Array.isArray(data?.lines) ? data.lines : []).filter((l) => copied.some((r) => r.id === l?.id));
      const targets = lines.map((l, id) => ({ id, role: l.role, text: l.text, problems: ['it repeats the posting\'s wording; say what the candidate did, naming the product or system, in their own words'] }));
      const prompt = buildRepairPrompt(targets, { style });
      const { data: fixed } = await complete(
        { model, reasoningEffort: tailorEffort(model), system: prompt.system, user: prompt.user, json: true, responseFormat: REPAIR_RESPONSE_FORMAT, temperature: 0.2, serviceTier },
        { ...meta, kind: 'tailor', promptVersion: `${PROMPT_VERSIONS.tailor}+gaps-repair` }
      );
      const byId = new Map((Array.isArray(fixed?.lines) ? fixed.lines : []).filter((l) => Number.isInteger(l?.id) && typeof l.text === 'string' && l.text.trim()).map((l) => [l.id, l.text]));
      // A reworded line keeps its estimate only where the clause survived the rewording.
      const reworded = lines
        .map((l, id) => (byId.has(id) ? { ...l, text: byId.get(id), estimate: typeof l.estimate === 'string' && byId.get(id).includes(l.estimate) ? l.estimate : '' } : null))
        .filter(Boolean);
      if (reworded.length) {
        const again = applyGapLines({ ...tailored, form: merged.form, changes: merged.changes, estimates: merged.estimates }, form, { lines: reworded }, options);
        merged = { ...again, applied: merged.applied + again.applied, rejected: [...merged.rejected.filter((r) => !copied.includes(r)), ...again.rejected] };
      }
    } catch {
      // the lines stay out
    }
  }
  return { ...tailored, form: merged.form, changes: merged.changes, estimates: merged.estimates, applied: merged.applied, rejected: merged.rejected };
}

/**
 * One repair round over a tailoring (repair.js): the lines the model wrote that read badly are
 * sent back once, and the fixes code accepts replace them. No extra call when nothing is
 * flagged; a failed call leaves the tailoring as it was. Recorded as the tailor prompt's
 * "+repair" version, so its cost shows on its own.
 */
async function repairTailoring({ tailored, source, job, model, reasoningEffort, protectedKeywords, style, meta, serviceTier }) {
  const requirements = Array.isArray(job?.requirements) ? job.requirements : [];
  const description = job?.description || '';
  const targets = repairTargets(tailored, source, { requirements, description, style });
  if (!targets.length) return tailored;
  try {
    const prompt = buildRepairPrompt(targets, { style });
    const { data } = await complete(
      { model, reasoningEffort, system: prompt.system, user: prompt.user, json: true, responseFormat: REPAIR_RESPONSE_FORMAT, temperature: 0.2, serviceTier },
      { ...meta, kind: 'tailor', promptVersion: `${PROMPT_VERSIONS.tailor}+repair` }
    );
    const repaired = applyRepairs(tailored, targets, data, { protectedKeywords, requirements, description, style });
    return repaired.repaired ? { ...tailored, form: repaired.form, changes: repaired.changes } : tailored;
  } catch {
    return tailored;
  }
}
