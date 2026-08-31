# Microservices Observability & Monitoring — Senior Production Reference

OpenTelemetry 1.x / Micrometer / Prometheus 2.x / Grafana 10.x / Spring Boot 3.x / ELK or OpenSearch / Loki. Servlet and reactive stacks are both covered; differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping microservices, mesh sidecars, and JVM backends where "we have Grafana" still means you cannot answer why checkout failed for one customer at 2:14 AM.

---

## Table of Contents

1. [Mental Model: One Request Through the Observability Stack](#1-mental-model-one-request-through-the-observability-stack)
2. [Observability — Three Pillars and Beyond](#2-observability-three-pillars-and-beyond)
3. [Centralized Logging](#3-centralized-logging)
4. [Log Aggregation](#4-log-aggregation)
5. [Correlation IDs](#5-correlation-ids)
6. [Distributed Tracing](#6-distributed-tracing)
7. [OpenTelemetry](#7-opentelemetry)
8. [Metrics & Monitoring](#8-metrics-monitoring)
9. [Prometheus](#9-prometheus)
10. [Grafana](#10-grafana)
11. [Golden Signals — Latency, Traffic, Errors, Saturation](#11-golden-signals-latency-traffic-errors-saturation)
12. [RED Method](#12-red-method)
13. [USE Method](#13-use-method)
14. [SLI, SLO, SLA](#14-sli-slo-sla)
15. [Error Budgets](#15-error-budgets)
16. [Alerting](#16-alerting)
17. [Spring Boot / Micrometer Production Integration](#17-spring-boot-micrometer-production-integration)
18. [Production Debugging Playbook](#18-production-debugging-playbook)
19. [Quick Decision Matrix](#19-quick-decision-matrix)
20. [Interview Q&A](#20-interview-qa)

---

## 1. Mental Model: One Request Through the Observability Stack

Observability is not "install Prometheus and hope." It is a **contract** that every hop in a request path emits **correlated, queryable signals** — logs with trace context, metrics with consistent labels, traces with parent-child spans — so you can answer novel questions about system behavior without redeploying printf debugging.

```
Client / mobile / browser
  └─ Edge (CDN, WAF, API Gateway)
       ├─ inject/propagate: traceparent, X-Request-Id, X-Correlation-Id
       └─ access logs + gateway metrics
            └─ Service A (order-api)
                 ├─ MDC: traceId, spanId, correlationId, tenantId
                 ├─ Micrometer timers/counters → /actuator/prometheus
                 ├─ OTel SDK → OTLP exporter → collector
                 └─ outbound call
                      └─ Service B (payment-api)
                           ├─ continues trace (child span)
                           ├─ structured JSON logs → stdout → agent
                           └─ DB / Kafka / Redis
                                └─ client spans + pool metrics
```

Three objects you must keep distinct:

| Object | Question it answers | Typical production type |
|---|---|---|
| **Log** | What happened, in narrative detail, for this unit of work? | Structured JSON line with `trace_id`, `level`, `message`, `exception` |
| **Metric** | How much / how fast / how often, aggregated over time? | Prometheus counter/histogram: `http_server_requests_seconds` |
| **Trace** | Where did time go across services for this request? | OpenTelemetry span tree with `span_id`, `parent_span_id`, attributes |

A spike in **error rate** (metric) does not tell you **which dependency** failed — you need traces. A trace showing slow DB span does not tell you **how many users** are affected — you need metrics. A log line "payment declined" does not tell you if it is one bad card or a gateway outage — you need all three, linked by **correlation ID** and **trace ID**.

### The observability data path

```
Application code
  ├─ Logs     → stdout/file → Fluent Bit / Filebeat → OpenSearch / Loki
  ├─ Metrics  → /metrics scrape or remote_write → Prometheus / Mimir / Cortex
  └─ Traces   → OTLP gRPC/HTTP → OTel Collector → Tempo / Jaeger / X-Ray
                         │
                         └─ (optional) tail_sampling, PII scrubbing, routing

Grafana (or Datadog/New Relic) correlates:
  - Exemplars on histograms → jump to trace
  - Trace ID in log → jump from trace to logs
  - Dashboards: RED/USE + SLO burn rate
```

### Production scenario: "We have monitoring but can't debug incidents"

**Problem.** Platform team deploys Prometheus + Grafana + ELK. During a checkout outage, on-call sees elevated 5xx on `order-api` dashboard. Logs are scattered across 40 pods. No trace links. Different services use different header names (`X-Request-Id`, `requestId`, none). Incident takes 90 minutes; root cause was a 200ms DNS blip on `payment-api` amplified by missing timeouts.

**Cause.** Observability was installed as **infrastructure**, not as an **application contract**. No standard propagation, no structured logging, no SLOs, alerts on CPU not user journeys.

**Solution — minimum viable production contract:**

1. **One trace propagation standard:** W3C `traceparent` / `tracestate` (OpenTelemetry default).
2. **One business correlation ID:** `X-Correlation-Id` generated at edge, copied to MDC, returned in error responses.
3. **Structured JSON logs** with `trace_id`, `span_id`, `correlation_id`, `service`, `env`.
4. **RED metrics** per service and per critical dependency outbound client.
5. **SLO** on checkout success rate + latency; alert on **error budget burn**, not pod restart count.

Rules that save incidents:

- Metrics tell you **something is wrong**; traces tell you **where**; logs tell you **why in business terms**.
- If you cannot click from a spike to a trace to a log line in under 60 seconds, your stack is decorative.
- Cardinality is the silent killer of metrics backends — guard label sets in code review.

---

## 2. Observability — Three Pillars and Beyond

### Core concept

**Observability** is the ability to understand internal system state from external outputs. In microservices, "internal state" is distributed — no single heap dump explains checkout failure across twelve services.

Classic **three pillars:**

| Pillar | Strength | Weakness |
|---|---|---|
| **Metrics** | Cheap at scale, great for alerting and trends | Loses individual request context |
| **Logs** | Rich context, business events, exceptions | Expensive at volume; hard to aggregate without structure |
| **Traces** | End-to-end latency, dependency mapping | Sampling loses rare failures; storage cost |

Modern production adds:

| Extension | Purpose |
|---|---|
| **Profiles** | CPU/alloc hotspots (Pyroscope, async-profiler) |
| **Events / RUM** | Real user monitoring, Core Web Vitals |
| **Continuous verification** | SLO checks, synthetic probes, canaries |

**Monitoring** is a subset: known failure modes with predefined dashboards and alerts. **Observability** implies you can ask questions you did not anticipate ("show me all requests where `payment_provider=stripe` AND `region=eu-west` AND latency > 2s last Tuesday").

### Internal working — how signals relate

```
                    ┌─────────────────────────────────────┐
                    │           Single HTTP request        │
                    └─────────────────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
    Trace (sampled)              Metrics (always)            Logs (always*)
          │                           │                           │
    span: gateway                  counter: http_requests_total   INFO payment started
    span: order-api                histogram: latency_seconds     ERROR timeout calling payment
    span: payment-api              gauge: thread_pool_active      WARN retry attempt 2
    span: postgres query
          │                           │                           │
          └──────── trace_id ─────────┴──────── trace_id ──────────┘
                        (same ID in all three when wired correctly)

* "Always" for logs you intend to keep — sampling and log levels still apply.
```

### Production scenario: metrics-only shop

**Problem.** SRE team alerts on `kube_pod_status_ready == 0` and `container_cpu_usage_seconds_total`. Users report "app is broken" while all infra dashboards are green. CPU is 20%. Pods are Ready.

**Cause.** Dependency latency regression — `inventory-service` p99 went from 80ms to 4s. No timeout on Feign client. Thread pools saturate. Requests queue. HTTP 200 still returned for health checks. CPU low because threads are **blocked waiting**, not computing.

**Solution.** Add **Golden Signals** (section 11) at the **service edge** and **client outbound** layers. Alert on latency SLO burn and error rate, not pod CPU.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Dashboards only on infrastructure | Green dashboards during user-visible outages |
| Unstructured string logs | grep across 500 GB/day; incidents take hours |
| No trace propagation on async paths | Broken traces at `@Async`, Kafka consumer, `@Scheduled` |
| High-cardinality labels (`userId`, `orderId` on metrics) | Prometheus OOM, scrape timeouts, TSDB corruption |
| 100% trace sampling in prod | Collector/backend bill explodes; still miss logs |
| Different time zones in logs | Cannot correlate events across systems |
| Logging full request bodies | PCI/GDPR incident; log storage 10× cost |

### Debugging scenario

**Observe.** Grafana shows normal request rate but support tickets spike for "timeout."

**Diagnose.**

1. Check **latency histogram** p99 vs p50 — wide spread indicates tail latency, not average problem.
2. Open **exemplar** on slow bucket → trace → identify longest span.
3. Search logs with `trace_id` from exemplar — find business context (`orderId`, `customerTier`).
4. Compare **outbound client metrics** `http.client.requests` for that dependency.

**Fix.** Adaptive timeout + circuit breaker on slow dependency; add span attribute `peer.service=inventory-service` for filter in trace backend.

---

## 3. Centralized Logging

### Core concept

**Centralized logging** means application logs leave the pod/host and land in a **shared, searchable store** with retention, access control, and correlation fields — not `kubectl logs` across 200 replicas during an incident.

Goals:

- **Durability** — pod death does not lose logs
- **Search** — find all lines for one `correlation_id` in seconds
- **Context** — same fields across all services (`service`, `env`, `trace_id`)
- **Compliance** — retention tiers, PII redaction, audit access

Typical stack:

```
App (JSON to stdout)
  → DaemonSet: Fluent Bit / Promtail / Filebeat
  → Buffer (local disk / Kafka for burst)
  → Store: OpenSearch / Elasticsearch / Loki / CloudWatch
  → UI: Kibana / Grafana Explore / OpenSearch Dashboards
```

### Internal working — structured logging

**Unstructured (avoid in prod):**

```
2024-03-15 14:22:01 ERROR Payment failed for order 8821 user 4412
```

**Structured (production default):**

```json
{
  "timestamp": "2024-03-15T14:22:01.123Z",
  "level": "ERROR",
  "service": "payment-api",
  "env": "prod",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "correlation_id": "req-7f3a9c2e-8811",
  "tenant_id": "acme-corp",
  "message": "Payment authorization failed",
  "order_id": "8821",
  "payment_provider": "stripe",
  "error_code": "card_declined",
  "duration_ms": 1842,
  "exception": "com.example.PaymentDeclinedException: insufficient_funds"
}
```

Why JSON to **stdout**:

- Kubernetes/CRI captures stdout/stderr automatically
- No file rotation fights inside container
- 12-factor compliant
- Agent ships one stream per container

### Spring Boot Logback example

`logback-spring.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <springProperty scope="context" name="appName" source="spring.application.name"/>

    <appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
        <encoder class="net.logstash.logback.encoder.LogstashEncoder">
            <includeMdcKeyName>trace_id</includeMdcKeyName>
            <includeMdcKeyName>span_id</includeMdcKeyName>
            <includeMdcKeyName>correlation_id</includeMdcKeyName>
            <includeMdcKeyName>tenant_id</includeMdcKeyName>
            <customFields>{"service":"${appName}","env":"${spring.profiles.active:-local}"}</customFields>
        </encoder>
    </appender>

    <root level="INFO">
        <appender-ref ref="JSON"/>
    </root>
</configuration>
```

`build.gradle`:

```gradle
implementation 'net.logstash.logback:logstash-logback-encoder:7.4'
```

### Production scenario: log volume bankrupts the cluster

**Problem.** Developer sets `logging.level.org.hibernate.SQL=DEBUG` in `application.yml` and merges to main. Within a week OpenSearch data nodes at 95% disk; indexing lag 20 minutes; hot shards reject writes during peak.

**Cause.** DEBUG SQL on all pods × 500 RPS × wide rows = terabytes/week. No log level guard per environment.

**Solution.**

```yaml
# application-prod.yml — SQL debug NEVER in prod
logging:
  level:
    root: INFO
    com.example: INFO
    org.hibernate.SQL: WARN

# Config server or env override only for short-lived debug on ONE pod
```

Operational guardrails:

- **Index lifecycle management (ILM):** hot → warm → delete (7–30 days hot, 90 days warm typical)
- **Ingest pipeline** drop DEBUG below prod threshold
- **Quota per service** with alert at 80% daily ingest
- **Dynamic log level** via Actuator `/actuator/loggers` on canary pod, not fleet-wide yaml

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Logging to files inside container without rotation | Disk full → pod evicted → logs lost |
| Multiline stack traces as separate events | Broken exception context in Kibana |
| Clock skew across nodes | Events appear out of order |
| Missing service name field | Cannot filter in multi-tenant cluster |
| Logging secrets / PAN / JWT | Compliance breach |
| Sync appenders to remote TCP | App blocks on log backpressure |

### Debugging scenario — multiline stack traces

**Observe.** Exceptions in Kibana show only first line; stack trace split into 40 index entries.

**Fix.** Use JSON encoder (one event per log call) or Logback `ThrowableHandlingConverter` with multiline pattern that shipper treats as single record. In Fluent Bit:

```ini
[MULTILINE_PARSER]
    name          java_multiline
    type          regex
    flush_timeout 1000
    rule          "start_state" "/^\d{4}-\d{2}-\d{2}/" "cont"
    rule          "cont"        "/^\s+at /"            "cont"
```

---

## 4. Log Aggregation

### Core concept

**Log aggregation** is the pipeline that **collects, parses, enriches, routes, and stores** logs from many sources. Centralized logging is the outcome; aggregation is the machinery.

Pipeline stages:

```
Collect → Parse → Enrich → Filter → Buffer → Route → Store → Index
```

| Stage | Example |
|---|---|
| Collect | Fluent Bit tail `/var/log/containers/*.log` |
| Parse | JSON parser or grok for legacy nginx |
| Enrich | Add `k8s.namespace`, `pod`, `node`, geo from IP |
| Filter | Drop health-check noise, sample DEBUG |
| Buffer | Kafka `logs-raw` topic for burst absorption |
| Route | PCI logs → restricted index; app logs → general |
| Store | OpenSearch index per day: `logs-prod-2024.03.15` |
| Index | Field mappings: keyword vs text, numeric types |

### ELK / OpenSearch stack

```
Filebeat (on node)
  → Logstash or Ingest Node pipelines
  → OpenSearch cluster (hot/warm tiers)
  → Kibana / OpenSearch Dashboards
```

**Index template** (critical — wrong mapping = cannot aggregate):

```json
{
  "index_patterns": ["logs-prod-*"],
  "template": {
    "settings": {
      "number_of_shards": 3,
      "index.lifecycle.name": "logs-30d-policy"
    },
    "mappings": {
      "properties": {
        "timestamp": { "type": "date" },
        "level": { "type": "keyword" },
        "service": { "type": "keyword" },
        "trace_id": { "type": "keyword" },
        "correlation_id": { "type": "keyword" },
        "message": { "type": "text" },
        "duration_ms": { "type": "long" },
        "order_id": { "type": "keyword" }
      }
    }
  }
}
```

Use **keyword** for filter fields; **text** for full-text search on message.

### Loki (Grafana-native alternative)

Loki **indexes labels only**, not full text — cheaper at scale, trades ad-hoc full-text unless you add Bloom filters (newer versions).

```
Promtail / Fluent Bit → Loki → Grafana Explore (LogQL)
```

LogQL example:

```logql
{service="payment-api", env="prod"} |= "card_declined" | json | correlation_id="req-7f3a9c2e-8811"
```

Good fit when you already run Prometheus/Grafana and queries are **label-first** (service, level, trace_id).

### Production scenario: hot shard storm during deploy

**Problem.** Every deploy triggers log flood (startup banners, config dumps, connection retries). OpenSearch indexing queue backs up; search latency 30s; unrelated teams cannot query logs during deploy window.

**Cause.** No ingest rate limiting; single shared index for all services; oversized documents (logging full Spring context on startup).

**Solution.**

1. **Separate indices** per service or per team with index templates.
2. **Ingest pipeline** to drop known startup noise:

```json
{
  "processors": [
    {
      "drop": {
        "if": "ctx.message != null && ctx.message.contains('Started PaymentApplication')"
      }
    }
  ]
}
```

3. **Kafka buffer** between collectors and OpenSearch for backpressure.
4. **Dedicated coordinating nodes** for search vs indexing.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Dynamic mapping explosion (`fields.*`) | Cluster state updates constantly; mapping conflicts |
| One giant index, no ILM | Delete by query takes hours; disk never frees |
| Storing raw nginx + app logs unparseable | Cannot join on request ID |
| No backpressure | Agent memory grows; OOMKill on Fluent Bit |
| Searching `@timestamp` in wrong timezone | "Missing" logs during incident window |

### Debugging scenario — mapping conflict

**Observe.** Logstash drops events: `failed to parse field [duration_ms] of type [keyword]`.

**Cause.** First document had `duration_ms: "slow"` (string); template locked field as keyword; later numeric values conflict.

**Fix.** Reindex with correct mapping; enforce schema in app (always number); use ingest pipeline `convert` processor with `ignore_failure`.

---

## 5. Correlation IDs

### Core concept

A **correlation ID** is a **business-scoped identifier** that ties together all logs, support tickets, and optional traces for **one user journey** — checkout, onboarding, batch job run. It is not the same as `trace_id` (W3C trace) though they should both propagate.

| ID | Scope | Generated by | Format |
|---|---|---|---|
| **trace_id** | One distributed trace (may be sampled) | OTel / tracer | 32 hex chars (128-bit) |
| **span_id** | One operation within trace | OTel | 16 hex chars |
| **correlation_id** | Business transaction / support ticket | API Gateway or first service | UUID, ULID, or prefixed string |
| **request_id** | Single HTTP hop (edge) | Load balancer | varies |

Best practice: **generate at edge**, accept client-provided only if validated (length, format), always return in response header for support.

### Propagation flow

```
Client
  → API Gateway: generate correlation_id=req-abc, traceparent=00-...
  → order-api: MDC.put("correlation_id", ...), logs include both IDs
  → Kafka message header: correlation_id, traceparent
  → payment-api consumer: restore MDC from headers
  → response: X-Correlation-Id: req-abc
```

### Spring Boot implementation

**Filter — inbound HTTP:**

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Correlation-Id";
    public static final String MDC_KEY = "correlation_id";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String correlationId = Optional.ofNullable(request.getHeader(HEADER))
            .filter(id -> id.length() <= 128 && id.matches("[\\w\\-]+"))
            .orElse("req-" + UUID.randomUUID());

        MDC.put(MDC_KEY, correlationId);
        response.setHeader(HEADER, correlationId);

        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
```

**RestTemplate / WebClient interceptor:**

```java
@Component
public class CorrelationIdInterceptor implements ClientHttpRequestInterceptor {

    @Override
    public ClientHttpResponse intercept(HttpRequest request, byte[] body,
                                        ClientHttpRequestExecution execution) throws IOException {
        String id = MDC.get(CorrelationIdFilter.MDC_KEY);
        if (id != null) {
            request.getHeaders().set(CorrelationIdFilter.HEADER, id);
        }
        return execution.execute(request, body);
    }
}
```

**Kafka:**

```java
producer.send(new ProducerRecord<>(topic, key, value), (metadata, ex) -> {
    // headers set before send
});

// Producer interceptor or wrapper:
record.headers().add(CorrelationIdFilter.HEADER, correlationId.getBytes(StandardCharsets.UTF_8));
```

**Consumer:**

```java
@KafkaListener(topics = "payments")
public void consume(ConsumerRecord<String, PaymentEvent> record) {
    Header h = record.headers().lastHeader(CorrelationIdFilter.HEADER);
    if (h != null) {
        MDC.put(CorrelationIdFilter.MDC_KEY, new String(h.value(), StandardCharsets.UTF_8));
    }
    try {
        process(record.value());
    } finally {
        MDC.clear();
    }
}
```

### Production scenario: support cannot find customer's request

**Problem.** Customer calls support with screenshot showing error at 14:22. Support searches logs by email — nothing. Email is not in access logs. Incident escalates.

**Cause.** No correlation ID returned to client; logs keyed by internal UUID only visible server-side; mobile app does not log server correlation ID.

**Solution.**

1. Return `X-Correlation-Id` on all API responses including errors.
2. Mobile app displays "Reference: req-abc" on error screen.
3. Support runbook: search OpenSearch `correlation_id:req-abc`.
4. Optional: embed in JWT `jti` or session for authenticated flows.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| New correlation ID per internal hop | Cannot stitch journey |
| ID only in logs, not propagated outbound | Broken chain at first downstream call |
| `@Async` without MDC copy | Logs after async boundary lose correlation |
| Reactive WebFlux without Reactor Context | Same as async — empty MDC in pipeline |
| Trusting client ID without validation | Log injection / oversized header attacks |

### WebFlux MDC propagation

```java
public static <T> Mono<T> withMdc(Mono<T> mono) {
    return mono.contextWrite(ctx -> {
        String correlationId = ctx.getOrDefault(CorrelationIdFilter.MDC_KEY, null);
        if (correlationId != null) {
            MDC.put(CorrelationIdFilter.MDC_KEY, correlationId);
        }
        return ctx;
    }).doFinally(s -> MDC.remove(CorrelationIdFilter.MDC_KEY));
}
```

Better: use Micrometer Context Propagation + OTel automatic context bridge (Boot 3.2+).

---

## 6. Distributed Tracing

### Core concept

**Distributed tracing** records the path of a request as a tree of **spans** — timed operations with metadata — across processes. Each span has a `trace_id` (shared) and unique `span_id`; child spans reference `parent_span_id`.

```
Trace trace_id=abc123
├─ span: GET /api/checkout          [order-api]     450ms
│  ├─ span: auth validate           [order-api]      12ms
│  ├─ span: GET /inventory/{sku}    [inventory-api]  180ms
│  │  └─ span: SELECT products      [postgres]       95ms
│  └─ span: POST /payments/charge  [payment-api]   220ms
│     └─ span: stripe API call      [payment-api]   200ms
```

Without tracing, `order-api` logs 450ms total but you cannot see 200ms waited on Stripe vs 180ms on inventory.

### Span anatomy

| Field | Purpose |
|---|---|
| `name` | Operation (`GET /api/orders`) |
| `start_time`, `end_time` | Latency |
| `status` | OK, ERROR |
| `attributes` | `http.method`, `db.statement` (sanitized), `peer.service` |
| `events` | Point-in-time annotations ("retry attempt 2") |
| `links` | Async relationships (consumer links to producer span) |

### Context propagation — W3C Trace Context

Header `traceparent`:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                │
             │  trace-id (32 hex)                span-id (16 hex) flags (sampled)
             version
```

`tracestate` carries vendor-specific hints (optional).

**B3** (Zipkin legacy): `X-B3-TraceId`, `X-B3-SpanId` — still seen in older services; OTel collector can translate.

### Sampling

100% traces in prod is usually impossible at scale.

| Strategy | Behavior |
|---|---|
| **Head-based** | Decision at trace start (probabilistic 1%) |
| **Tail-based** | Decision after trace completes (keep all errors, slow traces) |
| **Parent-based** | Child follows parent's sampled flag |

Production default: **head-based probabilistic** (1–10%) + **always sample errors** (if collector supports tail sampling) + **boost critical paths** (checkout 100% for 1 hour canary).

### Production scenario: broken traces at message queue

**Problem.** HTTP ingress traces look fine. Checkout flows involving Kafka show orphan spans — `payment-api` consumer spans with new trace IDs.

**Cause.** Producer did not inject trace context into Kafka headers; consumer did not extract.

**Solution — Spring Kafka + OTel:**

```yaml
# application.yml
management:
  tracing:
    propagation:
      type: w3c,b3
    sampling:
      probability: 0.1
```

Ensure `spring-kafka` and OTel instrumentation propagate through `ProducerRecord` headers. For manual:

```java
TextMapPropagator propagator = openTelemetry.getPropagators().getTextMapPropagator();
propagator.inject(Context.current(), record.headers(), (carrier, key, value) ->
    carrier.add(key, value.getBytes(StandardCharsets.UTF_8)));
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Tracing disabled on outbound HTTP client | Gap in trace at Feign/WebClient call |
| Custom thread pool without context propagation | Spans detached from parent |
| Span name = `GET` only | Cannot distinguish endpoints in trace UI |
| Recording full SQL with PII | Compliance violation in trace backend |
| No `peer.service` attribute | Service map shows generic "http" nodes |

### Debugging scenario — trace too deep

**Observe.** Single checkout trace has 4,000 spans (every Redis GET is a span).

**Cause.** Default Redis instrumentation at DEBUG granularity.

**Fix.** Configure instrumentation suppressions; use span limits; aggregate cache spans in app-level wrapper span.

---

## 7. OpenTelemetry

### Core concept

**OpenTelemetry (OTel)** is the vendor-neutral standard for traces, metrics, and logs — APIs, SDKs, collectors, and semantic conventions. It replaces the fragmentation of OpenTracing + OpenCensus + proprietary agents.

Components:

```
┌─────────────────────────────────────────────────────────────┐
│                        Your application                      │
│  OTel API ← auto-instrumentation (Java agent) or manual SDK │
└───────────────────────────┬─────────────────────────────────┘
                            │ OTLP (gRPC :4317 / HTTP :4318)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   OpenTelemetry Collector                    │
│  receivers: otlp, jaeger, prometheus, kafka                  │
│  processors: batch, memory_limiter, attributes, tail_sampling│
│  exporters: prometheus, otlp, jaeger, loki, elasticsearch  │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
              Tempo / Jaeger / Prometheus / vendor backend
```

### Spring Boot 3 integration

Boot 3.2+ Micrometer Tracing bridges to OTel:

```gradle
implementation 'io.micrometer:micrometer-tracing-bridge-otel'
implementation 'io.opentelemetry:opentelemetry-exporter-otlp'
```

```yaml
management:
  otlp:
    tracing:
      endpoint: http://otel-collector:4318/v1/traces
  tracing:
    sampling:
      probability: 0.05
  endpoints:
    web:
      exposure:
        include: health,prometheus,metrics
```

### Java agent (zero-code instrumentation)

```bash
java -javaagent:opentelemetry-javaagent.jar \
  -Dotel.service.name=order-api \
  -Dotel.exporter.otlp.endpoint=http://collector:4317 \
  -Dotel.traces.exporter=otlp \
  -Dotel.metrics.exporter=otlp \
  -Dotel.resource.attributes=deployment.environment=prod \
  -jar order-api.jar
```

Agent instruments: JDBC, Kafka, HTTP clients, Spring MVC/WebFlux, gRPC.

Trade-off: agent = fast adoption; SDK/manual = control over span names, attributes, cardinality.

### Collector config example

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 8192
  memory_limiter:
    limit_mib: 512
    check_interval: 1s
  attributes:
    actions:
      - key: deployment.environment
        action: insert
        value: prod
  tail_sampling:
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow
        type: latency
        latency:
          threshold_ms: 2000
      - name: probabilistic
        type: probabilistic
        probabilistic:
          sampling_percentage: 5

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch, attributes]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
```

### Semantic conventions (selected)

| Attribute | Example |
|---|---|
| `service.name` | `order-api` |
| `deployment.environment` | `prod` |
| `http.route` | `/api/orders/{id}` |
| `http.response.status_code` | `503` |
| `db.system` | `postgresql` |
| `peer.service` | `payment-api` |

Use conventions — Grafana/Tempo service maps depend on them.

### Production scenario: collector OOM during traffic spike

**Problem.** Black Friday — OTel Collector pods OOMKill every 10 minutes; traces dropped; metrics gaps.

**Cause.** No `memory_limiter` processor; batch size huge; 100% sampling enabled "for the event"; exporters slower than ingest.

**Solution.**

1. Enable `memory_limiter` + `batch` with sane sizes.
2. Drop sampling to 5% head + tail sample errors/slow.
3. Scale collector horizontally with load balancer.
4. Separate collectors for traces (heavy) vs metrics.
5. Monitor collector's own metrics: `otelcol_processor_refused_spans`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Multiple agents (OTel + legacy Zipkin + New Relic) | Duplicate spans, double overhead |
| Wrong `service.name` per pod (includes pod name) | Service map shows 500 "services" |
| Exporting logs+traces+metrics one pipeline | Backpressure affects all signals |
| No TLS on OTLP in prod | Data leak on cluster network |
| Ignoring `resource` attributes | Cannot filter prod vs staging |

---

## 8. Metrics & Monitoring

### Core concept

**Metrics** are numeric measurements aggregated over time — counters (always increase), gauges (up/down), histograms (distributions). **Monitoring** is the practice of collecting metrics, visualizing them, and comparing to thresholds or SLOs.

Metric types (Prometheus model):

| Type | Use | Example |
|---|---|---|
| **Counter** | Total events | `http_requests_total{status="500"}` |
| **Gauge** | Current value | `jvm_memory_used_bytes`, `queue_depth` |
| **Histogram** | Distribution + buckets | `http_request_duration_seconds_bucket{le="0.5"}` |
| **Summary** | Client-side quantiles (avoid in multi-pod unless you know implications) | legacy |

### What to instrument

**Inbound (your API):**

- Request count by route, method, status
- Latency histogram by route
- Active requests gauge
- Error rate

**Outbound (dependencies):**

- Client request count/latency by dependency name
- Connection pool active/idle/pending
- Circuit breaker state (Resilience4j exports)

**Runtime:**

- JVM heap, GC pause, threads
- CPU (container limit aware)
- Kafka consumer lag

**Business (careful with cardinality):**

- Orders created / minute
- Payments failed by `error_code` (low cardinality enum)
- NOT `orders_created{userId="..."}`

### Micrometer → Prometheus

Spring Boot Actuator exposes `/actuator/prometheus`:

```yaml
management:
  metrics:
    tags:
      application: ${spring.application.name}
      env: ${spring.profiles.active}
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 100ms,500ms,1s,2s
  endpoints:
    web:
      exposure:
        include: prometheus,health,metrics
```

Custom metric:

```java
@Service
public class OrderService {

    private final Counter ordersCreated;
    private final Timer checkoutDuration;

    public OrderService(MeterRegistry registry) {
        this.ordersCreated = Counter.builder("orders.created")
            .description("Orders successfully created")
            .tag("channel", "web")
            .register(registry);
        this.checkoutDuration = Timer.builder("checkout.duration")
            .publishPercentileHistogram()
            .register(registry);
    }

    public Order createOrder(CreateOrderRequest req) {
        return checkoutDuration.record(() -> {
            Order order = persist(req);
            ordersCreated.increment();
            return order;
        });
    }
}
```

### Production scenario: metric cardinality explosion

**Problem.** Prometheus memory grows from 8 GB to 64 GB over two weeks. Scrape duration 45s. Query timeout on dashboards.

**Cause.** Developer added tag `uri` with full path including IDs: `/api/orders/8821`, `/api/orders/8822` — millions of series.

**Fix.**

```java
// WRONG
.tag("uri", request.getRequestURI())

// RIGHT — template route
.tag("uri", routeTemplate) // /api/orders/{id}
```

Use `http.server.requests` built-in with `uri` tag from Spring MVC route matching, not raw URI. Add lint rule in PR: no high-cardinality tags.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Counters reset on pod restart treated as rate error | False spike alerts (use `rate()` correctly) |
| Histogram buckets misaligned with SLO | SLO dashboard lies |
| Scraping `/metrics` without auth | Internal metrics leaked |
| Different metric names per service | Cannot build platform dashboards |
| Summary quantiles averaged across pods | Wrong p99 |

---

## 9. Prometheus

### Core concept

**Prometheus** is a pull-based time-series database: it scrapes HTTP endpoints on an interval, stores samples, evaluates PromQL alerts, optionally federates or remote-writes to long-term storage (Mimir, Cortex, Thanos).

Architecture:

```
┌──────────────┐     scrape /metrics      ┌──────────────┐
│  order-api   │ ◄─────────────────────── │  Prometheus  │
│  :8080       │                          │  server      │
└──────────────┘                          └──────┬───────┘
┌──────────────┐     scrape                     │
│ payment-api  │ ◄────────────────────────────┤
└──────────────┘                                │
┌──────────────┐     scrape                     ▼
│ node-exporter│ ◄──────────────────────  Alertmanager
└──────────────┘                                │
                                                ▼
                                          Grafana / PagerDuty
```

### Scrape config (Kubernetes)

```yaml
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
```

Pod annotations:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8080"
    prometheus.io/path: "/actuator/prometheus"
```

### Essential PromQL

**Request rate (5xx):**

```promql
sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m])) by (application)
```

**Error ratio:**

```promql
sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
/
sum(rate(http_server_requests_seconds_count[5m]))
```

**Latency p99 (histogram):**

```promql
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket[5m])) by (le, application)
)
```

**CPU vs limit (container):**

```promql
sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (pod)
/
sum(kube_pod_container_resource_limits{resource="cpu"}) by (pod)
```

### Recording rules

Pre-aggregate expensive queries:

```yaml
groups:
  - name: http_recording
    interval: 30s
    rules:
      - record: job:http_requests:rate5m
        expr: sum(rate(http_server_requests_seconds_count[5m])) by (job, status)
      - record: job:http_requests_latency:p99_5m
        expr: histogram_quantile(0.99, sum(rate(http_server_requests_seconds_bucket[5m])) by (le, job))
```

### Production scenario: Prometheus scrape timeouts during rollout

**Problem.** During rolling deploy, alert `PrometheusTargetDown` fires for half the fleet every minute. On-call fatigue.

**Cause.** Scrape interval 15s; pod startup 40s; readiness probe passes before Actuator/prometheus endpoint ready; short pod lifetime during rollout.

**Solution.**

1. Readiness probe includes `/actuator/prometheus` or `/actuator/health` with `liveness`/`readiness` groups.
2. Increase `scrape_timeout` modestly; use `honor_timestamps`.
3. Alert on **SLO burn**, not individual target down during deploy.
4. `min_ready_seconds` on Deployment to stabilize before receiving traffic.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `rate()` on gauge | Nonsense graphs |
| `rate()` with range shorter than 2× scrape interval | Missing data, spikes |
| Alert on `absent()` without `for:` duration | Page on every deploy |
| No retention planning | Disk full; silent data loss |
| Federation without `--enable-feature=remote-write-receiver` mismatch | Gaps in global view |

---

## 10. Grafana

### Core concept

**Grafana** visualizes metrics (Prometheus), logs (Loki), traces (Tempo/Jaeger), and mixed **dashboards**. Production value is not pretty graphs — it is **correlation**: exemplars → trace → logs, unified alerting, SLO dashboards.

### Dashboard design principles

1. **User journey first** — checkout dashboard before JVM heap dashboard.
2. **RED panels** per service (section 12).
3. **USE panels** for nodes/databases (section 13).
4. **SLO burn** panel with multi-window (section 15).
5. **Variables** — `$service`, `$env`, `$cluster` for reuse.
6. **Annotations** — deploy markers from CI/CD.

### Example dashboard layout — checkout

```
Row 1: SLO — success rate (30d), error budget remaining, burn rate 1h/6h
Row 2: Golden Signals — latency p50/p99, RPS, error %, saturation (thread pool)
Row 3: Dependencies — RED per outbound client (payment, inventory)
Row 4: Traces — link to Tempo filtered by service + min duration
Row 5: Logs — Loki panel correlation_id search (linked variables)
Row 6: Infra — CPU/memory (only after app signals abnormal)
```

### Exemplars (metrics → traces)

Enable exemplars on histograms in Micrometer:

```yaml
management:
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
```

Prometheus scrape with exemplar support; Grafana histogram panel → click bucket → open trace.

### Grafana alerting (unified)

```yaml
# Alert rule — high error rate
expr: |
  (
    sum(rate(http_server_requests_seconds_count{application="order-api", status=~"5.."}[5m]))
    /
    sum(rate(http_server_requests_seconds_count{application="order-api"}[5m]))
  ) > 0.05
for: 10m
labels:
  severity: critical
annotations:
  summary: order-api error rate above 5%
  runbook: https://wiki.example.com/runbooks/order-api-errors
```

Prefer **Alertmanager** routing for on-call rotation, silences, inhibition (don't page on dependency if root cause already firing).

### Production scenario: dashboard sprawl

**Problem.** 400 dashboards; nobody knows which is canonical; new engineer duplicates "Order API v2 Final."

**Cause.** No dashboard-as-code; no folder ownership; copy-paste instead of variables.

**Solution.**

- **Jsonnet / Terraform** for dashboards in Git.
- **Golden dashboard template** per service generated from cookiecutter.
- **Folder per team** with CODEOWNERS.
- Deprecate duplicates; redirect UIDs.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `$__interval` too small on high-cardinality query | Grafana OOM, Prometheus overload |
| No datasource provisioning in Git | Drift between staging/prod Grafana |
| Alerts without `for:` | Flapping pages |
| Dashboard time range "Last 5 minutes" saved | Miss slow burns |
| Mixed percent units (0.05 vs 5%) | Wrong thresholds |

---

## 11. Golden Signals — Latency, Traffic, Errors, Saturation

### Core concept

Google SRE **Four Golden Signals** — the minimum set to watch for any user-serving tier:

| Signal | Question | Microservice examples |
|---|---|---|
| **Latency** | How long do requests take? | HTTP server histogram, gRPC deadline exceeded |
| **Traffic** | How much demand? | RPS, Kafka messages/sec, queue ingress |
| **Errors** | What fraction fails? | HTTP 5xx, gRPC `INTERNAL`, business `payment_declined` |
| **Saturation** | How "full" is the resource? | Thread pool queue, CPU throttling, DB connections, disk IO wait |

**Latency nuance:** measure **successful** request latency separately from errors — a fast 503 misleads if blended into p99.

```promql
# Success latency p99
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket{status!~"5.."}[5m])) by (le)
)
```

### Traffic

```promql
sum(rate(http_server_requests_seconds_count[5m])) by (application)
```

Watch for:

- Traffic drop (routing failure, DNS, CDN misconfig)
- Traffic spike (attack, retry storm, marketing event)

### Errors

Split layers:

| Layer | Metric |
|---|---|
| HTTP transport | 5xx, 502 from gateway |
| Application | 4xx business validation (may be OK) |
| Client perspective | Synthetic check failures |

```promql
sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m])) by (application, uri)
```

### Saturation

| Resource | Signal |
|---|---|
| JVM threads | `tomcat_threads_busy`, `executor_active` |
| Connection pool | HikariCP `pending`, `active` |
| CPU | CFS throttling `container_cpu_cfs_throttled_seconds_total` |
| Memory | OOMKilled pods, heap after GC |
| Disk | DB `disk_usage`, Kafka log dir |
| Network | Bandwidth cap, ENI limits |

Saturation often **precedes** errors — thread pool full → timeouts → 503.

### Production scenario: low CPU, high latency

**Problem.** p99 latency 8s; CPU 15%; no errors in app logs.

**Diagnose saturation not CPU:**

- Thread pool 200/200 busy — all blocked on JDBC.
- HikariCP `pending` connections growing.
- Postgres `active_connections` at max.

**Fix.** Increase pool cautiously; fix slow query; add timeout; scale DB read replicas; bulkhead slow endpoints.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Alert only on errors, not latency | Slow bleed outages |
| Latency includes health-check paths | Diluted p99 |
| Ignoring saturation gauges | Surprise hard failures |
| Traffic measured at wrong layer (CDN only) | Backend starved unnoticed |

---

## 12. RED Method

### Core concept

**RED** — for **request-driven services** (microservices, APIs):

| Letter | Metric |
|---|---|
| **R**ate | Requests per second |
| **E**rrors | Failed requests per second |
| **D**uration | Distribution of request latency |

Tom Wilkie (Grafana) proposed RED as the service-level counterpart to USE (resources).

### RED PromQL template

```promql
# Rate
sum(rate(http_server_requests_seconds_count{application="$service"}[5m]))

# Errors
sum(rate(http_server_requests_seconds_count{application="$service", status=~"5.."}[5m]))
/
sum(rate(http_server_requests_seconds_count{application="$service"}[5m]))

# Duration p99
histogram_quantile(0.99,
  sum(rate(http_server_requests_seconds_bucket{application="$service"}[5m])) by (le)
)
```

Apply RED to:

- Each microservice inbound HTTP/gRPC
- Each outbound client (`http.client.requests` or custom)
- API gateway routes
- GraphQL operations (low-cardinality operation names)

### RED per dependency dashboard

```
payment-api (inbound RED)
  → calls stripe (outbound RED)
  → calls fraud-scoring (outbound RED)
inventory-api (inbound RED)
  → calls postgres (client RED if instrumented)
```

When checkout is slow, compare RED of each outbound — the one with Duration spike without Error spike is likely slow dependency, not hard failure.

### Production scenario: green error rate, angry users

**Problem.** Error rate 0.1% (within SLO). Users complain checkout "hangs."

**Cause.** Duration degraded — p99 12s; errors low because requests eventually timeout at gateway with 504 counted at gateway not service.

**Fix.** RED on **synthetic checkout** + **client-side RUM**; SLO on latency; alert Duration even when Errors low.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| RED on wrong metric name per framework | Broken cross-service view |
| Duration as average only | Miss tail latency |
| Including `/health` in Rate | Noise |
| No RED on async consumers | Blind spot on Kafka processing |

---

## 13. USE Method

### Core concept

**USE** — for **resources** (CPU, memory, disk, network, connection pools, Kafka brokers):

| Letter | Question |
|---|---|
| **U**tilization | Percent time resource busy |
| **S**aturation | Extra work queued (queue depth, wait time) |
| **E**rrors | Device/controller errors |

Tom Wilkie: USE for resources, RED for services.

### USE examples

**CPU (node):**

```promql
# Utilization
1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))

# Saturation — run queue length
node_load1 / count(node_cpu_seconds_total{mode="idle"})

# Errors — throttling (containers)
rate(container_cpu_cfs_throttled_seconds_total[5m])
```

**Memory:**

```promql
# Utilization
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"}

# Saturation — GC time
rate(jvm_gc_pause_seconds_sum[5m])

# Errors — OOM events (kube)
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}
```

**Database connections (HikariCP):**

```promql
# Utilization
hikaricp_connections_active / hikaricp_connections_max

# Saturation
hikaricp_connections_pending

# Errors
rate(hikaricp_connections_timeout_total[5m])
```

**Disk:**

```promql
# Utilization
1 - node_filesystem_avail_bytes / node_filesystem_size_bytes

# Saturation — IO wait
rate(node_disk_io_time_weighted_seconds_total[5m])

# Errors
rate(node_disk_io_errors_total[5m])
```

### When to apply USE vs RED

| Layer | Method |
|---|---|
| HTTP API service | RED |
| Kubernetes node | USE |
| Postgres server | USE |
| Redis | USE |
| Kafka consumer group | RED on processing + USE on broker disk |
| Thread pool inside JVM | USE (utilization + queue) |

### Production scenario: connection pool exhaustion

**Problem.** `payment-api` errors spike briefly every hour.

**USE on HikariCP:**

- Utilization pegged at 100%
- Saturation: `pending` > 0 for 30s
- Errors: connection acquire timeout counter increasing

**Cause.** Long-running report query holds connections; checkout traffic competes.

**Fix.** Separate read replica datasource; bulkhead pools; query timeout; `maxLifetime` tuning.

---

## 14. SLI, SLO, SLA

### Core concept

| Term | Definition |
|---|---|
| **SLI** (Indicator) | Measurable aspect of service level — e.g. proportion of successful requests < 500ms |
| **SLO** (Objective) | Target for SLI — e.g. 99.9% success over 30 days |
| **SLA** (Agreement) | Contract with consequences — refunds, credits; usually looser than internal SLO |

Relationship:

```
SLI (measure) → SLO (internal goal) → SLA (customer contract)
                     │
                     └── error budget = 100% - SLO
```

### Good SLI properties

- **User-centric** — reflects user pain (checkout success, search results loaded)
- **Measurable** — from metrics/logs/traces, not opinions
- **Stable** — definition does not change weekly

### Example SLIs

| Service | SLI | Measurement |
|---|---|---|
| Checkout API | Availability | `2xx` responses / total (exclude 4xx validation) |
| Checkout API | Latency | proportion of requests < 800ms |
| Search | Freshness | index lag < 60s |
| Batch export | Correctness | jobs completed without error / total jobs |

### SLO examples

```yaml
# Checkout availability
slo: 99.95% over 30 days
sli: |
  sum(rate(http_server_requests_seconds_count{uri="/api/checkout", status=~"2.."}[5m]))
  /
  sum(rate(http_server_requests_seconds_count{uri="/api/checkout"}[5m]))

# Checkout latency
slo: 99% of requests < 800ms over 30 days
sli: |
  histogram_share(
    sum(rate(http_server_requests_seconds_bucket{uri="/api/checkout"}[5m])) by (le),
    800ms
  )
```

### SLA vs SLO in practice

- **SLO 99.95%** internal
- **SLA 99.9%** customer-facing with service credits below that
- Gap (0.05%) is buffer for deployments, incidents, dependency failures

Never set SLO = 100% — you will never deploy, never take risk, never sleep.

### Production scenario: measuring wrong SLI

**Problem.** Team SLO "99.99% uptime" based on Kubernetes pod Ready. SLA breached during incident where pods were Ready but returning 503 from bad config.

**Cause.** **Infrastructure SLI** ≠ **user-perceived SLI**.

**Fix.** SLI from **load balancer access logs** or **synthetic probes** hitting `/api/checkout` with real payload; exclude `/health` from user SLO.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| SLO on mean latency | Tail violations ignored |
| Including client 400 in error SLI | SLO drops on bad users |
| Too many SLOs (50 per team) | Alert fatigue; nothing prioritized |
| SLO window too short (1h) | Noise from normal variance |
| No SLO documented | Debates during incident about "acceptable" |

---

## 15. Error Budgets

### Core concept

**Error budget** = allowed unreliability = `1 - SLO` over rolling window.

For 99.9% monthly availability:

```
Budget = 0.1% × 30 days × 24h × 60min = 43.2 minutes downtime equivalent
```

Not all errors consume budget equally — define **budget burn** in terms of SLI shortfall.

### Burn rate alerting (Google SRE multi-window)

Fast burn (1h window) pages immediately — budget exhausted in hours.
Slow burn (3d window) tickets — gradual leak.

```promql
# Simplified burn rate — error ratio / (1 - SLO)
(
  sum(rate(http_server_requests_seconds_count{status=~"5.."}[1h]))
  /
  sum(rate(http_server_requests_seconds_count[1h]))
) / (1 - 0.999) > 14.4
```

Multi-window, multi-burn-rate alerts (conceptual):

| Alert | Short window | Long window | Burn factor | Action |
|---|---|---|---|---|
| Page | 1h | - | 14.4× | Immediate |
| Page | 6h | 30d | 6× | Serious |
| Ticket | 3d | 30d | 1× | Investigate trend |

Tools: [Sloth](https://sloth.dev), [Pyrra](https://github.com/pyrra-dev/pyrra), Grafana SLO app, Datadog SLO.

### Error budget policy

When budget **remains**:

- Ship features
- Increase deploy frequency
- Accept risky migrations

When budget **depleted**:

- Freeze feature releases
- Focus on reliability work
- Reduce deploy rate; more canaries
- Postmortem required for new incidents

### Production scenario: feature freeze ignored

**Problem.** Error budget exhausted for checkout SLO three weeks running. Product still ships daily. Incidents multiply.

**Cause.** No governance — SLO is dashboard decoration.

**Solution.** Error budget policy in engineering handbook; CI gate blocks deploy to checkout services when budget < 10%; weekly SLO review with product.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Alert on absolute error count | Pages at traffic spike despite healthy ratio |
| No burn rate — only monthly snapshot | Late detection |
| Shared budget across unrelated services | One bad batch job blocks mobile deploy |
| Resetting budget manually after incident | Learns wrong lessons |

---

## 16. Alerting

### Core concept

**Alerting** connects observability signals to human action. A good alert is **actionable**, **urgent**, and **symptom-based** (user impact), not **cause-based** (CPU high) unless correlated.

Alert pipeline:

```
Prometheus/Grafana rule → Alertmanager → route by severity/team → PagerDuty/Slack → runbook
```

### Alert design principles

1. **Page on symptoms** — SLO burn, synthetic failure, error rate on critical path.
2. **Ticket on causes** — disk 80%, certificate expires in 14 days.
3. **Every page has runbook** — link in annotation.
4. **`for:` duration** — suppress flapping (5–15m for error rate).
5. **Inhibition** — if `kube_node_not_ready`, don't page every pod on that node.
6. **Silences with expiry** — maintenance windows documented.

### Alert tiers

| Severity | Response | Example |
|---|---|---|
| P1 / critical | Page on-call 24/7 | Checkout SLO fast burn |
| P2 / high | Page business hours | Search latency degraded |
| P3 / warning | Slack next day | Disk 75% |
| P4 / info | Dashboard only | Certificate expires in 30 days |

### Example Alertmanager route

```yaml
route:
  receiver: default-slack
  group_by: ['alertname', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - match:
        severity: critical
      receiver: pagerduty-oncall
    - match:
        team: payments
      receiver: payments-slack

receivers:
  - name: pagerduty-oncall
    pagerduty_configs:
      - routing_key: <key>
  - name: payments-slack
    slack_configs:
      - channel: '#payments-alerts'

inhibit_rules:
  - source_match:
      alertname: KubernetesNodeNotReady
    target_match_re:
      alertname: Pod.*
    equal: ['node']
```

### Anti-patterns

| Bad alert | Why |
|---|---|
| `CPU > 80%` | Not actionable; may be fine |
| `Pod restarted` | Kubernetes self-heals |
| `Any log line ERROR` | Volume impossible |
| `Latency p99 > 1s` without traffic context | False during low traffic |
| Duplicate alerts per pod | 200 pages for one issue |

### Production scenario: alert fatigue during dependency outage

**Problem.** Payment provider down. 40 services page simultaneously with "connection refused to payment-api."

**Cause.** Every service alerts on its outbound client errors without routing aggregation.

**Solution.**

1. **Upstream golden alert** on `payment-api` SLO only pages payments team.
2. Downstream services alert **only if** their **user-facing SLO** burns, not raw client error.
3. Alertmanager **group_by** service; one notification with summary.
4. **Runbook** first step: check dependency status dashboard.

### Synthetic monitoring

Black-box probes from outside the cluster:

```yaml
# Grafana Cloud / Pingdom / custom
probe:
  url: https://api.example.com/api/checkout/health
  interval: 60s
  assertions:
    - status_code: 200
    - max_latency_ms: 500
```

Catches: DNS, CDN, WAF, certificate, routing failures invisible inside cluster.

---

## 17. Spring Boot / Micrometer Production Integration

### Full stack reference config

```yaml
spring:
  application:
    name: order-api

management:
  endpoints:
    web:
      exposure:
        include: health,prometheus,metrics,loggers
  endpoint:
    health:
      show-details: when_authorized
      probes:
        enabled: true
      group:
        liveness:
          include: livenessState
        readiness:
          include: readinessState,db
  metrics:
    tags:
      application: ${spring.application.name}
      env: ${spring.profiles.active}
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 100ms,300ms,500ms,1s,2s
  tracing:
    sampling:
      probability: 0.05
    propagation:
      type: w3c,b3
  otlp:
    tracing:
      endpoint: http://otel-collector.observability:4318/v1/traces
    metrics:
      export:
        enabled: true
        endpoint: http://otel-collector.observability:4318/v1/metrics

logging:
  pattern:
    level: "%5p [${spring.application.name:},%X{trace_id:-},%X{span_id:-},%X{correlation_id:-}]"
```

### Dependencies (Gradle)

```gradle
implementation 'org.springframework.boot:spring-boot-starter-actuator'
implementation 'io.micrometer:micrometer-registry-prometheus'
implementation 'io.micrometer:micrometer-tracing-bridge-otel'
implementation 'io.opentelemetry:opentelemetry-exporter-otlp'
implementation 'net.logstash.logback:logstash-logback-encoder:7.4'
```

### Health checks vs metrics

| Endpoint | Use |
|---|---|
| `/actuator/health/liveness` | Kubernetes liveness — JVM up |
| `/actuator/health/readiness` | Ready for traffic — DB up |
| `/actuator/prometheus` | Scraped metrics — not for K8s probe |

**Never** put optional dependencies on liveness — pod restart loop during partial outage.

### Production scenario: Actuator exposed publicly

**Problem.** Security scan finds `/actuator/env`, `/actuator/heapdump` on public internet.

**Fix.**

```yaml
management:
  endpoints:
    web:
      base-path: /actuator
      exposure:
        include: health,prometheus
  server:
    port: 8081  # separate management port — network policy internal only
```

Or Spring Security restrict `/actuator/**` to internal CIDR / mTLS.

---

## 18. Production Debugging Playbook

When users say "it's slow" and dashboards are confusing, walk this list in order.

1. **Confirm user impact.** Synthetic checks failing? Support ticket pattern? Which region/device?

2. **Check SLO burn dashboards** — fast burn alert firing? Which SLI — availability or latency?

3. **Golden signals on edge** — CDN/LB error rate, RPS drop/spike, p99 latency, connection queue.

4. **Service RED** — which microservice shows Duration or Errors anomaly first? That's your entry point, not necessarily root cause.

5. **Outbound RED from that service** — which dependency Duration spiked?

6. **Open exemplar trace** — longest span name; check `peer.service`, `db.statement` (sanitized), retry spans.

7. **Logs with trace_id / correlation_id** — business error codes, exception stack, "connection pool timeout."

8. **USE on resources** — thread pool, HikariCP pending, CPU throttling, Kafka lag, DB connections.

9. **Recent change correlation** — deploy, feature flag, config push, certificate expiry, DNS TTL, scale event.

10. **Mitigate before root cause** — scale, circuit open on bad dep, increase pool (temporary), shed load, rollback canary.

11. **Communicate** — status page updates based on **user SLI**, not "we're investigating CPU."

12. **Post-incident** — missing signal? add SLI; missing correlation? fix propagation; alert noise? tune burn rates.

### Quick commands

```bash
# Prometheus instant query
curl -G 'http://prometheus:9090/api/v1/query' \
  --data-urlencode 'query=sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m])) by (application)'

# Find pod logs with correlation ID (kubectl fallback)
kubectl logs -l app=order-api --since=10m | jq 'select(.correlation_id=="req-abc")'

# OTel collector health
curl -s http://otel-collector:13133/

# Check trace export errors
curl -s http://otel-collector:8888/metrics | grep refused
```

### Time synchronization reminder

If logs and metrics disagree on event order by minutes — check **NTP/chrony** on nodes. Distributed debugging requires clocks within ~100ms.

---

## 19. Quick Decision Matrix

| Situation | Do this |
|---|---|
| New microservice going to prod | Structured JSON logs + W3C trace propagation + RED metrics + `/actuator/prometheus` |
| Cannot find logs during incident | Search by `correlation_id` or `trace_id`, not grep email in message body |
| Prometheus OOM / slow queries | Audit metric cardinality; remove `userId`/`orderId` labels; recording rules |
| Traces incomplete at Kafka boundary | Inject/extract OTel context in record headers |
| `@Async` logs lose trace | Micrometer Context Propagation + TaskDecorator copying MDC |
| WebFlux lost context | Reactor Context + context-propagation library, not thread-local MDC alone |
| Alert fatigue | Page on SLO burn; inhibit node→pod storms; group_by service |
| CPU alert useless | Switch to Golden Signals + USE saturation (pools, queues) |
| User SLO vs pod Ready mismatch | Measure at load balancer or synthetic probe on business endpoint |
| Long-term metric retention | Prometheus remote_write → Mimir/Thanos; don't scale Prometheus disk forever |
| Log cost too high | ILM + drop DEBUG + Loki label-first queries + sampling noisy info |
| Vendor lock-in concern | OpenTelemetry SDK + Collector; export OTLP to multiple backends |
| PCI/PII in observability | Scrub at collector; never log PAN; hash user id in traces |
| Deploy causes trace gaps | Readiness only after exporter ready; avoid 100% sampling spike |
| Multi-tenant SaaS | `tenant_id` in logs (keyword); low-cardinality tenant tier in metrics, not tenant UUID |
| Batch job observability | Correlation ID per job run; span per batch chunk; lag metric on queue |
| Mobile client errors | Return `X-Correlation-Id`; RUM SDK for client latency and crash correlation |
| Choosing RED vs USE | RED on services; USE on CPU/memory/pools/disks/brokers |
| Error budget exhausted | Feature freeze on affected SLO; reliability sprint; no vanity deploys |
| Checkout critical path | Higher trace sampling; dedicated SLO; synthetic probe every 60s |
| Legacy service no instrumentation | OTel Java agent sidecar first; refactor to manual spans later |
| Grafana dashboard chaos | Dashboard-as-code; one golden template per service |
| On-call cannot find runbook | Alert annotation `runbook_url` required in CI lint for alert rules |

---

## 20. Interview Q&A

### Q1. What is observability and how does it differ from monitoring?

**A.** Monitoring watches **known** failure modes with predefined metrics and alerts — "is CPU high?" Observability is the ability to answer **arbitrary** questions about system behavior from exported telemetry without shipping new code — "why did EU checkout fail for premium users between 14:00–14:15?" Monitoring is a subset; observability requires correlated logs, metrics, and traces with enough context (IDs, attributes) to debug novel failures.

### Q2. Explain the three pillars of observability.

**A.** **Metrics** — numeric time-series for rates, errors, latency aggregates; cheap, great for alerting. **Logs** — discrete events with detail and business context; expensive at volume. **Traces** — request-scoped span trees across services; show where time went. Together they answer "how many" (metrics), "what exactly" (logs), and "where" (traces). Modern practice links them via `trace_id` and exemplars.

### Q3. What is a correlation ID and how is it different from a trace ID?

**A.** A **correlation ID** is a business or support-scoped identifier for a user journey, generated at the edge and propagated through all services and messages — often returned to the client. A **trace ID** (W3C) identifies a distributed trace for telemetry, subject to sampling. They should both propagate; correlation ID survives support workflows even if trace was not sampled.

### Q4. How does distributed tracing work?

**A.** Each operation emits a **span** with timing and metadata. Spans share a `trace_id`; child spans reference `parent_span_id`. **Context propagation** (W3C `traceparent` header) passes active span context across HTTP, gRPC, and message queues. A collector receives spans; the UI reconstructs the tree. Sampling reduces volume while tail sampling can keep errors and slow traces.

### Q5. What is OpenTelemetry and why use it?

**A.** OpenTelemetry is the vendor-neutral standard (CNCF) for traces, metrics, and logs — unified APIs, SDKs, auto-instrumentation, and Collector for routing/processing. It avoids lock-in to Datadog/New Relic/Jaeger-specific agents and lets you export OTLP to multiple backends. Spring Boot 3 integrates via Micrometer Tracing bridge.

### Q6. What are the Four Golden Signals?

**A.** From Google SRE: **Latency** (time to serve requests, success vs error separately), **Traffic** (demand), **Errors** (failed requests rate), **Saturation** (how full resources are — queues, pools, throttling). They apply to user-facing tiers; saturation often predicts errors before they appear.

### Q7. Explain the RED method.

**A.** RED applies to request-driven services: **Rate** (requests/sec), **Errors** (failed requests/sec or ratio), **Duration** (latency distribution, especially tail). Use RED on each service inbound and outbound dependencies. It complements USE which applies to resources.

### Q8. Explain the USE method.

**A.** USE applies to resources: **Utilization** (percent busy), **Saturation** (queued work / backpressure), **Errors** (device/controller errors). Examples: CPU utilization + run queue; connection pool active/max + pending acquires; disk utilization + IO wait. USE for nodes, databases, pools; RED for HTTP services.

### Q9. What is an SLI, SLO, and SLA?

**A.** **SLI** — measured indicator of service behavior (e.g. proportion of requests < 500ms). **SLO** — internal target for SLI (99.9% over 30 days). **SLA** — external contract with business consequences, usually stricter penalty threshold than internal SLO. SLO drives engineering decisions via error budgets.

### Q10. What is an error budget and how do you use it?

**A.** Error budget = `1 - SLO` — allowed unreliability over a window (e.g. 99.9% → 43 minutes/month equivalent). While budget remains, take risks and ship features. When depleted, prioritize reliability, freeze risky releases. Alert on **burn rate** (how fast budget consumes), not just absolute errors.

### Q11. How do you prevent metric cardinality explosion in Prometheus?

**A.** Never label metrics with unbounded values (user ID, order ID, raw URL). Use templated routes (`/api/orders/{id}`), bounded enums, and code review lint rules. Drop high-cardinality labels at scrape or export. Use logs/traces for per-entity detail. Monitor `prometheus_tsdb_symbol_table_size` and series count.

### Q12. Head-based vs tail-based sampling?

**A.** **Head-based** decides at trace start (e.g. 5% random) — simple, low memory, but may discard important traces early. **Tail-based** decides after trace completes — can keep all errors/slow traces while sampling happy paths — requires collector buffering, higher complexity. Production often combines probabilistic head sampling with tail policies for errors/latency.

### Q13. How do you correlate logs and traces?

**A.** Inject `trace_id` and `span_id` into logging MDC from OpenTelemetry/Micrometer context; structured JSON logs include those fields. In Grafana, click exemplar on histogram → trace → query Loki/OpenSearch with same `trace_id`. Also propagate business `correlation_id` for support workflows when trace was not sampled.

### Q14. What makes a good production alert?

**A.** Symptom-based (SLO burn, synthetic failure), actionable (clear runbook), urgent-only (pages rare), with `for:` duration to reduce flapping, routed to owning team, inhibited when upstream cause already firing. Avoid paging on CPU, pod restarts, or any ERROR log line.

### Q15. How would you design observability for a Kafka-based event flow?

**A.** Propagate trace context in record headers; consumer creates child span linked via context. Metrics: consumer lag, processing rate, error rate per topic, rebalance events. Logs: `correlation_id`, `trace_id`, partition/offset. RED on consumer handler; USE on broker disk and network. Alert on lag SLO burn, not just lag absolute value without traffic context.

### Q16. What is log aggregation and why not just kubectl logs?

**A.** Log aggregation collects logs from all pods/nodes into centralized storage with parsing, enrichment, retention, and search. `kubectl logs` does not scale across hundreds of replicas, survives no pod death, supports no cross-service correlation, and has no retention/compliance controls.

### Q17. How do exemplars connect metrics to traces?

**A.** Histogram buckets attach sample trace IDs to specific observations (Prometheus exemplars). In Grafana, clicking a latency bucket jumps to the exact trace that contributed to that bucket — bridging aggregate metrics and individual request debugging without querying all traces.

### Q18. What are common causes of broken distributed traces?

**A.** Missing propagation on async (`@Async`, reactive chains, custom thread pools), message queues without header injection, legacy services using different formats (B3 vs W3C) without translation, new trace started in scheduler jobs, instrumentation disabled on Feign/WebClient, load balancer stripping headers.

### Q19. How do you measure latency SLO correctly?

**A.** Use histogram with appropriate buckets near SLO threshold; compute proportion under threshold (histogram_share or similar). Measure at user boundary (synthetic or edge), not only internal service average. Separate success vs error latency. Use percentiles (p99) aligned with user pain, not mean.

### Q20. Prometheus pull vs push — when push?

**A.** Prometheus default is **pull** (scrape `/metrics`) — simple, service discovery friendly. **Pushgateway** or **remote_write** for short-lived jobs (batch), or OTel Collector receiving push then exposing for scrape. Avoid Pushgateway for long-lived service metrics — loses health signal if push stops.

### Q21. How does alerting on multi-window burn rates work?

**A.** Compare short-window error ratio to long-window budget consumption. Fast burn (e.g. 1h at 14× normal) pages immediately — budget gone in hours. Slower burn (6h/3d) warns before monthly budget exhausted. Reduces false positives from brief blips while catching serious outages early. Implement with Sloth/Pyrra or manual PromQL.

### Q22. What should structured logs always include?

**A.** ISO timestamp, level, service name, environment, message, `trace_id`, `span_id`, `correlation_id`, and bounded business context (error_code, tenant tier). Never log secrets, PAN, passwords, full JWT. Exception type and stack in structured field. Consistent schema across services for cross-search.

### Q23. How do you debug high p99 latency with low error rate?

**A.** RED Duration signal — check p99 vs p50 spread. Exemplars/traces on slow requests — find longest span (DB, external API, lock contention). USE on pools and threads — saturation without errors indicates queueing. Compare canary vs stable. Check deploy correlation, GC pauses, DNS, retry amplification.

### Q24. What is the role of OpenTelemetry Collector?

**A.** Vendor-neutral pipeline: receive OTLP/Jaeger/Prometheus, process (batch, sample, scrub PII, add attributes), export to Tempo/Jaeger/Prometheus/Loki/vendors. Enables tail sampling, central policy, and decoupling apps from backend credentials. Scale collectors independently of apps.

### Q25. How do liveness and readiness differ in observability context?

**A.** **Liveness** — process should restart if failing (JVM deadlocked). **Readiness** — should receive traffic (DB up, warm cache ready). Optional dependencies belong on readiness or custom health groups, not liveness. Metrics scraping should target ready pods; alerting on user SLOs, not kube Ready alone.

### Q26. Centralized logging vs log aggregation — same thing?

**A.** Related but distinct. **Centralized logging** is the outcome — logs in one searchable place. **Log aggregation** is the pipeline (collect, parse, enrich, route, store). You need aggregation architecture (Fluent Bit, Kafka buffer, OpenSearch/Loki) to achieve reliable centralized logging at scale.

### Q27. How would you reduce observability cost without losing debuggability?

**A.** Tail sampling for traces; log INFO default with dynamic DEBUG on canary; ILM hot/warm/delete; drop health-check logs at ingest; Loki for label queries; metric cardinality audit; recording rules instead of raw expensive queries; retain full traces for errors/slow only; business logs at WARN for expected validation failures.

### Q28. What is the difference between counters and gauges in alerting?

**A.** **Counters** monotonically increase — use `rate()` or `increase()` for alerts (requests/sec, errors/sec). **Gauges** go up/down — alert on absolute value (queue depth, memory used). Alerting `rate()` on a gauge produces nonsense. Histograms need `histogram_quantile` for latency alerts.

---

*Metrics tell you the patient has a fever; traces tell you which organ; logs tell you what they ate. If your correlation IDs stop at the gateway, your traces break at the first `@Async`, and your alerts fire on pod restarts — you do not have observability, you have expensive wallpaper. Instrument the request path once, correctly, and spend the rest of your career tuning SLOs instead of grep.*
