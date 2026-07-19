#!/usr/bin/env python3
"""API routes for the sprite-sheet action animation feature (Track B).

Registers, on the shared studio route maps:
    * ``POST /api/animate``      — idea/description -> grid -> img2img sheet -> GIF.
    * ``GET  /api/animations``   — list persisted animation records.

Generated PNG/GIF files land in ``animations/`` (git-ignored) and are served
back over ``GET /animations/<file>`` by the studio static file handler (its
working directory is the project root), so no extra GET route is needed.

The image + LLM calls go through the ``image_openai`` / ``llm_gateway`` clients,
which read provider settings (and API keys) via ``providers`` — keys are never
logged or echoed here. Like the other studio endpoints, this route is
unauthenticated and intended for local single-user use only.
"""

import json
import uuid
from datetime import datetime
from pathlib import Path

import image_openai
import llm_gateway
import sprite_animation as sa

PROJECT_DIR = Path(__file__).resolve().parent.parent

# Output directory for generated grids / sheets / gifs (git-ignored). Referenced
# through the module global so tests can redirect it to a tmp path.
ANIM_DIR = PROJECT_DIR / "animations"

# Pixels per grid cell used when rendering the reference template. The final
# sheet is re-measured at slice time, so this only sets the reference aspect.
CELL_PX = 256

# Idea -> English action description. Keeps technical sprite-sheet terms out of
# the description itself (the template/prompt supply the grid structure).
_IDEA_SYSTEM_PROMPT = (
    "You are an expert at writing detailed visual descriptions for 2D sprite sheet animations. "
    "The user provides a simple concept; expand it into a concise but descriptive sentence focusing "
    "on the subject's appearance, clothing, equipment, and the specific action. Do not include "
    "technical terms like 'sprite sheet', 'grid', 'frame', 'sequence', or 'animation' in the "
    "description. Always output the description in English, regardless of the user's input language."
)


def _read_json_body(h) -> dict:
    """Read and parse the JSON request body from a studio handler."""
    length = int(h.headers.get("Content-Length", 0))
    return json.loads(h.rfile.read(length)) if length else {}


def _clamp_dim(value, default: int) -> int:
    """Coerce a grid dimension into the valid 2–6 range."""
    try:
        dim = int(value)
    except (TypeError, ValueError):
        return default
    return max(2, min(6, dim))


def _expand_idea(idea: str) -> str:
    """Expand a short idea into an English action description via the LLM gateway.

    Falls back to the raw idea if the gateway is unavailable or returns nothing.
    """
    try:
        resp = llm_gateway.chat(
            [
                {"role": "system", "content": _IDEA_SYSTEM_PROMPT},
                {"role": "user", "content": idea},
            ]
        )
        content = resp["choices"][0]["message"]["content"]
        text = content.strip() if isinstance(content, str) else ""
        return text or idea
    except Exception:
        return idea


def _sheet_bytes_from_edit(result) -> bytes:
    """Extract the first image's raw bytes from an ``image_openai.edit`` result."""
    if not result:
        raise ValueError("Image client returned no images.")
    first = result[0]
    if isinstance(first, (bytes, bytearray)):
        return bytes(first)
    raise TypeError("Image client returned an unexpected image type.")


def _record_urls(record: dict) -> dict:
    """Return a copy of ``record`` with browser-facing ``/animations/`` URLs added."""
    enriched = dict(record)
    if record.get("image_path"):
        enriched["sheet_url"] = f"/animations/{Path(record['image_path']).name}"
    if record.get("gif_path"):
        enriched["gif_url"] = f"/animations/{Path(record['gif_path']).name}"
    return enriched


