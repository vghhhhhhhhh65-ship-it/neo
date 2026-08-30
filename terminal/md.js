'use strict';

const { C, getWidth, wrap, stripAnsi, wlen } = require('./ansi');

function inlines(t) {
  return t
    .replace(/`([^`\n]+)`/g, (m, x) => C.pink + x + C.reset)
    .replace(/\*\*([^*\n]+)\*\*/g, C.bold + '$1' + C.reset)
    .replace(/__([^_\n]+)__/g, C.bold + '$1' + C.reset)
    .replace(/\*([^*\n]+)\*/g, C.italic + '$1' + C.reset)
    .replace(/_([^_\n]+)_/g, C.italic + '$1' + C.reset)
    .replace(/~~([^~\n]+)~~/g, C.dim + C.italic + '$1' + C.reset)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, C.blue + C.underline + '$1' + C.reset)
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
        return (n <= 2 ? C.h2 + C.bold : C.dimt + C.bold) + m[2].trim() + C.reset;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return C.gray + '─'.repeat(Math.min(width, 40)) + C.reset;
      if (/^[-*+]\s+/.test(trimmed)) return C.blue + '•' + C.reset + ' ' + inlines(trimmed.replace(/^[-*+]\s+/, ''));
      if (/^\d+[.)]\s+/.test(trimmed)) {
        const num = trimmed.match(/^\d+/)[0];
        return C.blue + C.bold + num + '.' + C.reset + ' ' + inlines(trimmed.replace(/^\d+[.)]\s+/, ''));
      }
      if (trimmed.startsWith('>')) return C.gray + '┃ ' + C.reset + C.dimt + C.italic + inlines(trimmed.replace(/^>\s?/, '')) + C.reset;
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
        if (cells.length && cells.every((c) => /^:?-+:?$/.test(c))) return C.gray + '─'.repeat(width) + C.reset;
        return '  ' + cells.map((c) => inlines(c)).join(C.gray + '│' + C.reset + ' ');
      }
      return inlines(l);
    })
    .join('\n');

  // code fences → panel block with a thin top rule (no heavy box)
  const fenceRe = /```(\w*)\n([\s\S]*?)(```|$)/g;
  const out = plain.replace(fenceRe, (_m, lang, code) => {
    const W = Math.max(10, width - 2);
    const body = code.trimEnd();
    const wrapped = body.split('\n').flatMap((l) => (stripAnsi(l).length > W ? wrap(l, W) : [l]));
    const header = (lang ? C.dimt + lang : C.dimt + 'code') + ' ';
    const top = C.gray + '┄ '.repeat(2) + header + C.reset + C.border + ' '.repeat(0) + C.reset;
    const rule = C.gray + '─'.repeat(Math.min(width, 46)) + C.reset;
    const mid = wrapped.map((l) => C.element + '  ' + C.text + l + C.reset).join('\n');
    return rule + '\n' + (lang ? C.dimt + ' ' + lang + C.reset + '\n' : '') + mid + '\n' + C.gray + '─'.repeat(Math.min(width, 46)) + C.reset;
  });

  return out;
}

module.exports = { renderMd };