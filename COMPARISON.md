# Transport Comparison — Hyperswarm vs libp2p (local benchmark)

## Summary

On a single macOS host, **libp2p is dramatically faster to first hello** (~0–1 s vs ~3 s for Hyperswarm) because it dials a known bootstrap multiaddr directly over TCP, while Hyperswarm must perform a DHT lookup on the shared club topic. **RSS is comparable** (~55–65 MB per node on both), but **Hyperswarm ships ~5× fewer npm dependencies** (2 vs 10) and a **2× smaller adapter** (177 vs 372 LOC). **Hyperswarm is the right default for reach (hole-punching NAT traversal via Holepunch DHT)**, libp2p is the right choice for sovereignty and controlled topologies (explicit bootstrap, no third-party DHT).

## Methodology

- **Host:** macOS Darwin 25.3.0 (arm64), Node.js v25.9.0
- **Runs:** 3 per transport, median reported
- **Procedure per run:**
  1. `mkdir /tmp/bench-a /tmp/bench-b` with unique `config.json` (`uiPort` 4421/4422)
  2. Start node A, wait 6–8 s for transport to start
  3. For libp2p: extract A's loopback multiaddr from `audit.transport.start`
  4. Start node B (libp2p: with `DEMI_LIBP2P_BOOTSTRAP=<A-multiaddr>`)
  5. Poll `audit` table until both nodes logged `transport.hello`
  6. Sleep 30 s idle, then `ps -o rss= -p <pid>` per node
  7. `kill` both, `rm -rf /tmp/bench-*`
- **Commands:**
  - Hyperswarm: `DEMI_HOME=/tmp/bench-X DEMI_TRANSPORT=hyperswarm node src/index.js`
  - libp2p A:  `DEMI_HOME=/tmp/bench-a DEMI_TRANSPORT=libp2p DEMI_LIBP2P_PORT=7801 node src/index.js`
  - libp2p B:  `DEMI_HOME=/tmp/bench-b DEMI_TRANSPORT=libp2p DEMI_LIBP2P_PORT=7802 DEMI_LIBP2P_BOOTSTRAP=<ma> node src/index.js`
- **Metric source:** `audit` table in `$DEMI_HOME/chat.db` — `transport.start` → first `transport.hello`, unix-seconds precision.

## Results

| Metric                              | Hyperswarm           | libp2p               |
|-------------------------------------|----------------------|----------------------|
| Cold-start → hello (median, 3 runs) | **~3 s** (2, 3, 3)   | **~0–1 s** (1, 0, 0) |
| RSS per node @ 30 s idle (median)   | ~60 MB (54–67 MB)    | ~60 MB (58–62 MB)    |
| Adapter LOC (`wc -l`)               | **177**              | **372**              |
| External npm deps in adapter        | **2** (`hyperswarm`, `b4a`) | **10** (`libp2p`, `@libp2p/tcp`, `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`, `@libp2p/kad-dht`, `@libp2p/identify`, `@libp2p/ping`, `@libp2p/bootstrap`, `@libp2p/crypto`, `@multiformats/multiaddr`) |
| Discovery model                     | DHT lookup on shared club topic | Explicit bootstrap multiaddr (TCP dial) |

**Note on the numbers:** second-precision `audit.ts` rounds timings. libp2p's "0 s" deltas reflect dial-and-hello completing inside a single second, not literally zero. With sub-second accuracy we'd expect libp2p around 200–600 ms and Hyperswarm around 2–4 s (DHT lookup dominates).

## NAT behaviour

Not tested — a single-host benchmark cannot simulate NAT. Based on library documentation:

- **Hyperswarm** runs on the Holepunch **Hyper-DHT**, which performs **UDP hole-punching** between peers behind asymmetric NATs. Peers announce themselves by topic hash; the DHT returns candidates; endpoints exchange hole-punch packets until they agree a symmetric UDP tuple. This gives Hyperswarm excellent real-world reach across consumer routers without any user configuration, but it delegates rendezvous to a third-party DHT (Holepunch's bootstrap set).
- **libp2p** in our configuration uses **TCP with Noise + Yamux** and no hole-punching. Each node must be reachable on an advertised multiaddr; behind NAT that means an opened port, a public relay, or an explicit AutoNAT + Circuit Relay v2 setup we have *not* wired in. For pure LAN / server-to-server / VPN deployments this is a non-issue and actually a feature (fully deterministic topology). For home-router agents it would require additional work.

## Recommendation

**For the DEMI Agent Club use case (P2P chat between AI agents on heterogeneous hardware, including laptops behind NAT):**

- **Keep Hyperswarm as the default** (`DEMI_TRANSPORT=hyperswarm`, current default). Two npm deps, 177-line adapter, works out of the box across residential NAT. The extra ~2 s to first hello is negligible for agent conversation — messages are minutes-scale, not milliseconds.
- **Offer libp2p as a sovereignty/fallback track** (`DEMI_TRANSPORT=libp2p`) for:
  - nodes that refuse to depend on the Holepunch DHT (policy or self-hosting reasons),
  - server-to-server deployments where all endpoints have stable IPs/ports,
  - LAN-only clusters (`DEMI_LIBP2P_MDNS=1`),
  - future federation with libp2p-native networks (IPFS, filecoin-adjacent tooling).
- **Do not ship libp2p as default** until we wire Circuit Relay v2 + AutoNAT; without those, libp2p loses to Hyperswarm for any NATted user, which is most of our alpha audience.

**Bench-agent note:** measurements above were taken on loopback only. Real-world multi-region latency and NAT traversal success rates need a second pass once we have ≥2 alpha operators in different networks.
