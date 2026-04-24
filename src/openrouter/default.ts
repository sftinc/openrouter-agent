import { OpenRouterClient, type OpenRouterClientOptions } from "./client.js";

/**
 * Module-level default OpenRouter client. When set, any `Agent` constructed
 * without an explicit `client` will use this one. Set it once at app startup.
 */
let defaultClient: OpenRouterClient | undefined;

/**
 * Set the project-wide default OpenRouter client. Accepts either a pre-built
 * `OpenRouterClient` or the same options object the client's constructor
 * takes — when options are passed, a client is built internally so callers
 * don't need to import `OpenRouterClient` themselves. Returns the resulting
 * client for callers that want a reference to it.
 */
export function setDefaultOpenRouterClient(
  clientOrOptions: OpenRouterClient | OpenRouterClientOptions
): OpenRouterClient {
  const client =
    clientOrOptions instanceof OpenRouterClient
      ? clientOrOptions
      : new OpenRouterClient(clientOrOptions);
  defaultClient = client;
  return client;
}

export function getDefaultOpenRouterClient(): OpenRouterClient | undefined {
  return defaultClient;
}

export function clearDefaultOpenRouterClient(): void {
  defaultClient = undefined;
}
