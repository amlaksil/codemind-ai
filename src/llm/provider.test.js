import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { buildRequest, costFor, isFlexUnavailable, isOutOfCredits, isReasoningModel, isTransient, providerFor, unfence } from './index.js';
import { flexFor } from './providers.js';

const MESSAGES = [
  { role: 'system', content: 's' },
  { role: 'user', content: 'u' },
];

test('GPT-5 and o-series are reasoning models; GPT-4 and Qwen models are not', () => {
  for (const model of ['gpt-5-nano', 'gpt-5-mini', 'gpt-5', 'o3-mini']) assert.equal(isReasoningModel(model), true, model);
  for (const model of ['gpt-4o-mini', 'gpt-4.1', 'qwen3.7-flash', '']) assert.equal(isReasoningModel(model), false, model);
});

test('a GPT-4 request keeps temperature, max_tokens and JSON mode, and ignores reasoning effort', () => {
  assert.deepEqual(
    buildRequest({ system: 's', user: 'u', json: true, model: 'gpt-4o-mini', maxTokens: 100, temperature: 0.2, reasoningEffort: 'low' }),
    { model: 'gpt-4o-mini', messages: MESSAGES, temperature: 0.2, max_tokens: 100, response_format: { type: 'json_object' } }
  );
});

test('a GPT-5 request drops temperature and uses max_completion_tokens, reasoning effort and the JSON schema', () => {
  const responseFormat = { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: {} } };
  assert.deepEqual(
    buildRequest({
      system: 's',
      user: 'u',
      json: true,
      responseFormat,
      model: 'gpt-5-nano',
      maxTokens: 8000,
      temperature: 0.5,
      reasoningEffort: 'minimal',
    }),
    { model: 'gpt-5-nano', messages: MESSAGES, max_completion_tokens: 8000, reasoning_effort: 'minimal', response_format: responseFormat }
  );
});

test('Qwen models go to Model Studio; "minimal" turns thinking off and any other effort turns it on', () => {
  assert.equal(providerFor('qwen3.7-flash'), 'dashscope');
  assert.equal(providerFor('qwen3.8-flash'), 'dashscope');
  assert.equal(providerFor('gpt-5-mini'), 'openai');
  assert.equal(providerFor('gpt-oss:120b'), 'ollama');

  const responseFormat = { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: {} } };
  assert.deepEqual(
    buildRequest({ system: 's', user: 'u', responseFormat, model: 'qwen3.7-flash', maxTokens: 8000, temperature: 0, reasoningEffort: 'minimal' }),
    { model: 'qwen3.7-flash', messages: MESSAGES, temperature: 0, max_tokens: 8000, enable_thinking: false, response_format: responseFormat }
  );
  assert.equal(buildRequest({ system: 's', user: 'u', model: 'qwen3.8-flash', reasoningEffort: 'low' }).enable_thinking, true);
  assert.equal('enable_thinking' in buildRequest({ system: 's', user: 'u', model: 'qwen3.8-flash' }), false);
});

test('the flex tier goes only to the model families that take it: GPT-5 and GPT-6, never GPT-4.1 or another provider', () => {
  for (const model of ['gpt-5-nano', 'gpt-5-mini', 'gpt-5.6-luna', 'gpt-6-luna', 'o4-mini']) assert.equal(flexFor(model), true, model);
  for (const model of ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'qwen3.7-flash', 'gpt-oss:120b', '']) assert.equal(flexFor(model), false, model);
  assert.equal(buildRequest({ system: 's', user: 'u', model: 'gpt-5-nano', serviceTier: 'flex' }).service_tier, 'flex');
  // Asked for flex on a model that refuses it: the request goes out on the standard tier, no 400, no fallback.
  assert.equal('service_tier' in buildRequest({ system: 's', user: 'u', model: 'gpt-4.1-mini', serviceTier: 'flex' }), false);
});

