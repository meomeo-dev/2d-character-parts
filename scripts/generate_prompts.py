#!/usr/bin/env python3
"""
2D Character Parts — Prompt Generator CLI

Generates 19 comprehensive image prompts (1 global + 18 parts) with
quality presets, negative prompts, and aspect ratios for Stable Diffusion,
DALL·E, Midjourney, etc.

Usage:
    python3 scripts/generate_prompts.py                    # All 19, split-screen
    python3 scripts/generate_prompts.py --batch            # All 19, plain (easiest to copy)
    python3 scripts/generate_prompts.py head               # Single part
    python3 scripts/generate_prompts.py torso              # Single part
    python3 scripts/generate_prompts.py --global           # Global only
    python3 scripts/generate_prompts.py --list             # List all part IDs
"""

import argparse
import json
import sys
from pathlib import Path


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def get_all_parts(config):
    """Return flat list of { id, label_cn, label_en, w, h, group }."""
    parts = []
    for g in config["groups"]:
        for p in g["parts"]:
            labels = p["label"].split("\n")
            parts.append(
                {
                    "id": p["id"],
                    "label_cn": labels[0],
                    "label_en": labels[1] if len(labels) > 1 else "",
                    "w": p["w"],
                    "h": p["h"],
                    "group": g["label"],
                }
            )
    return parts


def build_positive(parts_list, profile):
    """
    Combine quality preset + style + subject + background.
    Returns a single dense positive prompt string.
    """
    p = profile["presets"]
    subject = ", ".join(parts_list)
    return f"{p['quality']}, {p['style']}, {subject}, {p['background']}"


def build_global_subject(profile):
    c = profile["character"]
    return [
        "1girl, full body, 45-degree side view, slight top-down angle, character concept art",
        f"{c['hair']}, {c['eyes']}",
        f"wearing {c['outfit']}",
        c["pose"],
    ]


