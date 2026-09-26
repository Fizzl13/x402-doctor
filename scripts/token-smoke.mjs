// nohumans.directory: how to claim a listing (read-only).
const txt = await (await fetch("https://api.nohumans.directory/llms.txt")).text();
const hits = [];
let i = -1;
while ((i = txt.toLowerCase().indexOf("claim", i + 1)) !== -1) hits.push(i);
console.log(`"claim" occurs ${hits.length} times`);
// Print each distinct section heading that mentions claiming, with its body.
const sections = txt.split(/\n(?=#{2,3} )/);
for (const s of sections) if (/claim/i.test(s.split("\n")[0]) || /claim_token|\/claim|well-known\/nohumans|dns|verification token/i.test(s)) console.log(`\n=====\n${s.slice(0, 3000)}`);
const api = await (await fetch("https://api.nohumans.directory/openapi.json")).json();
for (const [p, ops] of Object.entries(api.paths)) if (/claim|owner|verify/i.test(p)) console.log(`\nPATH ${p}: ${JSON.stringify(ops).slice(0, 1500)}`);
console.log("\nsecuritySchemes:", JSON.stringify(api.components?.securitySchemes || {}).slice(0, 1500));
