// Tests for the Codex pet prompt builders (no network; pure string builders).
// Run: node --import tsx --test server/pet/prompts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBasePrompt,
  buildRowPrompt,
  IDENTITY_LOCK,
  NEGATIVE_CLAUSE,
  STATE_PROMPTS,
  STATE_REQUIREMENTS,
  USED_COLS,
  type PetState,
} from "./prompts.ts";

const ALL_STATES: PetState[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

// A distinctive keyword from each global clause, used to assert inclusion.
const IDENTITY_KEYWORD = "Identity lock";
const NEGATIVE_KEYWORD = "transparent-background extraction";

test("all 9 states have STATE_PROMPTS and STATE_REQUIREMENTS entries", () => {
  assert.equal(ALL_STATES.length, 9);
  for (const state of ALL_STATES) {
    const prompt = STATE_PROMPTS[state];
    assert.ok(prompt && prompt.length > 0, `${state} missing STATE_PROMPTS entry`);
    const reqs = STATE_REQUIREMENTS[state];
    assert.ok(Array.isArray(reqs) && reqs.length > 0, `${state} missing STATE_REQUIREMENTS entries`);
  }
});

test("USED_COLS matches the fixed atlas frame counts", () => {
  assert.deepEqual(USED_COLS, {
    idle: 6,
    "running-right": 8,
    "running-left": 8,
    waving: 4,
    jumping: 5,
    failed: 8,
    waiting: 6,
    running: 6,
    review: 6,
  });
});

test("buildRowPrompt includes frame count, identity lock, and negative clause for every state", () => {
  for (const state of ALL_STATES) {
    const prompt = buildRowPrompt({ state, petNotes: "a round orange fox mascot" });
    const frames = USED_COLS[state];
    assert.ok(
      prompt.includes(`exactly ${frames} full-body frames`),
      `${state} missing correct frame count (${frames})`,
    );
    assert.ok(
      prompt.includes(`${frames} invisible equal-width slots`),
      `${state} missing slot count (${frames})`,
    );
    assert.ok(prompt.includes(IDENTITY_KEYWORD), `${state} missing IDENTITY_LOCK`);
    assert.ok(prompt.includes(NEGATIVE_KEYWORD), `${state} missing NEGATIVE_CLAUSE`);
    // The state's action line and requirements must be embedded.
    assert.ok(prompt.includes(STATE_PROMPTS[state]), `${state} missing its STATE_PROMPTS action line`);
    for (const req of STATE_REQUIREMENTS[state]) {
      assert.ok(prompt.includes(req), `${state} missing a requirement line`);
    }
  }
});

test("IDENTITY_LOCK and NEGATIVE_CLAUSE expose the asserted keywords", () => {
  assert.ok(IDENTITY_LOCK.includes(IDENTITY_KEYWORD));
  assert.ok(NEGATIVE_CLAUSE.includes(NEGATIVE_KEYWORD));
});

test("buildRowPrompt echoes petId and petNotes", () => {
  const prompt = buildRowPrompt({
    petId: "sunny-fox",
    state: "idle",
    petNotes: "a round orange fox mascot",
  });
  assert.ok(prompt.includes("sunny-fox"), "missing petId");
  assert.ok(prompt.includes("a round orange fox mascot"), "missing petNotes");
});

test("buildBasePrompt includes transparent background and negative clause key phrases", () => {
  const prompt = buildBasePrompt({ petNotes: "a round orange fox mascot" });
  assert.ok(prompt.toLowerCase().includes("transparent background"), "missing transparent background");
  assert.ok(prompt.includes("192x208"), "missing 192x208 readability cue");
  assert.ok(prompt.includes(NEGATIVE_KEYWORD), "missing NEGATIVE_CLAUSE");
  assert.ok(prompt.includes("a round orange fox mascot"), "missing petNotes");
});

test("buildBasePrompt tolerates blank petNotes with a reference fallback", () => {
  const prompt = buildBasePrompt({ petNotes: "   " });
  assert.ok(prompt.includes("the pet shown in the reference image(s)"), "missing petNotes fallback");
});

test("running row means active-task work, not foot-running", () => {
  const prompt = buildRowPrompt({ state: "running", petNotes: "a round orange fox mascot" });
  const lower = prompt.toLowerCase();
  // Work semantics present.
  assert.ok(lower.includes("working") || lower.includes("processing"), "running missing work semantics");
  // Foot-running explicitly excluded.
  assert.ok(lower.includes("not literal foot-running"), "running does not exclude foot-running");
  assert.ok(lower.includes("jogging"), "running does not exclude jogging");
  assert.ok(lower.includes("sprinting"), "running does not exclude sprinting");
});

test("jumping row forbids ground shadows", () => {
  const prompt = buildRowPrompt({ state: "jumping", petNotes: "a round orange fox mascot" }).toLowerCase();
  assert.ok(prompt.includes("ground shadows") || prompt.includes("contact shadows"), "jumping allows shadows");
});

test("directional running rows assert their travel direction", () => {
  const right = buildRowPrompt({ state: "running-right", petNotes: "fox" }).toLowerCase();
  const left = buildRowPrompt({ state: "running-left", petNotes: "fox" }).toLowerCase();
  assert.ok(right.includes("travel right"), "running-right missing rightward travel");
  assert.ok(left.includes("travel left"), "running-left missing leftward travel");
});
