# Microservices Service Management Mastery — Senior Production Reference

Spring Boot 3.x / Spring Cloud 2023.x (2023.0.x Leyton). Kubernetes 1.28+. This is not a getting-started guide. It is the map of what actually breaks in production after shipping microservices behind gateways, registries, and orchestrators — the layer that sits between your business code and the pager.

---

## Table of Contents

1. [Mental Model: One Request Through the Mesh](#1-mental-model-one-request-through-the-mesh)
2. [API Gateway — Spring Cloud Gateway](#2-api-gateway-spring-cloud-gateway)
3. [Service Discovery — Netflix Eureka](#3-service-discovery-netflix-eureka)
4. [Service Discovery — HashiCorp Consul](#4-service-discovery-hashicorp-consul)
5. [Service Discovery — Kubernetes Native](#5-service-discovery-kubernetes-native)
6. [Load Balancing — Client, Server, and Gateway](#6-load-balancing-client-server-and-gateway)
7. [Configuration Management — Local and Externalized](#7-configuration-management-local-and-externalized)
8. [Centralized Configuration — Spring Cloud Config Server](#8-centralized-configuration-spring-cloud-config-server)
9. [Health Checks — Actuator, Aggregates, and Custom Indicators](#9-health-checks-actuator-aggregates-and-custom-indicators)
10. [Liveness Probes — When to Kill the Pod](#10-liveness-probes-when-to-kill-the-pod)
11. [Readiness Probes — When to Route Traffic](#11-readiness-probes-when-to-route-traffic)
12. [Graceful Shutdown — Zero-Downtime Deploys](#12-graceful-shutdown-zero-downtime-deploys)
13. [Spring Cloud LoadBalancer and Service-to-Service Calls](#13-spring-cloud-loadbalancer-and-service-to-service-calls)
14. [Resilience at the Edge — Timeouts, Retries, Circuit Breakers](#14-resilience-at-the-edge-timeouts-retries-circuit-breakers)
15. [Multi-Environment, Profiles, and Feature Flags](#15-multi-environment-profiles-and-feature-flags)
16. [Observability — Metrics, Tracing, and Service Identity](#16-observability-metrics-tracing-and-service-identity)
17. [Security at the Gateway and Between Services](#17-security-at-the-gateway-and-between-services)
18. [Testing Service Infrastructure](#18-testing-service-infrastructure)
19. [Migration Playbook — Eureka/Consul to Kubernetes](#19-migration-playbook-eurekaconsul-to-kubernetes)
20. [Common Production Failures Catalog](#20-common-production-failures-catalog)
21. [Production Debugging Playbook](#21-production-debugging-playbook)
22. [Quick Decision Matrix](#22-quick-decision-matrix)
23. [Scenario-Based Questions](#23-scenario-based-questions)

---

## 1. Mental Model: One Request Through the Mesh

Microservice "service management" is not one product. It is the **operational contract** between clients, an edge (API Gateway or Ingress), a **registry or DNS layer** (Eureka, Consul, Kubernetes Services), **load balancing**, **centralized configuration**, and **lifecycle signals** (health, liveness, readiness, graceful shutdown) that tell the platform when to route traffic and when to kill a process.

```
Mobile / Browser / BFF
  └─ DNS / CDN / WAF
       └─ API Gateway (Spring Cloud Gateway, Kong, NGINX Ingress)
            ├─ TLS termination, auth, rate limit, routing
            ├─ path rewrite: /api/orders → orders-service
            └─ downstream resolution
                 ├─ Eureka/Consul lookup → instance list
                 ├─ K8s Service DNS → Endpoints / EndpointSlice
                 └─ LoadBalancer picks instance (round-robin, weighted, zone-aware)
                      └─ Target pod / VM
                           ├─ Readiness: in Endpoints? (K8s) / UP in registry?
                           ├─ Liveness: JVM alive? deadlock? thread pool exhausted?
                           ├─ Config: Spring Cloud Config / ConfigMap / Secret
                           └─ Graceful shutdown: drain in-flight, deregister, then exit
```

Four objects you must keep distinct:

| Object | Question it answers | Typical implementation |
|---|---|---|
| **Service registration** | Where do instances announce themselves? | Eureka client heartbeat, Consul agent check, K8s Pod + Endpoints controller |
| **Service discovery** | How does a caller find instances? | `@LoadBalanced RestTemplate`, `ReactiveLoadBalancerExchangeFilterFunction`, K8s `orders-service.default.svc.cluster.local` |
| **Health signal** | Is this process fit to serve? | Actuator `/actuator/health`, custom `HealthIndicator`, K8s probes |
| **Configuration source** | What config does this instance run with? | `application.yml`, Config Server Git repo, K8s ConfigMap + Secret, Vault |

A **502 from the gateway** usually means **no healthy downstream instance** (empty registry, all pods NotReady, wrong service name). A **503 with retry-after** often means **rate limit or circuit open**. A **504** is **timeout** — gateway waited longer than configured for a slow or hung downstream. Mixing those up sends you to the wrong team's runbook.

### When you need a registry vs K8s DNS

| Deployment | Discovery pattern |
|---|---|
| VMs / EC2 autoscaling groups, no K8s | Eureka or Consul; gateway and clients poll registry |
| Kubernetes with in-cluster calls | Native Service DNS + Spring Cloud Kubernetes (optional) |
| Hybrid (legacy on VMs + new on K8s) | Gateway on K8s with Eureka for legacy; split routes |
| Serverless / FaaS | No registry; API Gateway → Lambda URL or ALB target group |

### Internal working — registration lifecycle

1. **Startup:** Application binds port, runs `@PostConstruct` / `SmartLifecycle`, Eureka client registers `InstanceInfo` (app name, host, port, VIP address, metadata).
2. **Heartbeat:** Eureka client renews lease every 30s (default). Missed renewals → instance marked **DOWN** after eviction window (~90s).
3. **Discovery cache:** Eureka clients cache registry locally; refresh every 30s. Stale cache = calls to dead instances until refresh.
4. **Gateway route:** `lb://orders-service` resolves via `LoadBalancerClientFilter` → instance list → `RoundRobinLoadBalancer` → `http://10.0.1.47:8080/...`.
5. **Shutdown:** `ContextClosedEvent` → Eureka deregister (if graceful) → stop accepting new connections → complete in-flight → exit.

Kubernetes replaces steps 1–3 with: Pod scheduled → kubelet starts container → readiness probe passes → Endpoints controller adds Pod IP to Service Endpoints → CoreDNS resolves Service name to ClusterIP (kube-proxy or eBPF datapath forwards to Pod).

### Production scenario: deploy succeeds, 100% 502 for ten minutes

**Problem.** Team deploys `orders-service` v2. Gateway health is green. All `/api/orders/**` return 502. Eureka dashboard shows `orders-service` with 0 instances UP.

**Cause chain:** New pods pass **liveness** (JVM up) but fail **readiness** because `DataSourceHealthIndicator` cannot reach RDS during security group change window. Eureka/K8s never routes traffic. Gateway has zero healthy targets for `lb://orders-service`.

Alternatively: service registered under wrong name (`spring.application.name=order-service` typo) while gateway routes to `orders-service`.

**Solution checklist:**

```yaml
# Verify registration name matches gateway route
spring:
  application:
    name: orders-service

# Readiness must not require optional deps you can't guarantee at boot
management:
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState,db
          show-details: when_authorized
```

```java
// Gateway route — name must match spring.application.name (Eureka) or K8s Service
spring.cloud.gateway.routes[0].uri=lb://orders-service
spring.cloud.gateway.routes[0].predicates[0]=Path=/api/orders/**
```

Fix RDS SG, or split readiness groups so Kafka lag doesn't block HTTP readiness on a sync API.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `spring.application.name` mismatch between gateway route and service | Permanent 502; Eureka shows instances under different name |
| Eureka self-preservation ON during network partition | Registry shows UP instances that are unreachable; intermittent 502/504 |
| Readiness includes every dependency (Kafka, Redis, third-party HTTP) | Pod never Ready; rolling deploy stalls at 0% available |
| No graceful shutdown; Eureka deregister after process kill | In-flight requests fail during deploy; error spike every release |
| Config Server mandatory at bootstrap; Config Server down | All pods CrashLoop; cascade outage |
| `@LoadBalanced` missing on `RestTemplate` / WebClient | Calls go to literal hostname `orders-service` → DNS failure on VM |
| Gateway timeout 30s, downstream timeout 60s | Gateway 504 while client still waiting upstream; duplicate processing risk on retry |

### Debugging scenario

**Observe.** Intermittent 502 on `GET /api/orders/123` — roughly 1 in 20 requests. No pattern by user.

**Diagnose.**

```bash
# Eureka — instance count and status
curl -s http://eureka:8761/eureka/apps/ORDERS-SERVICE | grep -E 'status|hostName|port'

# K8s — endpoints vs ready pods
kubectl get endpoints orders-service -o wide
kubectl get pods -l app=orders-service -o wide

# Gateway — enable reactor netty wiretap (staging only)
logging.level.reactor.netty.http.client=DEBUG
```

Check if stale instance in load balancer pool: recently terminated pod still in Eureka for 90s, or K8s Endpoints lag. Check **zone affinity** — client in AZ-a hitting dead instance in AZ-b while healthy ones exist in AZ-a.

**Fix.** Reduce Eureka renewal/eviction tuning carefully; ensure `server.shutdown=graceful`; preStop hook deregistration; verify `spring.cloud.loadbalancer.cache.ttl` isn't hiding fresh instances too long.

---

## 2. API Gateway — Spring Cloud Gateway

### Core concept

Spring Cloud Gateway is a **reactive** edge router built on Spring WebFlux, Netty, and Project Reactor. It sits in front of microservices and centralizes cross-cutting concerns: routing, load balancing, authentication, rate limiting, request/response mutation, and circuit breaking — without duplicating that logic in every service.

Unlike a simple reverse proxy (NGINX `proxy_pass`), Gateway routes are **Spring beans** — predicates + filters + URI — with access to the Spring ecosystem (OAuth2, Redis rate limiter, Config Server refresh).

```
Client request
  └─ Netty server (Gateway)
       └─ Gateway Handler Mapping
            ├─ Route predicate match (Path, Host, Header, Weight)
            ├─ Global filters (order: LOWEST_PRECEDENCE → HIGHEST)
            ├─ Route filters (StripPrefix, RewritePath, RequestRateLimiter, CircuitBreaker)
            └─ LoadBalancerClientFilter → lb://service-id → HTTP client to instance
```

### Internal working

1. `RoutePredicateHandlerMapping` evaluates routes in definition order; **first match wins** (same mental model as Spring Security filter chains).
2. `FilteringWebHandler` runs the filter chain. Global filters wrap route filters.
3. `ReactiveLoadBalancerClientFilter` (order ~10150) intercepts `lb://` URIs, asks `ReactiveLoadBalancer` for `ServiceInstance`, rewrites URI to `http://host:port`.
4. `NettyRoutingFilter` performs the outbound HTTP call on the gateway's event loop — **blocking downstream or slow responses consume gateway capacity**, not a thread-per-request pool, but still a finite resource.
5. Response filters run in reverse order (NettyWriteResponseFilter commits the response).

Default timeouts matter:

```yaml
spring:
  cloud:
    gateway:
      httpclient:
        connect-timeout: 5000
        response-timeout: 30s
      # global default filters can be added here
```

### Production-ready Gateway configuration

```java
@Configuration
public class GatewayRoutesConfig {

    @Bean
    public RouteLocator customRoutes(RouteLocatorBuilder builder) {
        return builder.routes()
            .route("orders-api", r -> r
                .path("/api/orders/**")
                .filters(f -> f
                    .stripPrefix(1)  // /api/orders/1 → /orders/1 on downstream — usually DON'T strip /api if downstream expects it
                    .requestRateLimiter(c -> c
                        .setRateLimiter(redisRateLimiter())
                        .setKeyResolver(userKeyResolver()))
                    .circuitBreaker(c -> c
                        .setName("ordersCb")
                        .setFallbackUri("forward:/fallback/orders")))
                .uri("lb://orders-service"))
            .route("payments-api", r -> r
                .path("/api/payments/**")
                .filters(f -> f
                    .rewritePath("/api/payments/(?<segment>.*)", "/${segment}")
                    .addRequestHeader("X-Gateway-Id", "edge-01"))
                .uri("lb://payments-service"))
            .build();
    }

    @Bean
    RedisRateLimiter redisRateLimiter() {
        return new RedisRateLimiter(100, 200); // replenishRate, burstCapacity
    }

    @Bean
    KeyResolver userKeyResolver() {
        return exchange -> exchange.getRequest().getHeaders()
            .getFirst("X-User-Id") != null
            ? Mono.just(exchange.getRequest().getHeaders().getFirst("X-User-Id"))
            : Mono.just(exchange.getRequest().getRemoteAddress().getAddress().getHostAddress());
    }
}
```

YAML equivalent (preferred for ops-owned routes):

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: orders-api
          uri: lb://orders-service
          predicates:
            - Path=/api/orders/**
          filters:
            - name: CircuitBreaker
              args:
                name: ordersCb
                fallbackUri: forward:/fallback/orders
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
                key-resolver: "#{@userKeyResolver}"
        - id: payments-api
          uri: lb://payments-service
          predicates:
            - Path=/api/payments/**
          filters:
            - RewritePath=/api/payments/(?<segment>.*), /${segment}
      default-filters:
        - AddResponseHeader=X-Response-Gateway, spring-cloud-gateway
        - name: Retry
          args:
            retries: 2
            statuses: BAD_GATEWAY,SERVICE_UNAVAILABLE
            methods: GET
            backoff:
              firstBackoff: 100ms
              maxBackoff: 500ms
```

### JWT validation at the gateway

Centralizing OAuth2 resource-server at the gateway reduces duplicate JWT parsing in every microservice — but **authorization** (can this user access this order?) usually stays in domain services.

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.company.com/realms/prod
  cloud:
    gateway:
      routes:
        - id: secured-orders
          uri: lb://orders-service
          predicates:
            - Path=/api/orders/**
          filters:
            - TokenRelay=  # forwards Authorization header — or use default propagation
```

```java
@Bean
SecurityWebFilterChain gatewaySecurity(ServerHttpSecurity http) {
    return http
        .csrf(ServerHttpSecurity.CsrfSpec::disable)
        .authorizeExchange(ex -> ex
            .pathMatchers("/actuator/health", "/fallback/**").permitAll()
            .pathMatchers("/api/public/**").permitAll()
            .anyExchange().authenticated())
        .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
        .build();
}
```

**Trade-off:** Gateway compromise = wider blast radius. Services should still validate tokens or mTLS for zero-trust. Never trust `X-User-Id` from the client without signature verification.

### Production scenario: StripPrefix breaks path-based authorization

**Problem.** Gateway strips `/api`, downstream receives `/orders/123`. Downstream Spring Security matches `/api/orders/**`. Every request 403 or falls through to wrong chain.

**Solution.** Align paths end-to-end. Either:

- Gateway: no strip; downstream controllers at `/api/orders`.
- Gateway: `RewritePath=/api/(?<p>.*), /${p}` and downstream at `/orders`.
- Document the contract in OpenAPI; integration test through gateway in CI.

### Production scenario: Retry filter duplicates POST on 502

**Problem.** Idempotency not enforced. Gateway retries POST on `BAD_GATEWAY`. Payment charged twice.

**Solution.** Retry only safe methods:

```yaml
filters:
  - name: Retry
    args:
      retries: 2
      statuses: BAD_GATEWAY
      methods: GET,HEAD,OPTIONS
```

Domain services: idempotency keys (`Idempotency-Key` header) for POST/PUT.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `lb://` without Eureka/K8s discovery on classpath | `503 Unable to find instance for orders-service` |
| Circuit breaker fallback URI wrong scheme | `500 No static resource fallback/orders` |
| Rate limiter Redis down | All requests 429 or 500 depending on exception handler |
| CORS configured only on downstream, not gateway | Browser preflight fails at edge |
| `response-timeout` shorter than slowest legitimate report | 504 on month-end batch download |
| Global `Retry` on all routes including POST | Duplicate side effects |

### Debugging scenario

**Observe.** Gateway returns 404 for route that "exists in yaml."

**Diagnose.** Actuator:

```bash
curl http://gateway:8080/actuator/gateway/routes | jq .
curl http://gateway:8080/actuator/gateway/routedefinitions
```

Check predicate order — another route matched first. Enable:

```yaml
logging.level.org.springframework.cloud.gateway=DEBUG
```

Verify Config Server refresh didn't drop routes (missing `@RefreshScope` on custom beans if applicable).

**Fix.** Reorder routes (specific before catch-all). Use `RouteLocator` `@Order` or yaml list order.

---

## 3. Service Discovery — Netflix Eureka

### Core concept

Eureka is a **AP-oriented** (availability + partition tolerance) service registry. Services **register** on startup, **renew** leases via heartbeats, and **fetch** the registry to discover peers. Eureka Server replicates registry state to peer nodes (peer-aware deployment).

Designed for AWS-era elastic instances with unpredictable termination — clients cache registry and tolerate stale data briefly.

```
┌─────────────┐     register/renew      ┌──────────────┐
│ orders-svc  │ ───────────────────────►│ Eureka Server│
│  :8080      │                         │   (peer 1)   │
└─────────────┘                         └──────┬───────┘
       ▲                                       │ replicate
       │ fetch registry                        ▼
       │                              ┌──────────────┐
┌─────────────┐                        │ Eureka Server│
│  gateway    │◄───────────────────────│   (peer 2)   │
└─────────────┘     fetch registry     └──────────────┘
```

### Internal working

- **Registration:** `DiscoveryClient` sends POST to `/eureka/apps/{APP_NAME}` with `InstanceInfo` (IP, port, health URL, metadata).
- **Renewal:** PUT `/eureka/apps/{APP_NAME}/{instanceId}` every `leaseRenewalIntervalInSeconds` (default 30).
- **Eviction:** Server removes instance if no renewal within `leaseExpirationDurationInSeconds` (default 90).
- **Self-preservation:** If >15% of instances expire in a short window, server assumes network glitch and **stops evicting** — registry shows zombies; clients may hit dead nodes.
- **Client cache:** Registry fetched periodically; `@LoadBalanced` uses cached list until refresh.

### Eureka Server — minimal production setup

```yaml
# eureka-server application.yml
server:
  port: 8761
eureka:
  client:
    register-with-eureka: false
    fetch-registry: false
  server:
    enable-self-preservation: true  # understand before disabling
    eviction-interval-timer-in-ms: 60000
spring:
  application:
    name: eureka-server
```

Peer replication (two AZs):

```yaml
eureka:
  client:
    service-url:
      defaultZone: http://eureka-peer1:8761/eureka/,http://eureka-peer2:8761/eureka/
  instance:
    hostname: eureka-peer1
```

### Eureka Client — Spring Boot service

```yaml
spring:
  application:
    name: orders-service
eureka:
  client:
    service-url:
      defaultZone: http://eureka:8761/eureka/
    registry-fetch-interval-seconds: 10
  instance:
    prefer-ip-address: true
    lease-renewal-interval-in-seconds: 30
    lease-expiration-duration-in-seconds: 90
    metadata-map:
      zone: us-east-1a
      version: ${BUILD_VERSION:unknown}
management:
  endpoints:
    web:
      exposure:
        include: health,info
```

```java
@SpringBootApplication
@EnableDiscoveryClient  // optional in Boot 3 + spring-cloud-starter-netflix-eureka-client
public class OrdersApplication { }
```

Gateway discovery:

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
</dependency>
```

```yaml
spring.cloud.gateway.routes[0].uri=lb://orders-service
```

### Production scenario: self-preservation during AZ failure

**Problem.** AZ-a network partition. Eureka marks many instances expired but flips to self-preservation. Gateway still load-balances to dead AZ-a instances. 50% error rate.

**Solution.** Do not disable self-preservation casually — understand the trade-off. Mitigations:

- Client-side retry with Spring Retry + LoadBalancer on another instance.
- Zone-aware load balancing (`spring.cloud.loadbalancer.configurations=zone-preference`).
- Eureka server in 3+ nodes across AZs; monitor `renewal threshold`.
- Long-term: migrate critical paths to K8s with faster endpoint updates.

```yaml
spring:
  cloud:
    loadbalancer:
      zone: us-east-1a  # set per instance via metadata
      configurations: zone-preference
```

### Production scenario: wrong hostname registration on Docker/K8s

**Problem.** Eureka registers container hostname `a3f9b2c1d4e5` — unreachable from other hosts.

**Solution:**

```yaml
eureka:
  instance:
    prefer-ip-address: true
    ip-address: ${POD_IP:}  # K8s downward API
    non-secure-port: ${server.port}
```

K8s downward API:

```yaml
env:
  - name: POD_IP
    valueFrom:
      fieldRef:
        fieldPath: status.podIP
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Eureka server also registers as client to itself incorrectly | Split-brain registry |
| `spring.application.name` with uppercase | Eureka normalizes; gateway `lb://` case sensitivity issues on some versions |
| No health check URL in `InstanceInfo` | UP in Eureka while app returns 500 |
| Single Eureka server in prod | SPOF; registry loss = discovery blackout |
| Client fetch interval 30s + instant scale-down | Calls to terminated instances for up to 30s |

### Debugging scenario

**Observe.** Service shows registered in Eureka UI but gateway 503.

**Diagnose.** Check `status` field (UP vs STARTING vs DOWN). Verify port — registered 8080 but app listens 8081. Check `healthCheckUrl` manually:

```bash
curl http://<instance-ip>:8080/actuator/health
```

Inspect gateway load balancer:

```yaml
logging.level.org.springframework.cloud.loadbalancer=DEBUG
```

**Fix.** Align `server.port`, `eureka.instance.non-secure-port`, and health check path.

---

## 4. Service Discovery — HashiCorp Consul

### Core concept

Consul combines **service discovery**, **health checking**, and **KV store** (often used for config). Unlike Eureka's pure AP registry, Consul uses **Raft consensus** for the catalog (CP for writes) and local agents for health checks — better fit when you want **DNS interface**, multi-datacenter federation, and integrated health probes.

```
Service instance
  └─ Consul Agent (sidecar or host agent)
       ├─ registers service definition
       ├─ runs HTTP/TCP/script check every interval
       └─ reports pass/warn/fail to Consul Server catalog
            └─ DNS: orders-service.service.consul → healthy instances only
```

### Internal working

1. Agent registers service with check definition.
2. Check fails N times → service marked **critical** → removed from DNS/load balancer pool.
3. Spring Cloud Consul Discovery watches catalog via Blocking Queries (long polling).
4. `spring.cloud.consul.discovery.health-check-path=/actuator/health` — agent hits instance periodically.

### Spring Cloud Consul client

```yaml
spring:
  application:
    name: orders-service
  cloud:
    consul:
      host: consul-agent
      port: 8500
      discovery:
        prefer-ip-address: true
        health-check-path: /actuator/health
        health-check-interval: 10s
        health-check-critical-timeout: 30s
        tags: version=2.1.0,zone=dc1
        metadata:
          secure: false
```

```java
@SpringBootApplication
@EnableDiscoveryClient
public class OrdersApplication { }
```

Gateway with Consul:

```yaml
spring:
  cloud:
    consul:
      discovery:
        enabled: true
    gateway:
      discovery:
        locator:
          enabled: true
          lower-case-service-id: true
      routes:
        - id: orders
          uri: lb://orders-service
          predicates:
            - Path=/api/orders/**
```

### Consul Connect / service mesh (awareness)

Consul Connect adds mTLS sidecars. Spring apps can register normally; mesh handles encryption. Not required for basic discovery but common in HashiCorp stacks.

### Production scenario: health check storm during GC pause

**Problem.** Long GC pause > check timeout. Consul marks instance critical. Traffic drains. Instance recovers. Flapping.

**Solution.**

```yaml
spring.cloud.consul.discovery:
  health-check-interval: 15s
  health-check-timeout: 10s
  health-check-critical-timeout: 60s  # deregister after sustained failure only
```

Tune JVM GC; use `/actuator/health/liveness` vs full aggregate for registration check — **registration check should be lighter than full readiness**.

Separate **Consul check** (process responding) from **K8s readiness** (dependencies OK).

### Production scenario: ACL token missing on agent

**Problem.** Service registers in dev (ACL default allow) but prod agent rejects registration silently or logs `403`.

**Solution.** Bootstrap token / service-specific policy:

```yaml
spring.cloud.consul:
  token: ${CONSUL_HTTP_TOKEN}
  discovery:
    acl-token: ${CONSUL_SERVICE_TOKEN}
```

Store tokens in Vault/K8s Secret; rotate.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Agent not on same host/network as service | Health check connection refused |
| `health-check-path` wrong context path | Permanent critical status |
| Multiple services same port on one agent | Wrong check hits wrong process |
| Datacenter mismatch in WAN federation | Empty catalog in local DC |
| TTL check without app heartbeat | Deregistered while running |

### Debugging scenario

**Observe.** Consul UI shows service green; Spring `@LoadBalanced` calls fail.

**Diagnose.**

```bash
consul catalog services
consul health service orders-service
dig @127.0.0.1 -p 8600 orders-service.service.consul SRV
```

Spring cache stale? `spring.cloud.consul.discovery.catalog-services-watch-delay=1000`.

**Fix.** Verify `spring.cloud.consul.discovery.service-name` override vs `application.name`. Refresh discovery cache TTL.

---

## 5. Service Discovery — Kubernetes Native

### Core concept

In Kubernetes, you often **do not need Eureka/Consul**. A **Service** is a stable ClusterIP (or headless DNS) backed by **Endpoints** (Pod IPs). The control plane watches Pod readiness and updates Endpoints automatically. CoreDNS resolves `orders-service.namespace.svc.cluster.local`.

Spring Cloud Kubernetes bridges K8s API → Spring Cloud DiscoveryClient so `lb://orders-service` works inside the cluster without Eureka.

```
Pod (orders-service-abc123)
  ├─ readiness probe → pass → Endpoints controller adds IP
  ├─ liveness probe → fail → kubelet restart container
  └─ Service "orders-service" selector app=orders-service
       └─ DNS A record → ClusterIP → kube-proxy/Cilium → Pod IP:8080
```

### Spring Cloud Kubernetes discovery

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-kubernetes-client-all</artifactId>
</dependency>
```

```yaml
spring:
  application:
    name: orders-service
  cloud:
    kubernetes:
      discovery:
        enabled: true
        all-namespaces: false
      reload:
        enabled: true
        mode: event
        strategy: refresh
```

```java
// Same @LoadBalanced RestTemplate / WebClient / Gateway lb:// URI
@Bean
@LoadBalanced
RestTemplate restTemplate() {
    return new RestTemplate();
}
```

Direct K8s DNS (no Spring Cloud discovery):

```java
// Explicit — good for simple setups
@Value("${ORDERS_SERVICE_URL:http://orders-service.default.svc.cluster.local:8080}")
String ordersBaseUrl;
```

### K8s Service and Deployment manifest

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-service
  labels:
    app: orders-service
spec:
  type: ClusterIP
  selector:
    app: orders-service
  ports:
    - port: 80
      targetPort: 8080
      protocol: TCP
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orders-service
  template:
    metadata:
      labels:
        app: orders-service
    spec:
      containers:
        - name: orders-service
          image: registry/orders-service:2.1.0
          ports:
            - containerPort: 8080
          env:
            - name: SPRING_PROFILES_ACTIVE
              value: prod
```

### Ingress vs in-cluster Gateway

| Layer | Use when |
|---|---|
| NGINX Ingress / ALB Ingress | North-south HTTP routing into cluster |
| Spring Cloud Gateway Deployment | Need Spring filters, OAuth2, custom Java logic at edge |
| Service mesh (Istio/Linkerd) | mTLS, traffic split, observability without app changes |

Many teams: **Ingress → Gateway Deployment → microservices**.

### Production scenario: headless service for StatefulSet but used with Deployment

**Problem.** `clusterIP: None` headless service with Deployment — DNS returns all ready Pod IPs but clients cache poorly; uneven load without proper client LB.

**Solution.** Standard ClusterIP Service for Deployments. Headless for StatefulSet stable network ID (`pod-0.orders`, `pod-1.orders`).

### Production scenario: cross-namespace discovery

**Problem.** Gateway in `platform` namespace; services in `orders` namespace. `lb://orders-service` finds nothing.

**Solution.**

```yaml
spring.cloud.kubernetes.discovery.namespaces: orders,payments,platform
```

Or FQDN: `orders-service.orders.svc.cluster.local`. RBAC: ServiceAccount needs `get/list/watch` on Endpoints/Pods in target namespaces.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: orders
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "endpoints"]
    verbs: ["get", "list", "watch"]
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Service selector doesn't match Pod labels | Empty Endpoints; permanent 502 |
| `targetPort` ≠ container port | Connection refused |
| Readiness never passes | Pods running but no Endpoints |
| Spring Cloud K8s discovery without RBAC | 403 from API server; empty instance list |
| Using `localhost` inside pod for inter-service calls | Works in dev only |

### Debugging scenario

**Observe.** `kubectl get pods` shows Running; Service has no endpoints.

**Diagnose.**

```bash
kubectl describe pod orders-service-xxx
kubectl get endpoints orders-service -o yaml
kubectl exec -it gateway-pod -- curl -v http://orders-service:80/actuator/health
```

Check readiness probe failures in `kubectl describe`.

**Fix.** Align probe port/path with `server.port` and context path.

---

## 6. Load Balancing — Client, Server, and Gateway

### Core concept

Load balancing distributes requests across instances. In microservices:

| Type | Where | Examples |
|---|---|---|
| **Server-side (L4/L7)** | Before apps | AWS ALB/NLB, F5, NGINX Ingress, cloud LB |
| **Client-side** | In calling app | Spring Cloud LoadBalancer, Eureka+Ribbon (legacy), gRPC client LB |
| **Gateway-side** | Edge router | Spring Cloud Gateway `lb://`, Envoy, Kong upstream |

Spring Cloud **removed Netflix Ribbon**; use **Spring Cloud LoadBalancer** (`spring-cloud-starter-loadbalancer`).

### Internal working — Spring Cloud LoadBalancer

1. `LoadBalancerClientFactory` creates per-service `ReactiveLoadBalancer` bean.
2. `RoundRobinLoadBalancer` (default) cycles instances from `ServiceInstanceListSupplier`.
3. Supplier sources: Eureka, Consul, K8s discovery, static list.
4. `CachingServiceInstanceListSupplier` caches list; TTL default may delay seeing new instances.
5. `RetryLoadBalancerInterceptor` (RestTemplate) or reactive filter retries on next instance.

```yaml
spring:
  cloud:
    loadbalancer:
      cache:
        ttl: 5s
        capacity: 256
      retry:
        enabled: true
      configurations: default  # or zone-preference, same-instance-preference
```

### RestTemplate and WebClient

```java
@Configuration
public class ClientConfig {

    @Bean
    @LoadBalanced
    RestTemplate restTemplate(RestTemplateBuilder builder) {
        return builder
            .setConnectTimeout(Duration.ofSeconds(2))
            .setReadTimeout(Duration.ofSeconds(10))
            .build();
    }

    @Bean
    @LoadBalanced
    WebClient.Builder loadBalancedWebClientBuilder() {
        return WebClient.builder();
    }
}

@Service
public class OrderClient {
    private final RestTemplate rest;

    OrderClient(@LoadBalanced RestTemplate rest) {
        this.rest = rest;
    }

    Order getOrder(long id) {
        // orders-service resolves via discovery — NOT a real DNS name on bare metal without registry
        return rest.getForObject("http://orders-service/orders/{id}", Order.class, id);
    }
}
```

Reactive:

```java
return webClient.get()
    .uri("http://payments-service/payments/{id}", id)
    .retrieve()
    .bodyToMono(Payment.class);
```

### Weighted and custom load balancing

```java
@Configuration
public class CustomLoadBalancerConfig {

    @Bean
    ReactorLoadBalancer<ServiceInstance> randomLoadBalancer(
            Environment env,
            LoadBalancerClientFactory factory) {
        String name = env.getProperty(LoadBalancerClientFactory.PROPERTY_NAME);
        return new RandomLoadBalancer(
            factory.getLazyProvider(name, ServiceInstanceListSupplier.class),
            name);
    }
}
```

Metadata-based routing (canary):

```java
public class VersionPreferenceLoadBalancer implements ReactorServiceInstanceLoadBalancer {
    // filter instances where metadata version=canary for internal testers
    // fallback to stable instances
}
```

### Production scenario: retry storm amplifies outage

**Problem.** `payments-service` degraded. Every caller retries 3x across 5 instances. Effective load 15x. Complete meltdown.

**Solution.** Retry only idempotent ops; cap attempts; use circuit breaker; bulkhead thread pools.

```yaml
resilience4j:
  circuitbreaker:
    instances:
      payments:
        slidingWindowSize: 50
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
  retry:
    instances:
      payments:
        maxAttempts: 2
        waitDuration: 200ms
        enableExponentialBackoff: true
```

### Production scenario: sticky sessions without thinking

**Problem.** `SameInstancePreferenceServiceInstanceListSupplier` + scale-down kills session pod. Users logged out.

**Solution.** Stateless JWT/cookies in Redis; avoid instance stickiness unless required (WebSocket). If required, use consistent hash on connection id at gateway.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Missing `@LoadBalanced` | UnknownHostException for service name |
| RestTemplate timeout infinite | Thread pool exhaustion cascades |
| LoadBalancer cache TTL too high during fast scale-up | Under-utilized new pods |
| Zone preference with all instances in one zone | No instances available error |
| HTTP retry on connection refused without backoff | Retry storm |

### Debugging scenario

**Observe.** Uneven load — one pod at 100% CPU, siblings idle.

**Diagnose.** Check algorithm (round-robin vs single long-lived connection reuse). HTTP/2 multiplexing to one connection? Client-side connection pool pinning?

For Gateway:

```yaml
spring.cloud.gateway.httpclient.pool.maxConnections: 500
```

**Fix.** Ensure multiple connections per host; verify instance list size in DEBUG logs.

---

## 7. Configuration Management — Local and Externalized

### Core concept

**Configuration management** is how runtime behavior (URLs, pool sizes, feature toggles, secrets) is supplied to services without rebuilding artifacts. The **12-factor** rule: store config in environment, not in the JAR.

Spring Boot hierarchy (later overrides earlier):

```
1. application.yml (in JAR)
2. application-{profile}.yml
3. OS environment variables
4. Command-line args
5. Spring Cloud Config Server (if bootstrap/import)
6. Kubernetes ConfigMap / Secret mounted as env or files
7. Vault / AWS Parameter Store / Secrets Manager integrations
```

### Internal working — property binding

- `@ConfigurationProperties` binds prefix to immutable or validated bean.
- `@Value` for single keys — harder to test and refresh.
- `@RefreshScope` beans recreate on `/actuator/refresh` or Bus event — **only for `@RefreshScope` beans**, not all properties.

```java
@ConfigurationProperties(prefix = "orders")
@Validated
public record OrdersProperties(
    @NotNull Duration exportTimeout,
    @Min(1) int maxPageSize,
    boolean enableLegacyApi) {}
```

```yaml
orders:
  export-timeout: 30s
  max-page-size: 500
  enable-legacy-api: false
```

### Externalized config without Config Server

```yaml
# application-prod.yml — non-secret defaults
spring:
  datasource:
    url: jdbc:postgresql://${DB_HOST:postgres}:5432/orders
    username: ${DB_USER}
    password: ${DB_PASSWORD}
```

K8s ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: orders-service-config
data:
  application-prod.yml: |
    orders:
      max-page-size: 1000
    logging:
      level:
        com.company.orders: INFO
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: orders-service
          envFrom:
            - configMapRef:
                name: orders-service-config
          volumeMounts:
            - name: config
              mountPath: /config
              readOnly: true
          env:
            - name: SPRING_CONFIG_ADDITIONAL_LOCATION
              value: "file:/config/"
```

### Production scenario: config drift between regions

**Problem.** `us-east` manually edited ConfigMap; `eu-west` stale. Different pagination limits; support tickets "works in US not EU."

**Solution.** GitOps (Argo CD / Flux) — ConfigMaps from repo. Single source of truth. Config Server with branch per environment.

### Production scenario: secret in application.yml committed to Git

**Problem.** DB password in repo history. Compliance incident.

**Solution.** Secrets only via K8s Secret, Vault, or cloud SM. Sealed Secrets / SOPS for GitOps. **Never** `@RefreshScope` on secrets without rotation plan.

```yaml
spring:
  datasource:
    password: ${DB_PASSWORD}  # from K8s secretKeyRef
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Same profile name `prod` in dev and prod different meaning | Wrong DB wiped |
| Missing validation on `@ConfigurationProperties` | App starts with `maxPageSize=0` |
| Relaxed binding typo `orders.max-pageSize` | Silent default; feature off |
| ConfigMap change without pod restart (no reload) | Old behavior until rollout |
| Giant monolithic ConfigMap for all services | Blast radius on bad edit |

### Debugging scenario

**Observe.** Property "clearly set" in ConfigMap but app uses default.

**Diagnose.**

```bash
curl http://pod:8080/actuator/env | jq '.propertySources[] | select(.name | contains("config"))'
kubectl exec pod -- env | grep ORDERS
```

Check `SPRING_PROFILES_ACTIVE`, property key spelling, and precedence.

**Fix.** Use `/actuator/env` to see winning source. Document precedence in runbook.

---

## 8. Centralized Configuration — Spring Cloud Config Server

### Core concept

**Spring Cloud Config Server** provides a **central Git-backed (or JDBC/Vault) property source** served over HTTP. Clients fetch on bootstrap and optionally refresh without full redeploy for `@RefreshScope` beans.

```
Git repo (config-repo)
  └─ orders-service-prod.yml
  └─ application.yml (shared)
       └─ Config Server (serves /{app}/{profile}/{label})
            └─ Microservice bootstrap → merge into Environment
                 └─ /actuator/refresh → Bus → all instances
```

### Config Server setup

```java
@SpringBootApplication
@EnableConfigServer
public class ConfigServerApplication { }
```

```yaml
# config-server application.yml
server:
  port: 8888
spring:
  application:
    name: config-server
  cloud:
    config:
      server:
        git:
          uri: https://github.com/company/config-repo
          default-label: main
          search-paths: '{application}'
          clone-on-start: true
          force-pull: true
        encrypt:
          enabled: true
```

Encrypted value in repo:

```yaml
spring:
  datasource:
    password: '{cipher}AQA...encrypted...'
```

Client:

```yaml
spring:
  application:
    name: orders-service
  config:
    import: optional:configserver:http://config-server:8888
  cloud:
    config:
      fail-fast: true
      retry:
        max-attempts: 6
        initial-interval: 1000
```

Boot 2.4+ uses `spring.config.import` instead of bootstrap.yml (bootstrap still works with `spring-cloud-starter-bootstrap`).

### Shared configuration pattern

```
config-repo/
  application.yml          # all services
  application-prod.yml     # all prod
  orders-service.yml
  orders-service-prod.yml
  gateway-prod.yml
```

```yaml
# application-prod.yml — shared
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
eureka:
  client:
    service-url:
      defaultZone: http://eureka:8761/eureka/
```

### Spring Cloud Bus refresh

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-bus-amqp</artifactId>
</dependency>
```

```bash
curl -X POST http://config-server:8888/actuator/busrefresh
# or single service
curl -X POST http://orders-service:8080/actuator/refresh
```

Only `@RefreshScope` beans pick up changes. DataSource pool size change may need restart.

### Production scenario: Config Server unavailable at cold start

**Problem.** `fail-fast: true` + Config Server maintenance → all pods fail startup. Full platform down.

**Solution.**

```yaml
spring:
  config:
    import: optional:configserver:http://config-server:8888
```

Ship **sensible defaults** in local `application.yml` for bootstrapping. Config Server adds/overrides. Monitor Config Server like a tier-0 dependency — HA deployment, Git mirror, health checks.

### Production scenario: refresh pushed bad YAML — fleet-wide outage

**Problem.** Typo disables datasource URL. `/actuator/busrefresh` hits 40 services. All orders APIs down.

**Solution.** PR review on config-repo; CI validates yaml; canary refresh one instance first; avoid `@RefreshScope` on critical infrastructure beans; blue/green config labels:

```yaml
spring.cloud.config.label: release-2026-08-31
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `spring.application.name` doesn't match repo file prefix | Wrong or empty config |
| No encryption for secrets in Git | Credential leak |
| Bootstrap imports Config Server but not Eureka order | Chicken-and-egg if config has eureka URL only in Config Server |
| RefreshScope on `@ConfigurationProperties` without `@RefreshScope` on dependent beans | Partial config apply; inconsistent state |
| `optional:` import removed "to catch errors" | Hard dependency outage |

### Debugging scenario

**Observe.** One service missing property others have.

**Diagnose.**

```bash
curl http://config-server:8888/orders-service/prod/main
curl http://orders-pod:8080/actuator/configprops
```

Check label/branch, profile active, and search-paths.

**Fix.** Align naming; merge shared `application.yml`; verify import order in logs at DEBUG:

```yaml
logging.level.org.springframework.cloud.config=DEBUG
```

---

## 9. Health Checks — Actuator, Aggregates, and Custom Indicators

### Core concept

**Health checks** expose whether a service and its dependencies are functioning. Spring Boot Actuator aggregates `HealthIndicator` beans into `/actuator/health` with status `UP`, `DOWN`, `OUT_OF_SERVICE`, `UNKNOWN`.

Used by: load balancers, Eureka/Consul agents, Kubernetes probes, PagerDuty, Grafana alerts.

```
/actuator/health
  ├─ diskSpace          UP
  ├─ db                 UP
  ├─ redis              DOWN  → aggregate DOWN (unless grouped)
  ├─ ping               UP
  └─ custom/kafka       UP
```

### Internal working

- `HealthEndpoint` collects all `HealthIndicator` / `ReactiveHealthIndicator`.
- `HealthContributorRegistry` auto-registers classpath indicators (DataSource, Redis, etc.).
- Groups (`liveness`, `readiness`) filter which contributors affect probe endpoints.
- Boot 2.3+: `management.endpoint.health.probes.enabled=true` adds `/actuator/health/liveness` and `/actuator/health/readiness`.

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true
      show-details: when_authorized
      group:
        readiness:
          include: readinessState,db,redis
          show-details: always
        liveness:
          include: livenessState,diskSpace
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true
    db:
      enabled: true
    redis:
      enabled: true
```

### Custom HealthIndicator

```java
@Component
public class PaymentGatewayHealthIndicator implements HealthIndicator {

    private final PaymentClient client;

    PaymentGatewayHealthIndicator(PaymentClient client) {
        this.client = client;
    }

    @Override
    public Health health() {
        try {
            if (client.ping()) {
                return Health.up().withDetail("provider", "stripe-bridge").build();
            }
            return Health.down().withDetail("reason", "ping false").build();
        } catch (Exception ex) {
            return Health.down(ex).build();
        }
    }
}
```

**Rule:** Custom checks should be **fast** (<1s) and **cached** if expensive — probe interval × replicas = QPS to dependency.

```java
@Component
public class CachedPartnerHealthIndicator implements HealthIndicator {
    private volatile Health last = Health.unknown().build();
    private final AtomicLong lastCheck = new AtomicLong(0);

    @Override
    public Health health() {
        long now = System.currentTimeMillis();
        if (now - lastCheck.get() > 30_000) {
            lastCheck.set(now);
            last = doCheck();
        }
        return last;
    }
}
```

### Production scenario: health endpoint triggers write in dependency

**Problem.** Custom indicator calls `POST /partner/sync` as "health check." Partner rate-limits; health flaps; K8s restarts pods.

**Solution.** Dedicated `GET /health` or HEAD on partner side. Never side-effect health checks.

### Production scenario: aggregate health DOWN blocks wrong layer

**Problem.** `/actuator/health` DOWN because optional analytics DB unreachable. Eureka marks instance DOWN. Core API withdrawn.

**Solution.** Use groups. Readiness includes only **required** deps. Optional deps as separate metric, not readiness.

```yaml
management:
  endpoint:
    health:
      group:
        readiness:
          include: readinessState,db
        optional:
          include: redis,analyticsDb
  health:
    group:
      optional:
        show-components: always
```

Expose optional group on different path for dashboards only.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Actuator on same port, unsecured `/actuator/env` | Credential leak |
| Health check hits DB with max pool exhausted | Health check fails → death spiral |
| Slow health (> probe timeout) | Flapping NotReady / restarts |
| `show-details: always` in prod | Info disclosure (versions, URLs) |
| DiskSpaceHealthIndicator on ephemeral container filling logs | Random restarts |

### Debugging scenario

**Observe.** Manual `/actuator/health` UP; K8s readiness failing.

**Diagnose.** Probe may hit different port/path:

```yaml
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
```

Check `server.servlet.context-path`:

```yaml
readinessProbe:
  httpGet:
    path: /api/actuator/health/readiness  # if context-path=/api
```

**Fix.** Align probe path; split management port:

```yaml
management:
  server:
    port: 8081
```

---

## 10. Liveness Probes — When to Kill the Pod

### Core concept

**Liveness** answers: "Should this process be **restarted**?" If liveness fails, kubelet **kills and recreates** the container. Use for **deadlocks, unrecoverable corruption, infinite loop** — not for "downstream DB is down."

Spring Boot 2.3+ `LivenessStateHealthIndicator` tracks internal application lifecycle:

- `CORRECT` → UP
- `BROKEN` → DOWN (signal broken state explicitly in app code)

```java
@Component
public class DeadlockDetector implements ScheduledTask {
    private final ApplicationAvailability availability;

    @Scheduled(fixedDelay = 5000)
    void check() {
        if (ThreadMXBean.findDeadlockedThreads() != null) {
            availability.onApplicationEvent(new AvailabilityChangeEvent<>(
                LivenessState.BROKEN, this, LivenessState.BROKEN));
        }
    }
}
```

### Kubernetes liveness probe

```yaml
livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8080
  initialDelaySeconds: 60
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

| Parameter | Guidance |
|---|---|
| `initialDelaySeconds` | Must exceed cold start (JVM + Spring context) |
| `periodSeconds` | 10–30s typical |
| `failureThreshold` | 3 failures → restart (30s with 10s period) |
| `timeoutSeconds` | < periodSeconds; account for GC pauses |

### Production scenario: liveness includes database

**Problem.** RDS blip 30s. Liveness probe includes `db` indicator → fails → kubelet kills all 20 pods → thundering herd on startup → extended outage.

**Solution.** **Never** put external dependencies in liveness. Only process health:

```yaml
management:
  endpoint:
    health:
      group:
        liveness:
          include: livenessState,diskSpace
```

DB belongs in **readiness**, not liveness.

### Production scenario: JVM heap exhaustion — liveness still UP

**Problem.** App in GC thrash; requests timeout; liveness `/actuator/health/liveness` still UP (ping responds). Pods never restart.

**Solution.** Custom indicator: if GC time > threshold or thread pool saturated N minutes, set `LivenessState.BROKEN`. Or use **OOMKilled** via memory limits:

```yaml
resources:
  limits:
    memory: 1Gi
```

Combine memory limit (hard kill) with app-level BROKEN signal (graceful).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Liveness too aggressive (initialDelay 10s on Boot app) | CrashLoopBackOff during normal start |
| Same path for liveness and readiness with full aggregate | DB blip restarts all pods |
| TCP socket probe on wrong port | Immediate kill loop |
| exec probe `curl localhost` missing in slim image | Permanent failure |

### Debugging scenario

**Observe.** Pod restart count climbing; `kubectl describe pod` shows `Liveness probe failed`.

**Diagnose.**

```bash
kubectl logs pod --previous
kubectl describe pod | grep -A5 Liveness
```

Hit liveness path during incident:

```bash
kubectl exec -it pod -- curl -s -o /dev/null -w "%{http_code}" localhost:8080/actuator/health/liveness
```

**Fix.** Widen initial delay; remove heavy checks from liveness; fix app hang root cause.

---

## 11. Readiness Probes — When to Route Traffic

### Core concept

**Readiness** answers: "Should this instance **receive traffic**?" Failure removes Pod from Service Endpoints **without** restarting the container. Use for: warming caches, waiting for migrations, dependency unavailable, graceful drain.

```
Startup → context loading → readiness FAIL (no traffic)
       → db migration done → readiness PASS → Endpoints include Pod
       → kafka lag high (optional policy) → readiness FAIL → drained, not killed
       → shutdown started → readiness FAIL → drain then terminate
```

### Spring ReadinessState

```java
// Defer readiness until warm-up complete
@Component
public class CacheWarmupRunner implements ApplicationRunner {
    private final ApplicationAvailability availability;

    @Override
    public void run(ApplicationArguments args) {
        availability.onApplicationEvent(new AvailabilityChangeEvent<>(
            ReadinessState.REFUSING_TRAFFIC, this, ReadinessState.REFUSING_TRAFFIC));
        warmCaches();
        availability.onApplicationEvent(new AvailabilityChangeEvent<>(
            ReadinessState.ACCEPTING_TRAFFIC, this, ReadinessState.ACCEPTING_TRAFFIC));
    }
}
```

### Kubernetes readiness probe

```yaml
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  initialDelaySeconds: 30
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
  successThreshold: 1
startupProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  failureThreshold: 30
  periodSeconds: 10
```

**Startup probe** (K8s 1.16+): protects slow-starting apps without killing liveness. Until startup succeeds, liveness ignored.

### Production scenario: rolling deploy — mixed schema version

**Problem.** New pods Ready before Flyway migration completes on shared DB (misordered init). Old and new code incompatible.

**Solution.** Run migrations as **Job** or init container before Deployment rollout. Readiness includes migration version check:

```java
@Component
public class SchemaVersionHealthIndicator implements HealthIndicator {
    @Override
    public Health health() {
        int required = 42;
        int current = jdbc.queryForObject("SELECT version FROM schema_version", Integer.class);
        return current >= required
            ? Health.up().build()
            : Health.down().withDetail("schema", current).build();
    }
}
```

### Production scenario: readiness flaps on Kafka consumer lag

**Problem.** Lag spikes during rebalance; readiness fails; pod drained; rebalance worsens.

**Solution.** Do not tie HTTP API readiness to Kafka lag unless HTTP handlers truly cannot serve. Separate consumer health metric; HPA on consumer group lag.

### Graceful drain via readiness (preview)

On shutdown hook, flip readiness to REFUSING_TRAFFIC **before** stopping Netty:

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

See [Section 12](#12-graceful-shutdown--zero-downtime-deploys).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No startupProbe; slow Boot app | Liveness kills during startup |
| Readiness same as liveness path `/actuator/health` | Transitive dependency failure restarts pod |
| successThreshold too high with single success | Slow rollouts |
| Readiness passes before Eureka registration | Brief 502 at gateway during register delay |

### Debugging scenario

**Observe.** Deployment stuck `0/3 ready` but logs show "Started Application."

**Diagnose.** Readiness failing silently:

```bash
kubectl describe pod | grep -A10 Readiness
curl localhost:8080/actuator/health/readiness | jq .
```

**Fix.** Identify DOWN component; fix dependency or adjust readiness group membership.

---

## 12. Graceful Shutdown — Zero-Downtime Deploys

### Core concept

**Graceful shutdown** ensures in-flight requests complete, message consumers finish current batch, and the instance **deregisters from discovery** before the process exits — avoiding 502/connection reset during rolling deploys and scale-in.

Spring Boot 2.3+:

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

Sequence:

```
SIGTERM received
  ├─ Spring ContextClosedEvent
  ├─ SmartLifecycle / GracefulShutdown (Tomcat/Netty stops accepting new connections)
  ├─ Eureka/Consul deregister (if configured)
  ├─ Readiness → REFUSING_TRAFFIC (K8s removes from Endpoints)
  ├─ In-flight requests complete (up to timeout)
  └─ Process exit 0
```

### Eureka graceful deregister

```yaml
eureka:
  client:
    should-deregister-on-shutdown: true
    should-enforce-registration-at-init: false
```

Spring Cloud handles deregister on shutdown when `should-deregister-on-shutdown=true`.

### Kubernetes preStop hook

Endpoints update is **not instantaneous**. Add sleep to allow drain:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 15"]
terminationGracePeriodSeconds: 60
```

Full pattern:

```yaml
spec:
  terminationGracePeriodSeconds: 90
  containers:
    - name: orders-service
      lifecycle:
        preStop:
          httpGet:
            path: /actuator/health/readiness
            port: 8080
      # readiness fails when shutdown starts — combined with preStop sleep
```

Better: application sets readiness REFUSING on SIGTERM immediately; preStop sleep 10–15s for Endpoints propagation and gateway cache TTL.

### Tomcat vs Netty

Servlet (Tomcat):

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

WebFlux/Gateway (Netty): same properties; Netty `GracefulShutdown` waits for active connections.

### Kafka / JMS listeners

```yaml
spring:
  kafka:
    listener:
      shutdown-timeout: 30s
```

```java
@Bean
DefaultMessageListenerContainer container() {
    container.setShutdownTimeout(30_000);
    return container;
}
```

Stop accepting new messages early in shutdown phase.

### Production scenario: K8s kills pod at 30s with active checkout

**Problem.** `terminationGracePeriodSeconds: 30` but payment call takes 45s. SIGKILL mid-transaction.

**Solution.** Increase grace period; align `timeout-per-shutdown-phase`; idempotent payment IDs; readiness drain before heavy shutdown; client timeouts < grace period.

```yaml
terminationGracePeriodSeconds: 120
spring.lifecycle.timeout-per-shutdown-phase: 90s
```

### Production scenario: Eureka deregister after process dead

**Problem.** SIGKILL (OOM) — no deregister. Stale instance 90s.

**Solution.** Short Eureka eviction; client retry; K8s preStop; Istio outlier detection. Prefer K8s Endpoints for faster convergence.

### Production scenario: Gateway still routes during drain

**Problem.** Pod removed from K8s Endpoints but Gateway LoadBalancer cache TTL 35s still includes instance.

**Solution.**

```yaml
spring.cloud.loadbalancer.cache.ttl: 5s
```

Coordinate deploy speed with cache TTL. Rolling update `maxUnavailable: 0`, `maxSurge: 1`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `server.shutdown=immediate` | Connection resets on every deploy |
| No preStop; instant SIGTERM kill | 502 spike proportional to QPS |
| Shutdown timeout < longest request | Forced kill mid-request |
| HPA scale-down without PDB | All pods terminated concurrently |
| `@Scheduled` jobs ignore shutdown | Duplicate batch runs after restart |

### Debugging scenario

**Observe.** Error rate spike exactly during deploy window.

**Diagnose.** Compare deploy timestamp with 502/499 (client disconnect) metrics. Check gateway upstream connect failures. Trace single request across deploy.

**Fix.** Implement graceful shutdown end-to-end; verify deregister in Eureka UI during roll; load test deploy under traffic in staging.

---

## 13. Spring Cloud LoadBalancer and Service-to-Service Calls

### Core concept

After Ribbon retirement, **every** `lb://` URI and `@LoadBalanced` client uses Spring Cloud LoadBalancer. Understand instance list suppliers and lifecycle integration.

### Dependency

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-loadbalancer</artifactId>
</dependency>
<!-- plus eureka-client OR kubernetes-client OR consul-discovery -->
```

### Multiple discovery backends

Avoid classpath conflicts — pick one primary discovery for a service. Mixing Eureka + K8s without `@Primary` supplier causes unpredictable lists.

```yaml
spring:
  cloud:
    discovery:
      client:
        composite-indicator:
          enabled: true
    loadbalancer:
      ribbon:
        enabled: false  # legacy guard
```

### Production scenario: WebClient bypasses load balancer

**Problem.** `WebClient.create("http://orders-service")` without `@LoadBalanced` builder — DNS fails.

**Solution.**

```java
@Bean
@LoadBalanced
WebClient.Builder webClientBuilder() {
    return WebClient.builder();
}

// inject builder
WebClient client = webClientBuilder.build();
```

Or use `ReactorLoadBalancerExchangeFilterFunction` explicitly in WebFlux apps.

### Production scenario: HTTPS to internal services

**Problem.** Instances register as HTTP; mTLS required by policy.

**Solution.** Service mesh sidecar terminates mTLS; app still HTTP to localhost sidecar. Or register `secure=true`, `port=443` in metadata; custom `ServiceInstance` URI logic.

---

## 14. Resilience at the Edge — Timeouts, Retries, Circuit Breakers

### Core concept

Service management includes **failure containment** at gateway and clients. Spring Cloud Circuit Breaker (Resilience4j) integrates with Gateway filters.

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: orders
          uri: lb://orders-service
          filters:
            - name: CircuitBreaker
              args:
                name: ordersCb
                fallbackUri: forward:/fallback/orders
resilience4j:
  circuitbreaker:
    instances:
      ordersCb:
        slidingWindowSize: 100
        permittedNumberOfCallsInHalfOpenState: 10
        failureRateThreshold: 50
        waitDurationInOpenState: 20s
  timelimiter:
    instances:
      ordersCb:
        timeoutDuration: 5s
```

Fallback controller:

```java
@RestController
public class FallbackController {
    @GetMapping("/fallback/orders")
    public Mono<ResponseEntity<Map<String, String>>> ordersFallback() {
        return Mono.just(ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
            .body(Map.of("error", "orders temporarily unavailable")));
    }
}
```

### Bulkhead at gateway

Limit concurrent outbound connections per route:

```yaml
spring.cloud.gateway.httpclient.pool:
  maxConnections: 500
  acquireTimeout: 45s
```

Separate gateway replicas HPA on connection saturation.

---

## 15. Multi-Environment, Profiles, and Feature Flags

### Profile strategy

```
local     → H2, embedded Redis, no Config Server
dev       → shared dev cluster, relaxed secrets
staging   → prod-like, anonymized data
prod      → strict validation, no debug endpoints
```

```yaml
spring:
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:local}
```

**Anti-pattern:** `prod` profile on laptop connecting to prod DB via VPN typo.

### Feature flags

```java
@ConfigurationProperties(prefix = "features")
public record FeatureFlags(boolean newCheckoutFlow, boolean legacyExport) {}

@RestController
public class OrderController {
    @GetMapping("/orders/export")
    ResponseEntity<?> export(@AuthenticationPrincipal User u) {
        if (flags.newCheckoutFlow()) {
            return newExport();
        }
        return legacyExport();
    }
}
```

Integrate LaunchDarkly/Unleash for dynamic flags; Config Server for semi-static toggles with refresh.

---

## 16. Observability — Metrics, Tracing, and Service Identity

### Service identity in logs and traces

```yaml
spring:
  application:
    name: orders-service
management:
  tracing:
    sampling:
      probability: 0.1
  metrics:
    tags:
      application: ${spring.application.name}
      environment: ${ENV:local}
```

Structured logging:

```yaml
logging:
  pattern:
    level: "%5p [${spring.application.name:},%X{traceId:-},%X{spanId:-}]"
```

### Key metrics for service management

| Metric | Alert on |
|---|---|
| `discovery.client.registration.status` | Not REGISTERED |
| `spring.cloud.gateway.requests` 5xx rate | Edge failures |
| `resilience4j.circuitbreaker.state` | OPEN sustained |
| K8s `kube_pod_status_ready` | Not ready > N min |
| Eureka renewal rate drop | Registry instability |

---

## 17. Security at the Gateway and Between Services

### mTLS and service identity

Zero-trust: gateway validates JWT; service-to-service uses mTLS (mesh) or OAuth2 client credentials.

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          orders-to-payments:
            provider: company-idp
            client-id: orders-service
            client-secret: ${CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: payments.read
```

Propagate trace and auth carefully — `Authorization` header relay at gateway; downstream validates signature.

### Actuator exposure

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    health:
      show-details: when_authorized
```

NetworkPolicy: only Prometheus scrapes metrics port; only ops VPN reaches actuator admin.

---

## 18. Testing Service Infrastructure

### Contract tests through gateway

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
@AutoConfigureWebTestClient
class GatewayRoutingTest {
    @Autowired WebTestClient client;

    @Test
    void routesOrdersPath() {
        client.get().uri("/api/orders/1")
            .headers(h -> h.setBearerAuth(testToken()))
            .exchange()
            .expectStatus().isOk();
    }
}
```

### Testcontainers — Eureka + service

```java
@Container
static GenericContainer<?> eureka = new GenericContainer<>("steeltoeoss/eureka-server:latest")
    .withExposedPorts(8761);
```

Verify registration before assertions.

### Chaos tests

- Kill pod during load test — error rate within SLO?
- Config Server down — new pods still start with optional import?
- Network partition between AZs — self-preservation behavior understood?

---

## 19. Migration Playbook — Eureka/Consul to Kubernetes

### Phased approach

```
Phase 1: Containerize; keep Eureka; deploy to K8s with Eureka server in cluster
Phase 2: Dual registration — K8s Service + Eureka (bridge period)
Phase 3: Gateway uses K8s discovery for migrated services; Eureka for legacy VMs
Phase 4: Decommission Eureka when last VM service migrates
```

### Dual discovery bridge

Run both clients temporarily:

```yaml
spring:
  cloud:
    kubernetes:
      discovery:
        enabled: true
    discovery:
      client:
        composite-indicator:
          enabled: true
```

Validate `lb://` resolves merged instance list.

### Checklist per service

- [ ] `spring.application.name` matches K8s Service name
- [ ] Probes configured (startup, readiness, liveness)
- [ ] Graceful shutdown + preStop
- [ ] Config via ConfigMap/Secret or Config Server reachable from cluster
- [ ] RBAC for K8s discovery
- [ ] Remove Eureka client dependency when cutover complete

---

## 20. Common Production Failures Catalog

| Failure | Signature | First response |
|---|---|---|
| Registry stale | Intermittent 502 to dead IP | Lower cache TTL; verify deregister on shutdown |
| Thundering herd on cold start | All pods NotReady then simultaneous Ready | Stagger rollout; startupProbe; cache warmup |
| Config typo bus-refreshed | Correlated 500 all services | Rollback config commit; restart if needed |
| Gateway OOM | Edge 502, Netty direct buffer | Increase memory; reduce body buffer; limit concurrent routes |
| DB in liveness | Mass pod restart on DB fail | Move DB to readiness only |
| Missing `@LoadBalanced` | UnknownHost in inter-service calls | Fix bean config |
| Eureka self-preservation | Zombie instances after partition | Client retry; zone LB; long-term K8s |
| preStop too short | Deploy 502 spike | Increase sleep; readiness drain |
| Retry on POST | Duplicate charges | Idempotency keys; restrict retry methods |
| Cross-namespace RBAC | Empty discovery in gateway | Fix RoleBinding |

---

## 21. Production Debugging Playbook

When traffic is "randomly" failing at the platform layer, walk this order:

1. **Classify the error.** 502 = no healthy upstream. 503 = circuit open / rate limit / deliberate unavailable. 504 = timeout. 499 = client gave up (often during deploy). Connection reset = shutdown not graceful.

2. **Edge first.** Gateway access logs + route id. Which `lb://` target? Actuator `/actuator/gateway/routes`. Confirm route predicate matched intended service.

3. **Registry / Endpoints.** Eureka app status vs K8s `kubectl get endpoints`. Count UP instances vs Deployment replicas.

4. **Instance health.** Direct curl to pod IP bypassing gateway: `/actuator/health/readiness`. Compare with aggregate health.

5. **Recent change.** Deploy? Config refresh? Scale event? Certificate rotation?

6. **Load balancer cache.** Spring Cloud LoadBalancer TTL; Eureka client refresh interval; Consul watch delay.

7. **Probe configuration.** `kubectl describe pod` — liveness vs readiness paths, failure counts, OOMKilled.

8. **Graceful shutdown timeline.** Correlate SIGTERM with error spike duration. If spike ≈ cache TTL + preStop, fix drain.

9. **Enable targeted DEBUG on one canary** — never whole fleet:

   ```yaml
   logging.level.org.springframework.cloud.gateway=DEBUG
   logging.level.org.springframework.cloud.loadbalancer=DEBUG
   logging.level.com.netflix.discovery=DEBUG
   ```

10. **Turn DEBUG off.** Includes instance IPs, tokens in headers if logged.

Actuator `/actuator/env` and `/actuator/configprops` expose secrets if not sanitized — restrict by network and `show-values`.

---

## 22. Quick Decision Matrix

| Situation | Do this |
|---|---|
| All services on Kubernetes | Native Service DNS; Spring Cloud K8s discovery optional; skip Eureka |
| VMs + autoscaling, no K8s | Eureka or Consul; 2+ registry nodes; client retry |
| Need edge OAuth2 + Java filters | Spring Cloud Gateway Deployment behind Ingress |
| Simple path routing only | NGINX Ingress annotations; skip Gateway JVM |
| Central config for 50+ services | Config Server + Git repo + PR review; optional Bus refresh |
| Secrets in config | Vault / K8s Secrets / cloud SM; encrypt in Git if Config Server |
| Deploy causes 502 spike | Graceful shutdown + preStop + readiness drain + lower LB cache TTL |
| DB down | Readiness fails; liveness stays UP |
| JVM deadlock suspected | Custom liveness BROKEN signal or restart via OOM limit |
| Slow Boot (2+ min) | startupProbe; increase initialDelaySeconds |
| Idempotent GET APIs through gateway | Retry filter on 502/503 with backoff |
| POST payment APIs | No gateway retry; idempotency keys in service |
| Multi-AZ uneven errors | Zone-aware load balancing + instance metadata |
| Hybrid migration | Dual discovery bridge; migrate service-by-service |
| Health check load on DB | Readiness group only; cache expensive checks |
| Zero-trust internal | mTLS mesh or client credentials between services |

---

## 23. Scenario-Based Questions

**Q1: After deploy, gateway returns 502 for 60 seconds then recovers. Eureka shows instances UP throughout. What happened?**

**A:** Likely readiness/liveness passed before app truly ready, or K8s Endpoints lag + LoadBalancer cache TTL + missing preStop caused traffic to terminating pods. Eureka heartbeats don't guarantee HTTP readiness. Fix: startupProbe, readiness includes critical deps, preStop sleep 10–15s, `spring.cloud.loadbalancer.cache.ttl=5s`, verify graceful shutdown deregistration order.

**Q2: All pods CrashLoopBackOff after Config Server maintenance window. Root cause and immediate fix?**

**A:** `spring.config.import=configserver:` without `optional:` and `fail-fast: true` — pods cannot bootstrap. Immediate: restore Config Server or temporarily deploy with `SPRING_CONFIG_IMPORT=optional:configserver:...` and local fallback yaml in ConfigMap. Permanent: HA Config Server, optional import, cached config in image for tier-1 break-glass defaults only (non-secret).

**Q3: Intermittent 502 — roughly 5% — only on one service. Other services fine. Eureka shows 4 instances, one marked UP but unreachable.**

**A:** Classic stale/zombie instance — self-preservation, slow eviction, or killed VM still registered. Client round-robin hits dead node. Verify with direct curl to each instance IP:port. Lower eviction interval carefully, enable client retry, fix graceful deregister, consider K8s Endpoints for faster removal. Disable self-preservation only with ops understanding of network partition trade-offs.

**Q4: Kubernetes shows 3/3 Running but Service has `<none>` endpoints. Gateway 502. Diagnosis?**

**A:** Readiness probe failing — pods Running but not Ready. Check `kubectl describe pod` readiness failures, wrong port/path, context-path mismatch, DB not reachable at boot. Fix probe path `/actuator/health/readiness`, startupProbe for slow apps, fix dependency. Less common: Service selector label mismatch with Pod labels.

**Q5: Rolling deploy kills active long-running report downloads. Users see truncated files. Fix?**

**A:** `terminationGracePeriodSeconds` too short vs report duration; no graceful shutdown; readiness not withdrawn first. Increase grace period and `spring.lifecycle.timeout-per-shutdown-phase`, implement readiness REFUSING on shutdown, preStop delay for endpoint propagation, consider async report job with polling instead of long HTTP through gateway (gateway timeout often 30s anyway).

**Q6: `@LoadBalanced RestTemplate` call to `http://inventory-service/...` throws UnknownHostException on developer laptop but works in K8s.**

**A:** Local machine has no Eureka/Consul/K8s DNS resolving `inventory-service`. Developer needs local profile with explicit URL, `/etc/hosts`, or Testcontainers registry. In cluster, ensure discovery client enabled and service registered. Missing `@LoadBalanced` annotation also causes literal hostname resolution failure everywhere.

**Q7: Gateway CircuitBreaker stuck OPEN; fallback returns 503 for all users even though orders-service recovered.**

**A:** Resilience4j waitDurationInOpenState not elapsed, or downstream still failing health from gateway network perspective (NetworkPolicy blocking gateway→orders). Check `actuator/circuitbreakers`, gateway pod connectivity, half-open test calls. Tune sliding window; verify security groups; ensure recovery verified with probe from gateway pod not laptop.

**Q8: `/actuator/busrefresh` after config change; some pods old behavior, some new.**

**A:** Only `@RefreshScope` beans refresh; `@ConfigurationProperties` records need `@RefreshScope` on `@Bean` method or restart. Bus message not received by all instances (Rabbit partition, missing bus dependency on some services). Verify each pod `/actuator/env` for property value. Prefer rolling restart for non-refresh-safe properties like connection pool max size.

**Q9: Liveness probe kills pods every 2 minutes during normal load. GC logs show frequent long pauses.**

**A:** Liveness timeout too aggressive for GC (e.g., 1s timeout, 10s period, 3 failures during STW GC). Increase timeoutSeconds and failureThreshold; tune JVM heap/G1; **do not** add DB to liveness. Consider larger nodes or ZGC if latency SLO requires. Separate symptom: heap too small → OOMKilled — different fix (memory limits).

**Q10: Readiness includes Redis; Redis cluster maintenance → all API pods NotReady → total outage. Was readiness wrong?**

**A:** If Redis is cache-only (not required for core reads/writes), yes — readiness should not include optional cache. Remove redis from readiness group; monitor cache miss latency separately. If Redis is session store and required, readiness correct but need Redis HA and maintenance window procedure with traffic shift.

**Q11: Two Eureka servers in prod; split-brain after network partition. Different instance lists per client.**

**A:** Eureka peer replication broken — asymmetric network, wrong `service-url` peer list, or registering server as client incorrectly. Run 3+ nodes in odd number; verify peer sync in server logs; clients should list all servers in `defaultZone`. During partition, prefer availability but monitor stale data; migrate critical workloads to K8s for CP endpoint control.

**Q12: Spring Cloud Gateway memory grows until OOM during file upload proxy. Cause?**

**A:** Default buffers entire body in memory for some filter chains. Large uploads through Gateway without streaming exhaust direct memory. Fix: increase appropriate buffer limits cautiously, route large uploads directly to service (bypass gateway), use `spring.codec.max-in-memory-size`, or dedicated upload ingress. Monitor Netty direct buffer metrics.

**Q13: Consul health check flapping WARN/CRITICAL on healthy service. Only on one AZ.**

**A:** Agent connectivity or latency to service health endpoint from that AZ — security group, MTU, DNS to wrong pod IP, overloaded node. Compare `consul health service` with manual curl from same agent host. Increase `health-check-critical-timeout`; fix network path; ensure check hits lightweight liveness not full aggregate.

**Q14: How do you implement zero-downtime deploy for stateful WebSocket service behind Gateway?**

**A:** Sticky sessions or shared pub/sub backplane (Redis) so connections survive instance drain; on deploy, stop new WebSockets via readiness, wait for existing sessions to close or timeout, preStop + grace period exceeding max session idle. Gateway may need `lb:sticky` or header-based routing. Cannot simply round-robin WebSockets without shared state.

**Q15: Service discovers 0 instances for `lb://payments-service` in K8s but `kubectl get svc payments-service` exists.**

**A:** Spring Cloud Kubernetes discovery RBAC denied, wrong namespace (`all-namespaces: false`), or Gateway ServiceAccount lacks list/watch on Endpoints in `payments` namespace. Fix Role/RoleBinding. Alternative: use full DNS `http://payments-service.payments.svc.cluster.local` without discovery client. Verify `spring.cloud.kubernetes.discovery.enabled=true` and correct dependency on classpath.

**Q16: POST /api/payments duplicated charges after gateway 502. User clicked once.**

**A:** Gateway or client retried POST on idempotent-unsafe operation. Disable retry for POST at gateway; implement `Idempotency-Key` header in payments-service stored in DB with unique constraint. Return same response for duplicate key. Audit Resilience4j retry config on Feign/WebClient too.

**Q17: Flyway migration on pod startup; old pods still running new code fails on new column. What went wrong?**

**A:** Expand-contract migration violated — additive deploy order wrong. New code deployed before schema compatible with old code, or migration ran after traffic switched. Fix: backward-compatible migrations first; run migration Job before Deployment update; use readiness until schema version matches; blue/green with feature flag for new column usage.

**Q18: How to choose Eureka vs Consul vs K8s native for greenfield 2026?**

**A:** All-in on Kubernetes → native Service + optional Spring Cloud K8s; skip Eureka unless team mandate. Multi-cloud VMs + K8s hybrid → Consul if want DNS + KV + mesh; Eureka if Spring-centric Netflix stack already. Greenfield pure K8s: Eureka adds operational burden with little benefit over Endpoints + CoreDNS.

**Q19: `management.server.port=8081` — probes still hit 8080 and fail. Explain.**

**A:** Actuator on separate management port but probes configured on main port 8080 where `/actuator/health` may be disabled or not exposed. Fix probe port 8081 or expose health on main port via `management.endpoint.health.probes.add-additional-paths` (Boot 3.4+) or unified port policy. Document in Deployment manifest.

**Q20: HorizontalPodAutoscaler scales up; new pods get no traffic; old pods saturated.**

**A:** LoadBalancer cache stale instance list; or new pods failing readiness slowly; or HPA based on CPU but bottleneck is thread pool not CPU. Check readiness on new pods, LB cache TTL, Eureka registration delay metadata. Verify HPA metric matches bottleneck (queue depth, request latency via KEDA).

**Q21: Config Server Git repo has `orders-service-prod.yml` but service loads empty custom properties.**

**A:** `spring.application.name` mismatch (`order-service` vs `orders-service`), wrong profile (`production` vs `prod`), wrong label/branch, or import order overridden by empty env var. curl Config Server directly: `/{name}/{profile}/{label}`. Check `optional:` import silently skipped if server down at first start with cached default.

**Q22: During zone failure, zone-preference load balancing causes 'No servers available'. Why?**

**A:** All instances in local zone down but other zones healthy — zone preference too strict without fallback. Configure `spring.cloud.loadbalancer.zone` correctly per instance metadata; use `ZonePreferenceLoadBalancer` fallback to all zones when local empty; combine with Eureka zone affinity settings and regional gateway deployments.

---

*The registry tells callers where instances are; readiness tells the platform which instances should receive traffic; graceful shutdown tells everyone when an instance is leaving. Get those three contracts right and most "random" microservice outages stop being random.*
