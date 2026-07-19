#!/usr/bin/env python3
"""Shared HTTP helpers built on the stdlib ``urllib``.

All API clients in this project reuse these helpers so that request framing,
error translation, and timeouts stay consistent. No third-party dependencies.

Error contract:
    * HTTP error responses raise ``HttpError(status, body)``.
    * Connection-level failures (DNS, refused, timeout wrapped in URLError)
      raise ``HttpError(0, reason)``.
"""

import json
import urllib.error
import urllib.request
import uuid


class HttpError(Exception):
    """Raised when an HTTP request fails.

    Attributes:
        status: HTTP status code, or ``0`` for connection-level failures.
        body: Response body text, or the failure reason for status ``0``.
    """

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body}")
        self.status = status
        self.body = body


def _request(
    url: str,
    *,
    data: bytes | None = None,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    timeout: float = 60,
) -> bytes:
    """Perform a request and return the raw response body bytes."""
    req = urllib.request.Request(url, data=data, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise HttpError(exc.code, body) from exc
    except urllib.error.URLError as exc:
        raise HttpError(0, str(exc.reason)) from exc


def get_json(url: str, headers: dict[str, str] | None = None, timeout: float = 60) -> dict:
    """GET ``url`` and parse the JSON response body into a dict."""
    raw = _request(url, method="GET", headers=headers, timeout=timeout)
    return json.loads(raw)


def post_json(url: str, payload: dict, headers: dict[str, str] | None = None, timeout: float = 120) -> dict:
    """POST ``payload`` as JSON and parse the JSON response body into a dict."""
    merged: dict[str, str] = {"Content-Type": "application/json"}
    if headers:
        merged.update(headers)
    data = json.dumps(payload).encode("utf-8")
    raw = _request(url, data=data, method="POST", headers=merged, timeout=timeout)
    return json.loads(raw)


def get_bytes(url: str, headers: dict[str, str] | None = None, timeout: float = 60) -> bytes:
    """GET ``url`` and return the raw response body bytes."""
    return _request(url, method="GET", headers=headers, timeout=timeout)


def post_multipart(
    url: str,
    fields: dict[str, str],
    files: list[tuple[str, str, bytes, str]],
    headers: dict[str, str] | None = None,
    timeout: float = 180,
) -> dict:
    """POST a ``multipart/form-data`` request and parse the JSON response.

    Args:
        url: Target URL.
        fields: Plain text form fields as ``{name: value}``.
        files: File parts, each ``(field_name, filename, content_bytes, content_type)``.
        headers: Extra headers (the multipart ``Content-Type`` is set automatically).
        timeout: Socket timeout in seconds.
    """
    boundary = uuid.uuid4().hex
    body = _encode_multipart(boundary, fields, files)
    merged: dict[str, str] = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if headers:
        merged.update(headers)
    raw = _request(url, data=body, method="POST", headers=merged, timeout=timeout)
    return json.loads(raw)


def _encode_multipart(
    boundary: str,
    fields: dict[str, str],
    files: list[tuple[str, str, bytes, str]],
) -> bytes:
    """Assemble a ``multipart/form-data`` request body."""
    delimiter = f"--{boundary}".encode()
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(delimiter)
        parts.append(f'Content-Disposition: form-data; name="{name}"'.encode())
        parts.append(b"")
        parts.append(value.encode("utf-8"))
    for field_name, filename, content, content_type in files:
        parts.append(delimiter)
        parts.append(f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"'.encode())
        parts.append(f"Content-Type: {content_type}".encode())
        parts.append(b"")
        parts.append(content)
    parts.append(f"--{boundary}--".encode())
    parts.append(b"")
    return b"\r\n".join(parts)
