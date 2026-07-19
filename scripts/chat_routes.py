#!/usr/bin/env python3
"""Chat / companion API routes: ``POST /api/chat`` and ``POST /api/memory/compress``.

Registered into the studio server via ``register(get_map, post_map)`` (see
``studio.FEATURE_ROUTE_MODULES``). Handlers have the signature
``handler(h, parsed) -> None`` where ``h`` is the ``StudioHandler`` instance.

Responsibilities:
    * Build the system prompt (persona from ``config/character_profile.json`` +
      long-term memory + optional retrieved memories + scene context) and the
      chat message list.
    * Aggregate callable tools from ``COMPANION_TOOL_MODULES`` (motion effects
      here; web-search tools from Track D's ``jina_tools`` when present) and
      drive the tool-calling loop via ``llm_gateway.run_tool_loop``.
    * Compress recent conversation into a structured relationship-diary summary.

Security: API keys live only in ``providers``/``llm_gateway``; this module never
reads or echoes them. ``/api/health`` reports *whether* a key is configured as a
boolean, never the value.
"""

import importlib
import json
from collections.abc import Callable
from pathlib import Path

import companion_effects
import llm_gateway
import providers
from _http import HttpError

PROJECT_DIR = Path(__file__).resolve().parent.parent
PROFILE_PATH = PROJECT_DIR / "config" / "character_profile.json"

# Modules contributing LLM tools. Each must expose ``TOOL_DEFINITIONS`` (list)
# and ``execute(name, args) -> (effect, tool_result)``. ``jina_tools`` is
# provided by Track D and imported defensively — its absence is not an error.
COMPANION_TOOL_MODULES = ["companion_effects", "jina_tools"]

# Tools from this module are body/face gestures, gated behind the frontend's
# "auto gesture" toggle. Tools from other modules (e.g. web search) stay
# available regardless of that toggle.
MOTION_TOOL_MODULE = "companion_effects"

# Cached ``(tool_definitions, dispatch, tool_owner)`` registry, built on first use.
_REGISTRY: tuple[list[dict], dict[str, Callable], dict[str, str]] | None = None


# ── Route registration ──────────────────────────────────


def register(get_map: dict, post_map: dict) -> None:
    """Register chat routes into the studio handler maps."""
    get_map["/api/health"] = handle_health
    post_map["/api/chat"] = handle_chat
    post_map["/api/memory/compress"] = handle_memory_compress


# ── Tool registry ───────────────────────────────────────


def _build_registry() -> tuple[list[dict], dict[str, Callable], dict[str, str]]:
    """Import each tool module (guarded) and aggregate their definitions.

    Returns ``(tool_definitions, dispatch, tool_owner)`` where ``dispatch`` maps
    a tool name to its module's ``execute`` and ``tool_owner`` maps a tool name
    to the owning module name.
    """
    tool_definitions: list[dict] = []
    dispatch: dict[str, Callable] = {}
    tool_owner: dict[str, str] = {}

    for mod_name in COMPANION_TOOL_MODULES:
        try:
            module = importlib.import_module(mod_name)
        except ImportError:
            continue  # optional module (e.g. jina_tools) not present — skip
        definitions = getattr(module, "TOOL_DEFINITIONS", None)
        execute = getattr(module, "execute", None)
        if not isinstance(definitions, list) or not callable(execute):
            continue
        for tool in definitions:
            fn_name = (tool.get("function") or {}).get("name")
            if not fn_name:
                continue
            dispatch[fn_name] = execute
            tool_owner[fn_name] = mod_name
            tool_definitions.append(tool)

    return tool_definitions, dispatch, tool_owner


def _get_registry() -> tuple[list[dict], dict[str, Callable], dict[str, str]]:
    """Return the cached tool registry, building it on first access."""
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = _build_registry()
    return _REGISTRY


def _make_executor(dispatch: dict[str, Callable]) -> Callable[[str, dict], tuple[dict, dict]]:
    """Return a unified ``execute(name, args)`` that dispatches to the owning module."""

    def _execute(name: str, args: dict) -> tuple[dict, dict]:
        handler = dispatch.get(name)
        if handler is None:
            return {"type": "noop"}, {"status": "ignored", "error": f"unknown tool: {name}"}
        return handler(name, args)

    return _execute


