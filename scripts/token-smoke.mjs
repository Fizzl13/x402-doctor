// Read presign-guard's agent registration once more (read-only).
const r = await fetch("https://presign-guard.fizzl.eu/.well-known/agent-registration.json", { headers: { "user-agent": "fizzl-registration-log-check/1.0" }, signal: AbortSignal.timeout(60000) });
console.log("REG presign", r.status, new Date().toISOString());
