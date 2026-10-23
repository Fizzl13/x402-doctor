// Sellers that just failed the inkoper: it paid them and got no usable answer (an HTTP error, an empty answer, or one
// the answer check said wasn't what was paid for), or the payment itself broke off. For HOLD_MS they go to the back
// of the candidates, so the next agent doesn't pay for the same failure; the pick shows it too. In memory: a restart
// forgets them, which costs at most one more failed try per seller.
'use strict';

const HOLD_MS = 6 * 60 * 60 * 1000;

function createStrikes({ holdMs = HOLD_MS, now = () => Date.now() } = {}) {
  const until = new Map(); // host -> time the strike ends
  return {
    add(host) { if (host) until.set(host, now() + holdMs); },
    has(host) {
      const t = until.get(host);
      if (t === undefined) return false;
      if (t > now()) return true;
      until.delete(host);
      return false;
    },
  };
}

module.exports = { createStrikes, HOLD_MS };
