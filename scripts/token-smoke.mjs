// Read-only: are the older project demos up? Status, time, title, and a text sample.
for (const u of ['https://ai-customerserviceemailapp.onrender.com', 'https://fizzl-digital-twin.onrender.com', 'https://fizzl-ai-process-agent.onrender.com']) {
  const t = Date.now();
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(90000) });
    const body = await r.text();
    const title = (body.match(/<title>([^<]*)/) || [])[1];
    console.log('DEMO', u, r.status, Date.now() - t, 'ms', 'title=' + title, 'len=' + body.length, '|', body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  } catch (e) { console.log('DEMO', u, 'ERR', e.message, Date.now() - t, 'ms'); }
}
// rerun 18:50:20
