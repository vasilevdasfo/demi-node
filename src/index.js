#!/usr/bin/env node
// src/index.js — DEMI node bootstrap
import { ensureHome, paths, loadConfig, touchActive, touchLastSeen } from './paths.js';
import { loadIdentity, generateIdentity, panicWipe, fingerprint } from './identity.js';
import { getOrCreateNickname } from './nickname.js';
import { openDb, listPeers, getHistory, upsertPeer } from './db.js';
import { createTransport } from './transport/index.js';
import { UiServer } from './ui-server.js';
import { sendChat, history } from './chat.js';
import { createPair, redeemPair } from './pair.js';
import { loadLocale, t } from './i18n.js';
import fs from 'node:fs';

const cfg = loadConfig();
loadLocale(cfg.lang);

async function main() {
  ensureHome();
  touchActive();
  touchLastSeen();

  console.log(t('boot.starting'));

  let identity = loadIdentity();
  if (!identity) {
    identity = generateIdentity();
    console.log(t('boot.identity.created', { fp: fingerprint(identity.pubHex) }));
  } else {
    console.log(t('boot.identity.loaded', { fp: fingerprint(identity.pubHex) }));
  }

  openDb();
  const nickname = getOrCreateNickname();
  console.log(t('boot.nickname', { nick: nickname }));

  // Self-register in peers table
  upsertPeer(identity.pubHex, {
    self_nickname: nickname,
    fp_short: identity.fpShort,
    trust: 'self',
    online: true,
  });

  // Supervisor loop — watch .active file
  setInterval(() => {
    if (!fs.existsSync(paths.active)) {
      console.log('Active file removed — shutting down');
      process.exit(0);
    }
    touchLastSeen();
  }, 2000);

  // Dead-man switch check
  try {
    const lastSeen = fs.existsSync(paths.lastSeen) ? new Date(fs.readFileSync(paths.lastSeen, 'utf8')) : new Date();
    const daysSince = (Date.now() - lastSeen.getTime()) / 86400000;
    if (daysSince > (cfg.deadManDays || 30)) {
      console.error(`Dead-man switch triggered (no activity ${Math.floor(daysSince)} days). Panic wipe.`);
      panicWipe();
      process.exit(0);
    }
  } catch {}

  // Transport (P2P) — pluggable via DEMI_TRANSPORT env (hyperswarm default, libp2p fallback)
  const transport = await createTransport({
    identity,
    nickname,
    lang: cfg.lang,
    clubTopic: cfg.clubTopic || 'demi-club/v1',
    onMessage: (ev) => {
      if (ev.kind === 'chat') {
        import('./chat.js').then(({ handleIncomingChat }) => {
          handleIncomingChat({
            pubkey: ev.pubkey,
            frame: ev.frame,
            onBroadcast: (e) => ui.broadcast(e),
            ownPubHex: identity.pubHex,
          });
        });
      } else if (ev.kind === 'hello') {
        ui.broadcast({ kind: 'hello', ...ev });
      }
    },
  });
  await transport.start();
  await transport.rejoinAllKnown();

  // UI + RPC
  const ui = new UiServer({
    port: cfg.uiPort || 4321,
    onRpc: async ({ method, args }) => {
      try {
        return { result: await rpc(method, args || {}, { identity, nickname, transport }) };
      } catch (e) {
        return { error: e.message };
      }
    },
  });
  await ui.start();
  console.log(t('boot.ui', { port: cfg.uiPort || 4321 }));
  console.log(t('boot.ready'));

  // Graceful shutdown
  const shutdown = async () => {
    await transport.stop();
    await ui.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// RPC dispatcher
async function rpc(method, args, ctx) {
  switch (method) {
    case 'identity.whoami':
      return { pubHex: ctx.identity.pubHex, nickname: ctx.nickname, fpShort: ctx.identity.fpShort };
    case 'identity.pubkey':
      return { pubkey: ctx.identity.pubHex };
    case 'peers.list':
      return listPeers();
    case 'peers.history':
    case 'chat.history':
      return history(args.pubkey, args.limit || 100);
    case 'chat.send':
      return sendChat({ transport: ctx.transport, peerPubkey: args.pubkey, text: args.text });
    case 'pair.new': {
      // Synchronous code, async handshake in background
      const { code, promise } = createPair({
        transport: ctx.transport,
        identity: ctx.identity,
        nickname: ctx.nickname,
      });
      promise.catch((err) => console.error('pair.new background:', err.message));
      return { code, pending: true };
    }
    case 'pair.redeem': {
      const r = await redeemPair({
        transport: ctx.transport,
        identity: ctx.identity,
        nickname: ctx.nickname,
        code: args.code,
      });
      return r; // { peer: { pubHex, nickname } }
    }
    case 'panic.wipe':
      if (args.confirm !== 'YES') throw new Error('confirmation required (YES)');
      return panicWipe();
    case 'health':
      return { ok: true, uptime: process.uptime() };
    default:
      throw new Error('unknown method: ' + method);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
