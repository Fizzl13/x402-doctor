"""x402 Doctor on Hugging Face: a Gradio app that is also an MCP server.

Three free tools, each a call to x402 Doctor's public API (https://x402-doctor.fizzl.eu). Nothing here pays,
signs or holds a key: the paid preflight ($0.001 over x402) stays on Doctor itself.

- check_x402_endpoint: the full check of a paid endpoint (POST /api/diagnose), what an agent would meet before paying.
- trust_record: the daily track record of an endpoint listed in the CDP Bazaar or the MPP directory (GET /api/trust).
- x402_market_health: totals of the latest daily scan of every listed endpoint (GET /api/trust/summary).
"""

import os

import gradio as gr
import requests

DOCTOR = os.environ.get("DOCTOR_URL", "https://x402-doctor.fizzl.eu").rstrip("/")
USER_AGENT = "x402-doctor-hf-space/1.0 (+https://huggingface.co/spaces/x402Fizzl/x402-doctor)"
TIMEOUT = 60
LEGEND = "one letter per day, oldest first: g payable, c payable with a caution, n not payable, x unreachable, - not scanned"


def _call(method, path, **kwargs):
    """Doctor's answer as (status, JSON), or (status, {"error": ...}) when it isn't JSON or can't be reached."""
    try:
        res = requests.request(method, f"{DOCTOR}{path}", headers={"user-agent": USER_AGENT, "accept": "application/json"}, timeout=TIMEOUT, **kwargs)
    except requests.RequestException as err:
        return 0, {"error": f"x402 Doctor could not be reached: {err}"}
    if res.status_code == 429:
        return 429, {"error": "x402 Doctor is rate limiting this Space (a few checks a minute for everyone using it). Try again in a minute, or run the check on https://x402-doctor.fizzl.eu."}
    try:
        return res.status_code, res.json()
    except ValueError:
        return res.status_code, {"error": f"x402 Doctor answered HTTP {res.status_code} without JSON"}


def _url_ok(url):
    url = (url or "").strip()
    return url if url.startswith(("https://", "http://")) else None


def summarize_check(report):
    """The part of Doctor's report an agent needs: the verdict, every problem with its fix, and the payment options."""
    checks = report.get("checks") or []
    problems = [
        {"status": c.get("status"), "check": c.get("id"), "message": c.get("message"), **({"fix": c["hint"]} if c.get("hint") else {})}
        for c in checks
        if c.get("status") in ("fail", "warn")
    ]
    accepts = ((report.get("challenge") or {}).get("accepts")) or []
    options = [
        {k: a.get(k) for k in ("scheme", "network", "amount", "asset", "payTo") if a.get(k) is not None}
        for a in accepts
        if isinstance(a, dict)
    ]
    wallets = [w.get("wallet") for w in report.get("wallets") or [] if w.get("yes")]
    return {
        "url": report.get("url"),
        "method": report.get("method"),
        "overall": report.get("overall"),
        "problems": problems,
        "checks_passed": sum(1 for c in checks if c.get("status") == "pass"),
        "payment_options": options,
        "wallets_that_can_pay": wallets,
        "full_report": report.get("share_url"),
    }


def summarize_trust(record):
    """A track record without the per-day date list: the history string is explained instead."""
    out = {k: v for k, v in record.items() if k != "days"}
    days = record.get("days") or []
    if days:
        out["window"] = f"{days[0]} to {days[-1]}"
    if "history" in out:
        out["history_legend"] = LEGEND
    return out


def summarize_market(summary):
    latest = summary.get("latest") or {}
    checked = sum(latest.get(k, 0) for k in ("go", "caution", "no_go", "unreachable"))
    pct = lambda n: round(100 * n / checked, 1) if checked else 0
    return {
        "updated": summary.get("updated"),
        "endpoints_checked": checked,
        "payable_pct": pct(latest.get("go", 0) + latest.get("caution", 0)),
        "clean_pct": pct(latest.get("go", 0)),
        "caution_pct": pct(latest.get("caution", 0)),
        "not_payable_pct": pct(latest.get("no_go", 0) + latest.get("unreachable", 0)),
        "top_reasons": (summary.get("reasons") or [])[:5],
        "networks": (summary.get("networks") or [])[:5],
        "by_protocol": summary.get("by_protocol"),
        **({"onchain_payments": summary["onchain_payments"]} if summary.get("onchain_payments") else {}),
        "source": f"{DOCTOR}/trust",
    }


