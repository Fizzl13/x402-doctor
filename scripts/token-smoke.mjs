// Who is behind api.060504.shop? Only public information.
const get = async (u, o = {}) => { try { const r = await fetch(u, { redirect: "follow", ...o }); return { s: r.status, h: r.headers, t: await r.text(), url: r.url }; } catch (e) { return { s: 0, t: String(e) }; } };
const strip = (t) => t.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const ep = await get("https://api.060504.shop/v1/fetch/dynamic");
console.log("## endpoint GET", ep.s, ep.h?.get?.("content-type"));
const pr = ep.h?.get?.("payment-required");
if (pr) { const c = JSON.parse(Buffer.from(pr, "base64").toString()); console.log(JSON.stringify({ resource: c.resource, accepts: c.accepts?.map((a) => ({ net: a.network, amt: a.amount, payTo: a.payTo, extra: a.extra })), ext: c.extensions ? Object.keys(c.extensions) : null }, null, 1).slice(0, 1500)); if (c.extensions?.bazaar) console.log("bazaar:", JSON.stringify(c.extensions.bazaar).slice(0, 800)); }
else console.log(ep.t.slice(0, 800));
for (const u of ["https://api.060504.shop/", "https://060504.shop/", "https://www.060504.shop/", "https://api.060504.shop/.well-known/x402", "https://api.060504.shop/openapi.json", "https://api.060504.shop/llms.txt", "https://060504.shop/llms.txt"]) {
  const r = await get(u);
  console.log(`\n## ${u} -> ${r.s} (${r.url})`);
  console.log(strip(r.t).slice(0, 900));
}
const rdap = await get("https://rdap.centralnic.com/shop/domain/060504.shop");
console.log("\n## RDAP", rdap.s); try { const j = JSON.parse(rdap.t); console.log(JSON.stringify({ events: j.events, entities: j.entities?.map((e) => ({ roles: e.roles, vcard: e.vcardArray?.[1]?.filter((x) => ["fn", "org", "adr", "email"].includes(x[0])) })), nameservers: j.nameservers?.map((n) => n.ldhName) }).slice(0, 1500)); } catch { console.log(rdap.t.slice(0, 300)); }
const am = await get("https://api.agentic.market/v1/services/search?q=060504");
console.log("\n## agentic.market search", am.s, am.t.slice(0, 1200));
let found = [];
for (let off = 0; off < 20000; off += 500) {
  const r = await get(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=500&offset=${off}`);
  let items = []; try { const j = JSON.parse(r.t); items = j.items || j.resources || []; } catch {}
  for (const it of items) if (JSON.stringify(it).includes("060504")) found.push({ resource: it.resource, desc: (it.accepts?.[0]?.description || it.description || "").slice(0, 120), payTo: it.accepts?.[0]?.payTo, quality: it.quality });
  if (items.length < 500) break;
}
console.log("\n## CDP Bazaar entries:", found.length); console.log(JSON.stringify(found.slice(0, 15), null, 1).slice(0, 3000));
