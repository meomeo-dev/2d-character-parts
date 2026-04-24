#!/usr/bin/env python3
"""
SiliconFlow Image Generation API Client

Generate images via SiliconFlow's REST API.
Requires env var SILICONFLOW_API_KEY or --api-key argument.

Usage:
    export SILICONFLOW_API_KEY=sk-xxx
    python3 scripts/siliconflow.py --prompt "a cat" --output parts/head.png
    python3 scripts/siliconflow.py --list-models
    python3 scripts/siliconflow.py --batch  # generate all 18 parts
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = "https://api.siliconflow.cn/v1"
ENDPOINT = f"{API_BASE}/images/generations"
MODELS_URL = f"{API_BASE}/models"


def get_api_key(args_key=None):
    key = args_key or os.environ.get("SILICONFLOW_API_KEY")
    if not key:
        print("❌ No API key found. Set SILICONFLOW_API_KEY env var or use --api-key.")
        sys.exit(1)
    return key


def list_models(api_key):
    """List available image generation models."""
    req = urllib.request.Request(MODELS_URL)
    req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            # Filter to image-related models
            for m in data.get("data", []):
                if "image" in m.get("type", "").lower() or any(
                    kw in m.get("id", "").lower() for kw in ["flux", "kolors", "qwen-image", "z-image-turbo", "kontext"]
                ):
                    print(f"  {m['id']}")
            return
    except Exception as e:
        print(f"❌ Failed to list models: {e}")
        sys.exit(1)


def generate(
    api_key,
    prompt,
    negative_prompt="",
    model="Qwen/Qwen-Image",
    image_size="1328x1328",
    seed=None,
    num_inference_steps=None,
    guidance_scale=None,
    output=None,
    ref_images=None,  # optional: [url, url, url] → image, image2, image3
):
    """Generate an image via SiliconFlow API and save to file.

    ref_images: list of up to 3 image URLs used as reference.
                Kolors supports 1 (→ image field).
                Qwen-Image-Edit-2509 supports up to 3 (→ image, image2, image3).
    """

    body = {
        "model": model,
        "prompt": prompt,
        "image_size": image_size,
    }

    if negative_prompt:
        body["negative_prompt"] = negative_prompt
    if seed is not None:
        body["seed"] = seed
    if num_inference_steps is not None:
        body["num_inference_steps"] = num_inference_steps
    if guidance_scale is not None:
        body["cfg"] = guidance_scale  # Qwen models use CFG
    if ref_images:
        for idx, ref_url in enumerate(ref_images[:3]):
            key = "image" if idx == 0 else f"image{idx + 1}"
            body[key] = ref_url

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"❌ HTTP {e.code}: {e.read().decode()}")
        return None
    except Exception as e:
        print(f"❌ Request failed: {e}")
        return None

    images = result.get("images", [])
    used_seed = result.get("seed", seed)
    timing = result.get("timings", {})

    if not images:
        print("⚠ No images returned")
        return None

    img_url = images[0].get("url", "")
    if not img_url:
        print("⚠ No URL in response")
        return None

    if output:
        _download(img_url, output)
        print(f"  ✓ Saved: {output} (seed={used_seed})")
    else:
        print(f"  URL: {img_url}")

    return {
        "url": img_url,
        "seed": used_seed,
        "output": str(output) if output else None,
        "timing": timing,
    }


def _download(url, output_path):
    """Download image from URL to local file."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(output_path, "wb") as f:
        f.write(resp.read())


def main():
    parser = argparse.ArgumentParser(description="SiliconFlow Image Generator")
    parser.add_argument("--prompt", help="Text prompt")
    parser.add_argument("--negative-prompt", default="", help="Negative prompt")
    parser.add_argument("--model", default="Qwen/Qwen-Image", help="Model name (default: Qwen/Qwen-Image)")
    parser.add_argument("--image-size", default="1328x1328", help="Image size (e.g. 1328x1328, 928x1664 for Qwen)")
    parser.add_argument("--seed", type=int, default=None, help="Random seed")
    parser.add_argument("--steps", type=int, default=None, help="Inference steps")
    parser.add_argument("--cfg", type=float, default=None, help="Guidance scale (CFG)")
    parser.add_argument("--output", help="Output file path")
    parser.add_argument("--api-key", help="SiliconFlow API key (or set SILICONFLOW_API_KEY)")
    parser.add_argument("--list-models", action="store_true", help="List available models")
    parser.add_argument("--batch", action="store_true", help="Generate all 18 parts using character_profile.json")
    args = parser.parse_args()

    api_key = get_api_key(args.api_key)

    if args.list_models:
        list_models(api_key)
        return

    if args.batch:
        # DAG pipeline: read profile + layout, generate stage by stage
        script_dir = Path(__file__).resolve().parent.parent
        sys.path.insert(0, str(script_dir / "scripts"))
        from generate_prompts import build_global_subject, build_part_subject, build_positive, get_all_parts, load_json

        config = load_json(script_dir / "config" / "parts_layout.json")
        profile = load_json(script_dir / "config" / "character_profile.json")
        parts = get_all_parts(config)
        part_by_id = {p["id"]: p for p in parts}
        p = profile["presets"]
        parts_dir = script_dir / "parts"
        parts_dir.mkdir(exist_ok=True)

        pipeline = config.get("pipeline")
        if not pipeline:
            print("❌ No pipeline defined in parts_layout.json")
            sys.exit(1)

        total_stages = len(pipeline)
        total_parts = sum(len(s["parts"]) for s in pipeline)
        done = 0

        print(f"\n  ⚙ Pipeline: {total_stages} stages, {total_parts} parts\n")

        for stage in pipeline:
            stage_idx = stage["stage"]
            stage_label = stage["label"]
            stage_ids = stage["parts"]

            # Stage header
            bar = "━" * 55
            print(f"\n{bar}")
            print(f"  Stage {stage_idx}: {stage_label}  ({len(stage_ids)} parts)")
            print(f"{bar}")

            for pid in stage_ids:
                if pid == "global_reference":
                    subject = build_global_subject(profile)
                    positive = build_positive(subject, profile)
                    img_size = "928x1664"
                elif pid in part_by_id:
                    part = part_by_id[pid]
                    label = f"{part['label_cn']}"
                    if part.get("label_en"):
                        label += f" / {part['label_en']}"
                    subject = build_part_subject(part, profile)
                    positive = build_positive(subject, profile)
                    img_size = "1328x1328"
                else:
                    print(f"  ⚠ Unknown part: {pid} — skipping")
                    continue

                out = parts_dir / f"{pid}.png"
                result = generate(
                    api_key, positive, p["negative"], args.model, img_size, args.seed, args.steps, args.cfg, str(out)
                )

                if result is None:
                    print(f"\n  ❌ Stage {stage_idx} failed at '{pid}' — stopping pipeline.")
                    print("     Downstream stages skipped.")
                    return

                done += 1

        print(f"\n{'═' * 55}")
        print(f"  ✅ Pipeline complete: {done}/{total_parts} parts generated")
        print(f"{'═' * 55}\n")

    if not args.prompt:
        parser.print_help()
        print("\nProvide --prompt or --batch to generate.")
        sys.exit(1)

    generate(
        api_key,
        args.prompt,
        args.negative_prompt,
        args.model,
        args.image_size,
        args.seed,
        args.steps,
        args.cfg,
        args.output,
    )


if __name__ == "__main__":
    main()
