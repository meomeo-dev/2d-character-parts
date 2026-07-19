#!/usr/bin/env python3
"""Companion motion/expression tools for the 2D sprite avatar.

Exposes the OpenAI-style ``TOOL_DEFINITIONS`` the LLM may call plus an
``execute(name, args)`` dispatcher that normalises the model's raw arguments
into a clamped, client-facing *effect* directive.

This is the 2D counterpart of the original VRM tool set: ``motion_play`` /
``face_set`` / ``motion_stop``. The 3D-only ``head_look_at`` is intentionally
dropped — a flat sprite has no head to rotate.

``execute`` returns ``(effect, tool_result)``:
    * ``effect`` — dict consumed by the frontend ``Sprite2DController``.
    * ``tool_result`` — small JSON payload fed back to the model as the
      ``role: tool`` message.
"""

# Facial expressions the 2D avatar can display. Unknown values coerce to
# ``neutral`` so a malformed tool call never leaves the sprite in a bad state.
FACE_EXPRESSIONS = ("happy", "relaxed", "surprised", "blink", "neutral")

# Motion clip names the model is nudged toward. ``motion_play.name`` is a free
# string (a clip name), not a hard enum, so any generated sprite-sheet clip can
# be triggered by name; these are only suggestions surfaced in the schema.
SUGGESTED_MOTIONS = (
    "idle",
    "wave",
    "nod",
    "think",
    "happy",
    "greet",
    "listen",
    "cheer",
    "shy",
    "sleepy",
)

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "motion_play",
            "description": (
                "Play a body motion clip for the 2D avatar. "
                "播放 2D 立绘的身体动作。name 为动画 clip 名(自由字符串)，"
                f"常用值: {', '.join(SUGGESTED_MOTIONS)}。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Animation clip name, e.g. wave / nod / think / idle / happy.",
                    },
                    "intensity": {"type": "number", "description": "0.1–1.0 motion strength."},
                    "speed": {"type": "number", "description": "0.4–2.0 playback speed."},
                    "duration": {"type": "number", "description": "0.2–4.0 seconds."},
                    "loop": {"type": "boolean", "description": "Whether the clip loops."},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "face_set",
            "description": "Set a facial expression for the 2D avatar. 设置 2D 立绘的表情。",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "enum": list(FACE_EXPRESSIONS),
                    },
                    "weight": {"type": "number", "description": "0.0–1.0 expression blend weight."},
                    "duration": {"type": "number", "description": "0.05–2.0 seconds transition."},
                },
                "required": ["expression", "weight"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "motion_stop",
            "description": "Stop an active motion by name and return to idle. 停止指定动作并回到待机。",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Clip name to stop."},
                },
                "required": ["name"],
            },
        },
    },
]


def _clamp(value: object, low: float, high: float, default: float) -> float:
    """Coerce ``value`` to a float in ``[low, high]``, using ``default`` if unparseable."""
    try:
        num = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        num = default
    return min(high, max(low, num))


def _normalize_expression(value: object) -> str:
    """Return ``value`` if it is a known expression, else ``"neutral"``."""
    return value if value in FACE_EXPRESSIONS else "neutral"


def execute(name: str, args: dict) -> tuple[dict, dict]:
    """Dispatch a tool call to its handler and return ``(effect, tool_result)``.

    Unknown tools yield a ``{"type": "noop"}`` effect (skipped by the caller)
    and a ``{"status": "ignored"}`` result.
    """
    args = args or {}

    if name == "motion_play":
        effect = {
            "type": "motion_play",
            "name": str(args.get("name") or "nod"),
            "intensity": _clamp(args.get("intensity", 0.7), 0.1, 1.0, 0.7),
            "speed": _clamp(args.get("speed", 1.0), 0.4, 2.0, 1.0),
            "duration": _clamp(args.get("duration", 1.2), 0.2, 4.0, 1.2),
            "loop": bool(args.get("loop", False)),
        }
        return effect, {"status": "ok"}

    if name == "face_set":
        effect = {
            "type": "face_set",
            "expression": _normalize_expression(args.get("expression", "happy")),
            "weight": _clamp(args.get("weight", 0.4), 0.0, 1.0, 0.4),
            "duration": _clamp(args.get("duration", 0.25), 0.05, 2.0, 0.25),
        }
        return effect, {"status": "ok"}

    if name == "motion_stop":
        effect = {"type": "motion_stop", "name": str(args.get("name") or "idle")}
        return effect, {"status": "ok"}

    return {"type": "noop"}, {"status": "ignored"}
