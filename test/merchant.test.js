const test = require('node:test');
const assert = require('node:assert/strict');
const { builderCodeExtension } = require('../lib/merchant');

test('builder code: declared from BUILDER_CODE, left out when unset or not a valid code', (t) => {
  assert.deepEqual(builderCodeExtension(' fizzl ')['builder-code'].info, { a: 'fizzl' });
  assert.deepEqual(builderCodeExtension(undefined), {});
  assert.deepEqual(builderCodeExtension('  '), {});
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(builderCodeExtension('Fizzl-EU'), {});
  assert.match(warn.mock.calls[0].arguments[0], /not a valid builder code/);
});
