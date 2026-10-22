import { isReasoningModel } from './catalog.js';
import { flexFor, providerOf } from './providers.js';

/** The chat.completions request for one call. */
export function buildRequest({ system, user, json = false, responseFormat, temperature = 0.5, model, maxTokens, reasoningEffort, serviceTier }) {
  const reasoning = isReasoningModel(model);
  const provider = providerOf(model);
  // Ollama Cloud accepts response_format but does not hold gpt-oss to it (nor to its own `format`,
  // tested 2026-09-30): the model answers in a shape of its own. The schema goes in the prompt instead.
  const schema = provider.schemaInPrompt && responseFormat?.json_schema?.schema;
  const request = {
    model,
    messages: [
      {
        role: 'system',
        content: schema
          ? `${system}\n\nAnswer with one JSON object and nothing else, matching this JSON schema exactly (every property required, no others):
${JSON.stringify(schema)}`
          : system,
      },
      { role: 'user', content: user },
    ],
  };
  if (!reasoning) request.temperature = temperature;
  if (maxTokens) request[reasoning ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  if (reasoning && reasoningEffort) request.reasoning_effort = reasoningEffort;
  // Hybrid Qwen models think by default; "none" or "minimal" turns thinking off, any other level on.
  if (provider.thinkingSwitch && reasoningEffort) {
    request.enable_thinking = !['none', 'minimal'].includes(reasoningEffort);
  }
  // gpt-oss always reasons, at low, medium or high; there is no lower level.
  if (provider.alwaysReasons && reasoningEffort) {
    request.reasoning_effort = ['none', 'minimal'].includes(reasoningEffort) ? 'low' : reasoningEffort;
  }
  // Only where the model's family takes the tier (providers.js): GPT-4.1 refuses it with a 400.
  if (serviceTier && flexFor(model)) request.service_tier = serviceTier;
  if (responseFormat) request.response_format = responseFormat;
  else if (json) request.response_format = { type: 'json_object' };
  return request;
}

/** A JSON answer wrapped in a Markdown code fence (gpt-oss on Ollama does this), unwrapped. */
export function unfence(text) {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  return fenced ? fenced[1].trim() : text;
}
