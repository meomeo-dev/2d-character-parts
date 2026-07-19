// LLM chat + memory compression via the AI SDK.
//
// Uses generateText from `ai` with an openai-compatible chatModel; the provider
// is built from getLlm() and llmBaseURL(getLlm().base_url). Ports
// chat_routes.run_chat (system-prompt assembly, tool aggregation, gesture
// gating, tool loop) and chat_routes.run_memory_compression.
//
// The model is ALWAYS getLlm().model — config.api.model from the UI payload is
// intentionally ignored (matching the Python gateway, which resolves the model
// from providers, not the request).
//
// Security: the API key is read via getLlm() and only ever handed to the AI SDK
// provider (Authorization header). It is never logged or echoed.
import { readFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import { configPath } from "./paths.ts";
import { getLlm, llmBaseURL } from "./providers.ts";
import * as jina from "./jina.ts";

// Overridable AI SDK bindings, so tests can stub the network layer without
// touching a real key or endpoint. Production code goes through this object.
export const _deps = { generateText };

// ── Motion / face effect normalisation (port of companion_effects.py) ──

/** Facial expressions the 2D avatar can display; unknown values coerce to neutral. */
const FACE_EXPRESSIONS = ["happy", "relaxed", "surprised", "blink", "neutral"] as const;

/** Motion clip names suggested to the model (motion_play.name is a free string). */
const SUGGESTED_MOTIONS = [
  "idle",
  "wave",
  "nod",
  "think",
  "happy",
  "greet",
  "listen",
  "cheer",
  "shy",
  "sleepy",
] as const;

/** Coerce value to a float in [low, high], using fallback when unparseable. */
function clamp(value: unknown, low: number, high: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  const resolved = Number.isFinite(num) ? num : fallback;
  return Math.min(high, Math.max(low, resolved));
}

/** Return value if it is a known expression, else "neutral". */
function normalizeExpression(value: unknown): string {
  return FACE_EXPRESSIONS.includes(value as (typeof FACE_EXPRESSIONS)[number])
    ? (value as string)
    : "neutral";
}

/** A client-facing animation directive collected from a motion tool call. */
export interface Effect {
  type: string;
  [key: string]: unknown;
}

/** Normalise a raw motion tool call into a clamped, client-facing effect, or null. */
function toEffect(toolName: string, input: Record<string, unknown>): Effect | null {
  if (toolName === "motion_play") {
    return {
      type: "motion_play",
      name: String(input["name"] ?? "nod"),
      intensity: clamp(input["intensity"] ?? 0.7, 0.1, 1.0, 0.7),
      speed: clamp(input["speed"] ?? 1.0, 0.4, 2.0, 1.0),
      duration: clamp(input["duration"] ?? 1.2, 0.2, 4.0, 1.2),
      loop: Boolean(input["loop"] ?? false),
    };
  }
  if (toolName === "face_set") {
    return {
      type: "face_set",
      expression: normalizeExpression(input["expression"] ?? "happy"),
      weight: clamp(input["weight"] ?? 0.4, 0.0, 1.0, 0.4),
      duration: clamp(input["duration"] ?? 0.25, 0.05, 2.0, 0.25),
    };
  }
  if (toolName === "motion_stop") {
    return { type: "motion_stop", name: String(input["name"] ?? "idle") };
  }
  return null;
}

const MOTION_TOOL_NAMES = new Set(["motion_play", "face_set", "motion_stop"]);

// ── Tool set assembly ──

/** Motion / face gesture tools (gated behind the auto-gesture toggle). */
function motionTools(): ToolSet {
  return {
    motion_play: tool({
      description:
        "Play a body motion clip for the 2D avatar. 播放 2D 立绘的身体动作。name 为动画 clip 名(自由字符串)，" +
        `常用值: ${SUGGESTED_MOTIONS.join(", ")}。`,
      inputSchema: z.object({
        name: z.string().describe("Animation clip name, e.g. wave / nod / think / idle / happy."),
        intensity: z.number().optional().describe("0.1–1.0 motion strength."),
        speed: z.number().optional().describe("0.4–2.0 playback speed."),
        duration: z.number().optional().describe("0.2–4.0 seconds."),
        loop: z.boolean().optional().describe("Whether the clip loops."),
      }),
      execute: async () => ({ status: "ok" }),
    }),
    face_set: tool({
      description: "Set a facial expression for the 2D avatar. 设置 2D 立绘的表情。",
      inputSchema: z.object({
        expression: z
          .string()
          .describe(`One of: ${FACE_EXPRESSIONS.join(", ")} (unknown coerces to neutral).`),
        weight: z.number().optional().describe("0.0–1.0 expression blend weight."),
        duration: z.number().optional().describe("0.05–2.0 seconds transition."),
      }),
      execute: async () => ({ status: "ok" }),
    }),
    motion_stop: tool({
      description: "Stop an active motion by name and return to idle. 停止指定动作并回到待机。",
      inputSchema: z.object({
        name: z.string().describe("Clip name to stop."),
      }),
      execute: async () => ({ status: "ok" }),
    }),
  };
}

/** Jina-backed web tools (always available, independent of the gesture toggle). */
function webTools(): ToolSet {
  return {
    web_search: tool({
      description:
        "Search the web for up-to-date information. 联网搜索获取实时信息。" +
        "Returns the top matching results with title, url, and a content snippet.",
      inputSchema: z.object({
        query: z.string().describe("The search query / 搜索关键词"),
      }),
      execute: async ({ query }) => ({ results: (await jina.search(query)).slice(0, 5) }),
    }),
    web_read: tool({
      description:
        "Fetch a web page and extract its readable content as markdown. " +
        "抓取网页并提取正文为 markdown。Use when you have a specific URL to read.",
      inputSchema: z.object({
        url: z.string().describe("The absolute URL of the page to read / 要抓取的网页地址"),
      }),
      execute: async ({ url }) => ({ page: await jina.read(url) }),
    }),
  };
}

/**
 * Build the callable tool set. Motion tools are included only when auto-gesture
 * is enabled; web tools are always present. Mirrors run_chat's gating.
 */
export function buildTools(enableGesture: boolean): ToolSet {
  return enableGesture ? { ...motionTools(), ...webTools() } : { ...webTools() };
}

// ── Persona / prompt assembly (port of chat_routes) ──

interface Persona {
  system_prompt?: string;
  diary_prompt?: string;
}
interface Profile {
  persona?: Persona;
}

/** Load character_profile.json, returning an empty object if unreadable. */
function loadProfile(): Profile {
  try {
    return JSON.parse(readFileSync(configPath("character_profile.json"), "utf-8")) as Profile;
  } catch {
    return {};
  }
}

/** Return a trimmed persona override from payload.config.persona[key]. */
function configPersonaField(config: Record<string, unknown> | undefined, key: string): string {
  const persona = ((config?.["persona"] as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const value = persona[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Resolve the system prompt: UI override wins, else the profile default. */
function resolveSystemPrompt(profile: Profile, config?: Record<string, unknown>): string {
  const override = configPersonaField(config, "systemPrompt");
  return override || (profile.persona?.system_prompt ?? "").trim();
}

/** Resolve the diary/compression prompt: UI override wins, else the profile default. */
function resolveDiaryPrompt(profile: Profile, config?: Record<string, unknown>): string {
  const override = configPersonaField(config, "diaryPrompt");
  return override || (profile.persona?.diary_prompt ?? "").trim();
}

/** Serialise the long-term memory (recent diary + stable profile) for the prompt. */
function buildMemoryBlock(diary: unknown[], stableProfile: Record<string, unknown>): string {
  if (diary.length === 0 && Object.keys(stableProfile).length === 0) {
    return "暂无长期关系记忆。";
  }
  return JSON.stringify(
    { relationshipDiary: diary.slice(0, 3), stableProfile },
    null,
    2,
  );
}

/** Assemble the full system prompt from persona, tool guidance, memory, and scene. */
export function buildSystemPrompt(profile: Profile, opts: ChatOptions): string {
  const blocks: string[] = [
    resolveSystemPrompt(profile, opts.config),
    "你可以在合适的时候调用轻量动作工具(motion_play / face_set / motion_stop)，" +
      "让说话与表情更自然协调。优先使用简短、自然、短时的动作，不要无意义地频繁调用。" +
      `常用动作名包括: ${SUGGESTED_MOTIONS.join(", ")}。`,
  ];

  const retrieved = opts.retrievedMemories;
  if (retrieved !== undefined && retrieved !== null && !isEmpty(retrieved)) {
    blocks.push("以下是与当前话题相关的历史记忆检索结果，可作参考：");
    blocks.push(JSON.stringify(retrieved, null, 2));
  }

  blocks.push("长期关系记忆如下：");
  blocks.push(buildMemoryBlock(opts.relationshipDiary ?? [], opts.stableProfile ?? {}));
  blocks.push("当前场景信息如下：");
  blocks.push(JSON.stringify(opts.sceneContext ?? {}));

  return blocks.join("\n\n");
}

/** True when a retrieved-memories value is an empty array or empty object. */
function isEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** Build the message list: recent history + the current user turn (system is separate). */
export function buildChatMessages(opts: ChatOptions): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const message of opts.recentMessages ?? []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    messages.push({ role, content: message.content ?? "" });
  }

  let userMessage = (opts.userMessage ?? "").trim();
  if (opts.mode === "timer") {
    userMessage =
      userMessage ||
      "请你结合最近对话与关系记忆，自然地主动说一句简短、具体、带一点温度的话。" +
        "若适合，可以调用一个轻量动作工具。避免重复上一轮表达。";
  }
  if (userMessage) messages.push({ role: "user", content: userMessage });

  return messages;
}

// ── Public API ──

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
  effects: Effect[];
  usage: unknown;
}

/** Collect motion effects from the tool calls across all generation steps. */
function collectEffects(steps: unknown): Effect[] {
  const effects: Effect[] = [];
  if (!Array.isArray(steps)) return effects;
  for (const step of steps) {
    const toolCalls = (step as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      const { toolName, input } = call as { toolName?: unknown; input?: unknown };
      if (typeof toolName !== "string" || !MOTION_TOOL_NAMES.has(toolName)) continue;
      const effect = toEffect(toolName, (input ?? {}) as Record<string, unknown>);
      if (effect) effects.push(effect);
    }
  }
  return effects;
}

/** Run one chat turn (with tool loop) and return the assistant result. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const llm = getLlm();
  const provider = createOpenAICompatible({
    name: "llm",
    baseURL: llmBaseURL(llm.base_url),
    apiKey: llm.api_key,
  });
  const model = provider.chatModel(llm.model);

  const profile = loadProfile();
  const system = buildSystemPrompt(profile, opts);
  const messages = buildChatMessages(opts);

  const motionConfig = (opts.config?.["motion"] as Record<string, unknown>) ?? {};
  const enableGesture = motionConfig["enableAutoGesture"] !== false;
  const tools = buildTools(enableGesture);

  const result = await _deps.generateText({
    model,
    system,
    messages,
    tools,
    stopWhen: stepCountIs(8),
  });

  return {
    assistantMessage: (result.text ?? "").trim(),
    reasoningContent: result.reasoningText ?? "",
    effects: collectEffects(result.steps),
    usage: result.usage ?? {},
  };
}

// ── Memory compression ──

/** Options for relationship-diary compression — mirrors POST /api/memory/compress. */
export interface CompressMemoryOptions {
  recentMessages?: ChatMessage[];
  relationshipDiary?: unknown[];
  config?: Record<string, unknown>;
}

export interface CompressMemoryResult {
  summary: Record<string, unknown>;
  stableProfilePatch: unknown;
}

const DIARY_FIELDS =
  "summaryVersion,timeRange,episodeTitle,relationshipStage,emotionTone," +
  "trustDelta,userPreferencesConfirmed,newFacts,sharedMoments,unresolvedThreads," +
  "carePoints,boundaries,repairNeeded,nextOpeners,evidenceQuotes,confidence,stableProfilePatch";

/** A minimal well-formed summary when the model output is not valid JSON. */
function fallbackSummary(rawContent: string): Record<string, unknown> {
  return {
    summaryVersion: 1,
    timeRange: "recent",
    episodeTitle: "临时摘要",
    relationshipStage: "warming-up",
    emotionTone: "gentle",
    trustDelta: "stable",
    userPreferencesConfirmed: [],
    newFacts: [],
    sharedMoments: [],
    unresolvedThreads: [],
    carePoints: [],
    boundaries: [],
    repairNeeded: [],
    nextOpeners: [],
    evidenceQuotes: [],
    confidence: 0.3,
    stableProfilePatch: {},
    rawContent,
  };
}

/** Strip a leading/trailing ```json fence, if present, so JSON.parse can run. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(trimmed);
  return match?.[1] !== undefined ? match[1].trim() : trimmed;
}

/** Compress recent conversation into a structured relationship-diary summary. */
export async function compressMemory(
  opts: CompressMemoryOptions,
): Promise<CompressMemoryResult> {
  const llm = getLlm();
  const provider = createOpenAICompatible({
    name: "llm",
    baseURL: llmBaseURL(llm.base_url),
    apiKey: llm.api_key,
  });
  const model = provider.chatModel(llm.model);

  const profile = loadProfile();
  const diaryPrompt = resolveDiaryPrompt(profile, opts.config);
  const recentMessages = opts.recentMessages ?? [];
  const relationshipDiary = opts.relationshipDiary ?? [];

  const system = [
    "你负责把对话压缩成结构化的关系日记 JSON。",
    diaryPrompt,
    "你必须只输出 JSON 对象，不要输出 Markdown，不要输出解释。",
    `字段必须包含: ${DIARY_FIELDS}。`,
  ].join("\n");

  const userContent = JSON.stringify({
    recentMessages,
    existingDiary: relationshipDiary.slice(0, 3),
  });

  const result = await _deps.generateText({
    model,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  const rawContent = result.text ?? "{}";
  let summary: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stripCodeFence(rawContent));
    summary =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : fallbackSummary(rawContent);
  } catch {
    summary = fallbackSummary(rawContent);
  }

  const stableProfilePatch = summary["stableProfilePatch"] ?? {};
  delete summary["stableProfilePatch"];
  return { summary, stableProfilePatch };
}
