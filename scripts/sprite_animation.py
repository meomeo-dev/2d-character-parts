#!/usr/bin/env python3
"""Sprite-sheet animation helpers — grid templates, slicing, and GIF export.

STUB — implementation lands in a later track. Signatures below are final.

The implementing track should guard the Pillow import (``try/except
ImportError``) so this module never hard-depends on Pillow at import time,
mirroring ``compose_parts.py``.
"""

from pathlib import Path


def create_grid_image(rows: int, cols: int, target_width: int, line_width: int = 2) -> tuple[bytes, int, int]:
    """Render a ``rows``×``cols`` grid template; return ``(png_bytes, width, height)``.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("sprite_animation.create_grid_image() lands in a later track (animation).")


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

    STUB: implemented in a later track.
    """
    raise NotImplementedError("sprite_animation.build_prompt() lands in a later track (animation).")


def slice_and_gif(
    sheet_path: str,
    rows: int,
    cols: int,
    *,
    line_width: int = 2,
    duration: int = 200,
    out_path: str | None = None,
) -> str:
    """Slice a sprite sheet into frames and export an animated GIF; return its path.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("sprite_animation.slice_and_gif() lands in a later track (animation).")


def synthesize_continuation_grid(
    prev_sheet: str,
    template: str,
    rows: int,
    cols: int,
    *,
    line_width: int = 2,
) -> str:
    """Compose a continuation grid seeded from ``prev_sheet``; return the output path.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("sprite_animation.synthesize_continuation_grid() lands in a later track (animation).")


def image_difference(img1, img2) -> float:
    """Return a scalar difference metric between two images (0.0 == identical).

    STUB: implemented in a later track.
    """
    raise NotImplementedError("sprite_animation.image_difference() lands in a later track (animation).")


class AnimationStore:
    """Lightweight project manager persisting records to ``history.json``."""

    def __init__(self, root: str) -> None:
        """Create a store rooted at ``root`` (holds ``history.json``)."""
        self.root = Path(root)
        self.history_path = self.root / "history.json"
        self.records: list[dict] = []

    def add_record(self, record: dict) -> str:
        """Append ``record`` and return its assigned id.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("AnimationStore.add_record() lands in a later track (animation).")

    def update_record(self, record_id: str, patch: dict) -> dict:
        """Deep-merge ``patch`` into an existing record; return the updated record.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("AnimationStore.update_record() lands in a later track (animation).")

    def get_record(self, record_id: str) -> dict | None:
        """Return the record with ``record_id``, or ``None`` if absent.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("AnimationStore.get_record() lands in a later track (animation).")

    def get_last_record(self) -> dict | None:
        """Return the most recently added record, or ``None`` if empty.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("AnimationStore.get_last_record() lands in a later track (animation).")
