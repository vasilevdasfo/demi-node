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

// Build hello frame (symmetric, both sides send after socket open)
export function helloFrame({ nickname, agent, role, caps, lang, version, fpShort, nickLocked = false }) {
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
