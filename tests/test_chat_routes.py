"""Unit tests for ``chat_routes`` — tool aggregation, prompt assembly, gating.

Exercises the integration seam (registry build with a missing optional module,
system-prompt composition, and tool gating) without any real network or key.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import chat_routes


def test_build_registry_includes_motion_tools_and_skips_missing(monkeypatch):
    # A non-existent optional tool module must be skipped without raising
    # (the guarded import contract). Use a bogus name so the assertion holds
    # regardless of which real optional modules (e.g. jina_tools) are merged.
    monkeypatch.setattr(chat_routes, "COMPANION_TOOL_MODULES", ["companion_effects", "no_such_tool_module_xyz"])
    tool_defs, dispatch, owner = chat_routes._build_registry()
    names = {t["function"]["name"] for t in tool_defs}
    assert {"motion_play", "face_set", "motion_stop"} <= names
    assert owner["motion_play"] == "companion_effects"
    assert "no_such_tool_module_xyz" not in set(owner.values())
    effect, _ = dispatch["motion_play"]("motion_play", {"name": "wave"})
    assert effect["type"] == "motion_play"


def test_make_executor_unknown_tool_returns_noop():
    _, dispatch, _ = chat_routes._build_registry()
    execute = chat_routes._make_executor(dispatch)
    effect, result = execute("does_not_exist", {})
    assert effect == {"type": "noop"}
    assert result["status"] == "ignored"


def test_build_system_prompt_includes_persona_memory_scene_retrieved():
    profile = {"persona": {"system_prompt": "PERSONA_BASE"}}
    payload = {
        "relationshipDiary": [{"episodeTitle": "day one"}],
        "stableProfile": {"preferredName": "Kai"},
        "sceneContext": {"hasModel": True},
        "retrievedMemories": [{"text": "likes tea"}],
    }
    prompt = chat_routes.build_system_prompt(profile, payload)
    assert "PERSONA_BASE" in prompt
    assert "day one" in prompt
    assert "Kai" in prompt
    assert "hasModel" in prompt
    assert "likes tea" in prompt


def test_system_prompt_ui_override_wins_over_profile():
    profile = {"persona": {"system_prompt": "PROFILE"}}
    payload = {"config": {"persona": {"systemPrompt": "UI_OVERRIDE"}}}
    prompt = chat_routes.build_system_prompt(profile, payload)
    assert "UI_OVERRIDE" in prompt
    assert "PROFILE" not in prompt


def test_build_chat_messages_timer_mode_injects_default_prompt():
    msgs = chat_routes.build_chat_messages({"mode": "timer"}, {"persona": {"system_prompt": "p"}})
    assert msgs[0]["role"] == "system"
    assert msgs[-1]["role"] == "user"
    assert len(msgs[-1]["content"]) > 0


def test_build_chat_messages_includes_recent_history():
    payload = {
        "userMessage": "now",
        "recentMessages": [{"role": "user", "content": "past-u"}, {"role": "assistant", "content": "past-a"}],
    }
    msgs = chat_routes.build_chat_messages(payload, {"persona": {"system_prompt": "p"}})
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"]
    assert msgs[-1]["content"] == "now"


def test_run_chat_gates_motion_tools_when_gesture_disabled(monkeypatch):
    captured = {}

    def fake_loop(messages, tools, execute, *, model=None, base_url=None, api_key=None):
        captured["tools"] = tools
        captured["model"] = model
        return {"assistantMessage": "hi", "effects": [], "reasoningContent": "", "usage": {}}

    monkeypatch.setattr(chat_routes.llm_gateway, "run_tool_loop", fake_loop)

    payload = {"userMessage": "hello", "config": {"motion": {"enableAutoGesture": False}, "api": {"model": "x/y"}}}
    chat_routes.run_chat(payload)
    tool_names = {t["function"]["name"] for t in captured["tools"]}
    assert "motion_play" not in tool_names
    assert "face_set" not in tool_names
    assert captured["model"] == "x/y"


def test_run_chat_includes_motion_tools_by_default(monkeypatch):
    captured = {}

    def fake_loop(messages, tools, execute, *, model=None, base_url=None, api_key=None):
        captured["tools"] = tools
        return {"assistantMessage": "hi", "effects": [], "reasoningContent": "", "usage": {}}

    monkeypatch.setattr(chat_routes.llm_gateway, "run_tool_loop", fake_loop)
    chat_routes.run_chat({"userMessage": "hello"})
    assert "motion_play" in {t["function"]["name"] for t in captured["tools"]}


def test_run_memory_compression_splits_stable_profile_patch(monkeypatch):
    def fake_chat(messages, *, model=None, extra=None):
        assert extra == {"response_format": {"type": "json_object"}}
        content = json.dumps({"episodeTitle": "t", "stableProfilePatch": {"preferredName": "Kai"}})
        return {"choices": [{"message": {"content": content}}]}

    monkeypatch.setattr(chat_routes.llm_gateway, "chat", fake_chat)
    out = chat_routes.run_memory_compression({"recentMessages": []})
    assert out["stableProfilePatch"] == {"preferredName": "Kai"}
    assert "stableProfilePatch" not in out["summary"]
    assert out["summary"]["episodeTitle"] == "t"


def test_run_memory_compression_falls_back_on_bad_json(monkeypatch):
    monkeypatch.setattr(
        chat_routes.llm_gateway,
        "chat",
        lambda messages, *, model=None, extra=None: {"choices": [{"message": {"content": "not json"}}]},
    )
    out = chat_routes.run_memory_compression({"recentMessages": []})
    assert out["summary"]["episodeTitle"] == "临时摘要"
    assert out["summary"]["rawContent"] == "not json"
    assert out["stableProfilePatch"] == {}
