# Distributed Data & Transactions Mastery — Senior Production Reference

Microservices, polyglot persistence, Kafka CDC, and cloud-native data platforms. This is not a textbook on ACID in a single database. It is the map of what actually breaks in production after years of shipping order pipelines, payment sagas, sharded ledgers, and cross-service queries on JVM and polyglot backends.

---

## Table of Contents

1. [Mental Model: Data Ownership in Microservices](#1-mental-model-data-ownership-in-microservices)
2. [Distributed Transactions](#2-distributed-transactions)
3. [Two-Phase Commit (2PC)](#3-two-phase-commit-2pc)
4. [Saga Pattern](#4-saga-pattern)
5. [Choreography vs Orchestration](#5-choreography-vs-orchestration)
6. [Compensating Transactions](#6-compensating-transactions)
7. [Data Consistency](#7-data-consistency)
8. [Eventual Consistency Challenges](#8-eventual-consistency-challenges)
9. [CQRS](#9-cqrs)
10. [Event Sourcing](#10-event-sourcing)
11. [Outbox Pattern](#11-outbox-pattern)
12. [Change Data Capture (CDC)](#12-change-data-capture-cdc)
13. [Distributed Locking](#13-distributed-locking)
14. [Database Sharding](#14-database-sharding)
15. [Read Replicas](#15-read-replicas)
16. [Polyglot Persistence](#16-polyglot-persistence)
17. [Data Ownership](#17-data-ownership)
18. [Data Replication](#18-data-replication)
19. [Cross-Service Queries](#19-cross-service-queries)
20. [Database Migration](#20-database-migration)
21. [Schema Migration](#21-schema-migration)
22. [Production Debugging Playbook](#22-production-debugging-playbook)
23. [Quick Decision Matrix](#23-quick-decision-matrix)

---

## 1. Mental Model: Data Ownership in Microservices

In a monolith, one database enforces ACID across all tables. In microservices, **each service owns its data**. There is no shared row-level lock across PostgreSQL in Order Service and MongoDB in Catalog Service. "Distributed transaction" is not a feature you enable — it is a **design choice** among 2PC, sagas, outbox + events, or accepting eventual consistency.

```
Client
  └─ API Gateway / BFF
       ├─ Order Service ──► orders_db (PostgreSQL) ──► outbox table
       ├─ Payment Service ──► payments_db (PostgreSQL)
       ├─ Inventory Service ──► inventory_db (PostgreSQL, sharded)
       └─ Search Service ──► elasticsearch (read model, eventual)
            ▲
            └── Kafka (CDC / domain events) ──► projections, analytics
```

Three objects you must keep distinct:

| Object | Question it answers | Wrong mental model |
|---|---|---|
| **Local transaction** | Did this service's DB change atomically? | "If local TX commits, the business operation is done globally." |
| **Distributed transaction** | Do multiple resources commit or abort together? | "Spring `@Transactional` spans microservices." |
| **Business consistency** | Does the system reflect correct business state over time? | "Strong consistency everywhere or the product is broken." |

The senior misdiagnosis pattern: reaching for **2PC or XA** because "we need transactions," when the real requirement is **idempotent saga steps + outbox + compensations** with explicit acceptance of seconds of lag on read models.

**Data per service** is not optional in mature microservices. Shared databases create coupling: schema changes require coordinated deploys; one team's slow query takes down another's API; ownership of rows is ambiguous in incidents ("who fixes duplicate payments?").

**The network is part of the transaction boundary.** A local commit followed by a failed HTTP call to another service is the default failure mode — not an edge case.

### Production scenario: shared database "microservices"

**Problem.** Five "services" deployed separately but all pointing at one Oracle schema. Team A adds a `NOT NULL` column on `orders`; Team B's older deployment inserts without the column → production outage. On-call cannot roll back one service without rolling back all.

**Solution.** Split databases per bounded context. Use APIs or events for cross-context data. Accept migration cost upfront — it is cheaper than perpetual coordinated releases.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Shared database across services | Schema migration blocks all teams; cascading failures |
| Synchronous chain of 5+ service calls in one user request | p99 latency explosion; partial failure with no compensation |
| `@Transactional` on method that calls HTTP client | Local TX rolls back but remote side effect already happened |
| Treating read replica as source of truth | Stale inventory, double booking, wrong balances |
| Global 2PC (XA) across heterogeneous stores | Coordinator failure blocks resources; ops nightmare |

### Debugging scenario

**Observe.** Customer charged, order shows "Payment Pending," inventory not decremented.

**Diagnose.** Trace ID across services. Timeline: Payment TX committed → Order service HTTP timeout → client retried → duplicate payment attempt blocked by idempotency (good) but order never updated. Check: outbox unpublished? Consumer lag? Saga step 3 never ran?

**Fix.** Outbox + event-driven saga; idempotency keys on all steps; dashboard for saga state and DLQ depth.

---

## 2. Distributed Transactions

### Core concept

A **distributed transaction** coordinates multiple **resource managers** (databases, message brokers, file systems) so that either **all** participants commit or **all** abort. The ACID properties you know from a single RDBMS must be redefined across process and network boundaries.

In microservices literature, "distributed transaction" often means:

1. **Technical:** 2PC / 3PC / XA between databases
2. **Business:** A multi-step workflow that must end in a consistent business outcome (saga)
3. **Colloquial:** Any cross-service write — usually **not** atomic

| Approach | Atomicity across services | Availability | Typical use |
|---|---|---|---|
| **Local TX only** | Per service | High | Default; combine with events |
| **2PC / XA** | Yes (blocking) | Low under failure | Homogeneous enterprise DBs, legacy |
| **Saga** | No (eventual) | High | Microservices, long-running flows |
| **TCC (Try-Confirm-Cancel)** | Business-level | Medium | Fintech, reserved resources |
| **Outbox + at-least-once** | Per service + eventual cross-service | High | Order/payment/inventory |

**You cannot have distributed ACID across arbitrary microservices without paying latency, availability, and operational cost.** Most product requirements are satisfied by **per-service ACID + eventual cross-service consistency + idempotency**.

### Internal working — what "atomic" means across nodes

Single-node transaction (simplified):

```
BEGIN
  UPDATE accounts SET balance = balance - 100 WHERE id = 1;
  UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT  -- WAL fsync, locks released
```

Distributed (conceptual):

```
Coordinator: PREPARE all participants
  Participant A: vote YES, hold locks
  Participant B: vote YES, hold locks
Coordinator: COMMIT all
  Participant A: commit, release
  Participant B: commit, release
```

If coordinator dies after PREPARE, participants hold locks until **in-doubt resolution** — this is why 2PC is avoided in high-throughput microservices paths.

### Production scenario: "just add `@GlobalTransactional`"

**Problem.** Team adopts Seata / Atomikos with XA across Order DB and Payment DB. Normal load: fine. Payment DB slow query during peak: XA locks propagate; Order API thread pool exhausted; site down.

**Solution.** Remove XA from hot path. Saga: reserve inventory → charge payment → confirm order, each step local TX + event. Compensate on failure. Reserve 2PC for rare batch reconciliation jobs if ever needed.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Long-running XA transaction | Lock escalation, deadlocks across services |
| Nested remote calls inside local TX | Connection held for seconds; pool starvation |
| No timeout on distributed coordinator | Indefinite blocking after partial prepare |
| Assuming rollback propagates to HTTP POST already sent | Ghost side effects, duplicate charges |

### Debugging scenario

**Observe.** Spikes in `idle in transaction` sessions on PostgreSQL during checkout.

**Diagnose.** `pg_stat_activity` shows XA or open TX from application server. Correlate with Seata TC logs or stuck saga without timeout.

**Fix.** Shorten transaction scope; move messaging to outbox; add saga timeout and compensation scheduler.

---

## 3. Two-Phase Commit (2PC)

### Core concept

**Two-Phase Commit** is a consensus protocol for atomic commit across participants:

**Phase 1 — Prepare (vote):** Coordinator asks each participant to prepare. Participant writes to durable log, acquires locks, votes YES or NO.

**Phase 2 — Commit or abort:** If all YES, coordinator sends COMMIT; else ABORT. Participants apply decision idempotently.

```
Coordinator                    Participant A              Participant B
     |  PREPARE  ----------------►|                          |
     |  PREPARE  ----------------------------------------►|
     |  YES      ◄----------------|                          |
     |  YES      ◄----------------------------------------|
     |  COMMIT   ----------------►|                          |
     |  COMMIT   ----------------------------------------►|
```

**2PC guarantees atomicity** but not partition tolerance in the CAP sense during blocking: if coordinator fails after all YES votes, participants are **blocked** until decision is recovered.

### Internal working — failure modes

| Failure point | Behavior | Production impact |
|---|---|---|
| Before prepare | Abort; no locks held | Safe |
| Participant votes NO | Global abort | Safe |
| Coordinator dies before commit | Participants blocked (in-doubt) | **Outage** until heuristic or manual resolution |
| Participant dies after commit | Coordinator retries commit on recovery | Must be idempotent |
| Network partition during prepare | Timeouts → abort or block | Split behavior |

**Heuristic rollback / commit:** Participant guesses decision when coordinator is gone — **risk of inconsistency**. Production XA drivers discourage this; ops run recovery tools.

**3PC** adds a pre-commit phase to reduce blocking — still rarely used in microservices; complexity vs benefit.

### XA and Java

JTA `UserTransaction` with XA datasources enrolls resources in global transaction. Spring `@Transactional` with `JtaTransactionManager` can span two XA-capable JDBC pools.

```java
// Illustrative — avoid on microservice hot paths
@Transactional
public void placeOrderWithXa(Order order) {
    orderRepository.save(order);           // XA resource 1
    paymentClient.chargeViaXaDatasource(); // XA resource 2 — anti-pattern if remote
}
```

XA over **remote HTTP** does not exist. XA is for **databases and message brokers** that support the protocol (some JMS, Narayana, Atomikos).

### Production scenario: IBM MQ + DB XA in legacy integration

**Problem.** Mainframe-style integration: message and DB must commit together. Works with mature MQ + DB2 XA. Team migrates Payment to cloud Postgres without XA driver in path — silent break: message sent, DB rolled back.

**Solution.** Either full XA chain end-to-end or **outbox pattern**: insert business row + outbox row in one local TX; separate relay publishes to MQ.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| XA with connection pool not XA-aware | Partial commit, heuristic errors |
| Coordinator SPOF without HA | Cluster-wide commit freeze |
| Long prepare phase | Lock contention on hot rows |
| Mixing XA and non-XA resources in same "transaction" | False sense of atomicity |

### Debugging scenario

**Observe.** `XAER_RMERR`, `TRANSACTION_ROLLBACK` in logs; growing `pg_prepared_xacts`.

**Diagnose.** List prepared transactions: `SELECT * FROM pg_prepared_xacts;`. Identify coordinator GTRID. Check TM (transaction manager) recovery log.

**Fix.** Run TM recovery; commit or rollback in-doubt branches per runbook; never guess in production without understanding orphan branches.

---

## 4. Saga Pattern

### Core concept

A **saga** is a sequence of **local transactions**, each updating one service's database and publishing an event or message to trigger the next step. If a step fails, **compensating transactions** undo prior steps (or apply semantic undo).

```
Happy path:
  T1: Create order (PENDING)     → event OrderCreated
  T2: Reserve inventory          → event InventoryReserved
  T3: Charge payment             → event PaymentCaptured
  T4: Confirm order (CONFIRMED)

Failure at T3:
  C3: (nothing — payment failed)
  C2: Release inventory
  C1: Cancel order
```

Sagas trade **atomicity** for **availability** and **autonomy**. Global state is **eventually consistent**; intermediate states are visible (order PENDING while payment in flight).

### Internal working — saga state machine

Each saga instance needs:

| Element | Purpose |
|---|---|
| **Saga ID** | Correlates all steps (often order ID or UUID) |
| **Current step** | Which local TX last succeeded |
| **Compensation stack** | Ordered list of undo actions |
| **Timeout** | Trigger compensation if step stalls |
| **Idempotency** | Duplicate events must not double-charge or double-release |

Persistence options: dedicated `saga_state` table, event sourcing the saga itself, or workflow engine (Temporal, Camunda, AWS Step Functions).

```sql
CREATE TABLE saga_instance (
    saga_id         UUID PRIMARY KEY,
    saga_type       VARCHAR(64) NOT NULL,
    current_step    VARCHAR(64) NOT NULL,
    status          VARCHAR(32) NOT NULL, -- RUNNING, COMPLETED, COMPENSATING, FAILED
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX saga_idempotency ON saga_step_log (saga_id, step_name, idempotency_key);
```

### Production scenario: Black Friday order saga timeouts

**Problem.** Inventory reserved; payment gateway slow (30s). Saga has no step timeout. Inventory locked for hours; oversell protection blocks legitimate orders.

**Solution.** Per-step timeout (e.g. 10s payment); on timeout → compensate inventory release; expose "payment processing" UI state; use async payment webhook to resume saga.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No saga persistence | Crash mid-saga → stuck PENDING orders forever |
| Compensations not idempotent | Double refund, negative inventory |
| Cyclic saga dependencies | Livelock, infinite compensation loops |
| Missing deadlock resolution between competing sagas | Two orders, one item — both compensate repeatedly |

### Debugging scenario

**Observe.** Orders stuck in `PAYMENT_PENDING` for 24h.

**Diagnose.** Query `saga_instance WHERE status = 'RUNNING' AND updated_at < now() - interval '1 hour'`. Check payment consumer lag; search DLQ for `PaymentFailed` events.

**Fix.** Saga reconciliation job; alert on stale RUNNING; manual compensation with audit trail.

---

## 5. Choreography vs Orchestration

### Core concept

Two ways to coordinate saga steps:

| Aspect | **Choreography** | **Orchestration** |
|---|---|---|
| Control | Decentralized; each service reacts to events | Central orchestrator directs steps |
| Coupling | Event contract coupling; implicit flow | Orchestrator knows full workflow |
| Visibility | Harder — flow spread across logs | Central saga log / UI |
| Change | Adding step = new consumer | Change orchestrator definition |
| Failure handling | Each service handles own compensation triggers | Orchestrator drives compensate |
| Best for | Simple pipelines, few steps | Complex branching, human tasks, SLAs |

**Choreography** diagram:

```
OrderSvc --OrderCreated--> Kafka --► InventorySvc
InventorySvc --Reserved--> Kafka --► PaymentSvc
PaymentSvc --Captured--> Kafka --► OrderSvc (confirm)
```

**Orchestration** diagram:

```
                ┌─────────────────┐
                │ Order Orchestrator │
                └────────┬────────┘
         command │      │ command      │ command
                  ▼      ▼              ▼
            Inventory  Payment      Notification
```

### Internal working — when choreography becomes a distributed ball of mud

Choreography works when:

- Steps are linear or simple fan-out
- Teams agree on event schemas and versioning
- Compensation is obvious from event types (`PaymentFailed` → inventory listens)

Choreography fails when:

- 8+ services need ordered reactions to one trigger
- "Who sends `OrderCompleted`?" disputes in every incident
- Need synchronous human approval in the middle
- Debugging requires reconstructing flow from 12 topics

Rule of thumb: **start choreography for 2–3 steps**; **introduce orchestrator when on-call cannot draw the flow from memory**.

### Production scenario: payment failure compensation race

**Problem.** Choreography: `PaymentFailed` consumed by Inventory (release) and Order (cancel). Order service processes first; emits `OrderCancelled`; Notification sends "order cancelled" before inventory released — customer reorders, oversell.

**Solution.** Orchestrator sequences: compensate inventory → wait ACK → cancel order → notify. Or choreography with `InventoryReleased` event gating order cancel.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| God topic with 20 consumers | One schema change breaks everyone |
| Orchestrator calls services synchronously in loop | Tight coupling; orchestrator becomes monolith |
| No correlation ID in choreography | Impossible distributed traces |
| Dual orchestration (Camunda + ad-hoc events) | Two sources of truth for saga state |

### Debugging scenario

**Observe.** Event replay causes duplicate shipments.

**Diagnose.** Choreography without idempotent consumers; replay from offset re-triggers `ShipOrder`.

**Fix.** Idempotency store per `(saga_id, event_type)`; orchestrator with dedupe; versioned event handlers.

---

## 6. Compensating Transactions

### Core concept

A **compensating transaction** is a **semantic undo** of a completed local transaction. It is not a database ROLLBACK — the original TX already committed and may be visible to other systems.

| Forward action | Naive undo | **Semantic compensation** |
|---|---|---|
| Deduct inventory | Re-add same quantity | Release reservation (may differ if partial ship) |
| Charge card | DELETE payment row | Issue refund (new TX, new id) |
| Send email | Cannot unsend | Send correction email |
| Create shipment label | — | Void label via carrier API |

Compensations must be:

1. **Idempotent** — retries safe
2. **Ordered** — often reverse order of forward steps (LIFO)
3. **Best-effort** — may fail; require reconciliation
4. **Business-meaningful** — "cancel" vs "refund" vs "credit note" are different products

### Internal working — compensation vs rollback

```
Forward (committed):
  inventory: reserved_qty += 1   [COMMITTED, visible]

Compensation:
  inventory: reserved_qty -= 1   [NEW local TX]
  -- if release fails, reconciliation job retries
```

**Pivot events** in saga literature: point of no return. After payment captured and fulfillment started, "compensation" may be **refund + return shipping** not simple cancel.

### Production scenario: compensation succeeds, forward retry also succeeds

**Problem.** Payment charge times out; saga compensates with refund. Original charge actually succeeded (late ACK). Customer got free product.

**Diagnose.** Missing **idempotency** and **payment status probe** before compensate.

**Solution.** Before refund: query payment provider with idempotency key. State machine: `UNKNOWN` → poll until `SUCCESS` or `FAILED`; only refund if confirmed success and business abort.

```java
public void compensatePayment(UUID paymentId, String idempotencyKey) {
    PaymentStatus status = paymentGateway.query(paymentId);
    if (status == NOT_FOUND || status == FAILED) {
        return; // idempotent no-op
    }
    if (status == SUCCEEDED) {
        paymentGateway.refund(paymentId, idempotencyKey + ":refund");
    }
    if (status == UNKNOWN) {
        throw new RetryableException("poll later");
    }
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| DELETE instead of compensating business action | Audit trail lost; regulatory violation |
| Compensation without idempotency key | Double refund |
| Compensating in wrong order | Release inventory before cancel payment — race for reorder |
| Ignoring non-reversible steps | Saga "completes" but business inconsistent |

### Debugging scenario

**Observe.** Finance reports refund count > failure count.

**Diagnose.** Duplicate `PaymentFailed` events; compensation not keyed.

**Fix.** Unique index on `refund_idempotency_key`; log compensation attempts in immutable audit table.

---

## 7. Data Consistency

### Core concept

**Consistency** in distributed systems spans a spectrum — not a boolean:

| Model | Guarantee | Microservice example |
|---|---|---|
| **Strong / linearizable** | Reads see latest write | Balance on ledger primary with sync repl |
| **Sequential** | All see same order of ops | Single Kafka partition consumer |
| **Causal** | Cause before effect | Comment thread ordering |
| **Read-your-writes** | User sees own updates | Session stickiness or version token |
| **Eventual** | Converges if no new writes | Search index, analytics |
| **Business invariant** | "Money conserved" over time | Saga + reconciliation batch |

**Microservices default:** **strong consistency inside service boundary** (local ACID), **bounded eventual consistency across boundaries**.

Invariants to document per bounded context:

- Order total matches sum of line items (local)
- Payment amount matches order total (cross-service — eventual or verified at confirm step)
- Inventory never negative (local constraint + reservation pattern)

### Internal working — enforcing cross-service invariants

Patterns:

1. **Saga with verify step** — before confirm, re-read payment and inventory
2. **Constraint in one service** — order service stores `payment_id` only after event
3. **Reconciliation job** — nightly compare payment DB vs order DB
4. **Idempotent keys** — prevent duplicate application of same logical operation

### Production scenario: "strong consistency" on read path across 4 services

**Problem.** Product demands checkout page shows live inventory, price, tax, shipping from four services synchronously. p99 = 4s; frequent failures.

**Solution.** BFF aggregates with caching and version stamps; show "confirm on submit" with server-side re-validation saga; do not block read on four strong reads.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No documented consistency model per API | Engineers assume linearizable |
| Cache without TTL/version | Forever stale prices |
| Dual writes (DB + cache) without transaction | Cache and DB diverge |
| Foreign key across service databases | Impossible referential integrity |

### Debugging scenario

**Observe.** Order total ≠ payment amount for 0.3% of orders.

**Diagnose.** Race: price changed between order create and payment; no version check.

**Fix.** Optimistic locking on `order_version`; payment step validates amount + version; reject mismatch with compensate.

---

## 8. Eventual Consistency Challenges

### Core concept

**Eventual consistency** means if updates stop, all replicas converge to the same value. **During convergence**, users see anomalies:

| Anomaly | User-visible effect | Mitigation |
|---|---|---|
| **Stale read** | Old inventory count | Version in UI; "may have changed" |
| **Read-your-writes violation** | Created order not in list | Route read to primary or wait for projection |
| **Monotonic read violation** | Page 2 older than page 1 | Session replica pinning |
| **Duplicate event processing** | Double ship | Idempotent consumer |
| **Lost event** | Missing order in search | Outbox + CDC; monitor lag |
| **Ordering violation** | Cancel before create applied | Per-aggregate partition key |

**CAP reminder:** under partition, choosing availability implies eventual consistency somewhere.

### Internal working — convergence time

Convergence time = f(replication lag, consumer lag, retry backoff, poison messages).

```
Write to orders_db (t=0)
  → outbox relay (t=50ms)
  → Kafka (t=100ms)
  → search consumer (t=2s under load)
  → Elasticsearch refresh (t=5s)
```

Product must define **SLA for consistency**, not engineers alone: "Search index within 30s" vs "within 1s" drives architecture cost.

### Production scenario: customer sees payment success, order missing

**Problem.** Payment service updates UI via webhook; order projection lags 60s on read model.

**Solution.** UI shows unified status from **orchestrator saga state** or poll order API with `read-your-writes` token; don't read search index for authoritative status.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No lag metrics on projections | Silent staleness until customer complaints |
| Unbounded consumer retry on bad message | Head-of-line blocking; growing lag |
| Same DB for write and heavy analytics | Replication lag hurts operational reads |
| Assuming Kafka order across partitions | Related events processed out of order |

### Debugging scenario

**Observe.** Elasticsearch order count < PostgreSQL.

**Diagnose.** Consumer lag, DLQ depth, failed mapping updates, full reindex needed.

**Fix.** Replay from known offset after fix; compare counts; alert on `abs(pg_count - es_count) > threshold`.

---

## 9. CQRS

### Core concept

**Command Query Responsibility Segregation** separates **write model** (commands, business rules, normalized storage) from **read model** (queries, denormalized projections optimized for UI).

```
Commands ──► Write DB (normalized) ──► events ──► Projectors ──► Read DB (denormalized)
                                                                              ▲
Queries ──────────────────────────────────────────────────────────────────────┘
```

CQRS is **not** mandatory for microservices. Use when:

- Read and write load profiles differ radically (100:1 reads)
- Complex queries would join many services
- Multiple UIs need different views of same data
- Event sourcing is in play

CQRS adds **complexity**: projection lag, schema duplication, sync discipline.

### Internal working — projection lifecycle

1. Command handler validates, writes aggregate to write store
2. Domain event emitted (outbox)
3. Projector consumes event, updates read model(s)
4. Query API serves read model only

Multiple read models from same event stream:

- `OrderSummaryView` for mobile list
- `OrderDetailView` for admin
- `OrderAnalyticsView` in warehouse

**Projector failure:** read model stale; write model still truth. Rebuild projection by replaying events from offset 0.

### Production scenario: CQRS without events — dual write

**Problem.** Team updates PostgreSQL and Elasticsearch in same service method. ES write fails → inconsistent; retry → duplicate document.

**Solution.** Single write to PostgreSQL + outbox; async projector to ES. Accept search lag.

```java
@Transactional
public void createOrder(CreateOrderCommand cmd) {
    Order order = orderFactory.create(cmd);
    orderRepository.save(order);
    outboxRepository.save(new OutboxEvent("OrderCreated", order.toEvent()));
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Query side mutates write model | CQRS benefits lost; coupling returns |
| One giant read model for all screens | Slow rebuilds; schema churn |
| No projection versioning | Cannot evolve read schema safely |
| Commands return read model from projection | Stale data returned to user after command |

### Debugging scenario

**Observe.** Admin dashboard order status wrong; detail API correct.

**Diagnose.** Two projections; one projector stuck; different consumer groups.

**Fix.** Monitor per-projector lag; idempotent upsert by order ID; integration test per projection.

---

## 10. Event Sourcing

### Core concept

**Event sourcing** stores state as a sequence of **immutable domain events** rather than current row values. Current state = replay all events (or snapshot + replay tail).

```
Events:
  OrderCreated { id, items, total }
  InventoryReserved { orderId, sku, qty }
  PaymentCaptured { orderId, paymentId, amount }
  OrderConfirmed { orderId }

State = fold(events)
```

Benefits:

- Complete audit trail
- Temporal queries ("what was balance on date X?")
- Natural integration via event stream
- Replay for new projections

Costs:

- Event schema evolution
- Storage growth
- Query complexity without CQRS read models
- Deleting data (GDPR) requires tombstone/compaction strategy

### Internal working — snapshots

Replay 10M events per aggregate is slow. **Snapshot** every N events:

```
Snapshot at v500: { status: CONFIRMED, total: 99.00, ... }
Replay events 501–520 on top
```

Snapshot store + event store must be consistent — usually snapshot in same aggregate TX as last processed event version check.

### Production scenario: GDPR right to erasure

**Problem.** Legal requires delete user data; event store is append-only with PII in every event.

**Solution.** Crypto-shredding (delete encryption key), event redaction pipeline, compaction with tombstone events, or separate PII service referenced by ID only in events. Plan **before** production — retroactive scrub is expensive.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Events as integration-only, not source of truth | Dual write between table and events |
| Mutable event log | Audit useless; replay non-deterministic |
| No upcasting/versioning | Cannot deploy new code on old events |
| Storing large blobs in events | Kafka log bloat; slow replay |

### Debugging scenario

**Observe.** Replay test gives different state than production.

**Diagnose.** Non-deterministic event handler (used `now()` without recording in event); bug fix changed fold logic without version bump.

**Fix.** Record time/decisions in events; version aggregate logic; regression test replay from fixture event files.

---

## 11. Outbox Pattern

### Core concept

The **transactional outbox** guarantees: **database change and outgoing message are atomic** within one service — without 2PC to the broker.

```
BEGIN LOCAL TX
  INSERT INTO orders (...) VALUES (...);
  INSERT INTO outbox (aggregate_id, event_type, payload, created_at)
    VALUES (...);
COMMIT

Separate process (relay):
  POLL outbox WHERE published = false
  PUBLISH to Kafka
  MARK published = true  (or DELETE)
```

Relay implementations:

- Polling publisher (simple, slight delay)
- **CDC on outbox table** (Debezium — low latency, no poll load)
- Log-based (same DB transaction log)

### Internal working — at-least-once to broker

Relay crash after publish before mark → **duplicate message** on retry. Consumers must be **idempotent**.

Ordering: publish outbox rows **in `created_at` order per aggregate** to preserve causal order on one partition (use aggregate ID as Kafka key).

```sql
CREATE TABLE outbox (
    id              BIGSERIAL PRIMARY KEY,
    aggregate_id    UUID NOT NULL,
    event_type      VARCHAR(128) NOT NULL,
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ
);

CREATE INDEX outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
```

### Production scenario: outbox table bloat

**Problem.** Relay marks published by DELETE; high volume; autovacuum cannot keep up; checkout slows.

**Solution.** Partition outbox by day; archive published batch to cold storage; or UPDATE `published_at` with periodic partition DROP. Monitor table size and relay lag.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Publish to Kafka inside `@Transactional` before commit | Message visible before DB commit |
| No relay HA | Outbox grows; events delayed hours |
| Multi-threaded relay breaks per-aggregate order | Inventory released before order created visible |
| Outbox in different DB than business data | Not atomic — defeats pattern |

### Debugging scenario

**Observe.** Orders in DB; no Kafka events.

**Diagnose.** Relay down; `SELECT COUNT(*) FROM outbox WHERE published_at IS NULL`. Debezium connector FAILED.

**Fix.** Restart relay; alert on unpublished count > threshold; replay unpublished in order.

---

## 12. Change Data Capture (CDC)

### Core concept

**CDC** streams **database row-level changes** (insert, update, delete) to consumers by reading the **transaction log** (WAL, binlog, oplog) — not polling tables with `updated_at`.

```
PostgreSQL WAL ──► Debezium ──► Kafka ──► Search projector
                              ──► Analytics
                              ──► Cache invalidation
```

Use cases:

- Outbox relay (read outbox inserts)
- Cache invalidation on row change
- Sync read models without application code in write path
- Integrate legacy DB with event-driven stack

### Internal working — Debezium on PostgreSQL

1. Connector creates **replication slot** on primary
2. Reads logical decoding plugin output (pgoutput)
3. Emits change events with before/after images
4. Tracks offset in Kafka Connect / external store

**Replica identity:** PostgreSQL needs `REPLICA IDENTITY FULL` for UPDATE/DELETE before image on some configs.

Operational concerns:

- Replication slot lag → WAL disk growth on primary
- Schema changes require connector handling / evolve
- Initial snapshot lock on large tables

### Production scenario: forgotten replication slot

**Problem.** Debezium connector removed; replication slot remains. WAL accumulates; disk full; primary down.

**Solution.** Monitor `pg_replication_slots` lag; drop orphaned slots in runbook; automate slot lifecycle with connector deployment.

```sql
SELECT slot_name, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag
FROM pg_replication_slots;
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| CDC from read replica without logical decoding | Connector fails or stale |
| No schema registry for CDC JSON | Consumer breaks on column add |
| Heavy transforms in connector only | Single point of failure; hard to test |
| CDC + application dual publish | Duplicate events |

### Debugging scenario

**Observe.** Search index has phantom deleted records.

**Diagnose.** CDC DELETE events not handled; tombstone compaction disabled in ES.

**Fix.** Handle `op=d` in projector; use document delete by ID; integration test DELETE path.

---

## 13. Distributed Locking

### Core concept

**Distributed locks** coordinate exclusive access to a resource across JVMs/pods. They are **not** transactions — they are **advisory** with failure modes.

Implementations:

| Implementation | Mechanism | Caveats |
|---|---|---|
| **Redis Redlock** | SET NX EX + quorum | Controversial; clock drift |
| **ZooKeeper / etcd** | Ephemeral sequential nodes | Session timeout edge cases |
| **DB advisory lock** | `pg_advisory_lock` | Ties to DB connection |
| **ShedLock** | DB row with expiry | Not fencing — TTL overlap |
| **Kafka partition** | Single consumer per key | Natural lock per aggregate |

**Martin Kleppmann:** locks without **fencing tokens** can allow stale leader to corrupt data after GC pause.

### Internal working — fencing token

```
1. Lock holder gets token T=58 from etcd
2. GC pause — lock expires
3. New holder gets token T=59
4. Old holder wakes, writes to storage with T=58
5. Storage rejects T < 59 → safe
```

Without fencing, step 4 corrupts state.

### Production scenario: ShedLock double execution

**Problem.** Nightly reconciliation job with ShedLock; job runs 45 min; lock TTL 30 min; second pod starts; duplicate payouts.

**Solution.** Extend lock heartbeat during job; or use workflow engine with single execution guarantee; make job idempotent.

```java
@SchedulerLock(name = "reconcilePayments", lockAtMostFor = "PT2H", lockAtLeastFor = "PT5M")
public void reconcile() { ... }
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Lock TTL < max task duration | Double execution |
| No idempotency under lock | Duplicates on lock race |
| Redis lock without value check | Wrong client unlocks |
| Distributed lock for every read | Throughput collapse |

### Debugging scenario

**Observe.** Rare duplicate inventory deduction.

**Diagnose.** Lock not held across async boundary; `@Transactional` ends before async completes.

**Fix.** Hold lock for full critical section; or use DB `UPDATE ... WHERE qty >= :n` atomic decrement without lock.

---

## 14. Database Sharding

### Core concept

**Sharding** partitions data horizontally across multiple database instances by **shard key** (user_id, tenant_id, order_id hash).

```
                    Router (application or proxy)
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
    Shard 0            Shard 1            Shard 2
  users 0-999        users 1000-1999     users 2000-2999
```

Goals: scale write throughput and storage beyond single node limits.

Challenges:

- Cross-shard queries (expensive or impossible)
- Resharding / rebalancing
- Hot shards (celebrity user)
- Distributed transactions across shards (avoid or 2PC)

### Internal working — shard key selection

Good shard key:

- High cardinality
- Even distribution
- Aligns with query patterns (most queries include shard key)
- Rarely changes

Bad: `country_code` alone → US shard hot.

**Consistent hashing** minimizes data movement when adding shards.

Vitess, Citus, MongoDB sharding, custom app routing are common patterns.

### Production scenario: cross-shard report

**Problem.** "Total revenue by product" requires all shards; query timeouts.

**Solution.** CQRS analytics shard fed by CDC; pre-aggregate; never run fan-out OLAP on operational shards.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Shard key not in every query | Scatter-gather on every request |
| Monotonic user ID without hash | New users pile on latest shard |
| Cross-shard FK | Unsupported; orphan rows |
| Resharding without dual-write period | Data loss during migration |

### Debugging scenario

**Observe.** One shard CPU 100%, others idle.

**Diagnose.** Hot tenant on single key; celebrity influencer.

**Fix.** Sub-shard by hash(tenant_id + salt); rate limit tenant; split hot tenant to dedicated shard.

---

## 15. Read Replicas

### Core concept

**Read replicas** copy data from **primary** (leader) to one or more **standbys** asynchronously or synchronously. Scale read throughput; geographic locality; DR.

| Replication mode | RPO on primary fail | Read staleness |
|---|---|---|
| Async | May lose last seconds | Replica lag seconds |
| Sync (quorum) | Minimal loss | Higher write latency |
| Semi-sync | Compromise | Variable |

Application must know **which reads tolerate lag**.

### Internal working — routing reads

Patterns:

1. **Primary only** — all reads and writes to primary (simplest)
2. **Explicit replica** — reporting API uses replica datasource
3. **Lag-aware routing** — if `replication_lag < 100ms`, use replica
4. **Session stickiness** — after write, same connection to primary

PostgreSQL: `pg_stat_replication` for lag. ProxySQL, RDS read endpoints, Spring `AbstractRoutingDataSource`.

### Production scenario: inventory oversell via replica read

**Problem.** Check stock on replica (stale); show available; write reservation on primary — oversold.

**Solution.** Stock **check for reservation** must read primary or use linearizable store; replica OK for browse catalog only.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Read-your-writes required but using replica | User confusion after update |
| No monitoring of replication lag | Silent stale reads |
| Long transactions on replica | Replication slot lag, bloat |
| Failover without app config update | Writes to read-only node |

### Debugging scenario

**Observe.** After deploy, 503 on writes.

**Diagnose.** Failover promoted replica; app still points to old primary IP.

**Fix.** Use DNS/service discovery with health check; Patroni + HAProxy; connection pool validation query.

---

## 16. Polyglot Persistence

### Core concept

**Polyglot persistence:** each service uses the **best-fit store** for its problem — PostgreSQL for transactions, Redis for cache, Elasticsearch for search, S3 for blobs, Neo4j for graph.

```
Order Service     → PostgreSQL
Session Service   → Redis
Search Service    → Elasticsearch
Analytics         → ClickHouse / BigQuery
Document Service  → S3
Recommendation    → Feature store + Redis
```

Trade-off: **operational complexity** — more backup strategies, more expertise, more failure modes.

### Internal working — choosing a store

| Need | Typical choice | Avoid |
|---|---|---|
| ACID ledger | PostgreSQL, CockroachDB | Elasticsearch as SoT |
| Full-text search | Elasticsearch, OpenSearch | LIKE '%foo%' on PG at scale |
| Time-series metrics | TimescaleDB, Prometheus | Relational row per metric |
| High write events | Kafka + ClickHouse | PG single table billions rows |
| Flexible schema docs | MongoDB | Shared Mongo for all services |

### Production scenario: Elasticsearch as primary database

**Problem.** Team stores orders only in ES; index corruption loses data; no multi-document ACID.

**Solution.** PostgreSQL SoT; ES projection; rebuild search from CDC replay.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Same data authoritative in two stores | Conflict resolution nightmares |
| No migration path between stores | Vendor lock-in panic |
| Ops team not trained on all stores | Slow incident response |
| Cross-store "join" in application | Latency + inconsistency |

### Debugging scenario

**Observe.** Redis cache shows balance; DB different.

**Diagnose.** Cache invalidation missed; TTL too long; write without cache eviction.

**Fix.** Cache-aside with CDC invalidation; or delete key on write path in same service.

---

## 17. Data Ownership

### Core concept

**Data ownership** means one bounded context is the **only writer** for its data. Other contexts consume via **API or events** — never direct DB access.

Rules:

1. **Single writer** per aggregate type
2. **Published language** — API contract or event schema is the public interface
3. **No shared tables** between teams
4. **Copy if needed** — consumer stores local copy (materialized view, cache) under its control

| Anti-pattern | Correct pattern |
|---|---|
| Order service JOINs `payments.payment` table | Order stores `payment_id`; subscribes to `PaymentCaptured` |
| Shared `users` table | User service owns profile; others cache `user_id`, display name |
| BI tool with write access to prod | Read replica + ETL with governance |

### Internal working — strangler for ownership migration

1. Identify bounded context and tables
2. Create new service DB; dual-write or CDC sync period
3. Switch writers to new service
4. Remove old direct access
5. Delete deprecated columns from shared DB

### Production scenario: analytics team queries production OLTP

**Problem.** Heavy Tableau queries on primary; checkout latency spikes.

**Solution.** Read replica for BI; or CDC to warehouse (Snowflake); contractual SLA that BI never hits primary.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| "Read-only" shared DB access for 5 services | Someone runs migration on shared schema |
| Event without owner team in registry | Schema change breaks unknown consumers |
| Copying full user PII to every service | GDPR scope explosion |

### Debugging scenario

**Observe.** Mystery updates to `orders.status`.

**Diagnose.** Legacy cron job still has DB credentials; bypasses order service.

**Fix.** Revoke credentials; audit DB roles; network policy DB only from order service SA.

---

## 18. Data Replication

### Core concept

**Replication** copies data between nodes or systems:

- **Primary-replica** (PostgreSQL streaming)
- **Multi-master** (conflict-prone; CRDT, LWW)
- **Geo-replication** (latency, compliance residency)
- **Logical replication** (table subset, cross-version)
- **Application-level** (event sync between services)

Distinct from **backup**: replication is continuous; backup is point-in-time recovery.

### Internal working — replication lag budget

Define **RPO** (recovery point objective) and **RTO** (recovery time):

| Tier | RPO | RTO | Replication |
|---|---|---|---|
| Payments ledger | 0 | < 1 min | Sync cross-AZ |
| Orders | < 1 min | < 5 min | Async + monitoring |
| Search index | hours | hours | Rebuild from events |

**Split brain** after failover: ensure old primary cannot accept writes (STONITH, fencing).

### Production scenario: async replication data loss on failover

**Problem.** Primary crashes; promote replica; last 30s of orders lost.

**Diagnose.** Async replication; no sync standby.

**Solution.** Business accepts RPO or pays for sync rep; outbox events on survivor for reconciliation with payment provider.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Replication without monitoring | Silent lag until failover surprise |
| Circular replication | Loops, conflicts |
| Wrong WAL retention | Replica cannot catch up after outage |
| Geo-rep ignoring GDPR | Data residency violation |

### Debugging scenario

**Observe.** Replica lag growing linearly.

**Diagnose.** Long query on replica; missing index on replica; network throttle.

**Fix.** `hot_standby_feedback`; kill long queries; parallel apply workers; upgrade replica hardware.

---

## 19. Cross-Service Queries

### Core concept

**You cannot JOIN across microservice databases** in one SQL statement without coupling. Options:

| Pattern | How | Trade-off |
|---|---|---|
| **API composition** | BFF calls N services | Latency, partial failure |
| **CQRS read model** | Denormalized local DB | Staleness, build cost |
| **GraphQL federation** | Schema stitches services | N+1, complexity |
| **Materialized cache** | Periodic sync | Staleness |
| **Duplicate data** | Each service stores needed fields | Sync discipline |
| **Saga read** | Aggregate on demand | Slow, not for lists |

**Avoid:** distributed JOIN in application thread per row (N+1 HTTP).

### Internal working — BFF aggregation with resilience

```java
public OrderDetailView getOrderDetail(UUID orderId) {
    Order order = orderClient.get(orderId);           // required
  CompletableFuture<User> user = userClient.getAsync(order.getUserId());
  CompletableFuture<Payment> pay = paymentClient.getAsync(order.getPaymentId());

  return CompletableFuture.allOf(user, pay)
      .thenApply(v -> mapper.toView(order, user.join(), pay.join()))
      .orTimeout(2, SECONDS)
      .exceptionally(ex -> mapper.toPartialView(order)) // degrade gracefully
      .join();
}
```

### Production scenario: "order list with customer name"

**Problem.** Order list page calls User service per row — 50 orders = 50 HTTP calls.

**Solution.** Denormalize `customer_name` on order at create time; or batch user API `GET /users?ids=...`; or CQRS list projection.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Synchronous chain > 3 services | Fragile, slow |
| No timeout on composed calls | Thread pool hang |
| Returning 500 if optional enricher fails | Whole page broken |
| Shared DB "just for reports" | Ownership leak |

### Debugging scenario

**Observe.** p99 order detail 8s after user service deploy.

**Diagnose.** User service regression; no circuit breaker; retries amplify.

**Fix.** Circuit breaker + fallback display "Customer unavailable"; fix user service; cache user names.

---

## 20. Database Migration

### Core concept

**Database migration** moves data between systems: monolith → microservice DB, shard rebalancing, cloud lift-and-shift, engine change (Oracle → PostgreSQL).

Phases:

1. **Assess** — volume, dependencies, downtime tolerance
2. **Dual-write** — write to old and new (or CDC one direction)
3. **Backfill** — historical data copy with verification
4. **Cutover** — switch reads, then writes
5. **Decommission** — remove old path after soak period

Tools: Flyway, Liquibase, pg_dump, AWS DMS, Debezium, custom batch jobs.

### Internal working — zero-downtime cutover

```
Phase 1: New service reads old DB (legacy)
Phase 2: CDC old → new; new service dual-read compare
Phase 3: New writes to both; verify counts
Phase 4: Switch reads to new
Phase 5: Stop writes to old
Phase 6: Remove CDC
```

**Verification:** row counts, checksum samples, business invariants, shadow traffic comparison.

### Production scenario: bigint PK overflow migration

**Problem.** `orders.id` INT max approaching; need BIGINT; table 2TB; lock time unacceptable.

**Solution.** Expand-only migration: add `id_bigint` column; backfill in batches; dual-read; switch PK in maintenance window with online schema change (pt-online-schema-change, gh-ost).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Big-bang cutover without rollback | Extended outage |
| No id mapping between old/new IDs | Broken foreign references in events |
| Migration during peak | Replication meltdown |
| Charset/collation mismatch | Silent data corruption |

### Debugging scenario

**Observe.** After migration, 2% orders missing in new DB.

**Diagnose.** Backfill job skipped rows with `updated_at` before cursor bug; deletes not replicated.

**Fix.** Reconcile diff query; fix cursor; idempotent upsert missing rows; delay decommission.

---

## 21. Schema Migration

### Core concept

**Schema migration** evolves table structure in deployed environments — distinct from data migration but often combined.

**Expand-contract** pattern for zero downtime:

1. **Expand** — add new column/table (nullable)
2. **Deploy** app writing both old and new
3. **Backfill** new column
4. **Deploy** app reading new only
5. **Contract** — drop old column

Never deploy **breaking** schema change (drop column, NOT NULL without default) before all app instances updated.

### Internal working — Flyway/Liquibase in CI

```sql
-- V20240831__add_order_version.sql (expand)
ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
```

```java
@Transactional
public void updateOrder(Order o) {
    int updated = jdbc.update(
        "UPDATE orders SET status=?, version=version+1 WHERE id=? AND version=?",
        o.getStatus(), o.getId(), o.getVersion());
    if (updated == 0) throw new OptimisticLockException();
}
```

Per-service migrations: each service owns its Flyway history — no shared migration repo across services unless shared DB (anti-pattern).

### Production scenario: NOT NULL column added in one release

**Problem.** `ALTER ADD COLUMN status TEXT NOT NULL` — deploy hits old pods inserting without column → failure.

**Solution.** Add nullable → backfill → set NOT NULL in later migration.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Manual prod DDL outside Flyway | Drift; CI fails next deploy |
| Long-running migration locks table | Checkout down |
| Renaming column in place | Old code breaks mid-deploy |
| Shared migration for 3 services | Coupled releases return |

### Debugging scenario

**Observe.** Flyway validation failed on deploy.

**Diagnose.** Someone edited applied migration file; checksum mismatch.

**Fix.** Never edit applied migrations; add new migration to correct; `repair` only with governance.

---

## 22. Production Debugging Playbook

When data bugs are "random," it is usually **dual write**, **missing idempotency**, **replica lag**, or **saga stuck without timeout**.

1. **Classify the symptom.** Stale read vs lost write vs duplicate vs stuck intermediate state. Ask: is authoritative store wrong or projection wrong?

2. **Identify source of truth.** Which service **owns** this data? Query primary DB of owner — not replica, not cache, not search index.

3. **Trace correlation ID** across services, outbox, Kafka, consumers. Build timeline: local TX commit → outbox publish → consumer process.

4. **Check replication and projection lag.**

   ```sql
   -- PostgreSQL replica lag
   SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS lag_seconds;
   ```

   Kafka: consumer group lag per partition. Elasticsearch: `_cat/indices` doc count vs source.

5. **Saga state.** Query `saga_instance` / workflow engine for stuck RUNNING. Check DLQ depth and poison messages.

6. **Idempotency gaps.** Search logs for duplicate `event_id` or same idempotency key with different outcomes.

7. **Lock and TX issues.** `pg_stat_activity` for `idle in transaction`, `pg_locks`, prepared XA transactions.

8. **CDC health.** `pg_replication_slots`, Debezium connector status, WAL disk usage.

9. **Compare counts** between systems (sample + checksum). Automate reconciliation dashboards.

10. **Fix forward, then reconcile.** Compensate or repair data; document RPO impact; postmortem with ownership map update.

Never run heuristic XA rollback in production without TM runbook. Never "fix" stale cache by disabling TTL without understanding write path.

---

## 23. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Single service, one database | Local `@Transactional` ACID — stop there |
| Cross-service business flow | Saga + outbox + idempotent consumers |
| Must publish event with DB write | Transactional outbox (not dual write) |
| Homogeneous 2 DBs, low volume, legacy | XA/2PC only if ops team owns TM HA |
| Read-heavy UI, complex queries | CQRS read model fed by events/CDC |
| Full audit + replay requirements | Event sourcing + snapshots on write side |
| Search / analytics | Projection from CDC; never SoT in ES |
| Inventory / balance reservation | Primary DB read or atomic `UPDATE ... WHERE` |
| Scale writes beyond one node | Shard by tenant/user; avoid cross-shard TX |
| Reporting / BI | Read replica or warehouse via CDC |
| Cross-service list with enrichments | Denormalize on write or batch fetch API |
| Schema change in production | Expand-contract; never drop-before-deploy |
| Migrate monolith table to service | CDC + dual-write + verify + cutover |
| Exclusive job / cron | ShedLock + idempotent job body; or workflow engine |
| "Exactly-once" across services | Idempotent consumers + outbox; not Kafka EOS alone |
| Celebrity / hot shard | Sub-shard, dedicated tenant, rate limit |
| GDPR delete | Plan in event-sourced systems before go-live |
| Debugging wrong customer balance | Owner service primary DB → then replication → then cache |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Why not use 2PC for all microservice transactions?</summary>

2PC blocks resources during prepare, needs durable coordinator, performs poorly across heterogeneous systems and WAN latency. Failure leaves in-doubt transactions. Microservices prioritize **availability and autonomy** — sagas with compensations match that; 2PC matches legacy same-DC homogeneous stacks.

---

</details>

<details class="qa-item">
<summary>2. How does outbox differ from dual write?</summary>

Dual write: DB commit then Kafka publish — crash between = inconsistency. Outbox: same local TX inserts row + outbox record — atomic. Relay may duplicate to broker; consumers idempotent. Outbox fixes **ordering with commit**; dual write does not.

---

</details>

<details class="qa-item">
<summary>3. Choreography or orchestrator for checkout?</summary>

3–4 linear steps with clear events: choreography OK with discipline. Branching (payment method, fraud hold, partial ship): orchestrator (Temporal/Camunda) gives visibility, timeouts, and compensation order. Hybrid: orchestrate payment path, choreograph notifications.

---

</details>

<details class="qa-item">
<summary>4. What is a compensating transaction vs rollback?</summary>

Rollback undoes uncommitted work in one DB session. Compensation is **new business action** after commit — refund, release reservation, credit note. Cannot rollback committed charge; must refund with idempotency.

---

</details>

<details class="qa-item">
<summary>5. How do you guarantee read-your-writes after creating an order?</summary>

Read from primary after write; return `ETag`/version to client; BFF passes version to list API; or short client poll until visible; or route session to same replica with lag check. Do not read search index for confirmation.

---

</details>

<details class="qa-item">
<summary>6. Explain CQRS without event sourcing.</summary>

Separate write model (normalized PG) and read model (denormalized table or ES). Projector syncs via outbox events or CDC. Writes go to command side; queries hit read side. No event store as SoT — current write table still authoritative.

---

</details>

<details class="qa-item">
<summary>7. When would you use event sourcing?</summary>

Audit/legal replay, temporal queries, complex aggregate lifecycle, multiple projections from same history. Avoid for simple CRUD with no audit need — operational cost of schema evolution and GDPR is high.

---

</details>

<details class="qa-item">
<summary>8. CDC vs application publishing events?</summary>

Application events: rich domain semantics, explicit versioning, only business-meaningful changes. CDC: captures all row changes including admin fixes, bypasses app bugs missing publish, enables legacy integration. Often **both**: domain events via outbox + CDC for analytics replica.

---

</details>

<details class="qa-item">
<summary>9. How to handle duplicate Kafka messages?</summary>

Idempotent consumer: `processed_events(event_id)` unique index; business idempotency keys; upsert read models; deterministic handlers. At-least-once + idempotency = effective exactly-once processing.

---

</details>

<details class="qa-item">
<summary>10. Shard key for multi-tenant SaaS?</summary>

`tenant_id` if tenants evenly sized; hash(tenant_id) for index size; isolate mega-tenants on dedicated shard. Queries must include tenant_id. Cross-tenant reports via warehouse, not scatter-gather OLTP.

---

</details>

<details class="qa-item">
<summary>11. Read replica OK for which operations?</summary>

Browse catalog, dashboards with "as of" disclaimer, analytics. Not OK: stock reservation, balance check, idempotency key lookup after write, uniqueness enforcement.

---

</details>

<details class="qa-item">
<summary>12. Polyglot persistence example for e-commerce.</summary>

Orders/payments: PostgreSQL ACID. Session cart: Redis TTL. Search: Elasticsearch projection. Images: S3. Recommendations: feature store. Each owned by one service; sync via events/CDC.

---

</details>

<details class="qa-item">
<summary>13. Cross-service query: order history with product thumbnails?</summary>

Denormalize thumbnail URL on order line at purchase time; or CQRS `OrderHistoryView` fed by Order + Catalog events; or BFF batch `GET /products?ids=` with cache. Never 50 sequential product calls.

---

</details>

<details class="qa-item">
<summary>14. Zero-downtime schema change steps?</summary>

Expand-contract: add nullable column → deploy dual-write → backfill → deploy read new → add NOT NULL → drop old. Use online schema change tools for large tables. Feature flags gate new code paths.

---

</details>

<details class="qa-item">
<summary>15. Saga stuck in RUNNING — how to debug?</summary>

Check last successful step in saga store; consumer lag on next topic; DLQ for failed event; payment gateway webhook delay; step timeout config. Run reconciliation job; manually compensate with audit if needed.

---

</details>

<details class="qa-item">
<summary>16. Distributed lock without fencing — real failure?</summary>

Leader pauses (GC), lock expires, new leader works, old leader resumes and writes — duplicate batch payout. Fix: fencing tokens in storage layer or use DB compare-and-swap with version column.

---

</details>

<details class="qa-item">
<summary>17. How does Debezium affect PostgreSQL primary?</summary>

Creates logical replication slot; WAL retained until consumed; lag causes disk growth. Monitor slot lag; avoid orphaned slots; `REPLICA IDENTITY FULL` overhead on updates. Plan slot management in connector lifecycle.

---

</details>

<details class="qa-item">
<summary>18. Eventual consistency acceptable for what business cases?</summary>

Search ranking, recommendations, analytics, non-critical notifications. Not acceptable without mitigation: account balance display (use strong read or versioned UI), inventory at checkout (reservation on primary), legal invoice totals (verify before issue).

---

</details>

<details class="qa-item">
<summary>19. Migrate 500GB orders table to new service DB?</summary>

CDC or batch backfill with cursor; dual-write period; checksum validation; shadow read compare; gradual traffic shift; keep rollback path until soak complete. Id mapping table for old_id → new_id in events.

---

</details>

<details class="qa-item">
<summary>20. TCC vs Saga?</summary>

**TCC:** Try-Reserve-Confirm/Cancel — resources reserved in Try phase; Confirm commits reservation. Stronger isolation for inventory/money; more invasive code (three interfaces per service). **Saga:** simpler local TX + compensate; more visible intermediate state. TCC when reservation conflicts are costly; saga for most ecommerce flows.

---

</details>

<details class="qa-item">
<summary>21. Why is shared database an anti-pattern?</summary>

Couples schema evolution, scaling, deployment, and ownership. One team's migration blocks others. Violates microservice autonomy. Creates distributed monolith with network hops but same DB failure domain.

---

</details>

<details class="qa-item">
<summary>22. Optimistic locking in distributed updates?</summary>

Version column on aggregate; update `WHERE id=? AND version=?`; conflict → retry or return 409. Works within one service DB. Cross-service: use saga + business retry or merge policy — not global row lock.

---

</details>

<details class="qa-item">
<summary>23. How to test saga compensations?</summary>

Integration tests with testcontainers: inject failure after step 2; assert compensation events and final DB state. Chaos on payment provider mock. Property: compensation idempotent when invoked twice.

---

</details>

<details class="qa-item">
<summary>24. `REPEATABLE READ` enough for inventory?</summary>

Within single DB TX, `SELECT FOR UPDATE` or atomic `UPDATE qty = qty - 1 WHERE qty >= 1` prevents oversell in one service. Cross-service inventory requires reservation saga or central inventory partition — isolation level does not cross network.

---

</details>

<details class="qa-item">
<summary>25. Compare logical vs physical database per service.</summary>

**Physical:** separate instance — true blast radius isolation, higher cost. **Logical:** separate schema on shared cluster — cheaper; shared failure domain and noisy neighbor risk. Production microservices often start logical, split physical for hot services.

---

</details>

<details class="qa-item">
<summary>26. Handling ordering in saga with multiple instances?</summary>

Partition Kafka by `order_id`; single consumer per partition; or orchestrator serializes steps per saga instance. Outbox relay orders by aggregate. Never parallelize steps that depend on prior commit visibility.

---

</details>

<details class="qa-item">
<summary>27. Reconciliation job design?</summary>

Periodic compare owner DB vs downstream (payment provider API, warehouse). Emit metrics `mismatch_count`; auto-repair idempotent rows; alert on threshold; immutable audit log for manual fixes. Source of truth hierarchy documented.

---

</details>

<details class="qa-item">
<summary>28. Can GraphQL solve cross-service consistency?</summary>

GraphQL solves **query composition**, not consistency. Federation still hits multiple services with respective consistency models. Mutations should target single service or orchestrated BFF saga — not federated multi-write without design.

---

</details>

<details class="qa-item">
<summary>29. Pitfalls of Redis cache-aside for product prices?</summary>

Invalidation race: DB updated, cache stale until TTL. Thundering herd on expiry. Fix: write-through in catalog service, CDC invalidation, versioned cache keys, short TTL + singleflight on miss.

---

</details>

<details class="qa-item">
<summary>30. Interview: "Design order + payment + inventory."</summary>

Order service owns order (PG + outbox). Saga: create PENDING → reserve inventory (event) → charge payment (event) → confirm or compensate LIFO. Idempotency keys throughout. UI reads saga status. Nightly reconciliation with payment gateway. No 2PC; no shared DB.

---

</details>

<details class="qa-item">
<summary>31. What breaks when you add read replica without code change?</summary>

Application still talks to primary only — no benefit. If driver auto-load-balances reads without lag awareness — stale reads and read-your-writes violations. Must explicitly route queries and define tolerances.

---

</details>

<details class="qa-item">
<summary>32. Schema migration failed mid-deploy — rollback strategy?</summary>

Blue/green or rolling: new code backward compatible with old schema. If migration applied but code rolled back, forward-fix migration (re-add dropped column nullable) rather than restore from backup unless data loss acceptable. Flyway undo rare in prod — prefer expand-contract.

---

</details>

<details class="qa-item">
<summary>33. Event schema evolution — add required field?</summary>

Never break old consumers: add optional field with default in upcaster; dual-write both formats during transition; consumers handle missing field; remove old format after deprecation window. Schema registry compatibility BACKWARD_TRANSITIVE for consumers.

---

</details>

<details class="qa-item">
<summary>34. Why monotonic reads matter in account settings page?</summary>

User updates email, refreshes, sees old email — believes save failed, retries, creates duplicate tickets. Monotonic reads via primary or session-scoped replica pinning after write.

---

</details>

<details class="qa-item">
<summary>35. Split brain after DB failover — data layer?</summary>

Old primary must be fenced (STONITH, disable VIP). Apps use leader-aware connection string. Writes with **epoch/generation** rejected on stale primary. Test failover quarterly; measure RPO with async rep honestly.

---

</details>

<details class="qa-item">
<summary>36. Is Kafka transactional exactly-once enough for microservices?</summary>

Kafka EOS covers producer + consumer within Kafka streams processing. Cross-service exactly-once needs transactional outbox on DB side + idempotent consumers — broker EOS does not commit your PostgreSQL order row atomically with external side effects.

---

</details>

<details class="qa-item">
<summary>37. Cross-shard transaction needed for transfer between users?</summary>

Avoid if possible: redesign so both accounts in same shard (shard by `account_id % N` with consistent routing). If unavoidable: 2PC across shards (Citus, custom) or saga with debit/credit compensations and reconciliation — accept temporary inconsistency window.

---

</details>

<details class="qa-item">
<summary>38. Data ownership dispute in incident — how to resolve?</summary>

Consult bounded context map: writer service fixes data. Consumers rebuild projection from events. No direct patch on consumer copy without fixing owner. Postmortem updates ownership registry and on-call routing.

---

</details>

<details class="qa-item">
<summary>39. When to use materialized view vs CQRS projection?</summary>

Materialized view in same DB as write: simpler, same ownership, refresh lag managed by DB. CQRS projection: different store, scale independently, cross-service data via events. Cross-service → CQRS; same-service read optimization → mat view OK.

---

</details>

<details class="qa-item">
<summary>40. Production metric stack for data consistency?</summary>

Outbox unpublished count; consumer lag; replication lag; saga RUNNING age; reconciliation mismatch rate; DLQ depth; projection doc count drift; p99 relay latency. Alert on business SLO ("99% orders confirmed < 30s") not only infra metrics.

</details>

---

*Distributed data does not fail because you chose the wrong database. It fails because ownership was shared, consistency was assumed, and compensations were an afterthought. Own the write path per service, make cross-boundary behavior explicit, and reconcile before customers do.*
