/**
 * @file Module-level singleton holder for the project's OpenRouter client.
 *
 * Apps register one {@link OpenRouterClient} via {@link setOpenRouterClient}
 * at startup, and every {@link Agent} resolves that client via
 * {@link getOpenRouterClient} on demand. If no project client is registered,
 * agents lazily build one from `OPENROUTER_API_KEY` so trivial scripts work
 * without explicit setup.
 */

import { OpenRouterClient, type OpenRouterClientOptions } from "./client.js";

/**
 * The single, project-wide OpenRouter client. Set with
 * {@link setOpenRouterClient} at app startup; every {@link Agent} picks it
 * up automatically. If never set, agents build one lazily from
 * `OPENROUTER_API_KEY`.
 *
 * Held in module scope, so any consumer importing this module sees the
 * same instance. This intentionally couples the project to a single client
 * — multi-tenant servers should not use this helper.
 */
let projectClient: OpenRouterClient | undefined;

/**
 * Register the project's {@link OpenRouterClient}. Accepts either a
 * pre-built client or the same options object its constructor takes (one
 * is built for you, so callers don't need to import {@link OpenRouterClient}
 * directly).
 *
 * Calling this multiple times overwrites the previously registered client.
 * Existing {@link Agent} instances that have already cached a client are
 * unaffected — the new value is only picked up by future
 * {@link getOpenRouterClient} calls.
 *
 * @param clientOrOptions Either an {@link OpenRouterClient} (used as-is) or
 *   an {@link OpenRouterClientOptions} (used to construct a new client).
 * @returns The resulting client (the one passed in, or the one built).
 *
 * @example
 * ```ts
 * setOpenRouterClient({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   model: "anthropic/claude-haiku-4.5",
 *   title: "my-app",
 * });
 * ```
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

/**
 * Internal accessor: returns the client registered via
 * {@link setOpenRouterClient}, or `undefined` if none has been set.
 *
 * Consumers (typically the {@link Agent} constructor) fall back to building
 * a new client from environment variables when this returns `undefined`.
 *
 * @returns The configured client, or `undefined` if none is set.
 */
export function getOpenRouterClient(): OpenRouterClient | undefined {
  return projectClient;
}
