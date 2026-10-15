# hoggish-assistant

A shared TypeScript library for adding an AI chat assistant to an app. It sits on top of the
[Vercel AI SDK](https://ai-sdk.dev) (`ai`, `@ai-sdk/google`, `@ai-sdk/anthropic`) and adds the parts
the AI SDK leaves to you:

- **Free-model fallback chain.** Models are tried strongest first. If one returns a per-day 429
  (or a 404, 500 or 503) before any text has streamed, the same turn is retried on the next model.
  A per-minute 429 only puts that model on a short cooldown.
- **Quota tracking.** Requests are counted per model per quota day (Gemini resets at midnight
  Pacific time). Models recorded as used up are skipped, and you get a summary for a badge:
  requests left, about how many questions are left, the current model, whether a fallback model is
  answering, and the reset time. Storage is pluggable: in memory or Supabase.
- **Model and context-window status.** Every answer reports which model produced it and how many
  tokens the call used, so the UI can show the model's name and roughly how many more messages fit
  in its context window.
- **A framework-agnostic server handler** built on Web `Request`/`Response`. It works in Next.js
  route handlers and in Supabase Edge Functions (Deno). It runs a bounded tool loop and streams
  NDJSON events.
- **Confirm before action.** A tool can require confirmation. The model proposes the call, the user
  presses Confirm or Cancel, and only a confirmed call runs. Proposals can be signed with HMAC.
- **`useAssistantChat`**, a headless React hook (React 18 and 19), plus an unstyled
  `AssistantMarkdown` renderer.
- **Helpers:** a safe Markdown subset parser that never outputs HTML, and an Excel builder
  (exceljs) with typed money, date and percent columns.

The library never touches your app's database. Each app supplies its own `authorize`, tools,
prompt and API key. Give each app its own Google project so each gets its own free quota.

## Install

```json
{
  "dependencies": {
    "hoggish-assistant": "github:exampleschool23/hoggish-assistant#v0.3.1"
  }
}
```

The built `dist/` is committed, so installing from a Git tag needs no build step.

Peer dependencies:

| Package   | When                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `zod`     | `^3.25.76 \|\| ^4.1.8`, used for tool schemas (the AI SDK needs it too)  |
| `react`   | `^18.2 \|\| ^19`, only for `hoggish-assistant/react`                     |
| `exceljs` | `^4.4`, only for `hoggish-assistant/excel`                               |

## Entry points

| Import                       | Runtime          | Contents                                                                    |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `hoggish-assistant`          | any              | Event types, NDJSON parsing, quota math, the memory store, request helpers   |
| `hoggish-assistant/server`   | Node, Deno, edge | `createAssistantHandler`, providers, `defineTool`, the fallback chain        |
| `hoggish-assistant/react`    | browser          | `useAssistantChat`, `AssistantMarkdown` (`'use client'`)                     |
| `hoggish-assistant/markdown` | any              | `parseMarkdown`, `parseInline`                                              |
| `hoggish-assistant/excel`    | **Node only**    | `buildWorkbook`, `excelFile`, `safeSheetName`                                |
| `hoggish-assistant/supabase` | any              | `createSupabaseQuotaStore`                                                  |
| `hoggish-assistant/sql/assistant_model_usage.sql` | none | The table and RPC for the Supabase store                        |

The core and server entries use only Web APIs (`fetch`, Web Crypto, `TextEncoder`, `btoa`) and no
Node built-ins.

The package is ESM. CommonJS code can `require()` any entry on Node 20.19+ or 22.12+ (or through a
loader such as tsx), which loads the same ESM build.

## Providers: switching is a configuration change

```ts
import { anthropicProvider, geminiProvider, providerFromEnv } from 'hoggish-assistant/server';

// Free Gemini chain with daily limits (the default):
geminiProvider({ apiKey: process.env.GEMINI_API_KEY });

// Paid Gemini tier: plain model ids without `dailyLimit` turn quota tracking off.
geminiProvider({ apiKey: process.env.GEMINI_API_KEY, models: ['gemini-3.8-flash'] });

// Claude (defaults to claude-opus-5-5, with prompt caching on the system prompt):
anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });

// Or choose from env: ASSISTANT_PROVIDER=gemini|anthropic, GEMINI_API_KEY, ANTHROPIC_API_KEY,
// and optionally ASSISTANT_MODEL (one model id; for Gemini it replaces the free chain).
providerFromEnv(process.env);
```

### Several keys with priorities

A project can inject more than one API key and rank them. `providerChain` joins providers into
one chain: every model call walks it in priority order, and when a model's daily quota is used up
(or it is rate limited or down) the next model answers inline, even across providers. Links whose
key is missing are left out, so the same code runs where only some keys are set.

```ts
import { anthropicProvider, geminiProvider, providerChain } from 'hoggish-assistant/server';

const provider = providerChain([
  { priority: 1, provider: geminiProvider({ apiKey: process.env.GEMINI_API_KEY }) },
  { priority: 2, name: 'backup', provider: geminiProvider({ apiKey: process.env.GEMINI_BACKUP_API_KEY }) },
  { priority: 3, provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-5-5' }) },
]);
```

Lower `priority` goes first; links without one keep their array position after the numbered
ones. Each model keeps its own provider's settings (output limit, provider options, prompt
caching). When two links share a model id, the later ones are prefixed with the link's name
(`backup/gemini-3.8-flash`) so quota rows and cooldowns stay separate. Quota tracking covers the
models that have a `dailyLimit`; untracked paid models never appear in the quota badge.

