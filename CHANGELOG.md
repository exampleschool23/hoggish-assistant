# Changelog

## 0.3.1

- Time out stalled models: a model that accepts a call but sends no response chunk within
  `firstChunkTimeoutMs` (new handler option, default 25 000 ms, 0 disables) is aborted and the call
  moves to the next model, with the 60-second `unavailable` cooldown. Previously a stalled
  `gemini-3.8-flash` could hold an answer for minutes. Once text has streamed, models are still never
  swapped. `ModelTimeoutError` and `FIRST_CHUNK_TIMEOUT_MS` are exported.
- Report every fallback: when a model fails and the chain moves on, the handler's `onError` gets
  `stage: 'model'` with `provider`, `model`, `status` and `reason`. Still no message content.
- `require('hoggish-assistant/…')` works: every export has a `default` condition (the ESM build;
  CommonJS callers need Node 20.19+ or 22.12+, or a loader such as tsx). Previously it failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## 0.3.0

- Show which model is answering: the stream sends a `model` event when a model accepts a call
  (`{ model, provider?, contextWindow? }`) and a `usage` event with the provider's token counts
  when the call finishes. The usage endpoint now answers `{ provider, model, quota }`, where
  `model` is the model the next question would go to.
- Context-window status in the browser: `useAssistantChat` returns `model` (the model in use) and
  `context` (`contextWindow`, `usedTokens`, `tokensLeft`, `usedShare`, `messagesLeft`); each
  assistant message carries the `model` that produced it. `contextStatus` and `estimateTokens` are
  exported for custom clients.
- Models carry a `contextWindow`, defaulted from `contextWindowFor(modelId)` (Gemini 1 048 576;
  Claude 4.6+ and Claude 5 families 1 000 000; earlier Claude 200 000) and overridable per model.

## 0.2.0

- Add `providerChain`: join several providers, each with its own API key, into one fallback chain
  ranked by `priority`. When a model's daily quota is used up, or it is rate limited or down, the
  next model answers inline, even across providers. Unconfigured links are skipped; duplicate
  model ids are prefixed with the link name.
- `ASSISTANT_PROVIDER` accepts a comma-separated priority list (`gemini,anthropic`), which makes
  `providerFromEnv` build such a chain.
- A `ChainModel` can carry its own `maxOutputTokens`, `providerOptions` and `cacheSystemPrompt`;
  `modelSettings` resolves them with the provider's values as defaults.

## 0.1.1

- Fix a privacy leak: when a model call failed (for example a 503 that moved the turn to the next
  model in the chain), the AI SDK's default `streamText` error logger printed the whole
  `APICallError`, whose `requestBodyValues` contain the system prompt, user messages and tool
  results. The library now passes its own `onError`. Errors are still handled and reported through
  the handler's `onError`, which logs only stage, provider, tool, status and error name.
- Add a test that fails if prompt or tool-result text reaches `console` or `process.emitWarning`.

## 0.1.0

- First release: fallback chain, quota tracking, Web Request/Response handler with tool loop and
  NDJSON events, confirm-before-action tools, `useAssistantChat`, Markdown and Excel helpers.
