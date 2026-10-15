import {
  streamText,
  tool as sdkTool,
  type AssistantModelMessage,
  type FinishReason,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from 'ai';
import { signConfirmation } from './confirm';
import type { AssistantEvent } from './events';
import { ChainExhaustedError, Cooldowns, FIRST_CHUNK_TIMEOUT_MS, ModelTimeoutError, fallbackReason, modelsToTry, type FallbackReason } from './fallback';
import { modelSettings, type AssistantProvider, type ChainModel } from './providers';
import type { RequestResult } from './quota';
import type { ChatMessage, ConfirmedCall } from './request';
import {
  executeTool,
  needsConfirmation,
  toBase64,
  validateToolInput,
  type AssistantTools,
  type ToolOutcome,
} from './tools';

/** Model calls per question; each tool round is one call. */
export const MAX_ROUNDS = 8;

/**
 * Google documents this value for function-call parts the current model did
 * not produce. It is used when a fallback switches models partway through one
 * answer, because thought signatures are tied to the model that made them.
 */
export const FOREIGN_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export interface TurnOptions {
  provider: AssistantProvider;
  /** Stable instructions, identical across requests (cacheable). */
  system: string;
  /** Per-request context (user, tenant, date, locale…). */
  context?: string;
  history: ChatMessage[];
  tools: AssistantTools;
  send: (event: AssistantEvent) => void;
  signal: AbortSignal;
  maxRounds?: number;
  /** Models recorded as out of daily quota. */
  skipModels?: Iterable<string>;
  cooldowns: Cooldowns;
  onModelRequest?: (model: string, result: RequestResult) => void;
  onToolError?: (error: unknown, toolName: string) => void;
  /**
   * Milliseconds a model may take to send its first response chunk before the
   * call moves to the next model. Default `FIRST_CHUNK_TIMEOUT_MS`; 0 disables.
   */
  firstChunkTimeoutMs?: number;
  /** Called when a model fails and the call moves on to the next model in the chain. */
  onFallback?: (error: unknown, info: FallbackInfo) => void;
  confirmationSecret?: string;
  /** A tool call the user confirmed; it runs before the model is called. */
  confirmed?: ConfirmedCall;
}

export interface FallbackInfo {
  model: string;
  provider?: string;
  reason: FallbackReason;
}

interface Turn {
  message: ModelMessage;
  /** Model that produced an assistant turn; null otherwise. */
  producer: string | null;
}

interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid?: boolean;
  error?: unknown;
}

type ProviderOptionsRecord = Record<string, Record<string, unknown>>;

function withoutGoogleSignature(options: ProviderOptionsRecord | undefined, replacement?: string): ProviderOptionsRecord | undefined {
  if (!options?.google || !('thoughtSignature' in options.google)) {
    return replacement ? { ...options, google: { ...options?.google, thoughtSignature: replacement } } : options;
  }
  const { thoughtSignature: _dropped, ...google } = options.google;
  return { ...options, google: replacement ? { ...google, thoughtSignature: replacement } : google };
}

/** Messages for `model`, neutralising reasoning and signatures other models produced. */
export function messagesFor(turns: readonly Turn[], model: string): ModelMessage[] {
  return turns.map(({ message, producer }) => {
    if (!producer || producer === model || message.role !== 'assistant' || typeof message.content === 'string') return message;
    const content = message.content
      .filter((part) => part.type !== 'reasoning')
      .map((part) => {
        const providerOptions = ('providerOptions' in part ? part.providerOptions : undefined) as ProviderOptionsRecord | undefined;
        if (part.type === 'tool-call') return { ...part, providerOptions: withoutGoogleSignature(providerOptions, FOREIGN_THOUGHT_SIGNATURE) };
        return providerOptions ? { ...part, providerOptions: withoutGoogleSignature(providerOptions) } : part;
      });
    return { ...message, content } as AssistantModelMessage;
  });
}

function sdkTools(tools: AssistantTools): ToolSet {
  const set: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    set[name] = sdkTool({ description: definition.description, inputSchema: definition.inputSchema });
  }
  return set;
}

function instructions(cacheSystemPrompt: boolean | undefined, system: string, context?: string): SystemModelMessage[] {
  const messages: SystemModelMessage[] = [{
    role: 'system',
    content: system,
    ...(cacheSystemPrompt ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } } : {}),
  }];
  if (context?.trim()) messages.push({ role: 'system', content: context });
  return messages;
}

function jsonValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return String(value);
  }
}

