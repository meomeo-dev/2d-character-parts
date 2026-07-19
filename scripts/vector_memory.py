#!/usr/bin/env python3
"""JSON-backed vector memory with cosine similarity search.

STUB — implementation lands in a later track. Signatures below are final.

Planned behaviour (for the implementing track):
    * Embeddings are produced via ``jina.embed``.
    * Cosine similarity uses ``numpy`` when available, with a pure-Python
      fallback otherwise (guard the import so this module never hard-depends
      on numpy at import time).
    * State persists to a JSON file at ``path``.
"""

from pathlib import Path


class VectorMemory:
    """A small persistent store of ``(text, meta, embedding)`` records."""

    def __init__(self, path: str, *, dim: int | None = None) -> None:
        """Create a store backed by the JSON file at ``path``.

        ``dim`` optionally pins the embedding dimensionality.
        """
        self.path = Path(path)
        self.dim = dim
        self.records: list[dict] = []

    def add(self, text: str, meta: dict | None = None) -> None:
        """Embed ``text`` and store it with optional ``meta``.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("VectorMemory.add() lands in a later track (vector memory).")

    def search(self, query: str, *, top_k: int = 5) -> list[dict]:
        """Return the ``top_k`` closest records as ``[{text, meta, score}]``.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("VectorMemory.search() lands in a later track (vector memory).")

    def save(self) -> None:
        """Persist all records to the JSON file at ``self.path``.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("VectorMemory.save() lands in a later track (vector memory).")

    def load(self) -> None:
        """Load records from the JSON file at ``self.path``.

        STUB: implemented in a later track.
        """
        raise NotImplementedError("VectorMemory.load() lands in a later track (vector memory).")
