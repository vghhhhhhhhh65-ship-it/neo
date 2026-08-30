'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const cfg = require('./config').load();
let API_BASE = process.env.API_BASE || cfg.apiBase || 'https://api.xkiro.com/v1';
/* the user provides their own key via /apikey — never ship a secret key */
let API_KEY = (process.env.API_KEY || cfg.apiKey || '').trim();
const setApiKey = (k) => { API_KEY = String(k || '').trim(); };
const getApiKey = () => (API_KEY ? API_KEY.slice(0, 4) + '…' + API_KEY.slice(-4) : '');

/* unified model catalog — every entry was verified LIVE today:
   xkiro → POST /chat/completions 200 (21 models)
   opencode zen (api:'oc') → 200 / 429 free-limit on zen/v1 (5 models)
   Paid-only (403), phantom/unpublished (-free that 401s), and 400/500
   server-error ids were dropped — the list only shows models that answer. */
const MODELS = [
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', api: 'xkiro', tag: 'xkiro · 1M ctx', ctx: 1048576 },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', api: 'xkiro', tag: 'xkiro · 1M · سريع', ctx: 1048576 },
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek Chat V3.1', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'mistralai/codestral-2508', name: 'Codestral 2508', api: 'xkiro', tag: 'xkiro · coder · 262k', ctx: 262144 },
  { id: 'mistralai/devstral-medium', name: 'Devstral 2', api: 'xkiro', tag: 'xkiro · coder · 262k', ctx: 262144 },
  { id: 'mistralai/mistral-large-2512', name: 'Mistral Large', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'mistralai/mistral-medium-3.5', name: 'Mistral Medium', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'mistralai/mistral-small-2603', name: 'Mistral Small', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'mistralai/ministral-3b', name: 'Ministral 3B', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'mistralai/ministral-8b', name: 'Ministral 8B', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'mistralai/ministral-14b', name: 'Ministral 14B', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'minimax/minimax-m2', name: 'MiniMax M2', api: 'xkiro', tag: 'xkiro · 1M', ctx: 1048576 },
  { id: 'minimax/minimax-m2.1', name: 'MiniMax M2.1', api: 'xkiro', tag: 'xkiro · 1M', ctx: 1048576 },
  { id: 'minimax/minimax-m2.5', name: 'MiniMax M2.5', api: 'xkiro', tag: 'xkiro · 1M', ctx: 1048576 },
  { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7', api: 'xkiro', tag: 'xkiro · 1M', ctx: 1048576 },
  { id: 'minimax/minimax-m2.1-highspeed', name: 'MiniMax M2.1 HS', api: 'xkiro', tag: 'xkiro · 1M · سريع', ctx: 1048576 },
  { id: 'minimax/minimax-m2.5-highspeed', name: 'MiniMax M2.5 HS', api: 'xkiro', tag: 'xkiro · 1M · سريع', ctx: 1048576 },
  { id: 'minimax/minimax-m2.7-highspeed', name: 'MiniMax M2.7 HS', api: 'xkiro', tag: 'xkiro · 1M · سريع', ctx: 1048576 },
  { id: 'sensenova/sensenova-6.7-flash-lite', name: 'SenseNova 6.7 Lite', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'sensenova/sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Lite', api: 'xkiro', tag: 'xkiro · 262k', ctx: 262144 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', api: 'oc', tag: 'oc free · 262k', ctx: 262144 },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1', api: 'oc', tag: 'oc free · 250k', ctx: 256000 },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin', api: 'oc', tag: 'oc free · 262k', ctx: 262144 },
  { id: 'big-pickle', name: 'Big Pickle', api: 'oc', tag: 'oc free · 200k', ctx: 200000 },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5', api: 'oc', tag: 'oc free · 200k', ctx: 200000 },
];
let MODEL = process.env.MODEL || (MODELS.some((m) => m.id === cfg.model) ? cfg.model : '') || MODELS[1].id;
const setModel = (m) => { if (MODELS.some((x) => x.id === m)) MODEL = m; };
const setModelRaw = (m) => { if (typeof m === 'string' && m.trim()) MODEL = m.trim(); };
const getModel = () => MODEL;
const setApiBase = (u) => { if (typeof u === 'string' && u.trim()) API_BASE = u.trim().replace(/\/+$/, ''); };
const getApiBase = () => API_BASE;
/* per-model API routing — xkiro models use API_BASE/API_KEY (config),
   opencode zen models (api:'oc') use the free zen gateway + opencode key */
