const test = require('node:test');
const assert = require('node:assert/strict');
const { describeHops, proxyHops } = require('../lib/proxy-hops');

test('proxy hops: describes the header shape, never an address', () => {
  const req = {
    ip: '10.1.2.3',
    headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.9, 10.1.2.3', 'cf-connecting-ip': '203.0.113.7', 'true-client-ip': '203.0.113.7' },
  };
  const line = describeHops(req);
  assert.equal(line, 'proxy hops: xff=3 req.ip=xff[2] req.ip-private=true cf-connecting-ip=xff[0] true-client-ip=xff[0]');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(line));
});

test('proxy hops: logs only the first requests', () => {
  const lines = [];
  const mw = proxyHops({ limit: 2, log: { log: (l) => lines.push(l) } });
  const req = { ip: '::ffff:93.184.216.34', headers: { 'x-forwarded-for': '93.184.216.34' } };
  for (let i = 0; i < 5; i++) mw(req, {}, () => {});
  assert.deepEqual(lines, ['proxy hops: xff=1 req.ip=xff[0] req.ip-private=false', 'proxy hops: xff=1 req.ip=xff[0] req.ip-private=false']);
});