def check_x402_endpoint(url: str, method: str = "") -> dict:
    """Check a paid x402 (or MPP) API endpoint the way a paying agent meets it, without paying.

    Triggers the 402 challenge once and checks it: protocol version, payment options (network, amount, asset,
    payout address), the resource URL, sanctions and burn addresses, price against the OpenAPI document, and
    which wallets could pay. Returns the overall result, every problem with its fix, and the payment options.

    Args:
        url: The full URL of the paid endpoint, for example https://api.example.com/v1/forecast?city=Amsterdam
        method: GET or POST. Leave empty to try both.
    """
    target = _url_ok(url)
    if not target:
        return {"error": "url must be a full http(s) URL of the paid endpoint"}
    method = (method or "").strip().upper()
    if method not in ("", "GET", "POST"):
        return {"error": "method must be GET, POST or empty"}
    status, body = _call("POST", "/api/diagnose", json={"url": target, **({"method": method} if method else {})})
    if status != 200 or "checks" not in body:
        return body if "error" in body else {"error": f"HTTP {status}", **body}
    return summarize_check(body)


def trust_record(url: str) -> dict:
    """The daily track record of a paid endpoint listed in the CDP Bazaar or the MPP directory.

    x402 Doctor checks every listed endpoint once a day without paying. The record shows how many days it was
    payable, the latest verdict (go, caution or no_go) with its reasons, the price and networks, and what
    happened when Doctor bought it in its weekly spot-buy sample, if it did.

    Args:
        url: The full URL of the endpoint, as listed in the CDP Bazaar or the MPP directory.
    """
    target = _url_ok(url)
    if not target:
        return {"error": "url must be a full http(s) URL"}
    status, body = _call("GET", "/api/trust", params={"url": target})
    if status == 404:
        return {"url": target, "listed": False, "note": body.get("error", "not in the trust index")}
    if status != 200:
        return body if "error" in body else {"error": f"HTTP {status}"}
    return summarize_trust(body)


def x402_market_health() -> dict:
    """How healthy the x402 market is today: the latest daily check of every endpoint in the CDP Bazaar and the MPP directory.

    Returns the share of endpoints that are payable, clean, payable with a caution or not payable, the most common
    reasons a payment would fail, and the networks payable endpoints accept.
    """
    status, body = _call("GET", "/api/trust/summary")
    if status != 200:
        return body if "error" in body else {"error": f"HTTP {status}"}
    return summarize_market(body)


ABOUT = f"""# x402 Doctor

Check paid APIs (x402 and MPP) before an AI agent pays them. Free, read-only: nothing is paid or signed here.
These three tools are also an **MCP server**: add this Space in your [Hugging Face MCP settings](https://huggingface.co/settings/mcp),
or connect any MCP client to `https://x402fizzl-x402-doctor.hf.space/gradio_api/mcp/`.

For a go / caution / no_go verdict with your budget before paying, agents can buy x402 Doctor's preflight ($0.001 over x402)
at [{DOCTOR.replace('https://', '')}]({DOCTOR}). Everything else: [{DOCTOR.replace('https://', '')}/trust]({DOCTOR}/trust).
"""

with gr.Blocks(title="x402 Doctor") as demo:
    gr.Markdown(ABOUT)
    with gr.Tab("Check an endpoint"):
        url_in = gr.Textbox(label="Paid endpoint URL", placeholder="https://api.example.com/v1/forecast?city=Amsterdam")
        method_in = gr.Dropdown(choices=["", "GET", "POST"], value="", label="Method (empty: try both)")
        check_out = gr.JSON(label="Result")
        gr.Button("Check", variant="primary").click(check_x402_endpoint, [url_in, method_in], check_out, api_name="check_x402_endpoint")
    with gr.Tab("Track record"):
        trust_in = gr.Textbox(label="Endpoint URL (as listed in the CDP Bazaar or the MPP directory)")
        trust_out = gr.JSON(label="Track record")
        gr.Button("Look up", variant="primary").click(trust_record, [trust_in], trust_out, api_name="trust_record")
    with gr.Tab("Market health"):
        market_out = gr.JSON(label="Latest daily scan")
        gr.Button("Show", variant="primary").click(x402_market_health, [], market_out, api_name="x402_market_health")

if __name__ == "__main__":
    demo.launch(mcp_server=True)
