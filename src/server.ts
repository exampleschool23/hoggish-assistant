/**
 * Server entry: the Web Request/Response handler, providers, tools and the
 * fallback chain. Runs in Node (Next.js route handlers), Deno (Supabase Edge
 * Functions) and other fetch-based runtimes; nothing here needs Node APIs.
 */
export * from './index';
export {
  AssistantError,
  createAssistantHandler,
  errorCode,
  type AssistantHandler,
  type AssistantHandlerOptions,
  type ErrorInfo,
  type ErrorStage,
  type UsageResponse,
} from './handler';
export {
  CONTEXT_WINDOWS,
  DEFAULT_CLAUDE_MODEL,
  GEMINI_FREE_MODELS,
  anthropicProvider,
  contextWindowFor,
  customProvider,
  geminiProvider,
  providerChain,
  providerFromEnv,
  type AnthropicProviderOptions,
  type AssistantProvider,
  type ChainLink,
  type ChainModel,
  type ModelSettings,
  type ProviderChainOptions,
  type CustomProviderOptions,
  type EnvSource,
  type GeminiProviderOptions,
  type ModelInput,
  type ProviderOptions,
} from './providers';
export {
  ToolError,
  defineTool,
  toBase64,
  type AssistantFile,
  type AssistantTool,
  type AssistantTools,
  type ToolRunOptions,
} from './tools';
export {
  COOLDOWN_MS,
  ChainExhaustedError,
  Cooldowns,
  FIRST_CHUNK_TIMEOUT_MS,
  ModelTimeoutError,
  fallbackReason,
  isDailyQuotaError,
  modelsToTry,
  type FallbackReason,
} from './fallback';
export { FOREIGN_THOUGHT_SIGNATURE, MAX_ROUNDS, runTurn, type FallbackInfo, type TurnOptions } from './loop';
export { CONFIRMATION_TTL_MS, signConfirmation, verifyConfirmation } from './confirm';
