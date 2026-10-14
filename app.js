/* DeepChat PY — чат без ключа (Pollinations, анонимно) + Python в браузере (Pyodide) */
'use strict';
const $ = (s) => document.querySelector(s);
const messagesEl = $('#messages'), inputEl = $('#input'), sendBtn = $('#sendBtn'), stopBtn = $('#stopBtn');
const modelSelect = $('#modelSelect'), systemPromptEl = $('#systemPrompt'), tempRange = $('#tempRange'), tempVal = $('#tempVal');
const streamCheck = $('#streamCheck'), privateCheck = $('#privateCheck');
const apiDot = $('#apiDot'), apiStatus = $('#apiStatus'), pyDot = $('#pyDot'), pyStatus = $('#pyStatus'), pyVersionEl = $('#pyVersion');
const pyEditor = $('#pyEditor'), pyOutput = $('#pyOutput'), pyPlots = $('#pyPlots'), pyPackage = $('#pyPackage');
const TEXT_BASE = 'https://text.pollinations.ai';
const LS_KEY = 'deepchat_py_v1';

let chats = [], currentId = null, aborter = null, streaming = false;
let pyodide = null, pyLoading = null, pyInstalled = new Set();

/* ---------- utils ---------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}
function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify({ chats, currentId })); } catch {} }
function load() { try { const d = JSON.parse(localStorage.getItem(LS_KEY)); if (d && Array.isArray(d.chats)) { chats = d.chats; currentId = d.currentId; } } catch {} }
function cur() { return chats.find(c => c.id === currentId); }
function fmtTime(ts) { return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

/* ---------- markdown (лёгкий, без зависимостей) ---------- */
function renderMarkdown(src) {
  const blocks = [];
  // извлекаем ```fence
  let text = esc(src);
  text = text.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (m, lang, code) => {
    const i = blocks.push({ lang: (lang || 'text').toLowerCase(), code: unesc(code) }) - 1;
    return `\u0000BLOCK${i}\u0000`;
  });
  function unesc(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
  // заголовки, bold, italic, inline-code, ссылки, списки, таблицы (простые)
  text = text
    .replace(/^###### (.*)$/gm, '<h6>$1</h6>').replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^(\s*[-*] .+(\n\s*[-*] .+)*)/gm, (m) => '<ul>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^\s*[-*] /, '') + '</li>').join('') + '</ul>')
    .replace(/^(\s*\d+\. .+(\n\s*\d+\. .+)*)/gm, (m) => '<ol>' + m.trim().split('\n').map(l => '<li>' + l.replace(/^\s*\d+\. /, '') + '</li>').join('') + '</ol>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>');
  // таблицы | a | b |
  text = text.replace(/^(\|.+\|\n\|[-| :]+\|\n(\|.+\|\n?)+)/gm, (m) => {
    const rows = m.trim().split('\n').filter(r => !/^\|[-| :一]+\|$/.test(r.trim()));
    const tds = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => `<td>${c.trim()}</td>`).join('');
    const head = rows[0].trim().replace(/^\||\|$/g, '').split('|').map(c => `<th>${c.trim()}</th>`).join('');
    return `<table class="mdtable"><tr>${head}</tr>` + rows.slice(1).map(r => `<tr>${tds(r)}</tr>`).join('') + '</table>';
  });
  text = text.replace(/\n/g, '<br>');
  // вставляем блоки кода обратно
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => codeBlockHTML(blocks[+i]));
  return text;
}
function codeBlockHTML(b) {
  const id = 'cb' + Math.random().toString(36).slice(2, 8);
  const isPy = b.lang === 'python' || b.lang === 'py';
  return `<pre class="codeblock" data-code-id="${id}"><div class="cb-head"><span>${esc(b.lang || 'code')}</span><span class="spacer"></span>` +
    (isPy ? `<button class="cb-btn run" data-run="${id}">▶ Запустить</button><button class="cb-btn" data-tolab="${id}">📥 В лабораторию</button>` : ``) +
    `<button class="cb-btn" data-copy="${id}">⧉ Копировать</button></div>` +
    `<code id="${id}">${esc(b.code)}</code></pre>`;
}

