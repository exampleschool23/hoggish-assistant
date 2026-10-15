import { verifyConfirmation } from './confirm';
import { ERROR_STATUS, encodeEvent, type AssistantErrorCode, type AssistantEvent, type ModelInfo } from './events';
import { ChainExhaustedError, Cooldowns, fallbackReason, modelsToTry, statusCode, type FallbackReason } from './fallback';
import { MAX_ROUNDS, runTurn } from './loop';
import type { AssistantProvider } from './providers';
import { exhaustedModels, quotaDate, summarizeQuota, trackedModels, type QuotaStore, type QuotaSummary, type RequestResult } from './quota';
import { DEFAULT_LIMITS, parseChatRequest, type ConfirmedCall, type RequestLimits } from './request';
import { validateToolInput, type AssistantTools } from './tools';

/** Throw from `authorize` (or other callbacks) to answer with a specific code. */
export class AssistantError extends Error {
  constructor(readonly code: AssistantErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AssistantError';
  }
}

export type ErrorStage = 'authorize' | 'model' | 'tool' | 'quota' | 'setup';

export interface ErrorInfo {
  stage: ErrorStage;
  provider?: string;
  tool?: string;
  /** The model that failed, when the chain moved on to the next one. */
  model?: string;
  status?: number;
  /** Why the chain moved on (`stage: 'model'` fallbacks only). */
  reason?: FallbackReason;
}

type MaybePromise<T> = T | Promise<T>;

