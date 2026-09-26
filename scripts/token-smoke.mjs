// Wait for the deploy with pg1Key on /health, then report the status (never the key).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  const r = await fetch("https://presign-guard.onrender.com/health").then((x) => x.json()).catch(() => null);
  const k = r?.pg1Key;
  console.log(new Date().toISOString().slice(11, 19), JSON.stringify(r));
  if (k && k !== "checking") break;
  await sleep(15000);
}