/* ---------- чаты: state + рендер ---------- */
function newChat() {
  const c = { id: uid(), title: 'Новый чат', messages: [], model: modelSelect.value, updated: Date.now() };
  chats.unshift(c); currentId = c.id; save(); renderList(); renderMessages();
}
function renderList() {
  const box = $('#chatList'); box.innerHTML = '';
  if (!chats.length) { box.innerHTML = '<div class="hint">Пока пусто — создай чат ⬆</div>'; return; }
  for (const c of chats) {
    const d = document.createElement('div');
    d.className = 'chat-item' + (c.id === currentId ? ' active' : '');
    d.innerHTML = `<span class="t"></span><button class="del" title="Удалить">🗑</button>`;
    d.querySelector('.t').textContent = c.title;
    d.title = fmtTime(c.updated);
    d.onclick = (e) => { if (e.target.classList.contains('del')) return; currentId = c.id; modelSelect.value = c.model || 'openai'; save(); renderList(); renderMessages(); document.body.classList.remove('side-open'); };
    d.querySelector('.del').onclick = () => { chats = chats.filter(x => x.id !== c.id); if (currentId === c.id) currentId = chats[0]?.id || null; if (!currentId && chats.length === 0) newChat(); save(); renderList(); renderMessages(); };
    box.appendChild(d);
  }
}
function renderMessages() {
  const c = cur();
  messagesEl.innerHTML = '';
  $('#welcome').style.display = (c && c.messages.length) ? 'none' : '';
  if (!c) return;
  for (const m of c.messages) messagesEl.appendChild(msgNode(m));
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // делегирование кнопок кода
  messagesEl.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
    const code = document.getElementById(b.dataset.copy)?.textContent || '';
    navigator.clipboard.writeText(code).then(() => toast('Код скопирован'));
  });
  messagesEl.querySelectorAll('[data-tolab]').forEach(b => b.onclick = () => {
    const code = document.getElementById(b.dataset.tolab)?.textContent || '';
    pyEditor.value = code; setView('split'); ensurePyodide(false); toast('Код отправлен в лабораторию 🐍');
  });
  messagesEl.querySelectorAll('[data-run]').forEach(b => b.onclick = async () => {
    const code = document.getElementById(b.dataset.run)?.textContent || '';
    setView('split'); await runPython(code, b);
  });
  messagesEl.querySelectorAll('[data-resend]').forEach(b => b.onclick = () => {
    inputEl.value = b.dataset.resend; inputEl.focus();
  });
}
function msgNode(m) {
  const d = document.createElement('div');
  d.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
  const av = m.role === 'user' ? '🧑' : '🤖';
  d.innerHTML = `<div class="avatar">${av}</div><div class="bubble"><div class="meta"><span>${m.role === 'user' ? 'Вы' : 'ИИ • ' + esc(m.model || '')}</span><span>• ${fmtTime(m.ts)}</span></div><div class="body"></div><div class="actions"></div></div>`;
  d.querySelector('.body').innerHTML = m.role === 'user' ? esc(m.content).replace(/\n/g, '<br>') : renderMarkdown(m.content);
  const act = d.querySelector('.actions');
  if (m.role === 'ai') {
    act.innerHTML = `<button class="mini" data-c>⧉ Копировать</button><button class="mini" data-r>↺ Ввод как запрос</button>`;
    act.querySelector('[data-c]').onclick = () => navigator.clipboard.writeText(m.content).then(() => toast('Ответ скопирован'));
    act.querySelector('[data-r]').onclick = () => { inputEl.value = m.content; inputEl.focus(); };
  }
  if (m.py) { const p = document.createElement('div'); p.className = 'py-result' + (m.py.error ? ' err' : ''); p.textContent = (m.py.error ? 'Ошибка:\n' : 'Вывод Python:\n') + m.py.text; d.querySelector('.bubble').appendChild(p); }
  return d;
}
function setTitleFromFirst(c) {
  const first = c.messages.find(m => m.role === 'user');
  if (first) c.title = first.content.slice(0, 42) + (first.content.length > 42 ? '…' : '');
}

