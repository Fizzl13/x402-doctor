// Ichimoku free setups preview (read-only GET). Output is data only.
const r = await fetch('https://ichimoku-signal.fizzl.eu/setups/preview', { headers: { accept: 'application/json' } });
console.log('PREVIEW', r.status, (await r.text()).slice(0, 3000));
