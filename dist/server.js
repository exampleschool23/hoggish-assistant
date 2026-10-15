import { PACIFIC_TIME_ZONE, DEFAULT_LIMITS, quotaDate, summarizeQuota, parseChatRequest, exhaustedModels, trackedModels, encodeEvent, ERROR_STATUS } from './chunk-2WTQ3SDZ.js';
export { ASSISTANT_ERROR_CODES, DEFAULT_LIMITS, ERROR_STATUS, PACIFIC_TIME_ZONE, REQUESTS_PER_QUESTION, createMemoryQuotaStore, encodeEvent, estimateTokens, exhaustedModels, isAssistantErrorCode, nextQuotaReset, parseChatRequest, parseEventChunk, quotaDate, readEventStream, summarizeQuota, trackedModels, trimHistory } from './chunk-2WTQ3SDZ.js';
import { streamText, APICallError, tool, asSchema, RetryError } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

// src/confirm.ts
var CONFIRMATION_TTL_MS = 60 * 60 * 1e3;
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
var keys = /* @__PURE__ */ new Map();
function hmacKey(secret) {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, key);
  }
  return key;
}
function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
function message(issuedAt, payload) {
  return new TextEncoder().encode(`${issuedAt}
${payload.id}
${payload.name}
${stableStringify(payload.input)}`);
}
async function signConfirmation(secret, payload, now = Date.now()) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), message(now, payload));
  return `${now}.${toHex(signature)}`;
}
async function verifyConfirmation(secret, token, payload, now = Date.now()) {
  if (typeof token !== "string") return false;
  const [issued, hex, extra] = token.split(".");
  const issuedAt = Number(issued);
  const signature = fromHex(hex ?? "");
  if (extra !== void 0 || !Number.isSafeInteger(issuedAt) || !signature) return false;
  if (issuedAt > now + 6e4 || now - issuedAt > CONFIRMATION_TTL_MS) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), signature, message(issuedAt, payload));
}
var COOLDOWN_MS = {
  daily: 6e4,
  rate: 6e4,
  missing: 60 * 6e4,
  unavailable: 6e4
};
function rootError(error) {
  return RetryError.isInstance(error) ? error.lastError ?? error : error;
}
function statusCode(error) {
  const root = rootError(error);
  if (APICallError.isInstance(root)) return root.statusCode;
  const status = root?.statusCode ?? root?.status;
  return typeof status === "number" ? status : void 0;
}
function isDailyQuotaError(message2) {
  return /per[\s_-]?day|PerDay|daily/i.test(message2 ?? "");
}
function errorText(error) {
  const root = rootError(error);
  const parts = [];
  if (root instanceof Error) parts.push(root.message);
  if (APICallError.isInstance(root) && root.responseBody) parts.push(root.responseBody);
  return parts.join("\n");
}
var FIRST_CHUNK_TIMEOUT_MS = 25e3;
var ModelTimeoutError = class extends Error {
  constructor(model, timeoutMs) {
    super(`No response from ${model} within ${timeoutMs} ms`);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.name = "ModelTimeoutError";
  }
  model;
  timeoutMs;
};
function fallbackReason(error) {
  if (error instanceof ModelTimeoutError) return "unavailable";
  const status = statusCode(error);
  if (status === 429) return isDailyQuotaError(errorText(error)) ? "daily" : "rate";
  if (status === 404) return "missing";
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return "unavailable";
  return null;
}
var Cooldowns = class {
  constructor(clock = Date.now) {
    this.clock = clock;
  }
  clock;
  until = /* @__PURE__ */ new Map();
  set(model, reason) {
    this.until.set(model, this.clock() + COOLDOWN_MS[reason]);
  }
  isCooling(model) {
    return (this.until.get(model) ?? 0) > this.clock();
  }
  clear() {
    this.until.clear();
  }
};
function modelsToTry(chain, skip, cooldowns) {
  const preferred = chain.filter((entry) => !skip.has(entry.model) && !cooldowns.isCooling(entry.model));
  if (preferred.length) return preferred;
  return chain.filter((entry) => !cooldowns.isCooling(entry.model));
}
var ChainExhaustedError = class extends Error {
  constructor(errors) {
    super("Every model in the chain is unavailable or out of quota");
    this.errors = errors;
    this.name = "ChainExhaustedError";
  }
  errors;
};
var CONTEXT_WINDOWS = [
  ["gemini-", 1048576],
  ["claude-haiku-4-5", 2e5],
  ["claude-sonnet-4-5", 2e5],
  ["claude-opus-4-5", 2e5],
  ["claude-opus-4-1", 2e5],
  ["claude-3", 2e5],
  ["claude-", 1e6]
];
function contextWindowFor(model) {
  const id = model.slice(model.lastIndexOf("/") + 1);
  let best;
  for (const entry of CONTEXT_WINDOWS) {
    if (id.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}
function modelSettings(provider, model) {
  return {
    maxOutputTokens: model.maxOutputTokens ?? provider.maxOutputTokens,
    providerOptions: model.providerOptions ?? provider.providerOptions,
    cacheSystemPrompt: model.cacheSystemPrompt ?? provider.cacheSystemPrompt
  };
}
var GEMINI_FREE_MODELS = [
  { model: "gemini-3.8-flash", dailyLimit: 20 },
  { model: "gemini-3.7-flash", dailyLimit: 20 },
  { model: "gemini-3.6-flash", dailyLimit: 20 },
  { model: "gemini-3.5-flash-lite", dailyLimit: 500 },
  { model: "gemini-3.1-flash-lite", dailyLimit: 500 },
  { model: "gemini-2.5-flash", dailyLimit: 20 },
  { model: "gemini-2.5-flash-lite", dailyLimit: 20 }
];
var DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
function normalizeModels(models) {
  return models.map((entry) => typeof entry === "string" ? { model: entry } : { ...entry });
}
function withContextWindow(entry) {
  const contextWindow = entry.contextWindow ?? contextWindowFor(entry.model);
  return contextWindow ? { ...entry, contextWindow } : entry;
}
function geminiProvider(options) {
  const google = createGoogleGenerativeAI({ apiKey: options.apiKey ?? "", baseURL: options.baseURL });
  const models = normalizeModels(options.models ?? GEMINI_FREE_MODELS);
  return {
    name: "gemini",
    configured: Boolean(options.apiKey),
    models: models.map((entry) => withContextWindow({ ...entry, languageModel: google(entry.model) })),
    quotaTimeZone: options.quotaTimeZone ?? PACIFIC_TIME_ZONE,
    maxRetries: options.maxRetries ?? (models.length > 1 ? 0 : 2),
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: options.providerOptions
  };
}
function anthropicProvider(options) {
  const anthropic = createAnthropic({ apiKey: options.apiKey ?? "", baseURL: options.baseURL });
  const ids = [options.model ?? DEFAULT_CLAUDE_MODEL, ...options.fallbackModels ?? []];
  return {
    name: "anthropic",
    configured: Boolean(options.apiKey),
    models: ids.map((model) => withContextWindow({ model, languageModel: anthropic(model) })),
    quotaTimeZone: PACIFIC_TIME_ZONE,
    maxRetries: options.maxRetries ?? 2,
    maxOutputTokens: options.maxOutputTokens ?? 16e3,
    providerOptions: options.providerOptions,
    cacheSystemPrompt: true
  };
}
function customProvider(options) {
  return {
    name: options.name,
    configured: options.configured ?? options.models.length > 0,
    models: options.models.map(withContextWindow),
    quotaTimeZone: options.quotaTimeZone ?? PACIFIC_TIME_ZONE,
    maxRetries: options.maxRetries ?? (options.models.length > 1 ? 0 : 2),
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: options.providerOptions,
    cacheSystemPrompt: options.cacheSystemPrompt
  };
}
function providerChain(links, options = {}) {
  const normalized = links.map((link, index) => "provider" in link ? { ...link, index } : { provider: link, index }).filter((link) => link.provider.configured && link.provider.models.length > 0).sort((a, b) => rank(a.priority) - rank(b.priority) || a.index - b.index);
  const seen = /* @__PURE__ */ new Set();
  const models = [];
  for (const link of normalized) {
    const name = link.name ?? link.provider.name;
    for (const model of link.provider.models) {
      const id = seen.has(model.model) ? `${name}/${model.model}` : model.model;
      seen.add(id);
      models.push({ ...modelSettings(link.provider, model), ...model, model: id, provider: name });
    }
  }
  return {
    name: options.name ?? (normalized.map((link) => link.name ?? link.provider.name).join("+") || "chain"),
    configured: models.length > 0,
    models,
    quotaTimeZone: options.quotaTimeZone ?? normalized[0]?.provider.quotaTimeZone ?? PACIFIC_TIME_ZONE,
    maxRetries: options.maxRetries ?? (models.length > 1 ? 0 : normalized[0]?.provider.maxRetries ?? 2)
  };
}
function rank(priority) {
  return typeof priority === "number" && Number.isFinite(priority) ? priority : Number.POSITIVE_INFINITY;
}
function providerFromEnv(env, defaults = {}) {
  const requested = (env.ASSISTANT_PROVIDER ?? "").split(",").map((name) => name.trim().toLowerCase()).filter((name) => name === "gemini" || name === "anthropic");
  const model = env.ASSISTANT_MODEL?.trim() || void 0;
  const build = (name) => name === "anthropic" ? anthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model }) : geminiProvider({ apiKey: env.GEMINI_API_KEY, models: model ? [model] : void 0 });
  if (requested.length > 1) return providerChain(requested.map(build));
  return build(requested[0] ?? defaults.provider ?? (env.GEMINI_API_KEY ? "gemini" : "anthropic"));
}
function defineTool(tool) {
  return tool;
}
var ToolError = class extends Error {
  constructor(message2) {
    super(message2);
    this.name = "ToolError";
  }
};
async function needsConfirmation(tool, input) {
  if (typeof tool.needsConfirmation === "function") return Boolean(await tool.needsConfirmation(input));
  return Boolean(tool.needsConfirmation);
}
async function validateToolInput(tool, input) {
  const schema = asSchema(tool.inputSchema);
  if (!schema.validate) return { ok: true, value: input };
  const result = await schema.validate(input);
  if (result.success) return { ok: true, value: result.value };
  return { ok: false, message: result.error instanceof Error ? result.error.message : "Invalid input" };
}
async function executeTool(tool, input, options, onError) {
  try {
    const result = await tool.execute(input, options);
    return { result: result === void 0 ? null : result };
  } catch (error) {
    if (options.signal.aborted) throw error;
    if (error instanceof ToolError) return { result: error.message, isError: true };
    onError?.(error);
    return { result: "The tool failed. Tell the user it could not be completed.", isError: true };
  }
}
function toBase64(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return btoa(binary);
}

