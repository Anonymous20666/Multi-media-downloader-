"""Track source preparation: guard the URL, attach fetch headers.

py-tgcalls shells out to ffmpeg internally (MediaStream accepts remote URLs),
so our job is validation, not transcoding. Controller always resolves fresh
(signed CDN URLs expire) — the worker re-validates and plays.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .security import assert_public_url

CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
USER_AGENT = CHROME_USER_AGENT


@dataclass
class PreparedSource:
    url: str
    headers: dict[str, str]


def prepare_source(url: str, resolve: Optional[Callable[[str], list[str]]] = None) -> PreparedSource:
    safe = assert_public_url(url, resolve)
    headers = {
        "User-Agent": CHROME_USER_AGENT,
        "Accept": "*/*",
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
    }
    return PreparedSource(url=safe, headers=headers)
