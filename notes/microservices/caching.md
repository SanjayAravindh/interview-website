# Microservices Caching — Senior Production Reference

Spring Cache / Spring Data Redis / Redis 7.x / Spring Boot 3.x. Servlet and reactive stacks are both covered; differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping microservices with Redis clusters, Caffeine local caches, and `@Cacheable` annotations that silently stop working after a deploy.

---

## Table of Contents

1. [1. Mental Model: One Read Through the Cache Stack](#1-mental-model-one-read-through-the-cache-stack)
2. [2. Caching Strategies Overview](#2-caching-strategies-overview)
3. [3. Cache-Aside Pattern (Lazy Loading)](#3-cache-aside-pattern-lazy-loading)
4. [4. Read-Through Cache](#4-read-through-cache)
5. [5. Write-Through Cache](#5-write-through-cache)
6. [6. Write-Behind (Write-Back) Cache](#6-write-behind-write-back-cache)
7. [7. Cache Invalidation Strategies](#7-cache-invalidation-strategies)
8. [8. TTL, Eviction, and Memory Management](#8-ttl-eviction-and-memory-management)
9. [9. Cache Stampede and Thundering Herd](#9-cache-stampede-and-thundering-herd)
10. [10. Redis Architecture and Data Structures](#10-redis-architecture-and-data-structures)
11. [11. Spring Cache Abstraction](#11-spring-cache-abstraction)
12. [12. Spring Boot + Redis Integration](#12-spring-boot--redis-integration)
13. [13. Distributed Caching in Microservices](#13-distributed-caching-in-microservices)
14. [14. Consistency, Staleness, and CAP Trade-offs](#14-consistency-staleness-and-cap-trade-offs)
15. [15. Observability: Metrics, Traces, and Alerts](#15-observability-metrics-traces-and-alerts)
16. [16. Testing Cache Configuration](#16-testing-cache-configuration)
17. [17. Production Debugging Playbook](#17-production-debugging-playbook)
18. [18. Quick Decision Matrix](#18-quick-decision-matrix)
19. [19. Interview Q&A](#19-interview-qa)

---

## 1. Mental Model: One Read Through the Cache Stack

Caching is not "add Redis and `@Cacheable`." It is a **consistency contract** between callers, your application, and a store that may be stale, empty, or lying because invalidation failed silently. Every pattern answers a different question: *who loads on miss*, *who writes on update*, *how do peers know data changed*, and *what happens when Redis is down*.

```
Client request
  └─ API gateway / CDN edge cache (optional)
       └─ Controller / handler
            └─ Service layer
                 └─ Cache lookup stack (typical order)
                      ├─ L1: local in-process (Caffeine, Guava)     "microseconds, per-JVM"
                      ├─ L2: distributed (Redis, Memcached)         "milliseconds, shared"
                      └─ Origin: database / remote API              "tens–hundreds of ms"
                           └─ Persistent store
```

Three objects you must keep distinct:

| Object | Question it answers | Typical implementation |
|---|---|---|
| **Cache hit** | Did we avoid the origin? | Redis `GET` returns value, Caffeine `getIfPresent` non-null |
| **Cache miss** | Who loads and populates? | Cache-aside: app loads DB then `SET`; read-through: cache library loads |
| **Invalidation** | When does cached data become wrong? | TTL expiry, explicit `DEL`, pub/sub event, version bump in key |

A **slow endpoint after "we added caching"** may mean cache misses dominate (cold start, wrong keys), stampede on hot keys, serialization overhead, or Redis network latency — not "Redis is slow." Check hit ratio (`cache_gets_total{result="hit"}`) before blaming the database.

### Pattern composition in real systems

Most production services stack patterns:

```
L1 Caffeine (30s TTL, 10k entries)
  └─ L2 Redis (5m TTL, shared across pods)
       └─ PostgreSQL (source of truth)
```

L1 reduces Redis round-trips for hot keys. L2 shares state across pods. Neither replaces invalidation discipline — both can serve stale data if you forget to evict on write.

### Production scenario: "We cached everything and latency got worse"

**Problem.** Team adds `@Cacheable` on every repository method and a Redis cluster. P99 for product search drops briefly, then rises above pre-cache baseline. Redis CPU is moderate; DB load unchanged.

**Cause.** Cache keys include a timestamp or request ID by mistake (`#root.methodName + T(System.currentTimeMillis())`). Every call is a miss. Serialization of large DTO graphs (500KB JSON per product) adds 15ms Redis RTT + 8ms Jackson per request. No L1; every pod hits Redis for every request.

**Solution.**

1. Audit SpEL keys — keys must be stable per logical entity: `#productId`, not `#root.args[0].toString()` on mutable objects.
2. Cache **IDs or slim DTOs**, not full object graphs with nested collections.
3. Add L1 for read-heavy, moderately stale data:

```java
@Bean
public CacheManager cacheManager(RedisConnectionFactory factory) {
    RedisCacheManager redis = RedisCacheManager.builder(factory)
        .cacheDefaults(RedisCacheConfiguration.defaultCacheConfig()
            .entryTtl(Duration.ofMinutes(5))
            .serializeValuesWith(RedisSerializationContext.SerializationPair
                .fromSerializer(new GenericJackson2JsonRedisSerializer())))
        .build();

    CaffeineCacheManager local = new CaffeineCacheManager("productSummary");
    local.setCaffeine(Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofSeconds(30)));

    return new CompositeCacheManager(local, redis); // L1 first, L2 fallback
}
```

4. Measure: `cache.hit.ratio`, `cache.miss`, payload size histogram.

---

## 2. Caching Strategies Overview

### Core concept

A **caching strategy** defines the read/write path between application and origin. The choice determines consistency guarantees, failure behavior, and operational complexity. There is no universal best — only trade-offs aligned with read/write ratio, staleness tolerance, and team ability to operate invalidation.

| Pattern | Read path | Write path | Consistency | Complexity |
|---|---|---|---|---|
| **Cache-aside** | App checks cache → miss → load DB → populate cache | App writes DB → invalidates/updates cache | Eventual; app responsible | Low — most common |
| **Read-through** | App asks cache → cache loads origin on miss | App writes DB; cache may not know | Eventual; loader in cache layer | Medium |
| **Write-through** | App reads cache (may miss until write) | App writes cache → cache writes DB synchronously | Stronger on write path | Medium–high |
| **Write-behind** | App reads cache | App writes cache → async flush to DB | Weakest; loss on crash | High |
| **Refresh-ahead** | Cache proactively reloads before TTL | Same as underlying pattern | Controlled staleness | Medium |

### When to use what

```
Read-heavy, stale OK (product catalog)     → Cache-aside + TTL + event invalidation
Read-heavy, hot keys (homepage)            → Cache-aside + L1 + stampede protection
Write-heavy (inventory, balances)          → Cache-aside with short TTL OR skip cache on write path
Strong consistency required (ledger)       → Don't cache writes; maybe read-through with tight invalidation
Session / rate-limit counters              → Redis native structures, not @Cacheable
```

### Internal working: cache hit ratio math

Hit ratio `H = hits / (hits + misses)`. Effective latency:

```
L_eff = H × L_cache + (1 - H) × (L_cache + L_origin + L_populate)
```

If `H = 0.95`, `L_cache = 2ms`, `L_origin = 50ms`, effective ≈ `0.95×2 + 0.05×52 ≈ 4.5ms`. At `H = 0.50`, effective ≈ `27ms` — worse than no cache if `L_cache > 0`. **Sub-90% hit ratio on a cached endpoint often means misconfigured keys, TTL too short, or stampede.**

### Production scenario: mixing patterns without documenting ownership

**Problem.** Catalog service uses cache-aside for reads. Inventory service uses write-through to Redis for stock counts. Order service reads stock from Redis directly (cross-service cache read). After inventory deploy, orders oversell — Redis shows stock that DB doesn't have.

**Cause.** Three teams, three patterns, no ownership of "source of truth." Order service treated Redis as authoritative instead of inventory API. Write-through had a bug: cache updated before DB transaction committed.

**Solution.**

- **Rule:** Only the owning service reads/writes its cache. Other services call the API, not Redis keys.
- Write-through must update cache **after** DB commit (or use transactional outbox + invalidation event).
- Document key namespaces: `inventory:stock:{skuId}` owned by inventory-service.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Cache as source of truth across services | Silent data corruption, overselling, wrong balances |
| No TTL on any key | Redis OOM, stale data forever |
| Same data in L1 and L2, invalidate only L2 | L1 serves stale up to L1 TTL |
| Caching paginated lists with unstable sort | Low hit ratio, huge key cardinality |
| Caching `Optional.empty()` misses forever | "Cache poison" — DB row added later, cache still empty |

### Debugging scenario

**Observe.** Hit ratio reported 99% but DB QPS unchanged.

**Diagnose.** Metrics count "hit" on L1 while L2 and DB still queried on every request (broken composite manager order). Or hits are on a cache name nobody uses in prod code path.

```java
// Temporary — staging only
@Around("@annotation(org.springframework.cache.annotation.Cacheable)")
public Object logCache(ProceedingJoinPoint pjp) throws Throwable {
    log.info("Cacheable method: {}", pjp.getSignature());
    return pjp.proceed();
}
```

**Fix.** Trace one request: confirm which `CacheManager` and cache name resolve. Align metrics with actual code path.

---

## 3. Cache-Aside Pattern (Lazy Loading)

### Core concept

**Cache-aside** (lazy loading): the application manages the cache. On read, check cache; on miss, load from origin, store in cache, return. On write, update origin first, then invalidate or update cache. The cache is a **sidecar** — it never talks to the database on its own.

```
READ:
  app → cache GET key
    hit  → return
    miss → app → DB SELECT
           → app → cache SET key
           → return

WRITE:
  app → DB UPDATE/INSERT
  app → cache DEL key (or SET new value)
```

This is the default for Spring `@Cacheable` / `@CacheEvict` — Spring does not load the DB for you on miss; your method body runs, then the result is cached.

### Internal working (Spring Cache)

1. `@Cacheable("products")` on `findById(Long id)` triggers `CacheInterceptor`.
2. Interceptor computes key via `KeyGenerator` (default: `SimpleKeyGenerator` — all params).
3. `Cache.get(key)` — if non-null `Cache.ValueWrapper`, return without invoking method.
4. On miss, invoke method → `productRepository.findById(id)`.
5. `Cache.put(key, result)` — unless `@Cacheable(unless="#result == null")`.
6. Null results: by default still cached (Spring 5+); use `unless` to avoid caching misses for optional entities.

```java
@Service
public class ProductService {

    private final ProductRepository repo;

    @Cacheable(value = "products", key = "#id", unless = "#result == null")
    public Product findById(Long id) {
        return repo.findById(id).orElse(null);
    }

    @CacheEvict(value = "products", key = "#product.id")
    @Transactional
    public Product update(Product product) {
        return repo.save(product);
    }

    @Caching(evict = {
        @CacheEvict(value = "products", key = "#id"),
        @CacheEvict(value = "productLists", allEntries = true)
    })
    @Transactional
    public void deleteById(Long id) {
        repo.deleteById(id);
    }
}
```

### Redis implementation (manual cache-aside)

When not using Spring Cache — explicit control, common in high-throughput paths:

```java
@Service
@RequiredArgsConstructor
public class ProductCacheService {

    private final StringRedisTemplate redis;
    private final ProductRepository repo;
    private final ObjectMapper mapper;

    private static final Duration TTL = Duration.ofMinutes(10);

    public Product getById(long id) {
        String key = "product:" + id;
        String json = redis.opsForValue().get(key);
        if (json != null) {
            if ("NULL".equals(json)) return null; // cached negative
            return read(json, Product.class);
        }
        Product product = repo.findById(id).orElse(null);
        redis.opsForValue().set(key,
            product == null ? "NULL" : write(product),
            TTL);
        return product;
    }

    public void evict(long id) {
        redis.delete("product:" + id);
    }
}
```

Use **`SET key value NX EX ttl`** for populate-on-miss to reduce stampede (only first writer sets):

```java
public Product getByIdWithLock(long id) {
    String key = "product:" + id;
    String json = redis.opsForValue().get(key);
    if (json != null) return decode(json);

    Product p = repo.findById(id).orElse(null);
    redis.opsForValue().setIfAbsent(key, encode(p), TTL);
    return p;
}
```

For true single-flight under load, use Redisson `RLock` or Redis `SET lock NX` + double-check.

### Production scenario: cache-aside forgot invalidation on partial update

**Problem.** Admin updates product price via PATCH `/products/{id}/price`. Public API still shows old price for 10 minutes (Redis TTL).

**Cause.** PATCH endpoint calls `repo.updatePrice(id, price)` directly — bypasses `ProductService.update()` which has `@CacheEvict`.

**Solution.**

- Never bypass the service layer for writes that affect cached entities.
- Or add `@CacheEvict` on every write path.
- Prefer **domain events**: `ProductUpdatedEvent` → listener evicts `products::{id}` and list caches.

```java
@EventListener
public void onProductUpdated(ProductUpdatedEvent e) {
    cacheManager.getCache("products").evict(e.productId());
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Cacheable` on `private` method | Never intercepted — always DB |
| `@Cacheable` on same-class call (self-invocation) | AOP bypass — no cache |
| Evict wrong key (hashCode vs id) | Stale entries remain |
| Cache entity with lazy JPA collections | `LazyInitializationException` or huge serialized graph |
| No eviction on create | List caches stale until TTL |

### Debugging scenario

**Observe.** `@Cacheable` present but Redis `MONITOR` shows no GET for that endpoint.

**Diagnose.** Self-invocation:

```java
public Product getProduct(Long id) {
    return this.findById(id); // WRONG — bypasses proxy
}
```

**Fix.** Inject self `@Lazy ProductService self` or move cache to repository layer with explicit cache service.

---

## 4. Read-Through Cache

### Core concept

**Read-through:** the cache library sits in front of the origin. On miss, the **cache provider** loads from DB (via configured loader), stores, and returns. Application code only calls `cache.get(key)`.

Spring Cache **does not** implement read-through natively — `@Cacheable` is closer to cache-aside (method runs on miss). Read-through appears in:

- **Caffeine** `LoadingCache.get(key)` with `CacheLoader`
- **Guava** `LoadingCache`
- **Hazelcast** `IMap.get` with MapLoader
- **AWS ElastiCache** Memcached with consistent hashing + client logic

```java
LoadingCache<Long, Product> productCache = Caffeine.newBuilder()
    .maximumSize(10_000)
    .expireAfterWrite(Duration.ofMinutes(5))
    .build(id -> productRepository.findById(id)
        .orElseThrow(() -> new ProductNotFoundException(id)));

public Product getProduct(long id) {
    return productCache.get(id); // load automatic on miss
}
```

### Read-through vs cache-aside

| Aspect | Cache-aside | Read-through |
|---|---|---|
| Loader location | Application service | Cache library |
| Multiple app instances | Each implements same load logic | Loader can be centralized (Hazelcast MapStore) |
| Failure on load | App handles | Propagates from loader |
| Spring `@Cacheable` | Yes (method = loader) | No — method IS the loader invoked by aspect |

In practice, `@Cacheable` **is** cache-aside with the method body as implicit loader. Interview answer: "Spring Cache is cache-aside, not read-through, unless you wrap a LoadingCache yourself."

### Production scenario: LoadingCache without refresh on invalidation

**Problem.** L1 `LoadingCache` for tenant config. Admin updates config in DB. Some pods serve new config in 30s, others up to 5 minutes.

**Cause.** `expireAfterWrite(5m)` on L1; no `invalidate(key)` on update event. Read-through doesn't push invalidation — you must still evict.

**Solution.**

```java
@EventListener
public void onConfigChange(ConfigChangedEvent e) {
    productCache.invalidate(e.tenantId());
    redisTemplate.delete("config:" + e.tenantId()); // L2
}
```

Subscribe all pods via Redis pub/sub:

```java
// Publisher on write
redis.convertAndSend("cache:invalidate", "config:" + tenantId);

// Subscriber on each pod
@Component
public class CacheInvalidationListener implements MessageListener {
    @Override
    public void onMessage(Message message, byte[] pattern) {
        String key = new String(message.getBody());
        localCache.invalidate(parseKey(key));
    }
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Loader throws on not-found | Repeated DB hits if exception not cached |
| Heavy loader under stampede | DB meltdown — need single-flight in loader |
| Read-through L1 + cache-aside L2 | Double load logic, divergent behavior |

### Debugging scenario

**Observe.** Caffeine stats show high load count on one key per second.

**Diagnose.** `expireAfterAccess` too short vs hot key, or loader throws and entry not stored.

```java
CacheStats stats = cache.stats();
log.info("loads={}, hits={}, misses={}", stats.loadCount(), stats.hitCount(), stats.missCount());
```

**Fix.** `refreshAfterWrite` instead of expire for hot keys; handle not-found with cached sentinel.

---

## 5. Write-Through Cache

### Core concept

**Write-through:** application writes to cache first (or simultaneously); cache synchronously writes to the origin. Reads always go through cache. Stronger consistency on the write path because cache and DB update in the same logical operation — **if implemented correctly**.

```
WRITE:
  app → cache SET key value
  cache → DB INSERT/UPDATE (sync)
  return

READ:
  app → cache GET key
    hit  → return
    miss → rare if all writes go through cache; loader fills from DB
```

Spring Cache has **no built-in write-through**. You implement explicitly:

```java
@Service
@RequiredArgsConstructor
public class InventoryWriteThroughService {

    private final StringRedisTemplate redis;
    private final InventoryRepository repo;

    @Transactional
    public void setStock(String skuId, int quantity) {
        String key = "inventory:stock:" + skuId;
        // Order matters: DB first, then cache — see below
        repo.updateQuantity(skuId, quantity);
        redis.opsForValue().set(key, String.valueOf(quantity), Duration.ofHours(1));
    }

    public int getStock(String skuId) {
        String key = "inventory:stock:" + skuId;
        String val = redis.opsForValue().get(key);
        if (val != null) return Integer.parseInt(val);
        int qty = repo.findQuantity(skuId);
        redis.opsForValue().set(key, String.valueOf(qty), Duration.ofHours(1));
        return qty;
    }
}
```

### Critical ordering: DB-first vs cache-first

| Order | Risk |
|---|---|
| **Cache first, then DB** | Cache shows new value; DB fails → inconsistent; readers see uncommitted data |
| **DB first, then cache** | DB updated; cache update fails → stale cache until TTL (safer) |
| **DB commit, then cache** | Best for cache-aside invalidation; write-through variant updates cache after commit |

**Production rule:** update cache **after** database transaction commits:

```java
@Transactional
public void setStock(String skuId, int quantity) {
    repo.updateQuantity(skuId, quantity);
}

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onStockUpdated(StockUpdatedEvent e) {
    redis.opsForValue().set(key(e.skuId()), String.valueOf(e.quantity()), TTL);
}
```

True write-through (cache coordinates DB write) belongs in specialized stores (Hazelcast MapStore `store`, GemFire write-through loader). In Redis + Spring, you usually mean **"write DB then update cache synchronously"** — interviewers often accept that as write-through lite.

### Production scenario: write-through without transaction boundary

**Problem.** Transfer stock between warehouses: decrement A, increment B. Redis updated after each step. Crash between steps → Redis total wrong, DB rolled back partially.

**Cause.** Cache updates outside `@Transactional` boundary; no atomicity across two keys.

**Solution.** Don't write-through distributed counters for multi-step business operations. Use:

- Single DB transaction as source of truth
- Invalidate cache keys after commit
- Or Redis `WATCH`/`MULTI`/`EXEC` for atomic counter ops (still not a substitute for business transactions)

```java
@Transactional
public void transfer(String from, String to, int qty) {
    repo.decrement(from, qty);
    repo.increment(to, qty);
}
// AFTER_COMMIT: evict both keys, don't try to incrementally patch
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Cache-first on financial data | Phantom balances |
| Write-through on high-write path | Redis + DB both bottleneck |
| No rollback of cache on DB failure | Permanent inconsistency until TTL |
| Cross-service write-through to shared Redis | Ownership and consistency nightmares |

### Debugging scenario

**Observe.** Redis stock = 5, DB stock = 12 after payment failures.

**Diagnose.** Compare `updated_at` in DB vs Redis TTL key age. Trace write path — is decrement in Redis only?

**Fix.** Invalidate on any failed transaction; periodic reconciliation job: DB → overwrite Redis for drift detection.

---

## 6. Write-Behind (Write-Back) Cache

### Core concept

**Write-behind:** application writes to cache immediately; cache **asynchronously** batches/flushes to the origin. Lowest write latency, highest data-loss risk on crash.

```
WRITE:
  app → cache SET (immediate ack)
  cache → queue → async batch INSERT/UPDATE to DB

READ:
  app → cache GET (may not yet be in DB)
```

Use cases: analytics counters, click streams, non-critical telemetry — **not** orders or payments unless you accept loss.

Redis does not provide write-behind natively. Implement with:

- In-memory queue + `@Async` flusher
- Kafka/Redis Stream as buffer → consumer writes DB
- RDB/AOF persistence as safety net (not a substitute for DB)

```java
@Service
public class ViewCountWriteBehind {

    private final ConcurrentHashMap<String, AtomicLong> buffer = new ConcurrentHashMap<>();
    private final StringRedisTemplate redis;

    public void recordView(String productId) {
        redis.opsForValue().increment("views:" + productId);
        buffer.computeIfAbsent(productId, k -> new AtomicLong()).incrementAndGet();
    }

    @Scheduled(fixedRate = 5000)
    public void flush() {
        buffer.forEach((id, delta) -> {
            long d = delta.getAndSet(0);
            if (d > 0) viewRepository.addViews(id, d);
        });
    }
}
```

### Production scenario: write-behind buffer lost on pod kill

**Problem.** Kubernetes rolling deploy during flash sale. View counts and "limited stock" counters diverge; 2% of writes never reach DB.

**Cause.** Write-behind buffer in JVM heap; pod terminated before flush interval.

**Solution.** For anything business-critical, use write-through or cache-aside with invalidation. For counters, use Redis `INCR` as primary during burst + periodic sync, or write to durable queue (Kafka) before ack.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Write-behind for orders | Lost orders on crash |
| Unbounded buffer | OOM during outage |
| No idempotent flush | Duplicate rows on retry |

---

## 7. Cache Invalidation Strategies

### Core concept

**There are only two hard things in computer science: cache invalidation and naming things.** Invalidation fails more often than population because writes scatter across code paths, services, and admin tools.

| Strategy | Mechanism | Pros | Cons |
|---|---|---|---|
| **TTL expiry** | `EXPIRE key seconds` | Simple, self-healing | Staleness window |
| **Explicit delete** | `DEL key` on write | Immediate | Must hit every write path |
| **Event-driven** | Kafka/SNS → subscribers evict | Decoupled, multi-service | Event lag, ordering |
| **Version/key rotation** | `product:v2:{id}` bump global version | Instant logical invalidation | Key proliferation |
| **Write-invalidate vs write-update** | DEL vs SET on write | Update avoids next miss | Update can race with concurrent write |

### TTL-only (lazy invalidation)

```java
RedisCacheConfiguration.defaultCacheConfig()
    .entryTtl(Duration.ofMinutes(5));
```

Accept 5-minute staleness. Good for catalog, CMS content, feature flags with low change frequency.

### Explicit eviction (Spring)

```java
@CacheEvict(value = "products", key = "#id")
public void updateProduct(Long id, ProductDto dto) { ... }

@CacheEvict(value = "productLists", allEntries = true)
public void createProduct(Product p) { ... } // can't know all list query keys
```

`allEntries = true` is a sledgehammer — triggers `SCAN` + delete in Redis cache implementation; use sparingly.

### Event-driven invalidation

```java
// inventory-service publishes
kafkaTemplate.send("inventory.events", new StockChangedEvent(skuId));

// catalog-service consumes
@KafkaListener(topics = "inventory.events")
public void onStockChanged(StockChangedEvent e) {
    cacheManager.getCache("availability").evict(e.skuId());
}
```

Handle **ordering**: out-of-order events can briefly show wrong state. Use version in event: ignore if `event.version <= cached.version`.

### Version bump pattern

```java
// Global catalog version in Redis
Long ver = redis.opsForValue().increment("catalog:version");
// Key includes version
String key = "products:" + ver + ":" + productId;
// On any catalog change, increment version — old keys become unreachable, expire via TTL
```

Old keys need TTL or background cleanup (`SCAN catalog:products:OLDVER:*`).

### Cache invalidation vs update

**Invalidate (DEL):** next read pays miss cost — safe when write races possible.

**Update (SET):** next read is fast — risk if two writers race:

```
T1: read stock=10
T2: write stock=8, cache SET 8
T1: write stock=12 (stale read), cache SET 12  → lost update
```

For counters and inventory, prefer **invalidate** or atomic Redis ops (`DECR`), not blind SET.

### Production scenario: partial invalidation missed related keys

**Problem.** User updates profile name. Profile cache evicted. Search results and order history still show old name (separate caches).

**Cause.** Entity-centric eviction only cleared `users::{id}`, not denormalized caches.

**Solution.**

- Maintain invalidation map: `UserUpdated → [users, userSearch, orderSummariesForUser]`
- Or don't cache denormalized aggregates — cache IDs only, assemble at read time
- Or TTL short enough on denormalized views

```java
@Caching(evict = {
    @CacheEvict(cacheNames = "users", key = "#id"),
    @CacheEvict(cacheNames = "userSearch", allEntries = true)
})
public User updateUser(Long id, UserDto dto) { ... }
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Invalidate L2, forget L1 | Pods serve stale up to L1 TTL |
| Kafka consumer lag | Widespread stale caches |
| `allEntries` on every single write | Redis CPU spikes, latency jitter |
| No invalidation on batch SQL / Flyway | Mystery stale data after migration |

### Debugging scenario

**Observe.** "Fixed in DB, still wrong in API" for exactly TTL duration.

**Diagnose.** TTL-only, no evict on write path. Confirm with Redis `TTL key`.

**Fix.** Add `@CacheEvict` or event listener; reduce TTL as temporary mitigation.

---

## 8. TTL, Eviction, and Memory Management

### Core concept

Redis is an **in-memory** store. When `maxmemory` is reached, eviction policy decides what dies. JVM local caches use size + TTL via Caffeine. Misconfigured memory causes OOM, cascade failures, or silent evictions that look like cache misses.

### Redis TTL

```bash
SET product:42 "{\"name\":\"Widget\"}" EX 300
TTL product:42          # seconds remaining
PERSIST product:42      # remove TTL
```

Spring Redis cache:

```yaml
spring:
  cache:
    redis:
      time-to-live: 300000   # ms, default for all caches
```

Per-cache TTL:

```java
Map<String, RedisCacheConfiguration> configs = Map.of(
    "products", RedisCacheConfiguration.defaultCacheConfig().entryTtl(Duration.ofMinutes(10)),
    "sessions", RedisCacheConfiguration.defaultCacheConfig().entryTtl(Duration.ofHours(2))
);
RedisCacheManager.builder(factory).withInitialCacheConfigurations(configs).build();
```

### TTL jitter

Aligning TTLs causes synchronized expiry (stampede). Add random jitter:

```java
Duration ttl = Duration.ofMinutes(5).plusSeconds(ThreadLocalRandom.current().nextInt(60));
redis.opsForValue().set(key, value, ttl);
```

Or base TTL ± 10% in a custom `RedisCacheWriter`.

### Redis eviction policies (`maxmemory-policy`)

| Policy | Behavior | Use when |
|---|---|---|
| `volatile-lru` | Evict LRU among keys with TTL | Default choice for cache workload |
| `allkeys-lru` | Evict LRU any key | Pure cache, all keys have TTL |
| `volatile-ttl` | Evict shortest TTL first | Mixed TTL |
| `noeviction` | Return errors on write when full | **Dangerous** for cache — writes fail |

Set `maxmemory` **below** instance RAM (leave headroom for fragmentation and AOF rewrite):

```
maxmemory 6gb
maxmemory-policy allkeys-lru
```

### Caffeine local cache eviction

```java
Caffeine.newBuilder()
    .maximumSize(50_000)
    .maximumWeight(100_000_000)  // bytes, with weigher
    .expireAfterWrite(Duration.ofMinutes(5))
    .expireAfterAccess(Duration.ofMinutes(1))
    .weakKeys()   // rare — GC can evict anytime
    .recordStats();
```

### Production scenario: Redis OOM kills node, cluster resharding storm

**Problem.** Black Friday. Redis master OOM (`noeviction`), writes fail, app errors spike. Failover promotes replica; cold cache; DB dies from miss storm.

**Cause.** `maxmemory` = full RAM, `noeviction`, keys without TTL (session dump, unbounded analytics keys).

**Solution.**

1. Switch to `allkeys-lru` or `volatile-lru`; ensure TTL on cache keys.
2. Alert on `used_memory > 80% maxmemory`, `evicted_keys` rate.
3. Separate **cache Redis** from **session/queue Redis** clusters.
4. Application fallback when Redis unavailable: bypass cache, don't fail request (see playbook).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No `maxmemory` limit | Node uses all RAM, Linux OOM killer |
| `noeviction` on cache cluster | Write errors propagate to users |
| Infinite TTL on high-cardinality keys | Memory grows until crash |
| Same TTL for all entity types | Lists expire too fast, static config too slow |

### Debugging scenario

**Observe.** Hit ratio fine, Redis memory climbing 1GB/day.

**Diagnose.**

```bash
redis-cli INFO memory
redis-cli --bigkeys
redis-cli SCAN 0 MATCH product:* COUNT 1000
```

Look for keys without TTL (`TTL key == -1`), oversized values.

**Fix.** Add TTL, compress values, shard large objects, delete orphan key patterns from old deploys.

---

## 9. Cache Stampede and Thundering Herd

### Core concept

**Cache stampede:** many concurrent requests miss the same hot key and all hammer the origin simultaneously. **Thundering herd:** broader — synchronized action (TTL expiry, deploy, cron) causes coordinated load spike.

Classic timeline:

```
T=0   Hot key expires (or cold start)
T=0   10,000 requests → cache MISS
T=0   10,000 threads → SELECT * FROM products WHERE id = 1
T=1   DB connection pool exhausted, timeouts cascade
```

### Mitigations

| Technique | How |
|---|---|
| **Single-flight / request coalescing** | One loader per key; others wait |
| **Distributed lock** | Redis `SET lock:product:1 NX EX 5` |
| **Probabilistic early expiration** | Recompute before TTL at random offset |
| **Stale-while-revalidate** | Serve stale, async refresh in background |
| **TTL jitter** | Spread expiries |
| **Pre-warm** | Load hot keys before peak / after deploy |
| **Circuit breaker on origin** | Stop DB hammer when already failing |

### Single-flight with Spring + Redis

```java
public Product getProductSingleFlight(long id) {
    String key = "product:" + id;
    String lockKey = "lock:product:" + id;

    String cached = redis.opsForValue().get(key);
    if (cached != null) return decode(cached);

    Boolean acquired = redis.opsForValue().setIfAbsent(lockKey, "1", Duration.ofSeconds(10));
    if (Boolean.TRUE.equals(acquired)) {
        try {
            cached = redis.opsForValue().get(key); // double-check
            if (cached != null) return decode(cached);
            Product p = repo.findById(id).orElseThrow();
            redis.opsForValue().set(key, encode(p), jitteredTtl());
            return p;
        } finally {
            redis.delete(lockKey);
        }
    } else {
        // Wait and retry or spin briefly
        Thread.sleep(50);
        return getProductSingleFlight(id);
    }
}
```

**Redisson** `RBucket.get(key, loader)` handles this with `syncSlidingExpiration`.

### Stale-while-revalidate

```java
record CachedValue<T>(T data, Instant softExpiry, Instant hardExpiry) {}

public Product getWithSwr(long id) {
    CachedValue<Product> cv = getCached(id);
    if (cv == null) return loadAndCache(id);
    if (Instant.now().isBefore(cv.softExpiry())) return cv.data();
    if (Instant.now().isBefore(cv.hardExpiry())) {
        asyncRefresh(id); // @Async — don't block
        return cv.data(); // stale but fast
    }
    return loadAndCache(id);
}
```

HTTP analog: `Cache-Control: max-age=60, stale-while-revalidate=300`.

### Production scenario: flash sale product page stampede

**Problem.** 50k users hit `/products/FLASH-SKU` at sale start. Product cached with 60s TTL. TTL expires mid-sale; DB QPS 50k for 3 seconds; site down.

**Cause.** No single-flight; no pre-warm; identical TTL on hottest key.

**Solution.**

1. Pre-warm cache 5 minutes before sale.
2. `refreshAfterWrite` on L1 for hot SKU.
3. Single-flight on miss.
4. Extend soft TTL during event; invalidate only on stock change via event.
5. CDN edge cache for static product JSON.

```java
@Scheduled(cron = "0 55 11 * * *") // 11:55 before noon sale
public void prewarmFlashSku() {
    Product p = repo.findBySku("FLASH-SKU");
    redis.opsForValue().set("product:flash", encode(p), Duration.ofHours(1));
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Cacheable` sync on miss, no lock | DB spike on expiry |
| Lock without double-check | Redundant loads after lock wait |
| Lock TTL too short | Multiple loaders if load > TTL |
| Retry storm + cache miss | Multiplicative load |

### Debugging scenario

**Observe.** DB spikes every 5 minutes on the dot.

**Diagnose.** Fixed TTL on hot keys; plot `cache_miss` vs time. Aligned cron pre-warm without jitter worsens it.

**Fix.** TTL jitter ±10%; single-flight; `refreshAfterWrite`.

---

## 10. Redis Architecture and Data Structures

### Core concept

Redis is a **single-threaded event loop** per shard (Redis 7 with I/O threads for read/write offload on network). Understanding topology and data structures prevents wrong-tool choices — not everything belongs in a JSON string with `@Cacheable`.

### Deployment topologies

| Topology | HA | Scale | Notes |
|---|---|---|---|
| **Standalone** | Manual failover | Vertical | Dev/test only |
| **Redis Sentinel** | Auto failover | Vertical | 3+ sentinels, quorum |
| **Redis Cluster** | Sharded + failover | Horizontal | 16384 hash slots, min 3 masters |
| **Managed (ElastiCache, Azure, Memorystore)** | Vendor-dependent | Horizontal | Prefer for prod |

Spring Boot cluster:

```yaml
spring:
  data:
    redis:
      cluster:
        nodes:
          - redis-1:6379
          - redis-2:6379
          - redis-3:6379
      lettuce:
        cluster:
          refresh:
            adaptive: true
            period: 30s
```

**Hash tags** for multi-key ops in cluster: `{user:42}:profile` and `{user:42}:orders` same slot.

### Data structures for caching patterns

| Structure | Commands | Use case |
|---|---|---|
| **String** | GET/SET/SETEX/MSET | Object JSON, simple cache |
| **Hash** | HGET/HSET/HMGET | Field-level entity cache |
| **List** | LPUSH/LRANGE | Recent items (bounded) |
| **Set** | SADD/SMEMBERS | Tag membership, unique IDs |
| **Sorted Set** | ZADD/ZRANGE | Leaderboards, time-series rank |
| **Bitmap** | SETBIT/GETBIT | Feature flags, DAU |
| **HyperLogLog** | PFADD/PFCOUNT | Cardinality estimate |
| **Stream** | XADD/XREAD | Event log, invalidation bus |

### String vs Hash for entity cache

**String (JSON blob):**

```bash
SET user:42 '{"name":"Ada","email":"ada@ex.com"}' EX 3600
```

Pros: simple, one GET. Cons: update one field rewrites whole blob.

**Hash:**

```bash
HSET user:42 name Ada email ada@ex.com
EXPIRE user:42 3600
```

Pros: partial update `HSET user:42 name Ada Lovelace`. Cons: no nested objects without serialization per field.

### Serialization choices (Spring Data Redis)

| Serializer | Pros | Cons |
|---|---|---|
| `JdkSerializationRedisSerializer` | Default, easy | Opaque, brittle across versions, large |
| `GenericJackson2JsonRedisSerializer` | JSON, readable | Type info needed, schema drift |
| `StringRedisSerializer` | Simple strings | Manual JSON |
| Kryo / protobuf | Compact, fast | Schema coupling |

```java
@Bean
RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory cf) {
    RedisTemplate<String, Object> t = new RedisTemplate<>();
    t.setConnectionFactory(cf);
    t.setKeySerializer(new StringRedisSerializer());
    t.setValueSerializer(new GenericJackson2JsonRedisSerializer());
    t.setHashKeySerializer(new StringRedisSerializer());
    t.setHashValueSerializer(new GenericJackson2JsonRedisSerializer());
    return t;
}
```

Enable default typing carefully — **security risk** if Redis is compromised (deserialization gadgets). Prefer explicit DTOs or `Jackson2JsonRedisSerializer<Product>` typed.

### Persistence: RDB vs AOF

| Mode | Recovery | Performance |
|---|---|---|
| **RDB** | Point-in-time snapshots | Less write overhead |
| **AOF** | Append log, fsync policy | Durability, larger files |
| **Neither** | Pure cache — acceptable | Fastest |

For **cache-only** Redis: disable persistence or use RDB infrequent — you're rebuilding from DB anyway. For **session store**: enable AOF `everysec`.

### Production scenario: Redis Cluster CROSSSLOT error

**Problem.** `@CacheEvict(allEntries=true)` throws `CROSSSLOT Keys in request don't hash to the same slot`. Multi-key transaction fails.

**Cause.** Redis Cluster requires keys in same slot for `MGET`, `DEL` multiple keys, transactions. Spring Cache evict-all scans all keys — works on standalone, fails on cluster without hash tags.

**Solution.**

- Use standalone/sentinel for Spring Cache if you rely on `allEntries`.
- Or custom eviction: publish invalidation event, per-key delete with known hash tags.
- Namespace keys: `{cacheName}:key` — entire cache same slot (limits distribution).

```java
RedisCacheConfiguration.defaultCacheConfig()
    .computePrefixWith(name -> "{" + name + "}:");
```

Trade-off: one cache name = one slot = hot spot on large cache.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `KEYS *` in prod | Redis blocks, latency spike |
| Large values (>512MB theoretically, >1MB practically) | Slow, memory pressure |
| No connection pool tuning | `Lettuce` timeouts under load |
| JDK serialization after class change | `ClassNotFoundException` on get |

### Debugging scenario

**Observe.** Intermittent `MOVED` / `ASK` errors after cluster resize.

**Diagnose.** Stale cluster topology in client. Enable adaptive cluster topology refresh.

**Fix.** `lettuce.cluster.refresh.adaptive=true`; restart clients after resharding; verify all nodes reachable.

---

## 11. Spring Cache Abstraction

### Core concept

Spring Cache provides a **uniform `CacheManager` API** — `@Cacheable`, `@CachePut`, `@CacheEvict`, `@Caching` — backed by Caffeine, Redis, EhCache, Hazelcast, etc. It is AOP-based: annotations on **public** methods of Spring beans only.

### Enable caching

```java
@SpringBootApplication
@EnableCaching
public class Application { }
```

```xml
<!-- dependency -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
```

### Annotation reference

| Annotation | Behavior |
|---|---|
| `@Cacheable` | Cache result; skip method if hit |
| `@CachePut` | Always run method; update cache |
| `@CacheEvict` | Remove entries (before/after invocation) |
| `@Caching` | Group multiple cache annotations |
| `@CacheConfig` | Class-level cache name defaults |

```java
@Service
@CacheConfig(cacheNames = "orders")
public class OrderQueryService {

    @Cacheable(key = "#id")
    public OrderDto getOrder(Long id) { ... }

    @CachePut(key = "#result.id")
    public OrderDto refreshOrder(Long id) { ... } // force reload into cache

    @CacheEvict(key = "#id")
    public void cancelOrder(Long id) { ... }
}
```

### SpEL key expressions

```java
@Cacheable(value = "products", key = "#id")
@Cacheable(value = "products", key = "'sku:' + #sku")
@Cacheable(value = "search", key = "#query + ':' + #page + ':' + #size")
@Cacheable(value = "tenantData", key = "#root.methodName + ':' + T(com.app.TenantContext).get()")
@Cacheable(value = "users", key = "#user.id", condition = "#user.id != null")
@Cacheable(value = "products", unless = "#result == null or #result.disabled")
```

**Always include tenant ID in multi-tenant apps** — otherwise tenant A sees tenant B's cache entry.

### Custom KeyGenerator

```java
@Bean
KeyGenerator tenantAwareKeyGenerator() {
    return (target, method, params) -> {
        String tenant = TenantContext.get();
        return tenant + ":" + method.getName() + ":" + Arrays.deepHashCode(params);
    };
}
```

### CacheManager beans

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    @Primary
    CacheManager redisCacheManager(RedisConnectionFactory factory) {
        return RedisCacheManager.builder(factory)
            .cacheDefaults(RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(10))
                .disableCachingNullValues()
                .serializeKeysWith(RedisSerializationContext.SerializationPair
                    .fromSerializer(new StringRedisSerializer()))
                .serializeValuesWith(RedisSerializationContext.SerializationPair
                    .fromSerializer(new GenericJackson2JsonRedisSerializer())))
            .transactionAware() // evict after DB commit if in @Transactional
            .build();
    }

    @Bean
    CacheManager localCacheManager() {
        CaffeineCacheManager cm = new CaffeineCacheManager("referenceData");
        cm.setCaffeine(Caffeine.newBuilder().maximumSize(500).expireAfterWrite(Duration.ofHours(1)));
        return cm;
    }
}
```

Multiple `CacheManager` beans require `@Qualifier` on `@EnableCaching` or custom `CachingConfigurer` — otherwise `@Primary` wins for all caches.

### `@Cacheable` + `@Transactional` interaction

Default: cache put happens **after** method returns, even if transaction rolls back — **dirty cache**.

```java
RedisCacheManager.builder(factory).transactionAware().build();
```

With `transactionAware()`, cache put/evict deferred until transaction commit. **Must use `@Transactional` through Spring proxy** and `CacheManager` that supports it (Redis yes).

### Reactive caching (WebFlux)

`@Cacheable` on `Mono`/`Flux` is problematic — aspect caches the reactive type, not the data. Use:

```java
public Mono<Product> findById(long id) {
    return Mono.fromCallable(() -> localCache.get(id))
        .flatMap(opt -> opt.map(Mono::just).orElseGet(() ->
            repo.findById(id).doOnNext(p -> localCache.put(id, p))));
}
```

Or Spring Framework 6.1+ `@Cacheable` sync=false experimental support — verify version docs.

### Production scenario: `@CachePut` on create returns DTO without ID populated

**Problem.** Create user caches object with `id=null`. Subsequent get by email hits wrong cache entry.

**Cause.** `@CachePut(key = "#result.id")` when ID generated by DB after insert — key is `null` or wrong.

**Solution.** `@CacheEvict` lists instead; or `@CachePut` after save when ID exists:

```java
@Transactional
public User create(User u) {
    User saved = repo.save(u);
    return saved; // ID now populated
}

@CachePut(value = "users", key = "#result.id")
@Transactional
public User createAndCache(User u) {
    return repo.save(u);
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Caching mutable objects | Callers mutate cached instance — corruption |
| `sync=true` without Redis | Vendor may ignore — check docs |
| `@Cacheable` on repository interface | May not proxy depending on setup |
| Same cache name, different value types | Deserialization chaos |

### Debugging scenario

**Observe.** Cache works in integration test, not prod.

**Diagnose.** Profile-specific `CacheManager` — test uses `ConcurrentMapCacheManager`, prod Redis. Conditional `@Bean`.

**Fix.** Align profiles; add smoke test against Redis Testcontainers in CI.

---

## 12. Spring Boot + Redis Integration

### Core concept

Spring Boot auto-configures **Lettuce** (default) or **Jedis** client, `RedisTemplate`, `StringRedisTemplate`, and (with `spring-boot-starter-cache`) Redis-backed `CacheManager`. Production requires explicit connection pooling, timeouts, cluster awareness, and health checks.

### Dependencies and properties

```yaml
spring:
  application:
    name: catalog-service
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
          max-wait: 1000ms
  cache:
    type: redis
    redis:
      time-to-live: 600000
      cache-null-values: false
      key-prefix: "catalog:"
      use-key-prefix: true
```

### RedisTemplate patterns

```java
@Service
@RequiredArgsConstructor
public class SessionStore {

    private final StringRedisTemplate redis;

    public void saveSession(String sessionId, UserSession session) {
        redis.opsForValue().set(
            "session:" + sessionId,
            toJson(session),
            Duration.ofHours(24));
    }

    public Optional<UserSession> getSession(String sessionId) {
        return Optional.ofNullable(redis.opsForValue().get("session:" + sessionId))
            .map(this::fromJson);
    }

    public void addToRecentProducts(String userId, long productId) {
        String key = "recent:" + userId;
        redis.opsForList().leftPush(key, String.valueOf(productId));
        redis.opsForList().trim(key, 0, 19); // keep 20
        redis.expire(key, Duration.ofDays(7));
    }

    public boolean tryRateLimit(String clientId, int limit, Duration window) {
        String key = "ratelimit:" + clientId;
        Long count = redis.opsForValue().increment(key);
        if (count != null && count == 1) redis.expire(key, window);
        return count != null && count <= limit;
    }
}
```

### Redisson (advanced)

For locks, semaphores, maps with TTL:

```java
@Configuration
public class RedissonConfig {
    @Bean
    RedissonClient redisson() {
        Config config = new Config();
        config.useSingleServer().setAddress("redis://redis:6379");
        return Redisson.create(config);
    }
}

// Usage
RLock lock = redisson.getLock("lock:product:" + id);
try {
    if (lock.tryLock(5, 10, TimeUnit.SECONDS)) {
        // load and cache
    }
} finally {
    lock.unlock();
}
```

### Health and readiness

```yaml
management:
  health:
    redis:
      enabled: true
  endpoint:
    health:
      show-details: when_authorized
```

Customize: cache Redis down → service **degraded** (read bypass), not **down** — unless sessions stored only in Redis.

```java
@Component
public class RedisHealthIndicator implements HealthIndicator {
    private final RedisConnectionFactory factory;

    @Override
    public Health health() {
        try (var conn = factory.getConnection()) {
            conn.ping();
            return Health.up().build();
        } catch (Exception e) {
            return Health.down().withException(e).build();
        }
    }
}
```

### Production scenario: Lettuce connection pool exhausted

**Problem.** 400 threads, `max-active: 8`. Requests block on pool, timeouts cascade.

**Cause.** Default pool too small; long-running Redis ops (accidental `KEYS`); connection leak in custom code not using try-with-resources.

**Solution.**

```yaml
spring.data.redis.lettuce.pool.max-active: 32
spring.data.redis.lettuce.pool.max-wait: 500ms
```

Fix leaks; never block event loop thread on Redis in WebFlux. Monitor `lettuce.pool.active`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No password in prod | Open Redis — security incident |
| `timeout` too high | Threads blocked during Redis outage |
| Sharing Redis with untrusted apps | Key collision, `FLUSHALL` risk |
| SSL disabled on managed Redis | Connection refused in cloud |

### Debugging scenario

**Observe.** `RedisConnectionFailureException` after VPC change.

**Diagnose.** Security group, TLS requirement, cluster endpoint vs primary.

```bash
redis-cli -h host -p 6379 --tls -a pass PING
```

**Fix.** Update `spring.data.redis.ssl.enabled=true`, correct host/port.

---

## 13. Distributed Caching in Microservices

### Core concept

Each microservice should **own its cache**. Shared Redis instance is OK; **shared cache keys read/written by multiple services** is an anti-pattern that couples deploy cycles and breaks consistency.

```
                    ┌─────────────────┐
  API Gateway ─────►│ catalog-service │──► catalog-redis (namespace catalog:*)
                    └────────┬────────┘
                             │ REST/gRPC
                    ┌────────▼────────┐
                    │ inventory-svc   │──► inventory-redis (inventory:*)
                    └─────────────────┘
```

### Patterns across services

| Pattern | Description |
|---|---|
| **Cache-aside per service** | Each service caches its own DB reads |
| **API composition** | BFF calls services; each caches internally |
| **Event-driven invalidation** | Domain events evict downstream caches |
| **CDN / edge cache** | Static and semi-static public JSON |
| **Materialized view** | Denormalized read model in Redis/ES, fed by events |

### Invalidation across bounded contexts

```java
// Order placed → inventory must evict stock cache
@TransactionalEventListener
public void onOrderPlaced(OrderPlacedEvent e) {
    kafkaTemplate.send("domain.order.placed", e);
}

// inventory-service
@KafkaListener(topics = "domain.order.placed")
public void evictStock(OrderPlacedEvent e) {
    e.lines().forEach(line ->
        cacheManager.getCache("stock").evict(line.skuId()));
}
```

Prefer **at-least-once** eviction — duplicate evict is safe; missed evict is not.

### BFF aggregation cache

```java
@Cacheable(value = "productPage", key = "#productId")
public ProductPageDto getProductPage(long productId) {
    Product p = catalogClient.getProduct(productId);
    Stock s = inventoryClient.getStock(p.getSku());
    Reviews r = reviewsClient.getReviews(productId);
    return new ProductPageDto(p, s, r);
}
```

Invalidate on **any** upstream change is hard — use short TTL (30–60s) + event partial evict, or cache components separately:

```java
Product p = catalog.get(productId);      // cached in catalog
Stock s = inventory.get(sku);            // cached in inventory  
// BFF caches only the assembled page with short TTL
```

### Production scenario: shared Redis DB index collision

**Problem.** Team A `FLUSHDB` on "their" cache during debug. Team B loses sessions.

**Cause.** Same Redis instance, same database index `0`, no key prefix discipline.

**Solution.**

- Separate clusters for cache vs sessions vs queues
- Mandatory key prefix: `spring.cache.redis.key-prefix: ${spring.application.name}:`
- Never `FLUSHALL` in shared environments — use prefix delete via SCAN

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Service reads another service's Redis keys | Breaks on schema change |
| No correlation ID in cache logs | Can't trace cross-service stale |
| Global cache clear script | Production outage |

### Debugging scenario

**Observe.** Service B stale only when Service A deploys.

**Diagnose.** Shared cache key format changed in A; B reads old format bytes.

**Fix.** Version keys (`v2:product:`); contract tests for cached DTO schema.

---

## 14. Consistency, Staleness, and CAP Trade-offs

### Core concept

Distributed cache adds **eventual consistency** between origin and cache. CAP: during partition, choose **availability** (serve possibly stale cache) vs **consistency** (fail if can't verify fresh).

Most ecommerce/catalog systems choose **AP** for reads: serve stale with TTL bound; **strong consistency** for inventory/payment via DB transactions, not cache.

### Consistency levels (practical)

| Level | Description | Example |
|---|---|---|
| **Strong** | Read always reflects latest write | Don't cache; or sync read from primary DB |
| **Read-your-writes** | Same user sees own update | Session stickiness + evict on write for user scope |
| **Eventual** | Converges within TTL/event lag | Product description cache |
| **Bounded staleness** | Max age guaranteed | TTL 60s |

### Read-your-writes pattern

```java
@Cacheable(value = "profiles", key = "#userId")
public Profile getProfile(String userId) { ... }

@CacheEvict(value = "profiles", key = "#userId")
public Profile updateProfile(String userId, ProfileDto dto) { ... }
```

User updates profile → evict → next read loads fresh. Other users may see old version until TTL (acceptable for profiles).

### Linearizability vs cache

You **cannot** get linearizable reads from a eventually-invalidated Redis cache without treating cache as part of a distributed transaction (impractical). For money:

```java
// NO @Cacheable on balance
public BigDecimal getBalance(String accountId) {
    return accountRepository.findBalance(accountId);
}
```

Maybe cache **read models** with explicit version:

```java
if (cached.version() < eventVersion) { reload(); }
```

### Production scenario: CAP choice during Redis partition

**Problem.** Redis cluster split-brain. Some pods write to minority partition; reads inconsistent across regions.

**Cause.** Chose availability — apps kept writing cache without quorum verification.

**Solution.**

- Monitor cluster state; circuit-break Redis writes on `CLUSTERDOWN`
- Fallback: bypass cache, read DB only
- For multi-region: active-passive Redis or region-local cache with short TTL + async replication acceptance

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Cache balances | Financial discrepancies |
| Assuming Redis write = committed DB | Phantom reads |
| Ignoring replication lag (read replica + cache) | Stale from both layers |

---

## 15. Observability: Metrics, Traces, and Alerts

### Core concept

You cannot operate what you cannot measure. Cache incidents look like "DB slow" or "random 500s" without hit ratio, latency, memory, and eviction metrics.

### Key metrics

| Metric | Alert threshold idea |
|---|---|
| `cache.hit.ratio` (per cache name) | < 80% on cached endpoints |
| `cache.gets` hits vs misses | Miss spike |
| `redis.used_memory / maxmemory` | > 85% |
| `redis.evicted_keys` rate | Sustained > 0 |
| `redis.connected_clients` | Sudden drop (failover) or spike (leak) |
| `redis.commands.processed` latency p99 | > 5ms intranet |
| Application `redis.timeout.count` | Any sustained |

### Micrometer + Spring Boot 3

```java
@Bean
public CacheManager cacheManager(RedisConnectionFactory factory, MeterRegistry registry) {
    RedisCacheManager redis = RedisCacheManager.builder(factory).build();
    return new CaffeineCacheMetricsRegistrar(registry, List.of()).bindTo(redis);
    // Or wrap caches:
}

@Component
public class CacheMetrics implements CacheManager {
    private final CacheManager delegate;
    private final MeterRegistry registry;

    @Override
    public Cache getCache(String name) {
        return new InstrumentedCache(delegate.getCache(name), name, registry);
    }
}
```

Caffeine:

```java
Caffeine.newBuilder().recordStats();
// expose: caffeine_cache_hit_total, miss_total, load_seconds
```

### Tracing

Add span attributes on cache operations:

```java
span.setAttribute("cache.name", "products");
span.setAttribute("cache.key", key);
span.setAttribute("cache.hit", hit);
```

Distributed trace showing DB call on every request → cache not working.

### Logging (staging only)

```yaml
logging.level.org.springframework.cache=TRACE
logging.level.org.springframework.data.redis=DEBUG
```

Never log full cache values in prod — PII.

### Production scenario: hit ratio 95% but users report stale prices

**Problem.** Metrics green; business wrong.

**Cause.** Hit ratio on **wrong cache** or **wrong keys** — evictions failing silently. 95% hits on `referenceData` while `products` never hit.

**Solution.**

- Metric tags: `cache_name`, `operation`, `result=hit|miss`
- Business audit: sample compare cache vs DB
- Alert on `@CacheEvict` failures (custom aspect)

### Alert runbook snippet

```
ALERT: cache_hit_ratio{cache="products"} < 0.7 for 5m
→ Check recent deploy (key format change?)
→ Check Redis memory/evictions
→ Check invalidation consumer lag
→ Temporary: reduce TTL, warm cache, scale DB if stampede
```

---

## 16. Testing Cache Configuration

### Core concept

Tests that mock everything never catch broken SpEL keys, wrong serializer, or missing eviction. Use **Testcontainers Redis** + assertion on call count.

### `@SpringBootTest` + Testcontainers

```java
@Testcontainers
@SpringBootTest
class ProductCacheIT {

    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @DynamicPropertySource
    static void redisProps(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", redis::getHost);
        registry.add("spring.data.redis.port", redis::getFirstMappedPort);
    }

    @Autowired ProductService service;
    @Autowired ProductRepository repo;

    @Test
    void secondCallDoesNotHitDb() {
        repo.save(new Product(1L, "Widget"));
        service.findById(1L);
        service.findById(1L);
        verify(repo, times(1)).findById(1L); // Mockito spy or datasource proxy
    }

    @Test
    void updateEvictsCache() {
        repo.save(new Product(1L, "Widget"));
        service.findById(1L);
        service.update(new Product(1L, "Super Widget"));
        Product p = service.findById(1L);
        assertThat(p.getName()).isEqualTo("Super Widget");
        verify(repo, times(2)).findById(1L); // once before update, once after evict
    }
}
```

### Test `CacheManager` directly

```java
@Test
void cacheEvictAllClearsRedis() {
    Cache cache = cacheManager.getCache("products");
    cache.put("1", product);
    assertThat(cache.get("1")).isNotNull();
    service.deleteAllProducts();
    assertThat(cache.get("1")).isNull();
}
```

### What to test

| Scenario | Assert |
|---|---|
| First call miss | Repository invoked once |
| Second call hit | Repository not invoked |
| Update evicts | Fresh data after update |
| Null not cached (`unless`) | Repeated null → repeated DB calls |
| TTL expiry | After sleep/FakeClock, reload |
| Redis down | Fallback behavior (if configured) |
| Serializer round-trip | Complex object equals after cache |

### Production scenario: cache tests green, prod uses different profile

**Problem.** CI uses `ConcurrentMapCacheManager`; prod uses Redis with JSON serializer that fails on `LazyInitializationException`.

**Cause.** `@Profile("test")` cache config.

**Solution.** Testcontainers Redis in CI mandatory for merge; one integration test per critical `@Cacheable` method.

---

## 17. Production Debugging Playbook

When "data is wrong" or "Redis is slow," work through this list before restarting pods or flushing Redis.

1. **Classify the symptom.** Stale data (invalidation/TTL)? Missing data (eviction/OOM)? Slow (network/stampede/serialization)? Errors (connection/pool/cluster)?

2. **Check hit ratio first.**

   ```bash
   curl -s localhost:8080/actuator/metrics/cache.gets | jq
   curl -s localhost:8080/actuator/metrics/cache.puts | jq
   ```

3. **Inspect the key in Redis** (staging/replica — never `MONITOR` in prod):

   ```bash
   redis-cli GET "catalog:products::42"
   redis-cli TTL "catalog:products::42"
   redis-cli MEMORY USAGE "catalog:products::42"
   ```

4. **Verify code path hits cache.** Self-invocation? Private method? Wrong profile? Multiple `CacheManager` beans?

5. **Trace one request.** Span should show cache hit or miss. If always miss, dump computed SpEL key vs Redis key prefix.

6. **Memory pressure.**

   ```bash
   redis-cli INFO memory
   redis-cli INFO stats | grep evicted
   ```

7. **Invalidation path.** Did Kafka consumer lag? Did `@CacheEvict` run? Transaction rolled back with `transactionAware`?

8. **Stampede check.** DB QPS spike correlates with TTL boundary? Fix single-flight before scaling DB.

9. **Cluster health.**

   ```bash
   redis-cli CLUSTER INFO
   redis-cli CLUSTER NODES
   ```

10. **Temporary mitigation order:**
    - Increase TTL slightly to reduce miss rate (accept staleness)
    - Enable single-flight / lock on hot keys
    - Bypass cache (`spring.cache.type=none` on canary) to confirm cache is root cause
    - Scale DB only after stampede ruled out
    - **Never `FLUSHALL`** unless isolated cache cluster and accept cold start

11. **Post-incident:** document write path that bypassed eviction; add integration test.

---

## 18. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Read-heavy catalog, 5-min staleness OK | Cache-aside + Redis TTL + `@Cacheable` |
| Hot key (flash sale SKU) | L1 Caffeine + single-flight + pre-warm + event invalidation |
| User profile after own edit | `@CacheEvict` on write — read-your-writes |
| Account balance / inventory for checkout | DB authoritative; short TTL or no cache on write path |
| Cross-service data need | Call API; don't read their Redis keys |
| Multi-tenant SaaS | Tenant ID in every cache key |
| Paginated search results | Cache with query hash key OR don't cache; avoid `allEntries` |
| Write-heavy counters (views) | Redis `INCR` + periodic flush OR write-behind with durable queue |
| Redis down | Degrade: bypass cache, hit DB; don't fail user request if possible |
| Cluster + `allEntries` evict | Hash-tag prefix `{cacheName}:` or per-key evict via events |
| Large object graphs | Cache slim DTO; avoid lazy JPA in cached methods |
| Deploy causes miss storm | Pre-warm; stagger pod restarts; TTL jitter |
| Session storage | Dedicated Redis; AOF; not same as cache cluster |
| Global config change | Version bump key namespace or pub/sub L1 invalidation |
| Testing | Testcontainers Redis; verify miss/hit/evict counts |
| JSON serialization | Typed serializer; no default typing in prod |
| Stale acceptable at CDN | `Cache-Control` + short origin TTL |

---

## 19. Interview Q&A

### Q1. What is cache-aside and how does it differ from read-through?

**A.** Cache-aside: the application checks cache, on miss loads from DB and populates cache. Read-through: the cache library loads from DB on miss — application only talks to cache. Spring `@Cacheable` is cache-aside — the annotated method is the loader invoked on miss.

### Q2. When would you use write-through vs write-behind?

**A.** Write-through: synchronous write to cache and DB — use when you need durability and can accept write latency (inventory sync with careful ordering). Write-behind: async DB flush — use for high-write non-critical data (analytics, view counts) where brief loss on crash is acceptable.

### Q3. How do you invalidate cache in a microservices architecture?

**A.** TTL as safety net; explicit `@CacheEvict` or `DEL` on every write path in owning service; domain events (Kafka) for cross-service eviction; version bump in key namespace for bulk logical invalidation; pub/sub for L1 invalidation across pods.

### Q4. What is cache stampede and how do you prevent it?

**A.** Many concurrent requests miss the same hot key and overload the origin. Prevention: single-flight/request coalescing, distributed lock on populate, TTL jitter, stale-while-revalidate, pre-warming, circuit breaker on origin.

### Q5. Explain Redis eviction policies. Which for pure cache?

**A.** When `maxmemory` reached: `volatile-lru` evicts LRU keys with TTL; `allkeys-lru` evicts any key LRU; `volatile-ttl` evicts shortest TTL; `noeviction` returns errors. Pure cache: `allkeys-lru` with TTL on all keys, or `volatile-lru` if every key has TTL.

### Q6. How does `@Cacheable` work internally in Spring?

**A.** AOP `CacheInterceptor` around proxied bean methods. Computes key via SpEL, `Cache.get(key)` — on hit returns without invoking method; on miss invokes method, `Cache.put(key, result)` unless `unless` prevents it.

### Q7. Why doesn't `@Cacheable` work on self-invocation?

**A.** Spring AOP uses proxies. Calling `this.findById()` from within the same class bypasses the proxy — no interceptor runs. Fix: inject self, move to another bean, or use AspectJ compile-time weaving.

### Q8. What happens if you cache null results?

**A.** By default Spring Cache may cache null (protects against repeated misses for non-existent keys). Use `unless = "#result == null"` to skip, or `disableCachingNullValues()` in Redis config. Cached null causes confusion if row later created — use short TTL or negative-cache sentinel with eviction on create.

### Q9. Redis Cluster vs Sentinel — when to use which?

**A.** Sentinel: single primary, automatic failover, vertical scale, simpler client. Cluster: sharded data across masters, horizontal scale, needed for large datasets/high throughput. Spring Cache `allEntries` eviction is harder on cluster — consider hash tags or standalone.

### Q10. How do you ensure cache consistency with database transactions?

**A.** Update DB first, evict/update cache after commit (`@TransactionalEventListener(AFTER_COMMIT)` or `transactionAware()` CacheManager). Never update cache before commit. For read-your-writes, evict on same user's write immediately.

### Q11. What are the risks of sharing Redis between services?

**A.** Key collisions, accidental `FLUSHDB`, schema coupling via shared key formats, security boundary blur, noisy neighbor memory pressure. Prefer logical separation: key prefixes, database indexes, or separate clusters.

### Q12. L1 + L2 caching — what invalidation strategy?

**A.** On write: evict/update L2, publish invalidation event for L1 on all pods. TTL on L1 shorter than L2. Never evict L2 only — L1 serves stale until its TTL expires.

### Q13. How do you choose TTL?

**A.** Balance staleness tolerance vs hit ratio vs memory. Start with business SLA ("price can be 60s old"), add jitter, measure miss rate and staleness complaints. Hot static data: longer TTL + event invalidation. Volatile data: short TTL or no cache.

### Q14. What serialization format for Redis in Java?

**A.** Avoid JDK serialization in prod — brittle and opaque. Prefer JSON (`GenericJackson2JsonRedisSerializer`) with typed DTOs, or Kryo/protobuf for performance. Never enable Jackson default typing without understanding deserialization security risks.

### Q15. How does `sync=true` on `@Cacheable` help?

**A.** For a given key, only one thread executes the method while others wait — built-in single-flight for that cache provider. Supported meaningfully when backed by Redis (Redisson) or concurrent map; verify provider docs. Reduces stampede on hot key miss.

### Q16. Difference between `@CachePut` and `@CacheEvict` + `@Cacheable`?

**A.** `@CachePut` always runs method and puts result in cache — use for forced refresh. `@CacheEvict` removes entries — use on writes. `@Cacheable` skips method on hit — use for reads. Don't `@CachePut` on create until all key fields (like ID) exist.

### Q17. How do you handle Redis failure in production?

**A.** Treat cache as optimization, not requirement. Catch connection exceptions, bypass to DB, log metric `cache.bypass`. Circuit-break Redis client after repeated failures to protect DB from stampede when Redis comes back. Sessions in Redis may require different failover strategy than object cache.

### Q18. What is stale-while-revalidate?

**A.** Serve slightly expired cached value immediately while asynchronously refreshing in background. Improves latency during revalidation window; user may see stale data within bounded window. HTTP `stale-while-revalidate` header is the CDN analog.

### Q19. Why is `KEYS *` dangerous in production?

**A.** `KEYS` scans entire keyspace in single thread, blocking Redis — latency spikes for all clients. Use `SCAN` iteratively for admin tasks. Spring Cache evict-all uses SCAN in modern versions — verify.

### Q20. How do you cache paginated query results?

**A.** Key = hash of query params including page, size, sort. Invalidation hard — any create/update may invalidate many pages. Options: short TTL, cache only first page, don't cache lists (cache entities by ID only), or `allEntries` evict on any write (expensive). Often better to cache search index (Elasticsearch) not SQL page results.

### Q21. Explain thundering herd vs cache stampede.

**A.** Cache stampede is a subset: many misses on same key simultaneously. Thundering herd is broader synchronized behavior — TTL expiry alignment, cron jobs, circuit half-open probes, deploy cold start. Both fixed with jitter, single-flight, pre-warm, staggered schedules.

### Q22. Multi-tenant cache isolation?

**A.** Include `tenantId` in every key (`tenant:42:product:7`). Never global shared keys for tenant data. Evict scoped to tenant on tenant-scoped writes. Test cross-tenant leakage explicitly.

### Q23. How would you cache a method that returns `Optional`?

**A.** `Optional` is serializable awkwardly — prefer `@Cacheable(unless = "#result.isEmpty()")` caching the inner value or null. Or return nullable type from cached layer. Be explicit about whether empty should be cached (negative cache).

### Q24. What metrics prove caching is working?

**A.** High hit ratio on target cache name, reduced DB QPS/latency for cached endpoints, Redis GET latency stable, miss spikes only on deploy/TTL boundaries. Compare canary with cache disabled vs enabled.

### Q25. Design caching for an e-commerce product detail page.

**A.** CDN for static assets. BFF or catalog-service caches product DTO in Redis (cache-aside, 5–10m TTL, event invalidation on catalog update). Inventory stock: separate short-TTL cache (30s) or no cache — call inventory API; evict on `StockChanged` event. L1 Caffeine for hottest SKUs. Single-flight on miss. Pre-warm before campaigns. Never cross-read inventory Redis from catalog service.

### Q26. What is cache penetration vs cache breakdown vs cache avalanche?

**A.** **Penetration:** queries for non-existent keys bypass cache repeatedly — fix with negative caching (brief TTL for null), bloom filter. **Breakdown (stampede):** hot key expires, mass miss — single-flight, jitter. **Avalanche:** Redis down or mass expiry, DB overwhelmed — circuit breaker, degraded mode, tiered TTL, limit concurrency to origin.

### Q27. How does Redis single-threaded model affect cache design?

**A.** One CPU-bound thread per shard handles commands — very fast ops (GET/SET) scale to 100k+ ops/s per core. Slow commands (`KEYS`, big `SMEMBERS`, Lua long scripts) block all clients on that shard. Keep values small, avoid blocking commands, shard hot keys across cluster.

### Q28. `@CacheEvict(beforeInvocation=true)` vs false?

**A.** `false` (default): evict after method succeeds — if method throws, cache unchanged. `true`: evict before — use when method failure should still clear stale data, or updating in place; risk if method fails after evict — next read loads old DB value into cache then method never updated DB.

---

*Caching will not fix a missing database index. The cache reduces read cost; your invalidation strategy and ownership boundaries determine whether users see truth. Measure hit ratio, test eviction paths, and never treat Redis as the system of record unless you designed it that way.*