def build_part_subject(part, profile):
    """Build the subject-specific part of a prompt, without quality/style/background."""
    c = profile["character"]
    table = {
        "head": [
            "1girl, head base only for sprite assembly, front view, transparent background",
            f"{c['hair']}, face contour, nose, ears visible",
            "blank eye sockets, no eyes, no pupils, no irises, no mouth, no lips, no teeth",
            "completely blank expressionless face, skin tone only in eye area and mouth area",
            "neck base visible at bottom edge for stitching to torso, shoulders cropped out",
            "this is a base layer — eyes and mouth will be overlaid as separate transparent sprites",
            "clean transparent canvas everywhere except the head itself",
        ],
        "torso": [
            "1girl, torso only, front view, transparent background",
            "from shoulders to waist, no head, no neck, no hair",
            f"wearing {c['outfit']}, outfit torso portion only, no sleeves below shoulder",
            "shoulder area is clean cut edge at top, neck hole visible at top center",
            "arms cropped at shoulders, waist is clean cut edge at bottom",
        ],
        "upper_arm_L": [
            "left upper arm only, from shoulder to elbow, front view, transparent background",
            f"wearing {c['outfit']} sleeve",
            "arm resting straight down at side, bare skin at elbow joint bottom edge",
        ],
        "upper_arm_R": [
            "right upper arm only, from shoulder to elbow, front view, transparent background",
            f"wearing {c['outfit']} sleeve",
            "arm resting straight down at side, bare skin at elbow joint bottom edge",
        ],
        "forearm_L": [
            "left forearm only, from elbow to wrist, front view, transparent background",
            f"wearing {c['outfit']} sleeve rolled up",
            "elbow joint at top edge, wrist at bottom edge",
        ],
        "forearm_R": [
            "right forearm only, from elbow to wrist, front view, transparent background",
            f"wearing {c['outfit']} sleeve rolled up",
            "elbow joint at top edge, wrist at bottom edge",
        ],
        "hand_L": [
            "left hand only, open palm facing viewer, front view, transparent background",
            "wrist at top edge, fingers extending downward, fingers slightly apart",
            "slender fingers, smooth skin, clean cut at wrist",
        ],
        "hand_R": [
            "right hand only, open palm facing viewer, front view, transparent background",
            "wrist at top edge, fingers extending downward, fingers slightly apart",
            "slender fingers, smooth skin, clean cut at wrist",
        ],
        "thigh_L": [
            "left thigh only, from hip to above-knee, front view, transparent background",
            "bare skin, upper leg, no skirt, no clothing on leg",
            "hip top is clean cut edge — skirt belongs to torso sprite",
            "knee area is clean cut edge — knee joint belongs to calf sprite",
        ],
        "thigh_R": [
            "right thigh only, from hip to above-knee, front view, transparent background",
            "bare skin, upper leg, no skirt, no clothing on leg",
            "hip top is clean cut edge — skirt belongs to torso sprite",
            "knee area is clean cut edge — knee joint belongs to calf sprite",
        ],
        "calf_L": [
            "left calf only, knee joint to ankle, front view, transparent background",
            "wearing white knee-high sock covering knee, sock starts at knee joint",
            "sock covers from knee to ankle, skin visible only at very top knee area",
            "shoe not included — foot sprite starts at ankle",
        ],
        "calf_R": [
            "right calf only, knee joint to ankle, front view, transparent background",
            "wearing white knee-high sock covering knee, sock starts at knee joint",
            "sock covers from knee to ankle, skin visible only at very top knee area",
            "shoe not included — foot sprite starts at ankle",
        ],
        "foot_L": [
            "left foot only, from ankle down, front view, transparent background",
            "wearing school loafer shoe, ankle joint at very top edge",
            "sole flat on ground, no calf, no leg above ankle",
        ],
        "foot_R": [
            "right foot only, from ankle down, front view, transparent background",
            "wearing school loafer shoe, ankle joint at very top edge",
            "sole flat on ground, no calf, no leg above ankle",
        ],
        "expr_happy_eyes": [
            "eye area only, front view, transparent background, expression overlay sprite",
            f"{c['eyes']}, eyes wide open with sparkle, happy expression eyebrows raised",
            "ONLY eyes and eyebrows visible — everything else must be fully transparent",
            "NO forehead, NO nose bridge, NO face contour, NO hair, NO mouth",
            "same framing as head base sprite for precise overlay alignment",
            "clean alpha channel, pure transparent canvas outside the eye features",
        ],
        "expr_closed_eyes": [
            "eye area only, front view, transparent background, expression overlay sprite",
            f"{c['eyes']}, eyes closed in gentle upward curve, relaxed expression",
            "ONLY eyes and eyebrows visible — everything else must be fully transparent",
            "NO forehead, NO nose bridge, NO face contour, NO hair, NO mouth",
            "same framing as head base sprite for precise overlay alignment",
            "clean alpha channel, pure transparent canvas outside the eye features",
        ],
        "expr_smile_mouth": [
            "mouth and nose area only, front view, transparent background, expression overlay sprite",
            "lips curved upward in happy smile, small teeth visible, open smile",
            "nose tip visible for alignment reference, ONLY nose and mouth visible",
            "NO chin, NO face contour, NO eyes, NO eyebrows, NO hair",
            "same framing as head base sprite for precise overlay alignment",
            "clean alpha channel, pure transparent canvas outside the mouth features",
        ],
        "expr_surprised_mouth": [
            "mouth and nose area only, front view, transparent background, expression overlay sprite",
            "lips parted in small oval shape, slightly open, surprised expression",
            "nose tip visible for alignment reference, ONLY nose and mouth visible",
            "NO chin, NO face contour, NO eyes, NO eyebrows, NO hair",
            "same framing as head base sprite for precise overlay alignment",
            "clean alpha channel, pure transparent canvas outside the mouth features",
        ],
    }
    return table.get(part["id"], [f"1girl, {part['label_cn']} only"])


