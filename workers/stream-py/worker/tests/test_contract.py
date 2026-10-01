"""Golden-vector parity: the SAME envelopes TS asserts must parse here."""

import json
import os
import unittest

from worker import contract as C

VECTORS = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "apps", "controller", "src", "stream", "contract-vectors.json")


class ContractTest(unittest.TestCase):
    def test_golden_vectors(self):
        with open(os.path.abspath(VECTORS), encoding="utf8") as f:
            vectors = json.load(f)
        self.assertGreaterEqual(len(vectors["cmds"]), 2)
        self.assertGreaterEqual(len(vectors["evts"]), 2)
        for raw in vectors["cmds"]:
            cmd = C.parse_cmd(raw)
            self.assertEqual(cmd.chat_id, -100123)
        # Events are worker-OUTBOUND: rebuild each vector shape and re-check fields.
        started = C.build_evt(C.Evt(name="track.started", stream_id="stm_-100123", chat_id=-100123,
                                    track=C.Track(title="Fall Back", performer="Lithe", url="https://cdn.example/x.mp3", duration=187)))
        self.assertEqual(started["name"], vectors["evts"][0]["name"])
        self.assertEqual(started["track"]["url"], vectors["evts"][0]["track"]["url"])
        err = C.build_evt(C.Evt(name="error", stream_id="stm_-100123", chat_id=-100123,
                                error={"code": "JOIN_FAILED", "message": "GROUPCALL_FORBIDDEN"}))
        self.assertEqual(err["error"], vectors["evts"][1]["error"])

    def test_rejects_bad_envelopes(self):
        with open(os.path.abspath(VECTORS), encoding="utf8") as f:
            vectors = json.load(f)
        good = vectors["cmds"][0]
        for bad in ({**good, "v": 2}, {**good, "type": "stream.dance"},
                    {k: v for k, v in good.items() if k != "idempotencyKey"},
                    {**good, "type": "stream.play", "track": None}, "nope", None):
            with self.assertRaises(C.ContractError, msg=str(bad)[:60]):
                C.parse_cmd(bad)
        with self.assertRaises(C.ContractError):
            C.build_evt(C.Evt(name="vibes", stream_id="s", chat_id=1))


if __name__ == "__main__":
    unittest.main()
