# Core Architecture — Microservices Senior Production Reference

Spring Boot 3.x / Java 17+. This is not a "what is a microservice" tutorial. It is the reference for what actually breaks after you split the monolith, ship fifteen services to Kubernetes, and discover that **distributed systems do not forgive organizational shortcuts**. The focus is decomposition decisions, data ownership, operational boundaries, and the failure modes that look like "network flakiness" but are actually architecture debt.

---

## Table of Contents

1. [Microservices Fundamentals](#1-microservices-fundamentals)
2. [Monolith vs Microservices](#2-monolith-vs-microservices)
3. [Service Decomposition & Boundaries](#3-service-decomposition-boundaries)
4. [Service Granularity](#4-service-granularity)
5. [Domain-Driven Design (DDD)](#5-domain-driven-design-ddd)
6. [Bounded Context](#6-bounded-context)
7. [Domain Events](#7-domain-events)
8. [Database per Service](#8-database-per-service)
9. [Shared Database Anti-pattern](#9-shared-database-anti-pattern)
10. [Stateless vs Stateful Services](#10-stateless-vs-stateful-services)
11. [Twelve-Factor App](#11-twelve-factor-app)
12. [Distributed Monolith](#12-distributed-monolith)
13. [Conway's Law](#13-conways-law)
14. [Service Ownership](#14-service-ownership)
15. [Production Debugging Playbook](#15-production-debugging-playbook)
16. [Quick Decision Matrix](#16-quick-decision-matrix)

---

## 1. Microservices Fundamentals

### Core concept

A **microservice** is an independently deployable unit that owns a **cohesive business capability**, exposes it through well-defined interfaces (HTTP/gRPC/events), and persists its state in storage it controls. The "micro" refers to **scope of responsibility**, not line count. A 200k-LOC billing service that deploys on its own cadence and owns invoice state is a microservice. A 3k-LOC "user-utils" library deployed as a jar inside six other services is not.

The architectural bet is **replaceability and team autonomy** at the cost of **distributed complexity**: partial failures, eventual consistency, observability tax, contract evolution, and operational headcount. Microservices are a **socio-technical** pattern. The runtime topology is the easy part; the hard part is deciding who may change what schema on Tuesday without paging five teams.

Three invariants senior teams enforce:

| Invariant | What it means in production |
|---|---|
| **Independent deployability** | A service can roll to prod without coordinated releases of sibling services (feature flags and backward-compatible contracts assumed) |
| **Encapsulated persistence** | No other service reads or writes this service's tables directly |
| **Explicit interfaces** | Synchronous APIs and/or async events are versioned, monitored, and owned |

Everything else — service mesh, Kafka, Kubernetes — is **implementation detail**, not definition.

### Internal working: the request lifecycle

A typical user-facing flow crosses multiple services. Understanding where state lives and where failures surface prevents misdiagnosis.

```
Client (browser / mobile)
  └─ Edge (CDN, WAF, API Gateway / BFF)
       └─ Service A — Order API          (state: order aggregate, outbox row)
            ├─ sync: GET  Inventory Svc  (read stock, no local cache of truth)
            ├─ sync: POST Payment Svc    (authorize; idempotency-key header)
            └─ async: publish OrderPlaced  → Kafka topic orders.events
                 └─ Service B — Fulfillment (consumer group fulfillment-v3)
                      ├─ writes shipment row (own DB)
                      └─ async: ShipmentCreated → Notification Svc
```

Failure propagation rules:

- **Sync call failure** rolls back the caller's local transaction *if* the caller designed for it. Many teams forget that HTTP timeout ≠ rollback on the callee side.
- **Async failure** retries, lands in DLQ, or poisons the partition depending on consumer design. The user may already have seen "Order placed."
- **Partial success** is the default mode unless you implement sagas, outbox, or idempotent consumers.

### Spring Boot service skeleton

Production services share a common skeleton. Deviations should be deliberate.

```java
@SpringBootApplication
@EnableScheduling  // only if you run outbox relay / housekeeping
public class OrderServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(OrderServiceApplication.class, args);
    }
}

@RestController
@RequestMapping("/api/v1/orders")
@Validated
public class OrderController {

    private final PlaceOrderUseCase placeOrder;

    public OrderController(PlaceOrderUseCase placeOrder) {
        this.placeOrder = placeOrder;
    }

    @PostMapping
    ResponseEntity<OrderResponse> place(
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody PlaceOrderRequest request) {
        Order order = placeOrder.execute(idempotencyKey, request);
        return ResponseEntity
            .created(URI.create("/api/v1/orders/" + order.id()))
            .body(OrderResponse.from(order));
    }
}
```

```yaml
# application.yml — baseline production config
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:postgresql://${DB_HOST}/orders_db
  kafka:
    bootstrap-servers: ${KAFKA_BROKERS}
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  tracing:
    sampling:
      probability: 0.1
server:
  shutdown: graceful
```

### Production scenario: "we have microservices" but shared runtime

**Problem.** Twelve `@SpringBootApplication` repos, but all deploy as WARs into one WebLogic cluster sharing a datasource JNDI binding. Releases require a maintenance window. One team's memory leak restarts the cluster.

**Cause.** Packaging split without **deployable independence**. The org renamed modules "services" without changing the deployment unit.

**Solution.** One process per service, separate CI/CD pipeline, separate health checks, separate DB credentials. If WebLogic is immovable short-term, at minimum separate datasources and independent rolling restart groups — but treat that as a bridge, not the target architecture.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Shared database across "services" | Schema migration conflicts; mysterious cross-team data corruption |
| No `spring.application.name` / inconsistent service naming in traces | Cannot correlate logs across Zipkin/Jaeger |
| Synchronous chains > 3 hops for writes | P99 latency spikes; cascading timeouts under load |
| No idempotency on POST | Duplicate orders on client retry |
| Library copy-paste instead of shared kernel | Divergent bug fixes; "works in catalog, broken in checkout" |

### Debugging scenario

**Observe.** Order service returns 500 intermittently; inventory service metrics look fine.

**Diagnose.** Trace shows inventory p99 40ms but order service thread pool exhausted. Check connection pool to **order DB** and outbound HTTP client pool — not inventory. Often the order service blocks on its own outbox relay or a `@Transactional` method that holds a DB connection while calling inventory.

**Fix.** Shorten transaction boundary: persist order + outbox in one TX, publish after commit. Use `@TransactionalEventListener(phase = AFTER_COMMIT)` or transactional outbox relay.

---

## 2. Monolith vs Microservices

### Core concept

A **monolith** is a single deployable that contains multiple business capabilities, usually sharing one codebase and often one database. It optimizes for **simplicity of change** inside the boundary: one IDE refactor, one integration test suite, one transaction boundary, one deployment artifact.

Microservices optimize for **independent evolution** across team boundaries. Neither is morally superior. The trade is:

```
Monolith strengths                    Microservices strengths
─────────────────────                 ─────────────────────────
ACID cross-aggregate updates          Team-scale autonomy
Simple debugging (one process)        Independent scaling per hot path
Lower baseline operational cost       Technology heterogeneity per service
Fast local integration tests          Blast-radius containment on deploy
```

The worst outcome is **distributed monolith** (see section 12): microservice labels on a graph that must release in lockstep.

### Decision framework

Ask these in order:

1. **Is the domain stable enough to draw boundaries?** If the business model changes weekly, premature splitting cemented wrong seams.
2. **Do multiple teams need to ship daily on different parts?** If one team owns everything, a modular monolith (Gradle modules, arch-unit rules) often wins.
3. **Are non-functional requirements diverging?** Example: search needs Elasticsearch scaling; billing needs strong consistency and audit — different services justified.
4. **Can you afford the platform?** CI/CD per service, observability, on-call rotation, contract testing, feature flags, secrets rotation.

### Modular monolith as middle path

Spring Boot supports a **modular monolith**: one deployable, strict module boundaries enforced by ArchUnit.

```java
@AnalyzeClasses(packages = "com.acme")
public class ArchitectureTest {
    @ArchTest
    static final ArchRule billing_does_not_depend_on_shipping =
        noClasses().that().resideInAPackage("..billing..")
            .should().dependOnClassesThat().resideInAPackage("..shipping..");
}
```

Extract to a microservice when a module's **deployment frequency**, **scaling profile**, or **team ownership** diverges — not because a conference slide said so.

### Production scenario: big-bang rewrite to microservices

**Problem.** 18-month "strangler" project builds 20 services from scratch. Old monolith still serves 80% traffic. New stack misses edge cases. CFO asks why velocity dropped.

**Cause.** **Big-bang decomposition** without incremental value delivery. Teams duplicated domain logic instead of strangling read paths first.

**Solution.** Strangler fig pattern:

```
Phase 1: Extract read-heavy paths (product catalog API) — low risk
Phase 2: Async boundaries (events for notifications, analytics)
Phase 3: Write paths with sagas (checkout) — highest risk, last
```

Keep monolith authoritative until the new service proves parity via shadow traffic and contract tests.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Splitting by technical layer (DAO service, REST service) | Chatty network; no business ownership |
| Microservices for < 10 engineers | Ops toil exceeds dev speed gain |
| Keeping monolith DB while splitting apps | Hidden coupling; cannot evolve schemas |
| No rollback plan per service | Forward-only fixes; long incidents |

### ASCII: strangler routing

```
                    ┌─────────────────┐
  Client ──────────►│  API Gateway    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        /catalog/**     /legacy/**     /checkout/**
              │              │              │
              ▼              ▼              ▼
        Catalog Svc    Monolith       Checkout Svc
        (new, read)    (writes)       (new, saga)
```

---

## 3. Service Decomposition & Boundaries

### Core concept

**Decomposition** is cutting the system so that each piece can change for **one reason** (business capability) rather than for **one technology** (layer). Good boundaries align with **verbs the business uses**: `PlaceOrder`, `CalculateTax`, `ShipPackage`. Bad boundaries align with nouns stripped of behavior: `DataService`, `CommonUtils`, `EntityManager`.

Heuristics that survive production:

| Heuristic | Application |
|---|---|
| **High cohesion** | Everything inside the service changes together when the business rule changes |
| **Low coupling** | Prefer events or queries over fine-grained RPC chatter |
| **Volatility matching** | Fast-changing experiments don't live in the same deployable as regulated audit ledgers |
| **Data ownership** | The service that owns the lifecycle of an aggregate owns its storage |

### Internal working: identifying seams

Use **event storming** outputs: commands, aggregates, policies, external systems. Each aggregate cluster with minimal cross-aggregate synchronous need is a candidate service boundary.

```
Domain: Order fulfillment

Aggregates:
  Order (Order Service) ──policy──► Inventory (reserve stock)
  Shipment (Fulfillment Service)
  Invoice (Billing Service)

Wrong cut:
  Order + Shipment in one DB because "they're related" — couples scaling and release
  OrderLineItem table shared — guarantees cross-team migrations
```

### Spring module boundary example

Package-by-feature inside a service (even before split):

```
com.acme.orders/
  api/          ← controllers, DTOs
  application/  ← use cases, @Transactional boundaries
  domain/       ← aggregates, domain events (no Spring)
  infrastructure/ ← JPA, Kafka adapters
```

Cross-package rule: `domain` never imports `infrastructure`. When you extract `billing`, you lift `domain` + `application` with minimal surgery.

### Production scenario: entity-split decomposition

**Problem.** Team splits `User`, `Address`, `Preferences` into three services because they are three tables. Checkout now needs three HTTP calls to render a confirmation page. Latency doubles; one service outage blocks checkout.

**Cause.** **Database-table decomposition** instead of **capability decomposition**. Address lifecycle is not independent from User in this domain.

**Solution.** Merge Address into Identity service. Expose one read model (`GET /users/{id}/profile`) optimized for consumers. Defer split until a genuine independent release cadence exists (e.g., Preferences becomes ML-driven experimentation platform).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| "God service" anti-pattern | `platform-service` with 400 endpoints; no owner |
| Nano-services (validate-email-svc) | Network overhead > compute |
| Circular dependencies A→B→A | Deploy ordering puzzles; partial startup failures |
| Shared DTO jar version hell | Consumer compile breaks on provider deploy |

### Debugging scenario

**Observe.** Frequent 503 from gateway during deploys of unrelated services.

**Diagnose.** Dependency graph: does Service X call Service Y at startup (`@PostConstruct` health fan-out)? Circular health checks create **startup thundering herd**.

**Fix.** Lazy clients, `@ConditionalOnProperty` for optional integrations, readiness vs liveness separation:

```java
@Component
public class DownstreamHealthIndicator implements HealthIndicator {
    private final InventoryClient client;

    @Override
    public Health health() {
        try {
            client.ping();
            return Health.up().build();
        } catch (Exception e) {
            // readiness fails; liveness stays up — pod not killed if optional
            return Health.outOfService().withException(e).build();
        }
    }
}
```

---

## 4. Service Granularity

### Core concept

**Granularity** is the size of a service's responsibility relative to the business and the org. There is no universal optimal size — only **fit to team topology and change frequency**.

Rules of thumb (not laws):

| Signal | Finer granularity | Coarser granularity |
|---|---|---|
| Team count | Many teams, Conway-aligned | One team, modular monolith |
| Change frequency | Subsystem ships daily vs quarterly | |
| Consistency needs | Eventual OK across boundary | Need cross-aggregate ACID |
| Load profile | One hot endpoint needs 10× scale | Uniform load |

**Two Pizza Team** is an organizational heuristic, not a sizing metric. A billing service may need eight engineers at tax season — still one service if the domain is cohesive.

### Internal working: the decomposition pendulum

Organizations swing:

```
Too coarse (monolith) ──split──► Too fine (nano-services) ──merge──► Right-sized
```

Detect **too fine** when:

- Median handler does one DB query and returns
- > 50% CPU spent in serialization/network
- Incident requires coordinating > 4 services for a one-line business rule change

Detect **too coarse** when:

- One service's deploy blocks entire product release
- Unrelated teams conflict in same Git repo daily
- Scaling the service scales cold modules together (waste)

### Production scenario: premature extraction of "NotificationService"

**Problem.** NotificationService handles email, SMS, push, in-app, webhook fan-out. 200 LOC. But every product team waits on notification team for template changes. Deploy queue is shared.

**Cause.** Service boundary drawn on **channel** not **ownership**. Templates are product-specific; transport is generic.

**Solution.** **Split by rate of change**:

```
notification-dispatcher (infra team) — SES, Twilio adapters, retry, DLQ
notification-templates (product teams via config / CMS) — not a microservice, config service
domain services publish NotificationRequested events with templateId + payload
```

### Java/Spring: avoid granularity driven by `@FeignClient` convenience

```java
// Anti-pattern: one Feign client per table
@FeignClient("user-service")
interface UserClient { /* 40 methods */ }

// Prefer: coarse API aligned to use case
@FeignClient("identity-service")
interface IdentityClient {
    @GetMapping("/api/v1/identities/{id}/checkout-context")
    CheckoutIdentityContext getCheckoutContext(@PathVariable UUID id);
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| One service per developer | Operational overhead >> value |
| Merging all "reads" into GraphQL BFF without domain ownership | BFF becomes monolith |
| Splitting write and read of same aggregate without CQRS discipline | Consistency bugs on read-your-writes |
| Shared Kafka topic per event type explosion | 400 topics, no one knows consumers |

---

## 5. Domain-Driven Design (DDD)

### Core concept

**DDD** is a design approach for complex domains: model software as **ubiquitous language** shared with domain experts, structure code around **aggregates** and **bounded contexts**, and accept that **not all models are globally consistent**.

In microservices, DDD is the primary tool for **drawing boundaries that won't be wrong in six months**. Without it, teams split on nouns they already had in the monolith schema (`Customer`, `Account`, `Order`) and recreate distributed ER diagrams.

Tactical building blocks that matter in production:

| Building block | Microservice role |
|---|---|
| **Entity / Value Object** | Internal domain model; not exposed in API |
| **Aggregate** | Consistency boundary; one transaction per aggregate |
| **Repository** | Persistence port; one aggregate root per repo method that commits |
| **Domain Service** | Logic spanning entities inside same aggregate cluster |
| **Application Service (Use Case)** | Orchestrates domain + infra; `@Transactional` lives here |
| **Anti-Corruption Layer (ACL)** | Translates foreign model at integration boundary |

### Internal working: aggregate design

An **aggregate root** is the only entry point for mutations. External references use **ID only**, not object graphs.

```java
// domain/Order.java — aggregate root
public class Order {
    private final OrderId id;
    private OrderStatus status;
    private final List<OrderLine> lines;
    private final List<DomainEvent> domainEvents = new ArrayList<>();

    public void place() {
        if (lines.isEmpty()) throw new DomainException("empty order");
        if (status != OrderStatus.DRAFT) throw new DomainException("already placed");
        status = OrderStatus.PLACED;
        domainEvents.add(new OrderPlaced(id, lines.stream().map(OrderLine::sku).toList()));
    }

    public List<DomainEvent> pullDomainEvents() {
        var copy = List.copyOf(domainEvents);
        domainEvents.clear();
        return copy;
    }
}
```

```java
// application/PlaceOrderUseCase.java
@Service
public class PlaceOrderUseCase {
    private final OrderRepository orders;
    private final DomainEventPublisher events;

    @Transactional
    public Order execute(String idempotencyKey, PlaceOrderRequest req) {
        if (orders.existsByIdempotencyKey(idempotencyKey)) {
            return orders.findByIdempotencyKey(idempotencyKey).orElseThrow();
        }
        Order order = Order.draft(idempotencyKey, req.lines());
        order.place();
        orders.save(order);
        order.pullDomainEvents().forEach(events::publish);
        return order;
    }
}
```

**Do not** expose JPA entities on REST boundaries. Mapping layer (`OrderResponse.from(order)`) is not boilerplate — it is an anti-corruption barrier.

### Production scenario: anemic domain model across services

**Problem.** "Domain" services are CRUD passthrough to JPA. Business rules live in BFF, Kafka streams job, and Android app. Tax calculation differs by client.

**Cause.** DDD skipped; **transaction script** pattern scaled horizontally by accident.

**Solution.** Consolidate invariant enforcement at the **aggregate that owns the lifecycle**. Clients become thin. For cross-cutting read models, use projections — not duplicated rules.

### Strategic DDD: context mapping

Relationships between bounded contexts:

```
[Sales Context] ──Customer-Supplier──► [Billing Context]
[Catalog Context] ──Conformist──► [External PIM]
[Legacy ERP] ──Anti-Corruption Layer──► [Order Context]
```

Implement ACL in Spring as adapter package:

```java
@Component
public class ErpOrderAdapter implements LegacyOrderPort {
    private final ErpSoapClient erp;
    private final ErpOrderTranslator translator;

    @Override
    public ExternalOrderId submit(Order order) {
        ErpOrderPayload payload = translator.toErp(order);
        ErpResponse response = erp.submitOrder(payload);
        return new ExternalOrderId(response.getDocNumber());
    }
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Aggregate too large (Order + Payment + Shipment) | Long locks; cross-service TX temptation |
| Aggregate too small (OrderLine as root) | Cannot enforce invariants |
| Domain events as integration events without translation | Leaking internal structure; breaking changes on rename |
| Generic "EntityService" base class | Hidden coupling across bounded contexts |

---

## 6. Bounded Context

### Core concept

A **bounded context** is the boundary within which a particular domain model is **consistent and meaningful**. The same word (`Customer`, `Product`, `Account`) means different things in different contexts — and that is correct.

| Term | In Sales Context | In Support Context | In Billing Context |
|---|---|---|---|
| Customer | Buyer with cart history | Ticket submitter | Payer with credit terms |
| Product | Merchandised SKU | Supported item in KB | Billable line item |

Microservices should map **one bounded context per service** in the ideal case. Real systems allow **multiple contexts in one service** temporarily during extraction, but **never one context split across two services** without event-driven synchronization and accepted eventual consistency.

### Internal working: context integration patterns

```
┌─────────────────┐         ┌─────────────────┐
│  Catalog BC     │  sync   │  Checkout BC    │
│  Product (merch)│◄───────►│  Product (price)│
└────────┬────────┘  price  └────────┬────────┘
         │                           │
         │ ProductUpdated (event)    │
         └──────────────────────────►│ local read model / cache
```

Patterns:

| Pattern | When |
|---|---|
| **Shared Kernel** | Tiny shared library (IDs, money type) — keep minimal |
| **Customer/Supplier** | Upstream defines contract; downstream conforms or ACL |
| **Open Host Service** | Published language (public API schema) |
| **Published Language** | JSON schema / protobuf as contract |

### Spring example: separate packages per context in modular monolith

```
com.acme.catalog/     ← Bounded Context: Merchandising
com.acme.checkout/    ← Bounded Context: Purchase
com.acme.support/     ← Bounded Context: Cases
```

ArchUnit enforces no `checkout → catalog.domain` imports; only `catalog.api` DTOs or events.

### Production scenario: "Customer" entity shared company-wide

**Problem.** One `customers` table, one `CustomerDTO` in company Maven parent. Marketing adds fields; PCI audit fails because support agents see payment tokens in the same DTO.

**Cause.** **Unified canonical model** fantasy. One model to rule them all becomes one breach surface and one migration bottleneck.

**Solution.** Split contexts and storage:

```
identity-service     → auth credentials, MFA
customer-profile-svc → marketing attributes, segments
billing-account-svc  → payment methods (tokenized), invoices
```

Integrate with IDs + events (`CustomerProfileUpdated`), not shared tables.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Global enterprise data model committee | 9-month schema changes |
| BFF merges contexts for "convenience" | BFF knows too much; becomes distributed monolith front |
| Same Kafka topic for all domains | Unclear ownership; schema registry chaos |
| Context boundary = package name only | No enforcement; imports creep |

### Debugging scenario

**Observe.** Checkout shows stale product titles after catalog deploy.

**Diagnose.** Is checkout calling catalog sync API on every request, or using a **local projection**? Check `last_updated` on checkout's `product_read_model` table. Event consumer lag?

**Fix.** Treat catalog as upstream; checkout is downstream conformist. Refresh via events; define SLA on staleness (e.g., 30s acceptable for title display).

---

## 7. Domain Events

### Core concept

A **domain event** is something that happened in the domain that domain experts care about: `OrderPlaced`, `PaymentCaptured`, `InventoryReserved`. It is past tense, immutable fact.

Distinguish:

| Type | Purpose | Audience |
|---|---|---|
| **Domain event** | Inside aggregate; enforces side effects in same BC | Same service |
| **Integration event** | Cross-service notification | Other services |
| **Event notification** | Thin signal ("something changed, go fetch") | Reduces payload coupling |
| **Event-carried state transfer** | Full state in event | Simpler consumers; larger payloads |

In microservices, **never publish domain entities raw to Kafka**. Translate to integration schema at the boundary.

### Internal working: outbox pattern

Dual-write problem: DB commit succeeds, Kafka publish fails (or reverse). **Transactional outbox** fixes this.

```
┌──────────────────────────────────────────────┐
│  @Transactional                              │
│    1. INSERT orders                          │
│    2. INSERT outbox (topic, payload, id)     │
│  COMMIT                                      │
└──────────────────────────────────────────────┘
         │
         ▼
  OutboxRelay (@Scheduled / Debezium CDC)
         │
         ▼
     Kafka publish (at-least-once)
```

```java
@Entity
@Table(name = "outbox")
public class OutboxMessage {
    @Id private UUID id;
    private String aggregateType;
    private String aggregateId;
    private String eventType;
    @Column(columnDefinition = "jsonb")
    private String payload;
    private Instant createdAt;
    private Instant publishedAt;
}

@Component
public class OutboxRelay {
    private final OutboxRepository outbox;
    private final KafkaTemplate<String, String> kafka;

    @Scheduled(fixedDelay = 500)
    @Transactional
    public void relay() {
        List<OutboxMessage> batch = outbox.findUnpublished(FetchLimit.of(100));
        for (OutboxMessage msg : batch) {
            kafka.send(msg.getTopic(), msg.getAggregateId(), msg.getPayload())
                 .get(5, TimeUnit.SECONDS);
            msg.markPublished();
        }
    }
}
```

Prefer **Debezium CDC** on outbox table at scale — removes polling and keeps relay logic out of app threads.

### Consumer design: idempotency

At-least-once delivery means duplicates. Store processed event IDs:

```java
@KafkaListener(topics = "orders.events", groupId = "fulfillment-v3")
@Transactional
public void onOrderPlaced(ConsumerRecord<String, String> record) {
    String eventId = extractEventId(record.value());
    if (processedEvents.exists(eventId)) return;

    OrderPlaced event = parse(record.value());
    fulfillment.createShipment(event.orderId());
    processedEvents.markProcessed(eventId);
}
```

### Production scenario: ordering guarantees misunderstood

**Problem.** Inventory service processes `OrderPlaced` before `PaymentAuthorized` due to partition reassignment. Overselling during flash sale.

**Cause.** Assuming **global ordering** across event types. Kafka orders per **partition key**, not per topic globally.

**Solution.**

- Model state machine: inventory listens to `PaymentAuthorized`, not `OrderPlaced`.
- Or use same partition key (`orderId`) for all events in the order lifecycle so per-order ordering holds.
- Document **saga** compensations: `ReleaseInventory` on payment timeout.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@TransactionalEventListener` without outbox + crash before publish | Lost events |
| Publishing before DB commit | Consumers see ghost data |
| No schema versioning (JSON "just add fields") | Consumer deser failures on deploy skew |
| Using events for sync query replacement | Chatty compensating reads; high lag |

### Event schema evolution (Avro/Protobuf)

```protobuf
message OrderPlaced {
  string order_id = 1;
  google.protobuf.Timestamp placed_at = 2;
  repeated OrderLine lines = 3;
  // reserved 4; // removed discount_code — use field 5 optional
  optional string correlation_id = 5;
}
```

Rule: **additive changes only** in wire format; consumers ignore unknown fields.

---

## 8. Database per Service

### Core concept

Each microservice owns a **private persistence** store that other services cannot access directly. "Database" means **any durable state the service treats as source of truth**: PostgreSQL, MongoDB, Redis durable indices, S3 object metadata tables.

Benefits:

- **Independent schema migration** (Flyway/Liquibase per repo)
- **Technology fit** (graph for recommendations, relational for ledger)
- **Blast radius** (bad migration contained)

Costs:

- **No cross-service JOIN** — assemble read models in app layer or via CQRS projections
- **Eventual consistency** across aggregates in different services
- **Operational multiplication** — backups, PITR, access control per store

### Internal working: data ownership matrix

| Data | Owning service | Others access via |
|---|---|---|
| `orders` table | order-service | REST `GET /orders/{id}`, `OrderShipped` event |
| `stock_levels` | inventory-service | REST reserve API, events |
| `user_credentials` | identity-service | OIDC token claims, never direct |

### Spring + Flyway per service

```
order-service/
  src/main/resources/db/migration/V1__orders.sql
  src/main/resources/db/migration/V2__outbox.sql
```

```yaml
spring:
  flyway:
    enabled: true
    schemas: orders
    baseline-on-migrate: true
```

**Never** share Flyway history table across services.

### CQRS read model (cross-service display)

Checkout needs product title + price + stock hint:

```java
@Entity
@Table(name = "checkout_product_view")
public class CheckoutProductView {
    @Id private String sku;
    private String title;
    private BigDecimal price;
    private int availableHint;  // eventually consistent
    private Instant updatedAt;
}

@KafkaListener(topics = "catalog.product.updated")
@Transactional
public void upsertProductView(ProductUpdated e) {
    repo.save(new CheckoutProductView(e.sku(), e.title(), e.price(), e.updatedAt()));
}
```

User sees slightly stale stock — business accepts or you add sync reserve call at checkout time (strong check on write path).

### Production scenario: read replica "sharing"

**Problem.** Analytics team attaches read replica of order DB for "reporting." Reports join orders + inventory tables via cross-DB link. Inventory team renames column; finance dashboard breaks on Monday.

**Cause.** **Database per service** violated for convenience. Replica is still **coupling**.

**Solution.** Analytics consumes **integration events** into warehouse (Snowflake/BigQuery) or uses CDC stream. If replica access unavoidable, treat as **deprecated integration** with contract and SLA — not ad hoc SQL.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Same PostgreSQL instance, different schemas, shared admin | Still operational coupling; noisy neighbor |
| Cross-schema FK | Cannot deploy migrations independently |
| Distributed two-phase commit (XA) | Heuristic rollback; ops nightmare |
| "Temporary" shared read access that never leaves | Permanent hidden dependency |

---

## 9. Shared Database Anti-pattern

### Core concept

The **shared database anti-pattern** occurs when multiple services read/write the same relational schema (or same tables) as peers. It preserves monolith coupling while adding network hops — the worst of both worlds.

Symptoms in org behavior:

- Migration requires **change advisory board** with all service owners
- No one knows which service wrote a row
- "Fix in SQL" production habit bypasses business rules
- Performance tuning on one table affects unknown consumers

### Internal working: how coupling propagates

```
Service A ──┐
Service B ──┼──► shared.orders ──► triggers ──► Service C (unknown)
Service D ──┘
```

Any index change locks table. Any column type change breaks unknown SELECT * in Service B's ad hoc job.

### Production scenario: dual-write to shared DB

**Problem.** Order service and Legacy monolith both INSERT into `orders` during migration. Duplicate order IDs, conflicting status updates.

**Cause.** **Strangler incomplete** — two writers, one table, no single owner.

**Solution.** Pick **one writer** (monolith OR new service). Other path goes read-only or through API of owner. Use `writer_role` DB permissions:

```sql
-- order-service role: INSERT/UPDATE orders only
-- legacy role: SELECT only (phase 1), then revoked
REVOKE INSERT, UPDATE, DELETE ON orders FROM legacy_app_role;
```

### Migration off shared DB

```
Phase 1: New service owns writes; sync to legacy via events (legacy read)
Phase 2: Legacy read-only
Phase 3: Split schema physically; legacy DB deprecated
```

Spring batch for one-time backfill:

```java
@Bean
public Job backfillOrders(JobRepository repo, PlatformTransactionManager tx) {
    return new JobBuilder("backfillOrders", repo)
        .start(new StepBuilder("copy", repo)
            .<LegacyOrder, Order>chunk(500, tx)
            .reader(legacyReader())
            .processor(this::mapToNewModel)
            .writer(newOrderWriter())
            .build())
        .build();
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| ORM entities from shared library map same tables | Hidden dual mapping |
| DB views as "API" between teams | View dependency graph untestable |
| Stored procedures called by multiple services | Business logic in DBA land |
| Shared connection pool service | Single point; credential sprawl |

### Anti-pattern vs legitimate shared infrastructure

| Shared | OK? | Notes |
|---|---|---|
| PostgreSQL **cluster**, separate DB per service | Yes | Network isolation + separate credentials |
| Same **database name**, different schemas with cross-FK | No | FK = coupling |
| Elasticsearch cluster, separate indices | Yes | Index per service |
| Redis cluster, key prefix per service | Yes | Enforce ACLs |

---

## 10. Stateless vs Stateful Services

### Core concept

**Stateless service** (ideal for horizontal scale): any instance can handle any request; no in-memory user session assumed sticky; durable state lives in external store (DB, cache, queue).

**Stateful service**: instance affinity required — WebSocket session, embedded cache of record, leader-elected worker, local RocksDB in Kafka Streams.

Kubernetes wants stateless pods. Stateful workloads need **StatefulSets**, persistent volumes, or externalized state.

| Dimension | Stateless | Stateful |
|---|---|---|
| Scaling | `kubectl scale` freely | Partition-aware; may need rebalancing |
| Deploy | Rolling replace | Careful rolling; quorum concerns |
| Failure | Retry another instance | May lose in-flight unless persisted |
| Examples | REST API, gRPC query | Kafka Streams, embedded scheduler, WS hub |

### Internal working: session stickiness trap

```
        LB (round-robin)
       /    |    \
    Pod1  Pod2  Pod3
      ↑
  in-memory session map  ← user logged in on Pod1 only
```

**Problem:** user hits Pod2 → 401.

**Solutions:**

1. **Externalize session** — Spring Session + Redis
2. **JWT stateless auth** — no server session (revocation harder)
3. **Sticky sessions** — fragile on pod death

```java
@Configuration
@EnableRedisHttpSession(maxInactiveIntervalInSeconds = 3600)
public class SessionConfig {}
```

Prefer JWT + short TTL + refresh for APIs; Redis session for browser BFF same-origin.

### Stateful: Kafka Streams / embedded state

```java
@Bean
public KStream<String, OrderEvent> pipeline(StreamsBuilder builder) {
    builder.stream("orders.events")
           .groupByKey()
           .aggregate(OrderStats::new, (k, e, agg) -> agg.apply(e),
               Materialized.as("order-stats-store"));
    return ...;
}
```

State store is **local disk** + changelog topic. Scaling requires **repartition** — plan capacity accordingly. This service is not "stateless" despite being "just Java."

### Production scenario: caching as source of truth

**Problem.** Product service caches catalog in Caffeine with 24h TTL. No DB on product service. Catalog team's DB update doesn't propagate. Black Friday prices wrong.

**Cause.** **Stateful cache without invalidation contract** masquerading as microservice.

**Solution.** Owner of data holds DB. Product service is a **cache-aside read model** with event-driven eviction:

```java
@CacheEvict(cacheNames = "products", key = "#event.sku")
@KafkaListener(topics = "catalog.product.updated")
public void evict(ProductUpdated event) {}
```

Or drop local cache; use CDN + short TTL HTTP cache on read API.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Sticky sessions + rolling deploy | Random logouts |
| In-memory idempotency map | Duplicates after pod restart |
| StatefulSet without PDB | Quorum loss on node drain |
| Assuming HPA fixes stateful partition hot spots | One hot key overloads one pod |

---

## 11. Twelve-Factor App

### Core concept

The **Twelve-Factor App** methodology (Heroku, 2011) remains the baseline for cloud-native microservices. Factors map directly to production incidents when ignored.

| # | Factor | Microservice production meaning |
|---|---|---|
| I | Codebase | One repo per service (or monorepo with clear deploy units) — one deployable per app |
| II | Dependencies | Explicit in `pom.xml` / Gradle; no missing container libs |
| III | Config | Config in env / vault — not in JAR |
| IV | Backing services | DB, Kafka, Redis are attachable resources |
| V | Build, release, run | Immutable image from CI; same artifact prod/stage |
| VI | Processes | Stateless processes; scale horizontally |
| VII | Port binding | Self-contained HTTP (embedded Tomcat) |
| VIII | Concurrency | Scale out processes, not up threads only |
| IX | Disposability | Fast startup, graceful shutdown |
| X | Dev/prod parity | Same containers; avoid "works on my laptop" |
| XI | Logs | stdout streams to aggregator — not local files |
| XII | Admin processes | Migrations as one-off jobs, not SSH |

### Internal working: Factor III (config) in Spring Boot

```yaml
# WRONG — secrets in git
spring:
  datasource:
    password: SuperSecret123

# RIGHT — env injection
spring:
  datasource:
    password: ${DB_PASSWORD}
```

```java
@ConfigurationProperties(prefix = "checkout")
@Validated
public record CheckoutProperties(
    @NotNull Duration paymentTimeout,
    @Min(1) int maxRetries
) {}
```

Feature flags via config server or LaunchDarkly — **not** hardcoded `if (prod)`.

### Factor IX: graceful shutdown

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

```java
@Bean
SmartLifecycle kafkaListenerDrainer() {
    return new SmartLifecycle() {
        @Override
        public void stop() {
            kafkaListenerRegistry.stop();
        }
        // ...
    };
}
```

Without graceful shutdown: in-flight HTTP aborted, duplicate Kafka processing on rebalance.

### Production scenario: Factor V violated — prod build from branch

**Problem.** Hotfix built on laptop, jar scp'd to server. Staging never saw that bytecode. Regression next week.

**Cause.** No immutable **release artifact** pipeline.

**Solution.** CI builds container image `order-service:1.4.2+sha`. Prod deploys that digest only. Spring Boot build-info:

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <executions>
    <execution>
      <goals><goal>build-info</goal></goals>
    </execution>
  </executions>
</plugin>
```

Expose `/actuator/info` for on-call to verify running version.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Log files on pod disk | Logs lost on restart; disk pressure evictions |
| 120s startup (eager init) | HPA too slow; startup probe kills pod |
| Config drift between regions | "Works in us-east" only |
| Admin SQL run manually | Untracked schema drift |

---

## 12. Distributed Monolith

### Core concept

A **distributed monolith** is a system of separately deployed services that **must change and release together** because of tight runtime and data coupling. It has microservice **operational cost** without microservice **benefits**.

Detection checklist:

- [ ] Deploy service A requires deploying B, C in same window
- [ ] Integration tests need full stack running locally
- [ ] Circular synchronous call chains
- [ ] Shared database or shared library with domain logic
- [ ] Breaking API change without consumer deploy = production outage
- [ ] "Version matrix" document of which service versions work together

### Internal working: coupling types

```
Temporal coupling    — must deploy together (shared DTO break)
Runtime coupling     — A down ⇒ B down (sync only, no fallback)
Data coupling        — shared tables
Semantic coupling    — implicit contract not in schema (field meaning)
Operational coupling — one on-call rotation doesn't know who owns failure
```

### ASCII: distributed monolith call graph

```
         ┌──────────┐
    ┌───►│  Order   │───┐
    │    └──────────┘   │
    │         ▲         ▼
┌───┴───┐     │    ┌──────────┐     ┌──────────┐
│Payment│◄────┘    │Inventory │◄───►│ Shipping │
└───┬───┘          └──────────┘     └──────────┘
    │                    ▲
    └────────────────────┘
      synchronous cycle during single user click
```

### Production scenario: shared `common-domain` Maven module

**Problem.** `common-domain-2.4.jar` contains entities, validation, Kafka serdes. Eight services depend on it. One enum change requires coordinated 8-service deploy Friday night.

**Cause.** **Shared kernel grew into distributed monolith kernel**.

**Solution.**

- Shrink shared kernel to **types with no behavior**: `Money`, `OrderId`, error codes
- Duplicate DTO mappers per consumer (yes, duplication) or generate from OpenAPI/Protobuf
- **Consumer-driven contracts** (Pact) so provider doesn't break silently

```java
// Acceptable shared kernel — no business rules
public record Money(@NotNull BigDecimal amount, @NotNull Currency currency) {
    public Money {
        if (amount.scale() > 4) throw new IllegalArgumentException("scale");
    }
}
```

### Refactoring path

```
1. Break sync cycles → introduce events for non-critical path
2. Add anti-corruption layers at worst coupling points
3. Database split with strangler + outbox
4. Contract tests + independent deploy pipeline per service
5. Feature flags to decouple "deploy" from "release"
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Feign everywhere, no timeouts | Hang cascades |
| "Version compatibility" via shared snapshot deps | Main always broken |
| Monolithic integration test suite gate | Weekly release train only |
| Synchronous saga without compensations | orphaned reservations |

---

## 13. Conway's Law

### Core concept

**Conway's Law** (1968): organizations design systems that **mirror their communication structure**. If billing and shipping are one department, you'll get one deployable. If they're separate VPs with separate backlogs, you'll get two services — whether or not architects draw the line.

Implication for seniors: **you cannot draw a microservice boundary that contradicts who gets paged and who approves schema changes** and expect it to hold.

### Internal working: inverse Conway maneuver

Deliberately structure teams to match **desired architecture**:

```
Desired: Independent Checkout team owns checkout end-to-end

Act:
  - Checkout team owns checkout-service, checkout DB, checkout on-call
  - Catalog team publishes API + events; no checkout engineer in catalog repo
  - Platform team provides K8s/Kafka, not business logic
```

If checkout engineers still commit to catalog repo for every feature, Conway wins — you'll merge back to monolith behavior.

### Team topologies (Skelton & Pais)

| Topology | Role |
|---|---|
| **Stream-aligned** | Owns feature flow (Checkout team) |
| **Platform** | Enables self-service infra (Internal Developer Platform) |
| **Enabling** | Temporary coaching (DDD coaches) |
| **Complicated-subsystem** | ML pricing engine — dedicated specialists |

### Production scenario: horizontal "API team"

**Problem.** Feature teams write business logic; API team owns all REST controllers across services. API team becomes bottleneck. Feature teams don't own SLAs.

**Cause.** Conway mismatch — **ownership split by technical layer**.

**Solution.** Stream-aligned teams own API + domain + data. Platform provides **golden paths** (Spring Boot starter, CI template, observability sidecar), not gatekeeping.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Architecture diagram ≠ team chart | Orphan services no one maintains |
| Rotating engineers across 12 services monthly | No institutional domain knowledge |
| Central architecture guild approves every PR | Same as monolith release committee |
| Outsourced ops, insourced dev | "Throw over wall" — slow incident resolution |

### Applying Conway to service boundaries

Before splitting, ask:

1. Who will be **on-call** for this service at 3am?
2. Who can **approve a breaking migration** without a meeting?
3. Does the team have **full-stack skill** (or paired ops embed) to run it?

If answers are fuzzy, the boundary is wrong.

---

## 14. Service Ownership

### Core concept

**Service ownership** means a team (or named engineers) holds **full lifecycle responsibility**: design, build, deploy, operate, secure, deprecate. Not "we built it and handed to ops." Not "platform runs it but doesn't know the domain."

Ownership artifacts (production-grade):

| Artifact | Purpose |
|---|---|
| `CODEOWNERS` / GitLab code owners | PR routing |
| Service catalog entry (Backstage) | Discoverability |
| Runbook in repo (`docs/runbook.md`) | Incident response |
| SLO + error budget | When to feature vs reliability |
| On-call rotation in PagerDuty | Page the owner |
| DEPRECATION.md | How to migrate off API v1 |

### Internal working: ownership model

```
┌─────────────────────────────────────────────────┐
│ Stream team: Order                              │
│  Repos: order-service, order-contracts          │
│  Infra: orders_db, orders.events topic          │
│  SLO: 99.9% place-order success                 │
│  On-call: primary + secondary from team         │
└─────────────────────────────────────────────────┘
         │ consumes
         ▼
┌─────────────────────────────────────────────────┐
│ Platform team                                   │
│  K8s cluster, Kafka cluster, observability stack│
│  Does NOT own order business logic              │
└─────────────────────────────────────────────────┘
```

### Spring Boot: operational hooks owners must ship

```yaml
management:
  endpoint:
    health:
      show-details: when_authorized
  metrics:
    tags:
      application: ${spring.application.name}
      team: checkout
```

```java
@Component
public class OrderMetrics {
    private final Counter placeOrderSuccess;
    private final Counter placeOrderFailure;

    public OrderMetrics(MeterRegistry registry) {
        this.placeOrderSuccess = registry.counter("order.place", "result", "success");
        this.placeOrderFailure = registry.counter("order.place", "result", "failure");
    }
}
```

### Production scenario: orphaned service after reorg

**Problem.** `loyalty-service` last commit 14 months ago. JDK CVE patch needed. No team claims it. Incidents go unresolved.

**Cause.** **Ownership vacuum** after reorg; service not decommissioned.

**Solution.** Service catalog policy: every service has **owner team field**; quarterly audit. Unowned → deprecate or assign. Minimum bar: security patches even if feature-frozen.

### Production scenario: shared ownership = no ownership

**Problem.** Slack channel `#payments-help` has 200 people. Payment service down; everyone assumes someone else is fixing.

**Cause.** **Diffusion of responsibility**.

**Solution.** Exactly one **primary owner team** in catalog. Others are **consumers** with contract tests, not co-owners.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No runbook | Every incident starts from grep |
| Platform team owns 40 business services | Platform doesn't know business rules |
| Owner team in different timezone than peak traffic | Slow ack during incidents |
| Breaking change without consumer notification | #war-room |

### Deprecation discipline

```java
@GetMapping("/api/v1/orders/{id}")
@Deprecated(forRemoval = true)
ResponseEntity<OrderResponseV1> getV1(@PathVariable UUID id) {
    meterRegistry.counter("api.v1.deprecated.calls").increment();
    // ...
}
```

Sunset headers:

```http
Sunset: Sat, 01 Mar 2027 00:00:00 GMT
Deprecation: true
Link: </api/v2/orders/{id}>; rel="successor-version"
```

---

## 15. Production Debugging Playbook

When "the microservices are slow" or "random 500s," the failure is usually **coupling, missing observability, or wrong consistency assumption** — not Kubernetes gremlins.

### 1. Classify the failure surface

| Observation | Likely layer |
|---|---|
| Single service pod restarts | Liveness probe, OOM, thread leak |
| All services spike 503 | Gateway, mesh, DNS, cert expiry |
| One user segment only | Tenant routing, feature flag, sticky session |
| After deploy of unrelated service | Hidden coupling, shared lib, schema |
| Gradual degradation | Connection pool leak, GC, disk full on state store |

### 2. Trace first, logs second

Ensure **W3C trace context** propagation:

```java
@Bean
RestClientCustomizer propagationCustomizer(ObservationRegistry registry) {
    return builder -> builder.observationRegistry(registry);
}
```

Check trace for:

- **Long synchronous fan-out** (checkout calling 6 services serially)
- **Missing span** (broken propagation at gateway)
- **Retry storms** (client retry × server retry)

### 3. Dependency graph drill

For failing service X:

```
X error rate up
  ├─ X DB latency?          → query plan, lock, pool
  ├─ X downstream Y timeout? → Y health, Y's downstream
  ├─ X Kafka consumer lag?  → poison message, slow handler
  └─ X CPU without traffic? → rebalance, scheduled job
```

### 4. Data coupling checks

Ask on every incident:

- Did any service run a **manual SQL** change today?
- Was there a **shared migration**?
- Did consumer deploy **before** producer schema?

Query outbox lag:

```sql
SELECT count(*) FROM outbox WHERE published_at IS NULL AND created_at < now() - interval '5 minutes';
```

### 5. Deploy correlation

Compare incident start with:

- All service deploy events (ArgoCD, Spinnaker)
- Feature flag toggles
- Kafka broker rolling
- Certificate rotation

**Correlated deploy across 3+ services** → suspect distributed monolith release.

### 6. Load test the boundary

Reproduce with **single service isolated** (contract test + wiremock downstream). If isolated service meets SLO but prod doesn't — coupling or data volume, not code path.

### 7. Rollback discipline

Independent deployability means **rollback one service** should be safe if contracts are backward compatible. If rollback requires rollback of N services — you have a distributed monolith; fix architecture after incident.

### 8. Communication template for incidents

```
Impact: checkout place-order 12% failure
Owner service: order-service (team-checkout)
Blast radius: users in EU only (routing)
Immediate: scale order-service + increase inventory timeout 2s → 5s
Root cause: TBD — hypothesis inventory DB lock
Next update: 15 min
```

### 9. Post-incident architecture actions

| If root cause was... | Architecture action |
|---|---|
| Sync chain timeout | Event-driven decouple or bulkhead |
| Shared DB migration | Accelerate DB split |
| Schema break | Schema registry + contract tests |
| Cache stale | Event invalidation or TTL policy |
| No owner | Catalog + assign team |

---

## 16. Quick Decision Matrix

| Situation | Do this |
|---|---|
| One team, < 15 engineers, domain still shifting | Modular monolith + ArchUnit |
| Two teams need independent ship on same data | Split bounded contexts + database per service + events |
| Need strong consistency across aggregates | Same service or saga; not sync RPC chain |
| Read-heavy, low stale tolerance | CQRS projection + cache; measure staleness SLA |
| Write-heavy hot spot | Split service + shard by tenant/region |
| External legacy ERP | Anti-corruption layer; never expose ERP model |
| Unsure if microservice justified | Strangler extract read path first |
| Org has no K8s/on-call maturity | Fix platform before splitting |
| "Common" entities (Customer) everywhere | Separate contexts; integrate by ID + events |
| Cross-service workflow | Saga + outbox + idempotent consumers |
| Session-based browser app | BFF + Redis session or JWT; not sticky pods |
| Real-time analytics | CDC / event stream to warehouse; not shared DB |
| Team topology mismatch | Inverse Conway: align teams to target boundaries |
| Service nobody maintains | Deprecate or assign owner within quarter |
| Frequent coordinated deploys | Stop feature work; break coupling (see §12) |
| Global ordering needed | Same Kafka partition key per aggregate instance |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Orders succeed in UI but warehouse never receives them. Where do you look first?</summary>

**Root cause pattern:** Lost or lagging **integration events** — often outbox relay stopped, consumer lag, or publishing before transaction commit.

**Fix:** Check outbox unpublished count; Kafka consumer lag for fulfillment group; verify `@Transactional` boundary includes outbox insert; ensure relay runs or Debezium connector healthy. Add alert on outbox age > 60s.

---

</details>

<details class="qa-item">
<summary>2. After splitting the monolith, P99 latency went from 200ms to 2s on checkout. Why?</summary>

**Root cause pattern:** **Serial synchronous microservice calls** replaced in-process method invocations. Six network hops × 50ms each + JSON serialization + connection pool wait.

**Fix:** Introduce BFF that parallelizes read calls (`CompletableFuture.allOf`); move non-critical steps async (`OrderPlaced` event); collapse read models via CQRS so checkout page needs one service call.

---

</details>

<details class="qa-item">
<summary>3. Two services deploy fine alone but break when deployed together. What architecture smell is this?</summary>

**Root cause:** **Distributed monolith** — shared library version coupling, shared database migration order, or breaking API without backward compatibility.

**Fix:** Consumer-driven contracts; expand/contract migrations; feature flags; shrink shared kernel; deploy provider before consumer with compatible schema (expand phase).

---

</details>

<details class="qa-item">
<summary>4. Inventory shows 5 units but checkout says out of stock intermittently.</summary>

**Root cause:** **Eventual consistency** between catalog/inventory projection and real-time stock; or race without reservation lock.

**Fix:** On checkout write path, call inventory **reserve** API synchronously (strong check). Projections for display only. Implement reservation TTL + release job.

---

</details>

<details class="qa-item">
<summary>5. Schema migration on Monday broke three "unrelated" services. How?</summary>

**Root cause:** **Shared database anti-pattern** — three services read same table or view; migration renamed column.

**Fix:** Immediate: rollback migration or compat views. Long-term: database per service; views only owned by one writer service exposing API.

---

</details>

<details class="qa-item">
<summary>6. Kafka consumer reprocesses old events after deploy and creates duplicate shipments.</summary>

**Root cause:** Missing **idempotency** store; or consumer offset reset (`auto.offset.reset=earliest`) misconfiguration.

**Fix:** `processed_events` table keyed by eventId; exactly-once semantics via idempotent consumer + transactional offset commit; never reset offsets without plan.

---

</details>

<details class="qa-item">
<summary>7. Team insists "Customer" must be one REST resource company-wide. What's wrong?</summary>

**Root cause:** **Bounded context** violation — one model cannot satisfy sales, support, billing, and compliance simultaneously.

**Fix:** Context-specific APIs (`/billing/accounts`, `/support/contacts`); correlate by `partyId` or `customerId` UUID mapping table in each context; events for cross-context sync.

---

</details>

<details class="qa-item">
<summary>8. API gateway logs show 401 only for mobile clients after scale-out.</summary>

**Root cause:** **Stateful session** on pods without Redis; mobile hits new pod without session.

**Fix:** Spring Session Redis or stateless JWT; disable naive sticky sessions as sole fix.

---

</details>

<details class="qa-item">
<summary>9. New engineer shipped a `@FeignClient` from Order to Inventory's internal admin endpoint. Incident follows. Prevention?</summary>

**Root cause:** **Encapsulation breach** — internal API treated as public contract.

**Fix:** Network policies: only gateway + approved peers call service; publish **OpenAPI** for public surface; ArchUnit ban Feign to `..internal..` packages; code review checklist.

---

</details>

<details class="qa-item">
<summary>10. Flash sale: inventory oversold by 12%. Event-driven architecture "failed."</summary>

**Root cause:** Consumed `OrderPlaced` before payment confirmed; or lost ordering across partitions; or no reservation invariant.

**Fix:** State machine: reserve on `PaymentAuthorized`; partition by `orderId`; load test saga compensations.

---

</details>

<details class="qa-item">
<summary>11. Platform team runs all services but feature teams write code. Incidents take 4 hours to escalate. Why?</summary>

**Root cause:** **Conway's Law / ownership mismatch** — ops doesn't know domain; devs not on-call.

**Fix:** Stream-aligned teams own on-call for their services; platform owns cluster only; embed SRE practices in teams (you build it, you run it).

---

</details>

<details class="qa-item">
<summary>12. `common-domain` jar change required 8-service coordinated release. Alternative?</summary>

**Root cause:** Shared kernel absorbed **behavior and entities**, not just primitives.

**Fix:** Schema-first contracts (Protobuf/OpenAPI) generated per repo; shared kernel limited to `Money`, IDs; duplicate mappers acceptable.

---

</details>

<details class="qa-item">
<summary>13. Strangler migration: both monolith and order-service write orders. Duplicate IDs appear.</summary>

**Root cause:** **Dual write** during migration without single writer authority.

**Fix:** UUID generated by owner only; monolith stops writes via feature flag; idempotency keys; DB permissions revoke insert on legacy.

---

</details>

<details class="qa-item">
<summary>14. Service passes health check but users get 503 from gateway.</summary>

**Root cause:** **Liveness vs readiness** confusion — app up but not ready (Kafka consumer stuck, dependency down). Gateway routes to not-ready pods.

**Fix:** Readiness probe fails when critical dependency unhealthy; liveness stays; implement `@ReadinessState` in Spring Boot 3. Gateway use readiness endpoint.

---

</details>

<details class="qa-item">
<summary>15. Elasticsearch product index diverges from PostgreSQL catalog. Search shows discontinued items.</summary>

**Root cause:** **Dual source of truth** without reliable event pipeline or full reindex discipline.

**Fix:** Catalog DB is source; ES is projection; monitor consumer lag; nightly reconcile job compares counts; versioned events.

---

</details>

<details class="qa-item">
<summary>16. Twelve-Factor violation: ops SSHs to pod to run Flyway manually. Risk?</summary>

**Root cause:** **Admin processes not tied to release** — schema drift between pods/regions; non-reproducible state.

**Fix:** Migration as init container or CI job before deploy; immutable releases; forbid manual DDL in prod runbook except break-glass with ticket.

---

</details>

<details class="qa-item">
<summary>17. Order service holds DB connection 30s while waiting for payment HTTP. Pool exhausted under load.</summary>

**Root cause:** **Long transaction spanning external I/O** — classic `@Transactional` on orchestration method.

**Fix:** Split TX: persist pending order + outbox; call payment after commit; saga state machine for PaymentPending → Paid/Failed.

---

</details>

<details class="qa-item">
<summary>18. Microservices adopted because "Netflix does it" but team is 6 developers. Outcome?</summary>

**Root cause:** **Premature decomposition** — ops toil (K8s, Kafka, tracing) exceeds delivery benefit; Conway not satisfied (one team).

**Fix:** Merge to modular monolith; invest in CI/CD and observability first; re-split when second team owns a bounded context with clear data.

---

</details>

<details class="qa-item">
<summary>19. Domain event `OrderLineItemAdded` published to Kafka with full JPA entity graph. Consumers break on field rename.</summary>

**Root cause:** **Leaking domain model** as integration contract.

**Fix:** Map to `OrderPlacedIntegrationV1` at publish boundary; schema registry; internal domain free to refactor.

---

</details>

<details class="qa-item">
<summary>20. Quarterly "release train" of 14 services. Still microservices?</summary>

**Root cause:** **Distributed monolith** operational model — independent deployability not achieved.

**Fix:** Prioritize breaking worst coupling (shared DB, sync cycle); contract tests; continuous deploy per service with feature flags.

</details>

---

*Microservices do not remove complexity — they move it to boundaries you must defend with data ownership, explicit contracts, and teams that match the architecture. If you cannot deploy, roll back, and page a single team for one service, you do not yet have microservices — you have a distributed system with a diagram.*
