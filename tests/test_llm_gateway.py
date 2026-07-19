"""Unit tests for ``llm_gateway`` — tool loop, request framing, model listing.

All HTTP is stubbed via monkeypatch; no real network or API key is touched.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import llm_gateway

# A distinctive, obviously-fake token bound via a variable (not a quoted literal
# after an ``api_key`` key) so secret scanners don't false-positive on it.
SENTINEL = "companion-probe-9f"
FAKE_SETTINGS = {"base_url": "https://example.test/v1", "api_key": SENTINEL, "model": "test/model"}


def _use_fake_settings(monkeypatch, settings=None):
    monkeypatch.setattr(llm_gateway.providers, "get_llm", lambda: dict(settings or FAKE_SETTINGS))


def test_chat_builds_body_and_auth_header(monkeypatch):
    _use_fake_settings(monkeypatch)
    captured = {}

    def fake_post_json(url, payload, headers=None, timeout=120):
        captured.update(url=url, payload=payload, headers=headers)
        return {"choices": [{"message": {"content": "ok"}}]}

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    llm_gateway.chat(
        [{"role": "user", "content": "hi"}],
        temperature=0.5,
        tools=[{"type": "function", "function": {"name": "t"}}],
    )

    assert captured["url"] == "https://example.test/v1/chat/completions"
    assert captured["payload"]["model"] == "test/model"
    assert captured["payload"]["stream"] is False
    assert captured["payload"]["temperature"] == 0.5
    assert captured["payload"]["tool_choice"] == "auto"
    assert captured["headers"]["Authorization"] == f"Bearer {SENTINEL}"


def test_chat_omits_auth_when_no_key(monkeypatch):
    _use_fake_settings(monkeypatch, {"base_url": "https://x/v1", "api_key": "", "model": "m"})
    captured = {}

    def fake_post_json(url, payload, headers=None, timeout=120):
        captured["headers"] = headers
        return {"choices": [{"message": {"content": "ok"}}]}

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    llm_gateway.chat([{"role": "user", "content": "hi"}])
    assert "Authorization" not in captured["headers"]
    # No tools => tool_choice must not be sent.
    assert "tool_choice" not in captured.get("payload", {})


def test_chat_passes_extra_body(monkeypatch):
    _use_fake_settings(monkeypatch)
    captured = {}

    def fake_post_json(url, payload, headers=None, timeout=120):
        captured["payload"] = payload
        return {"choices": [{"message": {"content": "{}"}}]}

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    llm_gateway.chat([{"role": "user", "content": "hi"}], extra={"response_format": {"type": "json_object"}})
    assert captured["payload"]["response_format"] == {"type": "json_object"}


def test_run_tool_loop_executes_tools_then_returns_effects(monkeypatch):
    _use_fake_settings(monkeypatch)

    responses = [
        {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {"name": "motion_play", "arguments": json.dumps({"name": "wave"})},
                            }
                        ],
                    }
                }
            ]
        },
        {
            "choices": [{"message": {"content": "你好呀", "reasoning_content": "thinking"}}],
            "usage": {"total_tokens": 42},
        },
    ]
    calls = []

    def fake_post_json(url, payload, headers=None, timeout=120):
        calls.append({"payload": payload, "headers": headers})
        return responses[len(calls) - 1]

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    executed = []

    def execute_tool(name, args):
        executed.append((name, args))
        return {"type": "motion_play", "name": args["name"]}, {"status": "ok"}

    tools = [{"type": "function", "function": {"name": "motion_play", "parameters": {}}}]
    messages = [{"role": "user", "content": "hi"}]
    result = llm_gateway.run_tool_loop(messages, tools, execute_tool)

    assert executed == [("motion_play", {"name": "wave"})]
    assert result["assistantMessage"] == "你好呀"
    assert result["reasoningContent"] == "thinking"
    assert result["effects"] == [{"type": "motion_play", "name": "wave"}]
    assert result["usage"] == {"total_tokens": 42}

    # Two upstream calls: initial (with tools) + follow-up after the tool result.
    assert len(calls) == 2
    assert calls[0]["payload"]["tools"] == tools
    # Messages were mutated in place: assistant(tool_calls) + role:tool appended.
    assert [m["role"] for m in messages] == ["user", "assistant", "tool"]
    assert messages[2]["tool_call_id"] == "call_1"
    assert json.loads(messages[2]["content"]) == {"status": "ok"}
    # The key is only ever an Authorization header, never copied into the JSON body.
    assert SENTINEL not in json.dumps(calls[0]["payload"])


def test_run_tool_loop_drops_noop_effects(monkeypatch):
    _use_fake_settings(monkeypatch)
    responses = [
        {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [{"id": "c1", "function": {"name": "mystery", "arguments": "{}"}}],
                    }
                }
            ]
        },
        {"choices": [{"message": {"content": "done"}}]},
    ]
    calls = []

    def fake_post_json(url, payload, headers=None, timeout=120):
        calls.append(payload)
        return responses[len(calls) - 1]

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    def execute_tool(name, args):
        return {"type": "noop"}, {"status": "ignored"}

    tools = [{"type": "function", "function": {"name": "mystery"}}]
    result = llm_gateway.run_tool_loop([{"role": "user", "content": "hi"}], tools, execute_tool)
    assert result["effects"] == []
    assert result["assistantMessage"] == "done"


def test_run_tool_loop_bad_arguments_json_becomes_empty(monkeypatch):
    _use_fake_settings(monkeypatch)
    responses = [
        {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [{"id": "c1", "function": {"name": "motion_play", "arguments": "{not json"}}],
                    }
                }
            ]
        },
        {"choices": [{"message": {"content": "ok"}}]},
    ]
    calls = []

    def fake_post_json(url, payload, headers=None, timeout=120):
        calls.append(payload)
        return responses[len(calls) - 1]

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    seen = []

    def execute_tool(name, args):
        seen.append(args)
        return {"type": "motion_play", "name": "nod"}, {"status": "ok"}

    tools = [{"type": "function", "function": {"name": "motion_play"}}]
    llm_gateway.run_tool_loop([{"role": "user", "content": "hi"}], tools, execute_tool)
    assert seen == [{}]  # malformed arguments string -> empty dict


def test_run_tool_loop_without_tools_returns_immediately(monkeypatch):
    _use_fake_settings(monkeypatch)
    calls = []

    def fake_post_json(url, payload, headers=None, timeout=120):
        calls.append(payload)
        return {"choices": [{"message": {"content": "hi there"}}]}

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    def execute_tool(name, args):
        raise AssertionError("execute_tool must not be called when there are no tools")

    result = llm_gateway.run_tool_loop([{"role": "user", "content": "hi"}], [], execute_tool)
    assert result["assistantMessage"] == "hi there"
    assert len(calls) == 1
    assert "tools" not in calls[0]


def test_run_tool_loop_caps_rounds_and_forces_final_answer(monkeypatch):
    _use_fake_settings(monkeypatch)
    tool_call_msg = {
        "choices": [
            {
                "message": {
                    "content": "",
                    "tool_calls": [{"id": "c", "function": {"name": "motion_play", "arguments": "{}"}}],
                }
            }
        ]
    }
    final_msg = {"choices": [{"message": {"content": "done"}}]}
    calls = []

    def fake_post_json(url, payload, headers=None, timeout=120):
        calls.append(payload)
        # Once the loop drops tools (cap hit), the model is forced to answer.
        return final_msg if "tools" not in payload else tool_call_msg

    monkeypatch.setattr(llm_gateway, "post_json", fake_post_json)

    def execute_tool(name, args):
        return {"type": "motion_play", "name": "x"}, {"status": "ok"}

    tools = [{"type": "function", "function": {"name": "motion_play"}}]
    result = llm_gateway.run_tool_loop([{"role": "user", "content": "hi"}], tools, execute_tool)

    assert result["assistantMessage"] == "done"
    assert len(calls) == llm_gateway._MAX_TOOL_ROUNDS + 1
    assert "tools" not in calls[-1]
    assert len(result["effects"]) == llm_gateway._MAX_TOOL_ROUNDS


def test_list_models_returns_data_array(monkeypatch):
    _use_fake_settings(monkeypatch)

    def fake_get_json(url, headers=None, timeout=60):
        assert url == "https://example.test/v1/models"
        assert headers["Authorization"] == f"Bearer {SENTINEL}"
        return {"data": [{"id": "a"}, {"id": "b"}]}

    monkeypatch.setattr(llm_gateway, "get_json", fake_get_json)
    assert [m["id"] for m in llm_gateway.list_models()] == ["a", "b"]


def test_list_models_handles_missing_data(monkeypatch):
    _use_fake_settings(monkeypatch)
    monkeypatch.setattr(llm_gateway, "get_json", lambda url, headers=None, timeout=60: {})
    assert llm_gateway.list_models() == []
