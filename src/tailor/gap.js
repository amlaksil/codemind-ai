import { hasKeyword } from '../text/keywords.js';
import { cleanListItem, cleanStructuredResume, structuredResumeToText } from '../resume/structuredResume.js';
import { compact, listLike } from '../ats/index.js';
import { MAX_BULLET_CHARS } from '../checks/index.js';
import { aiTellWords, RESUME_VOICE_RULES } from '../text/voice.js';
import { fieldNotesFor } from './fieldNotes.js';
import { losesEvidence } from './bullets.js';
import { claimsClearance, claimsCredential, inventsFact, TENURE_RE, TENURE_WORDS_RE } from './claims.js';
import { copiedRequirement, echoesRequirement } from './copied.js';
import { estimateClause, overstatedEstimate, sameFigure, withEstimate, withoutEstimate } from './estimates.js';
import { tailoringSources } from './form.js';
import { openRequirements } from './requirements.js';
import { PLAUSIBLE_BY_STYLE, tailorMode, tailorStyle } from './style.js';
import { crossesPlatform, gluedTerm, tooManyTerms } from './terms.js';
import { lower, termsIn } from './text.js';

// ── Gap pass ───────────────────────────────────────────────────────────────
//
// Still short of the mode's target after the rewrite (style.js): tailoring the whole resume
// again re-rolls everything and, measured, moves the score a point or two. What is short is
// known exactly — the scorer's verdicts name each requirement still weak or missing, and why —
// so one small call writes one line per requirement, each tied to a bullet of the tailored
// resume, and code checks and merges the lines as it checks a rewrite: no fact the resume does
// not state, no list of tools, no requirement sentence pasted, a figure only as an estimate.

/** How long a gap line may run before it is refused; the prompt asks for MAX_BULLET_CHARS. */
export const MAX_GAP_LINE_CHARS = Math.round(MAX_BULLET_CHARS * 1.2);

const GAP_SYSTEM_PROMPT =
  "You extend a tailored resume so it meets the requirements it still falls short of. You write in the candidate's own voice about the work their resume describes. Respond with JSON only.";

// How far a line may reach for a term the resume lacks, by mode: the score-first mode writes
// the gap in; the others only where the resume's work makes the term plausible, by their bar.
const REACH_BY_STYLE = {
  ats: "The candidate chose the score first: a gap a line of work can meet is written in, with the term the requirement names, wherever the role's work could have used it.",
  balanced: `The candidate chose a resume a reader believes: a gap is written in only where the candidate's own work makes it plausible, and otherwise skipped. ${PLAUSIBLE_BY_STYLE.balanced.replace(/\n/g, ' ')}`,
  realistic: `The candidate chose a resume that looks real first: a gap is written in only on the resume's own lines, and a term the resume lacks only where a bullet nearly names it already; otherwise skip it. ${PLAUSIBLE_BY_STYLE.realistic.replace(/\n/g, ' ')} At most one new bullet in a role; extend an existing one wherever it can carry the line.`,
};

/**
 * The gap pass prompt, or null when the score leaves nothing open. `tailoredForm` is the resume
 * as tailored (its bullets are what a line extends), `scoring` its score, `style` the mode
 * (style.js): the score-first one counts a nice-to-have as a gap, and each mode sets how far a
 * line may reach for a term the resume lacks.
 */
