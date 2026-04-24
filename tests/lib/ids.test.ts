import { describe, test, expect } from "vitest";
import { generateId } from "../../src/lib/ids.js";

describe("generateId", () => {
  test("prefixes the generated id", () => {
    const id = generateId("run-");
    expect(id.startsWith("run-")).toBe(true);
    expect(id.length).toBe("run-".length + 8);
  });

  test("produces different ids across calls", () => {
    const a = generateId("tu-");
    const b = generateId("tu-");
    expect(a).not.toBe(b);
  });

  test("works with empty prefix", () => {
    const id = generateId("");
    expect(id.length).toBe(8);
  });
});
