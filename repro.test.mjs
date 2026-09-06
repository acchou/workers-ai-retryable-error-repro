/** Assert the observed bug and distinguish it from recovery, cancellation, and budget exhaustion. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetryError } from 'ai';
import { runScenario } from './repro.mjs';

test('unmodified provider loses binding retryability despite maxRetries=2', async () => {
  const result = await runScenario();
  assert.equal(result.calls, 1);
  assert.equal(result.text, '');
  assert.deepEqual(result.errors, [result.injectedError]);
  assert.equal(result.errors[0].retryable, true);
});

test('normalization lets the real SDK retry and consume a real adapter-parsed stream', async () => {
  const result = await runScenario({ fixed: true });
  assert.equal(result.calls, 2);
  assert.equal(result.text, 'Recovered');
  assert.deepEqual(result.errors, []);
});

test('unclassified errors remain terminal', async () => {
  const error = new Error('Network connection lost.');
  const result = await runScenario({ fixed: true, error });
  assert.equal(result.calls, 1);
  assert.deepEqual(result.errors, [error]);
});

test('cancellation remains terminal even with a retryable flag', async () => {
  const error = Object.assign(new Error('Canceled'), { name: 'AbortError', retryable: true });
  const result = await runScenario({ fixed: true, error });
  assert.equal(result.calls, 1);
  // Some SDK versions handle aborts without onError; either way, no retry or output is allowed.
  assert.equal(result.text, '');
});

test('normalized errors still obey the SDK retry budget', async () => {
  const result = await runScenario({ fixed: true, alwaysFail: true, maxRetries: 1 });
  assert.equal(result.calls, 2);
  assert.equal(result.errors.length, 1);
  assert(RetryError.isInstance(result.errors[0]));
  assert.equal(result.errors[0].reason, 'maxRetriesExceeded');
});
