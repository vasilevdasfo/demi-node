// src/wire.js — line-delimited JSON wire protocol + hello frames
import b4a from 'b4a';

// Max frame size (bytes)
export const MAX_FRAME = 16 * 1024;

// Encode a message to newline-terminated JSON
export function encode(msg) {
  const s = JSON.stringify(msg) + '\n';
  if (Buffer.byteLength(s) > MAX_FRAME) throw new Error('frame too large');
  return b4a.from(s, 'utf8');
}

// Streaming line parser — call onLine for each complete line
//
// Gemini sv2 SEV-4 (OOM) fix: length check runs BEFORE concat. If a peer
// streams data without '\n', the previous post-split check was unreachable
// (while loop only entered after indexOf('\n') >= 0), allowing `buf` to grow
// unbounded in heap. Move the cap ahead of concat so an attacker who never
// sends a newline gets the buffer flushed after MAX_FRAME*4 bytes.
export function makeParser(onLine) {
  let buf = '';
  return (chunk) => {
    const added = b4a.toString(chunk, 'utf8');
    if (buf.length + added.length > MAX_FRAME * 4) {
      buf = ''; // flood protection BEFORE concat (unbounded-growth guard)
      return;
    }
    buf += added;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        // Ignore malformed; don't crash
      }
    }
  };
}

// Build hello frame (symmetric, both sides send after socket open).
//
// `auth` is OPTIONAL but REQUIRED to enable trusted-peer socket rebind on reconnect.
// It is a signed envelope (from identity.signEnvelope) proving that the sender
// controls the full identity pubkey — NOT just the short fingerprint. The envelope
// binds the sender pubkey to the current hyperswarm session pubkey so a captured
// envelope cannot be replayed on a different connection.
//
// Callers that want rebind-after-restart must pass `auth` built from:
//   signEnvelope(identity, 'hello-auth', { session: <hyperswarm-session-pubkey-hex>, ts: Date.now() })
// and receivers must verify `by === identity.pubHex` AND `payload.session === info.publicKey`.
export function helloFrame({ nickname, agent, role, caps, lang, version, fpShort, nickLocked = false, auth = null }) {
  return {
    type: 'hello',
    v: version || '0.3.10-demi',
    nick: String(nickname || '').slice(0, 40),
    agent: String(agent || 'DEMI').slice(0, 32),
    role: String(role || 'operator').slice(0, 64),
    caps: Array.isArray(caps) ? caps.slice(0, 16) : ['chat', 'rooms'],
    lang: String(lang || 'en').slice(0, 5),
    fpShort: String(fpShort || '').slice(0, 16),
    nickLocked: Boolean(nickLocked),
    ...(auth ? { auth } : {}),
  };
}

// Strip control chars except tab / newline / carriage-return, trim to maxLen chars.
export function sanitizeText(text, maxLen = 4096) {
  let s = String(text ?? '');
  // Remove C0 control chars except \t \n \r and DEL (0x7F)
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Chat frame
export function chatFrame(text, opts = {}) {
  return {
    type: 'chat',
    text: sanitizeText(text, 4096),
    ts: new Date().toISOString(),
    ...opts,
  };
}

// Pair-ack frame (during pairing handshake)
export function pairAckFrame({ pubHex, nickname, envelope }) {
  return {
    type: 'pair-ack',
    pubHex,
    nickname,
    envelope, // signed envelope proving ownership of pubkey
  };
}

// Prompt-injection detector (returns { flagged: bool, reasons: [] })
const INJECTION_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /disregard\s+all\s+prior/i,
  /<\/?system>/i,
  /reveal\s+(your\s+)?(mnemonic|private\s+key|secret)/i,
  /print\s+the\s+prompt/i,
  /you\s+are\s+now\s+(in\s+)?dev(eloper)?\s+mode/i,
  /jailbreak/i,
];

export function detectInjection(text) {
  const reasons = [];
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) reasons.push(re.source);
  }
  return { flagged: reasons.length > 0, reasons };
}

