import { describe, test, expect } from "vitest";
import { z } from "zod";
import { Tool } from "../../src/tool/Tool.js";
import type { ToolDeps } from "../../src/tool/types.js";

const noopDeps: ToolDeps = {
  complete: async () => ({ content: null, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }),
};

describe("Tool", () => {
  test("stores name, description, and schema", () => {
    const tool = new Tool({
      name: "echo",
      description: "Echoes the input",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => args.text,
    });
    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echoes the input");
  });

  test("execute returns string or ToolResult from handler", async () => {
    const tool = new Tool({
      name: "echo",
      description: "",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => args.text,
    });
    const out = await tool.execute({ text: "hi" }, noopDeps);
    expect(out).toBe("hi");
  });

  test("toOpenRouterTool emits function tool with JSON schema parameters", () => {
    const tool = new Tool({
      name: "get_weather",
      description: "Returns current weather",
      inputSchema: z.object({
        city: z.string().describe("City name"),
        units: z.enum(["celsius", "fahrenheit"]).default("celsius"),
      }),
      execute: async () => "sunny",
    });
    const wire = tool.toOpenRouterTool();
    expect(wire.type).toBe("function");
    expect(wire.function.name).toBe("get_weather");
    expect(wire.function.description).toBe("Returns current weather");
    expect(typeof wire.function.parameters).toBe("object");
    const params = wire.function.parameters as { properties: Record<string, unknown> };
    expect(params.properties).toHaveProperty("city");
    expect(params.properties).toHaveProperty("units");
  });

  test("display hooks are stored and callable", () => {
    const tool = new Tool({
      name: "echo",
      description: "",
      inputSchema: z.object({ text: z.string() }),
      execute: async (args) => args.text,
      display: {
        start: (args) => ({ title: `Echoing ${args.text}` }),
        end: (args, output) => ({ title: `Echoed`, content: output }),
      },
    });
    expect(tool.display?.start?.({ text: "hi" })).toEqual({ title: "Echoing hi" });
    expect(tool.display?.end?.({ text: "hi" }, "hi", { isError: false })).toEqual({
      title: "Echoed",
      content: "hi",
    });
  });
});
