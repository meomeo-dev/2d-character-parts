"""Unit tests for the OpenAI gpt-image client (``image_openai``).

All HTTP is stubbed via ``unittest.mock`` — no real network call or API key is
used. Tests assert both the outgoing request framing (URL, JSON body / multipart
fields, auth header) and the ``data[].b64_json`` decode path.
"""

import base64
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import image_openai

# A minimal PNG signature is enough — the client never decodes the pixels.
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(16))
PNG_B64 = base64.b64encode(PNG).decode("ascii")
JPEG = b"\xff\xd8\xff\xe0" + bytes(12)
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + bytes(8)


def _result(n=1):
    """Fake ``/images/*`` JSON response with ``n`` base64 payloads."""
    return {"data": [{"b64_json": PNG_B64} for _ in range(n)]}


# ── generate() ──────────────────────────────────────────


def test_generate_builds_request_and_decodes():
    with mock.patch("image_openai._http.post_json", return_value=_result()) as post:
        out = image_openai.generate(
            "a cat",
            model="gpt-image-1",
            size="1024x1024",
            quality="high",
            base_url="https://api.openai.com/v1",
            api_key="test-key",
        )

    assert out == [PNG]
    url, payload = post.call_args.args
    assert url == "https://api.openai.com/v1/images/generations"
    assert payload["model"] == "gpt-image-1"
    assert payload["prompt"] == "a cat"
    assert payload["n"] == 1
    assert payload["size"] == "1024x1024"
    assert payload["quality"] == "high"
    assert payload["output_format"] == "png"
    assert "background" not in payload
    assert post.call_args.kwargs["headers"] == {"Authorization": "Bearer test-key"}


def test_generate_includes_background_and_output_format():
    with mock.patch("image_openai._http.post_json", return_value=_result()) as post:
        image_openai.generate(
            "x",
            background="transparent",
            output_format="webp",
            model="gpt-image-1",
            base_url="https://host/v1",
            api_key="k",
        )
    payload = post.call_args.args[1]
    assert payload["background"] == "transparent"
    assert payload["output_format"] == "webp"


def test_generate_uses_provider_defaults():
    fake = {"base_url": "https://prov.example/v1", "api_key": "prov-key", "model": "gpt-image-2"}
    with (
        mock.patch("image_openai.providers.get_image", return_value=fake),
        mock.patch("image_openai._http.post_json", return_value=_result()) as post,
    ):
        image_openai.generate("hello")

    url, payload = post.call_args.args
    assert url == "https://prov.example/v1/images/generations"
    assert payload["model"] == "gpt-image-2"
    assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer prov-key"


def test_generate_strips_trailing_slash_on_base_url():
    with mock.patch("image_openai._http.post_json", return_value=_result()) as post:
        image_openai.generate("x", base_url="https://api.openai.com/v1/", api_key="k", model="gpt-image-1")
    assert post.call_args.args[0] == "https://api.openai.com/v1/images/generations"


def test_generate_decodes_multiple_images():
    with mock.patch("image_openai._http.post_json", return_value=_result(3)):
        out = image_openai.generate("x", n=3, model="m", base_url="https://h/v1", api_key="k")
    assert out == [PNG, PNG, PNG]


# ── edit() ──────────────────────────────────────────────


def test_edit_builds_multipart_from_path_and_bytes(tmp_path):
    img_file = tmp_path / "ref.png"
    img_file.write_bytes(PNG)

    with mock.patch("image_openai._http.post_multipart", return_value=_result()) as post:
        out = image_openai.edit(
            "make bg black",
            [str(img_file), JPEG],
            model="gpt-image-1",
            size="1024x1024",
            quality="high",
            base_url="https://api.openai.com/v1",
            api_key="test-key",
        )

    assert out == [PNG]
    url, fields, files = post.call_args.args
    assert url == "https://api.openai.com/v1/images/edits"
    assert fields["model"] == "gpt-image-1"
    assert fields["prompt"] == "make bg black"
    assert fields["size"] == "1024x1024"
    assert fields["quality"] == "high"
    assert fields["n"] == "1"
    assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer test-key"

    image_parts = [f for f in files if f[0] == "image[]"]
    assert len(image_parts) == 2
    # First from disk (suffix-derived), second from bytes (magic-sniffed).
    assert image_parts[0][1] == "ref.png"
    assert image_parts[0][2] == PNG
    assert image_parts[0][3] == "image/png"
    assert image_parts[1][2] == JPEG
    assert image_parts[1][3] == "image/jpeg"


def test_edit_includes_mask_part():
    with mock.patch("image_openai._http.post_multipart", return_value=_result()) as post:
        image_openai.edit(
            "p",
            [PNG],
            mask=WEBP,
            model="m",
            size="auto",
            quality="low",
            base_url="https://h/v1",
            api_key="k",
        )
    files = post.call_args.args[2]
    mask_parts = [f for f in files if f[0] == "mask"]
    assert len(mask_parts) == 1
    assert mask_parts[0][2] == WEBP
    assert mask_parts[0][3] == "image/webp"


def test_edit_omits_size_and_quality_when_none():
    with mock.patch("image_openai._http.post_multipart", return_value=_result()) as post:
        image_openai.edit("p", [PNG], model="m", base_url="https://h/v1", api_key="k")
    fields = post.call_args.args[1]
    assert "size" not in fields
    assert "quality" not in fields
    assert fields["n"] == "1"


def test_edit_normalizes_single_image():
    with mock.patch("image_openai._http.post_multipart", return_value=_result()) as post:
        # Pass a bare bytes object rather than a list.
        image_openai.edit("p", PNG, model="m", base_url="https://h/v1", api_key="k")
    files = post.call_args.args[2]
    assert len([f for f in files if f[0] == "image[]"]) == 1


def test_edit_uses_provider_defaults():
    fake = {"base_url": "https://prov/v1", "api_key": "pk", "model": "gpt-image-1"}
    with (
        mock.patch("image_openai.providers.get_image", return_value=fake),
        mock.patch("image_openai._http.post_multipart", return_value=_result()) as post,
    ):
        image_openai.edit("p", [PNG])
    url, fields, _files = post.call_args.args
    assert url == "https://prov/v1/images/edits"
    assert fields["model"] == "gpt-image-1"
    assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer pk"


def test_edit_rejects_empty_images():
    with mock.patch("image_openai._http.post_multipart") as post:
        try:
            image_openai.edit("p", [], model="m", base_url="https://h/v1", api_key="k")
        except ValueError:
            pass
        else:
            raise AssertionError("edit() should reject an empty image list")
    post.assert_not_called()


# ── generate_to_file() ──────────────────────────────────


def test_generate_to_file_writes_first_image(tmp_path):
    out_path = tmp_path / "sub" / "out.png"
    with mock.patch("image_openai._http.post_json", return_value=_result(2)):
        returned = image_openai.generate_to_file("x", str(out_path), model="m", base_url="https://h/v1", api_key="k")
    assert Path(returned) == out_path
    assert out_path.read_bytes() == PNG


# ── content-type sniffing ───────────────────────────────


def test_sniff_content_type():
    assert image_openai._sniff_content_type(PNG) == "image/png"
    assert image_openai._sniff_content_type(JPEG) == "image/jpeg"
    assert image_openai._sniff_content_type(WEBP) == "image/webp"
    assert image_openai._sniff_content_type(b"garbage") == "image/png"
