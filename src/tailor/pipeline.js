import { quickScoreResume } from '../ats/service.js';
import { hasKeyword, keywordList, sameKeyword, uniqueKeywords } from '../text/keywords.js';
import { structuredResumeToText } from '../resume/structuredResume.js';
import { fillTailoringGaps, tailorResumeForm } from './service.js';
import { markAnswered } from './requirements.js';
import { postingTerms, splitAssumedTerms, tailorMode, tailorStyle, withoutCuts } from './index.js';

// The whole tailoring of one resume for one job, as the calls run it: the source scored (unless
// a score is handed in), the rewrite, the rewrite scored against the source's own verdicts, the
// cuts put back when they cost more than the rewording gained, then the mode's gap passes until
// the score reaches its target. What it returns is for the caller to store; nothing is saved here.

// The scorer moves 5-8 points on the same resume from one run to the next (17 prod pairs
// re-run, 2026-10-06), so a gap pass that fixed two verdicts was thrown away when its score
// landed a point lower. A pass is kept when the score rose, or when more requirements and
// skills are met and the score fell no further than the noise.
//
// `scoreRounds` is how often the scorer runs inside the loop. 'each' (the original) scores after
// every gap pass and keeps or drops the pass by that score: four scores for three passes. 'ends'
// scores the rewrite and the finished resume only: the passes run on the rewrite's verdicts,
// each marking the gaps it answered met for the next (requirements.js markAnswered), and the
// finished resume is kept over the rewrite by the same progress rule, once. Two scores instead
// of four, at the cost of the per-pass gate, which the scorer's own noise makes a weak one.
const SCORE_NOISE = 3;
export const SCORE_ROUNDS = ['each', 'ends'];
const metCount = (scoring) =>
  [...(scoring?.requirements || []), ...(scoring?.requiredSkillVerdicts || []), ...(scoring?.preferredSkillVerdicts || [])].filter((v) => v?.verdict === 'met').length;
/** True when the gap pass that produced `next` moved the tailoring forward from `prior`. */
export function gapPassProgressed(prior, next) {
  if (next.score > prior.score) return true;
  return metCount(next) > metCount(prior) && next.score >= prior.score - SCORE_NOISE;
}

/**
 * Tailor `form` (the source resume's structured form) for `job` (with its `requirements`).
 * `originalText` is everything the source resume says (its upload's text and its form), which
 * decides what it already has. `scoring` is its cached score for the job; without one it is scored
 * first, because the scorer's findings steer the rewrite. `confirmedKeywords` (missing keywords the
 * user says they have; null when not asked) limits added keywords to those, and `evidence` is what
 * they said about them ([{ keyword, role, note }]). `assumedKeywords` are missing keywords they
 * neither confirmed nor declined, `declinedKeywords` the ones they switched off. `style` is how far
 * the rewrite goes (style.js); `instructions` the user's own notes; `model` the tailoring model.
 * Returns { before, after, tailored, style, confirmed, candidates, assumed, assumedAll, split }.
 *
 * @param {{ form: import('../types.js').ResumeForm, originalText: string, job: import('../types.js').Job, scoring?: import('../types.js').Scoring | null, confirmedKeywords?: string[] | null, assumedKeywords?: string[], declinedKeywords?: string[], evidence?: object[], style?: import('../types.js').TailorStyle, instructions?: string, model: string, meta?: import('../types.js').CallMeta }} input
 * @returns {Promise<{ before: import('../types.js').Scoring, after: import('../types.js').Scoring, tailored: object, style: import('../types.js').TailorStyle, confirmed: string[], candidates: string[], assumed: string[], assumedAll: string[], split: object }>}
 */
