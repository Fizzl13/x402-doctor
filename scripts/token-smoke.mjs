// Does the live projects background video have a sound track? (read-only GET)
for (const u of ["https://projects.fizzl.eu/projects-bg-landscape.mp4", "https://ai.fizzl.eu/bg-video.mp4"]) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
    const b = Buffer.from(await r.arrayBuffer());
    const handlers = []; let i = -1;
    while ((i = b.indexOf("hdlr", i + 1)) !== -1) handlers.push(b.subarray(i + 12, i + 16).toString("latin1"));
    console.log("SND", u, r.status, b.length, "bytes, handlers:", handlers.join(","));
  } catch (e) { console.log("SND", u, "ERR", e.message); }
}