# ── Prompt / message assembly ───────────────────────────


def _load_profile() -> dict:
    """Load ``character_profile.json``, returning an empty dict if unreadable."""
    try:
        return json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _config_persona_field(payload: dict, key: str) -> str:
    """Return a trimmed persona override from ``payload.config.persona[key]``."""
    config = payload.get("config") or {}
    persona = config.get("persona") or {}
    return (persona.get(key) or "").strip()


def _resolve_system_prompt(profile: dict, payload: dict) -> str:
    """Resolve the persona system prompt: UI override wins, else the profile default."""
    override = _config_persona_field(payload, "systemPrompt")
    if override:
        return override
    return (profile.get("persona", {}).get("system_prompt") or "").strip()


def _resolve_diary_prompt(profile: dict, payload: dict) -> str:
    """Resolve the diary/compression prompt: UI override wins, else the profile default."""
    override = _config_persona_field(payload, "diaryPrompt")
    if override:
        return override
    return (profile.get("persona", {}).get("diary_prompt") or "").strip()


def build_memory_block(payload: dict) -> str:
    """Serialise the long-term memory (recent diary + stable profile) for the prompt."""
    diary = payload.get("relationshipDiary") or []
    stable_profile = payload.get("stableProfile") or {}
    if not diary and not stable_profile:
        return "暂无长期关系记忆。"
    return json.dumps(
        {"relationshipDiary": diary[:3], "stableProfile": stable_profile},
        ensure_ascii=False,
        indent=2,
    )


def build_system_prompt(profile: dict, payload: dict) -> str:
    """Assemble the full system prompt from persona, tool guidance, memory, and scene."""
    blocks = [
        _resolve_system_prompt(profile, payload),
        (
            "你可以在合适的时候调用轻量动作工具(motion_play / face_set / motion_stop)，"
            "让说话与表情更自然协调。优先使用简短、自然、短时的动作，不要无意义地频繁调用。"
            f"常用动作名包括: {', '.join(companion_effects.SUGGESTED_MOTIONS)}。"
        ),
    ]

    retrieved = payload.get("retrievedMemories")
    if retrieved:
        blocks.append("以下是与当前话题相关的历史记忆检索结果，可作参考：")
        blocks.append(json.dumps(retrieved, ensure_ascii=False, indent=2))

    blocks.append("长期关系记忆如下：")
    blocks.append(build_memory_block(payload))
    blocks.append("当前场景信息如下：")
    blocks.append(json.dumps(payload.get("sceneContext") or {}, ensure_ascii=False))

    return "\n\n".join(blocks)


def build_chat_messages(payload: dict, profile: dict) -> list[dict]:
    """Build the OpenAI-style message list: system + recent history + current turn."""
    messages: list[dict] = [{"role": "system", "content": build_system_prompt(profile, payload)}]
    messages.extend(
        {"role": message.get("role", "user"), "content": message.get("content", "")}
        for message in payload.get("recentMessages") or []
    )

    user_message = (payload.get("userMessage") or "").strip()
    if payload.get("mode") == "timer":
        user_message = user_message or (
            "请你结合最近对话与关系记忆，自然地主动说一句简短、具体、带一点温度的话。"
            "若适合，可以调用一个轻量动作工具。避免重复上一轮表达。"
        )
    if user_message:
        messages.append({"role": "user", "content": user_message})

    return messages


# ── Core operations ─────────────────────────────────────


def run_chat(payload: dict) -> dict:
    """Run one chat turn (with tool loop) and return the assistant result dict."""
    profile = _load_profile()
    messages = build_chat_messages(payload, profile)

    tool_definitions, dispatch, tool_owner = _get_registry()
    config = payload.get("config") or {}
    enable_gesture = (config.get("motion") or {}).get("enableAutoGesture", True)
    if enable_gesture:
        tools = tool_definitions
    else:
        tools = [t for t in tool_definitions if tool_owner.get(t["function"]["name"]) != MOTION_TOOL_MODULE]

    return llm_gateway.run_tool_loop(
        messages,
        tools,
        _make_executor(dispatch),
        model=None,  # chat uses the configured LLM provider model (providers.get_llm)
    )