export async function runTailoring({
  form,
  originalText,
  job,
  scoring = null,
  confirmedKeywords = null,
  assumedKeywords = [],
  declinedKeywords = [],
  evidence = [],
  style,
  instructions = '',
  model,
  meta = {},
  // 'flex' for a tailoring nobody is waiting on (Smart Apply): every call rides OpenAI's half-price tier.
  serviceTier,
  scoreRounds = 'each',
}) {
  const before = scoring || (await quickScoreResume(form, job, meta, { serviceTier }));

  // Every keyword the rewrite could be tempted to add. Asked and not confirmed means blocked.
  const confirmed = confirmedKeywords || [];
  const candidates = [...(job.skills || []), ...(job.preferredSkills || []), ...keywordList(before.missingKeywords || before.topMissingKeywords)];
  style = tailorStyle(style);
  const mode = tailorMode(style);
  const declined = (k) => declinedKeywords.some((d) => sameKeyword(d, k));
  // Left to the rewrite: everything the job asks for that the user did not switch off, not only
  // the chips that were on screen; not already in the resume, and not also confirmed.
  const offered = [...assumedKeywords, ...candidates.filter((k) => !declined(k))];
  const missing = uniqueKeywords(offered).filter((k) => !hasKeyword(originalText, k) && !confirmed.some((c) => sameKeyword(c, k)));
  // What the job requires, up to the mode's cap (terms.js splitAssumedTerms), is
  // `assumed`: score first writes every one in, the other modes the ones the resume's own work
  // makes plausible by their bar. A nice-to-have — a preferred skill, or a term only a preferred
  // requirement names — is `optional`, added where plausible in every mode. What the cap leaves
  // out is offered to nobody: twenty resumes read by another grader lost their realism exactly
  // where fourteen or more terms went in, for a tenth of the score. What is not a skill's name
  // ("GitCI/CD?") is never written in.
  const split = splitAssumedTerms(missing, { job, scoring: before, max: mode.maxAssumedTerms });
  // Score first forces the nice-to-haves in as well, after the required terms and within the
  // same cap: the job's preferred skills are a tenth of the score (ats/breakdown.js), and a
  // resume that names none of them tops out around 85 whatever else it says.
  const forced = mode.forceAssumed ? uniqueKeywords([...split.assumed, ...split.optional]).slice(0, mode.maxAssumedTerms) : split.assumed;
  const assumed = forced;
  const optional = split.optional.filter((k) => !forced.some((f) => sameKeyword(f, k)));
  const assumedAll = [...assumed, ...optional];
  const allowed = [...confirmed, ...assumedAll];
  const blockedKeywords = Array.isArray(confirmedKeywords)
    ? candidates.filter((k) => !hasKeyword(originalText, k) && !allowed.some((c) => sameKeyword(c, k)))
    : [];

  const request = { confirmedKeywords, blockedKeywords, evidence, style, instructions, model, meta, serviceTier };
  let tailored = await tailorResumeForm(form, job, { ...request, scoring: before, assumedKeywords: assumed, optionalKeywords: optional });

  // The rewrite is judged against the source's own verdicts, so its score moves only for what it changed.
  const beforeRequirements = typeof before.toObject === 'function' ? before.toObject().requirements : before.requirements;
  const prior = beforeRequirements?.length ? { requirements: beforeRequirements, resumeText: structuredResumeToText(form) } : null;
  let after = await quickScoreResume(tailored.form, job, meta, { prior, serviceTier });
  // A rewrite that scores below the resume it started from lost more by cutting than it gained
  // by rewording. Put the cuts back, keep the rewording, and keep whichever scores higher.
  if (after.score < before.score && tailored.changes.some((c) => c.kind === 'removed')) {
    const restored = withoutCuts(form, tailored.form, tailored.changes);
    const rescored = await quickScoreResume(restored.form, job, meta, { prior, serviceTier });
    if (rescored.score > after.score) {
      after = rescored;
      tailored.form = restored.form;
      tailored.changes = restored.changes;
    }
  }

  // Still short of the mode's target: one small call writes a line for each requirement the
  // score still finds weak or missing (gap.js), and the result stays when it scores
  // higher. Tailoring the whole resume again, measured, moved the score a point or two a roll;
  // this answers what is short by name. A failed call leaves the first attempt standing. The
  // terms the rewrite was offered are what the gap pass may write in too, by the mode's bar; the
  // terms it writes are in the lines it adds, each one listed under "What changed" to put back.
  // The mode's passes at most: each reaches what the one before did not, and the passes stop
  // when nothing goes in, or when the score does not rise more often than the mode tolerates
  // (score first rolls once more after a flat pass; the others stop).
  const gapOptions = (scoring) => ({
    scoring,
    confirmedKeywords: confirmed,
    evidence,
    assumedKeywords: assumedAll,
    protectedKeywords: [...(job.skills || []), ...(job.preferredSkills || []), ...postingTerms(job.description, keywordList(scoring.matchedKeywords))],
    style,
    model: request.model,
    meta,
    serviceTier,
  });

  if (scoreRounds === 'ends') {
    // The passes run on the rewrite's verdicts, each taking the gaps the one before answered
    // off the list; nothing is scored until the passes are done, and the finished resume stands
    // or the rewrite does, by one score.
    const rewrite = tailored;
    let verdicts = after;
    let applied = 0;
    for (let pass = 0; after.score < mode.target && pass < mode.gapPasses; pass += 1) {
      try {
        const filled = await fillTailoringGaps(tailored, form, job, gapOptions(verdicts));
        if (!filled.applied) break;
        tailored = filled;
        applied += filled.applied;
        verdicts = markAnswered(verdicts, filled.answered, { preferred: mode.preferredGaps });
      } catch {
        break; // the attempt so far stands
      }
    }
    if (applied > 0) {
      const final = await quickScoreResume(tailored.form, job, meta, { prior, serviceTier });
      if (gapPassProgressed(after, final)) after = final;
      else tailored = rewrite;
    }
    return { before, after, tailored, style, confirmed, candidates, assumed, assumedAll, split };
  }

  let flat = 0;
  for (let pass = 0; after.score < mode.target && pass < mode.gapPasses; pass += 1) {
    try {
      const filled = await fillTailoringGaps(tailored, form, job, gapOptions(after));
      if (!filled.applied) break;
      const rescored = await quickScoreResume(filled.form, job, meta, { prior, serviceTier });
      if (!gapPassProgressed(after, rescored)) {
        flat += 1;
        if (flat > mode.flatPasses) break;
        continue;
      }
      [tailored, after] = [filled, rescored];
    } catch {
      break; // the attempt so far stands
    }
  }

  return { before, after, tailored, style, confirmed, candidates, assumed, assumedAll, split };
}
