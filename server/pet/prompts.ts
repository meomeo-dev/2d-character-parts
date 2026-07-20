// Prompt builders for Codex desktop-pet ("桌宠") sprite atlases.
//
// A pet atlas is a fixed 8x9 grid of 192x208 cells: 9 animation states (rows),
// each using a state-specific number of leading columns (frames). gpt-image-1
// renders each row as one horizontal strip, and a downstream slicer cuts the
// strip into per-frame cells on a transparent background.
//
// The prompt language here is a localized rewrite of the openai hatch-pet
// skill's constraints. Every clause exists for a concrete engineering reason:
// transparent output + clean per-slot poses are what make automated slicing and
// chroma-free extraction reliable. We keep the prompts in English because the
// image backend follows English instructions most reliably (matching the
// existing server/prompts.ts convention).

/** The 9 fixed pet animation states, in atlas row order (row 0..8). */
export type PetState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

/**
 * Frames used per state = leading columns of that atlas row. The atlas is 8
 * columns wide; unused trailing cells stay fully transparent. Kept local to
 * this worktree on purpose: a shared contract.ts may land later, but we avoid
 * depending on an unmerged file. Values must match references/animation-rows.md.
 */
export const USED_COLS: Record<PetState, number> = {
  idle: 6,
  "running-right": 8,
  "running-left": 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
};

/** One-line action description per state (localized port of hatch-pet STATE_PROMPTS). */
export const STATE_PROMPTS: Record<PetState, string> = {
  idle:
    "Calm low-distraction resting loop: subtle breathing, a tiny blink, a slight head or body bob, and only quiet persona-preserving motion.",
  "running-right":
    "Dragging-right loop: show directional movement to the right through body and limb poses only.",
  "running-left":
    "Dragging-left loop: show directional movement to the left through body and limb poses only.",
  waving:
    "Greeting loop: paw or limb down, raised, tilted, and returning in a friendly attention gesture.",
  jumping:
    "Hover jump loop: anticipation, lift, airborne peak, descent, and settle through body height.",
  failed:
    "Blocked/failed loop: slumped or deflated reaction with sad or closed eyes.",
  waiting:
    "Needs-input loop: an expectant asking pose waiting for approval, help, or user input.",
  // NOTE: `running` is the "actively working / processing" state, NOT foot-running.
  running:
    "Working loop: focused active-task processing — thinking, typing, scanning, or effortful concentration; not literal foot-running, jogging, sprinting, treadmill motion, raised knees, long steps, pumping arms, or directional travel.",
  review:
    "Ready-review loop: focused inspection of completed output with a lean, blink, narrowed eyes, head tilt, or paw pose.",
};

/** Per-state do/don't constraint lists (localized port of hatch-pet STATE_REQUIREMENTS). */
export const STATE_REQUIREMENTS: Record<PetState, string[]> = {
  idle: [
    "CRITICAL: idle is the low-distraction baseline state and its first frame is also reused as the reduced-motion static pet.",
    "Use only subtle idle motion: gentle breathing, a tiny blink, a slight head or body bob, a very small material sway, or another quiet motion that fits the pet persona.",
    "Keep the pet in essentially the same pose, facing direction, silhouette, markings, palette, and prop state across all frames.",
    "Idle variation must stay calm but still read as animation; do not repeat effectively identical copies across the loop.",
    "Do not show waving, walking, running, jumping, talking, working, reviewing, emotional reactions, large gestures, item interactions, or new props.",
    "Feet, base, body, or object anchor should remain planted or nearly planted.",
    "The first and last frames should be very close visually so the loop feels calm and does not pop.",
  ],
  "running-right": [
    "Show directional drag movement to the right through body, limb, and prop movement only.",
    "The row must unmistakably face and travel right.",
    "The movement cadence must alternate visibly across the frames instead of repeating one nearly static stride.",
    "Do not draw speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.",
  ],
  "running-left": [
    "Show directional drag movement to the left through body, limb, and prop movement only.",
    "The row must unmistakably face and travel left.",
    "The movement cadence must alternate visibly across the frames instead of repeating one nearly static stride.",
    "Do not draw speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.",
  ],
  waving: [
    "Show the greeting through paw, hand, wing, or limb pose only.",
    "Do not draw wave marks, motion arcs, lines, sparkles, symbols, or floating effects around the gesture.",
  ],
  jumping: [
    "Show the jump through pose and vertical body position only: anticipation, lift, airborne peak, descent, settle.",
    "Do not draw ground shadows, contact shadows, drop shadows, oval shadows, landing marks, dust, smears, bounce pads, or motion marks under the pet.",
    "Keep the background outside the pet perfectly flat and transparent with no darker patches.",
  ],
  failed: [
    "Show failure through a slumped pose, drooping ears or limbs, closed or sad eyes, and lower body position.",
    "Tears, small smoke puffs, or tiny stars are allowed only if attached to or overlapping the pet silhouette and kept inside the same frame slot.",
    "Do not draw red X marks, floating symbols, detached stars, separated smoke clouds, falling tear drops, dust, or other loose effects.",
  ],
  waiting: [
    "Show that the pet needs approval, help, or user input through an expectant asking pose.",
    "Keep the motion patient and readable, without turning it into ordinary idle or review.",
  ],
  running: [
    "Show the pet actively working or processing, as if running a task: focused posture, busy hands or paws, purposeful bobbing, thinking motion, or tool/prop motion only if already part of the pet identity.",
    "Do not show literal foot-running, jogging, sprinting, treadmill motion, raised knees, long steps, pumping arms, directional travel, speed lines, dust clouds, floor shadows, motion trails, or detached motion effects.",
  ],
  review: [
    "Show review through a lean, blink, narrowed eyes, head tilt, or paw/hand position.",
    "Do not add magnifying glasses, papers, code, UI, punctuation, symbols, or other new props unless they already exist in the base pet identity.",
  ],
};

