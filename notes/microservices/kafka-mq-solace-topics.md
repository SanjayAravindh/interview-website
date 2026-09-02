# Kafka, Message Queues & Solace Topics — Senior Production Reference

Apache Kafka 3.x / KRaft, RabbitMQ 3.x, Solace PubSub+, Spring Kafka / Spring AMQP / Solace Spring Boot. Enterprise messaging on Kubernetes and bare-metal clusters. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping order pipelines, payment sagas, CDC streams, guaranteed delivery over Solace VPNs, and hybrid Kafka-to-Solace bridges on JVM backends.

---

## Table of Contents

1. [Mental Model: Kafka Topics, MQ Queues & Solace Topics](#1-mental-model-kafka-topics-mq-queues-solace-topics)
2. [Message Queues — Fundamentals](#2-message-queues-fundamentals)
3. [AMQP / RabbitMQ — Exchanges, Queues, Bindings](#3-amqp-rabbitmq-exchanges-queues-bindings)
4. [JMS — Queue vs Topic, Durable Subscriptions, XA](#4-jms-queue-vs-topic-durable-subscriptions-xa)
5. [Apache Kafka — Architecture, Brokers & KRaft](#5-apache-kafka-architecture-brokers-kraft)
6. [Kafka Topics Deep Dive — Naming, Partitions & Keys](#6-kafka-topics-deep-dive-naming-partitions-keys)
7. [Kafka Retention, Compaction, Tiered Storage & ACLs](#7-kafka-retention-compaction-tiered-storage-acls)
8. [Kafka Replication, ISR & Leader Election](#8-kafka-replication-isr-leader-election)
9. [Consumer Groups, Offsets & Rebalance](#9-consumer-groups-offsets-rebalance)
10. [Cooperative Sticky Assignor & Static Membership](#10-cooperative-sticky-assignor-static-membership)
11. [Kafka Topic Patterns — Main/Retry/DLT, CDC, Changelog](#11-kafka-topic-patterns-mainretrydlt-cdc-changelog)
12. [Kafka Production Scenarios & Failure Catalog](#12-kafka-production-scenarios-failure-catalog)
13. [Solace PubSub+ — Event Broker, Message VPN & Routing](#13-solace-pubsub-event-broker-message-vpn-routing)
14. [Solace Topics — Hierarchy, Wildcards & Subscription Matching](#14-solace-topics-hierarchy-wildcards-subscription-matching)
15. [Solace Destinations — Queues vs Topics vs Endpoints vs Durable Subscriptions](#15-solace-destinations-queues-vs-topics-vs-endpoints-vs-durable-subscriptions)
16. [Solace Guaranteed Messaging — Direct vs Persistent, Ack & Replay](#16-solace-guaranteed-messaging-direct-vs-persistent-ack-replay)
17. [Side-by-Side Platform Comparison](#17-side-by-side-platform-comparison)
18. [Ordering Guarantees Across All Platforms](#18-ordering-guarantees-across-all-platforms)
19. [Delivery Semantics — At-Most, At-Least, Exactly-Once](#19-delivery-semantics-at-most-at-least-exactly-once)
20. [Spring Kafka — @KafkaListener, KafkaTemplate, RetryableTopic](#20-spring-kafka-kafkalistener-kafkatemplate-retryabletopic)
21. [Spring RabbitMQ — RabbitTemplate & @RabbitListener](#21-spring-rabbitmq-rabbittemplate-rabbitlistener)
22. [Solace Spring Boot — JCSMP & Solace Java API Patterns](#22-solace-spring-boot-jcsmp-solace-java-api-patterns)
23. [Schema & Serialization — JSON, Avro, Schema Registry](#23-schema-serialization-json-avro-schema-registry)
24. [Poison Messages & Cross-Platform DLQ Patterns](#24-poison-messages-cross-platform-dlq-patterns)
25. [Production Debugging Playbook](#25-production-debugging-playbook)
26. [Quick Decision Matrix](#26-quick-decision-matrix)

---

## 1. Mental Model: Kafka Topics, MQ Queues & Solace Topics

Messaging is not "HTTP, but async." It is a **durable contract** between producers and consumers mediated by a broker that owns persistence, routing, fan-out, and (sometimes) replay. Your application owns idempotency, schema compatibility, and business semantics. Three platforms dominate enterprise Java shops — each optimizes for a different mental model.

```
                    KAFKA                         RABBITMQ                      SOLACE PubSub+
                    ─────                         ────────                      ──────────────
Storage model       Append-only partitioned log   Queue per consumer/work pool  Topic tree + optional queue endpoints
Routing             Topic name + partition key    Exchange + binding + rk       Topic hierarchy + wildcards
Consumer model      Pull + consumer group offset  Push + ack/nack               Push/pull; direct or guaranteed
Retention           Time/bytes/compaction         Until ack (+ TTL policies)    Spool / replay / TTL per destination
Replay              Native (reset offset)         DLQ archive / shovel only     Replay from queue / DTE / broker log
Best at             High-throughput event streams Task queues, complex routing  Enterprise pub/sub + guaranteed delivery
```

Three objects you must keep distinct on every platform:

| Object | Question it answers | Kafka | RabbitMQ | Solace |
|---|---|---|---|---|
| **Message** | What payload is in flight? | Record (key, value, headers, timestamp, offset) | AMQP message (body, properties, headers) | BytesMessage / MapMessage / SDT container + user properties |
| **Destination** | Where is it stored / routed? | Topic (partitioned log) | Exchange → Queue | Topic string or Queue name |
| **Consumer position** | Where did this consumer stop? | Committed offset per partition | Delivery tag + ack state | Flow window + spool cursor / replay pointer |

**Kafka topic** = immutable, ordered log segment per partition. Messages are **not deleted on consume** — consumer groups track independent offsets. Multiple groups read the same topic without interfering. Think "event stream" or "changelog."

**Traditional MQ queue** = work buffer. One message typically goes to **one competing consumer** and is removed (or marked consumed) on ack. Think "do this job."

**Solace topic** = hierarchical address in a **topic space** (not a stored log). Publishers send to a topic string; subscribers register **topic subscriptions** (possibly with wildcards). Messages match subscriptions at routing time — fan-out is native. For **guaranteed** delivery, messages spool to **queue endpoints** or **durable topic subscriptions** bound to queues.

The #1 architectural mistake: using a Kafka topic like a task queue (resetting offsets, one consumer group doing competing work without key discipline) or using a RabbitMQ queue like an event log (expecting replay after ack). Solace teams sometimes treat topics like Kafka logs when they need **queue endpoints** for load balancing.

### Internal working — publish path comparison

**Kafka producer path:**

1. Producer serializes record, chooses partition (key hash, sticky, or explicit).
2. Record batches to partition leader broker.
3. Leader appends to local log, waits per `acks` policy.
4. Followers replicate from leader; ISR tracks in-sync replicas.
5. Producer receives ack with offset metadata.
6. Consumers pull — broker does not push.

**RabbitMQ publish path:**

1. Producer publishes to **exchange** with routing key / headers.
2. Exchange evaluates bindings → target queue(s).
3. Queue stores message (memory/disk per durability).
4. Broker **pushes** to consumer with prefetch limit.
5. Consumer acks → message removed from queue (or dead-lettered on nack).

**Solace publish path:**

1. Producer connects to **Message VPN**, obtains session.
2. Publishes to **topic** (direct/guaranteed) or sends to **queue** directly.
3. Event broker evaluates topic subscriptions → matching endpoints.
4. Guaranteed messages **spool** to queue/DTE; direct messages delivered immediately to online subscribers.
5. Consumer acks (CLIENT / AUTO / DUP) per flow; replay available from spool.

### Production scenario: "We picked Kafka for a job queue and can't scale workers"

**Problem.** Team uses topic `payment-jobs` with 1 partition and one consumer group. They scale consumers to 20 pods; only one processes messages. They try adding partitions — ordering breaks for same `orderId`.

**Cause.** Confused **competing consumers** (queue semantics) with **partition parallelism** (log semantics). Single partition = single consumer in group regardless of pod count.

**Solution.**

- If strict per-`orderId` order: partition key = `orderId`, partition count = desired max parallelism (e.g., 24), consumer count ≤ 24.
- If pure task queue with no ordering: RabbitMQ quorum queue or Solace queue with multiple consumers on same queue — or Kafka with many partitions and random/null keys (accept no cross-key order).
- Document the choice in ADR; don't "fix" with multiple consumer groups on same topic (duplicate processing).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Kafka topic used as point-to-point without key strategy | Can't scale consumers; or ordering lost when scaling |
| RabbitMQ fanout for work distribution | Every queue gets every message — not competing workers |
| Solace direct topic for critical payment path | Messages lost if no subscriber online |
| Mixed naming (`orders` vs `order.events` vs `OrderCreated`) | Routing bugs, ACL gaps, observability blind spots |
| Same logical event on Kafka and Solace without bridge idempotency | Double processing in hybrid consumers |

### Debugging scenario

**Observe.** Downstream service "sometimes never sees events" after broker migration.

**Diagnose.** Map producer destination type: Kafka topic name + partition; Rabbit exchange/binding/rk; Solace VPN + topic + subscription. Verify consumer subscription matches producer destination exactly (case-sensitive on Solace topics). For Rabbit, check **unroutable** returns. For Kafka, verify ACL `READ`/`WRITE` and `auto.create.topics.enable` didn't create wrong cluster topic.

**Fix.** Central registry of topic/queue contracts; integration tests with Testcontainers; mandatory publish confirms / `acks=all`.

---

## 2. Message Queues — Fundamentals

### Core concept

A message queue decouples **producers** from **consumers** in time and space. The producer does not need the consumer online. The broker buffers (within limits), routes, and optionally persists until consumed and acknowledged.

| Property | Meaning | Production impact |
|---|---|---|
| **Durability** | Survives broker restart | Non-durable = message loss on crash |
| **Visibility** | When another consumer can see the message | Prefetch, unacked state, Kafka offset not committed |
| **Competing consumers** | Multiple workers share load on one destination | Queue semantics; Kafka needs partition design |
| **Ordering** | FIFO within scope | Global vs per-key vs none |
| **Delivery guarantee** | At-most / at-least / exactly-once | Duplicates, loss, complexity |
| **Retention** | How long unconsumed messages live | Kafka days; Rabbit until ack; Solace spool + TTL |
| **Broker lifecycle** | Startup, fail-over, split-brain | Unclean election, mirror sync, VPN restart |

### Internal working — generic broker lifecycle

1. Producer connects, authenticates, serializes payload, sends to destination.
2. Broker validates ACL/VPN permissions, persists per policy (fsync varies).
3. Broker assigns ID: offset (Kafka), delivery tag (AMQP), spool id (Solace).
4. Delivery: **push** (RabbitMQ, Solace, JMS) or **pull** (Kafka).
5. Consumer processes; sends **ack** or **nack** / negative ack.
6. On ack: remove from queue (MQ) or advance offset (Kafka) or delete from spool (Solace guaranteed).
7. On nack / timeout / crash: **redeliver** (at-least-once) or **drop** (at-most-once).

```
Competing consumers (queue semantics):

Producer ──► [ Q: job1, job2, job3, job4 ] ──► Consumer A (job1)
                                           └──► Consumer B (job2)
                                           └──► Consumer C (job3)

Pub/sub (topic semantics):

Producer ──► Topic ──┬──► Subscriber 1 (all messages)
                     ├──► Subscriber 2 (all messages)
                     └──► Subscriber 3 (filtered by subscription)
```

### Production scenario: visibility timeout duplicates

**Problem.** Order fulfillment runs 90 seconds; RabbitMQ redelivers same message at 60s; duplicate shipments.

**Cause.** Consumer uses **auto-ack** or manual ack only at end; no heartbeat during long processing; `consumer_timeout` / TTL too aggressive.

**Solution.**

```java
@RabbitListener(queues = "fulfillment.jobs", ackMode = "MANUAL")
public void handle(Message message, Channel channel) throws IOException {
    long tag = message.getMessageProperties().getDeliveryTag();
    try {
        process(message); // idempotent on orderId
        channel.basicAck(tag, false);
    } catch (TransientException e) {
        channel.basicNack(tag, false, true); // requeue with backoff policy via DLX
    } catch (PermanentException e) {
        channel.basicNack(tag, false, false); // route to DLQ via dead-letter exchange
    }
}
```

Set `prefetch` to limit unacked in-flight per consumer. Extend consumer timeout or split long work into checkpointed steps.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Non-durable queue + transient messages | Vanish on broker restart |
| Auto-ack before handler completes | At-most-once loss on crash mid-process |
| Unbounded queue depth | Broker memory/disk alarm; cluster stall |
| No TTL on retry queues | Poison messages fill disk |
| High prefetch on slow consumers | Uneven work distribution; memory pressure |
| Shared queue for unrelated domains | One poison blocks all work types |

### Debugging scenario

**Observe.** Queue depth grows; consumers show as connected but idle.

**Diagnose.** RabbitMQ: `unacked` count high → stuck handlers. Kafka: consumer lag but low CPU → deserialization failure or blocked poll loop. Solace: **bind failure** or **No subscription match** on publish; check `solace/message/spool/usage` metrics.

**Fix.** Thread dump consumer pods; reduce prefetch; fix poison via DLQ; scale consumers within platform limits.

---

## 3. AMQP / RabbitMQ — Exchanges, Queues, Bindings

### Core concept

RabbitMQ implements **AMQP 0-9-1**. Producers never send directly to queues — they publish to an **exchange**. **Bindings** link exchanges to queues with routing rules. The **routing key** (and headers for header exchange) determines which queue(s) receive the message.

| Exchange type | Routing rule | Use case |
|---|---|---|
| **direct** | routing key exact match to binding key | Point-to-point, task routing by type |
| **topic** | routing key pattern (`*` one word, `#` zero+ words) | Multi-tenant, domain events |
| **fanout** | Ignores routing key — all bound queues | Broadcast notifications |
| **headers** | Match message headers to binding args | Complex routing without rk string |

Queue properties that matter in production:

| Property | Effect |
|---|---|
| `durable` | Queue metadata survives restart |
| `exclusive` | Only this connection; deleted on disconnect |
| `auto-delete` | Deleted when last consumer unsubscribes |
| `x-dead-letter-exchange` | Where rejected/expired messages go |
| `x-message-ttl` | Max time in queue before dead-letter |
| `x-max-length` | Cap queue size — drops or DLX |

**Quorum queues** (RabbitMQ 3.8+): Raft-replicated, safer than classic mirrored queues — preferred for new production workloads.

### Internal working — topic exchange routing

1. Producer publishes to exchange `order.events` with rk `order.placed.us`.
2. Exchange compares rk against each binding:
   - `order.placed.*` → matches (queue `payment-handler`)
   - `order.*.us` → matches (queue `us-audit`)
   - `order.cancelled.#` → no match
3. Message copies to all matching queues (fan-out within topic rules).
4. Each queue delivers to its consumer(s) independently.

```
                    ┌── binding: order.placed.* ──► queue: payment
Producer ──► exchange (topic)
                    ├── binding: order.*.us      ──► queue: us-audit
                    └── binding: #               ──► queue: analytics (careful!)
```

### Java / Spring Boot 3 example

```java
@Configuration
public class OrderRabbitConfig {

    public static final String EXCHANGE = "order.events";
    public static final String QUEUE_PAYMENT = "orders.payment";
    public static final String RK_PLACED = "order.placed";

    @Bean
    TopicExchange orderExchange() {
        return ExchangeBuilder.topicExchange(EXCHANGE).durable(true).build();
    }

    @Bean
    Queue paymentQueue() {
        return QueueBuilder.durable(QUEUE_PAYMENT)
            .withArgument("x-dead-letter-exchange", "order.dlx")
            .withArgument("x-dead-letter-routing-key", "order.payment.failed")
            .build();
    }

    @Bean
    Binding paymentBinding(Queue paymentQueue, TopicExchange orderExchange) {
        return BindingBuilder.bind(paymentQueue).to(orderExchange).with("order.placed.*");
    }

    @Bean
    RabbitTemplate rabbitTemplate(ConnectionFactory cf) {
        RabbitTemplate template = new RabbitTemplate(cf);
        template.setMessageConverter(new Jackson2JsonMessageConverter());
        template.setMandatory(true); // return unroutable to publisher
        template.setReturnsCallback(returned -> {
            log.error("Unroutable: rk={}, reply={}", returned.getRoutingKey(), returned.getReplyText());
        });
        return template;
    }
}

@Service
@RequiredArgsConstructor
public class OrderEventPublisher {
    private final RabbitTemplate rabbitTemplate;

    public void publishOrderPlaced(OrderPlacedEvent event, String region) {
        rabbitTemplate.convertAndSend(
            OrderRabbitConfig.EXCHANGE,
            "order.placed." + region,
            event,
            msg -> {
                msg.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                msg.getMessageProperties().setMessageId(event.eventId());
                return msg;
            });
    }
}
```

```yaml
spring:
  rabbitmq:
    host: rabbitmq.messaging.svc.cluster.local
    publisher-confirm-type: correlated
    publisher-returns: true
    listener:
      simple:
        acknowledge-mode: manual
        prefetch: 10
        default-requeue-rejected: false
```

### Production scenario: fanout exchange used for payment jobs

**Problem.** Three services bind to fanout `payment.events`. Each payment message processed three times — triple charges in staging (caught); would be production incident.

**Cause.** Fanout delivers **copy to every queue** — not competing consumers. Team wanted load balancing.

**Solution.** Use **one queue, multiple consumers** for competing work. Use fanout only when every subscriber must receive every message (audit, cache invalidation). For selective routing, use **topic** exchange.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `mandatory=false` + wrong binding | Silent message loss (unroutable dropped) |
| Classic mirrored queues in 3.13+ | Deprecated path; split-brain under failure |
| `#` binding on busy exchange | Accidental full firehose to analytics queue |
| DLX not configured | Infinite nack-requeue loops |
| Shared connection per message | Connection churn; publish latency spikes |

### Debugging scenario

**Observe.** Producer logs success; no consumer activity.

**Diagnose.** Management UI → Exchanges → publish rate vs queue rates. Check **Get messages** on queue (0 incoming). Verify binding key case sensitivity. Enable **firehose tracer** temporarily: `rabbitmqctl trace_on`.

**Fix.** Add binding; fix rk; enable mandatory + returns callback; add contract test.

---

## 4. JMS — Queue vs Topic, Durable Subscriptions, XA

### Core concept

**JMS** (Jakarta Messaging) is the Java API abstraction over brokers — ActiveMQ Artemis, IBM MQ, Solace JMS, HornetMQ. Spring wraps it via `JmsTemplate` and `@JmsListener`. Know JMS for legacy enterprise integrations and Solace JMS path.

| JMS destination | Semantics | Analogue |
|---|---|---|
| **Queue** | Point-to-point; competing consumers | RabbitMQ queue |
| **Topic** | Pub/sub; every active subscriber receives | Solace direct topic / Kafka multiple groups (loosely) |
| **Durable Topic Subscription** | Offline subscriber receives missed messages | Solace DTE / Kafka consumer group with retention |

**Durable subscription** = `(clientId, subscriptionName)` pair. Broker retains messages for durable subs even when subscriber offline (within retention). **Non-durable** topic sub: messages lost if not connected.

**XA (JTA)** = two-phase commit across DB + broker. Theoretically atomic; practically **slow, brittle, rarely worth it** in microservices. Prefer **outbox pattern** over XA.

### Internal working — durable topic subscription

1. Subscriber calls `createDurableSubscriber(topic, "inventory-updates")` with unique `clientId`.
2. Broker registers durable sub; spools messages for that sub name.
3. Subscriber disconnects — messages accumulate (subject to broker retention).
4. Reconnect with same `clientId` + sub name — receives backlog then live stream.
5. `unsubscribe()` deletes durable sub and **discards** pending messages.

### Java / Spring example

```java
@Configuration
@EnableJms
public class JmsConfig {

    @Bean
    DefaultJmsListenerContainerFactory topicFactory(ConnectionFactory cf) {
        DefaultJmsListenerContainerFactory factory = new DefaultJmsListenerContainerFactory();
        factory.setConnectionFactory(cf);
        factory.setPubSubDomain(true);
        factory.setSubscriptionDurable(true);
        factory.setClientId("inventory-service");
        factory.setSessionAcknowledgeMode(Session.CLIENT_ACKNOWLEDGE);
        return factory;
    }
}

@Component
public class ProductUpdateListener {

    @JmsListener(
        destination = "catalog/product/updated",
        containerFactory = "topicFactory",
        subscription = "inventory-product-updates")
    public void onProductUpdated(ProductUpdatedEvent event, Message message) throws JMSException {
        inventoryService.applyUpdate(event);
        message.acknowledge();
    }
}
```

### Production scenario: duplicate durable subscriptions after deploy

**Problem.** Every deploy creates new `clientId` with random UUID; durable subs multiply; disk fills; duplicate processing.

**Cause.** `clientId` must be **stable per logical consumer instance**, not per pod random. In K8s, use StatefulSet ordinal or fixed clientId with exclusive lock pattern.

**Solution.** Stable `clientId=inventory-service`; one active consumer per durable sub (scale via queue in Solace/Rabbit, not multiple durables on same name).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Random clientId per pod | Durable sub proliferation; spool bloat |
| CLIENT_ACK never called | Redelivery loops; poison buildup |
| XA without timeout tuning | Hung transactions; connection pool exhaustion |
| Topic listener without pubSubDomain=true | Consumes from queue named like topic — empty/wrong |
| AUTO_ACK on money path | At-most-once loss |

### Debugging scenario

**Observe.** JMS consumer receives nothing; JMS publisher shows no errors.

**Diagnose.** Confirm `pubSubDomain` matches destination type. Check durable sub name in broker admin console. Verify no duplicate clientId lock conflict (only one connection allowed per clientId in JMS spec).

**Fix.** Align factory config; use Solace PubSub+ manager to inspect DTE bindings.

---

## 5. Apache Kafka — Architecture, Brokers & KRaft

### Core concept

Kafka is a **distributed commit log**. A **cluster** has multiple **brokers**. Each broker hosts partition **leaders** and **followers**. Producers append; consumers pull. Metadata managed by **KRaft** (Kafka Raft) in modern deployments — replaces ZooKeeper (removed in Kafka 4.0).

| Component | Role |
|---|---|
| **Broker** | Stores partitions, serves produce/fetch requests |
| **Controller** | Manages partition leadership, ISR (KRaft quorum) |
| **Topic** | Named log split into partitions |
| **Partition** | Ordered, immutable sequence — **unit of parallelism** |
| **Replica** | Copy of partition on another broker for fault tolerance |
| **KRaft** | Raft-based metadata quorum; `process.roles=broker,controller` or separated |

**Partition = unit of parallelism.** More partitions → higher throughput ceiling and more consumer parallelism within one group. Cost: more file handles, longer leader election, rebalance overhead.

### Internal working — KRaft metadata path

1. KRaft controllers form quorum; one active controller leader.
2. Admin creates topic → metadata record in `__cluster_metadata` topic.
3. Controller assigns partition leaders across brokers (rack-aware if configured).
4. Brokers cache metadata; producers/consumers fetch metadata to find partition leaders.
5. On broker failure, controller elects new leader from ISR.

```
KRaft quorum (3 controllers):

  [Controller 1] ──raft── [Controller 2] ──raft── [Controller 3]
         │                      │
         └──── metadata ────────┴──► brokers (1..N) apply partition assignments
```

### Production KRaft configuration notes

```properties
# broker + controller combined (small/medium clusters)
process.roles=broker,controller
node.id=1
controller.quorum.voters=1@kafka-0:9093,2@kafka-1:9093,3@kafka-2:9093
log.dirs=/var/kafka/data

# production: separate controller nodes for large clusters
# process.roles=broker  (on data nodes)
# process.roles=controller  (on 3-5 dedicated nodes)
```

### Production scenario: broker disk full — cluster read-only

**Problem.** All producers fail; consumers stall; `LOG_DIR_EVENT` errors in logs.

**Cause.** Retention too long × high throughput; no tiered storage; compaction not running; consumer lag unbounded.

**Solution.** Alert at 70% disk; tiered storage for cold segments; reduce `retention.ms`; increase disk; `kafka-log-dirs.sh --describe` per broker. Never ignore `under-replicated partitions` — often precedes disk/IO issues.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Too few controllers (1) | No metadata fault tolerance |
| `auto.create.topics.enable=true` in prod | Accidental topics with defaults (1 partition, RF=1) |
| Uneven partition leadership | Hot broker; skewed network/disk |
| `log.retention.bytes` unbounded | Disk exhaustion |
| Missing rack awareness | AZ failure loses all replicas |

### Debugging scenario

**Observe.** `LEADER_NOT_AVAILABLE` on produce after rolling restart.

**Diagnose.** `kafka-topics.sh --describe`; check ISR count; controller logs. Wait for leader election; verify min ISR (`min.insync.replicas`).

**Fix.** Ensure RF ≥ 3, `min.insync.replicas=2`, `acks=all` on producers.

---

## 6. Kafka Topics Deep Dive — Naming, Partitions & Keys

### Core concept

Topic design is **permanent architecture** — partition count is costly to change (rebalance all keys). Name topics for humans, ACLs, and metrics — not for Java class names alone.

**Naming conventions (production):**

```
<domain>.<entity>.<event>[.<version>]

Examples:
  commerce.order.placed.v1
  commerce.order.payment-captured.v1
  platform.audit.user-login.v1
  __debezium.inventory.public.products  (CDC — internal)
```

Rules:

- Lowercase, dot-separated (or env prefix: `prod.commerce.order.placed`)
- Avoid generic names (`events`, `notifications`)
- Version suffix when breaking schema (`v1`, `v2`) — or use schema registry compatibility
- Internal topics: prefix `__` or `internal.` (retry, DLT, connect offsets)

**Partition count planning:**

| Factor | Guidance |
|---|---|
| Target throughput | More partitions → more parallel IO |
| Consumer parallelism | Max consumers in group ≤ partition count |
| Ordering needs | Per-key order requires all keys for aggregate in one partition |
| Rebalance cost | 10× partitions = longer rebalance (mitigate with cooperative assignor) |
| Broker limits | ~4000 partitions/broker soft guidance (varies by hardware) |

Formula starting point: `partitions = max(target_throughput / single_consumer_throughput, consumer_instances)`.

**Message keys:**

- **Null key**: round-robin partition assignment — no ordering guarantee.
- **Key set**: `hash(key) % numPartitions` — all messages with same key → same partition → order per key.
- **Custom partitioner**: rare; geographic routing, priority lanes.

```java
// Explicit key for order lifecycle ordering
kafkaTemplate.send("commerce.order.events.v1", order.getOrderId(), event);

// Producer config
props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
props.put(ProducerConfig.PARTITIONER_CLASS_CONFIG, DefaultPartitioner.class);
props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
```

### Internal working — partition assignment on produce

1. Producer receives record with optional key.
2. If key present: `partition = murmur2(key) % numPartitions` (sticky batching may stick to partition until batch full).
3. Producer sends to leader of chosen partition.
4. Record appended with monotonic offset in partition.
5. Consumer in group assigned this partition reads in offset order.

### Production scenario: 6 partitions, 12 consumers — half idle

**Problem.** Team scales consumers to 12; CPU flat; lag persists.

**Cause.** Consumer count exceeds partition count — extras idle by design.

**Solution.** Increase partitions (plan key impact — may reorder per-key during migration) OR accept 6-way parallelism. Alternative: second consumer group for different processing path (not load sharing).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| 1 partition on high-throughput topic | Bottleneck; single consumer |
| Key changes mid-lifecycle (`orderId` → `customerId`) | Ordering breaks for same aggregate |
| Too many partitions (500+) on small cluster | Rebalance storms; metadata bloat |
| Topic per microservice per event type explosion | Operational nightmare; use domain topics + headers |
| RF=1 in production | Data loss on broker failure |

### Debugging scenario

**Observe.** Same `orderId` events processed out of order.

**Diagnose.** Verify all related event types use **same key** and **same topic** (or accept cross-topic ordering gap). Check multiple producer instances with different key extraction bugs. Inspect partition assignment: `kafka-console-consumer --property print.key=true`.

**Fix.** Standardize key; consolidate topic; add version field in payload for application-level ordering.

---

## 7. Kafka Retention, Compaction, Tiered Storage & ACLs

### Core concept

Kafka retains messages based on **time**, **size**, or **compaction** policy — independent of consumption.

| Policy | Config | Behavior |
|---|---|---|
| Time retention | `retention.ms` | Delete segments older than threshold |
| Size retention | `retention.bytes` | Per-partition size cap |
| Compaction | `cleanup.policy=compact` | Keep latest record per key; tombstone deletes |
| Delete + compact | `compact,delete` | Compact then apply time retention |
| Tiered storage | `remote.storage.enable` | Old segments to S3/Azure/GCS; local disk relief |

**Compaction** use cases: changelog topics (KTables), connector offsets, config stores. **Not** for unbounded unique-key events (every key stays forever until tombstoned).

**Tiered storage:** hot data local, cold in object store. Fetch latency increases for old offsets — fine for replay/compliance, not hot path.

**ACLs** (when `authorizer.class.name` enabled):

| Operation | Principal needs |
|---|---|
| Produce | `WRITE` on topic |
| Consume | `READ` on topic + `READ` on consumer group |
| Admin | `CREATE`, `ALTER`, `DESCRIBE` as appropriate |

Use **prefix ACLs** for team namespaces: `commerce.order.*`.

### Compaction internal working

1. Cleaner thread scans log segments.
2. For each key, retains latest offset value.
3. Tombstone (null value) with `delete.retention.ms` removes key entirely.
4. Head segment never compacted (active writes).

### Production scenario: compacted topic disk still growing

**Problem.** `user-preferences` compacted topic grows unbounded.

**Cause.** Unique key per event (sessionId) instead of userId; no tombstones on delete.

**Solution.** Key = `userId`; publish tombstone on account deletion; set `min.cleanable.dirty.ratio` tuning; audit producer key strategy.

### Tiered storage configuration

Tiered storage offloads closed segments to object storage while keeping hot tail local:

```properties
# server.properties (Kafka 3.6+ with Tiered Storage feature flag)
remote.storage.enable=true
remote.log.storage.system.enable=true
remote.log.manager.task.interval.ms=30000
rsm.config.storage.backend.class=org.apache.kafka.server.log.remote.storage.storage.LocalTieredStorage
# Production: S3 / Azure / GCS implementation class from vendor or Confluent
log.local.retention.ms=604800000   # 7 days hot on broker disk
log.local.retention.bytes=107374182400  # 100 GB per partition local cap
```

**Operational notes:**

- Fetch from tier has higher latency — acceptable for compliance replay, not real-time hot consumers.
- Monitor `RemoteLogManager` metrics: copy lag, metadata topic health.
- Disaster recovery: ensure object store lifecycle policies align with compliance retention (7 years audit vs 7 days hot).
- Compacted topics with tiered storage: compaction still runs locally before remote copy.

### ACL example

```bash
kafka-acls.sh --bootstrap-server $BS \
  --add --allow-principal User:order-service \
  --operation Write --topic commerce.order.events.v1

kafka-acls.sh --bootstrap-server $BS \
  --add --allow-principal User:order-service \
  --operation Read --group order-service-consumer

# Prefix ACL for team namespace
kafka-acls.sh --bootstrap-server $BS \
  --add --allow-principal User:commerce-team \
  --operation All --topic commerce. \
  --resource-pattern-type PREFIXED
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `retention.ms` < lag recovery time | Messages deleted before consumer catches up |
| Compaction on high-cardinality keys | Disk bloat; slow compaction |
| Tiered storage without local cache budget | Fetch timeouts on replay |
| Missing group ACL | `GroupAuthorizationFailedException` |
| `allow.everyone.if.no.acl.found=true` in prod | Security incident waiting |

### Debugging scenario

**Observe.** Consumer suddenly jumps to latest; missing historical events.

**Diagnose.** Retention deleted old segments — check `retention.ms`, log start offset vs consumer committed offset. `kafka-log-dirs.sh` segment timestamps.

**Fix.** Increase retention; tiered storage; replay from archive; never reset prod offsets without runbook.

---

## 8. Kafka Replication, ISR & Leader Election

### Core concept

Each partition has one **leader** and N-1 **followers**. Producers/consumers talk to leader. Followers replicate. **ISR** (In-Sync Replicas) = replicas caught up within `replica.lag.time.max.ms`.

| Setting | Meaning |
|---|---|
| `replication.factor` | Total copies (3 in prod) |
| `min.insync.replicas` | Min ISR for acked produce (`acks=all`) |
| `unclean.leader.election.enable` | Allow non-ISR leader (data loss risk) — **false in prod** |
| `leader.replication.throttled.replicas` | Limit replication bandwidth during recovery |

**Leader election:** on leader failure, controller picks new leader from ISR. If ISR empty and unclean disabled → partition **offline** (preferable to data loss).

**Unclean election risk:** promote out-of-sync replica → **loses committed messages** that weren't replicated. Only enable with explicit acceptance of data loss.

### Internal working — produce with `acks=all`

1. Producer sends batch to leader.
2. Leader appends to local log.
3. Followers fetch and replicate.
4. Followers send ack to leader.
5. When all ISR ack (or `min.insync.replicas` met per broker config): leader responds to producer.
6. If ISR shrinks below min ISR: produce fails — **correct behavior**.

### Production scenario: under-replicated partitions during broker maintenance

**Problem.** Rolling broker restart; `UnderReplicatedPartitions` metric spikes; produce latency p99 5s.

**Cause.** Normal during rebalance; problematic if sustained — slow disk, network, or one follower stuck.

**Solution.** `kafka-reassign-partitions` for balance; verify disk IO; `kafka-topics.sh --describe --under-replicated-partitions`. Use `cruise-control` for automated rebalance. Maintenance: `kafka-configs --alter --add-config leader.replication.throttled.replicas=...` to throttle.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| RF=2, min ISR=2 | Produce fails when any broker down |
| unclean leader election enabled | Mysterious "lost" events after fail-over |
| All partitions on one broker | Single point of failure despite RF |
| No rack awareness | AZ outage loses quorum of replicas |

### Debugging scenario

**Observe.** `NOT_ENOUGH_REPLICAS` / `NOT_ENOUGH_REPLICAS_AFTER_APPEND`.

**Diagnose.** ISR size vs `min.insync.replicas`. Broker offline? Network partition?

**Fix.** Restore broker; increase ISR; never lower min ISR as "quick fix" without understanding loss risk.

---

## 9. Consumer Groups, Offsets & Rebalance

### Core concept

A **consumer group** (`group.id`) is a set of consumers cooperating on one topic. Each partition assigned to **at most one** consumer in the group. Different groups each consume independently — payment and analytics both read `commerce.order.events.v1`.

**Offsets** stored in `__consumer_offsets` (compact topic) — committed offset = "processed up to here."

| Commit mode | Semantics |
|---|---|
| Auto commit (default) | At-most-once risk — commit before process |
| Sync manual commit | After process — at-least-once |
| Async manual commit | Faster; ordering of commits matters |

**Rebalance** triggers: consumer join/leave, partition count change, subscription change, session timeout.

Classic rebalance: **stop-the-world** — all consumers revoke all partitions, redistribute, restart. Causes duplicate processing and latency spikes.

### Internal working — offset commit flow

1. Consumer polls records for assigned partitions.
2. Processes batch (ideally idempotent).
3. Calls `commitSync()` or `commitAsync()` with offset N+1.
4. Group coordinator writes offset to `__consumer_offsets`.
5. On rebalance, new assignee starts from committed offset.

```java
@KafkaListener(topics = "commerce.order.placed.v1", groupId = "payment-service")
public void listen(ConsumerRecord<String, OrderPlacedEvent> record, Acknowledgment ack) {
    paymentService.charge(record.value());
    ack.acknowledge(); // manual commit after success
}
```

```yaml
spring:
  kafka:
    consumer:
      group-id: payment-service
      enable-auto-commit: false
      auto-offset-reset: earliest  # only for new groups — understand implications
      isolation-level: read_committed  # if transactional producer
    listener:
      ack-mode: manual
      concurrency: 3  # threads ≤ partitions assigned to this instance
```

### Production scenario: lag grows after every deploy

**Problem.** Payment consumer lag spikes 10 minutes on every K8s rollout; duplicate charges in idempotency gap.

**Cause.** Rebalance during rolling deploy; revoked partitions reprocessed before commit; `max.poll.interval.ms` exceeded on long processing.

**Solution.** Cooperative sticky assignor (Section 10); static membership; idempotency keys; graceful shutdown hook; right-size `max.poll.interval.ms`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Same group.id in dev and staging pointing to prod cluster | Cross-env offset corruption |
| auto-commit on financial paths | Lost messages on crash |
| concurrency > partitions per instance | Idle threads; misleading scaling |
| `auto-offset-reset=latest` on new group | Silent skip of backlog |
| Long GC pauses > session.timeout.ms | Constant rebalance |

### Debugging scenario

**Observe.** One partition lagging while others fine.

**Diagnose.** Hot key → one partition overloaded. Slow message on that partition blocks sequential processing. `kafka-consumer-groups --describe --group X` — per-partition lag.

**Fix.** Split hot key handling; async side effects; increase partitions (plan migration); optimize slow handler.

---

## 10. Cooperative Sticky Assignor & Static Membership

### Core concept

**Cooperative sticky assignor** (`CooperativeStickyAssignor`): incremental rebalance — only **revoked partitions that must move**, not all. Reduces stop-the-world pause and duplicate processing window.

**Static membership** (`group.instance.id`): consumer rejoins with same instance id — **no rebalance** on brief restart (session timeout permitting). K8s: stable instance id from StatefulSet or configured UUID in config map per pod ordinal.

```properties
partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor
group.instance.id=payment-service-pod-0
session.timeout.ms=45000
heartbeat.interval.ms=15000
```

Spring Kafka enables cooperative by default in recent versions via `AbstractCooperativeAssignor`.

### Internal working — cooperative vs eager

**Eager (Range/RoundRobin):**

1. All consumers revoke all partitions.
2. Coordinator computes new assignment.
3. All consumers resume — gap where no one consumes some partitions.

**Cooperative:**

1. Coordinator identifies partitions needing migration.
2. Subset revoked from leaving consumer only.
3. Remaining consumers keep processing other partitions.
4. Second rebalance phase assigns revoked partitions.

### Production scenario: 500-partition topic, deploy causes 2-minute consume pause

**Problem.** Full rebalance on every scale event; SLA breach.

**Solution.** Switch to cooperative sticky; static membership for stateful consumers; reduce partition count if excessive; `max.poll.records` tuning to finish polls faster.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Mixed assignors in same group | Rebalance protocol errors |
| Duplicate group.instance.id | Consumer fencing; unstable assignment |
| session.timeout too low for processing | False-positive failure detection |

### Debugging scenario

**Observe.** `IllegalGenerationException` / constant rebalance logs.

**Diagnose.** Processing time exceeds `max.poll.interval.ms`. Thread dump for blocked consumer. Check cooperative protocol support on all client versions.

**Fix.** Increase intervals; optimize handler; cooperative assignor; fewer records per poll.

---

## 11. Kafka Topic Patterns — Main/Retry/DLT, CDC, Changelog

### Core concept

Production Kafka architectures use **topic topology patterns**, not single topics per handler.

**Main / Retry / DLT pattern:**

```
commerce.order.placed.v1          (main)
commerce.order.placed.v1-retry-0  (30s delay)
commerce.order.placed.v1-retry-1  (5m delay)
commerce.order.placed.v1-dlt      (poison / manual review)
```

Spring `@RetryableTopic` automates multi-topic retry with backoff and DLT.

**CDC (Change Data Capture):**

- Debezium reads DB WAL → Kafka topics (`server.schema.table`)
- Consumers treat as event source; ordering per table primary key
- Schema evolution via registry; tombstones on DELETE

**Changelog / compacted topics:**

- Kafka Streams state stores, `KTable` materialization
- Connector offset/config topics
- Latest-value cache pattern for reference data

### Spring RetryableTopic example

```java
@RetryableTopic(
    attempts = "4",
    backoff = @Backoff(delay = 30_000, multiplier = 2.0),
    dltStrategy = DltStrategy.FAIL_ON_ERROR,
    include = {TransientPaymentException.class},
    topicSuffixingStrategy = TopicSuffixingStrategy.SUFFIX_WITH_INDEX_VALUE)
@KafkaListener(topics = "commerce.order.placed.v1", groupId = "payment-service")
public void onOrderPlaced(OrderPlacedEvent event) {
    paymentGateway.charge(event);
}

@DltHandler
public void onDlt(OrderPlacedEvent event, @Header(KafkaHeaders.EXCEPTION_MESSAGE) String error) {
    alertOps(event.orderId(), error);
    dltRepository.save(event);
}
```

### CDC production notes

```yaml
# Debezium connector excerpt
connector.class: io.debezium.connector.postgresql.PostgresConnector
database.server.name: inventory
table.include.list: public.products,public.stock
transforms: unwrap
transforms.unwrap.type: io.debezium.transforms.ExtractNewRecordState
```

Consumers must handle: **CREATE/UPDATE/DELETE** op field; out-of-order across tables; initial snapshot vs streaming.

**CDC consumer example (Debezium envelope):**

```java
@KafkaListener(topics = "inventory.public.products", groupId = "catalog-sync")
public void onProductChange(ConsumerRecord<String, String> record) {
    JsonNode payload = objectMapper.readTree(record.value());
    String op = payload.path("op").asText(); // c=create, u=update, d=delete, r=snapshot read

    if ("d".equals(op)) {
        JsonNode before = payload.path("before");
        catalogCache.evict(before.path("id").asLong());
        return;
    }
    JsonNode after = payload.path("after");
    if (after.isMissingNode()) return;

    Product product = mapToProduct(after);
    // Idempotent upsert — snapshot (r) and update (u) both land here
    catalogRepository.upsert(product.id(), product, payload.path("source").path("ts_ms").asLong());
}
```

**Changelog topic for reference data:**

```bash
# Compact topic for latest product state per SKU — not the CDC raw topic
kafka-topics.sh --create --topic catalog.products.changelog.v1 \
  --partitions 12 --replication-factor 3 \
  --config cleanup.policy=compact \
  --config min.cleanable.dirty.ratio=0.5 \
  --config segment.ms=604800000
```

### Production scenario: retry topic storm amplifies outage

**Problem.** Payment gateway down; every message retries 4× across topics; Kafka disk and consumer CPU 10× normal; recovery takes hours after gateway fix.

**Cause.** No circuit breaker on retry consumer; unlimited retry fan-out.

**Solution.** Circuit breaker in handler; pause consumption via `listenerContainer.pause()`; exponential backoff with max; DLT quickly on known permanent errors; rate-limit retry consumption.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Retry topics same retention as main | Disk waste on poison |
| DLT without monitoring | Silent data loss path |
| CDC consumer assumes only INSERT | Missed deletes; stale cache |
| Shared retry topic across event types | Wrong backoff semantics |

### Debugging scenario

**Observe.** Messages in DLT but handler "works fine" locally.

**Diagnose.** Deserialization mismatch on retry topic headers; exception type not in `include` list — fails immediately to DLT. Check `@Header(KafkaHeaders.EXCEPTION_STACKTRACE)`.

**Fix.** Align serializers; broaden transient exceptions; add DLT replay tooling with idempotency.

---

## 12. Kafka Production Scenarios & Failure Catalog

This section is a **field guide** to Kafka incidents — grouped by symptom class. Every scenario follows the same production layout used elsewhere in this note: **observe → diagnose → fix → prevent**. If you have seen one of these in staging, assume it will happen in prod at 3× traffic.

### Incident taxonomy — what breaks and where

| Symptom class | Usually points to | First check |
|---|---|---|
| **Publish failures** | Producer config, ISR, ACL, message size | Producer logs, `NOT_ENOUGH_REPLICAS`, `RecordTooLargeException` |
| **Growing lag** | Slow handler, hot partition, too few partitions | Per-partition lag, consumer CPU, `max.poll.interval` |
| **Duplicates** | Rebalance, retry, at-least-once without dedup | Deploy timeline, offset commit mode, idempotency store |
| **Lost messages** | At-most-once, retention < lag, unclean election | `acks`, auto-commit, log start offset vs committed |
| **Out-of-order** | Key change, multiple partitions, retry topics | Key extraction, partition assignment |
| **Cluster instability** | Disk, controller, network, JVM GC on broker | Broker metrics, controller logs, under-replicated partitions |
| **Poison / DLT flood** | Bad deploy, schema break, downstream always fails | DLT rate, exception type, first failing offset |

### Producer failures

#### Scenario P1: `RecordTooLargeException` after payload "slightly grew"

**Observe.** Order export job fails on publish; smaller orders succeed.

**Cause.** Payload exceeded `message.max.bytes` (broker) or `max.request.size` (producer). Common after adding nested line items, PDF metadata, or debug fields to JSON events.

**Diagnose.**

```bash
kafka-configs.sh --bootstrap-server $BS --entity-type topics --entity-name commerce.order.placed.v1 --describe
# message.max.bytes, max.message.bytes
```

**Fix.** Trim payload (reference by ID); compress (`compression.type=zstd`); split event; raise limits consistently on broker + producer + consumer `fetch.max.bytes`. **Never** raise limits alone without end-to-end alignment.

#### Scenario P2: `NOT_ENOUGH_REPLICAS` spike during broker rolling restart

**Observe.** Payment publisher error rate 100% for 2–5 minutes during node drain.

**Cause.** ISR shrunk below `min.insync.replicas` while followers catch up; `acks=all` correctly rejects writes.

**Fix.** Rolling restart with one broker at a time; verify ISR recovery before next node; `replication.factor=3`, `min.insync.replicas=2`. **Do not** lower `min.insync.replicas` as a permanent fix — that trades away durability.

#### Scenario P3: Duplicate events after producer "retry fix"

**Observe.** Finance reconciliation finds 0.3% double charges after enabling `retries=10` without idempotence.

**Cause.** Producer retried successful batches; broker received duplicates with new sequence numbers when idempotence disabled.

**Fix.**

```properties
enable.idempotence=true
acks=all
retries=2147483647
max.in.flight.requests.per.connection=5
```

Application-level `eventId` dedup still required for **intentional** republish and consumer retries.

#### Scenario P4: Producer latency p99 8s — `buffer.memory` exhausted

**Observe.** Threads block in `KafkaProducer.send()`; heap fine; broker idle.

**Cause.** `buffer.memory` too small for burst; `max.block.ms` high so app threads stall instead of failing fast.

**Fix.** Increase `buffer.memory` and `batch.size`; async send with callback + bounded internal queue; backpressure at API layer when publish queue fills.

#### Scenario P5: Wrong partition — all traffic on partition 0

**Observe.** Single broker disk 95%; others 20%; one consumer pod at 100% CPU.

**Cause.** Constant key (`"default"`), null key with sticky batching stuck on one partition, or custom partitioner bug.

**Diagnose.**

```bash
kafka-console-consumer.sh --bootstrap-server $BS --topic commerce.order.events.v1 \
  --property print.partition=true --property print.key=true --max-messages 100
```

**Fix.** Key by `orderId` / `customerId`; salt only when accepting per-shard ordering loss.

### Consumer failures

#### Scenario C1: `max.poll.interval.ms` exceeded — rebalance loop

**Observe.** Consumer logs: `Revoking previously assigned partitions`; duplicate processing; lag oscillates.

**Cause.** Handler does HTTP + DB per record; batch of 500 records exceeds interval; consumer considered dead.

**Fix.**

```yaml
spring.kafka.consumer:
  max-poll-records: 10
  max-poll-interval-ms: 600000
spring.kafka.listener:
  type: batch
  ack-mode: manual
```

Optimize handler; or process async with bounded worker pool **after** ack strategy is designed (ack early only if safe).

#### Scenario C2: `OffsetOutOfRangeException` after retention trim

**Observe.** New consumer group crashes on start; `auto-offset-reset` not helping existing group.

**Cause.** Committed offset points to deleted segment — retention passed while consumer was down for weeks.

**Fix.** `kafka-consumer-groups.sh --reset-offsets --to-datetime` (maintenance window) or `--to-earliest` with idempotent replay. Alert when lag age approaches `retention.ms - safety_margin`.

#### Scenario C3: Zombie consumer — lag never clears

**Observe.** Lag shows 2M; only 3 consumers in group; 8 pods running.

**Cause.** Five pods have **different `group.id`** (typo in env var) — each reads full topic; "lag" metric aggregates confusion. Or static `group.instance.id` collision — only one instance truly active.

**Diagnose.**

```bash
kafka-consumer-groups.sh --bootstrap-server $BS --list
kafka-consumer-groups.sh --bootstrap-server $BS --describe --group payment-service --members --verbose
```

**Fix.** Single `group.id` via config server; unique `group.instance.id` per pod ordinal; CI test asserts env vars.

#### Scenario C4: Cooperative rebalance stuck — `RebalanceInProgressException`

**Observe.** Consumers pause processing for minutes after single pod crash.

**Cause.** Mixed client versions — some lack cooperative protocol; fallback to eager revoke-all.

**Fix.** Align broker + client versions; `partition.assignment.strategy=CooperativeStickyAssignor` on all consumers; upgrade Spring Kafka to version matching broker.

#### Scenario C5: `CommitFailedException` / `generation id` mismatch

**Observe.** Sparse errors during deploy; some messages processed twice.

**Cause.** Rebalance between `poll()` and `commitSync()` — generation invalidated.

**Fix.** Idempotent handler; cooperative assignor; retry commit on `CommitFailedException`; Spring `AcknowledgingMessageListener` with proper ack after process.

#### Scenario C6: Deserialization failure — silent skip misconfigured

**Observe.** "Consumer healthy" but 5% of orders never charged; no DLQ.

**Cause.** `ErrorHandlingDeserializer` not configured; default error handler logs and **seeks past** offset or stops container depending on version/config.

**Fix.**

```java
@Bean
ConsumerFactory<String, OrderPlacedEvent> consumerFactory() {
    Map<String, Object> props = kafkaProperties.buildConsumerProperties(null);
    props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, ErrorHandlingDeserializer.class);
    props.put(ErrorHandlingDeserializer.VALUE_DESERIALIZER_CLASS, JsonDeserializer.class);
    props.put(JsonDeserializer.TRUSTED_PACKAGES, "com.acme.events");
    return new DefaultKafkaConsumerFactory<>(props);
}

@Bean
DefaultErrorHandler errorHandler(KafkaTemplate<String, byte[]> template) {
  DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(template);
  DefaultErrorHandler handler = new DefaultErrorHandler(recoverer, new FixedBackOff(1000L, 3));
  handler.addNotRetryableExceptions(ValidationException.class);
  return handler;
}
```

### Broker and cluster failures

#### Scenario B1: Single broker hot — leader skew

**Observe.** `kafka-0` network 10 Gbps; `kafka-1`/`kafka-2` idle; uneven CPU.

**Cause.** Poor partition assignment; all high-traffic partition leaders on one broker; no `leader.rebalance` after expansion.

**Fix.** `kafka-leader-election.sh --election LEADER` after adding brokers; rack-aware assignment `broker.rack`; periodic preferred leader election.

#### Scenario B2: Controller failover — metadata unavailable

**Observe.** `TimeoutException` on metadata fetch; producers cannot create topics; admin operations fail.

**Cause.** KRaft quorum lost majority; or ZooKeeper session expired (legacy).

**Diagnose.** Controller logs; `kafka-metadata.sh --snapshot` (KRaft); verify 3+ controllers healthy.

**Fix.** Restore quorum nodes; never run single-controller production; staged controller upgrades.

#### Scenario B3: Log segment corruption — `CorruptRecordException`

**Observe.** One partition consumer fails consistently at offset 4,892,001; others fine.

**Cause.** Disk corruption, incomplete segment write during crash, or manual log dir tampering.

**Fix.** Restore partition from replica; if ISR corrupted, restore from backup; **truncate** only with explicit data-loss approval. Replace broker disk if hardware fault.

#### Scenario B4: Network partition — split produce/consume

**Observe.** Producers to cluster A succeed; consumers on cluster B read stale data — "split brain" mirror misconfiguration.

**Cause.** MirrorMaker 2 lag; wrong `bootstrap.servers` in one region; DNS failover to wrong cluster.

**Fix.** Monitor MM2 lag; consumer `bootstrap.servers` from config service; fencing writes to active region.

#### Scenario B5: `log.cleaner` IO saturation — compaction never completes

**Observe.** Compacted changelog topic disk grows; consumers slow on startup (reading dirty segments).

**Cause.** `min.cleanable.dirty.ratio` too high; cleaner threads starved; too many compacted topics on same broker.

**Fix.** Lower `min.cleanable.dirty.ratio`; dedicated brokers for compacted workloads; increase `log.cleaner.threads`.

### Performance and capacity

#### Scenario K1: Fetch lag — consumers can't keep up despite low CPU

**Observe.** Consumer CPU 30%; lag grows; broker `network` saturated.

**Cause.** `fetch.min.bytes` / `fetch.max.wait.ms` mismatch; consumers fetch tiny batches; compression not enabled on producer.

**Fix.** Producer `compression.type=zstd`; consumer `fetch.min.bytes=65536`; increase `max.partition.fetch.bytes` within memory limits.

#### Scenario K2: Consumer group exceeds partition count — false scaling

**Observe.** HPA scales to 20 pods; lag unchanged; cost 4×.

**Cause.** Topic has 6 partitions — max 6 active consumers in group.

**Fix.** Increase partitions (planned migration); or accept parallelism ceiling; second consumer group only if different processing path (not load sharing).

#### Scenario K3: Large message + gzip — CPU bound on broker

**Observe.** Broker CPU 90% after enabling gzip on multi-MB payloads.

**Cause.** Compression on huge messages is expensive; clients decompress on fetch.

**Fix.** Move blobs to S3; event carries reference; or use lz4/zstd on small JSON only.

#### Scenario K4: `__consumer_offsets` compaction lag

**Observe.** Coordinator slow; rebalance takes minutes on large clusters.

**Cause.** Millions of consumer groups (test env pollution); offset commit storm from per-record commit.

**Fix.** Batch commits; delete stale groups; separate test cluster; `offsets.retention.minutes` tuning.

### Operations, upgrades, and tooling

#### Scenario O1: Rolling upgrade — `ApiVersionsRequest` failure

**Observe.** Old clients cannot connect after broker upgrade.

**Cause.** Broker dropped old API version; client library ancient.

**Fix.** Upgrade clients first (forward compatible); read Kafka upgrade notes; test in staging with production client versions.

#### Scenario O2: Partition reassignment — hours of under-replication

**Observe.** `kafka-reassign-partitions` started; cluster degraded for hours.

**Cause.** Moving too many partitions simultaneously; throttle too high; disk bandwidth exhausted.

**Fix.** `throttled.replication.quota`; reassign in batches; monitor `UnderReplicatedPartitions`.

#### Scenario O3: Topic delete blocked — `markPartitionForDeletion`

**Observe.** Deleted topic reappears; disk not freed.

**Cause.** Topic still referenced by connector; auto-create recreates; delete in progress stuck.

**Fix.** `kafka-topics.sh --delete`; verify no producers still writing; disable auto-create; check `log.delete.delay.ms`.

#### Scenario O4: Kafka Connect — task failed, consumer group offset stuck

**Observe.** Connector RUNNING but task FAILED; sink stopped; DB stale.

**Cause.** Sink SQLException; converter error; rebalance in connect worker group.

**Fix.** Connect REST status; worker logs; restart task; DLQ for connect (`errors.tolerance=all` only with dead letter queue configured).

### Security and multi-tenant

#### Scenario S1: `TopicAuthorizationException` after ACL rollout

**Observe.** Producers fail in prod; staging works.

**Cause.** ACL allows `WRITE` on topic but not `DESCRIBE` / `CREATE` on cluster; or wrong principal (`User:CN=...` vs `User:service-account`).

**Fix.** `kafka-acls.sh --list`; mirror staging ACL pattern; use ACL operator / GitOps for ACLs.

#### Scenario S2: SASL handshake timeout during K8s rollout

**Observe.** Brief auth failures when pods start before secrets mounted.

**Cause.** Init container ordering; expired credential rotation.

**Fix.** Readiness probe after successful metadata fetch; external secrets rotation with overlap window.

### Spring Kafka–specific production issues

#### Scenario SK1: `@KafkaListener` not firing — wrong `autoStartup`

**Observe.** Bean exists; no consumption; no errors.

**Cause.** `autoStartup=false`; profile-gated listener; missing `@EnableKafka`.

**Fix.** `KafkaListenerEndpointRegistry` start; actuator `/actuator/kafkalistener` (if exposed).

#### Scenario SK2: Transactional producer + `@Transactional` DB — double failure mode

**Observe.** DB commits; Kafka send rolls back; or vice versa.

**Cause.** Kafka transaction not in same failure domain as DB — not true XA.

**Fix.** Outbox pattern; or accept Kafka EOS only for Kafka→Kafka pipelines.

#### Scenario SK3: `RetryableTopic` headers break non-Spring consumer

**Observe.** Analytics consumer on retry topic crashes on binary headers.

**Cause.** Spring adds `kafka_exception-stacktrace`, `kafka_dlt-original-consumer-group` headers.

**Fix.** Retry topics consumed only by Spring listeners; or header filter in analytics consumer.

### Kafka incident response checklist

1. **Stop amplifying damage** — pause retry consumers, circuit-break downstream calls, disable auto-replay jobs.
2. **Preserve evidence** — export offsets, sample failing records (hex if binary), broker metric snapshot.
3. **Classify data risk** — loss vs duplicate vs delay; money path gets priority.
4. **Fix forward** — patch handler, schema, or config; do not reset offsets until understood.
5. **Replay safely** — new consumer group or timestamp reset with rate limit + idempotency.
6. **Post-incident** — add alert on lag age, DLT rate, ISR size, publish error rate; runbook link in dashboard.

### Master misconfiguration table — Kafka production

| Misconfiguration | Symptom | Fix |
|---|---|---|
| `acks=1` or `acks=0` on money events | Silent loss on broker crash | `acks=all`, `min.insync.replicas=2` |
| `enable.auto.commit=true` | Lost or duplicate under crash | Manual ack after success |
| `auto.create.topics.enable=true` | RF=1 accidents | Disable; IaC for topics |
| `replication.factor=1` | Total loss on single broker death | RF=3 minimum prod |
| No idempotence + high retries | Producer duplicate storm | `enable.idempotence=true` |
| `max.poll.records` too high | Rebalance loop | Lower records; tune interval |
| Same key for all events | Hot partition | Proper key extraction |
| Retention < max outage recovery time | Offset out of range; data gone | Retention ≥ recovery SLA + lag buffer |
| `unclean.leader.election.enable=true` | Truncated log / "vanished" events | Disable unclean election |
| JSON without Schema Registry | Schema drift breaks consumers | Avro + compatibility CI |
| Per-record DB commit in listener | Throughput ceiling; connection pool exhaustion | Batch + idempotent upsert |
| Ignoring `consumer lag` alerts | Data loss when retention catches lag | Alert on lag age not just size |
| MirrorMaker without lag alert | Region serves stale events | MM2 lag metric + paging |

### Debugging scenario — end-to-end lag hunt

**Observe.** Payment lag 500k; business reports unpaid orders.

**Diagnose (ordered):**

```bash
# 1. Group health
kafka-consumer-groups.sh --bootstrap-server $BS --describe --group payment-service --members --verbose

# 2. Per-partition lag
kafka-consumer-groups.sh --bootstrap-server $BS --describe --group payment-service

# 3. Log end vs committed
kafka-get-offsets.sh --bootstrap-server $BS --topic commerce.order.placed.v1 --time -1

# 4. Broker health
kafka-topics.sh --bootstrap-server $BS --describe --under-replicated-partitions

# 5. Sample slow partition
kafka-console-consumer.sh --bootstrap-server $BS --topic commerce.order.placed.v1 \
  --partition 3 --offset 4892000 --max-messages 1
```

**Correlate.** Consumer thread dump; downstream payment API latency; GC pauses; rebalance events in logs at deploy time.

**Fix.** Address root (slow API, hot key, rebalance); temporary scale consumers ≤ partitions; never reset offsets without finance sign-off.

---

## 13. Solace PubSub+ — Event Broker, Message VPN & Routing

### Core concept

**Solace PubSub+** is an enterprise **event broker** (software, appliance, or cloud). Core isolation unit: **Message VPN** — like a virtual broker with own topics, queues, users, ACLs, and quotas. Cross-VPN bridging requires explicit configuration.

| Concept | Description |
|---|---|
| **Event broker** | Routes messages between publishers and subscribers |
| **Message VPN** | Logical isolation boundary (tenant / environment) |
| **Topic hierarchy** | Slash-separated names (`trade/equity/order/placed`) |
| **Client username** | Authenticated against VPN profile |
| **ACL profile** | Publish/subscribe permissions on topic patterns |
| **Queue** | Store-and-forward endpoint for guaranteed messaging |
| **Topic subscription** | Interest registration on topic tree (can include wildcards) |

**Routing model:** publisher sends to a **topic destination** (or queue). Broker matches against all **topic subscriptions** registered by clients and queue/DTE bindings. Matching subscribers receive copy (direct) or message spools to queue (guaranteed).

```
Message VPN: PROD_TRADING
├── Publishers: order-service, market-data-feed
├── Subscribers: risk-engine (topic sub: trade/>)
├── Queues: PAYMENT_INBOUND (bound to trade/*/payment/>)
└── ACL: order-service publish trade/order/>
```

### Internal working — guaranteed vs direct

**Direct (non-persistent):**

1. Publish to topic with DeliveryMode.NON_PERSISTENT.
2. Broker routes to currently connected matching subscribers.
3. Offline subscribers miss messages — fire-and-forget pub/sub.

**Persistent (guaranteed):**

1. Publish with DeliveryMode.PERSISTENT to topic (or send to queue).
2. Broker spools to matching queue endpoints / DTE queues.
3. Consumer acks; broker removes from spool.
4. Offline consumers receive backlog on connect (within max spool usage).

### Production scenario: wrong VPN — messages "vanish"

**Problem.** Staging publisher connects to PROD VPN by misconfigured host; ACL allows publish but no subscription in prod for staging consumer.

**Cause.** VPN mismatch; Solace doesn't route across VPNs without bridge.

**Solution.** Separate hosts/credentials per env; CI validation of `solace.jms.host` and VPN name; smoke test subscriber on deploy.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Direct delivery for financial events | Loss when consumer offline |
| VPN quota exceeded | Publish/subscribe rejected |
| No ACL on publish | Any client can publish anywhere in VPN |
| Shared client username across services | Can't trace origin; ACL too broad |

### Debugging scenario

**Observe.** `RejectedMessageError` / spool full.

**Diagnose.** Solace PubSub+ Manager → queue spool usage, ingress rate vs egress. Consumer slow or stopped?

**Fix.** Scale consumers; increase max spool; fix poison; temporary move to larger appliance tier.

---

## 14. Solace Topics — Hierarchy, Wildcards & Subscription Matching

### Core concept

Solace topics are **strings in a hierarchy**, not Kafka-style stored logs. Subscribers register **topic subscriptions** that may include wildcards.

**Naming convention:**

```
domain/entity/action[/qualifier]

Examples:
  commerce/order/placed
  commerce/order/payment/captured
  market-data/equity/AAPL/quote
  platform/audit/user/login
```

**Wildcards:**

| Wildcard | Matches | Example sub | Matches topic |
|---|---|---|---|
| `*` | Exactly **one** level | `commerce/*/placed` | `commerce/order/placed` ✓ |
| | | | `commerce/order/us/placed` ✗ (two levels between) |
| `>` | **Zero or more** levels | `commerce/>` | `commerce/order/placed` ✓ |
| | | | `commerce/order/payment/captured` ✓ |

**Subscription matching rules:**

- Trailing `/` normalized — `a/b` and `a/b/` equivalent in matching
- Subscriptions are evaluated at publish time against all registered subs
- Multiple subscriptions can match — message delivered to each (fan-out)
- Queue **topic subscription** binding: queue receives all messages matching pattern

```
Topic published: commerce/order/payment/captured

Subscriptions:
  commerce/order/>           ✓ match
  commerce/*/payment/*       ✓ match  
  commerce/order/placed      ✗ no match
  #  (invalid — Solace uses * and >, not MQTT #)
```

### Internal working — subscription table lookup

1. Publisher sends to topic `T`.
2. Broker walks subscription trie built from all client subs and queue bindings.
3. For each match: if direct client → deliver if online; if queue binding → spool to queue.
4. Ack tracking per guaranteed flow.

### Production scenario: overly broad `>` subscription

**Problem.** New `commerce/internal/debug/>` traffic floods analytics queue bound to `commerce/>`; production slowdown.

**Cause.** Wildcard too wide on guaranteed queue with no filter.

**Solution.** Narrow subscriptions: `commerce/order/>` not `commerce/>`. Use message selectors or separate VPNs for debug. Review queue bindings in change control.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `*` vs `>` confusion | Missing messages or unexpected matches |
| Case mismatch (`Order` vs `order`) | No match — Solace topics case-sensitive |
| Duplicate overlapping queue bindings | Same message spooled twice to two queues |
| MQTT topic syntax on Solace | Different wildcard rules — integration bugs |

### Debugging scenario

**Observe.** Publisher succeeds; queue depth zero; no consumers receive.

**Diagnose.** PubSub+ Manager → Topic Trace on publish; verify subscription list. Test with `solace-pubsub-cli` subscribe pattern.

**Fix.** Add queue topic subscription binding; fix typo in hierarchy; add ACL subscribe permission.

---

## 15. Solace Destinations — Queues vs Topics vs Endpoints vs Durable Subscriptions

### Core concept

Solace separates **addressing** (topic) from **consumption endpoint** (queue, temporary queue, topic endpoint). Interview question: "When do I use a queue vs a topic?"

| Destination | Purpose | Load balancing | Fan-out | Offline buffer |
|---|---|---|---|---|
| **Topic (direct)** | Pub/sub fire-and-forget | No (each subscriber gets all) | Yes | No |
| **Topic + Durable Topic Endpoint (DTE)** | Durable pub/sub to exclusive consumer | Single consumer per DTE | One sub per DTE | Yes (guaranteed) |
| **Queue** | Work queue; competing consumers | Yes (multiple flows same queue) | No (one queue = one copy) | Yes |
| **Queue + topic subscription** | Bridge topic routing to queue semantics | Yes | Per binding | Yes |
| **Temporary queue/topic** | Request-reply, RPC patterns | Exclusive | No | No |

**When to use each:**

- **Topic only (direct):** real-time ticks, presence, metrics where loss OK
- **Queue:** order processing, payment jobs — competing workers, ack, DLQ
- **Queue with topic subscription:** `trade/>` → `RISK_QUEUE` — fan-in from many topics to one work pool
- **DTE:** single active consumer must receive all events on `audit/>` durably (like durable JMS sub)
- **Topic endpoint:** consume directly from topic in guaranteed mode without separate queue object (Solace-specific pattern)

### Architecture pattern — topic to queue fan-in

```
Publishers ──► commerce/order/placed ──┐
             commerce/order/cancelled ─┼──► [ORDER_QUEUE] ──► Consumer pool (competing)
             commerce/order/updated ────┘
                        ▲
              queue topic subscription: commerce/order/>
```

### Production scenario: multiple consumers on DTE — only one gets messages

**Problem.** Team attaches 3 consumers to same DTE expecting load balance.

**Cause.** DTE is **exclusive** — one consumer active. Load balancing requires **queue**.

**Solution.** Bind `commerce/order/>` to `ORDER_PROCESSING_QUEUE`; attach multiple flows from consumer app instances.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Queue without topic binding | Empty queue forever |
| DTE for worker pool | Under-utilized consumers |
| Exclusive queue flag wrong | Multiple consumers error or split messages |
| Temp queue for durable workload | Messages lost on disconnect |

### Debugging scenario

**Observe.** Guaranteed messages not consumed; spool growing.

**Diagnose.** Active consumer count on queue bindings; `No Local` flag; flow inactive. Check `access-type` exclusive vs non-exclusive.

**Fix.** Add consumer flows; fix binding; increase `max-spool-usage`.

---

## 16. Solace Guaranteed Messaging — Direct vs Persistent, Ack & Replay

### Core concept

**Guaranteed messaging** = PERSISTENT delivery with spool, ack, redelivery, and replay.

| Mode | DeliveryMode | Behavior |
|---|---|---|
| Direct | NON_PERSISTENT | Best effort; lowest latency |
| Persistent | PERSISTENT | Spooled until acked |

**Ack modes (JCSMP / flow):**

| Mode | Behavior |
|---|---|
| **AUTO_ACK** | Ack on delivery to app — at-most-once risk if crash during process |
| **CLIENT_ACK** | Explicit ack after successful process — at-least-once |
| **CLIENT_ACK_FROM_PUBLISH** | Publisher-side confirmation (guaranteed publish) |

**Replay:** Solace supports **message replay** from queue by time, sequence, or ID — for recovery, new consumer bootstrap, regulatory audit. Replay creates separate replay flow — doesn't delete original spool until acked.

### Internal working — guaranteed publish to consume

1. Publisher sends PERSISTENT message; waits for pub ack (if enabled).
2. Broker spools to queue(s) matching topic subscription.
3. Consumer flow receives message with `RedeliveryFlag`.
4. Process; call `message.ackMessage()`.
5. Broker removes from active spool.
6. On crash before ack: redeliver (at-least-once); `dmq` (Dead Message Queue) after max redeliveries.

```java
@Service
public class SolaceOrderConsumer implements MessageHandler {

    @Override
    public void handleMessage(InboundMessage message) throws Exception {
        OrderPlacedEvent event = parse(message);
        try {
            orderService.process(event);
            message.ackMessage();
        } catch (PermanentException e) {
            // move to DMQ via queue config max-redelivery
            message.ackMessage(); // or reject per API version
            deadLetterStore.save(event, e);
        }
    }
}
```

### Replay configuration

```java
// Replay messages from 24h ago on queue ORDER_REPLAY
ReplayStartLocation start = ReplayStartLocation.fromTime(Instant.now().minus(24, ChronoUnit.HOURS));
// Bind replay flow via JCSMP API or Solace Manager replay trigger
```

### Production scenario: redelivery storm on poison message

**Problem.** Malformed payload causes NPE; message redelivered 1000×/min; blocks queue head.

**Cause.** `max-redelivery` too high; no DMQ; head-of-line blocking.

**Solution.** Configure DMQ; CLIENT_ACK only after validation; validate schema before business logic; park poison to DMQ after 3 attempts.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| AUTO_ACK on guaranteed queue | Silent loss on process crash |
| No pub ack on critical publish | Think sent; not spooled |
| Replay into same consumer group without idempotency | Duplicate side effects |
| DMQ not monitored | Poison accumulation unnoticed |

### Debugging scenario

**Observe.** `RedeliveryFlag` always true.

**Diagnose.** Handler throws before ack; consumer slow; VPN spool pressure causing retransmit.

**Fix.** Fix exception; idempotent handler; ack after persist; scale consumers.

---

## 17. Side-by-Side Platform Comparison

| Dimension | Kafka Topic | RabbitMQ Queue | Solace Topic | Solace Queue |
|---|---|---|---|---|
| **Storage model** | Append-only log | Queue buffer | Not stored (routing address) | Spooled messages |
| **Consume effect** | Offset advanced; log retained | Removed on ack | Ephemeral unless guaranteed endpoint | Removed on ack |
| **Fan-out** | Multiple consumer groups | Fanout exchange → many queues | Native topic subscriptions | One consumer pool per queue |
| **Competing consumers** | Same group, different partitions | Same queue, multiple consumers | Not on topic; yes on queue | Multiple flows |
| **Ordering** | Per partition | Per queue (single consumer) | Per subscriber flow | Per queue (head-of-line) |
| **Replay** | Reset offset / new group | DLQ/shovel only (no native log) | Replay API on spool | Replay API |
| **Routing** | Topic name + key | Exchange + binding + rk | Hierarchical topic + wildcards | Direct send or topic binding |
| **Throughput ceiling** | Very high | Moderate–high | High (hardware dependent) | High |
| **Ops complexity** | Partitions, ISR, KRaft | Exchanges, bindings, mirrors | VPN, ACL, spool, DTE |
| **Best fit** | Event streaming, CDC, analytics | Task queues, routing flexibility | Enterprise pub/sub + guaranteed | Work queues with Solace SLA |

---

## 18. Ordering Guarantees Across All Platforms

### Core concept

**Global ordering** (total order across all messages) requires single lane — Kafka: 1 partition; RabbitMQ: 1 queue + 1 consumer; Solace: single flow on exclusive queue.

**Per-key ordering** (same aggregate): Kafka: partition by key; RabbitMQ: consistent-hash exchange or single queue per aggregate (impractical at scale); Solace: hash to same queue via selector or partition key pattern.

| Platform | Scope | Guarantee | Breaks when |
|---|---|---|---|
| Kafka | Partition | Strict offset order | Key changes; multiple partitions |
| Kafka | Topic | No cross-partition order | Always |
| RabbitMQ | Queue | FIFO with one consumer | Multiple consumers on same queue |
| RabbitMQ | Exchange | No order across queues | Fan-out |
| Solace | Direct topic | Order per subscriber session | Multiple subscribers |
| Solace | Queue | FIFO single flow | Multiple competing flows (still FIFO but interleaved processing) |

### Production scenario: payment before order-created

**Problem.** `PaymentCaptured` processed before `OrderCreated` due to different partitions/topics.

**Solution.** Same topic + same key for order lifecycle; or saga orchestrator; or version/state machine rejecting invalid transitions; never rely on wall-clock timestamps.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Round-robin null keys for related events | Lifecycle events reordered |
| Multiple topics for one aggregate saga | Race conditions |
| Parallel `@KafkaListener` threads on same partition | Processing interleaving (poll is ordered but async process not) |

### Debugging scenario

**Observe.** Intermittent invalid state transitions.

**Diagnose.** Log partition, offset, key per event; reconstruct timeline. Check async processing inside listener.

**Fix.** Synchronous process per partition; or keyed executor; aggregate versioning.

---

## 19. Delivery Semantics — At-Most, At-Least, Exactly-Once

| Platform | At-most-once | At-least-once | Exactly-once |
|---|---|---|---|
| **Kafka** | `acks=0`, auto-commit before process | Manual commit after process; idempotent producer | Transactions (`transactional.id`) + `read_committed` + idempotent sink |
| **RabbitMQ** | Auto-ack; transient messages | Manual ack after process; publisher confirms | Not native — use idempotent consumer + dedup store |
| **Solace** | Direct + AUTO_ACK | CLIENT_ACK + persistent + pub ack | Transactional session (rare); usually idempotent consumer |

**End-to-end exactly-once** across DB + broker + external API is **not** provided by any broker alone. Pattern: **at-least-once + idempotency key + dedup table**.

```java
@Transactional
public void handle(OrderPlacedEvent event) {
    if (processedEventRepository.existsById(event.eventId())) {
        return; // duplicate from redelivery
    }
    paymentService.charge(event);
    processedEventRepository.save(new ProcessedEvent(event.eventId()));
}
```

### Production scenario: Kafka EOS transaction timeout

**Problem.** Streams app hangs; `ProducerFencedException` after pod restart.

**Cause.** `transactional.id` reused across instances; transaction timeout too short vs processing.

**Solution.** Unique `transactional.id` per instance; increase `transaction.timeout.ms`; fencing is feature not bug — fix duplicate id.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Claiming exactly-once without idempotent sink | Double charges |
| read_committed not set consuming transactional topic | Aborted txn messages visible |
| Idempotent producer without acks=all | Weak guarantee |

### Debugging scenario

**Observe.** Duplicate rate spikes correlate with deploys.

**Diagnose.** Rebalance + at-least-once; check commit lag vs processing time.

**Fix.** Idempotency; cooperative rebalance; static membership.

---

## 20. Spring Kafka — @KafkaListener, KafkaTemplate, RetryableTopic

### Core concept

Spring for Apache Kafka wraps producer/consumer APIs with `KafkaTemplate`, `@KafkaListener`, error handlers, and `@RetryableTopic` (Spring Kafka 2.7+).

```java
@Configuration
@EnableKafka
public class KafkaConfig {

    @Bean
    ProducerFactory<String, Object> producerFactory() {
        Map<String, Object> props = Map.of(
            ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092",
            ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
            ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, JsonSerializer.class,
            ProducerConfig.ACKS_CONFIG, "all",
            ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        return new DefaultKafkaProducerFactory<>(props);
    }

    @Bean
    KafkaTemplate<String, Object> kafkaTemplate(ProducerFactory<String, Object> pf) {
        return new KafkaTemplate<>(pf);
    }

    @Bean
    ConcurrentKafkaListenerContainerFactory<String, OrderPlacedEvent> kafkaListenerContainerFactory(
            ConsumerFactory<String, OrderPlacedEvent> cf) {
        var factory = new ConcurrentKafkaListenerContainerFactory<String, OrderPlacedEvent>();
        factory.setConsumerFactory(cf);
        factory.getContainerProperties().setAckMode(ContainerProperties.AckMode.MANUAL);
        factory.setCommonErrorHandler(new DefaultErrorHandler(
            new FixedBackOff(1000L, 3L)));
        return factory;
    }
}

@Service
@RequiredArgsConstructor
public class OrderEventProducer {
    private final KafkaTemplate<String, Object> kafkaTemplate;

    public CompletableFuture<SendResult<String, Object>> publish(OrderPlacedEvent event) {
        return kafkaTemplate.send("commerce.order.placed.v1", event.orderId(), event)
            .whenComplete((result, ex) -> {
                if (ex != null) log.error("Publish failed {}", event.orderId(), ex);
            });
    }
}
```

**Headers for trace propagation:**

```java
ProducerRecord<String, OrderPlacedEvent> record = new ProducerRecord<>(topic, key, event);
record.headers().add("traceId", traceId.getBytes(StandardCharsets.UTF_8));
kafkaTemplate.send(record);
```

**Full application.yml for Spring Boot 3.3+:**

```yaml
spring:
  kafka:
    bootstrap-servers: kafka.messaging.svc:9092
    producer:
      acks: all
      retries: 2147483647
      properties:
        enable.idempotence: true
        max.in.flight.requests.per.connection: 5
    consumer:
      group-id: payment-service
      enable-auto-commit: false
      auto-offset-reset: earliest
      properties:
        isolation.level: read_committed
        partition.assignment.strategy: org.apache.kafka.clients.consumer.CooperativeStickyAssignor
    listener:
      ack-mode: manual
      concurrency: 4
      observation-enabled: true  # Micrometer tracing
    template:
      observation-enabled: true
```

**Transactional producer (Kafka EOS within broker boundary):**

```java
@Bean
public KafkaTransactionManager<String, Object> kafkaTransactionManager(
        ProducerFactory<String, Object> pf) {
    return new KafkaTransactionManager<>(pf);
}

@Transactional("kafkaTransactionManager")
public void publishOrderAndAudit(OrderPlacedEvent event) {
    kafkaTemplate.send("commerce.order.placed.v1", event.orderId(), event);
    kafkaTemplate.send("platform.audit.v1", event.orderId(),
        new AuditEvent("ORDER_PLACED", event.orderId()));
    // both commits or both abort on failure
}
```

**Batch listener for throughput:**

```java
@KafkaListener(topics = "analytics.clicks.v1", batch = "true")
public void consumeBatch(List<ConsumerRecord<String, ClickEvent>> records, Acknowledgment ack) {
    clickRepository.saveAll(records.stream().map(r -> r.value()).toList());
    ack.acknowledge(); // single commit for batch — all-or-nothing per poll batch
}
```

### Production scenario: JsonDeserializer trusted packages `*`

**Problem.** CVE / RCE via malicious record payload in dev cluster exposed to prod pattern.

**Solution.** `spring.json.trusted.packages=com.mycompany.events` only; use Avro + Schema Registry in prod.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Wrong group-id in profile | Cross-environment consumption |
| `@RetryableTopic` on wrong exceptions | Poison to DLT too early/late |
| No `DefaultErrorHandler` | Container stops on bad record |
| concurrency=10, 3 partitions | 7 idle threads |

### Debugging scenario

**Observe.** Container stopped; `RecordDeserializationException`.

**Fix.** ErrorHandlingDeserializer wrapper; DLT routing; fix schema.

---

## 21. Spring RabbitMQ — RabbitTemplate & @RabbitListener

```java
@RabbitListener(queues = "orders.payment", containerFactory = "rabbitListenerContainerFactory")
public void handle(OrderPlacedEvent event, Channel channel,
                   @Header(AmqpHeaders.DELIVERY_TAG) long tag) throws IOException {
    try {
        paymentService.process(event);
        channel.basicAck(tag, false);
    } catch (Exception e) {
        channel.basicNack(tag, false, false); // to DLX
    }
}

@Bean
SimpleRabbitListenerContainerFactory rabbitListenerContainerFactory(
        ConnectionFactory cf, SimpleRabbitListenerContainerFactoryConfigurer configurer) {
    SimpleRabbitListenerContainerFactory factory = new SimpleRabbitListenerContainerFactory();
    configurer.configure(factory, cf);
    factory.setAcknowledgeMode(AcknowledgeMode.MANUAL);
    factory.setPrefetchCount(20);
    return factory;
}
```

**Publisher confirms:**

```java
rabbitTemplate.setConfirmCallback((correlation, ack, cause) -> {
    if (!ack) log.error("Nacked publish: {}", cause);
});
```

### Production scenario: DLX loop

**Problem.** Messages bounce between retry queue and main forever.

**Cause.** TTL retry queue dead-letters back to main without retry count header.

**Solution.** `x-death` header inspection; max retries; parking lot queue.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| default-requeue-rejected=true | Infinite retry |
| No publisher confirms | Silent loss on broker crash during publish |
| Jackson type id header mismatch | Deserialization failure |

### Debugging scenario

**Observe.** Unacked messages climb.

**Fix.** Thread dump; reduce prefetch; fix slow DB; DLQ poison.

---

## 22. Solace Spring Boot — JCSMP & Solace Java API Patterns

### Core concept

Solace Spring Boot Starter wraps **JCSMP** (Java API) and JMS. Configure VPN, host, credentials; define queues and topic subscriptions in broker or code.

```yaml
solace:
  java:
    host: tcps://solace.messaging.svc:55443
    msg-vpn: PROD_COMMERCE
    client-username: order-service
    client-password: ${SOLACE_PASSWORD}
    ssl:
      validate-certificate: true
```

```java
@Configuration
public class SolaceConfig {

    @Bean
    SpringJcsmpFactory solaceFactory(SolaceProperties props) {
        return new SpringJcsmpFactory(props);
    }

    @Bean
    Queue orderQueue() {
        return JCSMPFactory.onlyInstance().createQueue("ORDER_PROCESSING");
    }

    @Bean
    ConsumerFlowProperties flowProps(Queue orderQueue) {
        ConsumerFlowProperties props = new ConsumerFlowProperties();
        props.setEndpoint(orderQueue);
        props.setAckMode(JCSMPProperties.SupportedProperty.SUPPORTED_PROP_CLIENT_ACK);
        return props;
    }
}

@Component
@RequiredArgsConstructor
public class SolaceOrderPublisher {
    private final SpringJcsmpTemplate jcsmpTemplate;

    public void publishOrderPlaced(OrderPlacedEvent event) {
        Topic topic = JCSMPFactory.onlyInstance()
            .createTopic("commerce/order/placed");
        XMLMessage msg = jcsmpTemplate.getSession()
            .createMapMessage();
        msg.setMapObject("payload", event);
        msg.setDeliveryMode(DeliveryMode.PERSISTENT);
        jcsmpTemplate.send(topic, msg);
    }
}

@EventListener
public void onMessage(InboundMessage message) {
    // handle + ackMessage()
}
```

**Topic subscription on queue (admin or API):**

```java
// Queue ORDER_PROCESSING subscribes to commerce/order/> on broker
// PubSub+ Manager: Queues → Subscriptions → Add `commerce/order/>`
```

### Production scenario: JMS connection cache exhausted

**Problem.** `@JmsListener` creates connection per message under misconfig.

**Solution.** `CachingConnectionFactory`; single shared connection per JVM; tune `sessionCacheSize`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Missing topic subscription on queue | Empty consumer |
| NON_PERSISTENT on payment topic | Message loss |
| Wrong VPN in property file | Auth ok wrong env |

### Debugging scenario

**Observe.** Guaranteed publish timeout.

**Diagnose.** Pub flow not established; VPN spool full; ACL deny on publish topic.

**Fix.** Enable publisher confirms; monitor spool; fix ACL.

---

## 23. Schema & Serialization — JSON, Avro, Schema Registry

### Core concept

| Format | Pros | Cons |
|---|---|---|
| **JSON** | Human readable; Spring default | No schema enforcement; larger payloads |
| **Avro** | Compact; schema evolution; Registry | JVM codegen; breaking change discipline |
| **Protobuf** | Compact; cross-language | Less common in Kafka Java ecosystem |
| **CloudEvents** | Standard envelope metadata | Payload still needs schema |

**Confluent Schema Registry** (Kafka):

- Subject naming: `<topic>-value`, `<topic>-key`
- Compatibility: BACKWARD (default safe), FORWARD, FULL
- Serializer: `KafkaAvroSerializer` with `schema.registry.url`

```java
props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, KafkaAvroDeserializer.class);
props.put("schema.registry.url", "http://schema-registry:8081");
props.put("specific.avro.reader", true);
```

**Evolution rules:**

- Add optional fields with defaults — BACKWARD compatible
- Delete fields — breaking for FORWARD
- Never change field type

**Avro schema example with evolution-safe optional field:**

```json
{
  "type": "record",
  "name": "OrderPlaced",
  "namespace": "com.commerce.events",
  "fields": [
    { "name": "eventId", "type": "string" },
    { "name": "orderId", "type": "string" },
    { "name": "amount", "type": "double" },
    { "name": "currency", "type": "string", "default": "USD" },
    { "name": "loyaltyTier", "type": ["null", "string"], "default": null }
  ]
}
```

Adding `loyaltyTier` with null default is BACKWARD — old consumers ignore it; new consumers handle null.

**CI compatibility check:**

```bash
# Confluent Schema Registry plugin — fail build on breaking change
mvn schema-registry:validate \
  -Dschema.registry.url=http://schema-registry:8081 \
  -Dschema.files=src/main/avro/OrderPlaced.avsc \
  -Dcompatibility.level=BACKWARD
```

**CloudEvents envelope over Kafka (optional standardization):**

```java
CloudEvent cloudEvent = CloudEventBuilder.v1()
    .withId(event.eventId())
    .withSource(URI.create("/order-service"))
    .withType("commerce.order.placed.v1")
    .withTime(OffsetDateTime.now())
    .withData("application/json", objectMapper.writeValueAsBytes(event))
    .build();
// Serialize CloudEvent to Kafka value; consumers parse envelope then payload
```

### Production scenario: schema incompatible after deploy

**Problem.** Consumer deploy fails; `SerializationException`; lag grows.

**Cause.** Producer added required field without default; BACKWARD violated.

**Solution.** CI compatibility check (`maven-plugin` / `schema-registry plugin`); add optional fields only; dual-write period.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No compatibility gate in CI | Prod deserialization failures |
| JSON in prod without content-type contract | Silent field null |
| Schema ID mismatch across clusters | Consumer can't deserialize |

### Debugging scenario

**Observe.** Hex garbage in logs.

**Diagnose.** Consuming Avro as JSON. Check magic byte `0x0` + schema id header.

**Fix.** Align deserializer; use ErrorHandlingDeserializer.

---

## 24. Poison Messages & Cross-Platform DLQ Patterns

### Core concept

**Poison message** = fails every processing attempt (bad data, code bug, missing dependency).

| Platform | Dead letter mechanism |
|---|---|
| Kafka | DLT topic; `@RetryableTopic`; manual skip + store |
| RabbitMQ | DLX + DLQ queue; `x-death` headers |
| Solace | DMQ (Dead Message Queue); max-redelivery count |

Universal strategy:

1. **Limited retries** with exponential backoff
2. **Route to DLQ/DLT/DMQ** with original headers + error context
3. **Alert** on DLQ depth > 0
4. **Fix and replay** with idempotency
5. **Never** infinite requeue

```java
// Kafka DLT handler — already in Section 11
// Rabbit — DLX binding to orders.payment.dlq
// Solace — configure queue `dead-msg-queue` on VPN
```

### Production scenario: DLT replay double-charges

**Problem.** Ops replays 500 DLT payment events; 200 already processed.

**Solution.** Replay tool checks `processed_events` table; replay to **new** consumer group with idempotent handler; rate limit.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No DLQ monitoring | Silent business loss |
| Requeue forever | Head-of-line blocking |
| DLT same partition key hot spot | Replay storm on one partition |

### Debugging scenario

**Observe.** Main queue empty; DLQ growing.

**Fix.** Sample DLQ message; reproduce; patch; replay in staging first.

---

## 25. Production Debugging Playbook

When messaging bugs are "random," it is usually **offset/commit timing**, **rebalance**, **subscription mismatch**, **schema drift**, or **missing idempotency**.

1. **Classify the symptom.** Lag? Duplicates? Loss? Poison? Intermittent on deploy only?

2. **Identify the platform boundary.** Kafka vs Rabbit vs Solace — don't mix tooling.

3. **Kafka — first commands:**

   ```bash
   # Consumer lag and members
   kafka-consumer-groups.sh --bootstrap-server $BS --describe --group $GROUP
   kafka-consumer-groups.sh --bootstrap-server $BS --describe --group $GROUP --members --verbose

   # Topic layout, ISR, leader skew
   kafka-topics.sh --bootstrap-server $BS --describe --topic $TOPIC
   kafka-topics.sh --bootstrap-server $BS --describe --under-replicated-partitions

   # Log end offsets vs consumer position
   kafka-get-offsets.sh --bootstrap-server $BS --topic $TOPIC --time -1

   # Sample a stuck offset (replace partition/offset)
   kafka-console-consumer.sh --bootstrap-server $BS --topic $TOPIC \
     --partition 0 --offset $OFFSET --max-messages 1

   # Broker disk / segment pressure
   kafka-log-dirs.sh --bootstrap-server $BS --describe
   ```

   Read: `LAG` per partition, `ISR` count vs `Replicas`, leader distribution, log start offset vs committed offset (data loss risk if lag age > retention).

   **Kafka-specific signals:**

   | Metric / log | Meaning |
   |---|---|
   | `NOT_ENOUGH_REPLICAS` | ISR < `min.insync.replicas` — writes blocked (good) or misconfigured |
   | `RecordTooLargeException` | Broker/producer/consumer max bytes mismatch |
   | `max.poll.interval.ms` exceeded | Handler too slow — rebalance incoming |
   | `OffsetOutOfRangeException` | Committed offset deleted by retention |
   | `RebalanceInProgressException` | Commit during generation change — duplicate risk |
   | Under-replicated partitions > 0 | Broker down, network, or reassignment in progress |
   | Single partition lag dominant | Hot key or poison message on that partition |
   | Publish rate normal, lag grows | Consumer or downstream bottleneck — not broker |

4. **RabbitMQ — management UI / CLI:**

   ```bash
   rabbitmqctl list_queues name messages messages_ready messages_unacknowledged consumers
   rabbitmqctl list_bindings source_name destination_name routing_key
   ```

   Check ready vs unacked, publish vs deliver rate, DLQ depth.

5. **Solace — PubSub+ Manager / SEMP:**

   ```bash
   # CLI subscribe test
   solace-pubsub-cli sub -c $CONFIG -t "commerce/order/>" -e ORDER_PROCESSING
   ```

   Inspect queue spool, bind count, replay state, DMQ depth.

6. **Trace one message.** Pick `eventId` / `correlationId`; grep producer logs → broker timestamp → consumer partition/offset/queue → dedup table.

7. **Rebalance timeline.** Correlate duplicate spikes with K8s rollout timestamps and consumer group member changes.

8. **Subscription audit.** Solace: topic sub on queue matches publish hierarchy. Rabbit: binding keys. Kafka: topic name + ACL + group.id.

9. **Commit mode.** Confirm manual ack after success on money paths. Log offset at process start and ack time.

10. **Retention vs lag.** Kafka: `retention.ms` minus oldest lagging offset timestamp = time to data loss.

11. **Schema.** Registry version history; first failing offset payload hex dump.

12. **Turn debug logging off.** Verbose client logs flood disk and may log PII.

Metrics: `kafka.consumer.lag`, Rabbit `messages_unacknowledged`, Solace `spool_usage`, DLT/DLQ rate, publish error rate, rebalance rate.

---

## 26. Quick Decision Matrix

| Situation | Do this |
|---|---|
| High-throughput event stream, replay required | Kafka keyed partitions + schema registry |
| Task queue, competing workers, per-message ack | RabbitMQ quorum queue or Solace queue |
| Enterprise pub/sub with hierarchical routing | Solace topics + wildcards |
| Fan-out to many independent services | Kafka topic (multiple groups) or Solace topic subs |
| Guaranteed delivery, offline consumers | Solace persistent + queue; Rabbit durable + manual ack; Kafka with retention + consumer |
| Strict global ordering | Single Kafka partition OR Solace exclusive queue (accept throughput limit) |
| Per-customer ordering | Kafka key = customerId; consistent-hash Rabbit exchange |
| Money / inventory side effects | At-least-once + idempotency key + dedup store |
| Fire-and-forget metrics | Kafka at-most-once or Solace direct |
| DB write + publish atomic | Transactional outbox + relay (not XA) |
| Poison message risk | Retry topics / DLX / DMQ + alert |
| Bug fix requires reprocessing | Kafka: new consumer group; Solace: replay; Rabbit: DLQ shovel |
| Cross-datacenter | Kafka MirrorMaker 2 / cluster linking; Solace DMR; Rabbit Shovel/Federation |
| Spring Boot microservice default | Manual ack; outbox; `@RetryableTopic`; no auto-commit on money paths |
| Legacy JMS clients | Solace JMS or Artemis bridge to Kafka via Connect |
| Schema evolution | Avro BACKWARD; CI registry check |
| Hybrid Kafka + Solace | Bridge with idempotency; don't dual-publish without dedup |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. What is the fundamental mental model difference between a Kafka topic and a traditional MQ queue?</summary>

A **Kafka topic** is an **append-only retained log** — messages stay after consumption; consumer groups track independent offsets; replay is native. A **traditional MQ queue** is a **work buffer** — messages typically removed on ack; competing consumers share load; replay requires DLQ archive or external store. Use Kafka for event streams; use queues for task distribution.

</details>

<details class="qa-item">
<summary>2. How does a Solace topic differ from a Kafka topic?</summary>

A **Solace topic** is a **hierarchical routing address** (not a stored log). Messages are matched against subscriber **topic subscriptions** with wildcards at publish time. A **Kafka topic** is persisted partitioned log data. Solace fan-out is subscription-based; Kafka fan-out is multiple consumer groups reading the same log.

</details>

<details class="qa-item">
<summary>3. When would you bind a Solace queue to a topic subscription instead of publishing directly to the queue?</summary>

When you want **topic-based routing flexibility** (many publishers on `commerce/order/>`) with **queue semantics** (competing consumers, guaranteed delivery, spool, replay). Publishers stay decoupled from queue name; operations can rebind subscriptions without producer changes.

</details>

<details class="qa-item">
<summary>4. Explain RabbitMQ direct vs topic vs fanout exchanges with examples.</summary>

**Direct:** rk exact match — `payment.us` → binding `payment.us`. **Topic:** pattern match — rk `order.placed.us` matches binding `order.*.us`. **Fanout:** ignores rk — delivers copy to **every** bound queue. Use direct for typed routing, topic for domain events, fanout for broadcast (cache invalidation, alerts).

</details>

<details class="qa-item">
<summary>5. What is the purpose of Kafka partition keys?</summary>

Keys determine partition via hash — all records with the same key go to the **same partition**, preserving **order per key**. Null keys round-robin for load spreading without ordering. Keys are essential for order lifecycle, account balance, and any aggregate where event sequence matters.

</details>

<details class="qa-item">
<summary>6. How do you plan Kafka partition count for a new topic?</summary>

Start from `max(throughput_target / single_consumer_throughput, peak_consumer_instances)`, rounded up. Consider ordering (per-key needs fewer hotter partitions), rebalance cost (avoid 1000+ without reason), and broker limits (~4000 partitions/broker guidance). Increasing partitions later doesn't redistribute existing keys without re-keying strategy.

</details>

<details class="qa-item">
<summary>7. What is ISR and why does min.insync.replicas matter?</summary>

**ISR** = replicas fully caught up with leader. **`min.insync.replicas`** sets minimum ISR size required for `acks=all` produces to succeed. With RF=3 and min ISR=2, one broker can fail without blocking writes. If ISR shrinks below min, produce fails — preventing acked writes that could be lost on leader failure.

</details>

<details class="qa-item">
<summary>8. What is unclean leader election and why disable it in production?</summary>

**Unclean election** promotes a replica **not in ISR** to leader when all ISR members are offline. That replica may lack recent committed messages — **data loss**. Keep `unclean.leader.election.enable=false`; accept partition unavailability until ISR replica returns rather than silent loss.

</details>

<details class="qa-item">
<summary>9. Explain cooperative sticky assignor vs eager rebalance.</summary>

**Eager** revokes **all** partitions from **all** consumers during rebalance — stop-the-world processing gap. **Cooperative sticky** incrementally revokes only partitions that must move — others keep consuming. Reduces duplicate processing window and lag spikes during K8s rollouts. Use with consistent client versions supporting cooperative protocol.

</details>

<details class="qa-item">
<summary>10. What are Solace wildcard * and > and how do they differ?</summary>

`*` matches **exactly one** topic level. `>` matches **zero or more** trailing levels. Subscription `commerce/*/placed` matches `commerce/order/placed` but not `commerce/order/us/placed`. Subscription `commerce/>` matches both. Confusing them causes missed or overly broad message delivery.

</details>

<details class="qa-item">
<summary>11. Solace queue vs Durable Topic Endpoint — when to use which?</summary>

Use a **queue** for **competing consumers** and work-queue load balancing. Use a **DTE** for **single exclusive durable subscriber** that must receive all matching topic messages (audit tap, single pipeline consumer). Multiple workers on DTE don't load-balance — only one active consumer.

</details>

<details class="qa-item">
<summary>12. Compare ordering guarantees: Kafka partition vs RabbitMQ queue vs Solace queue.</summary>

**Kafka partition:** strict order by offset. **RabbitMQ queue:** FIFO with single consumer; multiple consumers interleave processing but broker delivers in order. **Solace queue:** FIFO per queue; competing flows may process in parallel after delivery — use exclusive consumer if strict sequential processing required. None provide global cross-partition/topic order without design.

</details>

<details class="qa-item">
<summary>13. How do you achieve at-least-once delivery on each platform?</summary>

**Kafka:** manual offset commit after successful process; idempotent producer. **RabbitMQ:** manual ack after process; durable queue + persistent messages + publisher confirms. **Solace:** PERSISTENT delivery + CLIENT_ACK + publisher pub ack. All require **idempotent consumers** to handle redelivery duplicates.

</details>

<details class="qa-item">
<summary>14. What is Kafka log compaction and when would you use it?</summary>

Compaction retains the **latest record per key**, removing older values for that key. Use for changelog topics (KTables, connector offsets, config stores). Not for unbounded unique keys (every event new key). Tombstones delete keys after `delete.retention.ms`.

</details>

<details class="qa-item">
<summary>15. Describe the main/retry/DLT topic pattern in Spring Kafka.</summary>

Failed messages route from **main topic** to **retry topics** with increasing backoff (`@RetryableTopic`), then to **DLT** after max attempts. Each topic can have independent retention and consumer concurrency. `@DltHandler` processes poison messages for alerting and manual replay. Prevents retry traffic from blocking main partition head.

</details>

<details class="qa-item">
<summary>16. What is a JMS durable subscription and how does it relate to Solace?</summary>

A **durable subscription** (`clientId` + subscription name) retains messages for offline topic subscribers. Solace **Durable Topic Endpoints** and **queue-based durable subs** provide similar guaranteed delivery. Non-durable JMS topic subs lose messages when disconnected — like Solace direct topics.

</details>

<details class="qa-item">
<summary>17. Why is XA (2PC) rarely used between DB and message broker?</summary>

XA is **slow**, increases failure modes (heuristic commits), ties connection pools, and doesn't extend to external APIs. **Outbox pattern** achieves reliable publish aligned with DB commit without 2PC — at-least-once relay with idempotent consumers is simpler and scales better.

</details>

<details class="qa-item">
<summary>18. How does RabbitMQ dead-letter exchange (DLX) work?</summary>

Queue configured with `x-dead-letter-exchange` and optional `x-dead-letter-routing-key`. Messages dead-letter when rejected (nack requeue=false), TTL expires, or queue length exceeded. DLX routes to DLQ for inspection and replay. Always pair with max retry policy — never infinite nack-requeue loops.

</details>

<details class="qa-item">
<summary>19. What is KRaft and why did Kafka move away from ZooKeeper?</summary>

**KRaft** uses Raft consensus for Kafka metadata (topics, partitions, ACLs) in an internal topic — no ZooKeeper dependency. Simplifies ops, faster metadata propagation, better scalability. Kafka 4.0 removes ZK entirely. Production: dedicated controller quorum (3 or 5 nodes) for fault tolerance.

</details>

<details class="qa-item">
<summary>20. How do Schema Registry and Avro help in Kafka ecosystems?</summary>

**Schema Registry** stores Avro/JSON/Protobuf schemas with version history. Producers embed schema ID; consumers fetch schema for deserialization. **Compatibility modes** (BACKWARD default) gate unsafe changes in CI. Prevents "JSON soup" and enables safe evolution — add optional fields, not breaking renames.

</details>

<details class="qa-item">
<summary>21. What causes consumer lag on only one Kafka partition?</summary>

**Hot key** — skewed partition gets more traffic. **Slow message** — poison or expensive record blocks sequential processing on that partition. **Stuck consumer** — instance assigned that partition crashed. Diagnose with `kafka-consumer-groups --describe` per-partition lag; fix with key salting, async side effects, or partition count increase.

</details>

<details class="qa-item">
<summary>22. Explain Solace guaranteed messaging ack modes.</summary>

**AUTO_ACK:** ack on deliver to app — at-most-once if crash during process. **CLIENT_ACK:** app acks after success — at-least-once with redelivery on failure. **Publisher pub ack:** confirms broker spooled persistent message. Use CLIENT_ACK on money paths; AUTO_ACK only for idempotent fire-and-forget metrics.

</details>

<details class="qa-item">
<summary>23. How do you replay messages safely on Kafka vs Solace vs RabbitMQ?</summary>

**Kafka:** new consumer group or offset reset in maintenance window; retention must cover window; idempotent handlers; rate-limit. **Solace:** replay API from queue by time/sequence; separate replay flow; idempotency required. **RabbitMQ:** no native log replay — shovel from DLQ archive or re-publish from event store. Plan replay at architecture time.

</details>

<details class="qa-item">
<summary>24. What is the difference between Kafka consumer group and Solace queue competing consumers?</summary>

Both distribute work, but Kafka assigns **whole partitions** exclusively (max parallelism = partition count); Solace queue delivers messages round-robin to **multiple flows** on same queue without partition concept. Kafka retains log for other groups; Solace queue message gone after ack.

</details>

<details class="qa-item">
<summary>25. Describe a production incident from wrong delivery semantics choice.</summary>

Team enabled **auto-commit** on order Kafka consumer. Pod killed after charge but before commit — message lost, order stuck unpaid but shipped. Fix: manual ack after DB commit + idempotency on `eventId`. Alternative failure: at-least-once without dedup — double charge on rebalance during deploy.

</details>

<details class="qa-item">
<summary>26. When would you choose Solace over Kafka in an enterprise?</summary>

When requirements include **hierarchical topic routing with wildcards**, **guaranteed messaging with DMQ/replay** out of the box, **multi-protocol bridging** (MQTT, AMQP, REST), **VPN-level multi-tenancy**, and **appliance SLA** — common in finance, telco, and existing Solace estates. Kafka wins on open-source ecosystem, stream processing, and massive log retention analytics.

</details>

<details class="qa-item">
<summary>27. How does CDC via Debezium relate to Kafka topics?</summary>

Debezium reads DB transaction log (WAL/binlog) and publishes row changes to Kafka topics (`server.schema.table`). Consumers treat changes as events — ordering per table primary key partition. Handles INSERT/UPDATE/DELETE with op field. Requires schema evolution discipline and idempotent sink processing. Initial snapshot + streaming phases must both be handled.

</details>

<details class="qa-item">
<summary>28. What metrics alert you to messaging incidents before users notice?</summary>

**Kafka:** consumer lag (max/p95), under-replicated partitions, offline partitions, produce error rate, rebalance rate. **RabbitMQ:** queue depth, unacked age, memory/disk alarm, publish/deliver gap. **Solace:** spool usage, bind failure rate, DMQ depth, message reject rate. Universal: DLT/DLQ depth > 0, publish confirm failures, schema registry errors.

</details>

<details class="qa-item">
<summary>29. What causes `NOT_ENOUGH_REPLICAS` on Kafka produce and how do you fix it without sacrificing durability?</summary>

Producer with `acks=all` waits for all ISR replicas to ack. Error means ISR size fell below `min.insync.replicas` — broker down, slow follower, or network partition. **Do not** lower `min.insync.replicas` permanently. Restore failed broker, wait for ISR to recover, verify `kafka-topics.sh --describe` shows full ISR. Prevent with RF=3, rack awareness, and rolling restarts one broker at a time.

</details>

<details class="qa-item">
<summary>30. Why does consumer lag spike on every Kubernetes deploy even when traffic is flat?</summary>

Rolling pod restart triggers **consumer group rebalance** — partitions revoked and reassigned. In-flight messages may be reprocessed if commit hadn't completed; eager rebalance pauses all consumption briefly. Mitigate: **cooperative sticky assignor**, **static membership** (`group.instance.id`), graceful shutdown (`WakeupException` handler), idempotent consumers, and right-sized `max.poll.interval.ms`.

</details>

<details class="qa-item">
<summary>31. How do you diagnose a single hot Kafka partition?</summary>

`kafka-consumer-groups --describe` shows one partition with huge LAG while others are zero. Causes: **hot key** (same `orderId`/`merchantId`), poison message on that partition, or slow handler for records in that shard. Sample with `kafka-console-consumer --partition N`. Fix: salt keys (accept ordering loss), optimize handler, move heavy work async, or split topic by tenant tier.

</details>

<details class="qa-item">
<summary>32. What is `OffsetOutOfRangeException` and when does it cause data loss?</summary>

Consumer's committed offset points to a log position **deleted by retention**. Common when consumer group was offline longer than `retention.ms`. Consumer cannot start. Fix: reset offsets (`--to-earliest` or `--to-datetime`) with **idempotent replay** in maintenance window. **Prevention:** alert when lag age approaches retention; increase retention beyond max recovery time.

</details>

<details class="qa-item">
<summary>33. Describe a Kafka retry-topic storm and how to stop it.</summary>

Downstream (payment gateway) fails; every message retries across `retry-0`, `retry-1`, … multiplying traffic 4–10×; disk and CPU spike; recovery delayed after gateway heals. Fix: **circuit breaker** in consumer, `listenerContainer.pause()`, cap retry attempts, fast-path permanent errors to DLT, rate-limit retry consumers. Never infinite retry without backoff ceiling.

</details>

<details class="qa-item">
<summary>34. What Kafka producer settings are mandatory for financial event publishing?</summary>

`acks=all`, `enable.idempotence=true`, `retries` high (with idempotence), `compression.type=zstd` or `lz4`, adequate `linger.ms`/`batch.size` for throughput, and `max.in.flight.requests.per.connection=5` (with idempotence). Plus application **eventId** for end-to-end dedup. Never `acks=0` or non-durable topic on money paths.

</details>

<details class="qa-item">
<summary>35. How do unclean leader elections cause "vanished" Kafka messages?</summary>

When all ISR replicas are offline, an out-of-sync replica can become leader if `unclean.leader.election.enable=true` (legacy misconfig). New leader has **truncated log** — consumers see offsets jump backward or records disappear. Production: keep unclean election **disabled**; accept write unavailability until ISR recovers rather than silent data loss.

</details>

---

*The broker guarantees semantics only within its boundary. Kafka topics are logs; MQ queues are work; Solace topics are routes — pick the model that matches your delivery, ordering, and replay requirements. Design for at-least-once, prove duplicates harmless with idempotency, monitor lag and spool like uptime, and never reset production offsets or replay guaranteed queues without a runbook and finance in the loop.*
