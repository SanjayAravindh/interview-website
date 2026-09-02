/**
 * Answers for Q&A items left as reformat stubs.
 * Keys are normalized summary prefixes (first line, trimmed).
 */
module.exports = {
  springCore: {
    "1. Three reasons for constructor injection: immutability, guaranteed non-null state, testability without a container (plus circular-dependency fail-fast and visible design smells).":
      "Constructor injection is the default because:\n\n1. **Immutability** — only constructor injection allows `final` fields; the object cannot be half-wired after construction.\n2. **Guaranteed non-null state** — required dependencies must be supplied before the instance exists; no NPE from forgotten injection.\n3. **Testability without a container** — plain `new Service(fakeDep)` works in unit tests.\n4. **Circular-dependency fail-fast** — the container detects cycles at startup instead of at runtime.\n5. **Visible design smell** — a constructor with ten parameters is obvious; field injection hides dependency count.",

    "2. Setter injection is right when a dependency is genuinely optional.":
      "Use setter (or field) injection when a dependency may legitimately be absent: `@Autowired(required = false)` on the setter, or `ObjectProvider<T>` / `Optional<T>` for lazy/optional resolution. Example: an `SmsService` that augments email notifications when SMS is configured, but the app runs fine without it. Do **not** use optional injection to paper over a missing required bean — that turns a startup failure into a production NPE.",

    "1. Forcing explicit disambiguation everywhere: use `@Qualifier` on every site, avoid `@Primary` (which creates a silent default).":
      "Teams that ban `@Primary` force every injection point to name its candidate explicitly via `@Qualifier` or a custom qualifier annotation. Benefit: no silent default that masks a wrong bean until an unrelated refactor. Trade-off: more annotation noise, but ambiguity errors become compile-time-visible design decisions rather than runtime surprises.",

    "2. `@Autowired`+`@Qualifier` resolves by type first; `@Resource` resolves by name first.":
      "`@Autowired` (with optional `@Qualifier`) matches by **type** first, then narrows by qualifier/name. `@Resource` (JSR-250) matches by **name** first (`@Resource(name = \"stripeGateway\")`), falling back to type. Legacy/portable code often uses `@Resource`; modern Spring code prefers constructor + `@Qualifier`. Mixing them without knowing the resolution order causes \"it works in one class but not another\" bugs.",

    "1. Field-injecting a prototype into a singleton resolves once at construction. Fixes: `ObjectProvider` or scoped proxy.":
      "A `singleton` resolves dependencies once at its own construction. Field-injecting a `prototype` bean gives the **same instance forever**, defeating prototype scope.\n\n**Fixes:**\n- `ObjectProvider<ReportBuilder> builder` → `builder.getObject()` per use.\n- `@Scope(value = ConfigurableBeanFactory.SCOPE_PROTOTYPE, proxyMode = ScopedProxyMode.TARGET_CLASS)` so the singleton holds a proxy that fetches a fresh target each call.",

    "1. Order: constructor → setter injection → `postProcessBeforeInitialization` → `@PostConstruct` → `postProcessAfterInitialization`.":
      "Singleton lifecycle order:\n1. Constructor\n2. Setter/field injection (`AutowiredAnnotationBeanPostProcessor`)\n3. `BeanPostProcessor.postProcessBeforeInitialization`\n4. `@PostConstruct` / `InitializingBean.afterPropertiesSet`\n5. `BeanPostProcessor.postProcessAfterInitialization` (AOP proxy wrapping happens here)\n\nAware callbacks (`BeanNameAware`, etc.) run before `@PostConstruct`. `@PreDestroy` runs on graceful shutdown.",

    "2. `@PostConstruct` runs after `Aware` callbacks and any setter/field injection, and keeps initialization separately testable from field assignment.":
      "By the time `@PostConstruct` runs, all injections are complete, so initialization logic can safely use dependencies. Unlike cramming setup into the constructor, `@PostConstruct` separates **wiring** from **initialization**, and you can invoke the init method directly in tests without a container. Avoid heavy I/O here if it blocks startup — move to `@EventListener(ApplicationReadyEvent)` or lazy init when appropriate.",

    "1. `BeanFactoryPostProcessor` touches definitions/metadata pre-instantiation; `BeanPostProcessor` touches instances during lifecycle.":
      "`BeanFactoryPostProcessor` — runs **before** bean instantiation; modifies `BeanDefinition` metadata (e.g. `PropertySourcesPlaceholderConfigurer`, custom definition tweaks). `BeanPostProcessor` — runs **per bean instance** before/after initialization (`AutowiredAnnotationBeanPostProcessor`, `AnnotationAwareAspectJAutoProxyCreator`). Confusing them leads to \"my processor never runs\" when registered on the wrong type.",

    "2. `AnnotationAwareAspectJAutoProxyCreator`; runs in `postProcessAfterInitialization` so it wraps the fully-initialized bean.":
      "Spring AOP auto-proxying is implemented by `AnnotationAwareAspectJAutoProxyCreator` (a `BeanPostProcessor`). It runs in **`postProcessAfterInitialization`** so the target is fully constructed and initialized before the proxy wrapper is applied. Advising in `beforeInitialization` would wrap a half-initialized object.",

    "1. Field injection can hand out a raw, shared-identity instance early; constructor injection has no partially-built object to hand out.":
      "With field injection, the object exists (same reference) before `@Autowired` fields are populated — anything that captures `this` during construction sees null dependencies. Constructor injection ensures the object cannot be observed until fully wired. Circular dependencies via field injection can also be masked until runtime.",

    "2. Most to least preferable: extract shared collaborator > `@Lazy` > field/setter injection.":
      "1. **Extract a third bean** holding the shared dependency both sides need — breaks the cycle cleanly.\n2. **`@Lazy` on one constructor parameter** — injects a proxy that defers resolution.\n3. **Field/setter injection** on one side — works but hides the cycle and delays failure.\nAvoid `@Lazy` as a permanent architecture fix; it papers over design problems.",

    "1. `@Service` = `@Component`, no functional difference. `@Repository` does differ (exception translation).":
      "`@Service`, `@Component`, `@Controller` are functionally `@Component` with different semantic stereotypes for scanning clarity. `@Repository` additionally registers `PersistenceExceptionTranslationPostProcessor`, translating persistence exceptions to Spring's `DataAccessException` hierarchy. `@Controller` + `@RestController` pair with MVC request mapping.",

    "2. A sibling package isn't scanned by default. Fixes: widen `basePackages`, or move the app class to the common parent package.":
      "`@ComponentScan` (and `@SpringBootApplication`'s default scan) starts at the package of the class carrying the annotation and scans **sub-packages only**. `com.acme.app` does not scan `com.acme.legacy`. Fixes: `@ComponentScan(basePackages = \"com.acme\")`, `@Import(LegacyConfig.class)`, or relocate `@SpringBootApplication` to `com.acme`.",

    "1. `@EnableAsync` uses `@Import` internally to pull in the config registering the `@Async`-detecting `BeanPostProcessor`.":
      "Meta-annotations like `@EnableAsync`, `@EnableScheduling`, `@EnableTransactionManagement` are implemented via `@Import` of selector/registrar classes that register the necessary infrastructure beans (`AsyncAnnotationBeanPostProcessor`, `ScheduledAnnotationBeanPostProcessor`, etc.). Understanding `@Import` explains how \"one annotation on the main class\" wires entire subsystems.",

    "2. Type-safe group binding + nested structure support (any two of the listed reasons).":
      "`@ConfigurationProperties` over loose `@Value` because:\n- **Type-safe binding** — ints, durations, enums without manual parsing.\n- **Nested structure** — `server.ssl.key-store` maps to nested objects.\n- **Validation** — `@Validated` + JSR-303 on the properties class.\n- **Relaxed binding** — `ACME_API_URL` maps to `acme.api.url`.\n- **Metadata** — Boot configuration processor generates IDE hints.",

    "1. `${...}` is plain substitution; `#{...}` is full SpEL; nested, the placeholder resolves first, then the result is parsed as SpEL.":
      "`${server.port}` — property placeholder resolution only. `#{systemProperties['user.name']}` — full SpEL with method calls, operators, `T()`, etc. Nested `#{${some.property}}` resolves the placeholder first, then evaluates the result as SpEL. Use `${}` for config values; `#{@beanName.method()}` when you need bean references or expressions.",

    "1. No valid filesystem path exists for a JAR zip entry; use `getInputStream()`.":
      "`Resource.getFile()` assumes a filesystem-backed resource. Classpath entries inside JARs are **not** files on disk — `getFile()` throws `FileNotFoundException` in production fat-JAR deployments. Use `getInputStream()`, `getInputStreamReader()`, or `ReadableResource` APIs that work for both filesystem and classpath/JAR resources.",

    "2. `classpath:` = first match only; `classpath*:` = all matches across every classpath root. Wrong choice silently drops contributions from some modules.":
      "`classpath:config/*.xml` returns the **first** matching resource on the classpath. `classpath*:config/*.xml` returns **all** matches from every classpath root (every module/JAR). Multi-module apps that rely on `classpath:` for plugin contributions silently miss configs from secondary modules. Use `classpath*:` when aggregating contributions.",

    "1. Synchronous by default. Consequences: latency is additive; listener exceptions can break the publisher's operation.":
      "Default `ApplicationEventMulticaster` invokes listeners **synchronously** on the publisher's thread. Slow listeners add directly to request latency. Uncaught listener exceptions can fail the publisher's transaction or HTTP response. Use `@Async` listeners (with a real executor), or `ApplicationEventPublisher` with async multicaster for fire-and-forget side effects.",

    "1. Join point = a point where advice could apply; pointcut = expression selecting which join points; advice = the code that runs at matches.":
      "- **Join point** — a point in execution where advice *could* be applied (method call, method execution, etc.).\n- **Pointcut** — predicate selecting which join points actually get advice (`execution(* com.acme..*(..))`).\n- **Advice** — the action at matched join points (`@Before`, `@Around`, `@AfterReturning`, etc.).\n- **Aspect** — module combining pointcuts + advice.",

    "2. CGLIB. Constraints: can't proxy `final` classes/methods; can never advise `private` methods.":
      "When no interface exists, Spring AOP uses **CGLIB** subclass proxies. Constraints: cannot subclass `final` classes; cannot override `final` methods; **never** intercepts `private` methods (not visible to subclass). `protected`/`public` non-final methods on non-final classes are fair game. Prefer interface-based JDK proxies when you control the API.",

    "2. `@Around`; must call `pjp.proceed()`.":
      "`@Around` is the most powerful advice — it wraps the join point and controls whether/when execution proceeds via `proceed()`. Skipping `proceed()` skips the target method entirely (useful for caching short-circuits, but dangerous if accidental). Always use `try/finally` in `@Around` for cleanup (locks, MDC) so `proceed()` failures still release resources.",

    "1. Direct dispatch on `this` never routes through the separate external proxy object; the proxy is only reached via DI-injected references from outside.":
      "Spring AOP wraps the bean in a **proxy object**. External callers hold the proxy → advice runs. Internal `this.foo()` calls are direct invocations on the raw target inside the object — they **never** pass through the proxy shell. Hence `@Transactional`, `@Cacheable`, `@Async` on methods called only via `this` silently do nothing.",

    "2. Extraction > self-injection > `AopContext.currentProxy()` > full AspectJ, because extraction also fixes the likely underlying design issue.":
      "Fix order for self-invocation:\n1. **Extract** the advised logic to another bean (best — fixes design).\n2. **Self-inject** the proxied interface (`@Lazy @Autowired private MyService self`).\n3. **`AopContext.currentProxy()`** (requires `exposeProxy = true`).\n4. **AspectJ compile-time weaving** — full power, no proxy boundary.\nExtraction is preferred because it usually addresses an SRP violation.",

    "2. Mass assignment: blind binding of any request field onto a target object. Mitigations: dedicated DTOs, explicit allowlisting.":
      "Mass assignment binds attacker-controlled fields (e.g. `isAdmin=true`) onto domain entities. Mitigations: **input DTOs** with only allowed fields, `@InitBinder` allowlists, never bind directly to JPA entities in web forms. Spring MVC's data binding is powerful — treat every bound field as untrusted input.",

    "2. Validation groups: `@Validated(Group.class)` + `groups = {...}` on constraints.":
      "JSR-303 **validation groups** let different endpoints validate different subsets. `@Validated(Create.class)` on controller + `@NotNull(groups = Create.class)` on fields. Without `@Validated` on the parameter/container, group constraints are ignored. Use separate groups for create vs update vs admin-only rules.",

    "2. `fixedRate` measures from start (can back up under slow execution); `fixedDelay` measures from end (self-paces).":
      "`@Scheduled(fixedRate = 5000)` — next run scheduled 5s after **start** of previous; slow jobs can overlap or queue up. `@Scheduled(fixedDelay = 5000)` — 5s after **end** of previous; self-pacing, no overlap. For cleanup jobs that must not overlap, use `fixedDelay` or a distributed lock.",

    "1. You get the product (`Widget`), not the `FactoryBean` itself; use `&beanName` for the latter.":
      "`getBean(\"myFactory\")` returns whatever `FactoryBean.getObject()` produces (the **product**). To retrieve the `FactoryBean` instance itself, prefix with `&`: `getBean(\"&myFactory\")`. Confusing product vs factory causes NPE when calling `FactoryBean` configuration methods on the product.",

    "2. Precise `getObjectType()` lets the container reason about type before instantiating, improving autowiring resolution and error clarity.":
      "Returning `Object.class` from `getObjectType()` when the product is `ConnectionPool` degrades autowiring — the container cannot distinguish candidates early, producing vague `NoUniqueBeanDefinitionException` messages. Return the exact product type (or a meaningful supertype).",

    "2. Multiple `DispatcherServlet`s sharing common business-layer beans without duplication, while keeping web layers independent.":
      "Parent (root) context holds services/repositories; child servlet contexts hold controllers/MVC config per `DispatcherServlet`. Children see parent beans; parent never sees children. Enables multiple servlets (admin vs API) sharing one service layer without duplicate bean definitions.",

    "1. Exact match of config classes, profiles, properties, and especially `@MockBean`/`@SpyBean` set/customizers.":
      "Spring Test caches `ApplicationContext` instances keyed by the **exact** test configuration fingerprint: `@SpringBootTest` classes, active profiles, `@TestPropertySource`, `@MockBean`/`@SpyBean` definitions, `@Import`, context customizers. Identical configs share one context; any difference triggers a full rebuild.",

    "2. Each distinct mock combination is its own cache key, silently multiplying rebuilt contexts across a large, uncoordinated suite.":
      "Every `@MockBean` variant creates a unique context cache entry. A suite with 60 test classes each mocking different beans can build 60 contexts — 45-minute CI suites often trace to this. Fix: shared `@Import(TestMocks.class)` base configs, slice tests, and fewer full `@SpringBootTest` classes.",
  },

  collections: {
    "1. Why does `Map<K,V>` not extend `Collection<E>`? Name the two concrete method-signature conflicts that would arise if it did.":
      "`Map` is a **key-value** abstraction, not a single-element collection. If it extended `Collection<E>`, two signature clashes appear:\n\n1. **`add(E e)`** — `Collection.add` adds one element; `Map` needs `put(K, V)` with two arguments.\n2. **`iterator()` / `contains(Object o)`** — `Collection` iterates/contains **values** (or elements); `Map` has distinct `keySet()`, `values()`, `entrySet()` views with different semantics.\n\nThe framework uses separate interfaces to keep contracts precise.",

    "3. You need a `Set` with: no duplicates, sorted iteration, and O(log n) range queries. Which class, and what's the one thing you must get right about your `Comparator` to avoid silently losing entries?":
      "**`TreeSet`** (or `NavigableSet` via `TreeSet`) — backed by red-black tree, O(log n) add/remove/contains, sorted iteration, `subSet`/`headSet`/`tailSet` for range queries.\n\n**Comparator contract:** must be **consistent with equals** — if `compare(a,b)==0`, `equals(a,b)` must be true. If two unequal keys compare as 0, the set treats them as duplicates and **silently drops** one. Same issue with `TreeMap` keys.",

    "4. What's the precise difference between \"unmodifiable\" and \"immutable\"? Give a concrete code example where treating them as equivalent causes a bug.":
      "- **Unmodifiable** — no mutating methods on the *view*; backing collection may still change.\n- **Immutable** — no mutation possible at all; contents never change after creation.\n\n```java\nList<String> backing = new ArrayList<>(List.of(\"a\"));\nList<String> view = Collections.unmodifiableList(backing);\nbacking.add(\"b\"); // mutates through backing reference\nSystem.out.println(view.size()); // 2 — view changed!\n```\n\n`List.of()` / `List.copyOf()` are truly immutable — safe to share.",

    "5. Name three Java 21 additions to the Collections Framework and, for each, name the specific pre-21 gap it closes.":
      "1. **`SequencedCollection` / `SequencedSet` / `SequencedMap`** — uniform first/last/get/reversed operations; pre-21, `LinkedHashMap` had `firstKey` patterns but no shared API.\n2. **`addFirst` / `addLast` on `Deque`** via sequenced interfaces — consistent deque semantics across implementations.\n3. **`LinkedHashMap.sequencedKeySet()` / `sequencedValues()`** — ordered views with predictable iteration without extra wrappers.\n\n(Java 21 also formalized sequenced collections; `HashMap` does **not** implement `SequencedMap` because hash order is not meaningful sequence.)",

    "8. Explain exactly why `PriorityQueue.remove(Object)` is O(n) while `poll()` is O(log n), even though both conceptually \"remove an element.\"":
      "`poll()` removes the **root** (min/max) — known position, swap with last, sift down — O(log n). `remove(Object)` must **find** the object first — no index; linear scan of the heap array O(n), then remove and sift — O(n) total. For frequent arbitrary removals, use a `HashMap` index + heap pairing, or `TreeSet`/`ConcurrentSkipListSet` if ordering matters.",

    "10. Explain why `ConcurrentHashMap.get()` requires no locking at all, but `put()` sometimes does. What specific field modifier makes the lock-free read safe?":
      "`get()` reads the volatile `Node[] table` reference and walks bin lists — reads see published nodes via **volatile**/`final` field semantics without locking the whole map. `put()` may CAS into an empty bin or **lock a single bin** (`synchronized` on the bin head) for insertion/update/resizing. The `volatile` (or equivalent safe publication) on table and node fields ensures readers never see torn/partial structure.",

    "18. A service holds a 50-million-entry lookup table, built once at startup from a bulk load, then read millions of times per minute with no further writes.":
      "**`HashMap`** (or pre-sized `HashMap` with known capacity to avoid resizes during load). O(1) expected reads, minimal memory overhead vs tree structures. Reject **`ConcurrentHashMap`** — unnecessary concurrency overhead if truly read-only after publish (use immutable snapshot or `Map.copyOf` if sharing). Reject **`TreeMap`** — O(log n) reads and higher per-entry cost. Consider off-heap or compressed storage only if heap is prohibitive.",

    "19. A leaderboard needs the current top 10 scores at all times, updated by thousands of score submissions per second from a single-threaded event-processing pipeline.":
      "**`PriorityQueue`** (min-heap of size 10 for top-10 highest if using reverse comparator, or maintain size-10 heap). Single-threaded → no concurrency wrapper needed. O(log 10) per update. Reject **`TreeSet`** — also works but higher constant factor; reject **`ConcurrentSkipListMap`** — no concurrency needed. Alternative: bucket by score + `TreeMap` if score range is small.",

    "20. A rarely-changing list of ~15 feature-flag listeners is iterated on every single request across a highly concurrent service.":
      "**`CopyOnWriteArrayList`** — reads (iteration) are lock-free on a snapshot; writes (rare listener registration) copy the array. Perfect read-heavy, write-rare. Reject plain `ArrayList` + lock — iterator would need synchronization every request. Reject `Collections.synchronizedList` — every iteration locks.",

    "21. A batch job needs to deduplicate 200 million log lines by a derived key, single-threaded, memory being the primary constraint.":
      "If exact dedup fits RAM: **`HashSet`** of keys (or `LongOpenHashSet` / primitive set if keys are numeric). If not: **sort + scan** external disk (no in-memory set), or **Bloom filter** for probabilistic dedup with second-pass confirmation. Reject `TreeSet` — higher memory per entry. Tune initial capacity/load factor to avoid resize churn during bulk insert.",

    "22. A cache of parsed configuration objects needs to survive being read by 50,000 concurrent virtual threads, refreshed roughly once per minute.":
      "**`volatile` reference swap** to immutable `Map.copyOf(snapshot)` refreshed atomically each minute — readers see stable snapshot without locking. Or **`ConcurrentHashMap`** if per-key lazy loading. For single bulk refresh: build new map, then `configCache = newMap` (volatile field). Reject `Collections.synchronizedMap` — pins under massive read concurrency. Caffeine with `refreshAfterWrite` is the production-grade choice.",

    "24. Under what specific circumstance does calling a mutating method on a `ConcurrentHashMap` from inside a `computeIfAbsent` lambda (on the *same* map) cause a problem? What's the fix?":
      "Recursive update — mutating the same map inside `computeIfAbsent`/`compute`/`computeIfPresent` while the bin is locked can throw **`IllegalStateException: Recursive update`**. Fix: compute the value without nested map mutation, or use a **different map** for intermediate state, or restructure to `putIfAbsent` + separate update outside the lambda.",

    "25. You're migrating a thread-per-request service from a fixed platform-thread pool (200 threads) to virtual threads. Name two categories of latent bugs in existing shared-collection code that are more likely to surface after this migration, and why.":
      "1. **Non-thread-safe collections under hidden concurrency** — `HashMap`/`ArrayList` shared across requests were \"safe\" at 200 platform threads with low collision; 50k virtual threads expose check-then-act races and `ConcurrentModificationException`.\n2. **`synchronized` on shared structures** — more concurrent access causes lock contention and long pin times; virtual threads magnify scheduler queue depth when blocking on fat locks.",

    "28. A `Set<CustomKey>` used for request deduplication starts admitting duplicates only after several days of uptime, never in fresh restarts or in tests.":
      "**Likely:** broken `equals`/`hashCode` contract — e.g. `hashCode` uses mutable fields that change after insert, or `equals` inconsistent with `hashCode`. Entries land in wrong buckets and duplicates appear. **Confirm:** log `hashCode` before/after mutation; reproduce with long-lived mutable keys. **Fix:** immutable keys, or keys with stable `hashCode` from immutable fields only.",

    "29. A service's heap usage climbs steadily and never drops, even after a full GC, and a heap histogram shows one `HashMap`'s internal table array is far larger than its live entry count would suggest.":
      "**HashMap resize without shrink** — table was huge during a spike, entries removed but capacity never shrinks (HashMap doesn't compact). Or **retained keys** (e.g. `Integer` cache, interned strings) holding references. **Confirm:** compare `map.size()` vs table length via heap dump or JOL. **Fix:** rebuild into new `HashMap` with right initial capacity, or use cache with eviction (Caffeine).",

    "30. Threads occasionally block for hundreds of milliseconds on what a thread dump shows as a `synchronized` block wrapping a shared `HashMap`, under moderate concurrent load that wasn't a problem in staging.":
      "**Coarse lock on non-concurrent `HashMap`** — all readers and writers serialize on one monitor. Staging had lower concurrency. **Fix:** `ConcurrentHashMap`, or read-write lock if reads dominate, or partition into shard maps. Never wrap plain `HashMap` in `synchronized` for high-traffic paths.",

    "31. A `PriorityQueue`-backed task scheduler occasionally processes a lower-priority task before a higher-priority one that was added earlier in the same batch, despite `poll()` being used correctly every time it's called.":
      "`PriorityQueue` is **not stable** — equal-priority (or comparator-equal) elements have no FIFO guarantee. If comparator treats distinct tasks as equal (e.g. only compares priority enum, not sequence), heap order is arbitrary. **Fix:** comparator includes sequence/timestamp, or use `LinkedHashMap` + separate structure, or `PriorityQueue` with unique sequence in comparison.",

    "32. A `WeakHashMap`-based \"cache\" has a near-zero hit rate in production despite the same keys being requested repeatedly within a short window.":
      "**Keys are strongly reachable elsewhere** — `WeakHashMap` entries survive only if keys are weakly reachable. If you store the same `String` in a strong `Set` or static cache, weak entries never clear but also **new keys** are different instances (not interned) → misses. Or **GC clears entries too aggressively** between requests if nothing else strongly references keys. **Fix:** use `String.intern()` / canonical key pool, or switch to Caffeine with TTL/size bounds.",

    "33. A rate limiter tracking request counts per API key over a sliding 60-second window, serving ~50,000 requests/sec across many concurrent virtual threads.":
      "**Per-key `ConcurrentHashMap` + lock-free or striped counters** — e.g. `ConcurrentHashMap<String, LongAdder>` with window reset, or bucketed time slices. For sliding window at scale: **Redis/Central store** or approximate counting (Count-Min Sketch). In-memory: avoid one global lock; shard by key hash. Caffeine with `expireAfterWrite(60s)` for per-key windows if approximate limits suffice.",

    "34. An in-memory audit log that must expose read-only access to the last 10,000 entries in insertion order, safely to many concurrent readers, while a single writer appends continuously.":
      "**Circular buffer** of 10k slots + **volatile/COW snapshot** for readers, or `ArrayDeque` with copy-on-write snapshot on read path. Production pattern: single writer thread appends to queue; readers get `List.copyOf` snapshot or immutable ring buffer view. `CopyOnWriteArrayList` works if 10k copies are acceptable on each write (usually not) — prefer ring buffer + atomic reference to immutable list snapshot periodically.",

    "35. A graph algorithm needing to repeatedly extract the minimum-distance unvisited node (Dijkstra's-style) from a set of ~1 million nodes, with occasional priority updates for nodes already in the structure.":
      "**`PriorityQueue` + `HashMap` for node→heap entry** (or **indexed heap**). Standard `PriorityQueue` lacks O(log n) arbitrary priority update — use lazy deletion (re-insert with new priority) or custom indexed heap. For concurrent: not typical in Dijkstra inner loop. **`TreeSet`** with explicit comparator on (distance, nodeId) works but higher constant factors than binary heap.",

    "36. \"Walk me through what happens, step by step, when you call `put()` on a `HashMap` that's about to trigger a resize.\"":
      "1. Compute `hash`, find bin index `(n-1) & hash`.\n2. Walk bin chain / tree.\n3. If threshold exceeded (`size > capacity * loadFactor`), **resize** 2x.\n4. Allocate new table; **split each old bin** using high bit of hash (lo/hi chains) without rehashing every key from scratch.\n5. Insert new entry in appropriate bin (tree if bin length > 8).\n6. Increment `size`.\n\nResize is O(n) but amortized O(1) per put.",

    "37. \"Why would you ever choose `ConcurrentSkipListMap` over `ConcurrentHashMap`? What are you giving up, and what are you gaining?\"":
      "Choose **`ConcurrentSkipListMap`** when you need **sorted keys**, `subMap`/`headMap`/`tailMap`, or concurrent navigable operations. You gain sorted iteration and range queries. You give up **lower memory overhead and faster point lookups** — skip list has higher constant factors than CHM hash bins. Never choose it for plain key-value get/put without ordering need.",

    "38. \"A colleague says `ArrayList.add()` is O(1). Do you agree? Push back on the parts of that claim you'd want to refine.\"":
      "**Amortized O(1)** for append at end — occasional O(n) resize when capacity exhausted. **O(n)** if add at index `i` (shift elements). Worst-case single add is O(n) due to resize copying entire backing array. Also: `add` triggers `ensureCapacity` — if you know size upfront, presize to avoid repeated resizes.",

    "39. \"Explain the `equals()`/`hashCode()` contract to me as if I'd never seen it, then show me what breaks if you violate the load-bearing direction of it.\"":
      "Equal objects must have equal hash codes. Hash-based collections place objects in buckets by `hashCode`; lookup uses `equals` within bucket. **Violating `equals` → `hashCode`:** object in wrong bucket → `get` returns null even though `equals` would match. Example: mutable key changes hash after insert → lost entry. **Fix:** immutable keys, or constant `hashCode` from stable fields.",

    "40. \"We need a thread-safe, mostly-read collection with predictable iteration behavior and minimal write frequency. What do you choose, and what are you trading away?\"":
      "**`CopyOnWriteArrayList`** or **`CopyOnWriteArraySet`** — snapshot iterators, no locks on read path. Trade-off: **O(n) copy on every write** — expensive if writes are frequent. Alternative for ordered map: immutable snapshot + atomic swap. You trade memory (copies) and write cost for read scalability and iterator safety.",
  },

  concurrency: {
    "1. Batch job using both together — see combined skeleton with `CountDownLatch` + `Semaphore` wrapping only the DB-access portion.":
      "```java\nCountDownLatch done = new CountDownLatch(chunks.size());\nSemaphore dbSlots = new Semaphore(8); // cap concurrent DB connections\n\nfor (Chunk chunk : chunks) {\n    executor.submit(() -> {\n        try {\n            Object parsed = parseLocally(chunk); // no permit needed\n            dbSlots.acquire();\n            try {\n                writeToDb(parsed);\n            } finally {\n                dbSlots.release();\n            }\n        } finally {\n            done.countDown();\n        }\n    });\n}\ndone.await(); // wait for all chunks before aggregating\naggregateResults();\n```\n\n`CountDownLatch` coordinates **completion**; `Semaphore` limits **concurrent DB access** — orthogonal concerns.",

    "1. Dedicated pool fix — wrap the parallel stream call in `dedicatedPool.submit(...)`.":
      "```java\nForkJoinPool dedicatedPool = new ForkJoinPool(16);\ntry {\n    dedicatedPool.submit(() ->\n        items.parallelStream()\n            .forEach(item -> processHttpCall(item)) // blocking I/O\n    ).get();\n} finally {\n    dedicatedPool.shutdown();\n}\n```\n\nParallel streams use the **common pool** by default — blocking I/O on it starves other parallel work (including `CompletableFuture` defaults). A dedicated pool isolates I/O-bound parallel streams from CPU-bound common-pool users.",
  },
};
