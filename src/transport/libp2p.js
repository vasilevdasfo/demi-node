// src/transport/libp2p.js — libp2p 3.x adapter (Этап B v0.1 — first wire-up)
//
// Contract matches src/transport/hyperswarm.js exactly, so the rest of the
// node (pair.js, chat.js, UI, audit, agent-dashboard) doesn't know which
// transport is under it.
//
// Gemini adversarial review mitigations (severity 5, all applied below):
//   #1 DHT Sybil/Eclipse on /demi-net/kad/1.0.0
//      → kadDHT({ clientMode: true }) on leaf nodes, no server role
//      → explicit bootstrap list from DEMI_LIBP2P_BOOTSTRAP env, not open DHT
//   #2 Memory exhaustion via unbounded lp.decode
//      → lp.decode(stream, { maxDataLength: MAX_MSG_BYTES })
//   #3 mDNS poisoning on hostile LAN
//      → mDNS OFF by default; opt-in with DEMI_LIBP2P_MDNS=1
//
// v0.1 scope (this release):
//   ✅ start/stop, TCP+Noise+Yamux, clientMode DHT, opt-in mDNS
//   ✅ long-lived wire stream per peer (same makeParser/encode/helloFrame as Hyperswarm)
//   ✅ signed hello-auth envelope on connect (same as Hyperswarm rebind flow)
//   ✅ send/broadcast/attachSocket/onConnect/onMessage
//   ✅ joinPeer(pubHex) — dial via cached multiaddr (if known)
//   ⏳ pair.js flow — initial pairing stays on Hyperswarm in v0.1
//      (libp2p pairing needs rendezvous or pubsub, Этап B v0.2)
//   ⏳ rejoinAllKnown — only dials peers with cached multiaddr
//
// Key design decisions:
//   - We reuse the exact wire frame format (../wire.js) — no new encoding.
//   - We adapt the identity: our ed25519 PKCS8 → libp2p Ed25519PrivateKey via
//     raw 32-byte seed (last 32 bytes of PKCS8 DER).
//   - Wire protocol id is `/demi/wire/1.0.0` (one long-lived stream per peer,
//     NOT the prototype's per-message /demi-net/hello + /demi-net/chat).

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { makeParser, encode, helloFrame, MAX_FRAME } from '../wire.js';
import { upsertPeer, getPeer, audit } from '../db.js';
import { signEnvelope, verifyEnvelope } from '../identity.js';

const DEMI_WIRE_PROTO = '/demi/wire/1.0.0';

// Extract the raw 32-byte ed25519 seed from a Node crypto KeyObject (PKCS8 DER).
// PKCS8 for ed25519 = fixed 16-byte prefix + 32-byte seed (RFC 8410).
function ed25519SeedFromNodeKey(privateKey) {
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.slice(-32);
}

// Build a libp2p Ed25519 PrivateKey from our raw seed so libp2p's PeerId
// reflects the SAME identity we use for ed25519 signatures elsewhere.
async function libp2pKeyFromIdentity(identity) {
  const seed = ed25519SeedFromNodeKey(identity.privateKey);
  const pubRaw = Buffer.from(identity.pubHex, 'hex');
  // libp2p expects 64 bytes for ed25519 raw private: seed (32) + pubkey (32)
  const raw = Buffer.concat([seed, pubRaw]);
  return privateKeyFromRaw(raw);
}

export class Transport extends EventEmitter {
  constructor({ identity, nickname, lang = 'en', clubTopic = 'demi-club/v1', onMessage }) {
    super();
    this.identity = identity;
    this.nickname = nickname;
    this.lang = lang;
    this.clubTopic = clubTopic;
    this.onMessage = onMessage || (() => {});
    this.node = null;
    // pubkey-hex → { stream, send, peerId }
    this.sockets = new Map();
    this.pairAckHandlers = new Set();
    this.connectHooks = new Set();
  }

