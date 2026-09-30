// Live check of the ReplyDesk demo.
const base = "https://replydesk-kvu8.onrender.com";
async function hit(path, opts) {
  const t = Date.now();
  try {
    const r = await fetch(base + path, { ...opts, signal: AbortSignal.timeout(120000) });
    const body = await r.text();
    console.log(path, r.status, `${Date.now() - t}ms`, body.slice(0, 600));
  } catch (e) { console.log(path, "ERR", e.message); }
}
await hit("/health");
await hit("/api/config");
await hit("/api/draft", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ message: "I cancelled my subscription but was charged again. Can you check?", language: "auto" }) });