// src/loop.ts
var MAX_ROUNDS = 8;
var FOREIGN_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
function withoutGoogleSignature(options, replacement) {
  if (!options?.google || !("thoughtSignature" in options.google)) {
    return replacement ? { ...options, google: { ...options?.google, thoughtSignature: replacement } } : options;
  }
  const { thoughtSignature: _dropped, ...google } = options.google;
  return { ...options, google: replacement ? { ...google, thoughtSignature: replacement } : google };
}
function messagesFor(turns, model) {
  return turns.map(({ message: message2, producer }) => {
    if (!producer || producer === model || message2.role !== "assistant" || typeof message2.content === "string") return message2;
    const content = message2.content.filter((part) => part.type !== "reasoning").map((part) => {
      const providerOptions = "providerOptions" in part ? part.providerOptions : void 0;
      if (part.type === "tool-call") return { ...part, providerOptions: withoutGoogleSignature(providerOptions, FOREIGN_THOUGHT_SIGNATURE) };
      return providerOptions ? { ...part, providerOptions: withoutGoogleSignature(providerOptions) } : part;
    });
    return { ...message2, content };
  });
}
function sdkTools(tools) {
  const set = {};
  for (const [name, definition] of Object.entries(tools)) {
    set[name] = tool({ description: definition.description, inputSchema: definition.inputSchema });
  }
  return set;
}
function instructions(cacheSystemPrompt, system, context) {
  const messages = [{
    role: "system",
    content: system,
    ...cacheSystemPrompt ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}
  }];
  if (context?.trim()) messages.push({ role: "system", content: context });
  return messages;
}
function jsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}
function toolResultMessage(results) {
  return {
    role: "tool",
    content: results.map(({ call, outcome }) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: outcome.isError ? typeof outcome.result === "string" ? { type: "error-text", value: outcome.result } : { type: "error-json", value: jsonValue(outcome.result) } : { type: "json", value: jsonValue(outcome.result) }
    }))
  };
}
var AbortedError = class extends Error {
  constructor() {
    super("The request was aborted");
    this.name = "AbortError";
  }
};
var TIMED_OUT = /* @__PURE__ */ Symbol("timed out");
var RESPONSE_PARTS = /* @__PURE__ */ new Set(["text-delta", "text-start", "reasoning-start", "reasoning-delta", "tool-input-start", "tool-call", "finish-step"]);
async function runTurn(options) {
  const { provider, send, signal, tools, cooldowns } = options;
  const firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS;
  const maxRounds = options.maxRounds ?? MAX_ROUNDS;
  const skip = new Set(options.skipModels ?? []);
  const toolSet = sdkTools(tools);
  const systemFor = (entry) => instructions(modelSettings(provider, entry).cacheSystemPrompt, options.system, options.context);
  const turns = options.history.map((message2) => ({ message: message2, producer: null }));
  let textSent = options.history.length > 0 && options.history[options.history.length - 1].role === "assistant";
  async function runCalls(calls) {
    return Promise.all(calls.map(async (call) => {
      send({ type: "tool", name: call.toolName, id: call.toolCallId });
      const definition = tools[call.toolName];
      if (!definition) return { call, outcome: { result: `Unknown tool ${call.toolName}`, isError: true } };
      if (call.invalid) {
        const message2 = call.error instanceof Error ? call.error.message : "Invalid tool input";
        return { call, outcome: { result: `Invalid input: ${message2}`, isError: true } };
      }
      const outcome = await executeTool(definition, call.input, {
        signal,
        toolCallId: call.toolCallId,
        attachFile: (file) => send({ type: "file", fileName: file.fileName, mimeType: file.mimeType, data: toBase64(file.data) })
      }, (error) => options.onToolError?.(error, call.toolName));
      return { call, outcome };
    }));
  }
  if (options.confirmed) {
    const { id, name, input } = options.confirmed;
    const call = { toolCallId: id, toolName: name, input };
    const last = turns[turns.length - 1];
    const toolCallPart = {
      type: "tool-call",
      toolCallId: id,
      toolName: name,
      input,
      providerOptions: { google: { thoughtSignature: FOREIGN_THOUGHT_SIGNATURE } }
    };
    if (last && last.message.role === "assistant" && typeof last.message.content === "string") {
      last.message = { role: "assistant", content: [{ type: "text", text: last.message.content }, toolCallPart] };
    } else {
      turns.push({ message: { role: "assistant", content: [toolCallPart] }, producer: null });
    }
    turns.push({ message: toolResultMessage(await runCalls([call])), producer: null });
  }
  async function streamRound() {
    const candidates = modelsToTry(provider.models, skip, cooldowns);
    const errors = [];
    for (const entry of candidates) {
      let roundText = false;
      let accepted = false;
      const settings = modelSettings(provider, entry);
      const call = new AbortController();
      const abortCall = () => call.abort(signal.reason);
      signal.addEventListener("abort", abortCall, { once: true });
      let timer;
      const stalled = firstChunkTimeoutMs > 0 ? new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), firstChunkTimeoutMs);
      }) : void 0;
      try {
        const result = streamText({
          model: entry.languageModel,
          instructions: systemFor(entry),
          messages: messagesFor(turns, entry.model),
          tools: toolSet,
          maxRetries: provider.maxRetries,
          ...settings.maxOutputTokens ? { maxOutputTokens: settings.maxOutputTokens } : {},
          ...settings.providerOptions ? { providerOptions: settings.providerOptions } : {},
          abortSignal: call.signal,
          // The AI SDK's default logs the whole error, whose requestBodyValues
          // hold the prompt, history and tool results. Errors still reach the
          // stream below and the handler's content-free `onError`.
          onError: () => {
          }
        });
        const calls = [];
        let finishReason;
        const parts = result.stream[Symbol.asyncIterator]();
        for (; ; ) {
          const next = !accepted && stalled ? await Promise.race([parts.next(), stalled]) : await parts.next();
          if (next === TIMED_OUT) {
            call.abort();
            parts.return?.().catch(() => {
            });
            throw new ModelTimeoutError(entry.model, firstChunkTimeoutMs);
          }
          if (next.done) break;
          const part = next.value;
          if (!accepted && RESPONSE_PARTS.has(part.type)) {
            accepted = true;
            clearTimeout(timer);
            options.onModelRequest?.(entry.model, "ok");
            send({
              type: "model",
              model: entry.model,
              ...entry.provider ?? provider.name ? { provider: entry.provider ?? provider.name } : {},
              ...entry.contextWindow ? { contextWindow: entry.contextWindow } : {}
            });
          }
          switch (part.type) {
            case "text-delta":
              if (!part.text) break;
              send({ type: "text", text: !roundText && textSent ? `

${part.text}` : part.text });
              roundText = true;
              textSent = true;
              break;
            case "tool-call":
              calls.push(part);
              break;
            case "finish-step":
              finishReason = part.finishReason;
              if (typeof part.usage.inputTokens === "number") {
                send({ type: "usage", model: entry.model, inputTokens: part.usage.inputTokens, outputTokens: part.usage.outputTokens ?? 0 });
              }
              break;
            case "error":
              throw part.error;
            case "abort":
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
        if (reason === "daily") {
          skip.add(entry.model);
          options.onModelRequest?.(entry.model, "daily_limit");
        }
        const providerName = entry.provider ?? provider.name;
        options.onFallback?.(error, { model: entry.model, ...providerName ? { provider: providerName } : {}, reason });
        errors.push(error);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abortCall);
      }
    }
    throw new ChainExhaustedError(errors);
  }
  for (let round = 0; ; round += 1) {
    if (round >= maxRounds) {
      send({ type: "error", code: "TOO_LONG" });
      return;
    }
    const { model, calls, finishReason, roundText, responseMessages } = await streamRound();
    if (calls.length === 0) {
      if (!roundText && (finishReason === "content-filter" || !textSent)) {
        send({ type: "error", code: "REFUSED" });
      }
      return;
    }
    if (finishReason === "length") {
      send({ type: "error", code: "TOO_LONG" });
      return;
    }
    for (const message2 of responseMessages) {
      turns.push({ message: message2, producer: message2.role === "assistant" ? model : null });
    }
    const proposals = [];
    for (const call of calls) {
      const definition = tools[call.toolName];
      if (definition && !call.invalid && await needsConfirmation(definition, call.input)) proposals.push(call);
    }
    if (proposals.length) {
      for (const call of proposals) {
        const definition = tools[call.toolName];
        const checked = await validateToolInput(definition, call.input);
        if (!checked.ok) continue;
        const summary = definition.describe ? await definition.describe(checked.value) : void 0;
        const token = options.confirmationSecret ? await signConfirmation(options.confirmationSecret, { id: call.toolCallId, name: call.toolName, input: call.input }) : void 0;
        send({
          type: "confirm",
          id: call.toolCallId,
          name: call.toolName,
          input: call.input,
          ...summary ? { summary } : {},
          ...token ? { token } : {}
        });
      }
      return;
    }
    turns.push({ message: toolResultMessage(await runCalls(calls)), producer: null });
  }
}

