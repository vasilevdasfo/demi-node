// src/libp2p-pair.js — libp2p pair flow via direct-dial over `/demi/pair-req/1.0.0`
//                      (Этап B v0.2.1 — replaces GossipSub rendezvous from commit 3314946).
//
// ----------------------------------------------------------------------------
// Why this exists
// ----------------------------------------------------------------------------
// commit 3314946 attempted pairing over GossipSub using topic
// `demi-pair/v1/<sha256(code)>`. Gemini 3 Flash adversarial review returned a
// class-break (severity 5):
//
//   The pair-code is transmitted in plaintext inside a signed envelope on a
//   *public* broadcast topic. Any subscriber can sniff the code, then publish a
//   valid `pair-ack` under THEIR OWN ed25519 key and get auto-promoted to
//   `trust:'trusted'` on the creator's side. The signed envelope only proves
//   "I own this ed25519 key", NOT "I knew the secret before hearing it on the
//   wire". There are no PAKE properties on a public pubsub rendezvous.
//
// The only way to fix this inside a pair-flow-over-pubsub design is to replace
// the primitive entirely (SPAKE2/PAKE). Instead we pivot to **peer-bootstrap
// direct-dial**: the creator publishes NO topic. The pair token is a bundle
// containing (code, libp2p peerId, multiaddrs, creator's identity pubHex, ts)
// transmitted out-of-band (Telegram DM, email, QR) on a channel the operator
// already trusts. The redeemer dials the creator over libp2p on a dedicated
// protocol, presents a signed envelope bound to the creator's identity, and
// only then does the creator accept the pairing.
//
// ----------------------------------------------------------------------------
// Wire-level flow
// ----------------------------------------------------------------------------
// A) Creator (listener):
//    1. generatePairCode() → 6-digit code (UX only; security comes from token).
//    2. buildPairToken({transport, identity, code}) → `demi-pair1:<b64url>`.
//    3. transport.handlePair(handler) registers `/demi/pair-req/1.0.0`.
//    4. Handler expects ONE NDJSON frame with
//         {type:'pair-req', pubHex, nickname, envelope}
//       envelope.payload = { code, role:'redeemer', ts, recipient:<creator pubHex> }
//    5. Rate-limit: ≤3 pair-req per remote peer per minute (fail-closed).
//    6. Single-use: rejects any second redeemer once we resolve one.
//    7. Fresh: |Date.now() - envelope.payload.ts| < 300_000 (5 min).
//    8. Binding: envelope.payload.recipient === identity.pubHex (our hex).
//    9. Reply: signed envelope with role:'creator', recipient:<redeemer pubHex>.
//   10. upsertPeer(trusted) + resolve.
//
// B) Redeemer (dialer):
//    1. decodePairToken(token) → {code, peerId, addrs, pubHex, ts}.
//    2. Ensure ts fresh (≤5 min).
//    3. dialPair(peerId, addrs, requestBytes, 15_000).
//    4. Build signed envelope:
//         payload = { code, role:'redeemer', ts, recipient: token.pubHex }
//    5. Send NDJSON frame, await response frame (10s timeout).
//    6. Verify response: envelope.by === frame.pubHex,
//                       envelope.payload.code === code,
//                       envelope.payload.role === 'creator',
//                       envelope.payload.recipient === identity.pubHex,
//                       fresh.
//    7. upsertPeer(trusted) + resolve.
//
// Security properties (vs BLOCK'd GossipSub flow):
//   - Token must travel over a trusted OOB channel. Treat as sensitive: 5-min TTL.
//   - Single-use code: creator refuses to accept a second pair-req even with
//     the same code.
//   - Rate-limit by remote libp2p peerId kills CPU-grind attempts.
//   - No public broadcast: passive sniffer of the DHT/pubsub sees nothing
//     because nothing is published. The creator never advertises the code.
//   - Recipient-binding: envelope.payload.recipient = creator.pubHex. A
//     captured envelope cannot be replayed against a different creator.
//
// What this does NOT protect against (operator responsibility):
//   - Sharing the token in a public Telegram channel, a PR description, a
//     GitHub issue, etc. The token is effectively a one-time-use secret.
//   - A compromised OOB channel (MITM on the messenger itself).
//   - Social engineering that tricks the operator into redeeming a hostile token.
// ----------------------------------------------------------------------------

