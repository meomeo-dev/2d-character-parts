// Prompt builder — port of generate_prompts.py (19 parts + pipeline DAG).
//
// STUB: implemented by a later track. Signature is final; behaviour must mirror
// studio._build_prompts (global subject + per-part positives/negatives, stage
// model assignment, sorted by stage).

/** Full prompt bundle returned by GET/POST /api/prompts. */
export interface PromptsResult {
  backend: string;
  global: unknown;
  parts: unknown[];
  stage_models?: unknown;
}

/**
 * Build global + per-part prompts. `profileOverride` is the merged character /
 * presets object from POST /api/prompts; omit it to use character_profile.json.
 */
export function buildPrompts(profileOverride?: unknown): PromptsResult {
  void profileOverride;
  throw new Error("not implemented: prompts track (generate_prompts.py port)");
}
