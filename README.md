# Cloudflare binding retryable error reproduction

Cloudflare already marks some Workers AI binding failures as retryable
(`retryable: true`). On the `workers-ai-provider` OpenAI Responses path, that
flag reaches the AI SDK unchanged, but is not translated into its recognized
`APICallError.isRetryable` contract. The SDK is configured to retry
(`maxRetries: 2`) but treats the error as terminal, so a brief binding failure
fails the whole request.

This repo reproduces that gap offline in `repro.mjs`. No Cloudflare account,
credentials, deployment, or live model call is required. Installing
dependencies needs npm access; the reproduction itself runs offline. Tested
with Node 24.13.1 (Node 22+).

## What is broken, and how serious it is

**Nature.** This is an error-classification gap, not a missing retry loop.

1. The Workers AI binding (`AI.run()`) can throw a plain `Error` with
   `retryable: true`. The observed message is `Network connection lost.`
2. The AI SDK only retries `APICallError` instances with `isRetryable: true`.
3. On the OpenAI Responses delegate path (models such as `openai/gpt-5`,
   routed through `@ai-sdk/openai`), `workers-ai-provider` forwards the
   binding error unchanged.
4. The SDK therefore never retries, even though `maxRetries` is set.

A comparison wrapper (`npm run fixed`) only translates that flagged error into
an `APICallError`. It does not add its own retry loop. After that translation,
the real SDK retries and recovers. That is the contract gap: retryability is
lost at the provider boundary.

**Severity.** A transient, already-flagged binding failure becomes a hard
user-facing failure.

- The first `AI.run()` throws; there is no second attempt.
- `streamText` produces no model output. `result.text` rejects with
  `AI_NoOutputGeneratedError`.
- In this reproduction the second call would have returned `Recovered`.
- Any app on this path that relies on SDK retries for transient Workers AI
  errors will surface those blips as terminal failures.

This does **not** mean Cloudflare is offline, and it does not reproduce a
real network outage. It shows that when the platform reports a retryable
binding error at request start, the adapter path documented here will not
retry it.

## Run

`--ignore-scripts` skips dependency lifecycle scripts. `--workspaces=false`
keeps `npm ci` from inheriting a parent npm workspace if this folder is nested
inside another repo.

```sh
npm ci --ignore-scripts --workspaces=false
npm run reproduce
```

**Expected exit code: 1 while the bug exists.** The script asserts successful
recovery. The unmodified provider calls the binding once, even though
`maxRetries` is 2 and a second call would succeed:

```json
{
  "mode": "unmodified-provider",
  "maxRetries": 2,
  "bindingCalls": 1,
  "text": "",
  "outputError": "AI_NoOutputGeneratedError",
  "errors": [{
    "name": "Error",
    "message": "Network connection lost.",
    "isAPICallError": false,
    "retryable": true
  }]
}
```

Same path with the illustrative normalization wrapper:

```sh
npm run fixed
```

**Expected exit code: 0.** Two binding calls, about two seconds apart, return
`Recovered` with no terminal error. The two-second gap is the real AI SDK
backoff, not a fake timer.

```sh
npm test
```

Five checks cover the existing bug, recovery after normalization, unclassified
errors staying terminal, cancellation staying terminal, and retry-budget
exhaustion.

**A green `npm test` means the reproducer behaves as documented, not that
upstream is fixed.** After an upstream repair, the first test should fail
because it asserts the old bug, and `npm run reproduce` should succeed.

## What is real and what is injected

```text
AI SDK streamText(maxRetries: 2)
  -> workers-ai-provider (catalog picks the OpenAI Responses adapter)
  -> @ai-sdk/openai Responses adapter
  -> Workers AI run transport
  -> injected AI.run()
```

A custom Responses wire plugin explicitly selects `createOpenAI(...).responses(modelId)`.
The SDK and provider adapters are real; the Cloudflare binding is injected. Its first call throws the
observed platform-error shape:

```js
Object.assign(new Error('Network connection lost.'), { retryable: true })
```

A later call returns a small synthetic Responses SSE stream. The real OpenAI
adapter parses that stream. The model id `openai/gpt-5` only selects that
delegate route; no hosted model is contacted.

The run transport is set explicitly (`transport: 'run'`) and resumable
streaming is off (`resume: false`) so the test isolates the first-call retry
boundary, not mid-stream reconnect behavior.

`onError` still receives the original provider error. `result.text` rejects
separately with `AI_NoOutputGeneratedError` because no step completed. The
reproducer reports both so the original cause is not lost.

The `--fixed` wrapper converts only explicitly flagged, non-cancellation
errors. It leaves existing `APICallError` instances and unclassified errors
alone. It is a comparison implementation, not a claim about the best upstream
patch location.

## Scope and limitations

- Demonstrates, deterministically, that the observed `retryable: true` binding
  error is not honored on this path.
- Does **not** reproduce or explain an actual Cloudflare connection outage.
- Does not test mid-stream recovery, queue scheduling, memory retrieval,
  billing, deployed infrastructure, or the Vitest-specific remote-binding
  defect.
- The SDK default allows two retries (three attempts) per model call. The
  exhaustion test uses one retry so the suite stays short.

A live probe is omitted on purpose: forcing a real platform disconnect is not
deterministic and is unnecessary to show the adapter contract gap.

## Versions

The lockfile pins the dependency graph used by this reproduction:

| Package | Version |
| --- | --- |
| `workers-ai-provider` | 4.0.0 |
| `ai` | 7.0.58 |
| `@ai-sdk/openai` | 4.0.15 |
| `@ai-sdk/provider` | 4.0.7 |

## Related upstream work

- [cloudflare/ai #593](https://github.com/cloudflare/ai/pull/593), released in
  [workers-ai-provider 3.3.0](https://github.com/cloudflare/ai/releases/tag/workers-ai-provider@3.3.0),
  normalized native Workers AI errors that use documented numeric codes. Its
  stated handling leaves unrecognized errors non-retryable. It does not show
  that this plain `retryable: true` error is handled on the Responses
  delegate path.
- [Current native binding normalization](https://github.com/cloudflare/ai/blob/main/packages/workers-ai-provider/src/workersai-error.ts).
- [AI SDK retry contract](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error).
- [workers-sdk #13306](https://github.com/cloudflare/workers-sdk/issues/13306)
  is a separate remote-binding/Vitest problem, not this adapter gap.

## Upstream report summary

**Suggested title:** Workers AI Responses delegate drops retryability of binding
errors carrying `retryable: true`

**Expected:** With `maxRetries: 2`, a retryable binding failure at request
start should allow another call. In this reproduction that second call
succeeds.

**Actual:** The binding is called once. The plain error reaches `onError`,
and `result.text` rejects with no answer.

**Reproduction:** `npm ci --ignore-scripts --workspaces=false && npm run reproduce`.
Compare `npm run fixed` for the same real provider chain with error
normalization.

Public reproducer: https://github.com/acchou/workers-ai-retryable-error-repro
