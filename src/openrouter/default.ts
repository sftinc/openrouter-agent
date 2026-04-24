import { OpenRouterClient, type OpenRouterClientOptions } from "./client.js";

/**
 * The single, project-wide OpenRouter client. Set with `setOpenRouterClient()`
 * at app startup; every `Agent` picks it up automatically. If never set,
 * agents build one lazily from `OPENROUTER_API_KEY`.
 */
let projectClient: OpenRouterClient | undefined;

/**
 * Register the project's OpenRouter client. Accepts either a pre-built
 * `OpenRouterClient` or the same options object its constructor takes (one
 * is built for you, so callers don't need to import `OpenRouterClient`).
 * Returns the resulting client.
 */
export function setOpenRouterClient(
  clientOrOptions: OpenRouterClient | OpenRouterClientOptions
): OpenRouterClient {
  projectClient =
    clientOrOptions instanceof OpenRouterClient
      ? clientOrOptions
      : new OpenRouterClient(clientOrOptions);
  return projectClient;
}

/** Internal: returns the configured client, or undefined if none is set. */
export function getOpenRouterClient(): OpenRouterClient | undefined {
  return projectClient;
}
