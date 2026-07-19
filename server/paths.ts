// Absolute filesystem paths for the backend.
//
// ROOT is the worktree root (the parent of server/). Everything else is derived
// from it so modules never depend on the process CWD. Resolved from this file's
// URL via fileURLToPath(import.meta.url).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Worktree root — the parent directory of server/. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to config/. */
export const CONFIG_DIR = join(ROOT, "config");
/** Absolute path to templates/. */
export const TEMPLATES_DIR = join(ROOT, "templates");
/** Absolute path to parts/. */
export const PARTS_DIR = join(ROOT, "parts");
/** Absolute path to animations/. */
export const ANIMATIONS_DIR = join(ROOT, "animations");

/** Join extra segments under config/. */
export const configPath = (...segments: string[]): string => join(CONFIG_DIR, ...segments);
/** Join extra segments under templates/. */
export const templatesPath = (...segments: string[]): string => join(TEMPLATES_DIR, ...segments);
/** Join extra segments under parts/. */
export const partsPath = (...segments: string[]): string => join(PARTS_DIR, ...segments);
/** Join extra segments under animations/. */
export const animationsPath = (...segments: string[]): string => join(ANIMATIONS_DIR, ...segments);
