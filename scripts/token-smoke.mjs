// Wait until Ichimoku #67 is deployed: the live OpenAPI lists liquid_top on /setups; check liquid_top
// is validated before payment. Free, read-only.
const B = "https://ichimoku-signal.onrender.com";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let live = false;
for (let i = 0; i < 56 && !live; i++) {
  try { live = (await (await fetch(`${B}/openapi.json`)).json()).paths["/setups"].get.parameters.some((p) => p.name === "liquid_top"); } catch {}
  console.log(new Date().toISOString(), "deployed:", live);
  if (!live) await wait(15000);
}
const bad = await fetch(`${B}/setups?liquid_top=0`);
console.log("liquid_top=0 ->", bad.status, (await bad.json()).error);
const ok = await fetch(`${B}/setups?liquid_top=30&top=3`);
console.log("liquid_top=30 ->", ok.status, "(402 expected: valid, asks for payment)");
