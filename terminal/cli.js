'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const core = require('../core');
const { runAgent, MODELS, API_BASE, MAX_CONTEXT, WORKDIR, SYSTEM_PROMPT, setMode, getMode, setApiKey, getApiKey, setModel, getModel, setModelRaw, setApiBase, getApiBase, runCompact, modelCtxLimit } = core;
const modelName = () => getModel();
const { C, getWidth, getHeight, stripAnsi, clearLine, clearScreen, home, wrap, wlen, applyTheme, listThemes, themeName, themeLabel, goto } = require('./ansi');
const cfgmod = require('../config');
const { renderMd } = require('./md');
const { LineEditor } = require('./input');
const updater = require('../update');
const appVersion = () => { try { return require('../package.json').version; } catch { return ''; } };

const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ESC = '\x1b';
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const SPLASH_ART = [
  '███╗   ██╗███████╗ ██████╗ ',
  '████╗  ██║██╔════╝██╔═══██╗',
  '██╔██╗ ██║█████╗  ██║   ██║',
  '██║╚██╗██║██╔══╝  ██║   ██║',
  '██║ ╚████║███████╗╚██████╔╝',
  '╚═╝  ╚═══╝╚══════╝ ╚═════╝ ',
];
const editor = new LineEditor();
const COL = () => getWidth();
const ROWS = () => getHeight();

let tokensUsage = { prompt: 0, completion: 0, total: 0 };

let BUSY = false; // model is working → input frame shows "⏹ esc" hint

let statusTimer = null;
let statusFrame = 0;
let statusPrefix = '';
let statusColor = C.text;

/* ── mode (build | plan) — color + word change the whole input box ── */
const modeIsPlan = () => getMode() === 'plan';
const modeColor = () => (modeIsPlan() ? C.amber : C.art1);
const modeKey = () => (modeIsPlan() ? 'Plan' : 'Build');

/* ── virtual conversation — opencode-style footer ────────────────
   rows 1..convRows : scrollable conversation
   then the pinned footer block (enclosed rounded input box):
     ROWS-7  ▣  Build · <model> · <elapsed>      (session header)
     ROWS-6  (blank)
     ROWS-5  ╭───────────────╮                  (box top · accent corners)
     ROWS-4  │  › input…     │   ← EDITOR owns both rails (caret exact)
     ROWS-3  │───────────────│                  (thin divider)
     ROWS-2  │ Build · model … │    (meta row · right hint chip)
     ROWS-1  ╰───────────────╯                  (box bottom rounded)
     ROWS    CWD … <usage>  ctrl+p commands     (footer line)             */
const convRows = () => Math.max(3, ROWS() - 8);
const F_HDR = () => ROWS() - 7;
const F_BLANK = () => ROWS() - 6;
const F_B1 = () => ROWS() - 5;
const F_EDIT = () => ROWS() - 4;
const F_B3 = () => ROWS() - 3;
const F_META = () => ROWS() - 2;
const F_EDGE = () => ROWS() - 1;
const F_FOOT = () => ROWS();
const IND = '   ';

/* ── conversation scroll (in-app) — scrollUp shows older LOG lines while the
   footer stays pinned; 0 = live view at the bottom. ── */
let scrollOff = 0;
const maxScroll = () => Math.max(0, LOG.length - convRows());
function convSlice() {
  const n = convRows();
  const off = Math.max(0, Math.min(scrollOff, maxScroll()));
  return LOG.slice(Math.max(0, LOG.length - n - off), Math.max(n, LOG.length - off));
}
function scrollTo(off) {
  if (palette) return;
  const next = Math.max(0, Math.min(off, maxScroll()));
  if (next === scrollOff) return;
  scrollOff = next;
  SCREEN = null;
  renderConv();
}
function scrollBy(dir) {
  const step = Math.max(1, Math.floor(convRows() * 0.7));
  scrollTo(scrollOff + dir * step);
}
/* scroll by one page towards the top (dir>0) or back to the bottom (dir<0) */
function scrollPage(dir) { scrollTo(scrollOff + dir * Math.max(1, convRows() - 2)); }

/* ── conversation model (mirror of opencode: messages → parts) ──
   MSGS = [ { role:'user', text } | { role:'assistant', parts:[
             {type:'text', text} | {type:'thought', text} | {type:'tool', ...} ] } ]
   LOG is rebuilt deterministically from MSGS on every change — no splicing. */
let MSGS = [];
let LOG = [];
let SCREEN = null;

function padLine(inner, bg) {
  if (wlen(stripAnsi(inner)) >= COL()) inner = truncateFmt(inner, Math.max(1, COL() - 1));
  const raw = wlen(stripAnsi(inner));
  return '\x1b[2K' + (bg || C.bg) + inner + ' '.repeat(Math.max(0, COL() - raw)) + C.reset;
}

/* truncate a (possibly colored) string so it fits max visible cells —
   measured in real terminal width (CJK/emoji = 2, combining = 0) so lines
   never wrap past the edge and overlap the rows below. */
