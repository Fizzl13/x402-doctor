// "Payable" badges for x402 sellers: a small SVG with the track record from the daily x402 Trust
// Index, for a README or a website, linking to the record on /trust. One resource
// (https://api.example.com/paid) or a whole origin (https://api.example.com: all its scanned
// endpoints together).

const COLORS = { green: '#2ea043', yellow: '#d29922', red: '#cf222e', grey: '#6e7781' };

// Roughly how wide Verdana 11px text is, so the badge fits its words without measuring.
function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[ilj.,:;|!' ]/.test(ch) ? 3.6 : /[mwMW@%]/.test(ch) ? 9.5 : /[A-Z0-9]/.test(ch) ? 7.4 : 6.4;
  return Math.ceil(w);
}
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderBadge({ label = 'x402', message, color }) {
  const lw = textWidth(label) + 12, mw = textWidth(message) + 12, w = lw + mw;
  const fill = COLORS[color] || COLORS.grey;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${xml(label)}: ${xml(message)}"><title>${xml(label)}: ${xml(message)}</title>`
    + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
    + `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#0b2a24"/><rect x="${lw}" width="${mw}" height="20" fill="${fill}"/><rect width="${w}" height="20" fill="url(#s)"/></g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`
    + `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${xml(label)}</text><text x="${lw / 2}" y="14" fill="#61f5c3">${xml(label)}</text>`
    + `<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${xml(message)}</text><text x="${lw + mw / 2}" y="14">${xml(message)}</text></g></svg>`;
}

// What the badge says, from a resource's track record or an origin's summary.
function badgeFor({ record = null, seller = null }) {
  if (record) {
    const today = record.last === 'g' || record.last === 'c';
    if (!today) return { message: 'not payable today', color: 'red' };
    const ratio = record.payable_ratio;
    return { message: `payable ${record.days_payable}/${record.days_checked} days`, color: ratio >= 0.9 ? 'green' : ratio >= 0.5 ? 'yellow' : 'red' };
  }
  if (seller && seller.resources > 0) {
    const pct = Math.round(seller.avg_payable_ratio * 100);
    const n = seller.resources;
    if (seller.payable_now === 0) return { message: `${n} endpoint${n === 1 ? '' : 's'} · none payable today`, color: 'red' };
    return { message: `${n} endpoint${n === 1 ? '' : 's'} · ${pct}% payable`, color: pct >= 90 && seller.payable_now === n ? 'green' : pct >= 50 ? 'yellow' : 'red' };
  }
  return { message: 'not scanned yet', color: 'grey' };
}

module.exports = { renderBadge, badgeFor, textWidth };
