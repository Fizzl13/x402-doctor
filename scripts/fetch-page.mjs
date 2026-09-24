// One-off: presign-guard after PR #5 (video). Waits for the deploy, then checks the video, homepage and Doctor.
import { execFileSync } from 'node:child_process';
const SITE = 'https://presign-guard.onrender.com';
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(SITE + '/media/explainer.mp4', { method: 'HEAD', signal: AbortSignal.timeout(90000) });
    console.log(`wait ${i}: /media/explainer.mp4 ${r.status} ${r.headers.get('content-type')} ${r.headers.get('content-length')}`);
    if (r.ok) break;
  } catch (e) { console.log(`wait ${i}: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 15000));
}
for (const p of ['/media/explainer.jpg', '/media/explainer.srt']) {
  const r = await fetch(SITE + p, { method: 'HEAD' });
  console.log(`${p}: ${r.status} ${r.headers.get('content-type')}`);
}
const html = await (await fetch(SITE + '/', { headers: { accept: 'text/html' } })).text();
console.log('homepage has video section:', html.includes('See it in a minute') && html.includes('/media/explainer.mp4'));
const json = await (await fetch(SITE + '/')).json().catch(() => null);
console.log('agents still get JSON on /:', Boolean(json && json.service === 'presign-guard'));
let out = '';
try { out = execFileSync('node', ['doctor/bin/x402-doctor.js', SITE + '/v1/check', '--method', 'POST'], { encoding: 'utf8', timeout: 120000 }); }
catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
console.log(`\n===== Doctor: POST /v1/check\n${out.split('\n').filter((l) => /PASS|FAIL|✘|!/.test(l)).join('\n')}`);
