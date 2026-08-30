'use strict';

const { C, getWidth, wrap, stripAnsi, wlen } = require('./ansi');

function inlines(t) {
  /* note: C.n (explicit theme fg) is used instead of C.reset so the theme's
     background is never dropped mid-row — otherwise the terminal's own
     base color flashes through inside the reply bubbles. C.text prefixes
     plain paragraphs so text is never left on the terminal's default fg
     (readable on light themes even if the terminal ignores OSC 10). */
  return C.text + t
    .replace(/`([^`\n]+)`/g, (m, x) => C.pink + x + C.n)
    .replace(/\*\*([^*\n]+)\*\*/g, C.bold + '$1' + C.n)
    .replace(/__([^_\n]+)__/g, C.bold + '$1' + C.n)
    .replace(/\*([^*\n]+)\*/g, C.italic + '$1' + C.n)
    .replace(/_([^_\n]+)_/g, C.italic + '$1' + C.n)
    .replace(/~~([^~\n]+)~~/g, C.dim + C.italic + '$1' + C.n)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, C.blue + C.underline + '$1' + C.n)
    .replace(/\*+/g, '')
    .replace(/_+/g, '')
    .replace(/#+/g, '')
    .replace(/~+/g, '');
}

/* Render markdown as clean ANSI for a LIGHT terminal (no raw * _ # ~) */
function renderMd(src, width) {
  width = width || getWidth() - 2;

  const plain = String(src)
    .split(/\r?\n/)
    .map((l) => {
      const trimmed = l.trim();
      if (!trimmed) return '';

      let m = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const n = m[1].length;
        return (n <= 2 ? C.h2 + C.bold : C.dimt + C.bold) + m[2].trim() + C.n;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return C.gray + '─'.repeat(Math.min(width, 40)) + C.n;
      if (/^[-*+]\s+/.test(trimmed)) return C.blue + '•' + C.n + ' ' + inlines(trimmed.replace(/^[-*+]\s+/, ''));
      if (/^\d+[.)]\s+/.test(trimmed)) {
        const num = trimmed.match(/^\d+/)[0];
        return C.blue + C.bold + num + '.' + C.n + ' ' + inlines(trimmed.replace(/^\d+[.)]\s+/, ''));
      }
      if (trimmed.startsWith('>')) return C.gray + '┃ ' + C.n + C.dimt + C.italic + inlines(trimmed.replace(/^>\s?/, '')) + C.n;
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length && cells.every((c) => /^:?-+:?$/.test(c))) return C.gray + '─'.repeat(width) + C.n;
        return '  ' + cells.map((c) => inlines(c)).join(C.gray + '│' + C.n + ' ');
      }
      return inlines(l);
    })
    .join('\n');

  // code fences → panel block with a thin rule + a language cap (no heavy box)
  const fenceRe = /```(\w*)\n([\s\S]*?)(```|$)/g;
  const out = plain.replace(fenceRe, (_m, lang, code) => {
    const W = Math.max(10, width - 2);
    const body = code.trimEnd();
    const wrapped = body.split('\n').flatMap((l) => (stripAnsi(l).length > W ? wrap(l, W) : [l]));
    const bar = C.gray + '─'.repeat(Math.max(8, Math.min(width - 2, 46))) + C.n;
    const cap = lang ? C.border + '─ ' + C.pink + lang + C.n + '\n' : '';
    const mid = wrapped.map((l) => C.element + '  ' + C.text + l + C.n).join('\n');
    return bar + '\n' + cap + mid + '\n' + bar;
  });

  return out;
}

module.exports = { renderMd };