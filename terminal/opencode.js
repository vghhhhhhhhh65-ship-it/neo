'use strict';

/* OpenCode integration profile — makes NEO talk to the OpenCode zen gateway
   using the account's existing OpenCode auth + model catalog.
   Reads:
     ~/.local/share/opencode/auth.json    → API key(s) for providers
     ~/.cache/opencode/models.json        → the models.dev catalog it fetched
   The "opencode" provider routes through https://opencode.ai/zen/v1 and
   takes bare model ids (e.g. "nemotron-3.5-lightning-free").
   ──────────────────────────────────────────────────────────────────────────
   IMPORTANT: NOT every "-free" id in the models.dev catalog is actually
   served by the zen gateway for this account — requesting a phantom id
   returns 401 "Model X is not supported". The gateway's own GET /models is
   the source of truth. NEO only lists ids verified live against that
   endpoint (VERIFIED_FREE_IDS below), refreshed in the background so newly
   published free models appear automatically. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const ZEN_V1 = 'https://opencode.ai/zen/v1';
const OPCODE_KEY = 'opencode';
const FREE_ONLY = true; // free tier — no payment method required

const authFile = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
const catalogFile = () => path.join(os.homedir(), '.cache', 'opencode', 'models.json');
const allowCacheFile = () => path.join(os.homedir(), '.cache', 'opencode', 'neo-zen-models.json');

/* free models this account can actually use — verified live against
   https://opencode.ai/zen/v1/models (id → { name, ctx }). Keep the
   reliably-responding ones first (they become the default after /opencode). */
const VERIFIED_FREE_IDS = [
  'nemotron-3.5-lightning-free',
  'laguna-s-2.1-free',
  'ling-3.0-flash-fin-free',
  'big-pickle',
  'mimo-v2.5-free',
  'deepseek-v4-flash-free',
  'muse-spark-1.2-contributor-free',
  'nemotron-3-ultra-free',
];

/* metadata fallback in case the models.dev catalog isn't downloaded yet */
const FALLBACK_MODELS = [
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', tag: 'free · 262k', ctx: 262144 },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1', tag: 'free · 256k', ctx: 256000 },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling-3.0 Flash Fin', tag: 'free · 262k', ctx: 262144 },
  { id: 'big-pickle', name: 'Big Pickle', tag: 'free · 200k', ctx: 200000 },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5', tag: 'free · 200k', ctx: 200000 },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', tag: 'free · 200k', ctx: 200000 },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 (contributor)', tag: 'free · 1M', ctx: 1048576 },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra', tag: 'free · 1M', ctx: 1000000 },
];

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

function opencodeKey() {
  const auth = readJson(authFile());
  if (!auth) return '';
  for (const name of [OPCODE_KEY, 'opencode-go', 'qwen']) {
    const v = auth[name];
    if (v && v.type === 'api' && typeof v.key === 'string' && v.key.trim()) return v.key.trim();
  }
  return '';
}

function fmtCtx(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1).replace('.0', '') + 'M' : Math.round(n / 1024) + 'k';
}

/* known free ids: the verified list, extended by any newer free model the
   gateway advertised (cached by refreshFreeModels). big-pickle has no
   "-free" suffix but is a free zen model, so it must be whitelisted. */
function allowedIds() {
  const set = new Set(VERIFIED_FREE_IDS);
  const cache = readJson(allowCacheFile());
  if (cache && Array.isArray(cache.ids)) for (const id of cache.ids) set.add(id);
  return set;
}

/* build the NEO model list: catalog metadata for the allowlisted ids (so
   names + context come from the real catalog), falling back to the static
   table. Only ids that actually exist on the zen gateway are included. */
function buildModels() {
  const allow = allowedIds();
  const cat = readJson(catalogFile());
  const catMs = cat && cat[OPCODE_KEY] && cat[OPCODE_KEY].models;
  const byId = {};
  if (catMs && typeof catMs === 'object') {
    for (const [id, m] of Object.entries(catMs)) {
      if (!allow.has(id)) continue;
      const lim = m.limit || {};
      byId[id] = {
        name: m.name || id,
        ctx: Number(lim.context) || 200000,
        desc: (m.description || '').slice(0, 90),
      };
    }
  }
  const out = [];
  for (const fb of FALLBACK_MODELS) {
    if (!allow.has(fb.id)) continue;
    const m = byId[fb.id];
    out.push({
      id: fb.id,
      name: (m && m.name) || fb.name,
      tag: 'oc free · ' + fmtCtx((m && m.ctx) || fb.ctx),
      ctx: (m && m.ctx) || fb.ctx,
      desc: (m && m.desc) || '',
    });
  }
  /* any extra allowlisted id from the live cache with no static entry */
  const staticIds = new Set(FALLBACK_MODELS.map((x) => x.id));
  for (const id of allow) {
    if (staticIds.has(id)) continue;
    const m = byId[id];
    out.push({
      id,
      name: (m && m.name) || id,
      tag: 'oc free · ' + fmtCtx((m && m.ctx) || 200000),
      ctx: (m && m.ctx) || 200000,
      desc: (m && m.desc) || '',
    });
  }
  return out;
}

/* background refresh: ask the zen gateway which models THIS account can see,
   keep only free ones, and cache the ids — so new free models added by the
   gateway show up without a manual update. Never blocks the caller. */
function refreshFreeModels() {
  const key = opencodeKey();
  if (!key) return;
  const url = new URL(ZEN_V1 + '/models');
  const lib = url.protocol === 'https:' ? https : http;
  const req = lib.get(url, { headers: { Authorization: 'Bearer ' + key }, timeout: 8000 }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      try {
        const d = JSON.parse(body);
        const ids = (d.data || []).map((m) => m.id).filter((id) => decodeFree(id));
        if (ids.length) {
          fs.mkdirSync(path.dirname(allowCacheFile()), { recursive: true });
          fs.writeFileSync(allowCacheFile(), JSON.stringify({ at: Date.now(), ids }));
        }
      } catch {}
    });
  });
  req.on('error', () => {});
  req.setTimeout(8000, () => { try { req.destroy(); } catch {} });
}

/* a model is free-tier if its id ends with "-free" or it's the known free
   flagships (small allowlist). Phantom "-free" ids not in the gateway list
   are filtered by stripFree since we only keep ids the gateway returned. */
function decodeFree(id) {
  if (/^-?[0-9]+$/.test(id)) return false;
  if (/free$/i.test(id)) return true;
  return ['big-pickle', 'big-pickle-lite'].includes(id);
}

/* apply: return { models, apiBase, apiKey } or null when no key configured */
function profile() {
  const key = opencodeKey();
  if (!key) return null;
  refreshFreeModels(); // fire-and-forget; cache feeds the next buildModels
  return { models: buildModels(), apiBase: ZEN_V1, apiKey: key };
}

module.exports = { profile, opencodeKey, buildModels, refreshFreeModels, ZEN_V1, VERIFIED_FREE_IDS };