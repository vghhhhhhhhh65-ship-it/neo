'use strict';

/* ═══════════════════════════ STATE ═══════════════════════════ */
const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const statPrompt = document.getElementById('statPrompt');
const statCompletion = document.getElementById('statCompletion');
const statTotal = document.getElementById('statTotal');
const ctxFill = document.getElementById('ctxFill');
const ctxNum = document.getElementById('ctxNum');

const state = {
  messages: [],
  busy: false,
  tokens: { prompt: 0, completion: 0 },
  contextMax: 1048576,
};

let activeAssistantEl = null;
let activeToolCard = null;
let activeFinalizing = false;
let thinkBoxEl = null;
let thinkContent = '';

/* ═══════════════════════════ UTILS ═══════════════════════════ */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function scrollBottom() {
  requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; });
}

/* ═══════════════════════════ MARKDOWN ═══════════════════════════ */
function renderMarkdown(src) {
  const blocks = [];
  let text = String(src);
  let stripped = '';

  const fenceRe = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIdx = 0, m;
  while ((m = fenceRe.exec(text)) !== null) {
    stripped += text.slice(lastIdx, m.index);
    blocks.push({ type: 'fence', lang: m[1] || 'code', code: m[2].replace(/\n$/, '') });
    lastIdx = m.index + m[0].length;
  }
  stripped += text.slice(lastIdx);

  const inlineRe = /`([^`\n]+)`/g;
  stripped = stripped.replace(inlineRe, (_, c) => `<pre class="inline">${esc(c)}</pre>`);

  let html = '';
  const lines = stripped.split('\n');
  let inUl = false, inOl = false, inBlockquote = false;

  const close = (type) => {
    if (type === 'ul' && inUl) { html += '</ul>'; inUl = false; }
    if (type === 'ol' && inOl) { html += '</ol>'; inOl = false; }
    if (type === 'bq' && inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { close('ul'); close('ol'); close('bq'); continue; }

    /* headings */
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { close('ul'); close('ol'); close('bq'); const n = h[1].length; html += `<h${n}>${h[2]}</h${n}>`; continue; }

    /* hr */
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { close('ul'); close('ol'); close('bq'); html += '<hr>'; continue; }

    /* blockquote */
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { if (!inBlockquote) { html += '<blockquote>'; inBlockquote = true; } html += esc(bq[1]) + '<br>'; continue; }

    /* lists */
    const ul = line.match(/^[-*•]\s+(.*)$/);
    if (ul) { if (!inUl) { close('ol'); html += '<ul>'; inUl = true; } html += `<li>${inline(ul[1])}</li>`; continue; }
    else if (inUl) { close('ul'); }

    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) { if (!inOl) { close('ul'); html += '<ol>'; inOl = true; } html += `<li>${inline(ol[1])}</li>`; continue; }
    else if (inOl) { close('ol'); }

    /* code continuation inside list? handled above. */
    html += `<p>${inline(line)}</p>`;
  }
  close('ul'); close('ol'); close('bq');

  for (const b of blocks) {
    if (b.type === 'fence') {
      const id = 'cb_' + Math.random().toString(36).slice(2, 9);
      html += `
        <div class="code-block">
          <div class="code-header">
            <span class="code-lang">${esc(b.lang)}</span>
            <button class="copy-btn" data-target="${id}">Copy</button>
          </div>
          <pre id="${id}"><code>${esc(b.code)}</code></pre>
        </div>`;
    }
  }
  return html;
}

function inline(s) {
  let out = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, (_, c) => `<code class="inline">${esc(c)}</code>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out.replace(/\*/g, '').replace(/_/g, '').replace(/~{2}/g, '').replace(/#/g, '');
}

/* ═══════════════════════════ DOM HELPERS ═══════════════════════════ */
function addMessage(role, html) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const av = role === 'assistant' ? 'N' : 'ا';
  wrap.innerHTML = `
    <div class="avatar">${av}</div>
    <div class="bubble">${html}</div>`;
  chatEl.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function appendNote(text) {
  const n = document.createElement('div');
  n.className = 'msg-note';
  n.innerHTML = `<span class="dot green"></span>${esc(text)}`;
  chatEl.appendChild(n);
  scrollBottom();
}

function addToolCard(ev) {
  const card = document.createElement('div');
  card.className = 'tool-card running';
  const icon = { read_file: '📖', write_file: '✍️', edit_file: '🔧', list_dir: '📂', glob: '🔍', grep: '🔎', bash: '⚡', view_image: '🖼️', web_search: '🌐', web_fetch: '📄', ask_question: '❓', todo_update: '✅' }[ev.name] || '🛠️';
  const args = Object.entries(ev.args || {})
    .slice(0, 2)
    .map(([k, v]) => {
      let s = String(v); if (s.length > 80) s = s.slice(0, 80) + '…';
      return `${k}=${s}`;
    })
    .join('  ');
  card.innerHTML = `
    <div class="tool-header">
      <div class="tool-icon">${icon}</div>
      <span class="tool-name">${esc(ev.name)}</span>
      <span class="tool-status"><span class="spin"></span>running</span>
      <span class="tool-chev">▼</span>
    </div>
    ${args ? `<div class="tool-args">${esc(args)}</div>` : ''}
    <div class="tool-output"></div>`;
  card.querySelector('.tool-header').addEventListener('click', () => {
    card.classList.toggle('open');
    card.querySelector('.tool-output').scrollTop = card.querySelector('.tool-output').scrollHeight;
  });
  chatEl.appendChild(card);
  scrollBottom();
  state.activeToolCard = card;
  return card;
}

