// The files the REPL wrote this session, and for whom, so close and stop can say which are still
// there to clean up. Kept in memory only, and nothing is removed.
const fs = require('fs');
const path = require('path');
const { state, onShutdownEnd } = require('./state');
const out = require('./output');
const { FILES_LEFT } = require('./util');

/** @type {Map<string, { kind: string, client: string | null }>} */
const written = new Map();

// kind: what it is, as the summary counts it (screenshot, video, steps file, profile, watch file).
/**
 * @param {string} file
 * @param {string} kind
 * @param {string | null} [client]
 */
function noteWritten(file, kind, client = state.client) {
  written.set(path.resolve(file), { kind, client: client ?? null });
}

// A file renamed (record off <file>) is still the same one.
/**
 * @param {string} from
 * @param {string} to
 */
function noteMoved(from, to) {
  const entry = written.get(path.resolve(from));
  if (!entry) return;
  written.delete(path.resolve(from));
  written.set(path.resolve(to), entry);
}

// Whether the client wrote this file, as this kind, in this REPL: its own it may replace.
/**
 * @param {string} file
 * @param {string} kind
 */
function wroteIt(file, kind) {
  const entry = written.get(path.resolve(file));
  return !!entry && entry.kind === kind && entry.client === (state.client ?? null);
}

/** @param {string | null | undefined} client */
function remaining(client) {
  /** @type {{ file: string, kind: string, size: number }[]} */
  const files = [];
  for (const [file, entry] of written) {
    if (entry.client !== (client ?? null)) continue;
    try { files.push({ file, kind: entry.kind, size: fs.statSync(file).size }); } catch {}
  }
  return files;
}

/** @param {number} bytes */
function sizeText(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
}

// For close: the client's own files, in full.
/** @param {string | null | undefined} client */
function ownFilesText(client) {
  const files = remaining(client);
  if (!files.length) return null;
  return [`Files you wrote that are still there; remove what is no longer needed:`, ...files.map(f => `  ${f.file} (${sizeText(f.size)})`)].join('\n');
}

const plural = (/** @type {number} */ n, /** @type {string} */ kind) => `${n} ${kind}${n === 1 ? '' : 's'}`;

// For stop: one line for each client that left files, each with what and where.
function summaryLines() {
  const clients = [...new Set([...written.values()].map(e => e.client))];
  const lines = [];
  for (const client of clients) {
    const files = remaining(client);
    if (!files.length) continue;
    const kinds = new Map();
    for (const f of files) kinds.set(f.kind, (kinds.get(f.kind) || 0) + 1);
    const folders = [...new Set(files.map(f => `${path.dirname(f.file)}/`))];
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    const who = client ? `by ${client}` : 'without a client name';
    lines.push(`${FILES_LEFT} ${who}: ${plural(files.length, 'file')}, ${sizeText(bytes)} (${[...kinds].map(([k, n]) => plural(n, k)).join(', ')}) in ${folders.join(' and ')}`);
  }
  return lines;
}

// After every recording has been saved, so its file is whole.
onShutdownEnd(() => { for (const line of summaryLines()) out.log(line); });

module.exports = { noteWritten, noteMoved, wroteIt, ownFilesText, summaryLines };
