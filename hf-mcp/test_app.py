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
        self.assertNotIn("largest_seller", s)
        farm = app.summarize_market({"latest": {"go": 60, "caution": 10, "no_go": 130, "unreachable": 0}, "largest_host": {"endpoints": 100, "share_pct": 50, "down": True, "latest_without": {"go": 60, "caution": 10, "no_go": 30, "unreachable": 0}}})
        self.assertEqual(farm["largest_seller"]["without_it"], {"endpoints": 100, "payable_pct": 70.0, "clean_pct": 60.0, "not_payable_pct": 30.0})


class Tools(unittest.TestCase):
    def test_bad_input_is_refused_before_any_call(self):
        with mock.patch.object(app, "_call") as call:
            self.assertIn("error", app.check_x402_endpoint("not a url"))
            self.assertIn("error", app.check_x402_endpoint("https://api.example.com", "DELETE"))
            self.assertIn("error", app.check_x402_endpoint("https://api.example.com/x", "POST", "not json"))
            self.assertIn("error", app.check_x402_endpoint("https://api.example.com/x", "GET", '{"a":1}'))
            self.assertIn("error", app.trust_record("ftp://x"))
            call.assert_not_called()

    def test_check_sends_the_method_only_when_given(self):
        with mock.patch.object(app, "_call", return_value=(200, {"checks": [], "overall": "pass"})) as call:
            app.check_x402_endpoint(" https://api.example.com/paid ", "")
            app.check_x402_endpoint("https://api.example.com/paid", "post")
        self.assertEqual(call.call_args_list[0].kwargs["json"], {"url": "https://api.example.com/paid"})
        self.assertEqual(call.call_args_list[1].kwargs["json"], {"url": "https://api.example.com/paid", "method": "POST"})

    def test_check_sends_an_example_body(self):
        with mock.patch.object(app, "_call", return_value=(200, {"checks": [], "overall": "pass"})) as call:
            app.check_x402_endpoint("https://api.example.com/csv", "", ' {"csvText":"a,b"} ')
        self.assertEqual(call.call_args.kwargs["json"], {"url": "https://api.example.com/csv", "body": '{"csvText":"a,b"}'})

    def test_unlisted_and_rate_limited(self):
        with mock.patch.object(app, "_call", return_value=(404, {"error": "not in the trust index"})):
            self.assertEqual(app.trust_record("https://api.example.com/x")["listed"], False)
        with mock.patch.object(app, "_call", return_value=(429, {"error": "x402 Doctor is rate limiting this Space"})):
            self.assertIn("rate limiting", app.check_x402_endpoint("https://api.example.com/x")["error"])



class AddToTrustIndex(unittest.TestCase):
    def test_refuses_non_https_before_any_call(self):
        with mock.patch.object(app, "_call") as call:
            self.assertFalse(app.add_to_trust_index("http://api.example.com/paid")["ok"])
            self.assertFalse(app.add_to_trust_index("")["ok"])
            call.assert_not_called()

    def test_passes_doctors_answer_on(self):
        with mock.patch.object(app, "_call", return_value=(201, {"status": "added", "message": "Added."})) as call:
            out = app.add_to_trust_index(" https://api.example.com/paid ")
            self.assertEqual(out, {"ok": True, "status": "added", "message": "Added."})
            call.assert_called_once_with("POST", "/api/trust/submit", json={"url": "https://api.example.com/paid"})
        with mock.patch.object(app, "_call", return_value=(422, {"error": "Not added: no 402."})):
            out = app.add_to_trust_index("https://api.example.com/free")
            self.assertEqual(out["ok"], False)
            self.assertIn("no 402", out["error"])

    def test_unlisted_record_points_to_the_add_tool(self):
        with mock.patch.object(app, "_call", return_value=(404, {"error": "not in the trust index yet", "submitted_at": "2026-10-19T20:00:00Z"})):
            out = app.trust_record("https://api.example.com/paid")
            self.assertFalse(out["listed"])
            self.assertEqual(out["submitted_at"], "2026-10-19T20:00:00Z")
            self.assertIn("add_to_trust_index", out["how_to_list"])

if __name__ == "__main__":
    unittest.main()
