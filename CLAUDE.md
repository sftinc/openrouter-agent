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

**Never push, release, or publish without being explicitly told to.** A user request to commit, refactor, fix, or implement is not a request to push. The release/publish task being part of an approved plan is not a standing authorization to chain through it. Pause and ask for explicit confirmation before each of: `npm run release`, `git push` (and `git push --follow-tags`), and `npm publish`. The user must specifically say push/release/publish (or equivalent) for that step. If the user authorizes one step, that does not extend to the others — confirm each.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`. The `type` drives how the change is grouped in the changelog and what kind of version bump it triggers:

- `feat` → **Added** (minor bump)
- `fix` → **Fixed** (patch bump)
- `perf`, `refactor`, `style`, `revert` → **Changed** (patch bump)
- `docs`, `chore`, `test`, `build`, `ci` → hidden from the changelog (no release-worthy impact on their own)

Breaking changes: add a `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` footer — this triggers a major bump.

## Releasing

Versioning and `CHANGELOG.md` are automated by [`commit-and-tag-version`](https://github.com/absolute-version/commit-and-tag-version). Do **not** hand-edit `package.json` version or `CHANGELOG.md` — they are generated from commit history.

To cut a release:

```bash
npm run release            # auto-detects bump from commits since last tag
npm run release:minor      # or force minor
npm run release:patch      # or force patch
git push --follow-tags     # push commits + the new version tag
```

The release command bumps `package.json`, prepends a new section to `CHANGELOG.md`, creates a `chore(release): X.Y.Z` commit, and tags it `vX.Y.Z`.

**Start every release from a clean working tree.** `.versionrc.json` sets `commitAll: true`, which means any unrelated staged or untracked changes get folded into the `chore(release): X.Y.Z` commit with a misleading message. Commit (or stash) unrelated work first.

## Publishing to npm

The package is published as `@sftinc/openrouter-agent` on npmjs.com. After a release is cut and pushed, ship the tarball:

```bash
npm publish --access public
```

`--access public` is required the first time a scoped package is published; after that the access flag is sticky and can be omitted. The `prepublishOnly` script runs `npm run build` automatically so `dist/` is always fresh in the published tarball.

If you want to verify what will ship before publishing, run `npm publish --dry-run`.

## "Push" always means release-then-push-then-publish

When the user asks to push, run the release flow — never a bare `git push`:

1. Check `git log <last-vX.Y.Z-tag>..HEAD` for commits since the last version tag.
2. If any of those commits are release-worthy types (`feat`, `fix`, `perf`, `refactor`, `style`, `revert`) → run `npm run release`, then `git push --follow-tags`, then `npm publish` (ask before publishing if uncertain).
3. If the only unreleased commits are hidden types (`docs`, `chore`, `test`, `build`, `ci`) or there are no new commits → just `git push` (no new version to cut, nothing to publish).
4. If the user explicitly says "push without releasing" (or equivalent), honor that and run a bare `git push`.
