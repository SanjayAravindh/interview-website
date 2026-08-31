# API Design & Evolution Mastery — Senior Production Reference

Spring Boot 3.x / Spring Cloud Gateway 4.x / OpenAPI 3.1. Servlet stack and reactive gateway paths are both covered; differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after shipping public APIs, mobile clients, partner integrations, and internal service meshes behind gateways for years.

---

## Table of Contents

1. [Mental Model: One Request Through the Edge](#1-mental-model-one-request-through-the-edge)
2. [API Versioning Strategies](#2-api-versioning-strategies)
3. [Backward Compatibility — Rules and Violations](#3-backward-compatibility-rules-and-violations)
4. [Breaking vs Non-Breaking Changes](#4-breaking-vs-non-breaking-changes)
5. [Deprecation, Sunset, and Migration](#5-deprecation-sunset-and-migration)
6. [API Gateway Patterns](#6-api-gateway-patterns)
7. [Spring Cloud Gateway — Production Configuration](#7-spring-cloud-gateway-production-configuration)
8. [API Rate Limiting](#8-api-rate-limiting)
9. [Quotas, Throttling, and Fairness](#9-quotas-throttling-and-fairness)
10. [API Documentation — Beyond Swagger UI](#10-api-documentation-beyond-swagger-ui)
11. [OpenAPI / Swagger — Specification and Tooling](#11-openapi-swagger-specification-and-tooling)
12. [Contract Testing and Spec-Driven Development](#12-contract-testing-and-spec-driven-development)
13. [Error Models and Problem Details (RFC 7807)](#13-error-models-and-problem-details-rfc-7807)
14. [Pagination, Filtering, and Field Selection](#14-pagination-filtering-and-field-selection)
15. [Idempotency and Safe Retries at the Edge](#15-idempotency-and-safe-retries-at-the-edge)
16. [Multi-Tenant and Partner API Isolation](#16-multi-tenant-and-partner-api-isolation)
17. [Production Debugging Playbook](#17-production-debugging-playbook)
18. [Quick Decision Matrix](#18-quick-decision-matrix)
19. [Interview Q&A](#19-interview-qa)

---

## 1. Mental Model: One Request Through the Edge

An API is not a controller method. It is a **contract** that outlives any single deploy: mobile apps cached for months, partner batch jobs hard-coded to field names, SDKs generated from OpenAPI, and observability dashboards keyed on status codes and route labels. Versioning, compatibility, gateway routing, rate limits, and documentation are not "nice-to-haves" — they are the **operational surface** where product velocity meets external reality.

```
Client (mobile / partner / browser)
  └─ CDN / WAF (optional)
       └─ API Gateway (Spring Cloud Gateway, Kong, AWS API GW, Envoy)
            ├─ TLS termination
            ├─ Authentication (JWT validate, API key, mTLS)
            ├─ Rate limit / quota (Redis, local bucket, global counter)
            ├─ Route match: /api/v2/orders → order-service
            ├─ StripPrefix / RewritePath / AddRequestHeader
            ├─ Circuit breaker / timeout budget
            └─ Order Service (Spring Boot 3)
                 ├─ @RequestMapping version resolution
                 ├─ Controller → Service → Repository
                 └─ Response DTO (must match published OpenAPI)
```

Three layers you must keep distinct:

| Layer | Question it answers | Typical failure when confused |
|---|---|---|
| **Contract** | What may clients depend on? | Field rename breaks mobile app in prod |
| **Routing** | Which service instance handles this path? | `/v1` traffic hits `/v2` controller after gateway rewrite |
| **Policy** | Who may call how often? | Partner DDoS exhausts DB; no 429, only 503 |

A **404 on a new version** usually means routing or deployment skew — the gateway still points at an old cluster. A **400 with unchanged client** often means **breaking schema change** shipped without version bump. A **429** means rate policy worked; a **503 under steady load** often means **limits missing** or **downstream pool exhausted**. Mixing those diagnoses wastes incident time.

The golden rule: **the gateway owns cross-cutting ingress policy; services own domain correctness; OpenAPI owns the published contract.** When those three disagree, production breaks in ways unit tests never catch.

---

## 2. API Versioning Strategies

### Core concept

API versioning answers: *how do we ship change without breaking existing consumers?* In microservices you version at least **two surfaces**:

| Surface | Who consumes | Version mechanism |
|---|---|---|
| **Public / partner API** | Mobile, web SPA, third parties | URI `/v1`, header, or content negotiation |
| **Internal service API** | Other microservices | URI or package-level (`com.example.orders.v2`) |

There is no universally "best" strategy. Teams optimize for **discoverability**, **cache behavior**, **gateway routing simplicity**, and **client toolchain**.

### Strategy comparison

| Strategy | Example | Pros | Cons |
|---|---|---|---|
| **URI path** | `/api/v1/orders` | Obvious in logs, curl, gateway routes; easy blue/green per version | URL proliferation; "wrong" version in bookmark |
| **Header** | `Accept-Version: 2` or custom `X-Api-Version: 2` | Clean URLs | Invisible in access logs unless logged explicitly; CDN cache key complexity |
| **Query param** | `/orders?version=2` | Easy to try in browser | Easy to forget; cache pollution |
| **Media type** | `Accept: application/vnd.company.orders.v2+json` | Pure REST purist | Client library support weak; gateway config harder |
| **No version (evolve)** | Additive-only forever | Simplest mental model | Requires discipline; one breaking change = incident |

**Production default for Java/Spring shops:** URI path versioning at the **edge** (`/api/v1/**`), documented in OpenAPI `servers` and `info.version`. Internal services often mirror URI versioning for operational clarity even when consumers are few.

### Internal working (Spring Boot 3)

**Option A — separate controller packages (recommended for large drift):**

```java
// v1
@RestController
@RequestMapping("/api/v1/orders")
@RequiredArgsConstructor
public class OrderControllerV1 {

    private final OrderService orderService;

    @GetMapping("/{id}")
    public OrderResponseV1 getOrder(@PathVariable UUID id) {
        return orderService.findAsV1(id);
    }
}

// v2 — different response shape
@RestController
@RequestMapping("/api/v2/orders")
@RequiredArgsConstructor
public class OrderControllerV2 {

    private final OrderService orderService;

    @GetMapping("/{id}")
    public OrderResponseV2 getOrder(@PathVariable UUID id) {
        return orderService.findAsV2(id);
    }
}
```

**Option B — single controller, version in mapping:**

```java
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class OrderController {

    private final OrderMapper mapper;
    private final OrderService orderService;

    @GetMapping(value = "/v1/orders/{id}", produces = "application/vnd.company.orders.v1+json")
    public OrderResponseV1 getV1(@PathVariable UUID id) {
        return mapper.toV1(orderService.find(id));
    }

    @GetMapping(value = "/v2/orders/{id}", produces = "application/vnd.company.orders.v2+json")
    public OrderResponseV2 getV2(@PathVariable UUID id) {
        return mapper.toV2(orderService.find(id));
    }
}
```

**Option C — content negotiation via custom resolver:**

```java
@Configuration
public class ApiVersionConfig implements WebMvcConfigurer {

    @Override
    public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {
        configurer
            .favorParameter(false)
            .ignoreAcceptHeader(false)
            .defaultContentType(MediaType.APPLICATION_JSON);
    }
}
```

Use Option A when v1 and v2 diverge in **behavior** (not just DTO fields). Use Option B when differences are **mapping-only** and you want one service class. Avoid Option C unless you have strong API governance — it is the hardest to debug in gateway logs.

### Gateway routing per version

```yaml
# Spring Cloud Gateway — application.yml
spring:
  cloud:
    gateway:
      routes:
        - id: orders-v1
          uri: lb://order-service
          predicates:
            - Path=/api/v1/orders/**
          filters:
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
                key-resolver: "#{@userKeyResolver}"

        - id: orders-v2
          uri: lb://order-service
          predicates:
            - Path=/api/v2/orders/**
          metadata:
            api-version: "2"
```

Run **both** routes to the **same** service during migration; retire v1 route only after sunset date and traffic metrics show zero.

### Production scenario: mobile app pinned to v1, backend ships v2-only

**Problem.** Backend team deprecates v1 controllers "because nobody uses them." Mobile app 2.3.1 (12% of users, slow auto-update regions) still calls `/api/v1/orders/{id}`. After deploy: spike in 404, App Store reviews, support tickets.

**Diagnose.**

```bash
# Access log aggregation — count by path and status
grep "/api/v1/orders" gateway-access.log | awk '{print $9}' | sort | uniq -c
# Still thousands of 200/404 mix → clients exist
```

Check OpenAPI `deprecated: true` on v1 — if never published, partners didn't know.

**Solution.**

1. Restore v1 controller (or gateway rewrite v1 → adapter layer) immediately.
2. Publish deprecation timeline: `Sunset: 2026-12-01`, `Deprecation: 2026-06-01`.
3. Add metric `api_version_requests_total{version="v1"}` — alert if > 0.1% after sunset-30d.
4. Mobile: force-upgrade only as last resort; prefer extended v1 read-only period.

### Production scenario: gateway strips `/api` but service expects full path

**Problem.** Gateway config:

```yaml
filters:
  - StripPrefix=2   # strips /api/v1 → leaves /orders
```

Service controller mapped to `/api/v1/orders`. Result: 404 on every request; works in local integration tests that hit service directly.

**Solution.** Align one side:

```yaml
# Gateway: strip to service root only
- StripPrefix=1   # /api/v1/orders → v1/orders — still wrong if service expects /api/v1

# Better: RewritePath
- RewritePath=/api/v(?<version>\d+)/(?<segment>.*), /$\{segment}   # only if service is unversioned internally

# Best: no strip; service owns /api/v1/orders; gateway routes Path=/api/v1/orders/**
```

Document the **canonical path** in OpenAPI `servers[0].url` exactly as clients call it through the gateway.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Version only in gateway, not in service | Direct pod curl works with wrong path; gateway 404 |
| Shared DTO between v1 and v2 | Accidental field exposure in v1; breaking change in shared class |
| `defaultVersion` implicit latest | Old clients get new behavior without opting in |
| OpenAPI `info.version` bumped but URI still `/v1` | Partner codegen mismatch |
| Deprecation header never sent | Clients discover breaking change at 404 |

### Debugging scenario

**Observe.** `/api/v2/orders/abc` returns 404; `/api/v1/orders/abc` works.

**Diagnose.**

1. Gateway route table — is `orders-v2` route present and ordered before catch-all?
2. Service actuator `mappings` — is `OrderControllerV2` registered?
3. Deploy skew — v2 pods not in load balancer pool?
4. Case sensitivity — `/api/V2` vs `/api/v2`?

```bash
curl -v https://api.example.com/api/v2/orders/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer ..."
# Compare X-Forwarded-Prefix, upstream path in gateway debug logs
```

**Fix.** Route + controller alignment; deploy all replicas; add contract test in CI that hits path through gateway test container.

---

## 3. Backward Compatibility — Rules and Violations

### Core concept

**Backward compatible** change: clients built against contract **T** continue to work against **T+1** without modification.

**Forward compatible** change: clients built against **T+1** can parse responses from **T** (rarely guaranteed; useful for rolling deploys).

Microservice APIs should optimize for **backward compatibility** on read paths and **explicit versioning** on unavoidable breaks.

### The compatibility checklist (additive changes — safe without new version)

| Change | Safe? | Notes |
|---|---|---|
| Add optional JSON field | Yes | Clients ignore unknown fields (JSON best practice) |
| Add optional query parameter with default | Yes | Document default behavior |
| Add new enum value | Usually | Clients with strict enum parsing break — document or use string |
| Add new endpoint | Yes | No impact on existing |
| Add HTTP method to resource | Yes | If URL new |
| Tighten validation on optional field | **Risky** | Previously accepted junk now 400 |
| Change error message text | Yes for machines | No for clients parsing `message` string |
| Change error **code** field | **No** | Partners branch on `code` |
| Rename JSON field | **No** | Use new field + deprecate old for one release |
| Change field type (`string` → `number`) | **No** | New version |
| Make optional field required on request | **No** | New version or default |
| Remove response field | **No** | Deprecate, then remove in major version |
| Change URL path | **No** | New version route |
| Change semantics of 200 (same JSON, different meaning) | **No** | Worst kind — tests pass, business breaks |

### Internal working — Jackson and unknown properties

Spring Boot 3 default Jackson **ignores unknown properties on deserialize** — good for forward evolution of requests. On **serialize**, you control exposure via DTOs — never return JPA entities.

```java
@JsonIgnoreProperties(ignoreUnknown = true)
public record CreateOrderRequest(
    @NotNull UUID customerId,
    @Positive int quantity,
    @Deprecated String legacySkuCode,  // still accepted, mapped internally
    String sku  // preferred field
) {}
```

**Response discipline:**

```java
public record OrderResponseV1(
    UUID id,
    String status,
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @Deprecated
    String legacyStatusCode,  // populated for v1 only
    Instant createdAt
) {}
```

Use **`@JsonInclude(NON_NULL)`** so new optional fields don't appear as `null` in v1 if you share serializers — or better, separate DTOs per version.

### Production scenario: "harmless" enum addition breaks partner

**Problem.** `status` was `PENDING | SHIPPED`. You add `PARTIALLY_SHIPPED`. Partner's generated client uses strict enum deserialization (OpenAPI `enum` in spec). Their nightly job starts failing with `IllegalArgumentException` even though they never see the new value in their subset of orders.

**Solution.**

1. OpenAPI: document enum extension policy — "Clients must tolerate unknown enum values; treat as `UNKNOWN`."
2. Prefer **string** status with documented values rather than closed enum in public APIs.
3. If enum required: bump minor OpenAPI version, notify partners, avoid codegen strict mode.

### Production scenario: nullable → required breaks mobile forms

**Problem.** `phoneNumber` optional in v1. v2 backend deploy makes it `@NotNull` on same `/api/v1` path (team forgot version split). Old app submits without phone → 400 validation storm.

**Solution.** Never tighten request validation on an unversioned path. New requirement → `/api/v2` or default value server-side with migration backfill.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Single `OrderDto` for DB, API, and events | Accidental field leak; renames break everything |
| Relying on JSON field order | Some clients parse naively; order not guaranteed |
| Using `float` for money | Rounding differences across platforms |
| Timestamp without timezone | DST bugs in reporting |
| Returning stack traces in 500 body | Security + clients parse `message` |

---

## 4. Breaking vs Non-Breaking Changes

### Formal definitions

| Term | Definition | Example |
|---|---|---|
| **Non-breaking (compatible)** | Existing clients unaffected | Add `metadata` object to response |
| **Breaking (incompatible)** | Existing clients fail or misbehave | Remove `customerId` from response |
| **Behavioral breaking** | Schema unchanged, semantics changed | `GET /stock/{sku}` used to include reserved; now available only — same JSON shape |

Behavioral breaks are the hardest — contract tests on schema alone won't catch them.

### Change management workflow

```
1. Propose change in RFC / ADR
2. Classify: additive | deprecated | breaking
3. If breaking → new API version OR feature flag + dual-write period
4. Update OpenAPI (source of truth)
5. Consumer-driven contract tests in CI
6. Publish changelog + deprecation headers
7. Monitor per-version traffic
8. Sunset old version on announced date
```

### Deprecation response headers

```java
@Component
public class DeprecationHeaderFilter extends OncePerRequestFilter {

    private static final Set<String> DEPRECATED_PREFIXES = Set.of("/api/v1/");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        chain.doFilter(request, response);
        String path = request.getRequestURI();
        if (DEPRECATED_PREFIXES.stream().anyMatch(path::startsWith) && response.getStatus() < 400) {
            response.setHeader("Deprecation", "true");
            response.setHeader("Sunset", "Sat, 01 Dec 2026 00:00:00 GMT");
            response.setHeader("Link", "</api/v2/orders>; rel=\"successor-version\"");
        }
    }
}
```

RFC 8594 `Sunset` header gives clients machine-readable end date.

### Production scenario: behavioral break in pagination

**Problem.** v1 returned all order lines inline. v2 paginates lines with default `?page=0&size=20` on same URL `/api/v1/orders/{id}` — "we didn't change the schema." Mobile order detail shows 20 lines max; support escalations.

**Solution.** Pagination is a **behavioral** change — new version or explicit `?include=allLines=true` default-true for v1 compatibility period.

---

## 5. Deprecation, Sunset, and Migration

### Core concept

**Deprecation** = still works, discouraged. **Sunset** = removed. The gap between them is where production stability lives. Industry norm: **minimum 6–12 months** for public APIs; internal services can be shorter if you control all consumers.

### Migration patterns

| Pattern | When | Mechanics |
|---|---|---|
| **Parallel run** | v1 + v2 both live | Gateway splits traffic by path; shared DB |
| **Strangler at gateway** | v2 reimplements subset | Gateway routes `/v2/**` to new service |
| **Adapter layer** | v1 facade over v2 internals | v1 controller calls v2 domain, maps response |
| **Read v2 / write dual** | Data model migration | Writes to both schemas during transition |

**Adapter example:**

```java
@RestController
@RequestMapping("/api/v1/orders")
@RequiredArgsConstructor
public class OrderV1AdapterController {

    private final OrderQueryService v2QueryService;
    private final OrderV1Mapper mapper;

    @GetMapping("/{id}")
    public OrderResponseV1 get(@PathVariable UUID id) {
        return mapper.fromV2(v2QueryService.find(id));
    }
}
```

Keeps v1 alive while domain moves to v2 model — cost is mapping debt; schedule deletion date.

### Production scenario: sunset v1 with hidden batch consumer

**Problem.** Traffic dashboard shows v1 at 0 RPS for weeks. Team removes v1. Finance batch job runs at 2 AM using v1 export endpoint — silent failure until month-end close.

**Solution.**

- Rate-limit metrics by `User-Agent` and `client_id` (OAuth).
- Alert on **any** v1 request in last 7 days before sunset PR merges.
- Require **explicit consumer registry** for partner APIs.

### Communication template (changelog entry)

```markdown
## 2026-06-01 — Orders API v1 deprecated

- **Sunset date:** 2026-12-01
- **Successor:** `/api/v2/orders`
- **Breaking changes in v2:** `status` enum replaced with `statusCode` string; see OpenAPI diff
- **Action required:** Migrate reads by Q3; write paths must use v2 by 2026-10-01
- **Support:** api-support@example.com
```

---

## 6. API Gateway Patterns

### Core concept

The API gateway is the **single front door** for clients. It centralizes concerns that should not be reimplemented in every microservice: TLS, authentication, rate limiting, routing, request/response transformation, CORS, WAF integration, and observability tags.

```
                    ┌─────────────────────────────────────┐
                    │           API Gateway               │
                    │  auth │ rate limit │ route │ WAF   │
                    └──────────┬────────────┬─────────────┘
                               │            │
              ┌────────────────┘            └────────────────┐
              ▼                                              ▼
     ┌─────────────────┐                          ┌─────────────────┐
     │  Mobile BFF     │                          │  Order Service  │
     │  (aggregation)  │                          │  (domain)       │
     └────────┬────────┘                          └─────────────────┘
              │ fan-out
     ┌────────┴────────┐
     ▼                 ▼
 Product Svc      Inventory Svc
```

### Pattern catalog

| Pattern | Purpose | Gateway vs service |
|---|---|---|
| **Reverse proxy / router** | Path → service | Gateway |
| **TLS termination** | Certificates at edge | Gateway / LB |
| **Authentication offload** | Validate JWT, pass claims headers | Gateway (validate) + service (authorize) |
| **Rate limiting** | Protect backends | Gateway (global) + service (fine-grained) |
| **Backend for Frontend (BFF)** | Client-specific aggregation | Separate BFF service, often behind gateway |
| **API composition** | Multi-call merge | BFF, not raw gateway scripts |
| **Protocol translation** | REST ↔ gRPC | Gateway (grpc-json transcoding) |
| **Request aggregation** | GraphQL / custom | BFF or dedicated graph layer |
| **Canary / A-B routing** | Weighted routes | Gateway metadata + load balancer |
| **Circuit breaking** | Fail fast on sick origin | Gateway (Resilience4j) or mesh |

### Gateway vs BFF vs mesh

| Component | Responsibility | Avoid |
|---|---|---|
| **Gateway** | Cross-cutting ingress, routing, coarse auth, rate limits | Business rules, 5-service joins |
| **BFF** | Shape responses for one client type | Becoming a god service with 40 Feign clients |
| **Service mesh (Istio/Linkerd)** | mTLS, L7 retry, telemetry between services | Replacing public API documentation |

### Authentication at the gateway

**Validate, don't replace domain authorization.**

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://order-service
          predicates:
            - Path=/api/v2/orders/**
          filters:
            - TokenRelay=
            - name: JwtClaimHeader
              # custom filter: X-User-Id, X-Tenant-Id from JWT
```

Service still checks: "May this tenant read this order?"

```java
@PreAuthorize("@orderAuth.canRead(#id, authentication)")
@GetMapping("/{id}")
public OrderResponseV2 get(@PathVariable UUID id) { ... }
```

**Anti-pattern:** Gateway strips auth and trusts `X-User-Id` from client — spoofable unless mTLS internal.

### Production scenario: BFF logic leaked into gateway filters

**Problem.** Team implements 200-line Groovy/SpEL in gateway to call inventory + product and merge JSON. Deployments require gateway restart for business rule tweaks; no unit tests; peak traffic melts gateway CPU.

**Solution.** Move aggregation to **Order BFF** service; gateway only routes `/mobile/**` → `mobile-bff`. Keep gateway filters stateless and fast (< 10ms).

### Production scenario: double authentication — gateway and every service

**Problem.** Gateway validates JWT. Each service also validates JWT with remote JWK fetch — 8 services × 500 RPS = JWK endpoint hammered; latency added.

**Solution.**

- Gateway validates signature + expiry; passes **signed internal token** or mTLS + trusted headers within cluster.
- Services validate **internal** token or rely on mesh identity for service-to-service.
- Never skip authorization because "gateway already authenticated."

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No timeout on gateway → service | Gateway 504 after client already disconnected; orphaned work |
| `StripPrefix` mismatch | 404 spikes after gateway change |
| CORS only on gateway, preflight hits service | Browser CORS errors on 401 |
| Rate limit key = IP only behind carrier NAT | Innocent users blocked together |
| JWT validation without `aud` check | Token from wrong client accepted |

---

## 7. Spring Cloud Gateway — Production Configuration

### Core routes, filters, and discovery

```yaml
spring:
  application:
    name: api-gateway
  cloud:
    gateway:
      default-filters:
        - AddResponseHeader=X-Content-Type-Options, nosniff
        - name: Retry
          args:
            retries: 2
            statuses: BAD_GATEWAY,SERVICE_UNAVAILABLE
            methods: GET
            backoff:
              firstBackoff: 100ms
              maxBackoff: 500ms
      routes:
        - id: order-service
          uri: lb://order-service
          predicates:
            - Path=/api/v2/orders/**
            - Method=GET,POST,PUT,DELETE
          filters:
            - name: CircuitBreaker
              args:
                name: orderService
                fallbackUri: forward:/fallback/orders
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 50
                redis-rate-limiter.burstCapacity: 100
                key-resolver: "#{@tenantKeyResolver}"
      httpclient:
        connect-timeout: 2000
        response-timeout: 10s

resilience4j:
  circuitbreaker:
    instances:
      orderService:
        slidingWindowSize: 20
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
```

**Custom key resolver (rate limit per tenant):**

```java
@Configuration
public class RateLimitConfig {

    @Bean
    KeyResolver tenantKeyResolver() {
        return exchange -> {
            String tenant = exchange.getRequest().getHeaders().getFirst("X-Tenant-Id");
            if (tenant == null || tenant.isBlank()) {
                tenant = exchange.getRequest().getRemoteAddress().getAddress().getHostAddress();
            }
            return Mono.just(tenant);
        };
    }
}
```

### Global filter — request ID and path logging

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter implements GlobalFilter {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String correlationId = Optional.ofNullable(
            exchange.getRequest().getHeaders().getFirst("X-Correlation-Id")
        ).orElse(UUID.randomUUID().toString());

        ServerHttpRequest mutated = exchange.getRequest().mutate()
            .header("X-Correlation-Id", correlationId)
            .build();

        exchange.getResponse().getHeaders().add("X-Correlation-Id", correlationId);
        return chain.filter(exchange.mutate().request(mutated).build());
    }
}
```

### Production scenario: Retry filter retries POST

**Problem.** Default retry config retries POST on 503. Payment double-charge.

**Solution.** Gateway retry **GET/HEAD only** unless downstream is provably idempotent (idempotency-key aware filter). Writes go through idempotency layer (Section 15).

### Production scenario: `lb://` resolution fails on Kubernetes

**Problem.** `UnknownHostException: order-service` — Spring Cloud LoadBalancer not configured for K8s discovery.

**Solution.**

```xml
<dependency>
    <groupId>org.springframework.cloud</groupId>
    <artifactId>spring-cloud-starter-kubernetes-client-loadbalancer</artifactId>
</dependency>
```

Or use full DNS: `uri: http://order-service.default.svc.cluster.local:8080` with static config in smaller clusters.

---

## 8. API Rate Limiting

### Core concept

Rate limiting protects **shared resources** — DB connections, CPU, downstream SaaS quotas, wallet balances on fraud checks. It is not punishment; it is **fairness and stability**. Return **429 Too Many Requests** with **`Retry-After`** (seconds or HTTP-date), not ambiguous 503 unless backend truly unavailable.

### Algorithms

| Algorithm | Behavior | Use when |
|---|---|---|
| **Fixed window** | Count requests per clock minute | Simple; boundary burst at minute rollover |
| **Sliding window log** | Timestamp log per key | Accurate; memory heavy |
| **Sliding window counter** | Hybrid approximation | Good balance |
| **Token bucket** | Steady rate + burst capacity | **Most common at gateway** — allows bursts |
| **Leaky bucket** | Smooth output rate | Traffic shaping to fixed downstream rate |

Spring Cloud Gateway `RequestRateLimiter` uses **token bucket** via Redis:

```
replenishRate = tokens added per second
burstCapacity = max bucket size
```

### Layered limits

| Layer | Key | Example limit |
|---|---|---|
| Global | `*` | 50k RPS cluster max |
| Per IP | `client_ip` | 100 req/min anonymous |
| Per API key / client_id | OAuth `azp` | 1000 req/min tier Pro |
| Per user | `sub` | 10 req/sec burst 20 |
| Per tenant | `tenant_id` | Contractual quota |
| Per endpoint | path + key | `POST /orders` stricter than `GET` |

**Order:** cheap checks first (gateway), expensive domain checks later (service).

### Implementation — Bucket4j in service (fine-grained)

```java
@Service
@RequiredArgsConstructor
public class OrderRateLimiter {

    private final ProxyManager<String> proxyManager;

    public boolean tryConsume(String tenantId) {
        Bucket bucket = proxyManager.builder()
            .build(tenantId, () -> BucketConfiguration.builder()
                .addLimit(Bandwidth.builder()
                    .capacity(100)
                    .refillGreedy(100, Duration.ofMinutes(1))
                    .build())
                .build());
        return bucket.tryConsume(1);
    }
}

@RestControllerAdvice
public class RateLimitAdvice {

    @ExceptionHandler(RateLimitExceededException.class)
    public ResponseEntity<ProblemDetail> handle(RateLimitExceededException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.TOO_MANY_REQUESTS, ex.getMessage());
        pd.setTitle("Rate Limit Exceeded");
        pd.setProperty("retryAfterSeconds", ex.getRetryAfterSeconds());
        return ResponseEntity.status(429)
            .header(HttpHeaders.RETRY_AFTER, String.valueOf(ex.getRetryAfterSeconds()))
            .body(pd);
    }
}
```

### Production scenario: Redis rate limiter single point of failure

**Problem.** Gateway `RequestRateLimiter` uses Redis. Redis cluster failover 30s — all requests denied or unlimited depending on fail mode.

**Solution.**

- Configure **fail-open vs fail-closed** explicitly for your risk profile (financial APIs → fail-closed with local fallback bucket).
- Local in-memory bucket as degraded mode per gateway pod (split brain allows 2× limit — acceptable briefly).
- Redis HA (sentinel/cluster); monitor latency.

### Production scenario: partner batch job hits 429, retries aggressively

**Problem.** Partner doubles retry rate on 429 without `Retry-After`. Amplification loop.

**Solution.**

- Document 429 handling in partner guide: exponential backoff, respect `Retry-After`, use bulk endpoints.
- Offer **separate quota** for batch API keys with higher limits, lower max concurrency.
- `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers (de-facto standard):

```java
response.setHeader("X-RateLimit-Limit", "1000");
response.setHeader("X-RateLimit-Remaining", String.valueOf(remaining));
response.setHeader("X-RateLimit-Reset", String.valueOf(epochSeconds));
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Limit per gateway pod only (no Redis) | Effective limit = N × intended |
| Key = IP for mobile carrier | Random 429 for users |
| No burst capacity | Legitimate spikes fail |
| 503 instead of 429 | Clients retry wrong |
| Same limit for GET and POST | Writes starve or reads over-consumed |

---

## 9. Quotas, Throttling, and Fairness

### Rate limit vs quota

| Concept | Window | Typical use |
|---|---|---|
| **Rate limit** | Seconds/minutes | Burst protection, DDoS |
| **Quota** | Day/month | SaaS plan: 10k API calls/month |
| **Concurrency limit** | In-flight | Long-polling, report generation |

**Quota enforcement** often needs durable store:

```sql
CREATE TABLE api_usage (
    client_id VARCHAR(64) NOT NULL,
    period DATE NOT NULL,
    request_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (client_id, period)
);
```

Increment in gateway filter via async event or synchronous Redis `INCR` with TTL to month-end.

### Adaptive throttling

When downstream latency rises (p99 > SLO), reduce accepted RPS proactively — **Google SRE adaptive throttling** concept: reject early at gateway before thread pools saturate.

```
accept_probability = max(0, (max_latency - current_latency) / max_latency)
```

Simpler production approach: circuit breaker OPEN → gateway returns 503 with short Retry-After; dynamic limit reduction tied to CPU on order-service.

### Production scenario: free tier exhausts shared DB

**Problem.** Free API tier unlimited read on `/products/search` — scrapers index entire catalog; OLTP DB pegged.

**Solution.** Tiered limits; require API key even for "free"; cache search at CDN/Elasticsearch; captcha on anonymous; separate read replica for search API.

---

## 10. API Documentation — Beyond Swagger UI

### Core concept

Documentation is part of the **contract**. If OpenAPI lags code, partners integrate against fiction. Treat docs as **versioned artifacts** published with each release — not a one-time Swagger annotation sprint.

### Documentation layers

| Layer | Audience | Content |
|---|---|---|
| **OpenAPI spec** | Machines + codegen | Paths, schemas, examples, securitySchemes |
| **Reference portal** | Developers | Redoc, Stoplight, ReadMe, Backstage |
| **Guides / cookbooks** | Integrators | Auth flow, idempotency, pagination walkthrough |
| **Changelog** | Existing consumers | Deprecations, breaking diffs |
| **SDKs** | Mobile/partners | Generated from OpenAPI with semver |

### What good public API docs include

1. **Authentication** — OAuth2 flows, scopes, token TTL, refresh, mTLS option.
2. **Error catalog** — all `problem type` URIs, retryability.
3. **Rate limits** — tiers, headers, 429 behavior.
4. **Versioning policy** — how long v1 supported, how to opt into v2.
5. **Idempotency** — header name, TTL, duplicate response semantics.
6. **Webhooks** — if applicable, signature verification sample code.
7. **Sandbox** — test credentials, base URL, limitations.
8. **SLA / status page** link.

### Production scenario: Swagger UI in production unauthenticated

**Problem.** `/swagger-ui.html` exposes full internal admin endpoints scraped by bots; CVE in old Swagger UI version.

**Solution.**

- Disable Swagger UI in prod **or** protect with SSO/VPN.
- Publish **static Redoc** to docs portal from CI artifact.
- Separate **public** OpenAPI (subset) from **internal** full spec.

```yaml
# application-prod.yml
springdoc:
  api-docs:
    enabled: false
  swagger-ui:
    enabled: false
```

### Documentation-driven CI gate

```yaml
# GitHub Actions excerpt
- name: OpenAPI breaking change detection
  run: |
    oasdiff breaking openapi/main.yaml openapi/pr.yaml --fail-on ERR
```

Block PR if response field removed without major version bump.

---

## 11. OpenAPI / Swagger — Specification and Tooling

### Core concept

**OpenAPI 3.1** (JSON Schema aligned) is the industry standard for describing HTTP APIs. **Swagger** historically referred to the spec and tooling ecosystem (Swagger UI, Codegen); today say **OpenAPI** for the spec, **springdoc-openapi** for Spring Boot integration.

### Spring Boot 3 — springdoc-openapi

```xml
<dependency>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
    <version>2.6.0</version>
</dependency>
```

**Configuration:**

```java
@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI orderServiceApi() {
        return new OpenAPI()
            .info(new Info()
                .title("Order Service API")
                .version("2.3.0")
                .description("Public order management API")
                .contact(new Contact().name("API Team").email("api@example.com")))
            .addServersItem(new Server().url("https://api.example.com").description("Production"))
            .addServersItem(new Server().url("https://sandbox.api.example.com").description("Sandbox"))
            .components(new Components()
                .addSecuritySchemes("bearer-jwt", new SecurityScheme()
                    .type(SecurityScheme.Type.HTTP)
                    .scheme("bearer")
                    .bearerFormat("JWT")))
            .addSecurityItem(new SecurityRequirement().addList("bearer-jwt"));
    }
}
```

**Controller annotations:**

```java
@Operation(summary = "Get order by ID", responses = {
    @ApiResponse(responseCode = "200", description = "Order found",
        content = @Content(schema = @Schema(implementation = OrderResponseV2.class))),
    @ApiResponse(responseCode = "404", description = "Not found",
        content = @Content(schema = @Schema(implementation = ProblemDetail.class))),
    @ApiResponse(responseCode = "429", description = "Rate limited")
})
@GetMapping("/{id}")
public OrderResponseV2 getOrder(@PathVariable UUID id) { ... }
```

**Schema with examples:**

```java
@Schema(description = "Order status code", example = "SHIPPED",
    allowableValues = {"PENDING", "SHIPPED", "DELIVERED", "CANCELLED"})
String statusCode;
```

### Multi-version OpenAPI

| Approach | Pros | Cons |
|---|---|---|
| Single spec, multiple tags (v1, v2) | One portal | Cluttered; easy to leak v1 into codegen |
| Separate specs per major version | Clear boundaries | Must sync shared components |
| Spec from running app per profile | Always in sync | Needs build per version |

**Recommended:** `openapi/v1/openapi.yaml` + `openapi/v2/openapi.yaml` in repo; CI merges shared `$ref` components.

### Code generation (clients)

```bash
openapi-generator-cli generate \
  -i openapi/v2/openapi.yaml \
  -g java \
  -o clients/order-java \
  --additional-properties=library=restclient,useJakartaEe=true
```

Pin generator version in CI — regenerating with new generator can break partners silently.

### Swagger UI vs Redoc vs Stoplight

| Tool | Best for |
|---|---|
| **Swagger UI** | Try-it-out interactive dev |
| **Redoc** | Beautiful read-only reference |
| **Stoplight Studio** | Design-first governance |

### Production scenario: runtime-generated spec doesn't match prod controllers

**Problem.** Dev uses `@Profile("local")` controllers; prod spec missing endpoints partners need — or includes internal debug routes.

**Solution.**

- Generate spec in CI from **prod profile** integration test slice.
- Or **design-first**: hand-write OpenAPI, validate controllers with schemathesis/DRY tests.

```java
@SpringBootTest
@AutoConfigureMockMvc
class OpenApiContractTest {

    @Autowired MockMvc mockMvc;

    @Test
    void specMatchesImplementations() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.paths['/api/v2/orders/{id}']").exists());
    }
}
```

### OpenAPI for gateway routes

Document **external** URL (through gateway), not internal `lb://order-service` path. Use `servers.url = https://api.example.com`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Schema` on entity with lazy fields | Spec shows relations; JSON serialization 500 |
| Generic `Map<String,Object>` in DTO | Useless codegen types |
| Missing `security` on sensitive ops | Docs show open endpoint |
| `example` doesn't validate against schema | Partner copy-paste fails |
| OpenAPI 2.0 swagger-codegen legacy | Wrong types in modern Java |

---

## 12. Contract Testing and Spec-Driven Development

### Core concept

**Consumer-driven contracts** verify that provider responses match what consumers expect — independent of OpenAPI's wishful thinking.

**Spring Cloud Contract** (producer-side):

```groovy
// contracts/orders/shouldReturnOrder.groovy
Contract.make {
    description "return order v2"
    request {
        method GET()
        url "/api/v2/orders/550e8400-e29b-41d4-a716-446655440000"
        headers {
            header("Authorization", "Bearer token")
        }
    }
    response {
        status 200
        headers {
            contentType(applicationJson())
        }
        body([
            id: "550e8400-e29b-41d4-a716-446655440000",
            statusCode: "SHIPPED"
        ])
        bodyMatchers {
            jsonPath('$.id', byRegex(uuid()))
        }
    }
}
```

**Pact** (consumer-driven): consumer defines expected interaction; provider verifies in CI.

### Workflow

```
OpenAPI (design) → Implement → Contract tests → Publish spec artifact → Partner codegen
                      ↑                                    │
                      └──────── breaking diff tool ────────┘
```

### Production scenario: green CI, broken partners

**Problem.** Unit tests mock everything. Field `totalAmount` renamed to `amount` — OpenAPI updated, provider tests pass with new DTO. Three partners break.

**Solution.** Pact or contract tests **per known consumer**; oasdiff in CI; canary release with shadow traffic comparison on JSON bodies.

---

## 13. Error Models and Problem Details (RFC 7807)

### Core concept

Consistent errors reduce integration cost. Spring Boot 3 `ProblemDetail` maps to `application/problem+json`.

```java
@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(OrderNotFoundException.class)
    public ProblemDetail notFound(OrderNotFoundException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setTitle("Order Not Found");
        pd.setType(URI.create("https://api.example.com/problems/order-not-found"));
        pd.setProperty("orderId", ex.getOrderId());
        return pd;
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail validation(MethodArgumentNotValidException ex) {
        ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        pd.setTitle("Validation Failed");
        pd.setProperty("errors", ex.getBindingResult().getFieldErrors().stream()
            .map(fe -> Map.of("field", fe.getField(), "message", fe.getDefaultMessage()))
            .toList());
        return pd;
    }
}
```

**Compatibility rule:** never remove `type`, `title`, or `status` semantics without version bump. Adding `errors` array is safe.

### Production scenario: clients parse HTML error pages

**Problem.** Gateway returns Spring Whitelabel HTML 500 for unhandled exceptions. Partner JSON parser crashes.

**Solution.** Global gateway `ErrorWebExceptionHandler` returning ProblemDetail JSON; `Accept: application/json` priority.

---

## 14. Pagination, Filtering, and Field Selection

### Standard patterns

| Pattern | Parameters | Notes |
|---|---|---|
| Offset | `?page=0&size=20` | Simple; poor on large offsets (DB deep scan) |
| Cursor | `?cursor=eyJ...&limit=20` | Stable for live feeds |
| Keyset | `?after_id=uuid&limit=20` | Efficient for ordered IDs |

**Response metadata:**

```json
{
  "data": [...],
  "page": {
    "size": 20,
    "totalElements": 1542,
    "totalPages": 78,
    "number": 0
  },
  "links": {
    "self": "/api/v2/orders?page=0&size=20",
    "next": "/api/v2/orders?page=1&size=20"
  }
}
```

**Field selection (sparse fieldsets):** `?fields=id,status,createdAt` — reduces payload; document in OpenAPI as optional query param.

### Compatibility

Adding pagination where none existed is **breaking** (Section 4). Default `size=1000` mimics old behavior during transition.

---

## 15. Idempotency and Safe Retries at the Edge

### Core concept

HTTP methods: **GET, PUT, DELETE** should be idempotent by design. **POST** is not — unless **Idempotency-Key** header (Stripe-style).

```java
@PostMapping
public ResponseEntity<OrderResponseV2> create(
    @RequestHeader("Idempotency-Key") String idempotencyKey,
    @Valid @RequestBody CreateOrderRequest request) {

    return idempotencyService.execute(idempotencyKey, () -> {
        Order created = orderService.create(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(mapper.toV2(created));
    });
}
```

Store `(key → response, status, expires_at)` in Redis 24h.

Gateway **must not retry POST** unless idempotency-aware (Section 7).

---

## 16. Multi-Tenant and Partner API Isolation

### Patterns

| Pattern | Isolation | API surface |
|---|---|---|
| **Shared schema, tenant_id column** | Logical | Single API; tenant from JWT |
| **Schema per tenant** | Stronger DB | Same API; routing in service |
| **Instance per enterprise** | Maximum | Custom domain / dedicated gateway route |

**OpenAPI:** document tenant header or claim; never expose cross-tenant IDs in examples.

**Rate limits:** always include tenant in key resolver (Section 7).

### Production scenario: tenant A sees tenant B order

**Problem.** `GET /api/v2/orders/{id}` checks auth but not tenant match on UUID v4 guessable enumeration.

**Solution.** Authorize `(user, tenant, order.tenantId)`; use non-enumerable IDs or secondary check; audit log cross-tenant attempts.

---

## 17. Production Debugging Playbook

When API behavior is "random," it is usually **version/routing skew**, **compat break**, **rate limit mis-keying**, or **spec drift**.

1. **Classify the status code.**
   - **404** — wrong version path, gateway rewrite, deploy skew, or removed resource.
   - **400** — validation tightened or client schema mismatch.
   - **401/403** — auth at gateway vs service disagreement.
   - **429** — rate limit; check `Retry-After`, key resolver, Redis health.
   - **502/504** — gateway timeout vs service slow; compare timeout budgets.

2. **Identify API version in flight.**

   ```bash
   # Access log fields: path, status, api_version, client_id
   grep "POST /api/v2/orders" gateway.log | tail -20
   ```

   Compare v1 vs v2 error rates after deploy.

3. **Diff response body against OpenAPI example** — use saved HAR from partner or `schemathesis run openapi.yaml --base-url https://staging.api.example.com`.

4. **Verify gateway route matched** — enable Spring Cloud Gateway DEBUG:

   ```yaml
   logging.level.org.springframework.cloud.gateway: DEBUG
   ```

   Look for `Route matched: orders-v2`.

5. **Check rate limit headers and Redis** — sudden 429 cluster-wide: Redis down or wrong key explosion (unique key per request bug).

6. **Validate JWT claims at both layers** — gateway `exp` ok but service rejects `aud`.

7. **Contract test replay** — run Pact verification against canary before full promote.

8. **Rollback criterion** — v1 error rate > baseline + 5% or any 429 on critical partner client_id.

9. **Communicate** — status page + changelog if breaking; include `Sunset` header verification in staging.

10. **Turn off DEBUG** — gateway TRACE logs full Authorization headers.

---

## 18. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Public mobile API, slow client updates | URI versioning; long v1 sunset; never break unversioned paths |
| Internal-only microservice API | URI `/internal/v1` or separate cluster; mTLS |
| Add optional response field | Same version; update OpenAPI minor; oasdiff should pass |
| Rename or remove field | New major version path; adapter for old |
| Behavioral change (pagination, filter default) | New version or explicit opt-in param defaulting to old behavior |
| Cross-cutting auth, TLS, coarse rate limit | API Gateway |
| Client-specific aggregation | BFF behind gateway |
| Partner SLAs and quotas | Gateway rate limit + durable quota store + documented 429 |
| DDoS / scraper on public read | CDN cache + WAF + strict anonymous limits |
| Design-first API | OpenAPI in repo → Spectral lint → implement → contract tests |
| Code-first API | springdoc → export spec in CI → diff against published artifact |
| Swagger in production | Disable or SSO-protect; publish static Redoc |
| POST from mobile on flaky network | Idempotency-Key + 429 backoff |
| Redis rate limit HA | Sentinel/cluster; define fail-open vs fail-closed |
| Multiple API versions in prod | Gateway routes per version; metrics per version; sunset headers |
| Enum in public OpenAPI | Prefer string + documented values; tolerate unknown |
| Error responses | RFC 7807 ProblemDetail JSON always at gateway and service |
| Breaking change detection | oasdiff / openapi-diff in CI on every PR |
| Gateway retry | GET/HEAD only unless idempotent POST |
| Version discovery | `Link` successor-version + changelog + email partners 90d before sunset |

---

## 19. Interview Q&A

### Q1. What is the difference between URI versioning and header versioning?

**A.** **URI versioning** embeds the version in the path (`/api/v1/orders`). It is visible in logs, easy to route at the gateway, and simple for clients. **Header versioning** keeps URLs stable and uses `Accept-Version`, `X-Api-Version`, or custom media types. Headers are cleaner for URL aesthetics but harder to debug without explicit logging, complicate CDN cache keys, and are easier for clients to omit. Most Spring production systems use **URI versioning at the public edge** for operational clarity.

### Q2. What changes are backward compatible without bumping API version?

**A.** Adding **optional** request fields, adding **new** response fields clients can ignore, adding **new endpoints**, and adding **optional** query parameters with defaults. Do **not** remove or rename fields, change types, tighten validation on existing optional inputs, change enum semantics, or alter the meaning of existing fields without a version bump.

### Q3. How do you handle breaking changes in a microservices architecture?

**A.** Introduce a **new major version** (`/api/v2`), run **v1 and v2 in parallel** during migration, publish **OpenAPI diff and sunset date**, send **Deprecation/Sunset/Link headers**, use **adapter controllers** if needed, monitor **per-version traffic**, and run **contract tests**. Remove v1 only when metrics and consumer registry show zero critical callers.

### Q4. What belongs in an API gateway vs in a microservice?

**A.** Gateway: **TLS termination**, **authentication validation**, **coarse rate limiting**, **routing**, **CORS**, **request ID**, **timeouts**, **circuit breaking** on routes. Service: **domain authorization**, **business validation**, **fine-grained quotas**, **data access**, **transaction boundaries**. BFF: **aggregation** tailored to a client. Avoid business orchestration logic in gateway filter scripts.

### Q5. Explain token bucket rate limiting.

**A.** A bucket holds tokens refilled at a steady **replenish rate** (tokens per second) up to **burst capacity**. Each request consumes one token; if empty, reject with **429**. It allows short bursts while enforcing average rate over time. Spring Cloud Gateway `RequestRateLimiter` with Redis implements this pattern.

### Q6. Why return 429 instead of 503 when rate limited?

**A.** **429** signals the client exceeded a **quota or rate policy** — backoff and retry later (`Retry-After`). **503** implies the **server is temporarily unable** to handle requests due to overload or maintenance — clients may retry aggressively and amplify load. Correct status codes improve client behavior and observability dashboards.

### Q7. What is OpenAPI and how does it relate to Swagger?

**A.** **OpenAPI** is the specification format (currently 3.1) describing REST API paths, operations, schemas, and security. **Swagger** was the original name; today it often refers to **tooling** (Swagger UI, legacy Codegen). In Spring Boot 3, **springdoc-openapi** generates OpenAPI 3 docs from code and serves Swagger UI optionally.

### Q8. How do you keep OpenAPI documentation in sync with code in production?

**A.** Treat spec as a **build artifact**: generate in CI from `/v3/api-docs` under prod-like profile, **diff against published spec** with oasdiff, block breaking changes without major version, publish to **docs portal** on release. Alternatively **design-first** — OpenAPI is source of truth and tests validate controllers. Never rely on manually edited Wiki docs.

### Q9. What are Deprecation and Sunset headers?

**A.** **`Deprecation: true`** (RFC 9745 ecosystem) marks a response as using a deprecated API version or feature. **`Sunset`** (RFC 8594) gives an HTTP-date when the API will be removed. **`Link: rel="successor-version"`** points to the replacement. They let clients and monitors detect end-of-life automatically.

### Q10. What is a BFF and how is it different from an API gateway?

**A.** **API Gateway** is infrastructure ingress — cross-cutting policies and routing. **BFF (Backend for Frontend)** is an **application service** that aggregates and shapes data for one client type (mobile vs web). Gateway routes to BFF; BFF calls domain microservices. BFF contains presentation logic; gateway should stay thin.

### Q11. How do you version internal service-to-service APIs?

**A.** Common approaches: **URI versioning** (`/internal/v1`) for clarity, **separate deployment** of breaking services with consumer updates, or **strict additive-only** policy with consumer-driven contracts (Pact). Even internal APIs deserve timeouts, auth (mTLS/OAuth client credentials), and OpenAPI — "internal" is not "trusted forever."

### Q12. What is consumer-driven contract testing?

**A.** **Consumers** define expected request/response shapes (Pact) or **producers** publish contracts (Spring Cloud Contract). CI verifies the provider against all consumer contracts. Catches field renames and status code changes that unit tests with mocks miss. Complements OpenAPI structural diff.

### Q13. How does Spring Cloud Gateway implement rate limiting?

**A.** The **`RequestRateLimiter`** filter uses a **`KeyResolver`** (user, IP, tenant) and **`RedisRateLimiter`** (token bucket backed by Redis Lua scripts). Configure `replenishRate` and `burstCapacity` per route. Requires reactive Redis; cluster Redis for HA. Custom filters can integrate Bucket4j or Envoy rate limit service.

### Q14. What is the difference between rate limiting and quotas?

**A.** **Rate limiting** controls **instantaneous request rate** (per second/minute) for burst protection. **Quotas** cap **total usage over a longer period** (daily/monthly API call allowance per plan). Rate limits prevent spikes; quotas enforce commercial tiers. Implement quotas with durable counters (DB/Redis) and reset at period boundaries.

### Q15. How do you make POST idempotent for API clients?

**A.** Require **`Idempotency-Key`** header (UUID from client). Server stores key → response mapping with TTL (e.g., 24 hours). Duplicate POST with same key returns **same status and body** without re-executing side effects. Essential for mobile flaky networks and gateway-safe retries. Document in OpenAPI.

### Q16. What is RFC 7807 Problem Details?

**A.** Standard JSON error format: `type` (URI identifying problem), `title`, `status`, `detail`, optional extensions. Spring Boot 3 **`ProblemDetail`** class produces `application/problem+json`. Consistent errors across gateway and services help partners programmatically handle failures without parsing HTML or ad-hoc JSON shapes.

### Q17. When is content negotiation (Accept header) versioning appropriate?

**A.** When you need **stable URLs** and clients already support custom media types (`application/vnd.company.v2+json`). Rare in mobile/public APIs due to poor tooling support. Requires careful **Vary: Accept** caching. Prefer URI versioning unless API maturity and client ecosystem support vendor media types.

### Q18. How do you detect breaking OpenAPI changes in CI?

**A.** Tools like **oasdiff**, **openapi-diff**, or **Spectral** rules compare PR spec to main. Fail on removed properties, type changes, removed endpoints, or required field additions. Pair with **semver** on `info.version` and API path major version. Publish human-readable changelog from diff output.

### Q19. What production issues arise from StripPrefix in Spring Cloud Gateway?

**A.** Gateway removes path segments before forwarding; if service controllers expect full `/api/v1/...` but gateway strips `/api/v1`, service returns **404**. Symptoms appear only through gateway — direct service calls in K8s succeed. Fix by aligning **RewritePath/StripPrefix** with controller `@RequestMapping` and documenting canonical external path in OpenAPI.

### Q20. How do you safely sunset an API version?

**A.** Announce **sunset date** (90+ days for partners), add **Deprecation/Sunset headers**, monitor **traffic metrics per version**, maintain **consumer registry**, provide **migration guide and OpenAPI diff**, offer **adapter layer** if needed, run **canary** on v2, alert on any v1 usage near cutoff, and only decommission when **business sign-off** and metrics confirm zero critical traffic.

### Q21. What is the difference between additive and behavioral compatibility?

**A.** **Additive compatibility** means schema changes (new optional fields) old clients tolerate. **Behavioral compatibility** means operations **semantically** behave the same — e.g., returning fewer items due to new default pagination is schema-compatible but **behavior-breaking**. Requires version bump or explicit opt-in parameters preserving old defaults.

### Q22. Should Swagger UI be enabled in production?

**A.** Generally **no** for public internet — exposes attack surface and may reveal **internal/admin endpoints**. Prefer **disabled springdoc UI in prod** and publish **read-only Redoc** to authenticated docs portal. If enabled, protect with **SSO/VPN/IP allowlist** and keep dependencies patched.

### Q23. How do gateway timeouts relate to service timeouts?

**A.** Timeouts must **align top-down**: client < CDN < gateway < BFF < downstream services. If service timeout exceeds gateway, gateway returns **504** while service still processing — orphaned work and duplicate client retries. Set gateway `response-timeout` slightly **shorter** than caller deadline; services shorter than gateway.

### Q24. What is API composition and where should it live?

**A.** **API composition** aggregates data from multiple services into one response (mobile home screen). Belongs in a **BFF** or dedicated aggregator service with parallel calls (WebClient), timeouts, and partial failure handling — **not** in gateway filters or a single "god" domain service without boundaries.

### Q25. How do you rate limit fairly behind NAT?

**A.** Do not rely on **IP alone** — use **API key**, **OAuth client_id**, or **JWT sub** as rate limit key after authentication. For anonymous endpoints, combine IP with **User-Agent fingerprint** cautiously, or require API key even for free tier. Document limits per tier; return **`X-RateLimit-*`** headers.

### Q26. What is the outbox pattern's relation to public APIs?

**A.** Public API returns **202 Accepted** for async operations while **outbox** ensures event publication matches DB commit. Document **polling endpoint** or **webhook** for completion. API evolution must keep **async status schema** backward compatible — mobile apps poll for days on slow networks.

### Q27. How do you document authentication in OpenAPI 3?

**A.** Define **`components.securitySchemes`**: `http/bearer` for JWT, `oauth2` with flows (clientCredentials for M2M, authorizationCode for user apps), or `apiKey` for partner keys. Apply **`security`** globally and override per operation. Include **scopes** matching authorization server. Provide **worked examples** in description, not live secrets.

### Q28. What is shadow traffic for API migrations?

**A.** Duplicate a sample of **v1 production traffic** to **v2 handlers** in read-only mode, compare responses (diff tool, metrics on mismatch rate) before cutover. Catches behavioral differences OpenAPI diff misses. Do not shadow-write without idempotency controls.

### Q29. Explain canary routing for a new API version at the gateway.

**A.** Route **95%** traffic to v1 backend, **5%** to v2 via weighted `metadata` or service mesh VirtualService; compare error rate and latency. Spring Cloud Gateway can use custom **`WeightCalculatorWebFilter`** or two routes with random predicate. Promote weight when SLOs hold.

### Q30. What is the biggest mistake teams make with backward compatibility?

**A.** Assuming **"we only added a field"** while simultaneously **tightening validation**, **changing defaults**, or **sharing one DTO** across versions — then shipping on the same `/v1` path. Compatibility is about **client observable behavior**, not developer perception of change size. Version paths, separate DTOs, contract tests, and oasdiff in CI prevent this class of incident.

---

*An API is a promise slower than your deploy pipeline. Version deliberately, document honestly, limit fairly at the gateway, and treat every field rename as a product event — because for someone integrating at 2 AM, it is.*
