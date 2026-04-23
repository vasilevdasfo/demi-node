# Changelog

All notable changes to `demi-node` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Pluggable transport layer** (`DEMI_TRANSPORT` env).
  Two adapters share one core (wire format, pair flow, chat, audit, agent-dashboard):
  - `DEMI_TRANSPORT=hyperswarm` (default) — battle-tested NAT-traversal via Holepunch DHT.
  - `DEMI_TRANSPORT=libp2p` — sovereignty track, mitigation for Risk #1 in the project
    register ("Holepunch can change policy"). **Этап B v0.1 shipped** — see below.
  - Factory: `src/transport/index.js` → `createTransport(opts)`.
  - Contract: `start / stop / joinPeer / rejoinAllKnown / onPairAck / onConnect /
    broadcast / send / attachSocket` + `onMessage({ kind, ... })`.
  - Migration: importing `{ Transport } from './transport.js'` still works
    (facade re-exports from `./transport/hyperswarm.js`).
- **libp2p adapter — Этап B v0.1** (`src/transport/libp2p.js`, ~260 LOC).
  - TCP + Noise + Yamux, kad-DHT `clientMode:true` on `/demi-net/kad/1.0.0`, identify, ping.
  - Custom wire protocol `/demi/wire/1.0.0` (one long-lived stream per peer,
    reuses `wire.js` newline-delimited JSON framing — no double encoding).
  - Ed25519 PeerId derived from our existing PKCS8 DER seed
    (`privateKeyFromRaw(seed ‖ pubkey)`), so libp2p PeerId and our ed25519
    identity are the **same key**.
  - Bootstrap dial is **explicit** (loops over `DEMI_LIBP2P_BOOTSTRAP` and dials
    each multiaddr + opens wire stream) — avoids races between symmetric
    `peer:connect` events.
  - Signed `hello-auth` envelope with session bound to **our own** `peerId`
    (recipient verifies `payload.session === connection.remotePeer`).
  - Configurable via env: `DEMI_LIBP2P_PORT` (default 0 = random),
    `DEMI_LIBP2P_BOOTSTRAP` (comma-separated multiaddrs),
    `DEMI_LIBP2P_MDNS=1` (opt-in).
  - **Out of scope for v0.1:** pairing via libp2p (still needs Hyperswarm pair
    code). Pure libp2p pair flow over rendezvous/pubsub is Этап B v0.2.
  - 2-node e2e smoke verified: `peer:connect` → wire stream → hello exchange →
    signed envelope `verified:true sessionOk:true freshOk:true`. Unpaired nodes
    correctly reject rebind with `hasPeer:false` (fail-closed as designed).
- **Agent-dashboard q/a/proposal/vote UI** in Observer UI.
  Derives full state from chat history (no backend change): active claims, open
  questions (click-to-answer), proposals (yes/no/abstain vote, cost/impact/risk,
  `escalate_dmitry` red tag), event timeline. Auto-refresh every 8s.
  Extends `AGENT_KINDS` to 10 types: `claim, release, status, heartbeat, handoff,
  conflict, question, answer, proposal, vote`.

- **Agent frame schema v1.1** (`src/wire.js`).
  - `AGENT_KINDS` canonicalises `question | answer | proposal | vote` (previously
    only referenced from the client renderer).
  - New optional cross-ref fields, fully backward-compatible:
    - `vote.related_review` — sha of a review this vote references.
    - `review.implies_vote` — `'yes' | 'no' | 'abstain'`, auto-count this review
      as a vote on its referenced proposal (review outranks vote when both exist).
    - `review.parent_review_sha` — sha of prior review in a chain
      (ack, rebuttal, re-review).
  - Frames without these fields parse identically to v1.0.

### Security

- **BREAKING: libp2p pair flow migrated from GossipSub rendezvous to direct-dial**
  `/demi/pair-req/1.0.0` (v0.2.1). The GossipSub scaffold (commit `3314946`)
  was withdrawn after Gemini 3 Flash adversarial review returned a class-break
  (severity 5): a passive subscriber of `demi-pair/v1/<sha256(code)>` sniffs
  the pair-code out of a signed envelope, publishes its own envelope under a
  different ed25519 key, and gets auto-promoted to `trust:'trusted'` on the
  creator's side. Signed envelope only proves key-ownership, not secret-knowledge;
  pairing-over-public-pubsub has no PAKE properties.
  New flow: creator never broadcasts. The pair token
  `demi-pair1:<base64url({c, p, a, h, t})>` (code + peerId + multiaddrs + creator pubHex + ts)
  is transmitted out-of-band. Redeemer decodes and direct-dials the creator.
  Security gates: token 5-min TTL, single-use code (creator marks `usedAt`),
  rate-limit ≤3 pair-req per remote peerId per minute (fail-closed),
  recipient-binding `envelope.payload.recipient === creator.pubHex`,
  2 KB pre-parse frame cap, 10s stream-read + 15s dial timeouts.
  Full post-mortem + v0.2.1 threat model in `docs/ETAPE_B_v0.2_pairing-design.md`.
  Removed dep: `@libp2p/gossipsub`.
- **Gemini adversarial review of libp2p prototype** (pre-refactor gate, severity 5).
  Three issues to mitigate in the libp2p adapter (documented in `src/transport/libp2p.js`):
  1. DHT Sybil/Eclipse on custom protocol id → `clientMode:true` + trusted bootstrap.
  2. Unbounded `lp.decode` → pass `{ maxDataLength: MAX_MSG_BYTES }` to decoder.
  3. mDNS poisoning on hostile LAN → disable by default, opt-in via env or pnet PSK.
