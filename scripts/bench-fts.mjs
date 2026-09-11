#!/usr/bin/env node
/**
 * bench-fts.mjs — SQLite FTS5 transcript-search benchmark vs 200ms p95 budget.
 *
 *   node scripts/bench-fts.mjs [dbCopyPath] [--synth N] [--scale] [--iters N] [--cold N] [--keep]
 *
 * Methodology:
 * - NEVER opens the real user DB for writing. Copies it with `cp` to os.tmpdir()
 *   and builds the FTS5 index on the COPY only. Default source:
 *   $CLOUDCHAT_USER_DATA_DIR/cloudchat.sqlite, else ~/.cloudchat/cloudchat.sqlite.
 * - Builds (if absent): VIRTUAL TABLE messages_fts USING fts5(content,
 *   conversation_id UNINDEXED, tokenize='porter'), populated from messages.
 * - Fixed query set (single-term, phrase, prefix, OR, NEAR) x N iterations.
 *   Timings include statement prepare() — conservative vs cached statements.
 * - Cold = fresh connection per sample (OS page cache may still be warm — stated).
 * - 4-reader test = 4 separate DatabaseSync connections, interleaved, single
 *   thread (node:sqlite is synchronous, so this measures connection overhead,
 *   NOT lock contention — stated, not oversold).
 * - Deterministic synthetic corpus (--synth N, mulberry32 seed) when real
 *   corpus is small. --scale runs 10k then 100k back-to-back.
 * - Separately: scans THIS repo's git-tracked files into files_fts and times
 *   scan+index+query (file-content indexing at repo scale is NOT transcript
 *   search — reported on its own lines).
 *
 * Zero dependencies. node:sqlite only (Node 22.5+).
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { statSync, unlinkSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUDGET_P95_MS = 200;
const SEED = 1337;

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opts = { iters: 25, cold: 5, synth: 0, scale: false, keep: false, dbPath: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--synth') opts.synth = parseInt(argv[++i], 10);
  else if (a === '--scale') opts.scale = true;
  else if (a === '--iters') opts.iters = parseInt(argv[++i], 10);
  else if (a === '--cold') opts.cold = parseInt(argv[++i], 10);
  else if (a === '--keep') opts.keep = true;
  else if (a.startsWith('--')) fail(`unknown flag ${a}`);
  else if (!opts.dbPath) opts.dbPath = a;
  else fail(`unexpected positional arg ${a}`);
}
if (!Number.isFinite(opts.iters) || opts.iters < 1) fail('--iters must be >= 1');
if (!Number.isFinite(opts.cold) || opts.cold < 1) fail('--cold must be >= 1');
if (opts.synth !== 0 && (!Number.isFinite(opts.synth) || opts.synth < 1)) fail('--synth N must be >= 1');

function fail(msg) { console.error(`bench-fts: ERROR: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------- utils
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pct(sortedAsc, q) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');

function findUserDb() {
  if (opts.dbPath) {
    if (!existsSync(opts.dbPath)) fail(`dbCopyPath not found: ${opts.dbPath}`);
    return path.resolve(opts.dbPath);
  }
  const cands = [];
  if (process.env.CLOUDCHAT_USER_DATA_DIR) cands.push(path.join(process.env.CLOUDCHAT_USER_DATA_DIR, 'cloudchat.sqlite'));
  if (process.env.HOME) cands.push(path.join(process.env.HOME, '.cloudchat', 'cloudchat.sqlite'));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

// Fixed query set: [label, candidate MATCH strings]. First candidate with
// >0 hits on the corpus wins (deterministic per corpus); reported verbatim.
const QUERY_SET = [
  ['single-term', ['landing', 'python', 'hermes', 'electron', 'test']],
  ['phrase', ['"landing page"', '"error handling"', '"test message"']],
  ['prefix', ['autom*', 'land*', 'test*']],
  ['OR', ['landing OR python OR hermes', 'test OR page OR script']],
  ['NEAR', ['NEAR(landing page, 5)', 'NEAR(error handling, 8)', 'NEAR(test message, 5)']],
];

function resolveQueries(db) {
  return QUERY_SET.map(([label, cands]) => {
    let chosen = cands[0], hits = 0;
    for (const c of cands) {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`).get(c);
        if (r.n > 0) { chosen = c; hits = r.n; break; }
      } catch { /* try next */ }
    }
    return { label, match: chosen, corpusHits: hits };
  });
}