export function buildGapPrompt({ tailoredForm, scoring, job = null, estimates = [], allowedTerms = null, style }) {
  const mode = tailorMode(style);
  const open = openRequirements(scoring, { allowedTerms, resumeText: structuredResumeToText(tailoredForm || {}), preferred: mode.preferredGaps });
  if (!open.length) return null;
  // The figures the resume already states as estimates: a line's figure is of something else, or
  // the program takes it as the same figure said twice and strips it.
  const stated = (estimates || []).map((e) => e?.clause).filter(Boolean);
  const roles = (tailoredForm?.experience || []).map((e, role) => ({
    role,
    company: e.company,
    title: e.title,
    period: e.period,
    bullets: (e.achievements || []).map((text, i) => ({ i, text })),
  }));
  const user = `Extend the tailored resume so it meets each requirement under GAPS.

RESUME (the tailored resume's experience; every bullet has its index "i" within its role):
${JSON.stringify(compact(roles) || [])}

GAPS (the scorer's verdict on each requirement the resume does not yet meet, and why):
${open.map(({ id, line }) => `${id}. ${line}`).join('\n')}
${stated.length ? `\nFIGURES ALREADY STATED (each is said once; a line's figure is of something else — one of the field's measures):\n${stated.map((c) => `- ${c}`).join('\n')}\n` : ''}
${fieldNotesFor(job)}

Rules:
- One line per gap, as { id, role, from, text, estimate }: "role" is the role it goes in (the most recent role that does that kind of work); "from" is the "i" of the bullet it extends — the bullet that comes closest to the requirement — and "text" the whole bullet as it should now read; or "from" is null and "text" a new bullet, when no bullet comes close.
- No two lines extend the same bullet: the second would overwrite the first. When two gaps fit one bullet, answer both in that one line, or take the next-closest bullet, or a new one.
- The line is a real piece of work, not the requirement said back. It names the specific thing from this role — the product, pipeline, service, dataset, client or release the role's other bullets name — says what was done to it, and how, with the requirement's term as the tool or method used once. The program refuses a line that shares the requirement's words and names nothing of the role's own. Not: "Participated in Agile teams and Software Development Lifecycle practices to iterate over design and development cycles" (the posting paraphrased). But: "Ran two-week sprints for the reporting pipeline with the analytics lead, shipping a release each sprint and reviewing every data-model change." Not: "Used AI-assisted development tools to draft and inspect application code" but: "Drafted the caller-ID service's migration scripts with Copilot, then verified each against the Postgres schema and the existing tests before release." In the same voice and length as the bullets around it: one sentence, under 30 words and ${MAX_BULLET_CHARS} characters (the program refuses a longer one), opening with the action. At most two technologies the bullet did not already name; never a list of tools; never the requirement's adjectives ("judiciously", "strong", "comfortable", "extensive").
- A requirement about the size or kind of organization, years in a field, or a frame of mind ("comfort with ambiguity") is not a line to write: the roles as they stand answer it, or nothing does. Skip it.
- A bullet that ends with a figure clause ("…, cutting failed uploads by ~30%") keeps that clause word for word at its end: the figure is the candidate's to edit, and a line without it is put back with it.
- Nothing the resume does not state: no employer, title, date, team size, customer, certification or number — except a figure for a requirement marked "measured", which the line must state: exactly one figure, realistic and modest (10-30%, with "~" or "about"; or a count or a time — a count or a time rather than another percentage when the role already states two), of the thing the requirement measures, as a clause at the end of the line, copied exactly into "estimate" ("cutting deployment lead time by ~20%"). Two figures in one line, or a bare "~20%" in "estimate", and the line is thrown away. Every other line's "estimate" is "". A bullet that already carries a figure takes no second one, and a figure is not put on the bullet next to one that has a figure: extend it without a figure, or extend another.
- A verdict that says why a line fell short (a bare term, a list of tools, no figure) is fixed on that line: "from" is that bullet.
- A skill gap ("[required skill]") is met by naming the skill in the bullet whose work used it, as the tool it was done with — at most two skills to a bullet, and never a bullet that is a list of them.
- Skip a requirement about years in a field, and one already met by a line you write for another gap. Skip a requirement that names a product, platform or certification the resume shows no sign of (a service mesh, an internal developer platform, a CKA) — that would be inventing a career — and one about a clearance, citizenship or work authorisation. A skill goes on a bullet whose platform and language could have used it, never on one about another (no XCTest on an Android bullet). A duty FIELD_NOTES lists, which anyone operating the resume's own systems would have done — cost, on-call, monitoring targets, incident follow-up — gets a line about those systems; a measured one gets one of the field's measures.
- ${REACH_BY_STYLE[tailorStyle(style)]}
${RESUME_VOICE_RULES}

JOB: ${job?.title || 'Not specified'}${job?.company ? ` at ${job.company}` : ''}`;
  return { system: GAP_SYSTEM_PROMPT, user, open };
}

/**
 * The gap pass's lines checked and merged into a tailoring: each one extends the bullet it
 * names (its change record follows, so it can still be put back) or is added to its role; a
 * figure stands as an estimate within the score-first budget and otherwise comes off; a line
 * that states a fact the resume does not, lists tools, repeats a requirement, loses what the
 * job asks for, or reads as AI-written is dropped. Returns { applied, form, changes, estimates }.
 */