function finishToolCard(output, ok) {
  const card = state.activeToolCard;
  if (!card) return;
  card.classList.remove('running');
  card.classList.add(ok ? 'ok' : 'err');
  const st = card.querySelector('.tool-status');
  st.innerHTML = ok ? `✓ done` : `✕ error`;
  st.classList.add(ok ? 'ok' : 'err');
  const out = card.querySelector('.tool-output');
  out.textContent = output;
  state.activeToolCard = null;
}

/* ═══════════════════════════ METRICS ═══════════════════════════ */
function updateMetrics(prompt, completion) {
  state.tokens.prompt += prompt;
  state.tokens.completion += completion;
  statPrompt.textContent = formatNum(state.tokens.prompt);
  statCompletion.textContent = formatNum(state.tokens.completion);
  const total = state.tokens.prompt + state.tokens.completion;
  statTotal.textContent = formatNum(total);
  const pct = Math.min(100, (total / state.contextMax) * 100);
  ctxFill.style.width = `${pct}%`;
  ctxNum.textContent = `${pct.toFixed(1)}%`;
}
function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/* ═══════════════════════════ STREAMING ═══════════════════════════ */
function beginAssistantBubble(restoreHtml) {
  activeAssistantEl = addMessage('assistant', restoreHtml || '<div class="typing"><i></i><i></i><i></i></div>');
}

function ensureThinkBox() {
  if (thinkBoxEl) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = `
    <div class="avatar think-av">◌</div>
    <div class="think-box">
      <div class="think-head">
        <span class="think-title">◯ think</span>
        <span class="think-state"><span class="spin"></span> thinking…</span>
      </div>
      <div class="think-body"></div>
    </div>`;
  chatEl.appendChild(wrap);
  thinkBoxEl = wrap;
  scrollBottom();
}
function streamThink(chunk) {
  ensureThinkBox();
  thinkContent += chunk;
  const body = thinkBoxEl.querySelector('.think-body');
  body.textContent = thinkContent;
  scrollBottom();
}
function finishThinkBox() {
  if (!thinkBoxEl) return;
  thinkBoxEl.querySelector('.think-state').innerHTML = 'done';
  thinkContent = '';
  thinkBoxEl = null;
}
function streamText(chunk) {
  if (!activeAssistantEl) beginAssistantBubble('');
  const bubble = activeAssistantEl.querySelector('.bubble');
  const typing = bubble.querySelector('.typing');
  if (typing) {
    typing.remove();
    bubble.innerHTML = '';
    activeAssistantEl.dataset.html = '';
  }
  const prev = activeAssistantEl.dataset.html || '';
  const next = prev + chunk;
  if (next.length < 3000) {
    /* live-update raw then re-render on chunk for cheap partial view */
    bubble.innerHTML = renderMarkdown(next);
    activeAssistantEl.dataset.html = next;
    scrollBottom();
  } else {
    activeAssistantEl.dataset.html = next;
    scrollBottom();
  }
}

/* ═══════════════════════════ AGENT LOOP ═══════════════════════════ */
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || state.busy) return;

  state.busy = true;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;
  sendBtn.classList.remove('send-up');

  state.messages.push({ role: 'user', content: text });
  addMessage('user', esc(text));

  activeAssistantEl = null;
  activeFinalizing = false;

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.messages }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

        switch (ev.type) {
          case 'reasoning':
            streamThink(ev.content);
            break;
          case 'reasoning_done':
            finishThinkBox();
            break;
          case 'text':
            finishThinkBox();
            streamText(ev.content);
            break;
          case 'iteration':
            appendNote(`↻ iteration loop ${ev.n}…`);
            break;
          case 'tool_start':
            finishThinkBox();
            activeFinalizing = false;
            addToolCard(ev);
            break;
          case 'tool_done':
            finishToolCard(ev.output.length > 1500 ? ev.output.slice(0, 1500) + '\n…(truncated)' : ev.output, !ev.output.startsWith('ERROR'));
            break;
          case 'usage':
            updateMetrics(ev.prompt_tokens || 0, ev.completion_tokens || 0);
            break;
          case 'error':
            appendNote('✕ ' + ev.message);
            break;
          case 'done':
            activeFinalizing = true;
            break;
        }
      }
    }
  } catch (e) {
    appendNote('✕ Connection error: ' + e.message);
  }

  if (activeAssistantEl) {
    const html = activeAssistantEl.dataset.html || activeAssistantEl.querySelector('.bubble').innerHTML;
    state.messages.push({ role: 'assistant', content: html });
    if (html && activeAssistantEl.dataset.html) {
      activeAssistantEl.querySelector('.bubble').innerHTML = renderMarkdown(html);
    }
  }

  state.busy = false;
  sendBtn.disabled = false;
  scrollBottom();
}

/* ═══════════════════════════ COPY BUTTONS ═══════════════════════════ */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const target = document.getElementById(btn.dataset.target);
  if (!target) return;
  navigator.clipboard.writeText(target.textContent).then(() => {
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  }).catch(() => {
    /* fallback */
    const r = document.createRange();
    r.selectNode(target);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    document.execCommand('copy');
    btn.textContent = '✓ Copied';
  });
});

/* ═══════════════════════════ INPUT ═══════════════════════════ */
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  sendBtn.classList.toggle('send-up', inputEl.value.trim().length > 0);
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener('click', sendMessage);

/* load model info */
fetch('/api/info').then((r) => r.json()).then((info) => {
  state.contextMax = info.maxContext;
  document.getElementById('modelName').textContent = info.model.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  document.getElementById('hintModel').textContent = `${info.model.split('/').pop()} • ${(info.maxContext / 1048576)}M context`;
}).catch(() => {});

inputEl.focus();