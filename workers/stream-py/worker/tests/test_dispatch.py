"""dispatch_one: validate → claim → play → events, dupes skipped, junk dropped."""

import unittest

from worker.bus import MemoryBus
from worker.engine import EngineError, FakeEngine
from worker.main import dispatch_one


def play_cmd(track_url="https://cdn.example/x.mp3", key="idem_1"):
    return {"v": 1, "id": "cmd_1", "type": "stream.play", "streamId": "stm_-100",
            "chatId": -100, "track": {"title": "T", "url": track_url}, "idempotencyKey": key}


class DispatchTest(unittest.TestCase):
    def setUp(self):
        self.bus = MemoryBus()
        self.events = []
        self.engine = FakeEngine(self.events.append)
        self.engine.start()
        self.sids = {}

    def dispatch(self, raw):
        import ipaddress

        def fake_resolve(host: str) -> list[str]:
            try:
                ipaddress.ip_address(host)
                return [host]  # literals resolve to themselves (loopback still rejected)
            except ValueError:
                return ["1.1.1.1"]

        dispatch_one(self.bus, self.engine, self.sids, raw, resolve=fake_resolve)

    def test_play_emits_started_and_engine_joined(self):
        self.dispatch(play_cmd())
        names = [e["name"] for e in self.bus.published]
        self.assertIn("track.started", names)
        self.assertEqual(self.engine.plays, [(-100, "https://cdn.example/x.mp3")])
        kinds = [e.kind for e in self.events]
        self.assertIn("joined", kinds)

    def test_duplicate_idempotency_key_skipped(self):
        self.dispatch(play_cmd())
        self.dispatch(play_cmd())
        self.assertEqual(len(self.engine.plays), 1)

    def test_private_url_rejected_with_error_event(self):
        self.dispatch(play_cmd("http://127.0.0.1/x.mp3"))
        self.assertEqual(self.engine.plays, [])
        err = [e for e in self.bus.published if e["name"] == "error"][0]
        self.assertEqual(err["error"]["code"], "SOURCE_REJECTED")

    def test_engine_failure_becomes_error_event(self):
        self.engine.fail_next = EngineError("PLAY_FAILED", "boom")
        self.dispatch(play_cmd())
        err = [e for e in self.bus.published if e["name"] == "error"][0]
        self.assertEqual(err["error"]["code"], "PLAY_FAILED")

    def test_pause_resume_stop_ping(self):
        self.dispatch({**play_cmd(), "id": "c", "type": "stream.pause", "idempotencyKey": "k2", "track": None})
        self.dispatch({**play_cmd(), "id": "c", "type": "stream.resume", "idempotencyKey": "k3", "track": None})
        self.dispatch({**play_cmd(), "id": "c", "type": "stream.stop", "idempotencyKey": "k4", "track": None})
        self.dispatch({**play_cmd(), "id": "c", "type": "stream.ping", "idempotencyKey": "k5", "track": None})
        names = [e["name"] for e in self.bus.published]
        self.assertEqual(names, ["paused", "resumed", "call.left", "pong"])

    def test_malformed_and_unknown_dropped_quietly(self):
        self.dispatch({"__malformed": True})
        self.dispatch({"v": 1, "id": "x", "type": "stream.dance", "streamId": "s", "chatId": 1, "idempotencyKey": "k"})
        self.dispatch(None)
        self.assertEqual(self.bus.published, [])
        self.assertEqual(self.engine.plays, [])


if __name__ == "__main__":
    unittest.main()
