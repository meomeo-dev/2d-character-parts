// Transparent-background image generation for the pet atlas pipeline.
//
// Why this exists: the pet chain needs alpha-transparent sprites for clean
// frame slicing, but not every gpt-image provider supports the native
// `background:"transparent"` parameter (e.g. gpt-image-2 rejects it with
// "Transparent background is not supported for this model"). Rather than
// depend on that capability, we recover alpha via triangulation matting —
// the same white/black two-render trick already used by POST /api/matting
// (see routes/imagegen.ts):
//
//   1. Render the subject on a solid WHITE background (opaque).
//   2. Edit ONLY the background to solid BLACK, keeping the subject pixel-
//      identical (constrained edit — no seed control on this provider, so an
//      edit is the reliable way to hold the foreground fixed).
//   3. Triangulation matting reconstructs straight alpha from the pair:
//        α = 1 - (C_white - C_black),  C_fg = C_black / α
//
// This costs two renders per sprite instead of one, but works on any provider
// that can do text->image and image edits, transparent support or not.
import { editImage, generateImage } from "../image-gen.ts";
import { triangulationMatting } from "../image/matting.ts";

// Constrained edit that flips the background to pure black while forbidding any
// change to the subject. Mirrors BLACK_BG_PROMPT in routes/imagegen.ts so both
// matting paths ask the model for exactly the same thing.
const BLACK_BG_PROMPT =
  "Change ONLY the background to pure black (#000000). " +
  "Keep every pixel of the character and subject exactly the same — no changes to the foreground. " +
  "Do not alter any pixel of the subject. This is a constrained edit for matting: " +
  "the background must become solid black while the subject remains pixel-perfect.";

// Appended to the caller's prompt so the first render lands the subject on a
// clean, matting-friendly solid white field (no gradients/shadows to confuse α).
const WHITE_BG_CLAUSE =
  " The entire background must be a single solid pure-white (#FFFFFF) field, " +
  "evenly lit, with no shadows, gradients, borders, or props.";

/** Inputs for a transparent render. `refs` (if any) drive an edit; else text->image. */
export interface TransparentGenOptions {
  prompt: string;
  /** Reference image paths/bytes for an identity-preserving edit; empty => text-to-image. */
  refs?: Array<string | Uint8Array>;
  /** gpt-image size / aspect string, forwarded to the underlying generate/edit. */
  size?: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Render `prompt` and return a straight-alpha transparent PNG, recovering alpha
 * via white/black triangulation matting (no provider transparent support needed).
 *
 * Returns `{ transparent, white, black }` so callers can persist the
 * intermediates for debugging/QA if they want; most only need `transparent`.
 */
export async function generateTransparent(
  opts: TransparentGenOptions,
): Promise<{ transparent: Buffer; white: Buffer; black: Buffer }> {
  const refs = opts.refs ?? [];
  const whitePrompt = opts.prompt + WHITE_BG_CLAUSE;

  // Step 1: white-background render (edit against refs when provided so the
  // pet identity carries over; otherwise a plain text->image render).
  const whiteBytes = refs.length > 0
    ? await editImage({ prompt: whitePrompt, images: refs, size: opts.size, model: opts.model, background: "opaque", signal: opts.signal })
    : await generateImage({ prompt: whitePrompt, size: opts.size, model: opts.model, background: "opaque", signal: opts.signal });
  const white = Buffer.from(whiteBytes);

  // Step 2: constrained edit of the white render -> solid black background.
  // We edit the freshly rendered white bytes (not the refs) so the subject is
  // held pixel-identical between the two renders — the matting math assumes the
  // foreground is the same in both.
  const blackBytes = await editImage({
    prompt: BLACK_BG_PROMPT,
    images: [white],
    size: opts.size,
    model: opts.model,
    background: "opaque",
    signal: opts.signal,
  });
  const black = Buffer.from(blackBytes);

  // Step 3: recover straight alpha from the white/black pair.
  const transparent = await triangulationMatting(white, black);
  return { transparent, white, black };
}
