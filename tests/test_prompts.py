"""Unit tests for prompt generation — ensures all 19 prompts are well-formed."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from generate_prompts import (
    build_global_subject,
    build_part_exclusions,
    build_part_subject,
    build_positive,
    get_all_parts,
    load_json,
)


def get_fixtures():
    config = load_json(Path(__file__).resolve().parent.parent / "config" / "parts_layout.json")
    profile = load_json(Path(__file__).resolve().parent.parent / "config" / "character_profile.json")
    parts = get_all_parts(config)
    return config, profile, parts


def test_load_json():
    config, profile, _ = get_fixtures()
    assert "meta" in config
    assert "groups" in config
    assert "pipeline" in config
    assert "name" in profile
    assert "character" in profile
    assert "presets" in profile


def test_all_parts_present():
    _, _, parts = get_fixtures()
    assert len(parts) == 18, f"Expected 18 parts, got {len(parts)}"


def test_every_part_has_subject():
    _, profile, parts = get_fixtures()
    for p in parts:
        subj = build_part_subject(p, profile)
        assert len(subj) > 0, f"{p['id']} has empty subject"
        pos = build_positive(subj, profile)
        assert len(pos) > 0, f"{p['id']} has empty positive prompt"


def test_every_part_has_exclusions():
    _, _, parts = get_fixtures()
    for p in parts:
        ex = build_part_exclusions(p["id"])
        assert len(ex) > 0, f"{p['id']} has no exclusion terms"


def test_global_subject_has_view_angle():
    _, profile, _ = get_fixtures()
    subj = build_global_subject(profile)
    pos = build_positive(subj, profile)
    assert "45-degree" in pos or "side view" in pos, "Global missing 45-degree view angle"


def test_parts_have_front_view_and_transparent():
    _, profile, parts = get_fixtures()
    for p in parts:
        subj = build_part_subject(p, profile)
        pos = build_positive(subj, profile)
        assert "front view" in pos.lower(), f"{p['id']} missing 'front view'"
        assert "transparent" in pos.lower(), f"{p['id']} missing 'transparent'"


def test_head_has_blank_face():
    _, profile, parts = get_fixtures()
    head = [p for p in parts if p["id"] == "head"][0]
    pos = build_positive(build_part_subject(head, profile), profile)
    assert "no eyes" in pos.lower() or "blank" in pos.lower()


def test_expression_sprites_are_transparent_overlays():
    _, profile, parts = get_fixtures()
    for pid in ["expr_happy_eyes", "expr_closed_eyes", "expr_smile_mouth", "expr_surprised_mouth"]:
        p = [x for x in parts if x["id"] == pid][0]
        subj = build_part_subject(p, profile)
        pos = ", ".join(subj).lower()
        assert "transparent" in pos, f"{pid} missing 'transparent'"
        assert "overlay" in pos, f"{pid} missing 'overlay'"


def test_part_exclusion_chains():
    """Verify adjacent limb parts exclude each other."""
    _, _, parts = get_fixtures()

    # Upper arm must exclude forearm and hand
    for pid in ["upper_arm_L", "upper_arm_R"]:
        ex = build_part_exclusions(pid)
        ex_text = " ".join(ex).lower()
        assert "forearm" in ex_text, f"{pid} doesn't exclude forearm"
        assert "hand" in ex_text, f"{pid} doesn't exclude hand"

    # Thigh must exclude calf and foot
    for pid in ["thigh_L", "thigh_R"]:
        ex = build_part_exclusions(pid)
        ex_text = " ".join(ex).lower()
        assert "calf" in ex_text, f"{pid} doesn't exclude calf"
        assert "foot" in ex_text, f"{pid} doesn't exclude foot"


def test_opposite_side_exclusion():
    """Verify left/right exclusion — each L part must exclude its R counterpart semantically."""
    opposite_check = {
        "thigh_L": ["no right leg", "不含右腿"],
        "thigh_R": ["no left leg", "不含左腿"],
        "calf_L": ["no right calf", "不含右小腿"],
        "calf_R": ["no left calf", "不含左小腿"],
        "upper_arm_L": ["no right arm", "不含右臂"],
        "upper_arm_R": ["no left arm", "不含左臂"],
        "forearm_L": ["no right forearm", "不含右前臂"],
        "forearm_R": ["no left forearm", "不含左前臂"],
        "hand_L": ["no right hand", "不含右手"],
        "hand_R": ["no left hand", "不含左手"],
        "foot_L": ["no right foot", "不含右脚"],
        "foot_R": ["no left foot", "不含左脚"],
    }
    for base, keywords in opposite_check.items():
        ex = build_part_exclusions(base)
        ex_text = " ".join(ex).lower()
        found = any(kw.lower() in ex_text for kw in keywords)
        assert found, f"{base} doesn't exclude its counterpart (checked: {keywords})"
