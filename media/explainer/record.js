// Records the explainer video's picture: drives a real browser through the
// live x402 Doctor pages, timed to the narration (out/durations.json), with
// burned-in captions. Writes out/screen.webm and out/timeline.json (when each
// segment starts, so build.sh can place the voice exactly there).
//
//   node record.js            # live pages (GitHub Actions)
//   DOCTOR_URL=http://127.0.0.1:3001 GREEN_URL=... ALLOW_PRIVATE=1 node record.js   # local test

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const OUT = process.env.OUT || path.join(__dirname, 'out');
const DOCTOR = (process.env.DOCTOR_URL || 'https://x402-doctor.onrender.com').replace(/\/$/, '');
const BROKEN_URL = process.env.BROKEN_URL || `${DOCTOR}/demo/broken`;
const GREEN_URL = process.env.GREEN_URL || 'https://ichimoku-signal.onrender.com/signal/BTC-USDT';
const LOOKUP_URL = process.env.LOOKUP_URL || `${DOCTOR}/api/v1/preflight`;
const W = 1920;
const H = 1080;
const ZOOM = 1.6;

const script = JSON.parse(fs.readFileSync(path.join(__dirname, 'script.json'), 'utf8'));
const durations = JSON.parse(fs.readFileSync(path.join(OUT, 'durations.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THEME = `
  :root { --bg:#0d1117; --panel:#161b22; --line:#30363d; --text:#e6edf3; --soft:#8b949e; --go:#3fb950; --warn:#d29922; --fail:#f85149; --accent:#58a6ff; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font-family:-apple-system,'Segoe UI',Inter,Roboto,sans-serif; }
`;

function cardHtml({ title, sub, note }) {
  return `<!doctype html><html><head><style>${THEME}
    body { display:flex; align-items:center; justify-content:center; }
    .c { text-align:center; animation: in .6s ease-out both; padding: 0 120px; }
    h1 { font-size: 104px; margin: 0 0 24px; letter-spacing: -0.02em; }
    p { font-size: 48px; color: var(--soft); margin: 0; }
    .note { font-size: 32px; margin-top: 40px; color: var(--accent); }
    @keyframes in { from { opacity:0; transform: translateY(24px);} to { opacity:1; transform:none; } }
  </style></head><body><div class="c"><h1>${title}</h1><p>${sub || ''}</p>${note ? `<p class="note">${note}</p>` : ''}</div></body></html>`;
}

function terminalHtml(lines) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html><head><style>${THEME}
    body { display:flex; align-items:center; justify-content:center; }
    .t { width: 1560px; background: var(--panel); border:1px solid var(--line); border-radius: 18px; padding: 36px 44px; box-shadow: 0 30px 80px rgba(0,0,0,.5); }
    .bar { display:flex; gap:10px; margin-bottom: 26px; } .bar i { width:16px; height:16px; border-radius:50%; background:#30363d; display:block; }
    .label { color: var(--soft); font-size: 24px; margin: -8px 0 22px; }
    pre { margin:0; font: 25px/1.5 'SF Mono', 'DejaVu Sans Mono', Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
    .l { opacity: 0; transition: opacity .35s; } .l.on { opacity: 1; }
    .cmd { color: var(--text); } .in { color: var(--warn); } .ok { color: var(--go); } .dim { color: var(--soft); }
    .hl { background: color-mix(in srgb, var(--go) 22%, transparent); border-radius: 6px; outline: 2px solid var(--go); }
  </style></head><body><div class="t"><div class="bar"><i></i><i></i><i></i></div><div class="label">An agent, before paying an unknown x402 API</div><pre>${lines
    .map((l, i) => `<div class="l ${l.cls || ''}" id="l${i}">${l.html || esc(l.text)}</div>`)
    .join('')}</pre></div></body></html>`;
}

// Captions: a bar at the bottom of every page, re-created after navigation.
async function caption(page, text) {
  await page.evaluate(
    ({ text }) => {
      let el = document.getElementById('__cap');
      if (!el) {
        el = document.createElement('div');
        el.id = '__cap';
        el.style.cssText = 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);max-width:1500px;z-index:2147483647;' +
          'background:rgba(0,0,0,.78);color:#fff;font:600 38px/1.35 -apple-system,"Segoe UI",Inter,Roboto,sans-serif;' +
          'padding:14px 28px;border-radius:14px;text-align:center;zoom:1;';
        document.body.appendChild(el);
      }
      // Same caption size on zoomed pages as on cards.
      el.style.zoom = String(1 / (parseFloat(document.documentElement.style.zoom) || 1));
      el.textContent = text;
    },
    { text }
  );
}

async function zoomPage(page) {
  await page.evaluate((z) => {
    document.documentElement.style.zoom = String(z);
  }, ZOOM);
}

async function realPreflight() {
  const { preflight } = require(path.join(ROOT, 'lib', 'preflight'));
  const { createSafeFetch } = require(path.join(ROOT, 'lib', 'safe-fetch'));
  return preflight(GREEN_URL, { safeFetch: createSafeFetch({ allowPrivate: process.env.ALLOW_PRIVATE === '1' }), maxUsd: 0.05 });
}

async function main() {
  const pf = await realPreflight();
  const best = pf.recommended_option === null ? null : pf.options[pf.recommended_option];
  const shortUrl = GREEN_URL.replace(/^https?:\/\//, '');
  const verdictJson = JSON.stringify(
    {
      verdict: pf.verdict,
      safe_to_pay: pf.safe_to_pay,
      summary: pf.summary,
      recommended_option: best && { network: best.network_name, usd: best.usd, asset: best.asset_symbol, payable: best.payable },
      reasons: pf.reasons.filter((r) => r.level !== 'info').map((r) => r.code),
    },
    null,
    2
  );
  const terminalLines = [
    { cls: 'cmd', text: `$ curl "${DOCTOR.replace(/^https?:\/\//, '')}/api/v1/preflight?url=${shortUrl}&max_usd=0.05"` },
    { cls: 'in', text: '← 402 Payment Required · $0.001 USDC (Base or Solana)' },
    { cls: 'dim', text: '→ agent signs $0.001 USDC and retries' },
    { cls: 'ok', text: '← 200 OK' },
    ...verdictJson.split('\n').map((line) => ({ cls: /"verdict"|"summary"/.test(line) ? 'ok' : 'dim', text: line })),
  ];

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } }, colorScheme: 'dark' });
  const page = await context.newPage();
  const t0 = Date.now();
  const timeline = [];

  const scenes = {
    async card(seg) {
      await page.setContent(cardHtml(seg.card));
    },
    async 'prepare:home-type-broken'() {
      await page.goto(DOCTOR, { waitUntil: 'load', timeout: 90000 });
      await zoomPage(page);
      await page.fill('#urlInput', '');
      await sleep(300);
    },
    async 'home-type-broken'() {
      await page.type('#urlInput', BROKEN_URL, { delay: 28 });
      await sleep(300);
      await page.click('#diagnoseBtn');
    },
    async 'home-scroll'(seg, ms) {
      await page.waitForSelector('#overallBox:not([hidden])', { timeout: 60000 });
      await sleep(900);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await page.evaluate(({ i, steps }) => {
          const z = parseFloat(document.documentElement.style.zoom) || 1;
          const results = document.getElementById('results');
          const bottom = results ? results.getBoundingClientRect().bottom + window.scrollY : document.documentElement.scrollHeight;
          const max = bottom - window.innerHeight / z + 40;
          window.scrollTo({ top: (Math.max(0, max) * i) / steps, behavior: 'smooth' });
        }, { i, steps });
        await sleep(Math.max(200, (ms * 0.8) / steps));
      }
    },
    async 'home-hints'(seg, ms) {
      const hints = await page.$$('.check-body .hint');
      const targets = [];
      for (const h of hints) {
        const text = await h.evaluate((el) => el.closest('.check').innerText);
        if (/decimal dollar|feePayer/.test(text)) targets.push(h);
      }
      for (const h of targets) {
        await h.evaluate((el) => {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const card = el.closest('.check');
          card.style.transition = 'box-shadow .3s, outline .3s';
          card.style.outline = '4px solid #d29922';
          card.style.boxShadow = '0 0 0 10px rgba(210,153,34,.18)';
        });
        await sleep(Math.max(1200, ms / Math.max(1, targets.length)));
      }
    },
    async 'home-green'() {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(500);
      await page.fill('#urlInput', '');
      await page.type('#urlInput', GREEN_URL, { delay: 22 });
      await page.click('#diagnoseBtn');
      await page.waitForSelector('#overallBox:not([hidden]):not(.fail)', { timeout: 60000 });
      await sleep(1600);
    },
    async 'prepare:terminal-call'() {
      await page.setContent(terminalHtml(terminalLines));
    },
    async 'terminal-call'(seg, ms) {
      for (let i = 0; i < 4; i++) {
        await page.evaluate((i) => document.getElementById(`l${i}`).classList.add('on'), i);
        await sleep(Math.max(500, ms / 4.5));
      }
    },
    async 'terminal-verdict'(seg, ms) {
      const rest = terminalLines.length - 4;
      for (let i = 4; i < terminalLines.length; i++) {
        await page.evaluate((i) => document.getElementById(`l${i}`).classList.add('on'), i);
        await sleep(Math.max(80, (ms * 0.45) / rest));
      }
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.l')) if (/"verdict"/.test(el.textContent)) el.classList.add('hl');
      });
    },
    async 'prepare:trust-stats'() {
      await page.goto(`${DOCTOR}/trust`, { waitUntil: 'load', timeout: 90000 });
      await zoomPage(page);
      await page.waitForFunction(() => /\d/.test(document.getElementById('s-total').textContent), null, { timeout: 60000 }).catch(() => {});
    },
    async 'trust-stats'() {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('.stat')) {
          el.style.transition = 'outline .3s';
          el.style.outline = '3px solid #58a6ff';
        }
      });
    },
    async 'trust-lookup'() {
      await page.fill('#url', '');
      await page.type('#url', LOOKUP_URL, { delay: 22 });
      await page.click('#form button');
      await page.waitForSelector('#result .days', { timeout: 30000 }).catch(() => {});
      await page.evaluate(() => document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'center' }));
    },
  };

  for (const seg of script.segments) {
    const ms = Math.round((durations[seg.id] || 3) * 1000);
    const scene = scenes[seg.scene];
    if (!scene) throw new Error(`unknown scene ${seg.scene}`);
    // Scene changes that load a page happen before the voice starts, so the
    // line is heard over the finished page.
    const loads = seg.scene === 'card';
    let action = null;
    if (scenes[`prepare:${seg.scene}`]) await scenes[`prepare:${seg.scene}`](seg, ms);
    if (loads) {
      await scene(seg, ms);
    } else {
      action = scene(seg, ms);
    }
    await caption(page, seg.text);
    const start = (Date.now() - t0) / 1000;
    timeline.push({ id: seg.id, start, duration: ms / 1000 });
    const minEnd = Date.now() + ms + 450;
    if (action) await action;
    const rest = minEnd - Date.now();
    if (rest > 0) await sleep(rest);
    console.log(`${seg.id}: ${start.toFixed(2)} s`);
  }
  await caption(page, '').catch(() => {});
  await sleep(1200);
  const total = (Date.now() - t0) / 1000;

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();
  fs.renameSync(videoPath, path.join(OUT, 'screen.webm'));
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ total, segments: timeline }, null, 2));
  fs.writeFileSync(path.join(OUT, 'preflight.json'), JSON.stringify(pf, null, 2));
  console.log(`recorded ${total.toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
