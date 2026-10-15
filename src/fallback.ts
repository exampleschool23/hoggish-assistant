import { APICallError, RetryError } from 'ai';

/**
 * Why a model failed in a way that should move the turn to the next model:
 * - `daily`: per-day quota used up (recorded in the quota store)
 * - `rate`: per-minute or other short-lived 429
 * - `missing`: the model id does not exist for this key (404)
 * - `unavailable`: provider overloaded or failing (500, 503, 529), or it sent
 *   nothing before the first-chunk timeout
 */
export type FallbackReason = 'daily' | 'rate' | 'missing' | 'unavailable';

/** How long this server instance skips a model after each kind of failure. */
export const COOLDOWN_MS: Record<FallbackReason, number> = {
  daily: 60_000,
  rate: 60_000,
  missing: 60 * 60_000,
  unavailable: 60_000,
};

/** Unwraps the AI SDK's retry wrapper to the last provider error. */
export function rootError(error: unknown): unknown {
  return RetryError.isInstance(error) ? (error.lastError ?? error) : error;
}

export function statusCode(error: unknown): number | undefined {
  const root = rootError(error);
  if (APICallError.isInstance(root)) return root.statusCode;
  const status = (root as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (root as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Gemini says which quota a 429 hit; only a per-day limit lasts until reset. */
export function isDailyQuotaError(message: string | undefined): boolean {
  return /per[\s_-]?day|PerDay|daily/i.test(message ?? '');
}

function errorText(error: unknown): string {
  const root = rootError(error);
  const parts: string[] = [];
  if (root instanceof Error) parts.push(root.message);
  if (APICallError.isInstance(root) && root.responseBody) parts.push(root.responseBody);
  return parts.join('\n');
}

/** Default wait for a model's first response chunk before moving to the next model. */
export const FIRST_CHUNK_TIMEOUT_MS = 25_000;

/** A model accepted the call but sent no response within the first-chunk timeout. */
export class ModelTimeoutError extends Error {
  constructor(readonly model: string, readonly timeoutMs: number) {
    super(`No response from ${model} within ${timeoutMs} ms`);
    this.name = 'ModelTimeoutError';
  }
}

export function fallbackReason(error: unknown): FallbackReason | null {
  if (error instanceof ModelTimeoutError) return 'unavailable';
  const status = statusCode(error);
  if (status === 429) return isDailyQuotaError(errorText(error)) ? 'daily' : 'rate';
  if (status === 404) return 'missing';
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return 'unavailable';
  return null;
}

/** Per-instance memory of models that recently failed. */
export class Cooldowns {
  private readonly until = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  set(model: string, reason: FallbackReason) {
    this.until.set(model, this.clock() + COOLDOWN_MS[reason]);
  }

  isCooling(model: string): boolean {
    return (this.until.get(model) ?? 0) > this.clock();
  }

  clear() {
    this.until.clear();
  }
}

/**
 * Models to try for one model call, strongest first. Models recorded as used
 * up or cooling down are skipped; if that leaves nothing, the full chain is
 * tried anyway, because the provider is the final authority on its quota.
 * Models cooling down after a failure on this instance are never retried early.
 */
export function modelsToTry<T extends { model: string }>(
  chain: readonly T[],
  skip: ReadonlySet<string>,
  cooldowns: Cooldowns,
): T[] {
  const preferred = chain.filter((entry) => !skip.has(entry.model) && !cooldowns.isCooling(entry.model));
  if (preferred.length) return preferred;
  return chain.filter((entry) => !cooldowns.isCooling(entry.model));
}

/** Thrown when every model in the chain failed with a fallback error. */
export class ChainExhaustedError extends Error {
  constructor(readonly errors: unknown[]) {
    super('Every model in the chain is unavailable or out of quota');
    this.name = 'ChainExhaustedError';
  }
}