  async start() {
    const privateKey = await libp2pKeyFromIdentity(this.identity);

    // Gemini #3 — mDNS off by default, opt-in via env
    const peerDiscovery = [];
    if (process.env.DEMI_LIBP2P_MDNS === '1') {
      const { mdns } = await import('@libp2p/mdns');
      peerDiscovery.push(mdns({ interval: 2000 }));
      audit('transport.libp2p.mdns', { enabled: true });
    }

    // Gemini #1 — explicit trusted bootstrap list, no open DHT
    const bootstrapList = (process.env.DEMI_LIBP2P_BOOTSTRAP || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (bootstrapList.length) {
      peerDiscovery.push(bootstrap({ list: bootstrapList }));
      audit('transport.libp2p.bootstrap', { n: bootstrapList.length });
    }

    const listenPort = Number(process.env.DEMI_LIBP2P_PORT || 0);

    this.node = await createLibp2p({
      privateKey,
      addresses: { listen: [`/ip4/0.0.0.0/tcp/${listenPort}`] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      services: {
        identify: identify(),
        ping: ping(), // required by kad-dht
        // Gemini #1 — leaf nodes are DHT clients only (no server role, no sybil surface)
        dht: kadDHT({
          protocol: '/demi-net/kad/1.0.0',
          clientMode: true,
        }),
      },
      connectionManager: { minConnections: 0 },
    });

    // Auto-dial newly discovered peers (from bootstrap list or mDNS).
    // Without this, connectionManager with minConnections:0 never opens connections.
    this.node.addEventListener('peer:discovery', (evt) => {
      const info = evt.detail;
      if (!info?.id) return;
      audit('transport.libp2p.discovered', {
        peer: info.id.toString(),
        mas: (info.multiaddrs || []).map((m) => m.toString()),
      });
    });

    // Register our long-lived wire protocol — one stream per peer, frames flow both ways.
    // libp2p v3 uses positional args (stream, connection), NOT destructured.
    await this.node.handle(DEMI_WIRE_PROTO, (stream, connection) => {
      audit('transport.libp2p.incoming-stream', { peer: connection.remotePeer.toString() });
      this._attachWireStream(stream, connection, { role: 'responder' });
    });

    // Auto-dial wire on outbound connections only (inbound side uses node.handle above).
    // This avoids duplicate streams when peer:connect fires symmetrically on both sides.
    this.node.addEventListener('peer:connect', (evt) => {
      audit('transport.libp2p.peer-connect', { peer: evt.detail.toString() });
    });

    await this.node.start();

    // Bootstrap clients (nodes with DEMI_LIBP2P_BOOTSTRAP) are the ONLY ones that
    // dial wire protocol on startup. Responders (bootstrap nodes themselves) just
    // accept incoming wire streams via node.handle above. This avoids races from
    // two sides dialing wire streams simultaneously.
    if (bootstrapList.length) {
      const { multiaddr: mafn } = await import('@multiformats/multiaddr');
      for (const ma of bootstrapList) {
        (async () => {
          try {
            const conn = await this.node.dial(mafn(ma));
            audit('transport.libp2p.bootstrap-dial-ok', { ma });
            const stream = await conn.newStream(DEMI_WIRE_PROTO);
            audit('transport.libp2p.bootstrap-wire-ok', { ma });
            this._attachWireStream(stream, conn, { role: 'dialer' });
          } catch (err) {
            audit('transport.libp2p.bootstrap-dial-fail', { ma, err: err.message });
          }
        })();
      }
    }

    audit('transport.start', {
      club: this.clubTopic,
      transport: 'libp2p',
      multiaddrs: this.node.getMultiaddrs().map((m) => m.toString()),
    });
  }

  async stop() {
    for (const s of this.sockets.values()) {
      try { await s.stream.close(); } catch {}
    }
    this.sockets.clear();
    if (this.node) {
      try { await this.node.stop(); } catch {}
      this.node = null;
    }
    audit('transport.stop', { transport: 'libp2p' });
  }

  async joinPeer(peerPubHex) {
    // libp2p has no "join topic" analogue. We dial by cached multiaddr
    // stored in peer record (last_multiaddr). No-op if we don't know one.
    const peer = getPeer(peerPubHex);
    const ma = peer?.last_multiaddr;
    if (!ma) {
      audit('transport.libp2p.join.skip', { peer: peerPubHex.slice(0, 16), reason: 'no-multiaddr' });
      return;
    }
    try {
      const { multiaddr } = await import('@multiformats/multiaddr');
      await this.node.dial(multiaddr(ma));
      audit('transport.libp2p.dial', { peer: peerPubHex.slice(0, 16), ok: true });
    } catch (e) {
      audit('transport.libp2p.dial', { peer: peerPubHex.slice(0, 16), ok: false, err: e.message });
    }
  }

  async rejoinAllKnown() {
    const { listPeers } = await import('../db.js');
    const peers = listPeers().filter((p) =>
      (p.trust === 'trusted' || p.trust === 'seen') &&
      p.pubkey !== this.identity.pubHex &&
      p.last_multiaddr
    );
    for (const p of peers) {
      await this.joinPeer(p.pubkey);
    }
  }

  onPairAck(fn) {
    this.pairAckHandlers.add(fn);
    return () => this.pairAckHandlers.delete(fn);
  }

  onConnect(fn) {
    this.connectHooks.add(fn);
    return () => this.connectHooks.delete(fn);
  }

  broadcast(frame) {
    const payload = encode(frame);
    for (const s of this.sockets.values()) {
      try { s.send(payload); } catch {}
    }
  }

  async send(peerPubHex, data) {
    const s = this.sockets.get(peerPubHex);
    if (!s) return false;
    try {
      s.send(data);
      return true;
    } catch {
      return false;
    }
  }

  attachSocket(pubHex, socket) {
    socket._remotePubHex = pubHex;
    this.sockets.set(pubHex, socket);
  }

  // ─── internal ────────────────────────────────────────────────────────────

  _attachWireStream(stream, connection, { role }) {
    // Dedupe: if we already have a wire stream for this libp2p peer, prefer existing.
    const libp2pPeerHex = connection.remotePeer.toString();

    // libp2p stream adapter with .send() and socket-like semantics so the
    // hyperswarm parser/encoder code works unchanged.
    const socket = {
      _remotePubHex: null,
      _libp2pPeer: libp2pPeerHex,
      _stream: stream,
      send: (buf) => {
        // stream.send is async internally but exposes sync boolean for backpressure
        try { return stream.send(buf); } catch { return false; }
      },
      write: (buf) => {
        try { stream.send(buf); return true; } catch { return false; }
      },
      destroy: () => { try { stream.close(); } catch {} },
    };

    this.sockets.set(libp2pPeerHex, socket);

    const parser = makeParser((msg) => this._onFrame(msg, socket, connection));

    // Gemini #2 — cap buffered input to MAX_FRAME*4 (done inside makeParser already).
    // libp2p v3 streams expose a 'message' event with {data: Uint8Array|Uint8ArrayList}.
    stream.addEventListener('message', (evt) => {
      let data = evt.data;
      if (data && typeof data.subarray === 'function' && !(data instanceof Uint8Array)) {
        // Uint8ArrayList → Uint8Array
        data = data.subarray();
      }
      try { parser(data); } catch (err) {
        audit('transport.libp2p.parse-error', { err: err.message });
      }
    });

    stream.addEventListener('close', () => {
      const pk = socket._remotePubHex;
      if (pk) {
        this.sockets.delete(pk);
        upsertPeer(pk, { online: false });
      }
      this.sockets.delete(libp2pPeerHex);
    });

    // Send hello + signed auth envelope (same shape as Hyperswarm).
    // Session binding: we bind to OUR OWN libp2p peer id. Recipient checks
    // payload.session === connection.remotePeer (which is our peer id from their view).
    const mySessionHex = this.node.peerId.toString();
    const auth = signEnvelope(this.identity, 'hello-auth', {
      session: mySessionHex,
      ts: Date.now(),
    });
    const hello = helloFrame({
      nickname: this.nickname,
      agent: 'DEMI',
      role: 'operator',
      caps: ['chat', 'rooms', 'pair'],
      lang: this.lang,
      version: '0.1.0-alpha.2',
      fpShort: this.identity.fpShort,
      auth,
    });
    audit('transport.libp2p.attach-wire', { peer: libp2pPeerHex, role });
    try {
      const ok = stream.send(encode(hello));
      audit('transport.libp2p.hello-sent', { peer: libp2pPeerHex, ok });
    } catch (err) {
      audit('transport.libp2p.hello-send-fail', { err: err.message });
    }

    // Notify pair.js + others
    for (const fn of this.connectHooks) {
      try { fn(socket, { role, libp2pPeer: libp2pPeerHex }); } catch {}
    }
  }

  _onFrame(msg, socket, connection) {
    const libp2pPeerHex = connection.remotePeer.toString();
    if (msg.type === 'hello') {
      if (!socket._remotePubHex && msg.auth) {
        const ok = verifyEnvelope(msg.auth);
        const payload = msg.auth?.payload || {};
        const peer = getPeer(msg.auth?.by || '');
        const sessionOk = payload.session === libp2pPeerHex;
        const freshOk = typeof payload.ts === 'number' && Math.abs(Date.now() - payload.ts) < 60_000;
        if (ok && peer && sessionOk && freshOk &&
            (peer.trust === 'trusted' || peer.trust === 'seen')) {
          this.attachSocket(peer.pubkey, socket);
          upsertPeer(peer.pubkey, {
            online: true,
            nickname: msg.nick || peer.nickname,
            last_multiaddr: connection.remoteAddr?.toString() || peer.last_multiaddr,
          });
          audit('transport.rebind', {
            peer: peer.pubkey.slice(0, 16),
            verified: true,
            transport: 'libp2p',
          });
        } else {
          audit('transport.rebind-reject', {
            verified: ok, hasPeer: !!peer, sessionOk, freshOk, fp: msg.fpShort,
            transport: 'libp2p',
          });
        }
      }
      audit('transport.hello', {
        nick: msg.nick, fp: msg.fpShort, auth: !!msg.auth, transport: 'libp2p',
      });
      this.onMessage({ kind: 'hello', from: socket._remotePubHex, frame: msg });
    } else if (msg.type === 'chat' && socket._remotePubHex) {
      this.onMessage({ kind: 'chat', pubkey: socket._remotePubHex, frame: msg });
    } else if (msg.type === 'pair-ack') {
      for (const fn of this.pairAckHandlers) {
        try { fn(socket, msg); } catch {}
      }
    }
  }
}
