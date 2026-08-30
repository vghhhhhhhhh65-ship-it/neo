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

/* fit a string to a max width (keep the head, append …) — no ANSI inside */
function fitRight(s, maxW) {
  if (wlen(s) <= maxW) return s;
  let out = '', w = 0;
  for (const ch of s) {
    const cw = wlen(ch);
    if (w + cw > maxW - 1) break;
    out += ch; w += cw;
  }
  return out + '…';
}
/* fit a string to a max width (keep the tail, prepend …) — for long prefixes */
function fitLeft(s, maxW) {
  if (wlen(s) <= maxW) return s;
  let out = s, w = wlen(s);
  while (w > maxW - 1 && out.length) { w -= wlen(out[0]); out = out.slice(1); }
  return '…' + out;
}

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
    this.pasteMode = false;     // showing the [Pasted ~N lines] box in the field
    this.pasteLines = 0;        // number of lines in the pasted block
    this.pasteStart = 0;        // raw start of the pasted block inside buf
    this.pasteEnd = 0;          // raw end of the pasted block inside buf
    this.pasteHeadW = 0;        // display width of the box before typed text (caret anchor)
    this.escLast = 0;           // last ESC press time (double-ESC clears the field)
    this.onEscCleared = null;   // double-ESC hook (field was cleared)
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
    /* inline [Pasted ~N lines] box: the pasted text itself lives at the END of
       the buffer; the box shows its line count + the first line of content.
       Any text typed after the paste is shown beside the box. */
    if (this.pasteMode && this.pasteLines > 0) {
      return this.pasteRow(raw, W, acc, room);
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

  /* render the field when a paste block is active: a small rectangular box
     "[Pasted ~N lines] · first-line…" representing the pasted lines, with any
     bonus text the user typed after the paste shown beside the box */
  pasteRow(raw, W, acc, room) {
    const tot = this.pasteLines;
    const start = this.pasteStart;
    const end = this.pasteEnd || 0;
    const pasted = raw.slice(start, end);
    const first = (pasted.split('\n').find((l) => l.trim()) || '').slice(0, 40);
    /* the box itself */
    const box = C.blue + C.bold + '[' + C.n + C.border + C.bold + 'Pasted ~' + C.n
      + C.text + tot + C.n + C.border + C.bold + ' lines' + C.n + C.blue + C.bold + ']' + C.n;
    const wBox = wlen('[Pasted ~' + tot + ' lines]');
    const roomLeft = Math.max(1, room - wBox - 4);
    /* preview of the first pasted line + anything typed after the box */
    const prev = first ? C.n + C.dimt + ' · ' + C.n + C.text + fitRight(first, Math.max(4, roomLeft - 2)) : '';
    const typed = raw.slice(end);
    const extra = typed ? C.n + ' ' + C.text + fitRight(typed, roomLeft) : '';
    const body = box + prev + extra;
    this.pasteHeadW = wlen(stripAnsi(box + prev)); // display width before typed text (caret anchor)
    this.pasteBodyW = wlen(stripAnsi(body));       // display width of the whole body
    const wB = this.pasteBodyW;
    const pad = Math.max(0, W - 8 - wB);
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
    /* caret column: normal = 5 + raw pos; in paste mode the box compresses the
       pasted block (raw [pasteStart..pasteEnd]) into one visual unit, so the
       caret sits after the box and any typed text beside it */
    let caret;
    if (this.pasteMode && this.pos > 0) {
      if (this.pos <= this.pasteEnd) caret = 5 + this.pasteHeadW;          // inside/at the box → end of box
      else caret = 5 + this.pasteHeadW + 1 + (this.pos - this.pasteEnd);   // typed text after the box
    } else {
      caret = 5 + this.pos;
    }
    const lineLen = stripAnsi(line).length;
    caret = Math.min(caret, Math.max(1, lineLen - 1)); // never run off the right rail
    const d = Math.max(0, lineLen - caret);
    if (this.pos < this.buf.length && d > 0) process.stdout.write(CSI + d + 'D');
  }

  stop() {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    this.done = true;
  }

  /* insert a multi-line paste at once (single redraw → no freeze):
     the pasted block is appended at the END of the buffer, right where the
     caret sits, then the field renders it as a compact rectangular box
     "[Pasted ~N lines] · first-line…". Text typed afterwards appends beside
     the box (raw position after pasteEnd). One backspace on the box deletes
     the whole box like a single character. */
  insertPaste(str) {
    const norm = String(str).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const start = this.buf.length;
    this.buf = this.buf + norm;
    this.pos = this.buf.length;
    this.pasteMode = true;
    this.pasteLines = norm.split('\n').length;
    this.pasteStart = start;
    this.pasteEnd = start + norm.length;
    this.draw();
    this.tick();
  }

  clearPasteMode() {
    this.pasteMode = false;
    this.pasteLines = 0;
    this.pasteStart = 0;
    this.pasteEnd = 0;
    this.pasteHeadW = 0;
  }

  /* clear the whole field (double-ESC or deleting the paste box) */
  clearField() {
    this.buf = '';
    this.pos = 0;
    this.pasteMode = false;
    this.pasteLines = 0;
    this.pasteStart = 0;
    this.pasteEnd = 0;
    this.pasteHeadW = 0;
    this.draw();
    this.tick();
    if (this.onEscCleared) this.onEscCleared();
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

  /* backspace: if the caret is at/inside the paste box, delete the WHOLE box
     as a single unit ("مربع مثل حرف"); otherwise delete one typed char
     (keeping the box when deleting text typed BESIDE it) */
  backspace() {
    if (this.pasteMode && this.pos <= this.pasteEnd && this.pos > this.pasteStart && this.pasteEnd > this.pasteStart) {
      this.buf = this.buf.slice(0, this.pasteStart) + this.buf.slice(this.pasteEnd);
      this.pos = this.pasteStart;
      this.clearPasteMode();
      this.draw(); this.tick();
      return true;
    }
    if (this.pos > 0) {
      this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos);
      this.pos--;
      if (!this.pasteMode) this.clearPasteMode();
      this.draw(); this.tick();
    }
    return true;
  }

  /* forward delete: inside the paste box → delete the whole box; after the
     box → delete a typed char beside it (keeping the box) */
  delChar() {
    if (this.pasteMode && this.pos < this.pasteEnd && this.pos >= this.pasteStart && this.pasteEnd > this.pasteStart) {
      this.buf = this.buf.slice(0, this.pasteStart) + this.buf.slice(this.pasteEnd);
      this.pos = this.pasteStart;
      this.clearPasteMode();
      this.draw(); this.tick();
      return true;
    }
    if (this.pos < this.buf.length) {
      this.buf = this.buf.slice(0, this.pos) + this.buf.slice(this.pos + 1);
      if (!this.pasteMode) this.clearPasteMode();
      this.draw(); this.tick();
    }
    return true;
  }

  /* single ESC: track timing; second ESC shortly after with a full field
     clears the whole field (feature: "ESC مرتين يحذف كامل الحقل") */
  pressEsc() {
    const now = Date.now();
    if (this.buf && now - this.escLast < 500) {
      this.escLast = 0;
      this.clearField();
      return true;
    }
    this.escLast = now;
    if (this.onEscPress) this.onEscPress();
    return true;
  }

  /* returns false → stop all further input processing */
  keySeq(seq) {
    if (seq === ESC) return this.pressEsc();
    if (seq === '\x1b\x1b') { // fast double-ESC merged into one chunk
      if (this.buf) this.clearField();
      else if (this.onEscPress) this.onEscPress();
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
    if (seq === KEY.DEL) return this.delChar();
    if (seq === KEY.BACK || seq === '\x7f') return this.backspace();
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
      return this.backspace();
    }
    if (ch === '\r' || ch === '\n') {
      if (this.onPaletteEnter && this.onPaletteEnter()) return false;
      this.submit();
      return false;
    }
    /* typing while the paste box is shown: new text goes BESIDE the box
       (the box and its raw region stay untouched) */
    if (!(this.pasteMode && this.pos >= this.pasteEnd)) this.clearPasteMode();
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