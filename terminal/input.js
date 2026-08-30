'use strict';

const { C, stripAnsi, wlen } = require('./ansi');

const CSI = '\x1b[';

const KEY = {
  UP: '\x1b[A', DOWN: '\x1b[B', RIGHT: '\x1b[C', LEFT: '\x1b[D',
  HOME: '\x1b[H', END: '\x1b[F', DEL: '\x1b[3~',
  PGUP: '\x1b[5~', PGDN: '\x1b[6~',
  CTRL_A: '\x01', CTRL_E: '\x05', CTRL_C: '\x03', CTRL_D: '\x04',
  CTRL_U: '\x15', CTRL_K: '\x0b', CTRL_W: '\x17',
  BACK: '\x7f',
};
const ESC = '\x1b';

/* Minimal line editor — draws a single WhatsApp-style input row (no box).
   Caller positions the cursor; draw() redraws the current line in place. */
class LineEditor {
  constructor() {
    this.buf = '';
    this.pos = 0;
    this.prompt = '❯ ';
    this.placeholder = 'Ask anything…';
    this.history = [];
    this.histIdx = -1;
    this.histDraft = '';
    this.done = false;
    this.resolveFn = null;
    this.maxWidth = 78;
    this.barW = null;       // full row width of the input line
    this.initGoto = null;
    this.onChange = null;
    this.onNavDir = null;       // up/down arrow hook (command palette)
    this.onPaletteEnter = null; // Enter hook when palette is open
    this.onModeToggle = null;   // TAB hook — switch build ⇄ plan mode
    this.onEscPress = null;     // ESC key hook (hint / stop / close palette)
    this.onScrollPage = null;   // PgUp/PgDn hook → in-app scroll
    this.onWheel = null;        // mouse wheel hook → dir = -1 / +1
    this.pickerHandler = null;  // modal picker (sessions / theme) key routing
    this.pickerResolve = null;
    this.accent = () => C.border; // live accent (box border + prompt) color fn
    this.pasting = false;       // collecting a bracketed paste \x1b[200~ … \x1b[201~
    this.pasteMode = false;     // showing the multi-line paste badge
    this.pasteLines = 0;        // number of lines in the pasted block
  }

  setPrompt(p) { this.prompt = p; }
  setPlaceholder(p) { this.placeholder = p; }
  setMaxWidth(w) { this.maxWidth = Math.max(8, w); }

  gotoAt(row, col) {
    this.initGoto = `\x1b[${row};${col}H`;
    this.draw();
  }

  setRow(row) {
    this.row = row;
  }

  /* ── input line inside the enclosed opencode-style box — full width:
        │  ❯ text …  pad …  │
        left rail col1 · prompt col4-5 · text from col6 · right rail col W-1
        the whole row is one continuous element-bg strip; caret math in
        draw() assumes the ASCII rails below. ── */
  rowText() {
    const W = Math.max(12, this.barW || (this.maxWidth + 6));
    const acc = (this.accent && this.accent()) || C.border;
    const room = Math.max(1, W - 8);
    const raw = this.buf || '';
    /* multi-line paste → collapse into a single compact badge with line count */
    if (this.pasteMode && raw.includes('\n')) {
      const tot = raw.split('\n').length;
      const first = raw.split('\n')[0].slice(0, Math.max(1, room - 22));
      const badge = C.blue + C.bold + '📄 لصق ' + C.n + C.text + first + C.n + C.dimt + ' …' + '  (' + tot + ' سطر)' + C.n;
      const wB = wlen(stripAnsi(badge));
      const pad = Math.max(0, W - 8 - wB);
      return acc + '│' + C.n + '  '
        + acc + C.bold + '› ' + C.n
        + badge
        + ' '.repeat(pad) + ' '
        + acc + '│' + C.n + ' ';
    }
    const clipped = raw.length > room;
    const shown = clipped ? raw.slice(0, room - 1) + '…' : raw;
    const ph = this.placeholder;
    const shownPh = wlen(ph) > room - 3 ? ph.slice(0, Math.max(1, room - 4)) + '…' : ph;
    const wT = wlen(shown || shownPh);
    const pad = Math.max(0, W - 8 - wT);
    const body = (this.buf ? C.text + shown + C.n : C.dimt + shownPh + C.n);
    return acc + '│' + C.n + '  '
      + acc + C.bold + '› ' + C.n
      + body
      + ' '.repeat(pad) + ' '
      + acc + '│' + C.n + ' ';
  }

  draw() {
    let head = '';
    if (this.row) head = `\x1b[${this.row};1H`;
    else if (this.initGoto) { head = this.initGoto; this.initGoto = null; }
    else head = '\r';
    const line = this.rowText();
    process.stdout.write(head + C.element + '\x1b[2K' + line + C.reset);
    const caret = 5 + this.pos; // '│  › ' → border col1, › col4-5, text starts col6
    const d = Math.max(0, stripAnsi(line).length - caret);
    if (this.pos < this.buf.length && d > 0) process.stdout.write(CSI + d + 'D');
  }

  stop() {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    this.done = true;
  }

