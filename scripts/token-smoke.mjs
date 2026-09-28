// New fizzl.eu hostnames: DNS, TLS certificate and the service answering behind them (all done per user).
import tls from 'node:tls';
import dns from 'node:dns/promises';
const hosts = { 'x402-doctor.fizzl.eu': '/api/health', 'presign-guard.fizzl.eu': '/health', 'ichimoku-signal.fizzl.eu': '/.well-known/x402', 'plaintext.fizzl.eu': '/' };
const cert = (host) => new Promise((resolve) => {
  const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
    const c = s.getPeerCertificate();
    resolve({ authorized: s.authorized, error: s.authorizationError || null, subject: c?.subject?.CN, altnames: c?.subjectaltname, issuer: c?.issuer?.O, valid_to: c?.valid_to });
    s.end();
  });
  s.on('error', (e) => resolve({ error: e.message }));
  s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }); });
});
for (const [host, path] of Object.entries(hosts)) {
  let cname = null; try { cname = await dns.resolveCname(host); } catch (e) { cname = e.code; }
  const c = await cert(host);
  let http = '';
  try { const r = await fetch(`https://${host}${path}`, { signal: AbortSignal.timeout(15000) }); http = `${r.status} ${(await r.text()).slice(0, 160).replace(/\s+/g, ' ')}`; } catch (e) { http = `fetch error: ${e.cause?.code || e.message}`; }
  console.log(`\n== ${host}\n  cname: ${JSON.stringify(cname)}\n  tls: ${JSON.stringify(c)}\n  https ${path}: ${http}`);
}
