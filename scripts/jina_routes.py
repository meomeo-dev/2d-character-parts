#!/usr/bin/env python3
"""HTTP routes for Jina web search/read and JSON-backed vector memory.

Registered into the studio server via ``register(get_map, post_map)`` (see
``studio.FEATURE_ROUTE_MODULES``). All handlers respond with JSON + CORS through
``h._json_response`` and read POST bodies via ``Content-Length``.

POST routes:
    * ``/api/search``          — ``{query}`` -> ``jina.search``
    * ``/api/read``            — ``{url}`` -> ``jina.read``
    * ``/api/memory/add``      — ``{text, meta}`` -> ``VectorMemory.add`` + ``save``
    * ``/api/memory/retrieve`` — ``{query, top_k}`` -> ``VectorMemory.search``
"""

import json
from pathlib import Path

import jina
from _http import HttpError
from vector_memory import VectorMemory

PROJECT_DIR = Path(__file__).resolve().parent.parent
MEMORY_PATH = PROJECT_DIR / "config" / "vector_memory.json"

_memory: VectorMemory | None = None


def _get_memory() -> VectorMemory:
    """Return the process-wide vector memory, loading it from disk on first use."""
    global _memory
    if _memory is None:
        _memory = VectorMemory(str(MEMORY_PATH))
        _memory.load()
    return _memory


def _read_json(h) -> dict:
    """Read and parse the request body as a JSON object, or ``{}`` when empty/non-object."""
    length = int(h.headers.get("Content-Length", 0))
    if not length:
        return {}
    data = json.loads(h.rfile.read(length))
    return data if isinstance(data, dict) else {}


def _upstream_status(exc: HttpError) -> int:
    """Map an upstream ``HttpError`` onto a client-facing status code."""
    return exc.status if 400 <= exc.status < 600 else 502


def _handle_search(h, parsed) -> None:
    """POST /api/search — run a Jina web search for ``query``."""
    try:
        body = _read_json(h)
    except json.JSONDecodeError:
        h._json_response({"error": "Invalid JSON"}, 400)
        return
    query = body.get("query", "")
    if not query:
        h._json_response({"error": "Missing 'query'"}, 400)
        return
    try:
        results = jina.search(query)
    except HttpError as exc:
        h._json_response({"error": exc.body}, _upstream_status(exc))
        return
    h._json_response({"results": results})


def _handle_read(h, parsed) -> None:
    """POST /api/read — extract a page's content via the Jina reader."""
    try:
        body = _read_json(h)
    except json.JSONDecodeError:
        h._json_response({"error": "Invalid JSON"}, 400)
        return
    url = body.get("url", "")
    if not url:
        h._json_response({"error": "Missing 'url'"}, 400)
        return
    try:
        page = jina.read(url)
    except HttpError as exc:
        h._json_response({"error": exc.body}, _upstream_status(exc))
        return
    h._json_response({"page": page})


def _handle_memory_add(h, parsed) -> None:
    """POST /api/memory/add — embed ``text`` into vector memory and persist."""
    try:
        body = _read_json(h)
    except json.JSONDecodeError:
        h._json_response({"error": "Invalid JSON"}, 400)
        return
    text = body.get("text", "")
    meta = body.get("meta") or {}
    if not text:
        h._json_response({"error": "Missing 'text'"}, 400)
        return
    memory = _get_memory()
    try:
        memory.add(text, meta)
        memory.save()
    except HttpError as exc:
        h._json_response({"error": exc.body}, _upstream_status(exc))
        return
    h._json_response({"ok": True, "count": len(memory.records)})


def _handle_memory_retrieve(h, parsed) -> None:
    """POST /api/memory/retrieve — return the top-k records most similar to ``query``."""
    try:
        body = _read_json(h)
    except json.JSONDecodeError:
        h._json_response({"error": "Invalid JSON"}, 400)
        return
    query = body.get("query", "")
    if not query:
        h._json_response({"error": "Missing 'query'"}, 400)
        return
    try:
        top_k = int(body.get("top_k", 5))
    except (TypeError, ValueError):
        h._json_response({"error": "'top_k' must be an integer"}, 400)
        return
    memory = _get_memory()
    try:
        results = memory.search(query, top_k=top_k)
    except HttpError as exc:
        h._json_response({"error": exc.body}, _upstream_status(exc))
        return
    h._json_response({"results": results})


def register(get_map: dict, post_map: dict) -> None:
    """Register the Jina search/read and vector-memory POST routes."""
    post_map["/api/search"] = _handle_search
    post_map["/api/read"] = _handle_read
    post_map["/api/memory/add"] = _handle_memory_add
    post_map["/api/memory/retrieve"] = _handle_memory_retrieve
