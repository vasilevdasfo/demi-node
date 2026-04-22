// public/app.js — Observer UI logic
// Minimal WebSocket RPC client + i18n + render loop.

// ---------- i18n ----------
const I18N = {
  ru: {
    'app.tagline': 'Суверенные агенты общаются напрямую. Без серверов.',
    'ui.peers': 'Пиры',
    'ui.pair.new': '+ Код',
    'ui.pair.redeem': 'Ввести',
    'ui.pair.redeem.title': 'Ввести код партнёра',
    'ui.cancel': 'Отмена',
    'ui.connect': 'Подключиться',
    'ui.chat.select': 'Выбери пира',
    'ui.send': 'Отправить',
    'ui.health': 'Состояние',
    'ui.uptime': 'Uptime',
    'ui.pubkey': 'Pubkey',
    'ui.fp': 'Fingerprint',
    'ui.wipe': 'Panic Wipe',
    'danger.activist': 'DEMI — v0.1 MVP. Для задач безопасности жизни комбинируй с Signal, Tor и оперсек-практиками.',
    'wipe.confirm': 'Panic Wipe удалит ключ, сообщения и контакты БЕЗВОЗВРАТНО. Напиши YES:',
    'pair.code.title': 'Твой код партнёра (действует 5 минут):',
    'pair.code.hint': 'Поделись им по защищённому каналу. Партнёр вводит его на своей стороне.',
    'chat.placeholder': 'Сообщение...',
    'chat.trusted': 'доверенный',
    'chat.seen': 'видели',
    'me.you': 'ты',
    'me.peer': 'партнёр',
  },
  en: {
    'app.tagline': 'Sovereign agents talk directly. No servers.',
    'ui.peers': 'Peers',
    'ui.pair.new': '+ Code',
    'ui.pair.redeem': 'Redeem',
    'ui.pair.redeem.title': 'Enter partner code',
    'ui.cancel': 'Cancel',
    'ui.connect': 'Connect',
    'ui.chat.select': 'Pick a peer',
    'ui.send': 'Send',
    'ui.health': 'Health',
    'ui.uptime': 'Uptime',
    'ui.pubkey': 'Pubkey',
    'ui.fp': 'Fingerprint',
    'ui.wipe': 'Panic Wipe',
    'danger.activist': 'DEMI — v0.1 MVP. For life-safety scenarios combine with Signal, Tor and op-sec practices.',
    'wipe.confirm': 'Panic Wipe will irreversibly delete key, messages and contacts. Type YES:',
    'pair.code.title': 'Your pairing code (valid for 5 minutes):',
    'pair.code.hint': 'Share over a secure channel. Partner enters it on their node.',
    'chat.placeholder': 'Message...',
    'chat.trusted': 'trusted',
    'chat.seen': 'seen',
    'me.you': 'you',
    'me.peer': 'peer',
  },
};

let LANG = localStorage.getItem('demi.lang') || (navigator.language || 'en').slice(0, 2);
if (!I18N[LANG]) LANG = 'en';

function t(key) {
  return I18N[LANG][key] ?? I18N.en[key] ?? key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  const input = document.getElementById('chat-input');
  if (input) input.placeholder = t('chat.placeholder');
}

// ---------- RPC client ----------
let ws;
let rpcId = 0;
const pending = new Map();

function openWs() {
  return new Promise((resolve) => {
    const url = `ws://${location.host}/`;
    ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'rpc-reply' && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(msg.error));
        else r(msg.result);
      } else if (msg.kind === 'chat-in') {
        if (state.currentPeer === msg.pubkey) appendMsg({ direction: 'in', ...msg });
      }
    });
    ws.addEventListener('close', () => setTimeout(() => openWs().then(bootstrap), 1500));
  });
}

function rpc(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('rpc timeout'));
      }
    }, 15_000);
  });
}

// ---------- state ----------
const state = {
  me: null,
  peers: [],
  currentPeer: null,
};

// ---------- render ----------
function renderMe() {
  if (!state.me) return;
  document.getElementById('me-nick').textContent = state.me.nickname;
  document.getElementById('me-fp').textContent = state.me.fpShort;
  document.getElementById('pubkey').textContent = state.me.pubHex;
  document.getElementById('fp').textContent = state.me.fpShort;
}

