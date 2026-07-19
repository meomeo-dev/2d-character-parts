"""Unit tests for the sprite-sheet animation feature (Track B).

Pillow is required for most tests; the whole module is skipped when it is
absent. The image/LLM clients are mocked, so nothing here touches the network,
real API keys, or the real ``animations/`` directory.
"""

import io
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

pytest.importorskip("PIL")
import animation_routes
import sprite_animation as sa
from PIL import Image, ImageDraw

LW = 2


def _cell_size(target_width, cols, lw=LW):
    """Mirror the production cell-size formula."""
    return (target_width - (cols + 1) * lw) // cols


def _distinct_sheet(rows, cols, target_width, lw=LW):
    """Build a grid sheet whose cells each hold a distinct grayscale value.

    A real sprite sheet has visually distinct frames; PIL's GIF encoder merges
    consecutive *pixel-identical* frames, so a plain (all-white) grid would
    collapse to a single frame. Painting each cell differently keeps every
    frame, letting frame-count assertions be meaningful.
    """
    png, _w, _h = sa.create_grid_image(rows, cols, target_width, lw)
    im = Image.open(io.BytesIO(png)).convert("RGB")
    draw = ImageDraw.Draw(im)
    cell = _cell_size(target_width, cols, lw)
    total = rows * cols
    idx = 0
    for r in range(rows):
        for c in range(cols):
            left = c * (cell + lw) + lw
            upper = r * (cell + lw) + lw
            g = int(255 * idx / max(1, total - 1))
            draw.rectangle([left, upper, left + cell - 1, upper + cell - 1], fill=(g, g, g))
            idx += 1
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


# ── create_grid_image ───────────────────────────────────


@pytest.mark.parametrize(
    "rows,cols,target_width",
    [(2, 2, 500), (3, 4, 1000), (6, 6, 1550), (4, 3, 800)],
)
def test_create_grid_dimensions(rows, cols, target_width):
    png, w, h = sa.create_grid_image(rows, cols, target_width, LW)
    cell = _cell_size(target_width, cols)
    assert w == cols * cell + (cols + 1) * LW
    assert h == rows * cell + (rows + 1) * LW
    # Cells are square: width formula uses the same cell for height.
    assert (h - (rows + 1) * LW) // rows == cell
    with Image.open(io.BytesIO(png)) as im:
        assert im.size == (w, h)
        assert im.mode == "RGB"


def test_create_grid_odd_line_width_normalized():
    # Odd line width is clamped up to the smallest even width (2).
    _png, w, h = sa.create_grid_image(2, 2, 500, line_width=3)
    cell = _cell_size(500, 2, lw=2)
    assert w == 2 * cell + 3 * 2
    assert h == 2 * cell + 3 * 2


@pytest.mark.parametrize("rows,cols", [(1, 3), (7, 3), (3, 1), (3, 7)])
def test_create_grid_rejects_out_of_range(rows, cols):
    with pytest.raises(ValueError):
        sa.create_grid_image(rows, cols, 800)


def test_create_grid_rejects_tiny_width():
    with pytest.raises(ValueError):
        sa.create_grid_image(3, 3, 5)


# ── build_prompt ────────────────────────────────────────


def test_build_prompt_new_mode_text():
    p = sa.build_prompt(
        "knight running",
        3,
        4,
        style="Pixel Art",
        era="Medieval",
        lighting="None",
        composition="None",
        color="Vibrant",
        mode="new",
    )
    assert "Sprite sheet of a knight running illustration" in p
    assert "Pixel Art style" in p
    assert "Medieval era" in p
    assert "Vibrant colors" in p
    assert "None era" not in p and "None colors" not in p  # sentinel filtered
    assert "3x4 grid (3 rows and 4 columns)" in p
    assert "white background, sequence, frame by frame animation, square aspect ratio." in p
    assert p.startswith("Create a new image by :")
    assert p.rstrip().endswith("Return the drawn picture.")


def test_build_prompt_continue_mode_text():
    p = sa.build_prompt(
        "knight jumping",
        2,
        3,
        style="Anime",
        mode="continue",
        prev_prompt_context="knight running",
    )
    assert "continuing the animation sequence" in p
    assert 'Previous Prompt Context: "knight running"' in p
    assert 'Current Prompt Context: "knight jumping"' in p
    assert "first row of the attached image contains the LAST frames" in p


def test_build_prompt_continue_without_context_falls_back_to_new():
    p = sa.build_prompt("x", 2, 2, mode="continue", prev_prompt_context=None)
    assert p.startswith("Create a new image by :")


