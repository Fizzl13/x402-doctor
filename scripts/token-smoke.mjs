// EntRoute capability ids that fit our services.
const all = await (await fetch('https://api.entroute.com/capabilities?with_endpoints=true', { headers: { accept: 'application/json' } })).json();
const list = Array.isArray(all) ? all : all.capabilities || all.items || [];
console.log('total capabilities', list.length, 'keys', Object.keys(list[0] || {}).join(','));
for (const c of list) console.log(`${c.id || c.capability_id} | ${c.category || ''} | ${(c.description || c.name || '').slice(0, 90)} | endpoints ${c.endpoint_count ?? c.endpoints ?? ''}`);
