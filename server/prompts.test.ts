// Parity tests for the prompt builder — mirrors tests/test_prompts.py.
//
// No network / no other-track stubs are touched: buildPrompts only reads the
// on-disk config/*.json fixtures, so these run offline with no mocking.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGlobalSubject,
  buildPartExclusions,
  buildPartSubject,
  buildPositive,
  buildPrompts,
  getAllParts,
  loadConfig,
  loadDefaultProfile,
  type PartInfo,
} from "./prompts.ts";

function fixtures() {
  const config = loadConfig();
  const profile = loadDefaultProfile();
  const parts = getAllParts(config);
  return { config, profile, parts };
}

function findPart(parts: PartInfo[], id: string): PartInfo {
  const p = parts.find((x) => x.id === id);
  assert.ok(p, `part ${id} not found`);
  return p;
}

test("load_json — config + profile have required keys", () => {
  const { config, profile } = fixtures();
  assert.ok("groups" in config);
  assert.ok("pipeline" in config);
  assert.ok("name" in profile);
  assert.ok("character" in profile);
  assert.ok("presets" in profile);
});

test("all 19 parts present", () => {
  const { parts } = fixtures();
  assert.equal(parts.length, 19, `expected 19 parts, got ${parts.length}`);
});

test("every part has a non-empty subject and positive prompt", () => {
  const { profile, parts } = fixtures();
  for (const p of parts) {
    const subj = buildPartSubject(p, profile);
    assert.ok(subj.length > 0, `${p.id} has empty subject`);
    const pos = buildPositive(subj, profile);
    assert.ok(pos.length > 0, `${p.id} has empty positive prompt`);
  }
});

test("every part has exclusion terms", () => {
  const { parts } = fixtures();
  for (const p of parts) {
    const ex = buildPartExclusions(p.id);
    assert.ok(ex.length > 0, `${p.id} has no exclusion terms`);
  }
});

test("global subject carries the view angle", () => {
  const { profile } = fixtures();
  const pos = buildPositive(buildGlobalSubject(profile), profile);
  assert.ok(pos.includes("45-degree") || pos.includes("side view"), "global missing view angle");
});

test("parts have front view and white background", () => {
  const { profile, parts } = fixtures();
  for (const p of parts) {
    const pos = buildPositive(buildPartSubject(p, profile), profile).toLowerCase();
    assert.ok(pos.includes("front view"), `${p.id} missing 'front view'`);
    assert.ok(pos.includes("white background"), `${p.id} missing 'white background'`);
  }
});

test("head base is a blank face", () => {
  const { profile, parts } = fixtures();
  const head = findPart(parts, "head");
  const pos = buildPositive(buildPartSubject(head, profile), profile).toLowerCase();
  assert.ok(pos.includes("no eyes") || pos.includes("blank"));
});

test("expression sprites are overlays on white", () => {
  const { profile, parts } = fixtures();
  for (const pid of ["expr_happy_eyes", "expr_closed_eyes", "expr_smile_mouth", "expr_surprised_mouth"]) {
    const p = findPart(parts, pid);
    const pos = buildPartSubject(p, profile).join(", ").toLowerCase();
    assert.ok(pos.includes("white background"), `${pid} missing 'white background'`);
    assert.ok(pos.includes("overlay"), `${pid} missing 'overlay'`);
  }
});

test("exclusion chains — adjacent limb parts exclude each other", () => {
  for (const pid of ["upper_arm_L", "upper_arm_R"]) {
    const exText = buildPartExclusions(pid).join(" ").toLowerCase();
    assert.ok(exText.includes("forearm"), `${pid} doesn't exclude forearm`);
    assert.ok(exText.includes("hand"), `${pid} doesn't exclude hand`);
  }
  for (const pid of ["thigh_L", "thigh_R"]) {
    const exText = buildPartExclusions(pid).join(" ").toLowerCase();
    assert.ok(exText.includes("calf"), `${pid} doesn't exclude calf`);
    assert.ok(exText.includes("foot"), `${pid} doesn't exclude foot`);
  }
});

test("opposite-side exclusion — each L part excludes its R counterpart", () => {
  const oppositeCheck: Record<string, string[]> = {
    thigh_L: ["no right leg", "不含右腿"],
    thigh_R: ["no left leg", "不含左腿"],
    calf_L: ["no right calf", "不含右小腿"],
    calf_R: ["no left calf", "不含左小腿"],
    upper_arm_L: ["no right arm", "不含右臂"],
    upper_arm_R: ["no left arm", "不含左臂"],
    forearm_L: ["no right forearm", "不含右前臂"],
    forearm_R: ["no left forearm", "不含左前臂"],
    hand_L: ["no right hand", "不含右手"],
    hand_R: ["no left hand", "不含左手"],
    foot_L: ["no right foot", "不含右脚"],
    foot_R: ["no left foot", "不含左脚"],
  };
  for (const [base, keywords] of Object.entries(oppositeCheck)) {
    const exText = buildPartExclusions(base).join(" ").toLowerCase();
    const found = keywords.some((kw) => exText.includes(kw.toLowerCase()));
    assert.ok(found, `${base} doesn't exclude its counterpart (checked: ${keywords.join(", ")})`);
  }
});

// ── buildPrompts integration (mirrors studio._build_prompts) ─────────────────

test("buildPrompts — 19 parts, global block, and full negative", () => {
  const result = buildPrompts();
  assert.equal(result.backend, "openai");
  assert.equal(result.parts.length, 19);
  assert.ok(result.global.positive.includes("45-degree"));
  assert.equal(result.global.ar, "9:16");
  assert.equal(result.global.model, "bytedance-seed/seedream-4.5");

  // Per-part negative = base negative + joined exclusions.
  for (const p of result.parts) {
    const ex = buildPartExclusions(p.id);
    assert.ok(p.negative.startsWith("lowres"), `${p.id} negative missing base preset`);
    if (ex.length > 0) {
      assert.ok(p.negative.endsWith(ex.join(", ")), `${p.id} negative missing exclusions`);
    }
  }
});

test("buildPrompts — parts sorted by stage, stage_models assigned", () => {
  const result = buildPrompts();
  // stage 0 → root t2i model; ref stages → ref model.
  assert.equal(result.stage_models["0"], "bytedance-seed/seedream-4.5");
  assert.equal(result.stage_models["1"], "google/gemini-3.1-flash-image-preview");

  // parts must be in non-decreasing stage order.
  const stages = result.parts.map((p) => p.stage);
  for (let i = 1; i < stages.length; i++) {
    assert.ok((stages[i] ?? 0) >= (stages[i - 1] ?? 0), "parts not sorted by stage");
  }
  // torso is stage 1, head is stage 4, expressions stage 6.
  const torso = result.parts.find((p) => p.id === "torso");
  const head = result.parts.find((p) => p.id === "head");
  assert.equal(torso?.stage, 1);
  assert.equal(head?.stage, 4);
});

test("buildPrompts — profile override deep-merges character + presets", () => {
  const result = buildPrompts({
    character: { hair: "blue twin tails" },
    presets: { ar_global: "2:3" },
    root_model: "custom/root",
    ref_model: "custom/ref",
  });
  assert.ok(result.global.positive.includes("blue twin tails"));
  // Non-overridden character fields survive the shallow merge.
  assert.ok(result.global.positive.includes("purple eyes"));
  assert.equal(result.global.ar, "2:3");
  assert.equal(result.global.model, "custom/root");
  assert.equal(result.stage_models["0"], "custom/root");
  assert.equal(result.stage_models["1"], "custom/ref");
});
