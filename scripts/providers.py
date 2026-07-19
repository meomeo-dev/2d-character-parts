#!/usr/bin/env python3
"""Unified provider settings for the ``llm`` / ``image`` / ``jina`` services.

Load priority (highest first):
    1. ``config/runtime_settings.json`` (if present)
    2. environment variables
    3. built-in defaults

Runtime patches are deep-merged and persisted back to the JSON file. Only the
override layer is written, so environment-provided secrets never touch disk
unless explicitly patched.

Security: API keys are never printed to stdout or logs by this module.
"""

import copy
import json
import os
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
SETTINGS_PATH = PROJECT_DIR / "config" / "runtime_settings.json"


def _defaults() -> dict:
    """Return built-in defaults, with env vars layered over hard-coded values.

    The ``llm`` model is an overridable placeholder; the real usable model ID is
    determined at runtime via ``GET {base_url}/models`` and must not be
    hard-coded elsewhere.
    """
    return {
        "llm": {
            "base_url": "https://ai-gateway.vercel.sh/v1",
            "api_key": os.environ.get("AI_GATEWAY_API_KEY", ""),
            "model": "openai/gpt-5.5",
        },
        "image": {
            "base_url": "https://api.openai.com/v1",
            "api_key": os.environ.get("OPENAI_API_KEY", ""),
            "model": "gpt-image-1",
        },
        "jina": {
            "api_key": os.environ.get("JINA_API_KEY", ""),
            "embed_model": "jina-embeddings-v3",
            "rerank_model": "jina-reranker-v3",
            "reader_base": "https://r.jina.ai",
            "search_base": "https://s.jina.ai",
            "embed_base": "https://api.jina.ai/v1",
        },
    }


def _deep_merge(base: dict, patch: dict) -> dict:
    """Recursively merge ``patch`` into ``base`` in place and return ``base``."""
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _load_file_overrides() -> dict:
    """Load the persisted override layer, or an empty dict if absent/invalid."""
    if not SETTINGS_PATH.exists():
        return {}
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def load_settings() -> dict:
    """Return the fully resolved settings (file > env > defaults)."""
    settings = _defaults()
    _deep_merge(settings, _load_file_overrides())
    return settings


def save_settings(patch: dict) -> dict:
    """Deep-merge ``patch`` into the persisted override layer and write it back.

    Empty ``api_key`` values are allowed. Returns the fully resolved settings.
    """
    overrides = _deep_merge(_load_file_overrides(), copy.deepcopy(patch))
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(overrides, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return load_settings()


def get_llm() -> dict:
    """Return the resolved ``llm`` provider settings."""
    return load_settings()["llm"]


def get_image() -> dict:
    """Return the resolved ``image`` provider settings."""
    return load_settings()["image"]


def get_jina() -> dict:
    """Return the resolved ``jina`` provider settings."""
    return load_settings()["jina"]
