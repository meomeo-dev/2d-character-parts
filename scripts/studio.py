#!/usr/bin/env python3
"""
2D Character Parts — Studio Server

Local HTTP server with OpenRouter / SiliconFlow API integration.
Provides a canvas UI for editing prompts and generating images.

Usage:
    export OPENROUTER_API_KEY=sk-or-xxx
    python3 scripts/studio.py              # http://localhost:8765  (default: openrouter)
    python3 scripts/studio.py --backend siliconflow
    python3 scripts/studio.py --port 8080
    python3 scripts/studio.py --model google/gemini-3.1-flash-image-preview
"""

import argparse
import base64
import importlib
import json
import os
import sys
import urllib.request
from collections.abc import Callable
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

# Ensure scripts dir is in path for importing sibling modules
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from generate_prompts import (
    build_global_subject,
    build_part_exclusions,
    build_part_subject,
    build_positive,
    get_all_parts,
    load_json,
)
from matting import triangulation_matting

# ── Globals set from CLI args ──────────────────────────
API_KEY = ""
BACKEND = "openrouter"  # "openrouter" | "siliconflow"
MODEL = "google/gemini-3.1-flash-image-preview"

SILICONFLOW_API = "https://api.siliconflow.cn/v1/images/generations"
OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions"

# ── Extensible route registry ──────────────────────────
# Feature tracks add API routes by registering handlers here instead of editing
# do_GET / do_POST. A handler has the signature ``handler(h, parsed) -> None``
# where ``h`` is the StudioHandler instance and ``parsed`` is the urlparse result.
EXTRA_GET_ROUTES: dict[str, Callable] = {}
EXTRA_POST_ROUTES: dict[str, Callable] = {}

# Optional feature-route modules, imported at startup. Each must expose
# ``register(get_map, post_map)``. Missing modules are created by later tracks.
FEATURE_ROUTE_MODULES = ["chat_routes", "animation_routes", "jina_routes"]


def _load_feature_routes():
    """Import optional feature-route modules and let each register its handlers.

    Modules absent (ImportError) or without a ``register`` attribute
    (AttributeError) are skipped silently.
    """
    for name in FEATURE_ROUTE_MODULES:
        try:
            module = importlib.import_module(name)
            module.register(EXTRA_GET_ROUTES, EXTRA_POST_ROUTES)
        except (ImportError, AttributeError):
            continue


# ── Helpers ─────────────────────────────────────────────


def _save_binary(output_path, data):
    """Save binary data to a Path, creating parent directories as needed."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(data)


def _download_to_path(url, output_path, timeout=60):
    """Download a URL and save to a Path."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        _save_binary(output_path, resp.read())


# ── OpenRouter model classification ────────────────────
NATIVE_KEYWORDS = ["seedream", "flux", "janus"]

# DAG model strategy
DAG_ROOT_MODEL = "bytedance-seed/seedream-4.5"  # stage 0: t2i
DAG_REF_MODEL = "google/gemini-3.1-flash-image-preview"  # stage 1-5: with refs


def is_native_model(model):
    return any(kw in model.lower() for kw in NATIVE_KEYWORDS)


def image_to_data_url(filepath):
    """Read a local image and return a data: URL."""
    path = Path(filepath)
    if not path.exists():
        return None
    ext = path.suffix.lower()
    mime = "image/png" if ext == ".png" else "image/jpeg"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{b64}"


def build_openrouter_body(
    positive, negative, image_size, seed, ref_images, model, aspect_ratio=None, image_size_or=None
):
    """Build OpenRouter request body (native or chat mode)."""
    # Map image_size string to aspect_ratio + image_size params
    # Allow explicit overrides from frontend
    if aspect_ratio:
        pass  # use as-is
    elif image_size == "928x1664":
        aspect_ratio = "9:16"
    else:
        aspect_ratio = "1:1"

    if image_size_or:
        pass  # use as-is
    elif image_size == "928x1664":
        image_size_or = "2K"
    else:
        image_size_or = "1K"

    body = {
        "model": model,
        "image_config": {
            "aspect_ratio": aspect_ratio,
            "image_size": image_size_or,
        },
    }

    # Build reference image content blocks
    ref_contents = []
    if ref_images and isinstance(ref_images, list):
        for ref_src in ref_images[:5]:  # support up to 5 refs
            if isinstance(ref_src, str) and ref_src.startswith("/parts/"):
                local_path = PROJECT_DIR / ref_src.lstrip("/")
                data_url = image_to_data_url(str(local_path))
                if data_url:
                    ref_contents.append(
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url},
                        }
                    )
            elif isinstance(ref_src, str) and ref_src.startswith("data:"):
                ref_contents.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": ref_src},
                    }
                )

    if is_native_model(model):
        body["modalities"] = ["image"]
        body["messages"] = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": positive},
                    *ref_contents,
                ],
            }
        ]
        if ref_contents:
            body["modalities"] = ["image", "text"]
    else:
        # Chat mode (gemini)
        body["modalities"] = ["image", "text"]
        content_blocks = [{"type": "text", "text": positive}]
        content_blocks.extend(ref_contents)
        body["messages"] = [
            {
                "role": "user",
                "content": content_blocks,
            }
        ]

    if negative:
        body["negative_prompt"] = negative
    if seed is not None:
        body["seed"] = int(seed)

    return body