/**
 * Global negative clause appended to every pet prompt.
 *
 * Each banned element is an engineering requirement, not an aesthetic one:
 * shadows / glows / motion blur / speed lines / dust / detached effects bleed
 * outside the pet silhouette and survive transparent-background cleanup as
 * stray colored pixels; stray pixels, text, borders, and checkerboard patterns
 * confuse per-slot slicing and the alpha extraction of each 192x208 cell. Ban
 * them up front so the transparent PNG cuts cleanly into frames.
 */
export const NEGATIVE_CLAUSE =
  "Clean transparent-background extraction: crisp opaque edges with safe padding, and no scenery, text, labels, borders, guide marks, checkerboard transparency pattern, shadows, glows, motion blur, speed lines, dust, detached effects, or stray pixels.";

/**
 * Cross-frame identity lock. Sprite frames are generated independently within a
 * row, so we must explicitly pin every identity cue or the pet drifts frame to
 * frame and the animation reads as different characters.
 */
export const IDENTITY_LOCK =
  "Identity lock: it is the exact same pet in every frame — preserve silhouette, face, palette, material, proportions, markings, and props across all frames.";

/** Build the base reference-sprite prompt (single centered pose, transparent bg). */
export function buildBasePrompt(opts: { petNotes: string; styleNotes?: string }): string {
  const petNotes = opts.petNotes.trim() || "the pet shown in the reference image(s)";
  const styleLine = opts.styleNotes && opts.styleNotes.trim().length > 0
    ? `Style: ${opts.styleNotes.trim()}\n`
    : "";
  return [
    "Create one clean full-body reference sprite for a Codex desktop pet.",
    "",
    `Pet identity: ${petNotes}.`,
    styleLine +
      "Place a single centered full-body pose on a perfectly flat transparent background. Keep the whole pet visible, compact, and clearly readable inside a 192x208 cell, with a clear silhouette, simple face, and stable palette and materials for easy animation.",
    "Preserve the approved reference identity cues (silhouette, face, palette, material, proportions, markings, props).",
    NEGATIVE_CLAUSE,
  ].join("\n");
}

/** Build the prompt for one animation-strip row (N frames of a single state). */
export function buildRowPrompt(opts: {
  petId?: string;
  state: PetState;
  petNotes: string;
  styleNotes?: string;
}): string {
  const frames = USED_COLS[opts.state];
  const petNotes = opts.petNotes.trim() || "the same pet from the approved base reference";
  const petId = opts.petId && opts.petId.trim().length > 0 ? opts.petId.trim() : "pet";
  const styleLine = opts.styleNotes && opts.styleNotes.trim().length > 0
    ? `Style: ${opts.styleNotes.trim()}\n`
    : "";
  const requirements = STATE_REQUIREMENTS[opts.state].map((line) => `- ${line}`).join("\n");
  return [
    `Create one horizontal animation strip for Codex desktop pet \`${petId}\`, state \`${opts.state}\`.`,
    "",
    // Frame count is load-bearing: the slicer expects exactly this many poses.
    `Output exactly ${frames} full-body frames in one left-to-right row on a flat transparent background. Treat the row as ${frames} invisible equal-width slots: one centered complete pose per slot, evenly spaced, with no overlap, clipping, empty slots, labels, or borders.`,
    "",
    `${IDENTITY_LOCK} The pet is: ${petNotes}.`,
    styleLine +
      // Baseline/scale stability prevents "size popping" after per-cell slicing;
      // motion must come from pose changes inside the slot, not from resizing.
      "Animation continuity: keep apparent pet scale and baseline stable within the row unless the state itself intentionally changes vertical position, such as `jumping`. Move the pose within each slot instead of redrawing the pet larger or smaller frame to frame.",
    "",
    `State action: ${STATE_PROMPTS[opts.state]}`,
    "",
    "State requirements:",
    requirements,
    "",
    NEGATIVE_CLAUSE,
  ].join("\n");
}