function toolResultMessage(results: Array<{ call: ToolCall; outcome: ToolOutcome }>): ModelMessage {
  return {
    role: 'tool',
    content: results.map(({ call, outcome }) => ({
      type: 'tool-result' as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: outcome.isError
        ? typeof outcome.result === 'string'
          ? { type: 'error-text' as const, value: outcome.result }
          : { type: 'error-json' as const, value: jsonValue(outcome.result) as never }
        : { type: 'json' as const, value: jsonValue(outcome.result) as never },
    })),
  };
}

class AbortedError extends Error {
  constructor() {
    super('The request was aborted');
    this.name = 'AbortError';
  }
}

const TIMED_OUT = Symbol('timed out');

const RESPONSE_PARTS = new Set(['text-delta', 'text-start', 'reasoning-start', 'reasoning-delta', 'tool-input-start', 'tool-call', 'finish-step']);

/**
 * Streams one answer: a bounded loop of model calls and tool calls. Each
 * model call walks the provider's chain until one model accepts it; once text
 * has streamed for a call, errors are no longer retried on another model.
 */
export async function runTurn(options: TurnOptions): Promise<void> {
  const { provider, send, signal, tools, cooldowns } = options;
  const firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS;
  const maxRounds = options.maxRounds ?? MAX_ROUNDS;
  const skip = new Set(options.skipModels ?? []);
  const toolSet = sdkTools(tools);
  const systemFor = (entry: ChainModel) => instructions(modelSettings(provider, entry).cacheSystemPrompt, options.system, options.context);
  const turns: Turn[] = options.history.map((message) => ({ message, producer: null }));
  let textSent = options.history.length > 0 && options.history[options.history.length - 1]!.role === 'assistant';

  async function runCalls(calls: ToolCall[]) {
    return Promise.all(calls.map(async (call) => {
      send({ type: 'tool', name: call.toolName, id: call.toolCallId });
      const definition = tools[call.toolName];
      if (!definition) return { call, outcome: { result: `Unknown tool ${call.toolName}`, isError: true } };
      if (call.invalid) {
        const message = call.error instanceof Error ? call.error.message : 'Invalid tool input';
        return { call, outcome: { result: `Invalid input: ${message}`, isError: true } };
      }
      const outcome = await executeTool(definition, call.input, {
        signal,
        toolCallId: call.toolCallId,
        attachFile: (file) => send({ type: 'file', fileName: file.fileName, mimeType: file.mimeType, data: toBase64(file.data) }),
      }, (error) => options.onToolError?.(error, call.toolName));
      return { call, outcome };
    }));
  }

  if (options.confirmed) {
    const { id, name, input } = options.confirmed;
    const call: ToolCall = { toolCallId: id, toolName: name, input };
    // History is plain text, so the confirmed call is replayed as this
    // assistant turn's tool call; no model produced it.
    const last = turns[turns.length - 1];
    const toolCallPart = {
      type: 'tool-call' as const,
      toolCallId: id,
      toolName: name,
      input,
      providerOptions: { google: { thoughtSignature: FOREIGN_THOUGHT_SIGNATURE } },
    };
    if (last && last.message.role === 'assistant' && typeof last.message.content === 'string') {
      last.message = { role: 'assistant', content: [{ type: 'text', text: last.message.content }, toolCallPart] };
    } else {
      turns.push({ message: { role: 'assistant', content: [toolCallPart] }, producer: null });
    }
    turns.push({ message: toolResultMessage(await runCalls([call])), producer: null });
  }

  async function streamRound() {
    const candidates = modelsToTry(provider.models, skip, cooldowns);
    const errors: unknown[] = [];
    for (const entry of candidates) {
      let roundText = false;
      let accepted = false;
      const settings = modelSettings(provider, entry);
      // Aborts this model's call alone on a stall; the request signal aborts it too.
      const call = new AbortController();
      const abortCall = () => call.abort(signal.reason);
      signal.addEventListener('abort', abortCall, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = firstChunkTimeoutMs > 0
        ? new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), firstChunkTimeoutMs);
        })
        : undefined;
      try {
        const result = streamText({
          model: entry.languageModel,
          instructions: systemFor(entry),
          messages: messagesFor(turns, entry.model),
          tools: toolSet,
          maxRetries: provider.maxRetries,
          ...(settings.maxOutputTokens ? { maxOutputTokens: settings.maxOutputTokens } : {}),
          ...(settings.providerOptions ? { providerOptions: settings.providerOptions as never } : {}),
          abortSignal: call.signal,
          // The AI SDK's default logs the whole error, whose requestBodyValues
          // hold the prompt, history and tool results. Errors still reach the
          // stream below and the handler's content-free `onError`.
          onError: () => {},
        });
        const calls: ToolCall[] = [];
        let finishReason: FinishReason | undefined;
        const parts = result.stream[Symbol.asyncIterator]();
        for (;;) {
          // Until the model sends its first response chunk, a stall moves the
          // call to the next model; afterwards the stream is awaited as is.
          const next = !accepted && stalled ? await Promise.race([parts.next(), stalled]) : await parts.next();
          if (next === TIMED_OUT) {
            call.abort();
            parts.return?.().catch(() => {});
            throw new ModelTimeoutError(entry.model, firstChunkTimeoutMs);
          }
          if (next.done) break;
          const part = next.value;
          if (!accepted && RESPONSE_PARTS.has(part.type)) {
            accepted = true;
            clearTimeout(timer);
            options.onModelRequest?.(entry.model, 'ok');
            send({
              type: 'model',
              model: entry.model,
              ...(entry.provider ?? provider.name ? { provider: entry.provider ?? provider.name } : {}),
              ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
            });
          }
          switch (part.type) {
            case 'text-delta':
              if (!part.text) break;
              // Separate text from different rounds ("Let me check…" then the answer).
              send({ type: 'text', text: !roundText && textSent ? `\n\n${part.text}` : part.text });
              roundText = true;
              textSent = true;
              break;
            case 'tool-call':
              calls.push(part as ToolCall);
              break;
            case 'finish-step':
              finishReason = part.finishReason;
              if (typeof part.usage.inputTokens === 'number') {
                send({ type: 'usage', model: entry.model, inputTokens: part.usage.inputTokens, outputTokens: part.usage.outputTokens ?? 0 });
              }
              break;
            case 'error':
              throw part.error;
            case 'abort':
              throw new AbortedError();
            default:
              break;
          }
        }
        if (signal.aborted) throw new AbortedError();
        const responseMessages = await result.responseMessages;
        return { model: entry.model, calls, finishReason, roundText, responseMessages };
      } catch (error) {
        if (signal.aborted) throw error;
        const reason = fallbackReason(error);
        if (reason === null || roundText) throw error;
        cooldowns.set(entry.model, reason);
        if (reason === 'daily') {
          skip.add(entry.model);
          options.onModelRequest?.(entry.model, 'daily_limit');
        }
        const providerName = entry.provider ?? provider.name;
        options.onFallback?.(error, { model: entry.model, ...(providerName ? { provider: providerName } : {}), reason });
        errors.push(error);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abortCall);
      }
    }
    throw new ChainExhaustedError(errors);
  }

  for (let round = 0; ; round += 1) {
    if (round >= maxRounds) {
      send({ type: 'error', code: 'TOO_LONG' });
      return;
    }

    const { model, calls, finishReason, roundText, responseMessages } = await streamRound();

    if (calls.length === 0) {
      // An empty answer or a blocked one is reported rather than left blank.
      if (!roundText && (finishReason === 'content-filter' || !textSent)) {
        send({ type: 'error', code: 'REFUSED' });
      }
      return;
    }
    if (finishReason === 'length') {
      // A tool call cut off by the token limit must not run.
      send({ type: 'error', code: 'TOO_LONG' });
      return;
    }

    for (const message of responseMessages) {
      turns.push({ message, producer: message.role === 'assistant' ? model : null });
    }

    const proposals: ToolCall[] = [];
    for (const call of calls) {
      const definition = tools[call.toolName];
      if (definition && !call.invalid && await needsConfirmation(definition, call.input)) proposals.push(call);
    }
    if (proposals.length) {
      // Nothing in this round runs until the user confirms; each confirmation
      // continues the conversation with that one call.
      for (const call of proposals) {
        const definition = tools[call.toolName]!;
        const checked = await validateToolInput(definition, call.input);
        if (!checked.ok) continue;
        const summary = definition.describe ? await definition.describe(checked.value) : undefined;
        const token = options.confirmationSecret
          ? await signConfirmation(options.confirmationSecret, { id: call.toolCallId, name: call.toolName, input: call.input })
          : undefined;
        send({
          type: 'confirm',
          id: call.toolCallId,
          name: call.toolName,
          input: call.input,
          ...(summary ? { summary } : {}),
          ...(token ? { token } : {}),
        });
      }
      return;
    }

    turns.push({ message: toolResultMessage(await runCalls(calls)), producer: null });
  }
}