def build_siliconflow_body(positive, negative, image_size, seed, ref_images, model):
    """Build SiliconFlow request body."""
    body = {
        "model": model or "Qwen/Qwen-Image",
        "prompt": positive,
        "image_size": image_size,
    }
    if negative:
        body["negative_prompt"] = negative
    if seed is not None:
        body["seed"] = int(seed)

    if ref_images and isinstance(ref_images, list):
        for idx, ref_src in enumerate(ref_images[:3]):
            key = "image" if idx == 0 else f"image{idx + 1}"
            if isinstance(ref_src, str) and ref_src.startswith("/parts/"):
                local_path = PROJECT_DIR / ref_src.lstrip("/")
                if local_path.exists():
                    ext = local_path.suffix.lower()
                    mime = "image/png" if ext == ".png" else "image/jpeg"
                    with open(local_path, "rb") as bf:
                        b64 = base64.b64encode(bf.read()).decode("utf-8")
                    body[key] = f"data:{mime};base64,{b64}"
            else:
                body[key] = ref_src
    return body


class StudioHandler(SimpleHTTPRequestHandler):
    """HTTP handler that routes API calls and serves static files."""

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/config":
            self._json_response(load_json(PROJECT_DIR / "config" / "parts_layout.json"))
        elif path == "/api/profile":
            self._json_response(load_json(PROJECT_DIR / "config" / "character_profile.json"))
        elif path == "/api/prompts":
            self._send_prompts()
        elif path == "/api/parts":
            self._list_parts()
        elif path == "/api/models":
            self._send_models()
        elif path == "/api/model-list":
            self._send_model_list()
        elif path.startswith("/parts/") and self.path.endswith(".png"):
            self._serve_part_image()
        elif path == "/" or path == "":
            self.path = "/templates/studio.html"
            super().do_GET()
        else:
            # Feature-track routes take precedence over static file serving.
            route_handler = EXTRA_GET_ROUTES.get(parsed.path)
            if route_handler is not None:
                route_handler(self, parsed)
            else:
                super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/generate":
            self._handle_generate()
        elif parsed.path == "/api/matting":
            self._handle_matting()
        elif parsed.path == "/api/prompts":
            self._send_prompts_post()
        elif parsed.path == "/api/settings":
            self._handle_settings()
        else:
            # Feature-track routes are consulted before returning 404.
            route_handler = EXTRA_POST_ROUTES.get(parsed.path)
            if route_handler is not None:
                route_handler(self, parsed)
            else:
                self.send_error(404)

    # ── API handlers ────────────────────────────────────

    def _json_response(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_prompts(self):
        profile = load_json(PROJECT_DIR / "config" / "character_profile.json")
        self._json_response(self._build_prompts(profile))

    def _list_parts(self):
        config = load_json(PROJECT_DIR / "config" / "parts_layout.json")
        parts_dir = PROJECT_DIR / "parts"
        parts_dir.mkdir(exist_ok=True)
        existing = {f.stem for f in parts_dir.glob("*.png")}
        parts = get_all_parts(config)
        result = [{"id": p["id"], "label_cn": p["label_cn"], "generated": p["id"] in existing} for p in parts]
        self._json_response(result)

    def _send_models(self):
        """Return the model strategy info for the current backend."""
        if BACKEND == "openrouter":
            self._json_response(
                {
                    "backend": "openrouter",
                    "root_model": DAG_ROOT_MODEL,
                    "ref_model": DAG_REF_MODEL,
                    "api_endpoint": OPENROUTER_API,
                }
            )
        else:
            self._json_response(
                {
                    "backend": "siliconflow",
                    "root_model": MODEL or "Qwen/Qwen-Image",
                    "ref_model": "Kwai-Kolors/Kolors",
                    "api_endpoint": SILICONFLOW_API,
                }
            )

    def _send_model_list(self):
        """Fetch available image models from OpenRouter."""
        if BACKEND == "openrouter":
            url = "https://openrouter.ai/api/v1/models?output_modalities=image"
            req = urllib.request.Request(url)
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read())
                    models = [
                        {
                            "id": m.get("id", ""),
                            "name": m.get("name", m.get("id", "")),
                            "description": m.get("description", ""),
                        }
                        for m in data.get("data", [])
                    ]
                    self._json_response({"models": models})
            except Exception as e:
                self._json_response(
                    {
                        "error": f"Failed to fetch models: {e}",
                        "models": [
                            {"id": DAG_ROOT_MODEL, "name": "Seedream 4.5"},
                            {"id": DAG_REF_MODEL, "name": "Gemini 3.1 Flash Image"},
                            {"id": "black-forest-labs/flux.2-pro", "name": "FLUX.2 Pro"},
                            {"id": "openai/gpt-5-image", "name": "GPT-5 Image"},
                        ],
                    },
                    200,
                )
        else:
            self._json_response(
                {
                    "models": [
                        {"id": "Qwen/Qwen-Image", "name": "Qwen Image"},
                        {"id": "Kwai-Kolors/Kolors", "name": "Kolors"},
                        {"id": "black-forest-labs/FLUX.1-schnell", "name": "FLUX.1 schnell"},
                    ]
                }
            )

    def _build_prompts(self, profile, root_model=None, ref_model=None):
        """Build global + part prompts from a profile dict."""
        _root = root_model or DAG_ROOT_MODEL
        _ref = ref_model or DAG_REF_MODEL

        config = load_json(PROJECT_DIR / "config" / "parts_layout.json")
        parts = get_all_parts(config)

        global_subject = build_global_subject(profile)
        global_positive = build_positive(global_subject, profile)

        pipeline = config.get("pipeline", [])
        stage_models = {}
        for s in pipeline:
            stage_idx = s["stage"]
            has_refs = bool(s.get("depends_on"))
            if stage_idx == 0:
                stage_models[str(stage_idx)] = _root
            elif has_refs:
                stage_models[str(stage_idx)] = _ref
            else:
                stage_models[str(stage_idx)] = MODEL

        part_stage = {}
        for s in pipeline:
            for pid in s["parts"]:
                part_stage[pid] = s["stage"]

        part_prompts = []
        for p in parts:
            subject = build_part_subject(p, profile)
            positive = build_positive(subject, profile)
            # Append part-specific mutual exclusions to negative prompt
            extra_neg = build_part_exclusions(p["id"])
            full_negative = profile["presets"]["negative"]
            if extra_neg:
                full_negative = full_negative + ", " + ", ".join(extra_neg)
            sid = part_stage.get(p["id"], -1)
            sm = stage_models.get(str(sid), MODEL) if sid >= 0 else MODEL
            part_prompts.append(
                {
                    "id": p["id"],
                    "label_cn": p["label_cn"],
                    "label_en": p["label_en"],
                    "w": p["w"],
                    "h": p["h"],
                    "positive": positive,
                    "negative": full_negative,
                    "stage": sid,
                    "model": sm,
                }
            )

        part_prompts.sort(key=lambda p: p["stage"])

        return {
            "backend": BACKEND,
            "global": {
                "positive": global_positive,
                "negative": profile["presets"]["negative"],
                "ar": profile["presets"]["ar_global"],
                "model": _root,
            },
            "parts": part_prompts,
            "stage_models": stage_models,
        }

    def _send_prompts_post(self):
        """POST /api/prompts — accept custom character/presets overrides."""
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._json_response({"error": "Invalid JSON"}, 400)
            return

        # Merge with default profile
        default_profile = load_json(PROJECT_DIR / "config" / "character_profile.json")
        profile = {
            "name": req.get("name", default_profile.get("name", "")),
            "character": {**default_profile.get("character", {}), **req.get("character", {})},
            "presets": {**default_profile.get("presets", {}), **req.get("presets", {})},
        }
        root_model = req.get("root_model")
        ref_model = req.get("ref_model")
        self._json_response(self._build_prompts(profile, root_model=root_model, ref_model=ref_model))

    def _handle_settings(self):
        """POST /api/settings — update runtime API key."""
        global API_KEY
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._json_response({"error": "Invalid JSON"}, 400)
            return
        if req.get("api_key"):
            API_KEY = req["api_key"]
            self._json_response({"ok": True, "backend": BACKEND})
        else:
            self._json_response({"error": "Missing api_key"}, 400)

    def _serve_part_image(self):
        rel = self.path.lstrip("/")
        filepath = PROJECT_DIR / rel
        if filepath.exists() and filepath.suffix == ".png":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(filepath.stat().st_size))
            self.end_headers()
            with open(filepath, "rb") as f:
                self.wfile.write(f.read())
        else:
            self.send_error(404, "Image not found. Generate it first.")

    def _build_ref_guidance(self, ref_images, part_id):
        """Build reference image guidance text for the prompt.
        Returns (guidance_text, ref_meta) where ref_meta is a list of
        {idx, part_id, label_cn, context} for the frontend log.
        """
        if not ref_images:
            return "", []

        config = load_json(PROJECT_DIR / "config" / "parts_layout.json")
        pipeline = config.get("pipeline", [])

        # Build lookup: part_id → {label_cn, stage context, stage depends_on}
        part_info = {
            "global_reference": {"label_cn": "全局参考 Global Reference", "label_en": "Global Reference"},
        }
        parts_flat = get_all_parts(config)
        for p in parts_flat:
            part_info[p["id"]] = {"label_cn": p["label_cn"], "label_en": p.get("label_en", "")}

        stage_by_part = {}
        stage_by_name = {}
        for s in pipeline:
            stage_by_name[s["name"]] = s
            for pid in s["parts"]:
                stage_by_part[pid] = s

        # Parse ref_images paths → part IDs
        ref_meta = []
        for idx, ref_path in enumerate(ref_images):
            # "/parts/torso.png" → "torso"
            if isinstance(ref_path, str) and ref_path.startswith("/parts/"):
                pid = ref_path.split("/")[-1].replace(".png", "")
            elif isinstance(ref_path, str) and "parts/" in ref_path:
                pid = ref_path.rsplit("/", 1)[-1].replace(".png", "")
            else:
                pid = str(ref_path)[-30:]  # fallback
            info = part_info.get(pid, {})
            stage = stage_by_part.get(pid, {})
            ref_meta.append(
                {
                    "idx": idx + 1,
                    "part_id": pid,
                    "label_cn": info.get("label_cn", pid),
                    "context": stage.get("context", ""),
                }
            )

        # Build guidance text
        lines = ["\n\n[参考图使用指南 Reference Image Guide]"]
        for rm in ref_meta:
            lines.append(f"参考图{rm['idx']} [img:{rm['idx']}:{rm['part_id']}] = {rm['label_cn']}")
            if rm["context"]:
                lines.append(f"  作用: {rm['context']}")

        # Find target part's stage context
        target_stage = stage_by_part.get(part_id, {})
        target_context = target_stage.get("context", "")
        target_label = target_stage.get("label", part_id)

        lines.append("")
        lines.append("使用要求 Usage Requirements:")
        lines.append(f"1. 本次生成目标: {target_label}")
        lines.append("2. 必须保持与所有参考图一致的风格、配色和角色设计（发色、瞳色、服饰）")
        lines.append("3. 参考图仅作为风格和比例参考，不要直接复制参考图内容，生成全新的匹配部件")
        lines.append(
            f"4. 新部件必须在比例和位置上与参考图对齐（如参考图为躯干，则生成的{target_label}需要与躯干肩宽/髋宽匹配）"
        )
        if target_context:
            lines.append(f"5. 本次生成上下文: {target_context}")
        lines.append("6. 确保生成的部件可以作为独立sprite与参考图中的部件拼接成完整角色")

        guidance = "\n".join(lines)
        return guidance, ref_meta

    def _handle_generate(self):
        if not API_KEY:
            self._json_response(
                {
                    "error": f"{'OPENROUTER' if BACKEND == 'openrouter' else 'SILICONFLOW'}_API_KEY not set. Set it and restart."
                },
                400,
            )
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._json_response({"error": "Invalid JSON"}, 400)
            return

        part_id = req.get("part_id", "")
        positive = req.get("positive", "")
        negative = req.get("negative", "")
        image_size = req.get("image_size", "1328x1328")
        seed = req.get("seed")
        ref_images = req.get("ref_images")  # optional
        gen_model = req.get("model") or MODEL
        aspect_ratio = req.get("aspect_ratio")  # optional override
        image_size_or = req.get("image_size_or")  # optional override

        if not positive:
            self._json_response({"error": "Missing 'positive' field"}, 400)
            return

        # Build reference guidance and inject into prompt
        ref_guidance, ref_meta = self._build_ref_guidance(ref_images, part_id)
        if ref_guidance:
            positive = positive + ref_guidance
        self._log_prompt = positive
        self._log_ref_meta = ref_meta

        if BACKEND == "openrouter":
            self._generate_openrouter(
                part_id, positive, negative, image_size, seed, ref_images, gen_model, aspect_ratio, image_size_or
            )
        else:
            self._generate_siliconflow(part_id, positive, negative, image_size, seed, ref_images, gen_model)

    def _handle_matting(self):
        """POST /api/matting — run triangulation matting to produce transparent PNG."""
        if not API_KEY:
            self._json_response({"error": "API_KEY not set."}, 400)
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            self._json_response({"error": "Invalid JSON"}, 400)
            return

        part_id = req.get("part_id", "")
        if not part_id:
            self._json_response({"error": "Missing 'part_id'"}, 400)
            return

        parts_dir = PROJECT_DIR / "parts"
        parts_dir.mkdir(exist_ok=True)

        white_path = parts_dir / f"{part_id}_white.png"
        black_path = parts_dir / f"{part_id}_black.png"
        current_path = parts_dir / f"{part_id}.png"

        if not current_path.exists():
            self._json_response({"error": f"Part '{part_id}' not generated yet. Generate it first."}, 400)
            return

        import shutil
        import time

        start_time = time.time()

        # Step 1: Preserve white-bg version
        try:
            shutil.copy2(current_path, white_path)
        except OSError as e:
            self._json_response({"error": f"Failed to copy white image: {e}"}, 500)
            return

        # Step 2: Read white image dimensions to match in black-bg generation
        try:
            from PIL import Image as PILImage

            white_img = PILImage.open(white_path)
            w, h = white_img.size
            white_img.close()
            # Map dimensions to aspect_ratio and image_size_or for the API
            ratio = w / h
            if 0.55 < ratio < 0.58:
                aspect_ratio = "9:16"
            elif 0.65 < ratio < 0.68:
                aspect_ratio = "2:3"
            elif 0.74 < ratio < 0.76:
                aspect_ratio = "3:4"
            elif 0.98 < ratio < 1.02:
                aspect_ratio = "1:1"
            elif 1.32 < ratio < 1.35:
                aspect_ratio = "4:3"
            elif 1.76 < ratio < 1.80:
                aspect_ratio = "16:9"
            else:
                aspect_ratio = "1:1"
            min_dim = min(w, h)
            if min_dim >= 3000:
                image_size_or = "4K"
            elif min_dim >= 1500:
                image_size_or = "2K"
            else:
                image_size_or = "1K"
        except Exception:
            aspect_ratio = "1:1"
            image_size_or = "1K"

        # Step 3: Generate black-background version via image editing
        black_prompt = (
            "Change ONLY the background to pure black (#000000). "
            "Keep every pixel of the character and subject exactly the same — no changes to the foreground. "
            "Do not alter any pixel of the subject. This is a constrained edit for matting: "
            "the background must become solid black while the subject remains pixel-perfect."
        )
        try:
            self._generate_image_via_openrouter(
                prompt=black_prompt,
                negative="blurry, distorted, altered subject, changed character, different proportions",
                aspect_ratio=aspect_ratio,
                image_size_or=image_size_or,
                ref_images=[f"/parts/{part_id}_white.png"],
                output_path=black_path,
                model=DAG_REF_MODEL,
            )
        except Exception as e:
            # Clean up white image on failure
            if white_path.exists():
                white_path.unlink()
            self._json_response({"error": f"Black-background generation failed: {e}"}, 502)
            return

        # Step 4: Run triangulation matting
        ok = triangulation_matting(str(white_path), str(black_path), str(current_path))
        if not ok:
            self._json_response({"error": "Matting algorithm failed — check Pillow installation."}, 500)
            return

        elapsed_ms = int((time.time() - start_time) * 1000)

        self._json_response(
            {
                "part_id": part_id,
                "white_url": f"/parts/{part_id}_white.png",
                "black_url": f"/parts/{part_id}_black.png",
                "transparent_url": f"/parts/{part_id}.png",
                "timing_ms": elapsed_ms,
            }
        )

    def _generate_image_via_openrouter(
        self, prompt, negative, aspect_ratio, image_size_or, ref_images, output_path, model
    ):
        """Generate a single image and save to disk. Raises on failure."""
        body = build_openrouter_body(
            prompt,
            negative,
            "1328x1328",
            None,
            ref_images,
            model,
            aspect_ratio=aspect_ratio,
            image_size_or=image_size_or,
        )
        data = json.dumps(body).encode("utf-8")
        sreq = urllib.request.Request(OPENROUTER_API, data=data, method="POST")
        sreq.add_header("Authorization", f"Bearer {API_KEY}")
        sreq.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(sreq, timeout=300) as resp:
                result = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            err_body = e.read().decode()
            raise RuntimeError(f"OpenRouter HTTP {e.code}: {err_body}") from e
        except TimeoutError:
            raise RuntimeError("Generation timed out after 300s.") from None

        choices = result.get("choices", [])
        if not choices:
            raise RuntimeError(f"No choices in response: {json.dumps(result, ensure_ascii=False)[:500]}")

        msg = choices[0].get("message", {})
        images = msg.get("images", [])
        if not images:
            text = msg.get("content", "")[:200]
            raise RuntimeError(f"No image in response. Text: {text}")

        img_data_url = images[0].get("image_url", {}).get("url", "")
        if not img_data_url:
            raise RuntimeError("No image_url in response")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            if img_data_url.startswith("data:"):
                _, b64data = img_data_url.split(",", 1)
                img_bytes = base64.b64decode(b64data)
                with output_path.open("wb") as f:
                    f.write(img_bytes)
            else:
                dreq = urllib.request.Request(img_data_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(dreq, timeout=60) as dl, open(output_path, "wb") as f:
                    f.write(dl.read())
        except Exception as e:
            raise RuntimeError(f"Failed to save image: {e}") from e

    def _generate_openrouter(
        self,
        part_id,
        positive,
        negative,
        image_size,
        seed,
        ref_images,
        gen_model,
        aspect_ratio=None,
        image_size_or=None,
    ):
        body = build_openrouter_body(
            positive, negative, image_size, seed, ref_images, gen_model, aspect_ratio, image_size_or
        )
        data = json.dumps(body).encode("utf-8")
        sreq = urllib.request.Request(OPENROUTER_API, data=data, method="POST")
        sreq.add_header("Authorization", f"Bearer {API_KEY}")
        sreq.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(sreq, timeout=300) as resp:
                result = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            err_body = e.read().decode()
            self._json_response({"error": f"OpenRouter HTTP {e.code}: {err_body}"}, 502)
            return
        except TimeoutError:
            self._json_response({"error": "Generation timed out after 300s."}, 504)
            return
        except Exception as e:
            self._json_response({"error": f"Request failed: {e}"}, 502)
            return

        choices = result.get("choices", [])
        if not choices:
            self._json_response({"error": "No choices in response", "raw": result}, 502)
            return

        msg = choices[0].get("message", {})
        images = msg.get("images", [])
        usage = result.get("usage", {})
        resp_seed = result.get("seed", seed)

        if not images:
            text_content = msg.get("content", "")[:200]
            self._json_response({"error": f"No image in response. Text: {text_content}", "raw": result}, 502)
            return

        img_obj = images[0].get("image_url", {})
        img_data_url = img_obj.get("url", "")

        if not img_data_url:
            self._json_response({"error": "No image_url in response", "raw": result}, 502)
            return

        # Decode base64 data URL and save
        output_path = PROJECT_DIR / "parts" / f"{part_id}.png" if part_id else PROJECT_DIR / "parts" / "_generated.png"
        output_path.parent.mkdir(exist_ok=True)

        try:
            if img_data_url.startswith("data:"):
                _header, b64data = img_data_url.split(",", 1)
                img_bytes = base64.b64decode(b64data)
                with output_path.open("wb") as f:
                    f.write(img_bytes)
            else:
                # HTTP URL fallback
                dreq = urllib.request.Request(img_data_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(dreq, timeout=60) as dl, open(output_path, "wb") as f:
                    f.write(dl.read())
        except Exception as e:
            self._json_response({"error": f"Download failed: {e}"}, 502)
            return

        self._json_response(
            {
                "part_id": part_id,
                "seed": resp_seed,
                "url": f"/parts/{part_id}.png",
                "path": str(output_path),
                "timing_ms": usage.get("total_tokens", 0),
                "usage": usage,
                "model": gen_model,
                "prompt": getattr(self, "_log_prompt", positive),
                "ref_meta": getattr(self, "_log_ref_meta", []),
            }
        )

    def _generate_siliconflow(self, part_id, positive, negative, image_size, seed, ref_images, gen_model):
        body = build_siliconflow_body(positive, negative, image_size, seed, ref_images, gen_model)
        data = json.dumps(body).encode("utf-8")
        sreq = urllib.request.Request(SILICONFLOW_API, data=data, method="POST")
        sreq.add_header("Authorization", f"Bearer {API_KEY}")
        sreq.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(sreq, timeout=300) as resp:
                result = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            err_body = e.read().decode()
            self._json_response({"error": f"API HTTP {e.code}: {err_body}"}, 502)
            return
        except TimeoutError:
            self._json_response({"error": "Generation timed out after 300s."}, 504)
            return
        except Exception as e:
            self._json_response({"error": f"Request failed: {e}"}, 502)
            return

        images = result.get("images", [])
        used_seed = result.get("seed", seed)
        timings = result.get("timings", {})
        inference_ms = timings.get("inference", 0)

        if not images or "url" not in images[0]:
            self._json_response({"error": "No image in response", "raw": result}, 502)
            return

        img_url = images[0]["url"]
        output_path = PROJECT_DIR / "parts" / f"{part_id}.png" if part_id else PROJECT_DIR / "parts" / "_generated.png"
        output_path.parent.mkdir(exist_ok=True)

        try:
            dreq = urllib.request.Request(img_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(dreq, timeout=60) as dl, open(output_path, "wb") as f:
                f.write(dl.read())
        except Exception as e:
            self._json_response({"error": f"Download failed: {e}", "url": img_url}, 502)
            return

        self._json_response(
            {
                "part_id": part_id,
                "seed": used_seed,
                "url": f"/parts/{part_id}.png",
                "path": str(output_path),
                "timing_ms": inference_ms,
                "model": gen_model,
                "prompt": getattr(self, "_log_prompt", positive),
                "ref_meta": getattr(self, "_log_ref_meta", []),
            }
        )

    def log_message(self, format, *args):
        if self.path.startswith("/api/"):
            super().log_message(format, *args)


def main():
    global API_KEY, BACKEND, MODEL

    parser = argparse.ArgumentParser(description="2D Character Parts Studio Server")
    parser.add_argument("--port", type=int, default=8765, help="Port (default: 8765)")
    parser.add_argument(
        "--backend",
        default="openrouter",
        choices=["openrouter", "siliconflow"],
        help="API backend (default: openrouter)",
    )
    parser.add_argument(
        "--model", default="google/gemini-3.1-flash-image-preview", help="Default model for single-part generation"
    )
    parser.add_argument("--api-key", help="API key (or set OPENROUTER_API_KEY / SILICONFLOW_API_KEY env)")
    args = parser.parse_args()

    BACKEND = args.backend
    MODEL = args.model

    if BACKEND == "openrouter":
        API_KEY = args.api_key or os.environ.get("OPENROUTER_API_KEY", "")
    else:
        API_KEY = args.api_key or os.environ.get("SILICONFLOW_API_KEY", "")

    if not API_KEY:
        env_var = "OPENROUTER_API_KEY" if BACKEND == "openrouter" else "SILICONFLOW_API_KEY"
        print(f"⚠ {env_var} not set.")
        print("  Set the env var or use --api-key:")
        print(f"    export {env_var}=sk-xxx")
        print("    python3 scripts/studio.py")

    _load_feature_routes()

    server = HTTPServer(("0.0.0.0", args.port), StudioHandler)  # nosec B104
    print("\n  🎨 2D Character Parts Studio")
    print("  ─────────────────────────────")
    print(f"  URL:     http://localhost:{args.port}")
    print(f"  Backend: {BACKEND}")
    print(f"  Model:   {MODEL}")
    print(f"  API:     {'✓ set' if API_KEY else '✗ not set'}")
    print("\n  Press Ctrl+C to stop.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
        server.server_close()


if __name__ == "__main__":
    main()
