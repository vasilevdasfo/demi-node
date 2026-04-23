# Этап B v0.2 — Pairing через libp2p (design)

**Status:** draft, awaiting Alpha's signed review
**Scope:** полный pair flow без зависимости от Hyperswarm

## Текущая проблема

`src/pair.js` использует `transport.swarm.join(topic)` — Hyperswarm-specific DHT topic rendezvous. На libp2p-транспорте это не работает. В Этапе B v0.1 мы явно оставили pair flow на Hyperswarm: libp2p-нода может пейриться только если у неё параллельно крутится Hyperswarm-режим (что ломает «чистую» сувереннию).

## Требования к v0.2

1. **Bootstrap-less for creator.** Создатель пары вводит 6-digit код и ждёт. Он не должен знать multiaddr получателя.
2. **Low-latency (<10s) when both online.** Код живёт 5 минут, пейринг должен пройти заметно быстрее.
3. **Privacy.** Не раскрывать pair code в plaintext на публичной сети.
4. **Signed envelope preserved.** Текущая схема `signEnvelope(id,'pair',{code,...})` + verify должна остаться — v0.2 меняет только transport.

## Варианты rendezvous

| Подход | Плюсы | Минусы |
|--------|-------|--------|
| **Kad-DHT PUT/GET** | Нет центральных серверов. Уже в services. | DHT v клубе-клиент-моде только читает, не пишет. Нужно включить server mode — риск Sybil (Gemini #1). |
| **GossipSub pubsub** | Масштабируется, low-latency, anti-sybil через scoring | Нужна predefined mesh — требует bootstrap-пиров. |
| **@libp2p/rendezvous** | Протокол-специфичный для этого use-case | Нужен dedicated rendezvous-сервер (либо внутри ноды) → централизация. |
| **Bootstrap-as-rendezvous** | Простейшее: bootstrap-нода хранит pair-запросы в памяти | Требует доверенную bootstrap-ноду. ОК для начала. |

## Рекомендованный путь

**Комбинация:** GossipSub поверх bootstrap-mesh + опциональный DHT fallback.

- Оба участника дополнительно к bootstrap-connection подписываются на топик `demi-pair/v1:{sha256(code)}`.
- Creator публикует свой signed `pair-ack` (frame как сейчас) — redeemer видит через gossip → верифицирует → шлёт свой ack в ответ.
- После mutual verify → оба сохраняют multiaddr друг друга в `peers.last_multiaddr` → отписываются от временного топика → подписываются на permanent `sortedPairTopic(pkA,pkB)` для будущих reconnect-notify.

**Privacy:** код пейринга хэшируется (`sha256('demi-pair/v1:' + code)`) — topic-name не раскрывает ни code, ни pubkey участников.

**Requires:** `@libp2p/gossipsub`, services.pubsub wiring, bootstrap mesh (≥1 bootstrap node). Для fresh-node deploys нужен seed bootstrap multiaddr.

## Implementation plan (2-3 часа)

1. Добавить `@libp2p/gossipsub` зависимость.
2. `src/transport/libp2p.js`:
   - `services.pubsub = gossipsub({ allowPublishToZeroTopicPeers: true })`
   - `subscribePair(topic)` / `publishPair(topic, frame)` методы на адаптере.
3. `src/pair.js` refactor:
   - Вынести swarm-specific код в `hyperswarm-pair.js`.
   - Новый `libp2p-pair.js` — тот же state-machine, но через `transport.subscribePair/publishPair` вместо `swarm.join`.
   - Диспетчер в `pair.js` выбирает имплементацию по `transport.kind`.
4. Миграция `peer.last_multiaddr` после успешного pair — уже есть в v0.1.

## Security гейты перед merge

Утверждённые Альфой (письмо 22:00 PT, секция q-05 vote):

1. **Throttling на `publishPair`** — 1 publish per (code, sender) per 10s,
   sender-side enforcement. Предотвращает DoS на verifier: атакующий не
   может заставить receiver палить CPU на проверку подписей.
2. **Receiver-side fresh check** — GossipSub может delayed-deliver через
   mesh; signed payload `ts` проверяется receiver-ом строго ≤60s от `now`,
   fail-closed. Дополняет sender-side ts stamp.
3. **NAT warning в README/CHANGELOG** — прямой libp2p pair за строгими
   NAT может не работать без DCUtR (out-of-scope v0.2). Hyperswarm fallback
   остаётся правильным UX по умолчанию — явно описать в docs.

Остальное:

- Gemini adversarial review на sha коммита (scope: `src/pair-libp2p.js`
  + изменения `src/transport/libp2p.js` + `pair.js` dispatcher). Фокус:
  gossipsub flooding, topic collision (sha256 + 6-digit code = 900K вариантов
  → брутфорс теоретически возможен, но invariant «code живёт 5 минут»
  ограничивает окно; mitigation v0.3: 8-digit code), replay через повторное
  gossipsub-delivery.
- Signed envelope уже закрывает replay (binds to code + ts).

## Out of scope для v0.2

- NAT-traversal на libp2p (для этого нужен DCUtR / hole-punching в отдельной итерации).
- Автоматическое переключение транспорта (hyperswarm fallback if libp2p fails) — сначала делаем pair, потом композицию.
- DHT server mode — оставляем clientMode:true пока не пройдёт security-review.

## Взаимодействие с Этапом B v0.1

v0.1 осталась нетронутой: chat, status frames, review — всё работает. v0.2 добавляет pair flow, делая libp2p самодостаточным транспортом (можно запускать ноду без Hyperswarm-деп вообще).

Следующий шаг: ждать signed review от Альфы на этот doc → если approve → реализация → e2e smoke между двумя чистыми libp2p-нодами без Hyperswarm.

---

## Post-mortem: Why NOT GossipSub (commit 3314946 → withdrawn)

Первая попытка реализации v0.2 (commit `3314946`) использовала GossipSub как rendezvous — topic `demi-pair/v1/<sha256(code)>`, оба участника subscribe + signed envelope с `ts`. Gemini 3 Flash adversarial review вернул **BLOCK severity 5/5 — class break**.

**Атака (F1, critical):** sniff-and-inject.

1. Атакующий Eve subscribe-ится на `demi-pair/v1/*` (или вычисляет хэш по известным candidate-кодам — всего 900K вариантов).
2. Creator Alice публикует свой signed envelope с `code` в plaintext внутри payload.
3. Eve видит envelope, извлекает `code`, публикует СВОЙ envelope (signed HER key) с тем же `code`.
4. Alice получает envelope от Eve, проверяет подпись → валидна (Eve владеет своим ed25519). Проверяет `code` → совпадает. `upsertPeer(trust:'trusted')`.
5. Pairing hijacked — Alice теперь доверяет Eve вместо Bob.

**Суть class-break:** signed envelope доказывает *владение ключом*, а не *знание секрета до broadcast'а*. GossipSub — public broadcast. Any-one-of-N-subscribers видит код раньше легитимного redeemer'а. **PAKE-свойств нет.**

Sev 4 issues (не закрыли проблему, но копились сверху):

- **F2:** 6-digit code = ~19.93 bits энтропии → rainbow table 40 MB по всем `sha256('demi-pair/v1:' + N)` для `N ∈ [100000, 999999]`. Topic hash перестаёт быть privacy-барьером.
- **F3:** CPU DoS — verifyEnvelope ~50μs, attacker публикует 20k invalid envelopes/sec → verifier 100% CPU.
- **F4:** throttle Map memory leak без TTL.
- **F5:** operational rainbow: DHT observer строит topic↔code map (то же что F2 с другой стороны).

Три security gate Дельты из vault letter 22:00 PT **НЕ закрывали class-break:**

1. Sender-side throttle 1/(topic,self)/10s — ограничивал только ЛЕГИТИМНЫЙ publish. Eve publish-ит под своим peerId — свой throttle-bucket.
2. Receiver-side fresh check ≤60s — Eve публикует в пределах fresh window, это окно 60s и есть время атаки.
3. NAT warning — UX, не security.

**Вывод:** исправить pair-flow-over-pubsub inline нельзя. Нужна либо полноценная PAKE-примитивность (SPAKE2/J-PAKE) с оффлайн-хэндшейком, либо — **убрать public broadcast из flow**. Выбран второй путь.

---

## v0.2.1 architecture — Peer-bootstrap direct-dial

Creator публикует **ничего**. Rendezvous выполняется out-of-band: creator даёт redeemer'у весь необходимый для прямого dial'а bundle — `token` — через trusted канал (Telegram DM, email, QR-код, signal). Redeemer dial-ит creator'а и предъявляет signed envelope.

### Token format

```
demi-pair1:<base64url(JSON)>
```

JSON (short keys для компактности при копипасте):

```json
{
  "c": "855-111",
  "p": "12D3KooW...",
  "a": ["/ip4/192.0.2.1/tcp/4601", "/ip6/2001:db8::1/tcp/4601"],
  "h": "<creator.identity.pubHex>",
  "t": 1714000000000
}
```

- `c` — 6-digit code (UX + дополнительный handshake-binding)
- `p` — libp2p peerId creator'а (для dial + binding)
- `a` — массив multiaddr без `/p2p/<peerId>` суффикса (redeemer добавит сам)
- `h` — creator's identity pubHex (64 hex chars) — redeemer ставит в envelope `recipient:h`, creator проверяет `recipient === identity.pubHex`. Это binds envelope к конкретной identity.
- `t` — `Date.now()` при генерации (fresh check)

TTL токена = 5 минут (`FRESH_WINDOW_MS`).

### Wire protocol

Новый libp2p protocol `/demi/pair-req/1.0.0`. На creator'е — `node.handle()`. Redeemer открывает stream, пишет NDJSON frame, читает ответный NDJSON frame, закрывает.

Request frame:
```json
{
  "type": "pair-req",
  "pubHex": "<redeemer.identity.pubHex>",
  "nickname": "<redeemer nick>",
  "envelope": signEnvelope(redeemerId, 'pair-req', {
    "code": "855-111",
    "role": "redeemer",
    "ts": 1714000001234,
    "recipient": "<creator.identity.pubHex from token.h>"
  })
}
```

Response frame (при успехе):
```json
{
  "type": "pair-ack",
  "pubHex": "<creator.identity.pubHex>",
  "nickname": "<creator nick>",
  "envelope": signEnvelope(creatorId, 'pair-ack', {
    "code": "855-111",
    "role": "creator",
    "ts": 1714000001300,
    "recipient": "<redeemer.identity.pubHex from request>"
  })
}
```

### Security gates v0.2.1

| Gate | Где | Закрывает |
|------|-----|-----------|
| **No public broadcast** | creator registers `handle()`, не publish-ит ничего | F1 sniff-and-inject (нет public topic) |
| **Token OOB only** | token живёт только в secure messenger / email / QR | F2 rainbow на `sha256(code)` — код не выходит в DHT |
| **Single-use code** | `usedAt` flag на creator'е; first valid redeemer wins | Повторное использование ukradenного token'а |
| **Rate-limit per remote peerId** | ≤3 pair-req/min per `connection.remotePeer`, fail-closed | F3 CPU DoS через подачу invalid envelopes |
| **Fresh window 5 min** | `Math.abs(now - payload.ts) < 300_000` | Replay token через долгое время |
| **Recipient binding** | `envelope.payload.recipient === identity.pubHex` | F1 residual: captured envelope не проигрывается на другого creator'а |
| **Frame size ≤2 KB** | pre-parse check в handler + dialPair | F3 preliminary DoS (дорогая JSON-decode больших payload'ов) |
| **Stream timeouts** | 10s read, 15s dial | Slow-loris / stalled attacker |

### Threat model v0.2.1

**Покрыто:**
- Passive sniffer DHT/pubsub — ничего не видит (нет publish).
- Public topic hijack (F1 class break) — устранён (нет topic).
- Rainbow table на code hash (F2/F5) — устранено (code не на wire).
- CPU DoS через sig-flood (F3) — rate-limit fail-closed.
- Replay captured envelope — fresh window + recipient binding.
- MITM на libp2p dial — creator envelope bound to creator peerId через token.pubHex проверку `resp.pubHex === creatorPubHex`.

**НЕ покрыто (operator responsibility / ограничения OOB):**

**`TRADE_OOB_OPSEC` — accepted trade-off, не defense gap.**

Token NOT bound к redeemer's PeerId. Creator НЕ знает идентичность redeemer'а до момента первого dial. Consequence: кто ПЕРВЫМ приносит valid envelope с matching code — получает trust. Это означает:

- **Sniffer-on-OOB wins:** если Eve перехватила token в OOB канале (secure messenger compromised, screenshot leaked, QR сфоткан), dial-ит первой → получает trust. Creator подпишет pair-ack на eve.pubHex. Audit trail показывает paired peer pubHex — operator может визуально detect мисмэтч в UI («я ожидал Боба, а спаррил какого-то Eve-X»).
- **Analogy:** equivalent safety tier с Signal safety number, WhatsApp invite link, sheva-node code `XXX-YYY`. All OOB-code-based pairing relies on OOB integrity.
- **Mitigations внутри протокола (cosmetic, не security):**
  - `ts` 5-min fresh window → stale tokens reject (не помогает против быстрой перехват-атаки)
  - Single-use → creator invalidates после первого successful redeem (не помогает если Eve первая)
  - Operator UI surfaces paired pubHex + nickname → визуальный detect мисмэтча
- **Upgrade path:** SPAKE2/PAKE → bidirectional proof-of-code-possession вместо signed envelope + OOB. Планируется v0.3+, см. Out of scope.

**Другие не-покрытые (те же):**
- Operator share-ит token в публичном Telegram-канале, PR-описании, GitHub issue. Token эффективно one-time-use секрет.
- Компрометация OOB канала (MITM на самом messenger'е, скомпрометированный email-аккаунт).
- Social engineering: оператора убеждают redeem hostile token.
- NAT-traversal — publically-routable multiaddr нужен (в v0.2.1 DCUtR/hole-punching out-of-scope).
- Token enumeration на DHT — `base64url(JSON)` длиной ~220 bytes, адрес ноды виден при dial'е, но creator принимает только от redeemer с valid envelope (proof-of-possession pattern).

**`POST_PAIR_WIRE_AUTO` — added в v0.2.1-fixup:**

После `pair.success`, redeemer вызывает `transport.joinPeer(creatorPubHex)` → dial через cached multiaddr → newStream(`/demi/wire/1.0.0`) → `_attachWireStream(role:'dialer')`. Creator автоматически attach-ит responder-сторону через `node.handle(DEMI_WIRE_PROTO, ...)`. Без этой post-pair graduation pairing завершается trust granted но wire stream не открыт — chat/agent frames не доставляются. Шаг идемпотентен (skip если socket already present).

**Security impact:** zero — использует existing wire protocol + hello-auth envelope gate, который уже защищён от session hijack (см. `SECURITY hotfix ee08350`). Single-shot dial в `joinPeer` не повышает attack surface.

**`POST_PAIR_REJOIN_PARTIAL` — fixed in commit-3e (was: Q-J, deferred):**

Creator-side `last_multiaddr` pre-3e captured `connection.remoteAddr` — т.е. B's **outbound ephemeral port** (random), НЕ B's listen port. После restart B листенит на новый ephemeral → A's `rejoinAllKnown` dial-ит мёртвый адрес → ECONNREFUSED. B→A direction работало (B персистит creator's token.addrs[0] = listen multiaddr). Net effect: chat recover'ился асинхронно 2-3 sec когда B's rejoin достигал A через inbound peer-connect.

**Fix landed in commit-3e (this branch):** `Transport.getListenAddrFor(peerId)` использует `node.peerStore.get(peerId)` из `@libp2p/identify` service — peer во время identify handshake подписанно передаёт свои listen addresses, они сохраняются в peerStore с `isCertified:true`. runCreator после pair-req success вызывает эту helper и предпочитает certified TCP listen addr над `connection.remoteAddr`. Fallback на ephemeral только если peerStore пустой (edge case: identify ещё не завершился на hostile LAN).

Selection priority (first match wins):
1. certified + TCP non-circuit listen addr
2. certified addr (any transport)
3. observed TCP non-circuit addr
4. any observed addr
5. `connection.remoteAddr` (ephemeral fallback, same behaviour as pre-3e)
6. `null` (peerStore down — unreachable in practice)

Audit: `pair.libp2p.rejoin_addr` emits `{peer, source: 'identify'|'ephemeral-fallback'|'none'}` so ops can detect when fallback kicks in.

**Observable fingerprint nit (Gemini sv2 SEV-2) — resolved by commit-3e:** 2-3-сек «dead zone» после restart creator'а больше не возникает — A's `rejoinAllKnown` теперь успешно дозванивается на B's stable listen multiaddr в первой же попытке. Fingerprint исчез (identify handshake стоит ~30-50ms, unchanged между restarts).

### Forward-compat notes (Gemini sv2 Q-L residual)

**Async upsertPeer/signEnvelope будущих версий:** `runCreator`'s single-use `usedAt` check в `libp2p-pair.js` сейчас racy-proof, потому что Node.js serializes sync callbacks и `upsertPeer`+`signEnvelope` оба sync. Если в будущем любая из двух станет async (SQLite через async driver, HSM-backed signing), нужно добавить atomic compare-and-swap через single-threaded mutex или row-level lock в SQLite. Не ship-blocker для v0.2.1, но marker для reviewer при refactor.

### Gemini review history

- **sv1 APPROVE** на `0f9da5c` (libp2p adapter foundation): DHT clientMode, bounded makeParser, mDNS opt-in, Noise encryption.
- **sv2 REVISE** на `5268bdc` (peer-bootstrap pair flow, v0.2.1 class-break fix): `src/wire.js` makeParser OOM pre-concat check + `src/transport/libp2p.js` broadcast Set dedupe + `_attachWireStream` has-check. Fixup squashed → sv3 после apply.
- **sv3** planned: verify 3 fixups + review schema gate на pair envelopes + scope cap.

### Out of scope (v0.3+)

- QR-code encoding token'а (для offline pairing без messenger'а).
- SPAKE2 upgrade — переход от "signed envelope + OOB token" на полноценный PAKE, чтобы убрать зависимость от OOB integrity.
- DCUtR hole-punching — для NAT-traversal без публичного multiaddr.
- Revocation: если token leaked, creator должен уметь invalidate до истечения 5-мин TTL.
