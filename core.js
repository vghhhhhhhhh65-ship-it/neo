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

/* models available on xkiro (verified live against /v1/models) */
const MODELS = [
  { id: 'openai/gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', tag: 'coder · 128k', ctx: 128000 },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', tag: '1M ctx', ctx: 1048576 },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', tag: '1M ctx · سريع', ctx: 1048576 },
  { id: 'qwen/qwen3-coder-plus:free', name: 'Qwen3 Coder Plus', tag: 'coder · 1M ctx', ctx: 1000000 },
  { id: 'mistralai/codestral-2508', name: 'Codestral', tag: 'coder · 256k', ctx: 262144 },
  { id: 'minimax/minimax-m2.7', name: 'MiniMax M2.7', tag: '204k', ctx: 2097152 },
  { id: 'qwen/qwen3.6-27b:free', name: 'Qwen3.6 27B', tag: '262k', ctx: 262144 },
  { id: 'mistralai/devstral-medium', name: 'Devstral 2', tag: 'coder · 256k', ctx: 262144 },
];
let MODEL = process.env.MODEL || cfg.model || MODELS[1].id;
const setModel = (m) => { if (MODELS.some((x) => x.id === m)) MODEL = m; };
const setModelRaw = (m) => { if (typeof m === 'string' && m.trim()) MODEL = m.trim(); };
const getModel = () => MODEL;
const setApiBase = (u) => { if (typeof u === 'string' && u.trim()) API_BASE = u.trim().replace(/\/+$/, ''); };
const getApiBase = () => API_BASE;
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
];

const SYSTEM_PROMPT = `You are NEO, a professional senior software engineer and coding agent. You have FULL permissions on this machine.

AVAILABLE TOOLSET — use them freely:
1. list_dir(path) — explore folders
2. read_file(path) — read files
3. write_file(path, content) — create/overwrite files (creates folders automatically)
4. edit_file(path, old, new) — exact substring replacement
5. glob(pattern, path) — find files by name
6. grep(pattern, path) — search inside file contents
7. bash(command, cwd) — run ANY shell command (git, node, python, npm, ls, cat, etc)

GROUND RULES:
- Working root is /home. All relative paths resolve there; ABSOLUTE paths are always allowed.
- You have UNRESTRICTED FULL permissions on the whole device — literally ANY command is allowed. On Android/Termux you can access phone storage freely via /storage/emulated/0, /sdcard, /storage, /data (e.g. work with files in /storage/emulated/0/Download, Pictures, Documents, Music, dcim). Use bash 'cd /storage/emulated/0/...' or pass absolute paths.
- Do real work with bash + write_file/edit_file: install packages ('pkg install' / 'npm i') when needed, run builds/tests, manage files, media, archives, git — any command at all.
- For BIG projects: create the structure first (folders + file list), then write each file. Never dump everything in one write.
- Prefer write_file tools (never print whole file content in chat). Show file list / summaries in chat instead, be concise.
- After creating files, run commands to VERIFY they work (node file.js, python3, npm test, etc). Fix errors you find.
- When you write code, explain briefly what you built and how to run it.
- Be professional, clear, confident. Use markdown formatting: headings, code blocks with language tags, bullet lists.
- If the user gives a task in Arabic, RESPOND IN ARABIC (professional, not slang).

WORK STYLE — be a careful, senior engineer. NEVER rush:
- Read the request TWICE before acting. Identify the REAL goal, not just the literal words.
- Start by exploring when there is a codebase (list_dir, read_file, glob, grep). Never assume what files exist.
- Think before calling tools: what are you about to change and why? Consider edge cases, existing conventions, and things you might break.
- Do the task step by step with todo_update so the user sees progress. Verify each step (run the code / tests) before moving on, and fix anything that fails.
- Correctness beats speed — a checked, working result is better than a quick broken one. Prefer the simplest robust solution.
- Before finishing, review your own work critically (like a code review): re-read the code you wrote for bugs, and run the real checks.
- If something is vague, state your assumption and proceed with the most reasonable interpretation.

You work autonomously — just do the task end-to-end, verify, and report the result.`;

const PLAN_INSTRUCTION = `

CURRENT SETTING: PLAN MODE ONLY.
You must PLAN, never execute:
- write_file, edit_file and bash are LOCKED here and not available to you.
- Explore ONLY with the read-only tools (list_dir, read_file, glob, grep).
- Analyze the task and produce a clear, numbered plan of concrete steps.
- Register EVERY planned step with todo_update (status="pending").
- End your reply with exactly: 'خطتي جاهزة — حوّلني إلى وضع Build لتنفيذها' (Plan ready — switch me to Build).
- Do NOT modify, create, run or delete anything.`;

/* ────────────────────────────── MODEL CALL ────────────────────────────── */

async function callModel(messages, onDelta, signal, toolDefs = toolDefinitions) {
  if (!API_KEY) throw new Error('لا يوجد API Key — اكتب /apikey لضبط المفتاح');
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort());
  }
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
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

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`api error ${resp.status}: ${err.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const result = { content: '', reasoning: '', toolCalls: [], usage: null };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
  return result;
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
          emit({ type: 'tool_done', id: tc.id, name: tc.name, output, ok, diff });
          history.push({ role: 'tool', tool_call_id: tc.id, content: output });
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

module.exports = { MODEL, MODELS, API_BASE, API_KEY, MAX_CONTEXT, WORKDIR, tools, toolDefinitions, SYSTEM_PROMPT, PLAN_INSTRUCTION, callModel, runAgent, runCompact, executeTool, makeFileDiff, setMode, getMode, getTodos, WRITE_TOOLS, setApiKey, getApiKey, setModel, getModel, setModelRaw, setApiBase, getApiBase, modelCtxLimit, getFiles };