// Part composition — port of compose_parts.py (sharp).
//
// Lays out generated part PNGs from `partsDir` onto a single transparent canvas
// per the parts_layout config (meta.canvas_width × meta.canvas_height, with each
// group part resized to (w,h) and pasted at (x,y)).
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { OverlayOptions } from "sharp";

/** One part slot in the layout: resized to (w,h) and placed at (x,y). */
export interface LayoutPart {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A named group of part slots. */
export interface LayoutGroup {
  id?: string;
  parts: LayoutPart[];
}

/** The parts_layout.json shape used by the composer. */
export interface LayoutConfig {
  meta: { canvas_width: number; canvas_height: number };
  groups: LayoutGroup[];
}

function asLayout(config: unknown): LayoutConfig {
  const c = config as Partial<LayoutConfig>;
  if (
    !c ||
    typeof c.meta?.canvas_width !== "number" ||
    typeof c.meta?.canvas_height !== "number" ||
    !Array.isArray(c.groups)
  ) {
    throw new Error("composeParts: invalid layout config (expected meta.canvas_width/height + groups[])");
  }
  return c as LayoutConfig;
}

/** Compose part PNGs from `partsDir` into a single sheet per `config`. */
export async function composeParts(config: unknown, partsDir: string): Promise<Buffer> {
  const layout = asLayout(config);
  const cw = layout.meta.canvas_width;
  const ch = layout.meta.canvas_height;

  const overlays = await Promise.all(
    layout.groups.flatMap((group) =>
      group.parts.map(async (part): Promise<OverlayOptions | null> => {
        const imgPath = join(partsDir, `${part.id}.png`);
        if (!existsSync(imgPath)) return null;
        const resized = await sharp(imgPath)
          .ensureAlpha()
          .resize(part.w, part.h, { fit: "fill", kernel: "lanczos3" })
          .png()
          .toBuffer();
        return { input: resized, left: part.x, top: part.y };
      }),
    ),
  );

  const composites = overlays.filter((o): o is OverlayOptions => o !== null);

  return sharp({
    create: {
      width: cw,
      height: ch,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
