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
      INSERT INTO peers (pubkey, nickname, self_nickname, fp_short, trust, last_seen, online, referred_by, nick_locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pubkey,
      fields.nickname ?? null,
      fields.self_nickname ?? null,
      fields.fp_short ?? pubkey.slice(0, 8),
      fields.trust ?? 'unknown',
      now,
      fields.online ? 1 : 0,
      fields.referred_by ?? null,
      fields.nick_locked ? 1 : 0
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

// searchMessages — FTS5 search with optional peer + date-range filter.
// Backward-compat: if second arg is a number, treat it as legacy `limit`.
// New form: searchMessages(query, { limit, peer, range: '1h'|'24h'|'7d'|'all' })
// Returns rows joined with peer nickname and a short FTS snippet.
export function searchMessages(query, opts = 50) {
  if (typeof opts === 'number') opts = { limit: opts };
  const limit = Math.max(1, Math.min(opts.limit || 50, 500));
  const peer = opts.peer || null;
  const range = opts.range || 'all';

  // FTS5 is strict about unbalanced quotes — fall back to a prefix-safe form.
  let ftsQuery = String(query).trim();
  if (!ftsQuery) return [];
  // If user didn't supply FTS operators, split tokens and OR them with prefix match.
  if (!/["^*:()]/.test(ftsQuery)) {
    ftsQuery = ftsQuery
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, '') + '*')
      .filter((t) => t.length > 1)
      .join(' OR ');
  }
  if (!ftsQuery) return [];

  const where = ['messages_fts MATCH ?'];
  const params = [ftsQuery];

  if (peer) { where.push('m.pubkey = ?'); params.push(peer); }

  if (range !== 'all') {
    const now = Date.now();
    const windowMs =
      range === '1h'  ? 3_600_000 :
      range === '24h' ? 86_400_000 :
      range === '7d'  ? 7 * 86_400_000 : 0;
    if (windowMs > 0) {
      const sinceIso = new Date(now - windowMs).toISOString();
      where.push('m.ts >= ?');
      params.push(sinceIso);
    }
  }

  const sql = `
    SELECT m.id, m.pubkey, m.direction, m.ts, m.text, m.flagged,
           p.nickname AS nickname, p.self_nickname AS self_nickname, p.fp_short AS fp_short,
           snippet(messages_fts, 0, '[[', ']]', '…', 12) AS snippet
    FROM messages m
    JOIN messages_fts fts ON fts.rowid = m.id
    LEFT JOIN peers p ON p.pubkey = m.pubkey
    WHERE ${where.join(' AND ')}
    ORDER BY m.ts DESC LIMIT ?
  `;
  params.push(limit);

  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    // Broken FTS query — surface empty rather than throwing so UI stays responsive.
    return [];
  }
}

// Aggregated peer profile: peers row + send/recv counts + recent pair.* audit events.
// Used by Observer UI "Profile" panel. Returns null for unknown pubkey.
export function getPeerProfile(pubkey) {
  if (!pubkey || typeof pubkey !== 'string') return null;
  const peer = db.prepare('SELECT * FROM peers WHERE pubkey = ?').get(pubkey);
  if (!peer) return null;

  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN direction = 'in'  THEN 1 ELSE 0 END) AS received,
      MIN(ts) AS first_msg_ts, MAX(ts) AS last_msg_ts
    FROM messages WHERE pubkey = ?
  `).get(pubkey) || {};

  // Pull pair audit events that mention this peer. We store `data` as JSON text;
  // a LIKE on the pubkey substring is cheap (no index) but handful for alpha.
  let pairEvents = [];
  try {
    const rows = db.prepare(`
      SELECT id, ts, ts_ms, kind, data FROM audit
      WHERE kind LIKE 'pair.%'
        AND (data LIKE ? OR data LIKE ?)
      ORDER BY COALESCE(ts_ms, ts * 1000) DESC
      LIMIT 20
    `).all('%' + pubkey + '%', '%' + (peer.fp_short || '__none__') + '%');
    pairEvents = rows.map((r) => {
      let parsed = null;
      try { parsed = JSON.parse(r.data); } catch {}
      return {
        id: r.id,
        kind: r.kind,
        ts_ms: r.ts_ms || (r.ts ? r.ts * 1000 : null),
        data: parsed,
      };
    });
  } catch {}

  return {
    peer,
    counts: {
      sent: counts.sent || 0,
      received: counts.received || 0,
      first_msg_ts: counts.first_msg_ts || null,
      last_msg_ts: counts.last_msg_ts || null,
    },
    pairEvents,
  };
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
