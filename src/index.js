// @codemind/ai: CodeMind's AI code. Everything that calls a model is exported here; the pure text
// helpers (text/) and resume reading and rendering (resume/) are also importable by path.
//
//   llm/        the one door to the model (complete), providers, retries, flex, prices, metering
//   ats/        a posting's requirements, and a resume judged against them
//   tailor/     the rewrite for one job, its repair round, its gap pass, and the whole pipeline
//   writing/    cover letters, application answers, referral requests, interview prep and feedback
//   parse/      an uploaded resume read into the structured form
//   enrich/     a job posting read into fields, validated, retried; the Batch API lines
//   checks/     what a model wrote, checked against the candidate's own resume
//   text/       keywords, skills dictionary, countries and cities, seniority, salaries, fences, voice
//   resume/     the structured resume form, text extraction, .docx and PDF rendering
//
// Nothing here imports the program around it. That program calls createCodemind() once with the
// providers' keys, the models in force, where usage goes and a logger.

import { configure } from './runtime.js';
import * as codemind from './index.js';

// Setup and errors.
export { AiError } from './errors.js';
export { models as currentModels } from './runtime.js';
export { PROMPT_VERSIONS } from './promptVersions.js';

// The model: one call, the catalog, and OpenAI's Batch API.
export { complete, costFor, isReasoningModel, MODEL_CATALOG, providerConfigured, providerFor } from './llm/index.js';
export { readBatch, startBatch } from './llm/batch.js';

// Features.
export { parseResumeText } from './parse/service.js';
export { extractJobRequirements, quickScoreResume, scoreVersion } from './ats/service.js';
export { fillTailoringGaps, tailorResumeForm } from './tailor/service.js';
export { runTailoring, SCORE_ROUNDS } from './tailor/pipeline.js';
export { estimateClause, TAILOR_STYLES, tailorStyle, withEstimate } from './tailor/index.js';
export { FIELD_NOTE_CATEGORIES } from './tailor/fieldNotes.js';
export { generateApplicationAnswer, generateApplicationAnswers, generateCoverLetter, generateReferral } from './writing/letters/index.js';
export { BLOCKING_INTRO_ISSUES, INSTRUCTIONS_LIMIT, INTRO_MAX_WORDS, SUBJECT_LIMIT, founderIntroIssues, generateFounderIntro, stripGreetingAndSignoff, wordCount } from './writing/letters/index.js';
export { generateInterviewPrep, reviewInterviewAnswer } from './writing/interview/service.js';
export { interpretScreeningQuestions, QUESTIONS_PER_CALL as SCREENING_QUESTIONS_PER_CALL } from './writing/screening/interpret.js';
export { resumeWarnings } from './checks/index.js';
export { fenced } from './text/fence.js';

// Job enrichment: one posting read directly, or many through the Batch API.
export { JOB_ENRICHMENT_SCHEMA, SUBCATEGORIES } from './enrich/schema.js';
export { PROMPT_VERSION as ENRICH_PROMPT_VERSION } from './enrich/prompt.js';
export { describeAttempt, enrichJob, enrichmentAttempts, failedChecksOf, resultFrom, salaryKept, settledAsOther, validateAnswer } from './enrich/enrichJob.js';
export { readEnrichmentBatch, recordBatchAnswer, submitEnrichmentBatch } from './enrich/batch.js';
export { enrichmentHash } from './enrich/hash.js';

/**
 * Set the AI code up for this process and return its calls. `providers`: { openai: { apiKey },
 * dashscope: { apiKey, baseUrl }, ollama: { apiKey, baseUrl } }, or a function returning that,
 * read when a provider's client is first built. `models`: a function returning the settings in
 * force, read on every call — { defaultModel, ats: { model, fallbackModel, effort, fallbackEffort },
 * enrich: { model, effort, fallbackModel, fallbackEffort }, parse: { …the same four } }.
 * `onUsage(event)`: stores one call's usage (model, tokens, costUsd, kind, promptVersion, ok…).
 * `logger`: debug/info/warn/error. One setup per process: a second call replaces the first.
 *
 * @param {import('./types.js').CodemindOptions} [options]
 * @returns {typeof import('./index.js')} The package's calls.
 */
export function createCodemind({ providers, models, onUsage, logger } = {}) {
  configure({ providers, models, onUsage, logger });
  return codemind;
}