The same thing from the environment: `ASSISTANT_PROVIDER=gemini,anthropic` makes `providerFromEnv`
build a chain in that order. To pick keys per request (per tenant, say), pass a function as
`provider` to `createAssistantHandler`; it receives the context from `authorize`.

The default free Gemini chain, strongest first, with requests per day:

| Model                   | Per day |
| ----------------------- | ------: |
| `gemini-3.8-flash`      |      20 |
| `gemini-3.7-flash`      |      20 |
| `gemini-3.6-flash`      |      20 |
| `gemini-3.5-flash-lite` |     500 |
| `gemini-3.1-flash-lite` |     500 |
| `gemini-2.5-flash`      |      20 |
| `gemini-2.5-flash-lite` |      20 |

You can pass your own chain: `models: [{ model: 'gemini-3.8-flash', dailyLimit: 50 }, 'gemini-2.5-flash']`.
`customProvider({ name, models: [{ model, languageModel, dailyLimit? }] })` accepts any AI SDK
language model, such as OpenAI, Bedrock or Vertex.

> **Privacy.** Google may use prompts sent on the free Gemini tier to improve its products. For apps
> that hold other people's private data, use a paid tier that does not train on your data (paid
> Gemini or Claude). With `providerFromEnv`, switching is a deployment setting.

### How the fallback works

- Each model call (every tool round) goes through the chain. A model switch can happen partway
  through an answer. When it does, the previous model's reasoning parts are dropped and its Gemini
  thought signatures are replaced with Google's documented `skip_thought_signature_validator`
  value.
- A per-day 429 marks the model as used up in the quota store. 404 and 5xx errors, and per-minute
  429s, only put the model on a cooldown on this server instance: 60 seconds, or 1 hour for a 404.
- A model that accepts a call but sends no response chunk within `firstChunkTimeoutMs` (handler
  option, default 25 000 ms; 0 disables) is aborted and treated like a 503: the call moves to the
  next model and the stalled one cools down for 60 seconds. Keep it well below your route's
  `maxDuration`.
- Every skipped model is reported to `onError` with `stage: 'model'`, the `provider`, `model`, HTTP
  `status` (when there is one) and `reason` (`daily`, `rate`, `missing` or `unavailable`), so logs
  show why a stronger model did not answer.
- If the store says every model is used up, the chain is tried anyway, because the provider is the
  final authority on its own quota.
- Once text has streamed for a model call, errors are not retried on another model, and pauses are
  not timed out. The user sees
  `BUSY` or `SERVER_ERROR` after the partial text.
- Chains with more than one model default to `maxRetries: 0`, so fallback is immediate.

## Next.js (App Router)

