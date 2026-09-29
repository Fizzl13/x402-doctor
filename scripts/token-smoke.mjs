// Read-only: which videos the Doctor homepage embeds; fix.mp4 still served.
const home = await (await fetch('https://x402-doctor.fizzl.eu/', { signal: AbortSignal.timeout(20000) })).text();
console.log('VID posters', JSON.stringify([...home.matchAll(/poster="([^"]+)"/g)].map((m) => m[1])));
console.log('VID fixSection', /fixVideoTitle/.test(home));
for (const u of ['https://x402-doctor.fizzl.eu/media/fix.mp4', 'https://x402-doctor.fizzl.eu/media/explainer.mp4']) {
  const r = await fetch(u, { method: 'GET', headers: { range: 'bytes=0-1' }, signal: AbortSignal.timeout(20000) });
  console.log('VID', u, r.status);
}
