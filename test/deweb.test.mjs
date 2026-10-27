// The X Layer DeWEB site (scripts/deweb-site.mjs) and how it is cut up for SiteRegistry (scripts/deweb-xlayer.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPage, compact } from '../scripts/deweb-site.mjs';
import { siteFiles, siteName, gatewayUrl, NETLIST, CHUNK } from '../scripts/deweb-xlayer.mjs';

const DATA = {
  network: 'eip155:196', updated: '2026-10-27T02:26:08.840Z', days: ['2026-10-26', '2026-10-27'],
  endpoints: 2, payable_now: 2, services: 2,
  categories: [{ id: 'crypto', name: 'Crypto prices & trading', services: 2 }],
  sellers: [{ host: 'allium.so', endpoints: 2, payable: 2, services: 2 }],
  resources: [
    { url: 'https://agents.allium.so/api/v1/prices', category: 'crypto', price_usd: 0.02, verdict: 'go', networks: ['eip155:196'] },
    { url: 'https://agents.allium.so/api/v1/<script>', category: 'crypto', price_usd: 0.01, verdict: 'no_go', networks: ['eip155:196'] },
  ],
};

test('the page is self-contained: no external scripts, styles, fonts or images', () => {
  const html = buildPage(DATA);
  assert.doesNotMatch(html, /\bsrc=["']?https?:/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /url\(|@import/i);
  assert.match(html, /2 x402 endpoints in the/);
  assert.match(html, /TAPEOUT_CIRCUIT_LOCKED_FOREVER/);
  // Data from the catalog can't close the script it is embedded in.
  assert.ok(!html.includes('/api/v1/<script>'));
  assert.deepEqual(compact(DATA).rows[0], ['https://agents.allium.so/api/v1/prices', 0.02, 'go', 'crypto']);
});

test('files are cut into 24,000-byte chunks with the SHA-256 of the whole file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deweb-'));
  const big = Buffer.alloc(CHUNK * 2 + 5, 7);
  fs.writeFileSync(path.join(dir, 'data.json'), big);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>hi</p>');
  const files = siteFiles(dir);
  assert.deepEqual(files.map((f) => f.path), ['index.html', 'data.json']);
  assert.equal(files[0].contentType, 'text/html; charset=utf-8');
  assert.equal(files[1].chunks.length, 3);
  assert.equal((files[1].chunks[2].length - 2) / 2, 5);
  assert.equal(files[1].sha256, `0x${crypto.createHash('sha256').update(big).digest('hex')}`);
});

test('the on-chain name and gateway URL, and the one-NAND netlist', () => {
  assert.equal(siteName(1, 396), '1.2.396.tape');
  assert.equal(gatewayUrl(1, 396), 'https://1-2-396.tapekit.org');
  // op 0x00 (NAND), a = signal 2, b = signal 3 (the two inputs), each a big-endian u24.
  assert.equal(NETLIST, '0x00000002000003');
});
