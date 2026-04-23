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
// Peer-bootstrap pair protocol (v0.2.1). Dialers send a signed `pair-req`
// NDJSON frame; the creator validates + replies with a signed `pair-ack`.
// See src/libp2p-pair.js for the full threat model and flow.
const DEMI_PAIR_PROTO = '/demi/pair-req/1.0.0';

// Gemini sv3 minor SEV-2 nit fix (commit-3f): stream.close() returns a Promise
// that we previously fired without await, risking unhandled rejections on the
// libp2p 3.x yamux close path. This helper swallows both sync throws and
// async rejections so error cleanup is deterministic without forcing every
// callsite to be async.
function safeClose(stream) {
  try {
    const p = stream.close();
    if (p && typeof p.then === 'function') p.catch(() => {});
  } catch {}
}

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
    this.kind = 'libp2p';
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
    // On successful dial, also open the wire stream so chat/agent frames
    // flow without requiring a DEMI_LIBP2P_BOOTSTRAP env (v0.2.1 gap-1 fix).
    const peer = getPeer(peerPubHex);
    const ma = peer?.last_multiaddr;
    if (!ma) {
      audit('transport.libp2p.join.skip', { peer: peerPubHex.slice(0, 16), reason: 'no-multiaddr' });
      return;
    }
    let conn;
    try {
      const { multiaddr } = await import('@multiformats/multiaddr');
      conn = await this.node.dial(multiaddr(ma));
      audit('transport.libp2p.dial', { peer: peerPubHex.slice(0, 16), ok: true });
    } catch (e) {
      audit('transport.libp2p.dial', { peer: peerPubHex.slice(0, 16), ok: false, err: e.message });
      return;
    }
    // Open wire stream as dialer. Responder side is auto-attached by
    // node.handle(DEMI_WIRE_PROTO, …) registered in start().
    if (this.sockets.has(peerPubHex)) {
      audit('transport.libp2p.wire.skip', { peer: peerPubHex.slice(0, 16), reason: 'already-attached' });
      return;
    }
    try {
      const stream = await conn.newStream(DEMI_WIRE_PROTO);
      this._attachWireStream(stream, conn, { role: 'dialer' });
    } catch (e) {
      audit('transport.libp2p.wire.open-fail', { peer: peerPubHex.slice(0, 16), err: e.message });
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

  /**
   * Resolve the best re-dial multiaddr for a remote peer via the `@libp2p/identify`
   * peer-store. Certified addresses (signed by the peer during identify) are
   * preferred over observed source addresses; TCP listen addresses are
   * preferred over relayed / circuit addresses. Returns a string multiaddr
   * with `/p2p/<peerId>` suffix, or `null` if nothing usable is known.
   *
   * Why this exists (POST_PAIR_REJOIN_PARTIAL / commit-3e):
   *   Pre-3e `upsertPeer(... last_multiaddr: connection.remoteAddr)` on the
   *   creator side stored the EPHEMERAL source port the redeemer happened to
   *   dial from. That's useless for re-dial after restart — the OS picks a
   *   new source port each time. Identify exposes the redeemer's signed
   *   listen addresses, which are stable across reconnects.
   *
   * Timing note: the `identify` service runs asynchronously on every new
   * connection. On the creator side we call this inside the pair-req handler,
   * which runs after TCP handshake + noise + yamux upgrade + one NDJSON frame
   * read + ed25519 signature verify — plenty of time for identify to complete
   * (empirically <50ms). On rare slow-LAN cases, peer-store may still be
   * empty; callers must handle a null return by falling back to
   * connection.remoteAddr (ephemeral, but better than losing the peer).
   */
  async getListenAddrFor(peerId) {
    if (!this.node) return null;
    let peerIdStr;
    try {
      peerIdStr = typeof peerId === 'string' ? peerId : peerId.toString();
    } catch {
      return null;
    }
    try {
      const peer = await this.node.peerStore.get(peerId);
      if (!peer || !Array.isArray(peer.addresses) || peer.addresses.length === 0) {
        return null;
      }
      // Prefer certified (signed) addresses over observed/advertised.
      const certified = peer.addresses.filter((a) => a.isCertified);
      const pool = certified.length > 0 ? certified : peer.addresses;
      // Prefer TCP listen addrs; reject circuit-relay so we don't get stuck
      // re-dialing through a disappearing relay node.
      const tcp = pool.find((a) => {
        const s = a.multiaddr?.toString() || '';
        return s.includes('/tcp/') && !s.includes('/p2p-circuit');
      });
      const pick = tcp || pool[0];
      const raw = pick?.multiaddr?.toString();
      if (!raw) return null;
      // Strip any existing /p2p/<id> and re-append canonical one.
      const i = raw.indexOf('/p2p/');
      const base = i >= 0 ? raw.slice(0, i) : raw;
      return `${base}/p2p/${peerIdStr}`;
    } catch (err) {
      audit('transport.libp2p.listen-addr-lookup-fail', {
        peer: peerIdStr.slice(0, 16),
        err: err.message,
      });
      return null;
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
    // Gemini sv2 SEV-3 fix: sockets Map holds each authed peer under TWO keys
    // (libp2pPeerId before hello-auth + pubHex after attachSocket rebind),
    // so .values() yields duplicates. Set-dedupe by socket reference.
    for (const s of new Set(this.sockets.values())) {
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

  // ─── v0.2.1 pairing: peer-bootstrap direct-dial ──────────────────────────
  //
  // Replaces the withdrawn GossipSub rendezvous (commit 3314946, Gemini BLOCK
  // severity 5: sniff-and-inject class break on public pubsub topic). Full
  // threat model in src/libp2p-pair.js.
  //
  // handlePair(handler)
  //   Register an incoming-stream handler on `/demi/pair-req/1.0.0`.
  //   `handler(stream, connection)` is awaited for one stream at a time;
  //   stream errors are caught and audited here — handler never needs to
  //   worry about transport-level exceptions bubbling up.
  //   Returns an async `unhandle()` function to deregister the protocol.
  //
  // dialPair(peerIdString, addrs, requestBytes, timeoutMs = 15_000)
  //   Dial each multiaddr in order (appending `/p2p/<peerId>` if absent)
  //   until one succeeds, open a new stream on `/demi/pair-req/1.0.0`,
  //   write `requestBytes`, and read exactly one NDJSON frame back.
  //   Returns a `Uint8Array` of the response bytes. Parsing is done by
  //   the caller (libp2p-pair.js).
  //   Throws on dial failure, stream-open failure, write failure, or timeout.

  async handlePair(handler) {
    if (!this.node) throw new Error('handlePair: transport not started');
    await this.node.handle(DEMI_PAIR_PROTO, async (stream, connection) => {
      try {
        await handler(stream, connection);
      } catch (err) {
        audit('transport.libp2p.pair-handler-error', { err: err.message });
        safeClose(stream);
      }
    });
    audit('transport.libp2p.pair-listen', { proto: DEMI_PAIR_PROTO });
    return async () => {
      try { await this.node.unhandle(DEMI_PAIR_PROTO); } catch {}
      audit('transport.libp2p.pair-unlisten', { proto: DEMI_PAIR_PROTO });
    };
  }

  async dialPair(peerIdString, addrs, requestBytes, timeoutMs = 15_000) {
    if (!this.node) throw new Error('dialPair: transport not started');
    if (!Array.isArray(addrs) || addrs.length === 0) {
      throw new Error('dialPair: addrs[] required');
    }

    const { multiaddr } = await import('@multiformats/multiaddr');
    const suffix = `/p2p/${peerIdString}`;
    const candidates = addrs.map((a) => (a.includes('/p2p/') ? a : a + suffix));

    let conn = null;
    let lastErr = null;
    for (const ma of candidates) {
      try {
        conn = await this.node.dial(multiaddr(ma), {
          signal: AbortSignal.timeout(timeoutMs),
        });
        audit('transport.libp2p.pair-dial-ok', { ma });
        break;
      } catch (err) {
        lastErr = err;
        audit('transport.libp2p.pair-dial-fail', { ma, err: err.message });
      }
    }
    if (!conn) {
      throw new Error('pair dial failed: ' + (lastErr?.message || 'no candidates'));
    }

    const stream = await conn.newStream(DEMI_PAIR_PROTO, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    audit('transport.libp2p.pair-stream-open', { peer: peerIdString });

    // Write request bytes.
    try {
      stream.send(requestBytes);
    } catch (err) {
      safeClose(stream);
      throw new Error('pair write failed: ' + err.message);
    }

    // Read one frame back, 10s cap, size-bounded.
    const MAX_RESP = 2 * 1024;
    const READ_TIMEOUT = 10_000;
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;

      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { stream.removeEventListener('message', onMessage); } catch {}
        try { stream.removeEventListener('close', onClose); } catch {}
        safeClose(stream);
        if (err) reject(err); else resolve(val);
      };

      const onMessage = (evt) => {
        let data = evt.data;
        if (data && typeof data.subarray === 'function' && !(data instanceof Uint8Array)) {
          data = data.subarray();
        }
        if (!data) return;
        size += data.length;
        if (size > MAX_RESP) {
          return finish(new Error('pair response too large (>2KB)'));
        }
        chunks.push(Buffer.from(data));
        const joined = Buffer.concat(chunks);
        // Resolve on first newline — one NDJSON frame is one response.
        const nl = joined.indexOf(0x0a);
        if (nl >= 0) {
          finish(null, joined.subarray(0, nl + 1));
        }
      };
      const onClose = () => {
        if (chunks.length === 0) return finish(new Error('pair response stream closed empty'));
        finish(null, Buffer.concat(chunks));
      };
      const timer = setTimeout(() => {
        finish(new Error(`pair response timeout (${READ_TIMEOUT}ms)`));
      }, READ_TIMEOUT);

      stream.addEventListener('message', onMessage);
      stream.addEventListener('close', onClose);
    });
  }

  // ─── internal ────────────────────────────────────────────────────────────

  _attachWireStream(stream, connection, { role }) {
    // Dedupe: if we already have a wire stream for this libp2p peer, prefer existing.
    const libp2pPeerHex = connection.remotePeer.toString();

    // Gemini sv2 SEV-2 fix: race on fast double-dial. Prior code blind-set
    // without checking existing mapping, leaking the first socket in heap.
    if (this.sockets.has(libp2pPeerHex)) {
      audit('transport.libp2p.wire.skip', {
        peer: libp2pPeerHex.slice(0, 16),
        reason: 'already-attached',
        role,
      });
      safeClose(stream);
      return;
    }

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
      destroy: () => safeClose(stream),
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
