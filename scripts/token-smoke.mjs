// Research: which agent-tools.cloud page shows the x402 Doctor listing (read-only).
const slug = 'x402-doctor-fizzl-eu-sub975';
for (const p of [`/services/${slug}`, `/service/${slug}`, `/s/${slug}`, `/x402/${slug}`, `/tools/${slug}`, `/listing/${slug}`, `/${slug}`]) {
  const r = await fetch(`https://agent-tools.cloud${p}`, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' }, redirect: 'manual' });
  const t = r.status === 200 ? await r.text() : '';
  console.log(p, r.status, r.headers.get('location') || '', /x402 Doctor/.test(t) ? 'MENTIONS DOCTOR' : '', (t.match(/<title>[^<]*<\/title>/) || [''])[0]);
}
