// presign-guard after #41: wait for the deploy (signer endpoint answers), show it, and check that
// /v1/verify rejects a body without a receipt and paid routes still 402. Free, read-only.
const B = "https://presign-guard.onrender.com";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let r, body;
for (let i = 0; i < 48; i++) {
  r = await fetch(`${B}/.well-known/presign-guard-signer.json`).catch(() => null);
  body = r && (await r.text());
  console.log(new Date().toISOString(), r && r.status, (body || "").slice(0, 160));
  if (r && r.status === 200 && body.startsWith("{")) break;
  await wait(15000);
}
const v = await fetch(`${B}/v1/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: { verdict: "green" } }) });
console.log("verify without receipt:", v.status, await v.text());
console.log("/v1/token still paid:", (await fetch(`${B}/v1/token?chain=base&address=0x4ed4e862860bed51a9570b96d89af5e1b0efefed`)).status);
console.log("root lists signer:", JSON.stringify((await (await fetch(`${B}/`, { headers: { accept: "application/json" } })).json()).signer));
