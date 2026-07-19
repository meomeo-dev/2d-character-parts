#!/usr/bin/env python3
"""Jina AI client — embeddings, web search, reader, and reranking.

Thin wrappers over the Jina REST APIs, built on the shared ``_http`` helpers so
request framing, error translation, and timeouts stay consistent. Provider
defaults (API key, model names, base URLs) come from ``providers.get_jina()``;
callers may override any of them per call.

Security: the API key is only ever placed in the ``Authorization`` header and is
never logged or echoed by this module.
"""

from _http import HttpError, post_json
from providers import get_jina

DEFAULT_EMBED_MODEL = "jina-embeddings-v3"
DEFAULT_RERANK_MODEL = "jina-reranker-v3"
DEFAULT_EMBED_BASE = "https://api.jina.ai/v1"
DEFAULT_SEARCH_BASE = "https://s.jina.ai"
DEFAULT_READER_BASE = "https://r.jina.ai"


def _url(base: str, path: str) -> str:
    """Join ``base`` and ``path`` with exactly one slash between them."""
    return base.rstrip("/") + "/" + path.lstrip("/")


def _resolve_key(api_key: str | None, settings: dict) -> str:
    """Return the explicit ``api_key`` when given, else the provider default."""
    return api_key if api_key is not None else settings.get("api_key", "")


def _auth_headers(api_key: str, *, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Build request headers with ``Accept: application/json`` and optional Bearer auth."""
    headers: dict[str, str] = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if extra:
        headers.update(extra)
    return headers


def embed(
    texts: list[str],
    *,
    task: str = "retrieval.passage",
    model: str | None = None,
    dimensions: int | None = None,
    api_key: str | None = None,
) -> list[list[float]]:
    """Return an embedding vector for each input text.

    POSTs to ``{embed_base}/embeddings`` with ``normalized`` float embeddings and
    the given ``task`` (``retrieval.passage`` for stored docs, ``retrieval.query``
    for queries). ``dimensions`` optionally truncates the output vectors.
    """
    settings = get_jina()
    key = _resolve_key(api_key, settings)
    base = settings.get("embed_base") or DEFAULT_EMBED_BASE
    payload: dict = {
        "model": model or settings.get("embed_model") or DEFAULT_EMBED_MODEL,
        "task": task,
        "input": texts,
        "normalized": True,
        "embedding_type": "float",
    }
    if dimensions is not None:
        payload["dimensions"] = dimensions
    resp = post_json(_url(base, "embeddings"), payload, headers=_auth_headers(key))
    return [item["embedding"] for item in resp.get("data", [])]


def search(query: str, *, api_key: str | None = None) -> list[dict]:
    """Web search via ``s.jina.ai``; returns ``[{title, url, content, description}]``.

    A Bearer API key is required — the endpoint returns ``401`` without one, so
    this fails fast with ``HttpError(401, ...)`` rather than making a doomed call.
    """
    settings = get_jina()
    key = _resolve_key(api_key, settings)
    if not key:
        raise HttpError(401, "Jina search requires an API key (set JINA_API_KEY).")
    base = settings.get("search_base") or DEFAULT_SEARCH_BASE
    resp = post_json(_url(base, ""), {"q": query}, headers=_auth_headers(key))
    return resp.get("data") or []


def read(
    url: str,
    *,
    api_key: str | None = None,
    respond_with: str = "markdown",
    with_links: bool = False,
) -> dict:
    """Read/extract a URL's content via ``r.jina.ai``; returns ``{title, url, content, ...}``.

    The API key is optional for the reader. ``with_links`` adds a link summary to
    the extracted content.
    """
    settings = get_jina()
    key = _resolve_key(api_key, settings)
    base = settings.get("reader_base") or DEFAULT_READER_BASE
    extra = {"X-Respond-With": respond_with}
    if with_links:
        extra["X-With-Links-Summary"] = "true"
    resp = post_json(_url(base, ""), {"url": url}, headers=_auth_headers(key, extra=extra))
    return resp.get("data") or {}


def rerank(
    query: str,
    documents: list[str],
    *,
    top_n: int | None = None,
    model: str | None = None,
    api_key: str | None = None,
) -> list[dict]:
    """Rerank ``documents`` against ``query``; returns scored, ordered results.

    POSTs to ``{embed_base}/rerank`` with ``return_documents: false`` so results
    carry indices and relevance scores only. ``top_n`` caps the returned count.
    """
    settings = get_jina()
    key = _resolve_key(api_key, settings)
    base = settings.get("embed_base") or DEFAULT_EMBED_BASE
    payload: dict = {
        "model": model or settings.get("rerank_model") or DEFAULT_RERANK_MODEL,
        "query": query,
        "documents": documents,
        "return_documents": False,
    }
    if top_n is not None:
        payload["top_n"] = top_n
    resp = post_json(_url(base, "rerank"), payload, headers=_auth_headers(key))
    return resp.get("results") or []
