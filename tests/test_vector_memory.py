"""Unit tests for VectorMemory — cosine ranking, persistence, numpy fallback.

``jina.embed`` is stubbed with deterministic vectors so no network or API key is
required.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import jina
import vector_memory
from vector_memory import VectorMemory

# Deterministic embeddings keyed by text. The query is identical to "apple
# fruit" and near "banana fruit", far from "car engine".
EMBEDDINGS = {
    "apple fruit": [1.0, 0.0, 0.0],
    "banana fruit": [0.9, 0.1, 0.0],
    "car engine": [0.0, 1.0, 0.0],
    "fruit query": [1.0, 0.0, 0.0],
}


def _fake_embed(texts, *, task="retrieval.passage", model=None, dimensions=None, api_key=None):
    """Return canned embeddings for known texts."""
    return [EMBEDDINGS[t] for t in texts]


def test_add_stores_record(monkeypatch, tmp_path):
    seen_tasks = []

    def fake_embed(texts, *, task="retrieval.passage", **kwargs):
        seen_tasks.append(task)
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(jina, "embed", fake_embed)
    memory = VectorMemory(str(tmp_path / "m.json"))
    memory.add("hello", {"src": "test"})

    assert len(memory.records) == 1
    record = memory.records[0]
    assert record["text"] == "hello"
    assert record["meta"] == {"src": "test"}
    assert record["embedding"] == [1.0, 0.0]
    assert seen_tasks == ["retrieval.passage"]


def test_add_defaults_meta_to_empty_dict(monkeypatch, tmp_path):
    monkeypatch.setattr(jina, "embed", _fake_embed)
    memory = VectorMemory(str(tmp_path / "m.json"))
    monkeypatch.setitem(EMBEDDINGS, "solo", [1.0])
    memory.add("solo")
    assert memory.records[0]["meta"] == {}


def test_search_cosine_ordering(monkeypatch, tmp_path):
    seen_tasks = []

    def fake_embed(texts, *, task="retrieval.passage", **kwargs):
        seen_tasks.append(task)
        return [EMBEDDINGS[t] for t in texts]

    monkeypatch.setattr(jina, "embed", fake_embed)
    memory = VectorMemory(str(tmp_path / "m.json"))
    memory.add("apple fruit")
    memory.add("banana fruit")
    memory.add("car engine")

    results = memory.search("fruit query", top_k=2)
    assert [r["text"] for r in results] == ["apple fruit", "banana fruit"]
    assert results[0]["score"] >= results[1]["score"]
    assert abs(results[0]["score"] - 1.0) < 1e-9
    # add() uses the passage task; search() uses the query task.
    assert seen_tasks[-1] == "retrieval.query"
    assert seen_tasks[:3] == ["retrieval.passage"] * 3


def test_search_empty_returns_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(jina, "embed", _fake_embed)
    memory = VectorMemory(str(tmp_path / "m.json"))
    assert memory.search("fruit query") == []


def test_search_respects_top_k(monkeypatch, tmp_path):
    monkeypatch.setattr(jina, "embed", _fake_embed)
    memory = VectorMemory(str(tmp_path / "m.json"))
    memory.add("apple fruit")
    memory.add("banana fruit")
    memory.add("car engine")
    assert len(memory.search("fruit query", top_k=1)) == 1


def test_save_load_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(jina, "embed", lambda texts, **kwargs: [[0.5, 0.5] for _ in texts])
    path = tmp_path / "m.json"
    memory = VectorMemory(str(path), dim=2)
    memory.add("one", {"i": 1})
    memory.add("two", {"i": 2})
    memory.save()
    assert path.exists()

    reloaded = VectorMemory(str(path))
    reloaded.load()
    assert len(reloaded.records) == 2
    assert reloaded.records[0]["text"] == "one"
    assert reloaded.records[1]["meta"] == {"i": 2}
    assert reloaded.dim == 2


def test_load_missing_file_is_empty(tmp_path):
    memory = VectorMemory(str(tmp_path / "nope.json"))
    memory.load()
    assert memory.records == []


def test_load_ignores_corrupt_file(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    memory = VectorMemory(str(path))
    memory.load()
    assert memory.records == []


def test_items_is_records_alias(monkeypatch, tmp_path):
    monkeypatch.setattr(jina, "embed", _fake_embed)
    monkeypatch.setitem(EMBEDDINGS, "aliased", [1.0])
    memory = VectorMemory(str(tmp_path / "m.json"))
    memory.add("aliased")
    assert memory.items is memory.records
    assert len(memory.items) == 1


def test_cosine_pure_python_fallback(monkeypatch):
    monkeypatch.setattr(vector_memory, "np", None)
    assert abs(vector_memory._cosine([1.0, 0.0], [1.0, 0.0]) - 1.0) < 1e-9
    assert abs(vector_memory._cosine([1.0, 0.0], [0.0, 1.0])) < 1e-9
    assert vector_memory._cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


def test_cosine_numpy_path():
    if vector_memory.np is None:  # pragma: no cover - numpy is installed in CI
        return
    assert abs(vector_memory._cosine([1.0, 2.0], [2.0, 4.0]) - 1.0) < 1e-9
    assert vector_memory._cosine([0.0, 0.0], [1.0, 1.0]) == 0.0
