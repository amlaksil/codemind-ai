import { providerOf } from './providers.js';
import { log as runtimeLog, models } from '../runtime.js';

// How a call falls back, and at what effort tailoring runs. Which model a feature uses comes from
// the app (createCodemind's `models`): scoring's ats model with a one-shot fallback, resume parsing's
// parse pair, and the tailoring and writing model the caller passes for the member.

/**
 * Run `call(model)` on the primary model; if it throws (API error, empty or malformed
 * output, or a failed check inside `call`), try the fallback once. A "model" is whatever
 * `call` takes: a model name, or settings such as { model, reasoningEffort }.
 */
// Failures another model would only repeat: a refusal is about the request, not the model.
const NO_FALLBACK = new Set(['ai_refused']);

export async function withFallback(call, tries, log = runtimeLog()) {
  const { model, fallbackModel } = tries || models().ats;
  try {
    return await call(model);
  } catch (err) {
    if (!fallbackModel || fallbackModel === model || NO_FALLBACK.has(err?.code)) throw err;
    log.warn({ model, fallbackModel, err: err.message }, 'AI call failed, trying the fallback');
    return call(fallbackModel);
  }
}

// A reasoning model tailors at low effort: the rewrite is long, and medium effort runs past the
// provider timeout. GPT-5.6 rewrote as well with reasoning off as at low effort, in half the
// time and tokens (measured), but "none" is a level neither GPT-5 nor GPT-6 accepts. Qwen's
// structured output only works with thinking off. The letters and answers write at the same effort.
export function tailorEffort(model) {
  if (providerOf(model).structuredNeedsThinkingOff) return 'minimal';
  return /^gpt-5\.6/.test(String(model || '')) ? 'none' : 'low';
}
