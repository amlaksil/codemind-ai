import { hasKeyword } from '../text/keywords.js';
import { listLike, MEASURED_RE } from '../ats/index.js';
import { claimsClearance } from './claims.js';
import { sameTerm } from './text.js';

/**
 * The requirements a score found weak or missing, each as a line for a prompt — kind, priority,
 * "measured" when a figure is what meets it, the verdict, and for a weak one why the line the
 * scorer quoted fell short (a bare term, a list of tools, no figure), since the fix is to that
 * line. `id` is the requirement's index in the score, so an answer can name it. The tailoring
 * prompt shows these as REQUIREMENT_VERDICTS; the gap pass asks one line per entry. A
 * nice-to-have is a gap only when `preferred` says so (the score-first mode, style.js): in the
 * others it is not written in on assumption (keywordRules).
 */
export function openRequirements(scoring, { allowedTerms = null, resumeText = '', preferred = false } = {}) {
  const list = Array.isArray(scoring?.requirements) ? scoring.requirements : [];
  const why = (r) => {
    if (r.verdict !== 'weak' || typeof r.quote !== 'string' || !r.quote.trim()) return '';
    const quote = r.quote.trim();
    const reasons = [];
    if (quote.split(/\s+/).length <= 3) reasons.push(`the scorer found only "${quote}", a bare term, not a line of work`);
    else if (listLike(quote)) reasons.push('the line it found only lists tools');
    if (MEASURED_RE.test(r.text) && !/\d/.test(quote)) reasons.push(reasons.length ? 'no figure' : 'the line states no figure');
    return reasons.length ? `: ${reasons.join('; and ')}` : '';
  };
  const measured = (r) => (MEASURED_RE.test(r.text) ? ', measured' : '');
  const requirements = list
    .map((r, id) => ({ r, id }))
    // A clearance or a work permit is a fact about the candidate, not a line anyone may write.
    .filter(({ r }) => r && typeof r.text === 'string' && r.text.trim() && r.verdict !== 'met' && (preferred || r.priority !== 'preferred') && !claimsClearance(r.text))
    .map(({ r, id }) => ({ id, line: `[${r.priority || 'required'} ${r.kind || 'experience'}${measured(r)}] ${r.text} — ${r.verdict || 'missing'}${why(r)}` }));
  // The job's skills the scorer finds only listed, or absent: shown in a line of work is met. A
  // skill the resume does not name is a gap only when it is one of the terms the tailoring may
  // write in (`allowedTerms`; null means any): the rest stay missing, and the fit is reported as it is.
  const mayWrite = (skill) => allowedTerms === null || hasKeyword(resumeText, skill) || allowedTerms.some((k) => sameTerm(k, skill));
  const required = Array.isArray(scoring?.requiredSkillVerdicts) ? scoring.requiredSkillVerdicts : [];
  // The job's nice-to-have skills are a tenth of the score (score/breakdown.js): a gap for the mode that writes those in.
  const niceToHave = preferred && Array.isArray(scoring?.preferredSkillVerdicts) ? scoring.preferredSkillVerdicts : [];
  const skills = [...required.map((s) => ({ s, priority: 'required' })), ...niceToHave.map((s) => ({ s, priority: 'preferred' }))]
    .map(({ s, priority }, i) => ({ s, priority, id: list.length + i }))
    .filter(({ s }) => s && typeof s.skill === 'string' && s.skill.trim() && s.verdict !== 'met' && mayWrite(s.skill))
    .map(({ s, priority, id }) => ({ id, line: `[${priority} skill] ${s.skill} — ${s.verdict === 'weak' ? 'weak: listed under skills, not shown in a line of work' : 'missing'}` }));
  return [...requirements, ...skills];
}

/**
 * The scoring with the gaps `ids` answered marked met, by the same numbering openRequirements
 * gives them: a requirement's index, then the required skills, then (with `preferred`) the
 * nice-to-haves. For a gap round that runs on the last score's verdicts rather than a fresh
 * score (pipeline.js scoreRounds 'ends'): what one round wrote a line for, the next does not
 * ask again. The score itself is not changed; only the real scorer moves it.
 */
export function markAnswered(scoring, ids, { preferred = false } = {}) {
  const answered = new Set((ids || []).filter(Number.isInteger));
  if (!answered.size || !scoring) return scoring;
  const list = Array.isArray(scoring.requirements) ? scoring.requirements : [];
  const required = Array.isArray(scoring.requiredSkillVerdicts) ? scoring.requiredSkillVerdicts : [];
  const niceToHave = preferred && Array.isArray(scoring.preferredSkillVerdicts) ? scoring.preferredSkillVerdicts : [];
  const met = (item, id) => (answered.has(id) && item ? { ...item, verdict: 'met' } : item);
  return {
    ...scoring,
    requirements: list.map((r, id) => met(r, id)),
    requiredSkillVerdicts: required.map((s, i) => met(s, list.length + i)),
    ...(preferred && { preferredSkillVerdicts: niceToHave.map((s, i) => met(s, list.length + required.length + i)) }),
  };
}
