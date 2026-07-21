// Tests for packagePet: writes spritesheet.webp + pet.json into a temp dir with
// the contract manifest shape. Run:
//   node --import tsx --test --experimental-test-module-mocks server/pet/package-pet.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packagePet } from "./package-pet.ts";

const TMP = mkdtempSync(join(tmpdir(), "package-pet-"));

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Minimal valid webp bytes stand-in — packagePet writes them verbatim. */
const WEBP = Buffer.from("fake-webp-bytes");

test("packagePet writes both files with the contract manifest shape", async () => {
  const outDir = join(TMP, "tofu");
  const { manifestPath, spritesheetPath } = await packagePet({
    petId: "tofu",
    displayName: "Tofu",
    description: "A small round orange cat.",
    webp: WEBP,
    outDir,
  });

  assert.ok(existsSync(spritesheetPath));
  assert.ok(existsSync(manifestPath));
  assert.equal(spritesheetPath, join(outDir, "spritesheet.webp"));
  assert.equal(manifestPath, join(outDir, "pet.json"));

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  assert.equal(manifest["id"], "tofu");
  assert.equal(manifest["displayName"], "Tofu");
  assert.equal(manifest["description"], "A small round orange cat.");
  // spritesheetPath is a relative filename, never absolute.
  assert.equal(manifest["spritesheetPath"], "spritesheet.webp");

  // Spritesheet bytes are written through unchanged.
  assert.deepEqual(readFileSync(spritesheetPath), WEBP);
});

test("packagePet trims a long description to one short sentence", async () => {
  const outDir = join(TMP, "verbose");
  const description =
    "A cheerful pixel companion who loves coding sessions. It also enjoys naps, snacks, and long walks through the file tree at midnight.";
  const { manifestPath } = await packagePet({
    petId: "verbose",
    displayName: "Verbose",
    description,
    webp: WEBP,
    outDir,
  });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  assert.equal(manifest["description"], "A cheerful pixel companion who loves coding sessions.");
});

test("packagePet hard-caps a terminator-less description", async () => {
  const outDir = join(TMP, "runon");
  const description = "x".repeat(300);
  const { manifestPath } = await packagePet({
    petId: "runon",
    displayName: "Runon",
    description,
    webp: WEBP,
    outDir,
  });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  const desc = String(manifest["description"]);
  assert.ok(desc.length <= 121, `expected capped length, got ${desc.length}`);
  assert.ok(desc.endsWith("…"));
});
