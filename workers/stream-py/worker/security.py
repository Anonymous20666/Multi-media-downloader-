"""Worker-side guards: secret redaction + URL validation (mirrors the TS SSRF layer).

Never log session strings, API hashes, or signed media URLs. Ever.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Callable, Optional
from urllib.parse import urlsplit


def redact_url(url: str) -> str:
    """Keep scheme + host + path; strip query/hash (signed CDN tokens live there)."""
    try:
        p = urlsplit(url)
        host = p.hostname or "?"
        return f"{p.scheme}://{host}{p.path or '/'}?<redacted>"
    except Exception:
        return "<unparseable-url>"


def redact_cmd(cmd: dict) -> dict:
    """Log-safe copy of a command envelope (track URL redacted)."""
    out = dict(cmd)
    track = out.get("track")
    if isinstance(track, dict):
        t = dict(track)
        if t.get("url"):
            t["url"] = redact_url(str(t["url"]))
        out["track"] = t
    return out


class UnsafeUrl(ValueError):
    pass


def assert_public_url(url: str, resolve: Optional[Callable[[str], list[str]]] = None) -> str:
    """Allow only http(s) URLs whose host resolves to global unicast IPs.

    `resolve` is injectable so tests never touch DNS. Residual risk (TOCTOU
    between check and ffmpeg fetch) is documented in the README.
    """
    p = urlsplit(url)
    if p.scheme not in ("http", "https"):
        raise UnsafeUrl("only http(s) media URLs are allowed")
    if p.username or p.password:
        raise UnsafeUrl("userinfo in media URL is forbidden")
    host = p.hostname
    if not host:
        raise UnsafeUrl("media URL has no host")
    ips = resolve(host) if resolve else _default_resolve(host)
    if not ips:
        raise UnsafeUrl("media host did not resolve")
    for ip in ips:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            raise UnsafeUrl("media host resolved to garbage")
        if not addr.is_global:
            raise UnsafeUrl(f"media host resolves to non-public IP ({addr})")
    return url


def _default_resolve(host: str) -> list[str]:
    try:
        return sorted({r[4][0] for r in socket.getaddrinfo(host, None)})
    except socket.gaierror:
        return []
