// Submit our endpoints to EntRoute (contact email given by the owner for this listing).
const base = { contact_email: 'Fizzl13@protonmail.com' };
const subs = [
  { endpoint_url: 'https://x402-doctor.fizzl.eu/api/v1/diagnose', capability_id: 'security.api_health', provider_name: 'x402 Doctor', price_per_call: 0.01 },
  { endpoint_url: 'https://presign-guard.fizzl.eu/v1/token', capability_id: 'crypto.risk_intelligence', provider_name: 'presign-guard', price_per_call: 0.01 },
  { endpoint_url: 'https://presign-guard.fizzl.eu/v1/check', capability_id: 'security.compliance_check', provider_name: 'presign-guard', price_per_call: 0.01 },
  { endpoint_url: 'https://ichimoku-signal.fizzl.eu/setups', capability_id: 'finance.trending', provider_name: 'Ichimoku Signal', price_per_call: 0.5 },
];
for (const s of subs) {
  const r = await fetch('https://api.entroute.com/submit', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ ...base, ...s }) });
  console.log('==', s.endpoint_url, r.status);
  console.log((await r.text()).slice(0, 1500));
}
