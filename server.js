'use strict';

const express = require('express');
const path = require('path');
const { MODEL, API_BASE, API_KEY, MAX_CONTEXT, WORKDIR, runAgent } = require('./core');

let _app;

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/api/chat', async (req, res) => {
    const clientMessages = (req.body.messages || []).slice(-20);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const sendError = (msg) => send({ type: 'error', message: msg });

    try {
      await runAgent(clientMessages, (ev) => send(ev));
    } catch (e) {
      if (!res.headersSent) res.status(500).end();
      else sendError(e.message);
    }
    res.end();
  });

  app.get('/api/info', (req, res) => {
    res.json({ model: MODEL, apiBase: API_BASE, maxContext: MAX_CONTEXT, workdir: WORKDIR });
  });

  return app;
}

async function start() {
  const port = parseInt(process.env.PORT || '3000', 10);
  const hostname = process.env.HOSTNAME || '127.0.0.1';
  _app = _app || createApp();
  return new Promise((resolve) => {
    const srv = _app.listen(port, hostname, () => {
      console.log(`🟢 NEO Agent web → http://${hostname}:${port}`);
      console.log(`   Model: ${MODEL} | Context: ${(MAX_CONTEXT / 1048576).toFixed(0)}M | Key: ${API_KEY.slice(0, 12)}…`);
      resolve(srv);
    });
  });
}

module.exports = { createApp, start };

if (require.main === module) start();