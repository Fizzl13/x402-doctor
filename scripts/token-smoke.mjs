// Read-only: free quick verdicts after the Token ACL deploy (no payment).
const B = 'https://presign-guard.fizzl.eu';
for (const [chain, a] of [['solana', 'Gy3Z9BuZAXHgtcXTyViwPu1dSvps82G3PSBaCRbFSRgz'], ['solana', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'], ['solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']]) {
  const t = Date.now();
  const r = await fetch(`${B}/v1/token/quick?chain=${chain}&address=${a}`, { signal: AbortSignal.timeout(30000) });
  console.log('PG', a.slice(0, 6), r.status, Date.now() - t, 'ms', (await r.text()).slice(0, 200));
}
const h = await (await fetch(B + '/health').catch(() => null))?.text?.();
console.log('PG health', (h || '').slice(0, 200));
