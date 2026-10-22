import { AiError } from '../errors.js';
import { isConfigured, log, models } from '../runtime.js';
import { cachedTokensOf, costFor, hasPrice } from './catalog.js';
import { flexFor } from './providers.js';
import { clientFor, FLEX_TIMEOUT_MS } from './client.js';
import { isFlexUnavailable, isOutOfCredits, isTimeout, isTransient, retryDelayMs } from './errors.js';
import { buildRequest, unfence } from './request.js';
import { recordUsage } from './usage.js';

// The one door to the model. Every call is timed, metered into usage_events, and
// retried on transient failures. Callers pass `meta` ({ userId, kind, promptVersion,
// ref, requestId }) so a call is attributable without the caller knowing how.

const MAX_ATTEMPTS = 3;

// Models already warned about having no price (catalog.js PRICES): their calls are metered at zero.
const unpriced = new Set();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * complete({ system, user, json, responseFormat, temperature, model, maxTokens, reasoningEffort,
 * serviceTier, allowEmpty }, meta) → { text, data?, usage }
 * `json: true` asks for a JSON object response and parses it into `data`; `responseFormat` sends
 * a JSON schema instead. `serviceTier: 'flex'` asks OpenAI for its half-price flex tier, which
 * answers more slowly and refuses with a 429 when it has no capacity (isFlexUnavailable); a model
 * whose family does not take the tier (providers.js flexFor) runs on the standard tier as if it
 * had not been asked.
 * `allowEmpty` returns an empty answer rather than throwing, for callers that treat it as a failed
 * attempt of their own.
 *
 * @param {{ system: string, user: string, json?: boolean, responseFormat?: object, temperature?: number, model?: string, maxTokens?: number, reasoningEffort?: string, serviceTier?: string, allowEmpty?: boolean }} request
 * @param {import('../types.js').CallMeta & { kind?: string, promptVersion?: string, attempt?: number }} [meta]
 * @returns {Promise<{ text: string, data?: any, usage: { model: string, tokensIn: number, tokensOut: number, cachedIn: number, costUsd: number } }>}
 */
export async function complete(
  { system, user, json = false, responseFormat, temperature = 0.5, model = models().defaultModel, maxTokens, reasoningEffort, serviceTier, allowEmpty = false },
  meta = {}
) {
  if (!isConfigured()) throw new Error('The AI code was called before createCodemind() set it up');
  const client = clientFor(model);
  const flex = serviceTier === 'flex' && flexFor(model);
  const started = Date.now();
  let lastErr;
  // What every answered attempt was billed for, also when its answer could not be used.
  const billed = { tokensIn: 0, tokensOut: 0, cachedIn: 0 };
  if (!hasPrice(model) && !unpriced.has(model)) {
    unpriced.add(model);
    log().warn({ model }, 'model has no price in the catalog; its calls are metered at $0');
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.chat.completions.create(
        buildRequest({ system, user, json, responseFormat, temperature, model, maxTokens, reasoningEffort, serviceTier }),
        flex ? { timeout: FLEX_TIMEOUT_MS } : undefined
      );

      const choice = response.choices[0];
      const text = unfence(choice?.message?.content?.trim() || '');
      const tokensIn = response.usage?.prompt_tokens || 0;
      const tokensOut = response.usage?.completion_tokens || 0;
      const cachedIn = cachedTokensOf(response.usage);
      const usage = { model, tokensIn, tokensOut, cachedIn, costUsd: costFor(model, tokensIn, tokensOut, { flex, cachedIn }) };
      billed.tokensIn += tokensIn;
      billed.tokensOut += tokensOut;
      billed.cachedIn += cachedIn;

      // A caller that allows an empty answer judges a refused or cut-off one itself (enrichment
      // validates it as a failed attempt).
      if (!allowEmpty) {
        if (choice?.message?.refusal) throw new AiError(422, 'ai_refused', 'The AI declined to answer this request.');
        // Cut off at the token limit (a reasoning model can spend it all before answering): the text
        // is incomplete, and a JSON answer would only look malformed.
        if (choice?.finish_reason === 'length') throw new AiError(502, 'ai_truncated', "The AI's answer was cut off before it finished. Try again.");
      }
      if (!text && !allowEmpty) throw AiError.upstream('The model returned an empty response');
      let data;
      if (json && text) {
        try {
          data = JSON.parse(text);
        } catch {
          throw AiError.upstream('The model returned malformed JSON');
        }
      }
      // Recorded once the answer is known to be usable: an empty or malformed one is the failure
      // recorded below, not a success and a failure both.
      await recordUsage({ ...meta, model, tokensIn, tokensOut, cachedIn, flex, latencyMs: Date.now() - started, ok: true });
      return data === undefined ? { text, usage } : { text, data, usage };
    } catch (err) {
      lastErr = err;
      const status = err.status || err.statusCode;
      // A refused flex request is not retried here: the caller leaves the work for a later cycle.
      // Nor is a flex request that timed out: each attempt already waited up to FLEX_TIMEOUT_MS.
      if (err instanceof AiError || isOutOfCredits(err) || isFlexUnavailable(err) || (flex && isTimeout(err)) || !isTransient(err) || attempt === MAX_ATTEMPTS) break;
      log().warn({ status, attempt, model, err: err.message }, 'model call failed, retrying');
      await sleep(retryDelayMs(err, attempt));
    }
  }

  await recordUsage({
    ...meta,
    model,
    ...billed,
    latencyMs: Date.now() - started,
    ok: false,
    flex,
    error: String(lastErr?.message || lastErr).slice(0, 500),
  });
  if (lastErr instanceof AiError) throw lastErr;

  // Flex at capacity is OpenAI's answer on a busy day, not a failure of ours: the caller leaves the
  // work for later or sends it on the standard tier, so it is a warning, not an error for Sentry.
  if (isFlexUnavailable(lastErr)) {
    log().warn({ model, status: lastErr?.status || lastErr?.statusCode }, 'flex tier at capacity');
    throw new AiError(503, 'ai_flex_unavailable', 'OpenAI has no flex capacity right now.');
  }

  log().error({ err: lastErr, model }, 'model call failed');
  const status = lastErr?.status || lastErr?.statusCode;
  if (status === 401) throw new AiError(503, 'ai_not_configured', 'The AI provider rejected the server key');
  if (isOutOfCredits(lastErr)) {
    throw new AiError(503, 'ai_no_credits', 'The AI provider account has no credits left. Add credits to continue.');
  }
  if (status === 429) throw new AiError(503, 'ai_busy', 'The AI provider is busy. Try again in a minute.');
  throw AiError.upstream('The AI provider did not respond. Try again.');
}