function truncateFmt(s, max) {
  if (wlen(stripAnsi(s)) <= max) return s;
  let out = '', cnt = 0, i = 0;
  while (i < s.length && cnt < max - 1) {
    const ch = s[i];
    if (ch === '\x1b') {
      let j = i + 1;
      while (j < s.length && s[j] !== 'm') j++;
      out += s.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const cp = s.codePointAt(i);
    if (cp > 0xffff) { out += s.slice(i, i + 2); cnt += 2; i += 2; continue; }
    out += ch;
    cnt += wlen(ch);
    i += 1;
  }
  return out + '…';
}

function blankLine() {
  return C.bg + ' '.repeat(Math.max(COL(), 10)) + C.reset;
}

/* ── paint whole screen: bg fill + conversation + input + status ── */
function paint() {
  let s = clearScreen() + '\x1b[3J';
  for (let i = 0; i < ROWS(); i++) s += blankLine() + '\n';
  SCREEN = null;
  process.stdout.write(s + home());
  rebuildLog();
  renderConv();
  drawLower();
}

/* ── deterministic rebuild: LOG built from MSGS parts (opencode For) ── */
function rebuildLog() {
  LOG = [];
  for (const m of MSGS) {
    if (m.role === 'splash') {
      const sp = m.parts[0];
      for (let i = 0; i < sp.padTop; i++) LOG.push('');
      const artW = wlen(SPLASH_ART[0]);
      const cx = (s) => ' '.repeat(Math.max(0, Math.floor((COL() - wlen(stripAnsi(s))) / 2)));
      SPLASH_ART.forEach((line, i) => {
        const cc = i < 2 ? C.art2 : i < 4 ? C.art1 : C.art3;
        LOG.push(cx(cc + line) + cc + C.bold + line + C.n);
      });
      LOG.push(cx(C.dimt + '· · ·  C O D I N G   A G E N T  · · ·') + C.dimt + '· · ·  C O D I N G   A G E N T  · · ·' + C.n);
      const key = getApiKey() ? C.green + '🔑 مضبوط' + C.n : C.red + '🔑 بدون مفتاح — /apikey' + C.n;
      const chips = C.dimt + modelName() + C.n + '  ·  ' + C.dimt + themeName() + C.n + '  ·  ' + modeColor() + modeKey() + C.n + '  ·  ' + key;
      LOG.push(cx(chips) + chips);
      const hint = 'اكتب مهمتك لتبدأ    TAB وضع Build⇄Plan    /  قائمة الأوامر';
      LOG.push(cx(C.gray + hint) + C.gray + hint + C.n);
      continue;
    }
    if (m.role === 'user') {
      const W = COL() - 8;
      LOG.push(...bubbleRows(USER_ICON, 'You', C.blue, C.userBg, wrap(m.text, W).map((l) => C.text + l), { right: true }));
      LOG.push('');
      continue;
    }
    for (const p of m.parts) {
      if (p.type === 'text') {
        LOG.push(...bubbleRows(AI_ICON, 'NEO', C.art1, C.panel, bubbleLines(p.text), { rail: C.art2 }));
        LOG.push('');
      } else if (p.type === 'thinking') {
        const first = truncateFmt(String(p.text).split('\n')[0], Math.max(16, COL() - IND.length - 4));
        LOG.push(IND + C.dimt + '· ' + first + C.n);
      } else if (p.type === 'note') {
        LOG.push(IND + C.dimt + p.text + C.n);
      } else if (p.type === 'update') {
        LOG.push(IND + (p.ok === false ? C.red : p.ok ? C.green : C.dimt) + p.text + C.n);
      } else if (p.type === 'compact') {
        const lines = String(p.text).split('\n');
        for (const l of lines) {
          const h = l.match(/^##\s*(.+)$/);
          if (h) LOG.push(IND + C.art1 + C.bold + h[1].trim() + C.n);
          else if (stripAnsi(l).trim()) LOG.push(IND + C.dimt + truncateFmt(l, Math.max(8, COL() - IND.length - 6)) + C.n);
        }
      } else if (p.type === 'todo') {
        const box = p.status === 'completed' ? C.green + '[✓]' + C.n : modeColor() + '[ ]' + C.n;
        LOG.push(IND + box + C.text + ' ' + truncateFmt(String(p.content), Math.max(8, COL() - IND.length - 8)) + C.n);
      } else if (p.type === 'tool') {
        if (p.pending) {
          LOG.push(IND + C.dimt + '~ ' + p.icon + '  ' + p.label + C.n);
        } else if (p.bash) {
          const W = COL() - 9;
          const cmd = String(p.labelName || '').trim() || String(p.label || '').replace(/^[^\s]+\s+/, '').trim();
          const body = String(p.output || '');
          const bodyLines = body.split('\n');
          const shown = bodyLines.slice(0, 9).flatMap((l) => (stripAnsi(l).length > W ? wrap(l, W) : [l]));
          const more = bodyLines.length > 9 ? [IND + C.dimt + '… (+' + (bodyLines.length - 9) + ' lines)' + C.n] : [];
          const failed = p.ok === false;
          const barC = failed ? C.red : C.blue;
          const cmdW = 2 + 2 + wlen(stripAnsi(cmd));
          const top = IND + C.panel + '┌' + C.n + ' ' + barC + '$' + C.n + ' ' + C.text + C.bold + cmd + C.n + ' ' + C.panel + '─'.repeat(Math.max(1, W - cmdW - 2)) + C.reset;
          const tail = IND + C.panel + '└' + C.n + (failed ? C.red : C.green) + '─'.repeat(Math.max(2, W)) + C.n + (failed ? C.reset : '');
          LOG.push(top);
          for (const l of shown) LOG.push(IND + C.panel + '│ ' + C.n + C.text + l + C.n);
          if (more.length) LOG.push(...more);
          LOG.push(tail);
        } else {
          const okC = p.ok === false ? C.red : p.ok === true ? C.green : C.dimt;
          const fname = String(p.labelName || '').trim() || String(p.label || '').replace(/^[^\s]+\s+/, '');
          const tag = p.diff && (p.diff.additions || p.diff.deletions)
            ? '  ' + C.green + '+' + p.diff.additions + C.n + ' ' + C.red + '−' + p.diff.deletions + C.n
            : '';
          LOG.push(IND + okC + p.icon + ' ' + C.n + C.text + C.bold + p.label.replace(/^[^\s]+\s+/, '') + C.n + tag + (p.ok === false ? C.red + '  ✕' + C.n : ''));
          if (p.diff) LOG.push(...diffBox(p.diff));
        }
      }
    }
  }
}

/* ── update only the changed conversation rows (diff vs last) ─── */
function renderConv() {
  const n = convRows();
  if (!SCREEN) SCREEN = new Array(n).fill('');
  const vis = convSlice();
  const pal = paletteRows();               // "/" command palette overlays the top rows
  let s = '';
  for (let i = 0; i < n; i++) {
    const content = (pal && i < pal.length) ? (pal[i] || '') : (vis[i] || '');
    if (SCREEN[i] === content) continue;
    SCREEN[i] = content;
    s += goto(i + 1, 1) + padLine(content);
  }
  process.stdout.write(s);
}

/* ── pinned footer (header + input box + edge + footer line) ── */
let sessionStart = Date.now();
function elapsedFmt() {
  const s = Math.floor((Date.now() - sessionStart) / 1000);
  const m = Math.floor(s / 60);
  return m ? m + 'm ' + (s % 60) + 's' : s + 's';
}

function footerLine() {
  const CW = Math.max(8, COL() - 1);
  const left = statusPrefix ? statusColor + (statusTimer ? SPINNERS[statusFrame % SPINNERS.length] + ' ' : '') + statusPrefix + C.n : C.gray + 'CWD' + C.n + '  ' + C.text + WORKDIR + C.n;
  const intr = BUSY ? '  ' + C.amber + C.bold + 'ESC' + C.n + C.amber + ' إيقاف' + C.n : '';
  const usage = ' ' + C.border + '▣' + C.n + '  ' + C.dimt + (tokensUsage.total ? fmt(tokensUsage.total) + ' / ' + fmt(modelCtxLimit()) + ' (' + Math.round(tokensUsage.total / modelCtxLimit() * 100) + '%)' : '0 / ' + fmt(modelCtxLimit()) + ' (0%)') + C.n;
  const pal = C.text + C.bold + 'ctrl+p' + C.n + ' ' + C.dimt + 'commands' + C.n;
  const L = ' ' + left + intr;
  const wl = wlen(stripAnsi(L));
  let R;
  if (wl + 2 + wlen(stripAnsi(usage)) + 2 + wlen(stripAnsi(pal)) <= CW) R = usage + '  ' + pal;
  else if (wl + 2 + wlen(stripAnsi(usage)) <= CW) R = usage;
  else R = '';
  const gap = Math.max(2, CW - wl - (R ? wlen(stripAnsi(R)) : 0));
  return truncateFmt(L + ' '.repeat(gap) + R, CW);
}

/* ── fixed input + footer rows (always at bottom, never scroll) ──
   an enclosed rounded box with accent rails at col1 and col COL-1:
     ╭─  Build ·   model  · 0:04 ────────────╮   with scroll hint ……
     ────────────────────────────────────────
     │  ❯ Ask anything…                       │
     ────────────────────────────────────────
     │  Build · model          ⏎ send · TAB⇄  │
     ╰──────────────────────────────────────╯
   the editor row itself owns both rails so the caret math stays exact. */
function fillRow(c, bg) { return padLine(c, bg); }

function drawLower() {
  const ac = modeColor();
  const W = COL();
  const M = Math.max(1, W - 3);              // inner run between the corners
  const scrollHint = scrollOff > 0 ? '   ' + C.gray + '↥ ' + scrollOff + ' أقدم' + C.n : '';
  const bgseg = '';
  const hdr = '▣  ' + ac + C.bold + modeKey() + C.n + C.dimt + ' · ' + C.n + C.text + modelName() + C.n + C.dimt + ' · ' + elapsedFmt() + C.n + bgseg + scrollHint;

  /* rounded corners + dim run: ╭ ring in accent, ─ run in dimt */
  const topRow = ac + '╭' + C.n + C.dimt + '─'.repeat(M) + C.n + ac + '╮' + C.n;
  const divRow = ac + '│' + C.n + C.dimt + '─'.repeat(M) + C.n + ac + '│' + C.n;
  const botRow = ac + '╰' + C.n + C.dimt + '─'.repeat(M) + C.n + ac + '╯' + C.n;

  /* meta row: |  mode · model …… chip │ */
  const metaL = ac + C.bold + modeKey() + C.n + C.dimt + ' · ' + C.n + C.text + modelName() + C.n;
  const chip = C.dimt + '⏎ send · TAB⇄' + C.n;
  const iw = wlen(stripAnsi(metaL));
  const cw = wlen(stripAnsi(chip));
  const pad = W - 5 - iw - cw;
  let metaRow;
  if (pad >= 1) {
    metaRow = '│ ' + metaL + ' '.repeat(pad) + chip + ' │';
  } else {
    const room = Math.max(4, W - 5);
    const m = truncateFmt(metaL, room);
    metaRow = '│ ' + m + ' '.repeat(Math.max(0, W - 5 - wlen(stripAnsi(m)))) + ' │';
  }

  process.stdout.write(goto(F_HDR(), 1) + fillRow(truncateFmt(hdr, W)));
  process.stdout.write(goto(F_BLANK(), 1) + fillRow(''));
  process.stdout.write(goto(F_B1(), 1) + fillRow(topRow, C.element));
  process.stdout.write(goto(F_B3(), 1) + fillRow(divRow, C.element));
  process.stdout.write(goto(F_META(), 1) + fillRow(metaRow, C.element));
  process.stdout.write(goto(F_EDGE(), 1) + fillRow(botRow, C.element));
  process.stdout.write(goto(F_FOOT(), 1) + fillRow(footerLine()));
  editor.barW = W;
  editor.setRow(F_EDIT());
  editor.accent = () => ac;
  editor.draw();
}

function drawStatusLine() { drawLower(); }

/* restore the terminal and print a clean goodbye (only used at real exit) */
function bye() {
  dropStatusTimer();
  /* restore the terminal's own default fg/bg (we may have changed them via OSC 10/11) */
  process.stdout.write('\x1b]110\x1b\\\x1b]111\x1b\\');
  process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?1049l' + clearScreen() + home() + C.text + 'Bye 👋' + C.reset + '\n');
}
/* enter the alternative screen — the app redraws in place, the main buffer
   (and its scrollback) is never polluted, so scrolling up can't scramble the
   log; in-app scrolling is provided via PgUp/PgDn and the mouse wheel.
   autowrap is disabled too: no single line can ever spill onto the next row,
   which is what made the status "Thinking…" cascade below the bar */
function termBegin() {
  process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?7l\x1b[?25l' + clearScreen() + home());
}

function setStatus(prefix, color) {
  statusPrefix = prefix || '';
  statusColor = color || C.text;
  dropStatusTimer();
  drawStatusLine();
}
function startStatusSpinner(prefix, color) {
  setStatus(prefix, color);
  statusFrame = 0;
  statusTimer = setInterval(() => { statusFrame++; drawStatusLine(); }, 80);
  drawStatusLine();
}
function dropStatusTimer() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = null;
}

/* ── toggle build ⇄ plan mode from TAB (or /plan · /build) ── */
function applyMode(next) {
  setMode(next);
  cfgmod.save({ mode: next });
  SCREEN = null;
  paint();
  drawLower();
  setStatus(
    getMode() === 'plan' ? 'خطة — أخطّط فقط ولا أنفّذ' : 'Build — أنفّذ ما تطلبه فوراً',
    modeColor()
  );
}
function toggleMode() {
  applyMode(getMode() === 'plan' ? 'build' : 'plan');
  if (palette) { closePalette(); }
}

/* ── file-change box (green added / red removed full-line backgrounds),
     opencode diff style ── */
function diffBox(d) {
  if (!d || !d.lines) return [];
  const W = Math.max(12, COL() - 10);
  const rows = [];
  const short = String(d.path).replace(/^.*[\\/]/, '');
  const head = '╭── ' + C.art2 + C.bold + short + C.n + C.dimt + ' ▣ +' + d.additions + ' −' + d.deletions + C.n;
  rows.push(IND + truncateFmt(head, W));
  for (const l of d.lines.slice(0, 12)) {
    const code = truncateFmt(String(l.text), W - 7);
    if (l.t === 'add') {
      rows.push(IND + C.diffAddBg + ' ' + C.green + '│ + ' + C.n + code + ' '.repeat(Math.max(0, W - 5 - wlen(stripAnsi(code)))) + C.reset);
    } else if (l.t === 'del') {
      rows.push(IND + C.diffRemBg + ' ' + C.red + '│ − ' + C.n + code + ' '.repeat(Math.max(0, W - 5 - wlen(stripAnsi(code)))) + C.reset);
    } else if (l.t === 'gap') {
      rows.push(IND + C.panel + ' ' + C.dimt + '│' + C.n + ' '.repeat(Math.max(0, W - 3)) + C.reset);
    } else {
      rows.push(IND + C.panel + ' ' + C.dimt + '│   ' + C.n + code + ' '.repeat(Math.max(0, W - 5 - wlen(stripAnsi(code)))) + C.reset);
    }
  }
  if (d.lines.length > 12) rows.push(IND + C.dimt + '… (+' + (d.lines.length - 12) + ' lines)' + C.n);
  rows.push(IND + C.border + '╰' + '─'.repeat(Math.max(2, W - 1)) + C.n);
  return rows;
}

/* ── message bubbles — rounded, breathing padding, calm look.
   assistant: left docked, gradient cap (title in art1, run in art2)
   user:      right docked (messenger style), soft blue walls      ── */
const USER_ICON = '◉';
const AI_ICON = '✦';

/* inner content lines already colored, no INDENT/BG yet.
   opts.right → right-aligned bubble; opts.rail → color for the dash run */
function bubbleRows(icon, title, borderColor, fillBg, lines, opts = {}) {
  const clean = lines.map((l) => String(l));
  if (!clean.length || clean.every((l) => wlen(stripAnsi(l)) === 0)) return [];
  const maxL = clean.reduce((a, l) => Math.max(a, wlen(stripAnsi(l))), 0);
  const W = Math.min(COL() - 6, Math.max(18, maxL + 3));
  const rail = opts.rail || borderColor || C.dimt;
  const head = C.dimt + icon + ' ' + C.n + C.bold + (borderColor || C.text) + title + C.n;
  const hl = wlen(stripAnsi(head));
  const rows = [];
  rows.push(C.dimt + '╭─ ' + C.n + head + rail + '  ' + '─'.repeat(Math.max(1, W - 6 - hl)) + C.n + C.dimt + '╮' + C.n);
  const innerW = W - 4;
  for (const l of clean) {
    const t = wlen(stripAnsi(l));
    for (const ln of (t > innerW ? wrap(l, innerW) : [l])) {
      const tn = wlen(stripAnsi(ln));
      /* re-apply fillBg after any embedded hard reset so the terminal's own
         base color can never bleed through inside the bubble; the closing
         rail stays on the same background (no reset before it) */
      const patched = ln.replace(/\x1b\[0m(?=.)/g, (m) => m + fillBg);
      rows.push(C.dimt + '│' + C.n + fillBg + '  ' + patched + ' '.repeat(Math.max(0, innerW - tn)) + C.dimt + '│' + C.n);
    }
  }
  rows.push(C.dimt + '╰' + rail + '─'.repeat(Math.max(2, W - 2)) + C.n + C.dimt + '╯' + C.n);
  if (opts.right) {
    return rows.map((r) => ' '.repeat(Math.max(0, COL() - 1 - wlen(stripAnsi(r)))) + r);
  }
  return rows.map((r) => IND + r);
}

/* wrap markdown text into plain (colored) lines for the bubble body */
function bubbleLines(text) {
  const W = COL() - 10;
  const rendered = renderMd(String(text || ''), W);
  const out = [];
  for (const raw of String(rendered).split('\n')) {
    const visible = wlen(stripAnsi(raw));
    if (!visible) { out.push(''); continue; }
    out.push(...(visible > W ? wrap(raw, W) : [raw]));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/* streaming accumulation (raw text, never spliced from rendered rows) */
let stream = null; // { msg, part } for the live assistant text part
let streamTimer = null;

function lastAssistant() {
  return MSGS.length && MSGS[MSGS.length - 1].role === 'assistant' ? MSGS[MSGS.length - 1] : null;
}
function ensureAssistant() {
  let a = lastAssistant();
  if (!a) { a = { role: 'assistant', parts: [] }; MSGS.push(a); }
  return a;
}
function streamChunk(chunk) {
  dropStatusTimer();
  statusPrefix = 'Writing…';
  statusColor = C.text;
  const a = ensureAssistant();
  if (!stream) {
    stream = { msg: a, part: { type: 'text', text: '' } };
    a.parts.push(stream.part);
  }
  stream.part.text += chunk;
  scheduleStreamRender();
}
function scheduleStreamRender() {
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    rebuildLog();
    renderConv();
    drawLower();
  }, 30);
}
function endStream() {
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
  stream = null;
  rebuildLog();
  renderConv();
  drawLower();
}

/* ── inline tools (icon + label; matched by id like opencode) */
const INLINE_ICON = { read_file: '→', write_file: '←', edit_file: '←', list_dir: '→', glob: '✱', grep: '✱', bash: '$' };

function toolHeading(ev) {
  const icon = INLINE_ICON[ev.name] || '⚙';
  const label = ev.name.replace(/_/g, ' ') + ' ' + toolArg(ev);
  return { icon, label };
}
function toolArg(ev) {
  for (const [k, v] of Object.entries(ev.args || {})) {
    if (k === 'description') continue;
    let s = String(v);
    if (s.length > 48) s = s.slice(0, 48) + '…';
    return s;
  }
  return '';
}

function printToolStart(ev) {
  const { icon, label } = toolHeading(ev);
  const a = ensureAssistant();
  a.parts.push({ type: 'tool', id: ev.id, icon, label, pending: true, bash: ev.name === 'bash' });
  startStatusSpinner(icon + '  ' + label, C.dimt);
  endStreamLike();
  rebuildLog();
  renderConv();
  drawLower();
}
function printToolDone(ev) {
  dropStatusTimer();
  const a = lastAssistant();
  if (!a) return;
  const part = a.parts.findLast((p) => p.type === 'tool' && p.pending === true && (ev.id ? p.id === ev.id : true));
  const icon = part ? part.icon : (INLINE_ICON[ev.name] || '⚙');
  const label = part ? part.label : (ev.name.replace(/_/g, ' ') + ' ' + toolArg(ev));
  if (part) {
    part.pending = false;
    part.ok = ev.ok;
    part.bash = ev.name === 'bash';
    part.labelName = toolArg(ev) || (part.label ? String(part.label).replace(/^[^\s]+\s+/, '') : '');
    part.output = ev.output || '';
    part.diff = ev.diff || null;
  }
  rebuildLog();
  renderConv();
  drawLower();
  setStatus((ev.ok ? icon + ' ' + label + ' ✓' : icon + ' ' + label + ' ✕'), ev.ok ? C.green : C.red);
}
function endStreamLike() {
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
  stream = null;
}

/* ── usage footer meta ───────────────────────────────────────── */
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

/* ── auto-update flow — silent network check, automatic apply + restart ──
   launch:  if newer release exists → show it, download, swap, re-exec the
            terminal so the user lands immediately in the new version.
   manual : /update  → check now + apply + restart (or "already freshest").
   timer  : while running, find newer release → gentle notice only.        */
async function doUpdate(opts = {}) {
  const { manual = false } = opts;
  const info = await updater.checkUpdate().catch(() => null);
  if (!info) {
    if (manual) setStatus('أنت على أحدث إصدار v' + appVersion() + ' ✓', C.green);
    return false;
  }
  const busy = BUSY || editor.buf !== '';
  if (busy) {
    const a = ensureAssistant();
    a.parts.push({ type: 'update', text: `⬆ متوفر تحديث NEO v${info.latest} — سيتم تطبيقه تلقائياً عند إعادة التشغيل. للترقية فوراً اكتب: /update`, ok: true });
    rebuildLog(); renderConv(); drawLower();
    return false;
  }
  {
    const a = ensureAssistant();
    a.parts.push({ type: 'update', text: '⬆ نسخة جديدة متاحة: v' + info.latest + ' (أنت على v' + info.current + ') — تحميل التحديث…', ok: true });
    rebuildLog(); renderConv();
  }
  setStatus('⬆ تحديث NEO إلى v' + info.latest + ' …', C.green);
  try {
    const res = await updater.applyUpdate(info);
    {
      const a = ensureAssistant();
      a.parts.push({ type: 'update', text: '✔ تم التحديث إلى v' + res.version + ' — إعادة تشغيل تلقائي…', ok: true });
      rebuildLog(); renderConv();
    }
    setStatus('✔ تم التحديث → v' + res.version + ' · إعادة تشغيل', C.green);
    if (editor.buf !== '' || BUSY) {
      const a2 = ensureAssistant();
      a2.parts.push({ type: 'update', text: '✔ التحديث جاهز — سيُفعّل تلقائياً عند إعادة تشغيل neo.', ok: true });
      rebuildLog(); renderConv(); drawLower();
      return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
    saveCurrent();
    try { process.stdin.setRawMode(false); } catch {}
    updater.reexec(process.argv.slice(2));
    return true;
  } catch (e) {
    const a = ensureAssistant();
    a.parts.push({ type: 'update', text: '✕ فشل التحديث: ' + e.message, ok: false });
    rebuildLog(); renderConv();
    setStatus('✕ فشل التحديث: ' + e.message, C.red);
    return false;
  }
}

function periodicUpdateCheck() {
  updater.checkUpdate().then((info) => {
    if (!info || BUSY) return;
    const a = ensureAssistant();
    a.parts.push({ type: 'update', text: '📦 توفر إصدار جديد: v' + info.latest + ' — اكتب /update للتحديث الآن (أو سيتم تلقائياً عند إعادة التشغيل).', ok: true });
    rebuildLog(); renderConv(); drawLower();
  }).catch(() => {});
}

/* ── sessions — persistent chat history (like opencode) ───────── */
const NEO_DIR = path.join(os.homedir(), '.neo');
const SESSIONS_FILE = path.join(NEO_DIR, 'sessions.json');
let SESSION_ID = Date.now().toString(36);

function sessionDir() { try { fs.mkdirSync(NEO_DIR, { recursive: true }); } catch {} }
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function currentTitle() {
  const u = MSGS.find((m) => m.role === 'user');
  if (u) return String(u.text).slice(0, 64);
  const a = lastAssistant();
  if (a) {
    const t = a.parts.filter((p) => p.type === 'text').map((p) => p.text).join('').slice(0, 64);
    if (t) return t;
  }
  return 'New chat';
}
function saveCurrent() {
  try {
    sessionDir();
    const db = loadSessions();
    const record = {
      id: SESSION_ID,
      ts: ((db.sessions || []).find((s) => s.id === SESSION_ID) || {}).ts || Date.now(),
      updated: Date.now(),
      title: currentTitle(),
      msgs: MSGS.filter((m) => m.role !== 'splash'),
    };
    let arr = db.sessions || [];
    if (!record.msgs.length) arr = arr.filter((s) => s.id !== SESSION_ID);
    else {
      const i = arr.findIndex((s) => s.id === SESSION_ID);
      if (i >= 0) arr[i] = record; else arr.unshift(record);
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: arr.slice(0, 30), active: SESSION_ID }));
  } catch {}
}
function openSession(id) {
  saveCurrent();
  const s = (loadSessions().sessions || []).find((x) => x.id === id);
  if (!s) { MSGS = []; scrollOff = 0; paint(); setStatus('Session not found', C.red); return; }
  SESSION_ID = id;
  MSGS = JSON.parse(JSON.stringify(s.msgs)) || [];
  scrollOff = 0;
  tokensUsage = { prompt: 0, completion: 0, total: 0 };
  paint();
  setStatus('Opened session · ' + (s.title || 'Untitled'), C.green);
}
function newSession() {
  saveCurrent();
  SESSION_ID = Date.now().toString(36);
  MSGS = [];
  scrollOff = 0;
  tokensUsage = { prompt: 0, completion: 0, total: 0 };
  paint();
  setStatus('New session', C.green);
}

/* ── modal picker — sessions / theme dialogs ── */
/* ═══════ full-screen pages — الوضعيات تفتح كصفحات مستقلة فوق الشاشة كلها ═══════ */

function restoreActiveSession() {
  try {
    const db = loadSessions();
    const act = db.active;
    const s = (db.sessions || []).find((x) => x.id === act);
    if (s) {
      SESSION_ID = act;
      MSGS = JSON.parse(JSON.stringify(s.msgs)) || [];
    }
  } catch {}
}

const cxStr = (s) => ' '.repeat(Math.max(0, Math.floor((COL() - wlen(stripAnsi(s))) / 2)));

function pagePaint(rows) {
  const n = ROWS();
  let s = '';
  for (let i = 0; i < n; i++) s += goto(i + 1, 1) + padLine(rows[i] || '', C.bg);
  process.stdout.write(s);
}

function restoreScreen() {
  SCREEN = null;
  rebuildLog();
  renderConv();
  drawLower();
}

/* ── قائمة في صفحة كاملة: النماذج / الثيمات / الجلسات / الترحيب ── */
async function pickPage(title, items, opts = {}) {
  if (!items || !items.length) return null;
  const maxVis = Math.max(1, ROWS() - 8);
  let sel = 0;
  let start = 0;
  const footer = opts.footer || '↑↓ اختر · Enter تنفيذ · ESC إلغاء';
  const draw = () => {
    const rows = Array(ROWS()).fill('');
    let k = 0;
    rows[k++] = C.art1 + C.bold + '  ' + title + C.n;
    rows[k++] = '';
    if (sel < start) start = sel;
    if (sel >= start + maxVis) start = sel - maxVis + 1;
    const shown = items.slice(start, start + maxVis);
    shown.forEach((it, i) => {
      const active = i + start === sel;
      const label = (active ? C.bold : C.panel) + it.label + C.n + (it.desc ? C.dimt + '   ' + it.desc + C.n : '');
      const line = (active ? C.element : C.panel) + '  ' + (active ? '❯ ' : '  ') + label;
      rows[k++] = cxStr(line) + line;
    });
    rows[ROWS() - 1] = C.dimt + '  ' + footer + C.n;
    pagePaint(rows);
  };
  draw();
  const picked = await editor.readPicker((tok) => {
    if (tok === ESC || tok === 'q' || tok === 'Q') { editor.finishPicker(null); return true; }
    if (tok.length === 1 && tok >= '1' && tok <= '9') {
      const i = Number(tok) - 1;
      if (items[i]) { editor.finishPicker(items[i]); return true; }
    }
    if (tok === ARROW_UP) { sel = (sel + items.length - 1) % items.length; draw(); return true; }
    if (tok === ARROW_DOWN) { sel = sel + 1 >= items.length ? 0 : sel + 1; draw(); return true; }
    if (tok === '\r' || tok === '\n') { editor.finishPicker(items[sel]); return true; }
    if (opts.onKey) return opts.onKey(tok) === true;
    return true;
  });
  restoreScreen();
  return picked ? picked.value : null;
}

/* ── interactive user question — the agent called ask_question(); show a
   picker page (title = the question) and resolve the pending answer so the
   agent can keep going, exactly like opencode's question dialog. ESC or a
   bare Enter on a free-text option = dismiss → agent proceeds on its own. ── */
async function showQuestionPage(ev) {
  stopInterruptWatcher();
  const items = ev.options.map((o) => ({ value: o.value, label: o.label, desc: '' }));
  items.push({ value: '__custom__', label: '✍️ اكتب إجابة بنفسك…', desc: 'رأي حر — أكتبه' });
  const title = truncateFmt('❓ ' + ev.question, Math.max(10, COL() - 6));
  const picked = await pickPage(title, items, {
    footer: '↑↓ اختر · Enter إرسال · ESC أكمل بلا إجابة',
  });
  let answer = null;
  if (picked === '__custom__') {
    const form = await pageForm({
      title: 'إجابتك الحرة',
      subtitle: ev.question,
      fields: [{ key: 'txt', label: 'الرد', placeholder: 'اكتب هنا…' }],
      footer: 'Enter حفظ · ESC إلغاء',
    });
    answer = form && form.txt ? String(form.txt).trim() : null;
  } else if (picked) {
    answer = String(picked);
  }
  try { core.answerQuestion(ev.id, answer || ''); } catch {}
  if (BUSY) installInterruptWatcher();
}

/* ── نموذج في صفحة كاملة: حقول إدخال متعددة (مخفية أو ظاهرة) ── */
async function pageForm(opts) {
  const { title, subtitle, fields, footer } = opts;
  let focus = 0;
  const values = {};
  const draw = () => {
    const rows = Array(ROWS()).fill('');
    rows[0] = C.art1 + C.bold + '  ' + title + C.n;
    if (subtitle) rows[1] = C.dimt + '  ' + subtitle + C.n;
    rows[2] = '';
    fields.forEach((f, i) => {
      const active = i === focus;
      const val = values[f.key] || '';
      const shown = f.mask ? '•'.repeat(val.length) : val;
      const body = C.text + (shown || C.dimt + (f.placeholder || '')) + (active ? C.art1 + '▏' + C.n : C.dimt + '▏' + C.n);
      const line = (active ? C.element : C.panel) + '  ' + (active ? '❯ ' : '  ') + C.bold + f.label + C.n + C.dimt + '    ' + C.n + body;
      rows[3 + i] = cxStr(line) + line;
    });
    rows[ROWS() - 1] = C.dimt + '  ' + footer + C.n;
    pagePaint(rows);
  };
  draw();
  const done = await editor.readPicker((tok) => {
    const f = fields[focus];
    if (tok === ESC || tok === '\x03') { editor.finishPicker(null); return true; }
    if (tok === ARROW_UP) { focus = (focus + fields.length - 1) % fields.length; draw(); return true; }
    if (tok === ARROW_DOWN) { focus = (focus + 1) % fields.length; draw(); return true; }
    if (tok === '\r' || tok === '\n') {
      if (focus === fields.length - 1) { editor.finishPicker({ ...values }); return true; }
      focus++; draw(); return true;
    }
    if (tok === '\x7f' || tok === '\b') { if (values[f.key]) values[f.key] = values[f.key].slice(0, -1); draw(); return true; }
    if (opts.onKey) { const r = opts.onKey(tok); if (r === true) return true; }
    if (tok.length === 1 && tok >= ' ' && tok.charCodeAt(0) !== 27) {
      const cur = values[f.key] || '';
      if (cur.length < 300) { values[f.key] = cur + tok; draw(); }
    }
    return true;
  });
  restoreScreen();
  return done;
}

/* ── استخدام مفتاح API · صفحة كاملة بحقل مخفي + رابط إنشاء المفتاح ── */
const XKIRO_KEYS = 'https://xkiro.com/dashboard/api/keys';
async function useApiKeyPage() {
  const saved = await pageForm({
    title: 'استخدام مفتاح API — xkiro',
    subtitle: 'أنشئ مفتاحك ثم ارجع:  ' + XKIRO_KEYS + '   (اضغط o للفتح)',
    fields: [{ key: 'apiKey', label: 'API Key', placeholder: 'sk-…', mask: true }],
    footer: 'اكتب المفتاح ثم Enter حفظ · o فتح الرابط · ESC رجوع',
    onKey: (tok) => {
      if (tok === 'o' || tok === 'O') { try { exec('termux-open-url "' + XKIRO_KEYS + '"'); } catch {} return true; }
      return false;
    },
  });
  if (saved && saved.apiKey && saved.apiKey.trim()) {
    const k = saved.apiKey.trim();
    setApiKey(k);
    cfgmod.save({ apiKey: k });
    setStatus('تم حفظ مفتاح API ✓', C.green);
    return k;
  }
  return null;
}

/* ── ربط مزوّد خارجي: اسم نموذج + رابط API + مفتاح + سياق ═══ */
async function connectProviderPage() {
  const got = await pageForm({
    title: 'ربط مزوّد / API خارجي',
    subtitle: 'أي خدمة بواجهة OpenAI /v1 — xkiro أو خوادمك أو أدواتك الخاصة',
    fields: [
      { key: 'model', label: 'اسم النموذج', placeholder: 'model-id' },
      { key: 'apiBase', label: 'API Base URL', placeholder: 'https://api.example.com/v1' },
      { key: 'apiKey', label: 'API Key', mask: true },
      { key: 'maxContext', label: 'حجم السياق (اختياري)', placeholder: '1048576' },
    ],
    footer: '↑↓ تنقل · Enter الحقل التالي (آخر واحد = حفظ) · ESC إلغاء',
  });
  if (!got) return null;
  const model = (got.model || '').trim();
  const base = (got.apiBase || '').trim();
  const key = (got.apiKey || '').trim();
  const save = {};
  if (key) save.apiKey = key;
  if (base) save.apiBase = base;
  if (model) save.model = model;
  if ((got.maxContext || '').trim() && Number(got.maxContext) > 0) save.maxContext = Number(got.maxContext);
  if (!Object.keys(save).length) { setStatus('لم تُدخل أي بيانات', C.amber); return null; }
  cfgmod.save(save);
  if (key) setApiKey(key);
  if (base) setApiBase(base);
  if (model) { if (MODELS.some((m) => m.id === model)) setModel(model); else setModelRaw(model); }
  setStatus('✓ المزوّد: ' + (base || '(افتراضي)') + ' · ' + (model || '(افتراضي)') + (key ? ' · key ✓' : ' · بدون key'), C.green);
  return got;
}

/* ── بوابة الترحيب — شاشة بدء بثلاثة أزرار قبل صفحة المحادثة ── */
const WELCOME_ITEMS = [
  { value: 'useapi', label: 'استخدام مفتاح API — xkiro', desc: 'أدخل مفتاحك من لوحة xkiro.com' },
  { value: 'provider', label: 'ربط مزوّد / API خارجي', desc: 'نموذج + رابط API + مفتاح لأي خدمة' },
  { value: 'exit', label: 'خروج', desc: 'إنهاء البرنامج' },
];

async function welcomeGate() {
  while (getApiKey() === '') {
    const c = await pickPage('NEO · قبل أن تبدأ', WELCOME_ITEMS, { footer: '1/2/3 أو ↑↓ ثم Enter · ESC خروج' });
    if (c === 'exit' || c === null) return false;
    if (c === 'useapi') { if (await useApiKeyPage()) return true; }
    else if (c === 'provider') { if (await connectProviderPage()) return true; }
  }
  return true;
}

/* ── model picker (xkiro catalog + custom) · صفحة مستقلة ── */
async function showModels() {
  const known = MODELS.map((m) => ({
    value: m.id,
    label: m.name,
    desc: (m.id === modelName() ? '(active)' : m.tag) + (m.id === modelName() && m.tag ? ' · ' + m.tag : ''),
  }));
  const custom = !MODELS.some((m) => m.id === modelName())
    ? [{ value: modelName(), label: modelName(), desc: '(مزوّد خارجي مخصص)' }]
    : [];
  const picked = await pickPage('Model — النموذج (الكل مجاني)', [...known, ...custom]);
  if (picked) {
    setModel(picked);
    cfgmod.save({ model: picked });
    SCREEN = null; paint();
    setStatus('Model: ' + picked, C.green);
  }
}

/* ── مفتاح API · صفحة مستقلة ── */
async function showApiKey() {
  await useApiKeyPage();
}

async function showSessions() {
  saveCurrent();
  const arr = (loadSessions().sessions || []).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const items = [{ value: '__new__', label: '+ New session', desc: 'محادثة جديدة' }];
  for (const s of arr) items.push({ value: s.id, label: String(s.title) || 'Untitled', desc: timeAgo(s.updated) + ' · ' + modelName() });
  const picked = await pickPage('Sessions — المحادثات', items);
  if (!picked) return;
  if (picked === '__new__') newSession(); else openSession(picked);
}

async function showThemePicker() {
  const items = listThemes().map((n) => ({
    value: n,
    label: themeLabel(n),
    desc: n === themeName() ? '(active)' : '',
  }));
  const picked = await pickPage('Theme — الثيم', items);
  if (picked) {
    applyTheme(picked);
    cfgmod.save({ theme: picked });
    SCREEN = null; paint(); setStatus('Theme saved: ' + themeLabel(picked), C.green);
  }
}

function showPromptInfo() {
  const { promptPath, reloadPrompt, SYSTEM_PROMPT } = core;
  const r = reloadPrompt();
  const a = ensureAssistant();
  a.parts.push({
    type: 'text',
    text: `prompt file: ${r.path}\nstate:       ${r.ok ? (r.mode === 'custom' ? 'يُستخدم (أنت تستبدل نظام NEO)' : 'افتراضي — لم يوجد محتوى') : 'لا يُقرأ — ' + r.reason}\n\nاكتب برومتك في الملف ده بالكامل و NEO هتنفذه حرفياً كموجه نظام:\n  printf 'أنت خبير في …' > "${r.path}"\n\nاتفضل تعدّل ثم أعد الإرسال — تُقرأ من هنا تلقائياً بنفس الجلسة (الملف يغلّف الموضوع/السياق).`,
  });
  rebuildLog(); renderConv(); drawLower();
  setStatus(String(SYSTEM_PROMPT).slice(0, 40) + '…', C.dimt);
}

/* ── "/" command palette — shows live while typing ── */
const COMMANDS = [
  { value: '/plan', label: '/plan', desc: 'وضع الخطة · أخطّط فقط + TODO · أصفر' },
  { value: '/build', label: '/build', desc: 'وضع التنفيذ · أنفّذ فوراً · TAB للتبديل' },
  { value: '/model', label: '/model', desc: 'كل النماذج المثبتة تعمل — xkiro + oc مجاناً' },
  { value: '/apikey', label: '/apikey', desc: 'إعداد مفتاح API · xkiro.com' },
  { value: '/compact', label: '/compact', desc: 'ضغط الذاكرة إلى ملخص أقسام · يعمل تلقائياً' },
  { value: '/setup', label: '/setup', desc: 'إعادة صفحة الإعداد: مفتاح / مزوّد' },
  { value: '/session', label: '/session', desc: 'المحادثات · فتح قديمة أو جديدة' },
  { value: '/theme', label: '/theme', desc: 'تبديل الثيم · يُحفظ فوراً' },
  { value: '/clear', label: '/clear', desc: 'إعادة ضبط المحادثة' },
  { value: '/config', label: '/config', desc: 'إعدادات config.json / config.toml' },
  { value: '/prompt', label: '/prompt', desc: 'ملف البرومت · نحّي نظام NEO لموضوعك' },
  { value: '/info', label: '/info', desc: 'تفاصيل الجلسة' },
  { value: '/update', label: '/update', desc: 'التحقق من التحديث · الترقية التلقائية' },
  { value: '/help', label: '/help', desc: 'مساعدة واختصارات' },
  { value: '/web', label: '/web', desc: 'تشغيل neo web' },
  { value: '/exit', label: '/exit', desc: 'إنهاء البرنامج' },
];
let palette = null;

function paletteMatches(q) {
  const s = q.toLowerCase().trim();
  if (!s) return COMMANDS;
  return COMMANDS.filter((c) => (c.value + ' ' + c.label + ' ' + c.desc).toLowerCase().includes(s));
}
function showPalette(q) { palette = { items: paletteMatches(q), sel: 0, q }; renderConv(); }
function closePalette() {
  if (!palette) return;
  palette = null;
  SCREEN = null; rebuildLog(); renderConv(); drawLower();
}
/* the "/" command palette renders as an overlay on TOP of the conversation
   area — it goes through renderConv (like every other row) so a repaint can
   never wipe it or leave it desynced/wedged. Rows fill the exact cell width;
   padLine adds the trailing theme background. */
function paletteRows() {
  if (!palette) return null;
  const maxR = Math.max(3, convRows() - 1);
  const all = palette.items;
  const s0 = Math.max(0, palette.sel - (maxR - 1));
  const shown = all.slice(s0, s0 + maxR);
  const over = all.length - s0 - shown.length;
  const ac = modeColor();
  const out = [];
  const headTxt = ' Commands — الأوامر' + (over > 0 ? C.dimt + '   +' + over + ' أكثر ↑↓' : '');
  const L = ac + '╭' + C.n + C.panel + C.bold + headTxt + C.n;
  const R = C.dimt + '  ↑↓ ⏎ esc  ' + C.n + ac + '╮' + C.n;
  const lw = wlen(stripAnsi(L)), rw = wlen(stripAnsi(R));
  out.push(C.panel + L + ' '.repeat(Math.max(0, COL() - 1 - lw - rw)) + R);
  if (!shown.length) {
    const body = C.dimt + 'لا توجد نتائج — امسح النص لمشاهدة كل الأوامر' + C.n;
    const bw = wlen(stripAnsi(body));
    out.push(C.panel + ac + '│' + C.n + ' ' + body + ' '.repeat(Math.max(0, COL() - 4 - bw)) + ' ' + ac + '│' + C.n);
  } else {
    for (let i = 0; i < shown.length && out.length < maxR; i++) {
      const it = shown[i];
      const active = s0 + i === palette.sel;
      const val = active ? C.bold + it.value + C.n : it.value;
      const mark = active ? C.accent + '❯ ' + C.n : '  ';
      const row = mark + (active ? C.text : C.dimt) + val + C.n + C.dimt + '   ' + it.desc + C.n;
      const body = truncateFmt(row, Math.max(4, COL() - 4));
      const bgc = active ? C.element : C.panel;
      out.push(bgc + ac + '│' + C.n + ' ' + body + ' '.repeat(Math.max(0, COL() - 4 - wlen(stripAnsi(body)))) + ' ' + ac + '│' + C.n);
    }
  }
  if (out.length < maxR) {
    out.push(C.panel + ac + '╰' + C.n + C.dimt + '─'.repeat(Math.max(1, COL() - 3)) + C.n + ac + '╯' + C.n);
  }
  return out;
}
function paletteNav(dir) {
  if (!palette || !palette.items.length) return false;
  palette.sel = (palette.sel + dir + palette.items.length) % palette.items.length;
  renderConv();
  return true;
}
function paletteEnter() {
  if (!palette) return false;
  const typed = '/' + (palette.q || '');
  const it = palette.items.length ? (palette.items[palette.sel] || palette.items[0]) : null;
  const multi = palette.items.length === 1 && typed.split(/\s+/).length > 1 && it && it.value.split(' ')[0] === typed.split(' ')[0];
  palette = null;
  if (!it) {
    // no matching command → consume Enter, clear the "/…" draft, stay put
    editor.buf = ''; editor.pos = 0;
    SCREEN = null; rebuildLog(); renderConv(); drawLower(); editor.draw();
    return true;
  }
  editor.resolveValue(multi ? typed : it.value);
  return true;
}

/* ── ESC model: closes the "/" palette or pickers, otherwise stops the AI
     immediately — no warning message ── */
let abortState = null;   // { flag } for the currently running turn
let turnAbort = null;    // AbortController for the running turn
let interruptWatcher = null;

function cancelGeneration() {
  if (abortState) abortState.flag = true;
  if (turnAbort) turnAbort.abort();
  if (abortState || turnAbort) setStatus('⛔  Stopping…', C.amber);
}
function onEscPress() {
  if (palette) {
    // close the palette AND clear the partial "/…" draft (like opencode)
    palette = null;
    editor.buf = ''; editor.pos = 0;
    SCREEN = null; rebuildLog(); renderConv(); drawLower(); editor.draw();
    return; // ESC closes the command palette
  }
  cancelGeneration();                                              // ESC stops the AI right away
}

/* during a run the editor has no listener, so install a raw watcher that
   catches ESC presses (ignoring arrow / function-key sequences) */
function installInterruptWatcher() {
  stopInterruptWatcher();
  interruptWatcher = (d) => {
    const s = d.toString('utf8');
    if (s.indexOf('\x1b[') !== -1) return;   // arrow / function keys
    if (s.indexOf('\x1b') !== -1) onEscPress();
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', interruptWatcher);
}
function stopInterruptWatcher() {
  if (interruptWatcher) {
    process.stdin.removeListener('data', interruptWatcher);
    interruptWatcher = null;
  }
}

/* ── run one turn ────────────────────────────────────────────── */
function applyAgentEvent(ev) {
  if (ev.type === 'context_gc') {
    const a = ensureAssistant();
    a.parts.push({ type: 'note', text: 'Ctx: تم تجاهل ' + ev.dropped + ' رسالة قديمة — الجلسة طويلة جداً' });
    rebuildLog();
    renderConv();
    drawLower();
  } else if (ev.type === 'iteration') {
    startStatusSpinner('Thinking…', C.amber);
  } else if (ev.type === 'reasoning_done') {
    dropStatusTimer();
    if (ev.content) {
      const a = ensureAssistant();
      a.parts.push({ type: 'thinking', text: ev.content });
      rebuildLog();
      renderConv();
      drawLower();
    }
  } else if (ev.type === 'text') {
    streamChunk(ev.content);
  } else if (ev.type === 'todo') {
    const a = ensureAssistant();
    const key = String(ev.key || '');
    let part = a.parts.find((p) => p.type === 'todo' && p.key === key);
    if (!part) { part = { type: 'todo', key, content: String(ev.content || ''), status: 'pending' }; a.parts.push(part); }
    else {
      if (ev.status === 'completed') part.status = 'completed';
      if (ev.content) part.content = String(ev.content);
    }
    rebuildLog();
    renderConv();
    drawLower();
  } else if (ev.type === 'tool_start') {
    if (ev.name !== 'todo_update') printToolStart(ev);
  } else if (ev.type === 'tool_done') {
    if (ev.name !== 'todo_update') printToolDone(ev);
  } else if (ev.type === 'usage') {
    tokensUsage = { prompt: ev.prompt_tokens || 0, completion: ev.completion_tokens || 0, total: ev.total_tokens || 0 };
    drawStatusLine();
  } else if (ev.type === 'question') {
    showQuestionPage(ev).catch(() => {});
  } else if (ev.type === 'compacted') {
    const a = ensureAssistant();
    a.parts.push({ type: 'note', text: '🧠 ذاكرة مضغوطة تلقائياً — ' + ev.dropped + ' رسالة ← ملخص' + (ev.kept ? ' · بقي ' + ev.kept + ' حديثة كما هي' : '') });
    a.parts.push({ type: 'compact', text: ev.summary });
    rebuildLog();
    renderConv();
    drawLower();
    setStatus('🧠 Memory compacted — سيكمل من الملخص', C.amber);
  }
}

async function runTurn(cmd) {
  const emit = (ev) => applyAgentEvent(ev);

  try {
    BUSY = true;
    drawLower();
    setStatus('Waiting for ' + modelName() + '…', C.dimt);
    abortState = { flag: false };
    turnAbort = new AbortController();
    const res = await runAgent(messages(), emit, { isAborted: () => abortState.flag, signal: turnAbort.signal });
    if (res && res.aborted) {
      endStream();
      dropStatusTimer();
      const a = lastAssistant();
      if (a) {
        const p = [...a.parts].reverse().find((x) => x.type === 'text');
        if (p) p.text += '  ⏹';
      }
      rebuildLog();
      renderConv();
      drawLower();
      setStatus('⛔  Stopped', C.amber);
    } else {
      endStream();
      dropStatusTimer();
      setStatus('✓  Done', C.green);
      drawLower();
    }
  } catch (e) {
    endStream();
    dropStatusTimer();
    const a = ensureAssistant();
    a.parts.push({ type: 'text', text: '✕ ' + e.message });
    rebuildLog();
    renderConv();
    drawLower();
    setStatus('✕  Error', C.red);
  }
  saveCurrent();
  abortState = null;
  turnAbort = null;
  BUSY = false;
  drawLower();
  drawStatusLine();
}

/* ── state → API messages used by runAgent (plain role/content pairs,
   mirroring how opencode sends the conversation thread) ── */
function messages() {
  const out = [];
  for (const m of MSGS) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const content = m.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (content) out.push({ role: 'assistant', content });
    }
  }
  return out;
}

/* ── splash (art fills the conversation area; input is fixed at bottom) ── */
function drawSplash() {
  const n = convRows();
  const total = SPLASH_ART.length + 5;
  const padTop = Math.max(1, Math.floor((n - total) / 2));
  MSGS = [{ role: 'splash', parts: [{ type: '_splash', padTop }] }];
  paint();
}

/* ── /compact — ضغط يدوي للمحادثة الكبيرة إلى ملخص أقسام ── */
async function manualCompact() {
  const msgs = messages();
  if (msgs.length < 2) { setStatus('المحادثة قصيرة — لا تحتاج ضغط', C.amber); return; }
  setStatus('🧠 Compacting…', C.amber);
  drawStatusLine();
  try {
    const r = await runCompact(SYSTEM_PROMPT, msgs, {});
    if (!r.summary) throw new Error('summary was empty');
    const oldLen = MSGS.length;
    const compactMsg = { role: 'assistant', parts: [{ type: 'note', text: '🧠 تم ضغط الذاكرة يدوياً — ' + oldLen + ' رسالة ← ملخص + ' + r.kept.length + ' حديثة' }, { type: 'compact', text: r.summary }] };
    const kept = r.kept.map((m) => (m.role === 'user'
      ? { role: 'user', text: String(m.content) }
      : { role: 'assistant', parts: [{ type: 'text', text: String(m.content) }] }));
    MSGS = [compactMsg, ...kept];
    tokensUsage = { prompt: 0, completion: 0, total: 0 };
    rebuildLog(); renderConv(); drawLower();
    setStatus('✓ ذاكرة مضغوطة: ' + oldLen + ' ← ملخص + ' + r.kept.length + ' حديثة', C.green);
  } catch (e) {
    setStatus('✕ فشل الضغط: ' + e.message, C.red);
  }
}

async function handleCommand(cmd) {
  const bare = cmd.trim().split(/\s+/)[0];
  const rest = cmd.trim().slice(bare.length).trim();
  if (bare === '/help') {
    const a = ensureAssistant();
    a.parts.push({
      type: 'text',
      text: '/help   مساعدة واختصارات\n/model   كل النماذج تعمل — اختر من قائمة واحدة (xkiro + oc مجاناً)\n/apikey  إعداد مفتاح API — xkiro.com/dashboard/api/keys\n/compact ضغط الذاكرة يدوياً إلى ملخص أقسام (أو تلقائياً عند الاقتراب من الحد)\n/setup  إعادة صفحة الإعداد (مفتاح أو مزوّد خارجي)\n/plan    وضع الخطة — يخطّط + TODO بدون تنفيذ (أصفر)\n/build   وضع التنفيذ — ينفّذ فوراً (بنفسجي)\n/session  المحادثات · فتح قديمة أو جديدة\n/theme   تبديل الثيم (يُحفظ فوراً)\n/config  إعدادات الملف config.json/.toml\n/clear   إعادة ضبط المحادثة\n/info    تفاصيل الجلسة\n/update  التحقق من التحديث · ترقية تلقائية\n/web     تشغيل neo web\n/exit    إنهاء\n\nاختصارات:\nTAB     يبدّل Build ⇄ Plan (لون الصندوق يتغيّر)\n/  تظهر قائمة الأوامر أثناء الكتابة\nctrl+p  تفتح قائمة الأوامر مباشرة\nESC   يوقف الرد فوراً ⏹ + يغلق اللوحات والحوارات\n↑ ↓   تنقل داخل القوائم والحوارات\n\nإعدادات: ~/.neo/config.json · أو config.jsonc / config.toml\nمفاتيح: theme, mode, model, apiBase, apiKey, maxContext, workdir',
    });
    rebuildLog(); renderConv(); drawLower();
  } else if (bare === '/clear') {
    saveCurrent();
    MSGS = [];
    scrollOff = 0;
    tokensUsage = { prompt: 0, completion: 0, total: 0 };
    paint();
  } else if (bare === '/info') {
    const a = ensureAssistant();
    a.parts.push({
      type: 'text',
      text: `## تحديثات الجلسة\n\n- **model**:   ${modelName()}\n- **api**:     ${modelName().includes('-free') || modelName() === 'big-pickle' ? 'opencode zen (oc)' : modelName().includes('/') ? 'xkiro' : stripAnsi(getApiBase())}\n- **workdir**: ${WORKDIR}\n- **context**: ${fmt(modelCtxLimit())} tokens (ضغط تلقائي عند ~80%)\n- **os**:      ${os.platform()} ${os.release()}\n- **session**: ${SESSION_ID}\n- **theme**:   ${themeName()}\n- **mode**:    ${modeKey()}\n- **apiKey**:  ${getApiKey() || 'غير مضبوط — اكتب /apikey أو افتح /setup'}`,
    });
    rebuildLog(); renderConv(); drawLower();
  } else if (bare === '/exit' || bare === '/quit') {
    saveCurrent();
    bye();
    process.exit(0);
  } else if (bare === '/web') {
    const a = ensureAssistant();
    a.parts.push({ type: 'text', text: 'neo web --hostname 0.0.0.0 --port 3000' });
    rebuildLog(); renderConv(); drawLower();
  } else if (bare === '/session') {
    await showSessions();
  } else if (bare === '/compact') {
    await manualCompact();
  } else if (bare === '/setup') {
    await welcomeGate();
  } else if (bare === '/update') {
    await doUpdate({ manual: true });
  } else if (bare === '/theme') {
    if (rest) {
      if (listThemes().includes(rest)) {
        applyTheme(rest);
        cfgmod.save({ theme: rest });
        SCREEN = null; paint(); setStatus('Theme saved: ' + themeLabel(rest), C.green);
      } else {
        setStatus('Console: unknown theme → try: ' + listThemes().join(', '), C.red);
      }
    } else await showThemePicker();
  } else if (bare === '/plan') {
    applyMode('plan');
  } else if (bare === '/build') {
    applyMode('build');
  } else if (bare === '/mode') {
    applyMode(getMode() === 'plan' ? 'build' : 'plan');
  } else if (bare === '/model') {
    await showModels();
  } else if (bare === '/apikey' || bare === '/key') {
    await showApiKey();
  } else if (bare === '/config' || bare === '/cfg') {
    const file = cfgmod.activeFile() || cfgmod.JSON_FILE + ' (أنشئه)';
    const a = ensureAssistant();
    a.parts.push({
      type: 'text',
      text: `file:     ${file}\nformat:   .json / .jsonc / .toml\nkeys:     theme, model, mode, apiBase, apiKey, maxContext, workdir, promptFile\ncurrent:  theme=${themeName()}, model=${modelName()}, context=${(MAX_CONTEXT / 1048576).toFixed(0)}M, workdir=${WORKDIR}`,
    });
    rebuildLog(); renderConv(); drawLower();
  } else if (bare === '/prompt' || bare === '/system' || bare === '/sys') {
    showPromptInfo();
  } else {
    const a = ensureAssistant();
    a.parts.push({ type: 'text', text: 'آمر غير معروف → /help' });
    rebuildLog(); renderConv(); drawLower();
  }
}

async function main() {
  try {
    const cf = cfgmod.load();
    if (cf.theme && listThemes().includes(cf.theme)) applyTheme(cf.theme);
    if (cf.mode === 'plan' || cf.mode === 'build') setMode(cf.mode);
  } catch {}
  applyTheme();
  termBegin();
  /* welcome gate — قبل صفحة المحادثة: Use API key / Connect provider / Exit */
  if (getApiKey() === '') {
    const ok = await welcomeGate();
    if (!ok) {
      bye();
      process.exit(0);
    }
  }
  restoreActiveSession();
  paint();
  if (!MSGS.length) drawSplash();

  /* tell the user when this run was just upgraded (set by the updater) */
  if (process.env.NEO_UPDATED_FROM) {
    const a = ensureAssistant();
    a.parts.push({ type: 'update', text: '✔ تم الترقية تلقائياً v' + process.env.NEO_UPDATED_FROM + ' → v' + appVersion() + ' ✨ أحدث إصدار', ok: true });
    rebuildLog(); renderConv();
  }

  /* auto-update check (silent, non-blocking) + periodic fresh-check */
  doUpdate();
  setInterval(periodicUpdateCheck, 45 * 60 * 1000).unref();

  process.on('SIGINT', () => {
    bye();
    try { process.stdin.setRawMode(false); } catch {}
    process.exit(0);
  });

  // full repaint on terminal resize (soft keyboard, window changes) — like opencode
  process.stdout.on('resize', () => {
    SCREEN = null;
    paint();
  });

  editor.onChange = (buf) => {
    const t = buf.trim();
    if (t.startsWith('/')) { showPalette(t.slice(1)); }
    else if (palette) closePalette();
  };
  editor.onNavDir = (dir) => paletteNav(dir);
  editor.onPaletteEnter = () => paletteEnter();
  editor.onEscPress = () => onEscPress();
  editor.onPaletteShortcut = () => {
    if (palette) closePalette();
    else { showPalette(''); }
  };
  editor.onModeToggle = toggleMode;
  editor.onScrollPage = (dir) => scrollPage(dir);
  editor.onWheel = (dir) => scrollBy(dir);

  return new Promise((resolve) => {
    (async function loop() {
      while (true) {
        const line = await editor.readLine();
        if (line === null) { bye(); process.exit(0); }
        const cmd = line.trim();
        if (!cmd) { drawLower(); continue; }

        if (MSGS.length === 1 && MSGS[0].role === 'splash') { MSGS = []; paint(); }

        if (cmd.startsWith('/')) { await handleCommand(cmd); }
        else {
          scrollOff = 0;
          MSGS.push({ role: 'user', text: cmd, color: null });
          rebuildLog();
          renderConv();
          drawLower();
          installInterruptWatcher();
          await runTurn(cmd);
          stopInterruptWatcher();
        }
        drawLower();
      }
    })().then(resolve);
  });
}

module.exports = {
  main,
  ...(process.env.NEO_TUI_TEST === '1'
    ? {
        getLOG: () => LOG.slice(),
        getMSGS: () => JSON.parse(JSON.stringify(MSGS)),
        __rebuild: (msgs) => { MSGS = msgs; rebuildLog(); renderConv(); return LOG.slice(); },
      }
    : {}),
};