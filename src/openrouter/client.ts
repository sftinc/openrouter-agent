import type {
  CompletionsRequest,
  CompletionsResponse,
  LLMConfig,
} from "./types.js";
import { DEFAULT_MODEL } from "./types.js";

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

/**
 * Options for the OpenRouter client. Project-wide LLM defaults (model,
 * max_tokens, temperature, etc.) live here via `LLMConfig` — everything on
 * `LLMConfig` is part of the chat-completions request body. `apiKey`,
 * `referer`, and `title` are transport-level fields sent as headers.
 */
export interface OpenRouterClientOptions extends LLMConfig {
  apiKey?: string;
  title?: string;
  referer?: string;
}

const BASE_URL = "https://openrouter.ai/api/v1";

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly referer?: string;
  private readonly title?: string;
  private readonly defaults: LLMConfig;

  constructor(options: OpenRouterClientOptions) {
    const { apiKey, title, referer, ...llmDefaults } = options;
    const envKey =
      typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY : undefined;
    const key = apiKey ?? envKey;
    if (!key) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Pass apiKey to the OpenRouterClient or set the env var."
      );
    }
    this.apiKey = key;
    this.title = title;
    this.referer = referer;
    this.defaults = llmDefaults;
  }

  /**
   * Shallow-merged LLMConfig defaults configured on this client. Useful for
   * callers (like the agent loop) that want to read what the client will send
   * for fields the caller has not overridden.
   */
  get llmDefaults(): LLMConfig {
    return { ...this.defaults };
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

    // Precedence: DEFAULT_MODEL fallback < client.defaults < per-request fields.
    const body = {
      model: DEFAULT_MODEL,
      ...this.defaults,
      ...request,
      stream: false as const,
    };

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errBody = await this.safeParseJson(response);
      if (process.env.OPENROUTER_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[openrouter] error response:", response.status, JSON.stringify(errBody));
      }
      const message =
        (errBody as { error?: { message?: string } } | undefined)?.error
          ?.message ?? `HTTP ${response.status}`;
      const metadata = (errBody as { error?: { metadata?: Record<string, unknown> } } | undefined)
        ?.error?.metadata;
      throw new OpenRouterError({
        code: response.status,
        message,
        body: errBody,
        metadata,
      });
    }

    const json = (await response.json()) as CompletionsResponse;
    if (process.env.OPENROUTER_DEBUG) {
      const hasToolCalls = (json.choices ?? []).some(
        (c) => Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length > 0
      );
      const debugBody = JSON.stringify(json, (key, value) => {
        if (key === "reasoning" || key === "reasoning_details") return undefined;
        return value;
      });
      // eslint-disable-next-line no-console
      console.log("[openrouter] response:", hasToolCalls ? `\x1b[33m${debugBody}\x1b[0m` : debugBody);
    }
    return json;
  }

  private async safeParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}
