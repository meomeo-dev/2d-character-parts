#!/usr/bin/env python3
"""LLM gateway client (OpenAI-compatible chat completions).

STUB — implementation lands in a later track. Signatures below are final so
feature tracks can integrate against them now. Provider defaults come from
``providers.get_llm()``; the usable model ID is discovered via ``list_models``
(``GET {base_url}/models``) rather than hard-coded.
"""

from collections.abc import Callable


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

    STUB: implemented in a later track.
    """
    raise NotImplementedError("llm_gateway.chat() lands in a later track (LLM gateway).")


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

    ``execute_tool(name, args)`` returns ``(tool_result, effect)``.

    Returns a dict shaped as::

        {"assistantMessage", "reasoningContent", "effects", "usage"}

    STUB: implemented in a later track.
    """
    raise NotImplementedError("llm_gateway.run_tool_loop() lands in a later track (LLM gateway).")


def list_models(*, base_url: str | None = None, api_key: str | None = None) -> list[dict]:
    """List available models via ``GET {base_url}/models``.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("llm_gateway.list_models() lands in a later track (LLM gateway).")
