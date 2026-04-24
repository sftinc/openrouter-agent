export type {
  LLMConfig,
  OpenRouterTool,
  CompletionsRequest,
  CompletionsResponse,
  NonStreamingChoice,
  ErrorResponse,
} from "./types.js";
export { DEFAULT_MODEL } from "./types.js";
export { OpenRouterClient, OpenRouterError } from "./client.js";
export type { OpenRouterClientOptions } from "./client.js";
export { setOpenRouterClient, getOpenRouterClient } from "./default.js";
