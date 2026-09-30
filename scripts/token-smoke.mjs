// One-off check: how x402-trust.com grades the fizzl endpoints (read-only). Output is data only.
const res = await fetch('https://x402-trust.com/search?q=fizzl.eu', { headers: { accept: 'text/html,application/json' } });
const html = await res.text();
console.log('status', res.status, 'len', html.length);
const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
console.log(text.slice(0, 4000));
const links = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => /fizzl|endpoint|service|provider/i.test(h));
console.log('links', [...new Set(links)].slice(0, 40).join(' '));