function renderPeers() {
  const ul = document.getElementById('peers-list');
  ul.innerHTML = '';
  const others = state.peers.filter((p) => p.pubkey !== state.me?.pubHex);
  for (const p of others) {
    const li = document.createElement('li');
    li.className = 'peer' + (p.pubkey === state.currentPeer ? ' active' : '');
    const name = p.nickname || p.self_nickname || '(no nick)';
    const dot = p.online ? '●' : '○';
    const trust = p.trust === 'trusted' ? t('chat.trusted') : t('chat.seen');
    li.innerHTML = `
      <span class="dot ${p.online ? 'on' : 'off'}">${dot}</span>
      <span class="nick">${escapeHtml(name)}</span>
      <span class="fp">${p.fp_short || ''}</span>
      <span class="trust">${trust}</span>`;
    li.addEventListener('click', () => selectPeer(p.pubkey));
    ul.appendChild(li);
  }
  if (!others.length) {
    ul.innerHTML = '<li class="empty">—</li>';
  }
}

function appendMsg(m) {
  const log = document.getElementById('chat-log');
  const li = document.createElement('li');
  li.className = 'msg ' + (m.direction === 'in' ? 'in' : 'out');
  if (m.flagged) li.classList.add('flagged');
  const ts = (m.ts || new Date().toISOString()).slice(11, 19);
  li.innerHTML = `<span class="ts">${ts}</span><span class="text">${escapeHtml(m.text || '')}</span>`;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

async function renderChat() {
  const log = document.getElementById('chat-log');
  log.innerHTML = '';
  if (!state.currentPeer) {
    document.getElementById('chat-with').textContent = t('ui.chat.select');
    document.getElementById('chat-fp').textContent = '';
    document.getElementById('chat-input').disabled = true;
    document.querySelector('#chat-form button').disabled = true;
    return;
  }
  const peer = state.peers.find((p) => p.pubkey === state.currentPeer);
  document.getElementById('chat-with').textContent = peer?.nickname || peer?.self_nickname || '—';
  document.getElementById('chat-fp').textContent = peer?.fp_short || '';
  document.getElementById('chat-input').disabled = false;
  document.querySelector('#chat-form button').disabled = false;
  const msgs = await rpc('peers.history', { pubkey: state.currentPeer, limit: 200 });
  for (const m of msgs) appendMsg(m);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- actions ----------
async function selectPeer(pubkey) {
  state.currentPeer = pubkey;
  renderPeers();
  await renderChat();
}

async function refreshPeers() {
  state.peers = await rpc('peers.list');
  renderPeers();
}

async function refreshHealth() {
  try {
    const h = await rpc('health');
    document.getElementById('uptime').textContent = `${Math.floor(h.uptime)}s`;
  } catch {}
}

async function bootstrap() {
  state.me = await rpc('identity.whoami');
  renderMe();
  await refreshPeers();
  await refreshHealth();
}

// ---------- events ----------
document.getElementById('lang').value = LANG;
document.getElementById('lang').addEventListener('change', (e) => {
  LANG = e.target.value;
  localStorage.setItem('demi.lang', LANG);
  applyI18n();
  renderPeers();
  renderChat();
});

document.getElementById('btn-pair-new').addEventListener('click', async () => {
  const r = await rpc('pair.new');
  const box = document.getElementById('pair-code');
  box.innerHTML = `<div class="pair-title">${t('pair.code.title')}</div>
    <div class="pair-digits">${r.code}</div>
    <div class="pair-hint">${t('pair.code.hint')}</div>`;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 5 * 60_000);
});

document.getElementById('btn-pair-redeem').addEventListener('click', () => {
  document.getElementById('dlg-redeem').showModal();
});

document.getElementById('dlg-redeem').addEventListener('close', async (e) => {
  if (e.target.returnValue !== 'ok') return;
  const code = document.getElementById('redeem-input').value.trim();
  if (!/^\d{3}-\d{3}$/.test(code)) { alert('Code format: NNN-NNN'); return; }
  try {
    await rpc('pair.redeem', { code });
    await refreshPeers();
  } catch (err) {
    alert('Pair failed: ' + err.message);
  }
});

document.getElementById('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentPeer) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendMsg({ direction: 'out', text, ts: new Date().toISOString() });
  try {
    await rpc('chat.send', { pubkey: state.currentPeer, text });
  } catch (err) {
    appendMsg({ direction: 'out', text: '[send failed: ' + err.message + ']', flagged: true });
  }
});

document.getElementById('btn-wipe').addEventListener('click', () => {
  document.getElementById('dlg-wipe').showModal();
});

document.getElementById('dlg-wipe').addEventListener('close', async (e) => {
  if (e.target.returnValue !== 'ok') return;
  const confirm = document.getElementById('wipe-input').value.trim();
  if (confirm !== 'YES') return;
  try {
    await rpc('panic.wipe', { confirm: 'YES' });
    alert('Wiped. Reload and create new identity.');
    location.reload();
  } catch (err) {
    alert('Wipe failed: ' + err.message);
  }
});

// ---------- init ----------
applyI18n();
openWs().then(bootstrap);
setInterval(refreshPeers, 10_000);
setInterval(refreshHealth, 5_000);