```ts
// src/lib/assistant/handler.ts
import 'server-only';
import { z } from 'zod';
import { AssistantError, createAssistantHandler, defineTool, providerFromEnv } from 'hoggish-assistant/server';
import { createSupabaseQuotaStore } from 'hoggish-assistant/supabase';
import { excelFile } from 'hoggish-assistant/excel';
import { createServerClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

interface Ctx {
  supabase: Awaited<ReturnType<typeof createServerClient>>;
  clubId: string;
  locale: 'en' | 'ru' | 'uz';
}

export const assistant = createAssistantHandler<Ctx>({
  // Validate the client's `context`, authenticate, and check membership.
  async authorize(_request, context) {
    const parsed = z.object({ clubId: z.string().uuid(), locale: z.enum(['en', 'ru', 'uz']) }).safeParse(context);
    if (!parsed.success) throw new AssistantError('INVALID_REQUEST');
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null; // UNAUTHORIZED
    const { data: member } = await supabase.from('club_members').select('role')
      .eq('club_id', parsed.data.clubId).eq('user_id', user.id).maybeSingle();
    if (!member) throw new AssistantError('FORBIDDEN');
    return { supabase, ...parsed.data };
  },
  provider: providerFromEnv(process.env),
  system: 'You are the finance assistant for a game club. Answer from tool data only.',
  context: (ctx) => `Club ${ctx.clubId}. Answer in ${ctx.locale}. Today is ${new Date().toISOString().slice(0, 10)}.`,
  tools: (ctx) => ({
    get_expenses: defineTool({
      description: 'Expenses between two dates (YYYY-MM-DD).',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }) => {
        const { data } = await ctx.supabase.from('expenses').select('date,category,amount')
          .eq('club_id', ctx.clubId).gte('date', from).lte('date', to);
        return data ?? [];
      },
    }),
    export_expenses: defineTool({
      description: 'Send the user an Excel file of expenses.',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async ({ from, to }, { attachFile }) => {
        const { data } = await ctx.supabase.from('expenses').select('date,category,amount')
          .eq('club_id', ctx.clubId).gte('date', from).lte('date', to);
        attachFile(await excelFile(`expenses ${from} ${to}`, [{
          name: 'Expenses',
          columns: [{ key: 'date', type: 'date' }, { key: 'category' }, { key: 'amount', type: 'money' }],
          rows: data ?? [],
        }]));
        return { rows: data?.length ?? 0 };
      },
    }),
    add_expense: defineTool({
      description: 'Record an expense. The user confirms before it is saved.',
      inputSchema: z.object({ amount: z.number().int().positive(), category: z.string() }),
      needsConfirmation: true,
      describe: ({ amount, category }) => `Record ${amount.toLocaleString('ru-RU')} UZS for ${category}`,
      execute: async (input) => {
        const { error } = await ctx.supabase.from('expenses').insert({ club_id: ctx.clubId, ...input });
        if (error) throw error;
        return { saved: true };
      },
    }),
  }),
  quotaStore: createSupabaseQuotaStore(createServiceClient()),
  confirmationSecret: process.env.ASSISTANT_CONFIRMATION_SECRET,
});
```

```ts
// src/app/api/assistant/route.ts
import { assistant } from '@/lib/assistant/handler';

export const runtime = 'nodejs'; // 'edge' also works if you don't use the Excel helper
export const maxDuration = 120;

export const POST = (request: Request) => assistant.chat(request);
```

```ts
// src/app/api/assistant/usage/route.ts
import { assistant } from '@/lib/assistant/handler';

export const GET = (request: Request) => assistant.usage(request);
```

Create the handler once, at module scope, so per-model cooldowns survive between requests on a
warm instance.

## Supabase Edge Function (Deno)

Deno can't install from a GitHub tag, so import the committed `dist/` from jsDelivr and map the
bare imports to npm:

```jsonc
// supabase/functions/assistant/deno.json
{
  "imports": {
    "hoggish-assistant/": "https://cdn.jsdelivr.net/gh/exampleschool23/hoggish-assistant@v0.1.1/dist/",
    "ai": "npm:ai@^7.0.141",
    "@ai-sdk/google": "npm:@ai-sdk/google@^4.0.96",
    "@ai-sdk/anthropic": "npm:@ai-sdk/anthropic@^4.0.80",
    "zod": "npm:zod@^4.1.8",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@^2"
  }
}
```

