// Local custom-pet packaging — writes the two files the Codex app loads from
// ${CODEX_HOME:-$HOME/.codex}/pets/<pet-name>/ (see references/codex-pet-contract.md):
//
//   spritesheet.webp   the lossless atlas (passed in; we don't re-encode)
//   pet.json           the manifest, shape fixed by the contract
//
// The manifest's spritesheetPath is a *relative* filename ("spritesheet.webp"),
// not an absolute path, because the app resolves it against the pet folder.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Inputs for {@link packagePet}. */
export interface PackagePetOptions {
  /** Manifest id / folder name (already slugified by the caller). */
  petId: string;
  /** Human-facing display name. */
  displayName: string;
  /** Free-text description; trimmed to one short sentence in the manifest. */
  description: string;
  /** The lossless spritesheet.webp bytes to write verbatim. */
  webp: Buffer;
  /** Directory to write both files into (created if missing). */
  outDir: string;
}

/** Absolute paths of the two files {@link packagePet} wrote. */
export interface PackagePetResult {
  manifestPath: string;
  spritesheetPath: string;
}

/**
 * Reduce a free-text description to "one short sentence" per the contract.
 * Takes the first sentence (up to the first ., !, ? or newline); if that is
 * still longer than ~120 chars — or there was no terminator — it is hard-capped
 * at 120 chars with an ellipsis so the manifest never carries a paragraph.
 */
function toShortSentence(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return "";
  // First sentence terminator (keep the char itself) or first line break.
  const match = /^[^.!?\n]*[.!?]/.exec(trimmed);
  let sentence = match ? match[0].trim() : (trimmed.split(/\n/)[0] ?? trimmed).trim();
  if (sentence.length > 120) {
    // Cap on a word boundary where possible to avoid cutting mid-word.
    const capped = sentence.slice(0, 120);
    const lastSpace = capped.lastIndexOf(" ");
    sentence = (lastSpace > 40 ? capped.slice(0, lastSpace) : capped).trimEnd() + "…";
  }
  return sentence;
}

/**
 * Write a self-contained custom-pet package (spritesheet.webp + pet.json) into
 * `outDir`, creating it if needed. Returns the two absolute paths written.
 *
 * The caller owns `outDir`: this function does not decide where the package
 * lands (the route defaults it inside the run dir and flags cross-tree writes).
 */
export async function packagePet(opts: PackagePetOptions): Promise<PackagePetResult> {
  const { petId, displayName, description, webp, outDir } = opts;

  await mkdir(outDir, { recursive: true });

  const spritesheetPath = join(outDir, "spritesheet.webp");
  await writeFile(spritesheetPath, webp);

  // Manifest shape is fixed by the contract; spritesheetPath stays relative so
  // the app resolves it against the pet folder regardless of where outDir is.
  const manifest = {
    id: petId,
    displayName,
    description: toShortSentence(description),
    spritesheetPath: "spritesheet.webp",
  };
  const manifestPath = join(outDir, "pet.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  return { manifestPath, spritesheetPath };
}
