/**
 * Identifier generation utilities for the agent runtime.
 *
 * This module exposes a single helper, {@link generateId}, used to mint short
 * prefixed IDs for ephemeral runtime objects (agent runs, synthetic tool-use
 * IDs, etc.). The generator favours brevity and human-readability over
 * cryptographic strength.
 *
 * @module lib/ids
 */

/**
 * Generates a short pseudo-random identifier with the given prefix.
 *
 * The suffix is derived from {@link Math.random} converted to base36 and
 * truncated to 8 characters, yielding a final string of the form
 * `"{prefix}xxxxxxxx"`. Used for run IDs and tool-use IDs in the agent loop.
 *
 * Not cryptographically secure — `Math.random()` is not a CSPRNG and the 8
 * base36 characters give ~41 bits of entropy. Collisions are improbable but
 * possible in high-concurrency scenarios; substitute a real UUID
 * (e.g. `crypto.randomUUID()`) if collision-resistance matters for your use
 * case.
 *
 * @param prefix - String prepended to the random suffix. May be empty. The
 *   prefix is NOT validated or sanitized; callers typically pass short tags
 *   such as `"run_"` or `"tool_"` to make IDs self-describing in logs.
 * @returns The concatenation of `prefix` and an 8-character base36 suffix.
 *
 * @example
 * ```ts
 * generateId("run_");  // => "run_k3f2a9bz"
 * generateId("tool_"); // => "tool_p7q1m4xc"
 * ```
 */
export function generateId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}
