import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { readEventStream, type AssistantEvent } from '../src/events';
import { customProvider, type AssistantProvider } from '../src/providers';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

export interface Step {
  text?: string | string[];
  calls?: Array<{ id: string; name: string; input: unknown; signature?: string }>;
  finish?: 'stop' | 'tool-calls' | 'length' | 'content-filter';
  /** Emitted as a stream error after the text. */
  errorAfterText?: unknown;
  /** Waits this long (setTimeout, so fake timers apply) after the text before finishing. */
  pauseAfterTextMs?: number;
}

/** The model accepts the call, then never sends a chunk until the call is aborted. */
export const STALL = { stall: true } as const;

/** A model call streams a step, stalls, or fails before streaming. */
export type Response = Step | Error | typeof STALL;


function chunksFor(step: Step): unknown[] {
  const chunks: unknown[] = [{ type: 'stream-start', warnings: [] }];
  const texts = step.text === undefined ? [] : Array.isArray(step.text) ? step.text : [step.text];
  if (texts.length) {
    chunks.push({ type: 'text-start', id: 't1' });
    for (const delta of texts) chunks.push({ type: 'text-delta', id: 't1', delta });
    chunks.push({ type: 'text-end', id: 't1' });
  }
  if (step.errorAfterText) {
    chunks.push({ type: 'error', error: step.errorAfterText });
    return chunks;
  }
  for (const call of step.calls ?? []) {
    chunks.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input),
      ...(call.signature ? { providerMetadata: { google: { thoughtSignature: call.signature } } } : {}),
    });
  }
  const unified = step.finish ?? (step.calls?.length ? 'tool-calls' : 'stop');
  chunks.push({ type: 'finish', finishReason: { unified, raw: unified }, usage });
  return chunks;
}

export function mockModel(id: string, responses: Response[]) {
  let index = 0;
  const model = new MockLanguageModelV4({
    modelId: id,
    doStream: async ({ abortSignal }) => {
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      if (response instanceof Error) throw response;
      if ('stall' in response) {
        return {
          stream: new ReadableStream({
            start(controller) {
              // Like an aborted fetch: the only way this stream ends.
              abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), { once: true });
            },
          }),
        };
      }
      const chunks = chunksFor(response);
      const pause = response.pauseAfterTextMs;
      const textEnd = chunks.findIndex((chunk) => (chunk as { type: string }).type === 'text-end') + 1;
      return {
        stream: new ReadableStream({
          async start(controller) {
            for (const [position, chunk] of chunks.entries()) {
              if (pause && position === textEnd) await new Promise((resolve) => setTimeout(resolve, pause));
              controller.enqueue(chunk as never);
            }
            controller.close();
          },
        }),
      };
    },
  });
  return model;
}

export function apiError(status: number, message = `HTTP ${status}`, responseBody?: string, requestBodyValues: unknown = {}) {
  return new APICallError({
    message,
    url: 'https://example.test/v1/models',
    requestBodyValues,
    statusCode: status,
    responseBody,
    isRetryable: false,
  });
}

export const dailyQuotaError = () => apiError(
  429,
  'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 20',
  '{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}',
);

export const minuteQuotaError = () => apiError(
  429,
  'Quota exceeded for metric: generate_content_free_tier_requests',
  '{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]}}',
);

export function chainProvider(models: Array<{ id: string; responses: Response[]; dailyLimit?: number }>): AssistantProvider & { mocks: MockLanguageModelV4[] } {
  const mocks = models.map((entry) => mockModel(entry.id, entry.responses));
  const provider = customProvider({
    name: 'mock',
    models: models.map((entry, index) => ({ model: entry.id, dailyLimit: entry.dailyLimit, languageModel: mocks[index]! })),
  });
  return { ...provider, mocks };
}

export async function collect(response: globalThis.Response): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  for await (const event of readEventStream(response.body!)) events.push(event);
  return events;
}

export function textOf(events: AssistantEvent[]): string {
  return events.map((event) => (event.type === 'text' ? event.text : '')).join('');
}

export function chatRequest(body: unknown, init: RequestInit = {}) {
  return new Request('https://app.test/api/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}