// ---------- Agent RPC framing (structured chat frames) ----------
// Some chat messages are actually structured RPC between agents (e.g. two
// Claude sessions coordinating work via claim/release/status/heartbeat).
// The wire format is intentionally simple: an agent frame is just a chat
// frame whose `text` field is a JSON object with a recognised `type`.
// This keeps compatibility with plain-chat clients that never parsed it.
//
// Schema version: every outgoing frame stamps `v: AGENT_SCHEMA_V` so future
// versions can add fields without breaking older parsers. Incoming frames
// without `v` are tolerated as v:"1.0" (no behaviour change).
// v1.1 (2026-04-22) — add q/a/proposal/vote to canonical set, add cross-ref fields:
//   vote.related_review?  — sha of a review whose verdict this vote references
//   review.implies_vote?  — object { pid, choice, reason? } where choice ∈
//                           {'yes','no','abstain'}; auto-count this review as a
//                           vote on the proposal identified by implies_vote.pid
//                           (review outranks vote when both exist: verdict=approve
//                           ≡ yes, reject ≡ no). Agreed with Альфа (Q-1 compromise
//                           variant A, vault letter 22:20 PT) + independently
//                           validated by Gemini adversarial review on ea16d23.
//   review.parent_review_sha? — sha of a prior review this one follows up on;
//                           enables review chains (ack, rebuttal, re-review).
// All new fields are OPTIONAL; v1.0 peers ignore them → backward-compatible.
// Newer-version gate: frames claiming v > AGENT_SCHEMA_V are dropped with a
// __schema_too_new sentinel (see parseAgentFrame below).
export const AGENT_SCHEMA_V = '1.1';

// semver-style compare ('1.0' < '1.1' < '1.10' < '2.0').
// Returns positive if a>b, zero if equal, negative if a<b.
function schemaNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export const AGENT_KINDS = new Set([
  'claim',      // { type:'claim', path, ttl, session?, reason?, ts? }
  'release',    // { type:'release', path, session?, ts? }
  'status',     // { type:'status', task, state, branch?, ts?, ref?, progress? }
  'heartbeat',  // { type:'heartbeat', claim, ttl_extend?, ts? }
  'handoff',    // { type:'handoff', branch, from, to, reason?, ts? }
  'conflict',   // { type:'conflict', file, mine_sha?, theirs_sha?, question?, ts? }
  'question',   // { type:'question', id, prompt, options?, ts? }
  'answer',     // { type:'answer', qid, choice, reason?, ts? }
  'proposal',   // { type:'proposal', id, title, body, cost?, impact?, risk?,
                //   escalate_dmitry?, ts? }
  'vote',       // { type:'vote', pid, choice, reason?, related_review?, ts? }
                //   related_review — optional sha of a review this vote references.
  'review',     // { type:'review', target_sha, target_scope?, verdict, findings[],
                //   reviewer?, reviewer_role?, implies_vote?, parent_review_sha?, sig?, ts? }
                //   sig — signed envelope (signEnvelope(id,'agent-review',body))
                //   implies_vote — object { pid, choice, reason? } where
                //                  choice ∈ {'yes','no','abstain'}. When set,
                //                  counts as a vote on proposal `implies_vote.pid`.
                //                  Runtime invariant: implies_vote.pid MUST be
                //                  a non-empty string if implies_vote is set.
                //   parent_review_sha — sha of prior review in a chain (ack/rebuttal).
]);

/**
 * Parse a chat.text as an agent RPC frame.
 * Returns the parsed object when `text` is JSON with a recognised `type`,
 * or `null` otherwise. Safe on any input (never throws).
 *
 * Version gate (Gemini Finding #2 on ea16d23, sev 4):
 * Frames claiming a schema version STRICTLY NEWER than AGENT_SCHEMA_V return
 * a `__schema_too_new` sentinel (not null) so callers can audit and drop
 * without mistaking the frame for non-agent chat. Frames without `v` are
 * treated as v1.0 per the backward-compat invariant.
 */
export function parseAgentFrame(text) {
  if (!text || typeof text !== 'string' || text[0] !== '{') return null;
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;
    // Schema-version gate: drop frames claiming a version we do not speak.
    if (obj.v && schemaNewer(obj.v, AGENT_SCHEMA_V) > 0) {
      return { __schema_too_new: true, v: obj.v, type: obj.type };
    }
    if (!AGENT_KINDS.has(obj.type)) return null;
    return obj;
  } catch {}
  return null;
}

/**
 * Serialize an agent frame payload for transport as chat.text.
 * Always stamps a `ts` (unix seconds) and `v` (schema version) if not provided.
 */
export function agentFrameText(type, payload = {}) {
  if (!AGENT_KINDS.has(type)) throw new Error(`unknown agent frame type: ${type}`);
  const ts = payload.ts || Math.floor(Date.now() / 1000);
  const v = payload.v || AGENT_SCHEMA_V;
  return JSON.stringify({ type, v, ts, ...payload });
}
