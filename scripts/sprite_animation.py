#!/usr/bin/env python3
"""Sprite-sheet animation helpers — grid templates, slicing, and GIF export.

Ported from the reference notebook ``sprites_animation.ipynb``. Pillow is an
optional dependency: the import is guarded (``try/except ImportError``) so this
module never hard-depends on Pillow at import time, mirroring
``compose_parts.py``. Functions that need Pillow raise a clear ``RuntimeError``
when it is missing.

术语 / Terminology:
    * grid 网格模板 — 白底黑线, 偶数线宽, 正方格.
    * sheet 精灵表 — 由 grid 作结构参考生成的成品图.
    * frame 帧 / gif 预览动图.
"""

import copy
import io
import json
import uuid
from datetime import datetime
from pathlib import Path

try:
    from PIL import Image as PILImage
    from PIL import ImageDraw

    HAS_PIL = True
except ImportError:  # pragma: no cover - exercised only when Pillow is absent
    PILImage = None
    ImageDraw = None
    HAS_PIL = False

# Min / max grid dimension, inclusive (matches the reference template rules).
_MIN_DIM = 2
_MAX_DIM = 6


def _require_pil() -> None:
    """Raise ``RuntimeError`` if Pillow is unavailable."""
    if not HAS_PIL:
        raise RuntimeError("Pillow (PIL) is required for sprite animation. Install with: pip install Pillow")


def _normalize_line_width(line_width: int) -> int:
    """Clamp ``line_width`` to the smallest even width (>= 2)."""
    if line_width < 2 or line_width % 2 != 0:
        return 2
    return line_width


def _coerce_image(img):
    """Return a PIL image from a PIL image, path, or bytes."""
    _require_pil()
    if isinstance(img, PILImage.Image):
        return img
    if isinstance(img, (bytes, bytearray)):
        return PILImage.open(io.BytesIO(bytes(img)))
    return PILImage.open(str(img))


def create_grid_image(rows: int, cols: int, target_width: int, line_width: int = 2) -> tuple[bytes, int, int]:
    """Render a ``rows``×``cols`` grid template; return ``(png_bytes, width, height)``.

    White background with black border + grid lines of even width. Cells are
    square. Raises ``ValueError`` if ``rows``/``cols`` fall outside 2–6 or the
    target width is too small.
    """
    _require_pil()
    if not (_MIN_DIM <= rows <= _MAX_DIM and _MIN_DIM <= cols <= _MAX_DIM):
        raise ValueError("Rows and columns must be between 2 and 6.")

    line_width = _normalize_line_width(line_width)

    # width = (cols + 1) * line_width + cols * cell_size  ->  solve for cell_size
    available_space = target_width - (cols + 1) * line_width
    if available_space <= 0:
        raise ValueError("Target width is too small for the given columns and line width.")

    cell_size = available_space // cols

    # Recompute the real canvas size so every cell is an exact square.
    actual_width = cols * cell_size + (cols + 1) * line_width
    actual_height = rows * cell_size + (rows + 1) * line_width

    img = PILImage.new("RGB", (actual_width, actual_height), "white")
    draw = ImageDraw.Draw(img)
    line_color = "black"

    # Vertical lines (drawn as filled rectangles so the width stays exact/even).
    for i in range(cols + 1):
        x = i * (cell_size + line_width)
        draw.rectangle([x, 0, x + line_width - 1, actual_height - 1], fill=line_color)

    # Horizontal lines.
    for j in range(rows + 1):
        y = j * (cell_size + line_width)
        draw.rectangle([0, y, actual_width - 1, y + line_width - 1], fill=line_color)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), actual_width, actual_height


