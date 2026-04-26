# API Reference

Complete, exhaustive reference for every public export of `@sftinc/openrouter-agent`. Each page documents one source folder: every exported value, type, parameter, field, default, and error.

The package's single entrypoint is the package root — every public symbol is re-exported there:

```ts
import { /* … */ } from "@sftinc/openrouter-agent";
```

Do not import from internal subpaths (`@sftinc/openrouter-agent/src/...`); they are not part of the supported API surface.

## Pages

| Page | Folder | Surface |
| --- | --- | --- |
| [Agent Layer](./agent.md) | `src/agent/` | `Agent`, `AgentConfig`, `AgentRunOptions`, `AgentRun`, every `AgentEvent` variant, `AgentDisplayHooks`, `EventDisplay`, `EventEmit`, loop semantics |
| [Tool Layer](./tool.md) | `src/tool/` | `Tool`, `ToolConfig`, `ToolDeps`, `ToolResult`, `ToolDisplayHooks`, result coercion, Zod → JSON Schema conversion |
| [OpenRouter Client](./openrouter.md) | `src/openrouter/` | `OpenRouterClient`, `setOpenRouterClient`, `OpenRouterError`, `DEFAULT_MODEL`, `LLMConfig`, `OpenRouterClientOptions`, `OpenRouterTool`, `CompletionsRequest`, `CompletionsResponse` |
| [Session Layer](./session.md) | `src/session/` | `SessionStore` interface, `InMemorySessionStore`, `SessionBusyError`, contract for custom (Redis / Postgres) implementations |
| [Conversation Types](./types.md) | `src/types/` | `Message`, `ContentPart`, `ToolCall`, `Usage`, `Result`, all `stopReason` values |
| [Event Helpers](./helpers.md) | `src/helpers/` | `defaultDisplay`, `displayOf`, `consumeAgentEvents`, `streamText`, NDJSON codec (`serializeEvent`, `serializeEventsAsNDJSON`, `readEventStream`), HTTP adapters (`pipeEventsToNodeResponse`, `eventsToWebResponse`), high-level handlers (`handleAgentRun`, `handleAgentRunWebResponse`) |

## Reading order

If you are new to the package, read in this order:

1. [OpenRouter Client](./openrouter.md) — how the project-wide LLM client is configured.
2. [Tool Layer](./tool.md) — how to define a callable tool.
3. [Agent Layer](./agent.md) — the run loop, the primary entry point.
4. [Conversation Types](./types.md) — wire shapes and the `Result` returned from a run.
5. [Session Layer](./session.md) — pluggable conversation persistence.
6. [Event Helpers](./helpers.md) — display fallbacks, NDJSON streaming, and HTTP server integration.

## Conventions

- Every page lists symbols in the order they appear in the corresponding source folder.
- Tables use the columns: **name**, **type**, **required**, **default**, **description**.
- Citations use `path/to/file.ts:line` and refer to the repository at the version the docs were generated against.
- Examples are minimal but runnable; imports always come from `@sftinc/openrouter-agent`.
- Symbols not re-exported from the package root are flagged as folder-internal and may change without a major-version bump.

## See also

- [Root README](../../README.md) — install, quickstart, architecture overview, environment variables.
- [`docs/openrouter/`](../openrouter/) — upstream OpenRouter API reference (treated as the source of truth for wire shapes).
- [`examples/`](../../examples/) — runnable scripts (`websearch.ts`) and a streaming HTTP demo (`demo/`).
