import { describe, test, expect } from "vitest";
import { InMemorySessionStore } from "../../src/session/InMemorySessionStore.js";
import type { Message } from "../../src/types/index.js";

const msgs: Message[] = [
  { role: "system", content: "be helpful" },
  { role: "user", content: "hi" },
];

/** Deterministic clock for tests. Returns a `now()` function and an
 *  `advance(ms)` mutator. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("InMemorySessionStore", () => {
  test("get returns null for unknown session", async () => {
    const store = new InMemorySessionStore();
    expect(await store.get("nope")).toBeNull();
  });

  test("set then get returns a SessionRecord with messages and timestamps", async () => {
    const clock = fakeClock(1_000);
    const store = new InMemorySessionStore({ now: clock.now });
    await store.set("s1", msgs);

    const record = await store.get("s1");
    expect(record).not.toBeNull();
    expect(record!.messages).toEqual(msgs);
    expect(record!.createdAt).toBe(new Date(1_000).toISOString());
    expect(record!.updatedAt).toBe(new Date(1_000).toISOString());
  });

  test("first write stamps createdAt === updatedAt; subsequent write preserves createdAt and advances updatedAt", async () => {
    const clock = fakeClock(1_000);
    const store = new InMemorySessionStore({ now: clock.now });

    await store.set("s1", [{ role: "user", content: "a" }]);
    clock.advance(2_000);
    await store.set("s1", [{ role: "user", content: "b" }]);

    const record = await store.get("s1");
    expect(record!.createdAt).toBe(new Date(1_000).toISOString());
    expect(record!.updatedAt).toBe(new Date(3_000).toISOString());
  });

  test("set clones the array so later mutations don't affect storage", async () => {
    const store = new InMemorySessionStore();
    const mutable: Message[] = [{ role: "user", content: "hi" }];
    await store.set("s1", mutable);
    mutable.push({ role: "user", content: "should not leak" });
    const record = await store.get("s1");
    expect(record!.messages).toHaveLength(1);
  });

  test("get clones messages so caller mutations don't affect storage", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", [{ role: "user", content: "hi" }]);
    const first = await store.get("s1");
    first!.messages.push({ role: "user", content: "leak" });
    const second = await store.get("s1");
    expect(second!.messages).toHaveLength(1);
  });

  test("delete removes the session", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", msgs);
    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });

  test("delete is idempotent on an unknown session", async () => {
    const store = new InMemorySessionStore();
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });

  describe("TTL", () => {
    test("no TTL configured → no eviction even after a long delay", async () => {
      const clock = fakeClock(0);
      const store = new InMemorySessionStore({ now: clock.now });
      await store.set("s1", msgs);
      clock.advance(365 * 24 * 60 * 60 * 1_000); // one year
      const record = await store.get("s1");
      expect(record).not.toBeNull();
    });

    test("TTL not yet elapsed → returns the record", async () => {
      const clock = fakeClock(0);
      const store = new InMemorySessionStore({ ttlMs: 1_000, now: clock.now });
      await store.set("s1", msgs);
      clock.advance(999);
      const record = await store.get("s1");
      expect(record).not.toBeNull();
    });

    test("TTL elapsed at the boundary (>= semantics) → returns null and deletes the entry", async () => {
      const clock = fakeClock(0);
      const store = new InMemorySessionStore({ ttlMs: 1_000, now: clock.now });
      await store.set("s1", msgs);

      clock.advance(1_000);
      expect(await store.get("s1")).toBeNull();

      // Confirm the entry was actually deleted, not just hidden — even a
      // second call (still at the same instant) returns null.
      expect(await store.get("s1")).toBeNull();
    });

    test("TTL is idle, not absolute — set refreshes the window", async () => {
      const clock = fakeClock(0);
      const store = new InMemorySessionStore({ ttlMs: 1_000, now: clock.now });
      await store.set("s1", [{ role: "user", content: "a" }]);
      clock.advance(500);
      await store.set("s1", [{ role: "user", content: "b" }]); // refresh

      clock.advance(900); // 1400ms since first write, 900ms since refresh
      expect(await store.get("s1")).not.toBeNull();

      clock.advance(100); // total 1000ms since refresh — boundary
      expect(await store.get("s1")).toBeNull();
    });

    test("set after get-triggered eviction creates a fresh session", async () => {
      const clock = fakeClock(0);
      const store = new InMemorySessionStore({ ttlMs: 1_000, now: clock.now });
      await store.set("s1", [{ role: "user", content: "a" }]);
      clock.advance(1_500);
      expect(await store.get("s1")).toBeNull(); // evicts

      clock.advance(500);
      await store.set("s1", [{ role: "user", content: "b" }]);
      const record = await store.get("s1");
      expect(record!.createdAt).toBe(new Date(2_000).toISOString());
      expect(record!.updatedAt).toBe(new Date(2_000).toISOString());
    });

    test("set on an expired-but-not-yet-evicted entry refreshes it (preserves createdAt)", async () => {
      const clock = fakeClock(0);
      const store = new InMemorySessionStore({ ttlMs: 1_000, now: clock.now });
      await store.set("s1", [{ role: "user", content: "a" }]);
      clock.advance(2_000); // entry is now technically expired, but no get has run

      await store.set("s1", [{ role: "user", content: "b" }]); // refresh, no get between

      const record = await store.get("s1");
      expect(record).not.toBeNull();
      expect(record!.createdAt).toBe(new Date(0).toISOString()); // preserved
      expect(record!.updatedAt).toBe(new Date(2_000).toISOString());
    });

    test("ttlMs: 0 evicts on the next get even at the same instant", async () => {
      const clock = fakeClock(1_000);
      const store = new InMemorySessionStore({ ttlMs: 0, now: clock.now });
      await store.set("s1", msgs); // updatedAt = 1000, now() = 1000, age = 0 >= 0 → evict on next get
      expect(await store.get("s1")).toBeNull();
    });

    test("constructor rejects ttlMs: -1", () => {
      expect(() => new InMemorySessionStore({ ttlMs: -1 })).toThrow(RangeError);
    });

    test("constructor rejects ttlMs: NaN", () => {
      expect(() => new InMemorySessionStore({ ttlMs: NaN })).toThrow(RangeError);
    });

    test("constructor accepts ttlMs: 0", () => {
      expect(() => new InMemorySessionStore({ ttlMs: 0 })).not.toThrow();
    });
  });

  test("injected now() is used to stamp createdAt", async () => {
    const fixed = new Date("2026-04-26T12:00:00.000Z");
    const store = new InMemorySessionStore({ now: () => fixed });
    await store.set("s1", msgs);
    const record = await store.get("s1");
    expect(record!.createdAt).toBe(fixed.toISOString());
    expect(record!.updatedAt).toBe(fixed.toISOString());
  });
});
