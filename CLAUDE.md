# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Node.js + TypeScript. An agent wrapper around OpenRouter. API reference lives in `docs/openrouter/` — treat it as the source of truth when writing integration code.

## Commands

- `npm install` — install dependencies
- `npm run typecheck` — run TypeScript in no-emit mode
- `npm test` — run the Vitest suite once
- `npm run test:watch` — watch mode
- `npm run build` — emit `dist/`

Run a single test file: `npm test -- tests/agent/loop.test.ts`
Run a single test by name: `npm test -- -t "handles tool errors"`

## Code organization

- Organize code into subfolders by concern (e.g. `src/client/`, `src/agent/`, `src/tools/`).
- One primary export per file; name the file after what it exports (`FooClient.ts` exports `FooClient`).
- Each subfolder has an `index.ts` that re-exports its public surface. Consumers import from the folder, not from individual files — e.g. `import { FooClient } from "./client"`, not `from "./client/FooClient"`.
- Before adding a new class or function, check whether an existing one in the relevant subfolder can be reused or extended. Lift shared logic into a library folder rather than duplicating.

## JSDoc documentation

All exported classes, functions, types, and public methods must carry JSDoc. Documentation is part of the API — keep it accurate and complete, and update it whenever signatures or behavior change.

Every JSDoc block must include:

- **Summary** — one-line description of what it does, followed by a longer paragraph if behavior is non-obvious.
- **Usage** — a `@example` block showing a realistic call, including imports from the folder index (e.g. `import { FooClient } from "./client"`).
- **Parameters** — `@param` for every parameter. State the type, whether it is **required** or **optional**, the **default** if any, accepted values/ranges, and what the parameter controls. For object parameters, document each field with `@param options.field`.
- **Return value** — `@returns` describing the shape and meaning of the result, including async resolution type and any streaming/iterator semantics.
- **Errors** — `@throws` for each error type that callers must handle, with the condition that triggers it.
- **Side effects** — note any I/O, mutation, event emission, or state changes that aren't obvious from the signature.
- **Related** — `@see` links to closely related exports when it helps the reader navigate.

Additional rules:

- Mark deprecated APIs with `@deprecated` and point to the replacement.
- Mark unstable APIs with `@experimental` (or a clearly worded note) so consumers know the contract may change.
- Prefer concrete types in prose over restating the TypeScript signature — explain *why* and *when*, not just *what*.
- Document defaults in the JSDoc even when they are also expressed in code; callers reading hover docs should not need to open the source.
- Keep examples runnable and minimal. If an example needs setup, show it.