def build_prompt(
    description: str,
    rows: int,
    cols: int,
    *,
    style: str | None = None,
    era: str | None = None,
    lighting: str | None = None,
    composition: str | None = None,
    color: str | None = None,
    mode: str = "new",
    prev_prompt_context: str | None = None,
) -> str:
    """Build an image-generation prompt for a sprite sheet.

    ``mode="new"`` wraps the base prompt for a from-scratch generation;
    ``mode="continue"`` (with ``prev_prompt_context``) wraps it as a
    continuation whose first grid row holds the previous sequence's last frames.
    """

    def _clean(value: str | None) -> str | None:
        """Return a usable modifier, or ``None`` for empty / sentinel values."""
        if not value or value == "None":
            return None
        return value

    segments: list[str] = []
    style = _clean(style)
    if style:
        segments.append(f"{style} style")
    if _clean(era):
        segments.append(f"{era} era")
    if _clean(lighting):
        segments.append(f"{lighting}")
    if _clean(composition):
        segments.append(f"{composition}")
    if _clean(color):
        segments.append(f"{color} colors")

    modifiers = ", ".join(segments)
    modifiers = f", {modifiers}" if modifiers else ""

    base_prompt = (
        f"Sprite sheet of a {description} illustration{modifiers}, "
        f"{rows}x{cols} grid ({rows} rows and {cols} columns), "
        "white background, sequence, frame by frame animation, square aspect ratio."
    )

    if mode == "continue" and prev_prompt_context:
        return (
            "Create a new image by continuing the animation sequence:\n\n"
            f"{base_prompt}\n\n"
            "**CONTINUATION CONTEXT**:\n"
            "This is a continuation of a previous animation sequence.\n"
            f'Previous Prompt Context: "{prev_prompt_context}"\n'
            f'Current Prompt Context: "{description}"\n\n'
            "The first row of the attached image contains the LAST frames of the previous sequence.\n"
            "Please generate the subsequent frames in the remaining rows to continue the action "
            "defined by the Current Prompt Context.\n"
            "Follow the structure of the attached reference image exactly.\n"
            "Do not change the input aspect ratio.\n\n"
            "Return the drawn picture."
        )

    return (
        "Create a new image by :\n\n"
        f"{base_prompt} Follow the structure of the attached reference image exactly.\n\n"
        "Do not change the input aspect ratio.\n\n"
        "Return the drawn picture."
    )


def slice_and_gif(
    sheet_path: str,
    rows: int,
    cols: int,
    *,
    line_width: int = 2,
    duration: int = 200,
    out_path: str | None = None,
) -> str:
    """Slice a sprite sheet into ``rows*cols`` frames and export an animated GIF.

    Cell sizes are reverse-computed from the sheet's *actual* dimensions, so a
    model that returns a differently scaled sheet still slices cleanly. Frames
    are read row by row (row-major). Returns the GIF path.
    """
    _require_pil()
    line_width = _normalize_line_width(line_width)
    img = PILImage.open(sheet_path)
    total_width, total_height = img.size

    available_w = total_width - (cols + 1) * line_width
    available_h = total_height - (rows + 1) * line_width
    if available_w <= 0 or available_h <= 0:
        raise ValueError("Sheet image is too small for the given grid.")

    cell_w = available_w // cols
    cell_h = available_h // rows

    frames = [
        img.crop(
            (
                c * (cell_w + line_width) + line_width,
                r * (cell_h + line_width) + line_width,
                c * (cell_w + line_width) + line_width + cell_w,
                r * (cell_h + line_width) + line_width + cell_h,
            )
        )
        for r in range(rows)
        for c in range(cols)
    ]

    gif_path = str(Path(sheet_path).with_suffix(".gif")) if out_path is None else str(out_path)
    Path(gif_path).parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(gif_path, save_all=True, append_images=frames[1:], duration=duration, loop=0)
    return gif_path


