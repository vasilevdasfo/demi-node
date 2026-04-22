// src/chat.js — message send/receive with rate limit + injection detection
import { chatFrame, encode, detectInjection, sanitizeText } from './wire.js';
import { saveMessage, getHistory, upsertPeer, audit } from './db.js';
import { loadConfig } from './paths.js';

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
  audit('chat.out', { peer: peerPubkey.slice(0, 16), len: clean.length, delivered: ok });

  return { ok, delivered: ok, ts: frame.ts };
}

// Handle incoming chat frame
export function handleIncomingChat({ pubkey, frame, onBroadcast }) {
  if (!checkRate(pubkey)) {
    audit('chat.rate-drop', { peer: pubkey.slice(0, 16) });
    return;
  }
  const text = sanitizeText(frame.text, MAX_TEXT_LEN);
  const ts = frame.ts || new Date().toISOString();
  const { flagged, reasons } = detectInjection(text);

  saveMessage({ pubkey, direction: 'in', ts, text, flagged });
  upsertPeer(pubkey, { online: true });
  audit('chat.in', { peer: pubkey.slice(0, 16), len: text.length, flagged, reasons });

  if (onBroadcast) {
    onBroadcast({
      kind: 'chat-in',
      pubkey,
      ts,
      text,
      flagged,
    });
  }
}

export function history(pubkey, limit) {
  return getHistory(pubkey, limit);
}
