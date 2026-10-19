"""Offline tests for the Space (app.py): the summaries and the input checks. Doctor is never called."""

import unittest
from unittest import mock

import app


class Summaries(unittest.TestCase):
    def test_check_keeps_problems_with_their_fix_and_the_payment_options(self):
        report = {
            "url": "https://api.example.com/paid", "method": "GET", "overall": "fail", "share_url": "https://x402-doctor.fizzl.eu/?url=x",
            "checks": [
                {"id": "returns-402", "status": "pass", "message": "ok"},
                {"id": "resource-url", "status": "fail", "message": "resource.url is http", "hint": "build it from your public origin"},
                {"id": "openapi", "status": "warn", "message": "no openapi.json"},
                {"id": "note", "status": "info", "message": "fyi"},
            ],
            "challenge": {"accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "10000", "asset": "0xusdc", "payTo": "0xpay", "extra": {"name": "USD Coin"}}]},
            "wallets": [{"wallet": "Rabby", "yes": ["Base"]}, {"wallet": "Pera", "yes": []}],
        }
        s = app.summarize_check(report)
        self.assertEqual(s["overall"], "fail")
        self.assertEqual([p["check"] for p in s["problems"]], ["resource-url", "openapi"])
        self.assertEqual(s["problems"][0]["fix"], "build it from your public origin")
        self.assertNotIn("fix", s["problems"][1])
        self.assertEqual(s["checks_passed"], 1)
        self.assertEqual(s["payment_options"], [{"scheme": "exact", "network": "eip155:8453", "amount": "10000", "asset": "0xusdc", "payTo": "0xpay"}])
        self.assertEqual(s["wallets_that_can_pay"], ["Rabby"])

    def test_trust_drops_the_date_list_and_explains_the_history(self):
        s = app.summarize_trust({"url": "u", "history": "-gn", "days": ["2026-10-16", "2026-10-17", "2026-10-18"]})
        self.assertNotIn("days", s)
        self.assertEqual(s["window"], "2026-10-16 to 2026-10-18")
        self.assertIn("g payable", s["history_legend"])

    def test_market_shares(self):
        s = app.summarize_market({"updated": "t", "latest": {"go": 60, "caution": 10, "no_go": 29, "unreachable": 1}, "reasons": [{"code": "no_402", "count": 29}]})
        self.assertEqual([s["endpoints_checked"], s["payable_pct"], s["clean_pct"], s["not_payable_pct"]], [100, 70.0, 60.0, 30.0])


class Tools(unittest.TestCase):
    def test_bad_input_is_refused_before_any_call(self):
        with mock.patch.object(app, "_call") as call:
            self.assertIn("error", app.check_x402_endpoint("not a url"))
            self.assertIn("error", app.check_x402_endpoint("https://api.example.com", "DELETE"))
            self.assertIn("error", app.trust_record("ftp://x"))
            call.assert_not_called()

    def test_check_sends_the_method_only_when_given(self):
        with mock.patch.object(app, "_call", return_value=(200, {"checks": [], "overall": "pass"})) as call:
            app.check_x402_endpoint(" https://api.example.com/paid ", "")
            app.check_x402_endpoint("https://api.example.com/paid", "post")
        self.assertEqual(call.call_args_list[0].kwargs["json"], {"url": "https://api.example.com/paid"})
        self.assertEqual(call.call_args_list[1].kwargs["json"], {"url": "https://api.example.com/paid", "method": "POST"})

    def test_unlisted_and_rate_limited(self):
        with mock.patch.object(app, "_call", return_value=(404, {"error": "not in the trust index"})):
            self.assertEqual(app.trust_record("https://api.example.com/x")["listed"], False)
        with mock.patch.object(app, "_call", return_value=(429, {"error": "x402 Doctor is rate limiting this Space"})):
            self.assertIn("rate limiting", app.check_x402_endpoint("https://api.example.com/x")["error"])


if __name__ == "__main__":
    unittest.main()