def build_part_exclusions(part_id):
    """
    Return extra negative prompt terms that define what MUST NOT appear
    in this part's image. Each part has strict mutual exclusion so that
    the final sprites can be assembled without overlap/conflict.

    Key principles:
    - Adjacent body parts in the anatomical chain are excluded
    - Left/right counterpart parts are excluded
    - Overlapping regions (joint areas) are explicitly excluded
    """
    table = {
        # ── Torso ────────────────────────────────────────
        "torso": [
            # Must NOT contain any part above shoulders or below waist
            "no head",
            "no neck",
            "no arms",
            "no hands",
            "no legs",
            "no feet",
            "不含头部",
            "不含颈部",
            "不含手臂",
            "不含手",
            "不含腿",
            "不含脚",
            "headless",
            "armless",
            "legless",
            "shoulders are clean cut edges for sprite stitching",
            "waist is clean cut edge for sprite stitching",
        ],
        # ── Head (base, NO eyes/mouth — expressions are separate overlays)
        "head": [
            # Must NOT contain: eyes, mouth, body, torso, clothing below neck
            "no eyes",
            "no pupils",
            "no irises",
            "no mouth",
            "no lips",
            "no teeth",
            "no tongue",
            "不含眼睛",
            "不含瞳孔",
            "不含虹膜",
            "不含嘴",
            "不含嘴唇",
            "不含牙齿",
            "no expression",
            "no smile",
            "no eyebrows",
            "不含表情",
            "不含微笑",
            "不含眉毛",
            "no torso",
            "no body",
            "no shoulders",
            "no arms",
            "no legs",
            "不含躯干",
            "不含身体",
            "不含肩部",
            "不含手臂",
            "不含腿",
            "neck base is clean cut edge for sprite stitching",
            "no clothing below neck",
            "blank expressionless face, eye and mouth areas intentionally empty",
        ],
        # ── Thighs (hip → knee) ─────────────────────────
        "thigh_L": [
            # Exclude: torso above hip, calf below knee, right thigh, foot
            "no torso",
            "no upper body",
            "no calf",
            "no foot",
            "不含躯干",
            "不含上半身",
            "不含小腿",
            "不含脚",
            "no right leg",
            "不含右腿",
            "hip top is clean cut edge for sprite stitching",
            "knee bottom is clean cut edge for sprite stitching",
        ],
        "thigh_R": [
            "no torso",
            "no upper body",
            "no calf",
            "no foot",
            "不含躯干",
            "不含上半身",
            "不含小腿",
            "不含脚",
            "no left leg",
            "不含左腿",
            "hip top is clean cut edge for sprite stitching",
            "knee bottom is clean cut edge for sprite stitching",
        ],
        # ── Calves (knee → ankle) ────────────────────────
        "calf_L": [
            # Exclude: thigh above knee, foot below ankle, right calf
            "no thigh",
            "no upper leg",
            "no foot",
            "no shoe",
            "不含大腿",
            "不含大腿",
            "不含脚",
            "不含鞋",
            "no right calf",
            "不含右小腿",
            "knee top is clean cut edge for sprite stitching",
            "ankle bottom is clean cut edge for sprite stitching",
        ],
        "calf_R": [
            "no thigh",
            "no upper leg",
            "no foot",
            "no shoe",
            "不含大腿",
            "不含大腿",
            "不含脚",
            "不含鞋",
            "no left calf",
            "不含左小腿",
            "knee top is clean cut edge for sprite stitching",
            "ankle bottom is clean cut edge for sprite stitching",
        ],
        # ── Feet (ankle → sole) ──────────────────────────
        "foot_L": [
            # Exclude: calf above ankle, right foot, leg
            "no calf",
            "no leg",
            "no ankle visible",
            "不含小腿",
            "不含腿",
            "不含脚踝以上",
            "no right foot",
            "不含右脚",
            "ankle top is clean cut edge for sprite stitching",
            "sole is clean cut edge",
        ],
        "foot_R": [
            "no calf",
            "no leg",
            "no ankle visible",
            "不含小腿",
            "不含腿",
            "不含脚踝以上",
            "no left foot",
            "不含左脚",
            "ankle top is clean cut edge for sprite stitching",
            "sole is clean cut edge",
        ],
        # ── Upper Arms (shoulder → elbow) ────────────────
        "upper_arm_L": [
            # Exclude: torso, shoulder, forearm, hand, right arm
            "no torso",
            "no body",
            "no forearm",
            "no hand",
            "no fingers",
            "不含躯干",
            "不含身体",
            "不含前臂",
            "不含手",
            "不含手指",
            "no right arm",
            "不含右臂",
            "shoulder top is clean cut edge for sprite stitching",
            "elbow bottom is clean cut edge for sprite stitching",
        ],
        "upper_arm_R": [
            "no torso",
            "no body",
            "no forearm",
            "no hand",
            "no fingers",
            "不含躯干",
            "不含身体",
            "不含前臂",
            "不含手",
            "不含手指",
            "no left arm",
            "不含左臂",
            "shoulder top is clean cut edge for sprite stitching",
            "elbow bottom is clean cut edge for sprite stitching",
        ],
        # ── Forearms (elbow → wrist) ─────────────────────
        "forearm_L": [
            # Exclude: upper arm above elbow, hand below wrist, right forearm
            "no upper arm",
            "no bicep",
            "no hand",
            "no palm",
            "no fingers",
            "不含上臂",
            "不含上臂",
            "不含手",
            "不含手掌",
            "不含手指",
            "no right forearm",
            "不含右前臂",
            "elbow top is clean cut edge for sprite stitching",
            "wrist bottom is clean cut edge for sprite stitching",
        ],
        "forearm_R": [
            "no upper arm",
            "no bicep",
            "no hand",
            "no palm",
            "no fingers",
            "不含上臂",
            "不含上臂",
            "不含手",
            "不含手掌",
            "不含手指",
            "no left forearm",
            "不含左前臂",
            "elbow top is clean cut edge for sprite stitching",
            "wrist bottom is clean cut edge for sprite stitching",
        ],
        # ── Hands (wrist → fingers) ──────────────────────
        "hand_L": [
            # Exclude: forearm, arm, right hand
            "no forearm",
            "no arm",
            "no wrist above the hand",
            "不含前臂",
            "不含手臂",
            "不含手腕以上",
            "no right hand",
            "不含右手",
            "wrist top is clean cut edge for sprite stitching",
            "only the hand and wrist, nothing above wrist",
        ],
        "hand_R": [
            "no forearm",
            "no arm",
            "no wrist above the hand",
            "不含前臂",
            "不含手臂",
            "不含手腕以上",
            "no left hand",
            "不含左手",
            "wrist top is clean cut edge for sprite stitching",
            "only the hand and wrist, nothing above wrist",
        ],
        # ── Expressions: Eyes ────────────────────────────
        "expr_happy_eyes": [
            # Eyes and eyebrows ONLY on transparent canvas — clean overlay sprite
            "no mouth",
            "no lips",
            "no teeth",
            "不含嘴",
            "不含嘴唇",
            "不含牙齿",
            "no full face",
            "no body",
            "不含完整脸部",
            "不含身体",
            "no forehead",
            "no nose bridge",
            "no face contour",
            "no hair",
            "不含额头",
            "不含鼻梁",
            "不含脸型轮廓",
            "不含头发",
            "only eyes and eyebrows visible, completely transparent elsewhere",
            "alpha channel sprite, clean edges for overlay compositing",
        ],
        "expr_closed_eyes": [
            "no mouth",
            "no lips",
            "no teeth",
            "不含嘴",
            "不含嘴唇",
            "不含牙齿",
            "no full face",
            "no body",
            "不含完整脸部",
            "不含身体",
            "no forehead",
            "no nose bridge",
            "no face contour",
            "no hair",
            "不含额头",
            "不含鼻梁",
            "不含脸型轮廓",
            "不含头发",
            "only eyes and eyebrows visible, completely transparent elsewhere",
            "alpha channel sprite, clean edges for overlay compositing",
        ],
        # ── Expressions: Mouth ───────────────────────────
        "expr_smile_mouth": [
            # Mouth and nose tip ONLY on transparent canvas — clean overlay sprite
            "no eyes",
            "no eyebrows",
            "no eye",
            "不含眼睛",
            "不含眉毛",
            "不含眼部",
            "no full face",
            "no body",
            "不含完整脸部",
            "不含身体",
            "no chin",
            "no face contour",
            "no hair",
            "不含下巴",
            "不含脸型轮廓",
            "不含头发",
            "only nose tip and mouth visible, completely transparent elsewhere",
            "alpha channel sprite, clean edges for overlay compositing",
        ],
        "expr_surprised_mouth": [
            "no eyes",
            "no eyebrows",
            "no eye",
            "不含眼睛",
            "不含眉毛",
            "不含眼部",
            "no full face",
            "no body",
            "不含完整脸部",
            "不含身体",
            "no chin",
            "no face contour",
            "no hair",
            "不含下巴",
            "不含脸型轮廓",
            "不含头发",
            "only nose tip and mouth visible, completely transparent elsewhere",
            "alpha channel sprite, clean edges for overlay compositing",
        ],
    }
    return table.get(part_id, [])


