// Weekly Ichimoku results: the free preview's 7-day history and summary.
const r = await fetch('https://ichimoku-signal.onrender.com/setups/preview', { signal: AbortSignal.timeout(180000) });
const d = await r.json();
console.log('HTTP', r.status, 'timestamp', d.timestamp);
console.log('TODAY', JSON.stringify(d.setup && { pair: d.setup.pair, direction: d.setup.direction, rr: d.setup.risk_reward_1 }));
for (const h of d.history || []) console.log('DAY', JSON.stringify(h));
console.log('SUMMARY', JSON.stringify(d.history_summary));
