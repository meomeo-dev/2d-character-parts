#!/usr/bin/env python3
"""
2D Character Parts — Grid Catalog SVG Template Generator

Generates a clean engineering-style SVG grid catalog of the parts layout.
Parts are arranged in a rectangular grid (not human silhouette), with cell
sizes proportional to each part's real dimensions.

Usage:
    python scripts/generate_template.py [--output templates/exploded_view.svg]
"""

import argparse
import json
from pathlib import Path


def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def compute_group_bbox(parts):
    """Compute bounding box that encloses all parts in a group."""
    xs = [p["x"] for p in parts]
    ys = [p["y"] for p in parts]
    xe = [p["x"] + p["w"] for p in parts]
    ye = [p["y"] + p["h"] for p in parts]
    return min(xs), min(ys), max(xe), max(ye)


def generate_svg(config):
    w = config["meta"]["canvas_width"]
    h = config["meta"]["canvas_height"]
    groups = config["groups"]

    lines = []
    lines.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">')
    lines.append(f'  <rect width="{w}" height="{h}" fill="white"/>')

    # Title
    lines.append(
        f'  <text x="{w // 2}" y="20" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#999">2D Character Parts — Grid Catalog</text>'
    )

    # --- Global reference slot ---
    slot = config.get("global_ref_slot")
    if slot:
        sx, sy, sw, sh = slot["x"], slot["y"], slot["w"], slot["h"]
        lines.append(
            f'  <rect x="{sx}" y="{sy}" width="{sw}" height="{sh}" '
            f'fill="#eef6ff" stroke="#4a90d9" stroke-width="2" rx="4" ry="4"/>'
        )
        lines.append(
            f'  <text x="{sx + sw // 2}" y="{sy + sh // 2 - 8}" text-anchor="middle" '
            f'font-family="sans-serif" font-size="11" fill="#4a90d9">'
            f"{slot.get('label', 'Global Reference')}</text>"
        )
        lines.append(
            f'  <text x="{sx + sw // 2}" y="{sy + sh // 2 + 10}" text-anchor="middle" '
            f'font-family="sans-serif" font-size="9" fill="#888">9:16</text>'
        )

    # Groups that get a labeled bounding box
    groups_with_label = {"expressions", "upper_limbs", "lower_limbs"}

    # First pass: draw group bounding boxes
    for group in groups:
        gid = group["id"]
        gname = group["label"]
        parts = group["parts"]
        if gid not in groups_with_label or len(parts) < 1:
            continue

        x1, y1, x2, y2 = compute_group_bbox(parts)
        pad = 8
        lines.append(
            f'  <rect x="{x1 - pad}" y="{y1 - pad - 14}" width="{(x2 - x1) + pad * 2}" height="{(y2 - y1) + pad * 2 + 14}" '
            f'rx="5" ry="5" fill="none" stroke="#aaa" stroke-width="1" stroke-dasharray="5,3"/>'
        )
        lines.append(
            f'  <text x="{x1}" y="{y1 - pad - 2}" font-family="sans-serif" font-size="10" fill="#888">{gname}</text>'
        )

    # Second pass: draw all parts
    for group in groups:
        for part in group["parts"]:
            px, py, pw, ph = part["x"], part["y"], part["w"], part["h"]
            label = part["label"]

            # Dashed diagonal lines
            lines.append(
                f'  <line x1="{px}" y1="{py}" x2="{px + pw}" y2="{py + ph}" '
                f'stroke="#ddd" stroke-width="0.8" stroke-dasharray="3,3"/>'
            )
            lines.append(
                f'  <line x1="{px + pw}" y1="{py}" x2="{px}" y2="{py + ph}" '
                f'stroke="#ddd" stroke-width="0.8" stroke-dasharray="3,3"/>'
            )

            # Frame border
            lines.append(
                f'  <rect x="{px}" y="{py}" width="{pw}" height="{ph}" '
                f'fill="#f7f7f7" stroke="#333" stroke-width="1.5"/>'
            )

            # Label text (centered, multi-line)
            text_lines = label.split("\n")
            line_count = len(text_lines)
            start_y = py + ph // 2 - (line_count - 1) * 8
            for i, tl in enumerate(text_lines):
                ty = start_y + i * 16
                if ty > py + ph - 4:
                    break
                lines.append(
                    f'  <text x="{px + pw // 2}" y="{ty}" '
                    f'text-anchor="middle" font-family="SimSun, serif" font-size="10" fill="#333">{tl}</text>'
                )

    lines.append("</svg>")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate grid catalog SVG template")
    parser.add_argument("--config", default="config/parts_layout.json", help="Path to parts layout config")
    parser.add_argument("--output", default="templates/exploded_view.svg", help="Output SVG path")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent.parent
    config_path = script_dir / args.config
    output_path = script_dir / args.output

    config = load_config(config_path)
    svg = generate_svg(config)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(svg)

    print(f"✅ Template generated: {output_path.relative_to(script_dir)}")


if __name__ == "__main__":
    main()