# ── Output formatters ──────────────────────────────────────


def fmt_card(positive, negative, ar, tagline="", width=58):
    """Render one prompt block as a card with positive/negative/AR."""
    lines = []
    lines.append(f"  ┌{'─' * (width - 2)}┐")

    # Tagline line (e.g. "1/19  [head]")
    if tagline:
        tag = f" {tagline} "
        lines.append(f"  │{tag}{' ' * (width - 2 - len(tag))}│")
        lines.append(f"  ├{'─' * (width - 2)}┤")

    # Positive
    pos_label = " POSITIVE "
    lines.append(f"  │{pos_label}{' ' * (width - 2 - len(pos_label))}│")
    for chunk in _wrap(positive, width - 4):
        lines.append(f"  │ {chunk:<{width - 4}} │")

    # Negative
    lines.append(f"  ├{'─' * (width - 2)}┤")
    neg_label = " NEGATIVE "
    lines.append(f"  │{neg_label}{' ' * (width - 2 - len(neg_label))}│")
    for chunk in _wrap(negative, width - 4):
        lines.append(f"  │ {chunk:<{width - 4}} │")

    # AR
    lines.append(f"  ├{'─' * (width - 2)}┤")
    lines.append(f"  │ AR: {ar:<{width - 7}} │")
    lines.append(f"  └{'─' * (width - 2)}┘")
    return "\n".join(lines)


