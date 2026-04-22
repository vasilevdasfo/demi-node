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
    'agents.title': 'Агенты',
    'agents.claims': 'Активные claim',
    'agents.status': 'Последние статусы',
    'agents.none': 'Нет активных агент-событий',
    'agents.ttl.left': 'осталось',
    'agents.stale': 'просрочен',
    'agents.by': 'от',
    'agents.heartbeat': 'пульс',
    'agents.conflict': 'конфликт',
    'agents.handoff': 'передача',
    'agents.qapv': 'Переговоры',
    'agents.question': 'вопрос',
    'agents.answer': 'ответ',
    'agents.proposal': 'предложение',
    'agents.vote': 'голос',
    'agents.vote.yes': 'за',
    'agents.vote.no': 'против',
    'agents.vote.abstain': 'воздерж.',
    'agents.escalate': 'к Дмитрию',
    'agents.pending': 'ждёт ответа',
    'agents.answered': 'отвечено',
    'agents.cost': 'цена',
    'agents.impact': 'эффект',
    'agents.risk': 'риск',
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
    'agents.title': 'Agents',
    'agents.claims': 'Active claims',
    'agents.status': 'Recent statuses',
    'agents.none': 'No agent events yet',
    'agents.ttl.left': 'left',
    'agents.stale': 'stale',
    'agents.by': 'by',
    'agents.heartbeat': 'heartbeat',
    'agents.conflict': 'conflict',
    'agents.handoff': 'handoff',
    'agents.qapv': 'Negotiation',
    'agents.question': 'question',
    'agents.answer': 'answer',
    'agents.proposal': 'proposal',
    'agents.vote': 'vote',
    'agents.vote.yes': 'yes',
    'agents.vote.no': 'no',
    'agents.vote.abstain': 'abstain',
    'agents.escalate': 'to Dmitrii',
    'agents.pending': 'awaiting reply',
    'agents.answered': 'answered',
    'agents.cost': 'cost',
    'agents.impact': 'impact',
    'agents.risk': 'risk',
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
  currentPeerNick: null,
  agents: { claims: new Map(), statuses: new Map(), heartbeats: new Map(), events: [] },
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
  const agent = tryParseAgentFrame(m.text);
  if (agent) li.classList.add('msg-agent', 'agent-' + agent.type);
  const ts = (m.ts || new Date().toISOString()).slice(11, 19);
  let body;
  if (agent) {
    const kv = Object.entries(agent).filter(([k]) => k !== 'type').map(([k, v]) => `<span class="kv"><i>${escapeHtml(k)}</i>=${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</span>`).join(' ');
    body = `<span class="agent-type">${badgeFor(agent.type)} ${escapeHtml(agent.type)}</span> ${kv}`;
  } else {
    body = `<span class="text">${escapeHtml(m.text || '')}</span>`;
  }
  li.innerHTML = `<span class="ts">${ts}</span>${body}`;
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
  state.currentPeerNick = peer?.nickname || peer?.self_nickname || 'peer';
  const msgs = await rpc('peers.history', { pubkey: state.currentPeer, limit: 200 });
  for (const m of msgs) appendMsg(m);
  state.agents = computeAgentState(msgs);
  renderAgents();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- agent dashboard ----------
// Parses chat frames as structured agent RPC when they look like JSON.
// Kinds: claim, release, status, heartbeat, handoff, conflict.
const AGENT_KINDS = new Set(['claim', 'release', 'status', 'heartbeat', 'handoff', 'conflict', 'question', 'answer', 'proposal', 'vote']);

function tryParseAgentFrame(text) {
  if (!text || text[0] !== '{') return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && AGENT_KINDS.has(obj.type)) return obj;
  } catch {}
  return null;
}

