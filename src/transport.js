// src/transport.js — Hyperswarm wrapper + peer socket management
import Hyperswarm from 'hyperswarm';
import crypto from 'node:crypto';
import b4a from 'b4a';
import { makeParser, encode, helloFrame } from './wire.js';
import { upsertPeer, getPeer, audit } from './db.js';
import { sortedPairTopic } from './pair.js';

export class Transport {
  constructor({ identity, nickname, lang = 'en', clubTopic = 'demi-club/v1', onMessage }) {
    this.identity = identity;
    this.nickname = nickname;
    this.lang = lang;
    this.clubTopic = clubTopic;
    this.onMessage = onMessage || (() => {});
    this.swarm = new Hyperswarm();
    // pubkey-hex → socket
    this.sockets = new Map();
    // Pluggable handlers for pair.js and others
    this.pairAckHandlers = new Set();
    this.connectHooks = new Set();
    this.swarm.on('connection', (socket, info) => this._onConnection(socket, info));
  }

  async start() {
    // Join club topic (gossip / presence)
    const clubT = crypto.createHash('sha256').update(this.clubTopic).digest();
    this.swarm.join(clubT, { server: true, client: true });
    audit('transport.start', { club: this.clubTopic });
  }

  async joinPeer(peerPubHex) {
    const topic = sortedPairTopic(this.identity.pubHex, peerPubHex);
    this.swarm.join(topic, { server: true, client: true });
  }

  async rejoinAllKnown() {
    // Re-join permanent sorted-pair topics for all trusted peers
    const { listPeers } = await import('./db.js');
    const peers = listPeers().filter((p) => p.trust === 'trusted' || p.trust === 'seen');
    for (const p of peers) {
      if (p.pubkey === this.identity.pubHex) continue;
      await this.joinPeer(p.pubkey);
    }
  }

  /** Register a handler that is invoked for every incoming pair-ack frame. */
  onPairAck(fn) {
    this.pairAckHandlers.add(fn);
    return () => this.pairAckHandlers.delete(fn);
  }

  /** Register a handler that is invoked for every new socket connection. */
  onConnect(fn) {
    this.connectHooks.add(fn);
    return () => this.connectHooks.delete(fn);
  }

  /** Broadcast an encoded frame to every currently-open socket. */
  broadcast(frame) {
    const payload = encode(frame);
    for (const s of this.sockets.values()) {
      try { s.write(payload); } catch {}
    }
  }

  _onConnection(socket, info) {
    const peerPubRaw = info.publicKey; // hyperswarm's own pubkey, not our identity pubkey
    socket.setKeepAlive?.(true, 15_000);

    // Socket-local state (shared with parser closure via property)
    socket._remotePubHex = null;

    const parser = makeParser((msg) => {
      if (msg.type === 'hello') {
        audit('transport.hello', { nick: msg.nick, fp: msg.fpShort });
        this.onMessage({ kind: 'hello', from: socket._remotePubHex, frame: msg });
      } else if (msg.type === 'chat' && socket._remotePubHex) {
        this.onMessage({ kind: 'chat', pubkey: socket._remotePubHex, frame: msg });
      } else if (msg.type === 'pair-ack') {
        for (const fn of this.pairAckHandlers) {
          try { fn(socket, msg); } catch {}
        }
      }
    });

    socket.on('data', parser);
    socket.on('error', () => {});
    socket.on('close', () => {
      const pk = socket._remotePubHex;
      if (pk) {
        this.sockets.delete(pk);
        upsertPeer(pk, { online: false });
      }
      const hyperHex = b4a.toString(peerPubRaw, 'hex');
      this.sockets.delete(hyperHex);
    });

    // Send our hello immediately
    const hello = helloFrame({
      nickname: this.nickname,
      agent: 'DEMI',
      role: 'operator',
      caps: ['chat', 'rooms', 'pair'],
      lang: this.lang,
      version: '0.1.0-alpha.1',
      fpShort: this.identity.fpShort,
    });
    socket.write(encode(hello));

    // Index under hyperswarm pubkey until pair.js rebinds under identity pubHex
    const hyperHex = b4a.toString(peerPubRaw, 'hex');
    this.sockets.set(hyperHex, socket);

    // Notify pair.js (and anyone else) about the new socket so they can push frames on it
    for (const fn of this.connectHooks) {
      try { fn(socket, info); } catch {}
    }
  }

  /** Rebind an open socket under the peer's identity pubkey (used after pair-ack verify). */
  attachSocket(pubHex, socket) {
    socket._remotePubHex = pubHex;
    this.sockets.set(pubHex, socket);
  }

  async send(peerPubHex, data) {
    const socket = this.sockets.get(peerPubHex);
    if (!socket) return false;
    try {
      socket.write(data);
      return true;
    } catch {
      return false;
    }
  }

  async stop() {
    for (const s of this.sockets.values()) {
      try { s.destroy(); } catch {}
    }
    await this.swarm.destroy();
    audit('transport.stop', {});
  }
}
