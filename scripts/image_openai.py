#!/usr/bin/env python3
"""OpenAI-compatible image generation / editing client.

STUB — implementation lands in a later track. Signatures below are final.
Provider defaults come from ``providers.get_image()``.
"""


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
    """Generate ``n`` images and return their raw bytes.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("image_openai.generate() lands in a later track (image client).")


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
    """Edit ``images`` (paths, data URLs, or raw bytes) and return image bytes.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("image_openai.edit() lands in a later track (image client).")


def generate_to_file(prompt: str, output_path: str, **kwargs) -> str:
    """Generate a single image and write it to ``output_path``; return that path.

    STUB: implemented in a later track.
    """
    raise NotImplementedError("image_openai.generate_to_file() lands in a later track (image client).")