def fmt_plain(positive, negative, ar, tagline=""):
    """Render one prompt block as plain text for easy copy-paste."""
    lines = []
    if tagline:
        lines.append(tagline)
    lines.append(f"Positive: {positive}")
    lines.append(f"Negative: {negative}")
    lines.append(f"AR: {ar}")
    lines.append("")
    return "\n".join(lines)


def _wrap(text, width):
    """Simple word wrap: split at commas, group into lines ≤ width."""
    words = text.split(", ")
    lines = []
    current = ""
    for w in words:
        sep = ", " if current else ""
        candidate = f"{current}{sep}{w}"
        if len(candidate) > width and current:
            lines.append(current + ",")
            current = w
        else:
            current = candidate
    if current:
        lines.append(current + ",")
    return [line.rstrip(",") for line in lines]


# ── Output modes ────────────────────────────────────────────


def output_all(profile, config, batch):
    parts = get_all_parts(config)
    p = profile["presets"]
    neg = p["negative"]

    # Global
    positive = build_positive(build_global_subject(profile), profile)
    if batch:
        print("─" * 50)
        print("GLOBAL REFERENCE — 全局参考图")
        print(f"AR: {p['ar_global']}")
        print()
        print(f"Positive: {positive}")
        print(f"Negative: {neg}")
        print()
    else:
        print(f"\n  {'=' * 58}")
        print("  1/19  GLOBAL REFERENCE  全局参考图")
        print(f"  {'=' * 58}")
        print(fmt_card(positive, neg, p["ar_global"]))
        print()

    # Parts
    for i, part in enumerate(parts, 2):
        label = part["label_cn"]
        if part["label_en"]:
            label += f" / {part['label_en']}"
        tag = f"{i}/19  [{part['id']}]  {label}  ({part['w']}×{part['h']})"

        subject_lines = build_part_subject(part, profile)
        positive = build_positive(subject_lines, profile)

        if batch:
            print(tag)
            print(f"AR: {p['ar_part']}")
            print()
            print(f"Positive: {positive}")
            print(f"Negative: {neg}")
            print()
        else:
            print(fmt_card(positive, neg, p["ar_part"], tagline=tag))
            print()


