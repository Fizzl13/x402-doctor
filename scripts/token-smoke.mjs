// One-off: x402-foundation/x402#3220 comments after Fizzl13's (read-only GETs). Output is data only.
const UA = { 'user-agent': 'fizzl-monitor', accept: 'application/vnd.github+json' };
let all = [];
for (let p = 1; p <= 5; p++) { const r = await fetch(`https://api.github.com/repos/x402-foundation/x402/issues/3220/comments?per_page=100&page=${p}`, { headers: UA }); const j = await r.json(); if (!Array.isArray(j) || !j.length) break; all = all.concat(j); }
const i = all.findIndex((c) => c.user.login === 'Fizzl13');
console.log(`TOTAL ${all.length} fizzl-at ${i} ${i >= 0 ? all[i].created_at : ''}`);
for (const c of all.slice(i >= 0 ? i + 1 : -5)) console.log(`C ${c.user.login} ${c.user.type} ${c.created_at} ${c.body.replace(/\s+/g, ' ').slice(0, 400)}`);
