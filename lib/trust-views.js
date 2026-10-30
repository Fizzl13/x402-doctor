// The Trust Index as small precomputed files, written after the daily scan (scripts/trust-views.js), so the Doctor
// reads only what a request needs (lib/trust-reader.js) instead of holding all ~70,000 resources in memory:
//   views/meta.json            updated, days, the summary (as lib/trust-index.js summary() builds it), network keys
//   views/atlas.json           the star map (atlas())
//   views/templates.json       the resources with a path parameter, per origin (lookup() of /wallet/0xabc…)
//   views/sellers.json         per origin: how many resources, how many payable now, how reliable (seller())
//   views/similar/…            the price check's word index (similar()): meta.json (count, sellers), words/<00..ff>.json
//                              (per word: [entry, words, seller] in entry order), entries/<n>.json (500 entries a page)
//   views/networks/<key>.json  one network view per family or id that has endpoints (byNetwork()); one larger than
//                              VIEW_PART_CHARS without its resources, which follow in <key>.part<n>.json (meta.json
//                              network_parts says how many), so no file nears GitHub's 100 MB limit (Base's view was
//                              22 MB on 25 Oct 2026)
//   views/seller-endpoints/<00..ff>.json  per seller (site): its endpoints with their verdicts, at most 200, in 256
//                              buckets by a hash of the site (sellerEndpoints(), the atlas card)
//   keys/<00..ff>.json         the resources, in 256 buckets by a hash of their key (lookup()); by key, not host,
//                              because one seller can hold 40% of the index (28,175 resources on 20 Oct)
// Every view comes from the same code as the full index, so the answers are the same.

'use strict';

const crypto = require('node:crypto');
const { createTrustIndex, templatesOf, sellerIn, buildWordIndex } = require('./trust-index');

const BUCKETS = 256;
const SIMILAR_PAGE = 500;
const VIEW_PART_CHARS = 16_000_000;
// The bucket of a resource key (keyOf: origin + path) or of a word.
const bucketOf = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 2);
// A network key as a file name: "xrpl:0" -> "xrpl_3a0".
const fileOfNetwork = (key) => String(key).replace(/[^a-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);
const originOf = (key) => {
  try { return new URL(key).origin; } catch { return null; }
};
const hexOf = (i) => i.toString(16).padStart(2, '0');

// files: Map of path -> JSON value. index, categories and submitted are the objects the scan wrote.
async function buildViews({ index, categories = null, submitted = null, viewPartChars = VIEW_PART_CHARS }) {
  const serve = { 'mem:index': index, 'mem:categories': categories, 'mem:submitted': submitted };
  const fetchImpl = async (u) => (serve[u] ? { ok: true, status: 200, headers: new Headers(), json: async () => serve[u] } : { ok: false, status: 404 });
  const ti = createTrustIndex({ url: 'mem:index', categoriesUrl: 'mem:categories', submittedUrl: 'mem:submitted', fetchImpl });
  await ti.refresh();
  if (!ti.updated()) throw new Error('the index did not load');

  const files = new Map();
  const networks = [];
  const networkParts = {};
  for (const key of ti.networkKeys()) {
    const view = await ti.byNetwork(key);
    if (!view || !view.endpoints) continue;
    const parts = partsOf(view.resources, viewPartChars);
    if (parts.length > 1) {
      const { resources, ...head } = view;
      files.set(`views/networks/${fileOfNetwork(key)}.json`, head);
      parts.forEach((part, i) => files.set(`views/networks/${fileOfNetwork(key)}.part${i}.json`, part));
      networkParts[key] = parts.length;
    } else files.set(`views/networks/${fileOfNetwork(key)}.json`, view);
    networks.push(key);
  }
  files.set('views/meta.json', { version: 1, updated: index.updated, days: index.days, summary: ti.summary(), networks: networks.sort(), network_parts: networkParts });
  files.set('views/atlas.json', ti.atlas());
  files.set('views/templates.json', Object.fromEntries([...templatesOf(index.resources)].map(([origin, list]) => [origin, list])));

  const byOrigin = new Map();
  const buckets = Array.from({ length: BUCKETS }, () => ({}));
  for (const [key, entry] of Object.entries(index.resources || {})) {
    const origin = originOf(key);
    if (!origin) continue;
    if (!byOrigin.has(origin)) byOrigin.set(origin, {});
    byOrigin.get(origin)[key] = entry;
    buckets[parseInt(bucketOf(key), 16)][key] = entry;
  }
  files.set('views/sellers.json', Object.fromEntries([...byOrigin].map(([origin, resources]) => [origin, sellerIn(resources, origin)])));
  // Every bucket is written, empty ones too: a missing bucket means the views are missing, not an unknown resource.
  buckets.forEach((resources, i) => files.set(`keys/${hexOf(i)}.json`, { resources }));

  const sellerBuckets = Array.from({ length: BUCKETS }, () => ({}));
  for (const [site, view] of ti.sellerEndpointsAll()) sellerBuckets[parseInt(bucketOf(site), 16)][site] = view;
  sellerBuckets.forEach((sites, i) => files.set(`views/seller-endpoints/${hexOf(i)}.json`, sites));

  for (const [path, value] of similarFiles(ti.similarEntries())) files.set(path, value);
  return files;
}

// A list cut into pieces of at most maxChars of JSON each (one piece when it fits; an item larger than maxChars on its
// own is a piece of its own).
function partsOf(list, maxChars) {
  const parts = [];
  let part = [];
  let size = 2;
  for (const item of list) {
    const n = JSON.stringify(item).length + 1;
    if (part.length && size + n > maxChars) {
      parts.push(part);
      part = [];
      size = 2;
    }
    part.push(item);
    size += n;
  }
  if (part.length || !parts.length) parts.push(part);
  return parts;
}

// The price check's word index as files: per word its hits in entry order, each with the entry's word count and
// seller, so a query ranks from the word files alone and reads only the pages of the entries it returns.
function similarFiles(entries) {
  const { entries: list, byWord } = buildWordIndex(entries);
  const sites = [...new Set(list.map((e) => e.site))];
  const siteIndex = new Map(sites.map((s, i) => [s, i]));
  const files = new Map();
  files.set('views/similar/meta.json', { n: list.length, page: SIMILAR_PAGE, sites });
  const words = Array.from({ length: BUCKETS }, () => ({}));
  for (const [word, hits] of byWord) words[parseInt(bucketOf(word), 16)][word] = hits.map((i) => [i, list[i].words, siteIndex.get(list[i].site)]);
  words.forEach((w, i) => files.set(`views/similar/words/${hexOf(i)}.json`, w));
  for (let i = 0; i * SIMILAR_PAGE < list.length || i === 0; i++) {
    files.set(`views/similar/entries/${i}.json`, list.slice(i * SIMILAR_PAGE, (i + 1) * SIMILAR_PAGE).map((e) => [e.url, e.host, e.description, e.price]));
  }
  return files;
}

module.exports = { buildViews, bucketOf, fileOfNetwork, partsOf, BUCKETS, VIEW_PART_CHARS };