```ts
// supabase/functions/assistant/index.ts
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createAssistantHandler, defineTool, providerFromEnv } from 'hoggish-assistant/server.js';
import { createSupabaseQuotaStore } from 'hoggish-assistant/supabase.js';

const env = Deno.env.toObject();
const cors = {
  'Access-Control-Allow-Origin': 'https://pos.example.com',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const assistant = createAssistantHandler({
  async authorize(request) {
    const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    return user ? { supabase, user } : null;
  },
  provider: providerFromEnv(env),
  system: 'You are the assistant for a cafe POS.',
  tools: ({ supabase }) => ({
    todays_sales: defineTool({
      description: "Today's sales totals by product.",
      inputSchema: z.object({}),
      execute: async () => (await supabase.rpc('todays_sales')).data,
    }),
  }),
  quotaStore: createSupabaseQuotaStore(createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)),
  confirmationSecret: env.ASSISTANT_CONFIRMATION_SECRET,
  headers: cors,
});

// POST → chat, GET → usage, OPTIONS → CORS preflight.
Deno.serve((request) => assistant.handle(request));
```

Set secrets with `supabase secrets set GEMINI_API_KEY=… ASSISTANT_CONFIRMATION_SECRET=…`. The Excel
helper is Node-only. In Deno, build files with a Deno-compatible library or in a Node route.

## React

```tsx
'use client';
import { useEffect, useState } from 'react';
import { AssistantMarkdown, useAssistantChat, type ChatErrorCode } from 'hoggish-assistant/react';

const ERROR_TEXT: Record<ChatErrorCode, string> = {
  UNAUTHORIZED: 'Please sign in again.',
  INVALID_REQUEST: 'That request could not be sent.',
  FORBIDDEN: 'You do not have access.',
  NOT_CONFIGURED: 'The assistant is not set up.',
  BUSY: 'The assistant is busy. Try again in a minute.',
  REFUSED: 'The assistant could not answer that.',
  TOO_LONG: 'That took too many steps. Try a narrower question.',
  SERVER_ERROR: 'Something went wrong.',
  NETWORK: 'Check your connection.',
};

export function AssistantChat({ clubId, locale }: { clubId: string; locale: string }) {
  const [draft, setDraft] = useState('');
  const chat = useAssistantChat({
    api: '/api/assistant',
    usageApi: '/api/assistant/usage',
    context: { clubId, locale }, // sent with every request and passed to `authorize`
    // For an Edge Function: api: `${SUPABASE_URL}/functions/v1/assistant`,
    // headers: async () => ({ Authorization: `Bearer ${accessToken}` }),
  });

  // A conversation belongs to one club: start over when it changes.
  useEffect(() => chat.newChat(), [clubId, chat.newChat]);

  return (
    <div>
      <header>
        {chat.model && <strong>{chat.model.model}</strong>}
        {chat.quota && <span> · {chat.quota.questionsLeft} questions left today ({chat.quota.requestsLeft} of {chat.quota.requestsLimit} requests)</span>}
        {chat.quota?.usingFallback && <span> · fallback model</span>}
        {chat.context?.messagesLeft !== null && chat.context?.messagesLeft !== undefined && (
          <span> · about {chat.context.messagesLeft} more messages fit ({Math.round((chat.context.usedShare ?? 0) * 100)}% of the context window used)</span>
        )}
      </header>
      {chat.messages.map((message) => (
        <div key={message.id}>
          <AssistantMarkdown text={message.content} />
          {message.activeTool && <p>Working: {message.activeTool}…</p>}
          {message.files.map((file) => <a key={file.url} href={file.url} download={file.fileName}>{file.fileName}</a>)}
          {message.confirmations.filter((item) => item.status === 'pending').map((item) => (
            <div key={item.id}>
              <p>{item.summary ?? item.name}</p>
              <button onClick={() => chat.confirm(item.id)}>Confirm</button>
              <button onClick={() => chat.cancel(item.id)}>Cancel</button>
            </div>
          ))}
          {message.error && <p>{ERROR_TEXT[message.error]}</p>}
          {message.stopped && <p>Stopped.</p>}
        </div>
      ))}
      <form onSubmit={(event) => { event.preventDefault(); void chat.send(draft); setDraft(''); }}>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
        {chat.busy ? <button type="button" onClick={chat.stop}>Stop</button> : <button>Send</button>}
      </form>
    </div>
  );
}
```

