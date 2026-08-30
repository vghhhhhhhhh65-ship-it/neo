'use strict';
/* ───────────────────────── AUTO-UPDATER ─────────────────────────
   Detects a newer release of this repo, downloads the exact commit
   tarball (codeload host, no CDN-staleness), swaps the install dir
   atomically, and re-execs the running command so the user lands in
   the brand-new version automatically.

   Source of truth for "is there an update":
     GET /repos/{owner}/{repo}/commits/main                  → latest sha
     GET /repos/{owner}/{repo}/contents/package.json?ref=sha → version@sha
   Both are live (API, not CDN). Semver compare against the local
   package.json decides. No update ⇒ silent no-op.                */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

const REPO_SLUG = 'vghhhhhhhhh65-ship-it/neo';
const [OWNER, REPO] = REPO_SLUG.split('/');

const ROOT = __dirname; // install dir (holds package.json + bin/neo.js + this file)
const STATE_FILE = path.join(ROOT, '.update-meta.json');

let CURRENT_VERSION = '';
try { CURRENT_VERSION = require(path.join(ROOT, 'package.json')).version || ''; } catch {}

/* "a > b" → 1 · equal → 0 · "a < b" → -1 (numeric segments) */
function cmpVer(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function enabled() {
  return process.env.NEO_DISABLE_UPDATE !== '1';
}

async function apiJSON(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'neo-agent', Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/* newest published version we could find, or null when up-to-date/offline */
async function checkUpdate() {
  if (!enabled()) return null;
  const head = await apiJSON(`https://api.github.com/repos/${OWNER}/${REPO}/commits/main`);
  if (!head || !head.sha) return null;
  const sha = head.sha;
  const pkg = await apiJSON(`https://api.github.com/repos/${OWNER}/${REPO}/contents/package.json?ref=${sha}`);
  let latest = '';
  try { if (pkg && pkg.content) latest = (JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')) || {}).version || ''; } catch {}
  if (!latest || cmpVer(latest, CURRENT_VERSION) <= 0) return null;
  return { current: CURRENT_VERSION, latest, sha };
}

async function execP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 150000, maxBuffer: 16 * 1024 * 1024, ...opts }, (e, so, se) =>
      e ? reject(e) : resolve({ so, se })
    );
  });
}

/* download the exact-sha tarball, extract, verify, swap dirs.
   Throws on any failure — caller keeps running the old version. */
async function applyUpdate(info) {
  if (!enabled()) throw new Error('updates disabled');
  const tmpRoot = path.join(os.tmpdir(), 'neo-update-' + process.pid + '-' + Date.now());
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tgz = path.join(tmpRoot, 'neo.tar.gz');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90000);
  let resp;
  try {
    resp = await fetch(`https://codeload.github.com/${OWNER}/${REPO}/tar.gz/${info.sha}`, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'neo-agent' },
    });
  } catch (e) { throw new Error('download failed: ' + e.message); } finally { clearTimeout(t); }
  if (!resp || !resp.ok) throw new Error('download failed (HTTP ' + (resp && resp.status) + ')');

  try {
    await pipeline(resp.body, fs.createWriteStream(tgz));
    await execP('tar', ['-xzf', tgz, '-C', tmpRoot]);
  } catch (e) { throw new Error('download/extract failed: ' + e.message); }

  const candidates = fs.readdirSync(tmpRoot)
    .filter((d) => path.extname(d) === '')
    .map((d) => path.join(tmpRoot, d))
    .filter((p) => fs.existsSync(path.join(p, 'package.json')) && fs.existsSync(path.join(p, 'bin', 'neo.js')));
  if (!candidates.length) throw new Error('package missing bin/neo.js');
  const src = candidates[0];

  let vNew = '';
  try { vNew = require(path.join(src, 'package.json')).version || ''; } catch {}
  if (cmpVer(vNew, info.latest) !== 0) throw new Error(`version mismatch: expected v${info.latest}, got v${vNew}`);

  const backup = ROOT + '.old-' + Date.now();
  try { fs.renameSync(ROOT, backup); } catch (e) { throw new Error('cannot move current install: ' + e.message); }
  try { fs.renameSync(src, ROOT); } catch (e) { fs.renameSync(backup, ROOT); throw new Error('cannot install new version: ' + e.message); }

  /* reuse old node_modules when the new tree has none yet — then top it up */
  try {
    if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express')) && fs.existsSync(path.join(backup, 'node_modules'))) {
      fs.renameSync(path.join(backup, 'node_modules'), path.join(ROOT, 'node_modules'));
    }
  } catch {}

  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ sha: info.sha, version: vNew, from: info.current, at: Date.now() })); } catch {}
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  /* ensure dependencies (silent, non-blocking): already-present node_modules
   are reused above, npm just tops up what changed in the new version */
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    spawn(npm, ['install', '--no-audit', '--no-fund', '--silent'], { cwd: ROOT, stdio: 'ignore', detached: false }).unref();
  } catch {}

  return { ...info, version: vNew };
}

/* re-exec the SAME command with the freshly installed code.
   The child inherits our stdio, so it keeps this terminal; we exit right
   after it starts so the user lands in the new version automatically. */
function reexec(args) {
  const script = path.join(ROOT, 'bin', 'neo.js');
  const cv = CURRENT_VERSION;
  const child = spawn(process.execPath, [script, ...(args || [])], {
    stdio: 'inherit',
    detached: false,
    env: { ...process.env, NEO_UPDATED_FROM: cv },
  });
  child.on('error', () => process.exit(1));
  setTimeout(() => process.exit(0), 200);
}

module.exports = { REPO_SLUG, ROOT, CURRENT_VERSION, cmpVer, checkUpdate, applyUpdate, reexec, enabled };