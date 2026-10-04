const { diagnose } = require('/tmp/dr/lib/diagnose');
const { preflight } = require('/tmp/dr/lib/preflight');
const safeFetch = (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(15000) });
(async () => {
  for (const u of ['https://satring.com/api/services']) {
    const d = await diagnose(u, { safeFetch });
    console.log('L4 DIAG', u, d.overall, JSON.stringify(d.l402), JSON.stringify(d.mpp && d.mpp.map((c) => c.method)));
    for (const c of d.checks.filter((c) => ['l402', 'mpp', 'challenge'].includes(c.group))) console.log('L4  ', c.status, c.id, c.message.slice(0, 170));
    const p = await preflight(u, { safeFetch });
    console.log('L4 PRE', p.verdict, p.summary.slice(0, 200), JSON.stringify(p.signals.protocols), JSON.stringify(p.options.map((o) => [o.protocol, o.method, o.amount, o.usd, o.payable, o.problems])));
  }
  const r = await fetch('https://satring.com/api/v1/services?limit=200');
  const j = await r.json().catch(() => ({}));
  const by = {};
  for (const s of j.services || []) by[s.protocol] = (by[s.protocol] || 0) + 1;
  console.log('L4 SATRING page', (j.services || []).length, JSON.stringify(by), Object.keys(j).join(','), JSON.stringify(j.pagination || j.total || null));
})().catch((e) => console.log('L4 ERR', e.stack));
