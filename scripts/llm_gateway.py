#!/usr/bin/env python3
"""LLM gateway client (OpenAI-compatible chat completions).

Talks to any OpenAI-compatible ``/chat/completions`` endpoint. Provider
defaults (``base_url`` / ``api_key`` / ``model``) come from
``providers.get_llm()``; the usable model ID can be discovered at runtime via
``list_models`` (``GET {base_url}/models``) rather than hard-coded.

Security: the API key is read through ``providers`` and only ever placed in the
``Authorization`` header. It is never printed, logged, or echoed back to
callers.
"""

import json
from collections.abc import Callable

import providers
from _http import HttpError, get_json, post_json

# Safety cap on tool-calling rounds. Once reached, one final request is sent
# without tools so the model is forced to produce a natural-language answer,
# preventing a runaway loop if the model keeps emitting tool calls.
_MAX_TOOL_ROUNDS = 8


def _resolve(base_url: str | None, api_key: str | None, model: str | None) -> tuple[str, str, str]:
    """Resolve ``(base_url, api_key, model)`` from args, falling back to provider settings."""
    settings = providers.get_llm()
    resolved_base = (base_url if base_url is not None else settings.get("base_url", "")).rstrip("/")
    resolved_key = api_key if api_key is not None else settings.get("api_key", "")
    resolved_model = model if model is not None else settings.get("model", "")
    return resolved_base, resolved_key, resolved_model


# A browser-like User-Agent. Some gateways sit behind Cloudflare, which blocks
# the default ``Python-urllib`` UA with a 403 (error 1010); a normal UA passes.
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def _auth_headers(api_key: str) -> dict[str, str]:
    """Return request headers: a browser-like UA plus ``Authorization`` when keyed."""
    headers = {"User-Agent": _USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def chat(
    messages: list[dict],
    *,
    model: str | None = None,
    tools: list[dict] | None = None,
    tool_choice: str = "auto",
    temperature: float | None = None,
    stream: bool = False,
    base_url: str | None = None,
    api_key: str | None = None,
    extra: dict | None = None,
) -> dict:
    """Send a chat-completions request and return the raw response dict.

    POSTs ``{base_url}/chat/completions`` with the body
    ``{model, messages, tools?, tool_choice?, temperature?, stream}``. ``tools``
    and ``tool_choice`` are only included when ``tools`` is non-empty.
    """
    resolved_base, resolved_key, resolved_model = _resolve(base_url, api_key, model)
    body: dict = {"model": resolved_model, "messages": messages, "stream": stream}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice
    if temperature is not None:
        body["temperature"] = temperature
    if extra:
        body.update(extra)
    return post_json(f"{resolved_base}/chat/completions", body, headers=_auth_headers(resolved_key))


def run_tool_loop(
    messages: list[dict],
    tools: list[dict],
    execute_tool: Callable[[str, dict], tuple[dict, dict]],
    *,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
) -> dict:
    """Drive a tool-calling loop until the model returns a final answer.

    ``execute_tool(name, args)`` returns ``(effect, tool_result)``: ``effect`` is
    a client-facing animation directive (dropped when its ``type`` is
    ``"noop"``) and ``tool_result`` is the JSON payload fed back to the model as
    the ``role: tool`` message.

    On each round with ``tool_calls`` the assistant message (with its
    ``tool_calls``) and one ``role: tool`` message per call are appended to
    ``messages`` before re-requesting. Once the model answers without tool
    calls — or the ``_MAX_TOOL_ROUNDS`` safety cap is hit and a final tool-free
    request is made — returns::

        {"assistantMessage", "reasoningContent", "effects", "usage"}
    """
    effects: list[dict] = []
    rounds = 0

    while True:
        active_tools = tools if (tools and rounds < _MAX_TOOL_ROUNDS) else None
        response = chat(messages, model=model, tools=active_tools, base_url=base_url, api_key=api_key)
        message = response["choices"][0]["message"]
        tool_calls = (message.get("tool_calls") or []) if active_tools else []

        if not tool_calls:
            return {
                "assistantMessage": (message.get("content") or "").strip(),
                "reasoningContent": message.get("reasoning_content") or "",
                "effects": effects,
                "usage": response.get("usage", {}),
            }

        messages.append(
            {
                "role": "assistant",
                "content": message.get("content", ""),
                "reasoning_content": message.get("reasoning_content"),
                "tool_calls": tool_calls,
            }
        )

        for tool_call in tool_calls:
            function_name = tool_call["function"]["name"]
            try:
                arguments = json.loads(tool_call["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                arguments = {}
            effect, tool_result = execute_tool(function_name, arguments)
            if effect.get("type") != "noop":
                effects.append(effect)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "content": json.dumps(tool_result, ensure_ascii=False),
                }
            )

        rounds += 1


def list_models(*, base_url: str | None = None, api_key: str | None = None) -> list[dict]:
    """List available models via ``GET {base_url}/models``.

    The API key is sent when configured, but the request is also attempted
    without one (some gateways expose an open model list). Returns the ``data``
    array from the response, or an empty list if absent.
    """
    resolved_base, resolved_key, _ = _resolve(base_url, api_key, None)
    headers = _auth_headers(resolved_key)
    # Model listing is handled independently of the chat/image base path: try the
    # base as-is, then a ``/v1`` variant, so it works whether base_url is the proxy
    # root (ai-sdk-friendly) or already versioned. First JSON ``data`` array wins.
    candidates = [f"{resolved_base}/models"]
    if not resolved_base.endswith("/v1"):
        candidates.append(f"{resolved_base}/v1/models")
    for url in candidates:
        try:
            response = get_json(url, headers=headers)
        except (HttpError, ValueError, OSError):
            continue
        data = response.get("data")
        if isinstance(data, list) and data:
            return data
    return []
