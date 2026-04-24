#!/usr/bin/env python3
"""
2D Character Parts — Parts Composer

Assembles individual part images (PNG) into a complete character sprite
according to the exploded view layout coordinates.

Workflow:
  1. Place AI-generated part images in parts/<part_id>.png
  2. Run this script to compose the full sprite
  3. Output appears as parts/character_composite.png

Usage:
    python scripts/compose_parts.py [--output parts/character_composite.png]
"""

import argparse
import json
from pathlib import Path

try:
    from PIL import Image

    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def load_config(path="config/parts_layout.json"):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def compose(config, parts_dir, output_path):
    if not HAS_PIL:
        print("❌ Pillow (PIL) is required. Install with: pip install Pillow")
        return False

    cw = config["meta"]["canvas_width"]
    ch = config["meta"]["canvas_height"]
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))

    found_any = False
    for group in config["groups"]:
        for part in group["parts"]:
            pid = part["id"]
            img_path = parts_dir / f"{pid}.png"
            if not img_path.exists():
                continue
            try:
                img = Image.open(img_path).convert("RGBA")
                img_resized = img.resize((part["w"], part["h"]), Image.LANCZOS)
                canvas.paste(img_resized, (part["x"], part["y"]), img_resized)
                print(f"  ✓ {pid} → ({part['x']}, {part['y']})")
                found_any = True
            except Exception as e:
                print(f"  ✗ {pid}: {e}")

    if not found_any:
        print("⚠ No parts found in parts/ directory.")
        print(f"  Place PNG files named like: {parts_dir}/<part_id>.png")
        print("  Available part IDs:")
        for group in config["groups"]:
            for part in group["parts"]:
                print(f"    - {part['id']} ({part['label'].split(chr(10))[0]})")
        return False

    canvas.save(output_path)
    print(f"\n✅ Composite saved: {output_path}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Compose parts into full character sprite")
    parser.add_argument("--config", default="config/parts_layout.json", help="Parts layout config path")
    parser.add_argument("--parts-dir", default="parts", help="Directory with part PNGs")
    parser.add_argument("--output", default="parts/character_composite.png", help="Output composite PNG path")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent.parent
    config_path = script_dir / args.config
    parts_dir = script_dir / args.parts_dir
    output_path = script_dir / args.output

    config = load_config(config_path)
    compose(config, parts_dir, output_path)


if __name__ == "__main__":
    main()
