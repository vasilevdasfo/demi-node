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
export function makeParser(onLine) {
  let buf = '';
  return (chunk) => {
    buf += b4a.toString(chunk, 'utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      if (buf.length > MAX_FRAME * 4) {
        buf = ''; // protection against flood
        continue;
      }
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
export const AGENT_SCHEMA_V = '1.0';

export const AGENT_KINDS = new Set([
  'claim',      // { type:'claim', path, ttl, session?, reason?, ts? }
  'release',    // { type:'release', path, session?, ts? }
  'status',     // { type:'status', task, state, branch?, ts? }
  'heartbeat',  // { type:'heartbeat', claim, ttl_extend?, ts? }
  'handoff',    // { type:'handoff', branch, from, to, reason?, ts? }
  'conflict',   // { type:'conflict', file, mine_sha?, theirs_sha?, question?, ts? }
  'review',     // { type:'review', target_sha, target_scope?, verdict, findings[], reviewer?,
                //   reviewer_role?, sig? } — peer code review between agents. `sig` is a
                //   signed envelope produced by identity.signEnvelope(id,'agent-review',body)
                //   over the review body excluding the sig field itself; receivers MAY verify.
]);

/**
 * Parse a chat.text as an agent RPC frame.
 * Returns the parsed object when `text` is JSON with a recognised `type`,
 * or `null` otherwise. Safe on any input (never throws).
 */
export function parseAgentFrame(text) {
  if (!text || typeof text !== 'string' || text[0] !== '{') return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && AGENT_KINDS.has(obj.type)) return obj;
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
