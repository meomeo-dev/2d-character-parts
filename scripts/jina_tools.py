#!/usr/bin/env python3
"""Companion chat tools backed by Jina — web search and web page reading.

Aggregated by the chat tool loop via the ``COMPANION_TOOL_MODULES`` registry
(Track C). Exposes:

* ``TOOL_DEFINITIONS`` — OpenAI function-tool schemas for ``web_search`` and
  ``web_read``.
* ``execute(name, args) -> (effect, tool_result)`` — runs a tool and returns an
  ``effect`` descriptor (``{"type": "noop"}`` here, as these tools have no
  client-side side effect) plus the JSON-serialisable ``tool_result``.
"""

import jina

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the web for up-to-date information. "
                "联网搜索获取实时信息。Returns the top matching results with title, url, and a content snippet."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query / 搜索关键词",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_read",
            "description": (
                "Fetch a web page and extract its readable content as markdown. "
                "抓取网页并提取正文为 markdown。Use when you have a specific URL to read."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The absolute URL of the page to read / 要抓取的网页地址",
                    },
                },
                "required": ["url"],
            },
        },
    },
]


def execute(name: str, args: dict) -> tuple[dict, dict]:
    """Run tool ``name`` with ``args`` and return ``(effect, tool_result)``.

    ``web_search`` returns the top 5 search hits; ``web_read`` returns the
    extracted page. Both are read-only, so the effect is always ``{"type": "noop"}``.
    """
    if name == "web_search":
        query = args.get("query", "")
        return {"type": "noop"}, {"results": jina.search(query)[:5]}
    if name == "web_read":
        url = args.get("url", "")
        return {"type": "noop"}, {"page": jina.read(url)}
    raise ValueError(f"Unknown tool: {name}")
