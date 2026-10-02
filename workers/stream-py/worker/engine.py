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

    def join_chat(self, chat_id_or_invite: str | int) -> bool:
        raise NotImplementedError

    def leave_chat(self, chat_id: int) -> bool:
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

    def join_chat(self, chat_id_or_invite: str | int) -> bool:
        self._maybe_fail()
        return True

    def leave_chat(self, chat_id: int) -> bool:
        self._maybe_fail()
        return True

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
        self._video_chats: set[int] = set()
        self._active_chat_id: Optional[int] = None
        self._app: Any = None
        self._call: Any = None
        self._StreamEnded: Any = None

    def start(self) -> None:
        from pyrogram import Client  # noqa: PLC0415 — heavy deps stay lazy
        from pytgcalls import PyTgCalls
        from pytgcalls.types import StreamEnded, ChatUpdate

        self._StreamEnded = StreamEnded
        self._app = Client("pappy-stream", api_id=self._api_id, api_hash=self._api_hash, session_string=self._session)
        self._call = PyTgCalls(self._app)
        ended_cls = StreamEnded
        chat_update_cls = ChatUpdate
        emit = self._on_event

        def _on_update(update: object) -> None:
            # add_handler without filters invokes func(update) — verified in source.
            if isinstance(update, ended_cls):
                chat_id = int(getattr(update, "chat_id", 0))
                st = getattr(update, "stream_type", None)
                is_video = chat_id in self._video_chats
                # If audio stream is playing, ignore VIDEO ended notifications!
                if not is_video and st == ended_cls.Type.VIDEO:
                    return
                emit(EngineEvent("ended", chat_id))
            elif isinstance(update, chat_update_cls):
                status = getattr(update, "status", None)
                chat_id = int(getattr(update, "chat_id", 0))
                if status is not None and bool(status & (ChatUpdate.Status.CLOSED_VOICE_CHAT | ChatUpdate.Status.DISCARDED_CALL | ChatUpdate.Status.KICKED)):
                    self._live.discard(chat_id)
                    self._video_chats.discard(chat_id)
                    emit(EngineEvent("call.left", chat_id))

        self._call.add_handler(_on_update)
        self._call.start()

    def _run_pyrogram(self, coro: Any) -> Any:
        import asyncio
        if self._app.loop.is_running():
            return asyncio.run_coroutine_threadsafe(coro, self._app.loop).result(timeout=10)
        return self._app.loop.run_until_complete(coro)

    def _ensure_group_call(self, chat_id: int) -> bool:
        """Ensure a group call is active in the chat.
        Returns True if a new call was created, False if already active.
        """
        from pyrogram.raw.functions.channels import GetFullChannel
        from pyrogram.raw.functions.phone import CreateGroupCall
        import random
        import time
        import asyncio

        created = False

        async def _check_or_create() -> bool:
            nonlocal created
            try:
                peer = await self._app.resolve_peer(chat_id)
            except Exception:
                try:
                    await self._app.get_chat(chat_id)
                    peer = await self._app.resolve_peer(chat_id)
                except Exception as e:
                    err_txt = str(e)
                    if "CHANNEL_INVALID" in err_txt or "ChannelInvalid" in type(e).__name__:
                        raise EngineError("NOT_IN_GROUP", "Assistant account @pappy_d_spammer is not in this group.") from e
                    raise

            full = await self._app.invoke(GetFullChannel(channel=peer))
            call = getattr(full.full_chat, "call", None)
            if not call or getattr(call, "id", 0) == 0:
                await self._app.invoke(CreateGroupCall(peer=peer, random_id=random.randint(10000, 99999999), title="Pappy Radio 📻"))
                created = True
                for _ in range(10):
                    await asyncio.sleep(0.25)
                    full2 = await self._app.invoke(GetFullChannel(channel=peer))
                    call2 = getattr(full2.full_chat, "call", None)
                    if call2 and getattr(call2, "id", 0) != 0:
                        break
            return created

        try:
            is_new = bool(self._run_pyrogram(_check_or_create()))
            if is_new:
                # Give Telegram WebRTC servers 1.0s to provision media relay transport endpoints
                time.sleep(1.0)
            return is_new
        except EngineError:
            raise
        except Exception as e:
            err_msg = str(e)
            if "CHAT_ADMIN_REQUIRED" in err_msg:
                raise EngineError("NEED_ADMIN", "Assistant account needs Admin privileges with 'Manage Video Chats' enabled to start the voice call.") from e
            elif "CHANNEL_INVALID" in err_msg:
                raise EngineError("NOT_IN_GROUP", "Assistant account @pappy_d_spammer is not in this group.") from e
            return False

    def join_chat(self, chat_id_or_invite: str | int) -> bool:
        """Join a group chat via invite link or chat_id."""
        from pyrogram.errors import UserAlreadyParticipant

        async def _join() -> bool:
            try:
                chat = await self._app.join_chat(chat_id_or_invite)
                try:
                    await self._app.get_chat(chat.id)
                except Exception:
                    pass
                return True
            except UserAlreadyParticipant:
                return True
            except Exception as e:
                if "USER_ALREADY_PARTICIPANT" in str(e):
                    return True
                raise EngineError("JOIN_FAILED", f"Could not join chat: {e}") from e

        return bool(self._run_pyrogram(_join()))

    def leave_chat(self, chat_id: int) -> bool:
        """Leave a group chat to free assistant group quota for multi-group scaling."""
        from pyrogram.errors import UserNotParticipant

        async def _leave() -> bool:
            try:
                await self._app.leave_chat(chat_id)
                return True
            except UserNotParticipant:
                return True
            except Exception:
                return False

        try:
            return bool(self._run_pyrogram(_leave()))
        except Exception:
            return False

    def play(self, chat_id: int, url: str, headers: Optional[dict] = None, is_video: bool = False) -> bool:
        from pytgcalls.types import AudioQuality, VideoQuality, MediaStream, GroupCallConfig
        import time
        # Multi-group scaling: If the assistant is active in another group call,
        # cleanly leave/stop the previous group call so Telegram WebRTC transport
        # connects cleanly to the target group without MTProto call collision.
        for other_cid in list(self._live):
            if other_cid != chat_id:
                try:
                    self.stop(other_cid)
                    self._on_event(EngineEvent("call.left", other_cid))
                    time.sleep(1.5)
                except Exception:
                    pass

        # Speaker-quality audio boost filter chain + Chrome browser disguise:
        # - user_agent Chrome: bypasses YouTube / googlevideo CDN HTTP 403 Forbidden
        # - bass=g=5:f=100: deep punchy speaker bass instead of thin radio roll-off
        # - treble=g=3:f=6000: crisp high-end clarity for vocals and acoustics
        # - volume=1.8: high-energy speaker volume level (+80% gain boost)
        # - alimiter=limit=0.95:level=false: lookahead peak limiter to eliminate clipping/distortion
        chrome_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
        audio_boost_params = f'--audio -user_agent "{chrome_ua}" ---mid -af bass=g=5:f=100,treble=g=3:f=6000,volume=1.8,alimiter=limit=0.95:level=false'
        video_boost_params = f'--audio -user_agent "{chrome_ua}" --video -user_agent "{chrome_ua}" ---mid -af bass=g=5:f=100,treble=g=3:f=6000,volume=1.8,alimiter=limit=0.95:level=false'

        stream_headers = headers or {
            "User-Agent": chrome_ua,
            "Accept": "*/*",
            "Referer": "https://www.youtube.com/",
            "Origin": "https://www.youtube.com",
        }

        if is_video:
            stream = MediaStream(
                url,
                audio_parameters=AudioQuality.HIGH,
                video_parameters=VideoQuality.FHD_1080p,
                headers=stream_headers,
                ffmpeg_parameters=video_boost_params,
            )
        else:
            stream = MediaStream(
                url,
                audio_parameters=AudioQuality.HIGH,
                video_flags=MediaStream.Flags.IGNORE,
                headers=stream_headers,
                ffmpeg_parameters=audio_boost_params,
            )
        config = GroupCallConfig(auto_start=True)

        if chat_id not in self._live:
            self._ensure_group_call(chat_id)

        for attempt in range(2):
            try:
                self._call.play(chat_id, stream, config=config)
                break
            except EngineError:
                raise
            except Exception as e:
                err_name = type(e).__name__
                err_msg = str(e)
                if attempt == 0 and ("TransportParseException" in err_name or "Transport not found" in err_msg or "Timeout" in err_name or "ConnectionNotFound" in err_name or "NoActiveGroupCall" in err_name):
                    try:
                        if hasattr(self._call, "_clear_cache"):
                            self._call._clear_cache(chat_id)
                    except Exception:
                        pass
                    self._ensure_group_call(chat_id)
                    time.sleep(1.5)
                    continue
                elif "UserNotParticipant" in err_name or "USER_NOT_PARTICIPANT" in err_msg or "ChannelInvalid" in err_name or "CHANNEL_INVALID" in err_msg:
                    raise EngineError("NOT_IN_GROUP", "Assistant account @pappy_d_spammer is not in this group.") from e
                elif "ChatAdminRequired" in err_name or "CHAT_ADMIN_REQUIRED" in err_msg:
                    raise EngineError("NEED_ADMIN", "Assistant account needs Admin privileges with 'Manage Video Chats' enabled.") from e
                else:
                    raise EngineError("PLAY_FAILED", f"{err_name}: {err_msg}") from e

        if self._active_chat_id and self._active_chat_id != chat_id:
            try:
                self.stop(self._active_chat_id)
                self._on_event(EngineEvent("call.left", self._active_chat_id))
                time.sleep(1.0)
            except Exception:
                pass
        self._active_chat_id = chat_id

        fresh = chat_id not in self._live
        self._live.add(chat_id)
        if is_video:
            self._video_chats.add(chat_id)
        else:
            self._video_chats.discard(chat_id)
        if fresh:
            self._on_event(EngineEvent("joined", chat_id))
        self._on_event(EngineEvent("started", chat_id))
        return fresh

    def pause(self, chat_id: int) -> None:
        cid = int(chat_id)
        try:
            self._call.pause(cid)
        except Exception:
            pass

    def resume(self, chat_id: int) -> None:
        cid = int(chat_id)
        try:
            self._call.resume(cid)
        except Exception:
            pass

    def stop(self, chat_id: int) -> None:
        cid = int(chat_id)
        try:
            self._call.leave_call(cid)
        except Exception:
            pass
        try:
            if hasattr(self._call, "_clear_cache"):
                self._call._clear_cache(cid)
        except Exception:
            pass

        async def _force_leave() -> None:
            try:
                from pyrogram.raw.functions.phone import LeaveGroupCall
                from pyrogram.raw.functions.channels import GetFullChannel
                peer = await self._app.resolve_peer(cid)
                full = await self._app.invoke(GetFullChannel(channel=peer))
                call = getattr(full.full_chat, "call", None)
                if call and getattr(call, "id", 0) != 0:
                    await self._app.invoke(LeaveGroupCall(call=call, source=0))
            except Exception:
                pass

        try:
            self._run_pyrogram(_force_leave())
        except Exception:
            pass
        self._live.discard(cid)
        self._video_chats.discard(cid)
        if self._active_chat_id == cid:
            self._active_chat_id = None

    def set_volume(self, chat_id: int, level: int) -> None:
        cid = int(chat_id)
        try:
            self._call.change_volume_call(cid, level)
        except Exception:
            pass

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
