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
    register ("Holepunch can change policy"). **Stub in this release** — wire-up is Этап B.
  - Factory: `src/transport/index.js` → `createTransport(opts)`.
  - Contract: `start / stop / joinPeer / rejoinAllKnown / onPairAck / onConnect /
    broadcast / send / attachSocket` + `onMessage({ kind, ... })`.
  - Migration: importing `{ Transport } from './transport.js'` still works
    (facade re-exports from `./transport/hyperswarm.js`).
- **Agent-dashboard q/a/proposal/vote UI** in Observer UI.
  Derives full state from chat history (no backend change): active claims, open
  questions (click-to-answer), proposals (yes/no/abstain vote, cost/impact/risk,
  `escalate_dmitry` red tag), event timeline. Auto-refresh every 8s.
  Extends `AGENT_KINDS` to 10 types: `claim, release, status, heartbeat, handoff,
  conflict, question, answer, proposal, vote`.

### Security

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
  - `DEMI_TRANSPORT` — `hyperswarm` (default) | `libp2p` (stub, NYI).
  - `DEMI_LIBP2P_MDNS` — `1` to opt into mDNS LAN discovery (default off, hostile-LAN safe).
- **Audit stream adds one new kind:** `transport.factory` with
  `{kind: "hyperswarm" | "libp2p"}` emitted at startup.
