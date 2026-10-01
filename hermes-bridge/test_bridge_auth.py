"""Bridge token-guard tests (spec Phase 2.4).

Before this, loopback was exempt from the token entirely. That is what let the
chat approval forward and the runs-cancel path skip sending a token at all (G2):
a process on the same machine could drive every mutating bridge endpoint without
proving anything.

These drive the real middleware through the real app, with the client host
spoofed, so the loopback and non-loopback branches are both exercised without
needing two machines.
"""

import os
import unittest
from unittest.mock import patch

import main
from bridge_errors import BRIDGE_AUTH

TOKEN = "test-bridge-token-abcdef0123456789"


class _FakeClient:
    def __init__(self, host):
        self.host = host


def _request(path: str, *, host: str, token: str | None, method: str = "POST"):
    """A minimal Request stand-in for the token guard middleware."""
    class _URL:
        def __init__(self, p):
            self.path = p

    class _Headers(dict):
        def get(self, key, default=None):
            for k, v in self.items():
                if k.lower() == key.lower():
                    return v
            return default

    headers = _Headers()
    if token is not None:
        headers["X-Hermes-Bridge-Token"] = token

    class _Request:
        def __init__(self):
            self.url = _URL(path)
            self.headers = headers
            self.client = _FakeClient(host)
            self.method = method

    return _Request()


async def _run_guard(request):
    """Invoke the middleware and report (status, body)."""
    import json

    seen = {}

    async def call_next(_req):
        seen["passed"] = True
        return "NEXT"

    result = await main.bridge_token_guard(request, call_next)
    if result == "NEXT":
        return 200, None
    # Real JSONResponse exposes `.body` (bytes); the suite-wide FastAPI stub
    # exposes only `.content` (the already-decoded dict). Read whichever is
    # present so these assertions hold in both environments.
    raw = getattr(result, "body", None)
    if raw is not None:
        try:
            return result.status_code, json.loads(bytes(raw).decode())
        except Exception:
            return result.status_code, None
    return result.status_code, getattr(result, "content", None)


