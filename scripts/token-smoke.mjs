// One-off: fetch one full PlainText free-explain result (for a screenshot). Never pays.
const approval = { chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x1111111111111111111111111111111111111112', amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935' };
const r = await fetch('https://plaintext.fizzl.eu/api/free/explain', { method: 'POST', headers: { 'user-agent': 'fizzl-monitor/1.0', 'content-type': 'application/json' }, body: JSON.stringify({ data: approval }) });
const b = await r.json();
delete b.receipt;
console.log('RESULT', r.status, JSON.stringify(b));
