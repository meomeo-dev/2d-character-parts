#!/usr/bin/env python3
"""
OpenRouter Image Generation API Client

Generate images via OpenRouter's unified /chat/completions endpoint.
Supports two modes:
  - Native Image (seedream, flux): prompt + modalities: ["image"]
  - Chat Image (gemini): messages + modalities: ["image", "text"]

Requires env var OPENROUTER_API_KEY or --api-key argument.

Usage:
    export OPENROUTER_API_KEY=sk-or-xxx
    python3 scripts/openrouter.py --prompt "a cat" --output parts/head.png
    python3 scripts/openrouter.py --list-models
    python3 scripts/openrouter.py --batch  # generate all 19 parts via DAG pipeline
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = "https://openrouter.ai/api/v1"
ENDPOINT = f"{API_BASE}/chat/completions"
MODELS_URL = f"{API_BASE}/models"

# ── Model classification ──────────────────────────────────
NATIVE_MODELS = ["seedream", "flux", "janus"]  # use prompt + modalities
# gemini / chat models use messages + modalities


def is_native_model(model):
    """True if this model uses the native prompt+modalities format."""
    return any(kw in model.lower() for kw in NATIVE_MODELS)


def is_chat_model(model):
    """True if this model uses the messages+modalities format."""
    return not is_native_model(model)


def get_api_key(args_key=None):
    key = args_key or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("❌ No API key found. Set OPENROUTER_API_KEY env var or use --api-key.")
        sys.exit(1)
    return key


def list_models(api_key=None):
    """List available image generation models from OpenRouter."""
    url = f"{MODELS_URL}?output_modalities=image"
    req = urllib.request.Request(url)
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            models = data.get("data", [])
            print(f"\n  Image-capable models ({len(models)}):\n")
            for m in models:
                m_id = m.get("id", "?")
                m_desc = m.get("description", "")
                # Truncate description
                desc_short = (m_desc[:100] + "...") if len(m_desc) > 100 else m_desc
                print(f"  {m_id}")
                if desc_short:
                    print(f"    {desc_short}")
                print()
            return models
    except Exception as e:
        print(f"❌ Failed to list models: {e}")
        sys.exit(1)


def _ref_image_to_data_url(ref_src):
    """Convert a reference image (URL or local path) to a data URL string."""
    if isinstance(ref_src, str) and ref_src.startswith("data:"):
        return ref_src  # already a data URL

    if isinstance(ref_src, str) and (ref_src.startswith("http://") or ref_src.startswith("https://")):
        # Download remote image and convert to base64
        try:
            dreq = urllib.request.Request(ref_src, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(dreq, timeout=30) as resp:
                img_data = resp.read()
                ct = resp.headers.get("Content-Type", "image/png")
                b64 = base64.b64encode(img_data).decode("utf-8")
                return f"data:{ct};base64,{b64}"
        except Exception as e:
            print(f"  ⚠ Failed to download ref image {ref_src}: {e}")
            return None

    # Local file path
    path = Path(ref_src)
    if path.exists():
        ext = path.suffix.lower()
        mime = "image/png" if ext == ".png" else "image/jpeg"
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        return f"data:{mime};base64,{b64}"

    print(f"  ⚠ Ref image not found: {ref_src}")
    return None


def generate(
    api_key,
    prompt,
    model="google/gemini-3.1-flash-image-preview",
    aspect_ratio="1:1",
    image_size="1K",
    output=None,
    ref_images=None,  # optional: list of paths/URLs/data-URLs
):
    """Generate an image via OpenRouter API and save to file.

    ref_images: list of up to N image paths/URLs/data-URLs.
                Passed as image_url entries in messages[].content[].
    """
    body = {
        "model": model,
        "image_config": {
            "aspect_ratio": aspect_ratio,
            "image_size": image_size,
        },
    }

    # Build ref image content blocks (for both native and chat modes)
    ref_contents = []
    if ref_images:
        for ref_src in ref_images:
            data_url = _ref_image_to_data_url(ref_src)
            if data_url:
                ref_contents.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    }
                )

    if is_native_model(model):
        body["modalities"] = ["image"]
        body["messages"] = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    *ref_contents,
                ],
            }
        ]
        if ref_contents:
            body["modalities"] = ["image", "text"]
    else:
        # Chat mode (gemini, etc.) — must use messages
        body["modalities"] = ["image", "text"]
        content_blocks = [
            {"type": "text", "text": prompt},
        ]
        # Add reference images
        content_blocks.extend(ref_contents)
        body["messages"] = [
            {
                "role": "user",
                "content": content_blocks,
            }
        ]

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"❌ HTTP {e.code}: {err_body}")
        return None
    except Exception as e:
        print(f"❌ Request failed: {e}")
        return None

    choices = result.get("choices", [])
    if not choices:
        print("⚠ No choices in response")
        return None

    msg = choices[0].get("message", {})
    images = msg.get("images", [])
    text_content = msg.get("content", "")

    if not images:
        print(f"⚠ No images in response. Text content: {text_content[:200]}")
        return None

    # Extract base64 data URL from the first image
    img_url = images[0].get("image_url", {}).get("url", "")
    if not img_url:
        print("⚠ No image_url in response")
        return None

    # Decode and save
    if output and img_url.startswith("data:"):
        # data:image/png;base64,<data>
        header, b64data = img_url.split(",", 1)
        img_bytes = base64.b64decode(b64data)
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        with open(output, "wb") as f:
            f.write(img_bytes)
        print(f"  ✓ Saved: {output}")
    elif output and img_url.startswith("http"):
        _download(img_url, output)
        print(f"  ✓ Saved: {output}")
    elif output:
        print(f"  ⚠ Unknown image format, raw: {img_url[:100]}...")
        return None
    else:
        print(f"  Data URL (first 80 chars): {img_url[:80]}...")

    # Extract seed/usage if available
    usage = result.get("usage", {})
    seed = result.get("seed", "N/A")

    return {
        "url": img_url[:80] + "..." if len(img_url) > 80 else img_url,
        "output": str(output) if output else None,
        "seed": seed,
        "usage": usage,
    }


def _download(url, output_path):
    """Download image from URL to local file."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(output_path, "wb") as f:
        f.write(resp.read())


