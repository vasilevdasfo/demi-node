// src/transport/index.js — factory that picks transport by DEMI_TRANSPORT env
//
// Supported values:
//   hyperswarm (default) — battle-tested, NAT-traversal via Holepunch DHT
//   libp2p                — fallback / sovereignty track (Gemini-reviewed, see docs)
//
// Transport contract (both adapters implement):
//   constructor({ identity, nickname, lang, clubTopic, onMessage })
//   async start()
//   async stop()
//   async joinPeer(peerPubHex)
//   async rejoinAllKnown()
//   onPairAck(fn) → unsubscribe
//   onConnect(fn) → unsubscribe
//   broadcast(frame)
//   async send(peerPubHex, encodedBytes) → boolean
//   attachSocket(pubHex, socket)
//
// onMessage callback receives: { kind: 'hello'|'chat', from|pubkey, frame }

import { audit } from '../db.js';

export async function createTransport(opts) {
  const kind = (process.env.DEMI_TRANSPORT || 'hyperswarm').toLowerCase();
  audit('transport.factory', { kind });

  if (kind === 'libp2p') {
    const { Transport } = await import('./libp2p.js');
    return new Transport(opts);
  }

  if (kind === 'hyperswarm') {
    const { Transport } = await import('./hyperswarm.js');
    return new Transport(opts);
  }

  throw new Error(
    `Unknown DEMI_TRANSPORT="${kind}". Valid: hyperswarm (default), libp2p.`
  );
}

// Legacy alias — keep as named export so callers doing
//   import { Transport } from './transport.js'
// after the facade redirect still resolve to Hyperswarm by default.
export { Transport } from './hyperswarm.js';