def run_memory_compression(payload: dict) -> dict:
    """Compress recent conversation into a structured relationship-diary summary.

    Returns ``{"summary": {...}, "stableProfilePatch": {...}}`` (the patch is
    split out of the model's JSON object).
    """
    profile = _load_profile()
    diary_prompt = _resolve_diary_prompt(profile, payload)
    recent_messages = payload.get("recentMessages") or []
    relationship_diary = payload.get("relationshipDiary") or []

    messages = [
        {
            "role": "system",
            "content": "\n".join(
                [
                    "你负责把对话压缩成结构化的关系日记 JSON。",
                    diary_prompt,
                    "你必须只输出 JSON 对象，不要输出 Markdown，不要输出解释。",
                    "字段必须包含: summaryVersion,timeRange,episodeTitle,relationshipStage,emotionTone,"
                    "trustDelta,userPreferencesConfirmed,newFacts,sharedMoments,unresolvedThreads,"
                    "carePoints,boundaries,repairNeeded,nextOpeners,evidenceQuotes,confidence,stableProfilePatch。",
                ]
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {"recentMessages": recent_messages, "existingDiary": relationship_diary[:3]},
                ensure_ascii=False,
            ),
        },
    ]

    response = llm_gateway.chat(
        messages,
        model=None,  # chat uses the configured LLM provider model (providers.get_llm)
        extra={"response_format": {"type": "json_object"}},
    )
    raw_content = response["choices"][0]["message"].get("content", "{}")

    try:
        summary = json.loads(raw_content)
    except json.JSONDecodeError:
        summary = _fallback_summary(raw_content)

    stable_profile_patch = summary.pop("stableProfilePatch", {}) if isinstance(summary, dict) else {}
    return {"summary": summary, "stableProfilePatch": stable_profile_patch}


def _fallback_summary(raw_content: str) -> dict:
    """Return a minimal well-formed summary when the model output is not valid JSON."""
    return {
        "summaryVersion": 1,
        "timeRange": "recent",
        "episodeTitle": "临时摘要",
        "relationshipStage": "warming-up",
        "emotionTone": "gentle",
        "trustDelta": "stable",
        "userPreferencesConfirmed": [],
        "newFacts": [],
        "sharedMoments": [],
        "unresolvedThreads": [],
        "carePoints": [],
        "boundaries": [],
        "repairNeeded": [],
        "nextOpeners": [],
        "evidenceQuotes": [],
        "confidence": 0.3,
        "stableProfilePatch": {},
        "rawContent": raw_content,
    }


# ── HTTP handlers ───────────────────────────────────────


def _read_json_body(h) -> dict:
    """Read and parse the request JSON body; return ``{}`` when empty."""
    length = int(h.headers.get("Content-Length", 0))
    return json.loads(h.rfile.read(length)) if length else {}


def handle_health(h, parsed) -> None:
    """GET /api/health — report proxy readiness and whether an LLM key is configured."""
    llm = providers.get_llm()
    h._json_response(
        {
            "ok": True,
            "apiKeyConfigured": bool(llm.get("api_key")),
            "model": llm.get("model", ""),
            "baseUrl": llm.get("base_url", ""),
        }
    )


def handle_chat(h, parsed) -> None:
    """POST /api/chat — run a companion chat turn and return the assistant result."""
    try:
        payload = _read_json_body(h)
    except json.JSONDecodeError:
        h._json_response({"error": "Invalid JSON"}, 400)
        return

    try:
        result = run_chat(payload)
    except HttpError as exc:
        h._json_response({"error": f"LLM gateway error: {exc}"}, 502)
        return
    except Exception as exc:  # defensive: never crash the server thread
        h._json_response({"error": f"Chat failed: {exc}"}, 500)
        return

    h._json_response(result)


def handle_memory_compress(h, parsed) -> None:
    """POST /api/memory/compress — compress recent turns into a relationship-diary summary."""
    try:
        payload = _read_json_body(h)
    except json.JSONDecodeError:
        h._json_response({"error": "Invalid JSON"}, 400)
        return

    try:
        result = run_memory_compression(payload)
    except HttpError as exc:
        h._json_response({"error": f"LLM gateway error: {exc}"}, 502)
        return
    except Exception as exc:  # defensive: never crash the server thread
        h._json_response({"error": f"Memory compression failed: {exc}"}, 500)
        return

    h._json_response(result)
