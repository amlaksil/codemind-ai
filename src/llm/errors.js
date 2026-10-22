import OpenAI from 'openai';

// What a failed call means: worth another try, the flex tier full, or an account out of credits.

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * Worth a second try: a retryable HTTP status, or no response at all (a timeout or a dropped
 * connection has no status). The SDK's timeout error extends its connection error.
 */
export function isTransient(err) {
  return RETRYABLE.has(err?.status || err?.statusCode) || err instanceof OpenAI.APIConnectionError;
}

/** OpenAI refusing a flex-tier request for lack of capacity (a 429 that is not a rate limit). */
export function isFlexUnavailable(err) {
  return (err?.status || err?.statusCode) === 429 && (err?.code === 'resource_unavailable' || /resource.?unavailable/i.test(err?.message || ''));
}

/**
 * An account out of credits also answers 429 (OpenAI) or an overdue-payment error (Alibaba Cloud),
 * but waiting will not help, so it is never retried.
 */
export function isOutOfCredits(err) {
  return (
    err?.code === 'insufficient_quota' ||
    err?.code === 'Arrearage' ||
    /no credits remaining|exceeded your current quota|arrearage|overdue payment/i.test(err?.message || '')
  );
}

/** A call that ran out of time (no answer, so nothing was billed). */
export function isTimeout(err) {
  return err instanceof OpenAI.APIConnectionTimeoutError;
}

// The longest a retry waits, whatever a provider's Retry-After asks: past this the caller is better
// served by the error than by a request that hangs.
const MAX_RETRY_WAIT_MS = 30_000;

function headerOf(err, name) {
  const headers = err?.headers;
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  return value == null || String(value).trim() === '' ? NaN : Number(value);
}

/**
 * How long to wait before attempt `attempt + 1`: what the provider's Retry-After (or OpenAI's
 * retry-after-ms) asks, within a cap; else an exponential backoff with jitter, so callers that
 * failed together do not all retry at the same moment.
 */
export function retryDelayMs(err, attempt, random = Math.random) {
  const ms = headerOf(err, 'retry-after-ms');
  if (ms >= 0) return Math.min(ms, MAX_RETRY_WAIT_MS);
  const seconds = headerOf(err, 'retry-after');
  if (seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  return Math.round(500 * 2 ** (attempt - 1) * (0.5 + random() * 0.5));
}
