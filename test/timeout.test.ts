import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_CHUNK_TIMEOUT_MS, ModelTimeoutError, fallbackReason } from '../src/fallback';
import { createAssistantHandler, type AssistantHandlerOptions, type ErrorInfo } from '../src/handler';
import type { AssistantProvider } from '../src/providers';
import { apiError, chainProvider, chatRequest, collect, dailyQuotaError, minuteQuotaError, STALL, textOf } from './helpers';

const question = { messages: [{ role: 'user', content: 'Hi' }] };

function handlerFor(provider: AssistantProvider, extra: Partial<AssistantHandlerOptions<object>> = {}) {
  const errors: Array<{ error: unknown; info: ErrorInfo }> = [];
  const handler = createAssistantHandler({
    authorize: () => ({}),
    provider,
    system: 'test',
    onError: (error, info) => errors.push({ error, info }),
    ...extra,
  });
  return { handler, errors };
}

describe('first-chunk timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts a turn and waits until the first model has been called; resolves to the events promise. */
  async function start(handler: ReturnType<typeof handlerFor>['handler'], provider: ReturnType<typeof chainProvider>) {
    const events = handler.chat(chatRequest(question)).then(collect);
    await vi.waitFor(() => expect(provider.mocks[0]!.doStreamCalls).toHaveLength(1));
    return { events };
  }

  it('moves a stalled model to the next one and cools it down', async () => {
    const provider = chainProvider([
      { id: 'strong', responses: [STALL] },
      { id: 'light', responses: [{ text: 'from light' }] },
    ]);
    const { handler, errors } = handlerFor(provider);

    const { events: pending } = await start(handler, provider);
    expect(provider.mocks[1]!.doStreamCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS);
    const events = await pending;

    expect(textOf(events)).toBe('from light');
    expect(events).toContainEqual({ type: 'model', model: 'light', provider: 'mock' });
    expect(events.some((event) => event.type === 'error')).toBe(false);
    // The stalled call was aborted rather than left running.
    expect(provider.mocks[0]!.doStreamCalls[0]!.abortSignal?.aborted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBeInstanceOf(ModelTimeoutError);
    expect(errors[0]!.info).toEqual({ stage: 'model', model: 'strong', provider: 'mock', reason: 'unavailable', status: undefined });

    // Cooling down: the next question goes straight to the light model.
    await collect(await handler.chat(chatRequest(question)));
    expect(provider.mocks[0]!.doStreamCalls).toHaveLength(1);
    expect(provider.mocks[1]!.doStreamCalls).toHaveLength(2);
  });

  it('honours a custom timeout', async () => {
    const provider = chainProvider([
      { id: 'strong', responses: [STALL] },
      { id: 'light', responses: [{ text: 'ok' }] },
    ]);
    const { handler } = handlerFor(provider, { firstChunkTimeoutMs: 5_000 });

    const { events: pending } = await start(handler, provider);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(provider.mocks[1]!.doStreamCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(textOf(await pending)).toBe('ok');
  });

  it('reports BUSY when every model stalls', async () => {
    const provider = chainProvider([
      { id: 'strong', responses: [STALL] },
      { id: 'light', responses: [STALL] },
    ]);
    const { handler, errors } = handlerFor(provider);

    const { events: pending } = await start(handler, provider);
    await vi.advanceTimersByTimeAsync(2 * FIRST_CHUNK_TIMEOUT_MS);
    expect(await pending).toContainEqual({ type: 'error', code: 'BUSY' });
    expect(errors.map(({ info }) => [info.model, info.reason])).toEqual([
      ['strong', 'unavailable'],
      ['light', 'unavailable'],
      [undefined, undefined],
    ]);
  });

  it('never swaps models once text has streamed, however long the model pauses', async () => {
    const provider = chainProvider([
      { id: 'strong', responses: [{ text: ['Let me ', 'think'], pauseAfterTextMs: 3 * FIRST_CHUNK_TIMEOUT_MS }] },
      { id: 'light', responses: [{ text: 'from light' }] },
    ]);
    const { handler, errors } = handlerFor(provider);

    const { events: pending } = await start(handler, provider);
    await vi.advanceTimersByTimeAsync(3 * FIRST_CHUNK_TIMEOUT_MS);
    expect(textOf(await pending)).toBe('Let me think');
    expect(provider.mocks[1]!.doStreamCalls).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('can be turned off', async () => {
    const provider = chainProvider([
      { id: 'strong', responses: [{ text: 'slow', pauseAfterTextMs: 0 }] },
      { id: 'light', responses: [{ text: 'from light' }] },
    ]);
    const { handler } = handlerFor(provider, { firstChunkTimeoutMs: 0 });
    const { events: pending } = await start(handler, provider);
    expect(vi.getTimerCount()).toBe(0);
    expect(textOf(await pending)).toBe('slow');
  });
});

describe('fallback reporting', () => {
  it('reports each model the chain skipped, with status and reason', async () => {
    const provider = chainProvider([
      { id: 'a', responses: [dailyQuotaError()] },
      { id: 'b', responses: [minuteQuotaError()] },
      { id: 'c', responses: [apiError(404)] },
      { id: 'd', responses: [apiError(503)] },
      { id: 'e', responses: [{ text: 'ok' }] },
    ]);
    const { handler, errors } = handlerFor(provider);
    const events = await collect(await handler.chat(chatRequest(question)));
    expect(textOf(events)).toBe('ok');
    expect(errors.map(({ info }) => info)).toEqual([
      { stage: 'model', model: 'a', provider: 'mock', status: 429, reason: 'daily' },
      { stage: 'model', model: 'b', provider: 'mock', status: 429, reason: 'rate' },
      { stage: 'model', model: 'c', provider: 'mock', status: 404, reason: 'missing' },
      { stage: 'model', model: 'd', provider: 'mock', status: 503, reason: 'unavailable' },
    ]);
  });

  it('does not report a model that answered after streaming started', async () => {
    const provider = chainProvider([{ id: 'a', responses: [{ text: 'ok' }] }, { id: 'b', responses: [{ text: 'no' }] }]);
    const { handler, errors } = handlerFor(provider);
    await collect(await handler.chat(chatRequest(question)));
    expect(errors).toEqual([]);
  });

  it('maps a timeout to the unavailable reason', () => {
    expect(fallbackReason(new ModelTimeoutError('m', 1))).toBe('unavailable');
  });
});
