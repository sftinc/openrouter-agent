/**
 * Generates a short pseudo-random identifier (8 chars from base36) with the
 * given prefix. Used for run IDs and tool-use IDs in the agent loop. Not
 * cryptographically secure — collisions are improbable but possible in
 * high-concurrency scenarios; use a real UUID if that matters.
 */
export function generateId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}
