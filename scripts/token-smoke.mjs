// One-off: PlainText live check after #31 / presign-guard #73. Never pays.
const UA = { 'user-agent': 'fizzl-monitor/1.0', 'content-type': 'application/json' };
const approval = { chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', spender: '0x1111111111111111111111111111111111111112', amount: '115792089237316195423570985008687907853269984665640564039457584007913129639935' };
const r = await fetch('https://plaintext.fizzl.eu/api/free/explain', { method: 'POST', headers: UA, body: JSON.stringify({ data: approval }) });
const b = await r.json();
console.log('EXPLAIN', r.status, b.source, b.verdict, 'receipt=' + !!b.receipt, 'USDC=' + /USDC/.test(b.explanation || ''), 'left=' + b.free_left);
console.log('TEXT', b.explanation);
const w = await (await fetch('https://plaintext.fizzl.eu/api/free/check-wallet', { method: 'POST', headers: UA, body: JSON.stringify({ address: '0x1111111254eeb25477b68fb85ed929f73a960582', chain: 'base' }) })).json();
console.log('WALLET', w.source, w.verdict, 'reasons=' + JSON.stringify((w.reasons || []).map((x) => x.code)), 'receipt=' + !!w.receipt);
const page = await (await fetch('https://plaintext.fizzl.eu/', { headers: UA })).text();
console.log('PAGE findings', page.includes('renderFindings'), '| checked-by', page.includes('checked-by'));
