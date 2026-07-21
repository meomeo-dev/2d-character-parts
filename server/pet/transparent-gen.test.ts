// Tests for generateTransparent — the white/black triangulation-matting render
// used when the image provider can't emit a native transparent background.
//
// image-gen.ts (the network layer) is mocked to return synthesized white-bg and
// black-bg renders of the same subject; the real triangulationMatting then runs,
// so we assert the recovered alpha is transparent on the background and opaque
// on the subject. Run:
//   node --import tsx --experimental-test-module-mocks --test server/pet/transparent-gen.test.ts
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import sharp from "sharp";

const SERVER_DIR = join(import.meta.dirname, "..");
const url = (rel: string) => pathToFileURL(join(SERVER_DIR, rel)).href;

const W = 64;
const H = 64;
// A centred opaque subject block; the rest is background.
const SUBJECT = { r: 200, g: 60, b: 40 };
const BLOCK = { left: 16, top: 16, w: 32, h: 32 };

/** Render the subject block over a solid background of the given colour. */
async function renderOn(bg: { r: number; g: number; b: number }): Promise<Uint8Array> {
  const block = await sharp({
    create: { width: BLOCK.w, height: BLOCK.h, channels: 4, background: { ...SUBJECT, alpha: 1 } },
  }).png().toBuffer();
  const png = await sharp({
    create: { width: W, height: H, channels: 4, background: { ...bg, alpha: 1 } },
  })
    .composite([{ input: block, left: BLOCK.left, top: BLOCK.top }])
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

// Record what prompts/refs the two render calls receive so we can assert the
// white-then-black-edit orchestration.
const calls: { generate: Array<{ prompt: string }>; edit: Array<{ prompt: string; images: unknown[] }> } = {
  generate: [],
  edit: [],
};

let generateTransparent: typeof import("./transparent-gen.ts").generateTransparent;

before(async () => {
  mock.module(url("image-gen.ts"), {
    namedExports: {
      toOpenAISize: () => "auto",
      // Text->image: the white-background render.
      generateImage: async (opts: { prompt: string }) => {
        calls.generate.push({ prompt: opts.prompt });
        return renderOn({ r: 255, g: 255, b: 255 });
      },
      // Edit: first call (refs) is the white render, the BLACK_BG_PROMPT call is
      // the black render. We key off the prompt to decide which bg to return.
      editImage: async (opts: { prompt: string; images: unknown[] }) => {
        calls.edit.push({ prompt: opts.prompt, images: opts.images });
        const black = /black/i.test(opts.prompt);
        return renderOn(black ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 });
      },
    },
  });
  ({ generateTransparent } = await import(url("./pet/transparent-gen.ts")));
});

/** Read RGBA at (x,y) from a PNG buffer. */
async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

test("text-to-image path: background becomes transparent, subject stays opaque", async () => {
  calls.generate.length = 0;
  calls.edit.length = 0;

  const { transparent, white, black } = await generateTransparent({ prompt: "a red cube" });

  // One white render via generateImage (no refs) + one black-edit via editImage.
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.edit.length, 1);
  assert.match(calls.edit[0]!.prompt, /black/i);
  assert.ok(white.length > 0 && black.length > 0);

  // Background corner (0,0) should be fully transparent.
  const corner = await pixelAt(transparent, 2, 2);
  assert.equal(corner[3], 0, "background alpha should be 0");

  // Subject centre should be opaque and roughly the subject colour.
  const centre = await pixelAt(transparent, 32, 32);
  assert.ok(centre[3] > 250, `subject alpha should be ~255, got ${centre[3]}`);
  assert.ok(Math.abs(centre[0] - SUBJECT.r) < 40, "subject red channel recovered");
});

test("edit path: refs drive a white edit, then a constrained black edit", async () => {
  calls.generate.length = 0;
  calls.edit.length = 0;

  const refPng = Buffer.from(await renderOn({ r: 255, g: 255, b: 255 }));
  const { transparent } = await generateTransparent({ prompt: "match this pet", refs: [refPng] });

  // With refs, the white render goes through editImage too => two edit calls, no
  // text-to-image call. First edit is the white render, second is the black one.
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.edit.length, 2);
  assert.doesNotMatch(calls.edit[0]!.prompt, /Change ONLY the background/);
  assert.match(calls.edit[1]!.prompt, /Change ONLY the background/);

  const corner = await pixelAt(transparent, 2, 2);
  assert.equal(corner[3], 0);
  const centre = await pixelAt(transparent, 32, 32);
  assert.ok(centre[3] > 250);
});
