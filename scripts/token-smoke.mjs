// presign-guard after #42: wait until the live OpenAPI shows the receipt schema, then check
// the guidance, well-known signer link, homepage card and that signing is still on. Free.
const B = "https://presign-guard.onrender.com";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let spec;
for (let i = 0; i < 48; i++) {
  spec = await (await fetch(`${B}/openapi.json`)).json().catch(() => null);
  const has = spec && spec.paths?.["/v1/token"]?.get?.responses?.[200]?.content?.["application/json"]?.schema?.properties?.receipt;
  console.log(new Date().toISOString(), "version", spec && spec.info.version, "receipt in spec:", Boolean(has));
  if (has) break;
  await wait(15000);
}
const paths = ["/v1/check", "/v1/check/explain"].map((p) => Boolean(spec.paths[p].post.responses[200].content["application/json"].schema.properties.receipt));
paths.push(Boolean(spec.paths["/v1/approvals"].get.responses[200].content["application/json"].schema.properties.receipt));
console.log("receipt on check/explain/approvals:", paths.join(","));
console.log("guidance mentions verify:", /\/v1\/verify/.test(spec.info["x-guidance"]));
console.log("well-known signer:", (await (await fetch(`${B}/.well-known/x402`)).json()).signer);
const home = await (await fetch(B, { headers: { accept: "text/html" } })).text();
console.log("homepage card:", home.includes('id="signed-card"'));
const s = await (await fetch(`${B}/.well-known/presign-guard-signer.json`)).json();
console.log("signing:", s.signing, s.signers?.[0]?.address);
