#!/usr/bin/env node
// bin/demi.js — DEMI CLI
// Talks to the running node via WebSocket RPC on 127.0.0.1:4321
import { program } from 'commander';
import WebSocket from 'ws';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, paths } from '../src/paths.js';
import { loadLocale, t } from '../src/i18n.js';
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

program.parse();
