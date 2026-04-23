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
