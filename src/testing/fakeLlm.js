import { createCodemind } from '../index.js';

// A model that answers from a script, for tests that pin what the AI features send. It is set up
// the way the app sets the AI code up (createCodemind), as the client of every provider, so no call
// can reach a real API, and with a usage recorder that keeps the events. Each call records the
// exact chat.completions body.

// The models the app's environment defaults to (config/env.js), which the snapshots were taken with.
export const DEFAULT_MODELS = {
  defaultModel: 'gpt-4o-mini',
  ats: { model: 'gpt-4.1-mini', fallbackModel: 'gpt-5-mini', effort: 'minimal', fallbackEffort: 'minimal' },
  enrich: { mode: 'batch', dailyBudgetUsd: 5, model: 'gpt-5-nano', effort: 'low', fallbackModel: 'gpt-5-mini', fallbackEffort: 'low' },
  parse: { model: 'gpt-5.6-luna', fallbackModel: 'gpt-5.6-luna', effort: 'none', fallbackEffort: 'low' },
};

const RAW = Symbol('raw chat.completions response');

/**
 * An answer given as the whole chat.completions response, for tests of what a response carries
 * besides its content: finish_reason, refusal, real usage. Usage defaults to the fake's own.
 */
export const rawResponse = (response) => ({ [RAW]: response });

/**
 * installFakeLlm(answers, { models, logger }) → { calls, events, restore }
 * `answers` is a list used in order, one per call, or a function (request, index) → answer. An
 * answer is a string (the message content), an object (sent as its JSON), a rawResponse(…), or an
 * Error to throw. A call past the end of the list fails the test.
 */
export function installFakeLlm(answers, { models = DEFAULT_MODELS, logger } = {}) {
  const calls = [];
  const events = [];
  const answerFor = typeof answers === 'function' ? answers : (_, i) => {
    if (i >= answers.length) throw new Error(`fake LLM: no answer scripted for call ${i + 1}`);
    return answers[i];
  };
  const client = {
    chat: {
      completions: {
        create: async (request, options) => {
          const index = calls.length;
          calls.push({ request: structuredClone(request), options: options ?? null });
          const answer = await answerFor(request, index);
          if (answer instanceof Error) throw answer;
          if (answer?.[RAW]) return { usage: { prompt_tokens: 1000, completion_tokens: 100 }, ...answer[RAW] };
          const content = typeof answer === 'string' ? answer : JSON.stringify(answer);
          return { choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
        },
      },
    },
  };
  createCodemind({
    providers: { openai: { client }, dashscope: { client }, ollama: { client } },
    models: () => models,
    onUsage: (event) => events.push(event),
    logger,
  });
  return {
    calls,
    events,
    restore() {
      createCodemind({});
    },
  };
}

/**
 * The calls as text a person can review in a diff: per call, what it was metered as, the
 * request's settings (response schema included), then the system and user messages in full.
 */
export function describeCalls({ calls, events }) {
  return calls
    .map(({ request, options }, i) => {
      const { messages, ...settings } = request;
      const event = events[i] || {};
      const metered = { kind: event.kind, promptVersion: event.promptVersion, attempt: event.attempt ?? null, ok: event.ok, flex: event.flex };
      const parts = [`=== call ${i + 1} ===`, `metered: ${JSON.stringify(metered)}`, `settings: ${JSON.stringify(settings, null, 2)}`];
      if (options) parts.push(`options: ${JSON.stringify(options)}`);
      for (const m of messages) parts.push(`--- ${m.role} ---\n${m.content}`);
      return parts.join('\n');
    })
    .join('\n\n');
}
