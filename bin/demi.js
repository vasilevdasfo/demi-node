#!/usr/bin/env node
// bin/demi.js — DEMI CLI
// Talks to the running node via WebSocket RPC on 127.0.0.1:4321
import { program } from 'commander';
import WebSocket from 'ws';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, paths } from '../src/paths.js';
import { loadLocale, t } from '../src/i18n.js';
import { agentFrameText } from '../src/wire.js';
import fs from 'node:fs';

const cfg = loadConfig();
loadLocale(cfg.lang);

function rpc(method, args = {}, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${cfg.uiPort || 4321}/`;
    const ws = new WebSocket(url, { headers: { origin: `http://127.0.0.1:${cfg.uiPort || 4321}` } });
    let id = 1;
    const timer = setTimeout(() => { ws.close(); reject(new Error('rpc timeout')); }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'rpc', id, method, args }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'rpc-reply' && msg.id === id) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(new Error(`Node not running on :${cfg.uiPort || 4321}. Start it with 'demi start'. (${e.message})`)); });
  });
}

program
  .name('demi')
  .description('DEMI Agent Club — sovereign P2P AI-agent network')
  .version('0.1.0-alpha.1');

program.command('status')
  .description('Show node status')
  .action(async () => {
    const active = fs.existsSync(paths.active);
    console.log(active ? t('cli.status.running') : t('cli.status.stopped'));
    if (!active) return;
    try {
      const me = await rpc('identity.whoami');
      const h = await rpc('health');
      console.log(`Nickname:    ${me.nickname}`);
      console.log(`Fingerprint: ${me.fpShort}`);
      console.log(`Pubkey:      ${me.pubHex}`);
      console.log(`Uptime:      ${Math.floor(h.uptime)}s`);
    } catch (e) { console.error(e.message); }
  });

program.command('peers')
  .description('List known peers')
  .action(async () => {
    const list = await rpc('peers.list');
    if (!list.length) return console.log(t('cli.peers.empty'));
    for (const p of list) {
      const name = p.nickname || p.self_nickname || '(no nick)';
      const on = p.online ? '●' : '○';
      console.log(`${on} ${name.padEnd(20)} ${p.fp_short}  trust=${p.trust}`);
    }
  });

program.command('pair')
  .description('Create or redeem pairing code')
  .option('--new', 'Create new pairing code')
  .argument('[code]', 'Pairing code to redeem, e.g. 384-921')
  .action(async (code, opts) => {
    if (opts.new) {
      const r = await rpc('pair.new');
      console.log(t('pair.code', { code: r.code }));
      console.log(t('pair.code.hint'));
      console.log('\nShare this code with your friend over a secure channel.');
      console.log('When they enter it, both nodes will connect automatically.');
      return;
    }
    if (!code) { program.error('Provide a code or use --new'); }
    console.log(t('pair.redeeming', { code }));
    try {
      // Pair handshake can take up to 5 min — generous CLI timeout
      const r = await rpc('pair.redeem', { code }, { timeoutMs: 5 * 60 * 1000 });
      console.log(t('pair.success', { nick: r.peer?.nickname || '?', fp: r.peer?.pubHex?.slice(0, 8) || '?' }));
    } catch (e) {
      console.error(t('pair.failed', { reason: e.message }));
    }
  });

program.command('send')
  .description('Send a message to a peer')
  .argument('<nickname-or-pubkey>', 'Peer nickname or pubkey (hex)')
  .argument('<text...>', 'Message text')
  .action(async (target, textArr) => {
    const { getPeerByNickname, getPeer } = await import('../src/db.js');
    const { openDb } = await import('../src/db.js');
    openDb();
    let pubkey = target;
    if (!/^[0-9a-f]{64}$/.test(target)) {
      const p = getPeerByNickname(target);
      if (!p) return console.error('Peer not found: ' + target);
      pubkey = p.pubkey;
    }
    const text = textArr.join(' ');
    const r = await rpc('chat.send', { pubkey, text });
    if (r.ok) console.log(t('chat.sent', { peer: target, text: text.slice(0, 80) }));
    else console.error('Failed: not delivered');
  });

