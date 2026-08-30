'use strict';
/* User configuration — ~/.neo/config.{json,jsonc,toml}
   Loaded at startup (core + tui) and written back on theme changes. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.neo');
const JSON_FILE = path.join(CONFIG_DIR, 'config.json');
const JSONC_FILE = path.join(CONFIG_DIR, 'config.jsonc');
const TOML_FILE = path.join(CONFIG_DIR, 'config.toml');

function stripComments(text) {
  let out = '';
  let inStr = false, q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { if (i + 1 < text.length) out += text[++i]; continue; }
      if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

function parseToml(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else { const n = Number(val); if (val !== '' && !Number.isNaN(n)) val = n; }
    out[key] = val;
  }
  return out;
}

function load() {
  const tryFiles = [
    [JSON_FILE, (t) => JSON.parse(stripComments(t))],
    [JSONC_FILE, (t) => JSON.parse(stripComments(t))],
    [TOML_FILE, parseToml],
  ];
  for (const [file, parse] of tryFiles) {
    try { return parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') try { console.error('[config] bad ' + file + ': ' + e.message); } catch {} }
  }
  return {};
}

function save(data) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
  const preview = load();
  const merged = Object.assign({}, preview, data);
  try {
    fs.writeFileSync(JSON_FILE, JSON.stringify(merged, null, 2) + '\n');
    return JSON_FILE;
  } catch (e) { return null; }
}

function activeFile() {
  for (const f of [JSON_FILE, JSONC_FILE, TOML_FILE]) {
    try { if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

module.exports = { CONFIG_DIR, JSON_FILE, JSONC_FILE, TOML_FILE, load, save, activeFile };