def handle_animate(h, parsed) -> None:
    """Handle ``POST /api/animate``: generate a sprite sheet and its GIF preview."""
    try:
        body = _read_json_body(h)
    except (json.JSONDecodeError, ValueError):
        h._json_response({"error": "Invalid JSON"}, 400)
        return

    idea = (body.get("idea") or "").strip()
    description = (body.get("description") or "").strip()
    mode = body.get("mode", "new")
    rows = _clamp_dim(body.get("rows"), 3)
    cols = _clamp_dim(body.get("cols"), 4)
    style = body.get("style")
    era = body.get("era")
    lighting = body.get("lighting")
    composition = body.get("composition")
    color = body.get("color")

    if not description:
        if not idea:
            h._json_response({"error": "Provide 'idea' or 'description'."}, 400)
            return
        description = _expand_idea(idea)

    ANIM_DIR.mkdir(parents=True, exist_ok=True)
    store = sa.AnimationStore(str(ANIM_DIR))

    # Continuation mode aligns the grid with the previous sequence so the
    # synthesized seed row lines up cell-for-cell.
    prev_prompt_context = None
    prev_record = store.get_last_record() if mode == "continue" else None
    if prev_record and prev_record.get("image_path") and Path(prev_record["image_path"]).exists():
        grid_config = prev_record.get("grid_config") or {}
        rows = _clamp_dim(grid_config.get("rows"), rows)
        cols = _clamp_dim(grid_config.get("cols"), cols)
        prev_prompt_context = prev_record.get("description")
    else:
        mode = "new"

    stamp = f"{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}"
    target_width = cols * CELL_PX + (cols + 1) * 2

    # 1. Blank grid template (structural reference for img2img).
    try:
        grid_png, _w, _hh = sa.create_grid_image(rows, cols, target_width)
    except ValueError as exc:
        h._json_response({"error": str(exc)}, 400)
        return
    except RuntimeError as exc:  # Pillow missing
        h._json_response({"error": str(exc)}, 500)
        return

    template_path = ANIM_DIR / f"grid_{rows}x{cols}_{stamp}.png"
    template_path.write_bytes(grid_png)

    # 2. In continue mode, seed row 0 with the previous sheet's last row.
    reference_path = template_path
    if mode == "continue" and prev_record:
        try:
            reference_path = Path(
                sa.synthesize_continuation_grid(prev_record["image_path"], str(template_path), rows, cols)
            )
        except (RuntimeError, ValueError, OSError):
            reference_path = template_path
            mode = "new"
            prev_prompt_context = None

    # 3. Build the prompt and run img2img generation.
    prompt = sa.build_prompt(
        description,
        rows,
        cols,
        style=style,
        era=era,
        lighting=lighting,
        composition=composition,
        color=color,
        mode=mode,
        prev_prompt_context=prev_prompt_context,
    )

    try:
        result = image_openai.edit(prompt, images=[str(reference_path)])
        sheet_bytes = _sheet_bytes_from_edit(result)
    except NotImplementedError:
        h._json_response({"error": "Image client not implemented in this build."}, 501)
        return
    except Exception as exc:
        h._json_response({"error": f"Image generation failed: {exc}"}, 502)
        return

    sheet_path = ANIM_DIR / f"sheet_{rows}x{cols}_{stamp}.png"
    sheet_path.write_bytes(sheet_bytes)

    # 4. Slice into frames and export the preview GIF.
    try:
        gif_path = sa.slice_and_gif(
            str(sheet_path), rows, cols, out_path=str(ANIM_DIR / f"anim_{rows}x{cols}_{stamp}.gif")
        )
    except (RuntimeError, ValueError) as exc:
        h._json_response({"error": f"GIF export failed: {exc}"}, 500)
        return

    # 5. Persist the record and respond.
    record_id = store.add_record(
        {
            "image_path": str(sheet_path),
            "prompt": prompt,
            "description": description,
            "grid_config": {"rows": rows, "cols": cols},
            "style": style,
            "era": era,
            "lighting": lighting,
            "composition": composition,
            "color": color,
            "idea": idea or None,
            "status": "completed",
            "gif_path": gif_path,
            "generation_mode": mode,
        }
    )
    record = _record_urls(store.get_record(record_id) or {})
    h._json_response(
        {
            "gif_url": record.get("gif_url"),
            "sheet_url": record.get("sheet_url"),
            "record": record,
        }
    )


def handle_list(h, parsed) -> None:
    """Handle ``GET /api/animations``: return all persisted records, newest last."""
    store = sa.AnimationStore(str(ANIM_DIR))
    records = [_record_urls(r) for r in store.records]
    h._json_response({"records": records})


def register(get_map: dict, post_map: dict) -> None:
    """Register animation routes on the shared studio route maps."""
    post_map["/api/animate"] = handle_animate
    get_map["/api/animations"] = handle_list
