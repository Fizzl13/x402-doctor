// Look into the paid crowding-check result: raw Edge funding rows per venue.
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("crowding/result.json", "utf8"));
console.log("verdict:", r.verdict, "|", r.read);
const raw = r.raw?.funding;
const rows = raw?.assets || raw?.data?.assets || raw?.result?.assets || [];
const btc = rows.find((a) => /BTC/i.test(a.asset || a.symbol || "")) || rows[0];
console.log("top-level keys:", Object.keys(raw || {}).join(", "));
console.log("BTC row keys:", Object.keys(btc || {}).join(", "));
for (const v of btc?.venues || []) console.log(JSON.stringify(v));
const meta = { ...raw }; delete meta.assets; console.log("meta:", JSON.stringify(meta).slice(0, 1500));
console.log("positioning raw:", JSON.stringify(r.raw?.positioning).slice(0, 1500));