The hook returns `messages`, `busy`, `send`, `stop`, `newChat`, `confirm`, `cancel`, `quota`,
`refreshQuota`, `model` and `context`. History lives in the browser and the server stores nothing.
Sending a new question cancels any confirmations still pending. `AssistantMarkdown` takes a
`components` prop if you want to add class names to its elements.

`model` is the model in use: the one that produced the latest answer, or, before the first answer,
the one the usage endpoint says would answer next (`{ model, provider?, contextWindow? }`). Each
assistant message also carries the `model` that produced it, so a fallback switch is visible.

`context` describes the latest answer's context-window use and is `null` before the first answer:

```ts
interface ContextStatus {
  model: string;
  contextWindow: number | null;  // tokens the model accepts; null when unknown
  usedTokens: number;            // prompt + output tokens of the last model call
  tokensLeft: number | null;
  usedShare: number | null;      // 0–1
  messagesLeft: number | null;   // how many more messages of this chat's average size fit
}
```

`usedTokens` comes from the provider's own usage report, so it covers the system prompt, tools and
the whole history. `messagesLeft` is an estimate (about four characters per token for Latin text,
two and a half for Cyrillic). Note that the hook also trims history to `maxHistoryMessages`
(default 30), so with a million-token window the oldest messages drop out long before it fills;
the number is mostly useful with small windows or very long messages.

Context windows are attached to models by `contextWindowFor(modelId)`: 1 048 576 tokens for
Gemini, 1 000 000 for the Claude 4.6+ and Claude 5 families, 200 000 for earlier Claude models.
Pass `contextWindow` on a model (`{ model, dailyLimit, contextWindow }` or on a `ChainModel`) to
override it or to set it for a model the table does not know.

## Tools and confirmations

```ts
defineTool({
  description: 'What the tool does, for the model.',
  inputSchema: z.object({ ... }),          // zod 3.25+/4, Standard Schema or jsonSchema()
  execute: async (input, { signal, toolCallId, attachFile }) => result, // JSON-serialisable
  needsConfirmation: true,                 // or (input) => boolean; default false (read-only)
  describe: (input) => 'Shown on the Confirm button',
});
```

- **Authorization belongs in `execute`.** Scope every query to the signed-in user's tenant, and rely
  on database policies (RLS). The model chooses the input, so treat it like user input.
- Throw `new ToolError('message')` to send the model an error it can act on. Any other thrown error
  reaches the model only as a generic failure and goes to `onError`.
- A round with a confirmable call stops before anything runs. The client gets one `confirm` event
  per proposal. `confirm(id)` sends the call back, the server validates the input against the
  schema again, runs the tool, and the model continues the same answer.
- Set `confirmationSecret` (any long random string, in server env) so the server only runs calls it
  proposed with unchanged input in the last hour. Without it, any signed-in user can call a
  confirmable tool directly with input of their choosing, within what `execute` allows.
  Confirmation does not deduplicate: make writes idempotent if double-running would hurt.
- A turn is capped at `maxRounds` model calls (default 8), then ends with `TOO_LONG`.

## Quota storage

`createMemoryQuotaStore()` works for tests and single-instance servers. For serverless
deployments, use Supabase:

1. Copy `sql/assistant_model_usage.sql` (also at
   `node_modules/hoggish-assistant/sql/assistant_model_usage.sql`) into your migrations as a new,
   uniquely numbered file. It creates `assistant_model_usage` and `record_assistant_model_request`,
   which only `service_role` can use. It matches game-club-finance migration 080.
2. `createSupabaseQuotaStore(serviceRoleClient)`. Only create that client on the server.

Counting is best effort. A missing table or a failed write only turns the quota display off and
never blocks an answer. To use another backend, implement `QuotaStore` with `load(day)` and
`record(day, model, 'ok' | 'daily_limit')`.

`handler.usage(request)` answers `{ provider, model, quota }`. The context comes from the
`?context=` query parameter (JSON), which the hook sets. `model` is the model the next question
would go to (the first in the chain that is neither used up nor cooling down), as
`{ model, provider?, contextWindow? }`, or `null`. `quota` is `null` when the provider isn't
quota-tracked:

