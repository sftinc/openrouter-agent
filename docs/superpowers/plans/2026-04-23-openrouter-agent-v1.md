# openrouter-agent v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Node.js + TypeScript library that wraps OpenRouter's chat completions API with an agent loop, pluggable sessions, structured lifecycle events, and agent-as-subagent composition.

**Architecture:** A thin `Agent` class holds configuration and delegates execution to a pure `runLoop` function. `Tool` is a single class (no subclasses) with Zod input schemas. An `Agent` extends `Tool` so it can be used as a subagent. Events are emitted through a callback during the loop; `run()` collects them and returns a structured `Result`; `runStream()` exposes them as an `AsyncIterable`.

**Tech Stack:** Node 20+, TypeScript (strict, NodeNext), Zod, zod-to-json-schema, Vitest, native fetch. ESM only.

**Spec reference:** `docs/superpowers/specs/2026-04-23-agent-wrapper-design.md` — read this before starting.

---

## File Structure

```
package.json
tsconfig.json
vitest.config.ts
.gitignore
src/
  index.ts                        # top-level barrel
  types/
    Message.ts                    # Message, ContentPart, ToolCall, Usage, Result
    index.ts
  openrouter/
    types.ts                      # LLMConfig + wire response types
    client.ts                     # OpenRouterClient, OpenRouterError
    index.ts
  tool/
    types.ts                      # ToolDeps, ToolResult
    Tool.ts                       # Tool class
    index.ts
  session/
    SessionStore.ts               # interface
    InMemorySessionStore.ts
    index.ts
  agent/
    events.ts                     # AgentEvent, EventDisplay, defaultDisplay
    loop.ts                       # runLoop function
    Agent.ts                      # Agent class
    index.ts
tests/
  openrouter/
    client.test.ts
  tool/
    Tool.test.ts
  session/
    InMemorySessionStore.test.ts
  agent/
    events.test.ts
    loop.test.ts
    Agent.test.ts
  integration/
    end-to-end.test.ts
```

Each subfolder's `index.ts` re-exports its public surface. Consumers import from folders (`import { Agent } from "./agent"`), never individual files. Import specifiers in source files use explicit `.js` extensions (required by NodeNext module resolution even for `.ts` sources).

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/index.ts` (empty placeholder)
- Modify: `CLAUDE.md` (add commands section)

- [ ] **Step 1: Create `.gitignore`**

```
node_modules/
dist/
coverage/
*.log
.env
.env.local
.DS_Store
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "@sftinc/openrouter-agent",
  "version": "0.0.0",
  "description": "Agent loop wrapper for OpenRouter",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8",
    "zod-to-json-schema": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["tests", "dist", "node_modules"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create placeholder `src/index.ts`**

```ts
export {};
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: packages installed, `package-lock.json` created.

- [ ] **Step 7: Verify typecheck + test runner bootstraps**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: "No test files found" or similar — exit code 1 is acceptable here (vitest run exits nonzero with no tests by default). Use `npm test -- --passWithNoTests` to confirm setup works; expected exit 0.

- [ ] **Step 8: Update `CLAUDE.md` with commands section**

Insert this before the `## Code organization` heading:

```markdown
## Commands

- `npm install` — install dependencies
- `npm run typecheck` — run TypeScript in no-emit mode
- `npm test` — run the Vitest suite once
- `npm run test:watch` — watch mode
- `npm run build` — emit `dist/`

Run a single test file: `npm test -- tests/agent/loop.test.ts`
Run a single test by name: `npm test -- -t "handles tool errors"`

```

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/index.ts CLAUDE.md
git commit -m "chore: project scaffolding (package.json, tsconfig, vitest, CLAUDE.md commands)"
```

---

## Task 2: Core shared types

**Files:**
- Create: `src/types/Message.ts`
- Create: `src/types/index.ts`

Pure type definitions — no runtime tests. TypeScript compilation is the validation.

- [ ] **Step 1: Create `src/types/Message.ts`**

```ts
/**
 * Chat messages exchanged with OpenRouter. Matches the OpenAI-compatible
 * shape documented in docs/openrouter/llm.md.
 */
export type Message =
  | { role: "system"; content: string; name?: string }
  | { role: "user"; content: string | ContentPart[]; name?: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; name?: string }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * Usage accumulated across all LLM calls in a single agent run.
 * Mirrors OpenRouter's ResponseUsage.
 */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  server_tool_use?: {
    web_search_requests?: number;
  };
}

/**
 * Result returned by Agent.run().
 */
export interface Result {
  text: string;
  messages: Message[];
  stopReason:
    | "done"
    | "max_turns"
    | "aborted"
    | "length"
    | "content_filter"
    | "error";
  usage: Usage;
  generationIds: string[];
  error?: { code?: number; message: string; metadata?: Record<string, unknown> };
}
```

- [ ] **Step 2: Create `src/types/index.ts`**

```ts
export type { Message, ContentPart, ToolCall, Usage, Result } from "./Message.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/
git commit -m "feat(types): Message, ContentPart, ToolCall, Usage, Result"
```

---

## Task 3: OpenRouter wire types

**Files:**
- Create: `src/openrouter/types.ts`
- Create: `src/openrouter/index.ts` (partial — expanded in next task)

- [ ] **Step 1: Create `src/openrouter/types.ts`**

```ts
import type { Message, ToolCall, Usage } from "../types/index.js";

/**
 * User-facing configuration mirroring OpenRouter's chat completions
 * request schema, minus `messages` and `tools` (handled by the loop
 * and the Agent respectively). Every field is optional. See
 * docs/openrouter/llm.md for the full schema.
 */
export interface LLMConfig {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  top_a?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string | string[];
  logit_bias?: Record<number, number>;
  top_logprobs?: number;
  response_format?:
    | { type: "json_object" }
    | {
        type: "json_schema";
        json_schema: { name: string; strict?: boolean; schema: object };
      };
  tool_choice?:
    | "none"
    | "auto"
    | { type: "function"; function: { name: string } };
  prediction?: { type: "content"; content: string };
  reasoning?: {
    effort?: "low" | "medium" | "high";
    max_tokens?: number;
    enabled?: boolean;
  };
  user?: string;
  models?: string[];
  route?: "fallback";
  provider?: Record<string, unknown>;
  plugins?: Array<{ id: string; [key: string]: unknown }>;
}

/** Tool declaration as sent to OpenRouter (function tools only). */
export interface OpenRouterTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

/** Non-streaming choice shape from OpenRouter. */
export interface NonStreamingChoice {
  finish_reason: string | null;
  native_finish_reason: string | null;
  message: {
    content: string | null;
    role: string;
    tool_calls?: ToolCall[];
  };
  error?: ErrorResponse;
}