import { signEnvelope, verifyEnvelope } from './identity.js';
import { makeParser, encode, MAX_FRAME } from './wire.js';
import { upsertPeer, audit } from './db.js';

const TOKEN_PREFIX = 'demi-pair1:';
const FRESH_WINDOW_MS = 5 * 60 * 1000; // 5 min — matches creator TTL
const MAX_FRAME_BYTES = 2 * 1024;       // cheap DoS gate pre-parse
const RATE_WINDOW_MS = 60_000;          // 1 minute
const RATE_MAX = 3;                     // ≤3 pair-req per remote peer per window
const READ_TIMEOUT_MS = 10_000;
const DIAL_TIMEOUT_MS = 15_000;

// Gemini sv3 Finding #2 fix (commit-3f): schema version gate on pair envelopes.
// Symmetric with wire.js AGENT_SCHEMA_V + parseAgentFrame sentinel, but the
// pair protocol is a separate namespace — pair envelopes flow through
// verifyEnvelope (not parseAgentFrame), and their evolution is independent
// from the agent-RPC envelope (which is why we keep a separate constant here).
// Default to v1.0 for the Этап B v0.2.1 peer-bootstrap payload shape.
const PAIR_SCHEMA_V = '1.0';

// Compare dotted-numeric version strings. Returns 1 if a>b, -1 if a<b, 0 if eq.
// Mirror of wire.js schemaNewer from Дельта's cc4fa3c (which lands via rebase
// in push-stack #2). Defined locally so commit-3f's gate works pre-rebase —
// post-rebase we can consolidate by importing from ./wire.js.
function schemaNewer(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// Gemini sv3 minor SEV-2 nit fix (commit-3f): stream.close() returns a Promise
// that we previously fired without await, risking unhandled rejections. This
// helper swallows both sync throws and async rejections so error paths get
// deterministic cleanup without the caller having to await.
function safeClose(stream) {
  try {
    const p = stream.close();
    if (p && typeof p.then === 'function') p.catch(() => {});
  } catch {}
}

// ─── token codec ────────────────────────────────────────────────────────────

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

/**
 * Encode a pair-token bundle into the canonical `demi-pair1:<b64url(JSON)>` form.
 * Fields use short keys to keep Telegram-sharable tokens compact.
 */
export function encodePairToken({ code, peerId, addrs, pubHex, ts }) {
  if (typeof code !== 'string' || !code) throw new Error('encodePairToken: code required');
  if (typeof peerId !== 'string' || !peerId) throw new Error('encodePairToken: peerId required');
  if (!Array.isArray(addrs) || addrs.length === 0) throw new Error('encodePairToken: addrs[] required');
  if (typeof pubHex !== 'string' || pubHex.length < 32) throw new Error('encodePairToken: pubHex required');
  if (typeof ts !== 'number' || !Number.isFinite(ts)) throw new Error('encodePairToken: ts required');
  const json = JSON.stringify({ c: code, p: peerId, a: addrs, h: pubHex, t: ts });
  return TOKEN_PREFIX + base64urlEncode(Buffer.from(json, 'utf8'));
}

/**
 * Decode a pair-token. Throws `Error('pair token invalid')` on any problem.
 * Returns `{ code, peerId, addrs, pubHex, ts }`.
 */
export function decodePairToken(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
    throw new Error('pair token invalid (prefix)');
  }
  let obj;
  try {
    const payload = base64urlDecode(token.slice(TOKEN_PREFIX.length)).toString('utf8');
    obj = JSON.parse(payload);
  } catch (err) {
    throw new Error('pair token invalid (decode: ' + err.message + ')');
  }
  if (!obj || typeof obj !== 'object') throw new Error('pair token invalid (shape)');
  const { c, p, a, h, t } = obj;
  if (typeof c !== 'string' || !c) throw new Error('pair token invalid (c)');
  if (typeof p !== 'string' || !p) throw new Error('pair token invalid (p)');
  if (!Array.isArray(a) || a.length === 0 || !a.every((x) => typeof x === 'string')) {
    throw new Error('pair token invalid (a)');
  }
  if (typeof h !== 'string' || h.length < 32) throw new Error('pair token invalid (h)');
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error('pair token invalid (t)');
  return { code: c, peerId: p, addrs: a, pubHex: h, ts: t };
}