export function applyGapLines(tailored, sourceForm, answer, { confirmedKeywords = [], evidence = [], assumedKeywords = [], protectedKeywords = [], requirements = [], description = '', style } = {}) {
  const mode = tailorMode(style);
  const limits = { perLine: mode.maxTermsPerLine, perRole: mode.maxTermsPerRole };
  const sources = tailoringSources(cleanStructuredResume(sourceForm), confirmedKeywords, evidence);
  const form = { ...tailored.form, experience: tailored.form.experience.map((e) => ({ ...e, achievements: [...e.achievements] })) };
  const changes = (tailored.changes || []).map((c) => ({ ...c }));
  const estimates = (tailored.estimates || []).map((e) => ({ ...e }));
  let left = mode.maxEstimates - estimates.length;
  let applied = 0;
  const done = new Set();
  // Each line the merge refused, with why: for the bench and the logs, never stored.
  const rejected = [];
  const refuse = (line, reason) => rejected.push({ id: line.id, text: String(line.text || '').slice(0, 160), reason });
  // The lines a role may gain from no bullet, counting those the rewrite already gave it (bullets.js).
  const newLines = (role) => changes.filter((c) => c.role === role && c.kind === 'added').length;
  // Years in a field are the roles' titles and dates, which no line may restate ("across more
  // than eight years of infrastructure work"): a gap for such a requirement is not written, and a
  // line that states a tenure is not taken whatever gap it answers.
  const requirementOf = (id) => (Number.isInteger(id) ? requirements[id] : null);
  const requirementText = (req) => (typeof req === 'string' ? req : req.text || '');
  const yearsGap = (id) => {
    const req = requirementOf(id);
    return Boolean(req) && TENURE_RE.test(requirementText(req));
  };
  // A degree or a certification is a fact of the resume, never a line to write: an education gap
  // stays open, and a line that claims a credential is not taken whatever gap it answers.
  const educationGap = (id) => requirementOf(id)?.kind === 'education';
  // A clearance or a work permit the same: never written, whatever gap the line answers.
  const clearanceGap = (id) => {
    const req = requirementOf(id);
    return Boolean(req) && claimsClearance(requirementText(req));
  };
  for (const line of Array.isArray(answer?.lines) ? answer.lines : []) {
    if (!line || !Number.isInteger(line.role) || !form.experience[line.role] || typeof line.text !== 'string') continue;
    if (done.has(line.id)) {
      refuse(line, 'gap already answered');
      continue;
    }
    if (yearsGap(line.id) || educationGap(line.id) || clearanceGap(line.id)) {
      refuse(line, 'gap no line may answer (years, education, clearance)');
      continue;
    }
    if (TENURE_RE.test(line.text) || TENURE_WORDS_RE.test(line.text) || claimsCredential(line.text) || claimsClearance(line.text)) {
      refuse(line, 'states a tenure, credential or clearance');
      continue;
    }
    const role = form.experience[line.role];
    let text = cleanListItem(line.text);
    // A gap line runs long: it is a bullet with one more thing said. The prompt asks for
    // MAX_BULLET_CHARS; a fifth over that still reads, and 11 of 40 lines on three prod cases
    // were refused for 202-249 characters.
    if (!text || text.length > MAX_GAP_LINE_CHARS) {
      refuse(line, `empty or over ${MAX_GAP_LINE_CHARS} characters (${text.length})`);
      continue;
    }
    // The figure, if any, is judged as an estimate; the line is judged without it. A model that
    // copies only the figure ("about 20%") would leave "…reducing lead time by." when the estimate
    // comes off, so the clause is the bullet's last clause when that is where the figure is.
    const given = typeof line.estimate === 'string' && /\d/.test(line.estimate) ? line.estimate.trim() : '';
    const cut = given ? text.lastIndexOf(', ') : -1;
    const tail = cut >= 0 ? text.slice(cut + 2).replace(/\.$/, '') : '';
    const clause = given && tail.includes(given) ? tail : given;
    const plain = clause ? withoutEstimate(text, clause) : null;
    if (clause && !plain) {
      refuse(line, 'the estimate clause is not in the line');
      continue;
    }
    const from = Number.isInteger(line.from) && role.achievements[line.from] !== undefined ? line.from : null;
    const before = from !== null ? role.achievements[from] : '';
    // A bullet that already carries an estimate keeps it, and takes no second figure.
    const existing = from !== null ? estimates.find((e) => e.role === line.role && e.text === before) : null;
    const repeated = Boolean(clause) && estimates.some((e) => sameFigure(e.clause, clause));
    // Where the line will sit, and whether a figure already sits beside it (traceBullets keeps figures apart the same way).
    const touched = role.achievements.map((b, i) => (changes.some((c) => c.role === line.role && c.kind !== 'removed' && c.after === b) ? i : -1));
    const insertAt = Math.max(-1, ...touched) + 1 > 0 ? Math.max(-1, ...touched) + 1 : role.achievements.length;
    const hasFigure = (i) => role.achievements[i] !== undefined && estimates.some((e) => e.role === line.role && e.text === role.achievements[i]);
    const beside = from !== null ? [from - 1, from + 1] : [insertAt - 1, insertAt];
    const crowded = beside.some(hasFigure);
    const stands = Boolean(clause) && !existing && left > 0 && !overstatedEstimate(clause) && !repeated && !crowded;
    if (clause && !stands) text = plain;
    let judged = stands ? plain : text;
    if (existing) {
      // The bullet's figure is the candidate's to edit, so its clause stays where it was. A
      // line that rewrote the bullet without it gets it back at its end — the commonest drop
      // of a Balanced pass before (14 of 40 lines on three prod cases), since the model is shown
      // the bullet with the figure and writes the work without it — unless the line brought a
      // figure of its own, which would put two on one bullet.
      const kept = withoutEstimate(judged, existing.clause);
      if (kept) judged = kept;
      else if (clause || /\d/.test(judged)) {
        refuse(line, "dropped the bullet's existing estimate clause for a figure of its own");
        continue;
      } else {
        text = withEstimate(text, existing.clause);
      }
    }
    const copied = copiedRequirement(text, requirements, description);
    const tells = aiTellWords(text);
    if (inventsFact(judged, sources) || listLike(text) || copied || tells.length) {
      refuse(line, inventsFact(judged, sources) ? 'states a fact the resume does not' : listLike(text) ? 'reads as a list of tools' : copied ? `repeats the posting ("${copied.slice(0, 60)}")` : `AI-tell words: ${tells.join(', ')}`);
      continue;
    }
    // The requirement paraphrased, with nothing of the role's own work in it (copied.js): not experience.
    const sourceRole = cleanStructuredResume(sourceForm).experience[line.role];
    const echoed = echoesRequirement(text, requirements, (sourceRole?.achievements || []).join('\n'), { before });
    if (echoed) {
      refuse(line, `repeats the posting ("${echoed.slice(0, 60)}") without the role's own work`);
      continue;
    }
    // Assumed terms: at most a line's share of new ones, a role's share in all (terms.js), and
    // none of another platform's on a bullet about this one.
    const roleTerms = new Set(role.achievements.flatMap((b, i) => (i === from ? [] : termsIn(b, assumedKeywords))));
    if (tooManyTerms(text, assumedKeywords, { before, roleTerms, ...limits })) {
      refuse(line, 'too many assumed terms for a line or the role');
      continue;
    }
    // Nor the bullet as it was with a term glued onto its list ("…, Kafka, REST APIs, …").
    if (before && (crossesPlatform(before, text, assumedKeywords) || gluedTerm(before, text, assumedKeywords))) {
      refuse(line, crossesPlatform(before, text, assumedKeywords) ? "a term of another platform on this bullet" : 'a term glued onto the bullet as one more list item');
      continue;
    }
    // A new bullet only within the mode's allowance for the role (one, looking real first).
    if (from === null && newLines(line.role) >= mode.newBulletsPerRole) {
      refuse(line, "the role has its allowance of new bullets");
      continue;
    }
    if (from !== null) {
      if (lower(before) === lower(text) || losesEvidence(before, text, protectedKeywords)) {
        refuse(line, lower(before) === lower(text) ? 'the bullet unchanged' : `loses a job term the bullet carried (${protectedKeywords.filter((k) => hasKeyword(before, k) && !hasKeyword(text, k)).slice(0, 4).join(', ')})`);
        continue;
      }
      role.achievements[from] = text;
      const change = changes.find((c) => c.role === line.role && c.kind !== 'removed' && c.after === before);
      if (change) change.after = text;
      else changes.push({ role: line.role, kind: 'rewritten', before, after: text });
      if (existing) {
        existing.text = text;
        existing.plain = judged;
      }
    } else {
      // In after the last bullet tailoring wrote or rewrote: the lines for this job stay
      // together at the top of the role, and a reader, or a scorer that reads a role to a
      // limit, meets them before the bullets left as they were.
      role.achievements.splice(insertAt, 0, text);
      changes.push({ role: line.role, kind: 'added', before: '', after: text });
    }
    if (stands) {
      estimates.push({ role: line.role, text, plain, clause: estimateClause(clause) });
      left -= 1;
    }
    done.add(line.id);
    applied += 1;
  }
  // `answered`: the gap ids the lines taken were written for, so a round that runs without a
  // score in between (pipeline.js scoreRounds 'ends') can mark them met before the next one.
  return { applied, form, changes, estimates, rejected, answered: [...done] };
}
