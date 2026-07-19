#!/usr/bin/env python3
"""Jina AI client — embeddings, web search, reader, and reranking.

STUB — implementation lands in a later track. Signatures below are final.
Provider defaults (API key, model names, base URLs) come from
``providers.get_jina()``.
"""


def embed(
    texts: list[str],
    *,
    task: str = "retrieval.passage",
    model: str | None = None,
    dimensions: int | None = None,
    api_key: str | None = None,
) -> list[list[float]]:
    """Return an embedding vector for each input text.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("jina.embed() lands in a later track (Jina client).")


def search(query: str, *, api_key: str | None = None) -> list[dict]:
    """Web search via ``s.jina.ai``; returns ``[{title, url, content, description}]``.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("jina.search() lands in a later track (Jina client).")


def read(
    url: str,
    *,
    api_key: str | None = None,
    respond_with: str = "markdown",
    with_links: bool = False,
) -> dict:
    """Read/extract a URL's content via ``r.jina.ai``.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("jina.read() lands in a later track (Jina client).")


def rerank(
    query: str,
    documents: list[str],
    *,
    top_n: int | None = None,
    model: str | None = None,
    api_key: str | None = None,
) -> list[dict]:
    """Rerank ``documents`` against ``query``; returns scored, ordered results.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("jina.rerank() lands in a later track (Jina client).")
