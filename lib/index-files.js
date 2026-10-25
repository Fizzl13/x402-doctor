// The Trust Index as files that stay small however large it grows. GitHub refuses a file over 100 MB in a push, and
// index.json was 42 MB on 25 Oct 2026 (88,554 resources, after the endpoints scanned a day had tripled in a month), so
// the scan publishes it in parts on the trust-data branch:
//   index/meta.json     everything but the resources (version, updated, days, sanctions), with count and parts
//   index/<nn>.ndjson   one [key, resource] per line, each part at most PART_BYTES
// index.json and index.ndjson, the single files from before, are still written while they stay under COMPAT_MAX_BYTES,
// for readers outside this repository; past that they are left out. The readers here take the parts (readIndexDir,
// readIndexFile, loadIndex) and fall back to index.json while a branch has no parts yet.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PART_BYTES = 24 * 1024 * 1024;
const COMPAT_MAX_BYTES = 90 * 1024 * 1024;
const BASE_URL = 'https://raw.githubusercontent.com/Fizzl13/x402-doctor/trust-data/';
const WRITE_CHUNK = 1024 * 1024;

const partName = (i) => `${String(i).padStart(2, '0')}.ndjson`;

// Lines appended to a file in chunks of about WRITE_CHUNK.
function lineWriter(file) {
  const fd = fs.openSync(file, 'w');
  let pending = [];
  let size = 0;
  const flush = () => {
    if (pending.length) fs.writeSync(fd, pending.join(''));
    pending = [];
    size = 0;
  };
  return {
    write(text) {
      pending.push(text);
      size += text.length;
      if (size >= WRITE_CHUNK) flush();
    },
    close() {
      flush();
      fs.closeSync(fd);
    },
  };
}

// Writes <dir>/index/ (meta.json and the parts), and <dir>/index.json and index.ndjson while they fit (else removes
// them). Returns { count, parts, bytes, single } (single: the single files were written).
function writeIndexDir(dir, index, { partBytes = PART_BYTES, compatMaxBytes = COMPAT_MAX_BYTES } = {}) {
  const { resources = {}, ...head } = index;
  const partsDir = path.join(dir, 'index');
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.mkdirSync(partsDir, { recursive: true });
  const headLine = `${JSON.stringify(head)}\n`;
  const ndjsonFile = path.join(dir, 'index.ndjson');
  const ndjson = lineWriter(ndjsonFile);
  ndjson.write(headLine);
  const parts = [];
  let part = null;
  let partSize = 0;
  let count = 0;
  let bytes = 0;
  for (const [key, resource] of Object.entries(resources)) {
    const line = `${JSON.stringify([key, resource])}\n`;
    const n = Buffer.byteLength(line);
    if (!part || (partSize > 0 && partSize + n > partBytes)) {
      if (part) part.close();
      parts.push(partName(parts.length));
      part = lineWriter(path.join(partsDir, parts[parts.length - 1]));
      partSize = 0;
    }
    part.write(line);
    ndjson.write(line);
    partSize += n;
    bytes += n;
    count++;
  }
  if (part) part.close();
  ndjson.close();
  fs.writeFileSync(path.join(partsDir, 'meta.json'), JSON.stringify({ ...head, count, parts }));
  const single = bytes + Buffer.byteLength(headLine) < compatMaxBytes;
  if (single) fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  else {
    fs.rmSync(ndjsonFile, { force: true });
    fs.rmSync(path.join(dir, 'index.json'), { force: true });
  }
  return { count, parts, bytes, single };
}

// A part's line added to resources.
const adder = (resources) => (line) => {
  if (!line.trim()) return;
  const [key, resource] = JSON.parse(line);
  resources[key] = resource;
};

// The index from <dir>/index/ (the parts), else from <dir>/index.json; null when neither is there.
function readIndexDir(dir) {
  const metaFile = path.join(dir, 'index', 'meta.json');
  if (fs.existsSync(metaFile)) {
    const { count, parts, ...head } = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const resources = {};
    const add = adder(resources);
    for (const part of parts || []) fs.readFileSync(path.join(dir, 'index', part), 'utf8').split('\n').forEach(add);
    return { ...head, resources };
  }
  const file = path.join(dir, 'index.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// A script's --index path (trust-data/index.json): the parts beside it when they are there, else the file itself.
function readIndexFile(file) {
  if (fs.existsSync(path.join(path.dirname(file), 'index', 'meta.json'))) return readIndexDir(path.dirname(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Calls take(line) for every line of a response body as it arrives, so a part is never one string in memory. Only
// the new text is searched for line ends: a single line of 32 MB (index.json) is joined once, at the end.
async function eachLine(res, take) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    for (const line of (await res.text()).split('\n')) take(line);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    let start = 0;
    let end;
    while ((end = text.indexOf('\n', start)) >= 0) {
      take(rest + text.slice(start, end));
      rest = '';
      start = end + 1;
    }
    rest += text.slice(start);
  }
  take(rest + decoder.decode());
}

// The index from a parsed meta.json and its parts at baseUrl (the folder of meta.json), one part after the other.
async function readIndexParts(meta, { baseUrl, fetchImpl = fetch, timeoutMs = 60000 }) {
  const { count, parts, ...head } = meta;
  const resources = {};
  const add = adder(resources);
  for (const part of parts || []) {
    const res = await fetchImpl(new URL(part, baseUrl).href, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`trust index part ${part} HTTP ${res.status}`);
    await eachLine(res, add);
  }
  return { ...head, resources };
}

// The index for a report script: a local --index path, an explicit URL (one JSON file, as before), or the published
// index (the parts, else index.json from before them).
async function loadIndex(source, { fetchImpl = fetch, base = BASE_URL, timeoutMs = 60000 } = {}) {
  if (source && !/^https?:/.test(source)) return readIndexFile(source);
  if (!source) {
    const metaUrl = new URL('index/meta.json', base).href;
    const meta = await fetchImpl(metaUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (meta.ok) return readIndexParts(await meta.json(), { baseUrl: metaUrl, fetchImpl, timeoutMs });
    if (meta.status !== 404) throw new Error(`trust index HTTP ${meta.status}`);
  }
  const res = await fetchImpl(source || new URL('index.json', base).href, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`trust index HTTP ${res.status}`);
  return res.json();
}

module.exports = { writeIndexDir, readIndexDir, readIndexFile, readIndexParts, loadIndex, eachLine, PART_BYTES, COMPAT_MAX_BYTES, BASE_URL };
