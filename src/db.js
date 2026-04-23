// src/db.js — SQLite storage for chat + peers
import Database from 'better-sqlite3';
import { paths } from './paths.js';

let db = null;

export function openDb() {
  if (db) return db;
  db = new Database(paths.chatDb);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initSchema();
  return db;
}

function initSchema() {
  // Idempotent migration: add last_multiaddr to existing peers table if missing.
  // libp2p transport (Этап B) stores the remote multiaddr here for reconnect.
  try {
    const cols = db.prepare('PRAGMA table_info(peers)').all();
    if (cols.length && !cols.some((c) => c.name === 'last_multiaddr')) {
      db.exec('ALTER TABLE peers ADD COLUMN last_multiaddr TEXT');
    }
  } catch {}

  // Idempotent migration: add ts_ms (epoch milliseconds) to audit for
  // millisecond-precision benchmarks + timing-attack detection. Legacy
  // `ts` column (unix seconds) kept for backward-compat with v1.0 nodes.
  // New rows write both; old rows have ts_ms=NULL (reader falls back to ts*1000).
  try {
    const cols = db.prepare('PRAGMA table_info(audit)').all();
    if (cols.length && !cols.some((c) => c.name === 'ts_ms')) {
      db.exec('ALTER TABLE audit ADD COLUMN ts_ms INTEGER');
    }
  } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      pubkey TEXT PRIMARY KEY,
      nickname TEXT,
      self_nickname TEXT,
      fp_short TEXT,
      trust TEXT DEFAULT 'unknown',
      first_seen INTEGER DEFAULT (strftime('%s', 'now')),
      last_seen INTEGER,
      online INTEGER DEFAULT 0,
      referred_by TEXT,
      nick_locked INTEGER DEFAULT 0,
      last_multiaddr TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pubkey TEXT NOT NULL,
      direction TEXT NOT NULL,
      ts TEXT NOT NULL,
      text TEXT NOT NULL,
      flagged INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages(pubkey, ts);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(text, content='messages', content_rowid='id');

    CREATE TRIGGER IF NOT EXISTS messages_ai
      AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER DEFAULT (strftime('%s', 'now')),
      ts_ms INTEGER,
      kind TEXT,
      data TEXT
    );
  `);
}

// Peers
export function upsertPeer(pubkey, fields) {
  const cur = db.prepare('SELECT * FROM peers WHERE pubkey = ?').get(pubkey);
  const now = Math.floor(Date.now() / 1000);
  if (!cur) {
    db.prepare(`
      INSERT INTO peers (pubkey, nickname, self_nickname, fp_short, trust, last_seen, online, referred_by, nick_locked, last_multiaddr)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pubkey,
      fields.nickname ?? null,
      fields.self_nickname ?? null,
      fields.fp_short ?? pubkey.slice(0, 8),
      fields.trust ?? 'unknown',
      now,
      fields.online ? 1 : 0,
      fields.referred_by ?? null,
      fields.nick_locked ? 1 : 0,
      fields.last_multiaddr ?? null
    );
  } else {
    const allowed = ['nickname', 'self_nickname', 'fp_short', 'trust', 'online', 'nick_locked', 'referred_by', 'last_multiaddr'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]);
      }
    }
    sets.push('last_seen = ?');
    vals.push(now);
    vals.push(pubkey);
    db.prepare(`UPDATE peers SET ${sets.join(', ')} WHERE pubkey = ?`).run(...vals);
  }
}

export function listPeers() {
  return db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all();
}

export function getPeer(pubkey) {
  return db.prepare('SELECT * FROM peers WHERE pubkey = ?').get(pubkey);
}

export function getPeerByNickname(nickname) {
  return db.prepare('SELECT * FROM peers WHERE nickname = ? OR self_nickname = ? LIMIT 1').get(nickname, nickname);
}

// Resolve a trusted/seen peer by the short fingerprint carried in hello frames.
// Returns null if the fpShort matches zero or more than one peer (ambiguous — refuse to bind).
export function getPeerByFpShort(fpShort) {
  if (!fpShort || typeof fpShort !== 'string') return null;
  const rows = db.prepare('SELECT * FROM peers WHERE fp_short = ? LIMIT 2').all(fpShort);
  if (rows.length !== 1) return null;
  return rows[0];
}

export function setTrust(pubkey, level) {
  upsertPeer(pubkey, { trust: level });
}

// Messages
export function saveMessage({ pubkey, direction, ts, text, flagged = false }) {
  const r = db.prepare(`
    INSERT INTO messages (pubkey, direction, ts, text, flagged)
    VALUES (?, ?, ?, ?, ?)
  `).run(pubkey, direction, ts, text, flagged ? 1 : 0);
  return r.lastInsertRowid;
}

export function getHistory(pubkey, limit = 100) {
  return db.prepare(`
    SELECT * FROM messages WHERE pubkey = ? ORDER BY ts DESC LIMIT ?
  `).all(pubkey, limit).reverse();
}

export function searchMessages(query, limit = 50) {
  return db.prepare(`
    SELECT m.* FROM messages m
    JOIN messages_fts fts ON fts.rowid = m.id
    WHERE messages_fts MATCH ?
    ORDER BY m.ts DESC LIMIT ?
  `).all(query, limit);
}

export function audit(kind, data) {
  // Stamp ts_ms explicitly for millisecond precision. Legacy `ts` column
  // defaults to unix seconds via the table's DEFAULT — kept for v1.0 compat.
  db.prepare('INSERT INTO audit (kind, data, ts_ms) VALUES (?, ?, ?)').run(
    kind, JSON.stringify(data), Date.now(),
  );
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
