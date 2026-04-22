// src/transport/libp2p.js — libp2p 3.x adapter (STUB, Этап B)
//
// Contract must match src/transport/hyperswarm.js.
//
// Gemini adversarial review (2026-04-22) severity 5, three issues to
// mitigate in THIS adapter (not in core):
//   1. DHT Sybil/Eclipse on custom protocol id →
//      clientMode:true on leaf nodes + restrict routing table to trusted bootstrap.
//   2. Memory exhaustion via unbounded lp.decode →
//      pass { maxDataLength: MAX_MSG_BYTES } to decoder.
//   3. mDNS poisoning on hostile LAN →
//      disable mdns by default, opt-in via DEMI_LIBP2P_MDNS=1, or require pnet PSK.
//
// Reference prototype: ../../demi-node-libp2p/src/{node,transport,protocol}.js
// Wire format is shared (../wire.js) — no changes needed there.

import { audit } from '../db.js';

export class Transport {
  constructor(opts) {
    this.opts = opts;
    throw new Error(
      'libp2p transport not yet wired. Этап B — см. COMPARISON.md + ' +
      'demi-node-libp2p/. Use DEMI_TRANSPORT=hyperswarm (default) until then.'
    );
  }

  async start() { throw new Error('stub'); }
  async stop() { throw new Error('stub'); }
  async joinPeer() { throw new Error('stub'); }
  async rejoinAllKnown() { throw new Error('stub'); }
  onPairAck() { return () => {}; }
  onConnect() { return () => {}; }
  broadcast() {}
  async send() { return false; }
  attachSocket() {}
}

// Export stub for tree-shakers / importers that probe for the class
audit('transport.libp2p.stub-loaded', {});
