#!/usr/bin/env python3
"""JSON-backed vector memory with cosine similarity search.

Records are ``{text, meta, embedding}`` triples. Embeddings are produced via
``jina.embed`` (``retrieval.passage`` when stored, ``retrieval.query`` when
searching). Cosine similarity uses ``numpy`` when available with a pure-Python
fallback, so this module never hard-depends on numpy at import time. State
persists to a JSON file at ``path``.
"""

import json
import math
from pathlib import Path

import jina

try:  # numpy is optional — fall back to pure Python when absent.
    import numpy as np
except ImportError:  # pragma: no cover - exercised via monkeypatch in tests
    np = None  # type: ignore[assignment]


def _cosine(a: list[float], b: list[float]) -> float:
    """Return the cosine similarity of two vectors, or ``0.0`` if either is zero."""
    if np is not None:
        va = np.asarray(a, dtype=float)
        vb = np.asarray(b, dtype=float)
        denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
        return 0.0 if denom == 0.0 else float(np.dot(va, vb) / denom)
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


class VectorMemory:
    """A small persistent store of ``(text, meta, embedding)`` records."""

    def __init__(self, path: str, *, dim: int | None = None) -> None:
        """Create a store backed by the JSON file at ``path``.

        ``dim`` optionally pins the embedding dimensionality passed to
        ``jina.embed``.
        """
        self.path = Path(path)
        self.dim = dim
        self.records: list[dict] = []

    @property
    def items(self) -> list[dict]:
        """Alias for ``records`` — the same underlying list, for callers using either name."""
        return self.records

    def add(self, text: str, meta: dict | None = None) -> None:
        """Embed ``text`` (``retrieval.passage``) and append it with optional ``meta``."""
        embedding = jina.embed([text], task="retrieval.passage", dimensions=self.dim)[0]
        self.records.append({"text": text, "meta": meta or {}, "embedding": embedding})

    def search(self, query: str, *, top_k: int = 5) -> list[dict]:
        """Return the ``top_k`` closest records as ``[{text, meta, score}]``, best first."""
        if not self.records:
            return []
        query_vec = jina.embed([query], task="retrieval.query", dimensions=self.dim)[0]
        scored = [
            {
                "text": rec["text"],
                "meta": rec.get("meta", {}),
                "score": _cosine(query_vec, rec["embedding"]),
            }
            for rec in self.records
        ]
        scored.sort(key=lambda r: r["score"], reverse=True)
        return scored[:top_k]

    def save(self) -> None:
        """Persist all records (and ``dim``) to the JSON file at ``self.path``."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"dim": self.dim, "records": self.records}
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def load(self) -> None:
        """Load records from the JSON file at ``self.path`` (empty if absent/invalid)."""
        if not self.path.exists():
            self.records = []
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            self.records = []
            return
        if isinstance(data, dict):
            self.records = data.get("records", [])
            if self.dim is None:
                self.dim = data.get("dim")
        elif isinstance(data, list):
            self.records = data
        else:
            self.records = []
