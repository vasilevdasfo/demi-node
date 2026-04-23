// src/pair.js — pair-code / pair-token dispatcher (Этап B v0.2.1).
//
// 6-digit code → transport-specific rendezvous:
//   - Hyperswarm: DHT topic rendezvous (src/hyperswarm-pair.js)
//     Shape: createPair → { code, promise }, redeemPair(code) → { peer }.
//   - libp2p:     peer-bootstrap direct-dial (src/libp2p-pair.js)
//     Shape: createPair → { code, token, promise }, redeemPair(token) → { peer }.
//
// The libp2p branch REQUIRES a full token for redeem because the 6-digit code
// alone does NOT identify the creator (no public rendezvous exists). The
// token carries peerId + multiaddrs + creator's identity pubHex.
//
// Hyperswarm branch is unchanged.

import crypto from 'node:crypto';
import b4a from 'b4a';
import { audit } from './db.js';

// ─── shared helpers (imported by both pair-flow impls + transport) ──────────

export function generatePairCode() {
  // 6 digits, grouped as NNN-NNN (first digit 1–9 to avoid leading-zero confusion)
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

// ─── dispatcher ─────────────────────────────────────────────────────────────

/**
 * Create a pairing session.
 *
 * Return shapes:
 *   hyperswarm: { code, promise }
 *   libp2p:     { code, token, promise }
 *
 * The CLI/RPC prints `code` (+ `token` if present) immediately while the
 * handshake runs in `promise` in the background.
 */
export function createPair({ transport, identity, nickname, ttlMs = 5 * 60 * 1000 }) {
  const kind = transport?.kind || 'hyperswarm';
  const code = generatePairCode();

  if (kind === 'hyperswarm') {
    const promise = (async () => {
      const { runHyperswarmPairFlow } = await import('./hyperswarm-pair.js');
      return runHyperswarmPairFlow({
        transport, identity, nickname, role: 'creator', code, ttlMs,
      });
    })();
    audit('pair.create', {
      code,
      topic: b4a.toString(pairTopic(code), 'hex').slice(0, 16),
      transport: 'hyperswarm',
    });
    return { code, promise };
  }

  if (kind === 'libp2p') {
    // Synchronously build the token so the CLI can print it immediately.
    // Throws if transport not started — bubbles to caller.
    // Dynamic import would break synchronous token return; we import statically.
    // (This file already depends on ./libp2p-pair.js indirectly; direct import
    // is cheap and keeps createPair's sync contract for the `token` field.)
    // eslint-disable-next-line
    const { buildPairToken, runLibp2pPairFlow } = requireLibp2pPair();
    const token = buildPairToken({ transport, identity, code });
    const promise = runLibp2pPairFlow({
      transport, identity, nickname, role: 'creator', code, ttlMs,
    });
    audit('pair.create', { code, transport: 'libp2p' });
    return { code, token, promise };
  }

  throw new Error(`pair.js: unknown transport.kind="${kind}"`);
}

/**
 * Redeem a pairing.
 *
 * Accepts:
 *   - `{ code }` (hyperswarm only): 6-digit code.
 *   - `{ token }` (libp2p only): full `demi-pair1:…` bundle.
 *
 * Libp2p redeem REQUIRES a token; the code alone is not sufficient because
 * there is no public rendezvous — the token carries peerId + multiaddrs.
 */
export async function redeemPair({ transport, identity, nickname, code, token, ttlMs = 5 * 60 * 1000 }) {
  const kind = transport?.kind || 'hyperswarm';

  if (kind === 'hyperswarm') {
    if (!code) throw new Error('hyperswarm redeem requires a 6-digit code');
    audit('pair.redeem', {
      code,
      topic: b4a.toString(pairTopic(code), 'hex').slice(0, 16),
      transport: 'hyperswarm',
    });
    const { runHyperswarmPairFlow } = await import('./hyperswarm-pair.js');
    const peer = await runHyperswarmPairFlow({
      transport, identity, nickname, role: 'redeemer', code, ttlMs,
    });
    return { peer };
  }

  if (kind === 'libp2p') {
    if (!token) {
      throw new Error('libp2p redeem requires full token (code is not sufficient)');
    }
    const { runLibp2pPairFlow, decodePairToken } = await import('./libp2p-pair.js');
    const decoded = decodePairToken(token); // throws if malformed / expired handled downstream
    audit('pair.redeem', {
      code: decoded.code,
      transport: 'libp2p',
      creator_peer: decoded.peerId.slice(0, 16),
    });
    const peer = await runLibp2pPairFlow({
      transport, identity, nickname, role: 'redeemer', token, ttlMs,
    });
    return { peer };
  }

  throw new Error(`pair.js: unknown transport.kind="${kind}"`);
}

// ─── internal: synchronous libp2p-pair loader ──────────────────────────────
// createPair needs to return `token` synchronously so callers can print it
// right away. ES modules don't have sync `require`; we use a module-level
// dynamic-import-then-cache trick. To keep createPair sync, we actually use
// top-level await indirectly via a bootstrap import that runs once.
//
// NOTE: because `createPair` is called from `rpc('pair.new')` inside an async
// handler, we can safely use an awaited import on first call and cache the
// module afterwards.  The `requireLibp2pPair()` call below is only reached
// from the `kind === 'libp2p'` branch — callers on that branch should have
// awaited `ensureLibp2pPairLoaded()` during node startup.  For v0.2.1 we take
// the simpler approach: synchronously use `import.meta` resolution via
// pre-registered `LIBP2P_PAIR_MODULE`, seeded by the module loader below.

let _libp2pPairMod = null;

function requireLibp2pPair() {
  if (_libp2pPairMod) return _libp2pPairMod;
  throw new Error(
    'libp2p-pair module not preloaded. Call ensureLibp2pPairLoaded() before createPair() on libp2p transport.',
  );
}

/**
 * Preload the libp2p-pair module so createPair() can return `token` synchronously.
 * Safe to call multiple times; idempotent.
 */
export async function ensureLibp2pPairLoaded() {
  if (_libp2pPairMod) return _libp2pPairMod;
  _libp2pPairMod = await import('./libp2p-pair.js');
  return _libp2pPairMod;
}
