// Prompt builder — port of generate_prompts.py + studio._build_prompts.
//
// Builds 1 global reference prompt + 19 per-part prompts (positive + negative
// with mutual-exclusion terms) plus the pipeline DAG stage→model assignment.
// Behaviour mirrors the Python reference exactly (see scripts/generate_prompts.py
// and scripts/studio.py#_build_prompts).
import { readFileSync } from "node:fs";
import { configPath } from "./paths.ts";

// ── Backend / model strategy (mirrors studio.py constants) ──────────────────
// Default backend is the OpenAI gpt-image path; the DAG root/ref models are the
// stage-0 (text-to-image) and stage-1..5 (image-with-refs) defaults.
const BACKEND = "openai";
const MODEL = "google/gemini-3.1-flash-image-preview";
const DAG_ROOT_MODEL = "bytedance-seed/seedream-4.5";
const DAG_REF_MODEL = "google/gemini-3.1-flash-image-preview";

// ── Types ───────────────────────────────────────────────────────────────────

/** Character description block from character_profile.json. */
export interface CharacterProfile {
  hair: string;
  eyes: string;
  outfit: string;
  pose: string;
  hair_accessories?: string;
  [key: string]: unknown;
}

/** Quality / style / negative presets from character_profile.json. */
export interface Presets {
  quality: string;
  style: string;
  negative: string;
  background: string;
  ar_global: string;
  ar_part: string;
  [key: string]: unknown;
}

/** Full character profile. */
export interface Profile {
  name?: string;
  character: CharacterProfile;
  presets: Presets;
  [key: string]: unknown;
}

/** Partial override accepted by POST /api/prompts. */
export interface ProfileOverride {
  name?: string;
  character?: Partial<CharacterProfile>;
  presets?: Partial<Presets>;
  root_model?: string;
  ref_model?: string;
}

/** A single flattened part entry from parts_layout.json groups. */
export interface PartInfo {
  id: string;
  label_cn: string;
  label_en: string;
  w: number;
  h: number;
  group: string;
}

/** Global reference prompt. */
export interface GlobalPrompt {
  positive: string;
  negative: string;
  ar: string;
  model: string;
}

/** Per-part prompt with resolved stage + model. */
export interface PartPrompt {
  id: string;
  label_cn: string;
  label_en: string;
  w: number;
  h: number;
  positive: string;
  negative: string;
  stage: number;
  model: string;
}

/** Full prompt bundle returned by GET/POST /api/prompts. */
export interface PromptsResult {
  backend: string;
  global: GlobalPrompt;
  parts: PartPrompt[];
  stage_models: Record<string, string>;
}

// ── Layout config types ─────────────────────────────────────────────────────