program.command('history')
  .description('Show chat history with peer')
  .argument('<nickname-or-pubkey>')
  .option('--last <n>', 'Number of messages', '20')
  .action(async (target, opts) => {
    const { getPeerByNickname, openDb } = await import('../src/db.js');
    openDb();
    let pubkey = target;
    if (!/^[0-9a-f]{64}$/.test(target)) {
      const p = getPeerByNickname(target);
      if (!p) return console.error('Peer not found: ' + target);
      pubkey = p.pubkey;
    }
    const msgs = await rpc('peers.history', { pubkey, limit: Number(opts.last) });
    for (const m of msgs) {
      const who = m.direction === 'in' ? '←' : '→';
      const flag = m.flagged ? ' [flagged]' : '';
      console.log(`${m.ts.slice(0, 19)} ${who}${flag} ${m.text}`);
    }
  });

program.command('wipe')
  .description('PANIC WIPE — irreversibly delete identity, messages, peers')
  .option('--force', 'Skip confirmation (dangerous)')
  .action(async (opts) => {
    if (!opts.force) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const ans = await rl.question(t('wipe.confirm') + ' ');
      rl.close();
      if (ans.trim() !== 'YES') {
        console.log(t('wipe.cancelled'));
        return;
      }
    }
    try {
      const r = await rpc('panic.wipe', { confirm: 'YES' });
      console.log(t('wipe.done', { count: r.wiped }));
    } catch {
      // Node may be down; wipe locally anyway
      const { panicWipe } = await import('../src/identity.js');
      const r = panicWipe();
      console.log(t('wipe.done', { count: r.wiped }));
    }
  });

program.command('start')
  .description('Start the node (foreground)')
  .action(async () => {
    await import('../src/index.js');
  });

// ---------- Agent RPC shortcuts (claim / release / status / heartbeat / handoff) ----------
// Resolve a nickname or hex pubkey to a pubkey. Opens the DB lazily.
async function resolvePeer(target) {
  if (/^[0-9a-f]{64}$/.test(target)) return target;
  const { getPeerByNickname, openDb } = await import('../src/db.js');
  openDb();
  const p = getPeerByNickname(target);
  if (!p) throw new Error('Peer not found: ' + target);
  return p.pubkey;
}

// Send a pre-serialised agent frame as a chat message and print a tiny receipt.
async function sendAgent(target, type, payload) {
  const pubkey = await resolvePeer(target);
  return sendAgentTo(pubkey, target, type, payload);
}

// Same as sendAgent but skips re-resolving the peer — used by callers that
// already have the peer pubkey (e.g. signed review frames that must bind
// `recipient` to the pubkey BEFORE signing).
async function sendAgentTo(pubkey, label, type, payload) {
  const text = agentFrameText(type, payload);
  const r = await rpc('chat.send', { pubkey, text });
  if (r.ok) console.log(`→ ${type} (${label}): ${text}`);
  else console.error('Failed: not delivered');
}

program.command('claim')
  .description('Claim a file / path so other agents see it as locked')
  .argument('<peer>', 'Peer nickname or pubkey')
  .argument('<path>', 'File path to claim')
  .option('--ttl <seconds>', 'Claim TTL in seconds', '600')
  .option('--reason <text>', 'Reason for the claim')
  .option('--session <name>', 'Session name (free-form)')
  .action(async (peer, path, opts) => {
    await sendAgent(peer, 'claim', {
      path,
      ttl: Number(opts.ttl),
      reason: opts.reason,
      session: opts.session,
    });
  });

program.command('release')
  .description('Release a previously-claimed path')
  .argument('<peer>')
  .argument('<path>')
  .option('--session <name>')
  .action(async (peer, path, opts) => {
    await sendAgent(peer, 'release', { path, session: opts.session });
  });

program.command('report')
  .description('Report status on a task (e.g. done / wip / blocked) to a peer')
  .argument('<peer>', 'Peer nickname or pubkey')
  .argument('<task>', 'Task label')
  .argument('<state>', 'State: done | wip | blocked | todo')
  .option('--branch <name>')
  .action(async (peer, task, state, opts) => {
    await sendAgent(peer, 'status', { task, state, branch: opts.branch });
  });

