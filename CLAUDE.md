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
- Prefer concrete types in prose over restating the TypeScript signature — explain _why_ and _when_, not just _what_.
- Document defaults in the JSDoc even when they are also expressed in code; callers reading hover docs should not need to open the source.
- Keep examples runnable and minimal. If an example needs setup, show it.

# Git Rules

When committing, ensure all changed and untracked files are staged and included in the commit.

**Never push or release without being explicitly told to.** A user request to commit, refactor, fix, or implement is not a request to push. The release task being part of an approved plan is not a standing authorization to chain through it. Pause and ask for explicit confirmation before each of: `npm run release` and `git push` (or `git push --follow-tags`). The user must specifically say push or release (or equivalent) for that step. If the user authorizes one step, that does not extend to the other — confirm each.

**Never run `npm publish` locally.** Publishing is handled automatically by `.github/workflows/publish.yml` when a `v*` tag is pushed. If you find yourself reaching for `npm publish` (or `npm publish --dry-run`), stop — the workflow is the only path to npm.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`. The `type` drives how the change is grouped in the changelog and what kind of version bump it triggers:

- `feat` → **Added** (minor bump)
- `fix` → **Fixed** (patch bump)
- `perf`, `refactor`, `style`, `revert` → **Changed** (patch bump)
- `docs`, `chore`, `test`, `build`, `ci` → hidden from the changelog (no release-worthy impact on their own)

Breaking changes: add a `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` footer — this triggers a major bump.

## Releasing and publishing

The package is `@sftinc/openrouter-agent` on npmjs.com. The release flow has only two local steps; npm publish is handled by GitHub Actions on tag push.

1. **`npm run release`** — `commit-and-tag-version` bumps `package.json` based on conventional-commit types since the last tag, prepends a new section to `CHANGELOG.md`, creates a `chore(release): X.Y.Z` commit, and tags it `vX.Y.Z`. Use `npm run release:minor` / `release:patch` to force a bump. Do **not** hand-edit `package.json` version or `CHANGELOG.md`.
2. **`git push --follow-tags`** — pushes the release commit and the new tag. The `.github/workflows/publish.yml` workflow then runs `npm ci`, `npm run typecheck`, `npm test`, and `npm publish --provenance --access public` automatically.

**Start every release from a clean working tree.** `.versionrc.json` sets `commitAll: true`, so any unrelated staged or untracked changes get folded into the `chore(release): X.Y.Z` commit with a misleading message. Commit (or stash) unrelated work first.

## "Push" always means release-then-push (when there are release-worthy commits)

When the user asks to push:

1. Check `git log <last-vX.Y.Z-tag>..HEAD` for commits since the last version tag.
2. If any commits are release-worthy types (`feat`, `fix`, `perf`, `refactor`, `style`, `revert`) → ask before each of: `npm run release`, then `git push --follow-tags`. The workflow publishes from the tag.
3. If the only unreleased commits are hidden types (`docs`, `chore`, `test`, `build`, `ci`) or there are no new commits → just `git push` (nothing to release).
4. If the user explicitly says "push without releasing" (or equivalent), honor that and run a bare `git push`.
