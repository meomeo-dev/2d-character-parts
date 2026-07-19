// Image generation routes — port of studio._handle_generate / ._handle_matting.
//
//   POST /api/generate  text-to-image / img2img -> parts/<part_id>.png
//   POST /api/matting    white->black edit + triangulation matting -> transparent PNG
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import sharp from "sharp";
import { editImage, generateImage, toOpenAISize } from "../image-gen.ts";
import { triangulationMatting } from "../image/matting.ts";
import { PARTS_DIR, partsPath, configPath, ROOT } from "../paths.ts";

/** One reference-image descriptor surfaced back to the frontend log. */
interface RefMeta {
  idx: number;
  part_id: string;
  label_cn: string;
  context: string;
}

/** Derive a part id from a "/parts/<id>.png" (or "…parts/<id>.png") ref string. */
function partIdFromRef(ref: string): string {
  if (ref.startsWith("/parts/")) return ref.split("/").pop()!.replace(/\.png$/, "");
  if (ref.includes("parts/")) return ref.split("/").pop()!.replace(/\.png$/, "");
  return ref.slice(-30);
}

/**
 * Turn studio ref entries into inputs for editImage.
 *
 * "/parts/*.png" (or any "…parts/*.png") paths become absolute filesystem paths
 * when the file exists; "data:" URLs are decoded to raw bytes. Anything else is
 * skipped. Port of studio.resolve_openai_refs.
 */
function resolveOpenAIRefs(refImages: unknown): Array<string | Uint8Array> {
  const inputs: Array<string | Uint8Array> = [];
  if (!Array.isArray(refImages)) return inputs;
  for (const ref of refImages) {
    if (typeof ref !== "string") continue;
    if (ref.startsWith("/parts/") || ref.includes("parts/")) {
      const local = join(ROOT, ref.replace(/^\/+/, ""));
      if (existsSync(local)) inputs.push(local);
    } else if (ref.startsWith("data:")) {
      const comma = ref.indexOf(",");
      if (comma === -1) continue;
      try {
        inputs.push(new Uint8Array(Buffer.from(ref.slice(comma + 1), "base64")));
      } catch {
        // skip malformed data URL
      }
    }
  }
  return inputs;
}