/* ---------- API без ключа ---------- */
async function checkApi() {
  apiDot.className = 'dot yellow'; apiStatus.textContent = 'API: проверка…';
  try {
    const r = await fetch(TEXT_BASE + '/models', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const ids = Array.isArray(data) ? data.map(m => m.id || m.name).filter(Boolean) : [];
    if (ids.length) {
      const keep = new Set([modelSelect.value, ...ids.slice(0, 12)]);
      modelSelect.innerHTML = [...keep].map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      if (cur()) modelSelect.value = cur().model || [...keep][0];
    }
    apiDot.className = 'dot green'; apiStatus.textContent = 'API: онлайн (без ключа)';
  } catch (e) {
    apiDot.className = 'dot red'; apiStatus.textContent = 'API: недоступен (' + e.message + ')';
  }
}
function buildPayload(c, extra) {
  const msgs = [];
  const sys = systemPromptEl.value.trim();
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of c.messages.slice(-20)) msgs.push({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content });
  if (extra) msgs.push({ role: 'user', content: extra });
  return { model: c.model || modelSelect.value || 'openai', messages: msgs, temperature: parseFloat(tempRange.value) || 0.7, stream: streamCheck.checked, private: privateCheck.checked };
}
async function postOpenAI(payload, onToken, signal) {
  // ВАЖНО: никакого Authorization — иначе 402. Только Content-Type.
  const r = await fetch(TEXT_BASE + '/openai', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw Object.assign(new Error('HTTP ' + r.status + ' ' + t.slice(0, 200)), { status: r.status });
  }
  if (!payload.stream || !r.body) return { text: await r.text().then(parseNonStream), streamed: false };
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      const t = ln.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const tok = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
        if (tok) { full += tok; onToken(full); }
      } catch {}
    }
  }
  return { text: full, streamed: true };
}
function parseNonStream(t) {
  try { const j = JSON.parse(t); return j.choices?.[0]?.message?.content ?? j.choices?.[0]?.text ?? t; }
  catch { return t; }
}
async function fallbackGET(prompt, model) {
  const url = TEXT_BASE + '/' + encodeURIComponent(prompt).slice(0, 1500) + '?model=' + encodeURIComponent(model) + '&private=true';
  const r = await fetch(url);
  if (!r.ok) throw new Error('fallback HTTP ' + r.status);
  return await r.text();
}

/* ---------- отправка ---------- */
async function send(text) {
  text = (text || '').trim();
  if (!text || streaming) return;
  let c = cur(); if (!c) { newChat(); c = cur(); }
  c.model = modelSelect.value;
  c.messages.push({ role: 'user', content: text, ts: Date.now() });
  setTitleFromFirst(c); c.updated = Date.now(); save(); renderList(); renderMessages();
  inputEl.value = ''; autoGrow();
  await askAI(c);
}
async function askAI(c, prefill) {
  streaming = true; sendBtn.classList.add('hidden'); stopBtn.classList.remove('hidden');
  aborter = new AbortController();
  const payload = buildPayload(c, prefill);
  const aiMsg = { role: 'ai', content: prefill ? '' : '…', model: payload.model, ts: Date.now() };
  if (!prefill) { c.messages.push(aiMsg); }
  else { aiMsg.content = ''; c.messages.push(aiMsg); }
  renderMessages();
  const bubbles = messagesEl.querySelectorAll('.msg.ai .body');
  const body = bubbles[bubbles.length - 1];
  const setBody = (t, typing = true) => { if (body) body.innerHTML = renderMarkdown(t || '…') + (typing ? '<span class="typing"></span>' : ''); messagesEl.scrollTop = messagesEl.scrollHeight; };
  try {
    let out;
    try {
      out = await postOpenAI(payload, setBody, aborter.signal);
    } catch (e) {
      if (e.status === 429 || e.status === 402 || String(e.message).includes('429')) {
        setBody('⏳ Бесплатный лимит (1 запрос за раз). Пробую простой GET-режим…');
        const lastUser = [...c.messages].reverse().find(m => m.role === 'user')?.content || '';
        out = { text: await fallbackGET(lastUser, payload.model), streamed: false };
      } else throw e;
    }
    aiMsg.content = out.text.trim() || '(пустой ответ)';
    aiMsg.model = payload.model;
  } catch (e) {
    if (e.name === 'AbortError') aiMsg.content = (aiMsg.content && aiMsg.content !== '…') ? aiMsg.content + '\n\n_— остановлено пользователем_' : '_Остановлено._';
    else aiMsg.content = `⚠️ Не получилось получить ответ: ${e.message}\n\nСоветы:\n- подожди ~30 сек (free-лимит: 1 запрос за раз)\n- проверь интернет / VPN\n- попробуй другую модель в шапке`;
  }
  c.updated = Date.now(); save(); renderMessages();
  streaming = false; sendBtn.classList.remove('hidden'); stopBtn.classList.add('hidden');
}

