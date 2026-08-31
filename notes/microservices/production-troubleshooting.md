# Microservices Production Troubleshooting — Senior Production Reference

Spring Boot 3.x / Kubernetes 1.28+ / OpenTelemetry / Prometheus / incident.io / PagerDuty patterns. Servlet and reactive stacks are both covered; differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping microservices, multi-tenant SaaS, and globally distributed backends where "we'll check the logs" still means ninety minutes of grep across forty namespaces while the CFO asks why EU customers cannot pay.

---

## Table of Contents

1. [Mental Model: One Incident Through the Troubleshooting Stack](#1-mental-model-one-incident-through-the-troubleshooting-stack)
2. [Production Debugging Fundamentals](#2-production-debugging-fundamentals)
3. [Safe Production Investigation Techniques](#3-safe-production-investigation-techniques)
4. [Distributed Debugging](#4-distributed-debugging)
5. [Correlation, Traces, and Cross-Service Forensics](#5-correlation-traces-and-cross-service-forensics)
6. [Incident Management](#6-incident-management)
7. [Incident Roles, Severity, and Communication](#7-incident-roles-severity-and-communication)
8. [Root Cause Analysis (RCA)](#8-root-cause-analysis-rca)
9. [Postmortems and Learning from Incidents](#9-postmortems-and-learning-from-incidents)
10. [Performance Bottlenecks — Mental Model](#10-performance-bottlenecks-mental-model)
11. [CPU, Memory, and JVM Production Debugging](#11-cpu-memory-and-jvm-production-debugging)
12. [Database and Query Performance in Production](#12-database-and-query-performance-in-production)
13. [Network, Latency, and Dependency Bottlenecks](#13-network-latency-and-dependency-bottlenecks)
14. [Caching, Queues, and Async Path Debugging](#14-caching-queues-and-async-path-debugging)
15. [Production Troubleshooting Patterns](#15-production-troubleshooting-patterns)
16. [Kubernetes and Platform-Layer Debugging](#16-kubernetes-and-platform-layer-debugging)
17. [Multi-Tenancy in Production](#17-multi-tenancy-in-production)
18. [Multi-Tenant Failure Modes and Isolation](#18-multi-tenant-failure-modes-and-isolation)
19. [Data Residency and Regulatory Troubleshooting](#19-data-residency-and-regulatory-troubleshooting)
20. [Cross-Border Data and Geo-Routing Incidents](#20-cross-border-data-and-geo-routing-incidents)
21. [Spring Boot 3 Production Troubleshooting Integration](#21-spring-boot-3-production-troubleshooting-integration)
22. [Production Debugging Playbook](#22-production-debugging-playbook)
23. [Quick Decision Matrix](#23-quick-decision-matrix)
24. [Interview Q&A](#24-interview-qa)

---

## 1. Mental Model: One Incident Through the Troubleshooting Stack

Production troubleshooting is not "open Grafana and guess." It is a **disciplined pipeline** that moves from **user-visible symptoms** → **scoped blast radius** → **hypothesis** → **evidence** → **mitigation** → **root cause** → **preventive action**, while incident management keeps customers informed and engineers from tripping over each other.

```
User / customer symptom ("checkout broken", "slow reports", "wrong data")
  └─ Edge signal (synthetic probe, support tickets, status page trigger)
       ├─ SLO / error budget burn — is this a real outage or noise?
       └─ Golden signals at boundary (LB, CDN, API gateway)
            └─ Service entry point (first RED anomaly)
                 ├─ Logs: correlation_id / trace_id / business error code
                 ├─ Traces: longest span, dependency, retry storm
                 ├─ Metrics: RED inbound + outbound, USE on pools
                 └─ Hypothesis tree
                      ├─ Recent change? (deploy, flag, cert, DNS, scale)
                      ├─ Dependency? (payment, DB, cache, broker)
                      ├─ Tenant / region scoped? (multi-tenancy, residency)
                      └─ Resource saturation? (GC, pool, disk, lag)
                           └─ Mitigation (rollback, scale, circuit, shed load)
                                └─ RCA + postmortem + action items
```

Three objects you must keep distinct:

| Object | Question it answers | Typical production artifact |
|---|---|---|
| **Symptom** | What are users experiencing? | "5xx on checkout", "p99 8s in EU", "tenant A sees tenant B data" |
| **Root cause** | What single change or failure enabled the incident? | "Missing tenant predicate in SQL after refactor" |
| **Contributing factor** | What made impact worse or detection slower? | "No SLO on checkout", "TRACE left on", "retry storm" |

A **503 from order-api** may mean payment is down, HikariCP is exhausted, a circuit is open, you are load-shedding, or the pod is not Ready — mixing those up is the single most common senior misdiagnosis. A **slow dashboard** may be CPU, a missing index, N+1 queries, cache stampede, or a cross-region hop — the latency histogram alone does not tell you which.

### The troubleshooting time hierarchy

```
T0  User impact starts (may be minutes before you know)
T1  Alert fires OR support spike OR synthetic failure
T2  Incident declared, IC assigned, comms channel opened
T3  Blast radius scoped (region, tenant, feature, % users)
T4  Mitigation deployed (rollback, scale, disable feature)
T5  User impact ends (verify with SLI, not pod Ready)
T6  Root cause identified
T7  Postmortem published, action items tracked
```

**Mean Time to Detect (MTTD)** and **Mean Time to Mitigate (MTTM)** matter more than Mean Time to Root Cause during the fire. You can find the exact bad commit after customers can pay again.

### Production scenario: "Everything is red but users are fine"

**Problem.** On-call wakes to 200+ PagerDuty alerts: pod restarts, CPU warnings, ERROR log spikes. Customer support reports nothing. SLO dashboards green. Team spends two hours chasing kube events.

**Cause.** Alerting on **infrastructure symptoms** without **user SLI** correlation. A node drain caused pod churn; apps recovered; log level DEBUG in one service logged every health check as ERROR; inhibitions not configured — node alert spawned 40 pod alerts.

**Solution.**

1. Page on **SLO burn** and **synthetic business checks** first.
2. Configure alert **inhibition**: node NotReady suppresses pod alerts on that node.
3. Separate **warning** (ticket) from **critical** (page).
4. Incident commander asks "who is affected?" before "why is CPU 60%?"

Rules that save incidents:

- Mitigate before you understand — rollback a bad deploy in five minutes beats perfect RCA in two hours with customers down.
- Scope before you deep-dive — "EU only" vs "all regions" changes the entire hypothesis tree.
- One writer on the status page, one incident commander, one person driving technical investigation.
- If you cannot link symptom to trace to log in under 60 seconds, your observability is decorative — fix that before the next incident.

---

## 2. Production Debugging Fundamentals

### Core concept

**Production debugging** is investigating live system behavior under real traffic, real data, and real constraints — without turning production into a lab. It differs from development debugging: you cannot restart freely, you cannot attach a debugger on every pod, you cannot log PII for convenience, and every diagnostic action has blast radius.

Goals in order:

1. **Stop or reduce user harm** (mitigation).
2. **Understand scope** (who, where, what feature).
3. **Identify cause** (technical root + contributing factors).
4. **Prevent recurrence** (code, config, process, observability).

### Internal working — signal layers

```
Layer 0: Business / user SLI     checkout success rate, login latency p99
Layer 1: Edge / synthetic      probe from eu-west, RUM Core Web Vitals
Layer 2: Service RED             rate, errors, duration per service
Layer 3: Dependency RED          outbound client metrics, broker lag
Layer 4: Resource USE            pools, CPU throttle, disk, network
Layer 5: Process internals       JVM GC, thread dumps, heap (last resort)
Layer 6: Code / config diff      deploy correlation, feature flags, git blame
```

Start at Layer 0–2. Jumping to heap dumps before checking "did we deploy?" is how seniors waste the first thirty minutes.

### Production scenario: on-call opens logs first

**Problem.** Checkout fails intermittently. Engineer tails `kubectl logs` on a random `order-api` pod. Sees nothing. Tries another pod. Finds a stack trace from a different customer's request. Concludes "flaky network."

**Cause.** No correlation ID from support ticket. Random pod sampling. Unstructured logs. Intermittent failure needs **trace** or **metric aggregation**, not one log line.

**Solution.**

```bash
# Support ticket has X-Correlation-Id: ord-7f3a2b
kubectl logs -l app=order-api --since=2h | jq 'select(.correlation_id=="ord-7f3a2b")'

# Or in OpenSearch/Loki
correlation_id:"ord-7f3a2b" AND level:error
```

Then open trace by `trace_id` from that log line. Check `payment-api` outbound RED for same window.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No correlation ID at edge | Cannot tie support ticket to logs |
| DEBUG logging in prod at volume | Log pipeline lag; missed ERROR lines; cost spike |
| Alert on log pattern "Exception" | Pages on handled business exceptions |
| Single global log level | Cannot enable DEBUG on one canary without fleet change |
| Health check hits DB every 10s | DB load; slow readiness; false "dependency down" |
| `management.endpoints.web.exposure.include=*` on prod | Actuator env leaks secrets; accidental heapdump |

### Debugging scenario

**Observe.** `order-api` 5xx rate 2% up from 0.1%. Started ~14:02. No deploy to `order-api`.

**Diagnose.**

1. Check deploy/flag timeline for **all** dependencies (`payment-api`, DB migration, gateway).
2. RED on `order-api` — errors on which route? `POST /api/orders` only?
3. Exemplar trace on 5xx — span name `payment.authorize` timeout?
4. `payment-api` deploy at 14:00 — new timeout config?

**Fix.** Rollback `payment-api` or increase client timeout temporarily; root cause in RCA — default read timeout 1s on new HTTP client bean.

### Read-only investigation patterns

| Technique | Risk | When to use |
|---|---|---|
| Metrics / traces / logs query | Low | Always first |
| `kubectl logs`, `describe pod` | Low | K8s forensics |
| Actuator `/health`, `/metrics` | Low | Scoped exposure |
| Thread dump via Actuator | Medium | CPU spin, deadlock suspicion |
| Heap dump via Actuator | High | OOM, memory leak confirmation |
| Remote debug (JDWP) | **Critical** | Almost never — staging only |
| SQL on read replica | Low | Query plan, row counts |
| SQL on primary (heavy) | High | Avoid — use replica or EXPLAIN only |
| Dynamic log level change | Medium | One canary pod, time-bounded |
| Traffic shadow / capture | Medium | Replay in staging |

Never enable JDWP on production. A paused breakpoint holds threads; one debugger attachment can stall a pool and take down the service.

---

## 3. Safe Production Investigation Techniques

### Core concept

**Safe production investigation** means every diagnostic action is reversible, scoped, and audited. The incident is bad enough without the mitigation causing a second outage.

### Canary and targeted observability

```yaml
# Spring Boot — dynamic log level via Actuator (secure endpoint)
# POST /actuator/loggers/com.example.payment with {"configuredLevel": "DEBUG"}
# ONLY on canary deployment or single pod via label selector

logging:
  level:
    root: INFO
    com.example.payment: INFO  # default prod
```

Pattern: **1% canary** or **single "debug" pod** with:

- Higher trace sampling (`otel.traces.sampler=parentbased_traceidratio` with 1.0 on canary).
- DEBUG for one package.
- Extended metrics labels (never high-cardinality on full fleet).

Revert via GitOps or actuator within 24 hours — debug pods become permanent debt.

### Feature flags as circuit breakers

```java
if (featureFlags.isEnabled("checkout.use-new-payment-rail", tenantId)) {
    return newRail.pay(order);
}
return legacyRail.pay(order);
```

During incident: disable flag globally or per tenant **before** rollback if deploy is large. Flags must be **off by default** for risky paths; kill switch tested quarterly.

### Production data access

| Access type | Control |
|---|---|
| Support view of user data | Masked UI, audit log, ticket ID |
| DB read for incident | Read replica, time-bounded credential, IC approval |
| Log search with PII | Restricted role, no export to Slack |
| Heap dump | Encrypted storage, delete after 7 days, no customer objects in ticket |

### Production scenario: engineer runs EXPLAIN on primary during peak

**Problem.** Reports slow. DBA runs `EXPLAIN ANALYZE` on heavy report query on **primary** at 15:00 peak. Locks accumulate. Checkout latency spikes. Second incident.

**Cause.** Investigation on write path without blast-radius analysis.

**Solution.** Route analytics to **read replica** or **OLAP** (ClickHouse, BigQuery). `EXPLAIN` without `ANALYZE` on primary if needed. Schedule heavy diagnostics off-peak. Runbook line: "Never ANALYZE on primary during business hours."

### Time synchronization

Distributed debugging requires clocks within ~100ms. If logs and metrics disagree on event order by minutes:

```bash
chronyc tracking   # on node
```

Symptom: "payment failed before order created" in merged timeline — often clock skew, not logic bug.

---

## 4. Distributed Debugging

### Core concept

**Distributed debugging** is finding why a **user journey** failed when ownership is split across services, queues, caches, and regions. No single stack trace explains checkout — you need **correlation**, **partial failure semantics**, and **consistency models**.

```
Browser → CDN → API Gateway → order-api → Kafka → inventory-worker → postgres
                ↓                      ↓
            auth-service            payment-api → Stripe
```

Failure can occur at any hop; the **first error logged** is often not the **root cause** (e.g. inventory retry masks payment timeout).

### Partial failure modes

| Pattern | User experience | Debugging hint |
|---|---|---|
| **Fail fast** | Immediate 5xx | Clear error in entry service trace |
| **Timeout cascade** | Slow then fail | Deep span tree, retries multiply latency |
| **Silent degradation** | Wrong/missing data | No error metric; compare cache vs source |
| **Split brain** | Intermittent wrong state | Two regions, stale cache, no vector clock |
| **Poison message** | One queue stuck | Single partition lag, one consumer crash loop |
| **Thundering herd** | Recovery spike crash | Metrics spike after dependency recovery |

### Eventual consistency debugging

**Problem.** User sees "payment succeeded" but order status "pending" for 30 seconds.

**Not a bug if** SLA is async completion < 60s. **Bug if** payment event lost or consumer lag infinite.

Debug path:

1. Find `payment.completed` event in outbox/Kafka by `correlation_id`.
2. Check consumer lag metric for `order-status-updater`.
3. Trace consumer span — processing exception?
4. Idempotency key collision? Duplicate event dropped?

```sql
-- Outbox / event store forensics (read replica)
SELECT * FROM outbox_events
WHERE correlation_id = 'ord-7f3a2b'
ORDER BY created_at;
```

### CAP and production reality

During partition (network split between EU and US):

- **CP** systems may reject writes — users see errors; check quorum, leader election logs.
- **AP** systems may serve stale reads — users see old data; check replication lag, read-your-writes routing.

Document per dependency which failure mode you chose. Debugging "wrong balance" during partition starts with "are we AP on reads?"

### Production scenario: "only mobile clients fail"

**Problem.** Web checkout works; iOS fails. No server 5xx spike.

**Cause.** Mobile calls `api.example.com`; web uses same-origin BFF. Mobile token missing new scope after auth deploy. Server returns 403; mobile treats as network error.

**Debug.** Compare trace samples web vs mobile — `Authorization` header, path (`/v2/orders` vs `/v1/orders`), TLS cipher (old Android). RUM SDK shows client-side failure.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| Different trace header per service | Broken trace tree at first hop |
| Sync call chain 6+ deep | Any slow dependency blows p99 |
| No idempotency on consumer | Duplicate side effects after retry |
| Global retry without budget | Retry storm on recovery |
| Missing dead-letter queue | Silent message loss |

---

## 5. Correlation, Traces, and Cross-Service Forensics

### Core concept

Cross-service forensics links **one business identifier** across all telemetry. Minimum contract:

| ID | Scope | Propagation |
|---|---|---|
| `trace_id` | Telemetry trace | W3C `traceparent` |
| `span_id` | Single operation | Automatic in OTel |
| `correlation_id` | Business / support | `X-Correlation-Id` from edge |
| `tenant_id` | Multi-tenant scope | JWT claim + MDC (careful in metrics) |

```java
// Servlet filter — edge or first service
String correlationId = request.getHeader("X-Correlation-Id");
if (correlationId == null || correlationId.isBlank()) {
    correlationId = "gen-" + UUID.randomUUID();
}
MDC.put("correlation_id", correlationId);
response.setHeader("X-Correlation-Id", correlationId);
```

### Trace-guided debugging workflow

1. SLO dashboard shows checkout latency p99 breach.
2. Click exemplar on histogram → trace `abc123`.
3. Longest span: `jdbc.query` 4.2s in `inventory-api`.
4. Jump to logs: `trace_id=abc123` → `slow query` log with sanitized `query_hash`.
5. Check deploy: new index dropped? `pg_stat_statements` on replica.

### Message queue forensics

Kafka record headers must carry trace context:

```java
// Producer
Context context = Context.current();
kafkaTemplate.send(record, null, ProducerRecord.withContext(context));

// Consumer — child span
try (Scope scope = context.makeCurrent()) {
    Span span = tracer.spanBuilder("process-order-event").startSpan();
    // ...
}
```

Lag without errors: consumer too slow. Lag with consumer restarts: poison message. No lag but wrong outcomes: **consumer logic** or **ordering** issue.

### Production scenario: trace stops at gateway

**Problem.** Traces show gateway span only. Downstream services missing.

**Cause.** Gateway strips `traceparent` or starts new trace. Istio/Envoy misconfig: `forward_client_trace` false.

**Fix.** Ingress annotation / mesh Telemetry API. Verify with `curl -H 'traceparent: 00-...'` and check downstream span parent.

---

## 6. Incident Management

### Core concept

**Incident management** is the organizational process for coordinating response, communication, and recovery when user-impacting failure exceeds normal on-call triage. Technical debugging happens **inside** an incident structure — without it, five engineers rollback three different things simultaneously.

### Incident lifecycle

```
Detect → Triage → Declare → Respond → Mitigate → Resolve → Follow-up
```

| Phase | Output |
|---|---|
| Detect | Alert, ticket cluster, synthetic failure |
| Triage | "Is this an incident?" vs flaky test |
| Declare | Severity, IC assigned, channel created |
| Respond | Scoped investigation, parallel workstreams |
| Mitigate | User impact reduced (not necessarily root cause found) |
| Resolve | SLI restored, monitoring stable |
| Follow-up | Postmortem, action items in tracker |

### Severity matrix (example)

| Severity | User impact | Response |
|---|---|---|
| **SEV1** | Critical path down or data breach | All-hands, exec comms, status page, war room |
| **SEV2** | Major degradation or partial outage | IC + on-call + domain owners, status page |
| **SEV3** | Minor feature broken, workaround exists | On-call, ticket, no status page |
| **SEV4** | Internal / low traffic | Next business day |

Define **critical path** per product: checkout, login, payroll, patient records — not "admin reporting slow."

### Production scenario: no incident declared for 45 minutes

**Problem.** Checkout error rate 15%. Engineers fix individually in Slack threads. Marketing posts on social. CEO asks status. No single owner.

**Cause.** No clear threshold for "declare incident." On-call thought "payment team will handle it."

**Fix.** Automate: SLO fast burn → PagerDuty incident **with IC rotation**. Runbook: "Checkout SLO burn > 10x → declare SEV2 minimum."

### Tools (patterns, not vendor lock-in)

| Function | Examples |
|---|---|
| Paging | PagerDuty, Opsgenie |
| Incident channel | Slack `#inc-2026-08-31-checkout`, Zoom war room |
| Status page | Atlassian Statuspage, incident.io |
| Timeline | Google Doc, incident.io timeline, `#inc` pins |
| Action tracking | Jira, Linear, GitHub Issues |

---

## 7. Incident Roles, Severity, and Communication

### Core roles

| Role | Responsibility | Anti-pattern |
|---|---|---|
| **Incident Commander (IC)** | Prioritize, assign, decide rollback vs fix-forward | IC also deep-diving logs |
| **Technical Lead (TL)** | Drive hypothesis tree, coordinate engineers | TL updates status page |
| **Communications Lead** | Status page, support macros, exec updates | Comms guesses technical ETA |
| **Scribe** | Timeline: what happened when | No timeline in postmortem |
| **Domain experts** | Payment, DB, K8s — on demand | Everyone in war room unmuted |

IC phrase: "We are mitigating via rollback. TL continues RCA on branch. Comms: user impact is EU checkout, not login."

### Communication templates

**Internal (every 30 min during SEV1/2):**

```
INC-123 | SEV2 | IC: @ada | TL: @bob
Impact: EU checkout ~30% failure rate since 14:02 UTC
Mitigation: payment-api rollback in progress (ETA 5 min)
Next update: 14:45 UTC
Customer comms: status page "degraded checkout EU"
```

**External status page:**

```
Investigating: Some customers in Europe may experience errors completing checkout.
Next update in 30 minutes or upon significant change.
```

Never: "We are investigating high CPU." Users do not care about CPU.

### Production scenario: premature "resolved"

**Problem.** Team marks incident resolved after deploy. Error rate drops to 1% (still 10x normal). Support tickets continue.

**Cause.** Resolved tied to **deploy finished** not **SLI restored**.

**Fix.** Resolution criteria: SLO green for 15+ minutes, synthetic pass, support macro confirmed. IC signs off.

---

## 8. Root Cause Analysis (RCA)

### Core concept

**Root cause analysis** identifies **why** the incident was possible and **why** it was not caught earlier — not a single bad line of code. Outputs: root cause(s), contributing factors, timeline, action items (prevent, detect, mitigate).

### Root cause vs contributing factor

| Type | Example |
|---|---|
| **Root cause** | Deploy removed `tenant_id` filter from repository query |
| **Contributing** | Integration test used single-tenant fixture |
| **Contributing** | No alert on cross-tenant access audit spike |
| **Not root cause** | "Bob deployed on Friday" (blame) |

### Five Whys (used carefully)

Symptom: EU users could not checkout.

1. Why? Payment-api returned 503.
2. Why? Connection pool exhausted.
3. Why? Connections not released on timeout path.
4. Why? Missing `try-with-resources` on new Stripe client wrapper.
5. Why? Code review checklist missing resource cleanup for HTTP clients.

Action: fix leak + static analysis rule + pool saturation alert — not "don't deploy on Friday."

### Fishbone (Ishikawa) categories

```
People | Process | Technology | Environment
  │         │            │              │
  │         │            │              └─ EU region only → routing
  │         │            └─ payment pool leak
  │         └─ no load test on new path
  └─ on-call unfamiliar with pool metrics
```

Use fishbone when multiple factors interact — not for simple rollback scenarios.

### Timeline reconstruction

| Time (UTC) | Event | Source |
|---|---|---|
| 13:58 | payment-api v2.4.1 deploy started | ArgoCD |
| 14:02 | checkout error rate 0.1% → 5% | Prometheus |
| 14:05 | First PagerDuty SLO burn | Alertmanager |
| 14:08 | INC declared, IC @ada | Slack |
| 14:12 | Rollback payment-api v2.4.0 | ArgoCD |
| 14:18 | Error rate baseline | Prometheus |
| 14:45 | INC resolved | incident.io |

Timestamps from **metrics**, not memory. Clock sync matters.

### Production scenario: RCA stops at "human error"

**Problem.** Postmortem: "Engineer misconfigured timeout." Closed. Same class of bug recurs in three months.

**Cause.** RCA treated mistake as root; no systemic fix.

**Better RCA.** Root: timeout not validated by contract test against payment SLA. Actions: (1) default timeouts from config with bounds in CI, (2) synthetic payment probe in staging gate, (3) alert on client timeout < provider p99.

### Hypothesis tree (during incident)

```
Checkout 5xx elevated
├─ Deploy correlation?
│   ├─ order-api? no
│   └─ payment-api? yes @ 14:02 → prioritize rollback
├─ Dependency external?
│   └─ Stripe status? green
├─ Regional?
│   └─ EU only → check EU payment-api pods / residency routing
└─ Load spike?
    └─ RPS normal
```

Update tree in war room doc — kills duplicate investigation.

---

## 9. Postmortems and Learning from Incidents

### Core concept

A **postmortem** (or incident review) is a blameless document that transfers learning to the org. Required for SEV1/2; optional template for SEV3.

### Blameless culture

Focus on **systems**: guards, tests, alerts, runbooks — not punishment. "Why did the system allow deploy without integration test?" not "why did Bob miss it?"

Still document **who did what** in timeline (facts) without judgment.

### Postmortem template

```markdown
# Postmortem: INC-123 Checkout EU degradation

## Summary
30% checkout failure in EU for 16 minutes due to connection pool leak in payment-api v2.4.1.

## Impact
- Duration: 14:02–14:18 UTC
- Users: ~12,000 failed checkout attempts (estimate from error counter)
- Revenue: $X estimated (finance)
- SLO: checkout availability burned 15% of monthly error budget

## Timeline
(table)

## Root cause
...

## Contributing factors
...

## What went well
- SLO burn alert fired in 3 minutes
- Rollback automated via ArgoCD

## What went poorly
- No pool saturation alert
- IC not assigned until 14:08

## Action items
| ID | Action | Owner | Due | Priority |
|----|--------|-------|-----|----------|
| 1 | Fix connection leak + test | @bob | 2026-09-05 | P0 |
| 2 | Alert Hikari pending > 5 | @sre | 2026-09-10 | P1 |
| 3 | IC auto-assignment on SEV2 | @ada | 2026-09-15 | P2 |

## Lessons learned
...
```

### Action item hygiene

- **Prevent**: fix bug, add test, change architecture.
- **Detect**: alert, synthetic, audit log.
- **Mitigate**: runbook, feature flag, auto-rollback.

Avoid vague "improve monitoring." Specify metric name and threshold.

Review action items in quarterly reliability review — stale items mean postmortems are theater.

---

## 10. Performance Bottlenecks — Mental Model

### Core concept

A **performance bottleneck** is the constraint that limits throughput or inflates latency for a workload. In microservices, the bottleneck is often **not** where latency appears in the trace — queueing theory: delay accumulates **behind** the slowest resource.

### Universal bottleneck categories

| Category | Signals | Tools |
|---|---|---|
| **CPU** | High utilization, long GC, hot threads | profiler, thread dump |
| **Memory** | OOM, high GC pause, swap | heap dump, GC log |
| **I/O disk** | High iowait, slow fsync | node metrics, DB pg_stat |
| **Network** | Retransmits, TLS handshake p99 | mesh metrics, tcpdump (careful) |
| **Database** | Slow queries, locks, connections | pg_stat_statements, EXPLAIN |
| **Lock contention** | Java blocked threads, DB row locks | thread dump, `pg_locks` |
| **Pool exhaustion** | Pending acquire, timeout errors | Hikari metrics, bulkhead |
| **External API** | Outbound RED duration | trace spans, provider status |
| **Cache** | Miss storm, hot key, eviction | Redis INFO, cache metrics |
| **Queue lag** | Consumer lag, age of oldest | Kafka lag exporter |

### Little's Law (production intuition)

`L = λ × W` — average items in system = arrival rate × average time in system.

If checkout queue depth grows but RPS stable, **service time W increased** — find what got slower, not "add more pods" first. More pods help only if bottleneck is CPU-bound **and** no shared serial resource (DB primary).

### Production scenario: "we scaled to 50 pods, still slow"

**Problem.** Report API p99 10s. HPA maxed at 50 pods. CPU 30% per pod.

**Cause.** Bottleneck is **shared PostgreSQL primary** — 50 pods × 20 connections = 1000 queries hammering one primary. Slow query without index.

**Fix.** Index on replica for read path; move reports to OLAP; reduce pool size per pod (counterintuitive but reduces DB stampede). Scaling app without finding constraint wastes money.

### Latency percentiles

| Metric | Meaning |
|---|---|
| p50 | Typical experience |
| p95 | Most users, SLA often here |
| p99 | Tail pain, often dependency or GC |
| p99.9 | "Black swan" — mesh, DNS, cold start |

Alert on p99 **per route** and **per tenant tier** — global p99 hides VIP tenant on noisy neighbor.

---

## 11. CPU, Memory, and JVM Production Debugging

### Core concept

JVM microservices in K8s: CPU throttling, container memory limit vs heap, GC pauses, and thread pool sizing dominate tail latency. **Container OOMKill** is not Java OOM — different fixes.

### CPU throttling

Symptom: latency up, `container_cpu_cfs_throttled_seconds_total` up, JVM CPU "low."

```bash
# Check throttling
kubectl top pod
# Prometheus: rate(container_cpu_cfs_throttled_seconds_total[5m])
```

Fix: increase CPU limit, reduce work per request, or optimize hot path — not only "more replicas" if limit is starved.

### GC and memory

```yaml
# Prefer explicit heap with container limit headroom
# Container limit 2Gi → max heap ~1.2-1.4Gi leaving native/metaspace/off-heap
JAVA_OPTS: "-XX:MaxRAMPercentage=75.0 -XX:+UseG1GC"
```

Symptom: periodic p99 spikes every 60s → G1 mixed GC or humongous allocations.

Tools:

- **GC logs** to centralized logging (`-Xlog:gc*:file=/tmp/gc.log` — sidecar ship or rotate).
- **async-profiler** on canary (CPU, alloc) — not full fleet.
- **jcmd** thread dump: `jcmd <pid> Thread.print`

### Thread dump interpretation

```bash
kubectl exec -it order-api-xxx -- jcmd 1 Thread.print > threads.txt
```

Look for:

- `BLOCKED` on same monitor → lock contention.
- `WAITING` on `LinkedBlockingQueue.take` → pool starved or slow tasks.
- All threads in `socketRead0` → dependency slow, not CPU.

### Production scenario: OOMKilled without Java heap dump

**Problem.** Pod restart loop. `kubectl describe` shows OOMKilled. No heap dump.

**Cause.** Native memory (Netty direct buffers, gRPC, Tomcat) exceeded cgroup limit while heap fine.

**Debug.** Increase limit temporarily on canary; enable `-XX:NativeMemoryTracking=summary`; check Netty `maxDirectMemory`. Or direct buffer leak in new codec.

### Reactive (WebFlux) note

Blocking call on `parallel` scheduler → event loop blocked → all routes slow. Trace shows one slow route; actually `block()` in filter. Use bounded elastic for blocking; never `block()` on event loop thread.

---

## 12. Database and Query Performance in Production

### Core concept

Database bottlenecks are the default root cause for "we scaled the app and it's still slow." Connection pool misconfiguration + missing index + N+1 ORM queries account for majority of senior interview war stories.

### Connection pool (HikariCP)

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20      # not 200 "for performance"
      connection-timeout: 5000
      leak-detection-threshold: 60000
```

Metrics:

- `hikaricp_connections_active` / `max`
- `hikaricp_connections_pending` > 0 sustained → pool too small or connections held too long

Rule: `pool_size × pod_count` must not exceed DB `max_connections` with headroom for admin and replicas.

### Slow query workflow

1. Trace shows `jdbc` span 3s.
2. `pg_stat_statements` on replica:

```sql
SELECT query, calls, mean_exec_time, max_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 20;
```

3. `EXPLAIN (ANALYZE, BUFFERS)` on **replica** with representative parameters.
4. Missing index? Seq scan on million rows?
5. Lock wait? `SELECT * FROM pg_locks WHERE NOT granted;`

### N+1 detection

Symptom: 200 `jdbc` spans per request in trace — `order` + 199 `line_item` queries.

Fix: `@EntityGraph`, `JOIN FETCH`, or batch size:

```yaml
spring.jpa.properties.hibernate.default_batch_fetch_size: 50
```

### Production scenario: migration locked production

**Problem.** Deploy includes `ALTER TABLE orders ADD COLUMN ...` — table locked 20 minutes. Checkout down globally.

**Cause.** Blocking migration on hot table without `CONCURRENT` index / expand-contract pattern.

**Prevention.** Migration tool (Flyway/Liquibase) review; online schema change (pg_repack, gh-ost); expand-contract for column renames.

### Read vs write path

| Workload | Target |
|---|---|
| OLTP checkout | Primary, indexed, short transactions |
| Reporting | Replica or OLAP |
| Search | Elasticsearch/OpenSearch, not `%LIKE%` on PG |

---

## 13. Network, Latency, and Dependency Bottlenecks

### Core concept

Network issues present as **timeouts**, **intermittent 5xx**, and **regional skew**. In K8s: DNS, service mesh retries, TLS, cross-AZ traffic, and cross-region residency routing.

### DNS

Symptom: first request slow after idle, or random `UnknownHostException`.

- CoreDNS overload: `kubectl logs -n kube-system -l k8s-app=kube-dns`
- ndots issue: Java resolves `payment.svc.cluster.local` — misconfigured search path causes extra lookups.

```yaml
# Pod dnsConfig — use carefully
dnsConfig:
  options:
    - name: ndots
      value: "2"
```

### Service mesh retries

Istio default retries can **amplify** load on failing dependency — 3 retries × 50 pods = 150x traffic to dead payment-api.

```yaml
# VirtualService — cap retries, retry only connect-failure
retries:
  attempts: 2
  perTryTimeout: 2s
  retryOn: connect-failure,refused-stream
```

Mesh metrics: `istio_requests_total` with `response_flags` — `UF` upstream failure, `UO` upstream overflow.

### Cross-region latency

EU user → US database = 100ms+ RTT per query. Multiplies with chatty ORM.

Fix: data residency (EU DB for EU tenants), edge caching, aggregate API, gRPC binary protocol.

### External dependency

Check provider status page **after** internal RED confirms outbound duration spike — avoid "Stripe is down" when your cert expired.

```java
// Log provider correlation id from response header for support ticket with Stripe
String stripeRequestId = response.header("Request-Id");
```

### Production scenario: TLS handshake p99 2s

**Problem.** New mesh mTLS enabled. Latency up on every first call.

**Cause.** Cold connection + full handshake per request without connection pooling on sidecar.

**Fix.** Enable keep-alive, tune pool, or session resumption — verify with `openssl s_client` and mesh access logs.

---

## 14. Caching, Queues, and Async Path Debugging

### Core concept

Caches and queues **decouple** services — failures manifest as **staleness**, **lag**, or **duplicate processing** rather than immediate 5xx.

### Cache failure modes

| Mode | Symptom | Debug |
|---|---|---|
| **Cache miss storm** | DB spike after TTL expiry | Singleflight, jittered TTL |
| **Hot key** | One Redis node hot | Key splitting, local L1 |
| **Stale data** | User sees old balance | TTL, cache-aside invalidation miss |
| **Redis down** | Latency up if no fail-fast | Circuit breaker to cache; fallback |

```java
@Cacheable(value = "products", key = "#tenantId + ':' + #id")
public Product getProduct(String tenantId, long id) { ... }
```

Cache key **must include tenantId** — see Multi-tenancy section.

### Kafka lag debugging

```
lag = high, consumer CPU low → poison message or blocked processing
lag = high, consumer CPU high → slow handler or under-partitioned
lag = zero, wrong data → producer wrong topic or serde mismatch
```

Check:

- `kafka_consumer_group_lag`
- Consumer logs for `DeserializationException`
- DLQ topic volume

### Async @Async / scheduler

Lost trace context → cannot debug distributed path. Lost tenant context → wrong shard query.

Use `TaskDecorator` + context propagation (Micrometer). Pass `tenantId` explicitly into async methods.

### Production scenario: cache stampede after marketing push

**Problem.** Flash sale announcement. Traffic 10x. DB connections exhausted. Redis hit rate was 99% before.

**Cause.** All product cache entries TTL 60s synchronized — expired together at :00. Stampede to DB.

**Fix.** Jitter TTL `60 + random(0,30)`. Probabilistic early expiration. Pre-warm cache before push.

---

## 15. Production Troubleshooting Patterns

### Core concept

**Patterns** are repeatable playbooks for symptom classes. Senior engineers pattern-match before inventing.

### Pattern catalog

| Pattern | Signature | First moves |
|---|---|---|
| **Bad deploy** | Error/latency step change at deploy time | Rollback, diff config, feature flag off |
| **Capacity** | Gradual degradation, saturation metrics | Scale, shed load, queue |
| **Dependency** | Outbound RED bad, multiple services affected | Provider status, circuit, fallback |
| **Data corruption** | Wrong values, not errors | Stop writes, snapshot, compare checksums |
| **Thundering herd** | Spike after recovery or cache expiry | Rate limit, jitter, backoff |
| **Retry storm** | Errors + high RPS to dependency | Disable retry, fix client |
| **Noisy neighbor** | One tenant/pod skew | Isolate tenant, throttle, move |
| **Config drift** | Region A ok, B bad | Compare ConfigMaps, env, flags |
| **Certificate expiry** | TLS errors at fixed wall time | `openssl x509`, cert-manager |
| **DNS / routing** | Intermittent, region-specific | CoreDNS, ingress, geo DNS |

### Rollback vs fix-forward

| Rollback | Fix-forward |
|---|---|
| Unknown cause, fast revert path | Clear root cause, small patch |
| Data migration not reversible | Forward fix tested in staging |
| SEV1 user impact | Low risk config tweak |

IC decides. "We'll fix in prod" during SEV1 without load test is how incidents extend.

### Load shedding

```java
if (loadShedder.shouldReject()) {
    return ResponseEntity.status(503)
        .header("Retry-After", "30")
        .build();
}
```

Prefer shed at **gateway** for uniform behavior. Document 503 with `Retry-After` vs 429.

### Runbook structure

```markdown
# Runbook: checkout-high-error-rate

## Symptoms
- SLI checkout_success_rate < 99%
- Alert checkout_slo_fast_burn

## Severity
SEV2 default

## First steps (5 min)
1. Check status Stripe + internal payment-api RED
2. Deploy timeline last 2h all payment path services
3. Scope: region, tenant tier

## Mitigations
- Rollback payment-api: `argocd app rollback payment-api`
- Kill switch: `feature flag checkout-new-rail off`

## Escalation
#payments-oncall → #platform if pool/DB

## Verification
Synthetic EU checkout probe green 15 min
```

Runbooks in repo next to alert annotation `runbook_url`.

---

## 16. Kubernetes and Platform-Layer Debugging

### Core concept

Platform issues masquerade as application bugs: NotReady pods, CNI drops, image pull failures, HPA flapping, and eviction.

### Pod lifecycle

```bash
kubectl describe pod order-api-xxx
# Events: FailedScheduling, OOMKilled, Evicted, Unhealthy
kubectl get events -n prod --sort-by='.lastTimestamp'
```

| State | Meaning |
|---|---|
| `CrashLoopBackOff` | App exits — check logs previous |
| `Pending` | Quota, affinity, PVC |
| `NotReady` | Failing readiness — don't route traffic |
| `Evicted` | Node disk/memory pressure |

### Readiness vs liveness during incidents

Misconfigured liveness kills slow pods during dependency outage — **amplifies** incident. Readiness should fail when dependency down; liveness should not.

### HPA

Symptom: latency high, replicas at max, CPU low → HPA wrong metric (CPU vs RPS). Custom metrics from Prometheus adapter for queue depth or RPS.

### Production scenario: all pods NotReady after deploy

**Problem.** New deploy. All `order-api` NotReady. Liveness probes kill before app starts.

**Cause.** Slow startup (DB migration on boot) + `initialDelaySeconds: 10` + heavy readiness checks.

**Fix.** Startup probe; lazy init; readiness only critical deps; migrations as Job not in app start.

### NetworkPolicy misconfiguration

Symptom: "Connection refused" to `payment-api` after security hardening. `NetworkPolicy` dropped egress from `order-api` namespace.

Debug: `kubectl run tmp --rm -it --image=nicolaka/netshoot -- curl payment-api:8080`

---

## 17. Multi-Tenancy in Production

### Core concept

**Multi-tenancy** means one deployment serves many customers (tenants) with **logical isolation** — data, config, quotas, and noisy-neighbor protection. Production troubleshooting must **scope by tenant** early; "checkout slow" may be one enterprise tenant's bulk import.

### Tenancy models

| Model | Isolation | Ops complexity | Debug focus |
|---|---|---|---|
| **Shared DB, shared schema, tenant_id column** | Application-enforced | Low | SQL predicates, indexes on tenant_id |
| **Shared DB, schema per tenant** | Medium | Medium | Connection routing, migration per schema |
| **DB per tenant** | High | High | Shard map, connection pools per tenant |
| **Cell-based** | Very high | Very high | Cell routing, blast radius per cell |

### Tenant context propagation

```java
// JWT claim → TenantContext (ThreadLocal or request scope)
String tenantId = jwt.getClaimAsString("tenant_id");
TenantContext.setCurrent(tenantId);

// EVERY repository query
@Query("SELECT o FROM Order o WHERE o.tenantId = :tenantId AND o.id = :id")
```

Missing `tenantId` in one query = **cross-tenant data leak** — SEV1 security incident, not performance ticket.

### Production scenario: "only customer Acme affected"

**Problem.** Acme reports timeouts. Other tenants fine. Global metrics normal.

**Cause.** Acme on dedicated **noisy neighbor** — shared Redis key prefix collision with load test tenant. Or Acme tier allows 10x API rate flooding their shard.

**Debug.**

```promql
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket{tenant_tier="enterprise"}[5m])) by (le, tenant_id)
)
```

Only if `tenant_id` label is **low cardinality** (top 10 VIP) — not all tenants in metrics.

Prefer logs: `tenant_id=acme` + trace. Throttle Acme; isolate to dedicated pool.

### Quotas and fairness

| Mechanism | Purpose |
|---|---|
| Rate limit per tenant | API fairness |
| Bulkhead per tenant | Pool isolation |
| K8s ResourceQuota per namespace | Cell isolation |
| Noisy neighbor detection | Auto throttle |

---

## 18. Multi-Tenant Failure Modes and Isolation

### Core concept

Multi-tenant **failure modes** span performance, security, and compliance. Troubleshooting must distinguish **platform outage** vs **single-tenant abuse** vs **isolation breach**.

### Failure mode catalog

| Failure | Severity | Detection |
|---|---|---|
| Cross-tenant data read | SEV1 security | Audit log anomaly, support report |
| Cross-tenant data write | SEV1 security | Integrity checks, user reports |
| Tenant A slows tenant B | SEV2/3 | Per-tenant latency, shared resource saturation |
| Wrong tenant config | SEV2 | Feature flag scoped wrong |
| Tenant deleted still billed | SEV3 | Reconciliation job |
| Shard map stale | SEV2 | Routing to wrong DB cell |

### Cross-tenant leak debugging

1. **Stop the bleeding** — disable endpoint, feature flag off, IC + security.
2. Collect audit logs: `actor_tenant`, `resource_tenant`, `action`.
3. Identify query missing predicate — git diff recent repository changes.
4. Scope: which tenants affected, time window.
5. Regulatory notification if PII crossed tenants — legal involved.

```sql
-- Audit forensics (read replica)
SELECT * FROM audit_log
WHERE resource_tenant_id != actor_tenant_id
  AND created_at > '2026-08-31 12:00:00'
ORDER BY created_at;
```

### Cache and search isolation

```text
WRONG: cache key = product:123
RIGHT: cache key = tenant:acme:product:123
```

Elasticsearch: **routing key** = tenantId or separate index per tier.

### Testing isolation

- Contract test: tenant A token cannot read tenant B resource — every endpoint.
- Chaos: load test tenant must not move p99 for others on shared infra.
- Periodic **tenant escape automated tests** in CI.

### Production scenario: missing tenant filter in new API

**Problem.** v2 API shipped. Security scan clean. Pen test finds tenant B order visible to tenant A user.

**Cause.** New controller used raw `orderRepository.findById(id)` without tenant scope. v1 had filter.

**Fix.** Hotfix repository wrapper; mandatory `@TenantScoped` annotation enforced by ArchUnit test; incident SEV1; customer notification per contract.

---

## 19. Data Residency and Regulatory Troubleshooting

### Core concept

**Data residency** requires data storage and processing in specific jurisdictions (EU, India, UAE, etc.). **Production troubleshooting** must respect legal boundaries — US engineer cannot "just query EU prod DB" without access controls and audit.

### Residency architecture patterns

```
                    Global DNS / Geo routing
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   EU cell (eu-west)    US cell (us-east)    APAC cell
   EU Postgres          US Postgres          APAC Postgres
   EU Kafka             US Kafka             APAC Kafka
   EU OTel/Logs         US OTel/Logs         APAC OTel/Logs
```

**No cross-cell synchronous calls** for resident data — async replication only where legally allowed.

### Regulatory frameworks (troubleshooting lens)

| Framework | Production concern |
|---|---|
| **GDPR** | EU data in EU; breach notification 72h; right to erasure |
| **PCI DSS** | Card data environment segmentation; no PAN in logs |
| **HIPAA** | PHI access audit; BAA with vendors |
| **SOC 2** | Access logging, change management evidence |

Troubleshooting evidence (logs, dumps) may contain resident data — **where it is stored** must match policy.

### Production scenario: EU user data in US logs

**Problem.** Alert: log shipper routing misconfigured — `app=order-api` EU pods shipping to US OpenSearch cluster.

**Cause.** Fluent Bit `cluster_name` label wrong after helm upgrade.

**Severity.** SEV1 compliance — data residency violation even without user-visible outage.

**Response.** Stop shipping; delete US-indexed EU data per retention playbook; legal notified; fix routing; audit all index patterns.

### Access controls for cross-region debug

| Rule | Implementation |
|---|---|
| EU data accessed only by EU staff | IAM + break-glass with approval |
| No production data to US ticketing | Ticket references IDs only |
| Heap dump contains PII | Region-locked storage, encryption |
| Support impersonation | Time-bound, audited, tenant-scoped |

### Data residency debugging checklist

1. Which **cell** is tenant in? (`tenant.shard_map`)
2. Did request **geo-route** correctly? (DNS, ingress annotation)
3. Did async job **cross border**? (Kafka mirror, S3 replication config)
4. Backup/DR region — is secondary region allowed for this tenant tier?
5. Observability backend region matches data region?

---

## 20. Cross-Border Data and Geo-Routing Incidents

### Core concept

**Geo-routing incidents** occur when traffic or data crosses borders incorrectly — users hit wrong region, latency spikes, or compliance breaks.

### Geo DNS and routing

```
User in Germany → Geo DNS → EU ALB → EU cluster
User in Germany → misconfigured DNS → US ALB → US cluster (wrong + slow)
```

Debug:

- `dig api.example.com` from EU vantage (synthetic probe)
- CDN/LB access logs: `client_country`, `backend_region`
- `X-Region` response header for support tickets

### Failover across regions

**Problem.** EU region down. Failover to US. EU tenants legally cannot process in US.

**Cause.** DR runbook assumed technical failover without residency matrix.

**Fix.** **Stay down** for EU tenants or read-only degraded mode until EU recovers — not US takeover. Document per tenant tier in DR playbook.

### Replication lag across borders

If async replication EU → EU-DR only: lag causes RPO breach on failover — troubleshooting focuses on replication slot, network, write volume.

Cross-border replication for analytics: **aggregated anonymized** only — separate pipeline from resident OLTP.

### Production scenario: post-Brexit wrong shard

**Problem.** UK enterprise tenants still routed to EU-West cell after policy change requiring UK isolation.

**Cause.** Feature flag `uk_cell_enabled` not enabled for existing tenants — only new signups.

**Debug.** Tenant metadata `residency_policy=UK` vs actual `cell=eu-west`. Batch migration job status. Support ticket with tenant ID → shard map API.

### Clock and timezone in incidents

Report times in **UTC** internally; user comms in affected region local time. "Fixed at 3pm" without timezone confuses postmortem.

---

## 21. Spring Boot 3 Production Troubleshooting Integration

### Core concept

Spring Boot 3 provides Actuator, Micrometer, and observability bridges — misconfiguration creates false health, metric cardinality explosions, and dangerous exposed endpoints.

### Actuator for incidents

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,loggers
  endpoint:
    health:
      show-details: when_authorized
      probes:
        enabled: true  # K8s startup/readiness/liveness groups
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true
```

**Never** expose `env`, `heapdump`, `threaddump` on public ingress — VPN or port-forward only.

### Health groups

```yaml
management.endpoint.health.group.readiness.include: readinessState,db,kafka
management.endpoint.health.group.liveness.include: livenessState
```

During incident: `/actuator/health/readiness` failing on `db` → scope to database, not random JVM issue.

### Micrometer metrics for troubleshooting

| Metric | Use |
|---|---|
| `http.server.requests` | RED per route |
| `jdbc.connections.active` | Pool saturation |
| `resilience4j.circuitbreaker.state` | Circuit open |
| `kafka.consumer.lag` | Async path |

### Dynamic loggers

```bash
curl -u admin:$TOKEN -X POST \
  https://order-api-canary/actuator/loggers/com.example.payment \
  -H 'Content-Type: application/json' \
  -d '{"configuredLevel":"DEBUG"}'
```

Automate revert in 4 hours — cron or GitOps reset.

### Spring Boot 3 + observability

```yaml
management.tracing.sampling.probability: 0.1  # canary: 1.0
logging.pattern.level: "%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-},%X{correlation_id:-}]"
```

### Virtual threads (Java 21) note

Massive thread counts change debugging — thread dump larger. CPU profile may show different contention. Pool sizing for blocking JDBC still matters — virtual threads are not unlimited DB connections.

### Production scenario: Actuator prometheus scrape timeouts

**Problem.** Prometheus scrape failures on `order-api`. Metrics incomplete during incident.

**Cause.** 500+ custom metrics with high cardinality added per `userId`. Scrape takes 30s+.

**Fix.** Drop bad metrics; use `@Timed` with limited tags; `management.metrics.enable` deny list; recording rules.

---

## 22. Production Debugging Playbook

When users say "it's broken" and dashboards are noisy, walk this list in order.

### Phase 1: Confirm and scope (0–10 min)

1. **Is this real user impact?** Synthetic probes, support ticket rate, SLO burn — not just an alert.
2. **Declare incident if threshold met** — assign IC, open channel, start timeline.
3. **Scope blast radius** — region, tenant(s), feature, % traffic, client type (web/mobile).
4. **Recent changes** — deploys, flags, certs, DNS, scale, migrations in last 2 hours.
5. **External dependencies** — provider status pages, BGP, cloud region health.

### Phase 2: Mitigate (10–30 min)

6. **Stop user harm first** — rollback, flag off, scale, circuit open, shed load.
7. **Verify mitigation with SLI** — not pod Running; synthetic checkout pass.
8. **Communicate** — status page update with user-visible impact, not internals.
9. **Preserve evidence** — snapshot metrics range, export relevant logs, note trace IDs before TTL expiry.

### Phase 3: Diagnose (parallel to mitigation)

10. **Edge golden signals** — LB/CDN error, RPS, p99.
11. **Entry service RED** — first service with anomaly in critical path.
12. **Outbound RED** — which dependency?
13. **Trace exemplar** — longest span; retries; error attribute.
14. **Logs** — `correlation_id` / `trace_id`; business error codes.
15. **USE** — pools, thread queues, Kafka lag, CPU throttle, disk.
16. **Tenant/region dimension** — multi-tenant and residency scoped?
17. **Hypothesis tree** — update in war room doc; avoid duplicate work.

### Phase 4: Resolve and learn

18. **Resolution criteria** — SLO green 15+ min, IC sign-off.
19. **Postmortem** — timeline, root cause, contributing factors, blameless actions.
20. **Close the loop** — alerts, tests, runbooks, ArchUnit for tenant filters.

### Quick commands

```bash
# SLO-style error rate by service
curl -G 'http://prometheus:9090/api/v1/query' \
  --data-urlencode 'query=sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m])) by (application)'

# Correlation ID log hunt (kubectl fallback)
kubectl logs -l app=order-api --since=30m | jq 'select(.correlation_id=="ord-7f3a2b")'

# Hikari pool pressure
curl -s http://order-api:8080/actuator/metrics/hikaricp.connections.pending | jq

# Kafka consumer lag
kubectl exec -it kafka-exporter -- curl -s localhost:9308/metrics | grep lag

# Pod events last hour
kubectl get events -n prod --field-selector involvedObject.name=payment-api-xxx

# ArgoCD deploy history
argocd app history payment-api

# EU vs US error skew
# PromQL: sum by (region)(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
```

### Incident communication cadence

| Severity | Internal update | External update |
|---|---|---|
| SEV1 | Every 15–30 min | Every 30 min minimum |
| SEV2 | Every 30 min | Every 60 min or on change |
| SEV3 | On milestone | Only if user-visible |

### What not to do during SEV1

- Enable TRACE on entire fleet.
- Run heap dump on all pods.
- `kubectl delete pod --all` without IC approval.
- Deploy "quick fix" without CI on critical path.
- Query production primary with heavy analytics.
- Grant unrestricted cross-region DB access.
- Mark resolved before SLI confirms.

---

## 23. Quick Decision Matrix

| Situation | Do this |
|---|---|
| User impact unclear | Check synthetic + SLO burn before infra alerts |
| Step change at deploy time | Rollback first; diff config and code |
| Intermittent 5xx, low rate | Traces + exemplars; correlation ID from support |
| Global slow, CPU low | DB, pool, lock, external API — not "add pods" |
| EU only broken | Geo routing, EU cell health, residency routing table |
| One tenant broken | Tenant scope logs/metrics; noisy neighbor; shard map |
| Cross-tenant data report | SEV1 security; disable path; audit query; legal |
| Data in wrong region logs | SEV1 compliance; stop shipper; delete index; legal |
| Trace stops at gateway | Fix traceparent propagation |
| Trace stops at @Async | Context propagation + TaskDecorator |
| Pool pending > 0 sustained | Leak detection, slow queries, reduce pool × pods |
| Kafka lag rising | Consumer errors, poison message, DLQ |
| Cache miss DB spike | Stampede; jitter TTL; singleflight |
| Retry storm | Disable retries; fix dependency; jitter backoff |
| OOMKilled | cgroup limit vs heap; native memory; direct buffers |
| Certificate errors at exact hour | cert-manager, ingress TLS secret expiry |
| "Fixed" but tickets continue | Resolution tied to SLI not deploy complete |
| RCA says "human error" | Add systemic guard: test, alert, lint rule |
| DR failover needed | Check residency — may not be allowed to US cell |
| DEBUG needed in prod | One canary pod, actuator loggers, auto-revert |
| Heap dump needed | One pod, region-locked storage, delete after |
| Multi-tenant new endpoint | Verify tenant predicate before ship; ArchUnit |
| Performance regression no deploy | Flag, cache TTL, data growth, certificate, DNS TTL |
| Status page message | User-visible feature + region; not CPU/disk |
| Post-incident | Postmortem + tracked actions prevent/detect/mitigate |
| On-call overwhelmed | IC assigns parallel tracks; stop drive-by debugging |
| GDPR incident | 72h breach assessment clock — legal immediately |

---

## 24. Interview Q&A

### Q1. What is the first thing you do when paged for a production outage?

**A.** Confirm **real user impact** — SLO burn, synthetic failure, support spike — not just an infra alert. Declare an incident if thresholds warrant, assign an IC, and **scope** blast radius (region, tenant, feature). Check **recent changes** in the last two hours. **Mitigate** (rollback, flag off, scale) before deep RCA if user harm is active. Communicate user-visible status, not internal metrics.

### Q2. How do you debug an intermittent production issue?

**A.** Intermittent issues need **aggregation** — metric rates over time, trace sampling with tail sampling for errors, and **correlation IDs** from support tickets. Avoid random `kubectl logs`. Compare failing vs successful traces. Look for race conditions, pool exhaustion under peak, retry timing, and dependency blips. Reproduce with load test in staging with similar concurrency. Enable targeted DEBUG on a canary with time-bounded window.

### Q3. What is the difference between mitigation and root cause fix?

**A.** **Mitigation** reduces user impact quickly — rollback, disable feature, scale, circuit breaker, load shed — may not address underlying bug. **Root cause fix** prevents recurrence — code fix, migration, architecture change, new alert. During SEV1, mitigate first; root cause can follow after SLI restores. Confusing them leads to "resolved" while still broken or untested hotfixes extending outages.

### Q4. How do you perform root cause analysis?

**A.** Reconstruct a **timeline** from metrics and deploy logs (UTC). Identify **root cause** (enabling condition) vs **contributing factors** (detection delay, retry storm). Use five whys or fishbone for systemic view — avoid stopping at "human error." Produce blameless postmortem with action items: **prevent** (code/test), **detect** (alert), **mitigate** (runbook). Verify action items close — otherwise RCA is theater.

### Q5. What roles exist in incident management and why?

**A.** **Incident Commander** coordinates priorities and decisions without deep-diving. **Technical Lead** drives hypothesis tree and engineering. **Communications Lead** owns status page and support macros. **Scribe** maintains timeline. **Domain experts** join as needed. Separation prevents nobody owning customer comms and five engineers rolling back different things simultaneously.

### Q6. How do you debug a distributed microservices failure?

**A.** Start at **user journey SLI** and edge metrics. Find first service with RED anomaly on critical path. Use **distributed traces** with W3C propagation and **correlation IDs** across HTTP and Kafka. Check outbound dependency RED. Compare deploy timeline across all services in path — not only the entry service. Account for **partial failure**, async completion, and eventual consistency — absence of error metric does not mean correct behavior.

### Q7. What is a correlation ID and how do you use it in incidents?

**A.** Business-scoped identifier generated at edge, propagated through services, returned to client (`X-Correlation-Id`). Support tickets include it. Search logs and sometimes events by this ID to find exact request path. Distinct from `trace_id` (telemetry, may be unsampled). Both should propagate; correlation ID bridges support and engineering during incidents.

### Q8. How do you find performance bottlenecks in production?

**A.** Identify constraint using **USE** (pools, CPU throttle, disk) and **RED** (which span in trace is longest). Scaling pods helps only if bottleneck is app CPU and not shared serial resource (DB primary). Check connection pool pending, slow queries (`pg_stat_statements`), N+1 in traces (many jdbc spans), cache miss storms, GC pauses, and cross-region RTT. Little's Law: growing queue with stable RPS means increased service time — find what slowed.

### Q9. What are common database-related production performance issues?

**A.** Missing indexes, N+1 ORM queries, connection pool too large × many pods exceeding DB `max_connections`, long transactions holding locks, migrations locking hot tables, reading OLTP primary for reports, connection leaks on error paths, and stale statistics causing bad plans. Debug with trace jdbc spans, Hikari metrics, `pg_stat_statements`, and `EXPLAIN` on replica.

### Q10. How do connection pools cause outages?

**A.** Pool too small → pending acquires and timeouts under load. Pool too large × pod count → DB overwhelmed with connections. **Leaks** on exception paths never release connections → gradual exhaustion. Slow queries hold connections longer → effective pool shrink. Alert on `pending` and mean acquire time. Fix leaks, tune pool size, optimize queries, use replicas for read load.

### Q11. What is a retry storm and how do you detect it?

**A.** Clients retry failed calls aggressively — often after dependency recovers — multiplying traffic (e.g. 50 pods × 5 retries). Detect: spike in RPS to dependency while errors elevated; trace shows repeated retry spans; dependency recovers then crashes again. Fix: exponential backoff with jitter, cap retries, retry only idempotent ops, circuit breaker, coordinate retry budgets across services and mesh.

### Q12. How do you debug Kafka consumer lag?

**A.** Check `consumer_group_lag` metric and consumer pod restarts. High lag + low CPU → poison message or blocked handler (DB lock). High lag + high CPU → slow processing or under-provisioned consumers. Zero lag but wrong outcomes → logic bug, wrong topic, serde mismatch. Inspect DLQ, deserialization errors in logs, partition skew (hot partition). Propagate trace context in headers for cross-service debug.

### Q13. What is cache stampede and how do you prevent it?

**A.** Many requests miss cache simultaneously (e.g. shared TTL expiry) and hammer backing store. Prevent: **TTL jitter**, probabilistic early expiration, **singleflight** (one fetch per key), pre-warm before known traffic spikes, circuit to DB on overload. Symptom: DB spike with high cache hit rate moments before.

### Q14. How do you troubleshoot multi-tenant issues in production?

**A.** Early question: **one tenant or all?** If one — noisy neighbor, wrong shard, tenant-specific config/flag, quota exceeded. Verify `tenant_id` in JWT matches data access logs. Metrics with per-tenant labels only for bounded VIP set — else use logs. Check cache keys include tenant. For cross-tenant leak — SEV1: disable endpoint, audit query, security incident process.

### Q15. What causes cross-tenant data leaks and how do you prevent them?

**A.** Missing `tenant_id` predicate in SQL/repository, cache key without tenant prefix, search index without routing, batch job without tenant scope, admin tool bypassing checks. Prevent: centralized tenant-scoped repository layer, ArchUnit tests, automated "tenant escape" integration tests per endpoint, audit logs comparing actor vs resource tenant, code review checklist for any new data access path.

### Q16. What is data residency and how does it affect troubleshooting?

**A.** Data must be stored/processed in specific jurisdictions. Troubleshooting must use **region-appropriate** logs, DB replicas, and dumps — US engineer may not freely query EU PII. Misconfigured log routing can cause **compliance SEV1** without user-visible outage. DR failover may be **legally blocked** across borders — playbook must document per-tenant residency policy. Break-glass access is audited and time-bound.

### Q17. How do you handle a suspected GDPR data residency violation?

**A.** Treat as **SEV1 compliance** — involve legal immediately (72h breach assessment clock may apply). Stop data flow (fix shipper/routing), identify scope (which tenants, time window, data types), delete wrongly indexed data per retention playbook, preserve evidence for legal, customer notification per counsel guidance. Technical fix alone insufficient without legal process.

### Q18. How do geo-routing mistakes manifest?

**A.** Users in EU hitting US cluster — high latency and wrong residency. Debug: synthetic probes from EU, DNS geo responses, CDN/LB logs with `client_country`, tenant shard map vs actual cell. Failover runbooks must respect residency — cannot route EU tenants to US for convenience.

### Q19. When do you take a heap dump in production?

**A.** Last resort for **OOM** or confirmed memory leak after metrics show growth and GC ineffective — **one canary pod**, not fleet. Heap dumps contain PII — region-locked encrypted storage, delete after analysis, restricted access. Prefer allocation profiling on canary first. Never during active SEV1 unless leak is cause and rollback insufficient.

### Q20. What is the difference between liveness and readiness in incident response?

**A.** **Readiness** — should receive traffic; fail when dependencies down so load balancer routes away. **Liveness** — process alive; failure restarts pod. Misconfigured liveness during dependency outage kills pods repeatedly — **worsens incident**. During debug, NotReady is signal; CrashLoop from liveness is often misconfiguration. Alert on user SLI, not kube Ready alone.

### Q21. How do you write a good postmortem?

**A.** Blameless, factual timeline (UTC), clear impact (users, duration, SLO budget), root cause vs contributing factors, what went well/poorly, and **tracked action items** with owners and dates — prevent, detect, mitigate categories. Avoid vague "improve monitoring." Review in reliability meeting until items close. Share learnings org-wide for similar services.

### Q22. How do you decide rollback vs fix-forward?

**A.** **Rollback** when cause unknown, revert path fast and safe, data migration irreversible, or SEV1 active. **Fix-forward** when root cause clear, small tested patch, rollback risky (schema), or fix is faster than revert. IC decides with TL input — not lone engineer during incident. Fix-forward in SEV1 without load test often extends outage.

### Q23. What metrics do you check first for latency regression?

**A.** p99 **per route** and per critical path — not global average. Trace exemplars on slow requests — longest span name. Outbound client duration metrics. Pool pending, thread queue depth, GC pause metrics, `container_cpu_cfs_throttled_seconds_total`. Compare canary vs stable if gradual rollout. Deploy and flag correlation timestamp.

### Q24. How does eventual consistency affect troubleshooting?

**A.** User may see temporary inconsistent state — payment succeeded, order pending — without error metrics. Debug async path: event in outbox/Kafka by correlation ID, consumer lag, idempotency handling, DLQ. Define **SLA for consistency** — if within SLA, educate support; if event lost, bug in async pipeline. Sync path traces insufficient — must inspect message flow.

### Q25. What is alert fatigue and how do you reduce it during on-call?

**A.** Too many low-signal pages — pod restarts, CPU, log patterns — causing missed real outages. Page on **SLO burn** and synthetic business checks. Use inhibition (node → pod), severity tiers, `for:` durations, and runbook-linked annotations. Quarterly alert audit: delete alerts that never led to action. Incident declaration thresholds automated from SLO policy.

### Q26. How do you debug CPU high in JVM microservices?

**A.** Check **CPU throttling** first — cgroup limit vs JVM view. async-profiler or thread dump on canary — hot methods, infinite loops, excessive GC. Compare traffic RPS — legitimate load vs attack. Recent deploy diff. Reactive stack: blocking on event loop shows as widespread latency with one bad filter. Scale only if CPU-bound and not throttled.

### Q27. What is a hypothesis tree in incident response?

**A.** Structured branching of possible causes updated live during incident — e.g. checkout 5xx → deploy? dependency? region? tenant? Prevents five engineers investigating the same path. IC/TL maintains in war room doc. Mark branches eliminated with evidence. Guides parallel workstreams on independent branches.

### Q28. How do feature flags help in production incidents?

**A.** **Kill switches** disable risky paths without full rollback — faster if flag tested quarterly. Scope flags per tenant for isolating bad config. Flags must default safe (new rail off). Document flag names in runbooks. After incident, avoid leaving incident flags on — debt causes next mystery behavior.

### Q29. What is noisy neighbor in multi-tenant SaaS?

**A.** One tenant's workload degrades others on shared infrastructure — bulk API import, huge report, load test on shared cell. Detect: per-tenant latency skew while global metrics normal. Mitigate: throttle tenant, move to dedicated cell/shard, rate limits, bulkhead pools. Long-term: cell-based architecture for enterprise tier.

### Q30. How do you verify an incident is truly resolved?

**A.** User **SLI** restored for 15+ minutes — checkout success rate, synthetic probes pass in affected regions, support macro confirms ticket pattern stopped. Not merely deploy complete or error rate "lower than peak." IC signs off. Continue monitoring for retry storms and cache stampede on recovery. Communicate resolved on status page with brief impact summary.

---

*Production will not save a missing tenant predicate, a log shipper pointed at the wrong continent, or an incident where nobody was incident commander. Mitigate first, scope by tenant and region, link symptom to trace to log, and write the postmortem that actually closes action items — or the same outage returns with a worse headline.*