- **Mandatory pre-push Gemini review** for security-sensitive commits
  (crypto primitives, auth, wire protocol, P2P transport, public releases).
  Precedent: the `fp_short` rebind path shipped without review and required a
  same-day hotfix (signed `hello-auth` envelope with session binding + 60s freshness).

### Fixed

- **Agent-dashboard options renderer** now accepts both shapes:
  `{options: ["A: ...", "B: ..."]}` (string array) and
  `{options: [{id:"A", text:"..."}, ...]}` (structured). Previously rendered
  `undefined. undefined` for string-array proposals.
- **`.agents-panel` grid collapse** — `max-height` on a grid-row track resolved
  to `1px`; changed to explicit `height: 220px` with `overflow:auto`.

### Compatibility

**Agent frame schema — backward-compat matrix (v1.0 ↔ v1.1).**

Schema v1.1 is a pure-addition revision: every new field is optional, every
old field keeps its meaning, wire format (NDJSON over libp2p/hyperswarm)
is unchanged. The sentinel `__schema_too_new` only fires for `v >= 2.x`.

| Capability                                      | v1.0 → v1.0 | v1.0 reads v1.1 | v1.1 reads v1.0 | v1.1 → v1.1 |
|-------------------------------------------------|:-----------:|:---------------:|:---------------:|:-----------:|
| Parse 6 core agent kinds (`claim`, `release`, `status`, `heartbeat`, `handoff`, `conflict`) | ✅ | ✅ (extra fields ignored per JSON-extensibility) | ✅ | ✅ |
| Parse `question` / `answer` / `proposal` / `vote` | ❌ (unknown `type`, frame dropped) | ❌ (v1.0 `AGENT_KINDS` lacks them) | ✅ | ✅ |
| Honor `vote.related_review` cross-ref           | —           | — (field ignored) | ✅ (stored, rendered) | ✅ |
| Honor `review.implies_vote` (review outranks vote) | —       | — (field ignored) | ✅ | ✅ |
| Honor `review.parent_review_sha` (review chains) | —          | — (field ignored) | ✅ | ✅ |
| `__schema_too_new` sentinel for `v >= 2.x`      | —           | ✅ (drop + audit, no crash) | — | ✅ (drop + audit, no crash) |
| `ts_ms` millisecond audit stamp                 | —           | — (column absent in v1.0 db) | ✅ (both `ts` and `ts_ms` written) | ✅ |

**Notes.**

- **JSON-extensibility guarantee.** Any v1.0 reader silently ignores unknown
  keys on known `AGENT_KINDS` entries (question/answer/proposal/vote are NOT
  in v1.0's set, so those frames drop as unknown-type — not as a parse error
  or wire corruption). No protocol-level coercion.
- **Asymmetry is by design.** v1.0 readers cannot *act* on v1.1 semantics
  (cross-refs, implies-vote), but they also never mis-interpret them. A v1.1
  writer targeting a mixed mesh should expect some peers to skip the new
  frame types entirely — proposals/votes do not fan out to v1.0 nodes.
- **No schema-v2 yet.** The `schemaNewer()` gate (`src/wire.js`) compares
  dotted-version parts numerically. A hypothetical v2.0 frame at either peer
  is dropped via `__schema_too_new` sentinel with type + claimed version,
  and written to the audit log — never parsed speculatively.
- **Database side.** `ts_ms` column is added idempotently in `openDb()`; a
  v1.0 binary reading a v1.1-stamped database simply ignores the column.
  `last_multiaddr` follows the same rule (v1.0 readers don't use it).

## [0.1.0-alpha.1] — 2026-04-22

### Added

- MVP: Hyperswarm transport, ed25519 identity, pair-code flow with signed
  envelopes, end-to-end chat, SQLite audit + FTS5, Observer UI (RU/EN),
  CLI, dead-man switch, panic wipe.
- Rebind-auth (signed `hello-auth` with session pubkey binding) — fail-closed
  fallback when a trusted peer reconnects under a new Hyperswarm session.

---

### Upgrade notes (Unreleased → 0.1.x)

- **No behavioural changes on default settings.** Nodes started without
  `DEMI_TRANSPORT` pick `hyperswarm` and behave identically to 0.1.0-alpha.1.
- **Environment variables added:**
  - `DEMI_TRANSPORT` — `hyperswarm` (default) | `libp2p`.
  - `DEMI_LIBP2P_PORT` — listen port for libp2p TCP (default `0` = random).
  - `DEMI_LIBP2P_BOOTSTRAP` — comma-separated multiaddrs to dial on start.
  - `DEMI_LIBP2P_MDNS` — `1` to opt into mDNS LAN discovery (default off, hostile-LAN safe).
- **Database migrations** (both idempotent, run in `openDb()`, safe on
  existing 0.1.0-alpha.1 databases):
  - `ALTER TABLE peers ADD COLUMN last_multiaddr TEXT` — libp2p stores
    remote multiaddr for reconnect.
  - `ALTER TABLE audit ADD COLUMN ts_ms INTEGER` — millisecond-precision
    timestamps for benchmarks + timing-attack detection. Legacy `ts`
    (unix seconds) preserved for v1.0 readers; new rows stamp both.
- **Audit stream adds one new kind:** `transport.factory` with
  `{kind: "hyperswarm" | "libp2p"}` emitted at startup.
