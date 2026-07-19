// Unit tests for the pure size-mapping helper in image-gen.ts (no network).
// Run: node --import tsx --test server/image-gen.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAISize } from "./image-gen.ts";

test("toOpenAISize passes through explicit gpt-image sizes", () => {
  for (const s of ["1024x1024", "1536x1024", "1024x1536", "auto"]) {
    assert.equal(toOpenAISize(s), s);
  }
});

test("toOpenAISize maps aspect ratios to the nearest supported size", () => {
  assert.equal(toOpenAISize(null, "16:9"), "1536x1024"); // wide
  assert.equal(toOpenAISize(null, "9:16"), "1024x1536"); // tall
  assert.equal(toOpenAISize(null, "1:1"), "1024x1024"); // square
});

test("toOpenAISize derives ratio from a WxH dimension string", () => {
  assert.equal(toOpenAISize("1920x1080"), "1536x1024");
  assert.equal(toOpenAISize("1080x1920"), "1024x1536");
  assert.equal(toOpenAISize("1328x1328"), "1024x1024");
});

test("toOpenAISize falls back to auto for unknown / malformed input", () => {
  assert.equal(toOpenAISize(undefined), "auto");
  assert.equal(toOpenAISize("garbage"), "auto");
  assert.equal(toOpenAISize("0x0"), "auto");
});

test("toOpenAISize prefers an explicit aspect_ratio over the size string", () => {
  assert.equal(toOpenAISize("500x500", "16:9"), "1536x1024");
});
