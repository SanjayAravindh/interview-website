# Microservice Service Communication Mastery — Senior Production Reference

Spring Boot 3.x / Spring Cloud 2023.x / Spring Framework 6.x. Servlet stack and reactive (WebFlux) paths are both covered; differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after shipping distributed systems behind API gateways, service meshes, and event buses.

---

## Table of Contents

1. [Mental Model: One Call Through the Mesh](#1-mental-model-one-call-through-the-mesh)
2. [REST APIs in Microservices](#2-rest-apis-in-microservices)
3. [gRPC — Binary, Contract-First RPC](#3-grpc-binary-contract-first-rpc)
4. [OpenFeign — Declarative HTTP Clients](#4-openfeign-declarative-http-clients)
5. [WebClient — Reactive HTTP Client](#5-webclient-reactive-http-client)
6. [Synchronous vs Asynchronous Communication](#6-synchronous-vs-asynchronous-communication)
7. [Service-to-Service Communication Patterns](#7-service-to-service-communication-patterns)
8. [API Composition (Backend for Frontend / Aggregator)](#8-api-composition-backend-for-frontend-aggregator)
9. [Request/Response vs Event-Driven Communication](#9-requestresponse-vs-event-driven-communication)
10. [Webhooks — Outbound HTTP Callbacks](#10-webhooks-outbound-http-callbacks)
11. [Client-side vs Server-side Load Balancing](#11-client-side-vs-server-side-load-balancing)
12. [Request Hedging](#12-request-hedging)
13. [Fan-out / Fan-in Pattern](#13-fan-out-fan-in-pattern)
14. [Resilience: Timeouts, Retries, Circuit Breakers](#14-resilience-timeouts-retries-circuit-breakers)
15. [Observability: Tracing, Metrics, Correlation](#15-observability-tracing-metrics-correlation)
16. [Production Debugging Playbook](#16-production-debugging-playbook)
17. [Quick Decision Matrix](#17-quick-decision-matrix)

---

## 1. Mental Model: One Call Through the Mesh

Microservice communication is not "call another service." It is a **distributed systems problem** where every outbound call is a network hop with independent failure modes: DNS, TLS, connection pool exhaustion, partial partitions, retry storms, and cascading latency. The caller owns the timeout budget whether it uses REST, gRPC, Feign, WebClient, Kafka, or webhooks.

```
User request → API Gateway / BFF
  └─ Order Service (sync REST to Inventory via Feign)
       ├─ Inventory Service (200 OK, 150ms)
       ├─ Payment Service (503, retried ×3, circuit opens)
       └─ publish OrderCreated → Kafka (async, at-least-once)
            └─ Notification Service (consumer, webhook to partner)
                 └─ Partner endpoint (timeout, DLQ after 5 attempts)
```

Three dimensions you must keep distinct:

| Dimension | Question it answers | Typical Spring Boot 3 choice |
|---|---|---|
| **Transport** | How are bytes moved? | HTTP/JSON (REST), HTTP/2 + Protobuf (gRPC), message broker |
| **Interaction style** | Does the caller wait? | Sync (Feign/WebClient blocking), async (WebClient reactive, `@Async`, Kafka) |
| **Coupling** | Who knows about whom? | Point-to-point REST, event-driven pub/sub, API composition via BFF |

A **timeout** means the downstream did not respond in the budget — it might still succeed later (duplicate side effects if you retry POST). A **503** from a load balancer means no healthy backend — retrying blindly amplifies load. A **200 with stale data** from a cache means your composition layer lied — that is a product bug, not a network glitch.

The golden rule: **every synchronous hop consumes the same user-facing latency budget**. Three 200ms calls in series = 600ms minimum before your own logic runs. Fan-out in parallel recovers wall-clock time but multiplies load on downstreams and complicates error aggregation.

---

## 2. REST APIs in Microservices

### Core concept

REST over HTTP/1.1 or HTTP/2 remains the default inter-service protocol in Java shops because it is debuggable with curl, supported by every gateway, and maps cleanly to Spring MVC `@RestController`. In microservices, REST is usually **internal** (service-to-service) or **edge** (public API). Internal REST should still be versioned, authenticated, and idempotent where mutations occur — "internal" is not "trusted."

Resource design for services:

| Pattern | Use when | Example |
|---|---|---|
| Resource-oriented URI | CRUD on entities | `GET /api/v1/orders/{id}` |
| Command-style POST | Non-idempotent actions | `POST /api/v1/orders/{id}/cancel` |
| Sub-resource | Scoped collections | `GET /api/v1/customers/{id}/orders` |
| Hypermedia (HATEOAS) | Public APIs, evolving contracts | `_links.self.href` — rare internally |

### Internal working (Spring Boot 3)

1. `@RestController` methods return DTOs serialized by Jackson (`MappingJackson2HttpMessageConverter`).
2. `RestTemplate` is **deprecated** in Spring Framework 6 / Boot 3 — do not introduce it in new code. Use `RestClient` (Boot 3.2+ blocking) or `WebClient` (reactive/non-blocking).
3. Content negotiation: `Accept: application/json`, `Content-Type: application/json`. Problem Details (`application/problem+json`) for errors — RFC 7807 via `ProblemDetail` in `@ControllerAdvice`.
4. Service discovery resolves hostnames: Eureka, Kubernetes DNS (`http://inventory-service.default.svc.cluster.local`), or static URLs behind a gateway.

**Boot 3.2+ RestClient** (blocking, modern replacement for RestTemplate):

```java
@Configuration
public class RestClientConfig {

    @Bean
    RestClient inventoryRestClient(RestClient.Builder builder) {
        return builder
            .baseUrl("http://inventory-service")
            .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
            .requestInterceptor((request, body, execution) -> {
                // propagate trace context
                Optional.ofNullable(MDC.get("traceId"))
                    .ifPresent(id -> request.getHeaders().set("X-Trace-Id", id));
                return execution.execute(request, body);
            })
            .build();
    }
}

@Service
@RequiredArgsConstructor
public class InventoryGateway {

    private final RestClient inventoryRestClient;

    public StockDto getStock(String sku) {
        return inventoryRestClient.get()
            .uri("/api/v1/stock/{sku}", sku)
            .retrieve()
            .onStatus(HttpStatusCode::is4xxClientError, (req, res) -> {
                if (res.getStatusCode().value() == 404) {
                    throw new StockNotFoundException(sku);
                }
                throw new InventoryClientException(res.getStatusCode());
            })
            .onStatus(HttpStatusCode::is5xxServerError, (req, res) -> {
                throw new InventoryUnavailableException();
            })
            .body(StockDto.class);
    }
}
```

**Controller exposing internal REST:**

```java
@RestController
@RequestMapping("/api/v1/stock")
@RequiredArgsConstructor
public class StockController {

    private final StockService stockService;

    @GetMapping("/{sku}")
    public StockDto getStock(@PathVariable String sku) {
        return stockService.findBySku(sku);
    }

    @PostMapping("/{sku}/reserve")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void reserve(@PathVariable String sku, @Valid @RequestBody ReserveRequest req) {
        stockService.reserve(sku, req.quantity(), req.orderId());
    }
}
```

### Production scenario: POST retry creates double reservation

**Problem.** Order service calls `POST /api/v1/stock/{sku}/reserve` via Feign with a 3-second read timeout. Inventory is slow (GC pause). Client times out and retries. Two reservations exist for one order; oversell in peak traffic.

**Cause.** POST is not idempotent; timeout ≠ failure; no idempotency key.

**Solution.**

```java
// Inventory side — idempotency key header
@PostMapping("/{sku}/reserve")
@ResponseStatus(HttpStatus.NO_CONTENT)
public void reserve(
        @PathVariable String sku,
        @RequestHeader("Idempotency-Key") String idempotencyKey,
        @Valid @RequestBody ReserveRequest req) {
    stockService.reserveIdempotent(sku, idempotencyKey, req);
}

// Order side — stable key per order
@FeignClient(name = "inventory-service")
public interface InventoryClient {
    @PostMapping("/api/v1/stock/{sku}/reserve")
    void reserve(
        @PathVariable String sku,
        @RequestHeader("Idempotency-Key") String idempotencyKey,
        @RequestBody ReserveRequest request);
}

// usage
inventoryClient.reserve(sku, orderId, new ReserveRequest(qty, orderId));
```

Store idempotency key → outcome in Redis or DB with TTL. Return same 204 on replay.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No timeout on HTTP client | Threads pile up; cascading outage when downstream hangs |
| Shared DTOs as Maven dependency between all services | Every schema change redeploys 12 services |
| `GET` with side effects | Caches and retries corrupt state |
| 200 OK with `{ "error": "..." }` body | Client treats as success; monitoring misses failures |
| Missing `Content-Type` on POST | 415 or silent parse failures |
| Giant payloads (full order graph) | Latency spikes, OOM on mobile clients |
| Internal REST without auth ("it's in the VPC") | Lateral movement after one compromised pod |

### Debugging scenario

**Observe.** Order service logs `Connection reset` calling inventory intermittently.

**Diagnose.**

```yaml
logging.level.org.springframework.web.client=DEBUG
logging.level.reactor.netty.http.client=DEBUG  # if WebClient
```

Check: connection pool max (default too low under burst), keep-alive vs LB idle timeout (LB closes at 60s, client reuses dead socket → reset), DNS TTL vs pod churn in Kubernetes.

**Fix.** Align idle timeout with LB; tune pool:

```yaml
spring.cloud.openfeign.httpclient.max-connections: 200
spring.cloud.openfeign.httpclient.max-connections-per-route: 50
```

For WebClient / Reactor Netty:

```java
ConnectionProvider provider = ConnectionProvider.builder("inventory")
    .maxConnections(200)
    .pendingAcquireTimeout(Duration.ofSeconds(5))
    .build();
HttpClient httpClient = HttpClient.create(provider)
    .responseTimeout(Duration.ofSeconds(3));
```

---

## 3. gRPC — Binary, Contract-First RPC

### Core concept

gRPC uses HTTP/2, Protocol Buffers (protobuf) for serialization, and `.proto` files as the contract. It is **strongly typed**, supports streaming (unary, server, client, bidirectional), and typically beats JSON REST on latency and payload size for internal east-west traffic. Trade-offs: browser support requires grpc-web + proxy; debugging needs grpcurl or specialized tooling; load balancers must understand HTTP/2 long-lived connections.

```
Client stub (generated)                Server (generated base class)
     │                                        │
     ├─ unary RPC ───────────────────────────►│ InventoryService.Reserve()
     ├─ server streaming ◄────────────────────│ StreamStockUpdates()
     └─ bidi streaming ◄─────────────────────►│ SyncCatalog()
```

### Internal working (Spring Boot 3 + grpc-spring-boot-starter)

Spring Boot does not ship first-class gRPC server support in core; production teams use **grpc-spring-boot-starter** (net.devh) or **Armeria**, or run gRPC alongside servlet on a separate port.

**Proto contract:**

```protobuf
syntax = "proto3";

option java_multiple_files = true;
option java_package = "com.example.inventory.grpc";

service InventoryService {
  rpc GetStock(GetStockRequest) returns (StockResponse);
  rpc ReserveStock(ReserveStockRequest) returns (ReserveStockResponse);
  rpc StreamStockChanges(StockWatchRequest) returns (stream StockResponse);
}

message GetStockRequest {
  string sku = 1;
}

message StockResponse {
  string sku = 1;
  int32 available = 2;
  int64 version = 3;
}

message ReserveStockRequest {
  string sku = 1;
  int32 quantity = 2;
  string order_id = 3;
  string idempotency_key = 4;
}

message ReserveStockResponse {
  bool success = 1;
  string reservation_id = 2;
}
```

**Server implementation:**

```java
@GrpcService
@RequiredArgsConstructor
public class InventoryGrpcService extends InventoryServiceGrpc.InventoryServiceImplBase {

    private final StockService stockService;

    @Override
    public void getStock(GetStockRequest request, StreamObserver<StockResponse> responseObserver) {
        try {
            Stock stock = stockService.findBySku(request.getSku());
            responseObserver.onNext(StockResponse.newBuilder()
                .setSku(stock.getSku())
                .setAvailable(stock.getAvailable())
                .setVersion(stock.getVersion())
                .build());
            responseObserver.onCompleted();
        } catch (StockNotFoundException e) {
            responseObserver.onError(Status.NOT_FOUND
                .withDescription("SKU not found: " + request.getSku())
                .asRuntimeException());
        }
    }

    @Override
    public void reserveStock(ReserveStockRequest request, StreamObserver<ReserveStockResponse> responseObserver) {
        var result = stockService.reserveIdempotent(
            request.getSku(),
            request.getIdempotencyKey(),
            request.getQuantity(),
            request.getOrderId());
        responseObserver.onNext(ReserveStockResponse.newBuilder()
            .setSuccess(result.success())
            .setReservationId(result.reservationId())
            .build());
        responseObserver.onCompleted();
    }
}
```

**Client (blocking stub with deadline):**

```java
@Configuration
public class GrpcClientConfig {

    @Bean
    ManagedChannel inventoryChannel() {
        return ManagedChannelBuilder
            .forTarget("dns:///inventory-service:9090")
            .defaultLoadBalancingPolicy("round_robin")
            .usePlaintext() // TLS in prod — see below
            .build();
    }

    @Bean
    InventoryServiceGrpc.InventoryServiceBlockingStub inventoryStub(ManagedChannel channel) {
        return InventoryServiceGrpc.newBlockingStub(channel);
    }
}

@Service
@RequiredArgsConstructor
public class GrpcInventoryGateway {

    private final InventoryServiceGrpc.InventoryServiceBlockingStub stub;

    public StockResponse getStock(String sku) {
        return stub
            .withDeadlineAfter(2, TimeUnit.SECONDS)
            .getStock(GetStockRequest.newBuilder().setSku(sku).build());
    }
}
```

**TLS in production:**

```java
ManagedChannelBuilder.forAddress("inventory-service", 9090)
    .sslContext(GrpcSslContexts.forClient().trustManager(trustCert).build())
    .overrideAuthority("inventory-service.internal")
    .build();
```

### Production scenario: HTTP/2 connection stuck behind naive LB

**Problem.** gRPC works in dev (direct pod IP). In prod through AWS CLB (classic) or misconfigured nginx, requests hang or fail with `UNAVAILABLE`.

**Cause.** Classic L4 LB or HTTP/1.1-only proxy breaks HTTP/2 multiplexing; long-lived connections stick to dead pods.

**Solution.** Use L7 HTTP/2-aware LB (ALB with gRPC, nginx `grpc_pass`, Istio/Linkerd). Enable client-side load balancing with `dns:///service-name` and `round_robin` policy, or use **xDS** / service mesh. Set max connection age on server to force periodic reconnect for DNS refresh.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No deadline on stub | Hung threads forever (blocking stub) |
| Breaking proto field renumbering | Silent data corruption across versions |
| Removing required fields without `reserved` | Wire incompatibility |
| Blocking stub on Netty event loop | Deadlock in reactive gateway |
| Plaintext gRPC in prod | Compliance failure, MITM risk |
| Giant messages without max size config | OOM; default 4MB may be too small or too large |

### Debugging scenario

**Observe.** `DEADLINE_EXCEEDED` spikes during deploys.

**Diagnose.** grpcurl from a debug pod:

```bash
grpcurl -plaintext inventory-service:9090 list
grpcurl -plaintext -d '{"sku":"ABC"}' inventory-service:9090 inventory.InventoryService/GetStock
```

Check server logs for slow handlers; verify deadline budget < client timeout; ensure rolling deploy uses readiness probe that drains gRPC.

**Fix.** Propagate deadline from incoming metadata; use server interceptors:

```java
@GrpcGlobalServerInterceptor
public class DeadlineInterceptor implements ServerInterceptor {
    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {
        Deadline deadline = Context.current().getDeadline();
        if (deadline != null && deadline.isExpired()) {
            call.close(Status.DEADLINE_EXCEEDED.withDescription("Deadline expired before handler"), new Metadata());
            return new ServerCall.Listener<>() {};
        }
        return next.startCall(call, headers);
    }
}
```

---

## 4. OpenFeign — Declarative HTTP Clients

### Core concept

OpenFeign (Spring Cloud) turns an interface + annotations into an HTTP client implementation at runtime. It integrates with **LoadBalancer** (client-side LB), **Resilience4j** circuit breakers, request interceptors (auth, tracing), and error decoders. It is **synchronous and blocking** — one thread per outbound call unless you wrap it in `@Async` (which just moves the blocking elsewhere).

```
@FeignClient("inventory-service")
     │
     ▼
Feign.Builder → LoadBalancerFeignClient → Apache HttpClient / OkHttp
     │                    │
     │                    └─ ServiceInstanceListSupplier (Eureka, K8s discovery)
     └─ Encoder/Decoder (Spring Cloud OpenFeign uses Spring message converters)
```

### Internal working (Spring Boot 3)

Dependency:

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-openfeign</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-loadbalancer</artifactId>
</dependency>
```

Enable and define client:

```java
@SpringBootApplication
@EnableFeignClients
public class OrderApplication { }

@FeignClient(
    name = "inventory-service",
    configuration = InventoryFeignConfig.class,
    fallbackFactory = InventoryClientFallbackFactory.class
)
public interface InventoryClient {

    @GetMapping("/api/v1/stock/{sku}")
    StockDto getStock(@PathVariable("sku") String sku);

    @PostMapping("/api/v1/stock/{sku}/reserve")
    void reserve(
        @PathVariable("sku") String sku,
        @RequestHeader("Idempotency-Key") String idempotencyKey,
        @RequestBody ReserveRequest request);
}
```

**Per-client configuration:**

```java
@Configuration
public class InventoryFeignConfig {

    @Bean
    Logger.Level feignLoggerLevel() {
        return Logger.Level.BASIC; // FULL only in dev — logs bodies
    }

    @Bean
    RequestInterceptor traceAndAuthInterceptor() {
        return template -> {
            Optional.ofNullable(MDC.get("traceId"))
                .ifPresent(id -> template.header("X-Trace-Id", id));
            // OAuth2 client credentials for service-to-service
            template.header(HttpHeaders.AUTHORIZATION, "Bearer " + tokenProvider.getToken());
        };
    }

    @Bean
    ErrorDecoder inventoryErrorDecoder() {
        return (methodKey, response) -> {
            if (response.status() == 404) {
                return new StockNotFoundException("Not found");
            }
            if (response.status() >= 500) {
                return new InventoryUnavailableException("Inventory down");
            }
            return new Default().decode(methodKey, response);
        };
    }
}
```

**application.yml:**

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            connectTimeout: 2000
            readTimeout: 3000
            loggerLevel: basic
          inventory-service:
            readTimeout: 5000
      circuitbreaker:
        enabled: true  # Resilience4j integration

resilience4j:
  circuitbreaker:
    instances:
      inventory-service:
        slidingWindowSize: 50
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
  timelimiter:
    instances:
      inventory-service:
        timeoutDuration: 4s
```

**Fallback factory (preferred over raw fallback — access to cause):**

```java
@Component
public class InventoryClientFallbackFactory implements FallbackFactory<InventoryClient> {

    @Override
    public InventoryClient create(Throwable cause) {
        return new InventoryClient() {
            @Override
            public StockDto getStock(String sku) {
                log.warn("Inventory fallback for sku={}, cause={}", sku, cause.toString());
                return new StockDto(sku, 0, "UNKNOWN"); // or throw
            }

            @Override
            public void reserve(String sku, String key, ReserveRequest request) {
                throw new InventoryUnavailableException("Cannot reserve", cause);
            }
        };
    }
}
```

### Production scenario: Feign works locally, 404 in Kubernetes

**Problem.** `@FeignClient("inventory-service")` resolves in IDE via `/etc/hosts`. In cluster, Feign gets `404` or `Connection refused`.

**Cause.** Service name mismatch (K8s Service `inventory-svc` vs Feign name `inventory-service`); wrong port (Feign defaults to 8080, app on 8080 but Service maps 80→8080); context path not in `@GetMapping`.

**Solution.**

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          inventory-service:
            url: http://inventory-service.default.svc.cluster.local:8080  # explicit override if no discovery
```

Or register correctly with discovery:

```yaml
spring:
  application:
    name: inventory-service
  cloud:
    kubernetes:
      discovery:
        enabled: true
```

Ensure Feign path includes context path: `@GetMapping("/inventory/api/v1/stock/{sku}")` if server has `server.servlet.context-path=/inventory`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@FeignClient` on same interface without `contextId` | Bean name collision, wrong config applied |
| FULL logging in prod | PII in logs, I/O overhead |
| Fallback returns fake success on writes | Silent data loss |
| No compression for large JSON | Bandwidth saturation |
| Sharing Feign interface between services | Wrong coupling; use client SDK module owned by provider |
| Circuit breaker on GET without cache | Thundering herd when half-open |

### Debugging scenario

**Observe.** `Read timed out` but inventory metrics show 50ms p99.

**Diagnose.** Enable BASIC logging; check if timeout includes connection acquire from exhausted pool. Thread dump: many threads in `socketRead0` on Feign calls.

**Fix.** Increase pool; reduce fan-out; shorten retry chain; verify timelimiter vs Feign readTimeout alignment (timelimiter must be ≥ readTimeout or it wins first).

---

## 5. WebClient — Reactive HTTP Client

### Core concept

`WebClient` is the non-blocking HTTP client in Spring WebFlux. It runs on Reactor Netty by default, supports streaming, backpressure-aware bodies, and composes naturally with `Mono`/`Flux` pipelines. Use it in **WebFlux services**, **gateway/BFF aggregators**, and **blocking services** only if you accept `block()` at the edges (anti-pattern at scale) or bridge with virtual threads.

```
WebClient.create()
  .get().uri("/stock/{sku}", sku)
  .retrieve()
  .bodyToMono(StockDto.class)
  .timeout(Duration.ofSeconds(2))
  .retryWhen(Retry.backoff(3, Duration.ofMillis(100)).filter(this::is503))
  .onErrorMap(InventoryUnavailableException::new)
```

### Internal working (Spring Boot 3)

**Bean setup with connection pool and observability:**

```java
@Configuration
public class WebClientConfig {

    @Bean
    WebClient inventoryWebClient(WebClient.Builder builder) {
        ConnectionProvider provider = ConnectionProvider.builder("inventory-pool")
            .maxConnections(100)
            .maxIdleTime(Duration.ofSeconds(20))
            .evictInBackground(Duration.ofSeconds(30))
            .build();

        HttpClient httpClient = HttpClient.create(provider)
            .responseTimeout(Duration.ofSeconds(3))
            .doOnConnected(conn -> conn
                .addHandlerLast(new ReadTimeoutHandler(3))
                .addHandlerLast(new WriteTimeoutHandler(3)));

        return builder
            .baseUrl("http://inventory-service:8080")
            .clientConnector(new ReactorClientHttpConnector(httpClient))
            .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
            .filter(ExchangeFilterFunction.ofRequestProcessor(request -> {
                ClientRequest mutated = ClientRequest.from(request)
                    .header("X-Trace-Id", MDC.get("traceId"))
                    .build();
                return Mono.just(mutated);
            }))
            .filter(ExchangeFilterFunction.ofResponseProcessor(response -> {
                if (response.statusCode().is5xxServerError()) {
                    return response.bodyToMono(String.class)
                        .flatMap(body -> Mono.error(new InventoryUnavailableException(body)));
                }
                return Mono.just(response);
            }))
            .build();
    }
}
```

**Service usage — parallel fan-out:**

```java
@Service
@RequiredArgsConstructor
public class OrderEnrichmentService {

    private final WebClient inventoryWebClient;
    private final WebClient pricingWebClient;
    private final WebClient customerWebClient;

    public Mono<EnrichedOrderDto> enrich(OrderDto order) {
        Mono<StockDto> stock = inventoryWebClient.get()
            .uri("/api/v1/stock/{sku}", order.sku())
            .retrieve()
            .bodyToMono(StockDto.class)
            .timeout(Duration.ofSeconds(2))
            .onErrorResume(e -> Mono.just(StockDto.unavailable(order.sku())));

        Mono<PriceDto> price = pricingWebClient.get()
            .uri("/api/v1/prices/{sku}", order.sku())
            .retrieve()
            .bodyToMono(PriceDto.class)
            .timeout(Duration.ofSeconds(2));

        Mono<CustomerDto> customer = customerWebClient.get()
            .uri("/api/v1/customers/{id}", order.customerId())
            .retrieve()
            .bodyToMono(CustomerDto.class)
            .timeout(Duration.ofSeconds(2));

        return Mono.zip(stock, price, customer)
            .map(tuple -> EnrichedOrderDto.of(order, tuple.getT1(), tuple.getT2(), tuple.getT3()));
    }
}
```

**Blocking servlet service (escape hatch with virtual threads — Boot 3.2+):**

```java
@Service
@RequiredArgsConstructor
public class BlockingOrderFacade {

    private final WebClient inventoryWebClient;

    public StockDto getStockBlocking(String sku) {
        return inventoryWebClient.get()
            .uri("/api/v1/stock/{sku}", sku)
            .retrieve()
            .bodyToMono(StockDto.class)
            .block(Duration.ofSeconds(3));
    }
}
```

With `spring.threads.virtual.enabled=true`, blocking in Tomcat worker is less catastrophic — but downstream connection pool limits still apply globally.

### Production scenario: WebClient memory leak on streaming

**Problem.** Service downloads large CSV export from reporting service via `bodyToFlux(DataBuffer.class)`. Heap grows until OOM.

**Cause.** Consumer slower than producer; buffers not released; missing `DataBufferUtils.release`.

**Solution.**

```java
return reportingWebClient.get()
    .uri("/api/v1/reports/{id}/stream", reportId)
    .retrieve()
    .bodyToFlux(DataBuffer.class)
    .map(dataBuffer -> {
        try {
            return parseChunk(dataBuffer);
        } finally {
            DataBufferUtils.release(dataBuffer);
        }
    });
```

Or use `bodyToFlux(String.class)` / `exchangeToFlux` with explicit backpressure. Set max in-memory size:

```java
ExchangeStrategies.builder()
    .codecs(c -> c.defaultCodecs().maxInMemorySize(256 * 1024))
    .build();
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `block()` on reactor event loop thread | `BlockingOperationError` or frozen Netty |
| Default maxInMemorySize 256KB on large JSON | `DataBufferLimitException` |
| One global WebClient for all downstreams | Wrong timeouts; noisy neighbor in pool |
| Retry on POST without idempotency | Duplicate writes |
| No `timeout()` operator | Hung `Mono` never completes |

### Debugging scenario

**Observe.** BFF p99 latency 8s; each downstream p99 is 800ms.

**Diagnose.** Sequential `flatMap` instead of `zip`; accidental `block()` in reactive chain; missing timeout on one leg stalling `Mono.zip`.

**Fix.** Parallelize independent calls; add per-leg timeout; use `Mono.zipDelayError` to collect partial failures.

---

## 6. Synchronous vs Asynchronous Communication

### Core concept

| Style | Caller behavior | Consistency | Failure visibility |
|---|---|---|---|
| **Sync (request/response)** | Waits for response | Immediate read-your-writes (if no cache) | Errors return directly to user |
| **Async (message/event)** | Returns after handoff to broker | Eventual consistency | User may not see failure; needs compensation |

Sync is appropriate when the user **needs the answer now** (checkout total, auth decision). Async is appropriate when work can be **deferred** (send email, rebuild search index, analytics).

### Internal working — sync path

```
OrderController → OrderService → Feign/WebClient → InventoryService
                      │                                      │
                      └──────── same HTTP transaction ───────┘
User waits for entire chain.
```

Thread held for full duration in blocking stack. Budget: if gateway timeout is 30s and you chain 5 services each allowed 10s read timeout, you will hit gateway first — or worse, succeed at gateway while client disconnected.

### Internal working — async path

```
OrderService → KafkaTemplate.send("order-created", event) → returns 202
                      │
                      └─► NotificationService @KafkaListener → send email
                      └─► AnalyticsService @KafkaListener → warehouse insert
```

Spring Kafka producer:

```java
@Service
@RequiredArgsConstructor
public class OrderEventPublisher {

    private final KafkaTemplate<String, OrderCreatedEvent> kafkaTemplate;

    public CompletableFuture<SendResult<String, OrderCreatedEvent>> publish(OrderCreatedEvent event) {
        return kafkaTemplate.send("order-events", event.orderId(), event);
    }
}

@Component
@RequiredArgsConstructor
@Slf4j
public class OrderCreatedListener {

    @KafkaListener(topics = "order-events", groupId = "notification-service")
    public void onOrderCreated(
            @Payload OrderCreatedEvent event,
            @Header(KafkaHeaders.RECEIVED_KEY) String key,
            Acknowledgment ack) {
        try {
            notificationService.sendConfirmation(event);
            ack.acknowledge();
        } catch (Exception e) {
            log.error("Failed processing order {}", key, e);
            // do not ack — retry or route to DLQ via ErrorHandler
            throw e;
        }
    }
}
```

**Outbox pattern (avoid dual-write):**

```java
@Transactional
public Order createOrder(CreateOrderCommand cmd) {
    Order order = orderRepository.save(Order.from(cmd));
    outboxRepository.save(OutboxEvent.orderCreated(order)); // same DB transaction
    return order;
}

// separate poller or Debezium CDC publishes outbox → Kafka
```

### Production scenario: "async" but still blocking the user

**Problem.** API returns 200 after publishing to Kafka, but consumer failure means email never sent. Support tickets: "I never got confirmation."

**Cause.** Fire-and-forget without monitoring consumer lag, DLQ, or user-visible status.

**Solution.** Return `202 Accepted` with `statusUrl`; track saga state; alert on consumer lag > threshold; dead-letter topic with replay tooling.

```java
@PostMapping("/orders")
@ResponseStatus(HttpStatus.ACCEPTED)
public OrderAcceptedResponse create(@RequestBody CreateOrderRequest req) {
    String orderId = orderService.acceptOrder(req);
    return new OrderAcceptedResponse(orderId, "/api/v1/orders/" + orderId + "/status");
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Sync chain > 5 hops for user request | Latency SLO impossible |
| Async without idempotent consumers | Duplicate side effects on redelivery |
| `@Async` on Feign for "parallelism" | Thread pool explosion; harder debugging |
| Kafka auto-commit before processing | Message loss on crash |
| No outbox — DB commit then Kafka fail | Inconsistent state |

### Debugging scenario

**Observe.** User sees timeout but order exists in DB.

**Diagnose.** Upstream timeout shorter than downstream; client retried POST without idempotency; async notification still pending.

**Fix.** Align timeouts; idempotency keys; expose order status; don't rely on sync email in checkout response.

---

## 7. Service-to-Service Communication Patterns

### Core concept

Patterns describe **topology and responsibility**, not a specific library.

| Pattern | Description | Spring Boot manifestation |
|---|---|---|
| **Point-to-point sync** | A calls B directly | Feign, WebClient, gRPC stub |
| **API Gateway** | Single entry, routing, cross-cutting | Spring Cloud Gateway |
| **BFF (Backend for Frontend)** | Per-client aggregation | Dedicated Boot app with WebClient |
| **Aggregator** | Combines multiple services for one response | BFF or domain service with fan-out |
| **Choreography** | Services react to events without central coordinator | Kafka + `@KafkaListener` |
| **Orchestration** | Central service drives saga steps | `@Transactional` saga coordinator + commands |
| **CQRS** | Separate read/write models | Write service + read projector from events |
| **Strangler fig** | Gradual migration | Gateway routes old vs new |

### Orchestration saga example

```java
@Service
@RequiredArgsConstructor
public class OrderSagaOrchestrator {

    private final InventoryClient inventoryClient;
    private final PaymentClient paymentClient;
    private final ShippingClient shippingClient;
    private final SagaStateRepository sagaRepo;

    @Transactional
    public void execute(String sagaId, CreateOrderCommand cmd) {
        SagaState state = sagaRepo.findById(sagaId).orElseThrow();

        try {
            switch (state.getStep()) {
                case RESERVE_INVENTORY -> {
                    inventoryClient.reserve(cmd.sku(), sagaId, new ReserveRequest(cmd.qty(), sagaId));
                    state.advance(SagaStep.CHARGE_PAYMENT);
                    sagaRepo.save(state);
                    chargePayment(sagaId, cmd);
                }
                case CHARGE_PAYMENT -> chargePayment(sagaId, cmd);
                case CREATE_SHIPMENT -> createShipment(sagaId, cmd);
                default -> throw new IllegalStateException(state.getStep().name());
            }
        } catch (Exception e) {
            compensate(sagaId, state);
            throw e;
        }
    }

    private void compensate(String sagaId, SagaState state) {
        if (state.getStep().ordinal() >= SagaStep.CHARGE_PAYMENT.ordinal()) {
            paymentClient.refund(sagaId);
        }
        if (state.getStep().ordinal() >= SagaStep.RESERVE_INVENTORY.ordinal()) {
            inventoryClient.release(sagaId);
        }
        state.markFailed();
        sagaRepo.save(state);
    }
}
```

### Production scenario: choreography without correlation ID

**Problem.** Payment refunded twice during rollback; inventory released once.

**Cause.** Each service listens to events but duplicate `OrderCancelled` events; no idempotent saga step tracking.

**Solution.** Saga ID in every message; idempotent step table; single writer for compensation decisions (orchestrator) or deterministic idempotent handlers:

```java
@KafkaListener(topics = "order-cancelled")
public void onCancel(OrderCancelledEvent event) {
    if (processedEvents.exists(event.eventId())) return;
    paymentService.refundIdempotent(event.orderId(), event.eventId());
    processedEvents.mark(event.eventId());
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Every service calls every other service | Mesh of N² dependencies |
| Gateway contains business logic | Un deployable monolith at the edge |
| Saga without compensation | Orphan reservations, ghost payments |
| Shared database between services | Distributed monolith |

---

## 8. API Composition (Backend for Frontend / Aggregator)

### Core concept

API composition gathers data from multiple services into **one response** tailored to a client (mobile, web, partner). The BFF owns fan-out, field shaping, and partial failure policy — not core domain invariants (those stay in domain services).

```
Mobile BFF                    Web BFF
    │                             │
    ├─► Order Service             ├─► Order Service
    ├─► Product Service (lite)    ├─► Product Service (full)
    └─► Recommendations           └─► Reviews Service
```

### Internal working — Spring Cloud Gateway + WebClient (reactive BFF)

```java
@RestController
@RequestMapping("/mobile/v1/orders")
@RequiredArgsConstructor
public class MobileOrderBffController {

    private final OrderCompositionService compositionService;

    @GetMapping("/{orderId}")
    public Mono<MobileOrderView> getOrder(@PathVariable String orderId) {
        return compositionService.composeMobileOrder(orderId);
    }
}

@Service
@RequiredArgsConstructor
public class OrderCompositionService {

    private final WebClient orderClient;
    private final WebClient productClient;
    private final WebClient shippingClient;

    public Mono<MobileOrderView> composeMobileOrder(String orderId) {
        Mono<OrderDto> order = fetchOrder(orderId);
        return order.flatMap(o ->
            Mono.zip(
                fetchProductSummary(o.productId()),
                fetchShippingStatus(o.shipmentId()).onErrorReturn(ShippingStatus.unknown())
            ).map(tuple -> MobileOrderView.from(o, tuple.getT1(), tuple.getT2()))
        );
    }

    private Mono<OrderDto> fetchOrder(String orderId) {
        return orderClient.get()
            .uri("/api/v1/orders/{id}", orderId)
            .retrieve()
            .bodyToMono(OrderDto.class)
            .timeout(Duration.ofSeconds(2));
    }
    // ...
}
```

**Partial failure policy:**

| Policy | When | User experience |
|---|---|---|
| Fail entire request if core missing | Order not loaded | 404/503 |
| Degrade optional fields | Recommendations down | Order without recs |
| Cached stale for optional | Product image CDN fail | Placeholder image |
| Circuit breaker open | Inventory down | "Stock unavailable" badge |

### Production scenario: BFF becomes the monolith

**Problem.** Mobile BFF has 40 controllers, JPA entities, and scheduled jobs. Deploy weekly; every team blocked.

**Cause.** Business logic drifted into BFF; shared DB added "just for reads."

**Solution.** BFF only orchestrates and maps DTOs; max ~2000 LOC per BFF; split by client surface (mobile vs partner); domain rules stay in services; use GraphQL or dedicated read models only with discipline.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| N+1 downstream calls per item in list | BFF calls product service 50 times for cart |
| No batch APIs on downstream | Latency explosion; ask domain team for `/products?ids=` |
| Same BFF for mobile and admin | Over-fetching PII to mobile |
| Synchronous composition of 10 services | p99 unbounded |

### Debugging scenario

**Observe.** Mobile home screen timeout 30s.

**Diagnose.** Waterfall trace: 15 sequential WebClient calls.

**Fix.** Batch endpoints; parallel `zip`; server-side aggregation in a read service; cache hot product summaries in Redis with TTL.

---

## 9. Request/Response vs Event-Driven Communication

### Core concept

**Request/response (sync):** tight temporal coupling — callee must be up now. **Event-driven:** temporal decoupling — producer publishes fact; consumers process when able.

| Aspect | Request/Response | Event-Driven |
|---|---|---|
| Coupling | Caller knows callee endpoint | Producer knows topic name only |
| Latency to user | Immediate | Deferred |
| Failure | Caller gets error | Consumer retries; producer unaware |
| Ordering | Natural per call | Partition key guarantees per key |
| Debugging | Single trace span tree | Distributed log correlation |

### Event types

| Type | Semantics | Example |
|---|---|---|
| **Event notification** | "Something happened" | `OrderCreated` |
| **Event-carried state transfer** | Event contains data needed by consumer | `CustomerUpdated` with full address |
| **Command message** | Request to do work (async) | `ProcessRefundCommand` on queue |

### Spring Boot 3 event-driven stack

```java
// Producer
record OrderCreatedEvent(String eventId, String orderId, Instant occurredAt, OrderPayload payload) {}

@Service
@RequiredArgsConstructor
public class OrderService {
    private final ApplicationEventPublisher localEvents; // in-process only
    private final KafkaTemplate<String, OrderCreatedEvent> kafka;

    public Order create(CreateOrderCommand cmd) {
        Order order = // persist
        OrderCreatedEvent event = new OrderCreatedEvent(UUID.randomUUID().toString(), order.getId(), Instant.now(), OrderPayload.from(order));
        kafka.send("order-events", order.getId(), event); // key = orderId for ordering
        return order;
    }
}
```

```java
// Consumer with retry + DLQ (Spring Kafka non-blocking retries)
@Configuration
public class KafkaConsumerConfig {

    @Bean
    ConcurrentKafkaListenerContainerFactory<String, OrderCreatedEvent> kafkaListenerContainerFactory(
            ConsumerFactory<String, OrderCreatedEvent> consumerFactory,
            KafkaTemplate<String, OrderCreatedEvent> kafkaTemplate) {
        var factory = new ConcurrentKafkaListenerContainerFactory<String, OrderCreatedEvent>();
        factory.setConsumerFactory(consumerFactory);
        factory.setCommonErrorHandler(new DefaultErrorHandler(
            new DeadLetterPublishingRecoverer(kafkaTemplate,
                (record, ex) -> new TopicPartition(record.topic() + ".DLQ", record.partition())),
            new FixedBackOff(1000L, 3)));
        return factory;
    }
}
```

### Production scenario: ordering violated across partitions

**Problem.** `PaymentCaptured` processed before `OrderCreated` in fulfillment service.

**Cause.** Events on different topics/partitions; no version field; consumers assume order.

**Solution.** Same partition key (`orderId`); saga state machine rejects invalid transitions; include `sequence` and `aggregateVersion` in events:

```java
if (event.aggregateVersion() != state.expectedVersion() + 1) {
    throw new OutOfOrderEventException(event);
}
```

### When to choose which

- **Sync REST/gRPC:** query current state, validate user session, reserve inventory at checkout click.
- **Events:** notify warehouse, update search index, send analytics, cross-boundary integration with external orgs.
- **Hybrid (most real systems):** sync create order + async everything after payment capture.

---

## 10. Webhooks — Outbound HTTP Callbacks

### Core concept

A webhook is **your service calling someone else's URL** when an event occurs (payment provider → your app is inbound; your app → merchant's `https://merchant.com/hooks/order-shipped` is outbound). You are the HTTP client; reliability, signing, and retry policy are your responsibility.

```
Order Service ──► WebhookDispatcher ──► POST https://partner.com/webhooks/shipment
                         │                        │
                         ├─ HMAC signature          └─ 200 OK → mark delivered
                         ├─ retry with backoff
                         └─ DLQ after max attempts
```

### Internal working — Spring Boot 3 outbound webhooks

```java
@Entity
@Table(name = "webhook_subscriptions")
public class WebhookSubscription {
    @Id private UUID id;
    private String tenantId;
    private String targetUrl;
    private String secret; // HMAC key
    private Set<String> eventTypes;
    private boolean active;
}

@Entity
@Table(name = "webhook_deliveries")
public class WebhookDelivery {
    @Id private UUID id;
    private UUID subscriptionId;
    private String eventId;
    private String payload;
    private DeliveryStatus status; // PENDING, SUCCESS, FAILED
    private int attemptCount;
    private Instant nextAttemptAt;
}

@Service
@RequiredArgsConstructor
public class WebhookDispatcher {

    private final WebhookDeliveryRepository deliveryRepo;
    private final WebClient webClient; // generic, full URL per delivery
    private final ObjectMapper objectMapper;

    @Scheduled(fixedDelay = 5000)
    @Transactional
    public void processPendingDeliveries() {
        List<WebhookDelivery> batch = deliveryRepo.findPendingDue(Instant.now(), PageRequest.of(0, 50));
        for (WebhookDelivery d : batch) {
            dispatchOne(d);
        }
    }

    private void dispatchOne(WebhookDelivery delivery) {
        WebhookSubscription sub = // load
        String body = delivery.getPayload();
        String signature = sign(body, sub.getSecret());

        webClient.post()
            .uri(sub.getTargetUrl())
            .header("X-Webhook-Signature", "sha256=" + signature)
            .header("X-Webhook-Id", delivery.getEventId())
            .header("X-Webhook-Timestamp", String.valueOf(Instant.now().getEpochSecond()))
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(body)
            .retrieve()
            .toBodilessEntity()
            .timeout(Duration.ofSeconds(10))
            .doOnSuccess(r -> markSuccess(delivery))
            .doOnError(e -> scheduleRetry(delivery, e))
            .subscribe();
    }

    private String sign(String payload, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
```

**Inbound webhook verification (Stripe-style):**

```java
@PostMapping("/webhooks/stripe")
public ResponseEntity<Void> handleStripe(
        @RequestBody String rawBody,
        @RequestHeader("Stripe-Signature") String sigHeader) {
    Event event = Webhook.constructEvent(rawBody, sigHeader, webhookSecret);
    switch (event.getType()) {
        case "payment_intent.succeeded" -> paymentService.onSucceeded(event);
        default -> log.debug("Ignored event {}", event.getType());
    }
    return ResponseEntity.ok().build();
}
```

Always verify signature on **raw body** before JSON parse.

### Production scenario: partner endpoint slow — webhook worker exhausts threads

**Problem.** 10k pending webhooks; `@Async` pool size 8; backlog grows for hours.

**Cause.** Synchronous dispatch in request thread; no rate limit per tenant; partner returns 429.

**Solution.** Persistent queue + scheduled worker; exponential backoff; respect `Retry-After`; circuit breaker per subscription URL; max concurrency per host:

```java
// Resilience4j Bulkhead per domain
Bulkhead bulkhead = Bulkhead.of("partner-example-com", BulkheadConfig.custom()
    .maxConcurrentCalls(5)
    .maxWaitDuration(Duration.ofMillis(500))
    .build());
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No signature verification on inbound | Forged payment events |
| Retry without jitter | Thundering herd on partner recovery |
| Treat 404 as success | Merchant changed URL; events lost silently |
| Webhook in same TX as DB commit | Double send or never send |
| Logging full payload | PII leakage |

---

## 11. Client-side vs Server-side Load Balancing

### Core concept

| Approach | Who picks the instance? | Typical in Spring ecosystem |
|---|---|---|
| **Server-side (L4/L7 LB)** | Load balancer / K8s Service kube-proxy | External ALB, nginx, `ClusterIP` |
| **Client-side** | Client library from service registry | Spring Cloud LoadBalancer + Feign/WebClient |
| **Service mesh (data plane)** | Sidecar proxy (transparent) | Istio, Linkerd — server-side from app's view |

```
Server-side:
  Client → ALB → [Pod1, Pod2, Pod3]

Client-side:
  Client → LoadBalancerFeignClient → picks Pod2 from Eureka/K8s API → Pod2

Mesh:
  Client → sidecar → sidecar → Pod2
```

### Spring Cloud LoadBalancer (client-side)

```java
@Configuration
@LoadBalancerClient(name = "inventory-service", configuration = InventoryLbConfig.class)
public class LbConfig { }

public class InventoryLbConfig {
    @Bean
    ReactorLoadBalancer<ServiceInstance> randomLoadBalancer(
            Environment env,
            LoadBalancerClientFactory factory) {
        String name = env.getProperty(LoadBalancerClientFactory.PROPERTY_NAME);
        return new RoundRobinLoadBalancer(
            factory.getLazyProvider(name, ServiceInstanceListSupplier.class),
            name);
    }
}
```

**WebClient with `@LoadBalanced` RestTemplate-style:**

```java
@Bean
@LoadBalanced
WebClient.Builder loadBalancedWebClientBuilder() {
    return WebClient.builder();
}

// usage: baseUrl http://inventory-service/... resolves via discovery
```

### Production scenario: sticky sessions vs stateless pods

**Problem.** Client-side LB round-robin; cart service stores session in memory; items "disappear."

**Cause.** Stateful service without sticky sessions or shared store.

**Solution.** Redis session store; or server-side sticky cookie on L7 LB; or don't use client-side LB for that service. Spring Session:

```yaml
spring.session.store-type: redis
```

### Production scenario: DNS cache stale pods after scale-down

**Problem.** Client-side gRPC or WebClient keeps connecting to terminated pod IPs.

**Cause.** Long-lived connections; JVM DNS cache TTL; Eureka slow deregistration.

**Solution.** Lower connection TTL; use Spring Cloud Kubernetes with reload; readiness probe deregistration before SIGTERM; preStop hook sleep:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 10"]
```

### Comparison table

| Factor | Client-side | Server-side |
|---|---|---|
| Algorithm control | Per-service custom LB | Central config |
| Connection overhead | Client holds many connections | Pooled at LB |
| Observability | Must instrument client | LB metrics |
| Protocol awareness | App must handle HTTP/2/gRPC | L7 proxy can route on headers |
| Failure detection | Client sees errors; circuit break | Health checks remove bad nodes |

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| Double LB (client-side + ALB) without understanding | Uneven load, connection churn |
| `@LoadBalanced` without discovery starter | Unknown host exceptions |
| Round-robin on warm-cache services | Cache miss storm on every new pod |

---

## 12. Request Hedging

### Core concept

**Request hedging** sends the same request to multiple replicas **after a delay**, using the **first successful response** and canceling losers. It cuts tail latency when variance is high (GC pauses, noisy neighbor). Cost: multiplied load — use sparingly.

```
t=0     send request to replica A
t=500ms if not done, hedge → send to replica B
t=620ms B responds first → cancel A (if possible)
```

Unlike retry-on-failure, hedging starts **before** knowing failure — it bets on slowness.

### When hedging helps vs hurts

| Helps | Hurts |
|---|---|
| Read-only idempotent GET | Non-idempotent POST |
| p99 >> p50 (high variance) | System already saturated |
| Large replica count | Only 2 replicas (doubles load always) |
| User-facing search / metadata | Write paths |

### Implementation sketch (Spring Boot 3 + WebClient)

Not built into Feign; custom reactive logic:

```java
@Service
@RequiredArgsConstructor
public class HedgedInventoryClient {

    private final WebClient inventoryWebClient;
    private static final Duration HEDGE_DELAY = Duration.ofMillis(300);

    public Mono<StockDto> getStockHedged(String sku) {
        Mono<StockDto> primary = fetch(sku, "primary");

        Mono<StockDto> hedged = Mono.delay(HEDGE_DELAY)
            .flatMap(t -> fetch(sku, "hedge"))
            .doOnSubscribe(s -> log.debug("Hedge triggered for sku={}", sku));

        return primary
            .race(hedged) // first signal wins — use Mono.firstWithSignal(primary, hedged) in Reactor 3.5+
            .timeout(Duration.ofSeconds(2));
    }

    private Mono<StockDto> fetch(String sku, String leg) {
        return inventoryWebClient.get()
            .uri("/api/v1/stock/{sku}", sku)
            .header("X-Request-Leg", leg)
            .retrieve()
            .bodyToMono(StockDto.class);
    }
}
```

**Reactor 3.5+ `Mono.firstWithSignal`:**

```java
return Mono.firstWithSignal(
    primary,
    Mono.delay(HEDGE_DELAY).flatMap(d -> hedge)
).timeout(Duration.ofSeconds(2));
```

Cancel propagation: HTTP/1.1 cancel may not stop server work; HTTP/2 stream reset helps. For hedged POST, **do not** — use idempotent GET only.

### Production scenario: hedging during incident doubles outage load

**Problem.** Inventory at 90% CPU; hedging enabled on product page; effective QPS doubles; full outage.

**Cause.** Hedging without capacity headroom and without admission control.

**Solution.** Gate hedging: only if error rate < threshold and CPU < 70%; cap hedge fraction (5% of requests); disable via feature flag during incidents.

```java
if (featureFlags.isEnabled("inventory-hedging") && loadShedder.allowHedge()) {
    return getStockHedged(sku);
}
return getStock(sku);
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Hedge delay < network jitter | Almost always double load |
| Hedge on financial transfer | Double charge without idempotency |
| No cancellation of slow leg | Wasted downstream capacity |
| Same replica picked twice | Client-side LB sticky to one instance — use retry with different instance hint |

---

## 13. Fan-out / Fan-in Pattern

### Core concept

**Fan-out:** one incoming request triggers **parallel** calls to N services. **Fan-in:** merge results into one response (or downstream event). This is the primary latency optimization for BFFs and search aggregators — and the primary load multiplier.

```
         ┌─► Inventory ──┐
BFF ─────┼─► Pricing ────┼─► Fan-in (zip / merge) ──► Response
         └─► Reviews ────┘
```

### Internal working — reactive fan-out/fan-in

```java
public Mono<DashboardDto> buildDashboard(String userId) {
    List<Mono<WidgetDto>> widgets = List.of(
        fetchOrders(userId),
        fetchLoyalty(userId),
        fetchNotifications(userId),
        fetchRecommendations(userId)
    );

    return Flux.mergeSequential(widgets) // or Flux.fromIterable(widgets).flatMap(w -> w) for max parallelism
        .collectList()
        .map(DashboardDto::new);
}

// Better: Mono.zip for fixed set, parallel scheduling
public Mono<DashboardDto> buildDashboardZip(String userId) {
    return Mono.zip(
        fetchOrders(userId).onErrorReturn(WidgetDto.empty("orders")),
        fetchLoyalty(userId).onErrorReturn(WidgetDto.empty("loyalty")),
        fetchNotifications(userId).onErrorReturn(WidgetDto.empty("notifications")),
        fetchRecommendations(userId).onErrorReturn(WidgetDto.empty("recommendations"))
    ).map(t -> new DashboardDto(t.getT1(), t.getT2(), t.getT3(), t.getT4()));
}
```

**Virtual-thread parallel fan-out (Boot 3.2+, blocking clients):**

```java
public DashboardDto buildDashboardBlocking(String userId) throws Exception {
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
        Future<WidgetDto> orders = executor.submit(() -> orderClient.getSummary(userId));
        Future<WidgetDto> loyalty = executor.submit(() -> loyaltyClient.getPoints(userId));
        Future<WidgetDto> notifications = executor.submit(() -> notificationClient.getUnread(userId));
        return new DashboardDto(
            orders.get(2, TimeUnit.SECONDS),
            loyalty.get(2, TimeUnit.SECONDS),
            notifications.get(2, TimeUnit.SECONDS)
        );
    }
}
```

### Fan-out to messaging (scatter-gather async)

```java
public Mono<AggregateReport> gatherReport(String reportId) {
    // scatter
    List<String> shards = shardIds(reportId);
    return Flux.fromIterable(shards)
        .flatMap(shardId ->
            webClient.get()
                .uri("/reports/shard/{id}", shardId)
                .retrieve()
                .bodyToMono(ShardResult.class)
                .timeout(Duration.ofSeconds(5))
        , 10) // max concurrency 10
        .collectList()
        .map(this::mergeShards); // fan-in merge
}
```

### Production scenario: fan-out N+1 in order list

**Problem.** `GET /orders` returns 100 orders; BFF calls `GET /product/{id}` per line item — 1000 HTTP calls.

**Solution.** Batch API `POST /products/batch` with id list; or GraphQL DataLoader pattern; cache product metadata.

```java
@PostMapping("/api/v1/products/batch")
public List<ProductDto> batch(@RequestBody List<String> ids) {
    return productService.findByIds(ids);
}
```

### Error aggregation strategies

| Strategy | Behavior |
|---|---|
| **Fail fast** | Any error fails whole response |
| **Partial success** | Return available widgets + error metadata |
| **Primary + optional** | Core data required; enrichments optional |
| **Fallback cache** | Stale data for failed legs |

```java
public Mono<EnrichedOrder> enrich(Order order) {
    return Mono.zip(
        fetchInventory(order).onErrorResume(e -> Mono.just(InventorySnapshot.unavailable())),
        fetchPricing(order),
        fetchCustomer(order)
    ).flatMap(tuple -> {
        if (tuple.getT2().isEmpty()) {
            return Mono.error(new PricingRequiredException(order.id()));
        }
        return Mono.just(EnrichedOrder.of(order, tuple.getT1(), tuple.getT2().get(), tuple.getT3()));
    });
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Unbounded `flatMap` concurrency | Downstream DDoS from your BFF |
| Fan-in without timeout on slowest leg | Whole response waits for straggler |
| Duplicate fan-out at gateway and BFF | 2× calls |
| Merge without version/conflict rules | Inconsistent aggregated state |

---

## 14. Resilience: Timeouts, Retries, Circuit Breakers

### Core concept

Resilience patterns protect **your** service when **their** service fails. Apply at every outbound boundary.

| Pattern | Purpose | Spring Cloud / Resilience4j |
|---|---|---|
| Timeout | Cap wait time | Feign readTimeout, WebClient `.timeout()`, gRPC deadline |
| Retry | Transient failures | `@Retry`, `Retry.backoff`, Spring Retry |
| Circuit breaker | Stop calling failing dependency | Resilience4j `@CircuitBreaker` |
| Bulkhead | Isolate thread pools | `@Bulkhead` |
| Rate limiter | Protect downstream | `@RateLimiter` |

```java
@CircuitBreaker(name = "inventory", fallbackMethod = "getStockFallback")
@Retry(name = "inventory")
@Bulkhead(name = "inventory")
public StockDto getStock(String sku) {
    return inventoryClient.getStock(sku);
}

public StockDto getStockFallback(String sku, Throwable t) {
    return cache.get(sku).orElse(StockDto.unavailable(sku));
}
```

**Retry only idempotent operations:**

```yaml
resilience4j:
  retry:
    instances:
      inventory-get:
        maxAttempts: 3
        waitDuration: 200ms
        retryExceptions:
          - java.io.IOException
          - org.springframework.web.client.ResourceAccessException
        ignoreExceptions:
          - com.example.StockNotFoundException
```

### Production scenario: retry storm opens circuit everywhere

**Problem.** Inventory blip 5s; all services retry 3× with no jitter; inventory never recovers.

**Solution.** Exponential backoff + jitter; retry budget per service mesh; client-side max concurrency; friendly 429 with `Retry-After`.

---

## 15. Observability: Tracing, Metrics, Correlation

### Core concept

Without correlation IDs, a user complaint spans 12 log files you cannot join.

**Micrometer Tracing + Brave/OTel (Boot 3):**

```xml
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
```

Feign automatically propagates trace headers when on classpath. Manual MDC:

```java
@Bean
public Feign.Builder feignBuilder() {
    return Feign.builder().requestInterceptor(template -> {
        var context = observationRegistry.getCurrentObservationContext();
        // tracer injects b3/W3C traceparent via observation API
    });
}
```

**Metrics to alert on:**

| Metric | Meaning |
|---|---|
| `http.client.requests` p99 by uri | Downstream slow |
| `resilience4j.circuitbreaker.state` | OPEN = dependency hard down |
| `kafka.consumer.lag` | Async pipeline backing up |
| Connection pool pending acquire time | Pool exhaustion incoming |

---

## 16. Production Debugging Playbook

When inter-service behavior is "random," it is usually **timeout mismatch**, **retry duplication**, **wrong service instance**, or **missing trace context**.

1. **Classify the failure layer.** DNS/`UnknownHost` → discovery. `Connection refused` → nothing listening / wrong port. `Connection reset` → idle timeout / dead pod. `Read timed out` → downstream slow or pool wait. `503` → LB or breaker. `200` wrong body → contract drift.

2. **Capture one trace ID** from gateway through all hops. Verify `traceparent` or `X-B3-TraceId` propagates on Feign, WebClient, Kafka headers (`spring.kafka.template.observation-enabled=true`).

3. **Compare timeouts end-to-end.**

   ```
   Gateway: 30s
   BFF WebClient: 10s per leg × zip → max 10s (good)
   Feign readTimeout: 60s (bad — exceeds gateway)
   ```

4. **Check connection pools** on the caller during spike — pending acquire queue length.

5. **For Kafka:** consumer lag, DLQ rate, rebalance storms (session timeout too low), poison message stuck.

6. **For webhooks:** delivery table `attempt_count`, last HTTP status, signature mismatches.

7. **Load balancing:** verify target pod set matches registry; curl pod IP directly vs via service name.

8. **Replay safely** — use idempotency keys; never replay POST in prod without tooling.

9. **Turn off FULL Feign body logging** after debug — PCI/PII incident waiting to happen.

10. **Feature flags** to disable hedging, retries, or optional fan-out legs during incidents.

---

## 17. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Public browser/mobile API | REST/JSON at edge + BFF; OAuth2 at gateway |
| Internal sync, team knows Java + HTTP | REST + OpenFeign or RestClient; strict timeouts |
| Internal sync, high QPS, strict contracts | gRPC + protobuf; deadlines always |
| High fan-out aggregation, I/O bound | WebFlux BFF + WebClient + `Mono.zip` |
| Blocking codebase, moderate concurrency | Servlet + virtual threads + RestClient/Feign |
| Fire-and-forget side effects | Kafka/event + outbox; idempotent consumers |
| Cross-org integration | Webhooks outbound with HMAC + retries; inbound signature verify |
| Read tail latency critical, idempotent GET | Hedging with delay + capacity guardrails |
| Write path between services | Sync with idempotency key; avoid hedging/retry on POST |
| Service discovery on Kubernetes | Spring Cloud K8s discovery or mesh; explicit port |
| Avoid N+1 fan-out | Batch endpoints, caching, GraphQL DataLoader |
| Legacy RestTemplate everywhere | Migrate to RestClient/WebClient in Boot 3 — don't add new RestTemplate |
| Temporal coupling acceptable | Request/response |
| Peak load decoupling | Event-driven + scale consumers independently |
| Load balancing | Server-side LB at edge; client-side optional for advanced routing |
| Debugging prod | Micrometer tracing + structured logs with `traceId`, `orderId` |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Why is RestTemplate deprecated in Spring Boot 3, and what should you use instead?</summary>

RestTemplate blocked threads and aged poorly compared to modern APIs. Spring Framework 6 marks it deprecated. For **blocking** code use **RestClient** (Boot 3.2+) or **OpenFeign** for declarative clients. For **non-blocking** use **WebClient**. RestTemplate remains on classpath for legacy but should not be introduced in new microservice code.

</details>

<details class="qa-item">
<summary>2. When would you choose gRPC over REST between two Java microservices?</summary>

Choose gRPC when you need **lower latency**, **smaller payloads**, **strong contracts** (protobuf), **streaming**, or **high internal QPS** — and when you control both ends plus infrastructure (HTTP/2 LB, TLS). Stick with REST when you need **broad tooling**, **human-debuggable** traffic, **browser clients**, or heterogeneous polyglot teams without proto toolchain maturity.

</details>

<details class="qa-item">
<summary>3. What is the difference between OpenFeign and WebClient?</summary>

OpenFeign is **declarative, synchronous, blocking** — interface + annotations, integrates with LoadBalancer and circuit breakers, one thread per call. WebClient is **programmatic, reactive**, built on Reactor Netty, ideal for parallel I/O and streaming. Feign fits servlet services with simple callouts; WebClient fits BFFs, gateways, and reactive stacks.

</details>

<details class="qa-item">
<summary>4. Explain synchronous vs asynchronous communication in microservices with a checkout example.</summary>

**Sync:** user clicks Pay → order service **calls** payment service and **waits** → success/failure shown immediately. **Async:** after payment captured, order service **publishes** `PaymentCaptured` → email, warehouse, analytics consume **later**. Checkout confirmation needs sync payment; sending receipt email should be async. Mixing them without clear UX (202 + status polling) causes "payment worked but order pending" confusion.

</details>

<details class="qa-item">
<summary>5. What is the outbox pattern and why does it matter?</summary>

Dual-write problem: DB commit succeeds, Kafka publish fails (or vice versa). **Outbox** writes the event to an `outbox` table in the **same DB transaction** as the business row; a separate poller or CDC (Debezium) publishes to Kafka. Guarantees **at-least-once** publication aligned with DB state without 2PC across heterogeneous systems.

</details>

<details class="qa-item">
<summary>6. How do you make a POST retry-safe between services?</summary>

Use an **idempotency key** header (usually derived from business id like `orderId`). Server stores key → result with TTL; duplicate POST returns same response without re-executing side effects. Pair with **timeouts** that don't assume failure means rollback unless compensating saga step runs.

</details>

<details class="qa-item">
<summary>7. What is API composition / BFF, and how is it different from an API Gateway?</summary>

**Gateway** handles cross-cutting ingress: auth, rate limit, routing, TLS termination — minimal business logic. **BFF/composition** **aggregates domain data** for a specific client shape (mobile vs web), fan-out/fan-in, field filtering. Gateway routes `/mobile/**` to Mobile BFF; BFF calls domain services.

</details>

<details class="qa-item">
<summary>8. Client-side vs server-side load balancing — trade-offs?</summary>

**Server-side:** LB picks instance; simpler clients; centralized health checks; connection pooling at LB. **Client-side:** app picks instance from registry (Spring Cloud LoadBalancer); customizable per service; more connections from each client; must handle stale lists and connection draining. **Mesh** sidecars blur the line — app sees localhost, sidecar does LB.

</details>

<details class="qa-item">
<summary>9. What is request hedging and when should you avoid it?</summary>

Hedging sends duplicate requests after a delay, taking the fastest response. Good for **read-only**, high **p99/p50 gap**, spare capacity. Avoid on **writes**, **saturated** systems, **small replica counts**, and non-idempotent operations — it multiplies load and can cause duplicate side effects without careful design.

</details>

<details class="qa-item">
<summary>10. Describe the fan-out / fan-in pattern and a common production mistake.</summary>

Fan-out: one request parallel-calls N services. Fan-in: merge results. **Mistake:** N+1 — listing 100 orders and calling product service per line instead of batch API. Fix with batch endpoints, caching, bounded concurrency (`flatMap(..., 10)`), and per-leg timeouts so one straggler doesn't block zip.

</details>

<details class="qa-item">
<summary>11. Request/response vs event-driven — how do you decide?</summary>

Need **immediate answer** or **strong consistency** for user action → sync REST/gRPC. Can tolerate **eventual consistency**, want **decoupling**, **peak smoothing**, or **multiple subscribers** → events. Events add complexity: ordering, idempotent consumers, DLQ, schema evolution. Most systems use hybrid.

</details>

<details class="qa-item">
<summary>12. How do you secure service-to-service REST in Spring Boot 3?</summary>

Never rely on "private network" alone. Use **OAuth2 client credentials** or **mTLS** (mesh). Propagate or mint tokens in Feign `RequestInterceptor`. Validate JWT in resource server config on every service. Restrict scopes/audiences per caller. Rotate credentials; deny by default in `authorizeHttpRequests`.

</details>

<details class="qa-item">
<summary>13. What happens if Feign readTimeout is longer than the API gateway timeout?</summary>

Gateway returns **504** to client while Feign call **still running** — thread held, possible duplicate client retry, orphaned work downstream. **Fix:** align budgets top-down: gateway > BFF > leaf service, each layer slightly shorter than its caller.

</details>

<details class="qa-item">
<summary>14. How does a circuit breaker help in microservice calls?</summary>

When failure rate exceeds threshold, breaker **opens** — fail fast without calling sick dependency, allowing recovery and protecting caller threads. **Half-open** probes recovery. Use with **fallback** only for safe degradation (cached reads), not fake success on writes. Resilience4j integrates with Spring Cloud OpenFeign in Boot 3.

</details>

<details class="qa-item">
<summary>15. Webhook reliability — what must you implement on the sender side?</summary>

Persist deliveries before send; **HMAC signature**; retry with exponential backoff + jitter; max attempts → DLQ; respect 429/`Retry-After`; idempotency on receiver (`X-Webhook-Id`); timeout; per-host concurrency limits; disable subscription after permanent failures (410/404 policy).

</details>

<details class="qa-item">
<summary>16. How do you propagate trace context across Feign, WebClient, and Kafka?</summary>

Add **Micrometer Tracing** + OTel exporter. Feign/WebClient auto-instrumentation propagates W3C `traceparent`. For Kafka, enable producer/consumer observation (`spring.kafka.listener.observation-enabled=true`) or manually copy trace headers to record headers in `@KafkaListener`. Always log `traceId` in structured JSON.

</details>

<details class="qa-item">
<summary>17. What is the difference between choreography and orchestration in sagas?</summary>

**Orchestration:** central coordinator (order saga service) tells each participant what to do next and runs compensations. **Choreography:** each service reacts to events (`OrderCreated` → reserve, `PaymentFailed` → release). Choreography scales teams but harder to reason about global state; orchestration centralizes logic but can become a god service. Both need **idempotent steps** and **correlation IDs**.

</details>

<details class="qa-item">
<summary>18. Why can gRPC fail behind a traditional HTTP load balancer?</summary>

gRPC requires **HTTP/2** end-to-end. L4 TCP passthrough may work but breaks on TLS termination mismatch. HTTP/1.1-only proxies don't understand gRPC framing. Long-lived HTTP/2 connections stick to pods during rollouts unless **max connection age** and proper draining configured.

</details>

<details class="qa-item">
<summary>19. Virtual threads in Boot 3.2+ — do they replace WebClient for fan-out?</summary>

Virtual threads make **blocking** Feign/RestClient/JDBC **cheaper** on Tomcat — good for teams avoiding reactive complexity. They **don't** remove need for connection pool tuning, timeouts, or backpressure on streaming. WebClient still wins for massive concurrent I/O on few cores when fully reactive end-to-end. Measure; don't assume VT = WebFlux.

</details>

<details class="qa-item">
<summary>20. How do you handle partial failure in a BFF fan-in?</summary>

Define **required vs optional** legs. Use `onErrorReturn` / `Mono.zipDelayError` for optional enrichments. Return **207-like** metadata in JSON (`errors: [{ "source": "reviews", "code": "UNAVAILABLE" }]`) for mobile to render degraded UI. Never fail checkout because recommendations service is down unless product requires it.

</details>

<details class="qa-item">
<summary>21. What is the difference between retry and hedging?</summary>

**Retry** waits for **failure** (exception, 503) then tries again — often same or next instance. **Hedging** starts a **second in-flight request** while first may still succeed — targets **slow** not just failed. Retries increase latency on errors; hedging increases load on happy path tail. Both require idempotency for mutations.

</details>

<details class="qa-item">
<summary>22. How do you version REST APIs between microservices?</summary>

URI versioning (`/v1/`, `/v2/`) is common internally for clarity. Additive changes (new optional fields) are backward compatible. Breaking changes: new version path, run both during migration, consumer-driven contract tests (Spring Cloud Contract). Avoid sharing entity JPA models across services — share **DTO contracts** or OpenAPI specs only.

</details>

<details class="qa-item">
<summary>23. What metrics indicate you should scale consumers, not producers?</summary>

Rising **`kafka.consumer.lag`**, growing DLQ rate, age of oldest unprocessed message, consumer CPU high while producer flat. Scale **consumer replicas** within same `group.id` ( partitions permitting). Scaling producers when lag is consumer-bound worsens backlog.

</details>

<details class="qa-item">
<summary>24. Explain connection pool exhaustion symptoms and fix in Feign/WebClient.</summary>

Symptoms: `ConnectionPoolTimeoutException`, `Pending acquire timeout`, flat CPU but growing request queue, `Read timed out` despite fast downstream. Causes: too few max connections, slow responses holding connections, too many concurrent fan-out calls. Fix: increase pool per route, reduce fan-out concurrency, shorten timeouts, circuit break failing deps, separate WebClient beans per downstream.

</details>

<details class="qa-item">
<summary>25. When is event-carried state transfer better than event notification?</summary>

**Notification** (`OrderCreated` with id only) forces consumers to **callback** for data — reintroduces sync coupling. **State transfer** embeds needed fields so consumer processes offline — better for performance and availability, worse for payload size and schema coupling. Prefer notification + cached read model when data is large or changes often.

</details>

---

*Every outbound call is a liability budget: latency, failure, and load. Pick sync vs async, REST vs gRPC, and fan-out width deliberately — then enforce timeouts, idempotency, and traces so production stays debuggable when the mesh misbehaves.*
