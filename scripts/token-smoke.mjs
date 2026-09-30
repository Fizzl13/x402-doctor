// Wait until the ReplyDesk deploy answers CORS for fizzl.eu (no Claude call).
const url = "https://replydesk-kvu8.onrender.com/api/draft";
const end = Date.now() + 12 * 60_000;
while (Date.now() < end) {
  try {
    const r = await fetch(url, { method: "OPTIONS", headers: { origin: "https://fizzl.eu", "access-control-request-method": "POST" }, signal: AbortSignal.timeout(60000) });
    console.log(new Date().toISOString(), r.status, r.headers.get("access-control-allow-origin"));
    if (r.status === 204 && r.headers.get("access-control-allow-origin") === "https://fizzl.eu") { console.log("CORS LIVE"); process.exit(0); }
  } catch (e) { console.log(new Date().toISOString(), "ERR", e.message); }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log("NOT LIVE AFTER 12 MIN"); process.exit(1);