export interface ErrorResponse {
  code: number;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Full non-streaming response from /chat/completions. */
export interface CompletionsResponse {
  id: string;
  choices: NonStreamingChoice[];
  created: number;
  model: string;
  object: "chat.completion";
  system_fingerprint?: string;
  usage?: Usage;
}

/** Request body we POST to /chat/completions. */
export interface CompletionsRequest extends LLMConfig {
  messages: Message[];
  tools?: OpenRouterTool[];
  stream?: false;
}

export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
```

- [ ] **Step 2: Create `src/openrouter/index.ts`**

```ts
export type {
  LLMConfig,
  OpenRouterTool,
  CompletionsRequest,
  CompletionsResponse,
  NonStreamingChoice,
  ErrorResponse,
} from "./types.js";
export { DEFAULT_MODEL } from "./types.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/openrouter/
git commit -m "feat(openrouter): LLMConfig and wire response types"
```

---

## Task 4: OpenRouterClient

**Files:**
- Create: `tests/openrouter/client.test.ts`
- Create: `src/openrouter/client.ts`
- Modify: `src/openrouter/index.ts` (export client + error)

- [ ] **Step 1: Write the failing test file**

Create `tests/openrouter/client.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenRouterClient, OpenRouterError } from "../../src/openrouter/client.js";
import type { CompletionsResponse } from "../../src/openrouter/index.js";

const OK_RESPONSE: CompletionsResponse = {
  id: "gen-abc",
  choices: [
    {
      finish_reason: "stop",
      native_finish_reason: "stop",
      message: { role: "assistant", content: "hello" },
    },
  ],
  created: 1704067200,
  model: "anthropic/claude-haiku-4.5",
  object: "chat.completion",
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

describe("OpenRouterClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("POSTs to /chat/completions with Bearer auth and JSON body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(OK_RESPONSE), { status: 200 })
    );

    const client = new OpenRouterClient({ apiKey: "sk-test" });
    const response = await client.complete({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.id).toBe("gen-abc");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("includes optional HTTP-Referer and X-OpenRouter-Title headers", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(OK_RESPONSE), { status: 200 })
    );

    const client = new OpenRouterClient({
      apiKey: "sk-test",
      referer: "https://example.com",
      title: "My App",
    });
    await client.complete({
      model: "anthropic/claude-haiku-4.5",
      messages: [{ role: "user", content: "hi" }],
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    expect(headers["X-OpenRouter-Title"]).toBe("My App");
  });

  test("throws OpenRouterError on non-2xx responses", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
      })
    );

    const client = new OpenRouterClient({ apiKey: "sk-bad" });
    await expect(
      client.complete({
        model: "anthropic/claude-haiku-4.5",
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof OpenRouterError && err.code === 401;
    });
  });

  test("uses process.env.OPENROUTER_API_KEY when apiKey is omitted", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(OK_RESPONSE), { status: 200 })
    );
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-from-env";
    try {
      const client = new OpenRouterClient({});
      await client.complete({
        model: "anthropic/claude-haiku-4.5",
        messages: [{ role: "user", content: "hi" }],
      });
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-from-env");
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  test("throws if no apiKey available", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => new OpenRouterClient({})).toThrow(
        /OPENROUTER_API_KEY/
      );
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `npm test -- tests/openrouter/client.test.ts`
Expected: all tests fail (module not found).

- [ ] **Step 3: Create `src/openrouter/client.ts`**

```ts
import type {
  CompletionsRequest,
  CompletionsResponse,
} from "./types.js";

/**
 * Thrown when OpenRouter returns a non-2xx response.
 */
export class OpenRouterError extends Error {
  readonly code: number;
  readonly body?: unknown;
  readonly metadata?: Record<string, unknown>;

  constructor(params: {
    code: number;
    message: string;
    body?: unknown;
    metadata?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = "OpenRouterError";
    this.code = params.code;
    this.body = params.body;
    this.metadata = params.metadata;
  }
}

export interface OpenRouterClientOptions {
  apiKey?: string;
  referer?: string;
  title?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly referer?: string;
  private readonly title?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterClientOptions) {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Pass apiKey to the Agent constructor or set the env var."
      );
    }
    this.apiKey = apiKey;
    this.referer = options.referer;
    this.title = options.title;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(
    request: CompletionsRequest,
    signal?: AbortSignal
  ): Promise<CompletionsResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-OpenRouter-Title"] = this.title;

    const response = await this.fetchImpl(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request, stream: false }),
        signal,
      }
    );

    if (!response.ok) {
      const body = await this.safeParseJson(response);
      const message =
        (body as { error?: { message?: string } } | undefined)?.error
          ?.message ?? `HTTP ${response.status}`;
      const metadata = (body as { error?: { metadata?: Record<string, unknown> } } | undefined)
        ?.error?.metadata;
      throw new OpenRouterError({
        code: response.status,
        message,
        body,
        metadata,
      });
    }

    return (await response.json()) as CompletionsResponse;
  }

  private async safeParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}
```

- [ ] **Step 4: Expand `src/openrouter/index.ts`**

```ts
export type {
  LLMConfig,
  OpenRouterTool,
  CompletionsRequest,
  CompletionsResponse,
  NonStreamingChoice,
  ErrorResponse,
} from "./types.js";
export { DEFAULT_MODEL } from "./types.js";
export { OpenRouterClient, OpenRouterError } from "./client.js";
export type { OpenRouterClientOptions } from "./client.js";
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `npm test -- tests/openrouter/client.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/openrouter/ tests/openrouter/
git commit -m "feat(openrouter): OpenRouterClient with OpenRouterError"
```

---

## Task 5: Tool class

**Files:**
- Create: `src/tool/types.ts`
- Create: `tests/tool/Tool.test.ts`
- Create: `src/tool/Tool.ts`
- Create: `src/tool/index.ts`

- [ ] **Step 1: Create `src/tool/types.ts`**

```ts
import type { Message, ToolCall, Usage } from "../types/index.js";
import type { LLMConfig, OpenRouterTool } from "../openrouter/index.js";
import type { AgentEvent } from "../agent/events.js";

/**
 * Normalized tool result. A string return from a tool handler is sugar for
 * `{ content: string }`. `content` is what the model sees (serialized to
 * string before sending if not already a string). `isError` and `metadata`
 * are for events, UI, and logs — never sent to the model.
 */
export interface ToolResult {
  content: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Dependencies injected into every tool's execute() call. Optional fields are
 * always populated by the agent loop; user tools can ignore them. Agents
 * used as subagents rely on `emit` and `runId` to bubble their own events
 * up into the parent's stream.
 */
export interface ToolDeps {
  complete: (
    messages: Message[],
    options?: { llm?: LLMConfig; tools?: OpenRouterTool[] }
  ) => Promise<{ content: string | null; usage: Usage; tool_calls?: ToolCall[] }>;
  emit?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  runId?: string;
  parentRunId?: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/tool/Tool.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { z } from "zod";
import { Tool } from "../../src/tool/Tool.js";
import type { ToolDeps } from "../../src/tool/types.js";

const noopDeps: ToolDeps = {
  complete: async () => ({ content: null, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }),
};

describe("Tool", () => {
  test("stores name, description, and schema", () => {
    const tool = new Tool({
      name: "echo",
      description: "Echoes the input",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => args.text,
    });
    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echoes the input");
  });

  test("execute returns string or ToolResult from handler", async () => {
    const tool = new Tool({
      name: "echo",
      description: "",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => args.text,
    });
    const out = await tool.execute({ text: "hi" }, noopDeps);
    expect(out).toBe("hi");
  });

  test("toOpenRouterTool emits function tool with JSON schema parameters", () => {
    const tool = new Tool({
      name: "get_weather",
      description: "Returns current weather",
      inputSchema: z.object({
        city: z.string().describe("City name"),
        units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
      }),
      execute: async () => "sunny",
    });
    const wire = tool.toOpenRouterTool();
    expect(wire.type).toBe("function");
    expect(wire.function.name).toBe("get_weather");
    expect(wire.function.description).toBe("Returns current weather");
    expect(typeof wire.function.parameters).toBe("object");
    const params = wire.function.parameters as { properties: Record<string, unknown> };
    expect(params.properties).toHaveProperty("city");
    expect(params.properties).toHaveProperty("units");
  });

  test("display hooks are stored and callable", () => {
    const tool = new Tool({
      name: "echo",
      description: "",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => args.text,
      display: {
        start: (args) => ({ title: `Echoing ${args.text}` }),
        end: (args, output) => ({ title: `Echoed`, content: output }),
      },
    });
    expect(tool.display?.start?.({ text: "hi" })).toEqual({ title: "Echoing hi" });
    expect(tool.display?.end?.({ text: "hi" }, "hi", { isError: false })).toEqual({
      title: "Echoed",
      content: "hi",
    });
  });
});
```

- [ ] **Step 3: Run the test — expect FAIL**

Run: `npm test -- tests/tool/Tool.test.ts`
Expected: fails (Tool not found).

- [ ] **Step 4: Create `src/tool/Tool.ts`**

```ts
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { OpenRouterTool } from "../openrouter/index.js";
import type { ToolDeps, ToolResult } from "./types.js";
import type { EventDisplay } from "../agent/events.js";

export interface ToolDisplayHooks<Args> {
  start?: (args: Args) => EventDisplay;
  progress?: (args: Args, meta: { elapsedMs: number }) => EventDisplay;
  end?: (args: Args, output: unknown, meta: { isError: boolean }) => EventDisplay;
}

export interface ToolConfig<Args> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Args>;
  execute: (args: Args, deps: ToolDeps) => Promise<string | ToolResult>;
  display?: ToolDisplayHooks<Args>;
}

export class Tool<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Args>;
  readonly display?: ToolDisplayHooks<Args>;
  private readonly executeFn: (args: Args, deps: ToolDeps) => Promise<string | ToolResult>;

  constructor(config: ToolConfig<Args>) {
    this.name = config.name;
    this.description = config.description;
    this.inputSchema = config.inputSchema;
    this.executeFn = config.execute;
    this.display = config.display;
  }

  execute(args: Args, deps: ToolDeps): Promise<string | ToolResult> {
    return this.executeFn(args, deps);
  }

  toOpenRouterTool(): OpenRouterTool {
    const schema = zodToJsonSchema(this.inputSchema, { target: "openApi3" });
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: schema as object,
      },
    };
  }
}
```

- [ ] **Step 5: Create `src/tool/index.ts`**

```ts
export { Tool } from "./Tool.js";
export type { ToolConfig, ToolDisplayHooks } from "./Tool.js";
export type { ToolDeps, ToolResult } from "./types.js";
```

- [ ] **Step 6: Note the forward reference**

`Tool.ts` imports `EventDisplay` from `../agent/events.js`, which doesn't exist yet. This is a forward reference that the next task resolves. Until then typecheck will fail — that's expected.

- [ ] **Step 7: Commit the partial state**

```bash
git add src/tool/ tests/tool/
git commit -m "feat(tool): Tool class with Zod input schema and display hooks (pending events module)"
```

---

## Task 6: Session storage

**Files:**
- Create: `src/session/SessionStore.ts`
- Create: `src/session/InMemorySessionStore.ts`
- Create: `tests/session/InMemorySessionStore.test.ts`
- Create: `src/session/index.ts`

- [ ] **Step 1: Create `src/session/SessionStore.ts`**

```ts
import type { Message } from "../types/index.js";

