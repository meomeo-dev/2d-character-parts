// Tests for server/llm.ts — tool aggregation, gesture gating, effect collection,
// and memory-compression parsing. The AI SDK generateText call is stubbed via
// _deps so no real network / API key is touched.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  _deps,
  buildTools,
  buildSystemPrompt,
  buildChatMessages,
  chat,
  compressMemory,
  visualQa,
} from "./llm.ts";
import type { generateText } from "ai";

type GenText = typeof generateText;

/** Install a stub generateText that records the options and returns `result`. */
function stubGenerateText(result: unknown): { calls: unknown[] } {
  const calls: unknown[] = [];
  _deps.generateText = (async (opts: unknown) => {
    calls.push(opts);
    return result;
  }) as unknown as GenText;
  return { calls };
}

test("buildTools gates motion tools behind the gesture flag; web tools always present", () => {
  const withGesture = Object.keys(buildTools(true)).sort();
  assert.deepEqual(withGesture, [
    "face_set",
    "motion_play",
    "motion_stop",
    "web_read",
    "web_search",
  ]);

  const withoutGesture = Object.keys(buildTools(false)).sort();
  assert.deepEqual(withoutGesture, ["web_read", "web_search"]);
});

test("buildSystemPrompt includes persona, memory block, and retrieved memories", () => {
  const prompt = buildSystemPrompt(
    { persona: { system_prompt: "PERSONA_TEXT" } },
    {
      relationshipDiary: [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }],
      stableProfile: { likes: "tea" },
      retrievedMemories: [{ hit: "memo" }],
      sceneContext: { time: "night" },
    },
  );
  assert.match(prompt, /PERSONA_TEXT/);
  assert.match(prompt, /历史记忆检索结果/);
  assert.match(prompt, /长期关系记忆如下/);
  assert.match(prompt, /当前场景信息如下/);
  // diary is capped at 3 entries — the 4th must not leak in.
  assert.ok(prompt.includes('"likes": "tea"'));
  assert.ok(!prompt.includes('"d": 4'));
});

test("buildSystemPrompt uses UI persona override when provided", () => {
  const prompt = buildSystemPrompt(
    { persona: { system_prompt: "PROFILE_DEFAULT" } },
    { config: { persona: { systemPrompt: "UI_OVERRIDE" } } },
  );
  assert.match(prompt, /UI_OVERRIDE/);
  assert.ok(!prompt.includes("PROFILE_DEFAULT"));
});

test("buildSystemPrompt shows the empty-memory sentinel when nothing is stored", () => {
  const prompt = buildSystemPrompt({ persona: { system_prompt: "P" } }, {});
  assert.match(prompt, /暂无长期关系记忆。/);
});

test("buildChatMessages injects a proactive prompt in timer mode", () => {
  const timer = buildChatMessages({ mode: "timer" });
  assert.equal(timer.length, 1);
  assert.equal(timer[0]?.role, "user");
  assert.match(String(timer[0]?.content), /主动说一句/);

  const normal = buildChatMessages({
    recentMessages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "weird", content: "coerced" },
    ],
    userMessage: "  how are you  ",
  });
  assert.deepEqual(
    normal.map((m) => m.role),
    ["user", "assistant", "user", "user"],
  );
  assert.equal(normal.at(-1)?.content, "how are you");
});

test("chat collects normalized motion effects from tool-call steps", async () => {
  stubGenerateText({
    text: "  hi there  ",
    reasoningText: "because",
    usage: { totalTokens: 42 },
    steps: [
      {
        toolCalls: [
          { toolName: "motion_play", input: { name: "wave", intensity: 5, speed: 1.2 } },
          { toolName: "web_search", input: { query: "x" } },
        ],
      },
      {
        toolCalls: [
          { toolName: "face_set", input: { expression: "bogus", weight: 2 } },
          { toolName: "motion_stop", input: {} },
        ],
      },
    ],
  });

  const result = await chat({ userMessage: "hey" });
  assert.equal(result.assistantMessage, "hi there");
  assert.equal(result.reasoningContent, "because");
  assert.deepEqual(result.usage, { totalTokens: 42 });

  assert.deepEqual(result.effects, [
    { type: "motion_play", name: "wave", intensity: 1.0, speed: 1.2, duration: 1.2, loop: false },
    { type: "face_set", expression: "neutral", weight: 1.0, duration: 0.25 },
    { type: "motion_stop", name: "idle" },
  ]);
});

test("chat passes only web tools to generateText when gesture is disabled", async () => {
  const { calls } = stubGenerateText({ text: "ok", steps: [] });
  await chat({ userMessage: "hi", config: { motion: { enableAutoGesture: false } } });
  const opts = calls[0] as { tools: Record<string, unknown> };
  assert.deepEqual(Object.keys(opts.tools).sort(), ["web_read", "web_search"]);
});

