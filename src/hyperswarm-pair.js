// src/hyperswarm-pair.js — Hyperswarm-specific pair flow (extracted from pair.js for Этап B v0.2).
//
// Flow:
// 1. Creator/redeemer joins swarm on pair topic = sha256('demi-pair/v1:' + code)
// 2. Registers pair-ack handler on transport
// 3. Broadcasts signed pair-ack over all current sockets (incl. club topic sockets)
// 4. On first verified envelope with matching code → upsertPeer trusted, attach
//    socket, join permanent sorted-pair topic for future reconnects, re-broadcast.
//
// Separated from the dispatcher in pair.js so that:
//   - libp2p adapter (no swarm.join) can ship its own flow in libp2p-pair.js
//   - dispatcher in pair.js picks impl by transport.kind with zero behaviour change
//     for Hyperswarm (still the default transport).

import b4a from 'b4a';
import { signEnvelope, verifyEnvelope } from './identity.js';
import { encode, pairAckFrame } from './wire.js';
import { upsertPeer, audit } from './db.js';
import { pairTopic, sortedPairTopic } from './pair.js';

export function runHyperswarmPairFlow({ transport, identity, nickname, role, code, ttlMs }) {
  return new Promise((resolve, reject) => {
    const topic = pairTopic(code);

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

      audit('pair.success', { peer: msg.pubHex.slice(0, 16), role, transport: 'hyperswarm' });

      // Re-broadcast our ack so the peer also completes its handshake
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