def output_global(profile):
    p = profile["presets"]
    positive = build_positive(build_global_subject(profile), profile)
    print(f"\n{'=' * 58}")
    print("  GLOBAL REFERENCE  全局参考图")
    print(f"{'=' * 58}")
    print(f"AR: {p['ar_global']}")
    print()
    print(f"Positive: {positive}")
    print(f"Negative: {p['negative']}")
    print()


def output_one(part, profile):
    p = profile["presets"]
    label = part["label_cn"]
    if part["label_en"]:
        label += f" / {part['label_en']}"
    tag = f"[{part['id']}]  {label}  ({part['w']}×{part['h']})"

    subject_lines = build_part_subject(part, profile)
    positive = build_positive(subject_lines, profile)

    print(f"\n{'─' * 58}")
    print(f"  {tag}")
    print(f"{'─' * 58}")
    print(f"AR: {p['ar_part']}")
    print()
    print(f"Positive: {positive}")
    print(f"Negative: {p['negative']}")
    print()


def list_parts(config):
    parts = get_all_parts(config)
    print(f"\n  {'ID':<22} {'Name':<16} {'Dim':<10} Group")
    print(f"  {'─' * 22} {'─' * 16} {'─' * 10} {'─' * 16}")
    for p in parts:
        dim = f"{p['w']}×{p['h']}"
        print(f"  {p['id']:<22} {p['label_cn']:<16} {dim:<10} {p['group'].split()[0]}")
    print(f"\n  Total: {len(parts)} parts")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="2D Character Parts — Prompt Generator CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("part", nargs="?", help="Part ID (e.g. head, torso)")
    parser.add_argument("--global", dest="global_ref", action="store_true", help="Global reference only")
    parser.add_argument("--list", action="store_true", help="List all parts")
    parser.add_argument("--batch", action="store_true", help="Plain batch mode (easiest to copy)")
    parser.add_argument("--config", default="config/parts_layout.json")
    parser.add_argument("--profile", default="config/character_profile.json")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent.parent
    config = load_json(script_dir / args.config)
    profile = load_json(script_dir / args.profile)

    if args.list:
        list_parts(config)
        return

    if args.global_ref:
        output_global(profile)
        return

    if args.part:
        parts = get_all_parts(config)
        found = [p for p in parts if p["id"] == args.part]
        if not found:
            print(f"❌ Unknown part: {args.part}")
            print("   Use --list to see all available parts.")
            sys.exit(1)
        output_one(found[0], profile)
        return

    output_all(profile, config, args.batch)


if __name__ == "__main__":
    main()