```ts
interface QuotaSummary {
  requestsLeft: number;
  requestsLimit: number;
  questionsLeft: number;        // requestsLeft / requestsPerQuestion (default 3)
  currentModel: { model: string; limit: number; used: number; remaining: number } | null;
  usingFallback: boolean;       // the top model is used up
  resetsAt: string;             // ISO time of the next reset
  models: ModelQuota[];
}
```

## Wire protocol

`POST` body:

```ts
{
  messages: { role: 'user' | 'assistant'; content: string }[]; // starts with user; ends with user unless confirming
  context?: unknown;                                            // app-defined, checked by authorize
  confirmation?: { id: string; name: string; input: unknown; token?: string };
}
```

The response is `application/x-ndjson`, one event per line:

| Event                                                     | Meaning                                          |
| --------------------------------------------------------- | ------------------------------------------------ |
| `{ type: 'model', model, provider?, contextWindow? }`     | A model accepted a call (first event of each call) |
| `{ type: 'text', text }`                                  | Append to the answer                             |
| `{ type: 'usage', model, inputTokens, outputTokens }`     | Token usage of a finished model call             |
| `{ type: 'tool', name, id }`                              | A tool started (show a status line)              |
| `{ type: 'file', fileName, mimeType, data }`              | A generated file, base64                         |
| `{ type: 'confirm', id, name, input, summary?, token? }`  | A proposed action waiting for Confirm/Cancel     |
| `{ type: 'error', code }`                                 | See the codes below                              |
| `{ type: 'done' }`                                        | The turn finished                                |

Error codes: `UNAUTHORIZED`, `INVALID_REQUEST`, `FORBIDDEN`, `NOT_CONFIGURED`, `BUSY`, `REFUSED`,
`TOO_LONG`, `SERVER_ERROR`. The hook adds `NETWORK` for client-side failures. Errors that happen
before streaming starts are returned as JSON `{ error: code }` with a matching HTTP status. Map each
code to translated text in your app.

Default limits: user messages up to 4,000 characters (longer ones are rejected), assistant messages
cut to 8,000, and only the newest 30 messages kept. Override them with `limits`.

## Markdown and Excel

```ts
import { parseMarkdown, parseInline } from 'hoggish-assistant/markdown';
parseMarkdown('## Total\n| Month | Profit |\n|---|---|\n| May | 1 000 |');
// [{ type: 'heading', level: 2, text: 'Total' }, { type: 'table', header: [...], rows: [...] }]
```

The supported subset is headings, paragraphs, bullet and numbered lists, tables, fenced code,
`**bold**` and `` `code` ``. Raw HTML stays plain text.

```ts
import { buildWorkbook } from 'hoggish-assistant/excel';
const bytes = await buildWorkbook(
  [{ name: 'Expenses: May', title: 'Expenses · May 2026', columns: [
    { key: 'date', type: 'date' },
    { key: 'category', label: (value) => t(`categories.${value}`) },
    { key: 'amount', type: 'money' },
    { key: 'share', type: 'percent' },
  ], rows }],
  { translate: (key) => t(`columns.${key}`), moneyDecimals: 0, percentScale: 'whole' },
);
```

Column types are `text`, `number`, `integer`, `money`, `percent`, `date`, `month` and `datetime`.
ISO date strings become real Excel dates. Sheet names are cleaned of `: \ / ? * [ ]`, capped at 31
characters and de-duplicated. The header row is frozen and gets an auto-filter.

## Security checklist

- Keep API keys and `confirmationSecret` in server environment variables only. Never pass them to
  client code or commit them.
- `authorize` must validate the session on the server, for example with Supabase `auth.getUser()`,
  and check membership for the requested `context`.
- Tools enforce their own access rules. The UI is not an authorization boundary.
- The default `onError` logs the stage, provider, model, tool name, HTTP status and fallback reason,
  never message content.

## Development

```bash
npm install
npm run check
```

`npm run check` runs typecheck, tests and build. To release, bump `version`, add a changelog
entry, run `npm run build`, commit `dist/`, tag `vX.Y.Z` and push `main` and the tag. When working
with Claude Code, Claude does these steps itself (see `CLAUDE.md`).

## License

MIT
