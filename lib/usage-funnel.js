// Ichimoku's free /setups/preview → paid /setups funnel, from the usage log.
// Visitors are the log's visitor codes (a keyed hash of the IP), so a person
// who reads the preview in a browser and then pays from an agent on another
// machine counts as two visitors: "paid without a preview" catches those.

'use strict';

const WINDOW_MS = 24 * 3600 * 1000;
const isPreview = (e) => e.service === 'ichimoku' && e.route === 'setups_preview' && !e.quote && e.status < 400;
const isSetups = (e) => e.service === 'ichimoku' && (e.route === 'setups' || e.route === 'trade_setups');

function setupsFunnel(events, { windowMs = WINDOW_MS } = {}) {
  const previews = new Map(); // visitor -> preview times (ms)
  let previewCalls = 0;
  const web = new Set();
  for (const e of events) {
    if (!isPreview(e)) continue;
    previewCalls++;
    if (!e.visitor) continue;
    if (!previews.has(e.visitor)) previews.set(e.visitor, []);
    previews.get(e.visitor).push(Date.parse(e.t));
    if (e.via === 'web') web.add(e.visitor);
  }
  // A /setups event follows a preview when the same visitor previewed in the window before it.
  const follows = (e) => {
    const times = e.visitor && previews.get(e.visitor);
    const at = Date.parse(e.t);
    return Boolean(times) && times.some((p) => p <= at && at - p <= windowMs);
  };
  const sawPrice = new Set();
  const paidAfter = new Set();
  let revenueAfter = 0;
  let paidWithout = 0;
  let revenueWithout = 0;
  for (const e of events) {
    if (!isSetups(e)) continue;
    const after = follows(e);
    if (e.quote && after) sawPrice.add(e.visitor);
    if (!e.paid) continue;
    if (after) {
      paidAfter.add(e.visitor);
      revenueAfter += Number(e.usd) || 0;
    } else {
      paidWithout++;
      revenueWithout += Number(e.usd) || 0;
    }
  }
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return {
    window_hours: windowMs / 3600000,
    preview_calls: previewCalls,
    preview_visitors: previews.size,
    preview_visitors_web: web.size,
    saw_price: sawPrice.size,
    paid: paidAfter.size,
    revenue_after_preview: round(revenueAfter),
    paid_calls_without_preview: paidWithout,
    revenue_without_preview: round(revenueWithout),
  };
}

module.exports = { setupsFunnel };