class LoopbackAuthTests(unittest.IsolatedAsyncioTestCase):
    """The behaviour 2.4 changed."""

    async def test_loopback_without_a_token_is_rejected(self):
        """The G2 fix: loopback is no longer a free pass."""
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, body = await _run_guard(
                _request("/v1/chat/completions", host="127.0.0.1", token=None)
            )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], BRIDGE_AUTH)
        self.assertFalse(body["error"]["retryable"])

    async def test_loopback_with_the_wrong_token_is_rejected(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(
                _request("/v1/chat/completions", host="127.0.0.1", token="wrong")
            )
        self.assertEqual(status, 401)

    async def test_loopback_with_the_right_token_passes(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(
                _request("/v1/chat/completions", host="127.0.0.1", token=TOKEN)
            )
        self.assertEqual(status, 200)

    async def test_loopback_via_ipv6_loopback_also_requires_the_token(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(
                _request("/v1/chat/completions", host="::1", token=None)
            )
        self.assertEqual(status, 401)

    async def test_health_stays_open_without_a_token(self):
        """Readiness must answer before a caller can have authenticated."""
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(_request("/health", host="127.0.0.1", token=None))
        self.assertEqual(status, 200)

    async def test_diag_stays_open_without_a_token(self):
        """The Electron supervisor's ownership check.

        Gating this would make an unauthenticated prober unable to verify the
        process it launched, and it would then tear the bridge down as unowned.
        The supervisor now also sends the token, so this can tighten later.
        """
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(_request("/diag", host="127.0.0.1", token=None))
        self.assertEqual(status, 200)

    async def test_non_loopback_behaviour_is_unchanged(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            denied, _ = await _run_guard(
                _request("/v1/chat/completions", host="192.168.1.50", token=None)
            )
            allowed, _ = await _run_guard(
                _request("/v1/chat/completions", host="192.168.1.50", token=TOKEN)
            )
        self.assertEqual(denied, 401)
        self.assertEqual(allowed, 200)

    async def test_no_token_configured_means_no_auth_at_all(self):
        """Local dev, unchanged: an unconfigured bridge stays open."""
        with patch.object(main, "HERMES_BRIDGE_TOKEN", ""), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(
                _request("/v1/chat/completions", host="127.0.0.1", token=None)
            )
        self.assertEqual(status, 200)

    async def test_bearer_token_is_accepted_too(self):
        """The guard accepts either header form; clients should not care which."""
        request = _request("/v1/chat/completions", host="127.0.0.1", token=None)
        request.headers["Authorization"] = f"Bearer {TOKEN}"
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(request)
        self.assertEqual(status, 200)

    async def test_forbidden_origin_still_wins_and_is_an_envelope(self):
        request = _request("/v1/chat/completions", host="127.0.0.1", token=TOKEN)
        request.headers["Origin"] = "https://evil.example"
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, body = await _run_guard(request)
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], BRIDGE_AUTH)


class EscapeHatchTests(unittest.IsolatedAsyncioTestCase):
    """HERMES_BRIDGE_ALLOW_LOOPBACK_NOAUTH=1 restores the old behaviour."""

    async def test_hatch_allows_loopback_without_a_token(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", True):
            status, _ = await _run_guard(
                _request("/v1/chat/completions", host="127.0.0.1", token=None)
            )
        self.assertEqual(status, 200)

    async def test_hatch_still_does_not_open_up_non_loopback(self):
        """The hatch is scoped to loopback on purpose."""
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", True):
            status, _ = await _run_guard(
                _request("/v1/chat/completions", host="192.168.1.50", token=None)
            )
        self.assertEqual(status, 401)

    def test_hatch_is_off_unless_the_value_is_exactly_1(self):
        # Guards against a truthy-string footgun: "0" or "true" must not enable it.
        for value, expected in (("1", True), ("0", False), ("true", False), ("", False)):
            self.assertIs(_truthy(value), expected, f"value={value!r}")


def _truthy(value: str) -> bool:
    return value.strip() == "1"


class ExemptPathTests(unittest.TestCase):
    def test_exempt_set_is_exactly_the_probes(self):
        self.assertEqual(main._BRIDGE_AUTH_EXEMPT_PATHS, frozenset({"/health", "/diag"}))



class TestDiagNeverDisclosesToken(unittest.IsolatedAsyncioTestCase):
    """/diag is auth-exempt, so it must not hand the token to any local caller."""

    async def _diag(self, presented):
        req = _request("/diag", host="127.0.0.1", token=presented, method="GET")
        with patch.object(main, "HERMES_BRIDGE_TOKEN", "secret-launch-token"):
            return await main.diag(req)

    async def test_loopback_without_token_gets_no_token(self):
        payload = await self._diag(None)
        self.assertNotIn("secret-launch-token", repr(payload))
        self.assertFalse(payload["token_matches"])

    async def test_matching_token_is_confirmed_not_echoed(self):
        payload = await self._diag("secret-launch-token")
        self.assertTrue(payload["token_matches"])
        self.assertNotIn("token", payload)

    async def test_wrong_token_does_not_match(self):
        self.assertFalse((await self._diag("nope"))["token_matches"])


if __name__ == "__main__":
    unittest.main()


class ChatOverNonLoopbackTests(unittest.IsolatedAsyncioTestCase):
    """2.4's second criterion: chat works with a non-loopback bridge URL.

    A user can point HERMES_BRIDGE_URL at another host (a tunnel, a second
    machine). That path was already token-gated, but 2.4 tightens loopback too —
    so the two configurations have to be proven equivalent from the client's side,
    or tightening lockouts exactly the setups it was meant to keep working.
    """

    def _client_headers(self, *, token: str) -> dict:
        return {
            "Content-Type": "application/json",
            "X-Hermes-Bridge-Token": token,
        }

    async def test_authorized_non_loopback_request_is_allowed(self):
        """The shape the client actually sends, from a non-loopback client."""
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(
                _request(
                    "/v1/chat/completions",
                    host="10.0.0.5",
                    token=TOKEN,
                )
            )
        self.assertEqual(status, 200)

    async def test_unauthorized_non_loopback_request_is_denied(self):
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, body = await _run_guard(
                _request("/v1/chat/completions", host="10.0.0.5", token=None)
            )
        self.assertEqual(status, 401)
        self.assertEqual((body or {}).get("error", {}).get("code"), BRIDGE_AUTH)

    async def test_client_headers_satisfy_the_guard(self):
        """What server/lib/bridge-client.ts always attaches must be sufficient."""
        headers = self._client_headers(token=TOKEN)
        request = _request("/v1/chat/completions", host="127.0.0.1", token=None)
        request.headers["Content-Type"] = headers["Content-Type"]
        request.headers["X-Hermes-Bridge-Token"] = headers["X-Hermes-Bridge-Token"]
        with patch.object(main, "HERMES_BRIDGE_TOKEN", TOKEN), \
             patch.object(main, "_BRIDGE_ALLOW_LOOPBACK_NOAUTH", False):
            status, _ = await _run_guard(request)
        self.assertEqual(
            status, 200,
            "the client's unconditional token header must satisfy the tightened guard",
        )


class TestDiagNeverDisclosesToken(unittest.IsolatedAsyncioTestCase):
    """/diag is auth-exempt, so it must not hand the token to any local caller."""

    async def _diag(self, presented):
        req = _request("/diag", host="127.0.0.1", token=presented, method="GET")
        with patch.object(main, "HERMES_BRIDGE_TOKEN", "secret-launch-token"):
            return await main.diag(req)

    async def test_loopback_without_token_gets_no_token(self):
        payload = await self._diag(None)
        self.assertNotIn("secret-launch-token", repr(payload))
        self.assertFalse(payload["token_matches"])

    async def test_matching_token_is_confirmed_not_echoed(self):
        payload = await self._diag("secret-launch-token")
        self.assertTrue(payload["token_matches"])
        self.assertNotIn("token", payload)

    async def test_wrong_token_does_not_match(self):
        self.assertFalse((await self._diag("nope"))["token_matches"])