/**
 * Build the pair token for a fresh pairing session on this node.
 * Must be called AFTER transport.start() so node.peerId and multiaddrs exist.
 *
 * Multiaddr addrs have their `/p2p/<peerId>` suffix stripped — the peerId is
 * stored separately in the token so the redeemer can rebuild any
 * `<addr>/p2p/<peerId>` combination it wants.
 */
export function buildPairToken({ transport, identity, code, ts = Date.now() }) {
  const node = transport?.node;
  if (!node) throw new Error('buildPairToken: transport not started');
  const peerId = node.peerId.toString();
  const addrs = node.getMultiaddrs().map((m) => {
    const s = m.toString();
    const i = s.indexOf('/p2p/');
    return i >= 0 ? s.slice(0, i) : s;
  });
  if (addrs.length === 0) throw new Error('buildPairToken: no multiaddrs (listen not bound?)');
  return encodePairToken({ code, peerId, addrs, pubHex: identity.pubHex, ts });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isFresh(ts, windowMs = FRESH_WINDOW_MS) {
  return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(Date.now() - ts) < windowMs;
}

function rateCheck(map, peerId) {
  const now = Date.now();
  let hits = map.get(peerId) || [];
  // Prune entries older than window
  hits = hits.filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    map.set(peerId, hits);
    return false;
  }
  hits.push(now);
  map.set(peerId, hits);
  return true;
}