test("compressMemory parses JSON and splits out stableProfilePatch", async () => {
  stubGenerateText({
    text: JSON.stringify({
      episodeTitle: "第一次聊天",
      confidence: 0.8,
      stableProfilePatch: { name: "小明" },
    }),
  });
  const { summary, stableProfilePatch } = await compressMemory({});
  assert.equal((summary as { episodeTitle: string }).episodeTitle, "第一次聊天");
  assert.ok(!("stableProfilePatch" in summary));
  assert.deepEqual(stableProfilePatch, { name: "小明" });
});

test("compressMemory strips a ```json code fence before parsing", async () => {
  stubGenerateText({ text: '```json\n{"episodeTitle":"fenced"}\n```' });
  const { summary } = await compressMemory({});
  assert.equal((summary as { episodeTitle: string }).episodeTitle, "fenced");
});

test("compressMemory falls back to a well-formed summary on invalid JSON", async () => {
  stubGenerateText({ text: "not json at all" });
  const { summary, stableProfilePatch } = await compressMemory({});
  assert.equal((summary as { episodeTitle: string }).episodeTitle, "临时摘要");
  assert.equal((summary as { rawContent: string }).rawContent, "not json at all");
  assert.deepEqual(stableProfilePatch, {});
});

// ── visualQa (multimodal pet QA) ──
// getLlm is injected via _deps so we control the resolved api_key directly.
// Toggling env alone is not enough: config/runtime_settings.json's file layer
// overrides env (providers.ts "file > env > defaults"), so on a machine with a
// key in that file the "no api_key" path would never be exercised.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const realGetLlm = _deps.getLlm;

/** Force getLlm() to resolve to the given api_key (base_url/model kept stable). */
function stubLlm(api_key: string): void {
  _deps.getLlm = () => ({ ...realGetLlm(), api_key });
}

test("visualQa skips (no throw) when no api_key is configured", async () => {
  stubLlm("");
  try {
    const res = await visualQa({ image: PNG });
    assert.equal(res.visual_qa, "skipped");
    assert.match(String(res.reason), /api_key/);
  } finally {
    _deps.getLlm = realGetLlm;
  }
});

test("visualQa returns a structured pass verdict and sends an image part", async () => {
  stubLlm("test-key");
  const { calls } = stubGenerateText({
    text: JSON.stringify({ visual_qa: "pass", notes: "consistent", repair_rows: [] }),
  });
  try {
    const res = await visualQa({ image: PNG, context: "row 0: idle (6 frames)" });
    assert.equal(res.visual_qa, "pass");
    assert.equal(res.notes, "consistent");
    assert.deepEqual(res.repair_rows, []);

    // The user turn carries a text part + an image part with the raw buffer.
    const opts = calls[0] as { messages: Array<{ role: string; content: unknown }> };
    const content = opts.messages[0]!.content as Array<Record<string, unknown>>;
    assert.equal(content[0]!["type"], "text");
    assert.equal(content[1]!["type"], "image");
    assert.equal(content[1]!["mediaType"], "image/png");
    assert.ok(Buffer.isBuffer(content[1]!["image"]));
  } finally {
    _deps.getLlm = realGetLlm;
  }
});

test("visualQa surfaces a fail verdict with repair_rows", async () => {
  stubLlm("test-key");
  stubGenerateText({ text: '```json\n{"visual_qa":"fail","notes":"left run faces right","repair_rows":["running-left"]}\n```' });
  try {
    const res = await visualQa({ image: PNG });
    assert.equal(res.visual_qa, "fail");
    assert.deepEqual(res.repair_rows, ["running-left"]);
  } finally {
    _deps.getLlm = realGetLlm;
  }
});

test("visualQa skips on unparseable model output", async () => {
  stubLlm("test-key");
  stubGenerateText({ text: "totally not json" });
  try {
    const res = await visualQa({ image: PNG });
    assert.equal(res.visual_qa, "skipped");
    assert.match(String(res.reason), /not valid JSON/);
  } finally {
    _deps.getLlm = realGetLlm;
  }
});

test("visualQa skips (no throw) when the provider call fails", async () => {
  stubLlm("test-key");
  _deps.generateText = (async () => {
    throw new Error("model does not support image input");
  }) as unknown as GenText;
  try {
    const res = await visualQa({ image: PNG });
    assert.equal(res.visual_qa, "skipped");
    assert.match(String(res.reason), /image input/);
  } finally {
    _deps.getLlm = realGetLlm;
  }
});