def test_build_prompt_omits_all_none_modifiers():
    p = sa.build_prompt("robot", 2, 2)
    # No style/era/... supplied -> no leading modifier comma soup.
    assert "Sprite sheet of a robot illustration, 2x2 grid" in p


# ── slice_and_gif ───────────────────────────────────────


def test_slice_and_gif_frame_count(tmp_path):
    rows, cols = 3, 4
    png = _distinct_sheet(rows, cols, cols * 128 + (cols + 1) * LW)
    sheet = tmp_path / "sheet.png"
    sheet.write_bytes(png)

    gif = sa.slice_and_gif(str(sheet), rows, cols, out_path=str(tmp_path / "out.gif"))
    assert Path(gif).exists()
    with Image.open(gif) as im:
        assert getattr(im, "n_frames", 1) == rows * cols


def test_slice_and_gif_default_out_path(tmp_path):
    png, _w, _h = sa.create_grid_image(2, 2, 400, LW)
    sheet = tmp_path / "mysheet.png"
    sheet.write_bytes(png)
    gif = sa.slice_and_gif(str(sheet), 2, 2)
    assert gif == str(tmp_path / "mysheet.gif")
    assert Path(gif).exists()


# ── image_difference ────────────────────────────────────


def test_image_difference_identical_is_zero():
    png, _w, _h = sa.create_grid_image(2, 2, 400, LW)
    with Image.open(io.BytesIO(png)) as im:
        assert sa.image_difference(im, im.copy()) == 0.0
    # Also accepts raw PNG bytes.
    assert sa.image_difference(png, png) == 0.0


def test_image_difference_positive_for_different():
    png, _w, _h = sa.create_grid_image(2, 2, 400, LW)
    black = Image.new("RGB", (64, 64), "black")
    with Image.open(io.BytesIO(png)) as white_ish:
        assert sa.image_difference(white_ish, black) > 0


# ── synthesize_continuation_grid ────────────────────────


