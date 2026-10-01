"""Track source preparation: guard the URL, attach fetch headers.

py-tgcalls shells out to ffmpeg internally (MediaStream accepts remote URLs),
so our job is validation, not transcoding. Controller always resolves fresh
(signed CDN URLs expire) — the worker re-validates and plays.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .security import assert_public_url

USER_AGENT = "PappyStreamWorker/1.5 (+https://t.me/)"


@dataclass
class PreparedSource:
    url: str
    headers: dict[str, str]


def prepare_source(url: str, resolve: Optional[Callable[[str], list[str]]] = None) -> PreparedSource:
    safe = assert_public_url(url, resolve)
    return PreparedSource(url=safe, headers={"User-Agent": USER_AGENT})
