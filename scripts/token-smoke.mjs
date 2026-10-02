// One-off: does wallet.fizzl.eu reach the wallet server (DNS + TLS)?
import { resolveCname, resolve4 } from "node:dns/promises";
try { console.log("DNS CNAME", await resolveCname("wallet.fizzl.eu")); } catch (e) { console.log("DNS CNAME ERR", e.code); }
try { console.log("DNS A", await resolve4("wallet.fizzl.eu")); } catch (e) { console.log("DNS A ERR", e.code); }
for (const path of ["/health", "/demo", "/api/state"]) {
  try { const r = await fetch("https://wallet.fizzl.eu" + path, { signal: AbortSignal.timeout(90000) }); console.log("WF", path, r.status, (await r.text()).replace(/\s+/g, " ").slice(0, 80)); }
  catch (e) { console.log("WF", path, "ERR", e.cause?.code ?? e.message); }
}