def synthesize_continuation_grid(
    prev_sheet: str,
    template: str,
    rows: int,
    cols: int,
    *,
    line_width: int = 2,
) -> str:
    """Seed a continuation grid: copy ``prev_sheet``'s last row into row 0 of ``template``.

    The last-row cells are LANCZOS-resized to the template's cell size when the
    two grids differ. Returns the path to the written PNG.
    """
    _require_pil()
    line_width = _normalize_line_width(line_width)
    prev_img = PILImage.open(prev_sheet)
    template_img = PILImage.open(template).convert("RGB")

    src_w, src_h = prev_img.size
    src_cell_w = (src_w - (cols + 1) * line_width) // cols
    src_cell_h = (src_h - (rows + 1) * line_width) // rows

    dst_w, dst_h = template_img.size
    dst_cell_w = (dst_w - (cols + 1) * line_width) // cols
    dst_cell_h = (dst_h - (rows + 1) * line_width) // rows

    src_r = rows - 1
    for c in range(cols):
        src_left = c * (src_cell_w + line_width) + line_width
        src_upper = src_r * (src_cell_h + line_width) + line_width
        cell = prev_img.crop((src_left, src_upper, src_left + src_cell_w, src_upper + src_cell_h))

        if (src_cell_w, src_cell_h) != (dst_cell_w, dst_cell_h):
            cell = cell.resize((dst_cell_w, dst_cell_h), PILImage.LANCZOS)

        dst_left = c * (dst_cell_w + line_width) + line_width
        dst_upper = line_width  # first row
        template_img.paste(cell, (dst_left, dst_upper))

    out_path = Path(template).with_name(f"syn_{Path(prev_sheet).stem}_{Path(template).stem}.png")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    template_img.save(out_path)
    return str(out_path)


def image_difference(img1, img2) -> float:
    """Return the mean per-pixel L1 difference over a 32×32 grayscale downscale.

    ``0.0`` means identical. Accepts PIL images, file paths, or PNG bytes.
    """
    _require_pil()
    i1 = _coerce_image(img1).resize((32, 32)).convert("L")
    i2 = _coerce_image(img2).resize((32, 32)).convert("L")
    p1 = list(i1.getdata())
    p2 = list(i2.getdata())
    total = sum(abs(a - b) for a, b in zip(p1, p2, strict=False))
    return total / len(p1)


def _deep_merge(base: dict, patch: dict) -> dict:
    """Recursively merge ``patch`` into ``base`` in place and return ``base``."""
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


class AnimationStore:
    """Lightweight project manager persisting time-ordered records to ``history.json``."""

    def __init__(self, root: str) -> None:
        """Create a store rooted at ``root`` (holds ``history.json``); load existing records."""
        self.root = Path(root)
        self.history_path = self.root / "history.json"
        self.records: list[dict] = self._load()

    def _load(self) -> list[dict]:
        """Return persisted records, or an empty list if the file is absent/invalid."""
        if not self.history_path.exists():
            return []
        try:
            data = json.loads(self.history_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
        return data if isinstance(data, list) else []

    def _save(self) -> None:
        """Persist ``self.records`` to ``history.json`` (UTF-8, indent 2)."""
        self.root.mkdir(parents=True, exist_ok=True)
        self.history_path.write_text(
            json.dumps(self.records, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def add_record(self, record: dict) -> str:
        """Append ``record`` (assigning ``id`` + ``timestamp`` if absent); return its id."""
        stored = copy.deepcopy(record)
        record_id = stored.get("id") or uuid.uuid4().hex[:12]
        stored["id"] = record_id
        stored.setdefault("timestamp", datetime.now().isoformat())
        stored.setdefault("status", "completed")
        self.records.append(stored)
        self._save()
        return record_id

    def update_record(self, record_id: str, patch: dict) -> dict:
        """Deep-merge ``patch`` into the record with ``record_id``; return the updated record.

        Raises ``KeyError`` if no such record exists.
        """
        for rec in self.records:
            if rec.get("id") == record_id:
                _deep_merge(rec, copy.deepcopy(patch))
                self._save()
                return rec
        raise KeyError(f"No record with id {record_id!r}")

    def get_record(self, record_id: str) -> dict | None:
        """Return the record with ``record_id``, or ``None`` if absent."""
        for rec in self.records:
            if rec.get("id") == record_id:
                return rec
        return None

    def get_last_record(self) -> dict | None:
        """Return the most recently added record, or ``None`` if empty."""
        return self.records[-1] if self.records else None