  /* insert a multi-line paste at once (single redraw → no freeze) and switch
     the field to the compact "📄 لصق N سطر" badge until the user edits it */
  insertPaste(str) {
    const norm = String(str).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.buf = this.buf.slice(0, this.pos) + norm + this.buf.slice(this.pos);
    this.pos += norm.length;
    this.pasteMode = true;
    this.pasteLines = norm.split('\n').length;
    this.draw();
    this.tick();
  }

  clearPasteMode() {
    this.pasteMode = false;
    this.pasteLines = 0;
  }

  readLine() {
    return new Promise((resolve) => {
      if (!process.stdin.isTTY) {
        let data = '';
        process.stdin.on('data', (c) => (data += c));
        process.stdin.on('end', () => resolve(data));
        process.stdin.resume();
        return;
      }
      this.done = false;
      this.buf = '';
      this.pos = 0;
      this.pasting = false;
      this.clearPasteMode();
      this.resolveFn = resolve;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (d) => this.handleData(d));
      this.draw();
    });
  }

  submit() {
    const line = this.buf;
    if (line.trim()) this.history.push(line);
    this.histIdx = this.history.length;
    this.histDraft = '';
    this.clearPasteMode();
    this.stop();
    process.stdin.removeAllListeners('data');
    this.buf = '';
    this.pos = 0;
    this.draw();
    this.resolveFn(line);
  }

  /* resolve the current readLine with an external value (command palette pick)
     without sending it through the input buffer */
  resolveValue(v) {
    process.stdin.removeAllListeners('data');
    this.stop();
    this.buf = '';
    this.pos = 0;
    this.draw();
    const r = this.resolveFn; this.resolveFn = null;
    if (r) r(v);
  }

  /* ── modal picker: takes over raw input until finishPicker() ── */
  readPicker(handler) {
    return new Promise((resolve) => {
      this.pickerHandler = handler;
      this.pickerResolve = resolve;
      this.done = false;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (d) => this.handleData(d));
    });
  }
  finishPicker(v) {
    this.pickerHandler = null;
    const r = this.pickerResolve; this.pickerResolve = null;
    process.stdin.removeAllListeners('data');
    this.stop();
    if (r) r(v);
  }

  handleData(d) {
    if (this.done) return;
    const s = d.toString('utf8');
    /* ── bracketed paste \x1b[200~ … \x1b[201~ ── collect it fully, then
           insert literally (newlines kept, no accidental submit) ── */
    if (this.pasting) {
      const end = s.indexOf('\x1b[201~');
      if (end === -1) { this.insertPaste(s); return; }
      this.insertPaste(s.slice(0, end));
      this.pasting = false;
      const rest = s.slice(end + 6);
      if (rest) this.handleData(Buffer.from(rest));
      return;
    }
    const bStart = s.indexOf('\x1b[200~');
    if (bStart !== -1) {
      const before = s.slice(0, bStart);
      if (before) this.handleData(Buffer.from(before));
      this.pasting = true;
      const tail = s.slice(bStart + 6);
      if (tail) this.handleData(Buffer.from(tail));
      return;
    }
    /* ── non-bracketed multi-line paste: a burst containing a newline (and
           more than a bare Enter). Insert it whole instead of submitting at
           the first \n — this is what used to freeze the field. ── */
    const isSoleEnter = /^[\r\n]+$/.test(s);
    const hasNL = /[\r\n]/.test(s);
    const isBigSingle = s.length > 400;
    if (!isSoleEnter && (hasNL || isBigSingle) && !this.pickerHandler && s.length > 1) {
      this.insertPaste(s);
      return;
    }
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      /* mouse reports → wheel scrolling / clicks (never reach the editor) */
      if (ch === '\x1b' && s[i + 1] === '[' && s[i + 2] === '<') {
        let j = i + 3;
        while (j < s.length && s[j] !== 'M' && s[j] !== 'm') j++;
        const prm = s.slice(i + 3, j);
        const b = Number(prm.split(';')[0]) || 0;
        if (this.pickerHandler || !this.onWheel) { i = j; continue; }
        if (b === 64) this.onWheel(1);        // wheel up → older log
        else if (b === 65) this.onWheel(-1);  // wheel down → newer log
        i = j;
        continue;
      }
      if (ch === '\x1b' && s[i + 1] === 'M' && i + 4 < s.length) {
        const b = s.charCodeAt(i + 2) - 32;
        if (b === 64) { if (!this.pickerHandler && this.onWheel) this.onWheel(1); }
        else if (b === 65) { if (!this.pickerHandler && this.onWheel) this.onWheel(-1); }
        i += 4;
        continue;
      }
      if (this.pickerHandler) {
        if (ch === '\x1b') {
          let seq = ch;
          i++;
          while (i < s.length) {
            const c = s[i];
            seq += c;
            i++;
            if (c >= 0x40 && c <= 0x7e) break;
          }
          i--;
          if (!this.pickerHandler(seq)) return;
          if (!this.pickerHandler) return;   // picker just resolved — drop trailing bytes
          continue;
        }
        if (!this.pickerHandler(ch)) return;
        if (!this.pickerHandler) return;     // picker just resolved — drop trailing bytes
        continue;
      }
      if (ch === '\x1b') {
        // consume a full escape sequence: ESC [ <params> final-byte
        let seq = ch;
        i++;
        while (i < s.length) {
          const c = s[i];
          seq += c;
          i++;
          if (c >= 0x40 && c <= 0x7e) break;
        }
        i--;
        if (!this.keySeq(seq)) return;
        continue;
      }
      if (!this.key(ch)) return;
    }
  }

  /* returns false → stop all further input processing */
  keySeq(seq) {
    if (seq === ESC) {
      if (this.onEscPress) this.onEscPress();
      return true;
    }
    if (seq === '\x1b\x1b') { // fast double-ESC merged into one chunk
      if (this.onEscPress) this.onEscPress();
      if (this.onEscPress) this.onEscPress();
      return true;
    }
    if (seq === KEY.UP) { if (this.onNavDir) { if (this.onNavDir(-1)) return true; } this.moveHist(-1); return true; }
    if (seq === KEY.DOWN) { if (this.onNavDir) { if (this.onNavDir(1)) return true; } this.moveHist(1); return true; }
    if (seq === KEY.LEFT) { if (this.pos > 0) { this.pos--; this.draw(); } return true; }
    if (seq === KEY.RIGHT) { if (this.pos < this.buf.length) { this.pos++; this.draw(); } return true; }
    if (seq === KEY.HOME) { this.pos = 0; this.draw(); return true; }
    if (seq === KEY.END) { this.pos = this.buf.length; this.draw(); return true; }
    if (seq === KEY.PGUP) { if (this.onScrollPage) this.onScrollPage(1); return true; }
    if (seq === KEY.PGDN) { if (this.onScrollPage) this.onScrollPage(-1); return true; }
    if (seq === KEY.DEL) {
      if (this.pos < this.buf.length) { this.buf = this.buf.slice(0, this.pos) + this.buf.slice(this.pos + 1); this.clearPasteMode(); this.draw(); this.tick(); }
      return true;
    }
    if (seq === KEY.BACK || seq === '\x7f') {
      if (this.pos > 0) { this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos); this.pos--; this.clearPasteMode(); this.draw(); this.tick(); }
      return true;
    }
    return true;
  }

  /* per-char (includes multi-char paste) */
  key(ch) {
    if (ch === KEY.CTRL_C) {
      this.stop();
      process.stdin.removeAllListeners('data');
      process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?1049l' + '\r\n' + C.reset + '^C\n');
      process.exit(0);
      return false;
    }
    if (ch === '\x10') { // ctrl+p → command palette
      if (this.onPaletteShortcut) this.onPaletteShortcut();
      return true;
    }
    if (ch === '\x09') { // TAB → build ⇄ plan mode
      if (this.onModeToggle) this.onModeToggle();
      return true;
    }
    if (ch === KEY.CTRL_D) {
      if (!this.buf) { this.stop(); process.stdin.removeAllListeners('data'); this.resolveFn(null); return false; }
      return true;
    }
    if (ch === KEY.CTRL_U) { this.buf = ''; this.pos = 0; this.clearPasteMode(); this.draw(); this.tick(); return true; }
    if (ch === KEY.CTRL_K) { this.buf = this.buf.slice(0, this.pos); this.clearPasteMode(); this.draw(); this.tick(); return true; }
    if (ch === KEY.CTRL_W) {
      const before = this.buf.slice(0, this.pos);
      const m = before.match(/^(.*?)\S+\s*$/);
      const cut = m ? m[1].length : 0;
      this.buf = before.slice(0, cut) + this.buf.slice(this.pos);
      this.pos = cut;
      this.clearPasteMode();
      this.draw(); this.tick();
      return true;
    }
    if (ch === KEY.CTRL_A) { this.pos = 0; this.draw(); return true; }
    if (ch === KEY.CTRL_E) { this.pos = this.buf.length; this.draw(); return true; }
    if (ch === KEY.BACK) {
      if (this.pos > 0) { this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos); this.pos--; this.clearPasteMode(); this.draw(); this.tick(); }
      return true;
    }
    if (ch === '\r' || ch === '\n') {
      if (this.onPaletteEnter && this.onPaletteEnter()) return false;
      this.submit();
      return false;
    }
    this.clearPasteMode();
    this.buf = this.buf.slice(0, this.pos) + ch + this.buf.slice(this.pos);
    this.pos += ch.length;
    this.draw();
    this.tick();
    return true;
  }

  moveHist(dir) {
    if (!this.history.length) return;
    if (dir === -1) {
      if (this.histIdx > 0) {
        if (this.histIdx === this.history.length) this.histDraft = this.buf;
        this.histIdx--;
        this.buf = this.history[this.histIdx]; this.pos = this.buf.length; this.draw();
      }
    } else {
      if (this.histIdx < this.history.length - 1) { this.histIdx++; this.buf = this.history[this.histIdx]; }
      else { this.histIdx = this.history.length; this.buf = this.histDraft; }
      this.pos = this.buf.length; this.draw();
    }
  }

  tick() {
    if (this.onChange) this.onChange(this.buf);
  }
}

module.exports = { LineEditor };