/**
 * Pluggable persistence for conversation history.
 */
export interface SessionStore {
  get(sessionId: string): Promise<Message[] | null>;
  set(sessionId: string, messages: Message[]): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/session/InMemorySessionStore.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { InMemorySessionStore } from "../../src/session/InMemorySessionStore.js";
import type { Message } from "../../src/types/index.js";

const msgs: Message[] = [
  { role: "system", content: "be helpful" },
  { role: "user", content: "hi" },
];

describe("InMemorySessionStore", () => {
  test("get returns null for unknown session", async () => {
    const store = new InMemorySessionStore();
    expect(await store.get("nope")).toBeNull();
  });

  test("set then get returns the stored messages", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", msgs);
    expect(await store.get("s1")).toEqual(msgs);
  });

  test("set clones the array so later mutations don't affect storage", async () => {
    const store = new InMemorySessionStore();
    const mutable: Message[] = [{ role: "user", content: "hi" }];
    await store.set("s1", mutable);
    mutable.push({ role: "user", content: "should not leak" });
    const stored = await store.get("s1");
    expect(stored).toHaveLength(1);
  });

  test("delete removes the session", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", msgs);
    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test — expect FAIL**

Run: `npm test -- tests/session/InMemorySessionStore.test.ts`
Expected: fails (module not found).

- [ ] **Step 4: Create `src/session/InMemorySessionStore.ts`**

```ts
import type { SessionStore } from "./SessionStore.js";
import type { Message } from "../types/index.js";

export class InMemorySessionStore implements SessionStore {
  private readonly map = new Map<string, Message[]>();

  async get(sessionId: string): Promise<Message[] | null> {
    const value = this.map.get(sessionId);
    return value ? [...value] : null;
  }

  async set(sessionId: string, messages: Message[]): Promise<void> {
    this.map.set(sessionId, [...messages]);
  }

  async delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId);
  }
}
```

- [ ] **Step 5: Create `src/session/index.ts`**

```ts
export type { SessionStore } from "./SessionStore.js";
export { InMemorySessionStore } from "./InMemorySessionStore.js";
```

- [ ] **Step 6: Run the test — expect PASS**

Run: `npm test -- tests/session/InMemorySessionStore.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/session/ tests/session/
git commit -m "feat(session): SessionStore interface and InMemorySessionStore"
```

---

## Task 7: AgentEvent, EventDisplay, defaultDisplay

**Files:**
- Create: `tests/agent/events.test.ts`
- Create: `src/agent/events.ts`

This task unblocks the forward reference in `Tool.ts` from Task 5.

- [ ] **Step 1: Write the failing test**

Create `tests/agent/events.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { defaultDisplay, type AgentEvent } from "../../src/agent/events.js";

describe("defaultDisplay", () => {
  test("agent:start uses agentName", () => {
    const ev: AgentEvent = {
      type: "agent:start",
      runId: "r1",
      agentName: "research",
    };
    expect(defaultDisplay(ev).title).toBe("Starting research");
  });

  test("tool:start uses toolName", () => {
    const ev: AgentEvent = {
      type: "tool:start",
      runId: "r1",
      toolUseId: "t1",
      toolName: "web_search",
      input: { queries: ["foo"] },
    };
    expect(defaultDisplay(ev).title).toBe("Running web_search");
  });

  test("tool:end shows success or failure", () => {
    const ok: AgentEvent = {
      type: "tool:end",
      runId: "r1",
      toolUseId: "t1",
      output: "result",
      isError: false,
    };
    expect(defaultDisplay(ok).title).toBe("Completed tool");
    const err: AgentEvent = { ...ok, isError: true };
    expect(defaultDisplay(err).title).toBe("Tool failed");
  });

  test("agent:end title is Done", () => {
    const ev: AgentEvent = {
      type: "agent:end",
      runId: "r1",
      result: {
        text: "",
        messages: [],
        stopReason: "done",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        generationIds: [],
      },
    };
    expect(defaultDisplay(ev).title).toBe("Done");
  });

  test("error includes the error message", () => {
    const ev: AgentEvent = {
      type: "error",
      runId: "r1",
      error: { message: "rate limited" },
    };
    expect(defaultDisplay(ev).title).toBe("Error");
    expect(defaultDisplay(ev).content).toBe("rate limited");
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `npm test -- tests/agent/events.test.ts`
Expected: fails (module not found).

- [ ] **Step 3: Create `src/agent/events.ts`**

```ts
import type { Message, Result } from "../types/index.js";

export interface EventDisplay {
  title: string;
  content?: unknown;
}

export type AgentEvent =
  | {
      type: "agent:start";
      runId: string;
      parentRunId?: string;
      agentName: string;
      display?: EventDisplay;
    }
  | {
      type: "agent:end";
      runId: string;
      result: Result;
      display?: EventDisplay;
    }
  | {
      type: "message";
      runId: string;
      message: Message;
      display?: EventDisplay;
    }
  | {
      type: "tool:start";
      runId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      display?: EventDisplay;
    }
  | {
      type: "tool:progress";
      runId: string;
      toolUseId: string;
      elapsedMs: number;
      display?: EventDisplay;
    }
  | {
      type: "tool:end";
      runId: string;
      toolUseId: string;
      output: unknown;
      isError: boolean;
      display?: EventDisplay;
    }
  | {
      type: "error";
      runId: string;
      error: { code?: number; message: string };
      display?: EventDisplay;
    };

/**
 * Fallback display for events that don't carry a `display` field.
 * Consumers should prefer `event.display` if set: `event.display ?? defaultDisplay(event)`.
 */
export function defaultDisplay(event: AgentEvent): EventDisplay {
  switch (event.type) {
    case "agent:start":
      return { title: `Starting ${event.agentName}` };
    case "agent:end":
      return { title: "Done" };
    case "message":
      return { title: "Message" };
    case "tool:start":
      return { title: `Running ${event.toolName}` };
    case "tool:progress":
      return { title: `Still running (${Math.round(event.elapsedMs / 1000)}s)` };
    case "tool:end":
      return { title: event.isError ? "Tool failed" : "Completed tool" };
    case "error":
      return { title: "Error", content: event.error.message };
  }
}

export type EventEmit = (event: AgentEvent) => void;
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm test -- tests/agent/events.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Verify Tool.test.ts now passes too**

Run: `npm test -- tests/tool/Tool.test.ts`
Expected: all 4 tests pass (forward reference resolved).

- [ ] **Step 6: Run full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/agent/events.ts tests/agent/events.test.ts
git commit -m "feat(agent): AgentEvent union, EventDisplay, defaultDisplay helper"
```

---

## Task 8: The agent loop

**Files:**
- Create: `tests/agent/loop.test.ts`
- Create: `src/agent/loop.ts`

This is the core of the library. The loop:
1. Resolves initial messages (seed from session or input).
2. Calls OpenRouter until `finish_reason != "tool_calls"` or `maxTurns` hit.
3. On `tool_calls`, dispatches each sequentially, feeds results back, continues.
4. Emits events throughout.
5. Accumulates usage and generation IDs.
6. Persists to session store on exit if `sessionId` provided.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent/loop.test.ts`:

```ts
import { describe, test, expect, vi } from "vitest";
import { z } from "zod";
import { runLoop, type RunLoopConfig } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { Tool } from "../../src/tool/Tool.js";
import { InMemorySessionStore } from "../../src/session/InMemorySessionStore.js";
import type { CompletionsResponse } from "../../src/openrouter/index.js";

function mockResponse(partial: Partial<CompletionsResponse> & { message: { content: string | null; tool_calls?: unknown[] }; finish_reason?: string }): CompletionsResponse {
  return {
    id: partial.id ?? "gen-1",
    object: "chat.completion",
    created: 1704067200,
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: partial.finish_reason ?? "stop",
        native_finish_reason: partial.finish_reason ?? "stop",
        message: {
          role: "assistant",
          content: partial.message.content,
          tool_calls: partial.message.tool_calls as any,
        },
      },
    ],
    usage: partial.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function mkConfig(overrides: Partial<RunLoopConfig> = {}): RunLoopConfig {
  const client = {
    complete: vi.fn().mockResolvedValue(
      mockResponse({ message: { content: "hello" } })
    ),
  };
  return {
    agentName: "test-agent",
    systemPrompt: "you are helpful",
    llm: { model: "anthropic/claude-haiku-4.5" },
    tools: [],
    maxTurns: 10,
    client: client as any,
    ...overrides,
  };
}

function collect(events: AgentEvent[]): (ev: AgentEvent) => void {
  return (ev) => { events.push(ev); };
}

describe("runLoop", () => {
  test("single-turn no-tool run returns done", async () => {
    const events: AgentEvent[] = [];
    const cfg = mkConfig();

    await runLoop(cfg, "hi", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    expect(end?.type).toBe("agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("done");
      expect(end.result.text).toBe("hello");
      expect(end.result.usage.total_tokens).toBe(15);
      expect(end.result.generationIds).toEqual(["gen-1"]);
    }
  });

  test("tool_calls are dispatched and results fed back", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => `ECHO:${args.text}`,
    });
    const client = {
      complete: vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            id: "gen-1",
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) },
                },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          mockResponse({ id: "gen-2", message: { content: "final" } })
        ),
    };
    const cfg = mkConfig({ tools: [tool], client: client as any });

    await runLoop(cfg, "please echo", {}, collect(events));

    expect(client.complete).toHaveBeenCalledTimes(2);
    const second = client.complete.mock.calls[1][0];
    const toolMsg = (second.messages as any[]).find((m) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("call-1");
    expect(toolMsg.content).toBe("ECHO:hi");

    const toolStart = events.find((e) => e.type === "tool:start");
    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === "tool:end") {
      expect(toolEnd.isError).toBe(false);
      expect(toolEnd.output).toBe("ECHO:hi");
    }
  });

  test("tool handler errors feed 'Error: ...' to model with isError=true and loop continues", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "crash",
      description: "always fails",
      inputSchema: z.object({}),
      execute: async () => { throw new Error("boom"); },
    });
    const client = {
      complete: vi.fn()
        .mockResolvedValueOnce(
          mockResponse({
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "c", type: "function", function: { name: "crash", arguments: "{}" } },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          mockResponse({ message: { content: "recovered" } })
        ),
    };
    const cfg = mkConfig({ tools: [tool], client: client as any });

    await runLoop(cfg, "go", {}, collect(events));

    const toolEnd = events.find((e) => e.type === "tool:end");
    if (toolEnd?.type === "tool:end") {
      expect(toolEnd.isError).toBe(true);
      expect(String(toolEnd.output)).toContain("boom");
    }
    const secondCall = client.complete.mock.calls[1][0];
    const toolMsg = (secondCall.messages as any[]).find((m) => m.role === "tool");
    expect(toolMsg.content).toContain("boom");
    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("done");
    }
  });

  test("maxTurns bailout sets stopReason to max_turns", async () => {
    const events: AgentEvent[] = [];
    const tool = new Tool({
      name: "loop",
      description: "loop",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });
    const client = {
      complete: vi.fn().mockResolvedValue(
        mockResponse({
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "loop", arguments: "{}" } }],
          },
        })
      ),
    };
    const cfg = mkConfig({ tools: [tool], maxTurns: 2, client: client as any });

    await runLoop(cfg, "go", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("max_turns");
    }
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  test("AbortSignal triggers aborted stopReason between turns", async () => {
    const events: AgentEvent[] = [];
    const ac = new AbortController();
    const tool = new Tool({
      name: "loop",
      description: "loop",
      inputSchema: z.object({}),
      execute: async () => { ac.abort(); return "ok"; },
    });
    const client = {
      complete: vi.fn().mockResolvedValue(
        mockResponse({
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "c", type: "function", function: { name: "loop", arguments: "{}" } }],
          },
        })
      ),
    };
    const cfg = mkConfig({ tools: [tool], client: client as any });

    await runLoop(cfg, "go", { signal: ac.signal }, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("aborted");
    }
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  test("sessionId seeds history and persists updated history on exit", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [
      { role: "system", content: "be nice" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ]);
    const events: AgentEvent[] = [];
    const cfg = mkConfig({ sessionStore: store });

    await runLoop(cfg, "followup", { sessionId: "s1" }, collect(events));

    const persisted = await store.get("s1");
    expect(persisted).not.toBeNull();
    const roles = persisted!.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant"]);
  });

  test("run-time system replaces session's system message", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [{ role: "system", content: "old" }]);
    const events: AgentEvent[] = [];
    const client = { complete: vi.fn().mockResolvedValue(mockResponse({ message: { content: "ok" } })) };
    const cfg = mkConfig({ sessionStore: store, client: client as any });

    await runLoop(cfg, "hi", { sessionId: "s1", system: "new prompt" }, collect(events));

    const [req] = client.complete.mock.calls[0];
    const sys = (req.messages as any[]).find((m) => m.role === "system");
    expect(sys.content).toBe("new prompt");
    const persisted = await store.get("s1");
    const sysStored = persisted!.find((m) => m.role === "system");
    expect(sysStored?.content).toBe("new prompt");
  });

  test("infrastructure error from client aborts with stopReason=error", async () => {
    const events: AgentEvent[] = [];
    const client = {
      complete: vi.fn().mockRejectedValue(
        Object.assign(new Error("rate limited"), { code: 429 })
      ),
    };
    const cfg = mkConfig({ client: client as any });

    await runLoop(cfg, "hi", {}, collect(events));

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type === "agent:end") {
      expect(end.result.stopReason).toBe("error");
      expect(end.result.error?.message).toBe("rate limited");
    }
  });

  test("emits agent:start, message, and agent:end in order", async () => {
    const events: AgentEvent[] = [];
    await runLoop(mkConfig(), "hi", {}, collect(events));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("agent:start");
    expect(types).toContain("message");
    expect(types[types.length - 1]).toBe("agent:end");
  });
});
```

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: fails (module not found).

- [ ] **Step 3: Create `src/agent/loop.ts`**

```ts
import type { Message, Result, Usage } from "../types/index.js";
import type {
  CompletionsResponse,
  LLMConfig,
  OpenRouterTool,
} from "../openrouter/index.js";
import { DEFAULT_MODEL } from "../openrouter/index.js";
import type { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import type { AgentEvent, EventEmit } from "./events.js";

export interface RunLoopConfig {
  agentName: string;
  systemPrompt?: string;
  llm: LLMConfig;
  tools: Tool[];
  maxTurns: number;
  sessionStore?: SessionStore;
  client: {
    complete: (
      request: { messages: Message[]; tools?: OpenRouterTool[] } & LLMConfig,
      signal?: AbortSignal
    ) => Promise<CompletionsResponse>;
  };
  parentRunId?: string;
  display?: {
    start?: (input: string | Message[]) => { title: string; content?: unknown };
    end?: (result: Result) => { title: string; content?: unknown };
  };
}

export interface RunLoopOptions {
  sessionId?: string;
  system?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  llm?: LLMConfig;
  parentRunId?: string;
}

function newRunId(): string {
  return `run-${Math.random().toString(36).slice(2, 10)}`;
}

function newToolUseId(fallback: string): string {
  return fallback || `tu-${Math.random().toString(36).slice(2, 10)}`;
}

function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function addUsage(a: Usage, b: Usage | undefined): Usage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cost: (a.cost ?? 0) + (b.cost ?? 0) || undefined,
    prompt_tokens_details: mergeSubUsage(a.prompt_tokens_details, b.prompt_tokens_details),
    completion_tokens_details: mergeSubUsage(a.completion_tokens_details, b.completion_tokens_details),
    server_tool_use: mergeServerToolUse(a.server_tool_use, b.server_tool_use),
  };
}

function mergeSubUsage<T extends Record<string, number | undefined>>(
  a: T | undefined,
  b: T | undefined
): T | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    }
  }
  return out as T;
}

function mergeServerToolUse(
  a: Usage["server_tool_use"],
  b: Usage["server_tool_use"]
): Usage["server_tool_use"] {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    }
  }
  return out as Usage["server_tool_use"];
}

function normalizeToolResult(raw: string | ToolResult): ToolResult {
  return typeof raw === "string" ? { content: raw } : raw;
}

function wireContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function safeDisplay<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function resolveInitialMessages(
  input: string | Message[],
  systemOverride: string | undefined,
  systemFromConfig: string | undefined,
  sessionMessages: Message[] | null
): Message[] {
  const messages: Message[] = sessionMessages ? [...sessionMessages] : [];

  let systemContent: string | undefined;
  if (systemOverride !== undefined) {
    systemContent = systemOverride;
  } else if (Array.isArray(input)) {
    const sys = input.find((m) => m.role === "system");
    if (sys && typeof sys.content === "string") systemContent = sys.content;
  } else if (messages.length === 0) {
    systemContent = systemFromConfig;
  }

  if (systemContent !== undefined) {
    const existing = messages.findIndex((m) => m.role === "system");
    const sysMsg: Message = { role: "system", content: systemContent };
    if (existing >= 0) messages[existing] = sysMsg;
    else messages.unshift(sysMsg);
  } else if (messages.length === 0 && systemFromConfig) {
    messages.unshift({ role: "system", content: systemFromConfig });
  }

  if (Array.isArray(input)) {
    for (const m of input) {
      if (m.role === "system") continue;
      messages.push(m);
    }
  } else {
    messages.push({ role: "user", content: input });
  }

  return messages;
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

export async function runLoop(
  config: RunLoopConfig,
  input: string | Message[],
  options: RunLoopOptions,
  emit: EventEmit
): Promise<void> {
  const runId = newRunId();
  const parentRunId = options.parentRunId ?? config.parentRunId;
  const maxTurns = options.maxTurns ?? config.maxTurns;
  const signal = options.signal;
  const llm: LLMConfig = {
    model: DEFAULT_MODEL,
    ...config.llm,
    ...(options.llm ?? {}),
  };

  emit({
    type: "agent:start",
    runId,
    parentRunId,
    agentName: config.agentName,
    display: safeDisplay(() => config.display?.start?.(input)),
  });

  const sessionMessages =
    options.sessionId && config.sessionStore
      ? await config.sessionStore.get(options.sessionId)
      : null;
  let messages = resolveInitialMessages(
    input,
    options.system,
    config.systemPrompt,
    sessionMessages
  );

  const toolByName = new Map<string, Tool>();
  for (const t of config.tools) toolByName.set(t.name, t);
  const openrouterTools =
    config.tools.length > 0 ? config.tools.map((t) => t.toOpenRouterTool()) : undefined;

  let usage = zeroUsage();
  const generationIds: string[] = [];
  let stopReason: Result["stopReason"] | null = null;
  let error: Result["error"];

  const deps: ToolDeps = {
    complete: async (msgs, opts) => {
      const res = await config.client.complete(
        {
          ...llm,
          ...(opts?.llm ?? {}),
          messages: msgs,
          tools: opts?.tools,
        },
        signal
      );
      const choice = res.choices[0];
      return {
        content: choice?.message.content ?? null,
        usage: res.usage ?? zeroUsage(),
        tool_calls: choice?.message.tool_calls,
      };
    },
    emit,
    signal,
    runId,
    parentRunId,
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      stopReason = "aborted";
      break;
    }

    let response: CompletionsResponse;
    try {
      response = await config.client.complete(
        { ...llm, messages, tools: openrouterTools },
        signal
      );
    } catch (err) {
      stopReason = "error";
      const anyErr = err as { code?: number; message?: string; metadata?: Record<string, unknown> };
      error = {
        code: anyErr.code,
        message: anyErr.message ?? String(err),
        metadata: anyErr.metadata,
      };
      emit({ type: "error", runId, error: { code: anyErr.code, message: error.message } });
      break;
    }

    generationIds.push(response.id);
    usage = addUsage(usage, response.usage);

    const choice = response.choices[0];
    if (!choice) {
      stopReason = "error";
      error = { message: "OpenRouter response had no choices" };
      emit({ type: "error", runId, error: { message: error.message } });
      break;
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    };
    messages.push(assistantMsg);
    emit({ type: "message", runId, message: assistantMsg });

    const fr = choice.finish_reason;
    if (fr === "stop") { stopReason = "done"; break; }
    if (fr === "length") { stopReason = "length"; break; }
    if (fr === "content_filter") { stopReason = "content_filter"; break; }
    if (fr === "error") {
      stopReason = "error";
      error = choice.error
        ? { code: choice.error.code, message: choice.error.message, metadata: choice.error.metadata }
        : { message: "Unknown error from provider" };
      emit({ type: "error", runId, error: { code: error.code, message: error.message } });
      break;
    }

    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      stopReason = "done";
      break;
    }

    for (const toolCall of choice.message.tool_calls) {
      const toolUseId = newToolUseId(toolCall.id);
      const toolName = toolCall.function.name;
      const tool = toolByName.get(toolName);

      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        parsedArgs = {};
      }

      emit({
        type: "tool:start",
        runId,
        toolUseId,
        toolName,
        input: parsedArgs,
        display: tool ? safeDisplay(() => tool.display?.start?.(parsedArgs)) : undefined,
      });

      let result: ToolResult;
      if (!tool) {
        result = {
          content: `Error: tool "${toolName}" is not registered with this agent`,
          isError: true,
        };
      } else {
        try {
          const validated = tool.inputSchema.parse(parsedArgs);
          const raw = await tool.execute(validated, deps);
          result = normalizeToolResult(raw);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result = { content: `Error: ${msg}`, isError: true };
        }
      }

      emit({
        type: "tool:end",
        runId,
        toolUseId,
        output: result.content,
        isError: !!result.isError,
        display: tool
          ? safeDisplay(() =>
              tool.display?.end?.(
                parsedArgs as never,
                result.content,
                { isError: !!result.isError }
              )
            )
          : undefined,
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: wireContent(result.content),
      });
    }

    // Loop continues for next turn.
  }

  if (stopReason === null) stopReason = "max_turns";

  if (options.sessionId && config.sessionStore) {
    await config.sessionStore.set(options.sessionId, messages);
  }

  const result: Result = {
    text: lastAssistantText(messages),
    messages,
    stopReason,
    usage,
    generationIds,
    error,
  };

  emit({
    type: "agent:end",
    runId,
    result,
    display: safeDisplay(() => config.display?.end?.(result)),
  });
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npm test -- tests/agent/loop.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat(agent): runLoop — tool dispatch, usage accumulation, session persistence, errors"
```

---

## Task 9: Agent class

**Files:**
- Create: `tests/agent/Agent.test.ts`
- Create: `src/agent/Agent.ts`
- Create: `src/agent/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent/Agent.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Agent } from "../../src/agent/Agent.js";
import { Tool } from "../../src/tool/Tool.js";
import type { CompletionsResponse } from "../../src/openrouter/index.js";

function mockOkResponse(content: string, id = "gen-x"): CompletionsResponse {
  return {
    id,
    object: "chat.completion",
    created: 1704067200,
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: "stop",
        native_finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

describe("Agent", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.OPENROUTER_API_KEY = "sk-test";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("run returns Result with text and usage", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockOkResponse("hi there")), { status: 200 })
    );
    const agent = new Agent({ name: "a", description: "d" });
    const result = await agent.run("hello");
    expect(result.text).toBe("hi there");
    expect(result.stopReason).toBe("done");
    expect(result.usage.total_tokens).toBe(8);
  });

  test("runStream yields events in order", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockOkResponse("ok")), { status: 200 })
    );
    const agent = new Agent({ name: "a", description: "d" });
    const events: string[] = [];
    for await (const ev of agent.runStream("hello")) {
      events.push(ev.type);
    }
    expect(events[0]).toBe("agent:start");
    expect(events).toContain("message");
    expect(events[events.length - 1]).toBe("agent:end");
  });

  test("default model is anthropic/claude-haiku-4.5 when llm is omitted", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockOkResponse("ok")), { status: 200 })
    );
    const agent = new Agent({ name: "a", description: "d" });
    await agent.run("hi");
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
  });

  test("per-run llm shallow-merges over constructor llm", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockOkResponse("ok")), { status: 200 })
    );
    const agent = new Agent({
      name: "a",
      description: "d",
      llm: { model: "anthropic/claude-haiku-4.5", temperature: 0.7 },
    });
    await agent.run("hi", { llm: { temperature: 0 } });
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.temperature).toBe(0);
  });

  test("Agent can be used as a Tool (subagent)", async () => {
    // First call: parent emits tool_calls for 'child'. Second call: child responds 'child-done'. Third: parent's final response.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "gen-1",
            object: "chat.completion",
            created: 1,
            model: "anthropic/claude-haiku-4.5",
            choices: [
              {
                finish_reason: "tool_calls",
                native_finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "child", arguments: JSON.stringify({ input: "do it" }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockOkResponse("child-done", "gen-2")), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockOkResponse("parent-final", "gen-3")), { status: 200 })
      );

    const child = new Agent({ name: "child", description: "a subagent" });
    const parent = new Agent({ name: "parent", description: "the parent", tools: [child] });
    const result = await parent.run("use the child");
    expect(result.text).toBe("parent-final");
    expect(result.stopReason).toBe("done");
  });

  test("subagent events bubble up with parentRunId", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "gen-1",
            object: "chat.completion",
            created: 1,
            model: "anthropic/claude-haiku-4.5",
            choices: [
              {
                finish_reason: "tool_calls",
                native_finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "child", arguments: JSON.stringify({ input: "hi" }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockOkResponse("child-done", "gen-2")), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockOkResponse("final", "gen-3")), { status: 200 })
      );

    const child = new Agent({ name: "child", description: "sub" });
    const parent = new Agent({ name: "parent", description: "p", tools: [child] });

    const starts: { agentName: string; parentRunId?: string }[] = [];
    for await (const ev of parent.runStream("go")) {
      if (ev.type === "agent:start") {
        starts.push({ agentName: ev.agentName, parentRunId: ev.parentRunId });
      }
    }
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ agentName: "parent" });
    expect(starts[0].parentRunId).toBeUndefined();
    expect(starts[1]).toMatchObject({ agentName: "child" });
    expect(typeof starts[1].parentRunId).toBe("string");
  });

  test("custom tool with Zod schema is validated before execute", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "gen-1",
            object: "chat.completion",
            created: 1,
            model: "anthropic/claude-haiku-4.5",
            choices: [
              {
                finish_reason: "tool_calls",
                native_finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "weather", arguments: JSON.stringify({ city: 123 }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockOkResponse("recovered", "gen-2")), { status: 200 })
      );

    const weather = new Tool({
      name: "weather",
      description: "weather",
      inputSchema: z.object({ city: z.string() }),
      execute: async (args) => `weather in ${args.city}`,
    });
    const agent = new Agent({ name: "a", description: "d", tools: [weather] });
    const result = await agent.run("what's the weather");
    expect(result.stopReason).toBe("done");
    // Tool message should carry the validation error, not crash the loop.
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(String((toolMsg as { content: string }).content)).toMatch(/Error/i);
  });
});
```

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `npm test -- tests/agent/Agent.test.ts`
Expected: fails (Agent not found).

- [ ] **Step 3: Create `src/agent/Agent.ts`**

```ts
import { z } from "zod";
import type { Message, Result } from "../types/index.js";
import type { LLMConfig } from "../openrouter/index.js";
import { OpenRouterClient } from "../openrouter/index.js";
import { Tool } from "../tool/Tool.js";
import type { ToolDeps, ToolResult } from "../tool/types.js";
import type { SessionStore } from "../session/index.js";
import { InMemorySessionStore } from "../session/index.js";
import type { AgentEvent, EventDisplay } from "./events.js";
import { runLoop, type RunLoopConfig, type RunLoopOptions } from "./loop.js";

export interface AgentConfig<Input> {
  name: string;
  description: string;
  llm?: LLMConfig;
  systemPrompt?: string;
  tools?: Tool[];
  inputSchema?: z.ZodType<Input>;
  maxTurns?: number;
  sessionStore?: SessionStore;
  apiKey?: string;
  referer?: string;
  title?: string;
  display?: {
    start?: (input: string | Message[]) => EventDisplay;
    end?: (result: Result) => EventDisplay;
  };
}

export type AgentRunOptions = Omit<RunLoopOptions, "parentRunId"> & {
  parentRunId?: string;
};

const DEFAULT_INPUT_SCHEMA = z.object({ input: z.string() });

export class Agent<Input = { input: string }> extends Tool<Input> {
  private readonly llm: LLMConfig;
  private readonly systemPrompt?: string;
  private readonly agentTools: Tool[];
  private readonly maxTurns: number;
  private readonly sessionStore: SessionStore;
  private readonly client: OpenRouterClient;
  private readonly agentDisplay?: AgentConfig<Input>["display"];

  constructor(config: AgentConfig<Input>) {
    const inputSchema =
      config.inputSchema ?? (DEFAULT_INPUT_SCHEMA as unknown as z.ZodType<Input>);

    super({
      name: config.name,
      description: config.description,
      inputSchema,
      execute: async (args: Input, deps: ToolDeps): Promise<string | ToolResult> => {
        const inputStr =
          args && typeof args === "object" && "input" in args
            ? String((args as { input: unknown }).input)
            : String(args);

        const events: AgentEvent[] = [];
        const parentEmit = deps.emit;
        await runLoop(
          this.buildConfig(deps.runId),
          inputStr,
          { signal: deps.signal, parentRunId: deps.runId },
          (ev) => {
            events.push(ev);
            parentEmit?.(ev);
          }
        );
        const end = events.find((e) => e.type === "agent:end");
        if (end?.type !== "agent:end") {
          return { content: "", isError: true };
        }
        return { content: end.result.text };
      },
    });

    this.llm = config.llm ?? {};
    this.systemPrompt = config.systemPrompt;
    this.agentTools = config.tools ?? [];
    this.maxTurns = config.maxTurns ?? 10;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.client = new OpenRouterClient({
      apiKey: config.apiKey,
      referer: config.referer,
      title: config.title,
    });
    this.agentDisplay = config.display;
  }

  async run(input: string | Message[], options: AgentRunOptions = {}): Promise<Result> {
    const events: AgentEvent[] = [];
    await runLoop(this.buildConfig(options.parentRunId), input, options, (ev) => {
      events.push(ev);
    });
    const end = events.find((e) => e.type === "agent:end");
    if (end?.type !== "agent:end") {
      throw new Error("runLoop finished without agent:end event");
    }
    return end.result;
  }

  async *runStream(
    input: string | Message[],
    options: AgentRunOptions = {}
  ): AsyncIterable<AgentEvent> {
    const queue: AgentEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;

    const emit = (ev: AgentEvent) => {
      queue.push(ev);
      const r = resolveNext;
      resolveNext = null;
      r?.();
    };

    const loopPromise = runLoop(this.buildConfig(options.parentRunId), input, options, emit)
      .finally(() => {
        done = true;
        const r = resolveNext;
        resolveNext = null;
        r?.();
      });

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }

    await loopPromise;
  }

  private buildConfig(parentRunId?: string): RunLoopConfig {
    return {
      agentName: this.name,
      systemPrompt: this.systemPrompt,
      llm: this.llm,
      tools: this.agentTools,
      maxTurns: this.maxTurns,
      sessionStore: this.sessionStore,
      client: this.client,
      parentRunId,
      display: this.agentDisplay,
    };
  }
}
```

- [ ] **Step 4: Create `src/agent/index.ts`**

```ts
export { Agent } from "./Agent.js";
export type { AgentConfig, AgentRunOptions } from "./Agent.js";
export { runLoop } from "./loop.js";
export type { RunLoopConfig, RunLoopOptions } from "./loop.js";
export { defaultDisplay } from "./events.js";
export type { AgentEvent, EventDisplay, EventEmit } from "./events.js";
```

- [ ] **Step 5: Run the tests — expect PASS**

Run: `npm test -- tests/agent/Agent.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 6: Run full typecheck and full suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/agent/Agent.ts src/agent/index.ts tests/agent/Agent.test.ts
git commit -m "feat(agent): Agent class with run/runStream and subagent-as-tool"
```

---

## Task 10: Top-level barrel and end-to-end integration test

**Files:**
- Modify: `src/index.ts`
- Create: `tests/integration/end-to-end.test.ts`

- [ ] **Step 1: Replace `src/index.ts` with the public surface**

```ts
export { Agent } from "./agent/index.js";
export type { AgentConfig, AgentRunOptions } from "./agent/index.js";
export { Tool } from "./tool/index.js";
export type { ToolConfig, ToolDisplayHooks, ToolDeps, ToolResult } from "./tool/index.js";
export {
  InMemorySessionStore,
} from "./session/index.js";
export type { SessionStore } from "./session/index.js";
export { defaultDisplay } from "./agent/index.js";
export type {
  AgentEvent,
  EventDisplay,
  EventEmit,
} from "./agent/index.js";
export {
  OpenRouterClient,
  OpenRouterError,
  DEFAULT_MODEL,
} from "./openrouter/index.js";
export type {
  LLMConfig,
  OpenRouterClientOptions,
  OpenRouterTool,
  CompletionsRequest,
  CompletionsResponse,
} from "./openrouter/index.js";
export type {
  Message,
  ContentPart,
  ToolCall,
  Usage,
  Result,
} from "./types/index.js";
```

- [ ] **Step 2: Write the integration test**

Create `tests/integration/end-to-end.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Agent, Tool } from "../../src/index.js";
import type { AgentEvent } from "../../src/index.js";

function completionWithToolCall(id: string, name: string, args: object) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: "tool_calls",
        native_finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "tc-" + id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function completionText(id: string, text: string) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "anthropic/claude-haiku-4.5",
    choices: [
      {
        finish_reason: "stop",
        native_finish_reason: "stop",
        message: { role: "assistant", content: text },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
  };
}

describe("end-to-end", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.OPENROUTER_API_KEY = "sk-e2e";
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("Agent invokes a custom Tool, feeds result back, and returns synthesis", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completionWithToolCall("gen-1", "lookup", { key: "X" })), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completionText("gen-2", "value for X is 42")), { status: 200 })
      );

    const lookup = new Tool({
      name: "lookup",
      description: "Returns the value for a key",
      inputSchema: z.object({ key: z.string() }),
      execute: async (args) => ({ content: `${args.key}=42`, metadata: { source: "mock" } }),
    });

    const agent = new Agent({
      name: "researcher",
      description: "Looks things up",
      systemPrompt: "Answer questions using the lookup tool.",
      tools: [lookup],
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.runStream("what is X?")) {
      events.push(ev);
    }

    const end = events.find((e) => e.type === "agent:end");
    if (end?.type !== "agent:end") throw new Error("no agent:end event");

    expect(end.result.text).toBe("value for X is 42");
    expect(end.result.stopReason).toBe("done");
    expect(end.result.generationIds).toEqual(["gen-1", "gen-2"]);
    expect(end.result.usage.total_tokens).toBe(33);

    const toolStart = events.find((e) => e.type === "tool:start");
    const toolEnd = events.find((e) => e.type === "tool:end");
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === "tool:end") {
      expect(toolEnd.isError).toBe(false);
    }

    // Second HTTP call should include the tool result fed back to the model.
    const secondBody = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
    const toolMsg = (secondBody.messages as { role: string; content: string }[]).find(
      (m) => m.role === "tool"
    );
    expect(toolMsg?.content).toBe("X=42");
  });
});
```

- [ ] **Step 3: Run the integration test — expect PASS**

Run: `npm test -- tests/integration/end-to-end.test.ts`
Expected: passes.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: all tests pass across all files.

- [ ] **Step 5: Run typecheck and build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: `dist/` emitted with `.js`, `.d.ts`, `.d.ts.map`, `.js.map` files.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/integration/
git commit -m "feat: top-level barrel exports and end-to-end integration test"
```

---

## Done-state checklist

After all 10 tasks:

- [ ] `npm test` passes (≥ 30 tests across 5 files).
- [ ] `npm run typecheck` passes with no errors.
- [ ] `npm run build` produces `dist/` with declarations.
- [ ] Every public type/class listed in the spec's "Top-level exports" section is exported from `src/index.ts`.
- [ ] Every file is reachable from its folder's `index.ts` barrel.
- [ ] CLAUDE.md contains the Commands section.
- [ ] Git history has one commit per task (10 commits), each green on its own.

## Deferred for v2 (explicitly not in scope)

- SSE token streaming + `message:delta` event variant.
- MCP transport (stdio / http) and `McpTool` adapter.
- Parallel tool-call dispatch within a single turn.
- Expanded `ToolDeps` (`signal`, `runId`, `emit`).
- Typed provider preferences (`provider` is `Record<string, unknown>` for now).
