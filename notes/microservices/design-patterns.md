# Microservices Design Patterns — Senior Production Reference

Spring Cloud Gateway / Kafka / Kubernetes / service mesh. Servlet and reactive stacks are both covered; differences are called out explicitly. This is not a catalog of buzzwords. It is the map of what actually breaks in production after years of shipping gateways, sagas, event stores, and monolith migrations on JVM and polyglot backends.

---

## Table of Contents

1. [Mental Model: Patterns Across the Microservices Landscape](#1-mental-model-patterns-across-the-microservices-landscape)
2. [API Gateway Pattern](#2-api-gateway-pattern)
3. [Backend for Frontend (BFF)](#3-backend-for-frontend-bff)
4. [Anti-Corruption Layer (ACL)](#4-anti-corruption-layer-acl)
5. [Saga Pattern](#5-saga-pattern)
6. [CQRS Pattern](#6-cqrs-pattern)
7. [Event Sourcing Pattern](#7-event-sourcing-pattern)
8. [Outbox Pattern](#8-outbox-pattern)
9. [Circuit Breaker Pattern](#9-circuit-breaker-pattern)
10. [Bulkhead Pattern](#10-bulkhead-pattern)
11. [Strangler Fig Pattern](#11-strangler-fig-pattern)
12. [Sidecar Pattern](#12-sidecar-pattern)
13. [Ambassador Pattern](#13-ambassador-pattern)
14. [Pattern Composition and Interaction](#14-pattern-composition-and-interaction)
15. [Production Debugging Playbook](#15-production-debugging-playbook)
16. [Quick Decision Matrix](#16-quick-decision-matrix)
17. [Interview Q&A](#17-interview-qa)

---

## 1. Mental Model: Patterns Across the Microservices Landscape

Microservices design patterns are not interchangeable toppings. Each pattern solves a **specific failure mode** or **boundary problem** introduced when you split a monolith: network latency, partial failure, schema drift, inconsistent reads, and operational complexity. Applying the wrong pattern — or the right pattern twice — is how teams end up with three gateways, two event buses, and no single source of truth.

```
Client (web / mobile / partner)
  └─ Edge
       ├─ API Gateway                    routing, auth, rate limit, TLS termination
       └─ BFF (optional, per client)     aggregate, shape, cache for one UX
            └─ Domain services
                 ├─ Anti-Corruption Layer   translate legacy / external models
                 ├─ Command path (write)    local TX + Outbox → broker
                 ├─ Query path (read)       CQRS projections / read DB
                 └─ Resilience envelope     Circuit Breaker + Bulkhead on outbound calls
                      └─ Dependencies (other services, legacy, SaaS)
```

Three boundaries you must keep distinct:

| Boundary | Question it answers | Wrong mental model |
|---|---|---|
| **Edge (Gateway / BFF)** | How does traffic enter and get shaped for clients? | "Gateway is just nginx with JWT." |
| **Data / consistency** | How do writes propagate and reads stay fast? | "Saga + CQRS + Event Sourcing everywhere." |
| **Runtime / ops** | How do we deploy, observe, and isolate failure? | "Sidecar and Ambassador are the same thing." |

The senior misdiagnosis pattern: adding **Circuit Breaker** on every call while the real problem is a **Saga** missing compensations, or putting **CQRS** on a CRUD admin screen with twelve users. Patterns are **selective surgery**, not default architecture.

### Pattern families at a glance

| Family | Patterns in this doc | Primary pain |
|---|---|---|
| **Edge & integration** | API Gateway, BFF, Anti-Corruption Layer | Client coupling, legacy APIs, auth sprawl |
| **Data & consistency** | Saga, CQRS, Event Sourcing, Outbox | Cross-service writes, read scaling, audit |
| **Resilience** | Circuit Breaker, Bulkhead | Cascading failure, pool exhaustion |
| **Migration & platform** | Strangler, Sidecar, Ambassador | Monolith escape, cross-cutting concerns in K8s |

### Production scenario: "We adopted all the patterns"

**Problem.** Platform team mandates API Gateway, BFF per client, CQRS, Event Sourcing, and service mesh sidecars for a 15-person product. Six months later: p99 latency 2.4s on checkout, on-call cannot trace a single order ID across seven stores, and a junior deploy breaks three read models.

**Cause.** Patterns applied **without a forcing function**. Event Sourcing for configuration flags. BFF duplicating domain validation. Gateway running business aggregation that belongs in services.

**Solution.** Start from **pain**:

1. Cross-service order flow failing → Saga + Outbox.
2. Mobile needs one round-trip → BFF for mobile only.
3. Legacy billing SOAP → Anti-Corruption Layer in Payment service.
4. Catalog read overload → CQRS read model, not full Event Sourcing.
5. Payment provider flapping → Circuit Breaker + Bulkhead (see resilience doc).

Document **which pattern owns which boundary** in an architecture decision record (ADR). One gateway, one message bus, one event store — unless load or compliance truly requires more.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Gateway executes heavy orchestration | Gateway CPU pegged; business logic in YAML; hard to test |
| BFF becomes "mini monolith" | Same deploy blocks web and mobile; duplicated saga logic |
| Saga without idempotency | Duplicate charges, double inventory decrement |
| CQRS without explicit lag SLA | Users see "payment succeeded" but order still pending |
| Event Sourcing for simple CRUD | High storage cost; replay nightmares; team attrition |
| Outbox without monitoring | Silent message loss; DB and broker diverge |
| Sidecar on every pod "by default" | Memory overhead; upgrade blast radius across mesh |

### Debugging scenario

**Observe.** Checkout succeeds in Payment UI but Order History empty for 30–90 seconds, then appears. Support tickets spike after deploy.

**Diagnose.** Trace ID: command hit Order Service (write DB updated) → outbox publisher lagging → Kafka consumer rebuilding CQRS projection → BFF reads stale read model. Not a "gateway bug" — **expected eventual consistency** without UX handling.

**Fix.** BFF returns `202 Accepted` with poll URL; read model version in response; dashboard for projection lag; SLA alert when lag > 5s.

---

## 2. API Gateway Pattern

### Core concept

An **API Gateway** is a **single entry point** for clients into your microservices estate. It terminates TLS, authenticates, routes, rate-limits, and optionally transforms requests — so backend services stay **protocol-simple** (HTTP/gRPC internally) and **do not each implement cross-cutting edge policy**.

```
                    ┌─────────────────────────────────┐
  Client ──────────►│         API Gateway             │
                    │  auth │ route │ limit │ strip │
                    └──────────┬──────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         Order Service   Catalog Service   User Service
```

The gateway answers: **where does this request go**, **is this caller allowed**, and **how much load do we admit** — not **what is the business rule for a refund**.

### Internal working

Typical request path (Spring Cloud Gateway / Kong / AWS API Gateway — conceptually similar):

1. **Listener** receives HTTP(S) on public host.
2. **Authentication** validates JWT/API key/mTLS; attaches identity headers (`X-User-Id`, `X-Tenant-Id`) — never forward raw tokens to all services if avoidable.
3. **Route matching** — path, host, header predicates → `Route` → `uri` (service discovery name or static URL).
4. **Filter chain** (pre/post):
   - Strip/add path prefix (`/api/orders` → `/orders`)
   - Request size limits
   - Rate limiting (token bucket per client/IP/API key)
   - Circuit breaker to upstream (optional at gateway)
   - Request/response logging, trace ID injection
5. **Load balancing** to healthy instances (K8s Service, Eureka, Consul).
6. **Response** — unify error envelope, CORS headers, security headers.

Spring Cloud Gateway is **WebFlux** — blocking filters in the chain stall the event loop. Custom filters must be reactive or offloaded.

```yaml
# application.yml — illustrative route (Spring Cloud Gateway)
spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
          filters:
            - StripPrefix=1
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
            - name: CircuitBreaker
              args:
                name: orderService
                fallbackUri: forward:/fallback/orders
      default-filters:
        - AddResponseHeader=X-Content-Type-Options, nosniff
```

### Gateway vs load balancer vs reverse proxy

| Capability | L4 LB | Reverse proxy (nginx) | API Gateway |
|---|---|---|---|
| TLS termination | Yes | Yes | Yes |
| Path-based routing | Limited | Yes | Yes |
| OAuth2/JWT validation | No | With modules | First-class |
| Rate limit per API key | No | Awkward | First-class |
| Request transformation | No | lua | First-class |
| Developer portal / quotas | No | No | Often yes (Kong, Apigee) |

Use a **load balancer** for TCP passthrough and health checks. Use a **gateway** when **API policy** is product-facing and changes weekly.

### Production scenario: gateway as orchestrator

**Problem.** Team implements "checkout" as a Gateway route that chains five internal HTTP calls via `WebClient` in a custom filter. Deploy takes 20 minutes of integration testing. A Catalog change breaks checkout at the edge. Circuit breaker at gateway masks errors as generic 503.

**Cause.** **Orchestration belongs in a service or BFF**, not the gateway. Gateway filters should be **stateless policy**, not long-running sagas.

**Solution.** Move checkout aggregation to **Order Service** (orchestrated saga) or **Checkout BFF**. Gateway route: authenticate → rate limit → forward to `/checkout` on one service. Keep gateway filters under ~50ms p99 budget.

### Production scenario: path strip breaks Spring Security matchers

**Problem.** Gateway strips `/api` prefix. Order Service secures with `securityMatcher("/api/**")`. All requests fall through to wrong chain → 302 to login for mobile app.

**Cause.** Matchers run on **what the service sees**, not what the client sent.

**Solution.** Align gateway `StripPrefix` with service `context-path` and security matchers. Document **effective path** in service README. Integration test through gateway in CI.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No request ID / trace propagation | Cannot correlate gateway 504 with downstream timeout |
| Rate limit only at gateway | Internal service-to-service bypasses limit; still overloaded |
| JWT validated at gateway and every service (different rules) | Intermittent 403; clock skew double rejection |
| Huge request bodies buffered in gateway | OOM on file upload routes |
| `lb://` without health check awareness | Requests to terminating pods; 503 burst on deploy |
| CORS configured only on one service | Browser preflight fails at gateway |
| Gateway DB session store | Stateful edge; scaling nightmare |

### Debugging scenario

**Observe.** Intermittent 504 Gateway Timeout on `GET /api/catalog/search?q=...` during peak. Catalog pods CPU 40%.

**Diagnose.**

```bash
# Gateway access log — upstream timing
# x-response-time, route id, upstream status

# Compare gateway timeout vs service timeout vs client timeout
# Shortest wins; often gateway 30s, service 60s, client 15s → client gives up first
```

Check: slow query in Catalog? Gateway circuit half-open probing? Redis rate limiter blocking event loop?

**Fix.** Raise gateway timeout **only if** end-to-end SLA allows; fix Catalog query; add cache at BFF; ensure `spring.cloud.gateway.httpclient.response-timeout` aligns with product SLA.

---

## 3. Backend for Frontend (BFF)

### Core concept

A **Backend for Frontend (BFF)** is a **dedicated backend** tailored to the needs of **one client experience** — web, mobile, admin, partner API. It aggregates calls, shapes DTOs, handles pagination/caching for that UI, and hides microservice granularity from the client.

```
 Mobile app ──► Mobile BFF ──► Order, Catalog, User services
 Web SPA    ──► Web BFF    ──► same services, different shapes
 Partner    ──► Partner BFF ──► subset + API key scopes
```

BFF answers: **what does this screen need in one response** — not **what is the canonical domain model**.

### Internal working

Typical BFF responsibilities:

| Responsibility | In BFF | In domain service |
|---|---|---|
| Combine 5 APIs into one screen payload | Yes | No |
| Enforce business invariants (refund rules) | No | Yes |
| Pagination cursor for infinite scroll | Yes | Maybe |
| JWT validation | Often (or trust gateway headers) | Always for direct calls |
| Saga orchestration for write flows | Sometimes | Preferred for core domain |
| CDN cache headers for public catalog | Yes | Rare |

Implementation options:

1. **Dedicated microservice** per client type (`mobile-bff`, `web-bff`) — clear ownership, independent deploy.
2. **Module in monorepo** — shared lib for HTTP clients; separate deploy units.
3. **GraphQL layer** as BFF — flexible queries; risk of N+1 and unbounded query depth.

```java
// Web BFF — aggregate for product detail page (illustrative)
@RestController
@RequestMapping("/web/v1/product-detail")
@RequiredArgsConstructor
public class ProductDetailBffController {

    private final CatalogClient catalog;
    private final InventoryClient inventory;
    private final ReviewsClient reviews;

    @GetMapping("/{sku}")
    public ProductDetailPageDto getPage(@PathVariable String sku) {
        var product = catalog.getProduct(sku);
        var stock   = inventory.getAvailability(sku);   // bulkhead on client
        var reviews = reviews.getSummary(sku, 3);       // circuit breaker
        return ProductDetailPageDto.from(product, stock, reviews);
    }
}
```

BFF should use **resilience policies** on every outbound call (Circuit Breaker, Bulkhead, timeouts). Partial page render: show product with "reviews unavailable" rather than 500 the whole screen.

### BFF vs API Gateway

| Aspect | API Gateway | BFF |
|---|---|---|
| Audience | All clients, infrastructure | One client experience |
| Logic | Policy, routing | Aggregation, UX-specific shaping |
| Deploy frequency | Infra team | Product team |
| Caching product data | Unusual | Common |

**Gateway in front of BFFs** is normal: Gateway → Mobile BFF → services.

### Production scenario: one BFF becomes the new monolith

**Problem.** Single "API BFF" serves web, mobile, and partner. 400 endpoints. Any change requires regression across all clients. Mobile team blocked by web refactor.

**Cause.** **Conway's law ignored** — one BFF for all channels recreated monolith coupling.

**Solution.** Split BFFs by **client cadence and shape**. Share **client libraries** for HTTP/gRPC to domain services, not a shared BFF deployment. Partner BFF on stricter rate limits and versioning.

### Production scenario: BFF duplicates domain validation

**Problem.** Mobile BFF rejects order quantity > 10; Order Service allows up to 100; web BFF allows 50. Fraud and support chaos.

**Cause.** **Business rules leaked into BFF**.

**Solution.** BFF validates **presentation** (required fields, format). Domain service validates **invariants**. BFF passes through domain error codes to consistent UX messages.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| BFF calls services synchronously in serial | Multiplicative latency (5 × 80ms = 400ms) |
| No parallel composition | Fix with `CompletableFuture` / WebFlux `zip` |
| BFF writes to domain DBs directly | Bypasses service boundaries; schema coupling |
| Shared session between BFF and browser for API | CSRF and scaling issues — prefer tokens |
| GraphQL without query cost analysis | One mobile screen triggers 200 downstream calls |

### Debugging scenario

**Observe.** Mobile home feed slow (3s) after adding "recommended products." Web unchanged.

**Diagnose.** Mobile BFF added N+1 catalog calls in loop. Trace shows 40 sequential HTTP calls. No bulkhead — one slow Catalog shard blocks entire feed.

**Fix.** Batch API on Catalog (`POST /products/bulk`), parallel calls with timeout, cache recommendations 60s, bulkhead on Catalog client.

---

## 4. Anti-Corruption Layer (ACL)

### Core concept

An **Anti-Corruption Layer** is a **translation boundary** between your domain model and an **external or legacy model** you do not control — old mainframe COBOL copybooks, partner REST with bizarre field names, SAP IDoc, third-party payment webhooks.

```
 Your domain          ACL (adapter + translator)          External / legacy
 ───────────          ─────────────────────────          ─────────────────
 Order aggregate  ◄──► OrderLegacyMapper + SoapClient ◄──► Mainframe "ORD-REC"
 PaymentIntent    ◄──► StripeWebhookTranslator        ◄──► Stripe Event JSON
```

ACL answers: **how do we keep their mess out of our core model** — not **how do we avoid integration**.

### Internal working

Eric Evans (DDD) — ACL components:

1. **Facade / adapter** — single entry from your domain to the external system.
2. **Translator** — maps external DTO ↔ domain objects; no `LegacyOrder` in domain package.
3. **Adapter implementation** — HTTP, MQ, file drop; retries and circuit breaking live here.

```
domain/
  order/
    Order.java
    OrderRepository.java
integration/
  billing/
    BillingPort.java              # interface domain uses
    MainframeBillingAdapter.java  # implements BillingPort
    MainframeOrderTranslator.java
    MainframeSoapClient.java
```

Domain depends on **`BillingPort`**, not SOAP. Tests use in-memory fake. Legacy changes touch **integration/** only.

```java
public interface BillingPort {
    BillingReceipt charge(BillingCharge command);
}

@Service
@RequiredArgsConstructor
class MainframeBillingAdapter implements BillingPort {

    private final MainframeSoapClient soap;
    private final MainframeOrderTranslator translator;

    @Override
    public BillingReceipt charge(BillingCharge command) {
        var legacyRequest = translator.toLegacy(command);
        var legacyResponse = soap.submitOrder(legacyRequest);  // circuit breaker here
        return translator.toDomain(legacyResponse);
    }
}
```

### ACL vs shared DTO library

| Approach | When | Risk |
|---|---|---|
| **ACL in service** | Legacy changes often; model mismatch | More code |
| **Shared client JAR from vendor** | Stable SaaS SDK | Vendor types leak unless wrapped |
| **Copy external JSON into domain** | "Temporary" | Permanent corruption of domain language |

Always wrap vendor SDKs behind your port.

### Production scenario: legacy field rename Friday deploy

**Problem.** Mainframe team renames `ORD_AMT` → `ORDER_AMOUNT`. All microservices importing `legacy-dto.jar` break simultaneously.

**Cause.** **No ACL** — domain services used legacy DTOs directly.

**Solution.** ACL absorbs rename in `MainframeOrderTranslator` only. Contract test against mainframe stub in CI. Version external schema separately from domain events.

### Production scenario: webhook idempotency outside ACL

**Problem.** Stripe sends duplicate `payment_intent.succeeded`. Payment Service credits wallet twice.

**Cause.** Webhook handler parsed JSON in controller; idempotency logic scattered.

**Solution.** ACL method `processPaymentWebhook(StripeEvent raw)` → translate → idempotent command on domain. Store `event_id` in processed_events table inside local TX.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Domain imports `com.partner.*` classes | Every partner change requires domain redeploy |
| ACL calls domain service via HTTP loop | Circular dependency; use domain module in same service |
| Translator logic in controller | Untestable; grows without bound |
| No contract tests for ACL | Silent drift until production |
| ACL does saga orchestration + translation | God adapter; split orchestrator |

### Debugging scenario

**Observe.** Orders stuck "Submitted to billing" — mainframe shows success.

**Diagnose.** Translator maps success code `00` but new code `0` (string trim issue) treated as failure. Domain never marks paid.

**Fix.** Explicit mapping table for status codes; log raw legacy payload at ACL boundary (PII-redacted); golden-file tests for translator.

---

## 5. Saga Pattern

### Core concept

A **Saga** is a **sequence of local transactions**, each in one service, coordinated to achieve a **business outcome**. If a step fails, **compensating transactions** undo prior steps. There is **no global ACID lock** across services.

```
 Place Order saga (orchestrated):
   1. Order:   CREATE order PENDING        (local TX)
   2. Payment: CHARGE                      (local TX)  ──fail──► compensate
   3. Inventory: RESERVE stock             (local TX)  ──fail──► refund + cancel
   4. Order:   CONFIRM order               (local TX)
```

Saga answers: **how do we complete a business process across services without 2PC** — not **how do we make everything strongly consistent instantly**.

### Internal working — choreography vs orchestration

| Style | Coordinator | Pros | Cons |
|---|---|---|---|
| **Choreography** | Events only | Loose coupling | Hard to trace; cyclic events |
| **Orchestration** | Central saga manager | Clear flow; easy debug | Coordinator availability |

Orchestrator example (state machine):

```
                    ┌──────────────┐
                    │   STARTED    │
                    └──────┬───────┘
                           │ reserve inventory OK
                           ▼
                    ┌──────────────┐
         fail ◄────│   PAYMENT    │────► compensate inventory
                    └──────┬───────┘
                           │ charge OK
                           ▼
                    ┌──────────────┐
                    │  CONFIRMED   │
                    └──────────────┘
```

Each step message carries **`sagaId`**, **`stepId`**, **idempotency key**. Handlers:

```java
@Transactional
public void handle(ChargePaymentCommand cmd) {
    if (processedCommands.exists(cmd.idempotencyKey())) return;
    paymentRepository.charge(cmd);
    processedCommands.mark(cmd.idempotencyKey());
    sagaOutbox.publish(new PaymentCompleted(cmd.sagaId(), ...));
}
```

**Compensations** are not always literal undo — semantic compensations:

| Forward | Compensation |
|---|---|
| Reserve inventory | Release reservation |
| Charge card | Refund (may fail — manual intervention queue) |
| Send email | Send correction email (no undo) |
| Ship package | Return workflow (new saga) |

### Saga + Outbox + message broker

Never publish to Kafka **inside** a local TX without outbox — see [Outbox Pattern](#8-outbox-pattern). Saga state should be **persisted** (table `saga_instance`) for recovery after orchestrator crash.

### Production scenario: lost message between steps

**Problem.** Inventory reserved, payment never attempted. Order stuck forever.

**Cause.** Choreography: `InventoryReserved` event lost; no timeout; no saga state table.

**Solution.** Orchestrated saga with timeouts per step; `saga_instance` row moves to `FAILED` → compensation or alert; DLQ replay with idempotency.

### Production scenario: compensation fails

**Problem.** Payment charged, inventory reserve fails, refund call times out. Customer charged, no order.

**Cause.** **No reconciliation** for failed compensations.

**Solution.** `COMPENSATION_FAILED` state → manual queue + nightly reconciliation job comparing Payment ledger vs Order DB. Alert on any row in that state > 5 minutes.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No idempotency on steps | Duplicate side effects on retry |
| Sync HTTP chain instead of saga | Partial failure with no compensation |
| Compensations in wrong order | Refund before cancel shipment → customer gets item free |
| Long saga without timeout | Rows stuck; inventory locked |
| Cyclic choreography | Event storm; unclear termination |

### Debugging scenario

**Observe.** Spike in `PaymentCompleted` events but flat `OrderConfirmed`.

**Diagnose.** Consumer lag on Order Service; or orchestrator bug routing to wrong topic; check `saga_instance` for step `AWAITING_CONFIRM`.

**Fix.** Scale consumers; fix routing; replay from outbox with saga ID filter; dashboard per saga state counts.

---

## 6. CQRS Pattern

### Core concept

**Command Query Responsibility Segregation (CQRS)** splits **write model** (commands, business rules, normalized storage) from **read model** (queries, denormalized projections optimized for screens). One domain concept — two paths.

```
 Commands ──► Write model (Order aggregate, normalized DB)
                  │
                  │ domain events / CDC
                  ▼
              Read model (OrderSummaryView, Elasticsearch, Redis)
 Queries ◄── Read API (eventually consistent)
```

CQRS answers: **how do we scale reads differently from writes** — not **how do we avoid a database**.

### Internal working

| Path | Optimized for | Consistency | Example store |
|---|---|---|---|
| **Command** | Validation, invariants | Strong (local TX) | PostgreSQL normalized |
| **Query** | Latency, join-free reads | Eventual | Redis, ES, read replica tables |

Update flow:

1. Command handler loads aggregate, applies business logic, persists write DB.
2. Publishes `OrderPlaced` event (via outbox).
3. Projection handler updates read model: `order_summary`, `customer_orders_by_date`.
4. Query API serves from read model only — **never** heavy join on write DB for user-facing list screens.

```java
// Command side
@Service
@RequiredArgsConstructor
class PlaceOrderHandler {
    private final OrderRepository orders;
    private final OutboxPublisher outbox;

    @Transactional
    public OrderId handle(PlaceOrderCommand cmd) {
        var order = Order.place(cmd);
        orders.save(order);
        outbox.publish(order.domainEvents());
        return order.id();
    }
}

// Query side — separate package, maybe separate deploy
@RestController
@RequestMapping("/queries/orders")
class OrderQueryController {
    private final OrderSummaryRepository readModel;

    @GetMapping("/{id}")
    public OrderSummaryDto get(@PathVariable UUID id) {
        return readModel.findById(id)
            .orElseThrow(() -> new NotFoundException(id));
    }
}
```

### CQRS without Event Sourcing

CQRS **does not require** Event Sourcing. Most production CQRS uses **relational write DB + projection tables** or **CDC (Debezium)** to read models. Event Sourcing is an optional persistence style for the write side.

### Production scenario: read-your-writes failure

**Problem.** User submits form, redirect to detail page → 404 for 2 seconds.

**Cause.** Query served from async projection; no **read-your-wwrites** strategy.

**Solutions (pick one):**

1. After command, return full DTO from write side (bypass read model for this request).
2. Client polls with version until read model catches up.
3. **Transactional outbox + synchronous projection** for critical path (adds latency).
4. Route read to write DB by ID for N seconds after create ( pragmatic ).

### Production scenario: projection bug corrupts read model

**Problem.** Dashboard revenue 2× actual. Write DB correct.

**Cause.** Projection double-counted on event replay without idempotent upsert.

**Solution.** Projection uses `event_id` dedup table; rebuild read model from scratch script; monitor `projection_lag_seconds`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| CQRS on low-traffic CRUD | Operational overhead exceeds benefit |
| Query hits write DB "just this once" | Read load returns; boundaries blur |
| Multiple projections without ownership | Inconsistent counts across screens |
| No lag metrics | "Bug" reports are consistency SLA misses |
| Same DTO for command and query | Anemic domain; validation in wrong place |

### Debugging scenario

**Observe.** Search results missing newest products; detail API fine.

**Diagnose.** Elasticsearch projection lagging; Kafka consumer group stuck; check `consumer lag`, `last_processed_offset`.

**Fix.** Reset consumer with caution; scale projection workers; add alerting on lag > 30s.

---

## 7. Event Sourcing Pattern

### Core concept

**Event Sourcing** persists state as an **append-only sequence of domain events**, not as current row values. Current state is derived by **replay** (or snapshots + replay).

```
 Traditional:  orders row { id, status=SHIPPED, total=99.00 }
 Event store:  OrderCreated → ItemAdded → Paid → Shipped
               (current state = fold(events))
```

Event Sourcing answers: **how do we get perfect audit, temporal queries, and rebuild projections** — not **how do we store CRUD rows more simply**.

### Internal working

Components:

| Component | Role |
|---|---|
| **Event store** | Append-only log per aggregate stream (`order-123`) |
| **Aggregate** | Applies events in memory; emits new events on command |
| **Snapshot** | Periodic state checkpoint to shorten replay |
| **Upcasters** | Migrate old event schema versions on read |

```
Command → Load events [e1..en] → Aggregate.apply → new event en+1 → append to store
Query   → Snapshot + tail events OR projection from events
```

Example event stream:

```json
{"type":"OrderCreated","orderId":"abc","customerId":"c1","at":"2026-08-31T10:00:00Z"}
{"type":"LineItemAdded","sku":"SKU-1","qty":2,"unitPrice":49.50}
{"type":"OrderPaid","paymentId":"pay_99","amount":99.00}
```

Concurrency: **optimistic locking** on stream version — append fails if version mismatch → retry or reject.

### Event Sourcing + CQRS

Classic pairing: event store is **system of record**; projections (SQL, ES) are **disposable** and rebuildable by replaying events. This is powerful and expensive.

### Production scenario: replay takes 6 hours

**Problem.** New projection deploy requires replaying 400M events. Cannot ship read model fix.

**Cause.** No snapshots; inefficient event schema; single-threaded projector.

**Solution.** Snapshot every N events; parallel projection by partition key; **copy-to-new-table** rebuild for emergency; consider whether this aggregate needed Event Sourcing.

### Production scenario: event schema change

**Problem.** Rename field `amountCents` → `money.amountMinorUnits`. Old events fail deserialization.

**Cause.** No **upcasting** strategy.

**Solution.** Store event type version in payload; upcaster chain v1→v2 on read; never mutate stored events; test replay suite in CI.

### When NOT to use Event Sourcing

| Use ES | Skip ES |
|---|---|
| Audit legally required (finance, healthcare) | Config flags, preferences |
| Need temporal "state at time T" | Simple catalog CRUD |
| Multiple read models from same truth | Team new to distributed systems |
| Domain experts think in events | Reporting only needs current snapshot |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Events as integration payload (fat events) | Schema coupling; huge streams |
| Delete/GDPR on immutable log | Compliance failure — design tombstone events |
| No snapshot strategy | Slow aggregate load |
| Generic `EventEnvelope` without domain language | Loss of ubiquity |
| Event store also as message bus | Wrong tool; use Kafka for integration |

### Debugging scenario

**Observe.** Aggregate load timeout for high-activity accounts.

**Diagnose.** Stream has 50k events; no snapshot since v1.

**Fix.** Snapshot policy every 100 events; archive old events to cold storage with snapshot anchor; consider aggregate split (account → sub-accounts).

---

## 8. Outbox Pattern

### Core concept

The **Transactional Outbox** ensures **atomicity between database write and message publish**: write business data and an **outbox row** in the **same local transaction**; a separate **relay process** publishes to the message broker and marks rows sent.

```
 BEGIN TX
   UPDATE orders SET status = 'PLACED' WHERE id = ?
   INSERT INTO outbox (id, aggregate_id, payload, topic, created_at) VALUES (...)
 COMMIT
      │
      ▼ (async)
 Outbox relay / Debezium CDC ──► Kafka ──► consumers
```

Outbox answers: **how do we never commit DB without publishing (and vice versa)** — not **how do we get exactly-once everywhere**.

### Internal working

Two implementation styles:

| Style | Mechanism | Pros | Cons |
|---|---|---|---|
| **Polling publisher** | App or job `SELECT ... FOR UPDATE SKIP LOCKED` | Simple | Polling delay |
| **Log-based CDC** | Debezium reads WAL | Low latency | Infra complexity |

Polling relay (illustrative):

```java
@Scheduled(fixedDelay = 500)
@Transactional
void publishOutbox() {
    var batch = outboxRepo.fetchUnpublished(100);
    for (var row : batch) {
        kafkaTemplate.send(row.topic(), row.key(), row.payload());
        row.markPublished();
    }
}
```

Delivery guarantee: **at-least-once** to broker. Consumers **must be idempotent** (`message_id` dedup).

Outbox table schema essentials:

```sql
CREATE TABLE outbox (
  id            UUID PRIMARY KEY,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id  VARCHAR(64) NOT NULL,
  event_type    VARCHAR(128) NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  UNIQUE (id)
);
CREATE INDEX idx_outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
```

### Outbox vs dual write

| Approach | Failure mode |
|---|---|
| **Dual write** (DB then Kafka) | DB commits, Kafka fails → inconsistency |
| **Outbox** | Both or neither in one TX |
| **Kafka TX + DB** | Fragile; mixed vendors; avoid in microservices |

### Production scenario: outbox table bloat

**Problem.** `outbox` 200GB; inserts slow; order placement p99 degraded.

**Cause.** Relay slower than write rate; no archival; missing index on unpublished.

**Solution.** Scale relay; partition outbox; move published rows to archive nightly; alert on unpublished count > 10k; CDC instead of polling at scale.

### Production scenario: published but consumer never runs

**Problem.** Outbox `published_at` set; downstream projection stale.

**Cause.** Confusing **broker publish** with **consumer success**. Relay marks published after Kafka ack, not consumer process.

**Solution.** Monitor consumer lag separately; don't delete outbox rows until retention policy; use inbox pattern on consumer for idempotency.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Outbox in separate TX from domain write | Dual write by another name |
| Same DB connection pool exhausted by relay | App timeouts |
| Large payload in outbox (PDF blob) | DB bloat; use reference to object store |
| No ordering key | Events for same aggregate processed out of order |
| Clock skew on `published_at` | Misleading dashboards |

### Debugging scenario

**Observe.** Orders in DB; no `OrderPlaced` in Kafka for 15 minutes.

**Diagnose.** Relay pod crashed; `published_at IS NULL` count rising; check relay logs, DB locks, Kafka ACL.

**Fix.** Restart relay; run with `SKIP LOCKED`; fix Kafka auth; backfill unpublished in controlled batch.

---

## 9. Circuit Breaker Pattern

### Core concept

A **Circuit Breaker** stops calling a **failing dependency** so threads, connection pools, and the dependency itself can recover. Fail fast while **OPEN** instead of waiting for timeouts on every call.

```
 CLOSED ──(failures exceed threshold)──► OPEN ──(wait)──► HALF_OPEN
    ▲                                                        │
    └──────────── successes ─────────────────────────────────┘
                              failure → OPEN
```

As a **design pattern**, the breaker sits at **integration boundaries**: BFF→service, service→SaaS, ACL→legacy, gateway→upstream. Implementation: Resilience4j, Istio outlier detection, Hystrix (legacy).

See also: `resilience-fault-tolerance.md` for deep Resilience4j configuration.

### Internal working

State machine (Resilience4j semantics):

| State | Behavior |
|---|---|
| `CLOSED` | Calls pass; failures counted in sliding window |
| `OPEN` | `CallNotPermittedException` immediately |
| `HALF_OPEN` | Limited probe calls; success closes, failure reopens |

```java
@CircuitBreaker(name = "inventoryService", fallbackMethod = "fallbackStock")
public StockDto checkStock(String sku) {
    return inventoryClient.getStock(sku);
}

StockDto fallbackStock(String sku, CallNotPermittedException ex) {
    return StockDto.unknown(sku);
}
```

**Fallback** is not optional thinking — define degraded behavior: cached value, default, empty list, or propagate 503 with `Retry-After`.

### Circuit breaker at multiple layers

| Layer | Breaker protects |
|---|---|
| Gateway | Upstream service pool |
| BFF | Each downstream for partial page |
| Service | External SaaS, legacy ACL |
| Mesh sidecar | Same, transparent to app |

**Do not** stack identical breakers without coordination — gateway open + service open = confusing metrics. Prefer **breaker at caller** closest to UX decision point.

### Production scenario: breaker never opens

**Problem.** Inventory always slow (5s), never errors. Thread pool exhausted.

**Cause.** Breaker configured on **failure rate** only, not **slow call rate**.

**Solution.** Enable `slowCallRateThreshold` and `slowCallDurationThreshold`; pair with **TimeLimiter**; bulkhead to cap concurrent waits.

### Production scenario: half-open stampede

**Problem.** Breaker flaps OPEN/CLOSED; dependency gets probe storm.

**Cause.** Many instances half-open simultaneously; `permittedNumberOfCallsInHalfOpenState` too high.

**Solution.** Lower half-open probes; jitter `waitDurationInOpenState`; coordinate via centralized breaker (hard) or accept per-instance breakers with conservative thresholds.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Breaker on internal in-process call | Meaningless state |
| Fallback calls same failing dep | Infinite loop |
| No metrics on state transitions | Surprise OPEN during demo |
| Breaker without timeout | Threads blocked until OPEN |
| Shared breaker name across unrelated deps | False OPEN |

### Debugging scenario

**Observe.** Sudden all products "out of stock" on mobile.

**Diagnose.** `inventoryService` breaker OPEN on all BFF pods; check actuator `/actuator/circuitbreakers`; correlate with Inventory deploy.

**Fix.** Verify fallback UX; fix Inventory; tune thresholds; manual reset only after root cause fixed.

---

## 10. Bulkhead Pattern

### Core concept

A **Bulkhead** **limits concurrent access** to a resource — like ship bulkheads containing flooding. One slow or failing dependency cannot exhaust **all** threads or connections for the service.

```
 Without bulkhead:  [ shared thread pool 200 threads ]
                    inventory slow → all 200 blocked → entire API down

 With bulkhead:     [ orders pool 50 ] [ inventory pool 20 ] [ reports pool 30 ]
                    inventory slow → 20 blocked → orders still serve
```

Bulkhead answers: **how do we isolate blast radius** — not **how do we increase total capacity** (that is scaling).

### Internal working

Types:

| Type | Mechanism | Use case |
|---|---|---|
| **Semaphore bulkhead** | Limits concurrent calls | WebFlux, virtual threads |
| **Thread pool bulkhead** | Dedicated pool per dep | Blocking HTTP clients |
| **Connection pool** | Per-destination max connections | JDBC, HTTP client pools |
| **Pod / cell isolation** | Separate deployments | Checkout vs batch jobs |

Resilience4j:

```yaml
resilience4j:
  bulkhead:
    instances:
      inventoryService:
        maxConcurrentCalls: 25
        maxWaitDuration: 100ms
  thread-pool-bulkhead:
    instances:
      legacyBilling:
        maxThreadPoolSize: 10
        queueCapacity: 20
```

```java
@Bulkhead(name = "inventoryService", type = Bulkhead.Type.SEMAPHORE)
@TimeLimiter(name = "inventoryService")
public CompletableFuture<StockDto> getStockAsync(String sku) {
    return CompletableFuture.supplyAsync(() -> client.getStock(sku));
}
```

### Bulkhead + Circuit Breaker

Bulkhead **caps parallelism**; breaker **stops calls after failure rate**. Order for outbound: often **bulkhead innermost** (cap threads), **timeout**, **retry** (careful), **breaker** outermost.

### Production scenario: shared pool for admin and checkout

**Problem.** Finance runs heavy report; checkout timeouts during month-end.

**Cause.** Same JVM thread pool serves `/admin/reports` and `/checkout`.

**Solution.** Separate bulkhead or **separate deployment** for admin workloads (stronger isolation). Kubernetes: different Deployment with resource quotas.

### Production scenario: bulkhead too small

**Problem.** `maxConcurrentCalls: 2` on Catalog; normal load 50 RPS; constant `BulkheadFullException`.

**Cause.** Bulkhead sized for failure mode, not **nominal concurrency**.

**Solution.** Size from load test: peak concurrent in-flight calls × 1.5; alert on rejection rate; don't set to "2" because blog post said so.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| One bulkhead for all HTTP clients | One slow dep still blocks others in same pool |
| Unbounded queue on thread bulkhead | Latency hides overload until OOM |
| Bulkhead without rejected call metric | Silent degradation |
| Virtual threads = no bulkhead needed | Still can overwhelm downstream DB |

### Debugging scenario

**Observe.** 503 `BulkheadFull` on Partner API only.

**Diagnose.** Partner traffic spike; bulkhead 10; compare with baseline concurrent calls metric.

**Fix.** Raise bulkhead temporarily + rate limit partner at gateway; long-term separate partner deployment tier.

---

## 11. Strangler Fig Pattern

### Core concept

The **Strangler Fig Pattern** incrementally **replaces a legacy system** by routing functionality to new services while the old monolith shrinks — like a fig tree strangling its host.

```
 Phase 1:  Client → Monolith (100%)
 Phase 2:  Client → Gateway → new Order Service (orders)
                         └──► Monolith (everything else)
 Phase 3:  Client → Gateway → Order, Catalog, User services
                         └──► Monolith (reports only)
 Phase 4:  Monolith retired
```

Strangler answers: **how do we migrate without big-bang rewrite** — not **how do we run two systems forever**.

### Internal working

Steps:

1. **Identify seam** — bounded context with clear API (e.g. `POST /orders`).
2. **Place facade** — API Gateway or routing layer in front of monolith.
3. **Implement new service** — with Anti-Corruption Layer to monolith DB if needed during transition.
4. **Route traffic** — feature flag, % canary, or path-based routing.
5. **Sync data** — dual-write, CDC, or read-from-old until cutover verified.
6. **Decommission** — remove monolith module when traffic and data migrated.

```
                    ┌─────────────┐
  /orders/** ──────►│ Order µsvc  │
                    └─────────────┘
                    ┌─────────────┐
  /**         ──────►│  Monolith   │  (shrinking)
                    └─────────────┘
```

### Strangler + ACL + BFF

During migration, **ACL** translates between monolith schema and new domain. **BFF** may call both monolith and new service during transition — minimize duration of this dual-call period.

### Production scenario: dual-write drift

**Problem.** New Catalog service and monolith catalog table diverge; wrong prices on web.

**Cause.** Dual-write without reconciliation; async sync lag.

**Solution.** Single **write leader** during transition; read from new with fallback to old; nightly reconciliation job; metrics on drift count.

### Production scenario: strangler never finishes

**Problem.** Five years later, 60% traffic still on monolith; team maintains both.

**Cause.** No **exit criteria** per module; political fear of cutover.

**Solution.** ADR per slice with deadline; executive sponsor; measure cost of dual maintenance; big-bang cutover for final 5% if needed.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Route by URL only, shared session | Session stickiness to monolith |
| Database shared indefinitely | Cannot kill monolith |
| No feature flags | Rollback requires redeploy |
| Ignore monolith performance during migration | Blame new service for old DB locks |

### Debugging scenario

**Observe.** 1% canary to new Payment service; error rate 10× monolith.

**Diagnose.** Compare payloads ACL translated; load test canary; check idempotency and timeout differences.

**Fix.** Roll back canary; fix ACL mapping; increase canary gradually with automated comparison (shadow traffic).

---

## 12. Sidecar Pattern

### Core concept

A **Sidecar** is a **helper process deployed alongside** the main application container in the same pod (Kubernetes), extending functionality **without changing application code** — proxy, logging agent, config sync, service mesh data plane.

```
 ┌───────────────────────────── Pod ─────────────────────────────┐
 │  ┌─────────────────┐         ┌─────────────────────────────┐  │
 │  │  app container  │ ◄─────► │  sidecar (Envoy / Fluent)   │  │
 │  │  :8080          │  localhost │  :15000                  │  │
 │  └─────────────────┘         └─────────────────────────────┘  │
 └───────────────────────────────────────────────────────────────┘
```

Sidecar answers: **how do we add cross-cutting infra concerns uniformly** — not **how do we implement business logic**.

### Internal working

Common sidecars:

| Sidecar | Function |
|---|---|
| **Envoy (Istio/Linkerd)** | mTLS, retries, metrics, traffic split |
| **Fluent Bit / Filebeat** | Log ship |
| **Vault agent** | Secret rotation |
| **Cloud SQL Auth proxy** | Secure DB connection |

Traffic flow with mesh:

```
 inbound → sidecar intercepts → mTLS → sidecar → app:8080
 app outbound → sidecar → mTLS → remote sidecar → remote app
```

Application may be **unaware** of mesh — connects to `localhost:15001` or transparent redirect via `iptables`.

### Sidecar vs library

| Sidecar | In-process library |
|---|---|
| Uniform upgrade across fleet | Per-app version drift |
| Extra memory per pod (~50–100MB+) | Lower memory |
| Language agnostic | Best for that stack |
| Operational complexity | Simpler deploy unit |

### Production scenario: sidecar memory limits

**Problem.** Pods OOMKilled after enabling Istio; small Java heap already tight.

**Cause.** Sidecar memory not budgeted; default proxy limits too high for small pods.

**Solution.** Set sidecar resources explicitly; right-size pod; consider **ambient mesh** or selective injection (only edge services).

### Production scenario: debugging wrong layer

**Problem.** 503 errors; app logs show success.

**Cause.** Sidecar/outlier detection ejects upstream before app sees error.

**Solution.** Check Envoy stats, `istio-proxy` logs; compare `upstream_rq_503` vs app access log; adjust outlier detection or circuit settings in mesh config.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Sidecar on every pod including batch jobs | Cost explosion |
| App bypasses sidecar (wrong port) | mTLS gaps |
| Two sidecars doing same job | Redundant retries |
| Startup order — app before sidecar ready | Connection refused burst |

### Debugging scenario

**Observe.** Latency +15ms on all calls after mesh enable.

**Diagnose.** Expected hop overhead; check if retry policy duplicated (app + sidecar).

**Fix.** Disable app-level retries where mesh retries; tune connect timeout; measure p99 budget.

---

## 13. Ambassador Pattern

### Core concept

An **Ambassador** is a **helper proxy** that **offloads common connectivity tasks** from the application — retries, auth to external API, connection pooling, protocol bridging. In Kubernetes literature, Ambassador often manifests as a **sidecar** or **local proxy** dedicated to ** outbound** connections.

```
 App ──► localhost:9000 ──► Ambassador sidecar ──► External SaaS / legacy API
         (simple HTTP)        (tokens, retry, TLS)
```

Sidecar is **deployment form**; Ambassador is **role** (outbound ambassador vs inbound **proxy**). Compare:

| Pattern | Primary direction | Typical role |
|---|---|---|
| **Sidecar** | In + out | Mesh, logs, secrets |
| **Ambassador** | Out | Offload client connectivity |
| **API Gateway** | In | Edge routing, auth |

### Internal working

Ambassador responsibilities:

- Token refresh for OAuth2 client credentials to SaaS
- Connection pooling and DNS refresh
- Circuit breaking outbound (overlap with resilience patterns)
- Protocol translation (HTTP/1.1 ↔ gRPC)
- Request signing (AWS SigV4)

Illustrative: ambassador container holds service account credentials; app calls `http://127.0.0.1:9000/payments/charge` without holding API keys.

```yaml
# Simplified pod spec
containers:
  - name: order-service
    image: order-service:1.2
    env:
      - name: PAYMENT_PROXY
        value: "http://127.0.0.1:9000"
  - name: payment-ambassador
    image: payment-ambassador:2.0
    env:
      - name: PAYMENT_API_KEY
        valueFrom:
          secretKeyRef:
            name: payment-credentials
            key: api-key
```

### Ambassador vs Anti-Corruption Layer

| Ambassador | ACL |
|---|---|
| Connectivity, auth, retry | Domain translation |
| Often generic | Business-specific mapping |
| Can be shared lib or proxy | Inside service boundary |

They compose: App → Ambassador (TLS, token) → ACL adapter (SOAP translate) → mainframe.

### Production scenario: credentials in app container

**Problem.** Payment API key in 40 microservice env vars; rotation requires 40 deploys.

**Cause.** No ambassador; each service embeds SDK + secrets.

**Solution.** Ambassador sidecar (or central egress gateway) holds credentials; services call localhost; rotate once in ambassador.

### Production scenario: double retry

**Problem.** Ambassador retries 3×, app retries 3× → 9× load on failing payment API.

**Cause.** **Retry policy not coordinated**.

**Solution.** Retry only in ambassador; app fails fast on ambassador 503; document policy in platform ADR.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Ambassador stateful without persistence | Lost token cache on restart burst |
| App skips ambassador "for performance" | Secrets sprawl returns |
| Ambassador does domain validation | Wrong layer for business rules |
| No health check on ambassador | App starts, outbound fails |

### Debugging scenario

**Observe.** All services fail external geocoding simultaneously.

**Diagnose.** Ambassador pod OOM; shared geocoding ambassador Deployment down; app error `connection refused localhost:9000`.

**Fix.** HPA on ambassador; liveness probes; fallback to cached geo in app.

---

## 14. Pattern Composition and Interaction

Production systems **compose** patterns. Understanding **interaction** prevents double implementation and gap holes.

### Reference architecture — order placement

```
 Mobile ──► Gateway (auth, rate limit)
              └──► Mobile BFF
                      └──► POST /checkout
                              └──► Order Service (orchestrated Saga)
                                      ├─ local TX + Outbox → Kafka
                                      ├─ ACL → Legacy tax API (Ambassador sidecar)
                                      └─ Payment client (Circuit Breaker + Bulkhead)
 Kafka ──► Inventory consumer (idempotent saga step)
       ──► OrderSummary projector (CQRS read model)
 Mobile BFF ──► reads OrderSummary (eventual lag UX)
```

### Composition rules

| Rule | Rationale |
|---|---|
| **One write owner per aggregate** | Saga steps call owner's API |
| **Outbox on every saga step emit** | No lost events |
| **Breakers at outbound boundaries** | BFF, ACL, ambassadors |
| **Gateway does not orchestrate sagas** | Testability and clarity |
| **ACL inside owning service** | Domain boundary |
| **Strangler routes at gateway** | Single traffic control plane |

### Anti-patterns matrix

| Combination | Problem |
|---|---|
| Event Sourcing + direct SQL read on write DB | Defeats purpose |
| CQRS + sync call chain for "fresh read" | Latency + coupling |
| BFF + Saga orchestration + Gateway orchestration | Three places for same workflow |
| Sidecar retries + app retries + gateway retries | Retry storm |
| Outbox + manual Kafka send in same method | Dual write |

### Production scenario: tracing a single checkout

**Problem.** On-call cannot follow `order-xyz` across systems.

**Solution.** Mandatory **`traceId`** and **`sagaId`** in:

- Gateway access logs
- BFF MDC
- Outbox payload headers
- Kafka message headers
- Projection metrics tagged by `aggregate_id`

Runbook link from alert → Grafana dashboard with saga state table.

---

## 15. Production Debugging Playbook

When microservices "feel broken" after a pattern adoption, classify **which pattern owns the symptom** before restarting pods.

1. **Classify the user-visible symptom.**
   - 401/403 → Gateway/BFF auth
   - 404 on new resource → Strangler routing / wrong BFF path
   - Stale data → CQRS lag, not "cache bug" by default
   - Duplicate charge → Saga idempotency
   - Total dependency outage → Circuit breaker OPEN storm
   - Slow everything → Bulkhead pool exhaustion or missing bulkhead

2. **Edge first — Gateway and BFF.**
   ```bash
   # Effective route, upstream target, filter failures
   curl -v -H "Authorization: Bearer $TOKEN" https://api.example.com/api/orders/abc
   # Compare direct to service (bypass gateway) in staging only
   ```

3. **Trace IDs end-to-end.** One ID from mobile through gateway, BFF, services, outbox relay, consumer. If broken at gateway, fix edge before deep diving PostgreSQL.

4. **Saga state check.**
   ```sql
   SELECT saga_id, state, current_step, updated_at
   FROM saga_instance
   WHERE updated_at < now() - interval '5 minutes'
     AND state NOT IN ('COMPLETED', 'FAILED');
   ```

5. **Outbox health.**
   ```sql
   SELECT count(*) FROM outbox WHERE published_at IS NULL;
   SELECT max(created_at) FROM outbox WHERE published_at IS NULL;
   ```
   Rising count → relay failure. Zero unpublished but missing events → consumer lag or wrong topic.

6. **CQRS projection lag.**
   - Kafka consumer group lag per projection
   - `last_event_processed_at` vs write DB `max(updated_at)`

7. **Circuit breaker / bulkhead actuator.**
   ```bash
   curl -s localhost:8080/actuator/circuitbreakers | jq
   curl -s localhost:8080/actuator/metrics/resilience4j.bulkhead.available.concurrent.calls | jq
   ```

8. **Mesh / sidecar (if applicable).** Compare app access log status with Envoy `upstream_rq_*`. Mismatch → problem is sidecar policy not Java code.

9. **Strangler migration.** Compare traffic split config vs error rate by route. Roll back canary via feature flag before code rollback.

10. **Temporary mitigation order.**
    - Stop bleeding: open breakers, disable non-critical projections, shed load at gateway
    - Fix data path: replay outbox, unstick saga, rebuild read model from checkpoint
    - Communicate eventual consistency SLA to product/support
    - Post-incident ADR: which pattern failed and why

---

## 16. Quick Decision Matrix

| Situation | Pattern / action |
|---|---|
| Single public entry, TLS, rate limits, JWT | API Gateway |
| Mobile needs one aggregated screen | BFF for mobile (not in gateway) |
| Legacy mainframe with alien model | Anti-Corruption Layer in owning service |
| Cross-service business flow, no 2PC | Saga (orchestrated for complex flows) |
| Read load >> write; different read shape | CQRS |
| Audit, temporal replay, rebuild projections | Event Sourcing (if team can operate it) |
| DB + broker must agree atomically | Transactional Outbox |
| Dependency failure should not hang all threads | Circuit Breaker + timeout |
| One slow dep must not exhaust JVM | Bulkhead |
| Replace monolith incrementally | Strangler Fig at gateway routes |
| Uniform mTLS, metrics, traffic split in K8s | Sidecar / service mesh |
| Centralize outbound creds and retries to SaaS | Ambassador |
| Partner API vs internal admin different SLAs | Separate BFF or bulkhead tier |
| "Just add Kafka everywhere" | Stop — identify bounded context first |
| Read-your-writes after form submit | Command response DTO or poll version |
| GDPR delete | Event tombstones / crypto shred plan in ES design |
| Debugging cross-service bug | `traceId` + `sagaId` mandatory |
| Dual-write during migration | Reconciliation job + single write leader |
| Retry on payment POST | Idempotency key only — no blind retry |

---

## 17. Interview Q&A

### Q1. What problem does an API Gateway solve that a load balancer does not?

**A.** A load balancer distributes traffic at L4/L7 for health and capacity. An API Gateway adds **API-centric concerns**: authentication/authorization, rate limiting per client, request routing by path/header, protocol transformation, API versioning, and often developer-facing quotas. It is the **policy enforcement point** for external consumers, not just traffic spreading.

### Q2. When would you choose a BFF over exposing microservices directly to the client?

**A.** When the client needs **aggregated, shaped data** in one round trip (mobile on slow networks), **different contracts** per channel (web vs partner), or **UX-specific caching and pagination**. Avoid BFF when the client is another backend service — use direct API or events. Do not put core business invariants only in the BFF.

### Q3. Explain the Anti-Corruption Layer and give a production example.

**A.** ACL is a translation boundary between your domain model and an external/legacy model. Example: Payment service exposes `BillingPort.charge(Money)` internally; `MainframeBillingAdapter` maps to COBOL record layout, calls SOAP, maps response codes to domain `BillingReceipt`. Legacy field renames affect only the adapter, not Order or Checkout services.

### Q4. Saga vs 2PC — when do you pick each?

**A.** Pick **2PC/XA** rarely — homogeneous databases, low latency tolerance, strong ops on coordinators. Pick **Saga** for microservices: long-running flows, heterogeneous stores, high availability. Saga trades atomicity for **eventual business consistency** with compensations and idempotency. Most checkout/order flows use saga + outbox, not 2PC.

### Q5. Choreography vs orchestration in sagas — trade-offs?

**A.** **Choreography:** services react to events; loose coupling; hard to visualize and debug; risk of cyclic dependencies. **Orchestration:** central coordinator drives steps; clear state machine; easier timeouts and compensations; coordinator must be highly available. Use orchestration for complex flows with many steps; choreography for simple publish-subscribe reactions.

### Q6. What is CQRS and does it require Event Sourcing?

**A.** CQRS separates command (write) and query (read) models. Writes enforce invariants on normalized storage; reads serve denormalized projections optimized for queries. **No**, CQRS does not require Event Sourcing — projections can update from domain events, CDC, or even synchronous dual-write (less ideal). Event Sourcing is one way to persist writes as event streams.

### Q7. How do you handle read-your-writes with CQRS?

**A.** Options: return created resource from command handler (write side DTO); client polls until read model version ≥ command version; short TTL route-to-write for GET-by-id after create; synchronous projection for critical path (adds latency). Product must define **acceptable staleness** — often 1–5 seconds for non-financial reads.

### Q8. What is Event Sourcing and when would you avoid it?

**A.** Event Sourcing stores state as append-only events; current state is replay. Use when audit, temporal queries, and rebuildable projections justify operational cost. **Avoid** for simple CRUD, teams without experience, or when GDPR/immutability is poorly planned. Most systems need CQRS + outbox, not full ES.

### Q9. Explain the Transactional Outbox Pattern.

**A.** In one local DB transaction, persist domain changes and an row in an `outbox` table. A relay (polling or CDC) publishes outbox rows to Kafka and marks them published. Guarantees you never commit business data without a corresponding message intent. Consumers must handle **at-least-once** delivery with idempotency.

### Q10. Outbox vs publishing to Kafka directly after DB commit?

**A.** Direct publish after commit is a **dual write** — crash between commit and publish loses the message; publish success + DB rollback creates ghost events. Outbox makes DB write and message record **atomic**. Prefer outbox (or CDC from outbox table) for any event that triggers cross-service workflows.

### Q11. Circuit breaker vs retry — how do they work together?

**A.** Retry handles **transient** failures on individual attempts (timeouts, 503). Circuit breaker stops **all attempts** when failure rate indicates dependency is down. Use retry (limited, idempotent) inside closed breaker; when OPEN, fail fast to fallback without retry storm. Never retry non-idempotent POST without idempotency keys.

### Q12. What is the bulkhead pattern and how is it different from circuit breaker?

**A.** Bulkhead **limits concurrent resources** (threads, connections) per dependency or workload. Circuit breaker **stops calls based on failure history**. Bulkhead prevents one slow dep from occupying all threads; breaker prevents calling a dep that is failing. Use both: bulkhead for isolation, breaker for fail-fast on unhealthy deps.

### Q13. Describe the Strangler Fig pattern migration steps.

**A.** Place routing facade (gateway) in front of monolith; identify bounded context; build new service with ACL if needed; route slice of traffic (path or feature flag); sync data with single write leader and reconciliation; verify metrics; decommission monolith module. Repeat until monolith empty. Define **exit criteria** per slice to avoid permanent dual-run.

### Q14. Sidecar vs Ambassador — what is the difference?

**A.** **Sidecar** is a deployment pattern: helper container in same pod as app. **Ambassador** is a **role**: proxy handling outbound connectivity (auth, retry, pooling). An ambassador is often implemented as a sidecar, but not all sidecars are ambassadors (e.g. log shippers). API Gateway is inbound edge; ambassador is typically outbound helper.

### Q15. How does an API Gateway differ from a BFF in a typical architecture?

**A.** Gateway serves **all clients** with infrastructure policies (TLS, auth, rate limit, routing). BFF serves **one client type** with product aggregation and DTO shaping. Common stack: Client → Gateway → BFF → services. Gateway should stay thin; BFF owns screen-specific composition.

### Q16. What are compensating transactions in a saga?

**A.** Semantic undo steps: release inventory, refund payment, cancel shipment. Compensations are **not always ACID undo** — email cannot be un-sent; use corrective action. Compensations must be **idempotent** and may fail — require reconciliation queues and human intervention for `COMPENSATION_FAILED` states.

### Q17. How do you debug missing events in Kafka after a successful API call?

**A.** Check: (1) API returned 200 — write TX committed? (2) Outbox row exists with `published_at` null? → relay issue. (3) Published but no consumer? → consumer lag, wrong topic, ACL on broker. (4) Consumer errors? → DLQ, poison message. Trace `traceId` and `aggregate_id` across outbox and consumer logs.

### Q18. What is an anti-pattern when combining Gateway, BFF, and Saga?

**A.** Implementing checkout saga as Gateway filter chaining HTTP calls — business orchestration at edge, untestable, wrong failure semantics. Correct: Gateway authenticates and routes to Order service or Checkout BFF; **saga lives in domain service** with persisted state and outbox.

### Q19. Event Sourcing: how do you handle schema evolution?

**A.** Never mutate stored events. Version event types; implement **upcasters** that transform old events to new shape on read/replay; snapshot aggregates to limit replay chain; test replay in CI. Consider compacted topics separately from event store — different concerns.

### Q20. How would you size a bulkhead for a downstream HTTP dependency?

**A.** Load test peak **concurrent in-flight** calls (not RPS alone). Set `maxConcurrentCalls` ≈ measured peak × 1.3–1.5 with `maxWaitDuration` bounded. Monitor rejection rate and latency. Separate bulkheads for critical vs background workloads. Revisit after dependency SLA changes.

### Q21. BFF partial failure — how should the UI behave?

**A.** Return 200 with **degraded payload** when optional sections fail (reviews unavailable) if product accepts; use circuit breaker fallbacks per section. Critical sections failing → 503 or partial 200 with clear `errors[]` and retry hints. Never fail entire product page because recommendations service is down unless recommendations are contractually required.

### Q22. When does CQRS add more harm than good?

**A.** Low read/write traffic admin CRUD; tiny team without ops for projections; strong read-your-writes requirement without UX design; multiple overlapping projections without ownership. CQRS adds **lag, duplication, and operational surfaces** — need measurable read scaling or team scaling pain to justify.

### Q23. Explain idempotency in saga steps with an example.

**A.** Each step message carries `idempotencyKey`. Payment handler: if key processed, return previous result without re-charging. Example: client retries `ChargePayment` on timeout; second delivery sees existing key in `processed_commands` table, skips charge, still emits `PaymentCompleted` for saga progression (or returns stored outcome).

### Q24. Service mesh sidecar vs library circuit breaker — trade-off?

**A.** Sidecar/mesh: uniform policy, language-agnostic, upgrades independent of app; adds memory/latency and operational complexity. Library (Resilience4j): finer-grained per-method control, easier local debug, follows app deploy cycle. Many teams use **library in app for business-aware fallbacks** and **mesh for mTLS and L4/L7 routing**.

### Q25. Design checkout using patterns from this document — outline.

**A.** Mobile → **Gateway** (JWT, rate limit) → **Mobile BFF** (aggregate order status display) → **Order Service** **orchestrated saga**: reserve inventory, charge payment, confirm — each step local TX + **Outbox** to Kafka; **ACL** in Payment for legacy fraud check via **Ambassador** holding API keys; **Circuit breaker + bulkhead** on inventory and payment clients; **CQRS** `OrderSummary` projection for history screen with 3s staleness UX (poll or version); no Event Sourcing unless audit mandates — relational write DB sufficient.

### Q26. How does the Strangler pattern interact with the Anti-Corruption Layer?

**A.** During migration, new services often use ACL to talk to monolith database or APIs temporarily. Strangler routes traffic to new service; ACL hides monolith's model. As data migrates, ACL shrinks — monolith read replaced by local DB, then monolith module removed. ACL is the **compatibility seam** during strangler phases.

### Q27. What metrics would you alert on for outbox and CQRS?

**A.** Outbox: count unpublished rows, age of oldest unpublished, relay error rate, publish throughput. CQRS: consumer lag, projection processing latency p99, rebuild duration, mismatch count vs reconciliation job. Saga: count in non-terminal states > N minutes, compensation failure rate.

### Q28. Can you use Event Sourcing without CQRS?

**A.** Yes, but uncommon at scale — you'd replay events on every read (slow) or maintain snapshots without separate query stores. In practice ES almost always pairs with **projections (CQRS read side)** or snapshots for queries. ES without CQRS suits very small aggregates or tooling that always loads by ID with snapshots.

---

*Design patterns divide boundaries so teams can ship independently — but every pattern adds moving parts. Prefer the smallest pattern set that solves a measured pain; instrument sagas, outboxes, and projections; and when in doubt, trace the `sagaId` before blaming the gateway.*
