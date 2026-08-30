'use strict';

/* OpenCode integration profile — makes NEO talk to the OpenCode zen gateway
   using the account's existing OpenCode auth + model catalog.
   Reads:
     ~/.local/share/opencode/auth.json    → API key(s) for providers
     ~/.cache/opencode/models.json        → the models.dev catalog it fetched
   The "opencode" provider routes through https://opencode.ai/zen/v1 and
   takes bare model ids (e.g. "nemotron-3.5-lightning-free"), which is the
   same model-id convention NEO already uses. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ZEN_V1 = 'https://opencode.ai/zen/v1';
const OPCODE_KEY = 'opencode';
const FREE_ONLY = true; // free tier — no payment method required

const authFile = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
const catalogFile = () => path.join(os.homedir(), '.cache', 'opencode', 'models.json');

/* fallback catalog for the opencode provider (free tier) in case the models
   cache hasn't been downloaded yet — ids verified against the zen gateway */
const FALLBACK_MODELS = [
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', tag: 'free · 262k', ctx: 262144 },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra', tag: 'free · 1M', ctx: 1048576 },
  { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super', tag: 'free · 204k', ctx: 204800 },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5', tag: 'free · 200k', ctx: 200000 },
  { id: 'big-pickle', name: 'Big Pickle', tag: 'free · 200k', ctx: 200000 },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1', tag: 'free · 256k', ctx: 256000 },
  { id: 'kimi-k2.5-free', name: 'Kimi K2.5', tag: 'free · 262k', ctx: 262144 },
  { id: 'ring-2.6-1t-free', name: 'Ring 2.6 1T', tag: 'free · 262k', ctx: 262000 },
  { id: 'ling-3.0-flash-free', name: 'Ling-3.0 Flash', tag: 'free · 262k', ctx: 262144 },
  { id: 'minimax-m3-free', name: 'MiniMax M3', tag: 'free · 200k', ctx: 200000 },
];

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

/* the account's opencode key, copied from OpenCode's own auth store */
function opencodeKey() {
  const auth = readJson(authFile());
  if (!auth) return '';
  for (const name of [OPCODE_KEY, 'opencode-go', 'qwen']) {
    const v = auth[name];
    if (v && v.type === 'api' && typeof v.key === 'string' && v.key.trim()) return v.key.trim();
  }
  return '';
}

/* build a NEO-style model list from the models.dev catalog that opencode
   already downloaded — filtered to the account's provider + free tier */
function buildModels() {
  const cat = readJson(catalogFile());
  if (cat) {
    const prov = cat[OPCODE_KEY];
    const ms = prov && prov.models;
    if (ms && typeof ms === 'object') {
      const out = [];
      for (const [id, m] of Object.entries(ms)) {
        if (FREE_ONLY && !/^[^-]+.*-free$/i.test(id) && !/free/i.test(m.name || '')) continue;
        if (m && m.enabled === false) continue;
        const lim = m.limit || {};
        const ctx = Number(lim.context) || 200000;
        out.push({ id, name: m.name || id, tag: 'oc free · ' + fmtCtx(ctx), ctx });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      if (out.length) return out;
    }
  }
  return FALLBACK_MODELS;
}

function fmtCtx(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1).replace('.0', '') + 'M' : Math.round(n / 1024) + 'k';
}

/* apply: return { models, apiBase, apiKey } or null when no key configured */
function profile() {
  const key = opencodeKey();
  if (!key) return null;
  return { models: buildModels(), apiBase: ZEN_V1, apiKey: key };
}

module.exports = { profile, opencodeKey, buildModels, ZEN_V1 };