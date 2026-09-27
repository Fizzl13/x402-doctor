// Live check of the Doctor web page fix (empty box, glued-paste guard). Free.
for (let round = 0; round < 16; round++) {
  const html = await fetch("https://x402-doctor.onrender.com/").then((r) => r.text()).catch(() => "");
  const live = html.includes('id="exampleLink"');
  console.log(`round ${round}: new page ${live}`);
  if (live) {
    console.log("pre-filled value:", /id="urlInput"[^>]*\svalue=/.test(html));
    const r = await fetch("https://x402-doctor.onrender.com/api/diagnose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://smartcontractexplainhttps://pg1-ai-agent.vercel.app/api/mcp" }) });
    console.log("glued:", r.status, JSON.stringify(await r.json()));
    break;
  }
  await new Promise((r) => setTimeout(r, 30000));
}
