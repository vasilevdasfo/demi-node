// src/identity.js — ed25519 identity + panic wipe + signing
import crypto from 'node:crypto';
import fs from 'node:fs';
import { paths, ensureHome } from './paths.js';

// Generate fresh ed25519 keypair and store to disk (chmod 600)
export function generateIdentity() {
  ensureHome();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPriv = privateKey.export({ format: 'der', type: 'pkcs8' });
  const rawPub = publicKey.export({ format: 'der', type: 'spki' });
  fs.writeFileSync(paths.identity, rawPriv, { mode: 0o600 });
  fs.writeFileSync(paths.identityPub, rawPub.toString('hex') + '\n');
  return loadIdentity();
}

// Load identity from disk; return null if missing
export function loadIdentity() {
  if (!fs.existsSync(paths.identity)) return null;
  const privDer = fs.readFileSync(paths.identity);
  const pubHex = fs.readFileSync(paths.identityPub, 'utf8').trim();
  const privateKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey({ key: Buffer.from(pubHex, 'hex'), format: 'der', type: 'spki' });
  const rawPub = publicKey.export({ format: 'der', type: 'spki' });
  // Last 32 bytes of SPKI-DER = raw ed25519 pubkey
  const pubKeyRaw = rawPub.slice(-32);
  return {
    privateKey,
    publicKey,
    pubHex: pubKeyRaw.toString('hex'),
    fpShort: pubKeyRaw.slice(0, 4).toString('hex'), // 8 hex chars
  };
}

// Sign a canonical JSON envelope (domain-separated)
export function signEnvelope(identity, type, payload) {
  const canonical = canonicalize(payload);
  const msg = Buffer.from(`demi.v1\n${type}\n${canonical}`, 'utf8');
  const sig = crypto.sign(null, msg, identity.privateKey);
  return {
    type,
    payload,
    ts: new Date().toISOString(),
    sig: sig.toString('base64'),
    by: identity.pubHex,
  };
}

// Verify envelope against claimed pubkey
export function verifyEnvelope(envelope) {
  try {
    const { type, payload, sig, by } = envelope;
    const canonical = canonicalize(payload);
    const msg = Buffer.from(`demi.v1\n${type}\n${canonical}`, 'utf8');
    const pubRaw = Buffer.from(by, 'hex');
    // Rebuild SPKI-DER for ed25519: fixed 12-byte prefix + 32-byte key
    const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    const der = Buffer.concat([SPKI_PREFIX, pubRaw]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, msg, key, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

// Deterministic JSON canonicalization (sorted keys)
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

// PANIC WIPE — overwrite private key 3 times, delete history, config
export function panicWipe({ keepStub = false } = {}) {
  const targets = [paths.identity, paths.chatDb, paths.peersJson, paths.config, paths.nickname];
  for (const t of targets) {
    try {
      if (fs.existsSync(t)) {
        const sz = fs.statSync(t).size;
        // 3-pass overwrite with random bytes
        for (let i = 0; i < 3; i++) {
          fs.writeFileSync(t, crypto.randomBytes(Math.max(sz, 64)));
        }
        fs.unlinkSync(t);
      }
    } catch (e) {
      console.error(`wipe ${t}: ${e.message}`);
    }
  }
  if (!keepStub) {
    // Leave marker so supervisor stops
    try { fs.unlinkSync(paths.active); } catch {}
  }
  return { wiped: targets.length };
}

// Fingerprint: first 8 hex chars of pubkey
export function fingerprint(pubHex) {
  return pubHex.slice(0, 8);
}
