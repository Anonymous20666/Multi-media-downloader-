"""Call engines: FakeEngine (tests/CI) + PyTgCallsEngine (real WebRTC, lazy imports).

Real backend: pyrofork MTProto client + py-tgcalls 2.3.3 + ntgcalls 2.2.5 native
core (all API shapes verified against the installed packages — see README).
The engine NEVER sees plaintext secrets in logs; URLs are redacted by callers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class EngineEvent:
    kind: str  # joined | started | ended | error
    chat_id: int
    message: str = ""


class EngineError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class CallEngine:
    def start(self) -> None:
        raise NotImplementedError

    def play(self, chat_id: int, url: str, headers: Optional[dict] = None, is_video: bool = False) -> bool:
        """Play (joining first if needed). Returns True when this call was fresh."""
        raise NotImplementedError

    def pause(self, chat_id: int) -> None:
        raise NotImplementedError

    def resume(self, chat_id: int) -> None:
        raise NotImplementedError

    def stop(self, chat_id: int) -> None:
        raise NotImplementedError

    def set_volume(self, chat_id: int, level: int) -> None:
        raise NotImplementedError

    def active(self) -> list[int]:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError


class FakeEngine(CallEngine):
    """Scripted engine for unit tests and credential-less CI."""

    def __init__(self, on_event: Callable[[EngineEvent], None]):
        self._on_event = on_event
        self.live: set[int] = set()
        self.plays: list[tuple[int, str]] = []
        self.fail_next: Optional[EngineError] = None
        self.started = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def _maybe_fail(self) -> None:
        if self.fail_next is not None:
            err, self.fail_next = self.fail_next, None
            raise err

    def play(self, chat_id: int, url: str, headers: Optional[dict] = None, is_video: bool = False) -> bool:
        self._maybe_fail()
        fresh = chat_id not in self.live
        self.live.add(chat_id)
        self.plays.append((chat_id, url))
        if fresh:
            self._on_event(EngineEvent("joined", chat_id))
        self._on_event(EngineEvent("started", chat_id))
        return fresh

    def pause(self, chat_id: int) -> None:
        self._maybe_fail()

    def resume(self, chat_id: int) -> None:
        self._maybe_fail()

    def stop(self, chat_id: int) -> None:
        self.live.discard(chat_id)

    def set_volume(self, chat_id: int, level: int) -> None:
        self._maybe_fail()

    def active(self) -> list[int]:
        return sorted(self.live)

    def close(self) -> None:
        self.live.clear()
        self.closed = True

    # --- test helpers ------------------------------------------------------
    def emit_ended(self, chat_id: int) -> None:
        self._on_event(EngineEvent("ended", chat_id))


class PyTgCallsEngine(CallEngine):
    """Real engine. Needs-testing with live credentials (VPS game-day)."""

    def __init__(self, api_id: int, api_hash: str, session_string: str, on_event: Callable[[EngineEvent], None]):
        self._api_id = api_id
        self._api_hash = api_hash
        self._session = session_string
        self._on_event = on_event
        self._live: set[int] = set()
        self._app: Any = None
        self._call: Any = None
        self._StreamEnded: Any = None

    def start(self) -> None:
        from pyrogram import Client  # noqa: PLC0415 — heavy deps stay lazy
        from pytgcalls import PyTgCalls
        from pytgcalls.types import StreamEnded

        self._StreamEnded = StreamEnded
        self._app = Client("pappy-stream", api_id=self._api_id, api_hash=self._api_hash, session_string=self._session)
        self._call = PyTgCalls(self._app)
        ended_cls = StreamEnded
        emit = self._on_event

        def _on_update(update: object) -> None:
            # add_handler without filters invokes func(update) — verified in source.
            if isinstance(update, ended_cls):
                chat_id = int(getattr(update, "chat_id", 0))
                emit(EngineEvent("ended", chat_id))

        self._call.add_handler(_on_update)
        self._call.start()

    def play(self, chat_id: int, url: str, headers: Optional[dict] = None, is_video: bool = False) -> bool:
        if is_video:
            stream = MediaStream(
                url,
                audio_parameters=AudioQuality.HIGH,
                video_parameters=VideoQuality.FHD_1080p,
                headers=headers or None,
            )
        else:
            stream = MediaStream(
                url,
                audio_parameters=AudioQuality.HIGH,
                video_flags=MediaStream.Flags.IGNORE,
                headers=headers or None,
            )
        try:
            self._call.play(chat_id, stream)
        except Exception as e:
            err_name = type(e).__name__
            err_msg = str(e)
            if "NoActiveGroupCall" in err_name or "No active group call" in err_msg or "GroupCallNotFound" in err_name:
                try:
                    import random
                    import time
                    from pyrogram.raw.functions.phone import CreateGroupCall
                    from pytgcalls.sync import async_to_sync

                    async def _create():
                        peer = await self._app.resolve_peer(chat_id)
                        await self._app.invoke(CreateGroupCall(
                            peer=peer,
                            random_id=random.randint(10000, 99999999),
                            title="Pappy / Omega Live Stream"
                        ))

                    async_to_sync(_create)()
                    time.sleep(2)
                    self._call.play(chat_id, stream)
                except Exception as inner_e:
                    raise EngineError("NO_GROUP_CALL", "Voice chat is not active. Please start a Video/Voice Chat in the group header.") from inner_e
            elif "UserNotParticipant" in err_name or "USER_NOT_PARTICIPANT" in err_msg:
                raise EngineError("NOT_IN_GROUP", "Assistant account is not in this group. Please add @pappy_d_spammer to this group.") from e
            elif "ChatAdminRequired" in err_name or "CHAT_ADMIN_REQUIRED" in err_msg:
                raise EngineError("NEED_ADMIN", "Assistant account needs Admin privileges with 'Manage Video Chats' enabled.") from e
            else:
                raise EngineError("PLAY_FAILED", f"{err_name}: {err_msg}") from e
        fresh = chat_id not in self._live
        self._live.add(chat_id)
        if fresh:
            self._on_event(EngineEvent("joined", chat_id))
        self._on_event(EngineEvent("started", chat_id))
        return fresh

    def pause(self, chat_id: int) -> None:
        if not self._call.pause(chat_id):
            raise EngineError("PAUSE_FAILED", "engine declined pause")

    def resume(self, chat_id: int) -> None:
        if not self._call.resume(chat_id):
            raise EngineError("RESUME_FAILED", "engine declined resume")

    def stop(self, chat_id: int) -> None:
        try:
            self._call.leave_call(chat_id)
        finally:
            self._live.discard(chat_id)

    def set_volume(self, chat_id: int, level: int) -> None:
        self._call.change_volume_call(chat_id, level)

    def active(self) -> list[int]:
        return sorted(self._live)

    def close(self) -> None:
        for chat_id in list(self._live):
            try:
                self._call.leave_call(chat_id)
            except Exception:
                pass
        self._live.clear()
        try:
            if self._app is not None:
                self._app.stop()
        except Exception:
            pass