const ZEN_V1 = 'https://opencode.ai/zen/v1';
const ocOpenKey = () => {
  try {
    const { opencodeKey } = require('./terminal/opencode');
    return opencodeKey();
  } catch {
    return '';
  }
};
const apiOf = (mid) => {
  const m = MODELS.find((x) => x.id === mid);
  return m && m.api ? m.api : 'xkiro';
};
const endpointOf = (mid) => {
  if (apiOf(mid) === 'oc') return { base: ZEN_V1, key: ocOpenKey() };
  return { base: API_BASE, key: API_KEY };
};
/* hot-swap the model catalog in place (same array reference, so every
   consumer — picker, ctx limit, setModel — sees the new list) */
const NEO_DEFAULT_MODELS = [...MODELS];
const swapModels = (list) => {
  if (!Array.isArray(list) || !list.length) return false;
  MODELS.length = 0;
  MODELS.push(...list);
  return true;
};
const resetModels = (modelId) => {
  MODELS.length = 0;
  MODELS.push(...NEO_DEFAULT_MODELS);
  if (modelId && MODELS.some((x) => x.id === modelId)) MODEL = modelId;
  else MODEL = process.env.MODEL || cfg.model || MODELS[1].id;
  return true;
};
const MAX_CONTEXT = cfg.maxContext || 1048576;
/* effective context window per model — custom/unknown providers fall back to config */
const modelCtxLimit = () => {
  const m = MODELS.find((x) => x.id === MODEL);
  return m && m.ctx ? m.ctx : MAX_CONTEXT;
};
/* files the agent actually opened/edited — used to restore state after compaction */
const VOLATILE_FILES = new Set();
const getFiles = () => [...VOLATILE_FILES];
const WORKDIR = process.env.WORKDIR || cfg.workdir || '/home';
const MAX_ITERATIONS = 60;

/* ── mode (build | plan) — plan only analyzes + registers TODO steps ── */
let CURRENT_MODE = 'build';
const setMode = (m) => { CURRENT_MODE = m === 'plan' ? 'plan' : 'build'; };
const getMode = () => CURRENT_MODE;
let TODOS = [];
const getTodos = () => TODOS;
const WRITE_TOOLS = ['write_file', 'edit_file', 'bash'];

/* interactive question to the user: ask_question blocks the agent loop,
   the CLI shows a picker page, and answerQuestion() resolves the answer */
const pendingQuestions = new Map();
let questionSeq = 0;
let activeEmit = () => {};
function answerQuestion(id, value) {
  const r = pendingQuestions.get(id);
  if (r) { pendingQuestions.delete(id); r(value); }
}
const cancelAllQuestions = () => {
  for (const [, r] of pendingQuestions) r('…');
  pendingQuestions.clear();
};

/* ────────────────────────────── TOOLS ────────────────────────────── */