/* ---------- Python (Pyodide) ---------- */
const PY_CDNS = [
  'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/',
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
  'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/'
];
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('CDN недоступен: ' + src)); document.head.appendChild(s);
  });
}
async function ensurePyodide(showToast = true) {
  if (pyodide) return pyodide;
  if (pyLoading) return pyLoading;
  pyLoading = (async () => {
    pyDot.className = 'dot yellow'; pyStatus.textContent = 'Python: загрузка…'; pyOutput.textContent = 'Загружаю Pyodide (первый раз ~10–20 сек)…';
    let lastErr = null;
    for (const base of PY_CDNS) {
      try {
        await loadScript(base + 'pyodide.js');
        pyodide = await loadPyodide({ indexURL: base });
        pyodide.setStdout({ batched: (s) => { pyodide._buf = (pyodide._buf || '') + s + '\n'; } });
        pyodide.setStderr({ batched: (s) => { pyodide._buf = (pyodide._buf || '') + s + '\n'; } });
        try { await pyodide.loadPackage('micropip'); } catch {}
        pyVersionEl.textContent = '• ' + (pyodide.runPython('import sys; sys.version.split()[0]') || '');
        pyDot.className = 'dot green'; pyStatus.textContent = 'Python: готов'; pyOutput.textContent = 'Готов! Нажми ▶ Запустить. Пространство имён сохраняется между запусками.';
        if (showToast) toast('Python готов 🐍');
        return pyodide;
      } catch (e) { lastErr = e; }
    }
    pyDot.className = 'dot red'; pyStatus.textContent = 'Python: ошибка загрузки';
    pyOutput.textContent = 'Не удалось загрузить Pyodide: ' + (lastErr?.message || lastErr) + '\nПроверь интернет (нужен доступ к cdn.jsdelivr.net).';
    pyLoading = null; throw lastErr;
  })();
  return pyLoading;
}
async function maybeInstall(code) {
  const wants = [];
  if (/import matplotlib|from matplotlib|import numpy|import pandas|import sklearn|import scipy/.test(code)) {
    if (/matplotlib/.test(code) && !pyInstalled.has('matplotlib')) wants.push('matplotlib');
    if (/numpy/.test(code) && !pyInstalled.has('numpy')) wants.push('numpy');
    if (/pandas/.test(code) && !pyInstalled.has('pandas')) wants.push('pandas');
  }
  for (const p of wants) {
    pyOutput.textContent += `\n📦 ставлю ${p}…`;
    await pyodide.loadPackage(p); pyInstalled.add(p);
  }
}
async function runPython(code, fromBtn) {
  code = code ?? pyEditor.value;
  if (!code.trim()) { toast('Пустой код'); return; }
  await ensurePyodide();
  const t0 = performance.now();
  pyPlots.innerHTML = ''; pyOutput.textContent = '⏳ Выполняю…';
  if (fromBtn) { fromBtn.disabled = true; fromBtn.textContent = '⏳…'; }
  pyodide._buf = '';
  try {
    await maybeInstall(code);
    pyodide._buf = '';
    const res = await pyodide.runPythonAsync(code);
    // графики matplotlib
    let plots = [];
    try {
      const js = await pyodide.runPythonAsync(`
import io, base64
_plots = []
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    for _n in plt.get_fignums():
        _fig = plt.figure(_n)
        _buf = io.BytesIO()
        _fig.savefig(_buf, format='png', bbox_inches='tight')
        _plots.append(base64.b64encode(_buf.getvalue()).decode())
        plt.close(_fig)
except Exception:
    pass
_plots
`);
      plots = js?.toJs ? [...js.toJs()] : (Array.isArray(js) ? js : []);
    } catch {}
    let out = pyodide._buf || '';
    if ((res !== undefined) && !out.endsWith(String(res) + '\n') && code.trim().split('\n').length <= 6) out += (out && !out.endsWith('\n') ? '\n' : '') + String(res);
    if (!out) out = '✓ Выполнено без вывода.';
    const dt = ((performance.now() - t0) / 1000).toFixed(2);
    pyOutput.textContent = out + `\n— ${dt} сек —`;
    for (const b64 of plots) { const img = document.createElement('img'); img.src = 'data:image/png;base64,' + b64; pyPlots.appendChild(img); }
    return { text: out, error: null };
  } catch (e) {
    const msg = String(e?.message || e).replace(/PythonError:\s*/, '');
    pyOutput.textContent = '❌ Ошибка:\n' + msg;
    pyodide._lastError = msg;
    return { text: msg, error: true };
  } finally {
    if (fromBtn) { fromBtn.disabled = false; fromBtn.textContent = '▶ Запустить'; }
  }
}