// Reduce history → current agent state for the selected peer.
function computeAgentState(msgs) {
  // path -> { frame, peerNick, msgTs }  (most recent claim wins; release clears)
  const claims = new Map();
  // task -> { state, branch, progress, msgTs, peerNick }
  const statuses = new Map();
  // path -> lastHeartbeatMs
  const heartbeats = new Map();
  // id -> { frame, peerNick, msgTs, answered }
  const questions = new Map();
  // id -> { frame, peerNick, msgTs, votes: {yes,no,abstain} }
  const proposals = new Map();
  // transient events for the timeline (last 10)
  const events = [];

  for (const m of msgs) {
    const f = tryParseAgentFrame(m.text);
    if (!f) continue;
    const msgTs = Date.parse(m.ts || '') || Date.now();
    const peerNick = m.direction === 'in' ? (state.currentPeerNick || t('me.peer')) : t('me.you');

    if (f.type === 'claim' && f.path) {
      claims.set(f.path, { frame: f, peerNick, msgTs });
      events.push({ kind: 'claim', path: f.path, peerNick, msgTs, reason: f.reason, ttl: f.ttl });
    } else if (f.type === 'release' && f.path) {
      claims.delete(f.path);
      events.push({ kind: 'release', path: f.path, peerNick, msgTs });
    } else if (f.type === 'status' && f.task) {
      statuses.set(f.task, { state: f.state, branch: f.branch, progress: f.progress, etaMin: f.eta_min, msgTs, peerNick });
      events.push({ kind: 'status', task: f.task, state: f.state, branch: f.branch, progress: f.progress, peerNick, msgTs });
    } else if (f.type === 'heartbeat' && f.claim) {
      heartbeats.set(f.claim, msgTs);
      events.push({ kind: 'heartbeat', path: f.claim, peerNick, msgTs });
    } else if (f.type === 'handoff') {
      events.push({ kind: 'handoff', from: f.from, to: f.to, branch: f.branch, peerNick, msgTs });
    } else if (f.type === 'conflict') {
      events.push({ kind: 'conflict', file: f.file, question: f.question, peerNick, msgTs });
    } else if (f.type === 'question' && f.id) {
      questions.set(f.id, { frame: f, peerNick, msgTs, answered: null });
      events.push({ kind: 'question', id: f.id, topic: f.topic, peerNick, msgTs });
    } else if (f.type === 'answer' && f.ref) {
      const q = questions.get(f.ref);
      if (q) q.answered = { choice: f.choice, reason: f.reason, confidence: f.confidence, peerNick, msgTs };
      events.push({ kind: 'answer', ref: f.ref, choice: f.choice, peerNick, msgTs });
    } else if (f.type === 'proposal' && f.id) {
      proposals.set(f.id, { frame: f, peerNick, msgTs, votes: { yes: [], no: [], abstain: [] } });
      events.push({ kind: 'proposal', id: f.id, about: f.about, escalate: f.escalate_dmitry, peerNick, msgTs });
    } else if (f.type === 'vote' && f.ref) {
      const p = proposals.get(f.ref);
      if (p && ['yes', 'no', 'abstain'].includes(f.vote)) {
        p.votes[f.vote].push({ peerNick, reason: f.reason, msgTs });
      }
      events.push({ kind: 'vote', ref: f.ref, vote: f.vote, peerNick, msgTs });
    }
  }

  return { claims, statuses, heartbeats, questions, proposals, events: events.slice(-12).reverse() };
}

function ensureAgentsPanel() {
  let panel = document.getElementById('agents-panel');
  if (panel) return panel;
  panel = document.createElement('section');
  panel.id = 'agents-panel';
  panel.className = 'agents-panel';
  panel.innerHTML = `
    <div class="agents-head">
      <h3 data-i18n="agents.title">${t('agents.title')}</h3>
      <span class="agents-count" id="agents-count">0</span>
    </div>
    <div class="agents-body">
      <div class="agents-col">
        <div class="agents-label" data-i18n="agents.claims">${t('agents.claims')}</div>
        <ul id="agents-claims" class="agents-list"></ul>
      </div>
      <div class="agents-col">
        <div class="agents-label" data-i18n="agents.qapv">${t('agents.qapv')}</div>
        <ul id="agents-qapv" class="agents-list"></ul>
      </div>
      <div class="agents-col">
        <div class="agents-label" data-i18n="agents.status">${t('agents.status')}</div>
        <ul id="agents-events" class="agents-list"></ul>
      </div>
    </div>
  `;
  document.querySelector('main').appendChild(panel);
  return panel;
}

function fmtRemaining(ms) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function badgeFor(kind) {
  switch (kind) {
    case 'claim': return '🔒';
    case 'release': return '🔓';
    case 'status': return '✓';
    case 'heartbeat': return '·';
    case 'handoff': return '→';
    case 'conflict': return '⚠';
    case 'question': return '?';
    case 'answer': return '!';
    case 'proposal': return '◆';
    case 'vote': return '✓';
    default: return '•';
  }
}