const tools = {
  async todo_update(args) {
    const key = String(args.key || '').slice(0, 32);
    const content = String(args.content || '').slice(0, 120);
    const status = args.status === 'completed' ? 'completed' : 'pending';
    const i = TODOS.findIndex((t) => t.key === key);
    if (i === -1) TODOS.push({ key, content, status });
    else { TODOS[i].status = status; if (content) TODOS[i].content = content; }
    return { output: `todo [${key}] ${status} — ${content}` };
  },
  async list_dir(args) {
    const p = path.resolve(WORKDIR, args.path || '.');
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const out = entries
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`)
      .join('\n');
    return `place: ${p}:\n${out}\n(${entries.length} items)`;
  },

  async read_file(args) {
    const p = path.resolve(WORKDIR, args.path);
    const stat = await fsp.stat(p);
    if (stat.size > 2 * 1024 * 1024)
      return `FILE too large (${(stat.size / 1048576).toFixed(1)} MB). Use bash head/tail instead.`;
    const content = await fsp.readFile(p, 'utf8');
    const lines = content.split('\n');
    const offset = args.offset || 0;
    const limit = args.limit || 800;
    const slice = lines.slice(offset, offset + limit).join('\n');
    return `FILE: ${p}\nLINES: ${lines.length}\n${'-'.repeat(40)}\n${slice}\n${'-'.repeat(40)}\n(showing lines ${offset + 1}-${Math.min(offset + limit, lines.length)} of ${lines.length})`;
  },

  async write_file(args) {
    const p = path.resolve(WORKDIR, args.path);
    let before = '';
    try { before = await fsp.readFile(p, 'utf8'); } catch {}
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, args.content || '');
    return { output: `Written: ${p} (${(args.content || '').length} chars)`, diff: makeFileDiff(p, before, args.content || '') };
  },

  async edit_file(args) {
    const p = path.resolve(WORKDIR, args.path);
    const content = await fsp.readFile(p, 'utf8');
    if (!content.includes(args.old)) return `ERROR: old string not found in ${p}`;
    const next = content.split(args.old).join(args.new);
    await fsp.writeFile(p, next);
    return { output: `Edited: ${p}`, diff: makeFileDiff(p, content, next) };
  },

  async glob(args) {
    const dir = path.resolve(WORKDIR, args.path || '.');
    const cmd = `find ${JSON.stringify(dir)} -type f -name ${JSON.stringify(args.pattern)} -not -path '*/node_modules/*' 2>/dev/null | head -200`;
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    const files = stdout.trim().split('\n').filter(Boolean);
    return `Matches (${files.length}):\n${files.join('\n') || '(none)'}`;
  },

  async grep(args) {
    const dir = path.resolve(WORKDIR, args.path || '.');
    const cmd = `rg -n --no-heading -i ${JSON.stringify(args.pattern)} ${JSON.stringify(dir)} --glob '!node_modules' --glob '!*.lock' 2>/dev/null | head -120`;
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (!lines.length) return 'No matches.';
    return `Matches (${lines.length}):\n${lines.join('\n')}`;
  },

  async bash(args) {
    const cwd = args.cwd ? path.resolve(args.cwd) : WORKDIR;
    const { stdout, stderr } = await execAsync(args.command, {
      cwd,
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
      shell: '/bin/bash',
    });
    const out = (stdout + (stderr ? '\n[STDERR]\n' + stderr : '')).trim();
    return out.slice(0, 6000) || '(command ran with no output)';
  },

  /* ask the user for a decision — blocks the loop until the CLI replies.
     options: array of { label, value } or plain strings. */
  async ask_question(args) {
    if (activeEmit === (() => {})) throw new Error('ask_question is only available inside a run');
    const question = String(args.question || args.q || '').slice(0, 240);
    const options = (Array.isArray(args.options) ? args.options : [])
      .map((o) => {
        if (o && typeof o === 'object') return { label: String(o.label ?? '').slice(0, 80) || String(o), value: o.value !== undefined ? String(o.value) : String(o) };
        return { label: String(o).slice(0, 80), value: String(o) };
      })
      .filter((o) => o.label && o.label.trim())
      .slice(0, 12);
    if (!question.trim()) return 'ERROR: ask_question needs a "question".';
    if (options.length < 2) return 'ERROR: ask_question needs 2+ "options".';

    const id = ++questionSeq;
    activeEmit({ type: 'question', id, question: question.trim(), options });
    if (process.env.NEO_TUI_TEST === '1') console.error('__NEOQ_ASKED__ ' + JSON.stringify({ id, q: question.trim(), n: options.length }));
    const answer = await new Promise((resolve) => pendingQuestions.set(id, resolve));
    pendingQuestions.delete(id);
    if (process.env.NEO_TUI_TEST === '1') console.error('__NEOQ_ANSWERED__ ' + JSON.stringify({ id, answer }));
    if (!answer || answer === '…') return "The user dismissed the question — proceed on your own judgment.";
    return `User chose: "${answer}"`;
  },
};

/* ── structured file diff (green additions / red removals), like opencode ── */
function makeFileDiff(filePath, oldText, newText) {
  const o = String(oldText || '').split(/\r?\n/);
  const n = String(newText || '').split(/\r?\n/);
  if (o.length === n.length && o.every((l, i) => l === n[i])) return null;

  const m = o.length, s = n.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(s + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = s - 1; j >= 0; j--) {
      dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < s) {
    if (o[i] === n[j]) { ops.push({ t: 'ctx', text: o[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', text: o[i] }); i++; }
    else { ops.push({ t: 'add', text: n[j] }); j++; }
  }
  while (i < m) { ops.push({ t: 'del', text: o[i] }); i++; }
  while (j < s) { ops.push({ t: 'add', text: n[j] }); j++; }

  // collapse into change regions with 3 lines of context around each
  const regions = [];
  let cur = null;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t !== 'ctx') {
      if (!cur) cur = [];
      cur.push(ops[k]);
    } else if (cur) {
      cur.push({ t: 'sep', text: ops[k].text });
      regions.push(cur);
      cur = null;
    }
  }
  if (cur) regions.push(cur);

  const lines = [];
  let additions = 0, deletions = 0;
  for (const op of ops) {
    if (op.t === 'add') additions++;
    else if (op.t === 'del') deletions++;
  }
  for (const region of regions) {
    for (let k = 0; k < region.length; k++) {
      const op = region[k];
      if (op.t === 'sep') {
        lines.push({ t: 'gap', text: '' });
        continue;
      }
      lines.push({ t: op.t, text: op.text });
      if (lines.length >= 48) break;
    }
    if (lines.length >= 48) break;
  }
  return { path: filePath, additions, deletions, lines };
}

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders in a directory. Returns sorted entries. Use to explore the filesystem.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path (relative to /home or absolute)' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a text file. Use for reading source code / configs / data files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          offset: { type: 'integer', description: 'Line number to start from (0-based)' },
          limit: { type: 'integer', description: 'Max lines to read (default 800)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or fully overwrite a file with the given content. Automatically creates parent folders. Use for creating new source files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact substring inside an existing file. Use for small targeted edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old: { type: 'string', description: 'Exact text to replace' },
          new: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old', 'new'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a pattern under a directory. Pattern like "*.js", "**/*.ts".',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a string/regex under a directory.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run ANY shell command with FULL permissions (cd /storage/emulated/0, ls, mkdir, cp, git, node, python3, npm, pkg, dd, etc). Returns stdout+stderr. Use for builds, tests, programs, phone-storage file management — no command is off-limits.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd: { type: 'string', description: 'Working directory — absolute path anywhere (e.g. /home, /storage/emulated/0/Download). Default /home' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_update',
      description: 'Maintain a checkbox task list the user watches live. Register EVERY planned step with status "pending", then mark each "completed" as you finish it. Stays visible across the session.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Stable short id for this todo (e.g. "1", "2")' },
          content: { type: 'string', description: 'Short description of the step' },
          status: { type: 'string', enum: ['pending', 'completed'], description: 'pending when adding a step, completed when done' },
        },
        required: ['key', 'content', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description: 'Ask the user a short question with interactive answer options, shown as a picker on their screen. Use it ONLY when you are genuinely blocked or the request is ambiguous and a single wrong guess would waste a lot of effort. Keeps working while you wait — the chosen answer comes back to you and you continue. If the user dismisses it, proceed on your own judgment.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The short question to show the user' },
          options: { type: 'array', items: { type: 'string' }, description: '2-6 answer options the user can pick, in the user\'s language' },
        },
        required: ['question', 'options'],
      },
    },
  },
];

/* the working facts are injected at the START of every agent run so the
   model never guesses platform paths — this is what makes answers precise */
function sysPromptFacts() {
  const osf = process.platform;
  const arch = process.arch;
  const isTermux = fs.existsSync('/data/data/com.termux');
  const storage =
    isTermux && fs.existsSync('/storage/emulated/0')
      ? '\n- Phone storage is mounted at /storage/emulated/0 (you can read/write phones files: Download, Pictures, Documents, Music, dcim). On Termux the working files typically live in /data/data/com.termux/files/home.'
      : '';
  const nodeV = (process.version || '').replace(/^v/, '');
  let promptNote = '';
  try { promptNote = `\n- Your system/topic prompt file (you may edit it to change how you behave): ${promptPath()}`; } catch {}
  return [
    `RUNNING ENVIRONMENT (FACT, do not guess):`,
    `- OS: ${osf} (${arch})`,
    `- node: ${nodeV}`,
    `- working root: ${WORKDIR}`,
    `- user home: ${os.homedir()}`,
    `- Termux: ${isTermux ? 'yes' : 'no'}`,
    `- shell: bash`,
    storage,
    promptNote,
  ]
    .filter(Boolean)
    .join('\n');
}

/* prompt-file override — user can point NEO at another topic/system prompt */
const os = require('os');
const NEO_HOME = path.join(os.homedir(), '.neo');
const promptPath = () => {
  try {
    const raw = (cfg && cfg.promptFile && String(cfg.promptFile).trim()) || 'prompt.md';
    if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
    if (raw.startsWith('/')) return raw;
    return path.join(NEO_HOME, raw);
  } catch { return path.join(NEO_HOME, 'prompt.md'); }
};
const reloadPrompt = () => {
  const p = promptPath();
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t) { SYSTEM_PROMPT = t; return { ok: true, path: p, length: Buffer.byteLength(t, 'utf8'), mode: 'custom' }; }
    return { ok: true, path: p, length: 0, mode: 'default' };
  } catch (e) {
    return { ok: false, path: p, reason: e.code === 'ENOENT' ? 'missing' : e.message };
  }
};

let SYSTEM_PROMPT = `You are NEO, a precise senior software engineer and coding agent. You run ON the user's machine with FULL permissions — that is normal and expected: you are a working tool, not a discussion bot.

${sysPromptFacts()}

AVAILABLE TOOLSET — use freely:
1. list_dir(path) — explore folders
2. read_file(path) — read files (offset/limit to slice big ones)
3. edit_file(path, old, new) — replace an EXACT substring (match must exist verbatim, including whitespace)
4. write_file(path, content) — create/overwrite a file (parent folders auto-created)
5. glob(pattern, path) — find files by name pattern
6. grep(pattern, path) — search text inside file contents
7. bash(command, cwd) — run ANY shell command (git, node, python3, npm, pkg, ls, cat, mkdir, cp, curl, etc). Use it to build, run, test, install, move files, anything. Default cwd = the working root.

GROUND RULES:
- Resolve relative paths from the working root; absolute paths anywhere are allowed.
- Work with FILE TOOLS and bash for real output. Never claim something exists or works without CHECKING it with a real command.
- When writing code: CREATE the actual files (not narration about them), then RUN them to verify (node file.js / python3 … / npm test / ./script), fix whatever fails, re-run until green.
- For big projects build structure first (folders + file list), then write files one by one. Never inline whole big files into chat.
- In chat keep the reply SHORT and humanized: what you did, the file list, how to run, what you verified. Use markdown (headings, code fences, bullets).
- Match the user's language: Arabic → reply in clean Arabic (فصحى, not slang). English → English.
- Never fabricate results. Every claim = something you actually observed in a tool result.

WORK CYCLE (a strict routine that keeps you accurate):
1. UNDERSTAND — read the request twice; find the real goal, the constraints, and the deliverable. If a wrong guess would waste a lot of effort and the point is genuinely ambiguous, call ask_question with 2-6 options — never guess blindly; proceed without asking when a reasonable interpretation exists.
2. EXPLORE ONLY AS NEEDED — list_dir/read/glob/grep once to map the relevant area, then stop. Don't wander, don't re-read files already in context, don't run duplicate commands.
3. THINK BEFORE ACT — name the change, the risks, and the edge cases. Prefer the smallest change that works.
4. DO IT STEP BY STEP — track progress with todo_update (register each planned step pending, flip to completed when actually done).
5. VERIFY for real — run the build/test/syntax check after every meaningful change; read errors fully and fix the actual cause.
6. REVIEW & REPAIR — act as your own reviewer: re-read what you wrote for bugs before declaring done; fix without drama.
7. REPORT honestly — a compact final message with results, files, run commands, and anything unverified.

TRAPS TO AVOID (the classic ways agents get confused):
- Do not repeat a failing command hoping it will pass — read the error, adjust, retry.
- Do not dump code you can simply write to a file.
- Do not describe plans as if you performed them — perform them.
- Do not invent file paths or content; verify with tools.
- Do not over-engineer or keep reading forever — act when you have enough.
- If a tool returns an error, the error text IS the input for your next action.

You work autonomously end-to-end, verify everything real, then report.`;

const PLAN_INSTRUCTION = `

CURRENT SETTING: PLAN MODE ONLY.
You must PLAN, never execute:
- write_file, edit_file and bash are LOCKED here and not available to you.
- Explore ONLY with the read-only tools (list_dir, read_file, glob, grep).
- Analyze the task and produce a clear, numbered plan of concrete steps.
- Register EVERY planned step with todo_update (status="pending").
- End your reply with exactly: 'خطتي جاهزة — حوّلني إلى وضع Build لتنفيذها' (Plan ready — switch me to Build).
- Do NOT modify, create, run or delete anything.`;

/* apply a user prompt file at boot (custom system prompt for the session) */
reloadPrompt();

/* ────────────────────────────── MODEL CALL ────────────────────────────── */

const CALL_TRIES = Math.max(1, Number(process.env.NEO_CALL_RETRY || 3) || 3);
const RETRY_DELAY = [1500, 4000, 9000];

/* transient failures worth retrying — network hiccups, server 5xx, rate limits */
const isRetryable = (code) => (code >= 500 || code === 429 || code === 408 || code === 409);
const isNetworkErr = (e) =>
  !(e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) &&
  (/fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|network|read ECONNABORTED|UND_ERR/i.test(e && e.message ? String(e.message) + ' ' + String(e.cause && e.cause.message || '') : ''));

async function callModel(messages, onDelta, signal, toolDefs = toolDefinitions) {
  attemptLoop:
  for (let attempt = 1; attempt <= CALL_TRIES; attempt++) {
    const ep = endpointOf(MODEL);
    if (!ep || !ep.key) throw new Error('لا يوجد API Key — اكتب /apikey لضبط المفتاح');
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort());
    }
    let resp;
    try {
      resp = await fetch(`${ep.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          ...(toolDefs && toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : {}),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 65000,
          temperature: 0.35,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (!isNetworkErr(e) || attempt >= CALL_TRIES) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAY[attempt - 1] || 4000));
      continue;
    }

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      if (isRetryable(resp.status) && attempt < CALL_TRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY[attempt - 1] || 4000));
        continue;
      }
      throw new Error(`api error ${resp.status}: ${err.slice(0, 300)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const result = { content: '', reasoning: '', toolCalls: [], usage: null };

    /* watchdog: a fetch stream that stops sending bytes (mobile / flaky
       network) would otherwise hang the agent forever with the spinner —
       abort after STREAM_STALL_MS of total silence. */
    const STREAM_STALL_MS = Number(process.env.NEO_STREAM_TIMEOUT || 60000);
    let lastChunk = Date.now();
    let stallReason = null;
    const stallTimer = setInterval(() => {
      if (Date.now() - lastChunk > STREAM_STALL_MS) {
        clearInterval(stallTimer);
        stallReason = 'انتهت مهلة الاستجابة — الشبكة توقفت، أعد المحاولة (اضغط ESC للإيقاف)';
        controller.abort();
      }
    }, 2500);

    /* mid-stream network drop: if the socket dies BEFORE any content/tool
       output reached the user, retry the whole request (nothing to lose).
       If something already streamed, keep the partial output and let the
       caller decide — never duplicate text on the screen. */
    try {
      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (stallReason) throw new Error(stallReason);
          if (e && e.name === 'AbortError') throw e;
          const nothingStreamed = !result.content && !result.reasoning &&
            !(result.toolCalls && result.toolCalls.length);
          if (nothingStreamed && attempt < CALL_TRIES) {
            try { reader.releaseLock(); } catch {}
            await new Promise((r) => setTimeout(r, RETRY_DELAY[attempt - 1] || 4000));
            continue attemptLoop;
          }
          throw e;
        }
        const { done, value } = chunk;
        if (done) break;
        lastChunk = Date.now();
        buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          if (json.usage) result.usage = json.usage;
          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (delta.content) {
          result.content += delta.content;
          onDelta({ type: 'text', content: delta.content });
        }
        if (delta.reasoning_content) {
          result.reasoning += delta.reasoning_content;
          onDelta({ type: 'reasoning', content: delta.reasoning_content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            let slot = result.toolCalls[tc.index];
            if (!slot) {
              slot = { id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: '', arguments: '' };
              result.toolCalls[tc.index] = slot;
            }
            if (tc.id) slot.id = tc.id;
            if (tc.function) {
              if (tc.function.name) slot.name += tc.function.name;
              if (tc.function.arguments) slot.arguments += tc.function.arguments;
            }
          }
        }
      } catch { /* partial JSON lines skipped */ }
    }
  }
  } finally {
        clearInterval(stallTimer);
      }
      return result;
    }
  }

/* ────────────────────────────── AGENT LOOP ────────────────────────────── */

async function executeTool(name, argsRaw) {
  if (CURRENT_MODE === 'plan' && WRITE_TOOLS.includes(name))
    throw new Error(`blocked: ${name} is locked in plan mode — switch to build`);
  if (typeof tools[name] !== 'function') throw new Error(`unknown tool "${name}"`);
  if (argsRaw && typeof argsRaw === 'object' && ['read_file', 'write_file', 'edit_file'].includes(name) && argsRaw.path) {
    try { VOLATILE_FILES.add(path.resolve(WORKDIR, argsRaw.path)); } catch {}
  }
  const res = await tools[name](argsRaw);
  if (res && typeof res === 'object' && typeof res.output === 'string') return res;
  return { output: String(res ?? '') };
}

/* ══════════════════ SMART MEMORY COMPACTION ═══════════════════
   when the thread approaches the model's context limit we do NOT
   silently drop messages — we ask the model (with no tools) to
   compress the whole thread into ONE structured state report with
   sections (objective / done / current / next / files / blocked /
   notes). It is injected back as system memory + the newest few
   messages stay verbatim, and the open files + todos are re-listed
   so the agent can re-read them automatically and keep going.    */
const COMPACT_SYSTEM = `You are the memory manager of a coding agent. Read the WHOLE conversation thread below and compress it into a single structured, dense, exact state report.

Rules:
- Preserve every fact needed to continue the work: file paths, command strings, model/tool names, versions, error messages, decisions, user wishes.
- NEVER invent and never omit critical state. Keep it tight but complete.
- Reply ONLY with the report — no greetings, no commentary.

Use exactly these sections (Arabic headings, keep them):

## المطلوب (Objective)
The full task and end goal.

## تم إنجازه (Done)
Everything finished: files created, files modified (with paths), commands run, tests, results.

## الحالة الحالية (Current state)
What is in progress right now, where we stopped, open buffers, half-done changes.

## الخطوات القادمة (Next)
The ordered next actions, in priority order.

## الملفات (Files)
Every relevant file path and what was done to it. Mark the ones being edited right now.

## معطّل / عوائق (Blocked)
Anything failed, blocked, waiting, unstable, or pending verification — with the error.

## ملاحظات (Notes)
Other essential context (arguments, versions, gotchas, user preferences).`;

const SUMMARY_PREFIX = '\n\n————📦 ذاكرة مضغوطة — استمر من هنا————\n';

/* compress plain [{role,content}] messages into {summary, kept, dropped}.
   kept = newest messages preserved verbatim (≥2 always) */
async function runCompact(system, msgs, opts = {}) {
  const ctxLimit = modelCtxLimit();
  const est = (s) => Math.ceil(String(s).length / 3) + 8;
  const budget = Math.floor(ctxLimit * 0.8);
  const src = msgs.slice();
  let t = est(system);
  while (src.length > 1 && t + est(src[0].content) > budget) { t -= est(src.shift().content); }
  const payload = src.map((m) => `[${String(m.role).toUpperCase()}]\n${String(m.content || '')}`).join('\n\n');
  const prelude =
    '\nOpen files (context): ' + (getFiles().join(', ') || '(none)') +
    '\nTODO state: ' + (getTodos().length ? getTodos().map((q) => `[${q.status}] ${q.content}`).join(' | ') : '(none)') +
    '\n\n===== THREAD =====\n';
  const out = await callModel(
    [{ role: 'system', content: COMPACT_SYSTEM }, { role: 'user', content: prelude + payload }],
    opts.onEvent || (() => {}),
    opts.signal || null,
    []
  );
  const summary = String(out.content || '').trim();
  if (!summary) throw new Error('empty compaction summary');
  const keepBudget = Math.floor(ctxLimit * 0.08);
  const kept = [];
  let kt = est(system) + est(summary);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const mc = kt + est(m.content);
    if (mc > keepBudget && kept.length >= 2) break;
    kept.unshift(m);
    kt = mc;
  }
  return { summary, kept, dropped: msgs.length - kept.length };
}

async function runAgent(clientMessages, emit, opts = {}) {
  activeEmit = emit;
  const isAborted = opts.isAborted || (() => false);
  const signal = opts.signal || null;
  const isPlan = CURRENT_MODE === 'plan';
  const system = SYSTEM_PROMPT + (isPlan ? PLAN_INSTRUCTION : '');
  /* context guard — auto-compact (smart summary) near the model's real
     limit, with a hard fallback that drops oldest messages if it fails */
  const estTokens = (s) => Math.ceil(String(s).length / 3) + 8;
  const ctxLimit = modelCtxLimit();
  const compactFloor = Math.floor(ctxLimit * 0.8);
  const hardFloor = Math.floor(ctxLimit * 0.9);
  const msgs = clientMessages.slice();
  let total = estTokens(system) + msgs.reduce((a, m) => a + estTokens(m.content), 0);
  let history;

  if (total > compactFloor && msgs.length >= 5) {
    try {
      const r = await runCompact(system, msgs, { signal });
      const notes =
        '\nOpen files (استعدها تلقائياً): ' + (getFiles().join(', ') || '(none)') +
        '\nTODO: ' + (getTodos().length ? getTodos().map((q) => `[${q.status}] ${q.content}`).join(' | ') : '(none)') +
        '\nمتابعة: إذا احتجت استعادة حالة أي ملف أعد قراءته بـ read_file قبل المتابعة، ثم نَفّذ الخطوة التالية.';
      const sys = system + SUMMARY_PREFIX + r.summary + notes;
      history = [{ role: 'system', content: sys }, ...r.kept.map((m) => ({ role: m.role, content: m.content }))];
      emit({ type: 'compacted', summary: r.summary, dropped: r.dropped, kept: r.kept.length });
    } catch {
      let dropped = 0;
      while (msgs.length > 1 && total > hardFloor) { total -= estTokens(msgs[0].content); msgs.shift(); dropped++; }
      if (dropped) emit({ type: 'context_gc', dropped });
      history = [{ role: 'system', content: system }, ...msgs.map((m) => ({ role: m.role, content: m.content }))];
    }
  } else {
    let dropped = 0;
    while (msgs.length > 1 && total > hardFloor) { total -= estTokens(msgs[0].content); msgs.shift(); dropped++; }
    if (dropped) emit({ type: 'context_gc', dropped });
    history = [{ role: 'system', content: system }, ...msgs.map((m) => ({ role: m.role, content: m.content }))];
  }
  const cumulativeUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolDefs = isPlan ? toolDefinitions.filter((t) => !WRITE_TOOLS.includes(t.function.name)) : toolDefinitions;
  let lastFail = null, failCount = 0;

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (isAborted()) { emit({ type: 'aborted' }); return { history, usage: cumulativeUsage, aborted: true }; }
      emit({ type: 'iteration', n: iter + 1 });
      const result = await callModel(history, (ev) => emit(ev), signal, toolDefs);
      if (isAborted()) { emit({ type: 'aborted' }); return { history, usage: cumulativeUsage, aborted: true }; }

      if (result.reasoning) emit({ type: 'reasoning_done', content: result.reasoning });
      else emit({ type: 'reasoning_done', content: '' });

      if (result.usage) {
        cumulativeUsage.prompt_tokens += result.usage.prompt_tokens || 0;
        cumulativeUsage.completion_tokens += result.usage.completion_tokens || 0;
        cumulativeUsage.total_tokens += result.usage.total_tokens || 0;
        emit({ type: 'usage', ...cumulativeUsage, context: MAX_CONTEXT });
      }

      if (result.toolCalls && result.toolCalls.length) {
        history.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })),
        });
        let stuck = false;
        for (const tc of result.toolCalls) {
          if (isAborted()) { emit({ type: 'aborted' }); return { history, usage: cumulativeUsage, aborted: true }; }
          let argsRaw;
          try { argsRaw = JSON.parse(tc.arguments || '{}'); } catch { argsRaw = { _raw: tc.arguments }; }
          emit({ type: 'todo', key: argsRaw.key, content: argsRaw.content, status: argsRaw.status });
          emit({ type: 'tool_start', id: tc.id, name: tc.name, args: argsRaw });
          let output;
          let ok = true;
          let diff;
          try {
            const res = await executeTool(tc.name, argsRaw);
            output = res.output;
            diff = res.diff;
          } catch (e) {
            output = `ERROR: ${e.message}`;
            ok = false;
          }
          /* stuck-guard: three consecutive identical failures means the loop
             is spinning — stop it and feed the model a corrective hint */
          if (!ok) {
            const sig = tc.name + '\u0000' + (argsRaw && (argsRaw.command || argsRaw.path || argsRaw.pattern) ? String(argsRaw.command || argsRaw.path || argsRaw.pattern) : JSON.stringify(argsRaw || {}));
            if (lastFail === sig) failCount += 1;
            else { lastFail = sig; failCount = 1; }
            if (failCount >= 3) {
              output += '\n[STOP] Same failure repeated 3 times. Do NOT run this again — change the approach entirely, fix the real cause, and move on.';
              stuck = true;
            }
          } else {
            lastFail = null; failCount = 0;
          }
          emit({ type: 'tool_done', id: tc.id, name: tc.name, output, ok, diff });
          history.push({ role: 'tool', tool_call_id: tc.id, content: output });
          if (process.env.NEO_TUI_TEST === '1' && tc.name !== 'ask_question') {
            console.error('__NEOQ_NEXT_TOOL__ ' + JSON.stringify({ name: tc.name }));
          }
        }
        if (stuck) {
          history.push({ role: 'assistant', content: 'The previous identical action failed three times in a row. I will stop retrying it, re-analyze the error, and use a different approach now.' });
          emit({ type: 'text', content: '…' });
        }
        continue;
      }

      if (result.content) history.push({ role: 'assistant', content: result.content });
      emit({ type: 'done', usage: cumulativeUsage });
      return { history, usage: cumulativeUsage };
    }
    emit({ type: 'done', usage: cumulativeUsage, truncated: true });
    return { history, usage: cumulativeUsage };
  } catch (e) {
    if ((e && e.name === 'AbortError') || isAborted()) {
      emit({ type: 'aborted' });
      return { history, usage: cumulativeUsage, aborted: true };
    }
    emit({ type: 'error', message: e.message });
    throw e;
  }
}

module.exports = { MODEL, MODELS, API_BASE, API_KEY, MAX_CONTEXT, WORKDIR, tools, toolDefinitions, SYSTEM_PROMPT, promptPath, reloadPrompt, PLAN_INSTRUCTION, callModel, runAgent, runCompact, executeTool, makeFileDiff, setMode, getMode, getTodos, WRITE_TOOLS, setApiKey, getApiKey, setModel, getModel, setModelRaw, setApiBase, getApiBase, modelCtxLimit, getFiles, swapModels, resetModels, NEO_DEFAULT_MODELS, answerQuestion, cancelAllQuestions, isQuestionPending: () => pendingQuestions.size > 0 };