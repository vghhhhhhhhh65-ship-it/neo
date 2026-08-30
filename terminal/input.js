'use strict';

const { C, stripAnsi } = require('./ansi');

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

  /* ── input line inside the opencode-style box (left ┃ comes from footer):
        ┃  ❯ text …  [padded with element bg to the right edge] */
  rowText() {
    const W = Math.max(8, this.barW || (this.maxWidth + 6));
    const acc = (this.accent && this.accent()) || C.border;
    const prefix = '  ' + acc + '┃' + C.n + '  '; // visible 5
    const headLen = stripAnsi('❯ ').length;
    const room = Math.max(1, W - 5 - headLen);
    const raw = this.buf.slice(0, room);
    const clipped = this.buf.length > raw.length;
    const head = acc + C.bold + '❯ ' + C.n;
    const tail = raw ? C.text + raw + (clipped ? acc + '…' + C.n : C.n)
      : C.dimt + this.placeholder + C.n;
    const padN = Math.max(0, W - 5 - headLen - (raw ? raw.length : this.placeholder.length));
    return prefix + head + tail + ' '.repeat(padN);
  }

  draw() {
    let head = '';
    if (this.row) head = `\x1b[${this.row};1H`;
    else if (this.initGoto) { head = this.initGoto; this.initGoto = null; }
    else head = '\r';
    const line = this.rowText();
    process.stdout.write(head + C.element + '\x1b[2K' + line + C.reset);
    const caret = 7 + this.pos; // '  ┃  ❯ ' → caret index within the row
    if (this.pos < this.buf.length) process.stdout.write(CSI + (stripAnsi(line).length - caret) + 'D');
  }

  stop() {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    this.done = true;
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
      if (this.pos < this.buf.length) { this.buf = this.buf.slice(0, this.pos) + this.buf.slice(this.pos + 1); this.draw(); this.tick(); }
      return true;
    }
    if (seq === KEY.BACK || seq === '\x7f') {
      if (this.pos > 0) { this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos); this.pos--; this.draw(); this.tick(); }
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
    if (ch === KEY.CTRL_U) { this.buf = ''; this.pos = 0; this.draw(); this.tick(); return true; }
    if (ch === KEY.CTRL_K) { this.buf = this.buf.slice(0, this.pos); this.draw(); this.tick(); return true; }
    if (ch === KEY.CTRL_W) {
      const before = this.buf.slice(0, this.pos);
      const m = before.match(/^(.*?)\S+\s*$/);
      const cut = m ? m[1].length : 0;
      this.buf = before.slice(0, cut) + this.buf.slice(this.pos);
      this.pos = cut;
      this.draw(); this.tick();
      return true;
    }
    if (ch === KEY.CTRL_A) { this.pos = 0; this.draw(); return true; }
    if (ch === KEY.CTRL_E) { this.pos = this.buf.length; this.draw(); return true; }
    if (ch === KEY.BACK) {
      if (this.pos > 0) { this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos); this.pos--; this.draw(); this.tick(); }
      return true;
    }
    if (ch === '\r' || ch === '\n') {
      if (this.onPaletteEnter && this.onPaletteEnter()) return false;
      this.submit();
      return false;
    }
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