const EXAMPLES = {
  hello: `print("Привет из браузера! 🐍")\nfor i in range(5):\n    print(f"{i}² = {i**2}")\n`,
  numpy: `import numpy as np\ntry:\n    import pandas as pd\n    s = pd.Series([1, 2, 3, 4])\n    print(s.describe())\nexcept ImportError:\n    print("pandas нет, считаю в numpy:")\na = np.arange(10)\nprint("mean:", a.mean(), "sum:", a.sum())\n`,
  plot: `import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nimport math\nxs = [i/10 for i in range(0, 63)]\nys = [math.sin(x) for x in xs]\nplt.figure()\nplt.plot(xs, ys)\nplt.title("sin(x)")\nplt.xlabel("x"); plt.ylabel("y")\nprint("первые 5 точек:", list(zip(xs[:5], [round(y,3) for y in ys[:5]])))\n`,
  fib: `def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        yield a\n        a, b = b, a + b\n\nprint(list(fibonacci(10)))\n`,
  input_demo: `# Ввод данных: просто поменяй переменные и жми Запустить\nname = "Айгерим"\nage = 21\nprint(f"Привет, {name}! Через год тебе будет {age+1}.")\nnums = [3, 1, 4, 1, 5, 9]\nprint("sorted:", sorted(nums), "sum:", sum(nums))\n`
};

/* ---------- view / события ---------- */
function setView(v) {
  const ct = $('#content'), pp = $('#pyPane');
  $('#viewChatBtn').classList.toggle('active', v === 'chat');
  $('#viewSplitBtn').classList.toggle('active', v === 'split');
  $('#viewPyBtn').classList.toggle('active', v === 'py');
  ct.classList.toggle('split', v === 'split');
  ct.classList.toggle('pyonly', v === 'py');
  pp.classList.toggle('hidden', v === 'chat');
  if (v !== 'chat' && !pyodide && !pyLoading) ensurePyodide(false);
}
function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px'; }

