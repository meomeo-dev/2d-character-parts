// Image generation + editing via the AI SDK.
//
// STUB: implemented by a later track. Uses generateImage from `ai` with an
// openai-compatible imageModel built from getImage() and
// llmBaseURL(getImage().base_url). Ports image_openai.generate / .edit and the
// studio _generate_openai path.

/** Options for a text-to-image generation. */
export interface GenerateImageOptions {
  prompt: string;
  size?: string;
  model?: string;
}

/** Generate an image from a prompt and return the raw PNG bytes. */
export async function generateImage(opts: GenerateImageOptions): Promise<Uint8Array> {
  void opts;
  throw new Error("not implemented: image-gen track (image_openai.generate port)");
}

/** Options for an image edit — one or more reference inputs (paths or bytes). */
export interface EditImageOptions {
  prompt: string;
  images: Array<string | Uint8Array>;
  size?: string;
  model?: string;
}

/** Edit/compose an image against reference inputs and return the raw PNG bytes. */
export async function editImage(opts: EditImageOptions): Promise<Uint8Array> {
  void opts;
  throw new Error("not implemented: image-gen track (image_openai.edit port)");
}
