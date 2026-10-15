import { AssistantErrorCode, RequestLimits, ModelInfo, ChatMessage, AssistantEvent, ConfirmedCall } from './index.js';
export { ASSISTANT_ERROR_CODES, ChatRequestBody, ConfirmationRequest, DEFAULT_LIMITS, ERROR_STATUS, UsageInfo, encodeEvent, estimateTokens, isAssistantErrorCode, parseChatRequest, parseEventChunk, readEventStream, trimHistory } from './index.js';
import { a as QuotaModel, b as QuotaSummary, Q as QuotaStore, R as RequestResult } from './quota-DBUQslDa.js';
export { M as ModelQuota, c as ModelUsageRow, P as PACIFIC_TIME_ZONE, d as QuotaOptions, e as REQUESTS_PER_QUESTION, f as createMemoryQuotaStore, g as exhaustedModels, n as nextQuotaReset, q as quotaDate, s as summarizeQuota, t as trackedModels } from './quota-DBUQslDa.js';
import { LanguageModel } from 'ai';
import { a as AssistantTools } from './tools-Bze-ziwC.js';
export { A as AssistantFile, b as AssistantTool, T as ToolError, c as ToolRunOptions, d as defineTool, t as toBase64 } from './tools-Bze-ziwC.js';

/**
 * Why a model failed in a way that should move the turn to the next model:
 * - `daily`: per-day quota used up (recorded in the quota store)
 * - `rate`: per-minute or other short-lived 429
 * - `missing`: the model id does not exist for this key (404)
 * - `unavailable`: provider overloaded or failing (500, 503, 529), or it sent
 *   nothing before the first-chunk timeout
 */
type FallbackReason = 'daily' | 'rate' | 'missing' | 'unavailable';
/** How long this server instance skips a model after each kind of failure. */
declare const COOLDOWN_MS: Record<FallbackReason, number>;
/** Gemini says which quota a 429 hit; only a per-day limit lasts until reset. */
declare function isDailyQuotaError(message: string | undefined): boolean;
/** Default wait for a model's first response chunk before moving to the next model. */
declare const FIRST_CHUNK_TIMEOUT_MS = 25000;
/** A model accepted the call but sent no response within the first-chunk timeout. */
declare class ModelTimeoutError extends Error {
    readonly model: string;
    readonly timeoutMs: number;
    constructor(model: string, timeoutMs: number);
}
declare function fallbackReason(error: unknown): FallbackReason | null;
/** Per-instance memory of models that recently failed. */
declare class Cooldowns {
    private readonly clock;
    private readonly until;
    constructor(clock?: () => number);
    set(model: string, reason: FallbackReason): void;
    isCooling(model: string): boolean;
    clear(): void;
}
/**
 * Models to try for one model call, strongest first. Models recorded as used
 * up or cooling down are skipped; if that leaves nothing, the full chain is
 * tried anyway, because the provider is the final authority on its quota.
 * Models cooling down after a failure on this instance are never retried early.
 */
declare function modelsToTry<T extends {
    model: string;
}>(chain: readonly T[], skip: ReadonlySet<string>, cooldowns: Cooldowns): T[];
/** Thrown when every model in the chain failed with a fallback error. */
declare class ChainExhaustedError extends Error {
    readonly errors: unknown[];
    constructor(errors: unknown[]);
}

/** Provider-specific call options, keyed by provider (`google`, `anthropic`, …). */
type ProviderOptions = Record<string, Record<string, unknown>>;
/** Call settings that a model in a chain may override from its provider. */
interface ModelSettings {
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
    /** Mark the stable system prompt cacheable (Anthropic prompt caching). */
    cacheSystemPrompt?: boolean;
}
/** One model in a fallback chain. */
interface ChainModel extends QuotaModel, ModelSettings {
    /** Stable id used for quota rows and cooldowns, normally the model id. */
    model: string;
    languageModel: LanguageModel;
    /** Name of the provider this model came from, set by `providerChain`. */
    provider?: string;
    /**
     * Context window in tokens. Defaults to `contextWindowFor(model)`; the
     * browser uses it to estimate how many more messages fit.
     */
    contextWindow?: number;
}
/**
 * Known context windows (tokens) by model id prefix. Longest prefix wins.
 * Gemini models take 1 048 576 tokens; the Claude 4.6+ and Claude 5 families
 * 1 000 000; earlier Claude models 200 000.
 */
