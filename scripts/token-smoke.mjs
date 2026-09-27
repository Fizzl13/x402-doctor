// Wait until presign-guard #43 and Doctor #62 are deployed: the receipt schema in each live OpenAPI
// has the payment field. Free, read-only.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const has = async (url, pick) => { try { return Boolean(pick(await (await fetch(url)).json())); } catch { return false; } };
let a = false, b = false;
for (let i = 0; i < 56 && !(a && b); i++) {
  a = a || await has("https://presign-guard.onrender.com/openapi.json", (s) => s.paths["/v1/token"].get.responses[200].content["application/json"].schema.properties.receipt.properties.payment);
  b = b || await has("https://x402-doctor.onrender.com/openapi.json", (s) => s.paths["/api/v1/preflight"].get.responses[200].content["application/json"].schema.properties.receipt.properties.payment);
  console.log(new Date().toISOString(), "presign-guard:", a, "doctor:", b);
  if (!(a && b)) await wait(15000);
}
