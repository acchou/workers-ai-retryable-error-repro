/** Real SDK/provider path with a deterministic replacement for Cloudflare's AI binding. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { APICallError } from '@ai-sdk/provider';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, wrapLanguageModel } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';

// Match the application's Responses wire adapter, rather than testing a fake SDK model.
const responsesWire = {
  wireFormat: 'openai',
  create: ({ modelId, fetch, baseURL }) => createOpenAI({
    apiKey: 'unused', fetch, ...(baseURL ? { baseURL } : {}),
  }).responses(modelId),
};

function successfulStream() {
  const events = [
    { type: 'response.created', response: { id: 'resp_test', created_at: 1765000000, model: 'gpt-5', service_tier: null } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant' } },
    { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'Recovered' },
    { type: 'response.completed', response: {
      id: 'resp_test', status: 'completed', incomplete_details: null, reasoning: null, service_tier: null,
      usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 } },
    } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function bindingFailure() {
  // This shape was observed from cloudflare-internal:ai-api / AI.run().
  return Object.assign(new Error('Network connection lost.'), { retryable: true });
}

/** Illustrative boundary fix. Retry scheduling remains entirely owned by the AI SDK. */
export function normalizeBindingFailures(model) {
  async function invoke(call) {
    try {
      return await call();
    } catch (error) {
      if (error instanceof Error && !APICallError.isInstance(error)
        && !['AbortError', 'TimeoutError', 'ResponseAborted'].includes(error.name)
        && error.retryable === true) {
        throw new APICallError({
          message: error.message, cause: error, isRetryable: true,
          url: `workers-ai:binding/run/${model.modelId}`, requestBodyValues: undefined,
        });
      }
      throw error;
    }
  }
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapStream: ({ doStream }) => invoke(doStream),
      wrapGenerate: ({ doGenerate }) => invoke(doGenerate),
    },
  });
}

export async function runScenario({ fixed = false, error = bindingFailure(), alwaysFail = false, maxRetries = 2 } = {}) {
  let calls = 0;
  const callTimes = [];
  const started = performance.now();
  const binding = {
    async run() {
      calls++;
      callTimes.push(Math.round(performance.now() - started));
      if (calls === 1 || alwaysFail) throw error;
      return successfulStream();
    },
    gateway() {
      throw new Error('Unexpected gateway transport: this repro must use the AI.run binding path.');
    },
  };
  const workersAI = createWorkersAI({
    binding, gateway: { id: 'offline-repro' }, providers: [responsesWire],
  });
  // Explicit run transport and no resumable-stream behavior: isolate startup retry.
  const realModel = workersAI('openai/gpt-5', { transport: 'run', resume: false });
  const errors = [];
  const result = streamText({
    model: fixed ? normalizeBindingFailures(realModel) : realModel,
    prompt: 'Reply briefly.', maxRetries,
    onError: ({ error }) => errors.push(error),
  });
  // Preserve the provider error reported through onError separately from the
  // NoOutputGeneratedError thrown by the text promise when no step succeeded.
  let text = '';
  let outputError;
  try {
    text = await result.text;
  } catch (error) {
    outputError = error;
  }
  return { calls, callTimes, text, errors, outputError, injectedError: error };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  assert(args.every(arg => arg === '--fixed'), 'Usage: node repro.mjs [--fixed]');
  const fixed = args.includes('--fixed');
  const result = await runScenario({ fixed });
  console.log(JSON.stringify({
    mode: fixed ? 'with-normalization' : 'unmodified-provider', maxRetries: 2,
    bindingCalls: result.calls, callTimesMs: result.callTimes, text: result.text,
    outputError: result.outputError?.name,
    errors: result.errors.map(error => ({
      name: error.name, message: error.message,
      isAPICallError: APICallError.isInstance(error),
      retryable: error.retryable, isRetryable: error.isRetryable,
    })),
  }, null, 2));
  if (result.calls >= 2 && result.text === 'Recovered' && result.errors.length === 0 && !result.outputError) {
    console.log('PASS: the SDK retried the binding call and recovered.');
  } else {
    console.error('FAIL: expected SDK retry and recovery; the binding could succeed on its second call.');
    process.exitCode = 1;
  }
}
