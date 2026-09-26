// After the deploy: a bare /v1/token should answer 402 (was 400); bad input still 400.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 30; i++) {
  const r = await fetch("https://presign-guard.onrender.com/v1/token");
  console.log(new Date().toISOString().slice(11, 19), "bare:", r.status);
  if (r.status === 402) break;
  await sleep(15000);
}
const bad = await fetch("https://presign-guard.onrender.com/v1/token?chain=base&address=test");
console.log("chain=base&address=test:", bad.status);
