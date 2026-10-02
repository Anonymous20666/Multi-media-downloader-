"""Control contract v1 — mirrors apps/controller/src/stream/contract.ts (zod).

Stdlib only. Golden vectors (contract-vectors.json) are asserted here AND in TS.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional

STREAM_CMD_KEY = "pappy:stream:cmd"
STREAM_EVT_CHANNEL = "pappy:stream:evt"
STREAM_HB_KEY = "pappy:stream:hb"
CONTRACT_V = 1

CMD_TYPES = {"stream.play", "stream.pause", "stream.resume", "stream.stop", "stream.volume", "stream.ping", "stream.join", "stream.leave"}
EVT_NAMES = {"track.started", "track.ended", "call.joined", "call.left", "paused", "resumed", "error", "pong"}


@dataclass
class Track:
    title: str
    url: str
    performer: Optional[str] = None
    duration: Optional[float] = None
    is_video: bool = False


@dataclass
class Cmd:
    id: str
    type: str
    stream_id: str
    chat_id: int
    idempotency_key: str
    track: Optional[Track] = None
    level: Optional[int] = None
    invite_link: Optional[str] = None


@dataclass
class Evt:
    name: str
    stream_id: str
    chat_id: int
    track: Optional[Track] = None
    error: Optional[dict] = None
    ts: float = field(default_factory=time.time)


class ContractError(ValueError):
    pass


def _track(d: Any) -> Track:
    if not isinstance(d, dict):
        raise ContractError("track must be an object")
    title, url = d.get("title"), d.get("url")
    if not title or not isinstance(title, str):
        raise ContractError("track.title required")
    if not url or not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise ContractError("track.url must be an http(s) URL")
    return Track(
        title=title[:300],
        url=url,
        performer=d.get("performer"),
        duration=d.get("duration"),
        is_video=bool(d.get("isVideo", False)),
    )


def parse_cmd(raw: Any) -> Cmd:
    if not isinstance(raw, dict):
        raise ContractError("command must be an object")
    if raw.get("v") != CONTRACT_V:
        raise ContractError(f"unsupported contract v{raw.get('v')}")
    ctype = raw.get("type")
    if ctype not in CMD_TYPES:
        raise ContractError(f"unknown command {ctype!r}")
    for k in ("id", "streamId", "idempotencyKey"):
        if not raw.get(k) or not isinstance(raw[k], str):
            raise ContractError(f"{k} required")
    if not isinstance(raw.get("chatId"), int):
        raise ContractError("chatId must be an int")
    track = _track(raw["track"]) if "track" in raw and raw["track"] is not None else None
    if ctype == "stream.play" and track is None:
        raise ContractError("stream.play requires a track")
    level = raw.get("level")
    if level is not None and (not isinstance(level, int) or not 0 <= level <= 200):
        raise ContractError("level must be 0..200")
    invite_link = raw.get("inviteLink")
    if invite_link is not None and not isinstance(invite_link, str):
        invite_link = None
    return Cmd(id=raw["id"], type=ctype, stream_id=raw["streamId"], chat_id=raw["chatId"],
               idempotency_key=raw["idempotencyKey"], track=track, level=level, invite_link=invite_link)


def build_evt(evt: Evt) -> dict:
    if evt.name not in EVT_NAMES:
        raise ContractError(f"unknown event {evt.name!r}")
    d: dict[str, Any] = {"v": CONTRACT_V, "type": "evt", "name": evt.name,
                         "streamId": evt.stream_id, "chatId": evt.chat_id, "ts": evt.ts}
    if evt.track is not None:
        d["track"] = {"title": evt.track.title, "performer": evt.track.performer,
                      "url": evt.track.url, "duration": evt.track.duration}
    if evt.error is not None:
        d["error"] = {"code": str(evt.error.get("code", "UNKNOWN"))[:64],
                      "message": str(evt.error.get("message", ""))[:500]}
    return d


def build_heartbeat(worker_id: str, calls: list[int]) -> dict:
    return {"v": CONTRACT_V, "workerId": worker_id, "calls": calls, "ts": time.time()}
