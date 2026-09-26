// presign-guard /health: does PG1 accept PG1_API_KEY? Only the status is shown, never the key. Retries ~5 min.
for (let i = 0; i < 12; i++) {
  const r = await fetch('https://presign-guard.onrender.com/health', { signal: AbortSignal.timeout(60000) }).catch((e) => null);
  const j = r ? await r.json().catch(() => null) : null;
  console.log(`round ${i}: HTTP ${r?.status} ${JSON.stringify(j)}`);
  if (j && j.pg1Key && !['checking', 'unset'].includes(j.pg1Key)) break;
  await new Promise((s) => setTimeout(s, 25000));
}
