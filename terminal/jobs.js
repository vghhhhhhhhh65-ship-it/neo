'use strict';

/* ── background jobs — detached headless agent runs (like opencode run) ──
   each job = a JSON meta file + a JSONL event stream under ~/.neo/jobs/<sessionId>.
   The worker is fully detached (setsid, stdio ignored) so it survives the
   terminal closing; the TUI tails the JSONL to follow progress live.      */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const JOB_DIR = path.join(os.homedir(), '.neo', 'jobs');
const ROOT = path.join(__dirname, '..');
const WORKER = path.join(ROOT, 'bin', 'worker.js');

const mkdir = () => { try { fs.mkdirSync(JOB_DIR, { recursive: true }); } catch {} };
const metaFile = (id) => path.join(JOB_DIR, id + '.json');
const logFile = (id) => path.join(JOB_DIR, id + '.jsonl');

const readMeta = (id) => {
  try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch { return null; }
};
const writeMeta = (m) => { mkdir(); try { fs.writeFileSync(metaFile(idOf(m)), JSON.stringify(m)); } catch {} };
const idOf = (m) => (m && m.sessionId) || '';
const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
};
const running = (id) => {
  const m = readMeta(id);
  return !!(m && m.status === 'running' && alive(m.pid));
};
const list = () => {
  mkdir();
  try {
    return fs.readdirSync(JOB_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readMeta(f.slice(0, -5)))
      .filter(Boolean)
      .sort((a, b) => (b.started || 0) - (a.started || 0));
  } catch { return []; }
};
const readLines = (id, from = 0) => {
  try {
    const t = fs.readFileSync(logFile(id), 'utf8');
    const all = t.split('\n');
    return { count: all.length, lines: all.slice(from).filter(Boolean) };
  } catch { return { count: 0, lines: [] }; }
};
const start = (sessionId, prompt) => {
  mkdir();
  if (running(sessionId)) return { started: false, why: 'running', id: sessionId };
  const meta = {
    sessionId, status: 'running', started: Date.now(), pid: 0,
    prompt: String(prompt || '').slice(0, 200),
    title: String(prompt || '').slice(0, 64),
  };
  writeMeta(meta);
  let child;
  try {
    child = cp.spawn(process.execPath, [WORKER, '--session', sessionId], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NEO_BG: '1' },
    });
    child.unref();
  } catch (e) {
    meta.status = 'error'; meta.error = String(e.message); meta.ended = Date.now();
    writeMeta(meta);
    return { started: false, why: 'spawn', error: e.message, id: sessionId };
  }
  meta.pid = child.pid;
  writeMeta(meta);
  return { started: true, id: sessionId, pid: child.pid };
};
const stop = (id) => {
  const m = readMeta(id);
  if (!m) return;
  if (alive(m.pid)) { try { process.kill(m.pid, 'SIGTERM'); } catch {} }
  /* the worker turns a SIGTERM into a graceful abort (status=aborted);
     hard-kill only if it is still alive after a grace window */
  setTimeout(() => {
    if (alive(m.pid)) { try { process.kill(m.pid, 'SIGKILL'); } catch {} }
  }, 6000).unref();
};

module.exports = { JOB_DIR, readMeta, writeMeta, list, running, alive, start, stop, readLines, metaFile, logFile };