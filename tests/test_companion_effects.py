"""Unit tests for ``companion_effects.execute`` — argument clamping and normalisation."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import companion_effects as ce


def test_motion_play_clamps_out_of_range_values():
    effect, result = ce.execute(
        "motion_play",
        {"name": "wave", "intensity": 5, "speed": 0.01, "duration": 100, "loop": True},
    )
    assert effect["type"] == "motion_play"
    assert effect["name"] == "wave"
    assert effect["intensity"] == 1.0  # clamped down to max
    assert effect["speed"] == 0.4  # clamped up to min
    assert effect["duration"] == 4.0  # clamped down to max
    assert effect["loop"] is True
    assert result == {"status": "ok"}


def test_motion_play_invalid_numbers_fall_back_to_defaults():
    effect, _ = ce.execute("motion_play", {"name": "nod", "intensity": "abc", "speed": None})
    assert effect["intensity"] == 0.7
    assert effect["speed"] == 1.0
    assert effect["duration"] == 1.2  # missing -> default


def test_motion_play_defaults_name_when_missing():
    effect, _ = ce.execute("motion_play", {})
    assert effect["name"] == "nod"
    assert effect["loop"] is False


def test_face_set_clamps_weight_and_duration():
    effect, result = ce.execute("face_set", {"expression": "happy", "weight": 2.0, "duration": 0.001})
    assert effect["expression"] == "happy"
    assert effect["weight"] == 1.0  # clamped down to max
    assert effect["duration"] == 0.05  # clamped up to min
    assert result == {"status": "ok"}


def test_face_set_unknown_expression_coerces_to_neutral():
    effect, _ = ce.execute("face_set", {"expression": "angry", "weight": 0.5})
    assert effect["expression"] == "neutral"
    assert effect["weight"] == 0.5


def test_face_set_defaults():
    effect, _ = ce.execute("face_set", {})
    assert effect["expression"] == "happy"
    assert effect["weight"] == 0.4
    assert effect["duration"] == 0.25


def test_motion_stop_defaults_to_idle():
    effect, result = ce.execute("motion_stop", {})
    assert effect == {"type": "motion_stop", "name": "idle"}
    assert result == {"status": "ok"}


def test_unknown_tool_returns_noop():
    effect, result = ce.execute("head_look_at", {"yaw": 0.2})
    assert effect == {"type": "noop"}
    assert result["status"] == "ignored"


def test_execute_tolerates_none_args():
    effect, _ = ce.execute("motion_stop", None)
    assert effect["name"] == "idle"


def test_tool_definitions_shape():
    names = {t["function"]["name"] for t in ce.TOOL_DEFINITIONS}
    assert names == {"motion_play", "face_set", "motion_stop"}

    motion_play = next(t for t in ce.TOOL_DEFINITIONS if t["function"]["name"] == "motion_play")
    # motion_play.name is a free-form clip name, not a constrained enum.
    assert "enum" not in motion_play["function"]["parameters"]["properties"]["name"]

    face_set = next(t for t in ce.TOOL_DEFINITIONS if t["function"]["name"] == "face_set")
    assert set(face_set["function"]["parameters"]["properties"]["expression"]["enum"]) == set(ce.FACE_EXPRESSIONS)