program.command('heartbeat')
  .description('Extend a claim TTL so others know you are still working')
  .argument('<peer>')
  .argument('<path>', 'Claimed path to heartbeat')
  .option('--extend <seconds>', 'Additional TTL in seconds', '600')
  .action(async (peer, path, opts) => {
    await sendAgent(peer, 'heartbeat', {
      claim: path,
      ttl_extend: Number(opts.extend),
    });
  });

program.command('handoff')
  .description('Hand off a branch to another agent')
  .argument('<peer>')
  .argument('<branch>')
  .option('--from <name>', 'From session / agent name')
  .option('--to <name>',   'To session / agent name')
  .option('--reason <text>')
  .action(async (peer, branch, opts) => {
    await sendAgent(peer, 'handoff', {
      branch,
      from: opts.from,
      to: opts.to,
      reason: opts.reason,
    });
  });

program.command('review')
  .description('Send a peer code-review verdict on a commit / scope')
  .argument('<peer>',       'Peer nickname or pubkey')
  .argument('<target_sha>', 'Commit SHA (or other stable id) being reviewed')
  .argument('<verdict>',    'approve | changes | block  (normalised to lowercase)')
  .option('--scope <text>',        'Optional scope (file path, subsystem, etc.)')
  .option('--findings <json>',     'JSON array of findings, or @path/to/file.json')
  .option('--reviewer <name>',     'Reviewer label (defaults to own pubkey)')
  .option('--reviewer-role <role>','Reviewer role, e.g. security / business / ux')
  .option('--sign',                'Attach a signed envelope proving the reviewer identity')
  .action(async (peer, target_sha, verdict, opts) => {
    // Normalise verdict — accept loose input, emit one canonical form so receivers
    // don't have to case-fold. 'request_changes'/'REQUEST_CHANGES'/'CHANGES' all map
    // to 'changes'; 'APPROVE' → 'approve'; 'BLOCK' → 'block'.
    const vRaw = String(verdict).toLowerCase();
    let vNorm;
    if (vRaw === 'approve') vNorm = 'approve';
    else if (vRaw === 'block') vNorm = 'block';
    else if (vRaw === 'changes' || vRaw === 'request_changes' || vRaw === 'request-changes') vNorm = 'changes';
    else return console.error(`verdict must be one of: approve | changes | block (got ${verdict})`);

    let findings = [];
    if (opts.findings) {
      let raw = opts.findings;
      if (raw.startsWith('@')) {
        raw = fs.readFileSync(raw.slice(1), 'utf8');
      }
      try {
        findings = JSON.parse(raw);
        if (!Array.isArray(findings)) throw new Error('findings must be a JSON array');
      } catch (e) {
        return console.error('bad --findings: ' + e.message);
      }
    }

    const peerPubkey = await resolvePeer(peer);

    // Base body — always includes these fields whether signed or not.
    const body = {
      target_sha,
      target_scope: opts.scope,
      verdict: vNorm,
      findings,
      reviewer: opts.reviewer,
      reviewer_role: opts.reviewerRole,
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

    if (opts.sign) {
      const { loadIdentity, signEnvelope } = await import('../src/identity.js');
      const crypto = await import('node:crypto');
      const id = loadIdentity();
      if (!id) return console.error('No identity on disk — cannot --sign');
      if (!body.reviewer) body.reviewer = id.pubHex;

      // Bind signature to THIS recipient + a fresh nonce + a signed timestamp so
      // a captured signature cannot be (a) replayed to a different peer, (b)
      // replayed at a different time, or (c) bit-flipped while preserving `sig`.
      body.recipient = peerPubkey;
      body.nonce = crypto.randomBytes(16).toString('hex');
      body.signed_ts = Date.now();

      // Signed payload = snapshot of body WITHOUT `sig`. Receiver rebuilds the
      // same snapshot and verifyEnvelope() fails on any tamper.
      const signedPayload = { ...body };
      body.sig = signEnvelope(id, 'agent-review', signedPayload);
    }

    await sendAgentTo(peerPubkey, peer, 'review', body);
  });

program.parse();