def test_synthesize_continuation_copies_last_row(tmp_path):
    rows, cols = 2, 3
    tw = cols * 128 + (cols + 1) * LW

    # Template: plain white grid.
    tpl_png, _w, _h = sa.create_grid_image(rows, cols, tw, LW)
    template = tmp_path / "template.png"
    template.write_bytes(tpl_png)

    # Prev sheet: same grid, fully painted red so its last row is distinctive.
    prev_png, pw, ph = sa.create_grid_image(rows, cols, tw, LW)
    prev = tmp_path / "prev.png"
    with Image.open(io.BytesIO(prev_png)) as pimg:
        pimg = pimg.convert("RGB")
        ImageDraw.Draw(pimg).rectangle([0, 0, pw, ph], fill=(220, 30, 30))
        pimg.save(prev)

    out = sa.synthesize_continuation_grid(str(prev), str(template), rows, cols)
    assert Path(out).exists()

    cell = _cell_size(tw, cols)
    with Image.open(out) as res:
        res = res.convert("RGB")
        # Row 0, cell 0 center should now be red (copied from prev's last row).
        r0 = res.getpixel((LW + cell // 2, LW + cell // 2))
        # Row 1 (unchanged) center should still be white.
        r1 = res.getpixel((LW + cell // 2, (cell + LW) + LW + cell // 2))
    assert r0[0] > 150 and r0[1] < 120 and r0[2] < 120, f"row0 not red: {r0}"
    assert r1[0] > 200 and r1[1] > 200 and r1[2] > 200, f"row1 not white: {r1}"


# ── AnimationStore ──────────────────────────────────────


def test_animation_store_roundtrip_and_persistence(tmp_path):
    store = sa.AnimationStore(str(tmp_path))
    assert store.get_last_record() is None

    rid = store.add_record({"description": "first", "grid_config": {"rows": 2, "cols": 3}})
    assert isinstance(rid, str) and rid
    assert store.get_record(rid)["description"] == "first"
    assert "timestamp" in store.get_record(rid)
    assert store.get_last_record()["description"] == "first"

    rid2 = store.add_record({"description": "second"})
    assert rid2 != rid
    assert store.get_last_record()["description"] == "second"

    updated = store.update_record(rid, {"status": "failed", "grid_config": {"cols": 4}})
    assert updated["status"] == "failed"
    assert updated["grid_config"] == {"rows": 2, "cols": 4}  # deep-merged, rows kept

    # A fresh instance loads the persisted history.json.
    reloaded = sa.AnimationStore(str(tmp_path))
    assert len(reloaded.records) == 2
    assert reloaded.get_record(rid)["status"] == "failed"

    assert store.get_record("does-not-exist") is None
    with pytest.raises(KeyError):
        store.update_record("does-not-exist", {"x": 1})


# ── /api/animate + /api/animations route flow (mocked clients) ──


class FakeHandler:
    """Minimal stand-in for StudioHandler for route unit tests."""

    def __init__(self, body: dict):
        raw = json.dumps(body).encode("utf-8")
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = io.BytesIO(raw)
        self.captured = None

    def _json_response(self, data, status=200):
        self.captured = (status, data)


@pytest.fixture
def anim_env(tmp_path, monkeypatch):
    """Redirect output to a tmp dir and stub the image/LLM clients."""
    monkeypatch.setattr(animation_routes, "ANIM_DIR", tmp_path)

    calls = {"edit": [], "chat": []}
    # A valid, sliceable fake sheet (2x3 grid, distinct frames) from the image client.
    fake_sheet = _distinct_sheet(2, 3, 3 * 128 + 8)

    def fake_edit(prompt, images, **kwargs):
        calls["edit"].append({"prompt": prompt, "images": images})
        return [fake_sheet]

    def fake_chat(messages, **kwargs):
        calls["chat"].append(messages)
        return {"choices": [{"message": {"content": "a knight swinging a sword"}}]}

    monkeypatch.setattr(animation_routes.image_openai, "edit", fake_edit)
    monkeypatch.setattr(animation_routes.llm_gateway, "chat", fake_chat)
    return tmp_path, calls


def test_animate_idea_flow(anim_env):
    tmp_path, calls = anim_env
    h = FakeHandler({"idea": "a knight", "rows": 2, "cols": 3, "style": "Pixel Art"})
    animation_routes.handle_animate(h, urlparse("/api/animate"))

    assert h.captured is not None
    status, data = h.captured
    assert status == 200, data
    # Idea expansion ran through the LLM gateway.
    assert len(calls["chat"]) == 1
    assert data["record"]["description"] == "a knight swinging a sword"
    # img2img edit called with the template as a structural reference.
    assert len(calls["edit"]) == 1
    ref = calls["edit"][0]["images"][0]
    assert Path(ref).exists()
    assert "knight" in calls["edit"][0]["prompt"]

    # URLs point at /animations/ and the files were written to the tmp dir.
    assert data["sheet_url"].startswith("/animations/")
    assert data["gif_url"].startswith("/animations/")
    assert (tmp_path / Path(data["sheet_url"]).name).exists()
    gif = tmp_path / Path(data["gif_url"]).name
    assert gif.exists()
    with Image.open(gif) as im:
        assert getattr(im, "n_frames", 1) == 6  # 2x3
    assert data["record"]["generation_mode"] == "new"


def test_animate_description_skips_llm(anim_env):
    _tmp, calls = anim_env
    h = FakeHandler({"description": "a robot dancing", "rows": 2, "cols": 2})
    animation_routes.handle_animate(h, urlparse("/api/animate"))

    status, data = h.captured
    assert status == 200, data
    assert calls["chat"] == []  # description given -> no LLM expansion
    assert data["record"]["description"] == "a robot dancing"


def test_animate_requires_idea_or_description(anim_env):
    h = FakeHandler({"rows": 2, "cols": 2})
    animation_routes.handle_animate(h, urlparse("/api/animate"))
    status, data = h.captured
    assert status == 400
    assert "error" in data


def test_animate_continue_mode_uses_previous(anim_env):
    tmp_path, calls = anim_env
    first = FakeHandler({"description": "knight running", "rows": 2, "cols": 3})
    animation_routes.handle_animate(first, urlparse("/api/animate"))
    assert first.captured[0] == 200

    second = FakeHandler({"description": "knight jumping", "rows": 2, "cols": 3, "mode": "continue"})
    animation_routes.handle_animate(second, urlparse("/api/animate"))
    status, data = second.captured
    assert status == 200, data
    assert data["record"]["generation_mode"] == "continue"
    # Continuation prompt references the previous action.
    assert "knight running" in calls["edit"][-1]["prompt"]

    # Both records persisted.
    store = sa.AnimationStore(str(tmp_path))
    assert len(store.records) == 2


def test_list_animations_route(anim_env):
    _tmp, _calls = anim_env
    gen = FakeHandler({"description": "a cat pouncing", "rows": 2, "cols": 2})
    animation_routes.handle_animate(gen, urlparse("/api/animate"))

    lister = FakeHandler({})
    animation_routes.handle_list(lister, urlparse("/api/animations"))
    status, data = lister.captured
    assert status == 200
    assert len(data["records"]) == 1
    rec = data["records"][0]
    assert rec["description"] == "a cat pouncing"
    assert rec["sheet_url"].startswith("/animations/")
    assert rec["gif_url"].startswith("/animations/")
