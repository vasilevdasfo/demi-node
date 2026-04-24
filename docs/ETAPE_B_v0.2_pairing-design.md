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
