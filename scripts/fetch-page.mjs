// One-off: is the presign-guard token-check wording live on Render?
for (const [url, needle] of [['https://presign-guard.onrender.com/openapi.json', 'honeypot, impersonation'], ['https://presign-guard.onrender.com/', 'honeypots, fake look-alikes']]) {
  let found = false;
  for (let i = 0; i < 3 && !found; i++) {
    const text = await (await fetch(url)).text().catch(() => '');
    found = text.includes(needle);
    if (!found) await new Promise((r) => setTimeout(r, 30000));
  }
  console.log(`${found ? 'LIVE    ' : 'MISSING '} ${url}`);
}