interface RawPart {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RawGroup {
  id: string;
  label: string;
  parts: RawPart[];
}

interface PipelineStage {
  stage: number;
  name: string;
  label: string;
  parts: string[];
  depends_on: string[];
  context: string;
}

interface LayoutConfig {
  groups: RawGroup[];
  pipeline: PipelineStage[];
}

// ── JSON loading ─────────────────────────────────────────────────────────────

/** Read + parse a JSON file. */
export function loadJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** Load parts_layout.json. */
export function loadConfig(): LayoutConfig {
  return loadJson<LayoutConfig>(configPath("parts_layout.json"));
}

/** Load the default character_profile.json. */
export function loadDefaultProfile(): Profile {
  return loadJson<Profile>(configPath("character_profile.json"));
}

// ── Part flattening (port of get_all_parts) ─────────────────────────────────

/** Return flat list of parts with split cn/en labels. */
export function getAllParts(config: LayoutConfig): PartInfo[] {
  const parts: PartInfo[] = [];
  for (const g of config.groups) {
    for (const p of g.parts) {
      const labels = p.label.split("\n");
      parts.push({
        id: p.id,
        label_cn: labels[0] ?? "",
        label_en: labels.length > 1 ? (labels[1] ?? "") : "",
        w: p.w,
        h: p.h,
        group: g.label,
      });
    }
  }
  return parts;
}

// ── Positive / subject builders (port of generate_prompts.py) ───────────────

/** Combine quality preset + style + subject + background. */
export function buildPositive(partsList: string[], profile: Profile): string {
  const p = profile.presets;
  const subject = partsList.join(", ");
  return `${p.quality}, ${p.style}, ${subject}, ${p.background}`;
}

/** Global reference subject lines. */
export function buildGlobalSubject(profile: Profile): string[] {
  const c = profile.character;
  return [
    "1girl, full body, 45-degree side view, slight top-down angle, character concept art",
    `${c.hair}, ${c.eyes}`,
    `wearing ${c.outfit}`,
    c.pose,
  ];
}

/** Per-part subject lines (without quality/style/background). */
export function buildPartSubject(part: PartInfo, profile: Profile): string[] {
  const c = profile.character;
  const hairAccessories = c.hair_accessories ?? "none";
  const table: Record<string, string[]> = {
    head: [
      "1girl, head base only, no hair, no hair accessories, front view, pure white background (#FFFFFF)",
      "face contour, nose, ears visible, blank eye sockets",
      "no eyes, no pupils, no irises, no mouth, no lips, no teeth",
      "no hair, no bangs, no side hair, no ponytail, no hair ornaments, no hair accessories",
      "completely blank expressionless face, skin tone only in eye area and mouth area",
      "neck base visible at bottom edge for stitching to torso, shoulders cropped out",
      "this is a base layer — eyes, mouth, and hair will be overlaid as separate overlay sprites",
      "clean white canvas everywhere except the head base itself",
      "no headwear, no ribbons, no clips, no headbands, bald appearance on scalp",
    ],
    hair: [
      "1girl, hair only, no face, no body, front view, pure white background (#FFFFFF)",
      `${c.hair}`,
      `hair accessories: ${hairAccessories}`,
      "only hair and hair accessories visible, everything else must be pure white (#FFFFFF)",
      "NO face, NO skin, NO eyes, NO nose, NO mouth, NO ears, NO neck, NO body",
      "same framing and dimensions as head base sprite for precise overlay alignment",
      "hair positioned as if worn on a head, accessories attached to hair",
      "pure white canvas outside the hair features",
      "pure white background (#FFFFFF), solid white canvas, no background elements",
    ],
    torso: [
      "1girl, torso only, front view, pure white background (#FFFFFF)",
      "from shoulders to waist, no head, no neck, no hair",
      `wearing ${c.outfit}, outfit torso portion only, no sleeves below shoulder`,
      "shoulder area is clean cut edge at top, neck hole visible at top center",
      "arms cropped at shoulders, waist is clean cut edge at bottom",
    ],
    upper_arm_L: [
      "left upper arm only, from shoulder to elbow, front view, pure white background (#FFFFFF)",
      `wearing ${c.outfit} sleeve`,
      "arm resting straight down at side, bare skin at elbow joint bottom edge",
    ],
    upper_arm_R: [
      "right upper arm only, from shoulder to elbow, front view, pure white background (#FFFFFF)",
      `wearing ${c.outfit} sleeve`,
      "arm resting straight down at side, bare skin at elbow joint bottom edge",
    ],
    forearm_L: [
      "left forearm only, from elbow to wrist, front view, pure white background (#FFFFFF)",
      `wearing ${c.outfit} sleeve rolled up`,
      "elbow joint at top edge, wrist at bottom edge",
    ],
    forearm_R: [
      "right forearm only, from elbow to wrist, front view, pure white background (#FFFFFF)",
      `wearing ${c.outfit} sleeve rolled up`,
      "elbow joint at top edge, wrist at bottom edge",
    ],
    hand_L: [
      "left hand only, open palm facing viewer, front view, pure white background (#FFFFFF)",
      "wrist at top edge, fingers extending downward, fingers slightly apart",
      "slender fingers, smooth skin, clean cut at wrist",
    ],
    hand_R: [
      "right hand only, open palm facing viewer, front view, pure white background (#FFFFFF)",
      "wrist at top edge, fingers extending downward, fingers slightly apart",
      "slender fingers, smooth skin, clean cut at wrist",
    ],
    thigh_L: [
      "left thigh only, from hip to above-knee, front view, pure white background (#FFFFFF)",
      "bare skin, upper leg, no skirt, no clothing on leg",
      "hip top is clean cut edge — skirt belongs to torso sprite",
      "knee area is clean cut edge — knee joint belongs to calf sprite",
    ],
    thigh_R: [
      "right thigh only, from hip to above-knee, front view, pure white background (#FFFFFF)",
      "bare skin, upper leg, no skirt, no clothing on leg",
      "hip top is clean cut edge — skirt belongs to torso sprite",
      "knee area is clean cut edge — knee joint belongs to calf sprite",
    ],
    calf_L: [
      "left calf only, knee joint to ankle, front view, pure white background (#FFFFFF)",
      "wearing white knee-high sock covering knee, sock starts at knee joint",
      "sock covers from knee to ankle, skin visible only at very top knee area",
      "shoe not included — foot sprite starts at ankle",
    ],
    calf_R: [
      "right calf only, knee joint to ankle, front view, pure white background (#FFFFFF)",
      "wearing white knee-high sock covering knee, sock starts at knee joint",
      "sock covers from knee to ankle, skin visible only at very top knee area",
      "shoe not included — foot sprite starts at ankle",
    ],
    foot_L: [
      "left foot only, from ankle down, front view, pure white background (#FFFFFF)",
      "wearing school loafer shoe, ankle joint at very top edge",
      "sole flat on ground, no calf, no leg above ankle",
    ],
    foot_R: [
      "right foot only, from ankle down, front view, pure white background (#FFFFFF)",
      "wearing school loafer shoe, ankle joint at very top edge",
      "sole flat on ground, no calf, no leg above ankle",
    ],
    expr_happy_eyes: [
      "eye area only, front view, pure white background (#FFFFFF), expression overlay sprite",
      `${c.eyes}, eyes wide open with sparkle, happy expression eyebrows raised`,
      "ONLY eyes and eyebrows visible — everything else must be pure white (#FFFFFF)",
      "NO forehead, NO nose bridge, NO face contour, NO hair, NO mouth",
      "same framing as head base sprite for precise overlay alignment",
      "pure white canvas outside the eye features",
    ],
    expr_closed_eyes: [
      "eye area only, front view, pure white background (#FFFFFF), expression overlay sprite",
      `${c.eyes}, eyes closed in gentle upward curve, relaxed expression`,
      "ONLY eyes and eyebrows visible — everything else must be pure white (#FFFFFF)",
      "NO forehead, NO nose bridge, NO face contour, NO hair, NO mouth",
      "same framing as head base sprite for precise overlay alignment",
      "pure white canvas outside the eye features",
    ],
    expr_smile_mouth: [
      "mouth and nose area only, front view, pure white background (#FFFFFF), expression overlay sprite",
      "lips curved upward in happy smile, small teeth visible, open smile",
      "nose tip visible for alignment reference, ONLY nose and mouth visible",
      "NO chin, NO face contour, NO eyes, NO eyebrows, NO hair",
      "same framing as head base sprite for precise overlay alignment",
      "pure white canvas outside the mouth features",
    ],
    expr_surprised_mouth: [
      "mouth and nose area only, front view, pure white background (#FFFFFF), expression overlay sprite",
      "lips parted in small oval shape, slightly open, surprised expression",
      "nose tip visible for alignment reference, ONLY nose and mouth visible",
      "NO chin, NO face contour, NO eyes, NO eyebrows, NO hair",
      "same framing as head base sprite for precise overlay alignment",
      "pure white canvas outside the mouth features",
    ],
  };
  return table[part.id] ?? [`1girl, ${part.label_cn} only`];
}

/**
 * Extra negative-prompt terms defining what MUST NOT appear in a part's image.
 * Enforces strict mutual exclusion: adjacent chain parts, left/right
 * counterparts, and joint overlap regions are excluded.
 */
export function buildPartExclusions(partId: string): string[] {
  const table: Record<string, string[]> = {
    torso: [
      "no head",
      "no neck",
      "no arms",
      "no hands",
      "no legs",
      "no feet",
      "不含头部",
      "不含颈部",
      "不含手臂",
      "不含手",
      "不含腿",
      "不含脚",
      "headless",
      "armless",
      "legless",
      "shoulders are clean cut edges for sprite stitching",
      "waist is clean cut edge for sprite stitching",
    ],
    head: [
      "no eyes",
      "no pupils",
      "no irises",
      "no mouth",
      "no lips",
      "no teeth",
      "no tongue",
      "不含眼睛",
      "不含瞳孔",
      "不含虹膜",
      "不含嘴",
      "不含嘴唇",
      "不含牙齿",
      "no expression",
      "no smile",
      "no eyebrows",
      "不含表情",
      "不含微笑",
      "不含眉毛",
      "no hair",
      "no bangs",
      "no hair accessories",
      "no headwear",
      "不含头发",
      "不含发饰",
      "no torso",
      "no body",
      "no shoulders",
      "no arms",
      "no legs",
      "不含躯干",
      "不含身体",
      "不含肩部",
      "不含手臂",
      "不含腿",
      "neck base is clean cut edge for sprite stitching",
      "no clothing below neck",
      "blank expressionless face, eye and mouth areas intentionally empty",
    ],
    hair: [
      "no face",
      "no skin",
      "no eyes",
      "no nose",
      "no mouth",
      "no ears",
      "no neck",
      "不含脸部",
      "不含皮肤",
      "不含眼睛",
      "不含鼻子",
      "不含嘴",
      "不含耳朵",
      "不含颈部",
      "no body",
      "no torso",
      "no shoulders",
      "不含身体",
      "不含躯干",
      "不含肩部",
      "only hair strands and hair accessories visible",
      "white canvas where face and body would be",
      "sprite overlay designed to be composited on top of head base",
    ],
    thigh_L: [
      "no torso",
      "no upper body",
      "no calf",
      "no foot",
      "不含躯干",
      "不含上半身",
      "不含小腿",
      "不含脚",
      "no right leg",
      "不含右腿",
      "hip top is clean cut edge for sprite stitching",
      "knee bottom is clean cut edge for sprite stitching",
    ],
    thigh_R: [
      "no torso",
      "no upper body",
      "no calf",
      "no foot",
      "不含躯干",
      "不含上半身",
      "不含小腿",
      "不含脚",
      "no left leg",
      "不含左腿",
      "hip top is clean cut edge for sprite stitching",
      "knee bottom is clean cut edge for sprite stitching",
    ],
    calf_L: [
      "no thigh",
      "no upper leg",
      "no foot",
      "no shoe",
      "不含大腿",
      "不含大腿",
      "不含脚",
      "不含鞋",
      "no right calf",
      "不含右小腿",
      "knee top is clean cut edge for sprite stitching",
      "ankle bottom is clean cut edge for sprite stitching",
    ],
    calf_R: [
      "no thigh",
      "no upper leg",
      "no foot",
      "no shoe",
      "不含大腿",
      "不含大腿",
      "不含脚",
      "不含鞋",
      "no left calf",
      "不含左小腿",
      "knee top is clean cut edge for sprite stitching",
      "ankle bottom is clean cut edge for sprite stitching",
    ],
    foot_L: [
      "no calf",
      "no leg",
      "no ankle visible",
      "不含小腿",
      "不含腿",
      "不含脚踝以上",
      "no right foot",
      "不含右脚",
      "ankle top is clean cut edge for sprite stitching",
      "sole is clean cut edge",
    ],
    foot_R: [
      "no calf",
      "no leg",
      "no ankle visible",
      "不含小腿",
      "不含腿",
      "不含脚踝以上",
      "no left foot",
      "不含左脚",
      "ankle top is clean cut edge for sprite stitching",
      "sole is clean cut edge",
    ],
    upper_arm_L: [
      "no torso",
      "no body",
      "no forearm",
      "no hand",
      "no fingers",
      "不含躯干",
      "不含身体",
      "不含前臂",
      "不含手",
      "不含手指",
      "no right arm",
      "不含右臂",
      "shoulder top is clean cut edge for sprite stitching",
      "elbow bottom is clean cut edge for sprite stitching",
    ],
    upper_arm_R: [
      "no torso",
      "no body",
      "no forearm",
      "no hand",
      "no fingers",
      "不含躯干",
      "不含身体",
      "不含前臂",
      "不含手",
      "不含手指",
      "no left arm",
      "不含左臂",
      "shoulder top is clean cut edge for sprite stitching",
      "elbow bottom is clean cut edge for sprite stitching",
    ],
    forearm_L: [
      "no upper arm",
      "no bicep",
      "no hand",
      "no palm",
      "no fingers",
      "不含上臂",
      "不含上臂",
      "不含手",
      "不含手掌",
      "不含手指",
      "no right forearm",
      "不含右前臂",
      "elbow top is clean cut edge for sprite stitching",
      "wrist bottom is clean cut edge for sprite stitching",
    ],
    forearm_R: [
      "no upper arm",
      "no bicep",
      "no hand",
      "no palm",
      "no fingers",
      "不含上臂",
      "不含上臂",
      "不含手",
      "不含手掌",
      "不含手指",
      "no left forearm",
      "不含左前臂",
      "elbow top is clean cut edge for sprite stitching",
      "wrist bottom is clean cut edge for sprite stitching",
    ],
    hand_L: [
      "no forearm",
      "no arm",
      "no wrist above the hand",
      "不含前臂",
      "不含手臂",
      "不含手腕以上",
      "no right hand",
      "不含右手",
      "wrist top is clean cut edge for sprite stitching",
      "only the hand and wrist, nothing above wrist",
    ],
    hand_R: [
      "no forearm",
      "no arm",
      "no wrist above the hand",
      "不含前臂",
      "不含手臂",
      "不含手腕以上",
      "no left hand",
      "不含左手",
      "wrist top is clean cut edge for sprite stitching",
      "only the hand and wrist, nothing above wrist",
    ],
    expr_happy_eyes: [
      "no mouth",
      "no lips",
      "no teeth",
      "不含嘴",
      "不含嘴唇",
      "不含牙齿",
      "no full face",
      "no body",
      "不含完整脸部",
      "不含身体",
      "no forehead",
      "no nose bridge",
      "no face contour",
      "no hair",
      "不含额头",
      "不含鼻梁",
      "不含脸型轮廓",
      "不含头发",
      "only eyes and eyebrows visible, pure white (#FFFFFF) elsewhere",
      "alpha channel sprite, clean edges for overlay compositing",
    ],
    expr_closed_eyes: [
      "no mouth",
      "no lips",
      "no teeth",
      "不含嘴",
      "不含嘴唇",
      "不含牙齿",
      "no full face",
      "no body",
      "不含完整脸部",
      "不含身体",
      "no forehead",
      "no nose bridge",
      "no face contour",
      "no hair",
      "不含额头",
      "不含鼻梁",
      "不含脸型轮廓",
      "不含头发",
      "only eyes and eyebrows visible, pure white (#FFFFFF) elsewhere",
      "alpha channel sprite, clean edges for overlay compositing",
    ],
    expr_smile_mouth: [
      "no eyes",
      "no eyebrows",
      "no eye",
      "不含眼睛",
      "不含眉毛",
      "不含眼部",
      "no full face",
      "no body",
      "不含完整脸部",
      "不含身体",
      "no chin",
      "no face contour",
      "no hair",
      "不含下巴",
      "不含脸型轮廓",
      "不含头发",
      "only nose tip and mouth visible, pure white (#FFFFFF) elsewhere",
      "alpha channel sprite, clean edges for overlay compositing",
    ],
    expr_surprised_mouth: [
      "no eyes",
      "no eyebrows",
      "no eye",
      "不含眼睛",
      "不含眉毛",
      "不含眼部",
      "no full face",
      "no body",
      "不含完整脸部",
      "不含身体",
      "no chin",
      "no face contour",
      "no hair",
      "不含下巴",
      "不含脸型轮廓",
      "不含头发",
      "only nose tip and mouth visible, pure white (#FFFFFF) elsewhere",
      "alpha channel sprite, clean edges for overlay compositing",
    ],
  };
  return table[partId] ?? [];
}

// ── Profile merge (port of studio._send_prompts_post merge logic) ────────────

/** Shallow-merge an override onto the default character_profile. */
function mergeProfile(base: Profile, override?: ProfileOverride): Profile {
  if (!override) return base;
  return {
    ...base,
    name: override.name ?? base.name ?? "",
    character: { ...base.character, ...(override.character ?? {}) },
    presets: { ...base.presets, ...(override.presets ?? {}) },
  };
}

// ── Main builder (port of studio._build_prompts) ────────────────────────────

/**
 * Build global + per-part prompts. `profileOverride` (from POST /api/prompts) is
 * shallow-merged onto character_profile.json; omit it to use the defaults.
 */
export function buildPrompts(profileOverride?: ProfileOverride): PromptsResult {
  const root = profileOverride?.root_model ?? DAG_ROOT_MODEL;
  const ref = profileOverride?.ref_model ?? DAG_REF_MODEL;

  const config = loadConfig();
  const profile = mergeProfile(loadDefaultProfile(), profileOverride);
  const parts = getAllParts(config);

  const globalSubject = buildGlobalSubject(profile);
  const globalPositive = buildPositive(globalSubject, profile);

  const pipeline = config.pipeline ?? [];

  // stage → model: stage 0 uses the root (t2i) model; any stage with refs uses
  // the ref model; a stage with no refs falls back to MODEL.
  const stageModels: Record<string, string> = {};
  for (const s of pipeline) {
    const stageIdx = s.stage;
    const hasRefs = Array.isArray(s.depends_on) && s.depends_on.length > 0;
    if (stageIdx === 0) {
      stageModels[String(stageIdx)] = root;
    } else if (hasRefs) {
      stageModels[String(stageIdx)] = ref;
    } else {
      stageModels[String(stageIdx)] = MODEL;
    }
  }

  const partStage: Record<string, number> = {};
  for (const s of pipeline) {
    for (const pid of s.parts) {
      partStage[pid] = s.stage;
    }
  }

  const partPrompts: PartPrompt[] = [];
  for (const p of parts) {
    const subject = buildPartSubject(p, profile);
    const positive = buildPositive(subject, profile);
    const extraNeg = buildPartExclusions(p.id);
    let fullNegative = profile.presets.negative;
    if (extraNeg.length > 0) {
      fullNegative = fullNegative + ", " + extraNeg.join(", ");
    }
    const sid = partStage[p.id] ?? -1;
    const sm = sid >= 0 ? (stageModels[String(sid)] ?? MODEL) : MODEL;
    partPrompts.push({
      id: p.id,
      label_cn: p.label_cn,
      label_en: p.label_en,
      w: p.w,
      h: p.h,
      positive,
      negative: fullNegative,
      stage: sid,
      model: sm,
    });
  }

  // Stable sort by stage (mirrors Python list.sort — stable).
  partPrompts.sort((a, b) => a.stage - b.stage);

  return {
    backend: BACKEND,
    global: {
      positive: globalPositive,
      negative: profile.presets.negative,
      ar: profile.presets.ar_global,
      model: root,
    },
    parts: partPrompts,
    stage_models: stageModels,
  };
}
