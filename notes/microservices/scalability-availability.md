# Microservices Scalability & Availability — Senior Production Reference

Spring Boot 3.x / Java 17+ / Kubernetes 1.28+. Cloud-agnostic patterns with AWS/GCP/Azure callouts where they matter. This is not a "add more pods" tutorial. It is the map of what actually breaks in production after you scale a checkout service to Black Friday traffic, discover connection pools are the real bottleneck, and learn that **autoscaling without capacity planning is just expensive failure with better graphs**.

---

## Table of Contents

1. [Mental Model: One Request Through the Capacity Stack](#1-mental-model-one-request-through-the-capacity-stack)
2. [Horizontal Scaling](#2-horizontal-scaling)
3. [Vertical Scaling](#3-vertical-scaling)
4. [Autoscaling](#4-autoscaling)
5. [Capacity Planning](#5-capacity-planning)
6. [High Availability](#6-high-availability)
7. [Multi-region Deployment](#7-multi-region-deployment)
8. [Disaster Recovery](#8-disaster-recovery)
9. [RPO and RTO](#9-rpo-and-rto)
10. [Connection Pooling](#10-connection-pooling)
11. [Resource Exhaustion](#11-resource-exhaustion)
12. [Spring Boot & Kubernetes Integration](#12-spring-boot-kubernetes-integration)
13. [Observability for Scale and Availability](#13-observability-for-scale-and-availability)
14. [Production Debugging Playbook](#14-production-debugging-playbook)
15. [Quick Decision Matrix](#15-quick-decision-matrix)
16. [Interview Q&A](#16-interview-qa)

---

## 1. Mental Model: One Request Through the Capacity Stack

Scalability is not "more servers." Availability is not "three replicas." Both are **layered constraints**: each hop has a finite throughput, a finite connection budget, and a failure domain. Adding pods without fixing pool math, state, or blast radius just moves the bottleneck and often makes outages worse (retry storms, connection stampedes, cache inconsistency).

```
Client
  └─ DNS / CDN / WAF / Global LB          (geo, cache, DDoS absorption)
       └─ Regional Ingress / API Gateway   (TLS, rate limit, routing)
            └─ Service mesh / LB           (mTLS, retries, circuit break)
                 └─ Pod (replica N)
                      ├─ Tomcat/Netty thread budget
                      ├─ JVM heap / GC pause budget
                      ├─ HTTP client pool → downstream services
                      ├─ HikariCP → database
                      ├─ Redis / cache client pool
                      └─ Kafka producer / consumer buffers
                           └─ Stateful tier (DB, cache, queue)
                                └─ Disk IOPS, replication lag, connection limit
```

Three objects you must keep distinct:

| Object | Question it answers | Typical signal |
|---|---|---|
| **Throughput** | How many successful requests per second can this path sustain? | RPS at target p99 latency, not peak RPS at 30s timeouts |
| **Saturation** | How full are the finite resources right now? | CPU%, pool pending, thread queue depth, DB `max_connections` |
| **Availability** | What fraction of time is the service usable for its SLO? | Error budget burn, uptime vs **successful** requests |

A **503 from your service during scale-up** may mean HPA added pods but **readiness is slow**, the **DB connection limit** was hit, or **downstream pool exhaustion** — not "we need more CPU." Mixing horizontal scale with connection pool starvation is the single most common senior misdiagnosis during traffic spikes.

### The scalability triangle

```
                    ┌─────────────────┐
                    │ Stateless compute │
                    │ (scale out)       │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────────┐     │     ┌────────▼────────┐
     │ Pool + thread    │     │     │ Data tier limits │
     │ budgets per pod  │     │     │ (connections,    │
     └─────────────────┘     │     │  IOPS, lag)      │
                             │     └─────────────────┘
                    ┌────────▼────────┐
                    │ Traffic shaping  │
                    │ (cache, shed,    │
                    │  queue, limit)   │
                    └─────────────────┘
```

Remove any leg and "we autoscale" becomes "we autoscale into a database outage."

### Production scenario: Black Friday — pods healthy, checkout dead

**Problem.** Order service HPA scales 12 → 80 pods. CPU 40%. Error rate 35% on `POST /api/orders`. PostgreSQL logs: `FATAL: sorry, too many clients already`. HikariCP metrics show `hikaricp.connections.pending` pegged at max.

**Cause chain:**

1. Each pod: `maximum-pool-size: 20` → 80 × 20 = **1600** client connections attempted.
2. RDS `max_connections` = 500 (default-ish for db.r6g.large).
3. New pods pass liveness (heap OK) but readiness doesn't validate DB pool acquisition under load.
4. Retry storm from gateway doubles effective connection attempts.

**Solution (immediate + structural):**

```yaml
# Per-pod pool — size for (DB max / expected pods) with headroom
spring:
  datasource:
    hikari:
      maximum-pool-size: 5          # 80 pods × 5 = 400 < 500
      minimum-idle: 2
      connection-timeout: 3000      # fail fast, don't queue forever
      max-lifetime: 1800000
      leak-detection-threshold: 60000

# PgBouncer in transaction mode between app and RDS
# RDS max_connections raised only after pooler in place
```

Rules that save incidents:

- **Total connections = pods × pool size + admin + replicas + batch jobs.** Put this in a spreadsheet before Black Friday.
- Readiness should attempt a **real** DB checkout (or PgBouncer ping), not just `/actuator/health` with DB disabled.
- Scale **down** pool per pod when scaling **out** pods — counterintuitive but mandatory.

---

## 2. Horizontal Scaling

### Core concept

Horizontal scaling (**scale out / in**) adds or removes **identical stateless instances** behind a load balancer. It is the default for microservices because it improves throughput and fault tolerance without single-node ceilings — **if** the workload is partitionable and shared state is externalized.

```
                    ┌──────────┐
         Request ──►│    LB    │
                    └────┬─────┘
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
      ┌─────────┐  ┌─────────┐  ┌─────────┐
      │ Pod 1   │  │ Pod 2   │  │ Pod N   │
      └────┬────┘  └────┬────┘  └────┬────┘
           └─────────────┼─────────────┘
                         ▼
                  ┌─────────────┐
                  │ Shared state │
                  │ DB / Redis   │
                  └─────────────┘
```

### When horizontal scaling works

| Requirement | Why |
|---|---|
| **Stateless app tier** | Session in Redis/JWT; no sticky files on disk |
| **Shared-nothing or externalized state** | Each instance can handle any request |
| **Load balancer health checks** | Unhealthy instances removed from rotation |
| **Idempotent or partition-tolerant logic** | Retries and duplicate delivery handled |
| **Downstream can absorb fan-out** | DB, cache, vendor APIs have headroom |

### Internal working (Kubernetes Deployment)

1. Deployment controller maintains `replicas` desired count.
2. ReplicaSet creates Pods with unique identities.
3. Service selects pods via labels; Endpoints/EndpointSlice updated on readiness.
4. kube-proxy or CNI dataplane routes ClusterIP traffic.
5. Ingress/Gateway sends external traffic to Service.
6. HPA adjusts `replicas` based on metrics (see [Autoscaling](#4-autoscaling)).

Critical detail: **readiness ≠ liveness**. A pod can be alive (JVM up) but not ready (can't get DB connection). Sending traffic to not-ready pods causes errors; keeping not-ready pods in the count during scale-up causes **partial capacity** miscalculation.

### Production scenario: sticky sessions break scale-out

**Problem.** Team scales web tier 3 → 15 pods. Users randomly logged out; shopping carts vanish. Load balancer shows even distribution.

**Cause.** Spring Session stored in-memory with `server.servlet.session.timeout` and no Spring Session Redis. LB uses round-robin without session affinity — each request may hit a different pod with empty session map.

**Solution A — externalize session (preferred):**

```xml
<!-- pom.xml -->
<dependency>
  <groupId>org.springframework.session</groupId>
  <artifactId>spring-session-data-redis</artifactId>
</dependency>
```

```yaml
spring:
  session:
    store-type: redis
  data:
    redis:
      host: redis-cluster.internal
```

**Solution B — session affinity (escape hatch):**

```yaml
# NGINX Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/session-cookie-name: "route"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "3600"
```

Sticky sessions reduce effective load distribution and complicate deploys (draining). Prefer stateless JWT or centralized session store.

### Production scenario: horizontal scale amplifies cache stampede

**Problem.** Product catalog service scaled 5 → 40 pods during sale. Redis CPU 95%, DB query rate 10× baseline, p99 latency 4s.

**Cause.** Each pod maintains a **local** Caffeine cache with 60s TTL, no coordination. Hot keys expire simultaneously across 40 JVMs → 40× Redis miss → 40× DB query for same SKU.

**Solution.**

```java
@Bean
public CacheManager cacheManager(RedisConnectionFactory factory) {
    return RedisCacheManager.builder(factory)
        .cacheDefaults(RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(5))
            .disableCachingNullValues())
        .build();
}
```

Add single-flight on cache miss for hot keys; TTL jitter; consider CDN for product images/static catalog fragments.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| In-memory session without affinity | Random logouts after scale-out |
| Local cache for hot shared data | DB/Redis spike proportional to pod count |
| `maxSurge: 100%` + slow readiness | Traffic to half-ready pods; error burst on deploy |
| No PDB (Pod Disruption Budget) | Node drain kills too many replicas; outage |
| Scale pods without scaling pool math | `too many clients already` on database |
| File uploads to local disk | Pod reschedule = lost files; need object storage |
| Singleton scheduled job on every pod | 15× cron executions; duplicate charges |

### Horizontal scaling limits

Horizontal scaling stops helping when:

- **Database write path** is single-leader — more writers increase lock contention, not throughput.
- **Strong consistency cross-shard** requires distributed transactions — latency grows with fan-out.
- **Cold start** (JVM + Spring context) exceeds HPA reaction window — scale-up arrives too late.
- **Coordination overhead** (cache invalidation, gossip, leader election) dominates.

At that point: shard data, async pipelines, read replicas, or vertical scale the bottleneck tier — not more app pods.

### Debugging scenario

**Observe.** HPA at max replicas. CPU 25%. Latency high. Errors intermittent.

**Diagnose.**

```bash
kubectl top pods -n checkout
kubectl get hpa -n checkout -o yaml
curl -s localhost:8080/actuator/metrics/hikaricp.connections.active | jq
curl -s localhost:8080/actuator/metrics/http.server.requests | jq
```

Check: thread pool saturation (`tomcat.threads.busy`), GC pause (`jvm.gc.pause`), outbound HTTP pool pending, DB slow query log. CPU-low + latency-high = **blocking I/O or pool wait**, not CPU need.

**Fix.** Right-size pools, add PgBouncer, fix N+1 queries, scale data tier, add caching — not more pods.

---

## 3. Vertical Scaling

### Core concept

Vertical scaling (**scale up / down**) increases resources on a **single node**: CPU cores, RAM, network bandwidth, disk IOPS. It is simpler operationally (no sharding of instance count) but has hard ceilings and creates **larger blast radius** per failure.

```
Before:  ┌──────────────┐          After:  ┌──────────────────────┐
         │ 4 vCPU       │                  │ 16 vCPU              │
         │ 8 GB RAM     │    ──────►       │ 64 GB RAM            │
         │ 1 pod        │                  │ 1 pod (same code)    │
         └──────────────┘                  └──────────────────────┘
```

### When vertical scaling is the right first move

| Situation | Why vertical |
|---|---|
| **Monolith or single-node DB** | Cannot partition without rewrite |
| **Memory-bound JVM** | Larger heap reduces GC frequency (until pause dominates) |
| **Licensed software per socket** | Fewer bigger nodes may cost less |
| **Low traffic, high per-request memory** | ML inference, large in-memory joins |
| **Quick mitigation** | Buy time while horizontal path is engineered |

### JVM-specific vertical scaling notes

Increasing heap without adjusting GC:

```bash
# Before: -Xmx2g on 4 vCPU — OK
# After:  -Xmx24g on 8 vCPU — G1 pause times may spike if not tuned

-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:InitiatingHeapOccupancyPercent=35
-Xms8g -Xmx8g   # equal min/max avoids resize pauses
```

Rule of thumb: leave **25–40% RAM** for off-heap (metaspace, thread stacks, direct buffers, OS page cache). A 32 GB node is not a 32 GB heap node.

### Production scenario: "We upgraded to r6g.2xlarge and latency got worse"

**Problem.** Order service moved from 4 vCPU / 8 GB to 16 vCPU / 128 GB. Throughput flat. P99 GC pauses 800ms (was 50ms).

**Cause.** Ops set `-Xmx100g` "because we have the RAM." G1 collects a enormous heap; pause times dominate. Tomcat `maxThreads` still 200 — CPU idle, threads still the limiter.

**Solution.**

```yaml
# Right-size heap to working set, not hardware
JAVA_OPTS: >-
  -Xms4g -Xmx4g
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=100
server:
  tomcat:
    threads:
      max: 400        # scale with vCPU for I/O-bound work
    accept-count: 200
```

Profile with async-profiler during peak: if heap stable at 2 GB, 4 GB max is enough. Vertical scale **CPU and threads** before absurd heap.

### Vertical vs horizontal — decision framing

| Factor | Horizontal | Vertical |
|---|---|---|
| Fault tolerance | Better (N instances) | Worse (single bigger node) |
| Ceiling | Limited by coordination | Hardware max per instance |
| Deploy risk | Rolling, gradual | Often requires restart/downtime |
| Cost curve | Linear if stateless | Super-linear for DB memory |
| State | Must externalize | Can hide state longer (debt) |

**Production pattern:** horizontally scale stateless app tier; vertically scale **database** until sharding/replicas required; never vertically scale app tier alone as the only strategy for traffic growth.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Heap = 90% of node RAM | OOM killer terminates pod; noisy neighbor on node |
| Bigger node, same thread pool | CPU idle, requests queue at Tomcat |
| Vertical DB scale without query tuning | Faster disk, same slow queries |
| Single giant Kafka broker | Disk full faster; no redundancy |

### Debugging scenario

**Observe.** After vertical upgrade, sporadic `OutOfMemoryError: Direct buffer memory`.

**Diagnose.** Netty/WebClient direct memory scales with concurrency. Larger heap encouraged higher `maxConnections` on HTTP client without raising `-XX:MaxDirectMemorySize`.

**Fix.** Cap client pools; set direct memory explicitly; prefer horizontal pods with moderate heap over one monster JVM.

---

## 4. Autoscaling

### Core concept

Autoscaling adjusts capacity **automatically** based on signals (CPU, memory, custom metrics, queue depth, schedule). In Kubernetes, the **Horizontal Pod Autoscaler (HPA)** changes Deployment replicas; **Vertical Pod Autoscaler (VPA)** adjusts requests/limits; **Cluster Autoscaler** adds nodes when pods can't schedule.

```
Metrics (CPU / RPS / queue lag)
        │
        ▼
   ┌─────────┐     desired replicas     ┌────────────┐
   │   HPA   │ ───────────────────────► │ Deployment │
   └─────────┘                          └────────────┘
        │                                       │
        │ if pending pods                       ▼
        ▼                                  ┌─────────┐
   ┌──────────────┐                        │  Pods   │
   │Cluster       │ ◄── unschedulable ──── │         │
   │Autoscaler    │                        └─────────┘
   └──────────────┘
```

### HPA internal working

1. Metrics Server (or Prometheus Adapter) provides resource/custom metrics.
2. HPA controller every `syncPeriod` (default 15s) computes:

   ```
   desiredReplicas = ceil(currentReplicas × (currentMetric / targetMetric))
   ```

3. Applies stabilization windows and scale-down cooldown to prevent flapping.
4. Updates Deployment `spec.replicas` if within min/max bounds.
5. Deployment controller creates/deletes pods.

Default CPU target 80% is often wrong for I/O-bound Java services — CPU stays low while threads block on DB.

### Production-grade HPA manifest

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service
  namespace: checkout
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 3
  maxReplicas: 50
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: http_server_requests_seconds_count_per_second
        target:
          type: AverageValue
          averageValue: "100"    # 100 RPS per pod target
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
        - type: Pods
          value: 4
          periodSeconds: 60
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
```

Custom metric requires Prometheus Adapter or equivalent exporting Spring Micrometer metrics to HPA.

### Production scenario: HPA scales, latency worsens (metastable)

**Problem.** Traffic spike. HPA adds 30 pods in 5 minutes. Error rate climbs. DB CPU 100%. HPA still scaling up because CPU on **app pods** is low.

**Cause.** I/O-bound service; HPA metric wrong. More pods = more DB connections and queries. Metastable failure: DB slow → requests pile up → more pods requested → worse.

**Solution.**

1. Switch HPA to **request-rate** or **concurrency** metric, or CPU with very conservative maxReplicas until pooler in place.
2. Add **admission control** (rate limit at gateway) before autoscale.
3. Configure scale-down stabilization so recovery isn't interrupted by flapping.

```yaml
# KEDA ScaledObject — scale on Kafka lag (better for consumers)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor
spec:
  scaleTargetRef:
    name: order-processor
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus:9090
        query: |
          sum(rate(kafka_consumer_fetch_manager_records_consumed_total{group="order-processor"}[2m]))
        threshold: "500"
```

### Scheduled / predictive scaling

For known events (sales, payroll run, market open):

```yaml
# Cron-based pre-warm via KEDA cron trigger or external pipeline
# 30 minutes before event: set minReplicas from 5 → 30
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: checkout-pre-warm
spec:
  triggers:
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 8 * * 5"      # Friday 08:00
        end: "0 12 * * 5"
        desiredReplicas: "40"
```

Predictive scaling (AWS Auto Scaling predictive, custom ML on historical RPS) reduces cold-start lag. Always validate against **last year's** traffic shape, not average Tuesday.

### VPA and Cluster Autoscaler caveats

| Component | Gotcha |
|---|---|
| **VPA** | Restart pods to apply new resources — disruptive; often use recommender mode only |
| **Cluster Autoscaler** | Needs node pool headroom; wrong instance type = schedule pending forever |
| **HPA + Cluster Autoscaler lag** | 2–5 min to new nodes; traffic already lost |
| **maxReplicas too high** | Cost + downstream collapse |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| HPA on CPU for I/O-bound Java | Scales late or not at all; wrong diagnosis |
| minReplicas = 1 for HA service | Brief unavailability on node failure |
| No scale-down stabilization | Replica flapping; cache cold every minute |
| maxReplicas unlimited | DB connection apocalypse |
| Ignoring JVM warm-up in readiness | Traffic to cold pods; latency spike |
| Custom metric with 5m scrape interval | HPA reacts slower than traffic ramp |

### Debugging scenario

**Observe.** `kubectl describe hpa` shows `FailedGetResourceMetric` or replicas stuck at min.

**Diagnose.**

```bash
kubectl describe hpa order-service -n checkout
kubectl get apiservice v1beta1.metrics.k8s.io -o yaml
kubectl top pods -n checkout
```

Check Metrics Server running, resource requests set (HPA needs requests for CPU %), Prometheus Adapter RBAC for custom metrics.

**Fix.** Set realistic `resources.requests`; fix metrics pipeline; add pre-warm for known spikes.

---

## 5. Capacity Planning

### Core concept

Capacity planning answers: **how much headroom do we need, at what cost, before traffic or failure finds the gap?** Autoscaling reacts to the present; capacity planning prepares for **peak + failure + growth** with evidence, not hope.

```
Capacity plan inputs                    Outputs
─────────────────────                   ───────
• Historical RPS / seasonality    ──►   Target replica count
• Per-request CPU ms, DB queries        Pool sizes × pods
• p99 latency SLO                       DB instance size
• Failure scenarios (AZ loss)           Cache memory
• RPO/RTO (DR tier)                     Budget + runbook
• Deploy overhead (surge during roll)
```

### The utilization trap

Running at 90% average utilization feels efficient. It guarantees incidents:

- No room for AZ failure (lose 33% capacity in 3-AZ if not over-provisioned).
- Deploy surge (`maxSurge`) needs spare capacity.
- Retry storms multiply effective load 2–5×.
- GC pauses and slow queries are invisible in averages.

**Target steady-state utilization (rule of thumb):**

| Tier | Steady CPU / connection util | Headroom for |
|---|---|---|
| App (stateless) | 50–65% at peak normal | Spike + AZ loss |
| Database | 40–60% at peak | Failover + vacuum/maintenance |
| Cache | 70% memory | Hot key growth |
| Network | < 60% sustained | Burst, DDoS mitigation |

### Little's Law for queueing sanity

```
L = λ × W

L = average items in system (requests in flight)
λ = arrival rate (RPS)
W = average time in system (latency)
```

If W doubles at fixed λ, L doubles — queues build, timeouts cascade. Capacity planning must use **p99 W**, not mean.

Example: 1000 RPS × 0.5s p99 = 500 concurrent requests in system. If Tomcat `maxThreads=200`, you are already underwater at p99 — regardless of average latency looking fine.

### Production scenario: capacity review prevents outage

**Problem.** Finance projects 3× user growth in 6 months. Current peak: 2k RPS checkout, 24 pods, db.r6g.xlarge (4 vCPU, 32 GB), PgBouncer pool 300.

**Capacity worksheet:**

| Component | Current peak | @ 3× growth | Plan |
|---|---|---|---|
| RPS | 2,000 | 6,000 | 72 pods @ 85 RPS/pod (same p99) |
| DB connections | 24×5=120 via bouncer | 72×5=360 | PgBouncer max 400; RDS upgrade to 2xlarge |
| Redis | 4 GB, 60% used | ~12 GB working set | Cluster mode 3 shards |
| Kafka | 50 MB/s ingress | 150 MB/s | Add brokers; partition count review |
| Cost | $X/mo | ~2.2× (not 3× — economies) | Reserved instances |

Load test at 6.5k RPS in staging **before** marketing announcement. Found search N+1 at 4k RPS — fixed in sprint, not during launch.

### Load testing methodology

1. **Baseline** — current prod peak shape (RPS, payload mix, think time).
2. **Soak test** — 2× peak for 4–8 hours; memory leaks, connection drift.
3. **Spike test** — 0 → 5× in 60s; validates HPA + pre-warm + shed.
4. **Failure injection** — kill AZ, DB failover, pod kill during peak.
5. **Deploy under load** — rolling update while at 80% peak.

Tools: Gatling, k6, Locust, NBomber; Kubernetes job runners; production shadow traffic (advanced).

```javascript
// k6 excerpt — spike profile
export const options = {
  stages: [
    { duration: '2m', target: 500 },
    { duration: '1m', target: 2500 },  // spike
    { duration: '5m', target: 2500 },
    { duration: '2m', target: 500 },
  ],
  thresholds: {
    http_req_duration: ['p(99)<800'],
    http_req_failed: ['rate<0.01'],
  },
};
```

### Capacity planning artifacts

| Artifact | Owner | Refresh |
|---|---|---|
| Traffic forecast | Product + SRE | Quarterly |
| Service capacity sheet (RPS/pod, pools) | Team | Each major release |
| DB growth (storage, IOPS, connections) | DBA / platform | Monthly |
| Runbook: "at max scale" | SRE | After load test |
| Cost model | FinOps | Quarterly |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Plan on average RPS only | p99 miss; nightly batch overlaps peak |
| No load test since launch | "We thought 50 pods was enough" |
| Ignore dependency quotas | Stripe/API rate limit at 60% app capacity |
| Single-region capacity = global peak | DR region can't take failover traffic |
| Capacity = prod only | Staging can't reproduce; bugs escape |

### Debugging scenario

**Observe.** Leadership asks "can we handle 10×?" Engineering says "we autoscale."

**Diagnose.** Build bottom-up model: measure single-pod RPS at p99 SLO via load test; multiply; check DB, Redis, third-party limits; add headroom.

**Deliverable.** One-page answer: **Yes to 4× with $Y spend and these changes; No to 10× without catalog sharding and CDN** — with dates and cost.

---

## 6. High Availability

### Core concept

High availability (HA) is the ability to continue serving **within SLO** despite component failure. It is measured as uptime of **successful work**, not ping uptime. HA requires **redundancy + automatic failover + failure isolation** — not just multiple replicas.

```
                    ┌─────────────────────────────────┐
                    │         Availability zones       │
                    │  ┌───────┐ ┌───────┐ ┌───────┐  │
                    │  │ AZ-a  │ │ AZ-b  │ │ AZ-c  │  │
                    │  │ 2 pod │ │ 2 pod │ │ 2 pod │  │
                    │  └───┬───┘ └───┬───┘ └───┬───┘  │
                    └──────┼─────────┼─────────┼──────┘
                           └───────────┼───────────┘
                                       ▼
                              Multi-AZ database
                              (sync replica + auto failover)
```

### HA layers

| Layer | HA mechanism | Typical target |
|---|---|---|
| **Compute** | N+1 replicas across AZs, PDB | 99.9% – 99.99% |
| **Load balancing** | Health-checked targets, cross-zone LB | Same as compute |
| **Data** | Replication, automatic failover, backups | RPO/RTO driven |
| **Dependencies** | Multi-AZ cache, queue clusters | Match app tier |
| **Region** | Active-active or active-passive DR | 99.99%+ |

### SLA, SLO, SLI, error budget

```
SLI = proportion of successful requests (e.g. 200 + valid business response / total)
SLO = target for SLI (e.g. 99.9% monthly)
SLA = contractual consequence (often looser than internal SLO)
Error budget = 1 - SLO (99.9% → 43.8 min downtime/month)
```

**99.9% vs 99.99%:**

| Availability | Downtime/month | Downtime/year |
|---|---|---|
| 99.9% (three nines) | ~43 min | ~8.76 hours |
| 99.99% (four nines) | ~4.3 min | ~52 min |
| 99.999% (five nines) | ~26 sec | ~5.26 min |

Each nine is roughly **10× harder**. Four nines usually requires multi-AZ, automated failover, chaos testing, and no scheduled maintenance without redundancy.

### Production scenario: "We had 6 replicas but still went down"

**Problem.** 6 pods across 3 AZs. Single AZ power event. Service unavailable 12 minutes.

**Cause.**

1. All 6 pods on same node pool SKUs in AZ-a and AZ-b only (AZ-c empty — cost saving).
2. RDS single-AZ for "non-prod parity" mistake in prod account.
3. Redis standalone, no sentinel.
4. PDB `minAvailable: 50%` but only 2 AZs had pods — AZ-a loss took 4/6 pods.

**Solution.**

```yaml
# Pod topology spread
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: order-service

# PodDisruptionBudget
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-service-pdb
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: order-service
```

Multi-AZ RDS with `MultiAZ: true`; ElastiCache replication group 3 nodes cross-AZ; verify **actual** pod distribution with `kubectl get pods -o wide`.

### Active-active vs active-passive

| Pattern | Description | Trade-off |
|---|---|---|
| **Active-active** | All instances serve traffic | Needs stateless + conflict handling |
| **Active-passive (warm)** | Standby ready, manual/auto promote | Lower cost, failover minutes |
| **Active-passive (cold)** | Restore from backup | Cheapest, RTO hours |

Microservices default: **active-active app tier** in one region (multi-AZ); **active-passive or active-active** cross-region depending on RPO/RTO (see [Multi-region](#7-multi-region-deployment)).

### Health checks done correctly

```yaml
# Kubernetes probes
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 5
  failureThreshold: 3

livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  initialDelaySeconds: 60
  periodSeconds: 10
  failureThreshold: 3

startupProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  failureThreshold: 30
  periodSeconds: 10
```

Spring Boot 3 actuator groups:

```yaml
management:
  endpoint:
    health:
      group:
        readiness:
          include: readinessState,db,redis
        liveness:
          include: livenessState
      show-details: when_authorized
```

**Never** put optional downstreams (email vendor) in liveness — flapping kills pods. Optional deps belong in readiness or a separate **deep** health for monitoring only.

### Graceful shutdown

```yaml
spec:
  terminationGracePeriodSeconds: 60
```

```java
@Bean
public GracefulShutdown gracefulShutdown() {
    return new GracefulShutdown();
}
```

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

On SIGTERM: stop accepting new connections, finish in-flight, deregister from LB **before** kill. PreStop hook sleep helps LB propagation:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 15"]
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Replicas in one AZ | AZ outage = total outage |
| Liveness includes DB | Cascade pod kill on DB blip |
| No PDB | Node upgrade drains all pods |
| `terminationGracePeriodSeconds: 30` + 60s requests | SIGKILL mid-request |
| Health check hits cache only | DB dead but pod ready |
| Shared fate (all services one cluster) | Control plane issue = everything down |

### Debugging scenario

**Observe.** "Partial outage" — 30% errors, not 100%.

**Diagnose.** Check EndpointSlice — uneven ready endpoints; one AZ LB target unhealthy; partial deploy with mixed versions.

```bash
kubectl get endpointslices -n checkout -l kubernetes.io/service-name=order-service -o yaml
kubectl describe pod order-service-xxx | grep -A5 Conditions
```

**Fix.** Topology spread; fix readiness; rollback bad version; ensure cross-zone LB weights.

---

## 7. Multi-region Deployment

### Core concept

Multi-region deployment places workloads in **geographically separated regions** for lower latency to global users, regulatory data residency, and survival of regional catastrophes. It introduces **consistency, routing, and operational complexity** that single-region multi-AZ does not.

```
         Global DNS / Anycast / Geo routing
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   ┌─────────┐             ┌─────────┐
   │ us-east │             │ eu-west │
   │ active  │◄──repl─────►│ active  │
   └────┬────┘             └────┬────┘
        │                       │
   Regional stack            Regional stack
   (K8s, DB, cache)          (K8s, DB, cache)
```

### Multi-region patterns

| Pattern | Traffic | Data | Complexity |
|---|---|---|---|
| **Disaster recovery (passive)** | Single region until failover | Async replication to DR | Lower |
| **Active-passive (read)** | Writes primary; reads from both | Primary + read replicas | Medium |
| **Active-active** | Both regions serve writes | Conflict resolution, CRDTs, or partition | High |
| **Cell-based (partitioned)** | Users pinned to home region | Shard by tenant/region | High but controlled |

### Routing strategies

**Geo-DNS / latency routing:** Route 53 latency policies, Cloudflare Load Balancing, GCP Cloud CDN + LB. User in EU hits eu-west unless health check fails.

**Global load balancer with health:** Remove unhealthy region from pool; TTL affects failover speed (lower TTL = faster failover, more DNS load).

**Sticky tenant routing:** Enterprise customer data in `eu-west` only — route by subdomain (`eu.api.example.com`) or JWT claim `region=eu`.

### Production scenario: active-active write collision

**Problem.** Active-active order service in us-east and eu-west. Same user updates profile on mobile (roaming) in both regions within 2 seconds. Last-write-wins loses phone number; support tickets spike.

**Cause.** No partition key routing; global DynamoDB/CRDB not used; two independent PostgreSQL primaries with bidirectional async repl (dangerous).

**Solution options:**

1. **Home region per user** — route all writes for `user_id` hash to primary region; other region proxies or 307 redirect.
2. **Global database** — CockroachDB, Spanner, DynamoDB global tables (understand consistency model).
3. **Event sourcing + merge** — operational transform for specific fields (rare, complex).

```java
// Routing filter — reject writes in wrong region
@Component
public class RegionAffinityFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String home = userRegionResolver.resolve(req);  // from token or lookup
        if (!home.equals(deploymentRegion) && isWrite(req)) {
            res.setStatus(307);
            res.setHeader("Location", "https://" + home + ".api.example.com" + req.getRequestURI());
            return;
        }
        chain.doFilter(req, res);
    }
}
```

### Data replication across regions

| Store | Cross-region option | Consistency |
|---|---|---|
| **PostgreSQL** | Read replicas / logical replication | Async; RPO > 0 |
| **S3** | Cross-region replication | Eventually consistent |
| **Redis** | Global Datastore (Active-Active) | CRDT / eventual |
| **Kafka** | MirrorMaker 2 / cluster linking | Async |
| **DynamoDB** | Global tables | Multi-master eventual |

### Production scenario: regional failover drill

**Problem.** Team claims RTO 15 minutes. First real regional outage: 4 hours to restore.

**Cause.** Runbook assumed "flip DNS." Reality: Kafka consumer offsets wrong region; secrets in DR vault not synced; Helm values pointed to us-east DB endpoints; on-call didn't know who owns Route 53.

**Solution — quarterly game day:**

1. Failover **eu-west** to **us-east** in staging with production-like data volume.
2. Measure actual RTO/RPO; update runbook.
3. Automate DNS/weight shift with manual approval gate.
4. Document **failback** (often harder than failover).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Two write primaries without conflict handling | Split brain, data loss |
| High DNS TTL (3600s) | Region dead but clients still routed |
| Cross-region sync calls | Latency p99 unusable; cascade failures |
| DR region at 10% capacity | Failover overloads DR |
| Clock skew across regions | Idempotency keys collide; token expiry bugs |

### Debugging scenario

**Observe.** EU users report slow app; US fine. Traces show US database queries from EU pods.

**Diagnose.** Misconfigured JDBC URL pointing to global endpoint resolving to US; missing read replica in EU; no connection pooling to local replica.

**Fix.** Regional service discovery; JDBC to local Aurora reader endpoint; cache hot reads in regional Redis.

---

## 8. Disaster Recovery

### Core concept

Disaster recovery (DR) is the **documented, tested process** to restore systems after catastrophic failure: region loss, ransomware, operator error (`DROP DATABASE`), cloud provider control plane degradation. DR is not backups alone — it is **restore + validate + redirect traffic + communicate**.

```
Normal                    Disaster                 Recovery
──────                    ────────                 ────────
Primary region serving    Region unavailable       Execute runbook:
Multi-AZ within region    or data corrupted          • Declare incident
Backups continuous                                   • Route to DR region
                                                     • Promote replica / restore
                                                     • Validate data + SLO
                                                     • Failback when safe
```

### DR tiers (industry shorthand)

| Tier | Name | RTO | RPO | Cost |
|---|---|---|---|---|
| 0 | No DR | Undefined | Undefined | Lowest |
| 1 | Backup & restore | Days | Hours | Low |
| 2 | Warm standby | Hours | Minutes–hours | Medium |
| 3 | Hot standby | Minutes | Minutes | High |
| 4 | Active-active | Near zero | Near zero | Highest |

Pick tier from **business impact analysis (BIA)**, not engineering preference.

### Backup strategy (3-2-1 rule)

- **3** copies of data
- **2** different media/types
- **1** offsite / cross-region

For databases:

```bash
# Automated RDS snapshots + PITR (continuous WAL)
# Retention: 35 days prod; test restore weekly

# Application-level export for legal/compliance
pg_dump --format=custom --file=backup.dump orders_db
aws s3 cp backup.dump s3://dr-vault/orders/$(date +%F)/
```

Verify restore — untested backup is wishful thinking.

### Production scenario: operator DROP TABLE

**Problem.** Engineer runs migration against prod. Wrong schema. `orders` table truncated.

**Response playbook:**

1. **Stop bleeding** — revoke credentials; enable maintenance mode on write APIs.
2. **Assess scope** — PITR window; last good snapshot; binlog/WAL position.
3. **Restore path** — restore to **new** instance (never overwrite in place until verified); point read-only traffic first; reconcile delta from Kafka event log if available.
4. **Communicate** — status page, support macros, RPO disclosure if data loss.
5. **Post-incident** — break-glass DB roles; migration tool guardrails (Flyway on CI only).

```sql
-- RDS PostgreSQL PITR: restore to new cluster at timestamp T-5min
-- AWS Console or CLI: restore-db-cluster-to-point-in-time
```

### DR runbook template (abbreviated)

```markdown
## Trigger
- Regional health check failed 5 min
- OR manual declaration by incident commander

## Roles
- IC, Communications, Platform lead, DBA, App on-call

## Steps
1. Confirm primary region status (not transient network blip)
2. Execute Terraform/Helm: scale DR region replicas to production capacity
3. Promote Aurora global secondary / restore from latest snapshot
4. Update Global DNS weights: us-east 0%, eu-west 100%
5. Verify: synthetic checkout test, Kafka lag, error rate < 0.1%
6. Enable traffic 10% → 50% → 100%

## Failback
- Replicate DR → primary; plan maintenance window; reverse DNS weights
```

### Ransomware and immutable backups

- S3 Object Lock / Azure Immutable Blob / WORM storage
- Separate AWS account for backup vault (no prod IAM path to delete)
- Air-gapped or offline copy for Tier-0 data

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Backups without restore tests | Discover corrupt backup during real DR |
| DR runbook stale (old endpoints) | Failover fails at step 3 |
| Same IAM keys prod + DR vault | Attacker deletes backups |
| DR region never load tested | Failover succeeds then collapses |
| No event log for reconciliation | Restore loses last hour with no replay path |

### Debugging scenario

**Observe.** After DR failover, orders duplicated.

**Diagnose.** Idempotency keys not global; consumers replayed from old offset; outbox events published twice.

**Fix.** Global idempotency store (Redis/DynamoDB); Kafka exactly-once or idempotent consumers; reconcile job for duplicates.

---

## 9. RPO and RTO

### Core concept

**RPO (Recovery Point Objective):** maximum **acceptable data loss** measured in time. "How far back in time might we lose data?"

**RTO (Recovery Time Objective):** maximum **acceptable downtime** — time from disaster to restored service.

```
Timeline
────────────────────────────────────────────────────────►

        │◄──── RPO ────►│                    │
        Last good data  Disaster strikes     Service restored
                                            │◄── RTO ──►│
```

They are **business decisions** implemented by architecture — not slogans on a slide.

### RPO/RTO mapping to architecture

| Business requirement | Typical RPO | Typical RTO | Architecture |
|---|---|---|---|
| Marketing blog | 24 h | 4 h | Nightly backup, single region |
| Internal admin tool | 1 h | 2 h | Hourly snapshots, warm standby |
| E-commerce checkout | 5 min | 15 min | Multi-AZ + cross-region async repl + automated failover |
| Payment ledger | ~0 | < 5 min | Sync replication, active-active, strong consistency |
| IoT telemetry | 1 h | 8 h | Buffer at edge; batch replay OK |

### Measuring RPO in practice

RPO = replication lag + detection time + decision time + restore time **for data plane**.

```promql
# Aurora/Aurora Global Database replication lag
aws_rds_aurora_global_db_replicated_write_lag_seconds

# PostgreSQL streaming lag on replica
pg_replication_lag_seconds
```

If async repl lag p99 = 45s under load, **best achievable RPO ≈ 45s + ops time** unless you tighten replication or use sync.

### Measuring RTO in practice

RTO components:

1. **Detection** — alerting mean time to detect (MTTD)
2. **Decision** — human or automated failover trigger
3. **Execution** — DNS TTL, pod scale, DB promote, cache warm
4. **Validation** — smoke tests, canary traffic

Game day measured RTO 47 min → update SLA internal docs; either invest in automation or negotiate business expectation.

### Production scenario: SLA promises 15 min RTO, architecture delivers 2 hours

**Problem.** Contract says RTO 15 minutes. Stack: cold DR, manual snapshot restore to new RDS (~90 min), no pre-provisioned K8s in DR region.

**Options:**

1. **Change contract** to honest 4-hour RTO (Tier 2) — legal/commercial fix.
2. **Invest** — hot standby RDS, DR cluster always running at 50% capacity, automated Route 53 failover (~20 min measured).
3. **Hybrid** — automated failover for read path in 15 min; write path read-only until DB promote completes (degraded mode in SLA).

Never sign RTO without **measured** game day evidence.

### Sync vs async replication trade-off

| Mode | RPO | Impact on primary |
|---|---|---|
| **Synchronous** | ~0 | Write latency + availability coupling (primary waits for replica ack) |
| **Asynchronous** | > 0 (lag) | Better primary performance; replica may be stale |

PostgreSQL synchronous_commit:

```sql
-- Per transaction or session
SET synchronous_commit = on;
SET synchronous_standby_names = 'replica1';
```

Use sync only when business mandates near-zero RPO and accepts latency/availability cost.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| RPO on paper = 0, async repl in prod | Data loss on failover |
| Ignore detection/decision in RTO | "Automated 5 min failover" becomes 45 min |
| No degraded mode definition | Team afraid to fail over; RTO blows |
| Backup RPO confused with repl RPO | Snapshot daily ≠ 5 min RPO |

### Interview framing

**Q: RPO 1 minute, RTO 5 minutes — design outline?**

Multi-AZ primary, cross-region async repl with lag alert < 30s, DR K8s warm (min replicas), global LB health checks, automated failover runbook with human approval, continuous backup + PITR, quarterly game day, idempotent event replay for gap window.

---

## 10. Connection Pooling

### Core concept

Connection pooling maintains a **reuse set** of established database (or HTTP, Redis) connections to avoid per-request TCP + TLS + auth handshake. Pools are the **hidden multiplier** in horizontal scaling: `total_connections = pods × pool.max`.

```
Without pool:  Request ──► new TCP/TLS/auth ──► DB  (slow, expensive)
With pool:     Request ──► borrow conn ──► DB ──► return conn
```

### HikariCP (Spring Boot default)

```yaml
spring:
  datasource:
    url: jdbc:postgresql://pgbouncer.internal:6432/orders
    hikari:
      pool-name: orders-pool
      maximum-pool-size: 10
      minimum-idle: 2
      connection-timeout: 5000      # ms to wait for free conn
      idle-timeout: 600000          # 10 min
      max-lifetime: 1800000         # 30 min — rotate before DB/firewall kills
      keepalive-time: 300000
      validation-timeout: 5000
      leak-detection-threshold: 120000  # dev/staging; overhead in prod
```

```java
@Configuration
public class DataSourceConfig {
    @Bean
    @ConfigurationProperties("spring.datasource.hikari")
    public HikariConfig hikariConfig() {
        return new HikariConfig();
    }

    @Bean
    public DataSource dataSource(HikariConfig config) {
        config.setMetricRegistry(metricRegistry);  // optional Dropwizard bridge
        return new HikariDataSource(config);
    }
}
```

### Pool sizing formula (starting point)

```
pool_size = (core_count × 2) + effective_spindle_count   # legacy disk rule

For cloud I/O-bound Java microservice:
pool_size_per_pod ≈ target_concurrent_db_ops_per_pod

Conservative:
  total_pool_to_db = (DB max_connections × 0.8) - admin_reserve
  pool_size_per_pod = total_pool_to_db / max_expected_pods
```

Example: DB max 400, reserve 50 → 350 for apps. Max 70 pods → **5 per pod**.

### PgBouncer / RDS Proxy

Application pools should be **small**; pooler multiplexes many app connections to fewer DB connections.

```
70 pods × 5 conn = 350 app-side
         │
         ▼
    PgBouncer (transaction pooling)
         │
         ▼
    PostgreSQL max_connections = 100 physical
```

**Transaction pooling caveat:** no session-level features across checkout — `SET`, advisory locks, temp tables, `LISTEN/NOTIFY` break. Use **session pooling** for those workloads or disable pooler for that service.

### HTTP client pooling (RestTemplate / WebClient)

```java
@Bean
public CloseableHttpClient httpClient() {
    PoolingHttpClientConnectionManager cm = new PoolingHttpClientConnectionManager();
    cm.setMaxTotal(200);
    cm.setDefaultMaxPerRoute(50);
    return HttpClients.custom().setConnectionManager(cm).build();
}

// WebClient with connector limits
@Bean
public WebClient inventoryClient() {
    ConnectionProvider provider = ConnectionProvider.builder("inventory")
        .maxConnections(50)
        .pendingAcquireMaxCount(500)
        .pendingAcquireTimeout(Duration.ofSeconds(2))
        .build();
    HttpClient http = HttpClient.create(provider)
        .responseTimeout(Duration.ofSeconds(3));
    return WebClient.builder()
        .clientConnector(new ReactorClientHttpConnector(http))
        .baseUrl("http://inventory-service")
        .build();
}
```

Each outbound dependency needs its own cap — one slow vendor shouldn't exhaust `maxTotal`.

### Production scenario: connection leak after deploy

**Problem.** Over 6 hours after deploy, `hikaricp.connections.active` climbs to max and stays. Eventually timeouts. Restart pod fixes temporarily.

**Cause.** New code path opens `Connection` via low-level API in `@Async` worker without try-with-resources; under load, leaked connections never return.

**Diagnose.**

```yaml
spring.datasource.hikari.leak-detection-threshold: 60000  # staging only
```

Stack trace in logs points to `ReportGenerator.java:142`.

**Fix.**

```java
// Wrong
Connection c = dataSource.getConnection();
asyncExecutor.execute(() -> runReport(c));  // leak if task fails

// Right — let Spring manage
@Transactional(readOnly = true)
public Report generate() { ... }

// Or try-with-resources in async with short task
```

### Production scenario: pool wait dominates latency

**Problem.** p99 DB time 5ms in APM, but request p99 800ms. `hikaricp.connections.pending` spikes.

**Cause.** `maximum-pool-size: 3` on high-thread Tomcat; threads block waiting for connections.

**Fix.** Increase pool modestly; reduce Tomcat maxThreads to match sustainable concurrency; optimize query duration; add read replica for read-heavy endpoints.

### Redis / Lettuce pooling

```yaml
spring:
  data:
    redis:
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 2
          max-wait: 2000ms
```

Redis is usually faster than DB but **still** multiplies by pod count on connection count limits (`maxclients`).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| max pool × pods > DB max | `too many clients already` |
| connection-timeout too high | Threads blocked minutes; retry storm |
| max-lifetime > DB idle timeout | Mystery disconnect errors |
| One giant pool per monolith | DB overwhelmed; no isolation between services |
| No pool on HTTP clients | SYN flood; ephemeral port exhaustion |
| PgBouncer transaction mode + Hibernate `@Transactional` + session state | Random SQL errors |

### Debugging scenario

**Observe.** Intermittent `SQLTransientConnectionException: Connection is not available`.

**Diagnose.**

```bash
curl localhost:8080/actuator/metrics/hikaricp.connections.active
curl localhost:8080/actuator/metrics/hikaricp.connections.pending
curl localhost:8080/actuator/metrics/hikaricp.connections.timeout
jcmd <pid> Thread.print | grep -A2 "HikariPool"
```

Correlate with traffic spike, deploy time, slow queries (`pg_stat_activity`).

**Fix.** Pool math, PgBouncer, leak fix, query tuning — in that priority order.

---

## 11. Resource Exhaustion

### Core concept

Resource exhaustion occurs when any finite system budget hits zero: threads, heap, file descriptors, connection pools, disk, CPU quota, kernel conntrack, pod IP addresses, cloud API rate limits. Exhaustion failures are often **sudden cliffs**, not graceful slopes — the system was "fine" at 89% then collapses at 91%.

```
Resource exhaustion cascade
───────────────────────────
DB connections maxed
  → app threads block waiting
    → thread pool full
      → accept queue fills
        → LB 502/503
          → clients retry
            → MORE connections requested
              → metastable failure (won't recover when DB recovers)
```

### Exhaustion categories

| Resource | Symptom | Common cause |
|---|---|---|
| **Threads** | Requests hang; Tomcat busy = max | Sync calls; pool wait; missing timeout |
| **Heap** | OOMKilled; long GC | Memory leak; oversized cache; huge payloads |
| **File descriptors** | `Too many open files` | Socket leak; too many small pools |
| **Ephemeral ports** | Outbound errors to single host | HTTP client without pool reuse |
| **DB connections** | Timeouts; DB FATAL | Scale out without pool math |
| **Disk** | Pod evicted; DB crash | Logs unrotated; WAL full |
| **CPU throttling** | Latency without high CPU metric | Missing requests/limit; CFS throttle |
| **Network conntrack** | Random drop on busy nodes | NAT gateway overload |
| **Cloud quotas** | API errors | EIP, API rate, LB target limits |

### Production scenario: ephemeral port exhaustion

**Problem.** Payment service calls single IP (legacy vendor). Every request new TCP connection. At 800 RPS, `Cannot assign requested address`.

**Cause.** Linux ephemeral port range ~28k; TIME_WAIT holds ports 60s. No connection reuse.

**Fix.**

```java
// Reuse connections — pooled HttpClient
// Reduce TIME_WAIT impact: vendor-side keep-alive, pool max per route
```

Also consider VPC NAT gateway capacity — separate from app pooling.

### Production scenario: log disk fills node

**Problem.** Node NotReady. Pods evicted. JVM services writing JSON logs to container filesystem without rotation in high-traffic debug mode.

**Fix.**

```xml
<!-- logback-spring.xml -->
<rollingPolicy class="ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy">
  <maxFileSize>100MB</maxFileSize>
  <maxHistory>7</maxHistory>
  <totalSizeCap>1GB</totalSizeCap>
</rollingPolicy>
```

Ship logs to centralized store; set `emptyDir` size limit; never enable DEBUG fleet-wide in prod.

### Production scenario: CPU limit throttling

**Problem.** Latency SLO miss. `kubectl top` shows 500m CPU used of 2000m limit. `container_cpu_cfs_throttled_seconds_total` high.

**Cause.** Limit set to 500m based on "average" CPU; Java GC and JIT burst need headroom; throttling stretches GC pauses.

**Fix.**

```yaml
resources:
  requests:
    cpu: "1000m"
    memory: "2Gi"
  limits:
    cpu: "2000m"      # or remove CPU limit for Java (controversial; use requests for scheduling)
    memory: "2Gi"     # always set memory limit for JVM pods
```

For Java, **memory limit = heap + non-heap + native**; CPU request drives scheduling; aggressive CPU limits harm latency.

### Load shedding before exhaustion

```java
@Component
public class ConcurrencyLimiterFilter extends OncePerRequestFilter {
    private final Semaphore sem = new Semaphore(150);  // tune to sustainable concurrency

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        if (!sem.tryAcquire()) {
            res.setStatus(503);
            res.setHeader("Retry-After", "5");
            return;
        }
        try {
            chain.doFilter(req, res);
        } finally {
            sem.release();
        }
    }
}
```

Better: gateway rate limit + bulkhead in service (see resilience doc). Fail fast **before** thread pool is wedged.

### Kubernetes resource governance

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "1Gi"
  limits:
    memory: "1Gi"

# LimitRange defaults for namespace
# ResourceQuota max pods, max CPU/memory
# VPA recommender for right-sizing
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No limits on JVM pod | Node OOM kills random pods |
| CPU limit = request on bursty Java | Chronic throttling |
| Unlimited thread pool | OOM or hours of hangs |
| `@Async` unbounded queue | Heap fills with queued tasks |
| File upload to memory | Large POST OOM |
| Ignoring ulimit in container | FD exhaustion at scale |

### Debugging scenario

**Observe.** "Everything slow" after 2 hours peak; recovery slow after traffic drops.

**Diagnose — saturation checklist:**

```bash
# Threads
curl localhost:8080/actuator/metrics/tomcat.threads.busy

# Pool
curl localhost:8080/actuator/metrics/hikaricp.connections.pending

# GC
curl localhost:8080/actuator/metrics/jvm.gc.pause

# FD (inside container)
ls /proc/1/fd | wc -l
ulimit -n

# Node
kubectl describe node | grep -A5 Allocated
dmesg | grep -i oom
```

**Fix order:** stop retries amplifying load → shed load → fix pool/thread limits → scale data tier → add caching — not blind horizontal scale.

---

## 12. Spring Boot & Kubernetes Integration

### Graceful scaling and readiness during warm-up

JVM + Spring context may take 30–90s. Without startup probe, liveness kills pod during boot; with short readiness, traffic hits cold JIT.

```yaml
startupProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  periodSeconds: 5
  failureThreshold: 24   # 120s max startup
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  periodSeconds: 5
```

Optional readiness gate on warm caches:

```java
@Component
public class CacheWarmupHealthIndicator implements HealthIndicator {
    private volatile boolean ready = false;

    @EventListener(ApplicationReadyEvent.class)
    public void warm() {
        catalogService.loadCriticalSkus();
        ready = true;
    }

    @Override
    public Health health() {
        return ready ? Health.up().build() : Health.outOfService().build();
    }
}
```

### Pod Horizontal scaling with Spring metrics

Export custom metric for HPA:

```java
@Component
public class RequestRateMeter {
    private final MeterRegistry registry;
    private Counter counter;

    @PostConstruct
    void init() {
        counter = registry.counter("app.http.requests");
    }

    public void record() { counter.increment(); }
}
```

Prometheus scrape + adapter rule mapping to `http_server_requests_seconds_count` rate.

### Virtual threads (Java 21) and scale

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

Virtual threads increase **cheap blocking concurrency** — you can handle more blocked I/O waits without OS thread exhaustion. They do **not**:

- Increase DB connection budget
- Protect downstream from overload
- Remove need for backpressure and pool sizing

Treat virtual threads as "more concurrent waiters," not infinite throughput.

### Spring Cloud Kubernetes

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-kubernetes-client</artifactId>
</dependency>
```

Discovery via K8s Services; config from ConfigMaps; reload on change. Avoid over-reloading — connection pool recycle storms on every ConfigMap edit.

### Production scenario: ConfigMap reload drains pools

**Problem.** `@RefreshScope` on DataSource bean. ConfigMap change during incident. All pods refresh simultaneously; connection storm to DB.

**Fix.** Don't `@RefreshScope` DataSource; use external config for non-pool settings; rolling restart with maxUnavailable control for pool-affecting changes.

---

## 13. Observability for Scale and Availability

### Metrics that matter before CPU

| Metric | Alert condition | Meaning |
|---|---|---|
| `http.server.requests` p99 | SLO burn | User pain |
| `hikaricp.connections.pending` | > 0 sustained | Pool exhaustion incoming |
| `hikaricp.connections.timeout` | rate > 0 | Already exhausting |
| `tomcat.threads.busy / max` | > 0.85 | Thread cliff |
| `jvm.gc.pause` p99 | > 200ms | GC or heap pressure |
| `container_cpu_cfs_throttled_seconds_total` | rate high | CPU limit harm |
| `kube_pod_status_ready` | < minReplicas | HA broken |
| `pg_replication_lag_seconds` | > RPO budget | DR risk |

### Dashboard layout (SRE)

1. **Golden signals** per service — latency, traffic, errors, saturation
2. **Capacity headroom** — RPS vs load test max; pool active vs max
3. **HA view** — pods per AZ; ready vs desired
4. **DR view** — repl lag; last successful backup; DR region capacity %
5. **Autoscaling** — HPA desired vs current; scale events timeline

### Example Prometheus alerts

```yaml
groups:
  - name: capacity
    rules:
      - alert: HikariPoolPending
        expr: hikaricp_connections_pending{pool="orders-pool"} > 5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Orders pool threads waiting for DB connections"

      - alert: ErrorBudgetBurn
        expr: |
          sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))
          / sum(rate(http_server_requests_seconds_count[5m])) > 0.01
        for: 5m
        labels:
          severity: critical

      - alert: ReplicationLagExceedsRPO
        expr: pg_replication_lag_seconds > 60
        for: 1m
        labels:
          severity: critical
```

### Tracing scale issues

Look for spans where **gap** between service time and DB time = pool wait or thread queue. Tag spans with `pod.name`, `availability_zone` during AZ incidents.

### Production scenario: metrics green, users angry

**Problem.** CPU 30%, error rate 0.5% (below 1% alert). Support queue long.

**Cause.** 0.5% on checkout = thousands failed orders; alert threshold wrong; p99 latency 6s not alerted.

**Fix.** SLO-based alerts (burn rate); p99 latency; business metric `orders_completed_rate` drop.

---

## 14. Production Debugging Playbook

When outage looks like "we need to scale," work through this list — scaling without diagnosis often worsens metastable failures.

1. **Classify the cliff.** Thread pool? Connection pool? Disk full? OOM? LB no backends? DNS? Identify **first saturating resource** from metrics, not guesses.

2. **Check HA posture immediately.**

   ```bash
   kubectl get pods -o wide -n checkout
   kubectl get pdb -n checkout
   kubectl get endpointslices -n checkout
   ```

   Uneven AZ distribution or all pods NotReady = HA/config issue, not traffic.

3. **Pool metrics before pod count.**

   ```bash
   curl -s localhost:8080/actuator/metrics/hikaricp.connections | jq
   curl -s localhost:8080/actuator/metrics/tomcat.threads.busy | jq
   ```

4. **Compare RPS vs last week same hour.** Organic spike vs deploy vs DDoS vs batch job overlap.

5. **Recent changes.** Deploy, ConfigMap, HPA max raised, pool size change, feature flag, marketing email sent.

6. **Database side.**

   ```sql
   SELECT count(*), state FROM pg_stat_activity GROUP BY state;
   SELECT * FROM pg_stat_activity WHERE wait_event IS NOT NULL LIMIT 20;
   ```

7. **Stop amplification.** Temporarily reduce client retries, enable gateway rate limit, increase circuit breaker sensitivity — **before** adding 50 pods.

8. **If scaling out is correct:** pre-check `pods × pool_size < DB max`; scale data tier or pooler first; use scheduled pre-warm next time.

9. **DR/regional:** check global health checks, replication lag, DNS TTL, failover runbook step — don't fail over twice.

10. **Post-incident:** update capacity sheet; load test gap; fix alert thresholds; document saturating resource.

---

## 15. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Stateless API traffic growth | Horizontal scale + pool math + cache |
| JVM heap pressure, stable RPS | Vertical memory **after** leak profile; tune GC |
| I/O-bound, CPU-low, latency high | Fix pools, threads, queries — not CPU HPA |
| Predictable traffic spike (sale) | Scheduled pre-scale + load test + CDN |
| AZ outage tolerance required | Replicas across AZ + topology spread + PDB |
| Global users, latency-sensitive | Multi-region read path + home-region writes |
| Regional catastrophe | DR tier with tested RTO; cross-region backups |
| RPO near zero | Sync repl or global consistent store; accept latency cost |
| RTO < 15 min | Hot/warm DR capacity; automated DNS failover |
| `too many clients already` | Reduce per-pod pool; add PgBouncer/RDS Proxy; fewer pods can help |
| Connection leak suspected | Leak detection staging; thread dump; heap dump |
| Ephemeral port errors outbound | HTTP connection pool reuse; check NAT capacity |
| Metastable failure (won't recover) | Shed load; reduce retries; scale **down** clients temporarily |
| Monolith can't split yet | Vertical + optimize; plan extraction; don't pretend microservices |
| Virtual threads enabled | Still cap DB and HTTP pools; monitor downstream |
| Failover complete but errors persist | Cache cold; wrong DB endpoint; Kafka offset; idempotency |
| Cost vs HA argument | Present error budget €/$; BIA-driven tier selection |

---

## 16. Interview Q&A

### Q1. What is the difference between horizontal and vertical scaling?

**A.** Horizontal scaling adds more instances (scale out) behind a load balancer; vertical scaling increases resources (CPU, RAM) on existing instances (scale up). Horizontal improves fault tolerance and has softer ceilings for stateless tiers; vertical is simpler but has hardware limits and larger blast radius per node. Production microservices typically scale app tiers horizontally and data tiers vertically until sharding/replicas are required.

### Q2. When does horizontal scaling stop helping?

**A.** When the bottleneck is a shared resource that doesn't scale with pod count: single-leader database writes, exhausted connection limits, unpartitioned hot keys, synchronous cross-service chains, or workloads that require sticky local state. Adding pods then increases contention and can reduce availability.

### Q3. Explain HPA and what metrics you'd use for a Java microservice.

**A.** Horizontal Pod Autoscaler adjusts Deployment replicas based on metrics. Default CPU works for CPU-bound services; I/O-bound Java services often need custom metrics (requests per second, concurrent requests, queue lag) because CPU stays low while threads block. Combine scale-up policies with pool/DB limits and scale-down stabilization to prevent flapping and downstream collapse.

### Q4. What is capacity planning vs autoscaling?

**A.** Capacity planning proactively models peak traffic, headroom, dependency limits, and cost before events occur. Autoscaling reactively adjusts capacity to current demand. Autoscaling without capacity planning leads to late scale-up, exceeded DB limits, and DR regions that can't absorb failover. Both are required: plan the ceiling, autoscale within safe bounds.

### Q5. How do you calculate database connection pool size in Kubernetes?

**A.** Start from database `max_connections` minus admin/replica reserve. Divide by maximum expected pod count to get per-pod pool size. Formula: `pool_per_pod = floor((max_conn × 0.8) - reserve) / max_pods`. Add PgBouncer/RDS Proxy to multiplex. Revisit whenever HPA `maxReplicas` or node pool size changes.

### Q6. What is high availability and how is it different from scalability?

**A.** Scalability is handling load growth; high availability is continuing to serve correctly despite failures. HA uses redundancy (multi-instance, multi-AZ), health checks, automatic failover, and graceful degradation. A system can scale to many pods but still be unavailable if all pods are in one AZ or readiness is wrong.

### Q7. Compare active-active and active-passive multi-region designs.

**A.** Active-active serves traffic from multiple regions simultaneously — lower latency globally, higher complexity for writes and data consistency. Active-passive keeps a primary region serving traffic with a standby for DR — simpler, higher RTO/RPO unless warm standby is maintained. Choose based on RPO/RTO, data residency, and conflict tolerance.

### Q8. What are RPO and RTO?

**A.** RPO (Recovery Point Objective) is the maximum acceptable data loss measured in time — how far back you might lose data. RTO (Recovery Time Objective) is the maximum acceptable downtime to restore service. They are business targets that drive backup frequency, replication mode (sync vs async), and DR architecture cost.

### Q9. How does async replication affect RPO?

**A.** Async replication lag equals minimum achievable RPO under failover at that moment. If lag is 30 seconds, you may lose up to 30 seconds of writes unless you reconcile from an event log. Sync replication approaches RPO ≈ 0 but increases write latency and ties availability to replica health.

### Q10. What is a disaster recovery runbook and what must it include?

**A.** A step-by-step tested procedure to restore service after catastrophic failure. Must include: trigger criteria, roles, communication plan, steps to promote/restore data, traffic redirection (DNS/LB weights), validation checks, rollback/failback, and RPO/RTO assumptions. Untested runbooks are unreliable; game days measure actual RTO.

### Q11. Why can autoscaling make an outage worse?

**A.** More pods multiply connections, cache misses, and downstream calls during degradation — classic metastable failure. HPA reacting to lagging indicators scales into a saturated database. Mitigation: correct metrics, max replica caps, admission control, poolers, circuit breakers, and fixing downstream before scaling clients.

### Q12. Explain connection pooling and why it matters for microservices.

**A.** Pooling reuses open connections to avoid repeated handshake cost and to cap concurrent usage. In microservices, total connections = pods × pool size; careless horizontal scaling exhausts database `max_connections`. Pooling also bounds resource usage and enables fail-fast when saturated (`connection-timeout`).

### Q13. What is resource exhaustion and give an example cascade.

**A.** Resource exhaustion is hitting a hard limit on threads, connections, memory, file descriptors, disk, or network tables. Example: DB connections max → app threads block → Tomcat queue full → 503 → client retries → more connection attempts → system stays unhealthy after DB recovers (metastable). Fix requires load shedding and reducing retries, not only restoring DB.

### Q14. PgBouncer transaction pooling vs session pooling — when to use which?

**A.** Transaction pooling multiplexes many clients to fewer DB connections per transaction — best for stateless short transactions. Session pooling holds a DB connection for the client session — required when using prepared statements tied to session, temp tables, advisory locks, or `LISTEN/NOTIFY`. ORMs like Hibernate often need session mode or careful config with transaction pooling.

### Q15. How do readiness and liveness probes differ for availability?

**A.** Readiness determines if a pod receives traffic; failing readiness removes it from Service endpoints without restarting. Liveness determines if the container is dead; failing liveness restarts the pod. Put critical dependencies needed for serving traffic in readiness; keep liveness minimal (JVM alive) to avoid cascade kills on transient DB blips.

### Q16. What is a Pod Disruption Budget and why use it?

**A.** PDB limits voluntary disruptions (node drains, cluster upgrades) so a minimum number of pods stay available. Without PDB, Kubernetes may evict all pods of a Deployment during node maintenance, causing outage despite normal replica count.

### Q17. How would you design for 99.99% availability?

**A.** Multi-AZ active serving, N+2 capacity headroom, no single points of failure in app and data paths, automated health-based failover, graceful shutdown, chaos/game-day testing, SLO/error budget governance, observability on saturation not just errors, and DR region tested for regional failure. Four nines ≈ 52 minutes downtime/year — maintenance and dependency failures must fit in error budget.

### Q18. What is Little's Law and why should SREs care?

**A.** L = λ × W: average concurrent work = arrival rate × average time in system. If latency W doubles at fixed RPS λ, in-flight requests L doubles — queues grow nonlinearly. Capacity planning with average latency understates required threads and pool size; use p99 W.

### Q19. How do virtual threads change scaling considerations in Java 21?

**A.** Virtual threads allow many blocking tasks without one OS thread each, improving throughput for I/O-bound work on moderate hardware. They don't increase database connection limits, downstream QPS tolerance, or eliminate backpressure. Pool sizing and bulkheads remain essential; you may handle more concurrent waits, not infinite load.

### Q20. Describe a multi-region failover that minimizes RTO.

**A.** Maintain warm K8s and app replicas in DR region; continuous async replication with lag monitoring; automated global health checks; runbook to shift DNS/LB weights; pre-validated connection strings and secrets in DR; smoke tests before full traffic; communicate degraded mode if writes lag. Practice quarterly; measure RTO/RPO; automate everything except declare incident decision if required.

### Q21. What is the 3-2-1 backup rule?

**A.** Three copies of data, on two different types of storage/media, with one copy offsite (or cross-region). Protects against hardware failure, operator error, and regional disaster. Must include regular restore tests to validate RPO claims.

### Q22. How do you prevent connection pool exhaustion during traffic spikes?

**A.** Size pools from DB max and max pods; use PgBouncer; set short `connection-timeout` for fail-fast; align Tomcat/virtual thread concurrency with sustainable pool size; cache read-heavy data; rate limit at gateway; avoid retry storms; pre-warm before known spikes; alert on `connections.pending` before timeouts appear.

### Q23. What is the difference between scalability and performance?

**A.** Performance is how fast one request completes under given resources; scalability is how throughput grows as resources increase. Optimizing performance (faster queries) improves scalability efficiency; adding pods without performance tuning may yield negative returns when shared bottlenecks dominate.

### Q24. How would you load test for Black Friday readiness?

**A.** Baseline at current peak; soak at 2× for hours; spike 0→5× in one minute; failure injection (AZ loss, pod kill); mix read/write realistic payloads; measure p99 latency, error rate, pool pending, DB lag, cost; validate HPA and pre-warm scripts; document max sustainable RPS and gap to forecast with remediation plan.

### Q25. What is a metastable failure in scaling context?

**A.** A failure state persisting after the initial trigger is removed because the system operates beyond a stable point — e.g., retries keep DB saturated, pools never drain, breakers flap. Recovery requires reducing load (shed retries, open circuits, temporarily lower maxReplicas), not only fixing the original component.

### Q26. When would you choose vertical scaling over horizontal for a microservice?

**A.** Short-term mitigation when state cannot be externalized quickly; memory-bound single-node processing; licensed per-node software; or when operational complexity of sharding exceeds benefit. Always pair with plan to horizontal scale or partition before vertical ceilings (CPU/memory/disk IOPS) block growth.

### Q27. How do topology spread constraints improve HA?

**A.** They enforce even pod distribution across failure domains (zones, nodes). Prevents accidentally running all replicas in one AZ due to scheduler packing or node pool configuration — a common cause of "we had replicas but AZ outage took us down."

### Q28. Explain graceful shutdown in Kubernetes and Spring Boot.

**A.** On SIGTERM, Kubernetes removes pod from Service endpoints (after preStop/deregistration delay); Spring `server.shutdown=graceful` stops accepting new requests and completes in-flight work within timeout; then container exits. Prevents mid-request failures during deploys and scale-down. Set `terminationGracePeriodSeconds` longer than worst-case request time.

---

*Scalability without pool math is horizontal scaling into a wall. Availability without tested failover is redundancy on paper. Measure saturation before CPU, cap total connections before maxReplicas, and run the DR game day before the region runs the game on you.*
