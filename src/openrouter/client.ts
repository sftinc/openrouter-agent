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
    const envKey =
      typeof process !== "undefined" ? process.env?.OPENROUTER_API_KEY : undefined;
    const apiKey = options.apiKey ?? envKey;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Pass apiKey to the OpenRouterClient or set the env var."
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
      if (process.env.OPENROUTER_DEBUG) {
        // eslint-disable-next-line no-console
        console.log("[openrouter] error response:", response.status, JSON.stringify(body));
      }
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

    const json = (await response.json()) as CompletionsResponse;
    if (process.env.OPENROUTER_DEBUG) {
      const hasToolCalls = (json.choices ?? []).some(
        (c) => Array.isArray(c.message?.tool_calls) && c.message.tool_calls.length > 0
      );
      const body = JSON.stringify(json, (key, value) => {
        if (key === "reasoning" || key === "reasoning_details") return undefined;
        return value;
      });
      // eslint-disable-next-line no-console
      console.log("[openrouter] response:", hasToolCalls ? `\x1b[33m${body}\x1b[0m` : body);
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
