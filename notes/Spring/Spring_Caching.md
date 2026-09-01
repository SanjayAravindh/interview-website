# Spring Cache Abstraction — Senior Production Reference

Spring Framework 6.x / Spring Boot 3.x implementation view. This document is the **annotation, SPI, and wiring layer** — what `@Cacheable` actually does, how `CacheManager` beans resolve, where AOP fails silently, and how cache operations interact with `@Transactional`. Architectural theory — cache-aside vs read-through, CAP trade-offs, stampede math, Redis cluster topology — lives in `notes/microservices/caching.md`. Read that first if you need the *why*; this note is the *how it breaks on Tuesday*.

---

## Table of Contents

1. [Mental Model: Spring Cache Is AOP Around a Key-Value Store](#1-mental-model-spring-cache-is-aop-around-a-key-value-store)
2. [@EnableCaching and Boot Auto-Configuration](#2-enablecaching-and-boot-auto-configuration)
3. [CacheManager SPI and Cache Abstraction](#3-cachemanager-spi-and-cache-abstraction)
4. [@Cacheable, @CachePut, @CacheEvict, and @Caching](#4-cacheable-cacheput-cacheevict-and-caching)
5. [Cache Keys: SpEL, KeyGenerator, and Key Design](#5-cache-keys-spel-keygenerator-and-key-design)
6. [Self-Invocation and AOP Proxy Limits](#6-self-invocation-and-aop-proxy-limits)
7. [@Cacheable and @Transactional Interaction](#7-cacheable-and-transactional-interaction)
8. [Caffeine Local Cache (L1)](#8-caffeine-local-cache-l1)
9. [Redis Distributed Cache (L2)](#9-redis-distributed-cache-l2)
10. [Multi-Level Caching (L1 Caffeine + L2 Redis)](#10-multi-level-caching-l1-caffeine-l2-redis)
11. [Cache Stampede and Thundering Herd](#11-cache-stampede-and-thundering-herd)
12. [Cache Invalidation Strategies](#12-cache-invalidation-strategies)
13. [Security: Tenant Isolation, Sensitive Data, and Cache Poisoning](#13-security-tenant-isolation-sensitive-data-and-cache-poisoning)
14. [Observability: Metrics, Tracing, and Error Handling](#14-observability-metrics-tracing-and-error-handling)
15. [Testing Cache Configuration](#15-testing-cache-configuration)
16. [Hibernate Second-Level Cache (Brief)](#16-hibernate-second-level-cache-brief)
17. [HTTP Caching (Brief)](#17-http-caching-brief)
18. [Anti-Patterns Catalog](#18-anti-patterns-catalog)
19. [Production Debugging Playbook](#19-production-debugging-playbook)
20. [Quick Decision Matrix](#20-quick-decision-matrix)

---


## 1. Mental Model: Spring Cache Is AOP Around a Key-Value Store

Spring Cache is not a cache. It is a **thin AOP interceptor** (`CacheInterceptor`) that wraps `@Cacheable`/`@CachePut`/`@CacheEvict` methods, delegates to a `CacheManager`, and stores **return values** in a backing store (Caffeine, Redis, etc.). The framework never loads your database for you on a miss — your method body runs, then the result is stored. That makes Spring Cache **cache-aside by construction**, not read-through.

```
HTTP request
  └─ Controller
       └─ Service method (@Cacheable on public method of Spring bean)
            └─ CacheInterceptor (AOP proxy — JDK or CGLIB)
                 ├─ CacheOperationSource parses annotations
                 ├─ KeyGenerator / SpEL → cache key string
                 ├─ Cache.get(key) → hit? return cached value, skip method
                 └─ miss → invoke target method → Cache.put(key, result)
                      └─ CacheManager → Cache implementation (Caffeine / Redis / …)
```

Four objects you must keep distinct:

| Object | Question it answers | Typical type |
|---|---|---|
| `CacheInterceptor` | When does lookup/put/evict run relative to method? | `CacheAspectSupport` subclass, ordered at `@Order` |
| `CacheManager` | Which named `Cache` handles `"products"`? | `RedisCacheManager`, `CaffeineCacheManager`, `CompositeCacheManager` |
| `Cache` | How is one key stored and retrieved? | `RedisCache`, `CaffeineCache`, `ConcurrentMapCache` |
| Backing store | Where do bytes live? | JVM heap (Caffeine), Redis server, EhCache disk |

A **cache hit** means the interceptor returned a stored value without calling your method. A **cache miss** means your method ran and (usually) populated the cache. **Invalidation** is `@CacheEvict` or TTL expiry — Spring does not magically know your DB changed.

### What Spring Cache does NOT do

| Expectation | Reality |
|---|---|
| Automatic invalidation on DB write | You must `@CacheEvict` or TTL; JPA/Hibernate changes do not propagate |
| Cache null by default | `@Cacheable` caches null unless `unless="#result == null"` or `disableCachingNullValues()` |
| Work on private/self-invoked methods | AOP proxy bypass — method always runs, no cache |
| Distribute invalidation across pods | Only if backing store is shared (Redis) and you evict the same key everywhere |
| Prevent stampede | `sync=true` helps on supported stores; not a full lock service |
| Reactive `Mono`/`Flux` caching | Aspect caches the publisher, not the emitted value — manual pattern required |

### Production scenario: "We added @Cacheable and latency got worse"

**Problem.** Team annotates every repository method. P99 rises above pre-cache baseline. Redis CPU moderate; DB load unchanged.

**Cause.** SpEL key includes unstable data (`#root.args[0].toString()` on mutable DTO). Every call is a miss. Large serialized graphs (500KB JSON) add Redis RTT + Jackson overhead. No L1; every pod hits Redis per request.

**Solution.**

1. Audit keys — stable per entity: `#productId`, not timestamps or object identity.
2. Cache **slim DTOs**, not entity graphs with lazy collections.
3. Add L1 Caffeine in front of Redis for hot read paths (section 10).
4. Measure hit ratio before blaming Redis.

See `notes/microservices/caching.md` section 1 for the full stack mental model and pattern composition.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Cacheable` on repository interface without proxy | Annotations ignored |
| Multiple `CacheManager` beans, no `@Primary` / `@Qualifier` | Wrong store or startup failure |
| Caching JPA entities with lazy associations | `LazyInitializationException` or huge serialized graphs |
| `GenericJackson2JsonRedisSerializer` without type info | `ClassCastException` or `LinkedHashMap` on read |
| Test profile uses `ConcurrentMapCacheManager`, prod Redis | "Works in CI, fails in prod" |

### Debugging scenario

**Observe.** `@Cacheable` present but Redis `MONITOR` shows no `GET` for that endpoint.

**Diagnose.**

1. Confirm method is on a Spring bean and **public**.
2. Confirm call comes from **outside** the class (not self-invocation).
3. Log `CacheInterceptor` at DEBUG: `logging.level.org.springframework.cache=TRACE`.
4. Check `@ConditionalOnProperty` — is caching disabled in this profile?

**Fix.** Extract cached method to another bean, or use `ApplicationContext.getBean()` self-invocation workaround (prefer separate bean).

---

## 2. @EnableCaching and Boot Auto-Configuration

### Core concept

Caching is **opt-in**. Without `@EnableCaching`, annotations are parsed but **no advisor is registered** — methods run normally, no cache interaction. Spring Boot's `CacheAutoConfiguration` adds `@EnableCaching` when `spring-boot-starter-cache` is on the classpath and `@EnableCaching` is not already present.

### Minimal setup

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
```

```java
@SpringBootApplication
@EnableCaching
public class Application { }
```

Boot 3 auto-configures a `CacheManager` based on classpath:

| Classpath contains | Default `CacheManager` |
|---|---|
| Caffeine | `CaffeineCacheManager` |
| EhCache (Jakarta) | `JcacheCacheManager` |
| Hazelcast | `HazelcastCacheManager` |
| Redis (`spring-boot-starter-data-redis`) | `RedisCacheManager` |
| None of the above | `NoOpCacheManager` (no-op — **silent no caching**) |

**Critical:** If you only add `spring-boot-starter-cache` without a provider, Boot creates `NoOpCacheManager`. Annotations execute but store nothing. Always verify which manager is active.

### Verify at startup

```yaml
logging:
  level:
    org.springframework.boot.autoconfigure.cache: DEBUG
```

Look for: `Cache manager type: RedisCacheManager` or `NoOpCacheManager`.

Actuator (when enabled):

```bash
curl -s localhost:8080/actuator/caches | jq .
```

### `@EnableCaching` attributes

```java
@EnableCaching(
    proxyTargetClass = true,  // CGLIB proxies — required if no interfaces
    mode = AdviceMode.PROXY,  // PROXY (default) or ASPECTJ (compile-time weaving)
    order = Ordered.LOWEST_PRECEDENCE - 1  // relative to @Transactional, @Async
)
```

| Attribute | When to change |
|---|---|
| `proxyTargetClass = true` | Concrete classes without interfaces; avoids JDK proxy limitation |
| `mode = ASPECTJ` | Rare — load-time weaving, no Spring proxy for self-invocation (still need external calls) |
| `order` | Cache vs transaction ordering — see section 7 |

### `spring.cache.*` Boot properties

```yaml
spring:
  cache:
    type: redis          # force type: caffeine, redis, jcache, hazelcast, none
    cache-names: products, orders, referenceData
    caffeine:
      spec: maximumSize=10000,expireAfterWrite=300s
    redis:
      time-to-live: 600000   # ms — default TTL for all Redis caches
      cache-null-values: false
      use-key-prefix: true
      key-prefix: "myapp:"
    jcache:
      config: classpath:ehcache.xml
```

`spring.cache.type=none` disables caching entirely — useful for perf tests measuring uncached baseline.

### `CachingConfigurer` / `CachingConfigurerSupport`

Implement when you need global customizations:

```java
@Configuration
@EnableCaching
public class CacheConfig implements CachingConfigurer {

    @Override
    public CacheManager cacheManager() {
        return new ConcurrentMapCacheManager("demo");
    }

    @Override
    public KeyGenerator keyGenerator() {
        return (target, method, params) ->
            method.getName() + Arrays.deepHashCode(params);
    }

    @Override
    public CacheResolver cacheResolver() {
        return null; // default
    }

    @Override
    public CacheErrorHandler errorHandler() {
        return new CustomCacheErrorHandler(); // section 14
    }
}
```

When `CachingConfigurer.cacheManager()` is defined, it **overrides** auto-configured manager unless you also define `@Bean CacheManager` — know which wins in your project.

### Production scenario: caching "enabled" but nothing in Redis

**Problem.** `@EnableCaching` present, `@Cacheable` on service, Redis running, but keys never appear.

**Cause.** `spring.cache.type=caffeine` in prod YAML while team expects Redis. Or `NoOpCacheManager` because Redis starter missing from runtime classpath.

**Solution.** Check `/actuator/beans` for `cacheManager` bean class. Align `spring.cache.type` and dependencies. Add integration test with Testcontainers Redis asserting key creation.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@EnableCaching` on wrong `@Configuration` not scanned | No cache advisor |
| `spring.cache.type=none` in prod profile | All annotations no-op |
| Missing provider dependency | `NoOpCacheManager` |
| `@EnableCaching` duplicated in library and app | Usually harmless; verify single `CacheManager` |

---

## 3. CacheManager SPI and Cache Abstraction

### Core concept

`CacheManager` is the **factory** for named `Cache` instances. `@Cacheable("products")` resolves `cacheManager.getCache("products")`. If the cache name does not exist, behavior depends on implementation — `ConcurrentMapCacheManager` creates on demand; `RedisCacheManager` may return null unless pre-configured.

### Interface hierarchy

```
org.springframework.cache.CacheManager
  └─ getCache(String name) → Cache
  └─ getCacheNames() → Collection<String>

org.springframework.cache.Cache
  └─ getName()
  └─ get(key) → ValueWrapper | null
  └─ get(key, Class<T>) → T
  └─ get(key, Callable<T>) → T   // load on miss — used by sync=true
  └─ put(key, value)
  └─ evict(key)
  └─ clear()
  └─ invalidate()  // since Spring 6.1 — alias for clear in some impls
```

### Built-in implementations

| Implementation | Backing | Production use |
|---|---|---|
| `ConcurrentMapCacheManager` | JVM `ConcurrentHashMap` | Tests, dev only — no TTL, not shared |
| `CaffeineCacheManager` | Caffeine | L1 local, high perf |
| `RedisCacheManager` | Redis via Lettuce | L2 distributed |
| `CompositeCacheManager` | Multiple managers | L1 + L2 layering |
| `NoOpCacheManager` | Nothing | Disabled / misconfigured |
| `JcacheCacheManager` | EhCache, etc. | Enterprise L2 local |
| `HazelcastCacheManager` | Hazelcast cluster | Distributed with partition awareness |

### Defining a `CacheManager` bean

```java
@Configuration
public class RedisCacheConfig {

    @Bean
    @Primary
    RedisCacheManager cacheManager(RedisConnectionFactory factory) {
        Map<String, RedisCacheConfiguration> perCache = Map.of(
            "products", RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(5)),
            "referenceData", RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofHours(24))
        );

        return RedisCacheManager.builder(factory)
            .cacheDefaults(RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(10))
                .disableCachingNullValues())
            .withInitialCacheConfigurations(perCache)
            .transactionAware()
            .build();
    }
}
```

### Multiple `CacheManager` beans

```java
@Bean @Primary
CacheManager redisCacheManager(...) { ... }

@Bean
CacheManager localCacheManager(...) { ... }
```

Without qualification, `@Cacheable` uses `@Primary`. To route specific caches:

```java
@EnableCaching
public class App implements CachingConfigurer {
    @Override
    public CacheResolver cacheResolver() {
        return new NamedCacheResolver(localCacheManager()) {
            // or custom resolver mapping cache names → managers
        };
    }
}
```

Or per-annotation:

```java
@Cacheable(cacheNames = "products", cacheManager = "redisCacheManager")
@Cacheable(cacheNames = "referenceData", cacheManager = "localCacheManager")
```

### `CacheWriter` and low-level Redis control

`RedisCacheManager.builder(connectionFactory).cacheWriter(cacheWriter)` allows custom write behavior — non-locking writer (default), locking writer for `sync=true` stampede mitigation.

```java
RedisCacheWriter writer = RedisCacheWriter.nonLockingRedisCacheWriter(connectionFactory);
// or lockingRedisCacheWriter for sync=true
```

### `CacheStatistics` (Spring Framework 6)

Some implementations expose stats via `Cache#retrieveCacheStatistics()`:

```java
Optional<CacheStatistics> stats = cache.retrieveCacheStatistics();
stats.ifPresent(s -> log.info("hits={}, misses={}", s.getHits(), s.getMisses()));
```

Caffeine and Redis support varies — verify your version.

### Production scenario: `@Cacheable("orders")` throws "Cannot find cache"

**Problem.** First request fails with cache not found.

**Cause.** `RedisCacheManager` without `withInitialCacheConfigurations` and dynamic creation disabled in newer Spring Data Redis versions.

**Solution.** Pre-declare cache names:

```yaml
spring:
  cache:
    cache-names: orders, products, users
```

Or use `RedisCacheManager.builder(factory).initialCacheNames(Set.of("orders", "products"))`.

### Debugging scenario

**Observe.** Wrong TTL for one cache.

**Diagnose.** Check per-cache `RedisCacheConfiguration` vs global defaults. Order: per-cache config overrides `cacheDefaults`.

**Fix.** Explicit map in builder; avoid relying on implicit defaults across environments.

---

## 4. @Cacheable, @CachePut, @CacheEvict, and @Caching

### Annotation reference

| Annotation | Method invoked on hit? | Cache effect |
|---|---|---|
| `@Cacheable` | **No** (unless `sync=true` contended miss) | Return cached value; skip method |
| `@CachePut` | **Always** | Store return value; useful for forced refresh |
| `@CacheEvict` | **Always** | Remove key(s) before or after method |
| `@Caching` | — | Compose multiple of the above |
| `@CacheConfig` | — | Class-level `cacheNames`, `keyGenerator`, `cacheManager` defaults |

### `@Cacheable`

```java
@Service
@CacheConfig(cacheNames = "products")
public class ProductService {

    @Cacheable(key = "#id")
    public ProductDto findById(long id) {
        return repo.findById(id).map(mapper::toDto).orElseThrow();
    }

    @Cacheable(key = "#sku", condition = "#sku != null", unless = "#result == null")
    public ProductDto findBySku(String sku) { ... }

    @Cacheable(key = "#id", sync = true)  // stampede mitigation — section 11
    public ProductDto findByIdContended(long id) { ... }
}
```

**Flow on `@Cacheable`:**

1. Interceptor evaluates `condition` — false → proceed without cache.
2. Generate key via SpEL or `KeyGenerator`.
3. `cache.get(key)` — hit → return value (method **not** called).
4. Miss → invoke method.
5. Evaluate `unless` — true → return without storing.
6. `cache.put(key, result)`.

### `@CachePut`

Always runs the method. Use when you **must** execute logic and refresh cache:

```java
@CachePut(key = "#result.id")
public UserDto updateUser(long id, UserUpdateRequest req) {
    User saved = repo.save(...);
    return mapper.toDto(saved);
}
```

**Pitfall:** `@CachePut` on create when key is `#result.id` but ID not yet assigned — key becomes `null`. Prefer `@CacheEvict` on related keys or cache after ID exists.

### `@CacheEvict`

```java
@CacheEvict(key = "#id")
public void deleteProduct(long id) { repo.deleteById(id); }

@CacheEvict(allEntries = true)  // entire cache partition — expensive on Redis
public void rebuildIndex() { ... }

@Caching(evict = {
    @CacheEvict(cacheNames = "products", key = "#id"),
    @CacheEvict(cacheNames = "productLists", allEntries = true)
})
public void updateProduct(long id, ProductUpdate u) { ... }
```

| Attribute | Effect |
|---|---|
| `beforeInvocation = true` | Evict **before** method — if method throws, cache already cleared |
| `beforeInvocation = false` (default) | Evict **after** success |
| `allEntries = true` | Clear entire named cache — dangerous at scale |

### `@CacheConfig` at class level

```java
@CacheConfig(cacheNames = "orders", cacheManager = "redisCacheManager")
public class OrderQueryService { ... }
```

Methods inherit defaults; method-level attributes override.

### Return type considerations

| Return type | Caching behavior |
|---|---|
| `Optional<T>` | Caches the `Optional` wrapper — empty Optional is a cached miss |
| `void` | `@Cacheable` useless; `@CacheEvict` valid |
| Collections | Cached by reference in local cache — **do not mutate** returned list |
| Mutable entities | **Never cache** — callers corrupt shared instance |

### Production scenario: update method caches stale data

**Problem.** `@Cacheable` on getter, manual DB update via `@Modifying` query, getter still returns old DTO.

**Cause.** No `@CacheEvict` on update path.

**Solution.**

```java
@CacheEvict(key = "#id")
@Transactional
public void updatePrice(long id, BigDecimal price) {
    repo.updatePrice(id, price);
}
```

Or TTL short enough for acceptable staleness — document the contract.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@CachePut` key `#result.id` on pre-insert | Null key pollution |
| `@CacheEvict` missing on write path | Stale reads until TTL |
| `allEntries=true` on hot cache | Redis CPU spike, latency storm |
| `@Cacheable` on method returning mutable singleton | Corruption across requests |

---

## 5. Cache Keys: SpEL, KeyGenerator, and Key Design

### Core concept

The cache key is a **String** (or `Object` converted via `SimpleKey`) that uniquely identifies the cached entry. Collisions cause wrong data served. Unstable keys cause permanent misses.

### Default key generation

If `key` attribute is empty:

| Params | Generated key |
|---|---|
| None | `SimpleKey.EMPTY` |
| One | That param value |
| Many | `SimpleKey(params...)` — uses `Arrays.deepHashCode` / equals |

**Problem:** Default key on complex objects uses `equals`/`hashCode` — if not overridden, identity hash → constant misses or wrong hits.

### SpEL key expressions

```java
@Cacheable(value = "products", key = "#id")
@Cacheable(value = "products", key = "'sku:' + #sku")
@Cacheable(value = "search", key = "#query + ':' + #page + ':' + #size")
@Cacheable(value = "users", key = "#user.id", condition = "#user.id != null")
@Cacheable(value = "tenantCatalog", key = "T(com.app.TenantContext).get() + ':' + #productId")
@Cacheable(value = "reports", key = "#root.methodName + ':' + #date.format(T(java.time.format.DateTimeFormatter).ISO_LOCAL_DATE)")
```

**SpEL root object variables:**

| Variable | Meaning |
|---|---|
| `#root.methodName` | Method name |
| `#root.target` | Target bean |
| `#root.caches` | Cache names |
| `#paramName` / `#p0` / `#a0` | Method arguments |
| `#result` | Return value (`@CachePut`, `unless` on `@Cacheable`) |

### Custom `KeyGenerator`

```java
@Bean
KeyGenerator tenantAwareKeyGenerator() {
    return (target, method, params) -> {
        String tenant = TenantContext.require();
        return tenant + ":" + method.getName() + ":" + Arrays.stream(params)
            .map(p -> p == null ? "null" : p.toString())
            .collect(Collectors.joining(":"));
    };
}
```

Use with `@CacheConfig(keyGenerator = "tenantAwareKeyGenerator")` or `@Cacheable(keyGenerator = "tenantAwareKeyGenerator")`.

### Multi-tenant key discipline

**Always** embed tenant ID in key or cache name:

```java
@Cacheable(cacheNames = "products", key = "T(TenantContext).get() + ':' + #id")
```

Separate cache namespace per tenant is safer for bulk evict:

```java
@Cacheable(cacheNames = "products-#{T(TenantContext).get()}", key = "#id")
```

(SpEL in `cacheNames` requires `@Cacheable` cache resolver support — prefer explicit tenant in key for portability.)

### Redis key prefix

Spring Data Redis adds `cacheName::` prefix by default:

```
products::42
myapp:products::sku:ABC-123   // with spring.cache.redis.key-prefix
```

Use `use-key-prefix: true` and consistent `key-prefix` per environment to avoid cross-env collisions on shared Redis.

### Key design checklist

| Rule | Reason |
|---|---|
| Stable for same logical query | Hits |
| Include all dimensions of variation | Prevent wrong sharing |
| Include tenant / user scope when data is scoped | Security |
| Avoid serializing huge objects into key | Memory, slow hashing |
| Document key schema in team wiki | On-call debugging |

### Production scenario: cache key collision across tenants

**Problem.** Tenant A sees Tenant B's product name.

**Cause.** `@Cacheable(key = "#id")` without tenant — same product ID across tenants.

**Fix.** Add tenant to key. Add integration test asserting isolation.

### Debugging scenario

Log resolved keys at TRACE:

```yaml
logging:
  level:
    org.springframework.cache.interceptor: TRACE
```

Compare with Redis:

```bash
redis-cli KEYS 'products*'
redis-cli GET 'products::42'
```

---

## 6. Self-Invocation and AOP Proxy Limits

### Core concept

Spring Cache uses **AOP proxies**. Annotations apply only when the caller goes through the proxy. **Same-class calls bypass the proxy** — `@Cacheable` is ignored.

```java
@Service
public class OrderService {

    public OrderDto getOrder(long id) {
        return this.findByIdCached(id);  // ❌ self-invocation — NO CACHE
    }

    @Cacheable("orders")
    public OrderDto findByIdCached(long id) { ... }
}
```

This is the **same failure mode** as `@Transactional` self-invocation — see `notes/Spring/Spring_Data_JPA_and_Transactions.md` section 14.

### Fixes (prefer top to bottom)

**1. Extract to another bean (best):**

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderCacheService orderCache;

    public OrderDto getOrder(long id) {
        return orderCache.findByIdCached(id);
    }
}

@Service
public class OrderCacheService {
    @Cacheable("orders")
    public OrderDto findByIdCached(long id) { ... }
}
```

**2. Inject self (acceptable with `@Lazy`):**

```java
@Service
public class OrderService {
    private final OrderService self;

    public OrderService(@Lazy OrderService self) {
        this.self = self;
    }

    public OrderDto getOrder(long id) {
        return self.findByIdCached(id);
    }

    @Cacheable("orders")
    public OrderDto findByIdCached(long id) { ... }
}
```

**3. `AopContext.currentProxy()` (requires `@EnableAspectJAutoProxy(exposeProxy = true)`):**

```java
((OrderService) AopContext.currentProxy()).findByIdCached(id);
```

Fragile — avoid in new code.

### Other AOP limits

| Case | Cached? |
|---|---|
| `public` method, external call | Yes |
| `protected` / `package` / `private` | **No** |
| `final` method (CGLIB) | **No** |
| Method on non-Spring object | **No** |
| `@Cacheable` on `@Controller` | Yes but **wrong layer** — cache service layer |
| Reactive return without special handling | Caches broken publisher |

### Production scenario: "Cache works in Postman, not from internal batch"

**Problem.** Direct HTTP hits cache; scheduled job does not.

**Cause.** Job calls `this.loadCached()` internally; HTTP goes through proxy from controller → service.

**Fix.** Extract cached loader to separate bean; inject into both paths.

### Debugging scenario

Add temporary logging at start of `@Cacheable` method. If it logs on every HTTP request, cache is missing. Use `@Profile("debug")` aspect counting invocations vs cache hits (section 14).

---

## 7. @Cacheable and @Transactional Interaction

### Core concept

Default cache put happens **after method returns successfully**, but **independent of transaction commit**. If the method runs inside `@Transactional` and the transaction **rolls back**, a default cache may still hold the written value — **dirty cache**.

```
@Transactional
@CachePut(key = "#result.id")
public OrderDto update(OrderDto dto) {
    // DB update throws after return — or rollback after put
}
```

### `transactionAware()` CacheManager

```java
RedisCacheManager.builder(factory)
    .transactionAware()
    .build();
```

With `transactionAware()`:

- `put` and `evict` are **deferred** until transaction **commits**.
- On rollback, cache operations are discarded.

**Requirements:**

1. `@Transactional` must run through Spring proxy (same self-invocation rules).
2. `CacheManager` must support transaction awareness — `RedisCacheManager` yes; plain `CaffeineCacheManager` **no** (local JVM, no rollback sync with DB).

### Ordering: cache vs transaction advisors

Both `@EnableCaching` and `@EnableTransactionManagement` register advisors. Default order: `@Transactional` outer or inner depending on `@Order`. Typical desired behavior:

- **Read:** `@Cacheable` short-circuits before transaction if hit — no DB, no tx.
- **Write:** Transaction commits, then cache evict/put visible.

If `@Cacheable` miss opens read-only transaction, ensure `readOnly=true` for connection optimization.

### Read-only transaction + cache

```java
@Transactional(readOnly = true)
@Cacheable(key = "#id")
public ProductDto findById(long id) { ... }
```

On hit, transaction may still open (method entered) unless cache intercepts first — advisor order matters. For read-heavy paths, many teams remove `@Transactional` from pure cached reads.

### `@CacheEvict` and rollback

`beforeInvocation = false` (default): evict after method success. If method throws, entry remains — usually correct.

`beforeInvocation = true`: evict before method. If method throws, cache already cleared — can cause temporary stampede on retries.

### Production scenario: rolled-back order still in cache

**Problem.** Create order fails validation after save attempt; cache shows order exists.

**Cause.** `@CachePut` without `transactionAware()`.

**Solution.** Enable `transactionAware()` on Redis cache manager; verify `@Transactional` on write service.

### Caffeine + DB consistency

Local L1 is **not** transaction-aware with DB. Pattern:

- Write path: `@CacheEvict` local + Redis on successful commit (or pub/sub invalidation).
- Accept brief L1 staleness or skip L1 on writes.

See `notes/microservices/caching.md` section 14 for consistency models.

---

## 8. Caffeine Local Cache (L1)

### Core concept

Caffeine is the **default local cache** for Spring Boot when `com.github.ben-manes.caffeine:caffeine` is on classpath. Nanosecond-scale reads, per-JVM isolation, automatic eviction (size, time). Ideal L1 in front of Redis.

### Dependency and auto-config

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
<dependency>
  <groupId>com.github.ben-manes.caffeine</groupId>
  <artifactId>caffeine</artifactId>
</dependency>
```

```yaml
spring:
  cache:
    type: caffeine
    caffeine:
      spec: maximumSize=50000,expireAfterWrite=60s,recordStats
    cache-names: referenceData, productSummary
```

### Programmatic `CaffeineCacheManager`

```java
@Bean
CacheManager caffeineCacheManager() {
    CaffeineCacheManager manager = new CaffeineCacheManager();
    manager.setCaffeine(Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofSeconds(30))
        .expireAfterAccess(Duration.ofMinutes(5))
        .recordStats());
    manager.setCacheNames(List.of("productSummary", "referenceData"));
    return manager;
}
```

Per-cache specs require custom manager subclass or multiple managers:

```java
@Bean
CacheManager caffeineCacheManager() {
    SimpleCacheManager manager = new SimpleCacheManager();
    manager.setCaches(List.of(
        new CaffeineCache("productSummary", Caffeine.newBuilder()
            .maximumSize(10_000).expireAfterWrite(Duration.ofSeconds(30)).build()),
        new CaffeineCache("referenceData", Caffeine.newBuilder()
            .maximumSize(500).expireAfterWrite(Duration.ofHours(1)).build())
    ));
    manager.initializeCaches();
    return manager;
}
```

### When to use Caffeine only (no Redis)

| Fit | Misfit |
|---|---|
| Reference data, config snapshots | Cross-pod consistency required |
| Single-node dev | Shared invalidation needed |
| Extremely hot read keys | Large working set exceeding heap |

### Stats and tuning

```java
CaffeineCache cache = (CaffeineCache) cacheManager.getCache("productSummary");
com.github.benmanes.caffeine.cache.Cache<Object, Object> nativeCache = cache.getNativeCache();
CacheStats stats = nativeCache.stats();
log.info("hitRate={}", stats.hitRate());
```

Expose via Micrometer (section 14).

### Production scenario: OOM after adding Caffeine

**Problem.** Heap grows until GC thrash.

**Cause.** `maximumSize` unbounded or caching large object graphs per key.

**Solution.** Set `maximumSize`, cache slim DTOs, monitor heap per pod.

### Common misconfigurations

| Issue | Symptom |
|---|---|
| Long TTL + no eviction on write | Stale L1 across pods |
| Caching per-user large payloads | Memory pressure |
| `recordStats` disabled in prod | Blind tuning |

---

## 9. Redis Distributed Cache (L2)

### Core concept

`RedisCacheManager` stores entries in Redis — **shared across pods**, survives restarts (with persistence config), supports TTL. Spring Boot 3 uses **Lettuce** client by default.

### Dependencies

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
```

### Connection properties

```yaml
spring:
  data:
    redis:
      host: redis.internal
      port: 6379
      password: ${REDIS_PASSWORD}
      timeout: 2000ms
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 2
  cache:
    type: redis
    redis:
      time-to-live: 300000
      cache-null-values: false
      key-prefix: "catalog:"
      use-key-prefix: true
```

Cluster:

```yaml
spring:
  data:
    redis:
      cluster:
        nodes: redis-0:6379,redis-1:6379,redis-2:6379
        max-redirects: 3
```

See `notes/microservices/caching.md` section 10 for Redis topology and cluster slot constraints.

### Serialization

Default JDK serialization is **fragile** — prefer JSON:

```java
@Bean
RedisCacheConfiguration cacheConfiguration(ObjectMapper mapper) {
    mapper = mapper.copy().activateDefaultTyping(
        mapper.getPolymorphicTypeValidator(),
        ObjectMapper.DefaultTyping.NON_FINAL);

    return RedisCacheConfiguration.defaultCacheConfig()
        .serializeKeysWith(RedisSerializationContext.SerializationPair
            .fromSerializer(new StringRedisSerializer()))
        .serializeValuesWith(RedisSerializationContext.SerializationPair
            .fromSerializer(new GenericJackson2JsonRedisSerializer(mapper)))
        .disableCachingNullValues();
}
```

**Boot 3.2+** alternative — `RedisCacheConfiguration` with custom `RedisSerializer`.

Type safety options:

| Serializer | Trade-off |
|---|---|
| `GenericJackson2JsonRedisSerializer` | Type metadata in JSON; security configure validator |
| `Jackson2JsonRedisSerializer<T>` | Fixed type; no default typing |
| String JSON of DTO you control | Simplest; manual parse |

### `RedisCacheManager` builder essentials

```java
@Bean
@Primary
RedisCacheManager redisCacheManager(
        RedisConnectionFactory factory,
        RedisCacheConfiguration cacheConfiguration) {

    return RedisCacheManager.builder(RedisCacheWriter.nonLockingRedisCacheWriter(factory))
        .cacheDefaults(cacheConfiguration)
        .transactionAware()
        .enableStatistics()  // Spring Data Redis 3.2+
        .build();
}
```

### `sync=true` and locking writer

For stampede protection, use locking writer:

```java
RedisCacheWriter lockingWriter = RedisCacheWriter.lockingRedisCacheWriter(connectionFactory);
```

```java
@Cacheable(value = "products", key = "#id", sync = true)
public ProductDto findById(long id) { ... }
```

Only one thread loads; others wait on same key (Redis-dependent).

### Production scenario: ClassCastException after deploy

**Problem.** Cache read fails after DTO refactor.

**Cause.** Old JSON in Redis incompatible with new class shape.

**Solution.** Version key prefix (`v2:products::id`), flush cache on deploy, or use tolerant DTO mapping.

### Redis down — fail open or closed?

Default: cache errors propagate unless `CacheErrorHandler` configured (section 14). Many teams fail **open** — log and execute method without cache.

---

## 10. Multi-Level Caching (L1 Caffeine + L2 Redis)

### Core concept

`CompositeCacheManager` chains managers — **first match wins**:

```java
@Bean
@Primary
CacheManager compositeCacheManager(
        CacheManager caffeineCacheManager,
        CacheManager redisCacheManager) {

    CompositeCacheManager composite = new CompositeCacheManager(
        caffeineCacheManager,  // L1 — checked first
        redisCacheManager      // L2 — fallback
    );
    composite.setFallbackToNoOpCache(false); // don't silently skip L2
    return composite;
}
```

**Read path:** L1 hit → return. L1 miss → L2 hit → **populate L1** (CompositeCacheManager does not auto-promote — consider custom `Cache` wrapper or `CaffeineCache` loading from Redis).

### Custom L1-with-promotion pattern

```java
public class TwoLevelCache implements Cache {
    private final Cache l1;
    private final Cache l2;

    @Override
    public ValueWrapper get(Object key) {
        ValueWrapper v = l1.get(key);
        if (v != null) return v;
        v = l2.get(key);
        if (v != null) l1.put(key, v.get());
        return v;
    }
    // delegate put/evict/clear to both levels
}
```

Register via custom `CacheManager` returning `TwoLevelCache` instances.

### Invalidation across levels

| Event | L1 | L2 |
|---|---|---|
| `@CacheEvict` on one pod | Clears local only unless custom sync | Clears Redis — other pods' L1 still stale |
| TTL expiry | Independent | Independent |

**Cross-pod L1 invalidation:** Redis pub/sub, Spring Cache `@CacheEvict` + message listener, or short L1 TTL accepting staleness.

### Cache name strategy

Option A: Same cache names in both managers (`productSummary` in Caffeine and Redis).

Option B: `@Cacheable(cacheManager = "composite")` only; internal routing handles tiers.

### Production scenario: inconsistent counts across pods

**Problem.** API returns different inventory counts depending on pod.

**Cause.** L1 TTL 60s, write evicts Redis but not other pods' L1.

**Solution.** Pub/sub evict channel, reduce L1 TTL for that cache, or avoid L1 for frequently written data.

See `notes/microservices/caching.md` section 13 for distributed patterns.

---

## 11. Cache Stampede and Thundering Herd

### Core concept

When a hot key expires, **many threads** miss simultaneously and hammer the origin (DB). Spring offers **`@Cacheable(sync = true)`** — one loader, others block on cache populate (with locking `RedisCacheWriter`).

```java
@Cacheable(value = "hotProduct", key = "#id", sync = true)
public ProductDto getHotProduct(long id) {
    return expensiveLoad(id);
}
```

### Requirements for `sync=true`

| Requirement | Detail |
|---|---|
| Locking cache writer | `RedisCacheWriter.lockingRedisCacheWriter` |
| Supported `Cache` implementation | Redis yes; Caffeine has limited support |
| Still not global lock | Per-key only |

### Beyond `sync=true`

Patterns from architecture note (section 9 in microservices doc):

| Pattern | Implementation sketch |
|---|---|
| Probabilistic early expiration | Jitter TTL in custom wrapper |
| Request coalescing | Single-flight map in service layer |
| External lock (Redisson) | `RLock` around load |
| Prefetch before expiry | Scheduled refresh of hot keys |

### `@Cacheable` + reactive

Do not rely on `sync=true` for `Mono`. Use `Mono.cache()` or dedicated single-flight:

```java
private final Map<Long, Mono<Product>> inflight = new ConcurrentHashMap<>();

public Mono<Product> findById(long id) {
    return inflight.computeIfAbsent(id, k ->
        repo.findById(k)
            .cache(Duration.ofMinutes(5))
            .doFinally(s -> inflight.remove(k))
    );
}
```

### Production scenario: DB spike at top of every hour

**Problem.** Aligned TTL (all keys expire at :00) causes periodic outage.

**Cause.** Fixed TTL without jitter.

**Solution.** Random TTL component: `Duration.ofMinutes(5).plusSeconds(ThreadLocalRandom.current().nextInt(60))` in custom `RedisCacheConfiguration` per put.

### Common misconfigurations

| Issue | Symptom |
|---|---|
| `sync=true` with non-locking writer | No stampede protection |
| Hot key no TTL + manual evict only | Evict storm |
| Cache empty on cold start | All pods miss together — warm cache on startup |

---

## 12. Cache Invalidation Strategies

### Core concept

Spring Cache invalidation is **explicit** — annotations or programmatic `cache.evict()`. No DB change data capture.

### Annotation-based invalidation

```java
@Transactional
@Caching(evict = {
    @CacheEvict(cacheNames = "products", key = "#id"),
    @CacheEvict(cacheNames = "productSearch", allEntries = true)
})
public void updateProduct(long id, ProductUpdate update) { ... }
```

### Programmatic eviction

```java
@Service
@RequiredArgsConstructor
public class CacheAdminService {
    private final CacheManager cacheManager;

    public void evictProduct(long id) {
        Cache cache = cacheManager.getCache("products");
        if (cache != null) cache.evict(id);
    }

    public void clearAllProducts() {
        Cache cache = cacheManager.getCache("products");
        if (cache != null) cache.clear();
    }
}
```

### Event-driven invalidation

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onProductUpdated(ProductUpdatedEvent event) {
    cacheManager.getCache("products").evict(event.productId());
}
```

Decouples write logic from cache annotations — good for complex fan-out.

### TTL as invalidation

```yaml
spring:
  cache:
    redis:
      time-to-live: 300000
```

Acceptable staleness window — document SLA ("product price may lag up to 5 minutes").

### Versioned keys (schema migration)

```java
@Cacheable(key = "'v3:' + #id")
```

Deploy new version; old keys expire naturally.

### `allEntries=true` caution

Scans and deletes entire cache namespace — on Redis Cluster, may be slow or require hash-tag design. Prefer targeted evict lists.

### Production scenario: list cache stale after item update

**Problem.** Product detail fresh; search list shows old item.

**Cause.** `@CacheEvict` on detail key only.

**Solution.** Evict list caches too, or use cache-aside with short list TTL.

---

## 13. Security: Tenant Isolation, Sensitive Data, and Cache Poisoning

### Tenant isolation

| Risk | Mitigation |
|---|---|
| Shared key across tenants | Tenant in SpEL key |
| Shared Redis DB index | Separate logical DB or key prefix per env/tenant |
| Cache return to wrong user | Never cache user-specific without auth in key |

```java
@Cacheable(key = "'user:' + T(SecurityContextHolder).getContext().getAuthentication().getName() + ':' + #resourceId")
public ResourceDto getResource(String resourceId) { ... }
```

Verify authorization **before** cache check or include principal in key — otherwise user A requests id=1, caches, user B hits cache.

**Better:** cache only after authorization in service; key includes `#authentication.name`.

### Sensitive data in cache

| Do not cache | Why |
|---|---|
| Full credit card numbers | PCI scope |
| Raw JWT / refresh tokens | Token theft from Redis |
| PII without encryption | Redis often less protected than DB |

Encrypt values at rest in Redis if required; restrict network access; enable TLS.

### Cache poisoning

If attacker can influence cache keys or values:

- Validate inputs used in SpEL keys.
- Do not cache error responses unless intended.
- `unless="#result instanceof T(Exception)"` — usually automatic since exceptions skip put.

### Redis ACL

```bash
ACL SETUSER cache-app on >password ~catalog:* +get +set +del +expire
```

Spring app user should not have `FLUSHALL`.

### Production scenario: GDPR erasure incomplete

**Problem.** User deleted; profile still in Redis.

**Cause.** `@CacheEvict` missing on delete path; L1 on another pod.

**Solution.** Evict all key variants; pub/sub L1 flush; document in erasure runbook.

---

## 14. Observability: Metrics, Tracing, and Error Handling

### Actuator caches endpoint

```yaml
management:
  endpoints:
    web:
      exposure:
        include: caches,metrics,health
```

`/actuator/caches` — names and approximate sizes (implementation-dependent).

### Micrometer metrics

Spring Boot 3 registers cache metrics when supported:

| Metric | Meaning |
|---|---|
| `cache.gets` | Tags: `cache`, `result=hit\|miss` |
| `cache.puts` | Stores |
| `cache.evictions` | Evictions |
| `cache.size` | Current size |

Dashboard: hit ratio = hits / (hits + misses) per cache name.

### Custom `CacheErrorHandler`

Fail open on Redis outage:

```java
@Bean
CachingConfigurer cachingConfigurer() {
    return new CachingConfigurer() {
        @Override
        public CacheErrorHandler errorHandler() {
            return new CacheErrorHandler() {
                @Override
                public void handleCacheGetError(RuntimeException ex, Cache cache, Object key) {
                    log.warn("Cache get failed cache={} key={}", cache.getName(), key, ex);
                }
                @Override
                public void handleCachePutError(RuntimeException ex, Cache cache, Object key, Object value) {
                    log.warn("Cache put failed cache={} key={}", cache.getName(), key, ex);
                }
                @Override
                public void handleCacheEvictError(RuntimeException ex, Cache cache, Object key) {
                    log.warn("Cache evict failed cache={} key={}", cache.getName(), key, ex);
                }
                @Override
                public void handleCacheClearError(RuntimeException ex, Cache cache) {
                    log.warn("Cache clear failed cache={}", cache.getName(), ex);
                }
            };
        }
    };
}
```

Default handler **rethrows** — request fails if Redis down.

### Tracing

Cache operations may not auto-trace. Add spans around expensive misses:

```java
@Around("@annotation(cacheable)")
public Object traceCache(ProceedingJoinPoint pjp, Cacheable cacheable) throws Throwable {
    Span span = tracer.nextSpan().name("cacheable " + cacheable.value()[0]).start();
    try (Tracer.SpanInScope ws = tracer.withSpan(span)) {
        return pjp.proceed();
    } finally {
        span.end();
    }
}
```

Correlate with DB span on miss path.

### Logging

```yaml
logging:
  level:
    org.springframework.cache: DEBUG
    org.springframework.data.redis.cache: DEBUG
```

### Production alerts

| Alert | Threshold |
|---|---|
| Hit ratio drop | < 80% for 15m on critical cache |
| Redis error rate | > 1% of cache ops |
| Miss latency p99 | Spike correlating with DB load |
| Memory | Redis > 80% maxmemory |

See `notes/microservices/caching.md` section 15.

---

## 15. Testing Cache Configuration

### Unit test with `ConcurrentMapCacheManager`

```java
@ExtendWith(SpringExtension.class)
@ContextConfiguration(classes = { ProductService.class, TestCacheConfig.class })
@EnableCaching
class ProductServiceCacheTest {

    @Configuration
    static class TestCacheConfig {
        @Bean CacheManager cacheManager() {
            return new ConcurrentMapCacheManager("products");
        }
    }

    @Autowired ProductService service;

    @Test
    void secondCallDoesNotHitRepo() {
        // mock repo, call twice, verify once
    }
}
```

**Limitation:** Does not catch Redis serialization prod issues.

### `@SpringBootTest` + Testcontainers Redis

```java
@Testcontainers
@SpringBootTest
class RedisCacheIntegrationTest {

    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @DynamicPropertySource
    static void redisProps(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", redis::getHost);
        registry.add("spring.data.redis.port", () -> redis.getMappedPort(6379));
    }

    @Autowired CacheManager cacheManager;
    @Autowired ProductService products;

    @Test
    void cachesInRedis() {
        products.findById(1L);
        Cache cache = cacheManager.getCache("products");
        assertThat(cache.get(1L)).isNotNull();
    }
}
```

### Assert eviction

```java
@Test
void updateEvictsCache() {
    products.findById(1L);
    products.updatePrice(1L, new BigDecimal("9.99"));
    verify(repo, times(2)).findById(1L); // second find hits DB
}
```

### Profile alignment

Ensure test profile uses same `CacheManager` type as prod or dedicated CI job with Redis.

### `@Cacheable` not working in test

Check `@EnableCaching` on test config, public method, external invocation through injected bean.

---

## 16. Hibernate Second-Level Cache (Brief)

### Relationship to Spring Cache

**Separate systems.** Hibernate 2LC caches **entity state** at SessionFactory level (regions). Spring Cache caches **method return values**. They do not coordinate invalidation.

```
@Service @Cacheable
  └─ returns ProductDto (Spring Cache)

@Repository
  └─ EntityManager finds Product entity (Hibernate 1LC per transaction)
       └─ 2LC optional at SessionFactory level
```

### When 2LC still matters

| Use 2LC | Prefer Spring Cache |
|---|---|
| Many transactions read same entities | Cache aggregated DTOs / queries |
| Legacy Hibernate-heavy apps | Boot service layer pattern |
| Read-only reference entities | Cross-service shared Redis |

### Enable 2LC (Hibernate 6 / Boot 3)

```yaml
spring:
  jpa:
    properties:
      hibernate:
        cache:
          use_second_level_cache: true
          use_query_cache: true
          region:
            factory_class: org.hibernate.cache.jcache.JCacheRegionFactory
```

```xml
<dependency>
  <groupId>org.hibernate.orm</groupId>
  <artifactId>hibernate-jcache</artifactId>
</dependency>
```

Entity:

```java
@Entity
@Cacheable
@org.hibernate.annotations.Cache(usage = CacheConcurrencyStrategy.READ_WRITE)
public class Country { ... }
```

### Pitfalls (see JPA note section 25)

| Pitfall | Symptom |
|---|---|
| `@Cacheable` entity + mutation | Stale 2LC across pods |
| Query cache without invalidation | Phantom reads |
| `READ_WRITE` with high write rate | Lock contention |

**Production guidance:** Prefer Spring `@Cacheable` on service DTOs for microservices. Use 2LC sparingly for stable reference entities. Never stack both on same data without explicit invalidation strategy.

---

## 17. HTTP Caching (Brief)

### Not Spring Cache

Browser and CDN caching (`Cache-Control`, `ETag`, `Last-Modified`) is **orthogonal** to `@Cacheable`. Confusing them causes double staleness or no caching where expected.

```
Client
  └─ CDN (Cache-Control: max-age=60)
       └─ Spring MVC controller
            └─ @Cacheable service
                 └─ Redis
                      └─ DB
```

### Spring MVC cache headers

```java
@GetMapping("/products/{id}")
public ResponseEntity<ProductDto> get(@PathVariable long id) {
    ProductDto dto = productService.findById(id);
    return ResponseEntity.ok()
        .cacheControl(CacheControl.maxAge(30, TimeUnit.SECONDS).cachePublic())
        .eTag("\"" + dto.version() + "\"")
        .body(dto);
}
```

`ShallowEtagHeaderFilter` — auto ETag on response body (CPU cost for large payloads).

### Interaction with `@Cacheable`

| Layer | Key space |
|---|---|
| HTTP | URL + headers (Vary) |
| Spring Cache | SpEL business key |

Invalidate both on write — HTTP clients may not see `@CacheEvict`.

### WebFlux

`Cache-Control` on `ServerResponse`; reactive caching still manual for data layer.

See `notes/Spring/Spring_MVC_and_REST.md` for conditional requests and `WebContentInterceptor`.

---

## 18. Anti-Patterns Catalog

| Anti-pattern | Why it hurts | Fix |
|---|---|---|
| `@Cacheable` on every repository method | Uncontrolled key space, stale entities, lazy-load serialization | Cache service DTOs selectively |
| Caching `Optional` without understanding | Caches empty as valid | `unless="#result.isEmpty()"` or don't cache empty |
| Giant `allEntries` evict on every write | Redis scan storm | Targeted keys or message-driven fan-out |
| Same cache name, different value types | Deserialization failures | Separate cache names per type |
| Self-invocation | Silent no-cache | Extract bean |
| JDK serialized objects in Redis | Brittle, opaque | JSON + schema version |
| No TTL anywhere | Memory leak, eternal staleness | Always set TTL on distributed caches |
| Caching security-sensitive per-user data with weak keys | Data leak | Auth in key or no cache |
| `@Cacheable` on `@Modifying` query method | Nonsensical | Evict only |
| Relying on `NoOpCacheManager` in prod | False confidence | Assert manager type in smoke test |
| Mutable collection return cached | Caller mutates shared state | Return immutable copies |
| `sync=true` without locking writer | False sense of safety | Locking RedisCacheWriter |
| 2LC + Spring Cache same entity | Double stale layers | Pick one |
| HTTP max-age long + short Redis TTL | Confusing debug | Document layers |
| Ignoring cache in disaster recovery | Cold start kills DB | Warmup job, rate limits |

---

## 19. Production Debugging Playbook

### Symptom: stale data after update

1. Trace write path — is `@CacheEvict` present and key correct?
2. Check `transactionAware()` — did rollback leave old value?
3. L1 on other pods — pub/sub or TTL?
4. HTTP CDN cache — separate from Spring Cache?
5. Hibernate 2LC — separate region?

### Symptom: cache never hits

1. Self-invocation? Private method?
2. Unstable SpEL key? Log keys at TRACE.
3. `condition` / `unless` excluding store?
4. Wrong `CacheManager` bean?
5. `NoOpCacheManager` or `spring.cache.type=none`?
6. Redis connection to wrong host/env?

### Symptom: latency worse with cache

1. Measure hit ratio — if low, fix keys first.
2. Payload size — serialize slim DTO.
3. Redis RTT / connection pool wait.
4. Stampede on miss — `sync=true`, jitter TTL.
5. Serialization CPU — consider Kryo/MessagePack for internal only.

### Symptom: Redis memory growth

1. `redis-cli INFO memory`
2. Key count per prefix — `SCAN` not `KEYS` in prod.
3. Missing TTL — `TTL key` should not be -1.
4. Cached nulls — disable null caching.
5. Large collections cached per key.

### Symptom: ClassCastException / LinkedHashMap

1. Jackson default typing mismatch — align serializer config.
2. Deploy version skew — version keys.
3. Changed class without flush.

### Useful commands

```bash
# Actuator
curl localhost:8080/actuator/caches
curl localhost:8080/actuator/metrics/cache.gets?tag=result:hit

# Redis
redis-cli MONITOR   # dev only
redis-cli --scan --pattern 'catalog:products*' | head
redis-cli TTL 'catalog:products::42'
redis-cli MEMORY USAGE 'catalog:products::42'
```

### Rollback checklist

1. Disable cache via feature flag or `spring.cache.type=none` if causing outage.
2. `FLUSHDB` on dedicated cache Redis instance (never shared multi-purpose without approval).
3. Redeploy with key version bump.

---

## 20. Quick Decision Matrix

| Need | Choose |
|---|---|
| Single pod, dev/test | `ConcurrentMapCacheManager` |
| Hot read, tolerate per-pod staleness | Caffeine L1 |
| Shared across pods | Redis `RedisCacheManager` |
| Hot key + high concurrency miss | `@Cacheable(sync=true)` + locking writer |
| Write-heavy entity | Short TTL + targeted evict, avoid L1 |
| Multi-tenant SaaS | Tenant in every key; prefix per env |
| DTO aggregation expensive | `@Cacheable` on service method |
| Entity graph in ORM | DTO + Spring Cache, not raw entity |
| Cross-service cache | Redis with shared key contract, not local |
| GDPR delete | Programmatic evict + pub/sub L1 flush |
| Schema change deploy | Version prefix in key |
| Redis outage tolerance | Custom `CacheErrorHandler` fail-open |
| Reactive stack | Manual Mono cache / single-flight |
| Reference data hourly change | Caffeine 30m or Redis 1h TTL |
| Inventory / stock | Short TTL or no cache; evict on write |
| Search results | Cache with query key; evict lists on write |
| Session data | Spring Session Redis — not `@Cacheable` |
| Rate limiting | Redis counters — not `@Cacheable` |
| Hibernate entity reuse | 2LC (careful) or query cache |
| Browser caching | HTTP headers — not `@Cacheable` |
| Test unit speed | `ConcurrentMapCacheManager` |
| CI prod parity | Testcontainers Redis test |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Is Spring Cache read-through or cache-aside?</summary>

Cache-aside. On miss, your method runs and the interceptor stores the return value. Spring never invokes the DB loader itself.

</details>

<details class="qa-item">
<summary>2. Why does `@Cacheable` not work on a private method?</summary>

Spring Cache uses AOP proxies that only intercept public methods on Spring beans. Private methods are not proxied.

</details>

<details class="qa-item">
<summary>3. What happens if two `@Cacheable` methods in the same class call each other?</summary>

Self-invocation bypasses the proxy — caching does not apply. Extract to another bean.

</details>

<details class="qa-item">
<summary>4. What is `NoOpCacheManager` and when does Boot use it?</summary>

A manager that accepts operations but stores nothing. Used when no cache provider is on classpath or caching is disabled — annotations silently do nothing.

</details>

<details class="qa-item">
<summary>5. How do you defer cache put until after DB commit?</summary>

`RedisCacheManager.builder(...).transactionAware().build()` plus `@Transactional` through Spring proxy. Puts/evicts register with transaction synchronization and apply on commit.

</details>

<details class="qa-item">
<summary>6. Difference between `@CachePut` and `@Cacheable`?</summary>

`@Cacheable` skips method on hit. `@CachePut` always runs the method and updates cache with return value.

</details>

<details class="qa-item">
<summary>7. When should you use `@CacheEvict(allEntries=true)`?</summary>

Rarely — small caches or admin rebuild. Avoid on large Redis namespaces in production; use targeted evict.

</details>

<details class="qa-item">
<summary>8. What does `unless="#result == null"` do?</summary>

Prevents caching null results — method runs on every call for missing entities unless combined with other strategy.

</details>

<details class="qa-item">
<summary>9. How do you cache with multi-tenant isolation?</summary>

Include tenant ID in SpEL key or cache name. Never `#id` alone for tenant-scoped data.

</details>

<details class="qa-item">
<summary>10. What is `sync=true` on `@Cacheable`?</summary>

On miss, only one thread executes the method; others wait for populate (requires locking cache writer on Redis).

</details>

<details class="qa-item">
<summary>11. Can you use two CacheManager beans?</summary>

Yes — `@Primary`, `@Qualifier`, `cacheManager` attribute on annotation, or custom `CacheResolver`.

</details>

<details class="qa-item">
<summary>12. Why not cache JPA entities?</summary>

Lazy associations, detached mutation, version fields, and large graphs break serialization and consistency. Cache DTOs.

</details>

<details class="qa-item">
<summary>13. How does CompositeCacheManager order work?</summary>

First manager in list that has the cache name wins for get. Configure L1 before L2.

</details>

<details class="qa-item">
<summary>14. Default Redis key format in Spring Cache?</summary>

Typically `cacheName::key` with optional global prefix from `spring.cache.redis.key-prefix`.

</details>

<details class="qa-item">
<summary>15. How to test Redis cache in CI?</summary>

Testcontainers Redis + `@SpringBootTest` asserting key presence after `@Cacheable` call.

</details>

<details class="qa-item">
<summary>16. Relationship between Spring Cache and Hibernate 2LC?</summary>

Independent. Invalidating one does not invalidate the other. Avoid doubling without strategy.

</details>

<details class="qa-item">
<summary>17. What serializer for Redis in Boot 3?</summary>

Prefer JSON (`GenericJackson2JsonRedisSerializer` or typed Jackson2) over JDK serialization.

</details>

<details class="qa-item">
<summary>18. Cache fails when Redis down — default behavior?</summary>

Operations throw unless custom `CacheErrorHandler` swallows and falls back to method execution.

</details>

<details class="qa-item">
<summary>19. How to prevent aligned TTL expiry stampede?</summary>

Jitter TTL, `sync=true`, external single-flight, or proactive refresh.

</details>

<details class="qa-item">
<summary>20. Where should `@Cacheable` live — controller or service?</summary>

Service layer. Controllers handle HTTP; caching is business/data optimization.

</details>

<details class="qa-item">
<summary>21. Does `@Cacheable` work on `@Repository` interfaces?</summary>

Unreliable — Spring Data already proxies repositories; annotation on implementation may not apply as expected. Cache at service layer.

</details>

<details class="qa-item">
<summary>22. What is `CachingConfigurer` for?</summary>

Global defaults: `CacheManager`, `KeyGenerator`, `CacheResolver`, `CacheErrorHandler`.

</details>

<details class="qa-item">
<summary>23. How to evict L1 on all pods when L2 evicts?</summary>

Redis pub/sub broadcast, short L1 TTL, or accept staleness window.

</details>

<details class="qa-item">
<summary>24. `condition` vs `unless` in `@Cacheable`?</summary>

`condition` evaluated before method — skip cache entirely if false. `unless` evaluated after — skip put if true.

</details>

<details class="qa-item">
<summary>25. Spring Boot 3 reactive `@Cacheable` on Mono?</summary>

Problematic — caches Mono instance not value. Use reactive operators or imperative cache API inside flatMap.

</details>
