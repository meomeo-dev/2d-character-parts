#!/usr/bin/env python3
"""OpenAI-compatible image generation / editing client / OpenAI 图像生成与编辑客户端.

Talks to the ``{base_url}/images/generations`` and ``{base_url}/images/edits``
endpoints used by the ``gpt-image`` model family. All requests go through the
shared stdlib HTTP helpers in :mod:`_http`; provider defaults (base URL, API key,
model) come from :func:`providers.get_image`.

Contract / 契约:
    * ``base_url`` default ``https://api.openai.com/v1``.
    * ``model`` default ``gpt-image-1`` (also ``gpt-image-2`` / ``gpt-image-1.5`` /
      ``gpt-image-mini``).
    * ``size`` one of ``1024x1024`` / ``1536x1024`` / ``1024x1536`` / ``auto``.
    * ``quality`` one of ``low`` / ``medium`` / ``high`` / ``auto``.
    * ``background="transparent"`` requires ``output_format`` ``png`` or ``webp``.

Security: the API key is only ever placed in the ``Authorization`` header; it is
never printed or logged by this module.
"""

import base64
from pathlib import Path

import _http
import providers

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-image-1"

# Content-type lookup for reference/mask files supplied as paths.
_CONTENT_TYPE_BY_SUFFIX = {
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}
# Reverse map used to name in-memory (``bytes``) uploads.
_EXT_BY_CONTENT_TYPE = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def generate(
    prompt: str,
    *,
    model: str | None = None,
    size: str = "1024x1024",
    quality: str = "high",
    n: int = 1,
    background: str | None = None,
    output_format: str = "png",
    base_url: str | None = None,
    api_key: str | None = None,
) -> list[bytes]:
    """Generate ``n`` images from ``prompt`` and return their raw bytes.

    POSTs JSON to ``{base_url}/images/generations``. The ``gpt-image`` family
    returns base64 payloads in ``data[].b64_json``, which are decoded here.

    Args:
        prompt: Text description of the desired image.
        model: Image model id; defaults to the provider's configured model.
        size: Output dimensions (see module contract).
        quality: Render quality (see module contract).
        n: Number of images to request.
        background: ``"transparent"`` / ``"opaque"`` / ``"auto"``; omitted when None.
        output_format: ``png`` / ``jpeg`` / ``webp``.
        base_url: API base; defaults to the provider's configured base URL.
        api_key: Bearer token; defaults to the provider's configured key.

    Returns:
        One ``bytes`` object per generated image.
    """
    model, base_url, api_key = _resolve(model, base_url, api_key)
    body: dict = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size,
        "quality": quality,
        "output_format": output_format,
    }
    if background:
        body["background"] = background
    result = _http.post_json(f"{base_url}/images/generations", body, headers=_auth_headers(api_key))
    return _decode_images(result)


def edit(
    prompt: str,
    images: list[str | bytes],
    *,
    mask: str | bytes | None = None,
    model: str | None = None,
    size: str | None = None,
    quality: str | None = None,
    n: int = 1,
    base_url: str | None = None,
    api_key: str | None = None,
) -> list[bytes]:
    """Edit one or more ``images`` guided by ``prompt`` and return image bytes.

    POSTs ``multipart/form-data`` to ``{base_url}/images/edits``. Each input image
    is sent as a repeated ``image[]`` part (paths are read from disk; ``bytes`` are
    uploaded as-is). An optional ``mask`` (PNG with alpha) marks the editable region.

    Args:
        prompt: Instruction describing the edit.
        images: File paths or raw ``bytes`` for the source image(s). A bare
            ``str``/``bytes`` is accepted and treated as a single-item list.
        mask: Optional PNG mask (path or ``bytes``) with an alpha channel.
        model: Image model id; defaults to the provider's configured model.
        size: Output dimensions; omitted from the request when None.
        quality: Render quality; omitted from the request when None.
        n: Number of images to request.
        base_url: API base; defaults to the provider's configured base URL.
        api_key: Bearer token; defaults to the provider's configured key.

    Returns:
        One ``bytes`` object per edited image.
    """
    model, base_url, api_key = _resolve(model, base_url, api_key)
    if isinstance(images, (str, bytes)):
        images = [images]
    if not images:
        raise ValueError("image_openai.edit() requires at least one image")

    fields: dict[str, str] = {"model": model, "prompt": prompt, "n": str(n)}
    if size:
        fields["size"] = size
    if quality:
        fields["quality"] = quality

    files = [_file_part("image[]", src, stem=f"image_{i}") for i, src in enumerate(images)]
    if mask is not None:
        files.append(_file_part("mask", mask, stem="mask"))

    result = _http.post_multipart(f"{base_url}/images/edits", fields, files, headers=_auth_headers(api_key))
    return _decode_images(result)


def generate_to_file(prompt: str, output_path: str, **kwargs) -> str:
    """Generate a single image and write it to ``output_path``; return that path.

    ``kwargs`` are forwarded to :func:`generate`; only the first image is saved.
    """
    images = generate(prompt, **kwargs)
    if not images:
        raise RuntimeError("image_openai.generate() returned no image data")
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(images[0])
    return str(path)


# ── Internal helpers ────────────────────────────────────


def _resolve(model: str | None, base_url: str | None, api_key: str | None) -> tuple[str, str, str]:
    """Fill missing ``model`` / ``base_url`` / ``api_key`` from provider settings."""
    if model and base_url and api_key:
        return model, base_url.rstrip("/"), api_key
    image = providers.get_image()
    model = model or image.get("model") or DEFAULT_MODEL
    base_url = (base_url or image.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    api_key = api_key or image.get("api_key") or ""
    return model, base_url, api_key


def _auth_headers(api_key: str) -> dict[str, str]:
    """Return the Bearer auth header (Content-Type is set by the HTTP helper)."""
    return {"Authorization": f"Bearer {api_key}"}


def _decode_images(result: dict) -> list[bytes]:
    """Decode every ``data[].b64_json`` entry in an API response to bytes."""
    return [base64.b64decode(item["b64_json"]) for item in result.get("data", []) if item.get("b64_json")]


def _file_part(field_name: str, src: str | bytes, *, stem: str) -> tuple[str, str, bytes, str]:
    """Build a multipart file tuple ``(field, filename, content, content_type)``.

    Paths are read from disk with a suffix-derived content type; raw ``bytes`` are
    sniffed from their magic number.
    """
    if isinstance(src, bytes):
        content_type = _sniff_content_type(src)
        ext = _EXT_BY_CONTENT_TYPE.get(content_type, ".png")
        return (field_name, f"{stem}{ext}", src, content_type)
    path = Path(src)
    content_type = _CONTENT_TYPE_BY_SUFFIX.get(path.suffix.lower(), "image/png")
    return (field_name, path.name, path.read_bytes(), content_type)


def _sniff_content_type(data: bytes) -> str:
    """Guess an image content type from leading magic bytes (defaults to PNG)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"