/** Read config/parts_layout.json, or null when absent/invalid. */
function loadLayout(): Record<string, unknown> | null {
  const p = configPath("parts_layout.json");
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Build reference-image guidance text + ref_meta for the prompt.
 * Port of the essential parts of studio._build_ref_guidance.
 */
function buildRefGuidance(refImages: unknown, partId: string): { guidance: string; refMeta: RefMeta[] } {
  if (!Array.isArray(refImages) || refImages.length === 0) return { guidance: "", refMeta: [] };

  const layout = loadLayout();
  const labelByPart: Record<string, string> = { global_reference: "全局参考 Global Reference" };
  const contextByPart: Record<string, string> = {};
  let targetContext = "";
  let targetLabel = partId;

  if (layout) {
    for (const group of Array.isArray(layout["groups"]) ? (layout["groups"] as unknown[]) : []) {
      const parts = group && typeof group === "object" ? (group as Record<string, unknown>)["parts"] : null;
      for (const p of Array.isArray(parts) ? parts : []) {
        if (p && typeof p === "object") {
          const rec = p as Record<string, unknown>;
          if (typeof rec["id"] === "string") {
            labelByPart[rec["id"]] = String(rec["label"] ?? rec["label_cn"] ?? rec["id"]);
          }
        }
      }
    }
    for (const stage of Array.isArray(layout["pipeline"]) ? (layout["pipeline"] as unknown[]) : []) {
      if (stage && typeof stage === "object") {
        const s = stage as Record<string, unknown>;
        const ctx = typeof s["context"] === "string" ? s["context"] : "";
        const label = typeof s["label"] === "string" ? s["label"] : "";
        for (const pid of Array.isArray(s["parts"]) ? s["parts"] : []) {
          if (typeof pid === "string") contextByPart[pid] = ctx;
        }
        if (Array.isArray(s["parts"]) && (s["parts"] as unknown[]).includes(partId)) {
          targetContext = ctx;
          targetLabel = label || partId;
        }
      }
    }
  }

  const refMeta: RefMeta[] = refImages.map((ref, idx) => {
    const pid = typeof ref === "string" ? partIdFromRef(ref) : String(ref);
    return {
      idx: idx + 1,
      part_id: pid,
      label_cn: labelByPart[pid] ?? pid,
      context: contextByPart[pid] ?? "",
    };
  });

  const lines: string[] = ["\n\n[参考图使用指南 Reference Image Guide]"];
  for (const rm of refMeta) {
    lines.push(`参考图${rm.idx} [img:${rm.idx}:${rm.part_id}] = ${rm.label_cn}`);
    if (rm.context) lines.push(`  作用: ${rm.context}`);
  }
  lines.push("");
  lines.push("使用要求 Usage Requirements:");
  lines.push(`1. 本次生成目标: ${targetLabel}`);
  lines.push("2. 必须保持与所有参考图一致的风格、配色和角色设计（发色、瞳色、服饰）");
  lines.push("3. 参考图仅作为风格和比例参考，不要直接复制参考图内容，生成全新的匹配部件");
  lines.push(`4. 新部件必须在比例和位置上与参考图对齐`);
  if (targetContext) lines.push(`5. 本次生成上下文: ${targetContext}`);
  lines.push("6. 确保生成的部件可以作为独立sprite与参考图中的部件拼接成完整角色");

  return { guidance: lines.join("\n"), refMeta };
}

// Map a white-bg image's aspect ratio to a gpt-image aspect ratio string.
// Port of the ratio thresholds in studio._handle_matting.
function aspectFromRatio(ratio: number): string {
  if (ratio > 0.55 && ratio < 0.58) return "9:16";
  if (ratio > 0.65 && ratio < 0.68) return "2:3";
  if (ratio > 0.74 && ratio < 0.76) return "3:4";
  if (ratio > 0.98 && ratio < 1.02) return "1:1";
  if (ratio > 1.32 && ratio < 1.35) return "4:3";
  if (ratio > 1.76 && ratio < 1.8) return "16:9";
  return "1:1";
}

const BLACK_BG_PROMPT =
  "Change ONLY the background to pure black (#000000). " +
  "Keep every pixel of the character and subject exactly the same — no changes to the foreground. " +
  "Do not alter any pixel of the subject. This is a constrained edit for matting: " +
  "the background must become solid black while the subject remains pixel-perfect.";

export function register(app: Hono): void {
  app.post("/api/generate", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const partId = typeof b["part_id"] === "string" ? b["part_id"] : "";
    let positive = typeof b["positive"] === "string" ? b["positive"] : "";
    const imageSize = typeof b["image_size"] === "string" ? b["image_size"] : "1328x1328";
    const seed = b["seed"] ?? null;
    const refImages = b["ref_images"];
    const model = typeof b["model"] === "string" ? b["model"] : undefined;
    const aspectRatio = typeof b["aspect_ratio"] === "string" ? b["aspect_ratio"] : undefined;

    if (!positive) return c.json({ error: "Missing 'positive' field" }, 400);

    const { guidance, refMeta } = buildRefGuidance(refImages, partId);
    if (guidance) positive = positive + guidance;

    const refInputs = resolveOpenAIRefs(refImages);
    const size = toOpenAISize(imageSize, aspectRatio);

    const start = Date.now();
    let bytes: Uint8Array;
    try {
      bytes =
        refInputs.length > 0
          ? await editImage({ prompt: positive, images: refInputs, size, model })
          : await generateImage({ prompt: positive, size, model });
    } catch (e) {
      return c.json({ error: `Request failed: ${(e as Error).message}` }, 502);
    }
    const timingMs = Date.now() - start;

    mkdirSync(PARTS_DIR, { recursive: true });
    const outPath = partsPath(`${partId || "_generated"}.png`);
    try {
      writeFileSync(outPath, bytes);
    } catch (e) {
      return c.json({ error: `Failed to save image: ${(e as Error).message}` }, 500);
    }

    return c.json({
      ok: true,
      part_id: partId,
      seed,
      url: `/parts/${partId || "_generated"}.png`,
      path: outPath,
      timing_ms: timingMs,
      model: model ?? null,
      prompt: positive,
      ref_meta: refMeta,
    });
  });

  app.post("/api/matting", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const partId = typeof b["part_id"] === "string" ? b["part_id"] : "";
    if (!partId) return c.json({ error: "Missing 'part_id'" }, 400);

    mkdirSync(PARTS_DIR, { recursive: true });
    const whitePath = partsPath(`${partId}_white.png`);
    const blackPath = partsPath(`${partId}_black.png`);
    const currentPath = partsPath(`${partId}.png`);

    if (!existsSync(currentPath)) {
      return c.json({ error: `Part '${partId}' not generated yet. Generate it first.` }, 400);
    }

    const start = Date.now();

    // Step 1: preserve the white-bg version.
    try {
      copyFileSync(currentPath, whitePath);
    } catch (e) {
      return c.json({ error: `Failed to copy white image: ${(e as Error).message}` }, 500);
    }

    // Step 2: read dimensions to pick the matching gpt-image size.
    let aspectRatio = "1:1";
    try {
      const meta = await sharp(whitePath).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (w > 0 && h > 0) aspectRatio = aspectFromRatio(w / h);
    } catch {
      aspectRatio = "1:1";
    }

    // Step 3: regenerate with a pure-black background via image editing.
    let blackBytes: Uint8Array;
    try {
      blackBytes = await editImage({
        prompt: BLACK_BG_PROMPT,
        images: [whitePath],
        size: toOpenAISize(null, aspectRatio),
      });
      writeFileSync(blackPath, blackBytes);
    } catch (e) {
      if (existsSync(whitePath)) {
        try {
          unlinkSync(whitePath);
        } catch {
          // ignore cleanup failure
        }
      }
      return c.json({ error: `Black-background generation failed: ${(e as Error).message}` }, 502);
    }

    // Step 4: run triangulation matting -> transparent PNG (overwrites current).
    try {
      const white = readFileSync(whitePath);
      const black = readFileSync(blackPath);
      const transparent = await triangulationMatting(white, black);
      writeFileSync(currentPath, transparent);
    } catch (e) {
      return c.json({ error: `Matting algorithm failed: ${(e as Error).message}` }, 500);
    }

    const timingMs = Date.now() - start;
    return c.json({
      part_id: partId,
      white_url: `/parts/${partId}_white.png`,
      black_url: `/parts/${partId}_black.png`,
      transparent_url: `/parts/${partId}.png`,
      timing_ms: timingMs,
    });
  });
}
