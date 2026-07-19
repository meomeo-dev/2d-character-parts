"""Unit tests for the Jina client — request framing and response parsing.

The HTTP layer (``jina.post_json``) and provider settings (``jina.get_jina``)
are stubbed so no real network access or API key is required.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import jina
from _http import HttpError

FAKE_SETTINGS = {
    "api_key": "test-key",  # pragma: allowlist secret
    "embed_model": "jina-embeddings-v3",
    "rerank_model": "jina-reranker-v3",
    "reader_base": "https://r.jina.ai",
    "search_base": "https://s.jina.ai",
    "embed_base": "https://api.jina.ai/v1",
}


class _Recorder:
    """Stand-in for ``jina.post_json`` that records calls and returns a canned response."""

    def __init__(self, response: dict) -> None:
        self.response = response
        self.calls: list[dict] = []

    def __call__(self, url, payload, headers=None, timeout=120):
        """Record one call and return the canned response."""
        self.calls.append({"url": url, "payload": payload, "headers": headers or {}, "timeout": timeout})
        return self.response


def _patch(monkeypatch, response, settings=None):
    """Patch ``jina.post_json`` and ``jina.get_jina``; return the recorder."""
    recorder = _Recorder(response)
    monkeypatch.setattr(jina, "post_json", recorder)
    monkeypatch.setattr(jina, "get_jina", lambda: dict(settings if settings is not None else FAKE_SETTINGS))
    return recorder


# ── embed ────────────────────────────────────────────────


def test_embed_request_and_parse(monkeypatch):
    rec = _patch(monkeypatch, {"data": [{"embedding": [0.1, 0.2, 0.3]}, {"embedding": [0.4, 0.5, 0.6]}]})
    out = jina.embed(["hello", "world"], dimensions=3)
    assert out == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]

    call = rec.calls[0]
    assert call["url"] == "https://api.jina.ai/v1/embeddings"
    body = call["payload"]
    assert body["model"] == "jina-embeddings-v3"
    assert body["task"] == "retrieval.passage"
    assert body["input"] == ["hello", "world"]
    assert body["normalized"] is True
    assert body["embedding_type"] == "float"
    assert body["dimensions"] == 3
    assert call["headers"]["Authorization"] == "Bearer test-key"
    assert call["headers"]["Accept"] == "application/json"


def test_embed_omits_dimensions_when_none(monkeypatch):
    rec = _patch(monkeypatch, {"data": [{"embedding": [1.0]}]})
    jina.embed(["x"])
    assert "dimensions" not in rec.calls[0]["payload"]


def test_embed_query_task(monkeypatch):
    rec = _patch(monkeypatch, {"data": [{"embedding": [1.0]}]})
    jina.embed(["q"], task="retrieval.query")
    assert rec.calls[0]["payload"]["task"] == "retrieval.query"


def test_embed_model_and_key_override(monkeypatch):
    rec = _patch(monkeypatch, {"data": [{"embedding": [1.0]}]})
    jina.embed(["x"], model="custom-embed", api_key="override-key")  # pragma: allowlist secret
    assert rec.calls[0]["payload"]["model"] == "custom-embed"
    assert rec.calls[0]["headers"]["Authorization"] == "Bearer override-key"


# ── search ───────────────────────────────────────────────


def test_search_request_and_parse(monkeypatch):
    envelope = {
        "code": 200,
        "status": 20000,
        "data": [{"title": "T", "url": "https://a", "content": "C", "description": "D"}],
    }
    rec = _patch(monkeypatch, envelope)
    out = jina.search("python")
    assert out == [{"title": "T", "url": "https://a", "content": "C", "description": "D"}]

    call = rec.calls[0]
    assert call["url"] == "https://s.jina.ai/"
    assert call["payload"] == {"q": "python"}
    assert call["headers"]["Authorization"] == "Bearer test-key"
    assert call["headers"]["Accept"] == "application/json"


def test_search_requires_key(monkeypatch):
    rec = _patch(monkeypatch, {"data": []}, settings={**FAKE_SETTINGS, "api_key": ""})
    with pytest.raises(HttpError) as excinfo:
        jina.search("q")
    assert excinfo.value.status == 401
    assert rec.calls == []  # fails fast, no network call


def test_search_empty_data(monkeypatch):
    rec = _patch(monkeypatch, {"code": 200, "status": 20000})
    assert jina.search("q") == []
    assert rec.calls[0]["payload"] == {"q": "q"}


# ── read ─────────────────────────────────────────────────


def test_read_request_and_parse(monkeypatch):
    rec = _patch(monkeypatch, {"code": 200, "data": {"title": "Page", "url": "https://a", "content": "# md"}})
    out = jina.read("https://a", with_links=True)
    assert out == {"title": "Page", "url": "https://a", "content": "# md"}

    call = rec.calls[0]
    assert call["url"] == "https://r.jina.ai/"
    assert call["payload"] == {"url": "https://a"}
    assert call["headers"]["X-Respond-With"] == "markdown"
    assert call["headers"]["X-With-Links-Summary"] == "true"
    assert call["headers"]["Authorization"] == "Bearer test-key"


def test_read_without_links_summary(monkeypatch):
    rec = _patch(monkeypatch, {"data": {"title": "P"}})
    jina.read("https://a")
    assert "X-With-Links-Summary" not in rec.calls[0]["headers"]


def test_read_optional_key(monkeypatch):
    rec = _patch(monkeypatch, {"data": {"title": "P"}}, settings={**FAKE_SETTINGS, "api_key": ""})
    jina.read("https://a")
    assert "Authorization" not in rec.calls[0]["headers"]


# ── rerank ───────────────────────────────────────────────


def test_rerank_request_and_parse(monkeypatch):
    results = [{"index": 1, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.4}]
    rec = _patch(monkeypatch, {"results": results})
    out = jina.rerank("q", ["d0", "d1"], top_n=2)
    assert out == results

    call = rec.calls[0]
    assert call["url"] == "https://api.jina.ai/v1/rerank"
    body = call["payload"]
    assert body["model"] == "jina-reranker-v3"
    assert body["query"] == "q"
    assert body["documents"] == ["d0", "d1"]
    assert body["return_documents"] is False
    assert body["top_n"] == 2


def test_rerank_omits_top_n_when_none(monkeypatch):
    rec = _patch(monkeypatch, {"results": []})
    jina.rerank("q", ["d0"])
    assert "top_n" not in rec.calls[0]["payload"]
