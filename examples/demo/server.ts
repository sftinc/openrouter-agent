import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Agent, Tool } from "../../src/index.js";
import type { AgentEvent } from "../../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "public");
const PORT = Number(process.env.PORT ?? 3000);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const calculator = new Tool({
  name: "calculator",
  description:
    "Evaluate a basic arithmetic expression. Supports + - * / ( ) and decimals. Use for any math the user asks.",
  inputSchema: z.object({
    expression: z.string().describe("The arithmetic expression, e.g. '2 + 2 * 3'"),
  }),
  execute: async ({ expression }) => {
    if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
      return { content: `Error: "${expression}" contains non-math characters`, isError: true };
    }
    try {
      const result = Function(`"use strict"; return (${expression});`)() as number;
      return String(result);
    } catch (e) {
      return { content: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
  display: {
    start: (args) => ({ title: `Calculating`, content: args.expression }),
    end: (args, output, meta) => ({
      title: meta.isError ? `Calculator failed` : `= ${output}`,
      content: args.expression,
    }),
  },
});

const currentTime = new Tool({
  name: "current_time",
  description:
    "Returns the current date and time. Optionally in a specific IANA timezone (e.g. 'America/New_York').",
  inputSchema: z.object({
    timezone: z
      .string()
      .optional()
      .describe("IANA timezone name; omit for UTC ISO timestamp"),
  }),
  execute: async ({ timezone }) => {
    const now = new Date();
    if (!timezone) return now.toISOString();
    try {
      return now.toLocaleString("en-US", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      });
    } catch {
      return { content: `Error: unknown timezone "${timezone}"`, isError: true };
    }
  },
  display: {
    start: (args) => ({
      title: args.timezone ? `Looking up time in ${args.timezone}` : `Getting current time`,
    }),
  },
});

const webSearch = new Tool({
  name: "web_search",
  description:
    "Search the web for current information. Use for recent facts, news, prices, or anything outside your training data.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  execute: async ({ query }, deps) => {
    const res = await deps.complete(
      [
        {
          role: "system",
          content:
            "You are a web research assistant. Use the web to find current, factual information and return a concise answer with the key facts and any source URLs.",
        },
        { role: "user", content: query },
      ],
      { llm: { plugins: [{ id: "web" }] } }
    );
    return res.content ?? "(no results)";
  },
  display: {
    start: (args) => ({ title: `Searching the web`, content: args.query }),
  },
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agent = new Agent({
  name: "demo-assistant",
  description: "A helpful assistant with a calculator, current time, and web search.",
  systemPrompt:
    "You are a concise, helpful assistant. Use the available tools when they would give you better or more current information than guessing. Prefer calling a tool over speculating. When you answer, be direct.",
  tools: [calculator, currentTime, webSearch],
  maxTurns: 8,
  referer: "http://localhost:" + PORT,
  title: "openrouter-agent demo",
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "POST" && url.pathname === "/api/chat") {
    await handleChat(req, res);
    return;
  }

  if (req.method === "GET") {
    await serveStatic(url.pathname, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method not allowed");
});

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body: { message?: string; sessionId?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }

  const message = (body.message ?? "").trim();
  const sessionId = body.sessionId?.trim();
  if (!message || !sessionId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message and sessionId are required" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const send = (event: AgentEvent) => {
    res.write(JSON.stringify(event) + "\n");
  };

  try {
    for await (const event of agent.runStream(message, { sessionId })) {
      send(event);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(JSON.stringify({ type: "error", runId: "server", error: { message } }) + "\n");
  } finally {
    res.end();
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`demo server ready: http://localhost:${PORT}`);
  if (!process.env.OPENROUTER_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn("warning: OPENROUTER_API_KEY is not set; chat calls will fail");
  }
});