function timeSample(db, match) {
  const t0 = process.hrtime.bigint();
  const rows = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 20`).all(match);
  return { ms: ms(t0), hits: rows.length };
}

function ensureMessagesFts(db) {
  const exists = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='messages_fts'`).get().n > 0;
  if (exists) return { built: false, buildMs: 0 };
  const t0 = process.hrtime.bigint();
  db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(content, conversation_id UNINDEXED, tokenize='porter')`);
  db.exec(`INSERT INTO messages_fts(rowid, content, conversation_id) SELECT rowid, content, conversation_id FROM messages`);
  return { built: true, buildMs: ms(t0) };
}

function indexBytes(db) {
  try {
    const r = db.prepare(`SELECT SUM(pgsize) AS s FROM dbstat WHERE name LIKE 'messages_fts%'`).get();
    if (r.s != null) return r.s;
  } catch { /* dbstat may be unavailable */ }
  return null;
}

function benchMessages(workPath, corpusTag) {
  const beforeBytes = statSync(workPath).size;
  let db = new DatabaseSync(workPath);
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
  if (rows === 0) fail(`zero messages in ${workPath}`);
  const { built, buildMs } = ensureMessagesFts(db);
  const idxBytes = indexBytes(db);
  const afterBytes = statSync(workPath).size;
  const queries = resolveQueries(db);
  db.close();

  // cold: fresh connection per sample
  const cold = queries.map((q) => {
    const samples = [];
    for (let i = 0; i < opts.cold; i++) {
      const c = new DatabaseSync(workPath, { readOnly: true });
      samples.push(timeSample(c, q.match).ms);
      c.close();
    }
    samples.sort((a, b) => a - b);
    return { ...q, coldP50: pct(samples, 0.5), coldMax: Math.max(...samples) };
  });

  // warm: single connection, N iters
  db = new DatabaseSync(workPath, { readOnly: true });
  const warm = queries.map((q) => {
    const samples = [];
    let hits = 0;
    for (let i = 0; i < opts.iters; i++) {
      const s = timeSample(db, q.match);
      samples.push(s.ms); hits = s.hits;
    }
    samples.sort((a, b) => a - b);
    return { ...q, hits, warmP50: pct(samples, 0.5), warmP95: pct(samples, 0.95) };
  });
  db.close();

  // 4 readers: 4 dedicated connections, interleaved round-robin, single thread
  const conns = [0, 1, 2, 3].map(() => new DatabaseSync(workPath, { readOnly: true }));
  const conc = queries.map((q) => {
    const samples = [];
    const per = Math.max(1, Math.floor(opts.iters / 4));
    for (let i = 0; i < per; i++) for (let r = 0; r < 4; r++) samples.push(timeSample(conns[r], q.match).ms);
    samples.sort((a, b) => a - b);
    return { label: q.label, p50: pct(samples, 0.5), p95: pct(samples, 0.95), n: samples.length };
  });
  for (const c of conns) c.close();

  return { corpusTag, rows, fileBytes: afterBytes, indexBytes: idxBytes ?? (afterBytes - beforeBytes), built, buildMs, cold, warm, conc };
}

function printMessagesBench(b) {
  console.log(`\n== corpus: ${b.corpusTag} | rows=${b.rows} | db=${(b.fileBytes / 1024).toFixed(0)}KiB | fts-index~=${(b.indexBytes / 1024).toFixed(0)}KiB | build=${b.built ? `${fmt(b.buildMs)}ms (fresh)` : 'reused existing'} ==`);
  console.log(`query       | MATCH                        | hits   | coldP50  | warmP50 | warmP95 | 4connP95`);
  console.log(`------------+------------------------------+--------+----------+---------+---------+----------`);
  for (let i = 0; i < b.warm.length; i++) {
    const w = b.warm[i], c = b.cold[i], k = b.conc[i];
    console.log(`${w.label.padEnd(11)} | ${w.match.padEnd(28)} | ${String(w.hits).padStart(6)} | ${fmt(c.coldP50).padStart(6)}ms | ${fmt(w.warmP50).padStart(5)}ms | ${fmt(w.warmP95).padStart(5)}ms | ${fmt(k.p95).padStart(6)}ms`);
  }
  const worst = Math.max(...b.warm.map((w) => w.warmP95));
  return worst;
}

// ---------------------------------------------------------------- synth
const VOCAB = ('landing page build modern hero features grid call action python script automate task error handling test ' +
  'message conversation search index electron react component server client deploy hermes running memory store room ' +
  'tool invoke result summary token count timestamp role user assistant model prompt reply thread channel ' +
  'file repo branch commit review agent swarm brain plan gate contract claim pulse session worker queue ' +
  'style theme color font layout button modal nav settings dashboard chart table form input output cache ' +
  'network fetch api route handler middleware auth token secret key vault encrypt decrypt hash sign verify').split(' ');

function buildSynthDb(n, workPath) {
  if (existsSync(workPath)) unlinkSync(workPath);
  const db = new DatabaseSync(workPath);
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, token_count INTEGER)`);
  const rnd = mulberry32(SEED);
  const ins = db.prepare(`INSERT INTO messages (id, conversation_id, role, content, timestamp, token_count) VALUES (?, ?, ?, ?, ?, ?)`);
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const len = 20 + Math.floor(rnd() * 40);
    const words = [];
    for (let w = 0; w < len; w++) words.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
    if (i % 37 === 0) words.splice(3, 0, 'landing', 'page');       // guarantee phrase hits
    if (i % 53 === 0) words.splice(7, 0, 'error', 'handling');     // guarantee phrase hits
    if (i % 11 === 0) words.splice(1, 0, 'automate');              // guarantee prefix hits
    const content = words.join(' ');
    ins.run(`synth-${i}`, `conv-${i % 500}`, i % 3 === 0 ? 'user' : 'assistant', content, new Date(1700000000000 + i * 1000).toISOString(), len);
  }
  db.exec('COMMIT');
  const genMs = ms(t0);
  db.close();
  return genMs;
}

