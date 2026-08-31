# Spring WebFlux Mastery — Senior Production Reference

Spring Boot 3.x / Spring Framework 6.x reactive stack (Project Reactor 3.6+, Netty, WebFlux). Servlet MVC is still the default in Boot; this document is for teams that chose — or inherited — the reactive path. This is not a getting-started guide. It is the map of what actually breaks in production after shipping WebFlux services behind gateways, mobile clients, and event-driven pipelines.

---

## Table of Contents

1. [1. Mental Model: Event Loop vs Thread-Per-Request](#1-mental-model-event-loop-vs-thread-per-request)
2. [2. Project Reactor: Mono, Flux, Operators, Cold vs Hot](#2-project-reactor-mono-flux-operators-cold-vs-hot)
3. [3. DispatcherHandler vs DispatcherServlet](#3-dispatcherhandler-vs-dispatcherservlet)
4. [4. RouterFunctions vs Annotated Controllers](#4-routerfunctions-vs-annotated-controllers)
5. [5. WebClient: Pooling, Timeouts, Retries, Exchange Strategies](#5-webclient-pooling-timeouts-retries-exchange-strategies)
6. [6. Backpressure, Prefetch, and boundedElastic Misuse](#6-backpressure-prefetch-and-boundedelastic-misuse)
7. [7. Blocking Calls on Reactive Threads](#7-blocking-calls-on-reactive-threads)
8. [8. Schedulers and Context Propagation](#8-schedulers-and-context-propagation)
9. [9. Security on WebFlux (SecurityWebFilterChain)](#9-security-on-webflux-securitywebfilterchain)
10. [10. R2DBC vs Blocking JDBC Bridge](#10-r2dbc-vs-blocking-jdbc-bridge)
11. [11. Error Handling: onError*, GlobalExceptionHandler, ProblemDetail](#11-error-handling-onerror-globalexceptionhandler-problemdetail)
12. [12. SSE and Streaming Responses](#12-sse-and-streaming-responses)
13. [13. WebSocket on WebFlux](#13-websocket-on-webflux)
14. [14. Testing: StepVerifier and WebTestClient](#14-testing-stepverifier-and-webtestclient)
15. [15. Observability: Micrometer, Context Propagation, Tracing](#15-observability-micrometer-context-propagation-tracing)
16. [16. Spring Cloud Gateway Integration (Brief)](#16-spring-cloud-gateway-integration-brief)
17. [17. Virtual Threads vs WebFlux in Boot 3.2+](#17-virtual-threads-vs-webflux-in-boot-32)
18. [18. Common Production Failures](#18-common-production-failures)
19. [19. Performance Tuning and Netty Server Options](#19-performance-tuning-and-netty-server-options)
20. [20. Reactive Data Access Patterns](#20-reactive-data-access-patterns)
21. [21. Production Debugging Playbook](#21-production-debugging-playbook)
22. [22. Quick Decision Matrix](#22-quick-decision-matrix)

---

## 1. Mental Model: Event Loop vs Thread-Per-Request

Spring WebFlux is not "MVC but faster." It is a **non-blocking request pipeline** built on Reactor and (by default) **Netty**, where a small pool of event-loop threads multiplexes many concurrent connections. Work is expressed as `Publisher` chains (`Mono`/`Flux`) that complete asynchronously without holding a thread while waiting on I/O.

```
Servlet MVC (Tomcat/Jetty)                    WebFlux (Netty default)
─────────────────────────                    ─────────────────────────
HTTP request → thread from pool              HTTP request → event-loop thread
  → controller (blocks thread)                 → DispatcherHandler
  → JDBC / HTTP client (blocks)                    → handler returns Mono<Void>
  → thread released when response sent             → I/O registered; thread free
                                                   → on completion, resume chain
                                                   → write response on same loop
```

Three objects you must keep distinct:

| Object | Question it answers | Typical type |
|---|---|---|
| `Publisher` | What is the asynchronous data flow? | `Mono<T>`, `Flux<T>` |
| `Subscriber` | Who consumes signals (onSubscribe, onNext, onError, onComplete)? | Netty write path, `StepVerifier` |
| `Subscription` | How many items may flow (backpressure)? | `request(n)` |

A **blocking** stack fails under load when threads are tied up waiting. A **reactive** stack fails when you **block event-loop threads** — the entire loop stalls, not just one request. That asymmetry is the senior mental model.

### When WebFlux helps

- Many concurrent **long-lived** connections (SSE, WebSocket, streaming).
- High fan-out **I/O-bound** orchestration (call 5 downstream HTTP APIs, merge results) with tuned `WebClient` pools.
- Backpressure-aware streaming from DB or message bus to HTTP clients.
- Services already on **R2DBC**, reactive Mongo, reactive Redis, or reactive Kafka end-to-end.

### When WebFlux hurts

- Team and codebase are **blocking-first** (JPA, JDBC, blocking RestTemplate).
- CPU-heavy work on the event loop without offloading.
- "We need more throughput" without profiling — servlet + virtual threads (Boot 3.2+) may be simpler.
- CRUD APIs with JPA and no reactive data layer — you will bridge blocking code and lose the model.

### Internal working

1. Netty `EventLoopGroup` (boss + worker) accepts connections. Default worker count ≈ `Runtime.getRuntime().availableProcessors()`.
2. `ReactorHttpHandlerAdapter` bridges Netty to `HttpHandler` → `HttpWebHandlerAdapter` → `WebFilter` chain → `DispatcherHandler`.
3. Controller/handler method returns `Mono`/`Flux`. Spring subscribes when the response is committed; serialization may use `Encoder` implementations (`Jackson2JsonEncoder`, etc.).
4. If your chain calls `block()` or JDBC on the event-loop thread, Reactor may log `block()/blockFirst()/blockLast() are blocking` (with blockhound) or you see **latency cliffs** without obvious stack traces.

### Production scenario: "We went reactive for performance" — p99 worse than MVC

**Problem.** Team migrated a REST API from Tomcat MVC to WebFlux. Throughput on load test is flat; p99 latency **doubled**. CPU is high; thread dumps show few blocked threads.

**Cause.** Controllers return `Mono` but services call `repository.findById(id).block()` inside `map()`. Every request blocks an event-loop thread during JDBC. Netty cannot accept new work on that loop efficiently; the reactive stack adds overhead without benefit.

**Solution.** Pick one:

```java
// Option A: stay servlet + virtual threads (Boot 3.2+)
spring.threads.virtual.enabled=true

// Option B: true reactive data — R2DBC
return r2dbcRepo.findById(id).flatMap(this::enrich);

// Option C: isolate blocking (escape hatch, not the goal)
return Mono.fromCallable(() -> jdbcRepo.findById(id))
    .subscribeOn(Schedulers.boundedElastic());
```

Measure end-to-end. If >30% of handlers need `boundedElastic`, you chose the wrong stack.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| WebFlux + JPA "because Mono is modern" | Hidden `block()`, thread starvation, worse than MVC |
| Increasing Netty worker threads to "fix" blocking | Masks root cause; CPU contention; still stalls per loop |
| Mixing `@Transactional` JPA with reactive controllers | Transaction bound to blocking thread; context lost across `flatMap` |
| Assuming `Mono` return type makes I/O non-blocking | Only non-blocking if the entire chain is non-blocking |
| Reactive for 3 endpoints, blocking for 97 | Operational complexity; two mental models in one app |

### Debugging scenario

**Observe.** Under load, latency spikes; logs show `reactor.netty.ReactorNetty` warnings or hung requests. `blockhound` (test) flags `java.sql.DriverManager`.

**Diagnose.**

```yaml
# application.yml — dev/staging only
reactor:
  blockhound:
    enabled: true  # via test dependency io.projectreactor.tools:blockhound
```

```java
// Temporary — staging
Hooks.onOperatorDebug(); // expensive; pinpoints assembly stack
```

Thread dump: look for `reactor-http-nio-*` threads blocked in JDBC, `Future.get`, or `synchronized`.

**Fix.** Remove `block()` from reactive paths; move JDBC to `boundedElastic` as interim; plan R2DBC or revert to MVC + virtual threads.

---

## 2. Project Reactor: Mono, Flux, Operators, Cold vs Hot

### Core concept

Project Reactor implements Reactive Streams (`Publisher`, `Subscriber`, `Subscription`, `Processor`). **`Mono<T>`** emits 0 or 1 item. **`Flux<T>`** emits 0..N. Operators transform publishers lazily; **nothing runs until subscribe** (for cold sources).

```
subscribe() triggers:
  onSubscribe(Subscription) → subscription.request(n)
  onNext(item)* → onComplete() | onError(Throwable)
```

### Internal working

- **Assembly time:** `flux.map(f).filter(p)` builds a operator chain (linked nodes).
- **Subscribe time:** downstream requests upstream; each operator propagates `request`.
- **Cold:** each subscriber runs the source from scratch (HTTP call, DB query per subscriber).
- **Hot:** source runs independently; subscribers attach to ongoing stream (`share()`, `publish().refCount()`, `Sinks`).
- **Schedulers:** `publishOn` affects downstream; `subscribeOn` affects where subscription **starts** (often the source).

### Essential operators (production)

| Operator | Use | Footgun |
|---|---|---|
| `flatMap` | async merge (1→N async) | Unbounded concurrency default; use `flatMap(fn, concurrency)` |
| `concatMap` | ordered async | Serializes; can be slow |
| `switchMap` | latest wins | Cancels in-flight; good for search-as-you-type |
| `zip` | combine N sources | All must emit; one error fails all |
| `combineLatest` | latest from each | Emits when any emits |
| `onErrorResume` | fallback | Swallows error type — log before resume |
| `timeout` | SLA guard | Without retry, fails fast |
| `cache` | replay for late subscribers | Memory; stale data |
| `defer` | fresh supplier per subscribe | Use for per-request state |

### Code: cold vs hot

```java
// COLD — two subscribers = two HTTP calls
Flux<String> cold = webClient.get()
    .uri("/events")
    .retrieve()
    .bodyToFlux(String.class);

// HOT — multicast with refCount (last subscriber cancel stops source when refCount=0)
Flux<String> hot = cold.publish().refCount(1);

// Sinks — manual hot source (alerts, bus)
Sinks.Many<Alert> sink = Sinks.many().multicast().onBackpressureBuffer();
Flux<Alert> alerts = sink.asFlux();
```

### Production scenario: duplicate downstream calls on every request

**Problem.** Handler zips user profile and permissions; downstream sees **2x** traffic per API call. Metrics show two identical `GET /users/{id}` per inbound request.

**Cause.** Cold `Mono` wired twice without `cache()` or shared `flatMap` composition:

```java
// WRONG
Mono<User> user = userClient.getUser(id);
Mono<Details> details = userClient.getDetails(id);
return Mono.zip(user, details, UserView::new); // if userClient internally re-subscribes — OK
// But if you pass `user` into two branches that each subscribe — double call
```

Or: logging `user.doOnNext(...)` **and** returning `user` without `cache()` — two subscriptions.

**Solution.**

```java
Mono<User> user = userClient.getUser(id).cache();
// or single flatMap pipeline
return userClient.getUser(id)
    .flatMap(u -> userClient.getDetails(id).map(d -> new UserView(u, d)));
```

### Production scenario: `flatMap` concurrency blow-up

**Problem.** `flux.flatMap(id -> repo.findById(id))` with 10k IDs opens 10k concurrent DB connections; pool exhausted.

**Cause.** Default `flatMap` concurrency is `Queues.SMALL_BUFFER_SIZE` (256). Still too high for your pool of 20 connections.

**Solution.**

```java
return Flux.fromIterable(ids)
    .flatMap(id -> repo.findById(id), 8) // cap concurrency
    .collectList();
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Hot source without `refCount` / `share` | Leaked connections; late subscribers miss events |
| `subscribe()` without consumer in `@PostConstruct` | Silent drop; "works in debugger" |
| `block()` in tests copied to prod | Event-loop blocking |
| `Flux.interval` without `take` | Infinite stream; memory if collected |
| Ignoring `onError` | Swallowed failures; empty responses |

### Debugging tips

```java
// Dev only — traces signal flow
return mono
    .doOnSubscribe(s -> log.debug("sub {}", s))
    .doOnNext(v -> log.debug("next {}", v))
    .doOnError(e -> log.error("err", e))
    .doOnTerminate(() -> log.debug("done"))
    .name("user-pipeline")
    .tap(Micrometer.metrics(meterRegistry));
```

Use `StepVerifier` in unit tests; use `log()` operator sparingly in prod (volume).

---

## 3. DispatcherHandler vs DispatcherServlet

### Core concept

`DispatcherServlet` (MVC) maps HTTP to `@Controller` methods via `HandlerMapping` + `HandlerAdapter` (invocation on servlet thread). **`DispatcherHandler`** (WebFlux) does the same role for reactive handlers: it discovers `HandlerMapping` beans, finds a handler, invokes via `HandlerAdapter`, returns `Mono<HandlerResult>`.

```
WebFlux request
  └─ WebFilter chain (Netty)
       └─ DispatcherHandler
            ├─ HandlerMapping (RequestMappingHandlerMapping, RouterFunctionMapping, ...)
            ├─ HandlerAdapter (RequestMappingHandlerAdapter, HandlerFunctionAdapter)
            └─ HandlerResult → HandlerResultHandler (ResponseBodyResultHandler, ViewResolutionResultHandler)
```

### Internal working

1. `RequestMappingHandlerMapping` scans `@RestController` / `@Controller` with reactive return types (`Mono`, `Flux`, `ResponseEntity<Mono<T>>`).
2. `RouterFunctionMapping` matches `RouterFunction` beans.
3. `RequestMappingHandlerAdapter` invokes the method; return value must be a `Publisher` or reactive wrapper.
4. `ResponseBodyResultHandler` uses `HttpMessageWriter` list (`EncoderHttpMessageWriter` wrapping `Encoder`).
5. Exception handling: `WebExceptionHandler` (`ResponseStatusExceptionHandler`, `@ControllerAdvice` via `AbstractExceptionHandler`).

Differences that bite:

| Servlet MVC | WebFlux |
|---|---|
| `Filter` | `WebFilter` |
| `OncePerRequestFilter` | `WebFilter` + `chain.filter(exchange)` |
| `HttpServletRequest` | `ServerWebExchange` |
| `ResponseEntity` sync | `Mono<ResponseEntity<T>>` |
| `DeferredResult` / async servlet | native `Mono` |

### Production scenario: 404 on WebFlux route that "exists"

**Problem.** `GET /api/v1/orders` returns 404. Same mapping worked in MVC after gateway migration.

**Cause.** Gateway strips `/api` prefix; app maps `/v1/orders`. Or: two `DispatcherHandler` mappings — `RouterFunction` registered after annotated controller with overlapping pattern; wrong order. Or: using `@RestController` on servlet stack dependency only — app is still MVC.

**Solution.**

```java
// Verify stack
// spring.main.web-application-type=reactive

@Bean
RouterFunction<ServerResponse> routes() {
    return RouterFunctions.route()
        .GET("/v1/orders", req -> ServerResponse.ok().body(orderService.all(), Order.class))
        .build();
}
```

Confirm `spring.webflux.base-path` and gateway `StripPrefix` filter align.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `spring-boot-starter-web` + `starter-webflux` without config | Boot picks servlet; WebFlux beans ignored or dual stack confusion |
| `@Controller` returning `List<T>` not `Flux<T>` | Blocking serialization path; warnings |
| Missing `@ResponseBody` on reactive return | View resolution 404/500 |
| `ServerWebExchange` stored in singleton bean | Race; cross-request corruption |

### Debugging scenario

**Observe.** Handler never invoked; 404 with empty body.

**Diagnose.** Enable:

```yaml
logging.level.org.springframework.web.reactive=DEBUG
logging.level.org.springframework.boot.autoconfigure.web.reactive=DEBUG
```

Look for `Mapped to ...` vs `No handler found`. Inspect `RouterFunctionMapping` order.

**Fix.** Align paths with gateway; use single style (router vs annotation) per resource tree.

---

## 4. RouterFunctions vs Annotated Controllers

### Core concept

**Annotated controllers** (`@GetMapping`) — familiar, OpenAPI tooling, AOP (`@PreAuthorize`), validation (`@Valid`). **Router functions** — functional style, explicit `RouterFunction` beans, composable `nest`, `filter`, no reflection for mapping.

Both compile to the same `DispatcherHandler` pipeline. Choice is team ergonomics and cross-cutting needs.

### Router example

```java
@Configuration
public class OrderRouterConfig {

    @Bean
    public RouterFunction<ServerResponse> orderRoutes(OrderHandler handler) {
        return RouterFunctions.route()
            .path("/api/orders", builder -> builder
                .GET("", handler::list)
                .GET("/{id}", handler::get)
                .POST("", handler::create)
                .filter(new OrderAuditWebFilter()))
            .build();
    }
}

@Component
public class OrderHandler {
    public Mono<ServerResponse> list(ServerRequest req) {
        int page = req.queryParam("page").map(Integer::parseInt).orElse(0);
        return orderService.findPage(page)
            .collectList()
            .flatMap(list -> ServerResponse.ok().bodyValue(list));
    }
}
```

### Annotated example

```java
@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @GetMapping
    public Flux<Order> list(@RequestParam(defaultValue = "0") int page) {
        return orderService.findPage(page);
    }
}
```

### Production scenario: global validation doesn't run on RouterFunction

**Problem.** `@Valid` on `OrderRequest` works in `@RestController`; RouterFunction POST accepts malformed JSON without 400.

**Cause.** No `Validator` invoked — you must wire validation manually or use `RouterFunctions.route().before(...)` / custom `HandlerFilterFunction`.

**Solution.**

```java
public Mono<ServerResponse> create(ServerRequest req) {
    return req.bodyToMono(OrderRequest.class)
        .flatMap(orderValidator::validate) // returns Mono<OrderRequest> or Mono.error(WebExchangeBindException)
        .flatMap(orderService::create)
        .flatMap(o -> ServerResponse.created(uri).bodyValue(o));
}
```

Or use annotated controllers for input-heavy CRUD; routers for streaming/simple proxies.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Router + Controller same path | Ambiguous mapping; first wins; flaky 404 |
| `bodyToMono` without `contentType` check | 415/500 opaque errors |
| Heavy AOP on router handlers | Aspects may not apply; security gaps |
| OpenAPI generator only scans annotations | Undocumented router routes |

### Debugging tips

- Prefer one primary style per bounded context.
- Integration test both with `WebTestClient` regardless of style.

---

## 5. WebClient: Pooling, Timeouts, Retries, Exchange Strategies

### Core concept

`WebClient` is the reactive HTTP client (replaces blocking `RestTemplate` in WebFlux apps). It uses Reactor Netty `HttpClient` by default: connection pool, event loop, SSL. **Each poorly tuned WebClient is a production incident waiting for peak traffic.**

### Internal working

1. `WebClient.builder()` → `ExchangeFunctions` → `ReactorClientHttpConnector`.
2. Connection provider (`ConnectionProvider`) manages max connections, idle time, max life time, pending acquire timeout.
3. `retrieve()` vs `exchangeToMono()` — prefer `retrieve()`; `exchange()` can leak connections if body not consumed.
4. `ExchangeStrategies` control codecs (max in-memory buffer default **256KB** — large JSON blows up).

### Production configuration

```java
@Configuration
public class WebClientConfig {

    @Bean
    ConnectionProvider connectionProvider() {
        return ConnectionProvider.builder("downstream")
            .maxConnections(500)
            .pendingAcquireMaxCount(1000)
            .pendingAcquireTimeout(Duration.ofSeconds(45))
            .maxIdleTime(Duration.ofSeconds(20))
            .maxLifeTime(Duration.ofMinutes(5))
            .evictInBackground(Duration.ofSeconds(30))
            .build();
    }

    @Bean
    HttpClient httpClient(ConnectionProvider provider) {
        return HttpClient.create(provider)
            .responseTimeout(Duration.ofSeconds(10))
            .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)
            .doOnConnected(conn -> conn
                .addHandlerLast(new ReadTimeoutHandler(10))
                .addHandlerLast(new WriteTimeoutHandler(10)));
    }

    @Bean
    WebClient downstreamWebClient(HttpClient httpClient) {
        return WebClient.builder()
            .clientConnector(new ReactorClientHttpConnector(httpClient))
            .baseUrl("https://api.partner.com")
            .exchangeStrategies(ExchangeStrategies.builder()
                .codecs(c -> c.defaultCodecs().maxInMemorySize(2 * 1024 * 1024))
                .build())
            .filter(ExchangeFilterFunction.ofRequestProcessor(req -> {
                // propagate trace, auth
                return Mono.just(ClientRequest.from(req)
                    .header("X-Request-Id", MDC.get("traceId"))
                    .build());
            }))
            .build();
    }
}
```

### Retries (careful)

```java
return webClient.get()
    .uri("/resource/{id}", id)
    .retrieve()
    .bodyToMono(Resource.class)
    .timeout(Duration.ofSeconds(5))
    .retryWhen(Retry.backoff(3, Duration.ofMillis(200))
        .filter(ex -> ex instanceof WebClientRequestException
            || (ex instanceof WebClientResponseException w && w.getStatusCode().is5xxServerError()))
        .onRetryExhaustedThrow((spec, signal) -> signal.failure()));
```

Never retry POST that isn't idempotent without deduplication keys.

### Circuit breaker integration (Resilience4j)

```java
@Bean
ReactiveCircuitBreakerFactory circuitBreakerFactory() {
    return new ReactiveResilience4JCircuitBreakerFactory();
}

// usage in service
return circuitBreakerFactory.create("partner-api")
    .run(
        webClient.get().uri("/v1/status").retrieve().bodyToMono(Status.class),
        throwable -> Mono.just(Status.degraded())
    );
```

Tune `slidingWindowSize`, `failureRateThreshold`, and `waitDurationInOpenState` per downstream SLA. A circuit breaker on a reactive chain **does not** release WebClient connections — still drain bodies on fallback paths.

### Production scenario: connection pool exhausted

**Problem.** Spikes of `PoolAcquirePendingLimitException` or `TimeoutException: Acquire operation took longer than 45000ms`. Downstream is healthy.

**Cause.** `maxConnections` too low for `flatMap` concurrency × instances. Or: slow responses hold connections; pending queue grows. Or: **`exchangeToMono` without releasing body** on error paths.

**Solution.** Right-size pool; cap `flatMap` concurrency; use `retrieve()`; set `pendingAcquireTimeout` to fail fast; circuit breaker (Resilience4j).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| New `WebClient.create()` per request | No pool reuse; TCP churn; ephemeral port exhaustion |
| Default 256KB buffer | `DataBufferLimitException` on large payloads |
| No response timeout | Hung chains; memory leak of in-flight Monos |
| Retry on 429/409 | Retry storm; banned by partner |
| Missing correlation ID filter | Cannot trace cross-service |

### Debugging tips

Enable Reactor Netty wire tap **only in staging**:

```java
HttpClient.create()
    .wiretap("reactor.netty.http.client", LogLevel.DEBUG, AdvancedByteBufFormat.TEXTUAL);
```

Metrics: `reactor.netty.connection.provider` metrics via Micrometer.

---

## 6. Backpressure, Prefetch, and boundedElastic Misuse

### Core concept

**Backpressure** is how a slow consumer signals a fast producer to slow down. Reactor honors `request(n)` from Reactive Streams. **`Flux`** from cold sources respects backpressure; some hot sources buffer or drop.

**Prefetch** — operators like `publishOn`/`flatMap` prefetch a batch (default 32) to reduce scheduling overhead. Too high prefetch × slow consumer = memory pressure.

**`Schedulers.boundedElastic()`** — thread pool for blocking I/O escape hatch. **Misuse turns WebFlux into a worse thread-pool server.**

### Internal working

- `onBackpressureBuffer` / `drop` / `latest` — handle overflow when upstream ignores backpressure (e.g. `interval`).
- `limitRate(n)` — consumer-side throttle.
- `boundedElastic` has capped threads (10 × CPUs default) and **queued tasks** (100k default) — queue growth = GC pain.

### Production scenario: OOM during bulk export

**Problem.** `GET /export` streams millions of rows; heap grows until OOM.

**Cause.** `findAll().collectList()` materializes entire table. Or: `flatMap` with high concurrency buffers all in-flight rows.

**Solution.**

```java
@GetMapping(value = "/export", produces = MediaType.APPLICATION_NDJSON_VALUE)
public Flux<Order> export() {
    return orderRepository.findAll()
        .limitRate(100);
}
```

Ensure R2DBC driver streams; never `collectList()` on unbounded data.

### Production scenario: boundedElastic queue explosion

**Problem.** Under load, latency rises; heap full of `BoundedElasticScheduler` queued tasks.

**Cause.** Every request does `subscribeOn(boundedElastic)` for JDBC — 50k requests queue work; event loop free but elastic pool and queue drown.

**Solution.** Reduce blocking surface (R2DBC); bulkhead elastic usage; separate executor with explicit rejection policy; or revert stack.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `onBackpressureBuffer()` unbounded | OOM |
| `parallel()` on blocking JDBC | Pool chaos |
| Ignoring `OverflowException` | Dropped events without metrics |
| `publishOn` before slow op without prefetch tuning | Throughput collapse |

### Debugging tips

- Watch `reactor.scheduler.boundedElastic.*` metrics (queue size, active threads).
- Heap dump: dominator tree for `Runnable` queued in elastic scheduler.

### Production scenario: `limitRate` ignored — export still OOM

**Problem.** Developer added `limitRate(50)` but export still exhausts heap on a 5M-row table.

**Cause.** `limitRate` only affects downstream demand if upstream honors backpressure. A `Flux.fromIterable(rows)` where `rows` is a pre-loaded `List` in memory is not backpressure-aware — the entire list is already on the heap. Or: `flatMap` with default prefetch re-buffers faster than the client reads.

**Solution.**

```java
// Stream from DB cursor — never materialize list first
return databaseClient.sql("SELECT * FROM orders WHERE tenant_id = :t")
    .bind("t", tenantId)
    .map(this::mapRow)
    .all()
    .limitRate(100)
    .publishOn(Schedulers.boundedElastic(), 100); // explicit prefetch = limitRate
```

Validate with `curl -N` and watch heap during export in staging.

### Operator cheat sheet (interview depth)

| Symptom in prod | Operator to suspect | Fix direction |
|---|---|---|
| Duplicate HTTP calls | cold `Mono` subscribed twice | `cache()`, single `flatMap` |
| Out-of-order results | `flatMap` vs `concatMap` | Use `concatMap` if order matters |
| Stale search results | missing `switchMap` | `switchMap` cancels prior |
| Hung pipeline after first error | missing `onError*` | `onErrorResume` / propagate |
| Memory climb on interval ticks | hot source no backpressure | `onBackpressureLatest()` |

---

## 7. Blocking Calls on Reactive Threads

### Core concept

**Event-loop threads must never block.** Blocking includes: JDBC, JPA, `Thread.sleep`, file I/O (unless virtual-thread hybrid), `RestTemplate`, `.block()`, `.blockOptional()`, `CountDownLatch.await`, synchronized sections contended for milliseconds+.

Reactor 3.5+ detects blocking on non-blocking schedulers in tests (BlockHound). Production often shows only **throughput collapse**.

### Forbidden patterns

```java
// FORBIDDEN on event loop
@GetMapping("/{id}")
public Mono<User> get(@PathVariable String id) {
    return Mono.just(jdbcTemplate.queryForObject("...", User.class)); // blocks during subscribe
}

@GetMapping("/{id}")
public Mono<User> get(@PathVariable String id) {
    return userRepo.findById(id).block(); // explicit block
}

@GetMapping("/{id}")
public Mono<User> get(@PathVariable String id) {
    return Mono.fromCallable(() -> jpaRepo.getReferenceById(id)); // JPA blocks — MUST subscribeOn elastic
}
```

### Escape hatch (interim only)

```java
return Mono.fromCallable(() -> jdbcRepo.findById(id))
    .subscribeOn(Schedulers.boundedElastic())
    .timeout(Duration.ofSeconds(5));
```

### Production scenario: random 504 from gateway

**Problem.** Gateway timeout 30s; upstream WebFlux sometimes 504; thread dump shows `reactor-http-nio-3` blocked in `socketRead0` on DB.

**Cause.** "Reactive" repository wrapper still uses blocking JDBC on event loop.

**Solution.** R2DBC driver; or dedicated blocking service called via messaging; not elastic band-aid at scale.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `block()` in filter | Total stall |
| JPA `@Transactional` in WebFlux controller | Thread-bound session; leaks |
| `Files.readAllBytes` in `map` | Blocks loop |
| Feign client (blocking) in WebFlux | Thread starvation |

### Debugging tips

- BlockHound in CI.
- `reactor.netty.ReactorNetty` blocked thread detector (when enabled).
- Code review rule: no `block` outside tests; no JDBC in `map` without `subscribeOn`.

---

## 8. Schedulers and Context Propagation

### Core concept

**Schedulers** define where operators run: `parallel()` (CPU), `boundedElastic()` (blocking), `immediate()`, `single()`. **`publishOn`** shifts downstream; **`subscribeOn`** shifts subscription.

**Context propagation:** `ThreadLocal` (MDC, Spring Security servlet) **does not flow** across reactive threads. Use **Reactor Context** (`ContextView`) and Micrometer Context Propagation (Boot 3.x).

### Reactor Context

```java
return Mono.deferContextual(ctx -> {
    String tenantId = ctx.get("tenantId");
    return repo.findByTenant(tenantId);
})
.contextWrite(Context.of("tenantId", exchange.getRequest().getHeaders().getFirst("X-Tenant-Id")));
```

### Micrometer context propagation (Boot 3.2+)

```java
// Often auto-configured with micrometer-tracing
Hooks.enableAutomaticContextPropagation();
```

Bridges `ThreadLocal` ↔ Reactor Context for tracing (W3C `traceparent`) and MDC when using supported instrumentation.

### Production scenario: trace IDs missing in logs after `publishOn`

**Problem.** Access logs have `traceId`; application logs after `flatMap` do not. Jaeger shows broken spans.

**Cause.** `publishOn(Schedulers.parallel())` without context restore. Logback MDC is ThreadLocal.

**Solution.**

```xml
<!-- logback-spring.xml -->
<configuration>
    <appender name="CONSOLE" class="ch.qos.logback.classic.AsyncAppender">
        <appender-ref ref="STDOUT"/>
    </appender>
</configuration>
```

```java
// Boot 3 + micrometer-tracing-bridge-otel
// Ensure context-propagation dependency present
```

```java
return mono
    .publishOn(Schedulers.parallel())
    .doOnEach(signal -> {
        if (signal.getContextView().hasKey("traceId")) {
            MDC.put("traceId", signal.getContextView().get("traceId"));
        }
    });
```

Prefer automatic propagation over manual MDC in `doOnEach`.

### Production scenario: Security context empty in service layer

**Problem.** `ReactiveSecurityContextHolder.getContext()` empty in `flatMap` after `publishOn`.

**Cause.** Security context stored in Reactor Context by `SecurityWebFilterChain`; lost when switching threads without `contextWrite` / automatic propagation.

**Solution.**

```java
return orderService.findForCurrentUser()
    .contextWrite(ReactiveSecurityContextHolder.withAuthentication(auth));
```

Or rely on `ReactiveSecurityContextHolder` downstream of security filters without manual `publishOn` before auth-sensitive calls.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `ThreadLocal` in WebFilter not cleared | Leak across requests on pooled threads |
| Manual MDC without clear | Wrong tenant in logs |
| `subscribeOn` after `contextWrite` | Context not visible upstream |
| `InheritableThreadLocal` | Cross-request bleed in elastic pool |

### Debugging tips

- `Context` is immutable; `contextWrite` adds at subscribe time — order matters (last write wins for read).
- Use `deferContextual` not `subscriberContext()` (removed).

---

## 9. Security on WebFlux (SecurityWebFilterChain)

### Core concept

WebFlux Security uses **`SecurityWebFilterChain`** (not `SecurityFilterChain`). Filters are **`WebFilter`** implementations. Authentication lives in **Reactor Context** via `ReactiveSecurityContextHolder`, not `SecurityContextHolder` ThreadLocal.

```
HTTP exchange
  └─ WebFilter chain
       └─ SecurityWebFilterChain (@EnableWebFluxSecurity)
            ├─ SecurityContextServerWebExchangeWebFilter
            ├─ AuthenticationWebFilter (login)
            ├─ AuthenticationWebFilter (bearer JWT)
            ├─ AuthorizationWebFilter
            └─ ExceptionTranslationWebFilter
       └─ DispatcherHandler
```

### Configuration

```java
@Configuration
@EnableWebFluxSecurity
@EnableReactiveMethodSecurity
public class SecurityConfig {

    @Bean
    SecurityWebFilterChain springSecurity(ServerHttpSecurity http) {
        return http
            .csrf(ServerHttpSecurity.CsrfSpec::disable)
            .authorizeExchange(ex -> ex
                .pathMatchers("/actuator/health").permitAll()
                .pathMatchers(HttpMethod.GET, "/api/public/**").permitAll()
                .anyExchange().authenticated())
            .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
            .build();
    }
}
```

### Reactive method security

```java
@Service
public class OrderService {
    @PreAuthorize("hasRole('USER')")
    public Mono<Order> findById(long id) {
        return ReactiveSecurityContextHolder.getContext()
            .map(SecurityContext::getAuthentication)
            .map(Authentication::getName)
            .flatMap(owner -> repo.findByIdAndOwner(id, owner));
    }
}
```

### Production scenario: 401 on WebFlux resource server with valid JWT

**Problem.** Same JWT works on servlet sibling service. WebFlux returns 401.

**Cause.** `spring-boot-starter-web` pulled in; app is hybrid. Or: `SecurityWebFilterChain` not imported in test. Or: CORS preflight hits secured exchange without `permitAll` on OPTIONS.

**Solution.**

```yaml
spring:
  main:
    web-application-type: reactive
```

```java
.authorizeExchange(ex -> ex
    .pathMatchers(HttpMethod.OPTIONS).permitAll()
    ...
)
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `SecurityContextHolder.getContext()` in WebFlux | Always empty / wrong |
| `@EnableWebSecurity` instead of `@EnableWebFluxSecurity` | Security not applied |
| CSRF on stateless API | 403 on POST |
| `authorizeHttpRequests` copy-paste | Compile error or wrong API |

### Debugging tips

```yaml
logging.level.org.springframework.security: DEBUG
```

Look for `Authorization failed` on exchange. Use `WebTestClient` with `mutateWith(mockJwt())`.

---

## 10. R2DBC vs Blocking JDBC Bridge

### Core concept

**R2DBC** — reactive relational driver API; true non-blocking when driver and DB support it (PostgreSQL, MySQL, SQL Server). **Blocking JDBC bridge** — `Mono.fromCallable(() -> jdbc...).subscribeOn(boundedElastic)` — keeps thread-per-call semantics under the hood.

### R2DBC example

```java
public interface OrderRepository extends ReactiveCrudRepository<Order, Long> {
    @Query("SELECT * FROM orders WHERE owner = :owner")
    Flux<Order> findByOwner(String owner);
}
```

```yaml
spring:
  r2dbc:
    url: r2dbc:postgresql://localhost:5432/orders
    pool:
      max-size: 20
      initial-size: 5
      max-acquire-time: 5s
```

### When bridge is acceptable

- Migration phase; low QPS admin endpoints.
- Stored procedures with no R2DBC equivalent.
- Short-term — with explicit bulkhead and metrics on elastic pool.

### Production scenario: R2DBC pool exhausted faster than JDBC ever did

**Problem.** `R2dbcTimeoutException: Connection acquisition timed out after 5000ms`. DB connections normal.

**Cause.** Long chains hold connection across `flatMap` to HTTP call:

```java
// WRONG — holds DB connection during WebClient call
return repo.findById(id)
    .flatMap(order -> webClient.get().uri(...).retrieve().bodyToMono(Details.class)
        .map(d -> merge(order, d)));
```

**Solution.**

```java
return repo.findById(id)
    .flatMap(order -> webClient.get()...map(d -> merge(order, d)))
    .as(transactionalOperator::transactional); // only if needed

// Better: release connection before remote call
return repo.findById(id)
    .flatMap(order ->
        webClient.get()...map(d -> merge(order, d))); // ensure no transactional wrapper spans webClient
```

Use `flatMap` sequential steps; don't nest blocking remote inside `@Transactional` reactive transaction.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| R2DBC + JPA same table | Two models; consistency nightmares |
| No pool max on R2DBC | DB max connections hit |
| `collectList` on large Flux query | Memory |
| Flyway + R2DBC without JDBC URL for migrate | Startup fail — use separate JDBC for Flyway |

### Debugging tips

- Enable `io.r2dbc.postgresql.QUERY` logging (driver-specific).
- Compare connection hold time with pg_stat_activity.

---

## 11. Error Handling: onError*, GlobalExceptionHandler, ProblemDetail

### Core concept

Errors propagate as `onError` signals. Uncaught, they become **500** via `WebExceptionHandler`. Use **`@ControllerAdvice`** (reactive) for typed HTTP mapping. Boot 3 **`ProblemDetail`** (RFC 7807) for consistent API errors.

### Controller advice

```java
@RestControllerAdvice
public class GlobalErrorHandler {

    @ExceptionHandler(NotFoundException.class)
    public Mono<ResponseEntity<ProblemDetail>> notFound(NotFoundException ex, ServerWebExchange exchange) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setTitle("Resource Not Found");
        pd.setInstance(URI.create(exchange.getRequest().getPath().value()));
        return Mono.just(ResponseEntity.status(HttpStatus.NOT_FOUND).body(pd));
    }

    @ExceptionHandler(WebExchangeBindException.class)
    public Mono<ResponseEntity<ProblemDetail>> validation(WebExchangeBindException ex) {
        ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        pd.setProperty("errors", ex.getFieldErrors().stream()
            .map(fe -> Map.of("field", fe.getField(), "message", fe.getDefaultMessage()))
            .toList());
        return Mono.just(ResponseEntity.badRequest().body(pd));
    }
}
```

### Operator-level handling

```java
return repo.findById(id)
    .switchIfEmpty(Mono.error(new NotFoundException(id)))
    .onErrorMap(DataAccessException.class, ex -> new ServiceUnavailableException("DB error", ex));
```

Avoid swallowing:

```java
// DANGEROUS — empty 200
.onErrorResume(e -> Mono.empty());
```

### Production scenario: client receives empty 200 on downstream failure

**Problem.** API returns 200 with empty body when partner is down.

**Cause.** `onErrorResume(e -> Mono.empty())` in service "to keep stream alive."

**Solution.** Map to ProblemDetail; use `onErrorResume` only for known benign cases; metric `error` counters.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `block()` in advice | Blocked event loop |
| Returning `ProblemDetail` sync in reactive advice | Works but inconsistent; prefer `Mono` |
| Multiple `@ControllerAdvice` unordered | Wrong handler wins |
| `ErrorWebExceptionHandler` custom without default | Whitelabel leak |

### Debugging tips

- `doOnError` log with correlation ID before resume.
- Test error paths with `WebTestClient` expecting `application/problem+json`.

---

## 12. SSE and Streaming Responses

### Core concept

**Server-Sent Events (SSE)** — unidirectional text stream over HTTP (`text/event-stream`). Ideal for live dashboards, progress, notifications. WebFlux returns `Flux<ServerSentEvent<T>>` or `Flux<T>` with content type `TEXT_EVENT_STREAM`.

### Example

```java
@GetMapping(value = "/stream/orders", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public Flux<ServerSentEvent<OrderEvent>> streamOrders() {
    return orderEventBus.stream()
        .map(ev -> ServerSentEvent.<OrderEvent>builder()
            .id(ev.id())
            .event(ev.type())
            .data(ev)
            .retry(Duration.ofSeconds(3))
            .build())
        .onErrorResume(e -> Flux.just(ServerSentEvent.<OrderEvent>builder()
            .event("error")
            .comment("stream paused")
            .build()));
}
```

### Internal working

- Netty chunks response; backpressure from slow client slows `Flux` if source is backpressure-aware.
- Proxies/load balancers may buffer — disable buffering (`X-Accel-Buffering: no` on nginx).
- Idle timeouts on gateway kill long SSE — raise or use heartbeat comments (`: ping\n\n`).

### Production scenario: SSE works locally, stalls in production

**Problem.** Events batch every 30s instead of real-time.

**Cause.** Corporate nginx buffering; ALB idle timeout; `Flux.interval` without `publishOn` blocking.

**Solution.**

```java
return flux.doOnSubscribe(s -> log.info("client connected"));
```

Gateway:

```yaml
# Spring Cloud Gateway — increase response timeout for SSE routes
spring.cloud.gateway.httpclient.response-timeout: 0 # careful — use route-specific filters
```

Nginx: `proxy_buffering off;` for `/stream/**`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Hot `Flux` without heartbeat | Gateway 504 mid-stream |
| `collectList` before SSE | Not streaming |
| Jackson serialize infinite Flux | Memory |
| Missing CORS on EventSource | Browser silent fail |

### Debugging tips

- `curl -N` tests true streaming.
- Watch chunk encoding in Wireshark.

---

## 13. WebSocket on WebFlux

### Core concept

WebFlux WebSocket uses `WebSocketHandler` or `@MessageMapping` with STOMP (less common in pure WebFlux). Handshake goes through same `WebFilter` / security chain.

### Handler example

```java
@Configuration
public class WebSocketConfig {

    @Bean
    public HandlerMapping webSocketMapping(OrderWebSocketHandler handler) {
        Map<String, WebSocketHandler> map = Map.of("/ws/orders", handler);
        SimpleUrlHandlerMapping mapping = new SimpleUrlHandlerMapping();
        mapping.setOrder(-1);
        mapping.setUrlMap(map);
        return mapping;
    }

    @Bean
    public WebSocketHandlerAdapter handlerAdapter() {
        return new WebSocketHandlerAdapter();
    }
}

@Component
public class OrderWebSocketHandler implements WebSocketHandler {
  @Override
  public Mono<Void> handle(WebSocketSession session) {
    Flux<WebSocketMessage> out = session.receive()
        .map(WebSocketMessage::getPayloadAsText)
        .flatMap(this::processCommand)
        .map(session::textMessage);

    return session.send(out);
  }
}
```

### Security

```java
http.authorizeExchange(ex -> ex
    .pathMatchers("/ws/**").authenticated());
// Pass JWT as query param or Sec-WebSocket-Protocol — document threat model
```

### Production scenario: WebSocket disconnects every 60s

**Problem.** Clients reconnect loop; load balancer idle timeout 60s.

**Cause.** No ping frames; ALB treats connection as idle.

**Solution.** Implement `WebSocketSession` ping/pong or application-level heartbeat every 30s.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Blocking in `handle` | Stalls all WS on loop |
| Unbounded inbound `receive()` | Memory if client floods |
| STOMP + reactive mismatch | Complex; thread leaks |
| Same origin CSRF ignored for WS | CSRF on cookie auth handshake |

### Debugging tips

- Log session id on open/close.
- Metric: active sessions, messages/sec.

---

## 14. Testing: StepVerifier and WebTestClient

### Core concept

**`StepVerifier`** — unit-test `Publisher` signals with virtual time. **`WebTestClient`** — integration test WebFlux endpoints (binds to `RouterFunction` / `@Controller` / full context).

### StepVerifier

```java
@Test
void shouldEmitOneUser() {
    StepVerifier.create(userService.findById("1"))
        .expectNextMatches(u -> u.id().equals("1"))
        .verifyComplete();
}

@Test
void shouldTimeout() {
    StepVerifier.withVirtualTime(() -> slowService.get())
        .thenAwait(Duration.ofSeconds(11))
        .expectError(TimeoutException.class)
        .verify();
}
```

### WebTestClient

```java
@WebFluxTest(OrderController.class)
class OrderControllerTest {
    @Autowired WebTestClient client;

    @MockBean OrderService orderService;

    @Test
    void getOrder() {
        when(orderService.findById(1L)).thenReturn(Mono.just(new Order(1L)));

        client.get().uri("/api/orders/1")
            .accept(MediaType.APPLICATION_JSON)
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.id").isEqualTo(1);
    }
}
```

Security:

```java
client.mutateWith(mockJwt().authorities(new SimpleGrantedAuthority("ROLE_USER")))
    .get()...
```

### Production scenario: tests pass, prod fails on empty response

**Problem.** `StepVerifier` green; production returns 200 empty body.

**Cause.** Test used `verifyComplete()` on `Mono` that never subscribed in prod due to missing `return`. Or: mocked `Mono.empty()` hiding logic bug.

**Solution.** WebTestClient integration tests; `StepVerifier.create(mono, 0)` verify no premature subscribe if testing cold behavior.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `block()` in tests only | Prod block missed |
| No `@Import(SecurityConfig)` | Open tests; prod 401 |
| Real WebClient in tests | Flaky CI |
| Virtual time not used on `delay` | Slow tests |

### Debugging tips

- `StepVerifier.setDefaultTimeout(Duration.ofSeconds(5))` in CI.
- `@AutoConfigureWebTestClient` on `@SpringBootTest` for full stack.

---

## 15. Observability: Micrometer, Context Propagation, Tracing

### Core concept

Reactive chains break naive tracing (one thread per request). Use **Micrometer Observation**, **OpenTelemetry** bridge, **context propagation** library, Reactor **`tap(Micrometer.metrics(registry))`**.

### Boot configuration

```yaml
management:
  tracing:
    sampling:
      probability: 1.0
  metrics:
    export:
      prometheus:
        enabled: true

spring:
  reactor:
    context-propagation: auto
```

```java
@Bean
MeterFilter meterFilter() {
    return MeterFilter.maximumAllowableTags("http.client.requests", "uri", 100, MeterFilter.deny());
}
```

### Instrument WebClient

```java
WebClient.builder()
    .filter(new ObservationWebClientFilter(observationRegistry))
    .build();
```

### Production scenario: p99 metrics flat, traces show 40 nested spans for one call

**Problem.** Dashboard shows high span count; cardinality explosion on `uri` tag with IDs.

**Cause.** WebClient records full URI `/users/123` as tag.

**Solution.** Use templated URI tags; `lowCardinalityKeyValues`; filter metrics.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No context propagation dep | Broken parent-child spans |
| `Hooks.enableAutomaticContextPropagation` missing (older stacks) | MDC loss |
| High-cardinality tags | Prometheus OOM |
| Logging every `onNext` | Log volume cost |

### Debugging tips

- Trace one request in Tempo/Jaeger; verify single root span.
- Compare servlet vs reactive trace plugins.

---

## 16. Spring Cloud Gateway Integration (Brief)

### Core concept

**Spring Cloud Gateway** is WebFlux-native (Netty). It routes, filters, load-balances to downstream reactive or blocking services. WebFlux microservices sit **behind** or **beside** Gateway.

### Typical flow

```
Client → Gateway (WebFlux)
           ├─ JwtAuth filter
           ├─ RequestRateLimiter (Redis reactive)
           ├─ CircuitBreaker
           └─ lb://order-service → your WebFlux app
```

### WebFlux service behind Gateway

- Propagate `traceparent`, `X-Request-Id`, `Authorization`.
- Configure **response timeout** per route for SSE/WebSocket.
- **StripPrefix** / **RewritePath** must match `RouterFunction` paths.

### Production scenario: 503 SHORTCUT from Gateway, service healthy

**Problem.** Direct pod access works; through Gateway 503.

**Cause.** Gateway `lb://` service not registered; wrong K8s port; **HTTP vs HTTPS** scheme; reactive load balancer cache stale.

**Solution.** Verify `spring.cloud.kubernetes.discovery`; `ManagementPort` separate; health on correct port.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Global CORS + service CORS | Duplicate headers; browser fail |
| Rate limiter blocking Redis | Gateway event-loop blocked — use reactive Redis |
| Body size limits | 413 on upload |
| SSL termination path mismatch | Redirect loops |

### Debugging tips

- Gateway DEBUG `RoutePredicateHandlerMapping`.
- Compare headers direct vs via Gateway.

---

## 17. Virtual Threads vs WebFlux in Boot 3.2+

### Core concept

**Virtual threads** (Project Loom, `spring.threads.virtual.enabled=true`) give servlet MVC **thread-per-request ergonomics** with cheap blocking I/O. This reopens the question: **WebFlux for throughput** vs **MVC + virtual threads for simplicity**.

### Comparison

| Dimension | WebFlux + R2DBC | MVC + Virtual Threads + JDBC |
|---|---|---|
| Programming model | Mono/Flux everywhere | Blocking, familiar |
| JDBC/JPA | Poor fit | Natural fit |
| SSE / long poll | Strong | Acceptable with tuning |
| Team learning curve | High | Low |
| Debugging | Harder stack traces | Familiar thread dumps |
| End-to-end reactive | Required for payoff | N/A |

### When to reconsider WebFlux (Boot 3.2+)

- Greenfield service that's **mostly CRUD + JPA**.
- Migration motivated only by "scalability" without blocking profile.
- Elastic scheduler queue growing — you're simulating a thread pool badly.

### When to keep WebFlux

- Gateway already WebFlux; team fluent in Reactor.
- Streaming, WS, high-concurrency I/O multiplexing proven in load tests.
- Data layer is R2DBC / reactive Mongo / reactive Kafka throughout.

### Production scenario: team chose WebFlux; 18 months later maintaining `boundedElastic` everywhere

**Problem.** 60% of handlers use `subscribeOn(boundedElastic)`; incidents weekly.

**Cause.** Original JPA data layer never migrated.

**Solution.** Pilot MVC + virtual threads on new service; strangler migration; measure p99 and CPU before full revert.

```yaml
# servlet service application.yml
spring:
  threads:
    virtual:
      enabled: true
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Virtual threads + synchronized native code pin | Carrier pool exhaustion |
| WebFlux + VT "hybrid" without plan | Two pools, confusion |
| Assuming VT replaces need for backpressure on streams | OOM on bulk export still possible |

### Debugging tips

- JFR: `jdk.VirtualThreadPinned` events.
- Load test both stacks with **same** workload before rewriting.

---

## 18. Common Production Failures

### Thread starvation on event loop

**Problem.** Sudden global latency; CPU not saturated.

**Cause.** Blocking call on `reactor-http-nio-*`.

**Solution.** BlockHound; remove blocking; offload temporarily.

### Unbounded queues

**Problem.** GC thrash; `OutOfMemoryError: Java heap space` in `BoundedElasticScheduler`.

**Cause.** Mass `subscribeOn(boundedElastic)`; `onBackpressureBuffer(Integer.MAX_VALUE)`.

**Solution.** Cap queue; reject; R2DBC; scale out.

### Missing `subscribe()`

**Problem.** "Sometimes works" — fire-and-forget Mono created but never subscribed in `@PostConstruct` job.

**Cause.**

```java
@PostConstruct
void init() {
    refreshCache(); // returns Mono<Void> — nobody subscribes
}
```

**Solution.**

```java
@PostConstruct
void init() {
    refreshCache().subscribe(); // or block in init only on boundedElastic — better: ApplicationRunner
}
```

### Connection pool leaks (WebClient)

**Problem.** `Connection pool exhausted` after days.

**Cause.** `exchangeToMono` without consuming body on 4xx/5xx.

**Solution.** Use `retrieve()`; `onStatus` handlers that drain body.

### Silent error swallowing

**Problem.** Metrics green; customers see wrong data.

**Cause.** `onErrorResume(e -> Mono.just(default))`.

**Solution.** Log + metric; fail for authoritative reads.

### Misconfigured dual stack

**Problem.** Random servlet vs reactive behavior.

**Cause.** Both `starter-web` and `starter-webflux`.

**Solution.**

```yaml
spring:
  main:
    web-application-type: reactive  # or servlet — one
```

### Hot Flux without cancellation

**Problem.** CPU spike after clients disconnect.

**Cause.** Source ignores cancel signal.

**Solution.** `takeUntilOther`; `using`; test with `StepVerifier.cancel()`.

### Reactor `Hooks` left enabled in production

**Problem.** CPU 30% higher after "debugging incident"; logs enormous.

**Cause.** `Hooks.onOperatorDebug()` or `log()` operator left in hot path. Assembly stack capture on every operator is expensive.

**Solution.** Guard debug hooks with profile; never ship `onOperatorDebug` to prod. Search codebase for `Hooks.` in `@PostConstruct`.

### `Schedulers.parallel()` for blocking work

**Problem.** Team moved JDBC from event loop to `Schedulers.parallel()` "because docs say parallel is for CPU."

**Cause.** `parallel()` uses fixed pool sized to CPU count; blocking JDBC holds those threads — same starvation pattern as event loop, different pool.

**Solution.** Blocking → `boundedElastic` only as debt; correct fix is R2DBC or MVC + virtual threads.

### Multipart upload buffering entire file

**Problem.** `MultipartFile` equivalent in WebFlux — `filePart.content().collectList()` loads whole upload into memory; OOM on 500MB files.

**Cause.** Treating `FilePart` as blocking servlet multipart.

**Solution.**

```java
return exchange.getMultipartData()
    .flatMapMany(map -> Flux.fromIterable(map.get("file")))
    .cast(FilePart.class)
    .flatMap(part -> storageService.store(part.content())) // stream to S3/blob
    .then(Mono.just(ResponseEntity.accepted().build()));
```

### Summary table

| Failure | Signature | First action |
|---|---|---|
| Event-loop block | `reactor-http-nio` in JDBC stack | BlockHound trace |
| Elastic queue OOM | `BoundedElasticScheduler` in heap dump | Count `subscribeOn` usages |
| Pool exhausted | `PoolAcquirePendingLimitException` | Pool metrics + flatMap concurrency |
| Missing subscribe | No logs, no effect | Search `.subscribe(` |
| SSE stall | Batched events | Proxy buffering |
| Broken traces | Orphan spans | context-propagation dep |

---

## 19. Performance Tuning and Netty Server Options

### Core concept

Default Netty settings suit many apps; high-QPS services tune **worker count**, **buffer sizes**, **max connections**, **idle timeouts**, and **allocator**.

### Server configuration

```java
@Configuration
public class NettyServerConfig {

    @Bean
    public NettyServerCustomizer nettyServerCustomizer() {
        return server -> server
            .option(ChannelOption.SO_BACKLOG, 10000)
            .childOption(ChannelOption.SO_KEEPALIVE, true)
            .childOption(ChannelOption.TCP_NODELAY, true)
            .idleTimeout(Duration.ofSeconds(60))
            .runOn(LoopResources.create("reactor-http", 8, true));
    }
}
```

```yaml
server:
  netty:
    connection-timeout: 5s
    idle-timeout: 60s
  compression:
    enabled: true
```

### Reactor Netty HTTP server limits

```yaml
spring:
  codec:
    max-in-memory-size: 1MB
```

### Production scenario: latency spikes at exact QPS threshold

**Problem.** Cliff at 8k RPS on 8-core box.

**Cause.** Default worker threads = cores; CPU work in `map` contends on event loop.

**Solution.** Offload CPU to `Schedulers.parallel()` after I/O; don't increase loops blindly — profile.

### JVM / GC

- Prefer G1/ZGC with consistent heap.
- Direct memory for Netty — monitor `MaxDirectMemorySize`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `max-in-memory-size` too high | OOM on large uploads |
| Compression on SSE | Broken streams |
| Too many event loops | Context switching |
| `-Xmx` tiny with direct buffers | Native OOM |

### Debugging tips

- Micrometer: `reactor.netty.eventloop`, `http.server.requests`.
- `reactor.netty.ioWorkerCount` system property (use cautiously).

---

## 20. Reactive Data Access Patterns

### Core concept

End-to-end reactive means **non-blocking from socket to driver**. Patterns: **transactional operator**, **cursor streaming**, **batch insert**, **caching** with reactive Redis.

### TransactionalOperator

```java
@Bean
TransactionalOperator transactionalOperator(ReactiveTransactionManager rtm) {
    return TransactionalOperator.create(rtm);
}

public Mono<Order> placeOrder(OrderDraft draft) {
    return orderRepo.save(draft.toOrder())
        .flatMap(order -> lineItemRepo.saveAll(draft.items()).thenReturn(order))
        .as(transactionalOperator::transactional);
}
```

### Streaming query

```java
public Flux<AuditRow> auditStream(Instant since) {
    return databaseClient.sql("SELECT * FROM audit WHERE ts > :since")
        .bind("since", since)
        .map((row, meta) -> map(row))
        .all();
}
```

### Caching

```java
return redis.opsForValue()
    .get("user:" + id)
    .switchIfEmpty(
        userRepo.findById(id)
            .flatMap(u -> redis.opsForValue().set("user:" + id, u, Duration.ofMinutes(10)).thenReturn(u))
    );
```

### Production scenario: duplicate orders on retry

**Problem.** Client retries POST; two orders created.

**Cause.** Reactive pipeline retried **`save`** without idempotency key.

**Solution.**

```java
return idempotencyStore.claim(key)
    .flatMap(claimed -> claimed
        ? orderRepo.save(order)
        : idempotencyStore.result(key));
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Long `@Transactional` spans HTTP | Pool hold |
| `saveAll` without batching | N round trips |
| Cache stampede | Thundering herd on miss |
| Read-your-writes broken | Stale cache after write |

### Debugging tips

- Log transaction boundaries (dev).
- R2DBC proxy logging for slow queries.

---

## 21. Production Debugging Playbook

When a WebFlux bug is "random," it is usually **blocking on the event loop**, **connection pool lifecycle**, **missing context after scheduler hop**, or **cold publisher subscribed twice**.

1. **Classify the symptom.** Global latency → event-loop block. Pool errors → WebClient/R2DBC. Empty 200 → swallowed error. Broken traces → context. Only under load → pool/queue.

2. **Check stack first.**

   ```yaml
   spring:
     main:
       web-application-type: reactive
   ```

   Confirm not accidental servlet. `curl -I` look for `Server` header.

3. **Thread dump** (jcmd / Actuator threaddump). Search `reactor-http-nio`, `jdbc`, `boundedElastic`. Count blocked threads per loop.

4. **Enable BlockHound in staging** for regression tests.

5. **Reactor Netty metrics** — pending acquisitions, connections active, bytes throughput.

6. **Trace one slow request** — if span breaks at `publishOn`, fix context propagation.

7. **WebClient wiretap** in staging only; never log bodies with PII in prod.

8. **Review `flatMap` concurrency** and R2DBC pool size alignment (`pool max-size ≈ expected concurrent queries per instance`).

9. **Gateway vs direct** — reproduce without Gateway to isolate strip-prefix / timeout.

10. **Rollback lever** — MVC + virtual threads for CRUD services if reactive never achieved end-to-end.

Turn DEBUG/TRACE off after incident — reactive logs are voluminous.

---

## 22. Quick Decision Matrix

| Situation | Do this |
|---|---|
| New CRUD API, team knows JPA | MVC + virtual threads (Boot 3.2+), not WebFlux |
| High-concurrency SSE/WebSocket | WebFlux + tuned Netty; disable proxy buffering |
| Orchestrate many HTTP downstream calls | WebFlux + shared `WebClient` pool + concurrency limits |
| Relational DB, no R2DBC driver | Don't adopt WebFlux for that service |
| Migration from MVC "for perf" | Profile first; prove blocking boundaries |
| Blocking library unavoidable | `boundedElastic` sparingly + bulkhead; plan exit |
| JWT resource server | `SecurityWebFilterChain` + `ReactiveSecurityContextHolder` |
| Need ThreadLocal MDC/trace | `context-propagation` + OTel bridge |
| Large export | Streaming `Flux`, never `collectList` |
| POST retry from client | Idempotency keys, not blind `retry()` |
| Gateway + WebFlux service | Align paths, timeouts, SSE heartbeats |
| Tests for reactive code | `StepVerifier` + `WebTestClient`, not only mocks |
| Elastic queue growing | Stop adding `subscribeOn`; fix data layer |
| Dual `starter-web` + webflux | Pick `web-application-type` explicitly |

---

## Scenario-Based Questions

### 1. Your team migrated a Spring MVC app to WebFlux but kept Spring Data JPA. Load tests show worse p99 latency. What happened?

**Answer.** JPA is blocking. Wrapping repositories in `Mono.fromCallable` without isolating threads blocks Netty event-loop threads, or forces everything through `boundedElastic` — a thread-pool server with extra overhead. WebFlux only wins when the I/O chain is non-blocking end-to-end (R2DBC, reactive Mongo) or when workloads are I/O-multiplexed streaming. The fix is either migrate data access to R2DBC, use MVC + virtual threads, or accept elastic pooling with strict bulkheads while planning migration.

### 2. A `WebClient` call works in unit tests but production throws `DataBufferLimitException`. Why?

**Answer.** Default in-memory codec limit is 256KB. Large JSON responses exceed `maxInMemorySize`. Tests used small payloads. Fix: raise `ExchangeStrategies` codec limit for that client, or stream with `bodyToFlux` for huge payloads, or paginate downstream.

### 3. `ReactiveSecurityContextHolder.getContext()` is empty inside a `@Service` method called from a controller. The controller path is secured. What went wrong?

**Answer.** Likely `publishOn`/`subscribeOn` hop without context propagation, or the service is invoked from a thread not downstream of security filters (e.g. manual `subscribe()` in a scheduler). Use `contextWrite(ReactiveSecurityContextHolder.withAuthentication(...))` where needed, enable Micrometer context propagation, avoid reading `SecurityContextHolder` ThreadLocal in WebFlux.

### 4. Two subscribers to the same `Mono` built from a `WebClient` GET cause duplicate downstream HTTP calls. Is that expected?

**Answer.** Yes — cold publishers re-run per subscriber unless cached or shared. Use `.cache()`, `.transformDeferred`, or restructure to a single subscription with `flatMap`. This is a frequent production surprise when combining `doOnNext` logging with returning the same `Mono`.

### 5. Gateway returns 504 for SSE but direct pod access works. List three causes.

**Answer.** (1) Gateway/http proxy response timeout shorter than stream lifetime. (2) Proxy buffering batches events until buffer fills. (3) Missing heartbeat — idle connection closed by load balancer. Fix route-specific timeouts, disable buffering (`X-Accel-Buffering: no`), send periodic SSE comments or ping.

### 6. `flatMap(id -> repo.findById(id))` over 50,000 IDs killed the database. How do you fix without abandoning reactive?

**Answer.** Cap concurrency: `flatMap(id -> repo.findById(id), 8)` aligned with R2DBC pool `max-size`. Better: batch query `WHERE id IN (...)` in chunks, or server-side cursor. Never unbounded `flatMap` on per-row network calls.

### 7. When is `Schedulers.boundedElastic()` appropriate in WebFlux?

**Answer.** Short, bounded blocking that cannot yet be removed — legacy JDBC snippet, file read, blocking API — with explicit timeout and monitoring. Not as the default for every repository call. If most handlers need it, the architecture is wrong for WebFlux.

### 8. Explain cold vs hot `Flux` in the context of a live dashboard feeding 1,000 browser tabs.

**Answer.** Cold: each tab's subscription triggers a new upstream source (disastrous — 1,000 DB queries). Hot: single shared source multicasted via `publish().refCount()` or `Sinks.Many` fed by one DB poll pushes to all subscribers. Choose hot with backpressure strategy (buffer/drop/latest) based on SLA.

### 9. A junior adds `.block()` in a `WebFilter` to read the JWT claim synchronously. What breaks?

**Answer.** `WebFilter` runs on event-loop threads. `block()` stalls that loop, delaying all connections handled by it — not just one request. Symptoms: correlated latency spikes, low CPU, few threads blocked in dump. Fix: rewrite filter reactively `chain.filter(exchange).contextWrite(...)` or use resource server JWT support.

### 10. How do you test a `Flux` that uses `delayElements` without slow CI?

**Answer.** `StepVerifier.withVirtualTime(() -> flux).thenAwait(Duration.ofMinutes(1)).expectNext(...).verifyComplete()`. Virtual time advances the scheduler without sleeping.

### 11. R2DBC connection pool exhausted while DB shows few active connections. What reactive anti-pattern causes this?

**Answer.** Holding a connection across non-DB work in a transactional/reactive chain — e.g. `findById` then long `WebClient` call inside the same transaction before `commit`. Connection returned only after chain completes. Fix: shorten transactions; fetch data then release; then call WebClient.

### 12. Should you use RouterFunctions or `@RestController` for a public REST API with OpenAPI requirements?

**Answer.** `@RestController` unless team strongly prefers functional style — springdoc OpenAPI, validation, and method security are smoother. RouterFunctions excel for gateway-style routing, simple proxies, or when composing routes programmatically. Mixed styles OK across modules, not on same paths.

### 13. Boot 3.2 offers virtual threads. Your WebFlux service uses `boundedElastic` for all JPA calls. What do you recommend?

**Answer.** Re-evaluate stack choice. The service is servlet-style blocking with reactive tax. Pilot servlet + virtual threads + JPA on a branch; compare p99, CPU, dev velocity. Likely outcome: revert CRUD services to MVC; keep WebFlux for true streaming/orchestration services.

### 14. Client reports intermittent empty JSON `{}` with HTTP 200 on errors. Where do you look?

**Answer.** Search `onErrorResume(e -> Mono.empty())`, `switchIfEmpty(Mono.just(default))` masking failures, or `@ControllerAdvice` not handling reactive errors. Add metrics on error signals; ensure `ProblemDetail` responses for failures.

### 15. How does backpressure propagate from a slow HTTP client reading SSE to an R2DBC `Flux` query?

**Answer.** Slow TCP write → Netty writability → `Flux` demand reduced via Reactive Streams `request`. R2DBC driver fetches fewer rows. If someone inserted `publishOn` with large prefetch or `onBackpressureBuffer`, backpressure breaks and memory grows. Audit operator chain.

### 16. What is wrong with creating `WebClient.create()` per request in a `@Component`?

**Answer.** No connection pooling; new TCP connections each time; TLS handshake overhead; risk of ephemeral port exhaustion. Use a single bean `WebClient` with shared `ConnectionProvider`.

### 17. WebSocket connections drop at exactly 60 seconds behind ALB. Fix?

**Answer.** ALB idle timeout default 60s. Send WebSocket ping frames or application heartbeat every <60s. May also need to increase ALB idle timeout for long-lived connections.

### 18. `StepVerifier` passes but `WebTestClient` fails with 404. Why?

**Answer.** Slice test doesn't load `RouterFunction` or security `pathMatchers`. Controller not in `@WebFluxTest` slice. Context path / gateway prefix not applied in test. Import missing config beans.

### 19. How do you implement idempotent POST in WebFlux?

**Answer.** Client sends `Idempotency-Key` header. Store key → result in Redis/DB with TTL. `flatMap` claim key atomically; if already processed return cached response; else execute `save` once. Do not rely on Reactor `retry()` alone.

### 20. Name four signals in a thread dump that indicate WebFlux is misused as blocking MVC.

**Answer.** (1) `reactor-http-nio-*` blocked in `java.sql` or `SocketInputStream.read`. (2) Large `boundedElastic` queue in heap. (3) Many threads in `jdbc` pool waiting while event loops idle. (4) `block()` in stack frames on netty event loop (BlockHound).

### 21. Your `@Scheduled` job returns `Mono<Void>` from a reactive repository but data never updates. Why?

**Answer.** Spring's scheduler invoked the method but nothing subscribed to the returned `Mono`. Unlike MVC controllers, scheduled methods are not auto-subscribed. Fix: return `void` and call `.subscribe()` explicitly with error handler, use `Schedulers.boundedElastic()` inside, or switch to `ApplicationRunner` / `CommandLineRunner` with explicit subscription and metrics on failure.

### 22. Actuator `/health` shows UP but all API calls hang. What WebFlux-specific cause do you check?

**Answer.** All event-loop threads blocked — health endpoint may run on separate management port/thread and still pass. Thread dump `reactor-http-nio-*` blocked. Often JDBC `block()` in a filter or shared initialization. BlockHound history or recent deploy adding synchronous call in `WebFilter`.

### 23. How do you propagate a tenant ID from `X-Tenant-Id` header through a `WebClient` call to a downstream service in WebFlux?

**Answer.** Read header in `WebFilter`, `contextWrite(Context.of("tenantId", value))`. In service, `Mono.deferContextual(ctx -> ...)`. WebClient filter: `Mono.deferContextual(ctx -> ClientRequest.from(req).header("X-Tenant-Id", ctx.get("tenantId")).build())`. Do not use `ThreadLocal`. Enable context propagation for tracing alignment.

### 24. `ResponseEntity<Mono<Order>>` vs `Mono<ResponseEntity<Order>>` — which do you return and why?

**Answer.** Prefer `Mono<ResponseEntity<Order>>` — status and headers are decided inside the reactive chain (e.g. `switchIfEmpty` → 404). `ResponseEntity<Mono<Order>>` works but defers status selection until subscribe and confuses exception handlers. For streaming, `Mono<ResponseEntity<Flux<Order>>>` with `body(flux, Order.class)`.

### 25. Production metric: `reactor.netty.connection.provider.pending.connections` steadily increasing. Interpret and act.

**Answer.** More requests waiting for a connection than the pool can grant — pool too small, slow downstream holding connections, or connection leak (body not consumed). Increase pool only after ruling out leak; cap `flatMap` concurrency; set `pendingAcquireTimeout` to fail fast; alert on metric before clients see multi-minute hangs.

---

*WebFlux rewards end-to-end non-blocking design. It punishes blocking shortcuts louder than servlet stacks ever did — because one blocked event-loop thread hurts hundreds of connections. Pick the stack on evidence, instrument pools and schedulers, and treat every `subscribeOn(boundedElastic)` as technical debt with an owner.*
