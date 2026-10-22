import { providerSettings } from '../runtime.js';
import { providerFor } from './providers.js';

export { providerFor };

// The models the server knows: which provider serves each, what it costs, and whether it
// reasons. Pricing is what attributes cost to a call without a billing round trip.

// USD per 1M tokens. `cached` is the price of input tokens OpenAI served from its prompt cache (a
// repeated prompt start of 1,024+ tokens, such as the enrichment instructions); a model without
// one is metered at the full input price.
export const PRICES = {
  'gpt-4o-mini': { in: 0.15, out: 0.6, cached: 0.075 },
  'gpt-4o': { in: 2.5, out: 10, cached: 1.25 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6, cached: 0.1 },
  'gpt-4.1': { in: 2, out: 8, cached: 0.5 },
  'gpt-5-nano': { in: 0.05, out: 0.4, cached: 0.005 },
  'gpt-5-mini': { in: 0.25, out: 2, cached: 0.025 },
  'gpt-5': { in: 1.25, out: 10, cached: 0.125 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2 },
  'gpt-5.6-terra': { in: 2, out: 12 },
  'gpt-5.6-sol': { in: 4, out: 20 },
  // GPT-6 Sol and Luna (2026-09-22) replaced the 5.6 pair at half the price; cached is 10% of input.
  'gpt-6-luna': { in: 0.1, out: 0.5, cached: 0.01 },
  'gpt-6-sol': { in: 2, out: 10, cached: 0.2 },
  'gpt-6-astra': { in: 10, out: 50, cached: 1 },
  // Alibaba Cloud Model Studio, international (Singapore) prices for prompts up to 32K tokens.
  'qwen3.7-flash': { in: 0.03, out: 0.13 },
  'qwen3.8-flash': { in: 0.15, out: 0.47 },
  // Ollama Cloud: a plan's monthly usage credits are spent at these rates, then bought credits.
  'gpt-oss:120b': { in: 0.15, out: 0.6, cached: 0.014 },
  'gpt-oss:20b': { in: 0.07, out: 0.3, cached: 0.035 },
};

/** Whether the server holds a key for a model's provider. */
export function providerConfigured(model) {
  const settings = providerSettings(providerFor(model));
  return Boolean(settings.client || settings.apiKey);
}

// GPT-5, GPT-6 and o-series models reason before they answer: they accept only the default
// temperature, count reasoning tokens against max_completion_tokens, and take an effort level.
export function isReasoningModel(model) {
  return /^(gpt-[5-9]|o\d)/.test(String(model || ''));
}

// Every model an admin may choose, derived from PRICES so the two cannot drift: a model with
// no price would be metered at zero. `reasoning` models take an effort level instead of a
// temperature (see isReasoningModel).
export const MODEL_CATALOG = Object.entries(PRICES).map(([id, price]) => ({
  id,
  provider: providerFor(id),
  reasoning: isReasoningModel(id),
  pricePerMillion: { input: price.in, output: price.out },
}));

/**
 * A model's price. Model names are matched in any case; "-cloud" is how a local Ollama names the
 * same cloud model, and a dated snapshot ("gpt-5-mini-2025-08-07") is priced as its model.
 */
function priceOf(model) {
  const name = String(model || '').toLowerCase().replace(/-cloud$/, '');
  return PRICES[name] || PRICES[name.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
}

/** Whether a call to `model` can be priced; one that cannot is metered at zero. */
export const hasPrice = (model) => Boolean(priceOf(model));

/**
 * USD for one call; `cachedIn` of the input tokens are billed at the cached price. The Batch API
 * and the flex tier bill half.
 */
export function costFor(model, tokensIn, tokensOut, { batch = false, flex = false, cachedIn = 0 } = {}) {
  const p = priceOf(model);
  if (!p) return 0;
  const cached = Math.min(Math.max(cachedIn, 0), tokensIn);
  const input = (tokensIn - cached) * p.in + cached * (p.cached ?? p.in);
  return ((input + tokensOut * p.out) / 1_000_000) * (batch || flex ? 0.5 : 1);
}

/** The input tokens a response says came from the prompt cache. */
export const cachedTokensOf = (usage) => usage?.prompt_tokens_details?.cached_tokens || 0;
