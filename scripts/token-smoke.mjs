// Live check: the re-recorded Ichimoku explainer is served (4,559,997 bytes).
const url = "https://ichimoku-signal.onrender.com/media/explainer.mp4";
for (let i = 0; i < 30; i++) {
  const r = await fetch(url, { method: "HEAD" }).catch(() => null);
  const len = r?.headers.get("content-length");
  console.log(new Date().toISOString(), r?.status, len);
  if (len === "4559997") { console.log("OK new video live"); process.exit(0); }
  await new Promise((s) => setTimeout(s, 20000));
}
console.log("still old video");
