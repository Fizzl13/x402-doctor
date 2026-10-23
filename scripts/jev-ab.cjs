// Temporary: Jev's brand answers for the live namesake cases (not for merging).
const { createBrandCheck } = require('../lib/namesakes');
const cases = require('./inj/ns-cases.json');
(async () => {
  const b = await createBrandCheck().brands(cases);
  const rows = cases.map((c) => [b[c.name] ?? -1, c.label, c.original.sites.join(','), c.original.payers, c.namesakes.map((n) => `${n.sites.join(',')}(${n.payers})`).join(' ')]).sort((x, y) => y[0] - x[0]);
  for (const r of rows) console.log('BRAND ' + JSON.stringify(r));
})();
