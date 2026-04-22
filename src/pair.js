// src/pair.js — 6-digit pairing code → DHT topic → mutual pubkey exchange
// Flow:
// 1. Alice creates code NNN-NNN → topic = sha256('demi-pair/v1:' + NNNNNN)
// 2. Alice joins swarm on topic + registers pair-ack handler on transport
// 3. Alice broadcasts her signed pair-ack over all current sockets (incl. club topic sockets)
// 4. Bob redeems same code, joins topic, broadcasts his pair-ack
// 5. Both verify envelope (binds to code), attach socket under identity pubkey,
//    re-broadcast own ack (so the other side completes its half of the handshake),
//    join permanent sorted-pair topic for future reconnects.

import crypto from 'node:crypto';
import b4a from 'b4a';
import { signEnvelope, verifyEnvelope } from './identity.js';
import { encode, pairAckFrame } from './wire.js';
import { upsertPeer, audit } from './db.js';

export function generatePairCode() {
  // 6 digits, grouped as NNN-NNN (no 0 at start to avoid leading-zero confusion)
  const n = 100_000 + crypto.randomInt(900_000);
  const s = String(n);
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export function pairTopic(code) {
  const clean = code.replace(/-/g, '');
  return crypto.createHash('sha256').update('demi-pair/v1:' + clean).digest(); // 32 bytes
}

export function sortedPairTopic(pkA, pkB) {
  const pair = [pkA, pkB].sort().join(':');
  return crypto.createHash('sha256').update('demi-pair-perm/v1:' + pair).digest();
}

/**
 * Create a pairing code.
 * Returns `{ code, promise }` synchronously so the CLI/RPC can print the code
 * immediately while the handshake runs in the background.
 */
export function createPair({ transport, identity, nickname, ttlMs = 5 * 60 * 1000 }) {
  const code = generatePairCode();
  const promise = runPairFlow({ transport, identity, nickname, role: 'creator', code, ttlMs });
  audit('pair.create', { code, topic: b4a.toString(pairTopic(code), 'hex').slice(0, 16) });
  return { code, promise };
}

/**
 * Redeem a pairing code.
 * Returns a Promise that resolves with `{ peer: { pubHex, nickname } }` once
 * the remote side's signature is verified.
 */
export async function redeemPair({ transport, identity, nickname, code, ttlMs = 5 * 60 * 1000 }) {
  audit('pair.redeem', { code, topic: b4a.toString(pairTopic(code), 'hex').slice(0, 16) });
  const peer = await runPairFlow({ transport, identity, nickname, role: 'redeemer', code, ttlMs });
  return { peer };
}

// Core state machine used by both creator and redeemer. Returns peer info on success.
function runPairFlow({ transport, identity, nickname, role, code, ttlMs }) {
  return new Promise((resolve, reject) => {
    const topic = pairTopic(code);

    // Build our signed pair-ack once
    const envelope = signEnvelope(identity, 'pair-ack', { nickname, code, role });
    const frame = pairAckFrame({ pubHex: identity.pubHex, nickname, envelope });
    const encoded = encode(frame);

    let done = false;
    let unsubAck;
    let unsubConnect;
    let timer;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      try { unsubAck?.(); } catch {}
      try { unsubConnect?.(); } catch {}
      clearTimeout(timer);
      try { transport.swarm.leave(topic).catch(() => {}); } catch {}
      fn(value);
    };

    unsubAck = transport.onPairAck((socket, msg) => {
      if (done) return;
      if (!msg.envelope || msg.envelope.payload?.code !== code) return;
      if (!verifyEnvelope(msg.envelope)) return;
      if (msg.envelope.by !== msg.pubHex) return;
      if (msg.pubHex === identity.pubHex) return; // ignore our own broadcasts

      upsertPeer(msg.pubHex, {
        self_nickname: msg.nickname,
        fp_short: msg.pubHex.slice(0, 8),
        trust: 'trusted',
        online: true,
      });
      try { transport.attachSocket(msg.pubHex, socket); } catch {}

      // Join permanent sorted-pair topic so we can reconnect after restart
      try {
        const permTopic = sortedPairTopic(identity.pubHex, msg.pubHex);
        transport.swarm.join(permTopic, { server: true, client: true });
      } catch {}

      audit('pair.success', { peer: msg.pubHex.slice(0, 16), role });

      // Re-broadcast our ack so the peer also completes its handshake
      // (handles race where our first broadcast arrived before they registered their handler)
      try { transport.broadcast(frame); } catch {}

      finish(resolve, { pubHex: msg.pubHex, nickname: msg.nickname });
    });

    // Push our ack on every NEW socket too (peers joining the topic after us)
    unsubConnect = transport.onConnect((socket) => {
      try { socket.write(encoded); } catch {}
    });

    // Join the pair topic (server+client) so new peers can find us
    try { transport.swarm.join(topic, { server: true, client: true }); } catch {}

    // Broadcast over all CURRENTLY open sockets (e.g. club topic peers)
    try { transport.broadcast(frame); } catch {}

    timer = setTimeout(() => {
      finish(reject, new Error(`pair ${role} timeout (${Math.round(ttlMs / 60000)} min)`));
    }, ttlMs);
  });
}
