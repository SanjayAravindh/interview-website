# Microservices Resilience & Fault Tolerance — Senior Production Reference

Resilience4j 2.x / Spring Cloud Circuit Breaker / Spring Boot 3.x. Servlet and reactive stacks are both covered; differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping microservices, mesh sidecars, and JVM backends that call other people's APIs.

---

## Table of Contents

1. [Mental Model: One Call Through the Resilience Stack](#1-mental-model-one-call-through-the-resilience-stack)
2. [Circuit Breaker](#2-circuit-breaker)
3. [Retry Pattern](#3-retry-pattern)
4. [Retry with Exponential Backoff](#4-retry-with-exponential-backoff)
5. [Timeout Handling](#5-timeout-handling)
6. [Bulkhead Pattern](#6-bulkhead-pattern)
7. [Rate Limiting](#7-rate-limiting)
8. [Throttling](#8-throttling)
9. [Cascading Failures](#9-cascading-failures)
10. [Graceful Degradation](#10-graceful-degradation)
11. [Fail Fast](#11-fail-fast)
12. [Failover](#12-failover)
13. [Load Shedding](#13-load-shedding)
14. [Adaptive Timeouts](#14-adaptive-timeouts)
15. [Retry Storm](#15-retry-storm)
16. [Thundering Herd Problem](#16-thundering-herd-problem)
17. [Resilience4j + Spring Boot 3 Integration](#17-resilience4j-spring-boot-3-integration)
18. [Spring Cloud Circuit Breaker Abstraction](#18-spring-cloud-circuit-breaker-abstraction)
19. [Observability: Metrics, Traces, and Alerts](#19-observability-metrics-traces-and-alerts)
20. [Testing Resilience Configuration](#20-testing-resilience-configuration)
21. [Production Debugging Playbook](#21-production-debugging-playbook)
22. [Quick Decision Matrix](#22-quick-decision-matrix)

---

## 1. Mental Model: One Call Through the Resilience Stack

Resilience is not a library you sprinkle on `@RestController`. It is a **layered policy** applied around outbound calls (and sometimes inbound admission control) so that partial failure does not become total outage. Every pattern answers a different question: *how long to wait*, *how many times to try*, *when to stop trying*, *how much concurrency to allow*, and *what to return when the dependency is gone*.

```
Client request
  └─ Inbound admission (optional)
       ├─ Rate limiter / load shedder at API gateway or service edge
       └─ Controller / handler
            └─ Service layer
                 └─ Outbound call stack (typical order — outermost first)
                      ├─ TimeLimiter / client timeout          "stop waiting"
                      ├─ CircuitBreaker                        "stop calling a dead dependency"
                      ├─ Retry (+ backoff + jitter)            "transient blip recovery"
                      ├─ Bulkhead (semaphore / thread pool)    "don't let one dependency eat the JVM"
                      └─ HTTP client / gRPC stub / DB driver
                           └─ Remote dependency
```

Three objects you must keep distinct:

| Object | Question it answers | Resilience4j type |
|---|---|---|
| **Timeout** | How long may this call block before we give up? | `TimeLimiter`, client `connectTimeout`/`readTimeout` |
| **Circuit breaker** | Should we even attempt this call right now? | `CircuitBreaker` |
| **Fallback** | What do we return when the call fails or is skipped? | `@CircuitBreaker(fallbackMethod=...)`, `recover` in Vavr `Try` |

A **503 from your service** may mean the dependency is down, your bulkhead is full, your circuit is open, or you are load-shedding — mixing those up is the single most common senior misdiagnosis. Check metrics (`resilience4j.circuitbreaker.state`, `resilience4j.bulkhead.available_concurrent_calls`) before blaming the network.

### Pattern composition order matters

Resilience4j decorators compose **inside-out** when using the functional API:

```java
Supplier<String> decorated = Decorators.ofSupplier(remoteClient::fetch)
    .withCircuitBreaker(circuitBreaker)
    .withRetry(retry)
    .withTimeLimiter(timeLimiter, scheduledExecutor)
    .withBulkhead(bulkhead)
    .decorate();
```

Spring Cloud / annotation order is less explicit. Rule of thumb for outbound calls:

1. **Bulkhead** — cap concurrency first so retries don't multiply threads.
2. **TimeLimiter / timeout** — bound wait per attempt.
3. **Retry** — only for idempotent, transient failures.
4. **Circuit breaker** — often wraps the whole decorated call (including retries) so repeated failures trip the breaker.

Putting retry **outside** a circuit breaker that counts failures per call (not per attempt) trips the breaker after one logical operation that retried five times — usually what you want. Putting retry **inside** an open circuit wastes retry budget on calls that will never reach the wire.

### Production scenario: "We added Resilience4j and latency doubled"

**Problem.** Team wraps every Feign client with `@Retry` and `@CircuitBreaker` after a payment-provider outage. P99 latency jumps from 120ms to 800ms during normal operation. Payment success rate unchanged.

**Cause.** Retry configured with `maxAttempts=5`, `waitDuration=500ms`, no jitter, on **non-idempotent** POST endpoints. Transient 503s from the provider (normal maintenance window) cause five sequential attempts per request. Circuit breaker never opens because each attempt eventually succeeds on attempt 3–4.

**Solution.**

```yaml
resilience4j:
  retry:
    instances:
      paymentProvider:
        maxAttempts: 3
        waitDuration: 100ms
        enableExponentialBackoff: true
        exponentialBackoffMultiplier: 2
        retryExceptions:
          - java.net.SocketTimeoutException
          - org.springframework.web.client.ResourceAccessException
        ignoreExceptions:
          - com.example.PaymentDeclinedException   # business failure — do not retry
  circuitbreaker:
    instances:
      paymentProvider:
        slidingWindowSize: 50
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
        permittedNumberOfCallsInHalfOpenState: 5
```

Only retry **idempotent** reads and explicitly whitelisted transient errors. Never retry `400`, `401`, `403`, `404`, or business exceptions.

---

## 2. Circuit Breaker

### Core concept

A circuit breaker is a **state machine** that stops calling a failing dependency so threads, connection pools, and the dependency itself get a chance to recover. It is named after electrical breakers: when current (failures) exceeds threshold, the circuit **opens** and calls fail fast without hitting the wire.

States:

```
CLOSED  ──(failure rate / slow call rate exceeds threshold)──► OPEN
   ▲                                                              │
   │                                                              │ waitDurationInOpenState
   │                                                              ▼
   └────(successes in half-open)────────────────────────── HALF_OPEN
              ▲                         │
              │                         └──(any failure)──► OPEN
              └──(failure in half-open)──► OPEN
```

| State | Behavior |
|---|---|
| `CLOSED` | All calls pass through; failures are counted in sliding window |
| `OPEN` | Calls immediately fail with `CallNotPermittedException` (fail fast) |
| `HALF_OPEN` | Limited probe calls allowed; success → CLOSED, failure → OPEN |

### Internal working (Resilience4j)

1. Every completed call records outcome in a **ring buffer** (`slidingWindowSize` calls or `slidingWindowType=TIME_BASED` over `slidingWindowSize` seconds).
2. When window fills, Resilience4j computes `failureRate` and optionally `slowCallRate` (calls slower than `slowCallDurationThreshold`).
3. If `failureRate >= failureRateThreshold` (default 50%) or slow-call rate exceeds `slowCallRateThreshold`, state → `OPEN`, `CircuitBreakerOnStateTransitionEvent` published.
4. After `waitDurationInOpenState`, next call attempt transitions to `HALF_OPEN` (lazy — on next invocation, not a background timer in all versions).
5. In `HALF_OPEN`, at most `permittedNumberOfCallsInHalfOpenState` calls are allowed. All must succeed to close; one failure reopens.

Important: **slow calls count as failures** when slow-call rate threshold is configured. A dependency that responds in 29s on a 30s timeout may never register as a hard failure but will trip the breaker on slow-call rate — this is intentional.

### Resilience4j + Spring Boot 3 example

**Dependencies:**

```xml
<dependency>
  <groupId>io.github.resilience4j</groupId>
  <artifactId>resilience4j-spring-boot3</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

**Configuration:**

```yaml
resilience4j:
  circuitbreaker:
    configs:
      default:
        registerHealthIndicator: true
        slidingWindowSize: 100
        minimumNumberOfCalls: 10
        permittedNumberOfCallsInHalfOpenState: 5
        automaticTransitionFromOpenToHalfOpenEnabled: true
        waitDurationInOpenState: 60s
        failureRateThreshold: 50
        slowCallRateThreshold: 80
        slowCallDurationThreshold: 3s
    instances:
      inventoryService:
        baseConfig: default
        waitDurationInOpenState: 30s
      legacyMainframe:
        baseConfig: default
        failureRateThreshold: 30
        waitDurationInOpenState: 120s
```

**Annotation usage:**

```java
@Service
public class OrderService {

    private final InventoryClient inventoryClient;

    @CircuitBreaker(name = "inventoryService", fallbackMethod = "inventoryFallback")
    public StockCheckResult checkStock(long skuId, int qty) {
        return inventoryClient.check(skuId, qty);
    }

    private StockCheckResult inventoryFallback(long skuId, int qty, CallNotPermittedException ex) {
        // circuit OPEN — do not call inventory; return degraded response
        return StockCheckResult.unknown("inventory circuit open");
    }

    private StockCheckResult inventoryFallback(long skuId, int qty, Exception ex) {
        // call attempted but failed — different semantics than open circuit
        return StockCheckResult.unknown("inventory unavailable: " + ex.getClass().getSimpleName());
    }
}
```

Fallback method signatures must match the original **plus** a trailing `Throwable` (or specific exception type). Overload by exception type — most specific match wins.

**Programmatic registration (preferred for libraries / non-Spring code paths):**

```java
@Configuration
public class CircuitBreakerConfig {

    @Bean
    CircuitBreakerRegistry circuitBreakerRegistry() {
        CircuitBreakerConfig config = CircuitBreakerConfig.custom()
            .slidingWindowType(SlidingWindowType.COUNT_BASED)
            .slidingWindowSize(50)
            .minimumNumberOfCalls(10)
            .failureRateThreshold(50)
            .waitDurationInOpenState(Duration.ofSeconds(30))
            .build();
        return CircuitBreakerRegistry.of(config);
    }
}
```

### Spring Cloud Circuit Breaker (abstraction layer)

Spring Cloud Circuit Breaker wraps Resilience4j (or Reactor Resilience4j) behind a factory:

```java
@Service
public class CatalogService {

    private final CircuitBreakerFactory circuitBreakerFactory;
    private final RestClient restClient;

    public CatalogService(CircuitBreakerFactory circuitBreakerFactory, RestClient.Builder builder) {
        this.circuitBreakerFactory = circuitBreakerFactory;
        this.restClient = builder.baseUrl("http://catalog").build();
    }

    public Product getProduct(String id) {
        CircuitBreaker cb = circuitBreakerFactory.create("catalog");
        return cb.run(
            () -> restClient.get().uri("/products/{id}", id).retrieve().body(Product.class),
            throwable -> Product.placeholder(id)
        );
    }
}
```

Use Spring Cloud when you want vendor swap (Resilience4j vs Sentinel) or consistent API across reactive/imperative. Use raw Resilience4j annotations when you need fine-grained YAML per instance and AOP on service methods.

### Production scenario: circuit never opens during a real outage

**Problem.** Inventory DB dies. Order service threads block for 30s on every `checkStock` call. Circuit breaker metric stays `CLOSED`. Pod CPU pegs, thread pool exhausted, order API 503s.

**Cause.** `minimumNumberOfCalls` is 100 but traffic to inventory is only 5 req/s during the incident window — window never fills, failure rate never computed. Separately, `TimeLimiter` was not configured; calls block on socket read timeout (30s) and Resilience4j counts them as **slow successes** if they eventually return empty/error body without throwing.

**Solution.**

```yaml
resilience4j:
  circuitbreaker:
    instances:
      inventoryService:
        minimumNumberOfCalls: 5          # lower for low-traffic deps
        slidingWindowSize: 20
        slowCallRateThreshold: 50
        slowCallDurationThreshold: 2s
  timelimiter:
    instances:
      inventoryService:
        timeoutDuration: 2s
        cancelRunningFuture: true
```

Pair every circuit breaker with a **hard timeout** shorter than the client's default. Ensure failures **throw** (don't swallow HTTP 500 as a normal response body without exception).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No `minimumNumberOfCalls` tuning for low-traffic deps | Breaker stays CLOSED while dependency is dead |
| Shared circuit breaker name for unrelated endpoints | One bad endpoint opens breaker for entire service |
| Fallback calls the same broken dependency | Infinite loop or masked root cause |
| `recordExceptions` too narrow | Failures not counted; breaker never trips |
| Retry outside breaker with high `maxAttempts` | Breaker sees one failure per logical call but latency explodes |
| No fallback for OPEN state | `CallNotPermittedException` bubbles as 500 to clients |
| `waitDurationInOpenState` too short | Breaker flaps OPEN/HALF_OPEN, hammering recovering dependency |

### Debugging scenario

**Observe.** `GET /orders/{id}` returns 500 with `CallNotPermittedException` in logs after inventory incident "resolved" 2 minutes ago.

**Diagnose.**

```bash
curl -s http://localhost:8080/actuator/circuitbreakers | jq '.circuitBreakers.inventoryService'
curl -s http://localhost:8080/actuator/metrics/resilience4j.circuitbreaker.state | jq
```

Check: `state` (0=CLOSED, 1=OPEN, 2=HALF_OPEN), `failureRate`, `slowCallRate`, `bufferedCalls`. If OPEN with low failure rate in metrics, half-open probes may be failing. If HALF_OPEN stuck, probe calls may all be timing out.

**Fix.** Confirm dependency health independently (`curl` inventory directly). Adjust `permittedNumberOfCallsInHalfOpenState` and ensure half-open probes use the same timeout as production. Manual reset only in emergencies:

```java
circuitBreakerRegistry.circuitBreaker("inventoryService").transitionToClosedState();
```

Prefer letting half-open succeed naturally; forced close hides misconfigured thresholds.

---

## 3. Retry Pattern

### Core concept

Retry re-executes a failed operation when failure is **transient** — network blip, `503 Service Unavailable`, connection reset, leader election in DB. Retry is dangerous on **non-idempotent** writes unless you have deduplication keys, outbox pattern, or the downstream is explicitly idempotent.

Retry does **not** fix:

- Overloaded dependencies (retry amplifies load → retry storm)
- Permanent errors (`400`, `404`, business validation)
- Timeouts that exceed SLA (retry multiplies tail latency)

### Internal working (Resilience4j Retry)

```
attempt 1 ──fail (retryable)──► wait waitDuration ──► attempt 2 ──fail──► ... ──► attempt N ──► propagate exception
                              ▲
                              └── exponential backoff + jitter (optional)
```

Config keys:

| Property | Meaning |
|---|---|
| `maxAttempts` | Total attempts including first (3 = 1 initial + 2 retries) |
| `waitDuration` | Fixed delay between attempts (before backoff multiplier) |
| `retryExceptions` | Only these trigger retry (empty = all except ignoreExceptions) |
| `ignoreExceptions` | Never retry these |
| `resultPredicate` | Retry when result matches condition (e.g. empty optional) |

Events: `RetryOnRetryEvent`, `RetryOnSuccessEvent`, `RetryOnErrorEvent` — wire to Micrometer.

### Spring Boot 3 example

```yaml
resilience4j:
  retry:
    configs:
      default:
        maxAttempts: 3
        waitDuration: 200ms
        retryExceptions:
          - java.io.IOException
          - org.springframework.web.client.HttpServerErrorException
        ignoreExceptions:
          - org.springframework.web.client.HttpClientErrorException
    instances:
      catalogRead:
        baseConfig: default
      paymentWrite:
        maxAttempts: 1   # effectively disable retry for writes
```

```java
@Retry(name = "catalogRead")
public List<Product> listProducts(String category) {
    return catalogClient.list(category);
}
```

**Composable with circuit breaker:**

```java
@CircuitBreaker(name = "catalogRead", fallbackMethod = "listFallback")
@Retry(name = "catalogRead")
@TimeLimiter(name = "catalogRead")
public CompletableFuture<List<Product>> listProductsAsync(String category) {
    return CompletableFuture.supplyAsync(() -> catalogClient.list(category));
}
```

Note: `@TimeLimiter` requires `CompletableFuture` return type when using annotations.

### Production scenario: retry on POST creates duplicate orders

**Problem.** Checkout POST to order service retries on `SocketTimeoutException`. Client sees timeout, user clicks "Pay" again. Three orders created for one payment.

**Cause.** Timeout fired on client while server actually processed the request. Retry (automatic or user-driven) duplicates the write.

**Solution.**

1. Disable retry on non-idempotent endpoints (`maxAttempts: 1`).
2. Require `Idempotency-Key` header; server stores key → response mapping for 24h.
3. Use outbox + message queue for order creation instead of synchronous POST retry.

```java
@PostMapping("/orders")
public ResponseEntity<Order> create(@RequestHeader("Idempotency-Key") String key,
                                    @RequestBody CreateOrderRequest req) {
    return idempotencyService.execute(key, () -> orderService.create(req));
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Retry all exceptions | 400 validation retried 3×, logs flooded |
| Retry on POST without idempotency | Duplicate records, double charges |
| `maxAttempts=10` on high QPS | Retry storm takes down recovering service |
| No `ignoreExceptions` for business errors | Pointless retries, inflated error budgets |
| Retry without timeout | Each attempt waits full socket timeout |

### Debugging scenario

**Observe.** Downstream returns 503 for 30 seconds during deploy. Your service logs show 3× request volume to downstream per incoming call.

**Diagnose.** Enable retry event logging:

```yaml
logging.level.io.github.resilience4j.retry: DEBUG
```

Check `resilience4j_retry_calls_total` with tag `kind=failed_with_retry`. Correlate with downstream deploy window.

**Fix.** Reduce `maxAttempts`, add exponential backoff + jitter, ensure circuit breaker opens to stop retries during sustained 503.

---

## 4. Retry with Exponential Backoff

### Core concept

Exponential backoff increases wait time between retries: `wait = waitDuration × multiplier^attempt`. **Jitter** randomizes the wait (`± random fraction`) so synchronized clients don't retry in lockstep (thundering herd on the recovering service).

Resilience4j:

```yaml
resilience4j:
  retry:
    instances:
      searchIndex:
        maxAttempts: 5
        waitDuration: 100ms
        enableExponentialBackoff: true
        exponentialBackoffMultiplier: 2.0
        enableRandomizedWait: true
        randomizedWaitFactor: 0.5   # wait ± 50%
```

Wait sequence (no jitter): 100ms → 200ms → 400ms → 800ms → (attempt 5 fails).

With jitter on attempt 3: base 400ms, actual wait ∈ [200ms, 600ms].

### Internal working

Resilience4j computes:

```
interval = waitDuration * (multiplier ^ (attempt - 1))
if randomized: interval = interval * (1 - randomizedWaitFactor + random * 2 * randomizedWaitFactor)
Thread.sleep(interval)  // or scheduler for async
```

For async/reactive, use `IntervalFunction` with Resilience4j's retry policy or Spring Retry's `ExponentialBackOffPolicy` if not on Resilience4j.

**Programmatic (full control):**

```java
RetryConfig config = RetryConfig.custom()
    .maxAttempts(4)
    .intervalFunction(IntervalFunction.ofExponentialRandomBackoff(
        Duration.ofMillis(200), 2.0, 0.5))
    .retryExceptions(IOException.class, TimeoutException.class)
    .build();
Retry retry = Retry.of("elasticSearch", config);
```

### AWS / gRPC / industry alignment

| System | Default backoff |
|---|---|
| AWS SDK v2 | Exponential with full jitter |
| gRPC | Exponential backoff in service config |
| Kubernetes client-go | `wait.Backoff` with steps |
| Resilience4j | `enableExponentialBackoff` + `enableRandomizedWait` |

Always prefer **full jitter** (AWS pattern): `sleep = random(0, min(cap, base × 2^attempt))` for large fan-out clients. Resilience4j's `randomizedWaitFactor` approximates this.

### Production scenario: Elasticsearch yellow cluster, retry without backoff

**Problem.** ES cluster goes yellow; search API returns 503. 50 pod replicas each retry 5 times at 200ms fixed interval. ES gets 250× traffic spike per original QPS, stays red for 20 minutes.

**Cause.** Fixed backoff + no jitter + no circuit breaker. All pods retry on the same schedule.

**Solution.**

```yaml
resilience4j:
  retry:
    instances:
      elasticsearch:
        maxAttempts: 3
        waitDuration: 50ms
        enableExponentialBackoff: true
        exponentialBackoffMultiplier: 2
        enableRandomizedWait: true
        randomizedWaitFactor: 0.5
  circuitbreaker:
    instances:
      elasticsearch:
        failureRateThreshold: 40
        waitDurationInOpenState: 45s
        slidingWindowSize: 30
```

Add client-side **max total timeout** so one user request doesn't wait through all retries:

```java
// Total budget: 2s including all retries
@TimeLimiter(name = "elasticsearch", fallbackMethod = "searchFallback")
@Retry(name = "elasticsearch")
public CompletableFuture<SearchResult> search(String q) { ... }
```

```yaml
resilience4j:
  timelimiter:
    instances:
      elasticsearch:
        timeoutDuration: 2s
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Exponential backoff without cap | Last retry waits minutes |
| Multiplier too aggressive (10×) | Long gaps, user-facing timeout first |
| Jitter disabled on scheduled jobs | All pods hit dependency simultaneously at minute boundary |
| Backoff on circuit OPEN | Wasted waits — breaker should fail fast |

### Debugging scenario

**Observe.** Recovery after incident takes longer when more pods are running.

**Diagnose.** Plot retry attempt histogram per second. Synchronized spikes indicate missing jitter. Compare pod count vs downstream request rate during recovery.

**Fix.** Enable randomized wait; consider **decorrelated jitter** for large fleets (each client picks new random base each attempt).

---

## 5. Timeout Handling

### Core concept

Timeouts bound **how long a caller waits** for a response. They are not interchangeable with circuit breakers: a timeout ends one attempt; a breaker stops all attempts for a period. You need both.

Layers of timeout in a typical Spring Boot service:

```
1. Client connect timeout        (TCP handshake)
2. Client read/response timeout  (bytes on the wire)
3. Resilience4j TimeLimiter      (logical operation budget, can cancel Future)
4. Gateway / mesh timeout        (Envoy route timeout, nginx proxy_read_timeout)
5. Global servlet container timeout
```

The **shortest** timeout in the chain wins. Misaligned timeouts cause confusing behavior: gateway returns 504 while service still working, or service kills call gateway already abandoned (wasted work).

### Resilience4j TimeLimiter

```yaml
resilience4j:
  timelimiter:
    configs:
      default:
        timeoutDuration: 3s
        cancelRunningFuture: true
    instances:
      fraudCheck:
        timeoutDuration: 500ms
      reportGeneration:
        timeoutDuration: 30s
```

```java
@TimeLimiter(name = "fraudCheck", fallbackMethod = "fraudFallback")
public CompletableFuture<FraudScore> score(Transaction tx) {
    return CompletableFuture.supplyAsync(() -> fraudClient.score(tx), executor);
}

private CompletableFuture<FraudScore> fraudFallback(Transaction tx, TimeoutException ex) {
    return CompletableFuture.completedFuture(FraudScore.degraded());
}
```

`cancelRunningFuture: true` interrupts the underlying task on timeout — critical for thread pool hygiene. Without it, timed-out calls keep running in the background (bulkhead leak).

### RestClient / WebClient timeouts (Boot 3)

```java
@Bean
RestClient inventoryRestClient(RestClient.Builder builder) {
    SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(Duration.ofMillis(500));
    factory.setReadTimeout(Duration.ofSeconds(2));
    return builder
        .baseUrl("http://inventory")
        .requestFactory(factory)
        .build();
}
```

```java
@Bean
WebClient catalogWebClient(WebClient.Builder builder) {
    HttpClient httpClient = HttpClient.create()
        .responseTimeout(Duration.ofSeconds(2))
        .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 500);
    return builder
        .clientConnector(new ReactorClientHttpConnector(httpClient))
        .baseUrl("http://catalog")
        .build();
}
```

Feign (Spring Cloud OpenFeign):

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          inventory:
            connectTimeout: 500
            readTimeout: 2000
```

### Production scenario: cascading 504s from timeout mismatch

**Problem.** API gateway timeout = 5s. Order service calls 4 dependencies sequentially, each with 3s read timeout. Happy path = 4s. One slow dependency = 12s total. Gateway 504s at 5s; client retries; order service still processing orphaned calls.

**Cause.** Sequential calls without per-dependency budget; total path timeout not computed; no parallelization.

**Solution.**

1. Parallelize independent calls (`CompletableFuture.allOf` with shared deadline).
2. Set per-call timeout so sum ≤ gateway budget minus overhead.

```java
public OrderView enrichOrder(Order order) {
    Duration budget = Duration.ofSeconds(4);
    CompletableFuture<Stock> stock = callWithDeadline(() -> inventory.getStock(order.sku()), budget);
    CompletableFuture<ShipEta> eta = callWithDeadline(() -> shipping.eta(order.id()), budget);
    CompletableFuture.allOf(stock, eta).orTimeout(4, SECONDS).join();
    return OrderView.of(order, stock.join(), eta.join());
}
```

3. Document timeout chain in runbook: client 6s → gateway 5s → service 4s → deps 2s each.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Only gateway timeout, no client timeout | Threads blocked until OS TCP timeout (minutes) |
| TimeLimiter without `cancelRunningFuture` | Thread pool exhaustion after timeouts |
| Same 30s timeout for fraud and reporting | Fraud blocks checkout; reporting kills legitimate long jobs |
| Timeout > circuit breaker slow-call threshold | Slow calls counted as success until breaker trips |
| Reactive `block()` without timeout | Event loop stall (WebFlux) |

### Debugging scenario

**Observe.** Sporadic `TimeoutException` in `TimeLimiter` but downstream APM shows p99 = 800ms.

**Diagnose.** Check thread pool saturation (supplier runs on `ForkJoinPool.commonPool()` starved). Check DNS resolution delays. Compare TimeLimiter start/end with downstream trace span — gap indicates queue wait in bulkhead or thread pool, not slow HTTP.

**Fix.** Dedicated executor for timed calls; increase bulkhead size or reduce competing work; align TimeLimiter with actual client read timeout + small margin.

---

## 6. Bulkhead Pattern

### Core concept

Bulkhead isolates resources so failure or slowness in one dependency cannot exhaust shared thread pools, connection pools, or memory for the entire service. Named after ship compartments: one flooded section doesn't sink the vessel.

Two Resilience4j bulkhead types:

| Type | Mechanism | Use when |
|---|---|---|
| **Semaphore bulkhead** | Limits concurrent calls (same thread can serve many if non-blocking) | WebFlux, async, lightweight I/O |
| **Thread-pool bulkhead** | Dedicated pool + queue for blocking calls | Servlet stack, JDBC, blocking HTTP |

### Internal working

Semaphore bulkhead:

```
acquire permit (maxConcurrentCalls, default 25)
  ├─ available → proceed
  └─ full → CallNotPermittedException immediately (or wait maxWaitDuration if configured)
release permit in finally
```

Thread-pool bulkhead:

```
submit task to dedicated ThreadPoolExecutor (core, max, queueCapacity)
  ├─ queue has space → run on bulkhead thread
  └─ queue full → BulkheadFullException
```

Metrics: `resilience4j.bulkhead.available_concurrent_calls`, `resilience4j.threadpoolbulkhead.queue_depth`.

### Spring Boot 3 example

```yaml
resilience4j:
  bulkhead:
    instances:
      inventory:
        maxConcurrentCalls: 20
        maxWaitDuration: 0        # fail fast when full — preferred for latency-sensitive paths
  thread-pool-bulkhead:
    instances:
      legacySoap:
        maxThreadPoolSize: 10
        coreThreadPoolSize: 5
        queueCapacity: 20
        keepAliveDuration: 20s
```

```java
@Bulkhead(name = "inventory", type = Bulkhead.Type.SEMAPHORE, fallbackMethod = "stockFallback")
public StockLevel getStock(long sku) {
    return inventoryClient.getStock(sku);
}

@Bulkhead(name = "legacySoap", type = Bulkhead.Type.THREADPOOL, fallbackMethod = "soapFallback")
public LegacyQuote getQuote(String account) {
    return soapClient.fetchQuote(account);  // blocking
}
```

### Production scenario: one slow report endpoint kills checkout

**Problem.** `/reports/generate` and `/checkout` share Tomcat's 200 worker threads. Report runs 60s queries. Black Friday: 180 threads stuck in reports, checkout 503s despite healthy payment provider.

**Cause.** No bulkhead isolation between admin/report traffic and customer-facing paths.

**Solution.**

1. Separate deployment for report service (best).
2. If monolith: thread-pool bulkhead on report service methods + gateway route rate limit on `/reports/**`.
3. Virtual threads (Java 21) help throughput but do **not** replace bulkheads — they increase how many blocking calls you can pile up before dying.

```yaml
resilience4j:
  thread-pool-bulkhead:
    instances:
      reports:
        maxThreadPoolSize: 15
        queueCapacity: 5
  bulkhead:
    instances:
      checkout:
        maxConcurrentCalls: 100
        maxWaitDuration: 0
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| One bulkhead for all outbound calls | Unrelated dep exhausts permits |
| `maxWaitDuration` too long on checkout | Latency piles up instead of fail fast |
| Thread-pool bulkhead on WebFlux event loop | Wrong tool — use semaphore + async |
| Bulkhead size > downstream capacity | You become the retry storm source |
| No fallback on `BulkheadFullException` | 500 instead of degraded response |

### Debugging scenario

**Observe.** `BulkheadFullException` during peak but CPU is 40%.

**Diagnose.** Permits held by slow calls, not high CPU. Thread dump: bulkhead pool threads blocked on socket read. Check `resilience4j_bulkhead_concurrent_calls` vs `maxConcurrentCalls`.

**Fix.** Lower upstream timeout so permits release faster; increase bulkhead only if downstream can handle it; split bulkheads per dependency.

---

## 7. Rate Limiting

### Core concept

Rate limiting caps **how many requests** are allowed per time window — protecting your service (inbound) or respecting downstream quotas (outbound). Unlike throttling (often smooths rate), rate limiters typically enforce hard counts: N requests per period.

Resilience4j `RateLimiter`:

```
acquire permission (permitsPerPeriod, refreshPeriod)
  ├─ tokens available → proceed
  └─ no tokens → wait timeoutForDuration or fail
```

Algorithms in the wild:

| Algorithm | Behavior |
|---|---|
| Fixed window | 100 req/min resets at minute boundary — burst at boundary |
| Sliding window | Smoother; Resilience4j uses period refresh |
| Token bucket | Allows bursts up to bucket size |
| Leaky bucket | Constant outflow rate |

Resilience4j rate limiter is **token-bucket-like** with `limitForPeriod` replenished every `limitRefreshPeriod`.

### Configuration example

```yaml
resilience4j:
  ratelimiter:
    instances:
      externalApiQuota:
        limitForPeriod: 50
        limitRefreshPeriod: 1s
        timeoutDuration: 0        # fail immediately if no permit
      partnerWebhook:
        limitForPeriod: 1000
        limitRefreshPeriod: 60s
        timeoutDuration: 5s       # wait up to 5s for a permit
```

```java
@RateLimiter(name = "externalApiQuota", fallbackMethod = "quotaExceeded")
public ApiResponse callPartner(Request req) {
    return partnerClient.send(req);
}

private ApiResponse quotaExceeded(Request req, RequestNotPermitted ex) {
    return ApiResponse.rateLimited();
}
```

### Inbound rate limiting (Spring Cloud Gateway)

Gateway Redis rate limiter (production-grade for edge):

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://order-service
          filters:
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
                key-resolver: "#{@userKeyResolver}"
```

Resilience4j inbound on controller:

```java
@RestController
public class PublicApiController {

    @GetMapping("/public/search")
    @RateLimiter(name = "publicSearch")
    public SearchResult search(@RequestParam String q) {
        return searchService.search(q);
    }
}
```

Prefer **edge rate limiting** (API gateway, WAF, CDN) for DDoS and tenant fairness; use in-service rate limiting for **downstream quota protection** and per-tenant API tiers.

### Production scenario: partner API 429 during batch job

**Problem.** Nightly reconciliation hammers partner API. Partner returns 429. Job extends from 2h to 8h. No backoff on 429.

**Cause.** No outbound rate limiter aligned with partner contract (50 req/s). Parallel steps × 20 threads = 200 req/s.

**Solution.**

```yaml
resilience4j:
  ratelimiter:
    instances:
      partnerApi:
        limitForPeriod: 45       # headroom under 50
        limitRefreshPeriod: 1s
        timeoutDuration: 10s
```

```java
@RateLimiter(name = "partnerApi")
@Retry(name = "partnerApi429")
public PartnerRecord fetchPage(int page) { ... }
```

```yaml
resilience4j:
  retry:
    instances:
      partnerApi429:
        maxAttempts: 5
        waitDuration: 1s
        enableExponentialBackoff: true
        retryExceptions:
          - org.springframework.web.client.HttpClientErrorException$TooManyRequests
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Rate limit per instance, not cluster | N pods × limit exceeds global quota |
| `timeoutDuration=0` on user-facing path | Hard fail under burst instead of brief wait |
| Same limit for read and write | Writes starved or reads over-permitted |
| No 429 retry with Retry-After | Partner ban for abuse |

### Debugging scenario

**Observe.** `RequestNotPermitted` from rate limiter during normal traffic.

**Diagnose.** `limitForPeriod` too low vs actual QPS; or multiple rate limiters stacked (gateway + service). Check Micrometer `resilience4j.ratelimiter.available.permissions`.

**Fix.** Cluster-wide limit via Redis/similar; tune `limitForPeriod`; use `timeoutDuration` > 0 for smooth shedding.

---

## 8. Throttling

### Core concept

**Rate limiting** answers "how many requests in this window?" **Throttling** answers "how fast should traffic flow?" — often smoothing bursts, queueing excess work, or reducing concurrency under pressure. In practice the terms overlap; distinguish by **behavior on excess load**:

| Mechanism | Excess load behavior |
|---|---|
| Rate limit (hard) | Reject immediately (429 / `RequestNotPermitted`) |
| Throttle (soft) | Queue, delay, or reduce service quality |
| Load shed | Drop lowest-priority work |

### Implementation patterns

**1. Client-side throttling (Resilience4j rate limiter with wait)**

```yaml
resilience4j:
  ratelimiter:
    instances:
      smoothEmitter:
        limitForPeriod: 10
        limitRefreshPeriod: 100ms
        timeoutDuration: 2s     # throttle: wait for permit rather than fail
```

**2. Adaptive concurrency (Netflix/concurrency-limits style)**

Reduce allowed concurrency when latency rises:

```java
// Conceptual — use library or custom AtomicInteger maxInFlight
int currentLimit = adaptiveLimit.get();
if (inFlight.incrementAndGet() > currentLimit) {
    inFlight.decrementAndGet();
    return Optional.empty();  // shed or queue
}
try {
    return Optional.of(call());
} finally {
    inFlight.decrementAndGet();
    adaptiveLimit.update(p99Latency);
}
```

**3. Gateway throttling (Spring Cloud Gateway RequestSize / Redis)**

Burst capacity + replenish rate = token bucket throttle.

**4. Reactive backpressure (WebFlux)**

`Flux.limitRate(n)` / `concatMap` with prefetch 1 — subscriber pulls at sustainable pace.

```java
return webhookClient.sendBatch(events)
    .flatMap(event -> client.post().bodyValue(event).retrieve().bodyToMono(Void.class),
             5);  // max 5 concurrent — throttled parallelism
```

### Production scenario: Kafka consumer overwhelms DB

**Problem.** Consumer `concurrency=30` writes to Postgres. DB CPU 100%, replication lag 10 min. Consumer lag grows unbounded.

**Cause.** No throttle on write rate; treated Kafka as unbounded buffer.

**Solution.**

1. Reduce `concurrency` to match DB write capacity.
2. Add semaphore bulkhead around DB writes.
3. Pause consumption when lag or DB health metric crosses threshold (Kafka `pause()`).

```java
@KafkaListener(topics = "orders", concurrency = "5")
public void consume(ConsumerRecord<String, OrderEvent> record) {
    bulkhead.executeRunnable(() -> orderWriter.persist(record.value()));
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Unbounded queue "for throttling" | OOM under sustained overload |
| Throttle without priority classes | Critical traffic stuck behind bulk |
| WebFlux `flatMap` default prefetch 256 | Downstream hammered |
| No coordination between throttle and circuit breaker | Throttle queues calls breaker would fail fast |

### Debugging scenario

**Observe.** Latency grows linearly with load but error rate stays 0 until sudden cliff.

**Diagnose.** Queue depth growing (thread pool queue, reactive buffer, Kafka lag). Not rate limit — that's immediate 429.

**Fix.** Cap queue size; fail fast when full (load shed); scale consumers or downstream.

---

## 9. Cascading Failures

### Core concept

A **cascading failure** propagates: dependency A slows → callers of A accumulate threads → callers become slow → their callers fail → regional outage. The dependency may recover while callers remain unhealthy because of **retry buildup**, **connection pool exhaustion**, and **GC pressure** from piled-up objects.

Classic amplification loop:

```
Dependency latency ↑
  → Caller threads blocked waiting
  → Caller thread pool saturated
  → Caller rejects new work (503)
  → Clients retry
  → Dependency load ↑↑ (retry storm)
  → Dependency never recovers
```

Defense layers (use multiple):

1. Timeouts (release threads)
2. Bulkheads (cap blast radius)
3. Circuit breakers (stop calling sick dep)
4. Rate limits / load shed (reduce inbound)
5. Graceful degradation (partial responses)
6. Autoscaling with **cooldown** (avoid scaling into broken state)

### Production scenario: payment outage takes down entire ecommerce platform

**Problem.** Payment provider incident. Cart, catalog, account, and homepage all 503. Only checkout actually calls payment.

**Cause.**

- Shared Tomcat thread pool across all controllers.
- `@Retry` on unrelated services "for consistency."
- Feign default connects **through same load balancer** with no bulkhead.
- Health check includes payment → K8s kills all pods.

**Solution.**

```java
// Isolate payment
@CircuitBreaker(name = "payment")
@Bulkhead(name = "payment")
@TimeLimiter(name = "payment")
public PaymentResult charge(Order order) { ... }

// Health indicator — don't fail liveness on optional dep
@Bean
HealthIndicator paymentHealth(CircuitBreakerRegistry registry) {
    return () -> registry.circuitBreaker("payment").getState() == CLOSED
        ? Health.up().build()
        : Health.out().withDetail("payment", "circuit open").build();
}
```

```yaml
management:
  endpoint:
    health:
      group:
        liveness:
          include: livenessState,diskSpace
        readiness:
          include: readinessState,db
```

Use **synthetic checks** for payment on readiness only for checkout pods, not catalog pods.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Sync call chain depth > 3 without parallelization | Multiplicative timeout risk |
| Shared connection pool all deps | One slow dep holds all connections |
| Global retry policy | Every service retries into fire |
| Fat health check | Orchestrator restart loop during partial outage |
| No autoscaling on client thread pools | Fixed pool becomes global bottleneck |

### Debugging scenario

**Observe.** Dependency recovered (vendor green) but your platform still 503 for 15 minutes.

**Diagnose.** Thread dump: most threads blocked on `socketRead0` or waiting on bulkhead. Circuit breakers still OPEN. Connection pool metrics: `pending` high, `available` zero.

**Fix.** Rolling restart only after fixing root policy (otherwise repeats). Open circuits manually after vendor OK. Increase pool size temporarily with bulkhead caps to prevent recurrence.

---

## 10. Graceful Degradation

### Core concept

Graceful degradation returns **reduced functionality** instead of complete failure when dependencies are unavailable. Users see stale data, defaults, or partial pages — not a white screen.

Patterns:

| Pattern | Example |
|---|---|
| Cached fallback | Product price from Redis cache when pricing service down |
| Static default | "Delivery estimate unavailable" |
| Feature flag off | Disable recommendations widget |
| Stale-while-revalidate | Serve last good catalog snapshot |
| Optional enrichment drop | Order details without live tracking map |

Implementation with Resilience4j fallbacks:

```java
@CircuitBreaker(name = "recommendations", fallbackMethod = "defaultRecs")
public List<Product> recommendations(String userId) {
    return recClient.get(userId);
}

private List<Product> defaultRecs(String userId, Exception ex) {
    return cache.get("global-trending").orElse(List.of());
}
```

**Cache-aside with degradation:**

```java
public ProductPage loadProduct(String id) {
    Product core = productRepo.findById(id);  // local DB — always try first
    Optional<Reviews> reviews = resilience.executeSupplier(
        () -> reviewClient.get(id));          // optional — empty if open circuit
    Optional<Recs> recs = resilience.executeSupplier(
        () -> recClient.forProduct(id));
    return ProductPage.builder()
        .product(core)
        .reviews(reviews.orElse(Reviews.empty()))
        .recommendations(recs.orElse(Recs.trending()))
        .build();
}
```

### Production scenario: homepage hard-depends on personalization

**Problem.** Personalization service down. Homepage returns 500. Marketing loses entire site during Super Bowl ad.

**Cause.** Controller awaits personalization before rendering skeleton; no fallback; circuit breaker throws to global exception handler.

**Solution.**

1. Render shell immediately; load personalization async client-side (BFF pattern).
2. Server-side fallback to non-personalized catalog.

```java
@GetMapping("/home")
public HomeResponse home(Authentication auth) {
    CompletableFuture<Banner> banners = asyncOptional(() -> promoService.banners(auth));
    CompletableFuture<List<Item>> items = asyncOptional(() -> personalize(auth));
    return HomeResponse.builder()
        .banners(awaitOrDefault(banners, Banner.generic(), 300, MS))
        .items(awaitOrDefault(items, catalogService.trending(), 500, MS))
        .build();
}
```

Document **degradation tiers** in runbook: Tier 0 full, Tier 1 no personalization, Tier 2 read-only catalog, Tier 3 static maintenance page.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Fallback returns null → NPE in template | Secondary 500 during degradation |
| Stale cache without TTL cap | Wrong prices displayed for hours |
| Fallback hits same broken dependency | Cascading failure in fallback path |
| Degraded mode indistinguishable in UI | Users trust stale legal/medical data |

### Debugging scenario

**Observe.** Circuit OPEN but API still slow, not fast fallback.

**Diagnose.** Fallback method doing heavy work (re-query DB, call backup service that's also down). AOP fallback not matching exception type → propagates instead of fallback.

**Fix.** Lightweight fallbacks (cache, constants); verify fallback signatures; metric `fallback_calls_total`.

---

## 11. Fail Fast

### Core concept

**Fail fast** rejects work immediately when the system cannot succeed — open circuit, full bulkhead, validation failure, missing prerequisite — instead of queueing indefinitely or retrying hopelessly. Saves threads, money, and downstream capacity.

Resilience4j fail-fast sources:

- `CallNotPermittedException` — circuit OPEN or HALF_OPEN saturated
- `BulkheadFullException` — no permits, `maxWaitDuration=0`
- `RequestNotPermitted` — rate limiter with `timeoutDuration=0`

Application-level fail fast:

```java
public Order submit(OrderRequest req) {
    if (!inventoryCircuitBreaker.tryAcquirePermission()) {
        throw new ServiceUnavailableException("Ordering temporarily unavailable");
    }
    if (req.items().isEmpty()) {
        throw new BadRequestException("empty cart");  // don't hit DB
    }
    ...
}
```

**Validation before expensive I/O** is fail fast at the architecture level.

### Production scenario: queue depth hides overload until OOM

**Problem.** Service queues requests when thread pool full (unbounded `LinkedBlockingQueue`). Under load, latency → 60s, then OOM. Clients see timeouts, not 503.

**Cause.** Chose queueing over fail fast to "never reject customers."

**Solution.**

```java
@Bean
ThreadPoolExecutor orderExecutor() {
    return new ThreadPoolExecutor(
        20, 40, 60, SECONDS,
        new ArrayBlockingQueue<>(100),           // bounded
        new ThreadPoolExecutor.AbortPolicy());   // fail fast → RejectedExecutionException
}
```

Map `RejectedExecutionException` to 503 with `Retry-After`. Pair with **load shedding** at gateway.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `maxWaitDuration=10s` on user checkout | 10s wait then fail — feels like hang |
| Retry on fail-fast path | Defeats purpose |
| 200 OK with error body on overload | Clients don't backoff |
| try/catch swallows `CallNotPermittedException` | Hidden degradation |

### Debugging scenario

**Observe.** p99 latency 10s exactly during overload.

**Diagnose.** Matches `maxWaitDuration` on bulkhead or rate limiter — clients waiting for permit that never comes.

**Fix.** Set `maxWaitDuration: 0` for latency-sensitive paths; return 503 immediately with retry guidance.

---

## 12. Failover

### Core concept

**Failover** redirects traffic to a **standby** system when the primary fails — different from graceful degradation (same system, less function) and circuit breaker (stop calling). Failover implies **redundant capacity**: multi-AZ, multi-region, hot/warm standby, read replica promotion.

Layers:

| Layer | Failover mechanism |
|---|---|
| DNS | Route53 health-checked records (minutes TTL) |
| Load balancer | Target group health checks, cross-AZ |
| Service mesh | Outlier detection, locality-weighted LB |
| Application | Primary/secondary client with circuit breaker |
| Database | Replica promotion, Aurora failover |

### Application-level failover with Resilience4j

```java
@Service
public class GeoLookupService {

    private final GeoClient primary;
    private final GeoClient secondary;
    private final CircuitBreaker primaryCb;

    public GeoLookupService(GeoClient primary, GeoClient secondary,
                            CircuitBreakerRegistry registry) {
        this.primary = primary;
        this.secondary = secondary;
        this.primaryCb = registry.circuitBreaker("geoPrimary");
    }

    public Location lookup(String ip) {
        Try<Location> result = Try.ofSupplier(
            CircuitBreaker.decorateSupplier(primaryCb, () -> primary.lookup(ip)));
        if (result.isSuccess()) {
            return result.get();
        }
        if (primaryCb.getState() == CircuitBreaker.State.OPEN) {
            return secondary.lookup(ip);  // failover path
        }
        throw new GeoUnavailableException(result.getCause());
    }
}
```

Spring Cloud LoadBalancer + multiple service instances is **client-side failover** across healthy pods — not the same as cross-region failover unless instances span regions.

### Production scenario: single-region hard dependency

**Problem.** Primary SaaS vendor us-east-1 outage. Your eu-west-1 deployment still calls us-east-1 endpoint (hardcoded URL). EU site down despite "multi-region deploy."

**Cause.** Region affinity missing on client config; global vendor endpoint; no secondary vendor.

**Solution.**

```yaml
geo:
  clients:
    primary:
      url: ${GEO_PRIMARY_URL}   # regional endpoint
    secondary:
      url: ${GEO_SECONDARY_URL}
```

Runbook: failover checklist — flip feature flag `geo.client=secondary`, verify circuit on primary OPEN, monitor secondary quota.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Failover target shares fate (same vendor account) | Both paths fail together |
| No health check on standby | Failover to broken secondary |
| Sticky sessions to failed AZ | Partial user impact |
| Dual-write during failover | Split brain data |

### Debugging scenario

**Observe.** Failover "works" in drill but not in prod incident.

**Diagnose.** Drill used forced circuit open; prod failed on timeout — secondary also timing out (shared network path). DNS still pointing to primary region.

**Fix.** Test failover with **primary network partition** simulation; automate DNS/LB flip; cold standby runbook with RTO measured.

---

## 13. Load Shedding

### Core concept

Load shedding **actively drops** low-priority requests under overload to protect core functionality — opposite of queuing everything. Tell clients quickly so they backoff (503 + `Retry-After`).

Techniques:

1. **Admission control** — reject at gateway when CPU/latency/concurrency threshold exceeded
2. **Priority queues** — drop bronze tier, serve gold tier
3. **Sampled shedding** — randomly drop 30% of read traffic
4. **Concurrency limit** — Netflix Turbine-style

Resilience4j bulkhead/rate limiter at `maxWaitDuration=0` is a form of load shedding.

**Spring Boot 2.7+ / 3 availability:**

```java
@Component
public class LoadShedFilter implements Filter {

    private final AtomicInteger inFlight = new AtomicInteger();
    private static final int MAX = 500;

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        if (inFlight.incrementAndGet() > MAX) {
            inFlight.decrementAndGet();
            HttpServletResponse http = (HttpServletResponse) res;
            http.setStatus(503);
            http.setHeader("Retry-After", "5");
            return;
        }
        try {
            chain.doFilter(req, res);
        } finally {
            inFlight.decrementAndGet();
        }
    }
}
```

**Priority-based:**

```java
if (overload && !request.getHeader("X-Tier").equals("PREMIUM")) {
    return ResponseEntity.status(503).header("Retry-After", "10").build();
}
```

### Production scenario: viral traffic kills login for paying users

**Problem.** Anonymous catalog browse traffic spike. Auth DB connection pool exhausted. Paying users cannot log in.

**Cause.** No priority; anonymous and authenticated share pool; no shed on anonymous reads.

**Solution.** Gateway rate limit anonymous IPs; separate auth service pool; shed catalog enrichment before auth paths.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Shed without Retry-After | Clients immediate retry → worse |
| Shed critical paths last (not first) | Wrong priorities |
| Metric gap on shed count | Silent revenue loss |
| 200 empty body on shed | Clients cache bad state |

### Debugging scenario

**Observe.** 503 rate correlates with marketing email send, not dependency failure.

**Diagnose.** Load shed trigger is in-flight limit, not circuit breaker. Check shed counter vs campaign schedule.

**Fix.** Pre-warm capacity for campaigns; dynamic limit from CPU; coordinate with marketing on rate.

---

## 14. Adaptive Timeouts

### Core concept

**Adaptive timeouts** adjust per-request or per-dependency timeout based on observed latency distribution — tighter when system healthy (fail fast on anomaly), looser when baseline is high — instead of one static 30s for all conditions.

Approaches:

1. **Percentile-based** — timeout = p99 × multiplier (measured over rolling window)
2. **Coordinated omission aware** — HdrHistogram / Micrometer percentiles
3. **gRPC/deadline propagation** — remaining budget decreases down the chain
4. **Netflix TCP congestion style** — reduce concurrency when RTT rises

Simple rolling adaptive example:

```java
public class AdaptiveTimeout {

    private final Duration min = Duration.ofMillis(200);
    private final Duration max = Duration.ofSeconds(5);
    private final WindowedLatency stats = new WindowedLatency(1000);

    public Duration currentTimeout() {
        long p99 = stats.snapshot().getPercentile(0.99);
        long computed = (long) (p99 * 1.5) + 50;
        return Duration.ofMillis(Math.clamp(computed, min.toMillis(), max.toMillis()));
    }

    public <T> T call(Supplier<T> action) {
        Duration timeout = currentTimeout();
        return timeLimiter.executeFutureSupplier(
            () -> CompletableFuture.supplyAsync(action),
            timeout);
    }
}
```

**Deadline propagation:**

```java
public OrderView getOrder(String id, Duration remainingBudget) {
    long start = System.nanoTime();
    Order order = orderRepo.find(id);
    Duration left = remainingBudget.minus(Duration.ofNanos(System.nanoTime() - start));
    if (left.isNegative()) throw new TimeoutException("budget exhausted");
    return enrich(order, left);
}
```

Pass `X-Request-Deadline` from gateway (Envoy `x-envoy-upstream-rq-timeout-ms`).

### Production scenario: static 5s timeout masks 200ms regression

**Problem.** Dependency p99 drifts from 80ms to 400ms over a week (GC tuning regression). Static 5s timeout — no alerts until pool exhaustion from 10× concurrent calls.

**Cause.** Timeout too loose to detect regression; no SLO on latency.

**Solution.** Adaptive timeout with floor 500ms during healthy baseline p99=80ms → timeout ~150ms triggers alerts on regression. Pair with **SLO burn alerts** on latency, not just errors.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Adaptive without floor | Timeout collapses to 0, flaky failures |
| Adaptive without ceiling | One slow hour raises timeout for days |
| Per-attempt adaptive ignoring retry budget | Sum of retries exceeds gateway timeout |
| No cold-start default | First 100 calls use wrong timeout |

### Debugging scenario

**Observe.** Timeouts spike only on one AZ.

**Diagnose.** Adaptive stats per-instance not global — one bad AZ pod raises only its timeout if not shared. Check percentile input includes cross-AZ variance.

**Fix.** Cluster-wide latency signal (Redis/Micrometer distribution); exclude warm-up; reset window on deploy.

---

## 15. Retry Storm

### Core concept

A **retry storm** occurs when many clients retry failed requests simultaneously, multiplying traffic on an already failing dependency — turning a partial outage into total failure. Retries come from:

- Application `@Retry`
- Client libraries (AWS SDK, gRPC)
- API gateways
- Browser / mobile app retry
- Message queue redelivery
- Load balancer health check flapping

Traffic multiplication:

```
1000 RPS original × 3 app retries × 2 client retries = up to 6000 RPS effective
```

During incident, effective load can exceed recovery capacity → dependency never heals (metastable failure).

### Mitigation checklist

1. **Exponential backoff + full jitter** on all retry layers
2. **Circuit breaker** stops retries when open
3. **Retry budget** — cap retries as fraction of original traffic (Google SRE)
4. **Idempotency** — safe to retry without duplicate side effects
5. **429/503 with Retry-After** — server tells clients when to retry
6. **Coordinate retry policies** — don't stack 5 layers each retrying 3×

```yaml
# Single owner of retry policy — usually the calling service, not every layer
resilience4j:
  retry:
    instances:
      payments:
        maxAttempts: 2
        enableExponentialBackoff: true
        enableRandomizedWait: true
```

**Retry budget pattern:**

```java
// Allow retries only if recent retry rate < 10% of success rate
if (retryBudget.exhausted()) {
    throw ex;  // fail fast, no retry
}
```

### Production scenario: K8s + app + Feign triple retry

**Problem.** Pod unhealthy → K8s restarts → client retry 3× → Feign retry 3× → 9× calls during rolling update.

**Cause.** Retry at every layer without coordination.

**Solution.** Disable Feign retry when using Resilience4j; use `maxAttempts=1` on idempotent GET only; configure K8s `minReadySeconds` and proper readiness probes to avoid premature traffic shift.

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            retryer: feign.Retryer.NEVER_RETRY
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Retry on 500 without breaker | Traffic avalanche |
| Kafka `max.poll.interval` + long retry | Rebalance storm |
| Mobile app infinite retry | Client DDoS |
| Health check retries mark pod ready too early | Traffic to starting pod |

### Debugging scenario

**Observe.** Downstream request rate 10× incoming rate at incident start.

**Diagnose.** Count retry attempts via `resilience4j_retry_calls_total`; compare gateway access logs vs service logs; check multiple client types (mobile, batch, web).

**Fix.** Emergency: raise circuit breaker sensitivity, reduce `maxAttempts` via config server, publish incident banner to disable client auto-retry.

---

## 16. Thundering Herd Problem

### Core concept

**Thundering herd** — many clients wake up simultaneously and hammer a resource: cache expiry, circuit breaker half-open, scheduled cron, JVM warm-up after deploy, DNS TTL refresh. Distinct from retry storm (failure-driven) but often co-occurring during recovery.

Classic scenarios:

1. **Cache stampede** — hot key expires; 10k threads miss cache, hit DB
2. **Circuit half-open** — all instances probe at once when breaker closes
3. **Cron alignment** — 500 pods run `@Scheduled(cron = "0 0 * * * *")` at same second
4. **Connection pool rebuild** — all pods reconnect to DB after failover

### Mitigations

| Problem | Mitigation |
|---|---|
| Cache expiry | Probabilistic early refresh, single-flight (mutex per key), stale-while-revalidate |
| Circuit half-open | Randomized `waitDurationInOpenState` per instance; limit probes |
| Cron | `@Scheduled` + random initial delay; shedlock for single leader |
| Pool reconnect | Jittered reconnect backoff; pool size ramp |

**Cache single-flight:**

```java
public Product getProduct(String id) {
    return cache.get(id, key -> {
        synchronized (locks.get(key)) {
            return cache.getIfPresent(key).orElseGet(() -> db.load(key));
        }
    });
}
```

Better: Caffeine `LoadingCache` with async refresh; or Redis RedLock for cross-instance single-flight.

**Circuit breaker jitter:**

```java
// Per-instance wait = base + random(0, base/2) via custom StateTransitionHandler
// Or stagger pod restart times during deploy
```

**Resilience4j half-open limits:**

```yaml
resilience4j:
  circuitbreaker:
    instances:
      catalog:
        permittedNumberOfCallsInHalfOpenState: 3
        waitDurationInOpenState: 60s
        automaticTransitionFromOpenToHalfOpenEnabled: true
```

Deploy **canary** or **linear ramp** so not all pods transition half-open simultaneously.

### Production scenario: Redis cache expiry during flash sale

**Problem.** 50k RPS product page. Cache TTL 60s on price. Every minute, TTL aligns, DB gets 50k QPS spike, dies, cascade.

**Cause.** Fixed TTL without jitter; no single-flight on miss.

**Solution.**

```java
@Cacheable(value = "prices", key = "#sku")
public Price getPrice(long sku) {
    return priceClient.fetch(sku);
}
```

Add TTL jitter in cache config (Caffeine: `expireAfterWrite(60 + ThreadLocalRandom.current().nextInt(10), SECONDS)`). Warm cache before sale. Use read-through with `sync = true` (Spring Cache on Caffeine).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Identical cron on all pods | Periodic latency spikes |
| Shared fixed cache TTL on hot keys | Regular DB avalanches |
| All breakers share exact wait duration | Synchronized half-open probes |
| Cold start without warmup | Deploy causes herd on dependencies |

### Debugging scenario

**Observe.** DB spikes every 60s exactly.

**Diagnose.** Histogram of cache miss rate; TTL configuration; cron dashboards.

**Fix.** Jitter TTL; stagger jobs; enable single-flight; pre-warm.

---

## 17. Resilience4j + Spring Boot 3 Integration

### Dependencies and activation

```xml
<dependency>
  <groupId>io.github.resilience4j</groupId>
  <artifactId>resilience4j-spring-boot3</artifactId>
  <version>2.2.0</version>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

`resilience4j-spring-boot3` auto-configures registries, aspect, actuator endpoints, Micrometer binder when on classpath.

Enable annotations:

```java
@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

AspectJ annotations work on Spring beans (`@Service`, `@Component`) — not on `@Controller` methods calling self without proxy. Use `@Autowired self` pattern or move resilience to service layer.

### Full YAML reference (multi-pattern)

```yaml
resilience4j:
  circuitbreaker:
    configs:
      default:
        slidingWindowSize: 100
        minimumNumberOfCalls: 10
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
    instances:
      backendA:
        baseConfig: default
      backendB:
        baseConfig: default
        failureRateThreshold: 30

  retry:
    configs:
      default:
        maxAttempts: 3
        waitDuration: 200ms
        enableExponentialBackoff: true
    instances:
      backendA:
        baseConfig: default

  bulkhead:
    instances:
      backendA:
        maxConcurrentCalls: 25
        maxWaitDuration: 0

  timelimiter:
    instances:
      backendA:
        timeoutDuration: 2s
        cancelRunningFuture: true

  ratelimiter:
    instances:
      backendA:
        limitForPeriod: 100
        limitRefreshPeriod: 1s
        timeoutDuration: 0

  thread-pool-bulkhead:
    instances:
      blockingBackend:
        maxThreadPoolSize: 8
        coreThreadPoolSize: 4
        queueCapacity: 10

management:
  endpoints:
    web:
      exposure:
        include: health,metrics,circuitbreakers,retries,bulkheads,ratelimiters,timed-limiter
  health:
    circuitbreakers:
      enabled: true
```

### Composed annotation (custom)

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@CircuitBreaker(name = "standardBackend")
@Retry(name = "standardBackend")
@Bulkhead(name = "standardBackend")
@TimeLimiter(name = "standardBackend")
public @interface StandardBackendProtection {}

@Service
public class BackendFacade {
    @StandardBackendProtection
    public CompletableFuture<Response> call(Request r) {
        return CompletableFuture.supplyAsync(() -> client.send(r));
    }
}
```

### Event publishing

```java
@Component
public class ResilienceEventLogger {

    @EventListener
    public void onCircuitBreakerEvent(CircuitBreakerOnStateTransitionEvent event) {
        log.warn("Circuit {} transitioned from {} to {}",
            event.getCircuitBreakerName(),
            event.getStateTransition().getFromState(),
            event.getStateTransition().getToState());
    }

    @EventListener
    public void onRetry(RetryOnRetryEvent event) {
        log.debug("Retry {} attempt {}", event.getName(), event.getNumberOfRetryAttempts());
    }
}
```

### Production scenario: annotations on controller, self-invocation bypass

**Problem.** `@CircuitBreaker` on controller method; tests pass with MockMvc but production never opens during dependency outage.

**Cause.** Internal call from `@Scheduled` job invokes service method directly, bypassing proxy — or `@CircuitBreaker` on private method (ignored by Spring AOP).

**Solution.** Annotations on public service methods only; inject service into scheduler; verify with integration test that records `CircuitBreakerOnStateTransitionEvent`.

---

## 18. Spring Cloud Circuit Breaker Abstraction

### Core concept

`spring-cloud-starter-circuitbreaker-resilience4j` provides `CircuitBreakerFactory`, `ReactiveCircuitBreakerFactory`, and auto-config aligned with Spring Cloud Commons. Use when building **library code** that shouldn't depend on Resilience4j annotations, or when mixing **WebClient** reactive chains.

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-circuitbreaker-resilience4j</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    circuitbreaker:
      resilience4j:
        disableThreadPool: false
```

### Imperative factory

```java
@Service
public class AccountClient {

    private final CircuitBreakerFactory factory;
    private final RestClient http;

    public AccountClient(CircuitBreakerFactory factory, RestClient.Builder builder) {
        this.factory = factory;
        this.http = builder.baseUrl("http://account-service").build();
    }

    public Account getAccount(String id) {
        return factory.create("account").run(
            () -> http.get().uri("/accounts/{id}", id).retrieve().body(Account.class),
            ex -> Account.unknown(id)
        );
    }
}
```

### Reactive factory

```java
@Service
public class ReactiveCatalogClient {

    private final ReactiveCircuitBreakerFactory factory;
    private final WebClient webClient;

    public Mono<Product> getProduct(String id) {
        ReactiveCircuitBreaker cb = factory.create("catalog");
        return cb.run(
            webClient.get().uri("/products/{id}", id).retrieve().bodyToMono(Product.class),
            throwable -> Mono.just(Product.fallback(id))
        );
    }
}
```

### Customizer per circuit name

```java
@Bean
Customizer<Resilience4JCircuitBreakerFactory> defaultCustomizer() {
    return factory -> factory.configureDefault(id -> new Resilience4JConfigBuilder(id)
        .timeLimiterConfig(TimeLimiterConfig.custom().timeoutDuration(Duration.ofSeconds(2)).build())
        .circuitBreakerConfig(CircuitBreakerConfig.custom()
            .slidingWindowSize(50)
            .failureRateThreshold(40)
            .build())
        .build());
}

@Bean
Customizer<Resilience4JCircuitBreakerFactory> catalogCustomizer() {
    return factory -> factory.configure(builder -> builder
        .circuitBreakerConfig(CircuitBreakerConfig.custom()
            .waitDurationInOpenState(Duration.ofSeconds(60))
            .build()),
        "catalog", "catalogSearch");
}
```

### Spring Cloud Gateway + Circuit Breaker filter

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: product-route
          uri: lb://product-service
          filters:
            - name: CircuitBreaker
              args:
                name: productCb
                fallbackUri: forward:/fallback/products
```

Fallback controller returns cached/static response — gateway-level degradation.

### Production scenario: two circuit breaker frameworks

**Problem.** Team uses `@CircuitBreaker` (Resilience4j) and `spring-cloud-starter-netflix-hystrix` leftover module and Spring Cloud factory — three configs for same dependency, inconsistent behavior per code path.

**Cause.** Hystrix migration incomplete; copy-paste from different eras.

**Solution.** Remove Hystrix entirely (deprecated). Standardize: annotations for service layer, factory for WebClient/Gateway. Single YAML namespace `resilience4j.circuitbreaker.instances.*`.

---

## 19. Observability: Metrics, Traces, and Alerts

### Micrometer metrics (Resilience4j binder)

Auto-exported when `micrometer-registry-prometheus` present:

| Metric | Tags | Alert on |
|---|---|---|
| `resilience4j.circuitbreaker.state` | name | OPEN > 0 for 5 min |
| `resilience4j.circuitbreaker.failure.rate` | name | > threshold |
| `resilience4j.circuitbreaker.slow.call.rate` | name | rising |
| `resilience4j.circuitbreaker.calls` | kind=failed | spike |
| `resilience4j.retry.calls` | kind=failed_with_retry | retry storm |
| `resilience4j.bulkhead.available.concurrent.calls` | name | near 0 sustained |
| `resilience4j.ratelimiter.available.permissions` | name | chronically 0 |

Example Prometheus alert:

```yaml
groups:
  - name: resilience
    rules:
      - alert: CircuitBreakerOpen
        expr: resilience4j_circuitbreaker_state{name="payment"} == 1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Payment circuit OPEN"
      - alert: RetryStorm
        expr: rate(resilience4j_retry_calls_total{kind="failed_with_retry"}[5m])
              / rate(resilience4j_retry_calls_total{kind="successful_with_retry"}[5m]) > 0.5
        for: 3m
        labels:
          severity: warning
```

### Distributed tracing

Wrap outbound calls with span attributes:

```java
@NewSpan("inventory-check")
public Stock checkStock(@SpanTag("sku") long sku) {
    return inventoryClient.check(sku);
}
```

Tag spans with `circuit.breaker.state`, `retry.attempt` via Observation API (Micrometer 1.10+):

```java
Observation.createNotStarted("backend.call", observationRegistry)
    .lowCardinalityKeyValue("circuit.name", "inventory")
    .observe(() -> decoratedCall.get());
```

Correlate: user trace shows 4 retry spans × 2s = 8s — explains tail latency.

### Dashboard essentials

1. Circuit state timeline per dependency
2. Error rate vs retry rate stacked
3. Bulkhead utilization heatmap
4. p50/p99 latency per dependency vs timeout setting
5. Shed/reject count (503) vs success

### Production scenario: alerts on error rate but not retry rate

**Problem.** Dependency degraded (p99 8s). Error rate 2% (below 5% alert). User churn spikes — checkout "hangs."

**Cause.** Timeouts not counted as errors in business metrics; retries inflate latency without failing.

**Solution.** Alert on latency SLO burn and `resilience4j.timelimiter.calls` timeout count; SLO: 99% checkout < 3s.

---

## 20. Testing Resilience Configuration

### Unit test with CircuitBreakerRegistry

```java
@Test
void circuitOpensAfterFailures() {
    CircuitBreaker cb = CircuitBreaker.of("test", CircuitBreakerConfig.ofDefaults());
    AtomicInteger calls = new AtomicInteger();
    Supplier<String> failing = () -> { calls.incrementAndGet(); throw new RuntimeException("down"); };

    Supplier<String> decorated = CircuitBreaker.decorateSupplier(cb, failing);

    assertThatThrownBy(decorated::get).isInstanceOf(RuntimeException.class);
    // trip breaker after enough failures
    for (int i = 0; i < 100; i++) {
        try { decorated.get(); } catch (Exception ignored) {}
    }
    assertThat(cb.getState()).isEqualTo(CircuitBreaker.State.OPEN);
    assertThatThrownBy(decorated::get).isInstanceOf(CallNotPermittedException.class);
}
```

### Spring Boot test with WireMock

```java
@SpringBootTest
@AutoConfigureWireMock(port = 0)
class OrderServiceResilienceTest {

    @Autowired OrderService orderService;

    @Test
    void fallbackWhenInventoryReturns500() {
        stubFor(get(urlEqualTo("/stock/1"))
            .willReturn(aResponse().withStatus(500)));

        StockCheckResult result = orderService.checkStock(1, 2);

        assertThat(result.status()).isEqualTo(StockStatus.UNKNOWN);
    }

    @Test
    void circuitOpensAfterRepeatedFailures() {
        stubFor(get(urlMatching("/stock/.*"))
            .willReturn(aResponse().withStatus(503).withFixedDelay(100)));

        for (int i = 0; i < 20; i++) {
            orderService.checkStock(1, 1);
        }

        verify(20, getRequestedFor(urlMatching("/stock/.*"))); // adjust based on retry config
        assertThat(circuitBreakerRegistry.circuitBreaker("inventoryService").getState())
            .isIn(CircuitBreaker.State.OPEN, CircuitBreaker.State.HALF_OPEN);
    }
}
```

### Testcontainers chaos

```java
@Test
void survivesDependencyStop(@Autowired OrderService service,
                            @Autowired GenericContainer<?> inventoryContainer) {
    inventoryContainer.stop();
    assertThat(service.checkStock(1, 1).status()).isEqualTo(StockStatus.UNKNOWN);
    // should not hang > timelimiter + small margin
}
```

### What to test

| Scenario | Assert |
|---|---|
| Dependency 500 | Fallback or exception type |
| Dependency slow | TimeLimiter fires |
| Dependency down | Circuit opens, fail fast |
| Bulkhead full | `BulkheadFullException` / fallback |
| Retry count | WireMock verify call count |
| Idempotency | Single side effect after retries |

### Production scenario: resilience tests skipped in CI

**Problem.** `@CircuitBreaker` misconfigured for 6 months; discovered in prod only.

**Cause.** Integration tests mock all clients — never fail.

**Solution.** Contract tests + WireMock failure scenarios in CI required for merge; chaos engineering in staging weekly.

---

## 21. Production Debugging Playbook

When an outage looks like "everything is slow," work through this list before scaling pods (which often worsens retry storms).

1. **Classify the failure mode.** Hard error (5xx), timeout, open circuit (`CallNotPermittedException`), bulkhead full, rate limited — each has different fixes.

2. **Check circuit breaker actuator first.**

   ```bash
   curl -s localhost:8080/actuator/circuitbreakers | jq
   curl -s localhost:8080/actuator/metrics/resilience4j.circuitbreaker.state | jq
   ```

3. **Compare inbound RPS vs outbound RPS** per dependency. Ratio >> 1 indicates retry storm or fan-out.

4. **Thread dump** (`jcmd <pid> Thread.print` or actuator `/threaddump`). Look for blocked threads on socket read, bulkhead pool names, `ForkJoinPool`.

5. **Connection pool metrics** (HikariCP `hikaricp.connections.active`, HTTP pool pending). Pool pending + circuit CLOSED = slowness not failures.

6. **Trace one slow request** end-to-end. Count retry spans. Compare total trace duration to gateway timeout.

7. **Verify timeout chain** — shortest link wins. Log deadline remaining at each hop during incidents.

8. **Check deploy time correlation** — thundering herd from cache TTL, cron, cold start.

9. **Temporary mitigation order:**
   - Increase circuit sensitivity / force open to failing dep (stop bleeding)
   - Reduce retry `maxAttempts` via config server
   - Enable load shed / rate limit at gateway
   - Scale **down** misbehaving client if it amplifies load (controversial but effective for metastable failure)

10. **Post-incident:** document which pattern failed (missing bulkhead, retry on POST, etc.). Fix policy, not just restart.

---

## 22. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Transient network blip on idempotent GET | Retry 2–3× with exponential backoff + jitter |
| Non-idempotent POST/PUT/PAY | No retry unless idempotency key; fail fast on timeout |
| Dependency consistently slow | TimeLimiter + circuit breaker on slow-call rate |
| Dependency down hard | Circuit breaker OPEN + graceful degradation fallback |
| One bad client of many deps | Bulkhead per dependency |
| Protect downstream quota | Outbound rate limiter aligned with contract |
| Protect your service from traffic spike | Inbound rate limit / load shed at gateway |
| Flash sale / hot cache key | TTL jitter + single-flight + pre-warm |
| Multi-region vendor | Application failover + regional endpoints |
| Checkout vs admin reports same JVM | Thread-pool bulkhead split or separate deployment |
| Retry storm during incident | Reduce maxAttempts, open circuit, publish Retry-After |
| WebFlux blocking call | Semaphore bulkhead + bounded elastic scheduler — not unbounded block |
| Library can't use annotations | Spring Cloud `CircuitBreakerFactory` |
| Health check during partial outage | Liveness ≠ optional deps; readiness scoped per role |
| Testing resilience | WireMock failures + assert circuit state, not just happy path |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. What is the difference between a circuit breaker and a timeout?</summary>

A timeout bounds **one attempt** — how long you wait before giving up on a single call. A circuit breaker bounds **whether you attempt at all** based on recent history. After enough failures, the breaker opens and calls fail immediately (`CallNotPermittedException`) without waiting for timeout. Use both: timeout per attempt, breaker to stop hammering a recovering service.

</details>

<details class="qa-item">
<summary>2. When should you NOT use retry?</summary>

Do not retry non-idempotent operations without deduplication; permanent client errors (4xx except 429/408); when the downstream is overloaded (retry worsens outage); when total retry budget exceeds caller SLA; when circuit breaker is OPEN (fail fast instead).

</details>

<details class="qa-item">
<summary>3. Explain circuit breaker states and transitions.</summary>

CLOSED: normal operation, failures counted in sliding window. OPEN: calls rejected immediately after threshold breached. HALF_OPEN: limited probe calls after wait duration; all probes success → CLOSED, any failure → OPEN. Resilience4j supports automatic transition OPEN → HALF_OPEN after `waitDurationInOpenState`.

</details>

<details class="qa-item">
<summary>4. What is exponential backoff and why add jitter?</summary>

Exponential backoff increases wait between retries multiplicatively (e.g. 100ms, 200ms, 400ms) to give recovering systems time. Jitter randomizes waits so many clients don't retry simultaneously (thundering herd), which would spike load at the same instant.

</details>

<details class="qa-item">
<summary>5. How does the bulkhead pattern prevent cascading failures?</summary>

Bulkhead limits concurrent calls (semaphore) or isolates blocking work in a dedicated thread pool. If one dependency slows, only its bulkhead fills; other dependencies and request handling keep their own capacity. Without bulkheads, one slow call path can exhaust a shared thread pool and take down unrelated endpoints.

</details>

<details class="qa-item">
<summary>6. Rate limiting vs throttling — what's the difference?</summary>

Rate limiting typically enforces a hard cap (N requests per period) and rejects or fails when exceeded. Throttling smooths traffic — queueing, delaying, or reducing parallelism so average rate stays within bounds. In Resilience4j, a rate limiter with `timeoutDuration > 0` behaves like a throttle (waits for permit); with `timeoutDuration = 0` it fails fast like a hard limit.

</details>

<details class="qa-item">
<summary>7. What causes a retry storm and how do you prevent it?</summary>

Retry storms happen when many clients retry simultaneously against a failing service, multiplying effective traffic. Causes: aligned retry policies at app, gateway, and client; no backoff; circuit breaker absent or too lenient. Prevention: exponential backoff with full jitter, circuit breakers, retry budgets, cap `maxAttempts`, coordinate policies across layers, use `Retry-After` on 503/429.

</details>

<details class="qa-item">
<summary>8. What is the thundering herd problem? Give an example.</summary>

Many clients act simultaneously on the same trigger — cache expiry, circuit half-open, cron job, deploy. Example: a hot cache key expires and 10,000 requests miss cache and hit the database at once. Fixes: TTL jitter, single-flight on cache miss, stale-while-revalidate, stagger cron with random delay, limit half-open probe calls.

</details>

<details class="qa-item">
<summary>9. How do you implement graceful degradation in Spring Boot?</summary>

Use Resilience4j `@CircuitBreaker` / `@TimeLimiter` fallback methods returning cached or default data; optional enrichment pattern (core from local DB, optional sections empty on failure); feature flags to disable non-critical features; gateway fallback routes. Ensure fallbacks are lightweight and don't call the same failing dependency.

</details>

<details class="qa-item">
<summary>10. What is fail fast and why is it important under load?</summary>

Fail fast rejects work immediately when success is unlikely (open circuit, full bulkhead, validation failure) instead of queueing or retrying. It preserves threads and connection pools for requests that can succeed and signals overload to clients quickly (503 + Retry-After).

</details>

<details class="qa-item">
<summary>11. Explain cascading failure in microservices.</summary>

Service A slows → B's threads block waiting on A → B slows → C slows → retry amplification → pools exhausted even after A recovers (metastable failure). Defense: timeouts, bulkheads, circuit breakers, load shedding, avoid sync long chains, don't retry blindly.

</details>

<details class="qa-item">
<summary>12. How do Resilience4j annotations compose? What order matters?</summary>

Multiple annotations on one method are handled by Resilience4j's aspect. For `@CircuitBreaker`, `@Retry`, `@TimeLimiter`, `@Bulkhead` together: ensure bulkhead and time limiter constrain resources and duration; retry should not run when circuit is OPEN; time limiter requires `CompletableFuture` return for async. Prefer testing combined behavior — order affects whether retries count as one failure or many for the breaker depending on configuration.

</details>

<details class="qa-item">
<summary>13. What is load shedding vs circuit breaking?</summary>

Circuit breaking protects **callers from a bad dependency** — stop calling that dep. Load shedding protects **the service from too much inbound work** — drop requests to stay alive. Circuit breaker is per-dependency; load shed is per-service admission control. Both return fast under stress.

</details>

<details class="qa-item">
<summary>14. How would you configure Resilience4j for a low-traffic but critical dependency?</summary>

Lower `minimumNumberOfCalls` (e.g. 5) so breaker can open with fewer samples; tighter `slowCallDurationThreshold`; pair with aggressive `TimeLimiter`; dedicated bulkhead; longer `waitDurationInOpenState` if dependency needs time to recover; fallback for OPEN state; alert immediately on OPEN.

</details>

<details class="qa-item">
<summary>15. What is adaptive timeout and when is it useful?</summary>

Adaptive timeout adjusts limits based on recent latency distribution (e.g. p99 × multiplier) instead of a fixed 30s. Useful when baseline latency varies by time of day or when you want to detect regressions early with tight bounds during healthy periods, while allowing headroom during known slow periods — with min/max caps to prevent extremes.

</details>

<details class="qa-item">
<summary>16. Difference between Spring Cloud Circuit Breaker and raw Resilience4j?</summary>

Spring Cloud Circuit Breaker is an abstraction (`CircuitBreakerFactory`) with Resilience4j as implementation — good for programmatic use, WebClient, Gateway filters, vendor swap. Raw Resilience4j provides annotations, richer YAML per instance, event publishers, and direct registry access. Most Boot apps use both: annotations in services, factory in reactive clients.

</details>

<details class="qa-item">
<summary>17. How do you test that a circuit breaker actually opens?</summary>

Integration test with WireMock returning 500/slow responses; loop calls until `CallNotPermittedException`; assert actuator state OPEN; verify fallback invoked; use `CircuitBreakerRegistry` bean in test. Don't mock the decorator — mock the remote server.

</details>

<details class="qa-item">
<summary>18. What metrics alert you before users notice total failure?</summary>

Rising `slow.call.rate` with CLOSED breaker; `bulkhead.available.concurrent.calls` near zero; retry rate approaching success rate; connection pool pending; latency p99 approaching timeout; `ratelimiter.available.permissions` chronically zero.

</details>

<details class="qa-item">
<summary>19. How does failover differ from fallback?</summary>

Fallback returns alternate **data or behavior** (cached, default, reduced). Failover switches to alternate **infrastructure** (secondary region, standby vendor, replica DB). Fallback is logical degradation; failover is redundancy. You may combine: circuit open on primary → failover to secondary endpoint → fallback if both fail.

</details>

<details class="qa-item">
<summary>20. What is a metastable failure?</summary>

A failure state that persists after the root trigger is removed because the system operates beyond a stable point — e.g. retries keep load high, pools stay exhausted, breakers flap. Recovery requires reducing load (shed retries, open circuits, scale down clients) not just fixing the original dependency.

</details>

<details class="qa-item">
<summary>21. Should `@Retry` be inside or outside `@CircuitBreaker`?</summary>

Typically wrap retries **inside** the circuit breaker's guarded supplier so the breaker sees each **logical operation** (including retries) as one call for failure counting — or configure `CircuitBreaker` to record each failed attempt depending on policy. Most importantly: don't retry when breaker is OPEN; ensure retries don't prevent breaker from ever seeing sustained failure rate if each attempt eventually "succeeds" with error body.

</details>

<details class="qa-item">
<summary>22. How do you prevent cache stampede?</summary>

Jitter on TTL; probabilistic early expiration; single-flight lock per key on miss; stale-while-revalidate; pre-warm before known traffic; separate cache for hot keys with longer TTL and background refresh.

</details>

<details class="qa-item">
<summary>23. What HTTP status codes should trigger retry?</summary>

Generally: 408, 429 (with Retry-After), 502, 503, 504, and connection/timeout exceptions. Not: 400, 401, 403, 404, 409 (usually), 422 — business/client errors. Always align with idempotency and method semantics.

</details>

<details class="qa-item">
<summary>24. How does virtual threads (Java 21) change bulkhead thinking?</summary>

Virtual threads increase cheap concurrency for blocking I/O — you can handle more blocked calls without OS thread exhaustion. They do **not** remove need for bulkheads, circuit breakers, or downstream protection: you can still overwhelm dependencies and connection pools. Bulkheads still cap blast radius and enforce backpressure at business level.

</details>

<details class="qa-item">
<summary>25. Design resilience for a payment call in checkout — outline.</summary>

Dedicated bulkhead (small pool); TimeLimiter ~500ms–2s; circuit breaker with sensitive thresholds; **no retry** on charge POST unless idempotency key; fallback to "payment unavailable, try again" UI; rate limit outbound to payment provider quota; metrics and alert on OPEN; health check doesn't kill entire pod; optional async payment initiation with webhook completion for resilience over strong sync consistency.

</details>

---

*Resilience patterns protect dependencies from you and you from dependencies — but they cannot fix missing idempotency, unbounded queues, or shared fate in one thread pool. Compose timeouts, bulkheads, breakers, and retries deliberately; measure retry and slow-call rates; and never debug a retry storm by adding more retries.*
