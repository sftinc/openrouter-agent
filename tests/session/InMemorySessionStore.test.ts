import { describe, test, expect } from "vitest";
import { InMemorySessionStore } from "../../src/session/InMemorySessionStore.js";
import type { Message } from "../../src/types/index.js";

const msgs: Message[] = [
  { role: "system", content: "be helpful" },
  { role: "user", content: "hi" },
];

describe("InMemorySessionStore", () => {
  test("get returns null for unknown session", async () => {
    const store = new InMemorySessionStore();
    expect(await store.get("nope")).toBeNull();
  });

  test("set then get returns the stored messages", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", msgs);
    expect(await store.get("s1")).toEqual(msgs);
  });

  test("set clones the array so later mutations don't affect storage", async () => {
    const store = new InMemorySessionStore();
    const mutable: Message[] = [{ role: "user", content: "hi" }];
    await store.set("s1", mutable);
    mutable.push({ role: "user", content: "should not leak" });
    const stored = await store.get("s1");
    expect(stored).toHaveLength(1);
  });

  test("delete removes the session", async () => {
    const store = new InMemorySessionStore();
    await store.set("s1", msgs);
    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });
});
