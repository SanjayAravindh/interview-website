# Messaging & Event-Driven Architecture Mastery — Senior Production Reference

Apache Kafka 3.x / RabbitMQ 3.x / Spring Kafka / Spring AMQP. Cloud-native event-driven systems on Kubernetes. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping order pipelines, payment sagas, CDC streams, and notification fan-out on JVM backends.

---

## Table of Contents

1. [Mental Model: Messages, Events, and the Broker](#1-mental-model-messages-events-and-the-broker)
2. [Message Queues — Fundamentals](#2-message-queues-fundamentals)
3. [Event-Driven Architecture (EDA)](#3-event-driven-architecture-eda)
4. [Apache Kafka — Core Architecture](#4-apache-kafka-core-architecture)
5. [Topics & Partitions](#5-topics-partitions)
6. [Producers & Consumers](#6-producers-consumers)
7. [Consumer Groups](#7-consumer-groups)
8. [RabbitMQ — Core Architecture](#8-rabbitmq-core-architecture)
9. [Message Ordering & Event Ordering](#9-message-ordering-event-ordering)
10. [Delivery Semantics](#10-delivery-semantics)
11. [At-Most-Once Delivery](#11-at-most-once-delivery)
12. [At-Least-Once Delivery](#12-at-least-once-delivery)
13. [Exactly-Once Semantics](#13-exactly-once-semantics-eos)
14. [Idempotency](#14-idempotency)
15. [Duplicate Message Handling](#15-duplicate-message-handling)
16. [Poison Messages & Dead Letter Queues (DLQ)](#16-poison-messages-dead-letter-queues-dlq)
17. [Message Replay](#17-message-replay)
18. [Schema Registry & Schema Evolution](#18-schema-registry-schema-evolution)
19. [Event Versioning](#19-event-versioning)
20. [Backpressure](#20-backpressure)
21. [Spring Integration Patterns](#21-spring-integration-patterns)
22. [Production Debugging Playbook](#22-production-debugging-playbook)
23. [Quick Decision Matrix](#23-quick-decision-matrix)
24. [Interview Q&A — 20 Senior Questions](#24-interview-qa-20-senior-questions)

---

## 1. Mental Model: Messages, Events, and the Broker

Messaging is not "calling another service over HTTP, but async." It is a **durable, decoupled contract** between producers and consumers mediated by a broker. The broker owns persistence, ordering guarantees (within bounds), fan-out, and replay. Your application owns idempotency, schema compatibility, and business semantics.

```
Producer                         Broker                           Consumer(s)
   │                                │                                  │
   │  publish(message/event)        │                                  │
   ├───────────────────────────────►│  append to log / enqueue         │
   │                                │  replicate for durability        │
   │                                │                                  │
   │                                │  deliver (push or pull)          │
   │                                ├─────────────────────────────────►│
   │                                │                                  │ process
   │                                │◄─────────────────────────────────┤ ack / commit offset
   │                                │                                  │
   │                                │  on failure: retry / DLQ / replay│
```

Three objects you must keep distinct:

| Object | Question it answers | Kafka analogue | RabbitMQ analogue |
|---|---|---|---|
| **Message** | What payload is in flight? | Record (key, value, headers, timestamp) | AMQP message (body, properties, headers) |
| **Topic / Queue** | Where is it stored and who can read it? | Topic (partitioned log) | Queue or exchange + routing |
| **Consumer position** | Where did this consumer stop? | Committed offset per partition | Acknowledged delivery tag / manual ack |

A **message** is transport. An **event** is a message with business meaning — something happened (`OrderPlaced`, `PaymentCaptured`). Not every message is an event (commands like `ChargeCard` are messages but not past-tense events). Mixing commands and events on the same topic without naming discipline is a top source of coupling and replay bugs.

**Queue** semantics: work is typically **competing consumers** — one message, one worker. **Pub/sub** semantics: one message, many subscribers. Kafka topics are pub/sub logs; RabbitMQ can do both via exchanges. Choosing wrong semantics is the #1 architectural mistake in greenfield EDA projects.

---

## 2. Message Queues — Fundamentals

### Core concept

A message queue decouples **producers** (senders) from **consumers** (receivers) in time and space. The producer does not need the consumer to be online. The broker buffers (within limits), routes, and optionally persists messages until they are consumed and acknowledged.

Core properties every senior engineer must articulate:

| Property | Meaning | Production impact |
|---|---|---|
| **Durability** | Survives broker restart | Non-durable queues lose messages on crash |
| **Ordering** | FIFO within a scope | Global order vs per-key order vs none |
| **Delivery guarantee** | At-most / at-least / exactly-once | Duplicates, loss, complexity |
| **Visibility timeout** | How long before redelivery | Long processing → duplicate delivery |
| **Retention** | How long messages live unconsumed | Kafka: days; RabbitMQ: until ack + TTL |
| **Fan-out** | One-to-many delivery | Topic/exchange design |

### Internal working — generic broker lifecycle

1. Producer connects, serializes payload, sends to a **destination** (queue, topic, exchange).
2. Broker validates, optionally persists to disk (fsync policy varies), assigns an ID/offset.
3. Broker delivers to consumer(s) — **push** (RabbitMQ, JMS) or **pull** (Kafka).
4. Consumer processes; sends **ack** (positive acknowledgment) or **nack** (negative).
5. On ack: broker removes message (queue) or advances invisible cursor (some systems).
6. On nack / timeout / crash: broker **redelivers** (at-least-once) or **drops** (at-most-once).

### Production scenario: "We added a queue and lost orders"

**Problem.** Order service publishes to a queue after DB commit. Payment service consumes. During a broker restart, 2% of orders never reach payment. Logs show successful publish on producer side.

**Cause.** Producer used a **non-durable queue** and `delivery_mode=1` (non-persistent messages) on RabbitMQ, or Kafka producer with `acks=0`. Messages existed only in memory; broker crash = loss.

**Solution.**

```java
// RabbitMQ — durable queue + persistent messages
@Bean
Queue orderQueue() {
    return QueueBuilder.durable("orders.placed").build();
}

@Bean
RabbitTemplate rabbitTemplate(ConnectionFactory cf) {
    RabbitTemplate template = new RabbitTemplate(cf);
    template.setMessageConverter(new Jackson2JsonMessageConverter());
    // default delivery mode PERSISTENT when queue is durable
    return template;
}

// Kafka — wait for leader ack, enable idempotence
@Bean
ProducerFactory<String, OrderPlacedEvent> producerFactory() {
    Map<String, Object> props = new HashMap<>();
    props.put(ProducerConfig.ACKS_CONFIG, "all");
    props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
    props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
    return new DefaultKafkaProducerFactory<>(props);
}
```

Rules that save incidents:

- Durable destination + persistent messages + producer confirmation (`acks=all` / publisher confirms).
- Publish **after** local transaction commit (outbox pattern — see [Section 14](#14-idempotency)).
- Monitor **broker disk**, **unclean leader election**, **under-replicated partitions**.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Non-durable queue/exchange | Messages vanish on broker restart |
| Auto-ack before processing completes | At-most-once loss on consumer crash mid-handler |
| Unbounded queue depth | Broker OOM; cascading cluster failure |
| No TTL on retry queues | Poison messages fill disk forever |
| Shared queue for unrelated domains | One slow consumer blocks unrelated work |
| Publishing before DB commit | Consumer reads event; DB rollback → ghost events |

### Debugging scenario

**Observe.** Intermittent missing messages; producer logs "sent"; consumer never sees them.

**Diagnose.** Check RabbitMQ management UI: queue type, durability, message rates, **unroutable** returns (mandatory publish not enabled). For Kafka: `kafka-console-consumer` from `earliest`, compare offset lag vs producer timestamp. Enable producer metrics: `record-error-rate`, `not-enough-replicas-after-append`.

**Fix.** Enable publisher confirms / `acks=all`. Add mandatory flag + return listener on RabbitMQ. Implement outbox if DB + message must be atomic.

---

## 3. Event-Driven Architecture (EDA)

### Core concept

Event-Driven Architecture models system integration as **notifications of state changes** rather than synchronous request/response. Services publish **domain events**; interested services react. This enables loose coupling, independent scaling, and temporal decoupling — at the cost of **eventual consistency**, distributed debugging complexity, and schema governance burden.

Common EDA patterns:

| Pattern | Description | When to use |
|---|---|---|
| **Event Notification** | Thin signal; consumer calls back for details | Low payload size; strong API ownership |
| **Event-Carried State Transfer** | Event contains all data consumer needs | Reduce chatty callbacks; cache-friendly |
| **Event Sourcing** | Events are the source of truth | Audit, replay, complex domains — high cost |
| **CQRS** | Separate read/write models | Read scaling; reporting; pairs with event sourcing |
| **Saga (choreography)** | Services react to events in sequence | Long-running workflows without central orchestrator |
| **Saga (orchestration)** | Central coordinator sends commands | Clear flow visibility; single point of logic |
| **Outbox / Inbox** | Reliable DB + broker atomicity | Any "write DB + publish" path |

```
Choreography saga (events only):

OrderSvc ──OrderPlaced──► Kafka ──► PaymentSvc ──PaymentCaptured──► Kafka ──► ShippingSvc
                │                              │
                └──InventoryReserved──►        └──PaymentFailed──► OrderSvc (compensate)
```

### Internal working — choreography vs orchestration

**Choreography:** each service knows which events it listens to and which it emits. No central brain. Failure modes: implicit distributed state machine — hard to visualize; compensating events must be designed upfront.

**Orchestration:** a saga orchestrator (state machine, Temporal, Camunda) emits commands and listens for replies. Easier to trace; orchestrator becomes critical infrastructure.

Neither removes the need for **idempotent consumers** and **explicit failure events**.

### Production scenario: notification storm after deploy

**Problem.** Deploy new version of `CatalogService` that emits `ProductUpdated` on startup for every product (cache warm). Downstream search, pricing, and CDN invalidation services melt; Kafka consumer lag hits hours.

**Cause.** Treating events as commands; no distinction between **snapshot/bootstrap** events and **delta** events; no rate limiting on consumers.

**Solution.**

- Event types: `ProductCreated`, `ProductUpdated`, `ProductSnapshot` — consumers ignore snapshot in hot path or route to batch pipeline.
- Idempotent processing keyed by `(productId, version)`.
- **Backpressure**: pause consumption, scale consumers, or throttle upstream (see [Section 20](#20-backpressure)).
- Contract test: startup must not emit > N events/sec.

```java
@KafkaListener(topics = "catalog.product", groupId = "search-indexer")
public void onProductEvent(ProductEvent event) {
    if ("ProductSnapshot".equals(event.type()) && !snapshotModeEnabled) {
        return; // or route to batch topic
    }
    indexer.upsert(event.productId(), event.payload(), event.version());
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Events as RPC replacement without timeout story | Hung sagas; orders stuck "pending" forever |
| No correlation ID / causation ID | Cannot trace one business transaction across 12 topics |
| Shared "god topic" for all domains | Schema chaos; one bad consumer poisons everyone |
| Missing compensating events | Partial failure leaves inconsistent money/inventory |
| Synchronous HTTP inside event handler | Defeats decoupling; cascading latency |

### Debugging scenario

**Observe.** Payment captured in DB; shipping never starts. No errors in logs.

**Diagnose.** Trace `correlationId` across topics. Check consumer lag on `payments.captured`. Look for ** deserialization failure** (silently skipped if error handler misconfigured). Check if event was published to wrong topic (typo in constant).

**Fix.** Structured logging with `correlationId`, `eventType`, `aggregateId`. DLQ with alert on first poison message. Integration test that asserts end-to-end saga within SLA.

---

## 4. Apache Kafka — Core Architecture

### Core concept

Kafka is a **distributed commit log** implemented as **topics** split into **partitions**, replicated across **brokers**, with **ZooKeeper** (legacy) or **KRaft** (Kafka 3.x+) for cluster metadata. Producers append records; consumers track **offsets**. Unlike traditional queues, messages are **retained** after consumption (time/size bound) — enabling **replay**.

```
                    Kafka Cluster
┌─────────────────────────────────────────────────────────┐
│  Broker 1          Broker 2          Broker 3           │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   │
│  │ topic-A p0  │   │ topic-A p1  │   │ topic-A p2  │   │
│  │ (leader)    │   │ (leader)    │   │ (leader)    │   │
│  │ replicas... │   │ replicas... │   │ replicas... │   │
│  └─────────────┘   └─────────────┘   └─────────────┘   │
└─────────────────────────────────────────────────────────┘
         ▲                                    │
         │ produce                            │ fetch (poll)
    Producers                           Consumer Group
```

Key Kafka distinctions:

| Concept | Meaning |
|---|---|
| **Broker** | Server storing partitions |
| **Topic** | Named log category |
| **Partition** | Ordered, immutable sequence of records |
| **Replica** | Copy of partition for fault tolerance |
| **ISR** | In-Sync Replicas eligible for leader election |
| **Leader** | Broker handling all reads/writes for a partition |
| **Offset** | Monotonic position within a partition |
| **Consumer group** | Cooperative consumers sharing partition assignment |

### Internal working — produce path

1. Producer chooses partition (key hash, sticky partitioner, or explicit).
2. Record batch sent to **partition leader** broker.
3. Leader appends to local log, waits per `acks` config:
   - `acks=0`: fire-and-forget
   - `acks=1`: leader persisted
   - `acks=all`: all ISR replicas ack
4. Followers replicate from leader.
5. Producer receives ack with offset metadata (or error).

### Internal working — consume path

1. Consumer joins group; **group coordinator** triggers **rebalance**.
2. Partitions assigned (range, round-robin, sticky, cooperative sticky).
3. Consumer **polls** — fetches batches from leaders.
4. Application processes records.
5. Consumer commits offset (auto or manual, sync or async).
6. On rebalance, partition ownership may move — **in-flight** records need careful handling.

### Production scenario: unclean leader election data loss

**Problem.** Rack failure kills two brokers. Some partitions elect out-of-sync replica as leader (`unclean.leader.election.enable=true`). Consumers see truncated logs; events "disappear."

**Cause.** Trading availability for consistency during broker loss.

**Solution.**

- Production: `unclean.leader.election.enable=false` (default in modern clusters).
- `min.insync.replicas=2`, `replication.factor=3`, producer `acks=all`.
- Monitor **under-replicated partitions** and **offline replicas** — alert before election drama.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `replication.factor=1` | Single broker death = data loss |
| `log.retention.ms` too short | Cannot replay after incident window |
| Huge messages (> `message.max.bytes`) | Producer RecordTooLargeException |
| No compression (`compression.type=none`) | Network and disk saturation |
| Single partition hot topic | One broker CPU 100%; others idle |

### Debugging scenario

**Observe.** Producer latency p99 spikes; `NOT_ENOUGH_REPLICAS` in logs.

**Diagnose.** `kafka-topics.sh --describe --topic X` — check ISR shrinkage. Broker disk full? Network partition? ZooKeeper/KRaft quorum healthy?

**Fix.** Free disk, replace failed broker, ensure ISR recovers before accepting high-throughput traffic.

---

## 5. Topics & Partitions

### Core concept

A **topic** is a logical stream. A **partition** is the unit of parallelism and ordering in Kafka. Records in one partition have a **total order**; across partitions there is **no global order**.

Partition count decisions are **hard to reduce** later (requires reassignment and key remapping). Increase is easier but triggers rebalance.

| Factor | Guidance |
|---|---|
| **Throughput** | More partitions → more parallel consumers (up to partition count) |
| **Ordering** | Need order per `customerId` → key = customerId; ensure enough partitions |
| **Retention** | Per-topic `retention.ms`, `retention.bytes`, compacted vs delete |
| **Key cardinality** | Low cardinality keys → hot partitions |

### Internal working — partitioning strategies

```java
// Default: murmur2 hash of key → partition
producer.send(new ProducerRecord<>("orders", orderId, event));

// Explicit partition — use sparingly; you own hot spots
producer.send(new ProducerRecord<>("orders", 3, orderId, event));

// Null key — sticky partitioner batches null-key records to one partition until batch full
producer.send(new ProducerRecord<>("orders", event));
```

**Compacted topics** (`cleanup.policy=compact`): Kafka retains latest value per key — used for **changelog / KTable** semantics, config propagation, deduped state.

### Production scenario: 3 partitions, 12 consumers, 9 sit idle

**Problem.** Team scales consumer deployment to 12 pods; lag unchanged on 3 partitions; cost tripled.

**Cause.** Kafka assigns **at most one consumer per partition** within a group. Extra consumers are idle.

**Solution.** Increase partitions (e.g., to 12) via `kafka-topics.sh --alter`. Plan key distribution — rebalancing changes partition for existing keys mid-flight only for **new** messages. Existing records stay on old partitions.

```bash
kafka-topics.sh --bootstrap-server broker:9092 \
  --alter --topic orders.events --partitions 24
```

Also verify **consumer group** is the same across pods (typo in `group.id` → 12 groups of 1 consumer each, each reading full topic — duplicate processing).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Partition count << peak consumer desire | Cannot scale consumption horizontally |
| Partition count >> broker count × 100 | Metadata overhead; slow leader election |
| Wrong key → all events same partition | Single partition lag while others empty |
| Topic name without domain prefix | ACL and discovery nightmares |
| No naming convention for retry/DLT topics | Operators cannot find dead letters |

### Debugging scenario

**Observe.** Consumer lag uneven: partition 0 at 2M, partitions 1–11 at 0.

**Diagnose.** Hot key — one `merchantId` dominates. Dump key distribution from sample consume. Check skewed producer.

**Fix.** Salt keys (`merchantId + shard`), sub-topics per tenant tier, or accept per-key ordering and scale vertically on handler.

---

## 6. Producers & Consumers

### Core concept

**Producers** serialize and append records. **Consumers** poll, deserialize, process, and commit offsets. The contract between them is the **topic schema**, **partition assignment**, and **delivery semantics** — not an API endpoint.

### Producer — critical configs

| Config | Production value | Why |
|---|---|---|
| `acks` | `all` | Durability |
| `enable.idempotence` | `true` | Dedup retries on broker |
| `max.in.flight.requests.per.connection` | `5` (with idempotence) | Throughput vs ordering |
| `compression.type` | `lz4` or `zstd` | Bandwidth |
| `linger.ms` / `batch.size` | tune for throughput | Batch efficiency |
| `retries` | high (with idempotence) | Transient fault tolerance |

```java
@Service
public class OrderEventPublisher {

    private final KafkaTemplate<String, OrderPlacedEvent> kafka;

    public OrderEventPublisher(KafkaTemplate<String, OrderPlacedEvent> kafka) {
        this.kafka = kafka;
    }

    public CompletableFuture<SendResult<String, OrderPlacedEvent>> publish(OrderPlacedEvent event) {
        return kafka.send("orders.placed", event.orderId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) {
                    log.error("publish failed orderId={}", event.orderId(), ex);
                }
            });
    }
}
```

### Consumer — critical configs

| Config | Production value | Why |
|---|---|---|
| `enable.auto.commit` | `false` | Commit after successful processing |
| `max.poll.records` | tune with processing time | Avoid `max.poll.interval.ms` timeout |
| `max.poll.interval.ms` | > worst-case batch process time | Prevent rebalance during long work |
| `session.timeout.ms` / `heartbeat.interval.ms` | broker-tuned | Stable group membership |
| `isolation.level` | `read_committed` if transactions | Skip aborted txn records |

```java
@KafkaListener(topics = "orders.placed", groupId = "payment-service")
public void handle(ConsumerRecord<String, OrderPlacedEvent> record, Acknowledgment ack) {
    paymentService.charge(record.value());
    ack.acknowledge(); // manual commit after success
}
```

### Production scenario: consumer rebalance loop

**Problem.** Payment consumer logs rebalance every 30 seconds; duplicate charges; lag grows.

**Cause.** Handler takes 45s average; `max.poll.interval.ms=300000` but `max.poll.records=500` — processing 500 records exceeds interval. Consumer kicked from group; partitions reassigned; partial batch reprocessed.

**Solution.**

```yaml
spring.kafka.consumer:
  max-poll-records: 10
  max-poll-interval-ms: 600000
  enable-auto-commit: false
```

Or offload heavy work to executor **after** poll loop with pause/resume — but then you must manage offset commit yourself (advanced).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auto-commit before handler finishes | Lost messages on crash (at-most-once) |
| No deserialization error handler | Container stops; whole partition stuck |
| Shared `group.id` across environments | Staging steals prod partitions |
| `KafkaTemplate.send` without handling failure | Silent data loss |
| Consumer fetch min bytes too high | Latency spikes on low traffic |

### Debugging scenario

**Observe.** `CommitFailedException: rebalance in progress`

**Diagnose.** Processing time vs `max.poll.interval.ms`. GC pause? Blocking HTTP inside listener? Too many records per poll.

**Fix.** Reduce batch size; increase interval; use `@RetryableTopic` for retries without blocking poll loop.

---

## 7. Consumer Groups

### Core concept

A **consumer group** is a set of consumers cooperatively consuming a topic. Each partition is assigned to **at most one** consumer in the group. Different groups each receive **all** messages (pub/sub between groups).

```
Topic orders (4 partitions)

Group "payment":
  Consumer A → p0, p1
  Consumer B → p2, p3

Group "analytics":
  Consumer X → p0, p1, p2, p3  (separate copy of all data)
```

### Internal working — rebalance

Triggers: consumer join/leave, partition count change, subscription change.

Protocols:

| Protocol | Behavior |
|---|---|
| **Eager (range/round-robin)** | Revoke all, reassign — stop-the-world |
| **Cooperative (sticky)** | Incremental revoke — less disruption |

Static membership (`group.instance.id`): reduces rebalance on rolling restart if consumer rejoins within `session.timeout.ms`.

### Production scenario: duplicate processing during rolling deploy

**Problem.** Deploy 6 payment consumers one-by-one. Finance reports duplicate charges during deploy window.

**Cause.** Eager rebalance revokes partitions before commit; in-flight messages reassigned to another consumer.

**Solution.**

- Cooperative sticky assignor.
- Static group instance IDs.
- Idempotent consumer (see [Section 14](#14-idempotency)).
- Stop traffic briefly for critical financial paths, or use EOS transaction (heavy).

```properties
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
group.instance.id=payment-pod-${HOSTNAME}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| New `group.id` per deploy | Reads from `auto.offset.reset=latest`; misses events |
| Two apps same `group.id` | Random partition stealing; chaos |
| Ignoring rebalance listener | Commits offsets for partitions you no longer own |
| No graceful shutdown | `SIGKILL` mid-batch → duplicates on restart |

### Debugging scenario

**Observe.** Consumer group shows 8 members; only 4 pods running.

**Diagnose.** Zombie consumers — old pods not deregistered (network partition). `kafka-consumer-groups.sh --describe --group payment`.

**Fix.** Reduce `session.timeout.ms` carefully; ensure `@PreDestroy` calls `consumer.wakeup()`; delete stale members after confirming dead.

---

## 8. RabbitMQ — Core Architecture

### Core concept

RabbitMQ implements **AMQP 0-9-1**. Producers publish to **exchanges**; exchanges route to **queues** via **bindings** (routing key, headers, fanout). Consumers consume from queues. Messages are **removed** after ack (unless DLX/DLQ).

Exchange types:

| Type | Routing |
|---|---|
| **direct** | Exact routing key match |
| **topic** | Pattern match (`order.*`, `order.#`) |
| **fanout** | All bound queues |
| **headers** | Header attribute match |

```
Producer → exchange "orders.topic" ──binding──► queue "payment.orders"
                              └──binding──► queue "analytics.orders"
```

### Internal working — delivery and ack

1. Consumer receives message with `deliveryTag`.
2. **Manual ack** (`basicAck`) after success — message deleted.
3. **Nack/reject** with `requeue=true` → redelivery; `requeue=false` → drop or DLX.
4. **Prefetch** (`basicQos`) limits unacked messages per consumer — backpressure mechanism.

```java
@RabbitListener(queues = "payment.orders", ackMode = AcknowledgeMode.MANUAL)
public void handle(OrderPlacedEvent event, Channel channel,
                   @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
    try {
        paymentService.charge(event);
        channel.basicAck(tag, false);
    } catch (RetryableException ex) {
        channel.basicNack(tag, false, true); // requeue
    } catch (Exception ex) {
        channel.basicNack(tag, false, false); // route to DLQ via DLX
    }
}
```

### Production scenario: one slow consumer blocks the queue

**Problem.** Queue depth 500k; 4 consumers; 3 idle-looking but one at 100% CPU on poison JSON.

**Cause.** Default prefetch unlimited → one consumer hoards messages; poison message infinite retry without DLQ.

**Solution.**

```java
@Bean
SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
        ConnectionFactory connectionFactory) {
    SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
    factory.setConnectionFactory(connectionFactory);
    factory.setPrefetchCount(10);
    factory.setDefaultRequeueRejected(false);
    return factory;
}
```

Configure **dead-letter exchange** on main queue; max retries via TTL + DLX chain or `RepublishMessageRecoverer`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auto-ack | Message loss on crash |
| No DLX | Infinite redelivery loop |
| Non-durable exchange/queue | Broker restart data loss |
| `exclusive` consumer in prod | Single consumer only |
| Huge messages without limits | Memory alarm; cluster block |

### Debugging scenario

**Observe.** Messages published; queue empty; consumers idle.

**Diagnose.** **Unroutable** messages — wrong exchange or binding. Enable `mandatory=true` + `ReturnCallback`. Check routing key typo.

**Fix.** Fix bindings; add alternate exchange for unroutable audit.

---

## 9. Message Ordering & Event Ordering

### Core concept

**Message ordering** guarantees that consumers observe messages in the order producers sent them — **within a defined scope**. **Event ordering** adds domain meaning: causally related events (`OrderPlaced` before `OrderShipped`) must be processed in correct sequence for a given aggregate.

Scopes of ordering:

| Scope | Guarantee | Mechanism |
|---|---|---|
| **Global topic order** | Total order all messages | Single partition only — limits throughput |
| **Per-key order** | Order preserved per key | Kafka: same key → same partition |
| **Per aggregate order** | Order per `orderId` | Key = aggregate ID |
| **Cross-partition causality** | Not guaranteed | Version vectors, saga orchestration |

### Internal working — ordering vs parallelism tradeoff

```
orderId=42 events:  E1 → E2 → E3  (same partition → preserved)

orderId=42 and orderId=99 on different partitions → no relative order guarantee
```

Producer settings affecting order:

- `max.in.flight.requests.per.connection > 1` without idempotence → reorder on retry.
- With `enable.idempotence=true`, Kafka preserves order per partition even with retries (up to 5 in flight).

### Production scenario: shipped before paid

**Problem.** `OrderShipped` processed before `PaymentCaptured` for same order; warehouse ships unpaid orders.

**Cause.** Events on different topics/partitions; no key alignment; async handlers race.

**Solution.**

- Same key (`orderId`) for all order lifecycle events on one topic **or** enforce state machine in consumer:

```java
public void onOrderEvent(OrderEvent event) {
    orderStateMachine.apply(event.orderId(), event.type(), event.version());
    // reject out-of-order via optimistic version check
}
```

- Database: `UPDATE orders SET status = 'SHIPPED' WHERE id = ? AND status = 'PAID'`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Random partition assignment for keyed events | Lifecycle events scrambled |
| Multiple consumers same partition | Not possible in one group — but multiple groups race |
| Clock-based ordering across services | NTP skew breaks assumptions |
| Assuming Kafka topic order globally | Cross-partition inversion |

### Debugging scenario

**Observe.** Out-of-order in logs for same `customerId`.

**Diagnose.** Compare partition in `ConsumerRecord`. Check if key changed mid-lifecycle (null key on retry).

**Fix.** Enforce key on all publishes; add `sequenceNumber` in event; drop stale sequences.

---

## 10. Delivery Semantics

### Core concept

Delivery semantics describe the relationship between **message send** and **processing completion** under failures (network, broker, consumer crash, rebalance).

| Semantic | Producer crash | Consumer crash | Duplicates? | Loss? |
|---|---|---|---|---|
| **At-most-once** | May lose | May lose | No | Yes |
| **At-least-once** | Retry | Redeliver | Yes | No* |
| **Exactly-once** | Transaction | Transaction + idempotent sink | No | No* |

*Assuming correct configuration and supported broker features; EOS has boundaries.

The **end-to-end** story spans producer → broker → consumer → external side effect (DB, payment gateway). Broker EOS alone does not make your system exactly-once if you double-charge Stripe.

### Internal working — the two-phase consumer pattern

Correct at-least-once:

```
poll → process → commit offset (only if process succeeded)
```

Wrong:

```
poll → commit offset → process   // at-most-once on crash after commit
poll → process (partial) → crash without commit → redeliver  // at-least-once duplicate
```

Exactly-once in Kafka (streams / transactions):

```
beginTransaction → consume → produce → sendOffsetsToTransaction → commitTransaction
```

### Production scenario: "We chose exactly-once" but finance finds duplicates

**Problem.** Team enabled Kafka EOS transactions on producer; still duplicate ledger entries.

**Cause.** EOS covers **Kafka read/write atomicity within transaction** — not your PostgreSQL insert unless using idempotent write or transactional outbox with dedup.

**Solution.** Layer semantics:

1. Kafka EOS for stream processing pipelines.
2. **Idempotent consumer** with business-key dedup table for side effects.
3. External systems with idempotency keys (`Idempotency-Key` header on HTTP).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Claiming exactly-once without idempotent sink | Duplicate side effects |
| Auto-commit + long processing | Lost messages |
| Transaction timeout too short | Abort storm; lag |
| Mixing read_committed and non-transactional producers | Missing or partial data |

### Debugging scenario

**Observe.** Duplicate rate spikes after broker upgrade.

**Diagnose.** Check if upgrade changed `message.format_version` or unclean election. Compare consumer commit mode. Audit idempotency table hit rate.

**Fix.** Restore broker config; fix commit order; strengthen dedup.

---

## 11. At-Most-Once Delivery

### Core concept

At-most-once means a message is delivered **zero or one** times — never duplicated, but **may be lost**. Acceptable for metrics, non-critical telemetry, sample logging — **never** for money, inventory, or legally binding audit without explicit business tolerance.

### How it happens (often accidentally)

| Layer | Configuration |
|---|---|
| Producer | `acks=0`, no retries |
| Broker | Non-durable, TTL eviction |
| Consumer | Auto-commit **before** processing; `enable.auto.commit=true` default with immediate commit |

```java
// AT-MOST-ONCE — do not use for orders
@KafkaListener(topics = "metrics.raw")
public void ingestMetric(MetricEvent event) {
    // auto-commit may have advanced offset already
    metricsStore.write(event); // crash here → lost
}
```

### Production scenario: acceptable loss for metrics pipeline

**Problem.** Product accepts 0.01% metric loss for cost savings on firehose.

**Solution.** Explicit at-most-once: `acks=1`, limited retries, consumer auto-commit with short interval, document SLO. **Separate topic** from billing events — never share consumer code paths.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| At-most-once consumer on payment topic | Revenue leakage |
| Fire-and-forget producer on inventory | Oversell |
| Confusing "async = faster" with "async = lossy" | Incident during peak |

### Debugging scenario

**Observe.** Metric counts lower than upstream counters.

**Diagnose.** Expected if at-most-once. Confirm `acks`, commit mode, dropped records metric.

**Fix.** If loss not acceptable, migrate to at-least-once + idempotency.

---

## 12. At-Least-Once Delivery

### Core concept

At-least-once guarantees **no message loss** under retry/redelivery — but **duplicates are possible**. This is the **default production choice** for Kafka and RabbitMQ when configured with durability, manual acks, and producer retries. Duplicates must be handled in application logic.

### Correct configuration pattern

**Kafka consumer:**

```yaml
spring.kafka.consumer.enable-auto-commit: false
spring.kafka.listener.ack-mode: manual_immediate
```

**RabbitMQ:**

```java
factory.setAcknowledgeMode(AcknowledgeMode.MANUAL);
factory.setDefaultRequeueRejected(false); // after max retries → DLQ, not infinite loop
```

**Producer:**

```properties
acks=all
enable.idempotence=true
retries=2147483647
```

### Internal working — duplicate sources

1. Producer retry after ack lost → duplicate records in log (mitigated by idempotent producer).
2. Consumer crash after processing, before commit → redelivery.
3. Rebalance before commit → another consumer reprocesses.
4. RabbitMQ nack with requeue → same message again.

### Production scenario: inventory decremented twice

**Problem.** At-least-once redelivery on `OrderPlaced`; inventory service subtracts stock twice; oversell "fixed" but shelves empty incorrectly.

**Solution.** Idempotent consumption:

```sql
-- processed_events table
INSERT INTO processed_events (event_id, processed_at)
VALUES (?, NOW())
ON CONFLICT (event_id) DO NOTHING;
-- only decrement if insert succeeded
```

Or compare `event.version` to stored version on aggregate.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| At-least-once without dedup | Duplicate business effects |
| Infinite requeue on RabbitMQ | Poison loop; no progress |
| Committing per-record in huge batch | Slow; partial failure ambiguity |

### Debugging scenario

**Observe.** Same `eventId` processed twice 30s apart.

**Diagnose.** Log commit offset vs processing time. Rebalance timeline correlation. Check `deliveryTag` duplicates in RabbitMQ.

**Fix.** Idempotency store; cooperative rebalance; commit after batch with idempotent batch handler.

---

## 13. Exactly-Once Semantics (EOS)

### Core concept

**Exactly-once semantics** means each message's **effect** occurs once — even under failures. In Kafka, EOS typically means **atomic read-process-write** within a transactional pipeline using the `transactional.id` producer and consumer `isolation.level=read_committed`.

Boundaries — EOS does **not** magically include:

- External DB writes without idempotent design
- HTTP calls to third parties
- Cross-cluster publishing
- Multiple consumer groups

Kafka EOS building blocks:

| Component | Role |
|---|---|
| `transactional.id` | Fences zombie producers |
| Transaction coordinator | Manages transaction log |
| `read_committed` | Consumers skip aborted records |
| Idempotent producer | Sequence per partition dedup |

```java
@Bean
public KafkaTransactionManager<String, String> kafkaTransactionManager(
        ProducerFactory<String, String> pf) {
    return new KafkaTransactionManager<>(pf);
}

@Transactional("kafkaTransactionManager")
public void processAndForward(ConsumerRecord<String, InEvent> record) {
    OutEvent out = transform(record.value());
    kafkaTemplate.send("output.topic", record.key(), out);
    // offsets committed with transaction
}
```

### Production scenario: Kafka Streams EOS vs JDBC sink

**Problem.** Streams app with EOS; JDBC sink still duplicates rows on restore from changelog.

**Cause.** EOS ends at Kafka boundary; JDBC `INSERT` without upsert duplicates.

**Solution.** Use `INSERT ... ON CONFLICT` or transactional outbox. For Streams, prefer **sink connector** with idempotent mode or compacted changelog topic + single-writer rule.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Same `transactional.id` on multiple JVMs | Producer fencing; one side fails |
| Transaction timeout < processing time | Frequent aborts |
| Consumer not `read_committed` | Reads duplicate/aborted data |
| EOS for simple microservice overkill | Operational complexity; little benefit |

### Debugging scenario

**Observe.** `ProducerFencedException` after deploy.

**Diagnose.** Duplicate `transactional.id` — blue/green both running. Old pod not terminated.

**Fix.** Unique transactional id per instance or ensure single writer; use initTransactions on startup.

---

## 14. Idempotency

### Core concept

An operation is **idempotent** if performing it multiple times has the **same effect** as performing it once. At-least-once delivery **requires** idempotent handlers for any side effect that must not duplicate (charges, inventory, emails).

Idempotency strategies:

| Strategy | Mechanism |
|---|---|
| **Natural idempotency** | `SET status = SHIPPED` (same end state) |
| **Idempotency key** | Client-supplied or event UUID in dedup store |
| **Version / sequence** | Ignore events with `version <= current` |
| **Upsert** | DB unique constraint on business key |
| **Outbox** | Single DB transaction: business row + outbox row |

### Transactional Outbox pattern

```
┌─────────────┐     same DB txn      ┌─────────────┐
│ orders      │◄────────────────────►│ outbox      │
│ INSERT      │                      │ INSERT event│
└─────────────┘                      └──────┬──────┘
                                            │
                                     relay process (poll outbox)
                                            │
                                            ▼
                                      Kafka / RabbitMQ
```

```java
@Transactional
public void placeOrder(PlaceOrderCommand cmd) {
    Order order = orderRepo.save(new Order(cmd));
    outboxRepo.save(OutboxEvent.from(order.placedEvent()));
    // commit once — both or neither
}
```

Relay must mark outbox rows published and handle **at-least-once relay** (consumers still dedup).

### Production scenario: double charge on HTTP timeout

**Problem.** Payment service POSTs to gateway; timeout; retries; customer charged twice.

**Solution.** Gateway idempotency key:

```java
HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("/charges"))
    .header("Idempotency-Key", event.eventId())
    .POST(BodyPublishers.ofString(body))
    .build();
```

Store `eventId` in `processed_events` before calling gateway (claim pattern) to survive crash between charge and commit.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Dedup table without TTL/cleanup | Table bloat; slow inserts |
| Idempotency key = orderId for all event types | Legitimate second event dropped |
| Outbox relay without locking | Duplicate publish from multiple relayers |
| Relying only on Kafka EOS | External duplicates remain |

### Debugging scenario

**Observe.** Dedup table shows event processed; business row missing.

**Diagnose.** Transaction rolled back after dedup insert (wrong txn boundary). Or processed marker committed before side effect.

**Fix.** Same transaction for marker + effect; or **inbox pattern** with pending → processed states.

---

## 15. Duplicate Message Handling

### Core concept

Duplicate handling is the **operational application** of idempotency under at-least-once. Detect duplicates; skip or merge; never assume broker dedup alone suffices.

Detection layers:

1. **Broker:** idempotent producer (PID + sequence) — producer retry duplicates only.
2. **Message:** unique `eventId` / `messageId` in header.
3. **Application:** dedup store, version check.
4. **Downstream:** idempotency keys on APIs.

```java
@Transactional
public void handle(OrderPlacedEvent event) {
    if (inboxRepo.existsByEventId(event.eventId())) {
        return; // duplicate — ack and move on
    }
    inboxRepo.save(InboxEntry.pending(event.eventId()));
    orderProcessor.process(event);
    inboxRepo.markProcessed(event.eventId());
}
```

### Production scenario: email blast from duplicate events

**Problem.** `UserRegistered` redelivered 3 times; user gets 3 welcome emails.

**Solution.**

- Dedup on `eventId` before send.
- Email provider idempotency key.
- **Debounce** window for same aggregate (optional).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Dedup only in memory (per pod) | Duplicates across replicas |
| Throw exception on duplicate | Infinite retry instead of ack |
| No metric for duplicate rate | Silent data quality decay |

### Debugging scenario

**Observe.** Duplicate rate 0.1% steady.

**Diagnose.** Normal for at-least-once. Spike correlates with deploy? rebalance?

**Fix.** If spike abnormal, fix rebalance; else ensure dedup path hot and indexed.

---

## 16. Poison Messages & Dead Letter Queues (DLQ)

### Core concept

A **poison message** cannot be processed successfully — bad schema, corrupt payload, referential integrity violation, bug causing NPE every time. Without DLQ, it blocks or infinite-retries, stalling partitions or filling queues.

**Dead Letter Queue (DLQ)** / **Dead Letter Topic (DLT)** receives failed messages after N retries for manual inspection, fix, and replay.

Kafka — Spring `@RetryableTopic`:

```java
@RetryableTopic(
    attempts = "4",
    backoff = @Backoff(delay = 1000, multiplier = 2),
    dltStrategy = DltStrategy.FAIL_ON_ERROR,
    include = {TransientException.class}
)
@KafkaListener(topics = "orders.placed", groupId = "fulfillment")
public void fulfill(OrderPlacedEvent event) {
    fulfillmentService.process(event);
}

@DltHandler
public void onDlt(OrderPlacedEvent event, @Header(KafkaHeaders.EXCEPTION_MESSAGE) String error) {
    opsAlertService.poisonMessage("orders.placed", event, error);
}
```

RabbitMQ — DLX:

```java
@Bean
Queue ordersQueue() {
    return QueueBuilder.durable("orders")
        .withArgument("x-dead-letter-exchange", "orders.dlx")
        .withArgument("x-dead-letter-routing-key", "failed")
        .build();
}

@Bean
Queue ordersDlq() {
    return QueueBuilder.durable("orders.dlq").build();
}
```

### Internal working — retry topic pattern (Kafka)

```
main topic → retry-0 (delay) → retry-1 → ... → DLT
```

Each retry topic consumed by same group with backoff — avoids blocking main consumer poll with sleep.

### Production scenario: one bad JSON blocks partition for 6 hours

**Problem.** Malformed message at offset 999999; consumer throws on deserialize; no skip; manual intervention delayed.

**Solution.**

```java
@Bean
ConcurrentKafkaListenerContainerFactory<String, OrderPlacedEvent> kafkaListenerContainerFactory(
        ConsumerFactory<String, OrderPlacedEvent> cf) {
    ConcurrentKafkaListenerContainerFactory<String, OrderPlacedEvent> factory =
        new ConcurrentKafkaListenerContainerFactory<>();
    factory.setConsumerFactory(cf);
    factory.setCommonErrorHandler(new DefaultErrorHandler(
        new DeadLetterPublishingRecoverer(kafkaTemplate()),
        new FixedBackOff(1000L, 3L)));
    return factory;
}
```

Alert on DLT depth > 0. Runbook: fix schema/code → replay (see [Section 17](#17-message-replay)).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No DLQ | Infinite retry; lag explosion |
| DLQ without monitoring | Silent data loss of business events |
| Requeue poison forever | CPU burn; no progress |
| DLT same retention as main | Disk cost; compliance issues |

### Debugging scenario

**Observe.** Single partition lag stuck; rest healthy.

**Diagnose.** Consume that offset manually; reproduce exception. Check DLT for same key.

**Fix.** Skip offset after logging to DLT (careful); fix bug; replay from DLT.

---

## 17. Message Replay

### Core concept

**Replay** re-processes historical messages — after bug fix, new consumer deployment, disaster recovery, or regulatory audit. Kafka's retained log makes replay first-class; traditional queues often require separate archive or event store.

Replay modes:

| Mode | Description |
|---|---|
| **Reset consumer offset** | `--reset-offsets --to-datetime` |
| **New consumer group** | Read from `earliest` without affecting prod group |
| **Mirror / export** | Re-publish from S3 archive to new topic |
| **Event sourcing** | Rebuild projection from full history |

```bash
# New group reads from beginning — does not disturb payment-service group
kafka-consumer-groups.sh --bootstrap-server broker:9092 \
  --group payment-service-replay-20250831 \
  --reset-offsets --to-earliest \
  --topic orders.placed --execute
```

### Production scenario: replay after bug shipped wrong tax

**Problem.** Tax calculator bug for 48 hours; need recompute for 200k orders.

**Solution.**

1. Deploy fix.
2. New consumer group `tax-replay` from `2025-08-29T00:00:00` offset (timestamp index).
3. **Idempotent** tax adjustment: upsert by `orderId`.
4. Rate-limit replay to avoid overwhelming downstream.
5. Do **not** reset prod group offset while prod traffic active — duplicates live traffic.

```java
// Replay consumer — separate group, throttled
@KafkaListener(topics = "orders.placed", groupId = "tax-replay-20250831",
               concurrency = "2")
public void replay(OrderPlacedEvent event) {
    rateLimiter.acquire();
    taxService.recalculateIdempotent(event.orderId(), event);
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Reset prod offsets during live traffic | Massive duplicate side effects |
| Replay without idempotency | Double charges, double emails |
| Retention shorter than recovery window | Cannot replay far enough |
| Replay faster than sink capacity | Outage during recovery |

### Debugging scenario

**Observe.** Replay started; DB CPU 100%; prod lag spikes.

**Diagnose.** Replay group competing for same DB; insufficient throttling.

**Fix.** Dedicated read replica for replay; lower concurrency; pause replay during peak.

---

## 18. Schema Registry & Schema Evolution

### Core concept

**Schema Registry** (Confluent, Apicurio, AWS Glue Schema Registry) stores Avro/Protobuf/JSON Schema definitions with **versioning**. Producers register schema; consumers fetch compatible schema by ID embedded in message (`magic byte + schemaId + payload` for Confluent wire format).

Why it matters in production:

- Prevents "JSON blob" drift (`amount` string vs number).
- Enforces **compatibility rules** before deploy.
- Enables safe multi-team publishing to shared topics.

Compatibility modes:

| Mode | Rule |
|---|---|
| **BACKWARD** (default) | New schema can read old data — consumer deploy first |
| **FORWARD** | Old schema can read new data — producer deploy first |
| **FULL** | Both directions |
| **NONE** | Breaking changes allowed — incident bait |

### Internal working — Confluent Avro flow

```
Producer → serialize with schema id 47 → Kafka
Consumer ← fetch schema 47 from registry ← deserialize
```

Registry validates: new schema compatible with previous per subject policy.

```java
@Bean
public ProducerFactory<String, SpecificRecordBase> avroProducerFactory() {
    Map<String, Object> props = new HashMap<>();
    props.put(KafkaAvroSerializerConfig.SCHEMA_REGISTRY_URL_CONFIG, registryUrl);
    props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
    props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, KafkaAvroSerializer.class);
    return new DefaultKafkaProducerFactory<>(props);
}
```

### Production scenario: deploy breaks all consumers

**Problem.** Developer removes optional field; registry rejects (`Incompatible schema`); prod producers fail.

**Cause.** Field was not optional with default; BACKWARD violation.

**Solution.**

- Avro: only add fields with defaults; never delete without dual-write period.
- CI: `maven-schema-registry-plugin` or `schema-registry validate` in pipeline.
- Use **FULL_TRANSITIVE** for critical topics.

```json
{
  "type": "record",
  "name": "OrderPlaced",
  "fields": [
    {"name": "orderId", "type": "string"},
    {"name": "loyaltyPoints", "type": "int", "default": 0}
  ]
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No registry — raw JSON | Silent field drift; prod deserialization errors |
| NONE compatibility | Frequent consumer crashes |
| Subject naming chaos | Wrong schema applied |
| Schema not in CI | Friday deploy surprises |

### Debugging scenario

**Observe.** `SerializationException: Unknown magic byte`

**Diagnose.** Producer not using Confluent serializer; binary vs JSON mismatch. Or wrong registry URL in one region.

**Fix.** Align serializers; verify schema ID in hex dump of first bytes.

---

## 19. Event Versioning

### Core concept

**Event versioning** is domain-level schema strategy — how you evolve `OrderPlacedV1` → `OrderPlacedV2` without breaking sagas. Distinct from registry compatibility: you can be registry-compatible but semantically breaking (`amount` cents → dollars).

Versioning strategies:

| Strategy | Approach |
|---|---|
| **Single topic, version field** | `{"type":"OrderPlaced","version":2,...}` |
| **Topic per version** | `orders.placed.v1`, `orders.placed.v2` |
| **Upcasting** | Consumer maps v1 → internal canonical model |
| **Dual publish** | Transition period: emit v1 and v2 |
| **External event contract** | AsyncAPI / CloudEvents `specversion` |

CloudEvents standard headers:

```
ce-specversion: 1.0
ce-type: com.example.order.placed
ce-source: /orders-service
ce-id: uuid
ce-time: 2025-08-31T12:00:00Z
```

### Production scenario: v2 event drops field used by legacy analytics

**Problem.** v2 removes `customerEmail` (PII scrub); analytics pipeline breaks.

**Solution.**

- Deprecation window: field nullable 90 days.
- **Data classification**: analytics moves to separate consent-based topic.
- Document in AsyncAPI; consumer contract tests in CI.

```java
public CanonicalOrder toCanonical(OrderEvent raw) {
    return switch (raw.version()) {
        case 1 -> mapV1(raw);
        case 2 -> mapV2(raw);
        default -> throw new UnsupportedEventVersionException(raw.version());
    };
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Breaking change without version bump | Subtle wrong calculations |
| Infinite dual publish | Double cost; consumer confusion |
| No deprecation policy | Consumers fear upgrading |
| Version in topic name explosion | Operational overhead |

### Debugging scenario

**Observe.** Consumer throws `UnsupportedEventVersionException` after canary deploy.

**Diagnose.** Canary emits v3; only 5% traffic; main branch not ready.

**Fix.** Feature flag version emission; coordinate consumer deploy before producer.

---

## 20. Backpressure

### Core concept

**Backpressure** signals upstream to slow down when downstream cannot keep pace — preventing OOM, broker disk fill, and cascading failure. Messaging systems implement it differently:

| System | Mechanism |
|---|---|
| **Kafka** | Consumer pauses fetch; lag grows; retention may expire |
| **RabbitMQ** | Prefetch limit; publisher confirms block when memory alarm |
| **Reactive (RS)** | `request(n)` flow control |
| **Application** | Rate limiter, bounded queue, shed load |

Kafka consumer pause:

```java
container.pause();
// drain internal queue, scale workers, fix slow DB
container.resume();
```

RabbitMQ:

```java
channel.basicQos(10); // max 10 unacked per consumer
```

### Production scenario: Black Friday lag — retention expires before catch-up

**Problem.** Consumer lag 12 hours; `retention.ms=86400000` (24h); events start dropping before processing.

**Cause.** No backpressure on producer; consumer under-provisioned; retention not sized for recovery time.

**Solution.**

- Increase retention for peak (7 days on critical topics).
- Auto-scale consumers on lag metric.
- **Circuit breaker** on producer if lag > threshold (defer non-critical events).
- Optimize hot path (batch DB writes).

```java
if (lagMonitor.lag("orders.placed", "fulfillment") > 1_000_000) {
    nonCriticalPublisher.pause();
    alertOps("fulfillment lag critical");
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Unbounded in-memory buffer in consumer | OOMKilled pods |
| Prefetch unlimited (RabbitMQ) | One consumer hoards |
| No lag alerting | Discover backlog from customers |
| Scaling consumers past partition count | Wasted money; no gain |

### Debugging scenario

**Observe.** Broker disk usage climbing; produce rate normal.

**Diagnose.** Slow consumers → lag → retention not deleting fast enough? Or compaction disabled on high-volume topic?

**Fix.** Scale consumers; increase retention disk; throttle producers; add partitions if CPU-bound on consumer side.

---

## 21. Spring Integration Patterns

### Core concept

Spring Kafka and Spring AMQP provide production abstractions — listeners, error handlers, retry topics, transactions — that encode the patterns above. Misconfiguring the framework recreates classic messaging bugs.

### Kafka — listener ack modes

| Mode | Behavior |
|---|---|
| `RECORD` | Commit after each record |
| `BATCH` | Commit after whole poll batch |
| `MANUAL` / `MANUAL_IMMEDIATE` | Explicit `Acknowledgment.acknowledge()` |
| `TIME` | Commit on timer |

Use `MANUAL_IMMEDIATE` when processing time varies record-to-record.

### RabbitMQ — listener container

```yaml
spring.rabbitmq.listener.simple:
  acknowledge-mode: manual
  prefetch: 10
  default-requeue-rejected: false
  retry:
    enabled: true
    max-attempts: 3
```

### Production scenario: `@KafkaListener` and `@Transactional` on wrong bean

**Problem.** DB rolls back but offset committed — or opposite.

**Cause.** Kafka transaction manager vs JPA transaction manager confusion; `@Transactional` on listener without chained txn.

**Solution.** Separate concerns:

```java
@Transactional("transactionManager") // JDBC/JPA only
public void persistBusinessState(OrderPlacedEvent event) { ... }

@KafkaListener(...)
public void listen(OrderPlacedEvent event, Acknowledgment ack) {
    try {
        businessService.persistBusinessState(event);
        ack.acknowledge();
    } catch (Exception ex) {
        throw ex; // no ack — redelivery
    }
}
```

For true Kafka EOS, use `ChainedKafkaTransactionManager` (advanced) or outbox.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `JsonDeserializer` trusted packages `*` | RCE vulnerability |
| Wrong `spring.kafka.consumer.group-id` in YAML profile | Cross-env consumption |
| `@RetryableTopic` on class with wrong exception types | Poison to DLT too early/late |
| Missing `DefaultErrorHandler` | One bad record stops container |

### Debugging scenario

**Observe.** Spring Kafka container stopped; no consumer logs.

**Diagnose.** `stopImmediate` on fatal deserialization. Check `CommonErrorHandler` logs. `AuthorizationException` on cluster ACL.

**Fix.** Deserialization delegate with DLT routing; fix ACL; restart container.

---

## 22. Production Debugging Playbook

When messaging bugs are "random," it is usually **offset/commit timing**, **rebalance**, **schema drift**, or **missing idempotency**.

1. **Classify the symptom.** Lag growth? Duplicates? Loss? Poison? Intermittent only on deploy?

2. **Identify the boundary.** Producer vs broker vs consumer vs external side effect. Check each layer's semantics independently.

3. **Kafka — mandatory first commands:**

   ```bash
   kafka-consumer-groups.sh --bootstrap-server $BS --describe --group $GROUP
   kafka-topics.sh --bootstrap-server $BS --describe --topic $TOPIC
   ```

   Read: `LAG`, `ISR`, leader distribution, under-replicated partitions.

4. **RabbitMQ — management UI / CLI:**

   ```bash
   rabbitmqctl list_queues name messages consumers message_stats.publish_details.rate
   ```

   Check ready vs unacked, consumer utilisation, memory alarm.

5. **Trace one message.** Pick `eventId` / `correlationId`; grep across producer logs, broker timestamp, consumer partition/offset, dedup table.

6. **Rebalance timeline.** Correlate duplicate spikes with consumer group member count changes in metrics.

7. **Schema.** Registry version history; `Incompatible schema` errors; first failing offset hex dump.

8. **Commit mode.** Confirm auto-commit off for at-least-once side effects. Log offset at process start and ack time.

9. **DLT / DLQ depth.** Any non-zero = active incident. Sample payload; reproduce locally.

10. **Retention vs lag.** `retention.ms` minus oldest lagging offset timestamp = time to data loss.

11. **Turn debug off.** Verbose Kafka client logging in prod floods disk and may log PII payloads.

Actuator metrics: `spring.kafka.listener`, Micrometer `kafka.consumer.lag`, Rabbit `rabbitmq.received`. Alert on lag SLO, DLT rate, publish error rate, broker offline partitions.

---

## 23. Quick Decision Matrix

| Situation | Do this |
|---|---|
| High-throughput event stream, replay needed | Kafka, keyed partitions, schema registry |
| Task queue, competing workers, per-message ack | RabbitMQ queue + manual ack + DLX |
| Fan-out notifications to many subscribers | Kafka topic or Rabbit fanout exchange |
| Strict global ordering | Single partition OR redesign for per-aggregate keys |
| Per-customer ordering | Partition key = customerId |
| Money / inventory side effects | At-least-once + idempotency key + dedup store |
| Fire-and-forget metrics | At-most-once acceptable — isolate topic |
| DB write + publish must be atomic | Transactional outbox + relay |
| Poison message risk | Retry topics / DLX + `@DltHandler` + alert |
| Bug fix requires reprocessing | New consumer group replay; never reset prod offsets blindly |
| Schema changes | BACKWARD compatibility; CI registry check; default new fields |
| Cross-service causality debugging | CloudEvents + correlationId + structured logging |
| Peak traffic lag risk | Retention > recovery time; lag-based autoscale; backpressure |
| Kafka EOS stream processing | `transactional.id`, `read_committed`, idempotent sink |
| Legacy queue without log | Archive to S3 + Kafka connect for replay path |
| Multi-region | MirrorMaker / cluster linking; conflict resolution design upfront |
| Spring Boot microservice | Manual ack Kafka; outbox; `@RetryableTopic`; no auto-commit on money paths |

---

## 24. Interview Q&A — 20 Senior Questions

### Q1. What is the difference between a message queue and an event stream?

**Answer.** A **message queue** traditionally delivers work items to **competing consumers** — each message typically consumed once and removed (RabbitMQ queue). An **event stream** (Kafka) is an **append-only log** — messages retained after consumption, multiple consumer groups read independently, **replay** is native. Queues optimize task distribution; logs optimize audit, analytics, and reprocessing. Many systems use both patterns for different boundaries.

### Q2. When would you choose RabbitMQ over Kafka?

**Answer.** RabbitMQ when you need **complex routing** (topic/header exchanges), **per-message ack** with low latency task queues, moderate throughput, and **competing consumer** semantics without long retention. Kafka when you need **high throughput**, **log retention**, **replay**, stream processing, or many independent consumer groups on the same data. Rabbit for "do this job"; Kafka for "this happened, figure out what you need."

### Q3. Explain Kafka partitions to an interviewer.

**Answer.** A topic is split into partitions — ordered, immutable sequences. Each partition is hosted on one broker leader with replicas. Producers append to a partition (by key hash or choice). Consumers in a group divide partitions among members. **Order is guaranteed within a partition, not across.** Partition count caps parallel consumers in one group and is the unit of scalability.

### Q4. What is a consumer group and why does it matter?

**Answer.** A consumer group is a set of consumers sharing work on a topic. Each partition is assigned to at most one consumer in the group. If consumers exceed partitions, extras idle. **Different groups** each receive all messages — enabling payment service and analytics to read the same topic independently. Group coordinator manages membership and rebalance on scale events.

### Q5. How do you guarantee message ordering in Kafka?

**Answer.** Use a **single partition** for global order (limits throughput), or partition by **business key** (e.g., `orderId`) so all events for one aggregate go to one partition. Producer: enable **idempotence**, limit `max.in.flight` appropriately. Consumer: process sequentially per partition (single thread per partition in standard model). Cross-partition order requires application-level versioning or orchestration.

### Q6. Compare at-most-once, at-least-once, and exactly-once.

**Answer.** **At-most-once:** may lose, never duplicates — auto-commit before process, `acks=0`. **At-least-once:** no loss, may duplicate — manual commit after success, retries. **Exactly-once:** Kafka transactions for read-process-write within Kafka; end-to-end requires **idempotent sinks**. Most microservices run **at-least-once + idempotency** — simpler and sufficient.

### Q7. What causes duplicate messages and how do you handle them?

**Answer.** Duplicates from: producer retries, consumer crash before commit, rebalance, RabbitMQ requeue. Handle with **idempotency keys**, **dedup table** (`eventId` unique constraint), **version checks** on aggregates, natural idempotent updates, and external API idempotency headers. Never assume exactly-once without proving side effects are covered.

### Q8. What is a poison message and what is your strategy?

**Answer.** A message that **always fails** processing — bad data or code bug. Strategy: **limited retries** with backoff, route to **DLQ/DLT**, **alert** ops, fix root cause, **replay** from DLQ. Never infinite requeue. Separate retry traffic from main topic (Kafka retry topics). Log exception stack and payload metadata (not PII) in DLT handler.

### Q9. Explain the transactional outbox pattern.

**Answer.** Business state and an **outbox row** are written in the **same DB transaction**. A separate **relay** process polls outbox and publishes to the broker, marking rows sent. This avoids **dual-write** problem (DB committed, publish failed). Relay is at-least-once — consumers still need dedup. Variants: Debezium CDC on outbox table for log-based relay.

### Q10. What is idempotency and give a production example.

**Answer.** Performing an operation multiple times equals once. Example: `PaymentCaptured` event redelivered — before charging, `INSERT INTO processed_events (event_id) VALUES (?) ON CONFLICT DO NOTHING`; only proceed if insert succeeded. Or call payment gateway with **`Idempotency-Key: eventId`**. Inventory: `UPDATE stock SET qty = qty - ? WHERE id = ? AND qty >= ?` with monotonic event version check.

### Q11. How does Kafka's idempotent producer work?

**Answer.** Producer gets a **PID** (producer ID) and sends **sequence numbers** per partition. Broker deduplicates retries with same PID+sequence. Requires `enable.idempotence=true`, which sets `acks=all` and appropriate retries. **Does not** deduplicate two intentional sends of the same business event — still need application-level idempotency keys.

### Q12. What happens during a consumer rebalance?

**Answer.** Group coordinator revokes partition assignments, redistributes among members, consumers seek to **committed offsets** on newly assigned partitions. **In-flight** messages may be reprocessed if commit hadn't happened — duplicates. Mitigate: **cooperative sticky** assignor, **static membership**, **idempotent handlers**, graceful shutdown with `wakeup()`.

### Q13. What is a Dead Letter Topic (DLT) and when do you use it?

**Answer.** DLT holds messages that **failed processing** after retries — for inspection, manual fix, and replay. Use when failure is not transient (schema error, validation) or max retries exhausted. `@RetryableTopic` in Spring Kafka automates main → retry-N → DLT flow. Monitor DLT depth; zero tolerance for unreviewed DLT growth in payment domains.

### Q14. How would you replay Kafka messages safely?

**Answer.** Create a **new consumer group** (or reset offsets in maintenance window only). Start from `earliest` or timestamp. **Rate-limit** replay. Ensure handlers are **idempotent**. Do not reset production group offsets during live traffic — doubles processing. Verify **retention** covers replay window. Track replay progress separately from prod lag metrics.

### Q15. What is schema evolution and BACKWARD compatibility?

**Answer.** **Schema evolution** changes event structure over time. **BACKWARD** compatibility means **new consumers** can read **old data** — safe to deploy consumer before producer. Achieved by adding optional fields with defaults, not deleting required fields. Validate in **Schema Registry** CI. Use **upcasting** in consumer to a canonical internal model.

### Q16. How do you implement backpressure?

**Answer.** **Kafka:** pause consumer container, scale consumers (≤ partitions), increase retention, throttle producers on lag threshold. **RabbitMQ:** reduce **prefetch**, enable **publisher confirms** and block on memory alarm. **Application:** bounded queues, rate limiters, load shed non-critical paths. Alert on lag early — lag is the universal backpressure signal.

### Q17. What is the difference between message ordering and event ordering?

**Answer.** **Message ordering** is transport-level FIFO within a scope (partition). **Event ordering** is domain-level — causal order of business facts (`Created` before `Paid` before `Shipped`). Transport order per key helps but doesn't guarantee semantic order if events span topics or services — use **version numbers**, **state machines**, and **DB constraints**.

### Q18. Explain exactly-once semantics in Kafka Streams.

**Answer.** Streams uses **transactional producer** (`transactional.id`) to **atomically** write output topics and commit input offsets. Consumer `isolation.level=read_committed` skips aborted transactions. Bounded to Kafka ecosystem — JDBC sinks need idempotent writes. **Processing guarantee** `exactly_once_v2` in modern Streams.

### Q19. What metrics do you alert on in production messaging?

**Answer.** **Consumer lag** (max, p95), **DLT/DLQ rate**, **publish error rate**, **under-replicated partitions**, **broker disk**, **request latency**, **rebalance rate**, **duplicate/idempotency cache miss rate**, **schema registry errors**, RabbitMQ **memory/disk alarm**, **unacked message age**. SLO: lag recovery time < retention window.

### Q20. Describe a production incident you would expect from wrong delivery semantics.

**Answer.** Team enabled **auto-commit** on order consumer (at-most-once). Pod killed mid-charge after processing but before commit — message **lost**, customer never charged but order shipped. Or opposite: at-least-once without dedup — **double charge** during rebalance on deploy. Fix: manual ack after success, idempotency store, cooperative rebalance, finance reconciliation job as safety net.

### Q21. How do CloudEvents help in event-driven systems?

**Answer.** **CloudEvents** standardize metadata: `id`, `source`, `type`, `specversion`, `time`. Enables uniform routing, logging, and tracing across polyglot services. `id` supports dedup; extensions carry `correlationid`. Doesn't replace schema registry for payload but unifies envelope conventions.

### Q22. Kafka vs RabbitMQ — how do you handle message replay in each?

**Answer.** **Kafka:** native — reset offsets or new group; retention-bound. **RabbitMQ:** messages deleted on ack — replay requires **dead-letter archive**, **event store**, or **shovel** from audit log. If replay is a requirement, Rabbit alone is often insufficient without additional persistence layer.

---

*The broker guarantees delivery semantics only within its boundary. Your service owns idempotency, schema contracts, and compensating actions. Design for at-least-once, prove duplicates harmless, monitor lag like uptime, and never reset production offsets without a runbook and finance in the loop.*
