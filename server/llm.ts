// LLM chat + memory compression via the AI SDK.
//
// STUB: implemented by a later track. Uses generateText from `ai` with an
// openai-compatible chatModel; the provider is built from getLlm() and
// llmBaseURL(getLlm().base_url). Ports llm_gateway.run_tool_loop (chat) and
// chat_routes.run_memory_compression (compressMemory).

export interface ChatMessage {
  role: string;
  content: string;
}

/** Options for one companion chat turn — mirrors the POST /api/chat payload. */
export interface ChatOptions {
  userMessage?: string;
  recentMessages?: ChatMessage[];
  relationshipDiary?: unknown[];
  stableProfile?: Record<string, unknown>;
  retrievedMemories?: unknown;
  sceneContext?: Record<string, unknown>;
  mode?: string;
  config?: Record<string, unknown>;
}

export interface ChatResult {
  assistantMessage: string;
  reasoningContent: string;
  effects: unknown[];
  usage: unknown;
}

/** Run one chat turn (with tool loop) and return the assistant result. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  void opts;
  throw new Error("not implemented: llm/chat track (llm_gateway + chat_routes port)");
}

/** Options for relationship-diary compression — mirrors POST /api/memory/compress. */
export interface CompressMemoryOptions {
  recentMessages?: ChatMessage[];
  relationshipDiary?: unknown[];
  config?: Record<string, unknown>;
}

export interface CompressMemoryResult {
  summary: unknown;
  stableProfilePatch: unknown;
}

/** Compress recent conversation into a structured relationship-diary summary. */
export async function compressMemory(opts: CompressMemoryOptions): Promise<CompressMemoryResult> {
  void opts;
  throw new Error("not implemented: llm/chat track (memory compression port)");
}
