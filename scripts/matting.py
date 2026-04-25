#!/usr/bin/env python3
"""
Triangulation Matting — Dual-pass alphamatte for 2D character sprites.

Background-removal algorithm that derives a true alpha channel from a
white-background + black-background image pair of the same subject.

Algorithm:
  White-bg pixel: C_white = α × C_fg + (1-α) × 1.0
  Black-bg pixel: C_black = α × C_fg + (1-α) × 0.0

  Subtract:  C_white - C_black = (1-α) × (1.0 - 0.0) = 1 - α
  Therefore: α = 1 - (C_white - C_black)

  Foreground: C_fg = C_black / α   (with safe division)

References:
  Smith & Blinn, "Blue Screen Matting" (SIGGRAPH 96)
  nano-banana-2-transparent (Replicate community model)

Usage:
  from scripts.matting import triangulation_matting
  triangulation_matting("parts/head_white.png", "parts/head_black.png", "parts/head.png")
"""

from pathlib import Path

try:
    from PIL import Image

    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False


def triangulation_matting(white_path, black_path, output_path):
    """
    Produce an RGBA PNG with true alpha channel from a white-bg + black-bg pair.

    Args:
        white_path: Path to the white-background image (PNG).
        black_path: Path to the black-background image (PNG).
        output_path: Path to save the resulting RGBA PNG.

    Returns:
        True on success, False on failure.
    """
    if not HAS_PIL:
        print("❌ Pillow (PIL) is required. Install with: pip install Pillow")
        return False

    white_path = Path(white_path)
    black_path = Path(black_path)
    output_path = Path(output_path)

    if not white_path.exists():
        print(f"❌ White image not found: {white_path}")
        return False
    if not black_path.exists():
        print(f"❌ Black image not found: {black_path}")
        return False

    white = Image.open(white_path).convert("RGB")
    black = Image.open(black_path).convert("RGB")

    # Resize black to match white dimensions if needed
    if white.size != black.size:
        black = black.resize(white.size, Image.LANCZOS)

    result = _matting_numpy(white, black) if HAS_NUMPY else _matting_pure_pil(white, black)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, "PNG")
    return True


def _matting_numpy(white, black):
    """Fast path using numpy vectorized operations."""
    w_arr = np.array(white, dtype=np.float32) / 255.0
    b_arr = np.array(black, dtype=np.float32) / 255.0

    # α = 1 - (C_white - C_black) per channel, clamp to [0, 1]
    alpha_per_channel = 1.0 - (w_arr - b_arr)
    alpha_per_channel = np.clip(alpha_per_channel, 0.0, 1.0)

    # Use max alpha across RGB channels for robustness
    alpha = np.max(alpha_per_channel, axis=2)

    # C_fg = C_black / α
    safe_alpha = np.where(alpha > 0.005, alpha, 1.0)
    foreground = b_arr / safe_alpha[:, :, np.newaxis]
    foreground = np.clip(foreground, 0.0, 1.0)

    # Assemble RGBA
    h, w = alpha.shape
    result = np.zeros((h, w, 4), dtype=np.uint8)
    result[:, :, :3] = (foreground * 255).astype(np.uint8)
    result[:, :, 3] = (alpha * 255).astype(np.uint8)

    # Zero out fully-transparent pixels to avoid noise
    transparent_mask = alpha < 0.01
    result[transparent_mask, :] = 0

    return Image.fromarray(result, "RGBA")


def _matting_pure_pil(white, black):
    """Fallback path using pure Python + Pillow pixel iteration."""
    wpix = white.load()
    bpix = black.load()
    w, h = white.size

    result = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    rpix = result.load()

    for y in range(h):
        for x in range(w):
            wr, wg, wb = wpix[x, y]
            br, bg, bb = bpix[x, y]

            # α per channel
            ar = max(0.0, min(1.0, 1.0 - (wr - br) / 255.0))
            ag = max(0.0, min(1.0, 1.0 - (wg - bg) / 255.0))
            ab = max(0.0, min(1.0, 1.0 - (wb - bb) / 255.0))

            # Use max alpha across channels
            alpha = max(ar, ag, ab)

            if alpha > 0.005:
                inv_a = 1.0 / alpha
                fr = max(0, min(255, int(br * inv_a)))
                fg = max(0, min(255, int(bg * inv_a)))
                fb = max(0, min(255, int(bb * inv_a)))
                fa = max(0, min(255, int(alpha * 255)))
                rpix[x, y] = (fr, fg, fb, fa)
            else:
                rpix[x, y] = (0, 0, 0, 0)

    return result


def has_matting_support():
    """Check if dependencies for matting are available."""
    return HAS_PIL