function renderAgents() {
  const panel = ensureAgentsPanel();
  const { claims, statuses, heartbeats, events } = state.agents || { claims: new Map(), statuses: new Map(), heartbeats: new Map(), events: [] };

  const claimsUl = panel.querySelector('#agents-claims');
  const qapvUl = panel.querySelector('#agents-qapv');
  const eventsUl = panel.querySelector('#agents-events');
  const countEl = panel.querySelector('#agents-count');
  const { questions, proposals } = state.agents;

  claimsUl.innerHTML = '';
  const now = Date.now();
  const activeClaims = [];
  for (const [path, rec] of claims) {
    const ttlMs = (rec.frame.ttl || 0) * 1000;
    const expiresAt = rec.msgTs + ttlMs;
    const hb = heartbeats.get(path);
    const lastActivity = hb ? Math.max(hb, rec.msgTs) : rec.msgTs;
    const effectiveExpiry = lastActivity + ttlMs;
    const remaining = effectiveExpiry - now;
    if (remaining <= 0 && ttlMs > 0) continue; // drop expired
    activeClaims.push({ path, rec, remaining, ttlMs });
  }
  activeClaims.sort((a, b) => b.remaining - a.remaining);
  for (const { path, rec, remaining, ttlMs } of activeClaims) {
    const li = document.createElement('li');
    const stale = ttlMs > 0 && remaining < ttlMs / 3;
    li.className = 'claim-item' + (stale ? ' claim-stale' : ' claim-active');
    const reason = rec.frame.reason ? escapeHtml(rec.frame.reason) : '';
    li.innerHTML = `
      <div class="claim-row">
        <span class="claim-badge">🔒</span>
        <code class="claim-path">${escapeHtml(path)}</code>
        <span class="claim-ttl">${ttlMs > 0 ? fmtRemaining(remaining) + ' ' + t('agents.ttl.left') : '∞'}</span>
      </div>
      <div class="claim-meta">${t('agents.by')} <b>${escapeHtml(rec.peerNick)}</b>${reason ? ' · ' + reason : ''}</div>
    `;
    claimsUl.appendChild(li);
  }
  if (activeClaims.length === 0 && statuses.size === 0 && events.length === 0) {
    const li = document.createElement('li');
    li.className = 'claim-item empty';
    li.textContent = t('agents.none');
    claimsUl.appendChild(li);
  }

  // ---- Negotiation column: open questions + open proposals ----
  qapvUl.innerHTML = '';
  const openQuestions = [...(questions || new Map()).entries()]
    .filter(([, q]) => !q.answered)
    .sort((a, b) => b[1].msgTs - a[1].msgTs);
  const allProposals = [...(proposals || new Map()).entries()]
    .sort((a, b) => b[1].msgTs - a[1].msgTs);

  for (const [id, q] of openQuestions) {
    const li = document.createElement('li');
    li.className = 'qapv-item qapv-question';
    const f = q.frame;
    const opts = (f.options || []).map((o, i) => {
      const oid = (o && typeof o === 'object') ? String(o.id ?? i + 1) : String.fromCharCode(65 + i);
      const otxt = (o && typeof o === 'object') ? String(o.text ?? '') : String(o);
      return `<button class="qapv-opt" data-qid="${escapeHtml(id)}" data-choice="${escapeHtml(oid)}">${escapeHtml(oid)}. ${escapeHtml(otxt)}</button>`;
    }).join('');
    li.innerHTML = `
      <div class="qapv-row">
        <span class="qapv-badge">?</span>
        <b class="qapv-topic">${escapeHtml(f.topic || id)}</b>
        <span class="qapv-meta">${t('agents.pending')} · ${t('agents.by')} ${escapeHtml(q.peerNick)}</span>
      </div>
      <div class="qapv-opts">${opts || '<i class="qapv-free">free-form answer</i>'}</div>
    `;
    qapvUl.appendChild(li);
  }

  for (const [id, p] of allProposals) {
    const li = document.createElement('li');
    const f = p.frame;
    const total = p.votes.yes.length + p.votes.no.length + p.votes.abstain.length;
    const decided = total > 0 && (p.votes.yes.length > p.votes.no.length || p.votes.no.length > p.votes.yes.length);
    li.className = 'qapv-item qapv-proposal' + (decided ? ' qapv-decided' : '');
    if (f.escalate_dmitry) li.classList.add('qapv-escalate');
    const meta = [
      f.cost ? `${t('agents.cost')}: ${escapeHtml(f.cost)}` : null,
      f.impact ? `${t('agents.impact')}: ${escapeHtml(f.impact)}` : null,
      f.risk ? `${t('agents.risk')}: ${escapeHtml(f.risk)}` : null,
    ].filter(Boolean).join(' · ');
    li.innerHTML = `
      <div class="qapv-row">
        <span class="qapv-badge">◆</span>
        <b class="qapv-topic">${escapeHtml(f.about || id)}</b>
        ${f.escalate_dmitry ? `<span class="qapv-escalate-tag">⚠ ${t('agents.escalate')}</span>` : ''}
      </div>
      <div class="qapv-change">${escapeHtml(f.change || '')}</div>
      ${meta ? `<div class="qapv-meta">${meta}</div>` : ''}
      <div class="qapv-votes">
        <button class="qapv-vote qapv-yes" data-pid="${escapeHtml(id)}" data-vote="yes">${t('agents.vote.yes')} · ${p.votes.yes.length}</button>
        <button class="qapv-vote qapv-no" data-pid="${escapeHtml(id)}" data-vote="no">${t('agents.vote.no')} · ${p.votes.no.length}</button>
        <button class="qapv-vote qapv-abstain" data-pid="${escapeHtml(id)}" data-vote="abstain">${t('agents.vote.abstain')} · ${p.votes.abstain.length}</button>
      </div>
    `;
    qapvUl.appendChild(li);
  }

  if (openQuestions.length === 0 && allProposals.length === 0) {
    const li = document.createElement('li');
    li.className = 'qapv-item empty';
    li.textContent = t('agents.none');
    qapvUl.appendChild(li);
  }

  // Wire buttons: send answer / vote via chat.send
  qapvUl.querySelectorAll('.qapv-opt').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const qid = btn.dataset.qid;
      const choice = btn.dataset.choice;
      const frame = JSON.stringify({ type: 'answer', ref: qid, choice, ts: Math.floor(Date.now() / 1000) });
      try { await rpc('chat.send', { pubkey: state.currentPeer, text: frame }); } catch {}
    });
  });
  qapvUl.querySelectorAll('.qapv-vote').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.pid;
      const vote = btn.dataset.vote;
      const frame = JSON.stringify({ type: 'vote', ref: pid, vote, ts: Math.floor(Date.now() / 1000) });
      try { await rpc('chat.send', { pubkey: state.currentPeer, text: frame }); } catch {}
    });
  });

  eventsUl.innerHTML = '';
  for (const ev of events) {
    const li = document.createElement('li');
    li.className = 'event-item event-' + ev.kind;
    const time = new Date(ev.msgTs).toISOString().slice(11, 19);
    let body = '';
    if (ev.kind === 'status') body = `<code>${escapeHtml(ev.task)}</code> → <b>${escapeHtml(ev.state || '')}</b>${ev.branch ? ' · ' + escapeHtml(ev.branch) : ''}`;
    else if (ev.kind === 'claim') body = `<code>${escapeHtml(ev.path)}</code>${ev.reason ? ' · ' + escapeHtml(ev.reason) : ''}`;
    else if (ev.kind === 'release') body = `<code>${escapeHtml(ev.path)}</code>`;
    else if (ev.kind === 'heartbeat') body = `<code>${escapeHtml(ev.path)}</code>`;
    else if (ev.kind === 'handoff') body = `${escapeHtml(ev.from || '')} → ${escapeHtml(ev.to || '')}${ev.branch ? ' · ' + escapeHtml(ev.branch) : ''}`;
    else if (ev.kind === 'conflict') body = `<code>${escapeHtml(ev.file || '')}</code>${ev.question ? ' · ' + escapeHtml(ev.question) : ''}`;
    else if (ev.kind === 'question') body = `<code>${escapeHtml(ev.id)}</code>${ev.topic ? ' · ' + escapeHtml(ev.topic) : ''}`;
    else if (ev.kind === 'answer') body = `<code>${escapeHtml(ev.ref)}</code> → <b>${escapeHtml(String(ev.choice ?? ''))}</b>`;
    else if (ev.kind === 'proposal') body = `<code>${escapeHtml(ev.id)}</code>${ev.about ? ' · ' + escapeHtml(ev.about) : ''}${ev.escalate ? ' ⚠' : ''}`;
    else if (ev.kind === 'vote') body = `<code>${escapeHtml(ev.ref)}</code> → <b>${escapeHtml(ev.vote)}</b>`;
    li.innerHTML = `
      <span class="event-ts">${time}</span>
      <span class="event-badge">${badgeFor(ev.kind)}</span>
      <span class="event-body">${body}</span>
      <span class="event-by">${escapeHtml(ev.peerNick || '')}</span>
    `;
    eventsUl.appendChild(li);
  }

  countEl.textContent = String(activeClaims.length);
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
ensureAgentsPanel();
renderAgents();
openWs().then(bootstrap);
setInterval(refreshPeers, 10_000);
setInterval(refreshHealth, 5_000);
// Live refresh of agents panel (re-read current peer's history every 8s).
// Cheap until MID-finish adds WS push; good enough for dashboard.
setInterval(async () => {
  if (!state.currentPeer) { renderAgents(); return; }
  try {
    const msgs = await rpc('peers.history', { pubkey: state.currentPeer, limit: 200 });
    state.agents = computeAgentState(msgs);
    renderAgents();
  } catch {}
}, 8_000);