declare const CONTEXT_WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]>;
/** Context window for a model id, ignoring a `name/` prefix; undefined when unknown. */
declare function contextWindowFor(model: string): number | undefined;
/**
 * A configured provider: an ordered model chain (strongest first) plus call
 * settings. Build one with `geminiProvider`, `anthropicProvider`,
 * `customProvider` or `providerFromEnv`; switching providers is a config change.
 */
interface AssistantProvider extends ModelSettings {
    name: string;
    /** False when the server-side API key is missing. */
    configured: boolean;
    models: ChainModel[];
    /** Time zone whose midnight resets the daily limits. */
    quotaTimeZone: string;
    /** AI SDK retries per model. Chains default to 0 so fallback is immediate. */
    maxRetries: number;
}
type ModelInput = string | (QuotaModel & {
    contextWindow?: number;
});
/**
 * Free-tier Gemini models, strongest first, with their requests-per-day
 * limits. Each model has its own quota, so the chain walks down as they run out.
 */
declare const GEMINI_FREE_MODELS: readonly Required<QuotaModel>[];
declare const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
interface GeminiProviderOptions {
    apiKey: string | undefined;
    /**
     * Model chain, strongest first. Defaults to the free chain with daily limits.
     * For a paid tier pass plain model ids (no `dailyLimit`) to turn quota tracking off.
     */
    models?: readonly ModelInput[];
    baseURL?: string;
    quotaTimeZone?: string;
    maxRetries?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
}
declare function geminiProvider(options: GeminiProviderOptions): AssistantProvider;
interface AnthropicProviderOptions {
    apiKey: string | undefined;
    /** Defaults to `claude-opus-5-5`. */
    model?: string;
    /** Tried in order when the main model is overloaded or rate limited. */
    fallbackModels?: readonly string[];
    baseURL?: string;
    maxRetries?: number;
    /** Defaults to 16 000. */
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
}
declare function anthropicProvider(options: AnthropicProviderOptions): AssistantProvider;
interface CustomProviderOptions {
    name: string;
    models: ChainModel[];
    configured?: boolean;
    quotaTimeZone?: string;
    maxRetries?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
    cacheSystemPrompt?: boolean;
}
/** Any AI SDK language models (OpenAI, Bedrock, Vertex, a mock in tests, …). */
declare function customProvider(options: CustomProviderOptions): AssistantProvider;
/**
 * One link of a `providerChain`: a provider built with its own API key, and
 * where it sits in the order. Lower `priority` is tried first (1 before 2);
 * links without a priority keep their array position after the numbered ones.
 */
interface ChainLink {
    provider: AssistantProvider;
    priority?: number;
    /** Overrides the provider's name in model ids and error reports. */
    name?: string;
}
interface ProviderChainOptions {
    /** Defaults to the linked provider names joined with `+`. */
    name?: string;
    /** Defaults to 0 (fallback is immediate) when the chain has more than one model. */
    maxRetries?: number;
    /** Defaults to the first configured link's time zone. */
    quotaTimeZone?: string;
}
/**
 * Joins providers into one fallback chain, so a project can inject several
 * API keys (a free Gemini key, a second Gemini project, a paid Claude key…)
 * and rank them. Each model call walks the whole chain in priority order:
 * when a model's daily quota is used up, or it is rate limited or down, the
 * next model answers inline, even if it belongs to another provider.
 *
 * Links whose key is missing (`configured: false`) are left out, so the same
 * code works in environments that only set some of the keys. Each model keeps
 * its own provider's settings (output limit, provider options, prompt
 * caching), and the model ids stay unique: when two links share a model id
 * the later ones are prefixed with the link's name (`backup/gemini-2.5-flash`).
 */
declare function providerChain(links: ReadonlyArray<ChainLink | AssistantProvider>, options?: ProviderChainOptions): AssistantProvider;
type EnvSource = Record<string, string | undefined>;
/**
 * Picks the provider from environment variables, so switching an app to a
 * paid tier is a deployment setting rather than a code change:
 *
 * - `ASSISTANT_PROVIDER`: `gemini` (default when `GEMINI_API_KEY` is set) or
 *   `anthropic`; or a comma-separated priority list such as
 *   `gemini,anthropic`, which builds a `providerChain` in that order
 * - `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`: server-only keys
 * - `ASSISTANT_MODEL`: optional single model id; for Gemini it replaces the
 *   free chain and turns quota tracking off (use it for a paid tier)
 *
 * Pass `process.env` in Node or `Deno.env.toObject()` in Deno.
 */