// ---------------------------------------------------------------- files bench (separate — NOT transcript search)
function benchFiles(tmpDir) {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const repoRoot = path.resolve(scriptDir, '..');
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { console.log('\n== files: git ls-files failed, skipping file-content bench =='); return null; }
  const MAX_FILE = 512 * 1024, MAX_TOTAL = 100 * 1024 * 1024, MAX_COUNT = 20000;
  let scanned = 0, skippedBin = 0, skippedBig = 0, totalBytes = 0;
  const docs = [];
  const tScan0 = process.hrtime.bigint();
  for (const rel of tracked.slice(0, MAX_COUNT)) {
    if (totalBytes > MAX_TOTAL) break;
    const abs = path.join(repoRoot, rel);
    let buf;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE) { skippedBig++; continue; }
      buf = readFileSync(abs);
    } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) { skippedBin++; continue; } // binary
    docs.push([rel, buf.toString('utf8')]);
    totalBytes += buf.length; scanned++;
  }
  const scanMs = ms(tScan0);
  const fpath = path.join(tmpDir, 'bench-fts-files.sqlite');
  if (existsSync(fpath)) unlinkSync(fpath);
  const db = new DatabaseSync(fpath);
  db.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, content TEXT NOT NULL)`);
  const ins = db.prepare(`INSERT INTO files (path, content) VALUES (?, ?)`);
  db.exec('BEGIN'); for (const [p, c] of docs) ins.run(p, c); db.exec('COMMIT');
  const tB0 = process.hrtime.bigint();
  db.exec(`CREATE VIRTUAL TABLE files_fts USING fts5(content, path UNINDEXED, tokenize='porter')`);
  db.exec(`INSERT INTO files_fts(rowid, content, path) SELECT rowid, content, path FROM files`);
  const buildMs = ms(tB0);
  const fileQueries = [['single-term', 'import'], ['phrase', '"import fs"'], ['prefix', 'confi*']];
  const rows = [];
  for (const [label, m] of fileQueries) {
    let match = m, hits = 0;
    try { hits = db.prepare(`SELECT COUNT(*) AS n FROM files_fts WHERE files_fts MATCH ?`).get(m).n; } catch { hits = 0; }
    if (hits === 0 && label === 'phrase') { match = 'config'; try { hits = db.prepare(`SELECT COUNT(*) AS n FROM files_fts WHERE files_fts MATCH ?`).get(match).n; } catch { /* keep 0 */ } }
    const samples = [];
    for (let i = 0; i < opts.iters; i++) {
      const t0 = process.hrtime.bigint();
      db.prepare(`SELECT rowid FROM files_fts WHERE files_fts MATCH ? ORDER BY bm25(files_fts) LIMIT 20`).all(match);
      samples.push(ms(t0));
    }
    samples.sort((a, b) => a - b);
    rows.push({ label, match, hits, p50: pct(samples, 0.5), p95: pct(samples, 0.95) });
  }
  const fbytes = statSync(fpath).size;
  db.close();
  if (!opts.keep) { try { unlinkSync(fpath); } catch { /* ignore */ } }
  console.log(`\n== files (THIS repo tracked content, separate index — not transcript search) ==`);
  console.log(`files=${scanned} skippedBin=${skippedBin} skippedBig=${skippedBig} corpus=${(totalBytes / 1024).toFixed(0)}KiB db=${(fbytes / 1024).toFixed(0)}KiB scan=${fmt(scanMs)}ms build=${fmt(buildMs)}ms`);
  console.log(`query       | MATCH      | hits   | p50     | p95`);
  for (const r of rows) console.log(`${r.label.padEnd(11)} | ${r.match.padEnd(10)} | ${String(r.hits).padStart(6)} | ${fmt(r.p50).padStart(5)}ms | ${fmt(r.p95).padStart(5)}ms`);
  return { worstP95: Math.max(...rows.map((r) => r.p95)) };
}

// ---------------------------------------------------------------- main
function main() {
  console.log(`bench-fts | node=${process.version} | iters=${opts.iters} cold=${opts.cold} | budget p95<=${BUDGET_P95_MS}ms | seed=${SEED}`);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bench-fts-'));
  const workPaths = [];
  let worstP95 = 0;

  const runOneCopy = (srcLabel, workPath, corpusTag) => {
    workPaths.push(workPath);
    const b = benchMessages(workPath, corpusTag);
    worstP95 = Math.max(worstP95, printMessagesBench(b));
    return b;
  };

  if (opts.scale) {
    for (const n of [10000, 100000]) {
      const wp = path.join(tmpDir, `synth-${n}.sqlite`);
      const genMs = buildSynthDb(n, wp);
      runOneCopy('synth', wp, `synthetic-${n} (gen=${fmt(genMs)}ms)`);
    }
  } else if (opts.synth > 0) {
    const wp = path.join(tmpDir, `synth-${opts.synth}.sqlite`);
    const genMs = buildSynthDb(opts.synth, wp);
    runOneCopy('synth', wp, `synthetic-${opts.synth} (gen=${fmt(genMs)}ms)`);
  } else {
    const src = findUserDb();
    if (!src) fail('no user DB found (~/.cloudchat/cloudchat.sqlite or $CLOUDCHAT_USER_DATA_DIR); re-run with --synth N');
    const wp = path.join(tmpDir, 'copy.sqlite');
    execFileSync('cp', [src, wp]); // copy only — source never opened for writing
    const b = runOneCopy(src, wp, `real-copy(${src})`);
    if (b.rows < 10000) console.log(`\nNOTE: real corpus only ${b.rows} rows (<10k) — re-run with --synth N or --scale for 10k/100k scaling.`);
  }

  const fb = benchFiles(tmpDir);
  if (fb) worstP95 = Math.max(worstP95, fb.worstP95);

  for (const wp of workPaths) {
    if (!opts.keep) { try { unlinkSync(wp); } catch { /* ignore */ } }
  }

  const pass = worstP95 <= BUDGET_P95_MS;
  console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'} — worst warm p95 ${fmt(worstP95)}ms vs ${BUDGET_P95_MS}ms budget (transcript+files combined; see table).`);
  console.log(`Does NOT prove: Electron main-process contention under load; concurrent-write behavior (readers only); ` +
    `query realism beyond the fixed set; production corpus distribution (synth is uniform vocab).`);
}

try { main(); } catch (e) { fail(e?.message ?? String(e)); }