// Read exactly one NDJSON frame from a libp2p stream with a hard timeout + size cap.
function readOneFrame(stream, timeoutMs = READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const buffers = [];
    let size = 0;
    let parsed = null;

    const finish = (err, val) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { stream.removeEventListener('message', onMessage); } catch {}
      try { stream.removeEventListener('close', onClose); } catch {}
      if (err) reject(err); else resolve(val);
    };

    const parser = makeParser((msg) => {
      if (parsed) return;
      parsed = msg;
      finish(null, msg);
    });

    const onMessage = (evt) => {
      let data = evt.data;
      if (data && typeof data.subarray === 'function' && !(data instanceof Uint8Array)) {
        data = data.subarray();
      }
      if (!data) return;
      size += data.length;
      if (size > MAX_FRAME_BYTES) {
        return finish(new Error('pair frame too large (>2KB)'));
      }
      buffers.push(data);
      try { parser(data); }
      catch (err) { finish(err); }
    };

    const onClose = () => {
      if (!parsed) finish(new Error('pair stream closed before frame arrived'));
    };

    const timer = setTimeout(() => {
      finish(new Error(`pair frame read timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    stream.addEventListener('message', onMessage);
    stream.addEventListener('close', onClose);
  });
}

// ─── main flow ──────────────────────────────────────────────────────────────

/**
 * Run the libp2p pair flow. Returns a Promise that resolves with
 * `{ pubHex, nickname }` once the other side is verified + upserted as trusted.
 *
 * Shape by role:
 *   - creator:  { transport, identity, nickname, role:'creator', code, ttlMs }
 *                Registers a handler on /demi/pair-req/1.0.0 and resolves on
 *                the first valid pair-req.
 *   - redeemer: { transport, identity, nickname, role:'redeemer', token, ttlMs }
 *                Dials the creator using info embedded in `token`.
 */
export function runLibp2pPairFlow({ transport, identity, nickname, role, code, ttlMs = FRESH_WINDOW_MS, token }) {
  if (role === 'creator') return runCreator({ transport, identity, nickname, code, ttlMs });
  if (role === 'redeemer') return runRedeemer({ transport, identity, nickname, token, ttlMs });
  return Promise.reject(new Error(`runLibp2pPairFlow: unknown role "${role}"`));
}

function runCreator({ transport, identity, nickname, code, ttlMs }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let unhandle = null;
    const rateMap = new Map();        // peerId → [ts, ts, ts]
    let usedAt = null;                 // single-use guard
    const timer = setTimeout(() => {
      finish(reject, new Error(`pair creator timeout (${Math.round(ttlMs / 60000)} min)`));
    }, ttlMs);

    const finish = async (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (unhandle) await unhandle(); } catch {}
      fn(value);
    };

    const handler = async (stream, connection) => {
      const remotePeerId = (() => {
        try { return connection.remotePeer.toString(); } catch { return 'unknown'; }
      })();

      // Rate-limit per remote peer, fail-closed.
      if (!rateCheck(rateMap, remotePeerId)) {
        audit('pair.libp2p.rate_limited', { peer: remotePeerId.slice(0, 16) });
        safeClose(stream);
        return;
      }

      let frame;
      try {
        frame = await readOneFrame(stream, READ_TIMEOUT_MS);
      } catch (err) {
        audit('pair.libp2p.read_fail', { peer: remotePeerId.slice(0, 16), err: err.message });
        safeClose(stream);
        return;
      }

      // Validate frame shape
      if (!frame || frame.type !== 'pair-req' ||
          typeof frame.pubHex !== 'string' ||
          typeof frame.nickname !== 'string' ||
          !frame.envelope) {
        audit('pair.libp2p.bad_frame', { peer: remotePeerId.slice(0, 16) });
        safeClose(stream);
        return;
      }

      // verifyEnvelope: signature + by match
      if (!verifyEnvelope(frame.envelope)) {
        audit('pair.libp2p.bad_sig', { peer: remotePeerId.slice(0, 16) });
        safeClose(stream);
        return;
      }
      const env = frame.envelope;
      if (env.type !== 'pair-req' || env.by !== frame.pubHex) {
        audit('pair.libp2p.envelope_mismatch', { peer: remotePeerId.slice(0, 16) });
        safeClose(stream);
        return;
      }
      const p = env.payload || {};
      // Schema gate (Gemini sv3 Finding #2 fix, commit-3f): reject envelopes
      // declaring a pair-protocol version we can't parse safely. Symmetric with
      // parseAgentFrame's __schema_too_new sentinel in wire.js. A v1.0 peer
      // silent-accepting a v2.0 frame would be a type-confusion surface —
      // unknown fields could alter the semantics of role/recipient/freshness.
      if (p.v && schemaNewer(p.v, PAIR_SCHEMA_V) > 0) {
        audit('pair.libp2p.schema_too_new', {
          peer: remotePeerId.slice(0, 16),
          v: p.v,
          pair_schema: PAIR_SCHEMA_V,
        });
        safeClose(stream);
        return;
      }
      if (p.code !== code) {
        audit('pair.libp2p.code_mismatch', { peer: remotePeerId.slice(0, 16) });
        safeClose(stream);
        return;
      }
      if (p.role !== 'redeemer') {
        audit('pair.libp2p.role_mismatch', { peer: remotePeerId.slice(0, 16), role: p.role });
        safeClose(stream);
        return;
      }
      if (p.recipient !== identity.pubHex) {
        audit('pair.libp2p.recipient_mismatch', { peer: remotePeerId.slice(0, 16) });
        safeClose(stream);
        return;
      }
      if (!isFresh(p.ts)) {
        audit('pair.libp2p.stale', { peer: remotePeerId.slice(0, 16), delta_ms: typeof p.ts === 'number' ? Date.now() - p.ts : null });
        safeClose(stream);
        return;
      }

      // Single-use guard — only the first valid redeemer wins. Additional
      // valid-looking pair-req attempts from other peers under the same code
      // are refused.
      if (usedAt !== null) {
        audit('pair.code_reused', {
          peer: remotePeerId.slice(0, 16),
          used_at: usedAt,
          reused_by: frame.pubHex.slice(0, 16),
        });
        safeClose(stream);
        return;
      }
      usedAt = Date.now();

      // Accept: upsert trusted peer.
      //
      // commit-3e (POST_PAIR_REJOIN_PARTIAL fix): use identify-service peerStore
      // lookup for the redeemer's certified listen address rather than the
      // ephemeral source port captured by connection.remoteAddr. Without this,
      // restarts + rejoinAllKnown() fail with ECONNREFUSED because the OS
      // reassigns source ports. Fallback to connection.remoteAddr only if
      // peerStore is empty (slow identify round-trip on hostile LAN).
      let listenAddr = null;
      if (typeof transport.getListenAddrFor === 'function') {
        try {
          listenAddr = await transport.getListenAddrFor(connection.remotePeer);
        } catch {}
      }
      const fallbackAddr = connection.remoteAddr?.toString() || null;
      const rejoinAddr = listenAddr || fallbackAddr;
      try {
        upsertPeer(frame.pubHex, {
          self_nickname: frame.nickname,
          fp_short: frame.pubHex.slice(0, 8),
          trust: 'trusted',
          online: true,
          last_multiaddr: rejoinAddr,
        });
        audit('pair.libp2p.rejoin_addr', {
          peer: frame.pubHex.slice(0, 16),
          source: listenAddr ? 'identify' : (fallbackAddr ? 'ephemeral-fallback' : 'none'),
        });
      } catch (err) {
        audit('pair.libp2p.upsert_fail', { err: err.message });
      }

      // Reply: signed envelope binding to redeemer's identity.
      // v1.0 payload (commit-3f): includes `v` so future v2.0 peers can
      // recognise our capabilities without guessing. Older peers (pre-3f) that
      // don't send `v` still parse — missing `v` is treated as v1.0 by the gate.
      const replyEnvelope = signEnvelope(identity, 'pair-ack', {
        v: PAIR_SCHEMA_V,
        code,
        role: 'creator',
        ts: Date.now(),
        recipient: frame.pubHex,
      });
      const replyFrame = {
        type: 'pair-ack',
        pubHex: identity.pubHex,
        nickname,
        envelope: replyEnvelope,
      };
      try {
        stream.send(encode(replyFrame));
      } catch (err) {
        audit('pair.libp2p.reply_send_fail', { err: err.message });
        safeClose(stream);
        return finish(reject, new Error('pair reply send failed: ' + err.message));
      }

      audit('pair.success', {
        peer: frame.pubHex.slice(0, 16),
        role: 'creator',
        transport: 'libp2p',
        via: 'peer-bootstrap',
      });

      // Close the stream politely; resolve with the redeemer's identity.
      setTimeout(() => safeClose(stream), 50);
      finish(resolve, { pubHex: frame.pubHex, nickname: frame.nickname });
    };

    (async () => {
      try {
        unhandle = await transport.handlePair(handler);
      } catch (err) {
        finish(reject, err);
      }
    })();
  });
}

function runRedeemer({ transport, identity, nickname, token, ttlMs }) {
  return new Promise((resolve, reject) => {
    let decoded;
    try {
      decoded = decodePairToken(token);
    } catch (err) {
      return reject(err);
    }
    if (!isFresh(decoded.ts, ttlMs)) {
      return reject(new Error('pair token expired'));
    }
    const { code, peerId, addrs, pubHex: creatorPubHex } = decoded;

    // Timer is a safety-net on top of dialPair timeout + readOneFrame timeout.
    let done = false;
    const timer = setTimeout(() => {
      finish(reject, new Error(`pair redeemer timeout (${Math.round(ttlMs / 60000)} min)`));
    }, ttlMs);

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };

    (async () => {
      try {
        // Build the request envelope. Recipient = creator's identity pubHex
        // from token → creator will verify `envelope.payload.recipient === identity.pubHex`.
        // v1.0 payload (commit-3f): stamp `v` so creators running 3f+ run the
        // schema gate and future v2.0 peers get a deterministic drop-path.
        const reqEnvelope = signEnvelope(identity, 'pair-req', {
          v: PAIR_SCHEMA_V,
          code,
          role: 'redeemer',
          ts: Date.now(),
          recipient: creatorPubHex,
        });
        const reqFrame = {
          type: 'pair-req',
          pubHex: identity.pubHex,
          nickname,
          envelope: reqEnvelope,
        };
        const reqBytes = encode(reqFrame);
        if (reqBytes.length > MAX_FRAME_BYTES) {
          throw new Error('pair-req frame too large');
        }

        const respBytes = await transport.dialPair(peerId, addrs, reqBytes, DIAL_TIMEOUT_MS);
        if (!respBytes || respBytes.length === 0) {
          throw new Error('pair: empty response from creator');
        }

        // Parse response (single NDJSON frame).
        let resp = null;
        const parser = makeParser((msg) => { if (!resp) resp = msg; });
        try { parser(respBytes); } catch (err) {
          throw new Error('pair: response parse failed: ' + err.message);
        }
        if (!resp) throw new Error('pair: no frame in response');

        if (resp.type !== 'pair-ack' ||
            typeof resp.pubHex !== 'string' ||
            typeof resp.nickname !== 'string' ||
            !resp.envelope) {
          throw new Error('pair: bad response frame shape');
        }
        if (!verifyEnvelope(resp.envelope)) {
          throw new Error('pair: response signature invalid');
        }
        if (resp.envelope.by !== resp.pubHex) {
          throw new Error('pair: response envelope.by mismatch');
        }
        if (resp.pubHex !== creatorPubHex) {
          throw new Error('pair: response from unexpected identity (possible MITM)');
        }
        const rp = resp.envelope.payload || {};
        // Schema gate (Gemini sv3 Finding #2 fix, commit-3f): redeemer-side
        // symmetric check. If the creator is running a future pair protocol
        // version whose semantics we don't understand, refuse to upsert-trust
        // based on a frame we might mis-interpret.
        if (rp.v && schemaNewer(rp.v, PAIR_SCHEMA_V) > 0) {
          throw new Error(`pair: response schema too new (v=${rp.v}, supported ≤${PAIR_SCHEMA_V})`);
        }
        if (rp.code !== code) throw new Error('pair: response code mismatch');
        if (rp.role !== 'creator') throw new Error('pair: response role mismatch');
        if (rp.recipient !== identity.pubHex) throw new Error('pair: response recipient mismatch');
        if (!isFresh(rp.ts)) throw new Error('pair: response stale');

        // v0.2.1 gap-2 fix: persist last_multiaddr from token.addrs[0] so that
        // rejoinAllKnown() can re-dial the creator after restart. Mirror of
        // the creator-side upsert at line 356 which captures
        // connection.remoteAddr from the inbound pair connection.
        upsertPeer(resp.pubHex, {
          self_nickname: resp.nickname,
          fp_short: resp.pubHex.slice(0, 8),
          trust: 'trusted',
          online: true,
          last_multiaddr: Array.isArray(addrs) && addrs.length > 0 ? addrs[0] : null,
        });

        audit('pair.success', {
          peer: resp.pubHex.slice(0, 16),
          role: 'redeemer',
          transport: 'libp2p',
          via: 'peer-bootstrap',
        });

        // v0.2.1 gap-1 fix: graduate pair-only trust into a live wire stream so
        // chat/agent frames flow without DEMI_LIBP2P_BOOTSTRAP. Redeemer is the
        // dialer; creator side auto-attaches via node.handle(DEMI_WIRE_PROTO).
        // joinPeer is idempotent — skips re-attach if socket already present.
        if (typeof transport.joinPeer === 'function') {
          try {
            await transport.joinPeer(resp.pubHex);
          } catch (err) {
            audit('pair.libp2p.post_pair_wire_fail', { err: err.message });
          }
        }

        finish(resolve, { pubHex: resp.pubHex, nickname: resp.nickname });
      } catch (err) {
        audit('pair.libp2p.redeemer_fail', { err: err.message });
        finish(reject, err);
      }
    })();
  });
}