declare function providerFromEnv(env: EnvSource, defaults?: {
    provider?: 'gemini' | 'anthropic';
}): AssistantProvider;

/** Throw from `authorize` (or other callbacks) to answer with a specific code. */
declare class AssistantError extends Error {
    readonly code: AssistantErrorCode;
    constructor(code: AssistantErrorCode, message?: string);
}
type ErrorStage = 'authorize' | 'model' | 'tool' | 'quota' | 'setup';
interface ErrorInfo {
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
interface AssistantHandlerOptions<CTX> {
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
interface UsageResponse {
    provider: string | null;
    /** The model that would answer the next question; null when none is available. */
    model: ModelInfo | null;
    /** Null when the provider is not quota-tracked or usage cannot be read. */
    quota: QuotaSummary | null;
}
interface AssistantHandler {
    /** POST: one chat turn, streamed as NDJSON events. */
    chat(request: Request): Promise<Response>;
    /** GET: `{ provider, model, quota }`; `quota` is null for untracked providers. */
    usage(request: Request): Promise<Response>;
    /** Routes POST to `chat`, GET to `usage` and answers OPTIONS (for one Edge Function). */
    handle(request: Request): Promise<Response>;
    /** Today's quota summary without a request, e.g. for server-rendered pages. */
    quota(provider?: AssistantProvider): Promise<QuotaSummary | null>;
}
/** Maps a failure during a turn to the code shown to the user. */
declare function errorCode(error: unknown): AssistantErrorCode;
/**
 * Creates a framework-agnostic assistant endpoint using Web Request/Response.
 * Create it once at module scope so per-model cooldowns survive between
 * requests on a warm instance.
 */
declare function createAssistantHandler<CTX>(options: AssistantHandlerOptions<CTX>): AssistantHandler;

/** Model calls per question; each tool round is one call. */
declare const MAX_ROUNDS = 8;
/**
 * Google documents this value for function-call parts the current model did
 * not produce. It is used when a fallback switches models partway through one
 * answer, because thought signatures are tied to the model that made them.
 */
declare const FOREIGN_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
interface TurnOptions {
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
interface FallbackInfo {
    model: string;
    provider?: string;
    reason: FallbackReason;
}
/**
 * Streams one answer: a bounded loop of model calls and tool calls. Each
 * model call walks the provider's chain until one model accepts it; once text
 * has streamed for a call, errors are no longer retried on another model.
 */
declare function runTurn(options: TurnOptions): Promise<void>;

/**
 * Signed confirmation tokens. The server is stateless (history lives in the
 * browser), so a confirmed tool call comes back from the client. With a
 * `confirmationSecret`, the handler only runs calls whose id, name and input
 * match a proposal it signed recently. Uses Web Crypto, so it runs anywhere.
 */
declare const CONFIRMATION_TTL_MS: number;
interface ConfirmationPayload {
    id: string;
    name: string;
    input: unknown;
}
declare function signConfirmation(secret: string, payload: ConfirmationPayload, now?: number): Promise<string>;
declare function verifyConfirmation(secret: string, token: unknown, payload: ConfirmationPayload, now?: number): Promise<boolean>;

export { AssistantError, AssistantErrorCode, AssistantEvent, AssistantTools, CONFIRMATION_TTL_MS, CONTEXT_WINDOWS, COOLDOWN_MS, ChainExhaustedError, ChatMessage, ConfirmedCall, Cooldowns, DEFAULT_CLAUDE_MODEL, FIRST_CHUNK_TIMEOUT_MS, FOREIGN_THOUGHT_SIGNATURE, GEMINI_FREE_MODELS, MAX_ROUNDS, ModelInfo, ModelTimeoutError, QuotaModel, QuotaStore, QuotaSummary, RequestLimits, RequestResult, anthropicProvider, contextWindowFor, createAssistantHandler, customProvider, errorCode, fallbackReason, geminiProvider, isDailyQuotaError, modelsToTry, providerChain, providerFromEnv, runTurn, signConfirmation, verifyConfirmation };
export type { AnthropicProviderOptions, AssistantHandler, AssistantHandlerOptions, AssistantProvider, ChainLink, ChainModel, CustomProviderOptions, EnvSource, ErrorInfo, ErrorStage, FallbackInfo, FallbackReason, GeminiProviderOptions, ModelInput, ModelSettings, ProviderChainOptions, ProviderOptions, TurnOptions, UsageResponse };