function init() {
  load();
  if (!chats.length) { chats = [{ id: uid(), title: 'Новый чат', messages: [], model: 'openai', updated: Date.now() }]; currentId = chats[0].id; }
  if (!cur()) currentId = chats[0].id;
  modelSelect.value = cur().model || 'openai';
  pyEditor.value = EXAMPLES.hello;
  renderList(); renderMessages(); checkApi();

  $('#newChatBtn').onclick = newChat;
  modelSelect.onchange = () => { const c = cur(); if (c) { c.model = modelSelect.value; save(); } };
  tempRange.oninput = () => tempVal.textContent = tempRange.value;
  sendBtn.onclick = () => send(inputEl.value);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(inputEl.value); } });
  inputEl.addEventListener('input', autoGrow);
  stopBtn.onclick = () => aborter?.abort();
  document.querySelectorAll('[data-q]').forEach(b => b.onclick = () => send(b.dataset.q));
  document.querySelectorAll('[data-py-example]').forEach(b => b.onclick = () => {
    pyEditor.value = EXAMPLES[b.dataset.pyExample] || ''; setView('split'); ensurePyodide(false);
    $('#pyExampleSelect').value = b.dataset.pyExample; toast('Пример загружен — жми ▶');
  });

  $('#viewChatBtn').onclick = () => setView('chat');
  $('#viewSplitBtn').onclick = () => setView('split');
  $('#viewPyBtn').onclick = () => setView('py');
  $('#settingsBtn').onclick = () => $('#settingsPanel').classList.toggle('hidden');
  $('#sidebarOpen').onclick = () => document.body.classList.add('side-open');
  $('#sidebarClose').onclick = () => document.body.classList.remove('side-open');

  $('#exportMdBtn').onclick = () => {
    const c = cur(); if (!c) return;
    const md = `# ${c.title}\n\n` + c.messages.map(m => (m.role === 'user' ? '**Вы:** ' : `**ИИ (${m.model || ''}):** `) + m.content).join('\n\n---\n\n');
    dl(md, 'chat.md', 'text/markdown');
  };
  $('#exportJsonBtn').onclick = () => { const c = cur(); if (c) dl(JSON.stringify(c, null, 2), 'chat.json', 'application/json'); };
  $('#clearChatBtn').onclick = () => { const c = cur(); if (c) { c.messages = []; save(); renderMessages(); } };
  function dl(text, name, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }

  // python pane
  $('#pyLoadBtn').onclick = () => ensurePyodide();
  $('#pyRunBtn').onclick = () => runPython(pyEditor.value);
  $('#pyClearBtn').onclick = () => { pyOutput.textContent = ''; pyPlots.innerHTML = ''; };
  $('#pyResetBtn').onclick = async () => { pyodide = null; pyLoading = null; pyInstalled = new Set(); pyOutput.textContent = 'Сброшено. Жми ▶ для перезапуска.'; pyDot.className = 'dot gray'; pyStatus.textContent = 'Python: не загружен'; };
  $('#pyExampleSelect').onchange = (e) => { pyEditor.value = EXAMPLES[e.target.value] || ''; };
  pyEditor.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runPython(pyEditor.value); } });
  $('#pyInstallBtn').onclick = async () => {
    const pkg = pyPackage.value.trim(); if (!pkg) return toast('Введи имя пакета');
    await ensurePyodide(); pyOutput.textContent = `📦 ставлю ${pkg} через micropip…`;
    try { const mp = pyodide.pyimport('micropip'); await mp.install(pkg); pyOutput.textContent = `✓ ${pkg} установлен.`; }
    catch (e) { pyOutput.textContent = '❌ pip install не удался:\n' + (e.message || e); }
  };
  $('#pyExplainBtn').onclick = () => {
    setView('split');
    send(`Объясни построчно этот Python-код:\n\`\`\`python\n${pyEditor.value.slice(0, 3000)}\n\`\`\``);
  };
  $('#pyFixBtn').onclick = () => {
    const err = pyodide?._lastError || pyOutput.textContent.slice(0, 1500);
    setView('split');
    send(`Вот мой Python-код:\n\`\`\`python\n${pyEditor.value.slice(0, 3000)}\n\`\`\`\nОшибка:\n\`\`\`\n${err}\n\`\`\`\nИсправь код и объясни, в чём была проблема.`);
  };
  $('#pyToChatBtn').onclick = () => {
    const c = cur(); if (!c) return;
    c.messages.push({ role: 'user', content: 'Мой код:\n```python\n' + pyEditor.value.slice(0, 3000) + '\n```', ts: Date.now() });
    save(); renderMessages(); setView('split'); toast('Код вставлен в чат');
  };
}
document.addEventListener('DOMContentLoaded', init);
