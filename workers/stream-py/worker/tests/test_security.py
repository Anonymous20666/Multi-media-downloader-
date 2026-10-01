import unittest

from worker.security import UnsafeUrl, assert_public_url, redact_cmd, redact_url


class SecurityTest(unittest.TestCase):
    def test_redaction(self):
        self.assertEqual(redact_url("https://cdn.example/x.mp3?sig=SECRET#frag"), "https://cdn.example/x.mp3?<redacted>")
        cmd = {"type": "stream.play", "track": {"title": "T", "url": "https://cdn.example/x.mp3?sig=S"}}
        self.assertNotIn("sig=S", str(redact_cmd(cmd)))
        self.assertIn("Fall", str(redact_cmd({"track": {"title": "Fall"}})))

    def test_public_url_guard(self):
        allow = lambda h: ["1.1.1.1"]  # noqa: E731 — injected resolver, no DNS
        self.assertTrue(assert_public_url("https://cdn.example/x.mp3", allow))
        cases = [
            ("http://127.0.0.1/x.mp3", lambda h: ["127.0.0.1"]),
            ("http://10.0.0.8/x.mp3", lambda h: ["10.0.0.8"]),
            ("http://169.254.169.254/x", lambda h: ["169.254.169.254"]),
            ("http://[::1]/x.mp3", lambda h: ["::1"]),
            ("http://ghost.invalid/x", lambda h: []),
            ("ftp://cdn.example/x.mp3", allow),
            ("https://user:pass@cdn.example/x.mp3", allow),
            ("not-a-url", allow),
        ]
        for url, resolver in cases:
            with self.assertRaises(UnsafeUrl, msg=url):
                assert_public_url(url, resolver)


if __name__ == "__main__":
    unittest.main()