// src/handler.ts
var AssistantError = class extends Error {
  constructor(code, message2) {
    super(message2 ?? code);
    this.code = code;
    this.name = "AssistantError";
  }
  code;
};
function defaultOnError(error, info) {
  console.error("[hoggish-assistant]", info.stage, {
    ...info,
    name: error instanceof Error ? error.name : typeof error
  });
}
function errorCode(error) {
  if (error instanceof AssistantError) return error.code;
  if (error instanceof ChainExhaustedError || fallbackReason(error) !== null) return "BUSY";
  return "SERVER_ERROR";
}
function createAssistantHandler(options) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const cooldowns = new Cooldowns();
  const onError = options.onError ?? defaultOnError;
  const extraHeaders = options.headers ?? {};
  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }
    });
  }
  function errorResponse(code) {
    return json({ error: code }, ERROR_STATUS[code]);
  }
  async function authorize(request, context) {
    try {
      const ctx = await options.authorize(request, context);
      if (ctx === null || ctx === void 0) return { ok: false, response: errorResponse("UNAUTHORIZED") };
      return { ok: true, ctx };
    } catch (error) {
      if (error instanceof AssistantError) return { ok: false, response: errorResponse(error.code) };
      onError(error, { stage: "authorize" });
      return { ok: false, response: errorResponse("SERVER_ERROR") };
    }
  }
  async function resolveProvider(ctx) {
    return typeof options.provider === "function" ? options.provider(ctx) : options.provider;
  }
  async function loadQuota(provider, day) {
    if (!options.quotaStore || trackedModels(provider.models).length === 0) return null;
    try {
      return await options.quotaStore.load(day);
    } catch (error) {
      onError(error, { stage: "quota", provider: provider.name });
      return null;
    }
  }
  async function quota(provider) {
    if (!provider.configured) return null;
    const now = /* @__PURE__ */ new Date();
    const rows = await loadQuota(provider, quotaDate(now, provider.quotaTimeZone));
    if (!rows) return null;
    return summarizeQuota(provider.models, rows, now, {
      timeZone: provider.quotaTimeZone,
      requestsPerQuestion: options.requestsPerQuestion
    });
  }
  async function nextModel(provider) {
    if (!provider.configured) return null;
    const rows = await loadQuota(provider, quotaDate(/* @__PURE__ */ new Date(), provider.quotaTimeZone));
    const skip = rows ? exhaustedModels(provider.models, rows) : [];
    const entry = modelsToTry(provider.models, new Set(skip), cooldowns)[0];
    if (!entry) return null;
    const providerName = entry.provider ?? provider.name;
    return {
      model: entry.model,
      ...providerName ? { provider: providerName } : {},
      ...entry.contextWindow ? { contextWindow: entry.contextWindow } : {}
    };
  }
  async function checkConfirmation(confirmation, tools) {
    const definition = tools[confirmation.name];
    if (!definition?.needsConfirmation) return "INVALID_REQUEST";
    if (options.confirmationSecret) {
      const valid = await verifyConfirmation(options.confirmationSecret, confirmation.token, confirmation);
      if (!valid) return "FORBIDDEN";
    }
    const checked = await validateToolInput(definition, confirmation.input);
    if (!checked.ok) return "INVALID_REQUEST";
    return { ...confirmation, input: checked.value };
  }
  async function chat(request) {
    const raw = await request.json().catch(() => null);
    const access = await authorize(request, raw && typeof raw === "object" ? raw.context : void 0);
    if (!access.ok) return access.response;
    const body = parseChatRequest(raw, limits);
    if (!body) return errorResponse("INVALID_REQUEST");
    const { ctx } = access;
    let provider;
    let system;
    let context;
    let tools;
    try {
      provider = await resolveProvider(ctx);
      if (!provider.configured || provider.models.length === 0) return errorResponse("NOT_CONFIGURED");
      [system, context, tools] = await Promise.all([
        typeof options.system === "function" ? options.system(ctx) : options.system,
        options.context?.(ctx),
        options.tools?.(ctx) ?? {}
      ]);
    } catch (error) {
      if (error instanceof AssistantError) return errorResponse(error.code);
      onError(error, { stage: "setup" });
      return errorResponse("SERVER_ERROR");
    }
    let confirmed;
    if (body.confirmation) {
      const checked = await checkConfirmation(body.confirmation, tools);
      if (typeof checked === "string") return errorResponse(checked);
      confirmed = checked;
    }
    const day = quotaDate(/* @__PURE__ */ new Date(), provider.quotaTimeZone);
    const rows = await loadQuota(provider, day);
    const store = rows ? options.quotaStore : void 0;
    const pending = [];
    const record = (model, result) => {
      if (!store || !trackedModels(provider.models).some((entry) => entry.model === model)) return;
      pending.push(store.record(day, model, result).catch((error) => onError(error, { stage: "quota", provider: provider.name })));
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event) => {
          try {
            controller.enqueue(encoder.encode(encodeEvent(event)));
          } catch {
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
            skipModels: rows ? exhaustedModels(provider.models, rows) : void 0,
            cooldowns,
            onModelRequest: record,
            onToolError: (error, tool) => onError(error, { stage: "tool", provider: provider.name, tool }),
            onFallback: (error, info) => onError(error, { stage: "model", ...info, status: statusCode(error) }),
            firstChunkTimeoutMs: options.firstChunkTimeoutMs,
            confirmationSecret: options.confirmationSecret,
            confirmed
          });
          send({ type: "done" });
        } catch (error) {
          if (!request.signal.aborted) {
            onError(error, { stage: "model", provider: provider.name, status: statusCode(error) });
            send({ type: "error", code: errorCode(error) });
          }
        } finally {
          await Promise.allSettled(pending);
          try {
            controller.close();
          } catch {
          }
        }
      }
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        ...extraHeaders
      }
    });
  }
  async function usage(request) {
    let context;
    const param = new URL(request.url).searchParams.get("context");
    if (param) {
      try {
        context = JSON.parse(param);
      } catch {
        return errorResponse("INVALID_REQUEST");
      }
    }
    const access = await authorize(request, context);
    if (!access.ok) return access.response;
    try {
      const provider = await resolveProvider(access.ctx);
      const body = { provider: provider.name, model: await nextModel(provider), quota: await quota(provider) };
      return json(body);
    } catch (error) {
      onError(error, { stage: "quota" });
      const body = { provider: null, model: null, quota: null };
      return json(body);
    }
  }
  async function handle(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: extraHeaders });
    if (request.method === "GET") return usage(request);
    if (request.method === "POST") return chat(request);
    return new Response(null, { status: 405, headers: { Allow: "GET, POST, OPTIONS", ...extraHeaders } });
  }
  return {
    chat,
    usage,
    handle,
    quota: async (provider) => {
      if (provider) return quota(provider);
      if (typeof options.provider === "function") return null;
      return quota(options.provider);
    }
  };
}

export { AssistantError, CONFIRMATION_TTL_MS, CONTEXT_WINDOWS, COOLDOWN_MS, ChainExhaustedError, Cooldowns, DEFAULT_CLAUDE_MODEL, FIRST_CHUNK_TIMEOUT_MS, FOREIGN_THOUGHT_SIGNATURE, GEMINI_FREE_MODELS, MAX_ROUNDS, ModelTimeoutError, ToolError, anthropicProvider, contextWindowFor, createAssistantHandler, customProvider, defineTool, errorCode, fallbackReason, geminiProvider, isDailyQuotaError, modelsToTry, providerChain, providerFromEnv, runTurn, signConfirmation, toBase64, verifyConfirmation };
//# sourceMappingURL=server.js.map
//# sourceMappingURL=server.js.map