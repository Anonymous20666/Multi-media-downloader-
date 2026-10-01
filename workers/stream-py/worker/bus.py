"""Redis command/event transport (sync client in worker threads; memory fake for tests)."""

from __future__ import annotations

import json
from typing import Any, Optional

from . import contract as C


class MemoryBus:
    """In-process bus for unit tests (mirrors InMemoryBus on the TS side)."""

    def __init__(self) -> None:
        self.published: list[dict] = []
        self._cmds: list[dict] = []
        self._hb: Optional[dict] = None
        self._seen_idem: set[str] = set()

    def push_cmd(self, cmd: dict) -> None:
        self._cmds.append(cmd)

    def brpop_cmd(self, timeout: int = 1) -> Optional[dict]:
        return self._cmds.pop(0) if self._cmds else None

    def publish_evt(self, evt: dict) -> None:
        self.published.append(evt)

    def heartbeat(self, hb: dict, ttl: int = 20) -> None:
        self._hb = hb

    def last_heartbeat(self) -> Optional[dict]:
        return self._hb

    def claim_idem(self, key: str, ttl: int = 3600) -> bool:
        if key in self._seen_idem:
            return False
        self._seen_idem.add(key)
        return True


class RedisBus:
    """Thin wrapper over redis-py (imported lazily — tests never need it)."""

    def __init__(self, url: str):
        import redis  # noqa: PLC0415 — lazy so unit tests stay dependency-free

        self._r = redis.Redis.from_url(url, decode_responses=True)

    def brpop_cmd(self, timeout: int = 1) -> Optional[dict]:
        res = self._r.brpop(C.STREAM_CMD_KEY, timeout=timeout)
        if not res:
            return None
        try:
            return json.loads(res[1])
        except json.JSONDecodeError:
            return {"__malformed": True}

    def publish_evt(self, evt: dict) -> None:
        self._r.publish(C.STREAM_EVT_CHANNEL, json.dumps(evt))

    def heartbeat(self, hb: dict, ttl: int = 20) -> None:
        self._r.setex(C.STREAM_HB_KEY, ttl, json.dumps(hb))

    def claim_idem(self, key: str, ttl: int = 3600) -> bool:
        return bool(self._r.set(f"pappy:stream:idem:{key}", "1", nx=True, ex=ttl))

    def ping(self) -> bool:
        try:
            return bool(self._r.ping())
        except Exception:
            return False
