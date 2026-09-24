// What runs an x402 endpoint, from the response headers the diagnosis saw
// (report.probes) and the shape of its challenge. Used to pick the code a fix
// shows. Only claims what the headers show; everything else is "node" (an
// @x402 TypeScript SDK behind an unknown framework) or "generic".

const STACKS = {
  express: { name: 'Express (@x402/express)', family: 'node' },
  next: { name: 'Next.js (@x402/next)', family: 'node' },
  hono: { name: 'Hono (@x402/hono)', family: 'node' },
  node: { name: 'Node.js with an @x402 SDK', family: 'node' },
  python: { name: 'Python', family: 'generic' },
  generic: { name: 'Any server (raw HTTP)', family: 'generic' },
};

function detectStack(report, override) {
  if (override && STACKS[override]) return { id: override, ...STACKS[override], detected_from: 'you (stack parameter)' };

  const probes = report.probes || [];
  const main = probes.find((p) => p.status === 402) || probes[probes.length - 1] || { headers: {} };
  const h = main.headers || {};
  const powered = h['x-powered-by'] || '';
  const server = h.server || '';
  const pick = (id, from) => ({ id, ...STACKS[id], detected_from: from });

  // x-matched-path is set for every Vercel function, so it does not mean Next.js.
  if (/next\.js/i.test(powered) || h['x-nextjs-cache']) return pick('next', powered ? `x-powered-by: ${powered}` : 'x-nextjs-cache header');
  if (/express/i.test(powered)) return pick('express', `x-powered-by: ${powered}`);
  if (/hono/i.test(powered)) return pick('hono', `x-powered-by: ${powered}`);
  if (/uvicorn|hypercorn|gunicorn|werkzeug|daphne/i.test(server)) return pick('python', `server: ${server}`);
  // A v2 challenge in the PAYMENT-REQUIRED header is what the @x402 TypeScript SDKs send.
  if (report.challenge && report.challenge.x402Version === 2) {
    const host = h['x-vercel-id'] ? 'Vercel' : h['x-render-origin-server'] ? 'Render' : h['cf-ray'] ? 'Cloudflare' : null;
    return pick('node', host ? `x402 v2 challenge, hosted on ${host}` : 'x402 v2 challenge');
  }
  if (h['x-vercel-id']) return pick('node', 'Vercel function (x-vercel-id)');
  return pick('generic', 'no framework headers');
}

module.exports = { detectStack, STACKS };
