// src/chat.js — message send/receive with rate limit + injection detection
import { chatFrame, encode, detectInjection, sanitizeText, parseAgentFrame } from './wire.js';
import { saveMessage, getHistory, upsertPeer, audit } from './db.js';
import { loadConfig } from './paths.js';
import { verifyEnvelope } from './identity.js';

const cfg = loadConfig();
const RATE_WINDOW_MS = cfg.rateWindowMs ?? 60_000;
const RATE_MAX = cfg.rateMax ?? 10;
const MAX_TEXT_LEN = cfg.maxTextLen ?? 4096;

const rateState = new Map(); // pubkey -> [ts, ts, ...]

function checkRate(pubkey) {
  const now = Date.now();
  const arr = (rateState.get(pubkey) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) return false;
  arr.push(now);
  rateState.set(pubkey, arr);
  return true;
}

// Send chat to peer (via transport.send)
export async function sendChat({ transport, peerPubkey, text }) {
  if (!text || typeof text !== 'string') throw new Error('text required');
  const clean = sanitizeText(text, MAX_TEXT_LEN);
  if (!clean) throw new Error('text empty after sanitize');
  if (!checkRate(peerPubkey)) throw new Error('rate limit');

  const frame = chatFrame(clean);
  const ok = await transport.send(peerPubkey, encode(frame));

  const { flagged } = detectInjection(clean);
  saveMessage({
    pubkey: peerPubkey,
    direction: 'out',
    ts: frame.ts,
    text: clean,
    flagged,
  });

  // Distinguish structured agent RPC from plain chat in the audit trail so
  // `claim/release/status/heartbeat` events are grep-able without parsing JSON.
  const agent = parseAgentFrame(clean);
  if (agent) {
    audit('agent.' + agent.type, {
      peer: peerPubkey.slice(0, 16),
      direction: 'out',
      delivered: ok,
      ...pickAgentMeta(agent),
    });
  } else {
    audit('chat.out', { peer: peerPubkey.slice(0, 16), len: clean.length, delivered: ok });
  }

  return { ok, delivered: ok, ts: frame.ts, agent: agent || undefined };
}

// Extract the meta fields that matter per-agent-type so audit rows stay flat.
// For 'review' frames we ALSO cryptographically verify the attached signature
// when `ownPubHex` is supplied (only the receiving side has it). The result is
// surfaced as `verified:true|false`; `signed` alone is NOT trustworthy because
// any peer can attach garbage bytes to the `sig` field.
function pickAgentMeta(agent, opts = {}) {
  switch (agent.type) {
    case 'claim':     return { path: agent.path, ttl: agent.ttl, reason: agent.reason };
    case 'release':   return { path: agent.path };
    case 'status':    return { task: agent.task, state: agent.state, branch: agent.branch };
    case 'heartbeat': return { claim: agent.claim, ttl_extend: agent.ttl_extend };
    case 'handoff':   return { branch: agent.branch, from: agent.from, to: agent.to };
    case 'conflict':  return { file: agent.file, question: agent.question };
    case 'review':    {
      const meta = {
        target_sha: agent.target_sha,
        scope: agent.target_scope,
        verdict: agent.verdict,
        findings_n: Array.isArray(agent.findings) ? agent.findings.length : 0,
        reviewer: agent.reviewer,
        signed: !!agent.sig,
      };
      if (agent.sig && opts.ownPubHex) {
        meta.verified = verifyReviewSig(agent, opts.ownPubHex);
      } else if (agent.sig) {
        meta.verified = null; // cannot check — outgoing side, or caller didn't pass ownPubHex
      }
      return meta;
    }
    default:          return {};
  }
}

// Verify that a review-frame's signature:
//   1. is cryptographically valid (ed25519 over demi.v1\nagent-review\n<canonical payload>)
//   2. was signed by the claimed reviewer (sig.by === agent.reviewer)
//   3. targets US (payload.recipient === ownPubHex)  — blocks cross-peer replay
//   4. is fresh (payload.signed_ts within ±5 min)    — blocks eternal replay
//   5. matches the outer frame fields bit-for-bit     — blocks tampering
// Returns true only when ALL checks pass. Fail-closed on any error.
function verifyReviewSig(agent, ownPubHex) {
  try {
    const sig = agent.sig;
    if (!sig || typeof sig !== 'object') return false;
    if (sig.type !== 'agent-review') return false;
    if (!verifyEnvelope(sig)) return false;
    const p = sig.payload || {};

    // Reviewer identity must match the envelope signer (no "I claim to be X while signing as Y")
    if (p.reviewer && agent.reviewer && p.reviewer !== agent.reviewer) return false;
    if (agent.reviewer && sig.by !== agent.reviewer) return false;

    // Recipient binding — refuse to accept a signature meant for a different peer
    if (p.recipient !== ownPubHex) return false;

    // Freshness — signed_ts must be inside the signed payload, not the outer ts
    if (typeof p.signed_ts !== 'number') return false;
    if (Math.abs(Date.now() - p.signed_ts) > 5 * 60 * 1000) return false;

    // Tamper check — every security-relevant outer field must match the signed payload.
    const mustMatch = ['target_sha', 'target_scope', 'verdict', 'reviewer', 'reviewer_role', 'recipient', 'nonce', 'signed_ts'];
    for (const k of mustMatch) {
      const a = agent[k];
      const b = p[k];
      if ((a ?? null) !== (b ?? null)) return false;
    }
    // Findings comparison by canonical JSON (array order matters — sender chose it)
    const fa = JSON.stringify(agent.findings ?? []);
    const fb = JSON.stringify(p.findings ?? []);
    if (fa !== fb) return false;

    return true;
  } catch {
    return false;
  }
}

// Handle incoming chat frame.
// `ownPubHex` MUST be the receiving node's identity pubkey (hex). It is used
// to verify that signed review-frames were bound to us as the recipient.
// Omitting it causes review signatures to be reported as `verified:null`.
export function handleIncomingChat({ pubkey, frame, onBroadcast, ownPubHex }) {
  if (!checkRate(pubkey)) {
    audit('chat.rate-drop', { peer: pubkey.slice(0, 16) });
    return;
  }
  const text = sanitizeText(frame.text, MAX_TEXT_LEN);
  const ts = frame.ts || new Date().toISOString();
  const { flagged, reasons } = detectInjection(text);

  saveMessage({ pubkey, direction: 'in', ts, text, flagged });
  upsertPeer(pubkey, { online: true });

  const agent = parseAgentFrame(text);
  if (agent) {
    audit('agent.' + agent.type, {
      peer: pubkey.slice(0, 16),
      direction: 'in',
      ...pickAgentMeta(agent, { ownPubHex }),
    });
  } else {
    audit('chat.in', { peer: pubkey.slice(0, 16), len: text.length, flagged, reasons });
  }

  if (onBroadcast) {
    onBroadcast({
      kind: 'chat-in',
      pubkey,
      ts,
      text,
      flagged,
      agent: agent || undefined,
    });
  }
}

export function history(pubkey, limit) {
  return getHistory(pubkey, limit);
}