test('an account without credits is told apart from a rate limit, so it is not retried', () => {
  assert.equal(isOutOfCredits({ status: 429, code: 'insufficient_quota', message: '429 You exceeded your current quota' }), true);
  assert.equal(
    isOutOfCredits({ status: 429, message: '429 You have no credits remaining. Add credits to continue using the API.' }),
    true
  );
  assert.equal(isOutOfCredits({ status: 400, code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' }), true);
  assert.equal(isOutOfCredits({ status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt-5-nano' }), false);
  assert.equal(isOutOfCredits(null), false);
});

test('a call is priced per million tokens, and the Batch API bills half', () => {
  assert.equal(costFor('gpt-5-nano', 1_000_000, 1_000_000), 0.45);
  assert.equal(costFor('gpt-5-nano', 1_000_000, 1_000_000, { batch: true }), 0.225);
  assert.equal(costFor('not-a-priced-model', 10, 10), 0);
});

test('input tokens served from the prompt cache are billed at the cached price', () => {
  // gpt-5-nano: 250k fresh at $0.05 + 750k cached at $0.005 + 1M out at $0.40, halved in a batch.
  assert.ok(Math.abs(costFor('gpt-5-nano', 1_000_000, 1_000_000, { cachedIn: 750_000 }) - 0.41625) < 1e-12);
  assert.ok(Math.abs(costFor('gpt-5-nano', 1_000_000, 1_000_000, { cachedIn: 750_000, batch: true }) - 0.208125) < 1e-12);
  // More cached than sent is capped; a model with no cached price is billed in full.
  assert.equal(costFor('gpt-5-nano', 1_000_000, 0, { cachedIn: 5_000_000 }), 0.005);
  assert.equal(costFor('qwen3.7-flash', 1_000_000, 0, { cachedIn: 1_000_000 }), 0.03);
});

test('a retryable status, a timeout or a dropped connection is worth another attempt; anything else is not', () => {
  assert.equal(isTransient({ status: 503 }), true);
  assert.equal(isTransient({ statusCode: 429 }), true);
  assert.equal(isTransient(new OpenAI.APIConnectionTimeoutError({ message: 'Request timed out.' })), true);
  assert.equal(isTransient(new OpenAI.APIConnectionError({ message: 'socket hang up' })), true);
  assert.equal(isTransient({ status: 400 }), false);
  assert.equal(isTransient(new TypeError('x is not a function')), false);
  assert.equal(isTransient(null), false);
});

test('a gpt-oss request goes with a reasoning effort of at least low and keeps its temperature', () => {
  assert.deepEqual(buildRequest({ system: 's', user: 'u', model: 'gpt-oss:120b', temperature: 0.2, reasoningEffort: 'minimal' }), {
    model: 'gpt-oss:120b',
    messages: MESSAGES,
    temperature: 0.2,
    reasoning_effort: 'low',
  });
  assert.equal(buildRequest({ system: 's', user: 'u', model: 'gpt-oss:120b', reasoningEffort: 'medium' }).reasoning_effort, 'medium');
});

test('a gpt-oss request carries its JSON schema in the system prompt', () => {
  const responseFormat = { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { type: 'object', properties: { a: { type: 'string' } } } } };
  const request = buildRequest({ system: 's', user: 'u', model: 'gpt-oss:120b', responseFormat });
  assert.match(request.messages[0].content, /^s\n\nAnswer with one JSON object.*\{"type":"object","properties":\{"a":\{"type":"string"\}\}\}$/s);
  assert.equal(buildRequest({ system: 's', user: 'u', model: 'gpt-5-nano', responseFormat }).messages[0].content, 's');
});

test('a fenced JSON answer is unwrapped; anything else is left alone', () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('```\n{"a":1}```'), '{"a":1}');
  assert.equal(unfence('{"a":1}'), '{"a":1}');
});

test('a flex request names its tier for OpenAI only, and is billed at half price', () => {
  assert.equal(buildRequest({ system: 's', user: 'u', model: 'gpt-5-nano', serviceTier: 'flex' }).service_tier, 'flex');
  assert.equal('service_tier' in buildRequest({ system: 's', user: 'u', model: 'gpt-5-nano' }), false);
  assert.equal('service_tier' in buildRequest({ system: 's', user: 'u', model: 'qwen3.7-flash', serviceTier: 'flex' }), false);
  assert.equal(costFor('gpt-5-nano', 1_000_000, 0, { flex: true }), costFor('gpt-5-nano', 1_000_000, 0) / 2);
  assert.equal(costFor('gpt-5-nano', 1_000_000, 0, { flex: true }), costFor('gpt-5-nano', 1_000_000, 0, { batch: true }));
});

test('a flex refusal is told apart from a rate limit', () => {
  assert.equal(isFlexUnavailable({ status: 429, code: 'resource_unavailable', message: 'Resource unavailable' }), true);
  assert.equal(isFlexUnavailable({ status: 429, message: 'Resource Unavailable: the flex tier is at capacity' }), true);
  assert.equal(isFlexUnavailable({ status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached' }), false);
  assert.equal(isFlexUnavailable({ status: 500, code: 'resource_unavailable' }), false);
});
