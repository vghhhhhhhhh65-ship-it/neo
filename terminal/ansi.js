'use strict';

/* opencode TUI palette registry.
   dracula is the default theme; others: github-dark, tokyo-night, gruvbox.
   Colors adapt to the terminal's real capability — some terminals do NOT
   support 24-bit RGB (the \x1b[38;2;r;g;bm sequences get dropped and the UI
   shows only the terminal's dark default). We detect truecolor / 256-color /
   basic ANSI and map every palette color to the closest code the terminal
   actually renders. */

const ANSI16 = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

function rgbTo256(r, g, b) {
  const cube = [0, 95, 135, 175, 215, 255];
  const step = (v) => {
    let best = 0, bd = 1e9;
    for (let i = 0; i < cube.length; i++) { const d = Math.abs(v - cube[i]); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  const ri = step(r), gi = step(g), bi = step(b);
  const cubeIdx = 16 + ri * 36 + gi * 6 + bi;
  const gv = Math.round((r + g + b) / 3);
  const grayIdx = 232 + Math.min(23, Math.max(0, Math.round((gv - 8) / 10)));
  const grayVal = 8 + 10 * Math.min(23, Math.max(0, Math.round((gv - 8) / 10)));
  const d1 = (r - cube[ri]) ** 2 + (g - cube[gi]) ** 2 + (b - cube[bi]) ** 2;
  const d2 = (r - grayVal) ** 2 + (g - grayVal) ** 2 + (b - grayVal) ** 2;
  return d1 <= d2 ? cubeIdx : grayIdx;
}

function rgbTo16(r, g, b) {
  let bi = 0, bd = 1e9;
  for (let i = 0; i < ANSI16.length; i++) {
    const [ar, ag, ab] = ANSI16[i];
    const d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/* how this terminal renders color: colourterm-heavy builds do truecolor;
   256-color terminals get nearest-index; anything else gets basic ANSI */
let COLOR_MODE = null;
function colorMode() {
  if (COLOR_MODE) return COLOR_MODE;
  if (process.env.NEO_COLOR) {
    COLOR_MODE = process.env.NEO_COLOR === '8bit' || process.env.NEO_COLOR === '16' ? process.env.NEO_COLOR : 'truecolor';
    return COLOR_MODE;
  }
  const ct = (process.env.COLORTERM || '').toLowerCase();
  const term = (process.env.TERM || '').toLowerCase();
  if (ct.includes('24bit') || ct.includes('truecolor')) COLOR_MODE = 'truecolor';
  else if (term.includes('256color') || ct.includes('256')) COLOR_MODE = '8bit';
  else COLOR_MODE = '16';
  return COLOR_MODE;
}

function esc(r, g, b, isBg) {
  const m = colorMode();
  if (m === '8bit') { const c = rgbTo256(r, g, b); return isBg ? `\x1b[48;5;${c}m` : `\x1b[38;5;${c}m`; }
  if (m === '16') { const c = rgbTo16(r, g, b); return isBg ? `\x1b[${c < 8 ? 40 + c : 100 + c - 8}m` : `\x1b[${c < 8 ? 30 + c : 90 + c - 8}m`; }
  return isBg ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[38;2;${r};${g};${b}m`;
}

const f = (r, g, b) => esc(r, g, b, false);
const b = (r, g, b) => esc(r, g, b, true);

const PALETTES = {
  'github-dark': {
    name: 'GitHub Dark',
    hexbg: '#0d1117', hexfg: '#c9d1d9',
    text: [201, 209, 217], dimt: [139, 148, 158], gray: [139, 148, 158],
    blue: [88, 166, 255], green: [63, 185, 80], red: [248, 81, 73],
    amber: [227, 179, 65], orange: [210, 153, 34], purple: [188, 140, 255],
    pink: [255, 123, 114], cyan: [57, 197, 207],
    bg: [13, 17, 23], panel: [1, 4, 9], element: [22, 27, 34], border: [48, 54, 61],
    diffAddBg: [24, 54, 35], diffRemBg: [65, 31, 34],
    userBg: [24, 38, 58],
    art1: [188, 140, 255], art2: [88, 166, 255], art3: [210, 153, 34],
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    hexbg: '#1a1b26', hexfg: '#c0caf5',
    text: [192, 202, 245], dimt: [86, 95, 137], gray: [109, 120, 168],
    blue: [122, 162, 247], green: [158, 206, 106], red: [247, 118, 142],
    amber: [224, 175, 104], orange: [255, 158, 100], purple: [187, 154, 247],
    pink: [247, 118, 142], cyan: [125, 207, 255],
    bg: [26, 27, 38], panel: [31, 35, 53], element: [41, 46, 66], border: [62, 70, 101],
    diffAddBg: [55, 66, 53], diffRemBg: [75, 47, 61],
    userBg: [40, 46, 78],
    art1: [187, 154, 247], art2: [122, 162, 247], art3: [255, 158, 100],
  },
  'dracula': {
    name: 'Dracula',
    hexbg: '#282a36', hexfg: '#f8f8f2',
    text: [248, 248, 242], dimt: [153, 156, 185], gray: [153, 156, 185],
    blue: [139, 233, 253], green: [80, 250, 123], red: [255, 85, 85],
    amber: [241, 250, 140], orange: [255, 184, 108], purple: [189, 147, 249],
    pink: [255, 121, 198], cyan: [139, 233, 253],
    bg: [40, 42, 54], panel: [33, 34, 44], element: [52, 54, 70], border: [70, 70, 90],
    diffAddBg: [46, 84, 62], diffRemBg: [94, 47, 58],
    userBg: [52, 60, 116],
    art1: [189, 147, 249], art2: [139, 233, 253], art3: [241, 250, 140],
  },
  'gruvbox': {
    name: 'Gruvbox',
    hexbg: '#282828', hexfg: '#ebdbb2',
    text: [235, 219, 178], dimt: [146, 131, 116], gray: [146, 131, 116],
    blue: [131, 165, 152], green: [184, 187, 38], red: [251, 73, 52],
    amber: [215, 153, 33], orange: [254, 128, 25], purple: [211, 134, 155],
    pink: [214, 93, 14], cyan: [131, 165, 152],
    bg: [40, 40, 40], panel: [35, 34, 32], element: [60, 56, 54], border: [80, 73, 69],
    diffAddBg: [80, 78, 36], diffRemBg: [116, 52, 46],
    userBg: [62, 62, 56],
    art1: [211, 134, 155], art2: [131, 165, 152], art3: [215, 153, 33],
  },
};

let activeTheme = 'dracula';

function buildC(p) {
  const colors = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m', underline: '\x1b[4m', n: '\x1b[39m' };
  for (const k of ['text', 'dimt', 'gray', 'blue', 'green', 'red', 'amber', 'orange', 'purple', 'pink', 'cyan', 'art1', 'art2', 'art3']) colors[k] = f(...p[k]);
  colors.bg = b(...p.bg);
  colors.panel = b(...p.panel);
  colors.element = b(...p.element);
  colors.border = b(...p.border);
  colors.userBg = b(...p.userBg);
  colors.diffAddBg = b(...p.diffAddBg);
  colors.diffRemBg = b(...p.diffRemBg);
  colors.ok = colors.green;
  colors.err = colors.red;
  colors.accent = colors.blue;
  colors.accent2 = colors.purple;
  colors.h2 = colors.blue;
  colors.hexbg = p.hexbg;
  colors.hexfg = p.hexfg;
  return colors;
}

function setTheme(name) {
  if (name && PALETTES[name]) activeTheme = name;
  const fresh = buildC(PALETTES[activeTheme]);
  for (const k of Object.keys(fresh)) C[k] = fresh[k];
}

const C = buildC(PALETTES['dracula']);

module.exports = {
  C,
  f,
  b,
  getWidth,
  getHeight,
  stripAnsi,
  goto,
  up,
  down,
  right,
  left,
  clearLine,
  clearBelow,
  clearScreen,
  home,
  clearLines,
  wrap,
  wlen,
  applyTheme,
  listThemes,
  themeName,
  themeLabel,
  colorMode,
  setTheme,
  fillBackground,
  usleep,
};

function getWidth() {
  return process.stdout.columns || 100;
}
function getHeight() {
  return process.stdout.rows || 24;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/* display width in terminal cells: CJK/emoji count 2, combining marks 0.
   This is what keeps rows from silently wrapping past the edge and
   overlapping the next line. */
function isWideCp(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
         (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
         (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f000 && cp <= 0x1ffff) || (cp >= 0x20000 && cp <= 0x3fffd) ||
         /* ambiguous-width emoji usually rendered 2 cells on modern terminals */
         (cp >= 0x2300 && cp <= 0x23ff) || (cp >= 0x26a0 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff);
}
function wlen(s) {
  let w = 0;
  for (let i = 0; i < String(s).length; i++) {
    const cp = String(s).codePointAt(i);
    if (cp > 0xffff) i++;
    if (cp === 0x09) { w += 4; continue; }
    if (cp >= 0x0300 && cp <= 0x036f) continue;   // combining
    if (cp === 0xfe0f || cp === 0x200d) continue;  // variation selector, ZWJ
    w += isWideCp(cp) ? 2 : 1;
  }
  return w;
}

/* cursor positioning — rows/cols are 1-based */
function goto(r, c) {
  return `\x1b[${r};${c}H`;
}
function up(n) {
  return `\x1b[${n}A`;
}
function down(n) {
  return `\x1b[${n}B`;
}
function right(n) {
  return `\x1b[${n}C`;
}
function left(n) {
  return `\x1b[${n}D`;
}
function clearLine() {
  return '\x1b[2K';
}
function clearBelow() {
  return '\x1b[J';
}
function clearScreen() {
  return '\x1b[2J';
}
function home() {
  return '\x1b[H';
}

/* clear the previous `n` whole lines then position to start of first one */
function clearLines(n) {
  if (n <= 0) return '';
  return `\x1b[${n}A` + '\x1b[J';
}

/* wrap a string (may contain ANSI codes) to max width */
function wrap(str, max) {
  const s = String(str);
  const lines = [];
  let line = '', w = 0, pending = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      let j = i + 1;
      while (j < s.length && s[j] !== 'm') j++;
      pending += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '\n') {
      lines.push(line);
      line = '';
      w = 0;
      pending = '';
      continue;
    }
    line += pending + ch;
    pending = '';
    if (s.codePointAt(i) > 0xffff) { line += s[i + 1]; w += 2; i++; }
    else w += wlen(s[i]);
    if (w >= max) {
      lines.push(line);
      line = '';
      w = 0;
    }
  }
  if (line || pending) lines.push(line + pending);
  return lines;
}

/* set terminal default fg/bg to the active theme (opencode uses the theme's
   app background / primary foreground on the terminal host as well) */
function applyTheme(name) {
  if (name) setTheme(name);
  setTheme();
  if (!process.stdout.isTTY) return;
  if (colorMode() === '16' && !/termux|xterm|256color|kitty|foot|alacritty|wezterm/.test((process.env.TERM || '').toLowerCase())) return;
  try {
    process.stdout.write('\x1b]11;' + C.hexbg + '\x1b\\' + '\x1b]10;' + C.hexfg + '\x1b\\');
  } catch {}
}

function listThemes() {
  return Object.keys(PALETTES);
}

function themeName() {
  return activeTheme;
}

function themeLabel(key) {
  return PALETTES[key] ? PALETTES[key].name : key;
}

/* paint full screen with the app background */
function fillBackground(rows, cols) {
  let s = clearScreen() + home();
  const blank = C.bg + ' '.repeat(Math.max(cols, 10)) + C.reset;
  for (let i = 0; i < rows; i++) s += blank + '\n';
  return s;
}

function usleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}