# ── DAG Model Strategy ────────────────────────────────────
DAG_MODELS = {
    0: "bytedance-seed/seedream-4.5",  # t2i, no refs
    # Stages 1-5 use gemini with reference images
    "default_ref": "google/gemini-3.1-flash-image-preview",
}


def get_stage_model(stage_idx, has_refs):
    """Return the model to use for a given pipeline stage."""
    if stage_idx == 0:
        return DAG_MODELS[0]
    if has_refs:
        return DAG_MODELS["default_ref"]
    return DAG_MODELS[0]


def main():
    parser = argparse.ArgumentParser(description="OpenRouter Image Generator")
    parser.add_argument("--prompt", help="Text prompt")
    parser.add_argument("--model", default="google/gemini-3.1-flash-image-preview", help="Model name")
    parser.add_argument("--aspect-ratio", default="1:1", help="Aspect ratio (1:1, 9:16, 16:9, etc.)")
    parser.add_argument("--image-size", default="1K", help="Image size (1K, 2K, 4K)")
    parser.add_argument("--output", help="Output file path")
    parser.add_argument("--api-key", help="OpenRouter API key (or set OPENROUTER_API_KEY)")
    parser.add_argument("--list-models", action="store_true", help="List image models")
    parser.add_argument(
        "--batch", action="store_true", help="Generate all parts using DAG pipeline from parts_layout.json"
    )
    parser.add_argument("--ref", action="append", default=None, help="Reference image path/URL (repeatable)")
    args = parser.parse_args()

    if args.list_models:
        api_key = args.api_key or os.environ.get("OPENROUTER_API_KEY")
        list_models(api_key)
        return

    if args.batch:
        api_key = get_api_key(args.api_key)
        script_dir = Path(__file__).resolve().parent.parent
        sys.path.insert(0, str(script_dir / "scripts"))
        from generate_prompts import build_global_subject, build_part_subject, build_positive, get_all_parts, load_json

        config = load_json(script_dir / "config" / "parts_layout.json")
        profile = load_json(script_dir / "config" / "character_profile.json")
        parts = get_all_parts(config)
        part_by_id = {p["id"]: p for p in parts}
        parts_dir = script_dir / "parts"
        parts_dir.mkdir(exist_ok=True)

        pipeline = config.get("pipeline")
        if not pipeline:
            print("❌ No pipeline defined in parts_layout.json")
            sys.exit(1)

        total_stages = len(pipeline)
        total_parts = sum(len(s["parts"]) for s in pipeline)
        done = 0

        print(f"\n  ⚙ Pipeline: {total_stages} stages, {total_parts} parts")
        print("  Backend: OpenRouter\n")

        # Track stage outputs for building refs
        stage_outputs = {}

        for stage in pipeline:
            stage_idx = stage["stage"]
            stage_label = stage["label"]
            stage_ids = stage["parts"]
            stage_name = stage["name"]

            bar = "━" * 55
            print(f"\n{bar}")
            has_refs = bool(stage.get("depends_on"))
            model = get_stage_model(stage_idx, has_refs)
            mode = "native" if is_native_model(model) else "chat"
            print(f"  Stage {stage_idx}: {stage_label}  ({len(stage_ids)} parts)  [{model}] {mode}")
            print(f"{bar}")

            # Build reference images from dependencies
            ref_images = []
            if stage.get("depends_on"):
                for dep_name in stage["depends_on"]:
                    dep_parts = stage_outputs.get(dep_name, [])
                    for dpid in dep_parts:
                        ref_path = parts_dir / f"{dpid}.png"
                        if ref_path.exists():
                            ref_images.append(str(ref_path))

            for pid in stage_ids:
                if pid == "global_reference":
                    subject = build_global_subject(profile)
                    positive = build_positive(subject, profile)
                    ar = "9:16"
                    img_size = "2K"
                elif pid in part_by_id:
                    part = part_by_id[pid]
                    label = part["label_cn"]
                    if part.get("label_en"):
                        label += f" / {part['label_en']}"
                    subject = build_part_subject(part, profile)
                    positive = build_positive(subject, profile)
                    ar = "1:1"
                    img_size = "1K"
                else:
                    print(f"  ⚠ Unknown part: {pid} — skipping")
                    continue

                out = parts_dir / f"{pid}.png"
                active_refs = ref_images if (pid != "global_reference" and ref_images) else None

                result = generate(
                    api_key,
                    positive,
                    model=model,
                    aspect_ratio=ar,
                    image_size=img_size,
                    output=str(out),
                    ref_images=active_refs,
                )

                if result is None:
                    print(f"\n  ❌ Stage {stage_idx} failed at '{pid}' — stopping pipeline.")
                    print("     Downstream stages skipped.")
                    return

                done += 1

            # Record stage outputs for downstream refs
            stage_outputs[stage_name] = stage_ids

        print(f"\n{'═' * 55}")
        print(f"  ✅ Pipeline complete: {done}/{total_parts} parts generated")
        print(f"{'═' * 55}\n")
        return

    if not args.prompt:
        parser.print_help()
        print("\nProvide --prompt, --batch, or --list-models.")
        sys.exit(1)

    api_key = get_api_key(args.api_key)
    generate(
        api_key,
        args.prompt,
        model=args.model,
        aspect_ratio=args.aspect_ratio,
        image_size=args.image_size,
        output=args.output,
        ref_images=args.ref,
    )


if __name__ == "__main__":
    main()
