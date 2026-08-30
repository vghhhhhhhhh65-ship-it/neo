#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);

/* ── auto-update: for "run" and "web" modes we update before starting;
   the interactive TUI does its own update dance inside cli.js ── */
async function maybeAutoUpdate() {
  try {
    const { checkUpdate, applyUpdate, reexec } = require('../update');
    const info = await checkUpdate();
    if (!info) return false;
    await applyUpdate(info);
    process.stdout.write(`\n  ⬆ NEO updated  v${info.current} → v${info.version}  — restarting…\n`);
    reexec(args);
    return true;
  } catch (e) {
    try { process.stdout.write('\n  (NEO auto-update skipped: ' + e.message + ')\n'); } catch {}
    return false;
  }
}

function printHelp() {
  console.log(`Neo Agent — AI coding agent (DeepSeek V4 Pro, 1M context)

Usage:
  neo                         Start interactive terminal chat
  neo run "your task"         Run one prompt and print the reply
  neo web                     Start the web UI
  neo web --hostname 0.0.0.0  Start web UI for all interfaces (like opencode web)
  neo web --port 3000         Custom port (default 3000)

Options:
  --model <id>     Override model (default deepseek/deepseek-v4-pro)
  --key <key>      Override API key
  --workdir <dir>  Override working root (default /home)
`);
}

async function startWeb(opts) {
  process.env.PORT = opts.port || '3000';
  process.env.HOSTNAME = opts.hostname || '0.0.0.0';
  if (opts.model) process.env.MODEL = opts.model;
  const srv = require('../server');
  await srv.start();
}

async function runOnce(prompt, opts) {
  if (opts.model) process.env.MODEL = opts.model;
  if (opts.workdir) process.env.WORKDIR = opts.workdir;
  const { runAgent } = require('../core');
  const { C } = require('../terminal/ansi');

  let reply = '';
  try {
    await runAgent(
      [{ role: 'user', content: prompt }],
      (ev) => {
        if (ev.type === 'text') {
          process.stdout.write(ev.content);
          reply += ev.content;
        } else if (ev.type === 'error') {
          process.stdout.write('\n' + Cred(ev.message) + '\n');
        }
      }
    );
    process.stdout.write('\n');
  } catch (e) {
    console.error(Cred(e.message));
    process.exitCode = 1;
  }
}

function Cred(s) { return `\x1b[31m${s}\x1b[0m`; }

/* ── parse ── */
const opts = {};
let mode = 'chat';
let position = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else if (a === '--version' || a === '-v') { console.log(require('../package.json').version); process.exit(0); }
  else if (a === '--model') opts.model = args[++i];
  else if (a === '--key') opts.key = args[++i];
  else if (a === '--workdir') opts.workdir = args[++i];
  else if (a === '--hostname') opts.hostname = args[++i];
  else if (a === '--port' || a === '-p') opts.port = args[++i];
  else if (a === 'web' || a === 'serve') mode = 'web';
  else if (a === 'run') mode = 'run';
  else position.push(a);
}

if (mode === 'run') {
  const prompt = position.join(' ').trim() || '';
  if (!prompt) { console.error('Usage: neo run "your task"'); process.exit(1); }
  maybeAutoUpdate().then((did) => { if (!did) runOnce(prompt, opts); });
} else if (mode === 'web') {
  maybeAutoUpdate().then((did) => { if (!did) startWeb(opts); });
} else {
  const tui = require('../terminal/cli');
  tui.main();
}