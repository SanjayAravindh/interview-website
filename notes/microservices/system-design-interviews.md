# System Design Interviews — Senior Production Reference

This is not a "draw boxes and arrows" tutorial. It is the playbook for **45-minute senior system design interviews** — the clarification questions that save you from building the wrong thing, the back-of-envelope math interviewers expect you to narrate out loud, the tradeoffs that separate staff-level answers from textbook recitation, and **full walkthroughs** of eight systems that appear repeatedly at FAANG, fintech, and e-commerce companies.

Assumes you can already explain CAP, consistent hashing, and load balancers. Focus is on **how to run the interview**, **what to say when**, and **what actually breaks in production** after the whiteboard session ends.

---

## Table of Contents

1. [The 45-Minute Interview Playbook](#0-the-45-minute-interview-playbook)
2. [Clarification Questions Framework](#1-clarification-questions-framework)
3. [Back-of-Envelope Math](#2-back-of-envelope-math)
4. [API Design Sketch Framework](#3-api-design-sketch-framework)
5. [Data Model Sketch Framework](#4-data-model-sketch-framework)
6. [Component Diagram Framework](#5-component-diagram-framework)
7. [Tradeoff Narration](#6-tradeoff-narration)
8. [Non-Functional Requirements Framework](#7-non-functional-requirements-framework)
9. [Walkthrough: URL Shortener](#8-walkthrough-url-shortener)
10. [Walkthrough: Payment / Checkout](#9-walkthrough-payment-checkout)
11. [Walkthrough: Notification System](#10-walkthrough-notification-system)
12. [Walkthrough: Feed / Timeline (Twitter-like)](#11-walkthrough-feed-timeline-twitter-like)
13. [Walkthrough: Rate Limiter / API Gateway](#12-walkthrough-rate-limiter-api-gateway)
14. [Walkthrough: Search / Catalog](#13-walkthrough-search-catalog)
15. [Walkthrough: File Upload / Media Storage](#14-walkthrough-file-upload-media-storage)
16. [Walkthrough: Order Management / Inventory](#15-walkthrough-order-management-inventory)
17. [General Interview Playbook](#16-general-interview-playbook)
18. [Quick Decision Matrix](#17-quick-decision-matrix)
19. [Appendix A–H: Cheat Sheets & Traps](#appendix-a-latency-budget-template)

---

## 0. The 45-Minute Interview Playbook

### Time budget (what senior interviewers score)

| Phase | Minutes | What "good" looks like |
|---|---|---|
| **Clarify & scope** | 5–7 | You restate the problem, confirm users, scale, constraints. You **explicitly defer** analytics, admin UI, or ML unless asked. |
| **Requirements & NFRs** | 3–5 | Functional list (5–8 bullets). NFRs with numbers: availability, latency p99, consistency, retention. |
| **Estimates** | 5–7 | QPS (read/write split), storage, bandwidth. Round aggressively; show formula. |
| **High-level design** | 8–10 | Boxes: clients, gateway, services, caches, DB, queue. One sentence per arrow. |
| **Deep dive** | 12–15 | Interviewer picks 1–2 areas. You go data model + hot path + failure mode. |
| **Scale & tradeoffs** | 5–7 | Sharding, replication, caching, async. Name what you are **not** building and why. |
| **Q&A buffer** | 2–3 | Short answers; tie back to earlier tradeoffs. |

**Rule:** Never spend more than 10 minutes before drawing something. Never spend more than 15 minutes on estimates — they are a sanity check, not a PhD thesis.

### Minute-by-minute script (adapt verbally)

```
0:00  "Let me restate the problem and ask a few clarifying questions."
0:05  "Here's what I heard — functional requirements: ... NFRs: ..."
0:08  "I'll do rough capacity math, then high-level architecture."
0:15  "Core components: ... Hot path for [read/write] is ..."
0:28  "Deep dive: data model + [caching/sharding/consistency]."
0:38  "Failure modes: ... How we'd scale 10×: ..."
0:43  "Happy to go deeper on X or Y."
```

### What interviewers penalize

| Anti-pattern | Why it fails |
|---|---|
| Jumping to Kafka/Cassandra because "scale" | No evidence the workload needs it |
| Ignoring write path on read-heavy systems | Misses consistency, invalidation, fan-out |
| Single global DB with no sharding story at 100M+ DAU | Shows no operational experience |
| No idempotency on money/notifications/orders | Red flag for production maturity |
| Perfect CAP lecture, zero numbers | Staff loop expects quantitative reasoning |
| Designing for Google scale when prompt says "startup MVP" | Over-engineering |

### What interviewers reward

- **Explicit tradeoffs:** "I'm choosing X over Y because … under our QPS assumption …"
- **Failure narration:** "If Redis dies, we fall back to … at cost of …"
- **Scope control:** "Out of scope for 45 min: ML ranking, multi-region active-active"
- **Hot path clarity:** One request traced end-to-end with latency budget
- **Evolution story:** "V1 monolith + Postgres; V2 split read path with cache"

### Whiteboard layout template

```
┌─────────────────────────────────────────────────────────────┐
│ REQUIREMENTS (FR + NFR with numbers)                        │
├─────────────────────────────────────────────────────────────┤
│ ESTIMATES: QPS read/write, storage/day, bandwidth           │
├─────────────────────────────────────────────────────────────┤
│                    [ COMPONENT DIAGRAM ]                    │
├─────────────────────────────────────────────────────────────┤
│ DATA MODEL (entities + keys + indexes)                      │
├─────────────────────────────────────────────────────────────┤
│ HOT PATH (numbered steps + latency budget)                  │
├─────────────────────────────────────────────────────────────┤
│ DEEP DIVE / TRADEOFFS / FAILURE MODES                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Clarification Questions Framework

Ask **5–10 questions** in the first 5 minutes. Group them so the interviewer sees structure.

### Universal opening (every interview)

1. **Who are the users?** End users, internal admins, other services?
2. **Core actions?** What are the top 3 operations by volume?
3. **Scale today vs 3 years?** DAU, requests/day, data size — or "design for X"?
4. **Read vs write ratio?** Drives cache vs storage design.
5. **Latency expectations?** p99 for hot path (e.g. feed load < 300ms)?
6. **Consistency vs availability?** Can users see stale data? For how long?
7. **Multi-region?** Single region OK for MVP?
8. **Existing systems?** Greenfield or integrate with payment provider, identity, etc.?
9. **Compliance / security?** PCI, PII, GDPR, audit logs?
10. **What is explicitly out of scope?** Analytics, search within media, admin dashboards?

### By system type — high-value clarifiers

| System | Must-ask |
|---|---|
| URL shortener | Custom aliases? Expiration? Analytics on clicks? Abuse (malware links)? |
| Payment | Card data on us or Stripe? Refunds/chargebacks? Idempotency window? |
| Notifications | Real-time vs batched? Priority tiers? User opt-out / compliance? |
| Feed | Celebrity problem scale? Chronological vs ranked? Private accounts? |
| Rate limiter | Per user, IP, API key, tenant? Global or per-endpoint limits? |
| Search | Full-text only or facets/filters? Index update latency? |
| File upload | Max file size? Video transcoding? Public vs signed URLs? |
| Orders / inventory | Overselling allowed? Reservations TTL? Split shipments? |

### How to phrase scope cuts (say this out loud)

> "For the next 40 minutes I'll optimize for **correct checkout** and **read-heavy catalog**, with single-region deployment. I'll mention multi-region and search ranking as follow-ups but won't design them in depth unless you want to go there."

This signals senior judgment — you know the full landscape but prioritize.

### Red-flag answers from interviewer (adjust design)

| Interviewer says | Design implication |
|---|---|
| "Money must never be double-charged" | Strong idempotency, ledger, at-least-once + dedup |
| "Feeds must feel instant" | Push fan-out or hybrid; cache warm paths |
| "We have 10K QPS on reads, 100 on writes" | Cache-first; optimize write path for correctness |
| "Inventory cannot go negative" | Pessimistic lock or atomic decrement with constraint |
| "Global users" | CDN, multi-region read replicas; writes harder |

---

## 2. Back-of-Envelope Math

### Constants to memorize

| Constant | Value | Use |
|---|---|---|
| Seconds per day | ~86400 ≈ **100K** | QPS from daily actions |
| Seconds per month | ~2.6M | Storage growth |
| 1 million | 10^6 | |
| 1 billion | 10^9 | |
| Average HTTP request | ~1–10 KB | Bandwidth (without media) |
| Average photo | ~200 KB – 2 MB | Media bandwidth |
| SSD random read | ~100 μs | Too fast to matter vs network |
| Network same-DC RTT | ~0.5 ms | Service hop budget |
| Network cross-region | ~50–150 ms | Multi-region penalty |
| Postgres row + indexes | ~500 B – 2 KB | OLTP storage (varies) |

### QPS formulas

```
QPS = total_requests_per_day / 86400

Peak QPS ≈ QPS_avg × (2 to 3)     # daily curve; use 3 for consumer peaks

Read QPS  = total_QPS × read_ratio
Write QPS = total_QPS × (1 - read_ratio)
```

**Example narration (URL shortener, 100M links created/month, 10:1 redirect:create):**

```
Creates/month ≈ 100M  →  100M / (30 × 86400) ≈ 40 writes/s
Redirects ≈ 10×       →  400 reads/s average
Peak ≈ 3×             →  ~1200 read QPS, ~120 write QPS
```

Always **round up** one order of magnitude if unsure — then say "we have headroom."

### Storage formulas

```
storage = num_records × bytes_per_record × replication_factor

growth_per_day = writes_per_day × bytes_per_record

retention_storage = writes_per_day × bytes_per_record × retention_days
```

**Example (tweet-like, 500M DAU, 2 posts/user/day average):**

```
Posts/day = 500M × 2 = 1B posts/day
Post size ≈ 300 bytes (id, user_id, text, metadata)
Raw/day ≈ 1B × 300 B ≈ 300 GB/day
1 year ≈ 300 GB × 365 ≈ 110 TB/year (before indexes, ~2× → ~220 TB)
```

Say: "Indexes and replicas multiply this; I'll use 3× for planning → ~660 TB/year."

### Bandwidth formulas

```
bandwidth = QPS × payload_size

egress_cost driver = large responses × read QPS   # video, images
ingress = write_QPS × upload_size
```

**Example (image feed CDN):**

```
Read QPS = 50K, average image 200 KB from origin (cache miss 10%)
Origin bandwidth = 50K × 0.1 × 200 KB ≈ 1 GB/s ≈ 8 Gbps (origin only)
CDN serves 90%; origin is manageable with cache hit ratio target 95%+
```

### Latency budget (back-of-envelope for one request)

Typical p99 budget for user-facing read: **200–300 ms** total.

| Hop | Budget |
|---|---|
| Client ↔ edge (CDN/LB) | 20–50 ms |
| Gateway / auth | 5–15 ms |
| App logic | 10–30 ms |
| Cache hit | 1–5 ms |
| DB query (indexed) | 5–20 ms |
| 3 sequential DB/ service calls | **You are already over budget** — parallelize or cache |

Narrate: "I'll parallelize user profile + feed chunk fetches; sequential chain of 4×20ms blows p99."

### Server count (rough)

```
servers_needed ≈ peak_QPS / (single_server_RPS × target_utilization)

# single_server_RPS from load test or rule of thumb: 1K–5K RPS for simple JSON API
# target_utilization: 0.5–0.7 (headroom for spikes)
```

**Example:** Peak 12K QPS, 2K RPS per pod, 60% util → 12K / (2000 × 0.6) ≈ **10 pods** (+ HPA headroom).

### Interview tip: show units and sanity check

Always say units aloud: "That's gigabytes per day, not per second — passes sanity check."

---

## 3. API Design Sketch Framework

Design **REST or gRPC** unless the prompt implies GraphQL (mobile clients with varied shapes). Senior interviews want: resource naming, idempotency, pagination, error model.

### REST conventions (sketch on board)

```
POST   /v1/resources          Create (non-idempotent without key)
GET    /v1/resources/{id}     Read
PUT    /v1/resources/{id}       Replace (idempotent)
PATCH  /v1/resources/{id}       Partial update
DELETE /v1/resources/{id}       Delete (idempotent)

POST   /v1/resources/{id}/actions   # e.g. /orders/{id}/cancel
```

### Headers that matter in system design interviews

| Header | Purpose |
|---|---|
| `Idempotency-Key` | POST dedup (payments, orders, notifications) |
| `Authorization` | Bearer JWT or API key |
| `X-Request-Id` | Tracing |
| `If-Match` / ETag | Optimistic concurrency |
| `Cursor` / `page_token` | Stable pagination |

### Pagination patterns

**Offset (simple, bad at scale):**

```
GET /v1/feed?offset=100&limit=20
```

**Cursor (production feeds, timelines):**

```
GET /v1/feed?cursor=eyJpZCI6MTIzfQ&limit=20

Response: { "items": [...], "next_cursor": "...", "has_more": true }
```

Cursor = opaque, stable under inserts (typically `(timestamp, id)` tuple encoded).

### Error model (minimal)

```json
{
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "SKU-123 has 2 units; requested 5",
    "request_id": "req_abc",
    "retryable": false
  }
}
```

HTTP status: 400 validation, 401/403 auth, 409 conflict, 429 rate limit, 503 overload (retryable).

### API sketch template (fill per system)

```
# Resource: Order
POST   /v1/orders
  Headers: Idempotency-Key
  Body: { cart_id, payment_method_id, shipping_address_id }
  201: { order_id, status: "PENDING_PAYMENT" }
  409: duplicate idempotency key → return original order

GET    /v1/orders/{order_id}
POST   /v1/orders/{order_id}/cancel
GET    /v1/orders?cursor=&limit=20
```

---

## 4. Data Model Sketch Framework

### Entity-relationship sketch rules

1. Name **primary key** type: UUID vs snowflake vs auto-increment (shard-friendly?).
2. Mark **access patterns** under each entity: "read by user_id + created_at DESC."
3. Note **indexes** explicitly — interviews score this.
4. Separate **source of truth** from **derived/cached** stores.

### Sharding key selection

| Good shard key | Bad shard key |
|---|---|
| `user_id` for user-owned data | `created_at` alone (hot shard) |
| `order_id` for order lifecycle | `status` (imbalance) |
| `tenant_id` for B2B SaaS | Low-cardinality enum |

### SQL vs NoSQL narration

| Choose SQL (Postgres) when | Choose wide-column / KV when |
|---|---|
| ACID transactions across rows | Massive scale, simple access pattern |
| Complex joins (moderate scale) | Partition key maps 1:1 to query |
| Strong consistency on writes | Tunable consistency, huge write throughput |

Hybrid is normal: **Postgres for truth**, **Redis for cache/rate limits**, **Elasticsearch for search**, **S3 for blobs**.

### Data model template

```
┌──────────────┐       ┌──────────────┐
│    users     │       │    orders    │
├──────────────┤       ├──────────────┤
│ id (PK)      │──1─N─│ id (PK)      │
│ email        │       │ user_id (FK) │
│ created_at   │       │ status       │
└──────────────┘       │ total_cents  │
                       │ idempotency_key (UNIQUE)
                       └──────────────┘

Indexes:
  orders(user_id, created_at DESC)   -- list my orders
  orders(idempotency_key) UNIQUE     -- dedup
```

---

## 5. Component Diagram Framework

### Standard layers (top to bottom)

```
[ Mobile / Web / Third-party clients ]
              │
              ▼
[ CDN ] ── static assets, cacheable GETs, media edge
              │
              ▼
[ Load Balancer / WAF ] ── TLS termination, DDoS
              │
              ▼
[ API Gateway ] ── auth, rate limit, routing, request validation
              │
     ┌────────┼────────┐
     ▼        ▼        ▼
[ Service A ] [ Service B ] [ Service C ]   ← domain microservices OR modular monolith
     │        │        │
     └────────┼────────┘
              ▼
[ Cache — Redis ]     [ Message Queue — Kafka/SQS ]
              │                    │
              ▼                    ▼
[ Primary DB ]        [ Workers / Consumers ]
              │
              ▼
[ Object Storage — S3 ]   [ Search — ES ]   [ Analytics — OLAP ]
```

### When to add each box

| Component | Add when |
|---|---|
| CDN | Static assets, popular public reads, media |
| API Gateway | Multiple clients, auth, rate limits, TLS |
| Cache | Read QPS ≫ write QPS; tolerable staleness |
| Queue | Async side effects; peak smoothing; fan-out |
| Read replicas | Read-heavy; eventual consistency OK |
| Search index | Full-text, facets; not primary store |
| Blob store | Files, images, video |

### Diagram annotation example

Label each arrow with **protocol + sync/async + criticality**:

```
OrderSvc ──sync HTTP──▶ InventorySvc   (reserve stock, 100ms timeout)
OrderSvc ──async Kafka──▶ NotificationSvc   (at-least-once)
OrderSvc ──sync HTTP──▶ PaymentSvc   (idempotent authorize)
```

---

## 6. Tradeoff Narration

Interviewers want to hear **structured tradeoffs**, not buzzwords.

### Template sentence

> "We could use **A** which gives us **benefit** at the cost of **drawback**. Given **constraint from requirements**, I'll choose **A** for V1 and leave **B** as a migration path if **metric** exceeds **threshold**."

### Classic tradeoffs (know all four sides)

| Decision | Option A | Option B | When A wins |
|---|---|---|---|
| Fan-out | Push (write-time) | Pull (read-time) | Many readers per writer, read latency critical |
| Consistency | Strong (sync replicate) | Eventual (async) | Money, inventory reservation |
| ID generation | UUID v4 | Snowflake / DB sequence | Sortable cursors, index locality |
| Session | Stateful (Redis) | Stateless JWT | Revocation needs, size limits |
| Partitioning | By user | By geography | Data locality, compliance |
| Dedup | Idempotency key table | Natural key unique constraint | Retries from clients/gateways |

### "Good enough for V1" phrases

- "Single-region Postgres with read replicas — not active-active multi-master."
- "Redis cache with TTL staleness of 60s — not invalidation fan-out."
- "At-least-once notifications with dedup table — not exactly-once Kafka exactly-once semantics end-to-end."

---

## 7. Non-Functional Requirements Framework

Use **SLI → SLO → architecture consequence** chain.

### SLI / SLO examples

| Category | SLI | Example SLO | Design lever |
|---|---|---|---|
| Availability | Successful requests / total | 99.9% monthly | Replicas, health checks, graceful degradation |
| Latency | p99 response time | < 300 ms feed load | Cache, CDN, parallel fetch |
| Durability | Data not lost after ack | 99.999999999% (11 nines) S3 | Replication, backups, multi-AZ |
| Consistency | Read-your-writes | Required for profile edit | Route to primary or sticky session |
| Correctness | Zero double charge | 100% | Idempotency + ledger |
| Scalability | Handle 10× traffic | 6 months headroom | Stateless horizontal scale |
| Security | Encrypt PII at rest | Compliance | KMS, field-level encryption |
| Observability | MTTR < 30 min | On-call SLO | Metrics, traces, structured logs |

### NFR checklist (write on board)

```
Availability:  99.9%  (single region) / 99.99% (multi-AZ)
Latency:       p99 ___ ms (name the endpoint)
Throughput:    ___ QPS peak (read / write split)
Durability:    no acknowledged write loss
Consistency:   strong / eventual (where?)
Security:      authN/Z, encryption, audit
Cost:          mention when extreme (egress, ES cluster)
```

### Map NFR to failure modes

| SLO miss | Likely cause | Mitigation |
|---|---|---|
| Latency p99 | N+1 queries, cold cache, lock contention | Batch fetch, warm cache, shorten TX |
| Availability | Cascade failure, DB connections | Bulkheads, timeouts, circuit breakers |
| Durability | Single AZ DB, no backups | Multi-AZ, PITR, cross-region backup |
| Double processing | Retry without idempotency | Idempotency keys, outbox |

---

## 8. Walkthrough: URL Shortener

**Prompt:** Design bit.ly — shorten URLs, redirect, optional analytics.

### 8.1 Requirements

**Functional**

- Create short URL from long URL (custom alias optional).
- Redirect short URL → original (HTTP 301/302).
- Optional: expiration, click analytics, abuse reporting.

**Non-functional (state explicitly)**

- Read-heavy: assume **100:1** redirect:create ratio.
- p99 redirect latency **< 100 ms**.
- Availability **99.9%** (redirect is critical path).
- Short codes: **7 characters**, base62 `[a-zA-Z0-9]`.
- Scale: **100M new URLs/month**, **10B redirects/month**.

**Out of scope:** User accounts, link editing after create (unless asked).

### 8.2 Estimates

```
Creates: 100M / month ≈ 100M / 2.6M sec ≈ 40/s  →  peak ~120/s
Redirects: 10B / month ≈ 4000/s average        →  peak ~12K/s

Storage (5 year retention):
  100M/month × 12 × 5 = 6B URLs
  Row ≈ 500 B (short_code, long_url hash, user_id nullable, timestamps)
  6B × 500 B ≈ 3 TB + indexes ≈ 5–6 TB

Read QPS dominates → cache is mandatory.

Bandwidth (redirect response tiny ~500 B):
  12K × 500 B ≈ 6 MB/s — negligible
```

### 8.3 High-level design

```
Client ──▶ LB ──▶ Redirect Service (stateless)
                    │
         ┌──────────┼──────────┐
         ▼          ▼          ▼
      Redis       Postgres    Kafka (analytics)
     (cache)      (source of truth)   │
                                       ▼
                                 Analytics DB
```

**Create path:** API → generate unique code → insert Postgres → return short URL.

**Redirect path:** API → Redis GET `code → long_url` → on miss, Postgres → populate cache → 301.

### 8.4 API sketch

```
POST /v1/urls
  Body: { "long_url": "https://...", "custom_alias": "optional", "expires_at": null }
  201: { "short_url": "https://short.ly/abc1234", "code": "abc1234" }

GET /{code}   → 301 Location: long_url
  (handled at edge or redirect service)

GET /v1/urls/{code}/stats   (optional)
  200: { "clicks": 12345, "last_clicked_at": "..." }
```

### 8.5 Data model

```
urls
  code           VARCHAR(7) PRIMARY KEY
  long_url       TEXT NOT NULL
  long_url_hash  CHAR(64)     -- SHA-256 for dedup lookup
  user_id        UUID NULL
  created_at     TIMESTAMPTZ
  expires_at     TIMESTAMPTZ NULL
  is_active      BOOLEAN DEFAULT true

UNIQUE (long_url_hash, user_id)  -- optional dedup per user

clicks (analytics, async)
  id             BIGSERIAL
  code           VARCHAR(7)
  clicked_at     TIMESTAMPTZ
  referrer       TEXT
  country        CHAR(2)
  PARTITION BY RANGE (clicked_at)  -- monthly partitions
```

**Dedup:** If same long URL submitted twice, return existing code (product choice — clarify).

### 8.6 Hot path deep dive: redirect

```
1. Client GET /abc1234
2. Edge/CDN — optional cache for **very** hot links (careful: expiring links)
3. Redirect service:
   a. Redis GET url:abc1234  (1 ms)
   b. Hit → 301 + async click event to Kafka (non-blocking)
   c. Miss → Postgres SELECT by code (5–15 ms)
   d. Not found → 404
   e. expired → 410 Gone
4. Total p99 target: < 50 ms without CDN, < 20 ms with Redis hit
```

**301 vs 302:** 301 caches at browser (good for permanent, bad if URL changes). Use **302** if links editable; **301** for immutable.

### 8.7 ID / code generation

| Approach | Pros | Cons |
|---|---|---|
| Random + collision check | Simple | Collisions at scale; retry loop |
| Base62(counter) | Fast | Predictable/guessable unless salted |
| Snowflake-style | Unique, sortable | Needs ID service |
| **Pre-allocated range per server** | No collision at insert | Range management |

**Senior answer:** Range allocator or snowflake + base62 encode. Check uniqueness on insert with PK constraint. 62^7 ≈ 3.5 trillion codes — ample.

### 8.8 Scaling

- **Redirect tier:** Stateless, horizontal scale behind LB. **12K peak QPS** ≈ 6–10 pods (2K RPS each).
- **Redis:** Cluster, **replication**, memory ≈ hot codes (top 20% links = 80% traffic — cache those).
- **Postgres:** Write low (~120/s). Single primary sufficient; **read replicas** for cache miss path.
- **Analytics:** Async Kafka → ClickHouse/BigQuery; never block redirect.

### 8.9 Consistency choices

- **Create then redirect:** Read-your-writes if user immediately tests link — write-through cache on create.
- **Analytics:** Eventual consistency OK (clicks lag seconds).
- **Cache invalidation:** On delete/expire — delete Redis key; TTL backup.

### 8.10 Failure modes & production gotchas

| Failure | Symptom | Mitigation |
|---|---|---|
| Redis down | Postgres load spike, latency up | Circuit breaker; local LRU cache; replica Redis |
| Hot key (viral link) | Single Redis shard hot | Local cache on each pod; CDN cache redirect |
| Malware URLs | Brand damage | Async URL scan (Safe Browsing API); block redirect |
| Enumeration attack | Scrape all codes | Rate limit; non-sequential codes |
| Postgres primary fail | Writes fail | Failover (Patroni/RDS Multi-AZ) |

**Gotcha:** Don't log full long URLs with PII query params in click stream without governance.

### 8.11 Interview Q&A — URL shortener

**Q: How handle custom aliases?**  
A: `INSERT` with alias as PK; unique constraint; 409 on conflict. Reserve dictionary of blocked words.

**Q: Scale to 1B redirects/day?**  
A: CDN/edge redirect with KV at edge (Cloudflare Workers KV); origin only on miss; geo DNS.

**Q: Dedup long URLs globally?**  
A: Hash long URL → lookup index before insert; saves storage but couples users — product decision.

**Q: Analytics without slowing redirect?**  
A: Fire-and-forforget to Kafka; aggregate in stream processor; never sync write to analytics DB on redirect path.

---

## 9. Walkthrough: Payment / Checkout

**Prompt:** Design checkout flow — cart to payment confirmation, integrate card payments.

### 9.1 Requirements

**Functional**

- Create payment intent from cart total.
- Authorize/capture card via PSP (Stripe-like).
- Support idempotent retries (mobile flaky networks).
- Webhooks from PSP for async outcomes.
- Refunds (partial/full) — mention API, deep dive if asked.

**Non-functional**

- **Correctness:** no double charge — hard requirement.
- Availability **99.95%** for payment API.
- p99 authorize **< 2 s** (PSP bound).
- PCI: **no raw card storage** — tokenization via PSP.
- Audit trail for all money movement.

**Out of scope:** Fraud ML, FX, crypto.

### 9.2 Estimates

```
Assume e-commerce: 50M orders/year → ~1.6 orders/s average
Peak (Black Friday): 50× → ~80 orders/s
Payment API calls ≈ 2× order (auth + capture) → ~160/s peak

Storage:
  payments row ~1 KB; 50M/year × 5 years ≈ 250M rows ≈ 250 GB + ledger entries
Ledger append-only: ~2× → manageable on Postgres with partitioning

PSP rate limits: often 100–1000 RPS — know your provider
```

### 9.3 High-level design

```
Client ──▶ API Gateway ──▶ Checkout Orchestrator
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Cart Service    Payment Service   Order Service
                              │
                              ▼
                         PSP (Stripe)
                              │
                         webhook ──▶ Payment Service
                              │
                              ▼
                         Ledger DB (append-only)
                         Outbox ──▶ Kafka ──▶ Fulfillment
```

**Pattern:** **Orchestrated saga** with compensating actions (release inventory, void auth).

### 9.4 API sketch

```
POST /v1/checkout/sessions
  Idempotency-Key: client-uuid
  Body: { cart_id, shipping_address_id, payment_method_id }
  201: { session_id, status: "PENDING", client_secret: "..." }  # if client-side confirm

POST /v1/payments/authorize
  Idempotency-Key: REQUIRED
  Body: { order_id, amount_cents, currency, payment_method_token }
  200: { payment_id, status: "AUTHORIZED" | "FAILED" }

POST /v1/payments/{id}/capture
  Idempotent by payment_id + capture attempt id

POST /v1/webhooks/psp   (HMAC verified, raw body)
```

### 9.5 Data model

```
orders
  id, user_id, status, total_cents, currency, idempotency_key UNIQUE, created_at

payments
  id, order_id, psp_payment_id, status, amount_cents, currency,
  idempotency_key UNIQUE, authorized_at, captured_at

payment_events (audit / event sourcing lite)
  id, payment_id, event_type, payload JSONB, created_at

ledger_entries (double-entry)
  id, account, debit_cents, credit_cents, ref_type, ref_id, created_at
  -- invariant: sum debits = sum credits per payment
```

### 9.6 Hot path deep dive: authorize + place order

```
1. Client POST /checkout with Idempotency-Key K
2. Checkout service:
   a. Lookup idempotency record K → if exists, return stored response (200/201)
   b. BEGIN TX: validate cart, compute total (server-side — never trust client amount)
   c. Reserve inventory (sync call, timeout 500ms, idempotent reserve token)
   d. Call PSP authorize (sync, timeout 5s, idempotency key = K or payment_id)
   e. Insert order + payment rows status AUTHORIZED
   f. Insert outbox event OrderPaid
   g. COMMIT
3. Outbox relay publishes OrderPaid → fulfillment
4. Async: capture may be separate step for two-phase commerce
```

**Critical:** Idempotency store (Redis or Postgres) keyed by `Idempotency-Key` + user, TTL 24–72h.

### 9.7 Consistency & saga

| Step | Failure | Compensation |
|---|---|---|
| Inventory reserved, PSP fails | Abort | Release reservation |
| PSP authorized, DB commit fails | Rare | Reconcile job voids orphan auth |
| Webhook arrives before API response | Race | Webhook handler idempotent on psp_payment_id |
| Duplicate webhook | Double capture attempt | Status machine: only CAPTURED once |

**State machine:** `PENDING → AUTHORIZED → CAPTURED → REFUNDED` with legal transitions only.

### 9.8 Scaling

- Payment service **stateless**; bottleneck is **PSP** and **DB writes**.
- Partition ledger by `payment_id` or date.
- Webhook ingestion: queue + workers (verify signature, enqueue process).
- Read replicas for payment history UI.

### 9.9 Failure modes & production gotchas

| Gotcha | Reality |
|---|---|
| Idempotency only on client | Gateways/load balancers retry POST — server must dedup |
| Trust client amount | Fraud — always server-side pricing |
| No webhook replay protection | Store event IDs from PSP; unique constraint |
| Long TX holding inventory + PSP call | Connection pool exhaustion — **short TX**: reserve → commit → call PSP → update in new TX with saga |
| Clock skew on idempotency expiry | Use DB time; 24h minimum window |

**PCI:** Card data never touches your servers — use PSP iframe/token; SAQ A scope.

### 9.10 Interview Q&A — payment

**Q: Exactly-once payment?**  
A: End-to-end exactly-once impossible with external PSP; achieve **effectively once** via idempotency keys + ledger + reconciliation batch job comparing PSP settlement file.

**Q: Split payment + wallet + gift card?**  
A: Ledger with multiple accounts; orchestrator coordinates partial captures; single order maps to N payment legs.

**Q: How test without production PSP?**  
A: PSP test mode + contract tests; simulate webhooks; chaos on duplicate delivery.

---

## 10. Walkthrough: Notification System

**Prompt:** Send email, push, SMS to users — transactional and marketing.

### 10.1 Requirements

**Functional**

- API: send notification (template + channel + recipient).
- User preferences (opt-out per channel/category).
- Templates with variables.
- Delivery status tracking (sent, delivered, failed).
- Retry transient failures.

**Non-functional**

- **Throughput:** 1M notifications/hour peak burst.
- Latency: transactional (password reset) **< 30 s** p99; marketing can lag minutes.
- At-least-once delivery; **dedup** to avoid user annoyance.
- Compliance: CAN-SPAM, GDPR unsubscribe.

### 10.2 Estimates

```
1M/hour ≈ 280/s average; burst 10× ≈ 2800/s

Payload ~2 KB metadata per notification
Storage (90 day status retention):
  1M/hr × 24 × 90 ≈ 2.16B rows — too heavy for single Postgres
  → partition by date; archive to cold storage; aggregate metrics

Email size ~10 KB; SMS ~140 bytes metadata
Provider limits: SES ~14/s default (need limit increase); use queues to smooth
```

### 10.3 High-level design

```
Producer services ──▶ Notification API ──▶ Validation (prefs, quiet hours)
                                              │
                                              ▼
                                         Kafka (priority topics)
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                        Email Worker    Push Worker     SMS Worker
                              │               │               │
                              ▼               ▼               ▼
                           SendGrid        FCM/APNs        Twilio
                              │
                              ▼
                        Status callbacks ──▶ Status Service ──▶ DB
```

### 10.4 API sketch

```
POST /v1/notifications
  Idempotency-Key
  Body: {
    "user_id": "...",
    "channel": "email|push|sms",
    "template_id": "password_reset",
    "variables": { "code": "123456" },
    "priority": "transactional|marketing"
  }
  202: { "notification_id": "...", "status": "QUEUED" }

GET /v1/notifications/{id}
PUT /v1/users/{id}/preferences
```

### 10.5 Data model

```
notifications
  id, user_id, channel, template_id, status, idempotency_key UNIQUE,
  payload_hash, created_at, sent_at

notification_attempts
  id, notification_id, provider, provider_msg_id, status, error, created_at

user_preferences
  user_id, channel, category, opted_in BOOLEAN

templates
  id, channel, subject, body, version
```

**Dedup:** `(user_id, template_id, payload_hash, window)` for marketing; strict idempotency key for transactional.

### 10.6 Hot path deep dive

```
1. Order service publishes OrderShipped event OR calls Notification API
2. API checks user prefs → if opted out, return 200 skipped
3. Render template (cache templates in memory)
4. Produce to Kafka topic notifications.transactional (partition by user_id)
5. Email worker consumes:
   a. Rate limit per provider
   b. Call SendGrid API
   c. Record attempt; update status
6. Webhook from SendGrid (delivered/bounce) → update status; suppress hard bounces
```

### 10.7 Scaling

- **Kafka** partitions scale consumers; **separate topics** for priority.
- **Worker pools** per channel (SMS cost ≠ email cost).
- **Rate limiting** per provider and global (protect reputation).
- **Template rendering** CPU — horizontal workers.

### 10.8 Consistency choices

- Preferences: **cache with invalidation** on update; stale opt-out is compliance risk — read from primary for marketing sends or short TTL (60s).
- Status: eventual OK for dashboard.

### 10.9 Failure modes & production gotchas

| Failure | Mitigation |
|---|---|
| Provider outage | Multi-provider fallback; DLQ + retry with backoff |
| Duplicate Kafka consume | Idempotent consumer on notification_id |
| Push token stale | Register token refresh from mobile; prune on 410 |
| Email throttling | Queue lag acceptable for marketing; priority lane for OTP |
| Content bug blast | Kill switch flag; max send rate per template |

### 10.10 Interview Q&A — notifications

**Q: Exactly-once email?**  
A: Not guaranteed externally; idempotency + provider dedup keys; user sees at most one OTP if key reused.

**Q: Schedule notification for 9 AM user local time?**  
A: Scheduler service writes to delayed queue (Redis ZSET or SQS delay); worker fires at window.

**Q: Personalization at scale?**  
A: Pre-render at send time with cached user attributes; avoid N DB hits via batch prefetch in consumer.

---

## 11. Walkthrough: Feed / Timeline (Twitter-like)

**Prompt:** Design home timeline — users follow others and see recent posts.

### 11.1 Requirements

**Functional**

- Post tweet (text, optional media metadata).
- Follow / unfollow users.
- Home timeline: recent posts from followees.
- User profile timeline (own posts).
- Fan-out on write or read — **core design choice**.

**Non-functional**

- **500M DAU**, average **200 follows**, **2 posts/user/day** (active subset).
- Timeline load p99 **< 300 ms**.
- Availability **99.9%**; stale feed by **≤ 30 s** acceptable (clarify).
- Celebrity users: **50M+ followers** (Justin Bieber problem).

**Out of scope:** Trending, search, DMs, ranking ML.

### 11.2 Estimates

```
Posts/day (10% users post): 500M × 0.1 × 2 = 100M posts/day
  → ~1200 writes/s average, peak ~3600/s

Timeline reads: 500M DAU × 5 loads/day = 2.5B reads/day
  → ~29K read/s average, peak ~90K/s

Post storage:
  100M/day × 500 B ≈ 50 GB/day raw → ~18 TB/year (+ indexes ~2×)

Fan-out write (push model):
  Average fan-out = 200 followers/post → 100M × 200 = 20B timeline writes/day
  → ~230K writes/s — **push alone fails at average**

Conclusion: **hybrid fan-out** mandatory at this scale.
```

### 11.3 High-level design

```
Client ──▶ API Gateway ──▶ Post Service ──▶ Post DB (sharded by user_id)
              │                │
              │                └──▶ Fan-out Service ──▶ Timeline Cache (Redis)
              │                         │
              │                    Kafka (fan-out jobs)
              ▼
         Timeline Service ──▶ Redis (precomputed timelines)
              │
              └──▶ on miss / celebrity ──▶ merge from follow list + post store
```

### 11.4 API sketch

```
POST /v1/posts
  Body: { "text": "...", "media_ids": [] }
  201: { "post_id", "created_at" }

POST /v1/users/{id}/follow
DELETE /v1/users/{id}/follow

GET /v1/timeline/home?cursor=&limit=20
  200: { "posts": [...], "next_cursor": "..." }

GET /v1/users/{user_id}/posts?cursor=
```

### 11.5 Data model

```
posts (shard by author user_id)
  post_id (snowflake), user_id, text, created_at, media_ids[]

follows
  follower_id, followee_id, created_at
  PRIMARY KEY (follower_id, followee_id)
  INDEX (followee_id)  -- for fan-in count

timelines (Redis — push model cache)
  key: timeline:{user_id}
  value: sorted set of post_id by timestamp (cap 800 entries)

fan_out_jobs
  post_id, author_id, follower_count, status
```

### 11.6 Hot path deep dive: home timeline read

```
1. GET /timeline/home?cursor=C&limit=20
2. Timeline service:
   a. Redis ZREVRANGE timeline:{user_id} (1–5 ms) — get post_ids
   b. If cache warm and enough ids → batch GET post bodies (Redis/Memcached or Post service)
   c. Hydrate author profiles (batch, cached)
   d. Return 20 posts + next_cursor
3. Latency budget: Redis 5ms + batch fetch 30ms + gateway 20ms = ~55ms p50

Celebrity / cold user:
  - Author has followers > 10K → **no push**; followers pull at read time
  - Read path merges: cached timeline + fetch recent posts from followees not in cache (limited)
```

### 11.7 Fan-out strategies

| Model | Write cost | Read cost | Use when |
|---|---|---|---|
| **Push** | O(followers) | O(1) | Normal users (<10K followers) |
| **Pull** | O(1) | O(following) | Read-rare or celebrity authors |
| **Hybrid** | Push if followers < T else pull | Mixed | Twitter-scale |

**Hybrid narration:**

> "On post create, if follower_count < 10K, enqueue fan-out job to insert post_id into each follower's Redis timeline (trim to 800). If celebrity, skip fan-out; readers merge celebrity posts at read time from author's post list."

### 11.8 Scaling

- **Post DB:** Shard by `user_id` (author).
- **Timeline Redis:** Cluster; **millions of keys** — memory plan: 500M users × active 20% × 800 ids × 8 bytes ≈ huge — **only active users** get Redis timelines; cold storage eviction.
- **Fan-out workers:** Kafka consumer group scales horizontally; **backpressure** when Redis slow.
- **Read replicas** for profile/post fetch.

### 11.9 Consistency choices

- Timeline may miss post for seconds during fan-out — acceptable per NFR.
- **Read-your-writes:** After post, inject post_id at top of author's timeline synchronously.
- Unfollow: remove author from merge list; lazy purge from Redis timeline.

### 11.10 Failure modes & production gotchas

| Failure | Mitigation |
|---|---|
| Fan-out lag | Show partial timeline; background catch-up |
| Redis memory pressure | Trim timelines; TTL inactive users |
| Hot celebrity post | Don't push; CDN doesn't help timeline — merge at read |
| Thundering herd on popular post | Single post cached globally by post_id |
| Cascading slow Post DB | Circuit breaker; degrade to cached timeline only |

### 11.11 Interview Q&A — feed

**Q: Ranked feed not chronological?**  
A: Add scoring service; store `(post_id, score)` in ZSET; regenerate on engagement signals — async ranking pipeline.

**Q: Delete post propagation?**  
A: Tombstone in post store; filter on read; async purge from timelines (hard at scale — soft delete + filter).

**Q: Private accounts?**  
A: Fan-out only to approved followers; check ACL at fan-out job time.

---

## 12. Walkthrough: Rate Limiter / API Gateway

**Prompt:** Design a distributed rate limiter for API gateway — limit clients per API key / user / IP.

### 12.1 Requirements

**Functional**

- Enforce limits: e.g. **1000 req/min per API key**, **100 req/s global per endpoint**.
- Return **429** with `Retry-After`.
- Support burst (token bucket).
- Distributed: many gateway nodes, consistent enforcement.

**Non-functional**

- **Overhead < 5 ms** p99 per check.
- **Accuracy:** can overshoot slightly under partition (clarify strict vs approximate).
- **100K gateway RPS** aggregate.

**Out of scope:** WAF, full API gateway auth (mention integration).

### 12.2 Estimates

```
100K RPS rate limit checks
Redis: 100K ops/s — single cluster achievable with sharding
Memory: 1M active keys × 64 B ≈ 64 MB (negligible)
Bandwidth: minimal
```

### 12.3 High-level design

```
Client ──▶ LB ──▶ API Gateway Pod (N replicas)
                      │
                      ├──▶ Auth (JWT validate)
                      ├──▶ Rate Limiter ──▶ Redis Cluster
                      │         (token bucket / sliding window)
                      └──▶ Route to backend services
```

**Alternative:** Sidecar (Envoy + Redis) or dedicated **Rate Limit Service** (RLS) gRPC — Google pattern.

### 12.4 API sketch (internal)

```
# Envoy ext_authz / custom middleware — not public REST

CheckRateLimit(api_key, route, cost=1) → ALLOW | DENY(retry_after_ms)

Admin:
PUT /v1/limits
  Body: { "tenant_id", "route": "/v1/orders", "limit": 1000, "window": "60s", "burst": 50 }
```

### 12.5 Algorithms

| Algorithm | Behavior | Redis implementation |
|---|---|---|
| **Token bucket** | Allows burst, smooth refill | Hash: tokens, last_refill; Lua script atomic |
| **Fixed window** | Simple; boundary spike 2× | INCR key with EXPIRE per window |
| **Sliding window log** | Accurate; memory heavy | ZSET of timestamps |
| **Sliding window counter** | Good compromise | Two windows weighted average |

**Senior pick:** **Token bucket** or **sliding window counter** in Redis **Lua** for atomicity.

```lua
-- Token bucket sketch (conceptual)
-- KEYS[1]=bucket, ARGV[1]=rate, ARGV[2]=burst, ARGV[3]=now_ms, ARGV[4]=cost
local data = redis.call('HMGET', KEYS[1], 'tokens', 'last')
local tokens = tonumber(data[1]) or tonumber(ARGV[2])
local last = tonumber(data[2]) or tonumber(ARGV[3])
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local delta = math.max(0, now - last)
tokens = math.min(burst, tokens + delta * rate / 1000)
if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'last', now)
  redis.call('EXPIRE', KEYS[1], 3600)
  return {1, tokens}
else
  return {0, tokens}
end
```

### Production scenario: Black Friday gateway saturation

**Problem.** Marketing campaign sends 5M users to API simultaneously. Gateway pods CPU fine; Redis p99 latency jumps 1ms → 80ms; 15% requests get 429 despite limit being 1000/min/user — **global** endpoint limit hit first.

**Cause.** Per-endpoint global counter (`rl:global:/v1/deals`) becomes hot key; all gateway nodes hammer single Redis slot.

**Solution.** Split global limit into **regional counters** (limit/region_count); or use **local token bucket** with async sync to Redis every 100ms (approximate). For flash sales, **queue** users at edge (waiting room) instead of pure rate limit.

### Production scenario: Fail-open vs fail-closed debate

**Problem.** Redis cluster network partition during payment peak. Rate limiter fail-open → DB overload → outage. Previous fail-closed caused all traffic 503 during minor Redis blip.

**Senior answer in interview:**

> "Transactional payment endpoints **fail-closed** with short Redis timeout (5ms) and cached 'last known limit state' in gateway memory — degraded but not unlimited. Read-heavy catalog endpoints **fail-open** with emergency static limit per pod."

### 12.6 Data model (Redis)

```
Key: rl:{api_key}:{route}:{window_type}
Fields (Hash): tokens, last_update_ts
TTL: 2× window period (cleanup)
```

**Sharding:** Redis cluster by `hash(api_key)`.

### 12.7 Hot path deep dive

```
1. Request arrives gateway with API key
2. Extract identity + route template (/v1/orders/{id} → /v1/orders/:id)
3. Redis EVAL token bucket script (1 round trip ~1ms same AZ)
4. If deny → 429 + Retry-After from tokens deficit
5. If allow → forward to backend
```

### 12.8 Scaling

- **Redis Cluster** horizontal; hash tag `{api_key}` for colocation.
- **Gateway pods** stateless; HPA on RPS/CPU.
- **Global vs regional limits:** Per-region Redis or approximate global split.

### 12.9 Consistency choices

- **Strict global limit:** Central Redis — latency cost.
- **Redis failure:** Fail-open vs fail-closed — payment APIs fail-closed.

### 12.10 Failure modes & production gotchas

| Gotcha | Detail |
|---|---|
| Race without atomicity | Use Lua/MULTI |
| Clock skew | Use Redis TIME in script |
| Thundering retry on 429 | Client backoff + jitter |
| Hot API key | Local token cache with sync |
| Memory leak | Always TTL on keys |

### 12.11 Interview Q&A — rate limiter

**Q: Rate limit 1M distinct IPs?**  
A: Bloom filter for blocklist; /64 aggregation for IPv6.

**Q: Different limits per plan?**  
A: Config service; cache in gateway memory with version stamp.

**Q: Without Redis?**  
A: Gossip between nodes (approximate); edge CDN for DDoS only.

---

## 13. Walkthrough: Search / Catalog

**Prompt:** Design product search for e-commerce — full-text, filters, sort, browse.

### 13.1 Requirements

**Functional**

- Search by keyword with relevance ranking.
- Faceted filters (category, brand, price range, rating).
- Sort: relevance, price, popularity.
- Product detail by ID.
- Index updates on catalog change (seconds to minutes lag OK).

**Non-functional**

- **50M products**, **100K searches/s** peak.
- p99 search **< 200 ms**.
- Availability **99.9%**; stale index **< 1 min** acceptable.

### 13.2 Estimates

```
Search QPS: 100K peak
Index size: 50M × 2 KB doc ≈ 100 GB (+ replicas ~300 GB)
Catalog updates: 1% SKUs/day ≈ 6/s — low write rate

Bandwidth: 100K × 20 KB response ≈ 2 GB/s — cache hot queries
```

### 13.3 High-level design

```
Client ──▶ Search Service ──▶ Elasticsearch cluster
              │                      ▲
              └──▶ Product Service ──┘
                        │
                   CDC / events ──▶ Indexer
```

### 13.4 API sketch

```
GET /v1/search?q=laptop&category=electronics&price_min=500&sort=price_asc&limit=24
GET /v1/products/{product_id}
```

### 13.5 Data model

**Postgres (truth):** `products(id, title, description, brand_id, category_id, price_cents, attributes JSONB, updated_at)`

**Elasticsearch doc:** product_id, title, brand, category_path, price_cents, rating_avg, popularity_score, in_stock, suggest input.

### 13.6 Hot path deep dive: search request

```
1. Parse query string; sanitize; detect zero-results broadening strategy
2. Build ES query:
   - must: multi_match on title^3, description
   - filter: category, price range (filters are cacheable bits)
   - aggs: terms on brand, category for facets
3. Execute with timeout 150ms; route to coordinating node
4. Hydrate top hits with CDN image URLs (don't store blobs in ES)
5. Cache full response for hot queries (Redis, 30–60s TTL)
6. Return p99 < 200ms (ES 50–100ms + app 20ms + cache hit 5ms)
```

**Query example (conceptual):**

```json
{
  "query": {
    "bool": {
      "must": [{ "multi_match": { "query": "laptop", "fields": ["title^3", "description"] } }],
      "filter": [
        { "term": { "category_path": "electronics/laptops" } },
        { "range": { "price_cents": { "gte": 50000, "lte": 200000 } } }
      ]
    }
  },
  "aggs": { "brand": { "terms": { "field": "brand" } } },
  "sort": [{ "price_cents": "asc" }],
  "size": 24
}
```

### 13.7 Indexing pipeline

```
Product update in Postgres
  → Debezium CDC OR application outbox event ProductUpdated
  → Indexer consumer transforms to ES bulk API
  → Refresh interval 1s (near real-time)
  → On failure: DLQ + retry; index version alias swap for reindex
```

**Full reindex:** New index `products_v42`, bulk reindex, alias flip `products_current` — zero downtime.

### 13.8 Scaling

- **ES:** Shards ~30–50GB each; 50M docs may use 20–50 shards; replicas for read scale.
- **Search service:** Stateless; 100K QPS needs many pods + aggressive caching (top 1% queries = 50% traffic).
- **Separate autocomplete cluster** if suggest load heavy.

### 13.9 Consistency choices

- **Catalog truth in Postgres**; search is **eventually consistent**.
- Stock status: oversell risk if index stale — **checkout validates inventory** in real-time.

### 13.10 Failure modes & production gotchas

| Failure | Mitigation |
|---|---|
| ES cluster yellow/red | Replica shards; degrade to keyword-only backup index |
| Slow query | Query timeout; circuit breaker; block leading wildcard |
| Index drift | Nightly reconciliation job compares counts |
| Facet explosion | Limit facet cardinality; precompute popular facets |
| Price change during search | Display "price may vary"; fresh price on product page |

### 13.11 Interview Q&A — search

**Q: Typo tolerance?**  
A: ES fuzziness AUTO; phonetic optional; query suggestions.

**Q: Personalization?**  
A: Boost by user segment in query builder; separate ranking service — out of MVP.

**Q: Why not Postgres full-text?**  
A: 50M docs + faceted aggs + 100K QPS — ES/OpenSearch purpose-built; PG OK for <1M and simple search.

---

## 14. Walkthrough: File Upload / Media Storage

**Prompt:** Design photo/video upload for social app — store, serve, generate thumbnails.

### 14.1 Requirements

**Functional**

- Upload image/video from mobile/web.
- Store durably; serve via URL (public or signed).
- Generate thumbnails / transcode video (async).
- Metadata (owner, size, mime, dimensions).

**Non-functional**

- **10M uploads/day**, max **500 MB video**, **10 MB image**.
- Upload initiation p99 **< 500 ms**; delivery via CDN.
- Durability **11 nines** (S3-class).
- Bandwidth-heavy — optimize egress cost.

**Out of scope:** Live streaming, DRM, image ML moderation (mention async).

### 14.2 Estimates

```
Uploads/day: 10M
Average image 2 MB → 20 TB/day images
Video 20% × 50 MB avg → 10M × 0.2 × 50 MB = 100 TB/day video — dominant

Peak upload QPS: 10M/86400 ≈ 115/s, peak 3× ≈ 350/s
Ingress: 350 × 50 MB ≈ 17 GB/s peak — need multipart + direct upload

Storage 1 year (with lifecycle to cold): hundreds of PB — clarify retention
CDN egress: reads ≫ uploads; 500M views/day × 2 MB ≈ 1 PB/day egress — CDN mandatory
```

### 14.3 High-level design

```
Client ──▶ API ──▶ presigned URL (S3 multipart upload)
   │                    │
   └── direct upload ──▶ S3 / GCS
                              │
                         S3 event notification
                              ▼
                         Kafka ──▶ Media Worker (thumb, transcode)
                              │
                              ▼
                         Metadata DB + CDN invalidation
```

### 14.4 API sketch

```
POST /v1/media/uploads
  Body: { "filename", "content_type", "size_bytes", "purpose": "post_attachment" }
  201: {
    "upload_id": "...",
    "media_id": "...",
    "upload_urls": [ { "part_number": 1, "url": "presigned..." } ],
    "complete_url": "/v1/media/uploads/{upload_id}/complete"
  }

POST /v1/media/uploads/{upload_id}/complete
  Body: { "parts": [{ "part_number": 1, "etag": "..." }] }

GET /v1/media/{media_id}
  200: { "status": "READY|PROCESSING|FAILED", "urls": { "original", "thumb_256", "thumb_1024" } }

GET /v1/media/{media_id}/download
  302 → signed CDN URL (TTL 1h)
```

### 14.5 Data model

```
media_objects
  id, owner_id, bucket, key, content_type, size_bytes,
  status, checksum_sha256, created_at, expires_at

upload_sessions
  upload_id, media_id, owner_id, multipart_upload_id, status

media_variants
  media_id, variant (thumb_256, h264_720p), key, width, height
```

### 14.6 Hot path deep dive: upload

```
1. Client POST /uploads with size/type — auth check quota
2. API creates media row status=PENDING, calls S3 CreateMultipartUpload
3. Return presigned URLs for parts (client uploads direct to S3 — not through API)
4. Client PUT parts to S3 in parallel (5 MB chunks)
5. Client POST /complete with etags
6. API CompleteMultipartUpload; verify size; status=PROCESSING
7. S3 event → worker generates thumbnails (images) or transcode job (video)
8. Worker updates status=READY; register CDN paths
9. Client polls or push when ready
```

**Why presigned:** Keeps API servers out of data path; scales bandwidth.

### 14.7 Scaling

- **S3** scales infinitely; partition prefix `media/{hash(media_id)[0:2]}/...` for request rate.
- **Workers:** Autoscale on Kafka lag for transcode (GPU nodes for video).
- **CDN:** CloudFront/Fastly in front of S3; cache-control long max-age for immutable media IDs.
- **Metadata DB:** Postgres sharded by owner_id.

### 14.8 Consistency choices

- Object visible only after **complete** + virus scan (optional gate).
- **Eventual** variants — UI shows placeholder until READY.
- Delete: mark deleted + lifecycle purge S3 async.

### 14.9 Failure modes & production gotchas

| Gotcha | Mitigation |
|---|---|
| Incomplete multipart uploads | Lifecycle rule abort after 7 days |
| Duplicate complete calls | Idempotent complete on upload_id |
| Hot object abuse | Rate limit; CAPTCHA; max size in presigned conditions |
| Transcode backlog | Priority queue; notify user of delay |
| Egress cost | CDN caching; WebP/AVIF; video bitrate ladder |
| Content moderation | Async scan before public CDN URL |

### 14.10 Interview Q&A — media

**Q: Resume failed upload?**  
A: ListParts S3 API; client resumes from last part; upload_id TTL.

**Q: Private photos?**  
A: Signed URLs short TTL; no public CDN; bucket private ACL.

**Q: Deduplication?**  
A: Per-user content hash — optional; global dedup saves storage but privacy concerns.

---

## 15. Walkthrough: Order Management / Inventory

**Prompt:** Design order service with inventory — place order, reserve stock, prevent overselling.

### 15.1 Requirements

**Functional**

- Add to cart (optional separate service).
- Place order: validate, reserve inventory, create order.
- Cancel order: release inventory.
- Order status lifecycle: PENDING → CONFIRMED → SHIPPED → DELIVERED.
- Query order history.

**Non-functional**

- **No overselling** — hard constraint.
- **10K orders/min** peak.
- p99 place order **< 500 ms** (excluding payment).
- Strong consistency on inventory for checkout path.

**Out of scope:** Warehouse picking, shipping carrier integration depth.

### 15.2 Estimates

```
10K orders/min ≈ 167 orders/s peak
Avg 3 line items → 500 inventory ops/s
Inventory SKUs: 10M
Order storage: 100M orders/year × 2 KB ≈ 200 GB/year

Hot SKUs (flash sale): 10K/sec decrements on one SKU — hot row problem
```

### 15.3 High-level design

```
Client ──▶ Order Service ──▶ Inventory Service
              │                      │
              │                      └──▶ Inventory DB (Postgres / Redis+PG)
              ├──▶ Payment Service
              └──▶ Kafka (OrderCreated) ──▶ Fulfillment, Analytics

Cart Service (optional) ──▶ Redis cart snapshot
```

### 15.4 API sketch

```
POST /v1/orders
  Idempotency-Key
  Body: { "items": [{ "sku_id", "quantity" }], "shipping_address_id" }
  201: { "order_id", "status": "PENDING_PAYMENT" }

POST /v1/inventory/reserve
  Body: { "reservation_id", "sku_id", "quantity", "ttl_seconds": 900 }
  200: { "status": "RESERVED" }
  409: INSUFFICIENT_STOCK

POST /v1/inventory/release
  Body: { "reservation_id" }

POST /v1/orders/{id}/confirm   (after payment webhook)

GET /v1/orders/{id}
GET /v1/orders?cursor=
```

### 15.5 Data model

```
inventory
  sku_id PK, quantity_available, quantity_reserved, version (optimistic lock)

reservations
  reservation_id PK, sku_id, quantity, order_id, expires_at, status

orders
  id, user_id, status, total_cents, idempotency_key UNIQUE, created_at

order_lines
  order_id, sku_id, quantity, price_cents
```

### 15.6 Hot path deep dive: place order

```
1. POST /orders with Idempotency-Key K
2. Idempotency lookup → return if exists
3. For each line item (parallel with care):
   a. Inventory service: atomic reserve
      UPDATE inventory
      SET quantity_available = quantity_available - :qty,
          quantity_reserved = quantity_reserved + :qty,
          version = version + 1
      WHERE sku_id = :id AND quantity_available >= :qty
      -- if rows_affected=0 → 409
   b. Insert reservation with TTL 15 min
4. Create order PENDING_PAYMENT
5. Call payment (sync, idempotent)
6. On payment success → confirm order, convert reservation to permanent decrement
7. On payment fail → release reservations
8. Publish OrderConfirmed event
```

**Alternative for hot SKU:** Redis DECR with preallocated stock counter, async sync to Postgres.

### 15.7 Inventory strategies

| Approach | Oversell risk | Hot SKU | Complexity |
|---|---|---|---|
| DB pessimistic lock | Low | Poor (serial) | Low |
| Optimistic locking (version) | Low with retry | Medium | Medium |
| Redis counter + async flush | Medium without sync | Excellent | High |
| **Reservation TTL** | Low | Good | Medium |

### 15.8 Scaling

- **Shard inventory** by `sku_id`.
- **Order service** stateless; partition orders by `order_id` / user_id.
- **Kafka** for downstream; order write path stays sync for user response.
- **Read replicas** for order history.

### 15.9 Consistency choices

- **Checkout path:** strong consistency on inventory row.
- **Analytics counts:** eventual from events.
- **Cross-service:** saga — payment fail compensates inventory release.

### 15.10 Failure modes & production gotchas

| Failure | Mitigation |
|---|---|
| Reservation leak (crash before release) | TTL job releases expired reservations |
| Double submit | Idempotency key on order |
| Split inventory across warehouses | Separate inventory rows per warehouse |
| Phantom stock (cache stale) | Never cache inventory for checkout — always primary |
| Partial item availability | All-or-nothing order or partial ship — clarify product |

### 15.11 Interview Q&A — orders/inventory

**Q: Flash sale 100K units, 1M buyers?**  
A: Queue users; sell through token; Redis pre-decrement; waitlist; shard counter.

**Q: Distributed transaction 2PC?**  
A: Avoid 2PC; use saga + outbox + idempotent consumers.

**Q: Eventual inventory sync from warehouses?**  
A: WMS publishes adjustments; reconcile discrepancies nightly; safety stock buffer.

---

## 16. General Interview Playbook

### Pre-interview mental checklist

Before any prompt, load this sequence into working memory:

1. **Clarify** users, scale, read/write, latency, consistency, scope cuts.
2. **Estimate** QPS (peak), storage/year, bandwidth if media-heavy.
3. **Draw** client → edge → gateway → services → data stores.
4. **Define** API + data model for core entities.
5. **Trace** one hot path with latency budget.
6. **Deep dive** where interviewer points — usually hardest constraint.
7. **Failures** — 2–3 concrete scenarios.
8. **Evolve** — "At 10× we'd add …"

### The "RCA" framework for deep dives

When stuck, use **Requirements → Constraints → Architecture**:

| Step | Question |
|---|---|
| R | What must the system guarantee? (correctness, freshness, durability) |
| C | What limits us? (QPS, p99, budget, team size) |
| A | What structure satisfies R within C? |

### Staff-level signals

| Signal | Example phrase |
|---|---|
| Scope discipline | "I'll defer multi-region active-active unless we need 99.99 global" |
| Quantitative | "Peak 12K QPS → 10 pods at 2K RPS each with 60% util" |
| Operational | "On Redis failover we'd see 30s of elevated latency — acceptable for this tier" |
| Product-aware | "Custom alias URLs need abuse review — async scan pipeline" |
| Evolution | "V1 Postgres + Redis; V2 split read model if search QPS exceeds 20K" |

### Common interviewer redirects

| Redirect | How to respond |
|---|---|
| "Go deeper on database" | Sharding key, indexes, replication, failover |
| "What if X is down?" | Degrade path, circuit breaker, queue backlog |
| "Half the budget" | Cut ES replicas, shorter retention, batch notifications |
| "10× traffic tomorrow" | Pre-warm cache, scale stateless tier, identify first bottleneck |
| "Security?" | AuthN/Z, encryption, audit, rate limit, input validation |

### Whiteboard pacing recovery

**Running long (30 min in, no diagram):**  
Stop talking — draw three boxes: API, DB, Cache. Fill in.

**Running short (35 min, done early):**  
Offer: multi-region, observability, cost analysis, migration from monolith.

**Lost on scale:**  
Round numbers aggressively: "100M users, 10% DAU active, 10 actions/day → 100M × 0.1 × 10 / 86400 ≈ 1200 QPS."

### Production debugging tie-in (shows seniority)

After design, add one line:

> "In production I'd alert on p99 redirect latency, Redis hit ratio < 95%, and fan-out consumer lag > 60s."

Interviewers at product companies love **operational closure**.

---

## 17. Quick Decision Matrix

### Storage selection

| Need | Choose | Avoid |
|---|---|---|
| ACID transactions, joins | Postgres | Mongo for money |
| Session, cache, rate limit | Redis | Postgres row polling |
| Full-text + facets | Elasticsearch | LIKE '%foo%' at scale |
| Blob / media | S3 + CDN | DB BLOB columns |
| Time-series metrics | Prometheus / TSDB | Postgres unpartitioned |
| Event log, stream | Kafka | Cron polling DB |
| Analytics warehouse | BigQuery / Snowflake | Same OLTP DB |

### Communication pattern

| Pattern | Use | Pitfall |
|---|---|---|
| Sync HTTP/gRPC | Query needing immediate answer | Retry storms, coupling |
| Async queue | Side effects, peak smoothing | Duplicate processing |
| CDC | Search index sync | Schema change coordination |
| Webhook | External provider callbacks | Signature verify, idempotency |
| SSE / WebSocket | Real-time push to client | Connection scale on servers |

### Caching strategy

| Strategy | When | Invalidation |
|---|---|---|
| Cache-aside | Read-heavy, tolerable stale | TTL + delete on write |
| Write-through | Must not serve stale after write | Automatic on write |
| CDN edge | Static + public GET | Short TTL or versioned URLs |
| Application local | Extreme hot keys | Short TTL; accept inconsistency |

### Consistency spectrum

| Level | Mechanism | Example |
|---|---|---|
| Strong | Single leader, sync replicate | Inventory checkout |
| Read-your-writes | Sticky session or primary read | Profile update |
| Eventual | Async replicate, cache TTL | Feed fan-out |
| Causal | Version vectors (rare in interviews) | Collaborative edit |

### ID generation

| Method | Pros | Cons |
|---|---|---|
| UUID v4 | No coordinator | Random index inserts |
| Snowflake | Sortable, dense | Infra for worker IDs |
| DB sequence | Simple | Shard bottleneck |
| Natural key | Dedup free | Domain coupling |

### Partition / shard key

| Entity | Good key | Why |
|---|---|---|
| User data | user_id | Co-locate user rows |
| Orders | order_id or user_id | Query by user list |
| Time-series logs | date + hash | Partition pruning |
| Multi-tenant SaaS | tenant_id | Isolation |

### Rate limiting placement

| Layer | Stops | Limitation |
|---|---|---|
| CDN / WAF | DDoS, geo | Coarse |
| API Gateway | Per-key, per-route | Central bottleneck |
| Service | Fine-grained business rules | Per-service config drift |
| Resource (DB) | Connection storms | Last line of defense |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. How do you handle idempotency for POST requests?</summary>

Store `Idempotency-Key` + request hash + response body in Postgres or Redis with TTL 24–72h. On duplicate key, return stored response with same status code. Key must include **tenant/user scope** to prevent cross-user collision. PSP and mobile clients retry aggressively — server-side dedup is non-negotiable for payments and orders.

</details>

<details class="qa-item">
<summary>2. CAP theorem — how do you actually use it in interviews?</summary>

Don't recite the proof. State: "Under network partition, we choose **consistency** for inventory/payments (refuse stale writes) or **availability** for feeds (serve cached timeline)." Pick based on business cost of each failure mode. Most user-facing read paths choose AP with bounded staleness.

</details>

<details class="qa-item">
<summary>3. How would you design for multi-region active-active?</summary>

Split writes by **user home region** (geo-DNS route); async cross-region replication for read elsewhere. Conflict resolution: last-write-wins for profile; **avoid** active-active on same inventory row without CRDT or regional stock pools. Mention CRDB/Spanner for global SQL if budget allows. Most designs: active-passive DR with RPO/RTO targets.

</details>

<details class="qa-item">
<summary>4. What's your approach to database sharding?</summary>

Identify **dominant access pattern** → choose shard key with high cardinality → embed shard id in primary key → use consistent hashing or directory service for routing → plan **resharding** (double-write migration) before you need it. Avoid cross-shard joins; denormalize or aggregate via async jobs.

</details>

<details class="qa-item">
<summary>5. How do you prevent cascading failures?</summary>

Timeouts on every outbound call ( shorter than client timeout ), circuit breakers, bulkheads (separate thread pools), retry with jitter (max 2–3), load shed at gateway (429), cache fallback for read degradation. **Never** retry non-idempotent POST without idempotency key.

</details>

<details class="qa-item">
<summary>6. Explain exactly-once vs at-least-once vs at-most-once.</summary>

**At-most-once:** fire and forget — may lose messages. **At-least-once:** retry until ack — duplicates possible; consumers must dedup. **Exactly-once:** end-to-end is hard; achieve **effective once** via idempotent consumers + transactional outbox + dedup store. Kafka exactly-once within cluster ≠ exactly-once to external email provider.

</details>

<details class="qa-item">
<summary>7. How do you design a unique ID generator at scale?</summary>

Snowflake: timestamp + datacenter + worker + sequence → 64-bit sortable ID. Requires worker ID coordination (ZooKeeper, K8s pod index). Alternative: UUID v7 (time-ordered). DB sequences bottleneck at shard scale. Pre-allocated ranges per service instance for insert-heavy paths.

</details>

<details class="qa-item">
<summary>8. Cache stampede / thundering herd — mitigation?</summary>

Probabilistic early expiration, request coalescing (single-flight), mutex per hot key, pre-warm on deploy, stale-while-revalidate. For viral content, push to CDN edge; local in-process cache in front of Redis.

</details>

<details class="qa-item">
<summary>9. How do you sync search index with database?</summary>

Transactional **outbox** in same TX as product update → relay publishes to Kafka → indexer bulk upserts ES. Debezium CDC alternative. Never dual-write to Postgres and ES in application without outbox — drift guaranteed. Nightly reconciliation job compares counts and samples.

</details>

<details class="qa-item">
<summary>10. Design a leaderboard (top 10 scores).</summary>

Redis **sorted set** `ZADD leaderboard score user_id`; `ZREVRANGE 0 9` O(log N). For global scale, shard leaderboard by game/season. For write-heavy: batch score updates in memory, flush periodically if slight lag OK. Archive to Postgres for history.

</details>

<details class="qa-item">
<summary>11. How do you handle hot keys in Redis?</summary>

Local L1 cache on app servers, read replicas for Redis (Redis Enterprise), split key into `key:part-{0..N}` with random read, or move counter to dedicated shard. Monitor `redis hot keys` / latency per command.

</details>

<details class="qa-item">
<summary>12. WebSocket vs polling vs SSE for real-time?</summary>

**WebSocket:** bidirectional, chat, gaming — connection state expensive at millions. **SSE:** server push one-way, simpler through HTTP proxies. **Polling:** fallback; use long polling sparingly. At scale: WebSocket gateway cluster with sticky sessions or pub/sub backplane (Redis/Kafka).

</details>

<details class="qa-item">
<summary>13. How do you design audit logging for compliance?</summary>

Append-only **audit table** or immutable log stream (Kafka → S3/Glacier). Capture who, what, when, before/after snapshot, request_id. WORM storage for retention. Separate from application debug logs; PII redaction pipeline.

</details>

<details class="qa-item">
<summary>14. Schema migration without downtime?</summary>

Expand-contract pattern: add nullable column → dual-write → backfill job → switch reads → remove old. For renames, use views or compatibility layer. Never blocking `ALTER` on huge table in peak — use online schema change tools (gh-ost, pg_repack).

</details>

<details class="qa-item">
<summary>15. How do you estimate cost in system design?</summary>

Compute: `(pods × $/pod/month) + (DB instance) + (Redis) + (Kafka) + (S3 storage + egress) + (ES data nodes)`. Egress often dominates media. Mention **reserved capacity** vs on-demand. One sentence: "Video egress at 1 PB/day is the cost driver — CDN cache hit ratio is a finance metric."

</details>

<details class="qa-item">
<summary>16. Monolith vs microservices for MVP?</summary>

**Monolith modular** (clear package boundaries) until team > ~8–10 engineers or deploy cadence blocked. Split on **scaling** or **ownership** boundaries first (payments, media processing). Interview answer: "I'd start modular monolith + Postgres + Redis; extract notification worker first because it's async and independently scalable."

</details>

<details class="qa-item">
<summary>17. How do you design graceful degradation?</summary>

Define tiers: core (checkout), enhanced (recommendations), cosmetic (view counts). Under load, disable enhanced first via feature flag. Return cached/default for non-critical data. Queue writes if DB slow (careful with user-visible delay). Communicate degraded mode in status page.

</details>

<details class="qa-item">
<summary>18. Distributed lock — when and how?</summary>

Use sparingly — prefer **atomic DB update** or idempotent consumer. When needed: Redis Redlock with TTL + fencing token, or Postgres advisory lock. Always set TTL to prevent dead lock holder. Locks don't replace correct transaction boundaries.

</details>

<details class="qa-item">
<summary>19. How do you test a system design?</summary>

Load test hot path (k6, Gatling); chaos on Redis/DB failover; idempotency replay tests; contract tests between services; game days for regional failover. Mention **synthetic canaries** in prod. Interview: "Before launch, I'd load test 2× peak with gradual ramp and validate p99 and error budget."

</details>

<details class="qa-item">
<summary>20. What metrics and alerts would you define day one?</summary>

**Four golden signals:** latency (p50/p99), traffic, errors, saturation (pool, CPU, queue lag). SLO-based alerts on burn rate. Business metrics: orders/min, payment success rate, fan-out lag. Avoid alert fatigue — page on user impact, ticket on capacity planning thresholds.

</details>

---

## Appendix A: Latency Budget Template

Copy to whiteboard for any user-facing read:

```
Total p99 budget:     300 ms
├─ Edge / CDN:         30 ms
├─ Gateway + auth:     20 ms
├─ App logic:          30 ms
├─ Cache (if hit):      5 ms
├─ DB / downstream:    80 ms  (parallel, not sequential)
└─ Serialization:      15 ms
Buffer:                120 ms
```

If sequential downstream calls exceed budget → **parallelize**, **cache**, or **precompute**.

---

## Appendix B: Back-of-Envelope Cheat Sheet

```
QPS        = daily_actions / 86400 × peak_factor(2-3)
Storage    = records × bytes × replication × index_overhead(1.5-2×)
Bandwidth  = QPS × payload_size
Pods       = peak_QPS / (RPS_per_pod × utilization)
Redis mem  = keys × (key_size + value_size + overhead)
ES shards  = index_size_GB / 30 GB per shard (rule of thumb)
Kafka      = partitions ≥ max consumer parallelism; order per key
```

---

## Appendix C: Interview Day Checklist

- [ ] Restate problem in own words
- [ ] Ask 5+ clarifying questions
- [ ] Write FR + NFR with numbers
- [ ] Capacity estimates (QPS, storage)
- [ ] Component diagram labeled
- [ ] API + data model sketched
- [ ] Hot path numbered steps
- [ ] One deep dive (interviewer choice)
- [ ] 2+ failure modes + mitigations
- [ ] Explicit tradeoff sentence
- [ ] Scope cut / future work mentioned

---

## Appendix D: System-Specific Clarification Quick Reference

| System | Scale question | Consistency question | Must-not-miss |
|---|---|---|---|
| URL shortener | Read:write ratio? | 301 cache OK? | Cache + analytics async |
| Payment | PSP or in-house? | Strong on ledger | Idempotency-Key |
| Notifications | Transactional vs marketing? | Dedup window | Queue + provider limits |
| Feed | Celebrity followers? | Stale timeline OK? | Hybrid fan-out |
| Rate limiter | Strict or approximate? | Fail open/closed? | Atomic Redis Lua |
| Search | Index lag tolerance? | Stock in index? | Outbox/CDC to ES |
| Media | Max file size? | Public vs private? | Presigned direct upload |
| Orders | Oversell allowed? | Reservation TTL? | Atomic inventory + saga |

---

## Appendix E: Evolution Paths (V1 → V3)

Narrate maturity in interviews — shows you've shipped, not only whiteboarded.

### URL shortener

| Version | Architecture | Trigger to evolve |
|---|---|---|
| V1 | Monolith + Postgres + Redis cache | >5K read QPS |
| V2 | Separate redirect service, read replicas | >50K read QPS |
| V3 | Edge KV redirect, dedicated analytics pipeline | Global latency SLO |

### Payment

| Version | Architecture | Trigger |
|---|---|---|
| V1 | Modular monolith, Stripe, idempotency table | Compliance audit |
| V2 | Payment service + ledger + outbox | Multi-PSP, multi-currency |
| V3 | Event-sourced ledger, reconciliation batch jobs | Finance close automation |

### Feed

| Version | Architecture | Trigger |
|---|---|---|
| V1 | Pull-only timeline | <1M DAU |
| V2 | Hybrid push/pull + Redis | Latency SLO miss |
| V3 | Ranking layer + feature store | Engagement product requirements |

---

## Appendix F: Common Interviewer Traps

| Trap | Wrong answer | Strong answer |
|---|---|---|
| "Use microservices" | 15 services day one | Modular monolith until boundary clear |
| "Use NoSQL for scale" | Mongo for payments | Postgres until proven bottleneck |
| "Kafka everywhere" | Sync read through queue | Kafka for async side effects only |
| "100% cache" | Cache inventory counts | Never cache authoritative stock on checkout |
| "Strong consistency globally" | Sync replicate all regions | Scope strong consistency to checkout shard |
| "UUID for everything" | v4 for time-series | Snowflake/UUIDv7 for sortable feeds |

---

## Appendix G: Sample Opening (60 seconds)

Use this verbatim structure, replace specifics:

> "I'll design a **URL shortener** for **100M links/month** and **10B redirects/month**. Users create short links and get HTTP redirects — I'll assume **read-heavy 100:1**, **p99 redirect under 100ms**, **single region** for now. Out of scope: user accounts and link editing unless you want those.
>
> I'll start with capacity estimates, then draw the redirect and create paths, deep dive the read path with caching, and cover failure modes. Sound good?"

Pause for confirmation — interviewers appreciate the checkpoint.

---

## Appendix H: Deep Dive Menu (when interviewer says "go deeper")

Pick the row matching your system; offer 2 options:

| System | Deep dive A | Deep dive B |
|---|---|---|
| URL shortener | Code generation + collision | Analytics pipeline |
| Payment | Idempotency + webhook race | Saga compensation |
| Notifications | Priority queues + provider failover | Template + preference model |
| Feed | Hybrid fan-out threshold | Celebrity read merge |
| Rate limiter | Token bucket Lua atomicity | Global vs regional limits |
| Search | Index mapping + sharding | Zero-downtime reindex |
| Media | Multipart presigned flow | Transcode worker pool |
| Orders | Reservation TTL + leak cleanup | Flash sale counter shard |

---

*End of document — senior system design interview reference.*