export interface AssistantHandlerOptions<CTX> {
  /**
   * Authenticates the request and returns the app's context (user, tenant,
   * permissions). `context` is the client's `context` value, unvalidated.
   * Return null for UNAUTHORIZED; throw `AssistantError('FORBIDDEN')` etc.
   */
  authorize: (request: Request, context: unknown) => MaybePromise<CTX | null | undefined>;
  provider: AssistantProvider | ((ctx: CTX) => MaybePromise<AssistantProvider>);
  /** Stable system prompt, identical across requests so it can be cached. */
  system: string | ((ctx: CTX) => MaybePromise<string>);
  /** Per-request context appended after the system prompt (date, tenant name, locale…). */
  context?: (ctx: CTX) => MaybePromise<string>;
  /** Tools for this request; defaults to none. */
  tools?: (ctx: CTX) => MaybePromise<AssistantTools>;
  /** Daily request counts for quota-tracked models. */
  quotaStore?: QuotaStore;
  /**
   * Milliseconds each model may take to send its first response chunk before
   * the call moves to the next model (with a cooldown, as for a 503). Default
   * 25 000; 0 disables. Once text has streamed, a model is never swapped.
   */
  firstChunkTimeoutMs?: number;
  /** Model calls per question. Default 8. */
  maxRounds?: number;
  limits?: Partial<RequestLimits>;
  /** Signs confirmation proposals so only calls the server proposed can run. Recommended. */
  confirmationSecret?: string;
  /** Used for the "questions left" estimate. Default 3. */
  requestsPerQuestion?: number;
  /** Extra headers on every response (CORS for Edge Functions, for example). */
  headers?: Record<string, string>;
  /**
   * Logs failures, including each model the chain skipped past (`stage:
   * 'model'` with `model` and `reason`). Defaults to a console.error without
   * message content.
   */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

/** Body of the usage endpoint (GET). */
export interface UsageResponse {
  provider: string | null;
  /** The model that would answer the next question; null when none is available. */
  model: ModelInfo | null;
  /** Null when the provider is not quota-tracked or usage cannot be read. */
  quota: QuotaSummary | null;
}

export interface AssistantHandler {
  /** POST: one chat turn, streamed as NDJSON events. */
  chat(request: Request): Promise<Response>;
  /** GET: `{ provider, model, quota }`; `quota` is null for untracked providers. */
  usage(request: Request): Promise<Response>;
  /** Routes POST to `chat`, GET to `usage` and answers OPTIONS (for one Edge Function). */
  handle(request: Request): Promise<Response>;
  /** Today's quota summary without a request, e.g. for server-rendered pages. */
  quota(provider?: AssistantProvider): Promise<QuotaSummary | null>;
}

function defaultOnError(error: unknown, info: ErrorInfo) {
  console.error('[hoggish-assistant]', info.stage, {
    ...info,
    name: error instanceof Error ? error.name : typeof error,
  });
}

/** Maps a failure during a turn to the code shown to the user. */
export function errorCode(error: unknown): AssistantErrorCode {
  if (error instanceof AssistantError) return error.code;
  if (error instanceof ChainExhaustedError || fallbackReason(error) !== null) return 'BUSY';
  return 'SERVER_ERROR';
}

/**
 * Creates a framework-agnostic assistant endpoint using Web Request/Response.
 * Create it once at module scope so per-model cooldowns survive between
 * requests on a warm instance.
 */
export function createAssistantHandler<CTX>(options: AssistantHandlerOptions<CTX>): AssistantHandler {
  const limits: RequestLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const cooldowns = new Cooldowns();
  const onError = options.onError ?? defaultOnError;
  const extraHeaders = options.headers ?? {};

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    });
  }

  function errorResponse(code: AssistantErrorCode): Response {
    return json({ error: code }, ERROR_STATUS[code]);
  }

  async function authorize(request: Request, context: unknown): Promise<{ ok: true; ctx: CTX } | { ok: false; response: Response }> {
    try {
      const ctx = await options.authorize(request, context);
      if (ctx === null || ctx === undefined) return { ok: false, response: errorResponse('UNAUTHORIZED') };
      return { ok: true, ctx };
    } catch (error) {
      if (error instanceof AssistantError) return { ok: false, response: errorResponse(error.code) };
      onError(error, { stage: 'authorize' });
      return { ok: false, response: errorResponse('SERVER_ERROR') };
    }
  }

  async function resolveProvider(ctx: CTX): Promise<AssistantProvider> {
    return typeof options.provider === 'function' ? options.provider(ctx) : options.provider;
  }

  async function loadQuota(provider: AssistantProvider, day: string) {
    if (!options.quotaStore || trackedModels(provider.models).length === 0) return null;
    try {
      return await options.quotaStore.load(day);
    } catch (error) {
      onError(error, { stage: 'quota', provider: provider.name });
      return null;
    }
  }

  async function quota(provider: AssistantProvider): Promise<QuotaSummary | null> {
    if (!provider.configured) return null;
    const now = new Date();
    const rows = await loadQuota(provider, quotaDate(now, provider.quotaTimeZone));
    if (!rows) return null;
    return summarizeQuota(provider.models, rows, now, {
      timeZone: provider.quotaTimeZone,
      requestsPerQuestion: options.requestsPerQuestion,
    });
  }

  /** The model the next question would go to: first in the chain that is neither used up nor cooling down. */
  async function nextModel(provider: AssistantProvider): Promise<ModelInfo | null> {
    if (!provider.configured) return null;
    const rows = await loadQuota(provider, quotaDate(new Date(), provider.quotaTimeZone));
    const skip = rows ? exhaustedModels(provider.models, rows) : [];
    const entry = modelsToTry(provider.models, new Set(skip), cooldowns)[0];
    if (!entry) return null;
    const providerName = entry.provider ?? provider.name;
    return {
      model: entry.model,
      ...(providerName ? { provider: providerName } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    };
  }

  async function checkConfirmation(confirmation: ConfirmedCall, tools: AssistantTools): Promise<ConfirmedCall | AssistantErrorCode> {
    const definition = tools[confirmation.name];
    if (!definition?.needsConfirmation) return 'INVALID_REQUEST';
    if (options.confirmationSecret) {
      const valid = await verifyConfirmation(options.confirmationSecret, confirmation.token, confirmation);
      if (!valid) return 'FORBIDDEN';
    }
    const checked = await validateToolInput(definition, confirmation.input);
    if (!checked.ok) return 'INVALID_REQUEST';
    return { ...confirmation, input: checked.value };
  }

  async function chat(request: Request): Promise<Response> {
    const raw = await request.json().catch(() => null) as { context?: unknown } | null;
    const access = await authorize(request, raw && typeof raw === 'object' ? raw.context : undefined);
    if (!access.ok) return access.response;
    const body = parseChatRequest(raw, limits);
    if (!body) return errorResponse('INVALID_REQUEST');
    const { ctx } = access;

    let provider: AssistantProvider;
    let system: string;
    let context: string | undefined;
    let tools: AssistantTools;
    try {
      provider = await resolveProvider(ctx);
      if (!provider.configured || provider.models.length === 0) return errorResponse('NOT_CONFIGURED');
      [system, context, tools] = await Promise.all([
        typeof options.system === 'function' ? options.system(ctx) : options.system,
        options.context?.(ctx),
        options.tools?.(ctx) ?? {},
      ]);
    } catch (error) {
      if (error instanceof AssistantError) return errorResponse(error.code);
      onError(error, { stage: 'setup' });
      return errorResponse('SERVER_ERROR');
    }

    let confirmed: ConfirmedCall | undefined;
    if (body.confirmation) {
      const checked = await checkConfirmation(body.confirmation, tools);
      if (typeof checked === 'string') return errorResponse(checked);
      confirmed = checked;
    }

    const day = quotaDate(new Date(), provider.quotaTimeZone);
    const rows = await loadQuota(provider, day);
    const store = rows ? options.quotaStore : undefined;
    const pending: Promise<unknown>[] = [];
    const record = (model: string, result: RequestResult) => {
      if (!store || !trackedModels(provider.models).some((entry) => entry.model === model)) return;
      pending.push(store.record(day, model, result).catch((error: unknown) => onError(error, { stage: 'quota', provider: provider.name })));
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: AssistantEvent) => {
          // The browser may have gone away; dropping late events is fine.
          try {
            controller.enqueue(encoder.encode(encodeEvent(event)));
          } catch {
            // ignore
          }
        };

        try {
          await runTurn({
            provider,
            system,
            context,
            history: body.messages,
            tools,
            send,
            signal: request.signal,
            maxRounds: options.maxRounds ?? MAX_ROUNDS,
            skipModels: rows ? exhaustedModels(provider.models, rows) : undefined,
            cooldowns,
            onModelRequest: record,
            onToolError: (error, tool) => onError(error, { stage: 'tool', provider: provider.name, tool }),
            onFallback: (error, info) => onError(error, { stage: 'model', ...info, status: statusCode(error) }),
            firstChunkTimeoutMs: options.firstChunkTimeoutMs,
            confirmationSecret: options.confirmationSecret,
            confirmed,
          });
          send({ type: 'done' });
        } catch (error) {
          if (!request.signal.aborted) {
            onError(error, { stage: 'model', provider: provider.name, status: statusCode(error) });
            send({ type: 'error', code: errorCode(error) });
          }
        } finally {
          await Promise.allSettled(pending);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        ...extraHeaders,
      },
    });
  }

  async function usage(request: Request): Promise<Response> {
    let context: unknown;
    const param = new URL(request.url).searchParams.get('context');
    if (param) {
      try {
        context = JSON.parse(param);
      } catch {
        return errorResponse('INVALID_REQUEST');
      }
    }
    const access = await authorize(request, context);
    if (!access.ok) return access.response;
    try {
      const provider = await resolveProvider(access.ctx);
      const body: UsageResponse = { provider: provider.name, model: await nextModel(provider), quota: await quota(provider) };
      return json(body);
    } catch (error) {
      onError(error, { stage: 'quota' });
      const body: UsageResponse = { provider: null, model: null, quota: null };
      return json(body);
    }
  }

  async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: extraHeaders });
    if (request.method === 'GET') return usage(request);
    if (request.method === 'POST') return chat(request);
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST, OPTIONS', ...extraHeaders } });
  }

  return {
    chat,
    usage,
    handle,
    quota: async (provider) => {
      if (provider) return quota(provider);
      if (typeof options.provider === 'function') return null;
      return quota(options.provider);
    },
  };
}
