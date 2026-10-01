"""Worker entry: Redis command loop + heartbeat + engine dispatch.

Boot (crash-only): Redis must answer and the engine must start, or we exit
non-zero and let the supervisor show it. No session string = fatal, loud.
`python -m worker.main --doctor` prints a JSON self-check instead of booting.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import sys
import time
import uuid
from typing import Callable, Optional

from . import contract as C
from .bus import MemoryBus, RedisBus
from .engine import CallEngine, EngineError, EngineEvent, FakeEngine
from .security import UnsafeUrl, redact_cmd, redact_url
from .source import prepare_source

HEARTBEAT_EVERY = 10
HB_TTL = 20


def log(level: str, msg: str, **fields: object) -> None:
    print(json.dumps({"lv": level, "msg": msg, "svc": "stream-worker", **fields}))
    sys.stdout.flush()


def load_config() -> dict:
    return {
        "session": os.environ.get("STREAM_SESSION_STRING", ""),
        "api_id": os.environ.get("STREAM_API_ID", ""),
        "api_hash": os.environ.get("STREAM_API_HASH", ""),
        "redis_url": os.environ.get("REDIS_URL", "redis://localhost:6379"),
        "worker_id": os.environ.get("STREAM_WORKER_ID", f"w-{uuid.uuid4().hex[:8]}"),
        "fake_engine": os.environ.get("STREAM_FAKE_ENGINE", "") == "1",
    }


def doctor(cfg: dict) -> dict:
    """Self-check report. Secrets are NEVER included — booleans only."""
    try:
        import redis as redis_pkg

        redis_v: object = getattr(redis_pkg, "__version__", "?")
    except Exception:
        redis_v = None
    try:
        import pytgcalls  # noqa: F401

        pytgcalls_ok = True
    except Exception:
        pytgcalls_ok = False
    try:
        import ntgcalls  # noqa: F401

        ntgcalls_ok = True
    except Exception:
        ntgcalls_ok = False
    try:
        import pyrogram

        pyro_v: object = getattr(pyrogram, "__version__", "?")
    except Exception:
        pyro_v = None
    redis_ok: Optional[bool] = None
    if redis_v is not None:
        try:
            from .bus import RedisBus as RB

            redis_ok = RB(cfg["redis_url"]).ping()
        except Exception:
            redis_ok = False
    return {
        "contract_v": C.CONTRACT_V,
        "python": sys.version.split()[0],
        "ffmpeg": shutil.which("ffmpeg") or None,
        "session_set": bool(cfg["session"]),
        "api_id_set": bool(cfg["api_id"]),
        "api_hash_set": bool(cfg["api_hash"]),
        "redis_url_set": bool(cfg["redis_url"]),
        "redis_reachable": redis_ok,
        "redis_py": redis_v,
        "pytgcalls": pytgcalls_ok,
        "ntgcalls": ntgcalls_ok,
        "pyrofork": pyro_v,
        "fake_engine": cfg["fake_engine"],
    }


def dispatch_one(bus: object, engine: CallEngine, stream_id_of: dict[int, str], raw: object, resolve: Optional[Callable[[str], list[str]]] = None) -> None:
    """Validate → idempotency-claim → dispatch → publish. Pure enough to unit-test."""
    if not isinstance(raw, dict) or "__malformed" in raw:
        log("warn", "dropping malformed command")
        return
    try:
        cmd = C.parse_cmd(raw)
    except C.ContractError as e:
        log("warn", "dropping invalid command", error=str(e))
        return
    claim = getattr(bus, "claim_idem")
    if not claim(cmd.idempotency_key):
        log("info", "duplicate command skipped", id=cmd.id)
        return
    log("info", "dispatch", cmd=redact_cmd(raw if isinstance(raw, dict) else {}))
    publish = getattr(bus, "publish_evt")
    stream_id_of[cmd.chat_id] = cmd.stream_id

    def evt(name: str, track: object = None, error: object = None) -> None:
        publish(C.build_evt(C.Evt(name=name, stream_id=cmd.stream_id, chat_id=cmd.chat_id, track=track, error=error)))

    try:
        if cmd.type == "stream.play" and cmd.track is not None:
            try:
                src = prepare_source(cmd.track.url, resolve)
            except UnsafeUrl as e:
                evt("error", error={"code": "SOURCE_REJECTED", "message": str(e)})
                return
            engine.play(cmd.chat_id, src.url, src.headers)
            evt("track.started", track=cmd.track)
        elif cmd.type == "stream.pause":
            engine.pause(cmd.chat_id)
            evt("paused")
        elif cmd.type == "stream.resume":
            engine.resume(cmd.chat_id)
            evt("resumed")
        elif cmd.type == "stream.stop":
            engine.stop(cmd.chat_id)
            evt("call.left")
        elif cmd.type == "stream.volume":
            engine.set_volume(cmd.chat_id, cmd.level or 100)
        elif cmd.type == "stream.ping":
            evt("pong")
    except EngineError as e:
        evt("error", error={"code": e.code, "message": str(e)[:300]})


def main() -> int:
    cfg = load_config()
    if "--doctor" in sys.argv:
        print(json.dumps(doctor(cfg), indent=2))
        return 0
    if not cfg["session"] or not cfg["api_id"] or not cfg["api_hash"]:
        log("fatal", "STREAM_SESSION_STRING / STREAM_API_ID / STREAM_API_HASH required — refusing to boot faceless")
        return 2

    bus = RedisBus(cfg["redis_url"])
    if not bus.ping():
        log("fatal", "redis unreachable", url=cfg["redis_url"])
        return 1

    events: "queue.Queue[EngineEvent]" = queue.Queue()
    if cfg["fake_engine"]:
        log("warn", "STREAM_FAKE_ENGINE=1 — no real calls will be joined")
        engine: CallEngine = FakeEngine(events.put)
    else:
        from .engine import PyTgCallsEngine

        engine = PyTgCallsEngine(int(cfg["api_id"]), cfg["api_hash"], cfg["session"], events.put)
    try:
        engine.start()
    except Exception as e:  # noqa: BLE001 — boot failure is fatal by design
        log("fatal", "engine start failed", error=f"{type(e).__name__}: {e}")
        return 1

    stopping = False

    def _stop(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        log("info", "shutting down", sig=signum)

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    stream_ids: dict[int, str] = {}
    last_hb = 0.0
    log("info", "worker online", worker=cfg["worker_id"])
    while not stopping:
        now = time.time()
        if now - last_hb >= HEARTBEAT_EVERY:
            bus.heartbeat(C.build_heartbeat(cfg["worker_id"], engine.active()), HB_TTL)
            last_hb = now
        try:
            while True:
                ev = events.get_nowait()
                sid = stream_ids.get(ev.chat_id, f"stm_{ev.chat_id}")
                if ev.kind == "joined":
                    bus.publish_evt(C.build_evt(C.Evt(name="call.joined", stream_id=sid, chat_id=ev.chat_id)))
                elif ev.kind == "started":
                    pass  # dispatch already emitted track.started with the track attached
                elif ev.kind == "ended":
                    bus.publish_evt(C.build_evt(C.Evt(name="track.ended", stream_id=sid, chat_id=ev.chat_id)))
                elif ev.kind == "error":
                    bus.publish_evt(C.build_evt(C.Evt(name="error", stream_id=sid, chat_id=ev.chat_id, error={"code": "ENGINE", "message": ev.message})))
        except queue.Empty:
            pass
        raw = bus.brpop_cmd(timeout=1)
        if raw is not None:
            dispatch_one(bus, engine, stream_ids, raw)

    try:
        for chat_id in engine.active():
            try:
                engine.stop(chat_id)
            except Exception:
                pass
        engine.close()
    finally:
        log("info", "worker stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
