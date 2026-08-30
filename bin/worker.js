#!/usr/bin/env node
'use strict';

/* headless background runner — launched detached by terminal/jobs.js.
   Loads the session thread from sessions.json, runs the full agent loop
   (same core as the interactive TUI) and streams progress as JSONL events
   into ~/.neo/jobs/<sessionId>.jsonl. Survives the terminal closing.    */

process.env.NEO_BG = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const sessionId = arg('--session');
if (!sessionId) process.exit(2);

const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'core.js'));
const jobs = require(path.join(ROOT, 'terminal', 'jobs.js'));

/* a detached background worker must outlive any closed terminal */
['SIGHUP', 'SIGINT'].forEach((s) => { try { process.on(s, () => {}); } catch {} });
/* SIGTERM = the user asked /jobs → stop: abort the run gracefully */
const ctrl = new AbortController();
try { process.on('SIGTERM', () => { try { ctrl.abort(); } catch {} }); } catch {}

/* keep the phone awake while a big job runs (Termux) — best effort */
try { execFile('termux-wake-lock', [], { timeout: 2000 }, () => {}); } catch {}
const wakeRelease = () => { try { execFile('termux-wake-unlock', [], { timeout: 2000 }, () => {}); } catch {} };

const SESSIONS_FILE = path.join(os.homedir(), '.neo', 'sessions.json');
const loadDb = () => { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {}; } catch { return { sessions: [] }; } };

const writeEvent = (ev) => {
  try { fs.appendFileSync(jobs.logFile(sessionId), JSON.stringify(ev) + '\n'); } catch {}
};

/* thread = history persisted by the TUI (user/assistant text pairs) */
const msgs = [];
{
  const rec = (loadDb().sessions || []).find((s) => s.id === sessionId);
  if (rec && Array.isArray(rec.msgs)) {
    for (const m of rec.msgs) {
      if (m.role === 'user') msgs.push({ role: 'user', content: String(m.text || '') });
      else if (m.role === 'assistant') {
        const c = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
        if (c) msgs.push({ role: 'assistant', content: c });
      }
    }
  }
  if (!msgs.length) {
    const meta = jobs.readMeta(sessionId);
    if (meta && meta.prompt) msgs.push({ role: 'user', content: meta.prompt });
  }
}
if (!msgs.length) process.exit(3);

const done = (meta) => { meta.ended = Date.now(); jobs.writeMeta(meta); wakeRelease(); };
const fail = (m) => { try { jobs.writeMeta(m); } catch {} wakeRelease(); process.exit(0); };

(async () => {
  const emit = (ev) => {
    writeEvent(ev);
    if (ev.type === 'usage') {
      const m = jobs.readMeta(sessionId) || { sessionId };
      m.usage = ev.total_tokens || 0;
      jobs.writeMeta(m);
    }
    if (ev.type === 'iteration') {
      const m = jobs.readMeta(sessionId) || { sessionId };
      m.iterationAt = Date.now();
      jobs.writeMeta(m);
    }
  };

  let res;
  try {
    res = await core.runAgent(msgs, emit, { signal: ctrl.signal, isAborted: () => ctrl.signal.aborted });
  } catch (e) {
    const m = jobs.readMeta(sessionId) || { sessionId };
    m.status = 'error';
    m.error = String((e && e.message) || e);
    fail(m);
    return;
  }

  const m = jobs.readMeta(sessionId) || { sessionId };
  if (res && res.aborted) {
    writeEvent({ type: 'aborted' });
    m.status = 'aborted';
    m.error = 'stopped by user';
  } else {
    m.status = 'done';
  }

  /* persist the final assistant answer into the saved thread so a later
     reopen of the session shows the full conversation; skip if a live
     follower already streamed that answer into the session */
  if (res && Array.isArray(res.history)) {
    const last = res.history.filter((h) => h.role === 'assistant').map((h) => h.content).filter(Boolean).join('\n\n');
    if (last) {
      const db = loadDb();
      const arr = db.sessions || [];
      const i = arr.findIndex((s) => s.id === sessionId);
      if (i >= 0) {
        const ms = JSON.parse(JSON.stringify(arr[i].msgs || []));
        const beenStreamed = (() => {
          const norm = (t) => String(t).replace(/\s+/g, ' ');
          const head = norm(last).slice(0, 48);
          const existing = norm(ms.filter((m) => m.role === 'assistant').map((m) => (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('')).join('\n'));
          return head.length > 8 && existing.includes(head);
        })();
        if (!beenStreamed) {
          ms.push({ role: 'assistant', parts: [{ type: 'text', text: last }] });
          arr[i] = { ...arr[i], msgs: ms, updated: Date.now(), title: arr[i].title || m.title || 'Background job' };
          db.sessions = arr;
          try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(db)); } catch {}
        }
      }
    }
  }
  done(m);
  process.exit(0);
})().catch((e) => {
  const m = jobs.readMeta(sessionId) || { sessionId };
  m.status = 'error';
  m.error = String((e && e.message) || e);
  fail(m);
});