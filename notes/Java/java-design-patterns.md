# Java Design Patterns — Senior Production Reference

Java 17/21, Spring Boot 3.x. This is the implementation-depth companion to the pattern catalog in `java-oops.md` Part 11. That note answers "what is this pattern." This one answers "what does it look like in a real codebase, where does the JDK or Spring already do it for me, and when does applying it make the system worse."

Every pattern below is presented the same way: the concrete problem, a modern Java implementation, the real class names where it already lives in the platform, the over-engineering smell, and a production incident that came from getting it wrong.

---

## Table of Contents

1. [Mental Model: Patterns as Vocabulary](#1-mental-model-patterns-as-vocabulary)
2. [Creational — Singleton](#2-creational-singleton)
3. [Creational — Factory Method and Static Factory](#3-creational-factory-method-and-static-factory)
4. [Creational — Abstract Factory](#4-creational-abstract-factory)
5. [Creational — Builder](#5-creational-builder)
6. [Creational — Prototype and Copying](#6-creational-prototype-and-copying)
7. [Structural — Adapter](#7-structural-adapter)
8. [Structural — Decorator](#8-structural-decorator)
9. [Structural — Proxy](#9-structural-proxy)
10. [Structural — Facade](#10-structural-facade)
11. [Structural — Composite](#11-structural-composite)
12. [Structural — Bridge and Flyweight](#12-structural-bridge-and-flyweight)
13. [Behavioral — Strategy](#13-behavioral-strategy)
14. [Behavioral — Template Method](#14-behavioral-template-method)
15. [Behavioral — Observer](#15-behavioral-observer)
16. [Behavioral — Command](#16-behavioral-command)
17. [Behavioral — Chain of Responsibility](#17-behavioral-chain-of-responsibility)
18. [Behavioral — State](#18-behavioral-state)
19. [Behavioral — Visitor](#19-behavioral-visitor)
20. [Behavioral — Iterator, Mediator, Memento, Interpreter (brief concrete)](#20-behavioral-iterator-mediator-memento-interpreter-brief-concrete)
21. [Behavioral — Null Object and Special Case](#21-behavioral-null-object-and-special-case)
22. [Concurrency Patterns](#22-concurrency-patterns)
23. [Enterprise/Architecture Patterns (Repository, DTO, DI, etc.)](#23-enterprisearchitecture-patterns-repository-dto-di-etc)
24. [Anti-Patterns](#24-anti-patterns)
25. [Pattern Selection Guide](#25-pattern-selection-guide)
26. [Production Debugging Playbook](#26-production-debugging-playbook)
27. [Quick Decision Matrix](#27-quick-decision-matrix)

---


## 1. Mental Model: Patterns as Vocabulary

### Core concept

A design pattern is **a name for a shape that keeps reappearing**, not a deliverable. The value of "this is a Strategy" is that four engineers in a code review immediately agree on what the extension point is and where new behavior goes. The moment the name becomes the goal — "we should use more patterns," "add a factory here for flexibility" — you have inverted the tool and the problem.

The GoF book was written in 1994 against C++ and Smalltalk. Two things it had to work around are now language features:

1. **No first-class functions.** Any pattern whose entire content was "wrap one method in an object so it can be passed around" existed only because C++ had no lambdas. Strategy, Command, Template Method's hook steps, Observer's listener — all of these collapse to a functional interface plus a lambda in modern Java.
2. **No cheap immutable data carriers.** Value objects took 60 lines of `equals`/`hashCode`/`toString`/getters. Records now take one.

Java 17/21 changed the economics of roughly a third of the catalog:

| GoF pattern | Modern Java reality |
|---|---|
| Strategy | `Function`, `Predicate`, `Comparator`, or a small `sealed interface`; a lambda is the implementation |
| Command | `Runnable`, `Callable<T>`, `Supplier<T>` — a class is only needed when you also need `undo()` or serialization |
| Template Method | Often better as a method taking a lambda (`JdbcTemplate.query(sql, RowMapper)`), avoiding inheritance |
| Observer | `ApplicationEventPublisher` + `@EventListener`, or `Flow.Subscriber`; rarely hand-rolled |
| Visitor | `sealed interface` + exhaustive `switch` with pattern matching. The double-dispatch machinery is gone. |
| State | `sealed interface` of state records + `switch`, or an enum with per-constant transition logic |
| Prototype | Record `with`-style copy methods and copy constructors. `Cloneable` is a historical mistake. |
| Singleton | A Spring bean with default scope, or an `enum` constant |
| Iterator | `Iterable` is in the language (`for-each`), and `Stream` covers most traversal |
| Interpreter | Pattern-matching `switch` over a sealed AST hierarchy |

What did **not** get cheaper: Decorator, Proxy, Adapter, Composite, Chain of Responsibility, Builder, Flyweight. Those all describe object graphs and identity, not just "a function passed as data," so they still need real types.

### The three questions before applying any pattern

1. **What varies, and has it actually varied yet?** One implementation is not variation. Two implementations that differ only in a constant are not variation either.
2. **Who is the reader?** Patterns pay off when a stranger has to add the third case. If the abstraction makes the *first* case unreadable, it is a net loss.
3. **What is the cheaper alternative?** Usually: a plain method, a `Map`, an enum, or deleting the duplication instead of abstracting it.

### Cost model

Every pattern buys extensibility along **one axis** and charges indirection along **all** axes:

```
if/else chain          →  Strategy
  gained: add a case without touching existing code
  paid:   the reader must now find N files to see all behavior;
          stack traces get a lambda frame; debugging needs a breakpoint
          on the dispatch map, not on the branch
```

A Strategy with two implementations that both live in the same package and never change is strictly worse than an `if`. A Strategy with nine implementations owned by three teams is strictly better. The pattern is not right or wrong; the cardinality and ownership decide.

### The "pattern-driven design" failure mode

The recognizable senior-level smell is a codebase where the class names are pattern names: `OrderProcessorStrategyFactoryProvider`. Nobody can answer "where does an order get charged?" without reading six files. Pattern names in type names are usually a signal that the pattern was chosen before the problem was understood.

Naming rule that holds up: name types after the **domain role** (`FlatRateShipping`, `TieredDiscount`, `StripeGateway`), not after the pattern (`ShippingStrategyImpl`). The pattern is how it is wired, which is implementation detail. The exceptions are types whose whole job is infrastructure plumbing — `RetryingPaymentClient` is fine, `CachingProductRepository` is fine, because "retrying" and "caching" *are* the domain roles of those wrappers.

### Production scenario: a Strategy interface with exactly one implementation, forever

**Problem.** A payments service has `PricingStrategy`, `PricingStrategyFactory`, `AbstractPricingStrategy`, and `StandardPricingStrategy`. A new engineer needs to add a 3% surcharge for a country. It takes them a day: the factory reads a config key that only ever resolves to `STANDARD`, the abstract class has three protected hooks two of which are never overridden, and the actual arithmetic is spread across the abstract class and the one subclass.

**Cause.** The abstraction was added "for when we have regional pricing," three years before regional pricing existed. There was never a second implementation, so the extension points were never validated — and they turned out to be at the wrong seams (per-line-item hooks, when the real variation is per-country tax rules applied to the order total).

**Solution.** Collapse it. One class, one method, and add the abstraction when the second real case arrives — at which point you will know the correct seam.

```java
@Component
public class Pricing {

    private final TaxRates taxRates;

    public Pricing(TaxRates taxRates) { this.taxRates = taxRates; }

    public Money total(Order order) {
        Money subtotal = order.lines().stream()
            .map(OrderLine::lineTotal)
            .reduce(Money.ZERO, Money::plus);
        return subtotal.plus(taxRates.taxFor(order.shipTo(), subtotal));
    }
}
```

The deletion PR removed 340 lines and made the surcharge a four-line change. Speculative generality is more expensive than the duplication it was supposed to prevent, because duplication is visible and a wrong abstraction is not.

---

## 2. Creational — Singleton

### The problem it solves

Some resources are genuinely process-wide and expensive: a connection pool, a metrics registry, a JIT-warmed regex cache, a native library handle. Creating a second one is not just wasteful — with a pool it means double the database connections and an exhausted `max_connections`.

Singleton says: this type controls its own instantiation and hands out the one instance.

### Implementations, worst to best

**1. Lazy with synchronized accessor — correct but contended**

```java
public final class LegacyCache {
    private static LegacyCache instance;

    private LegacyCache() {}

    public static synchronized LegacyCache getInstance() {
        if (instance == null) {
            instance = new LegacyCache();
        }
        return instance;
    }
}
```

Correct. Every read takes a monitor forever, to protect a write that happens once.

**2. Double-checked locking with `volatile` — the interview classic**

```java
public final class ConnectionRegistry {

    private static volatile ConnectionRegistry instance;

    private ConnectionRegistry() {}

    public static ConnectionRegistry getInstance() {
        ConnectionRegistry local = instance;   // one volatile read on the fast path
        if (local == null) {
            synchronized (ConnectionRegistry.class) {
                local = instance;
                if (local == null) {
                    local = new ConnectionRegistry();
                    instance = local;          // volatile write publishes safely
                }
            }
        }
        return local;
    }
}
```

`volatile` is **not** optional and not a micro-optimization. Without it, the JMM permits the writing thread to publish the reference before the constructor's field writes are visible, so a second thread can observe a non-null reference to a partially constructed object with default-valued fields. This is the single most-tested detail of this pattern. The `local` variable exists to avoid re-reading the volatile field, which is a real (if small) win on the hot path.

**3. Holder idiom — lazy, no synchronization, no volatile**

```java
public final class SchemaRegistry {

    private SchemaRegistry() {}

    private static final class Holder {
        static final SchemaRegistry INSTANCE = new SchemaRegistry();
    }

    public static SchemaRegistry getInstance() {
        return Holder.INSTANCE;
    }
}
```

The JVM's class-initialization lock guarantees `Holder` is initialized exactly once, and only when `getInstance()` first touches it. Zero runtime synchronization cost after initialization. This is the correct answer when you need laziness and cannot use an enum.

**4. Enum singleton — the best default**

```java
public enum IdGenerator {
    INSTANCE;

    private final AtomicLong counter = new AtomicLong();

    public long next() { return counter.incrementAndGet(); }
}
```

Serialization-safe, reflection-safe, and initialized once by the JVM. This is what Joshua Bloch recommends in *Effective Java*, and it is the right answer for a stateless-or-atomic process-wide utility.

### Serialization and reflection attacks

A class-based singleton has two escape hatches:

**Reflection.** `Constructor<?> c = ConnectionRegistry.class.getDeclaredConstructor(); c.setAccessible(true); c.newInstance();` produces a second instance. The mitigation is a guard inside the constructor:

```java
private ConnectionRegistry() {
    if (instance != null) {
        throw new IllegalStateException("use getInstance()");
    }
}
```

This is defensive theater in most applications (anyone with reflection access can also clear the guard field) but it is the expected interview answer.

**Serialization.** If the singleton implements `Serializable`, every `readObject` mints a new instance. Fix with `readResolve`:

```java
private Object readResolve() {
    return getInstance();
}
```

`enum` needs neither: `java.io.ObjectInputStream` special-cases enum deserialization to resolve by name, and `Constructor.newInstance` throws `IllegalArgumentException` for enum types. That immunity is the actual argument for the enum form.

### Where it appears in the JDK and Spring

| Real example | Form |
|---|---|
| `Runtime.getRuntime()` | Eager static field |
| `java.time.Clock.systemUTC()` | Effectively a shared immutable instance |
| `Collections.emptyList()` | Shared immutable instance (also Flyweight/Null Object) |
| `Comparator.naturalOrder()` | Enum singleton (`Comparators.NaturalOrderComparator.INSTANCE`) |
| `DesktopManager`, `ProcessHandle.current()` | JVM-scoped instances |
| Every default-scoped Spring `@Bean` | One instance per `ApplicationContext`, managed externally |

### Why Spring beans replace it

A default-scoped Spring bean gives you the *only* property you actually wanted — one instance for the application — without the property you did not want, which is a hardcoded global accessor baked into every call site.

```java
// Singleton pattern: the dependency is invisible in the signature and unmockable.
public class OrderService {
    public void place(Order o) {
        ConnectionRegistry.getInstance().pool().borrow();
    }
}

// Spring singleton scope: the dependency is explicit and injectable.
@Service
public class OrderService {
    private final DataSource dataSource;
    OrderService(DataSource dataSource) { this.dataSource = dataSource; }
}
```

Note the vocabulary trap: Spring's "singleton scope" is **one instance per container**, not one per classloader. Two `ApplicationContext`s (common in tests, and in parent/child web contexts) mean two instances. If you truly need one per JVM regardless of contexts, that is an `enum`, not a bean.

### When it is the WRONG choice

- **The instance holds mutable business state.** A singleton `OrderCache` with a `HashMap` field is a data race and a memory leak with a global reference root. Every request thread touches it; nothing ever evicts it.
- **You need to test the collaborators.** `getInstance()` is not injectable. Tests either mutate global state (order-dependent failures) or need a static mocking library. Reaching for `mockStatic` is a design smell telling you the dependency should have been a parameter.
- **You are actually just avoiding parameter passing.** `AppContextHolder.getInstance().getCurrentUser()` is Service Locator wearing a Singleton costume; see [Anti-Patterns](#24-anti-patterns).
- **Per-tenant or per-request scope is the real requirement.** Discovered late, this is a rewrite, because the singleton reference is now in 200 call sites.

**Over-engineering smell:** double-checked locking written by hand in application code in 2024. If you are in Spring, the container already solved instance management. If you are not, the holder idiom or an enum is shorter and correct by construction.

### Testability damage, concretely

```java
// Untestable: hidden static dependency, shared state across tests.
class FeeCalculator {
    BigDecimal fee(Order o) {
        return RateTable.getInstance().rateFor(o.currency()).multiply(o.amount());
    }
}
```

`RateTable`'s content is loaded from a config file at class-init time. A test that needs a EUR rate of 1.1 must either ship a test config file that also affects every other test, or use static mocking. If `FeeCalculator` took `RateTable` as a constructor parameter, the test is three lines and independent. The singleton did not make the code faster; it made the seam disappear.

### Production scenario: two ApplicationContexts, two connection pools

**Problem.** A Boot 3 service configured `maximum-pool-size: 20` against a Postgres with `max_connections = 100`. Five pods. Arithmetic says 100 connections at absolute saturation, which is tight but survivable. In production the database started rejecting connections with `FATAL: sorry, too many clients already`, and `pg_stat_activity` showed 200 sessions from the service.

**Cause.** The application also started a Spring Batch job runner in a **child** `ApplicationContext` (created by an old `ClassPathXmlApplicationContext` bootstrap left over from a migration). Each context created its own `HikariDataSource` bean, because a Spring "singleton" is per-container. The batch context's pool was invisible in the main context's actuator metrics, so the dashboard showed 20 connections per pod while the reality was 40.

**Solution.** Two changes. First, remove the child context — the batch jobs were registered as beans in the main context. Second, make the pool count observable and asserted, so this class of drift fails a test rather than the database.

```java
@Configuration
public class DataSourceGuard {

    private static final AtomicInteger POOLS_CREATED = new AtomicInteger();

    @Bean
    DataSource dataSource(DataSourceProperties props) {
        int n = POOLS_CREATED.incrementAndGet();
        if (n > 1) {
            throw new IllegalStateException(
                "A second DataSource was created (count=" + n + "). "
                + "Check for a child ApplicationContext.");
        }
        return props.initializeDataSourceBuilder().type(HikariDataSource.class).build();
    }
}
```

`POOLS_CREATED` is a real JVM-wide static — deliberately, because the invariant being protected is JVM-wide, and a bean field cannot see across contexts. This is one of the few legitimate uses of static mutable state: a process-wide assertion, not business logic. Tests that intentionally build multiple contexts reset it via a package-private hook.

**Lesson.** "Singleton" is only meaningful relative to a scope. Always ask: one per what? Per JVM, per classloader, per container, per tenant, per request. Most singleton bugs are scope-mismatch bugs.

---

## 3. Creational — Factory Method and Static Factory

### The problem it solves

A constructor has three hard limits: it must be named after the class, it must return an instance of exactly that class, and it always allocates. A static factory method has none of those limits. Every one of those freedoms solves a real problem:

| Constructor limit | What the factory buys |
|---|---|
| No name | `Duration.ofSeconds(5)` vs `Duration.ofMillis(5)` — same signature, different meaning |
| Must return `this` type | Return a subtype, a cached instance, or a different implementation per input |
| Always allocates | `Integer.valueOf`, `Boolean.valueOf`, `List.of()` return shared instances |
| Cannot fail cleanly | A factory can validate and return `Optional`, or pick a fallback |
| Generic verbosity | `Map.of()` infers; `new HashMap<String, List<Integer>>()` does not (pre-diamond) |

Two distinct patterns get conflated here, and interviewers do check:

- **Static factory method** — not a GoF pattern. A named static method replacing a public constructor. Same class decides.
- **Factory Method (GoF)** — an *instance* method, declared abstract or overridable, that subclasses override to decide which concrete product to create. The decision is deferred to a subclass.

### Static factory conventions

The JDK's naming is a de facto standard; follow it and readers know the semantics without reading the body.

| Name | Contract |
|---|---|
| `of` / `ofX` | Aggregation or conversion from parts; may return a shared instance. `List.of`, `Set.of`, `Duration.ofDays`, `EnumSet.of` |
| `valueOf` | Conversion from another type, usually verbose/parsing-ish. `Integer.valueOf`, `BigDecimal.valueOf`, `Enum.valueOf` |
| `from` | Conversion from a single different type. `Date.from(Instant)`, `Instant.from(TemporalAccessor)` |
| `parse` | From a `String`, may throw a parse exception. `LocalDate.parse`, `UUID.fromString` (older naming) |
| `instance` / `getInstance` | Returns *an* instance, not necessarily new. `Calendar.getInstance`, `MessageDigest.getInstance` |
| `create` / `newInstance` | Guarantees a new instance each call. `Array.newInstance` |
| `copyOf` | Defensive immutable copy. `List.copyOf`, `Arrays.copyOf` |
| `getType` / `toType` | Factory on a different class than the returned type. `Files.getFileStore`, `Collectors.toList` |

Choosing `of` when you mean `create` is a real bug source: a caller who assumes a fresh mutable instance will get an `UnsupportedOperationException` from `List.of(...).add(...)`.

### Java implementation — validating static factory on a record

Records have a canonical constructor, and a compact constructor is the right place for invariants. But when construction can *legitimately* fail on user input, a factory returning `Optional` or a result type beats an exception.

```java
public record Iban(String value) {

    private static final Pattern SHAPE = Pattern.compile("[A-Z]{2}\\d{2}[A-Z0-9]{11,30}");

    // Compact constructor: invariants that indicate a programming error if violated.
    public Iban {
        Objects.requireNonNull(value, "value");
        if (!SHAPE.matcher(value).matches() || !mod97Valid(value)) {
            throw new IllegalArgumentException("invalid IBAN");
        }
    }

    /** Normalising factory: what callers should actually use. */
    public static Iban of(String raw) {
        return new Iban(raw.replaceAll("\\s", "").toUpperCase(Locale.ROOT));
    }

    /** Boundary factory: untrusted input, failure is expected, not exceptional. */
    public static Optional<Iban> tryParse(String raw) {
        if (raw == null || raw.isBlank()) return Optional.empty();
        try {
            return Optional.of(of(raw));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    private static boolean mod97Valid(String iban) {
        String rearranged = iban.substring(4) + iban.substring(0, 4);
        StringBuilder digits = new StringBuilder(rearranged.length() * 2);
        for (char c : rearranged.toCharArray()) {
            digits.append(Character.isDigit(c) ? c - '0' : c - 'A' + 10);
        }
        return new BigInteger(digits.toString()).mod(BigInteger.valueOf(97)).intValue() == 1;
    }
}
```

Note the pairing: the constructor enforces the invariant so an `Iban` *cannot* exist in an invalid state anywhere in the system, and the factories provide ergonomic and failure-tolerant entry points. Neither alone is sufficient.

### Java implementation — real Factory Method (subclass decides)

Factory Method earns its keep when a framework owns an algorithm and needs subclasses to supply the product type.

```java
public abstract class ReportJob {

    // Template algorithm — owned by the base class.
    public final ReportResult run(ReportRequest request) {
        ReportWriter writer = createWriter(request);   // factory method
        try (writer) {
            writer.header(request.title());
            request.rows().forEach(writer::row);
            return new ReportResult(writer.bytesWritten(), writer.contentType());
        }
    }

    /** Subclasses decide which product. */
    protected abstract ReportWriter createWriter(ReportRequest request);
}

public final class CsvReportJob extends ReportJob {
    @Override
    protected ReportWriter createWriter(ReportRequest request) {
        return new CsvReportWriter(request.outputStream(), ',');
    }
}

public final class XlsxReportJob extends ReportJob {
    private final XlsxStyles styles;
    public XlsxReportJob(XlsxStyles styles) { this.styles = styles; }

    @Override
    protected ReportWriter createWriter(ReportRequest request) {
        return new XlsxReportWriter(request.outputStream(), styles);
    }
}
```

In modern Java, ask whether that abstract method should just be a `Function<ReportRequest, ReportWriter>` constructor parameter. Usually it should:

```java
public final class ReportJob {
    private final Function<ReportRequest, ReportWriter> writerFactory;

    public ReportJob(Function<ReportRequest, ReportWriter> writerFactory) {
        this.writerFactory = writerFactory;
    }

    public ReportResult run(ReportRequest request) { /* same body */ }
}

var csv  = new ReportJob(r -> new CsvReportWriter(r.outputStream(), ','));
var xlsx = new ReportJob(r -> new XlsxReportWriter(r.outputStream(), styles));
```

Two subclasses gone, inheritance gone, and each variant is now testable by passing a fake writer. Keep the abstract-class form only when subclasses need to override *several* related hooks that must stay consistent with each other, or when a framework's extension contract already dictates it.

### Registry-based factory (the type-selection case)

The most common real "factory" in a Spring codebase is a dispatch map, and it should be built by the container, not by a `switch`.

```java
public interface PaymentGateway {
    PaymentMethod supports();
    Authorization authorize(PaymentRequest request);
}

@Component
public class PaymentGateways {

    private final Map<PaymentMethod, PaymentGateway> byMethod;

    public PaymentGateways(List<PaymentGateway> gateways) {
        this.byMethod = gateways.stream()
            .collect(Collectors.toUnmodifiableMap(PaymentGateway::supports, identity()));
    }

    public PaymentGateway forMethod(PaymentMethod method) {
        PaymentGateway gateway = byMethod.get(method);
        if (gateway == null) {
            throw new UnsupportedPaymentMethodException(method);
        }
        return gateway;
    }
}
```

Adding Klarna is a new `@Component`. No existing file changes. `Collectors.toUnmodifiableMap` throws on duplicate keys, so two gateways claiming `CARD` fail at startup rather than silently letting one win — that failure mode is the whole reason to prefer this over a manual `put` loop.

### Where it appears in the JDK and Spring

| Class | Pattern |
|---|---|
| `List.of`, `Set.of`, `Map.of`, `Map.entry` | Static factory returning hidden immutable implementations (`ListN`, `List12`) |
| `Integer.valueOf`, `Boolean.valueOf` | Static factory + Flyweight cache |
| `Optional.of` / `ofNullable` / `empty` | Static factory; `empty()` returns a shared instance |
| `Stream.of`, `IntStream.range`, `Collectors.*` | Static factories throughout |
| `Executors.newFixedThreadPool` | Static factory hiding `ThreadPoolExecutor` configuration |
| `Calendar.getInstance`, `NumberFormat.getInstance` | Locale-dependent implementation selection |
| `MessageDigest.getInstance("SHA-256")` | Provider-based factory (also Abstract Factory territory) |
| `LogFactory.getLog`, `LoggerFactory.getLogger` | Classic factory over a pluggable backend |
| `FactoryBean<T>` in Spring | The container's own Factory Method SPI |
| `ObjectProvider<T>`, `@Bean` methods | Container-managed factories |
| `BeanFactory` itself | The name is not an accident |

`FactoryBean` deserves a specific note: `getBean("myThing")` returns the **product**, while `getBean("&myThing")` returns the factory. Forgetting this produces the confusing "expected `Foo` but got `FooFactoryBean`" error when a `FactoryBean` is injected by type into a raw `Object` slot.

### When it is the WRONG choice

- **A factory with one branch.** `PaymentGatewayFactory.create()` that always returns `StripeGateway` is a constructor with extra syntax.
- **A factory whose selection input is a `String` from config, resolved at startup.** That is a Spring `@ConditionalOnProperty` or a profile, and letting the container do it gives you startup-time failure instead of first-request failure.
- **Factory over a factory.** `AbstractGatewayFactoryProvider` is a real class name I have deleted. If you need three levels, the actual problem is that construction depends on runtime state you should have injected.
- **Hiding a constructor that is genuinely fine.** `new Money(BigDecimal, Currency)` does not need `Money.create(...)`.

**Over-engineering smell:** a factory that takes the exact same arguments as the constructor, in the same order, and does nothing but `return new X(...)`. Delete it. The counter-argument "we might need to swap the implementation later" is answered by the fact that changing `new X(a,b)` to `X.of(a,b)` later is a mechanical refactor your IDE performs in one keystroke.

### Production scenario: enum-switch factory silently defaulting

**Problem.** A new payment method `WALLET` was added to the `PaymentMethod` enum for a mobile launch. QA passed. In production, wallet payments were charged as card payments — wrong interchange fees, wrong reconciliation ledger, and 4,100 transactions needed manual repair.

**Cause.** The factory was a `switch` with a `default`:

```java
static PaymentGateway create(PaymentMethod method) {
    switch (method) {
        case CARD:   return new StripeGateway();
        case SEPA:   return new SepaGateway();
        case PAYPAL: return new PaypalGateway();
        default:     return new StripeGateway();   // "sensible fallback"
    }
}
```

The `default` branch turned "unhandled case" into "wrong behavior." The compiler could have caught this and was explicitly prevented from doing so.

**Solution.** Remove the `default` and use an exhaustive `switch` expression (Java 14+). With no `default`, the compiler refuses to compile once a new enum constant exists, and the build fails on the line that must change.

```java
static PaymentGateway create(PaymentMethod method) {
    return switch (method) {
        case CARD   -> new StripeGateway();
        case SEPA   -> new SepaGateway();
        case PAYPAL -> new PaypalGateway();
        case WALLET -> new WalletGateway();
        // no default: adding a constant is now a compile error
    };
}
```

Better still, the registry form above, where the mapping lives with each implementation and a missing gateway fails at **startup**:

```java
@Component
class PaymentGatewayCompleteness {
    PaymentGatewayCompleteness(List<PaymentGateway> gateways) {
        var covered = gateways.stream().map(PaymentGateway::supports).collect(toSet());
        var missing = EnumSet.allOf(PaymentMethod.class);
        missing.removeAll(covered);
        if (!missing.isEmpty()) {
            throw new IllegalStateException("No PaymentGateway for: " + missing);
        }
    }
}
```

**Lesson.** `default:` in a factory switch over a closed set is a bug waiting for a deploy. Exhaustiveness is a free correctness check; do not trade it for a fallback that can only ever be wrong.

---

## 4. Creational — Abstract Factory

### The problem it solves

Sometimes objects only work in **families**. A Postgres `Dialect` must be paired with a Postgres `SequenceReader` and a Postgres `UpsertBuilder`; combining a Postgres dialect with an Oracle upsert builder produces SQL that compiles and then corrupts data. Abstract Factory exists to make mixed families unconstructible: you obtain one factory, and every product you get from it is guaranteed to be compatible with the others.

Factory Method creates **one** product and defers *which subclass*. Abstract Factory creates **several related** products and defers *which family*. That is the whole distinction, and it is the standard follow-up question.

### Java implementation

```java
public interface SqlDialectFactory {
    Dialect dialect();
    UpsertBuilder upsertBuilder();
    PagingClauseWriter pagingWriter();
    IdentifierQuoter quoter();
}

public final class PostgresFactory implements SqlDialectFactory {
    public Dialect dialect()                { return Dialect.POSTGRES; }
    public UpsertBuilder upsertBuilder()    { return new OnConflictUpsertBuilder(); }
    public PagingClauseWriter pagingWriter(){ return new LimitOffsetWriter(); }
    public IdentifierQuoter quoter()        { return new DoubleQuoteQuoter(); }
}

public final class SqlServerFactory implements SqlDialectFactory {
    public Dialect dialect()                { return Dialect.SQLSERVER; }
    public UpsertBuilder upsertBuilder()    { return new MergeUpsertBuilder(); }
    public PagingClauseWriter pagingWriter(){ return new OffsetFetchWriter(); }
    public IdentifierQuoter quoter()        { return new BracketQuoter(); }
}
```

Consumers depend on the abstract factory and never name a concrete product:

```java
public final class QueryCompiler {

    private final UpsertBuilder upserts;
    private final PagingClauseWriter paging;
    private final IdentifierQuoter quoter;

    public QueryCompiler(SqlDialectFactory factory) {
        this.upserts = factory.upsertBuilder();
        this.paging  = factory.pagingWriter();
        this.quoter  = factory.quoter();
    }

    public String compileUpsert(TableSpec table, List<Column> conflictKeys) {
        return upserts.build(quoter.quote(table.name()), table.columns(), conflictKeys);
    }
}
```

Because `QueryCompiler` takes the factory, it is structurally impossible for it to hold a Postgres upsert builder and a SQL Server quoter.

### When it collapses into DI configuration

In a Spring application, the container **is** an abstract factory: a `@Configuration` class conditioned on a property produces a consistent family of beans, and consumers inject the products directly.

```java
@Configuration
@ConditionalOnProperty(name = "app.db", havingValue = "postgres", matchIfMissing = true)
class PostgresDialectConfig {
    @Bean UpsertBuilder upsertBuilder()        { return new OnConflictUpsertBuilder(); }
    @Bean PagingClauseWriter pagingWriter()    { return new LimitOffsetWriter(); }
    @Bean IdentifierQuoter quoter()            { return new DoubleQuoteQuoter(); }
}

@Configuration
@ConditionalOnProperty(name = "app.db", havingValue = "sqlserver")
class SqlServerDialectConfig {
    @Bean UpsertBuilder upsertBuilder()        { return new MergeUpsertBuilder(); }
    @Bean PagingClauseWriter pagingWriter()    { return new OffsetFetchWriter(); }
    @Bean IdentifierQuoter quoter()            { return new BracketQuoter(); }
}
```

```java
// No factory interface anywhere.
public QueryCompiler(UpsertBuilder upserts, PagingClauseWriter paging, IdentifierQuoter quoter) { ... }
```

You gain: less code, and startup-time verification that all three beans exist. You lose: the compiler no longer enforces family consistency — a careless third `@Configuration` could contribute a mismatched `quoter`, and nothing stops it. Whether that trade is right depends on whether the family can vary **at runtime**.

**Decision rule.** If the family is chosen once per process (deployment configuration), use DI configuration. If the family is chosen **per request, per tenant, or per connection**, you need the real Abstract Factory, because a bean cannot be two things at once.

Multi-tenant example where the pattern is genuinely required:

```java
@Component
public class TenantAwareCompilerCache {

    private final Map<Dialect, SqlDialectFactory> factories;
    private final Map<Dialect, QueryCompiler> compilers = new ConcurrentHashMap<>();

    public TenantAwareCompilerCache(List<SqlDialectFactory> discovered) {
        this.factories = discovered.stream()
            .collect(toUnmodifiableMap(SqlDialectFactory::dialect, identity()));
    }

    public QueryCompiler forTenant(TenantId tenant) {
        Dialect dialect = tenant.dialect();
        return compilers.computeIfAbsent(dialect, d -> new QueryCompiler(factories.get(d)));
    }
}
```

### Where it appears in the JDK and Spring

| Class | Family it produces |
|---|---|
| `DocumentBuilderFactory` | `DocumentBuilder` + the parser/validator/entity-resolver family behind it |
| `XMLInputFactory`, `TransformerFactory`, `SAXParserFactory` | Whole JAXP implementation families, selected by system property or classpath |
| `SSLContext.getSocketFactory()` / `getServerSocketFactory()` | Client and server socket factories that must share a trust configuration |
| `java.sql.Connection` | `createStatement`, `prepareStatement`, `createBlob` — all products of one driver family |
| `Charset.newEncoder` / `newDecoder` | Matched encoder/decoder pair |
| `Hibernate` `Dialect` | Selects the identity/sequence/pagination/lock strategies as a set |
| Spring `BeanFactory` + `@Configuration` classes | The container as configurable family provider |
| `ConnectionFactory` (JMS), `Jackson` `JsonFactory` | Parser/generator families |
| Spring Cloud `LoadBalancerClientFactory` | Per-service-name family of load-balancing components |

The JAXP factories are worth studying because they show the pattern's real-world cost: `DocumentBuilderFactory.newInstance()` resolves the implementation through system properties, `META-INF/services`, and a JAR-scanning fallback. That flexibility is exactly why "which XML parser am I actually using" is a classic day-long debugging session, and why the secure-processing configuration has to be reapplied on every factory instance.

### When it is the WRONG choice

- **The products are not actually a family.** If `Foo` and `Bar` can be mixed freely without breaking anything, you have two independent factories at best, and probably just two beans.
- **The family never varies.** One implementation of the abstract factory is pure indirection.
- **You are in Spring and the choice is per-deployment.** Use `@ConditionalOnProperty` / profiles; a hand-rolled factory hierarchy duplicates the container.
- **You need to add a product type frequently.** Adding a method to the abstract factory breaks **every** implementation. Abstract Factory is easy to extend with new families and hard to extend with new products — the inverse of Visitor's trade-off, and the reason both patterns feel rigid in fast-moving code.

**Over-engineering smell:** an abstract factory with one product method. That is Factory Method with extra ceremony.

### Production scenario: XXE reintroduced by a second factory instance

**Problem.** A document-ingestion service was hardened against XML External Entity attacks after a pentest. Six months later, a new endpoint that imported vendor catalogs was found to read `/etc/passwd` and make outbound HTTP calls to an attacker-controlled host from a crafted upload.

**Cause.** The hardening was applied in one class that called `DocumentBuilderFactory.newInstance()` and configured it. The new endpoint called `DocumentBuilderFactory.newInstance()` again — a **fresh, unconfigured** factory, because `newInstance()` is a factory *creator*, not a shared singleton. Secure-processing settings live on the factory instance, so the new one had all the defaults, including external entity resolution.

**Solution.** Never let application code call the JAXP factory directly. Wrap the family in one bean with the hardening baked in, and ban the raw call with a static-analysis rule so the next endpoint cannot regress it.

```java
@Component
public class SafeXml {

    private final DocumentBuilderFactory documentBuilders = hardenedDocumentBuilderFactory();
    private final XMLInputFactory streamReaders = hardenedStreamFactory();

    private static DocumentBuilderFactory hardenedDocumentBuilderFactory() {
        var f = DocumentBuilderFactory.newInstance();
        try {
            f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setFeature("http://xml.org/sax/features/external-general-entities", false);
            f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            f.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        } catch (ParserConfigurationException e) {
            throw new IllegalStateException("cannot harden XML parser", e);
        }
        f.setXIncludeAware(false);
        f.setExpandEntityReferences(false);
        f.setNamespaceAware(true);
        return f;
    }

    private static XMLInputFactory hardenedStreamFactory() {
        var f = XMLInputFactory.newInstance();
        f.setProperty(XMLInputFactory.SUPPORT_DTD, false);
        f.setProperty(XMLInputFactory.IS_SUPPORTING_EXTERNAL_ENTITIES, false);
        return f;
    }

    /** DocumentBuilder is not thread-safe; the factory is (for creating builders). */
    public Document parse(InputStream in) throws Exception {
        return documentBuilders.newDocumentBuilder().parse(in);
    }

    public XMLStreamReader stream(InputStream in) throws XMLStreamException {
        return streamReaders.createXMLStreamReader(in);
    }
}
```

Plus an ArchUnit test that makes the shortcut impossible:

```java
@Test
void nobody_calls_jaxp_factories_directly() {
    noClasses().that().resideOutsideOfPackage("..xml.safe..")
        .should().callMethod(DocumentBuilderFactory.class, "newInstance")
        .check(new ClassFileImporter().importPackages("com.acme"));
}
```

**Lesson.** When an abstract factory carries **security or correctness configuration**, an unconfigured second instance is a vulnerability. Own the factory as a single configured bean; treat `newInstance()` in application code as a defect.

---

## 5. Creational — Builder

### The problem it solves

The telescoping-constructor problem. An immutable type with four required and eight optional fields forces a choice among three bad options:

1. **Constructor overloads** — a combinatorial ladder, and two `String` optionals make the overloads ambiguous. `new HttpRequest(url, method, body, headers, timeout, retries, followRedirects, ...)` with a call site of `new HttpRequest(u, "POST", null, null, 30, 3, true, null, null)` is unreadable and one transposition away from a bug.
2. **Setters (JavaBeans)** — kills immutability, and the object is observable in a half-built, invalid state. In a concurrent context another thread can see it before it is finished.
3. **A parameter object** — just moves the same problem one class over.

Builder gives named, order-independent arguments, validation at a single commit point, and an immutable result.

### Classic nested builder

```java
public final class ShippingLabel {

    private final Address from;
    private final Address to;
    private final Weight weight;
    private final Carrier carrier;
    private final ServiceLevel serviceLevel;
    private final boolean signatureRequired;
    private final Money insuredValue;
    private final List<String> specialHandling;

    private ShippingLabel(Builder b) {
        this.from = b.from;
        this.to = b.to;
        this.weight = b.weight;
        this.carrier = b.carrier;
        this.serviceLevel = b.serviceLevel;
        this.signatureRequired = b.signatureRequired;
        this.insuredValue = b.insuredValue;
        this.specialHandling = List.copyOf(b.specialHandling);   // defensive, immutable
    }

    public static Builder builder() { return new Builder(); }

    /** Start a builder pre-populated from this instance — the "toBuilder" idiom. */
    public Builder toBuilder() {
        return new Builder()
            .from(from).to(to).weight(weight)
            .carrier(carrier).serviceLevel(serviceLevel)
            .signatureRequired(signatureRequired)
            .insuredValue(insuredValue)
            .specialHandling(specialHandling);
    }

    public static final class Builder {
        private Address from;
        private Address to;
        private Weight weight;
        private Carrier carrier;
        private ServiceLevel serviceLevel = ServiceLevel.GROUND;   // real default
        private boolean signatureRequired;
        private Money insuredValue;
        private final List<String> specialHandling = new ArrayList<>();

        public Builder from(Address v)              { this.from = v; return this; }
        public Builder to(Address v)                { this.to = v; return this; }
        public Builder weight(Weight v)             { this.weight = v; return this; }
        public Builder carrier(Carrier v)           { this.carrier = v; return this; }
        public Builder serviceLevel(ServiceLevel v) { this.serviceLevel = v; return this; }
        public Builder signatureRequired(boolean v) { this.signatureRequired = v; return this; }
        public Builder insuredValue(Money v)        { this.insuredValue = v; return this; }

        public Builder specialHandling(Collection<String> v) {
            this.specialHandling.clear();
            this.specialHandling.addAll(v);
            return this;
        }

        public Builder addSpecialHandling(String v) {
            this.specialHandling.add(v);
            return this;
        }

        public ShippingLabel build() {
            // All cross-field validation happens exactly once, here.
            Objects.requireNonNull(from, "from");
            Objects.requireNonNull(to, "to");
            Objects.requireNonNull(weight, "weight");
            Objects.requireNonNull(carrier, "carrier");

            if (weight.grams() <= 0) {
                throw new IllegalArgumentException("weight must be positive");
            }
            if (serviceLevel == ServiceLevel.OVERNIGHT && !carrier.supportsOvernight()) {
                throw new IllegalArgumentException(carrier + " does not support OVERNIGHT");
            }
            if (insuredValue != null && insuredValue.isGreaterThan(carrier.maxInsurance())) {
                throw new IllegalArgumentException("insured value exceeds carrier maximum");
            }
            if (signatureRequired && serviceLevel == ServiceLevel.ECONOMY) {
                throw new IllegalArgumentException("signature unavailable on ECONOMY");
            }
            return new ShippingLabel(this);
        }
    }
}
```

Four properties make this a *good* builder rather than a fluent setter bag:

1. **`build()` is the only commit point.** Cross-field rules (`OVERNIGHT` requires a capable carrier) cannot be checked in a setter, because the other field may not be set yet. This is the entire reason validation belongs in `build()`.
2. **The target's constructor is private and takes the builder.** No path exists to a `ShippingLabel` that skipped validation.
3. **Collections are copied on the way in and on the way out.** `List.copyOf` in the constructor means mutating the builder afterwards cannot mutate a built label.
4. **`toBuilder()` gives cheap derivation** without exposing mutability, which is what people usually reach for `clone()` to do.

### Records + builder

Records give the value semantics; a builder still helps when the field count is high. The compact constructor keeps single-field invariants; the builder keeps ergonomics and cross-field checks.

```java
public record RetryPolicy(
        int maxAttempts,
        Duration initialBackoff,
        double multiplier,
        Duration maxBackoff,
        double jitterFactor,
        Set<Class<? extends Throwable>> retryOn) {

    public RetryPolicy {
        if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts >= 1");
        if (multiplier < 1.0) throw new IllegalArgumentException("multiplier >= 1.0");
        if (jitterFactor < 0 || jitterFactor > 1) {
            throw new IllegalArgumentException("jitterFactor in [0,1]");
        }
        Objects.requireNonNull(initialBackoff);
        Objects.requireNonNull(maxBackoff);
        retryOn = Set.copyOf(retryOn);   // reassigning the parameter makes the field immutable
    }

    public static Builder builder() { return new Builder(); }

    public static RetryPolicy defaults() {
        return builder().build();
    }

    public static final class Builder {
        private int maxAttempts = 3;
        private Duration initialBackoff = Duration.ofMillis(100);
        private double multiplier = 2.0;
        private Duration maxBackoff = Duration.ofSeconds(10);
        private double jitterFactor = 0.2;
        private Set<Class<? extends Throwable>> retryOn = Set.of(IOException.class);

        public Builder maxAttempts(int v)          { this.maxAttempts = v; return this; }
        public Builder initialBackoff(Duration v)  { this.initialBackoff = v; return this; }
        public Builder multiplier(double v)        { this.multiplier = v; return this; }
        public Builder maxBackoff(Duration v)      { this.maxBackoff = v; return this; }
        public Builder jitterFactor(double v)      { this.jitterFactor = v; return this; }

        @SafeVarargs
        public final Builder retryOn(Class<? extends Throwable>... types) {
            this.retryOn = Set.of(types);
            return this;
        }

        public RetryPolicy build() {
            if (maxBackoff.compareTo(initialBackoff) < 0) {
                throw new IllegalArgumentException("maxBackoff must be >= initialBackoff");
            }
            return new RetryPolicy(maxAttempts, initialBackoff, multiplier,
                                   maxBackoff, jitterFactor, retryOn);
        }
    }
}
```

`retryOn = Set.copyOf(retryOn)` inside the compact constructor is the record idiom for defensive copying: you reassign the *parameter*, and the implicit field assignment at the end of the compact constructor picks up the copy.

For records with **few** fields, skip the builder entirely and use `with`-style derivation:

```java
public record PageRequest(int page, int size, Sort sort) {
    public PageRequest withPage(int page)  { return new PageRequest(page, size, sort); }
    public PageRequest withSize(int size)  { return new PageRequest(page, size, sort); }
    public PageRequest withSort(Sort sort) { return new PageRequest(page, size, sort); }
}
```

Three fields, three one-line methods, no builder class. The crossover in practice is around five or six fields, or the first optional field whose absence is meaningful.

### Staged builder (compile-time required fields)

If required fields being missing is a repeated production issue, encode ordering in the type system so `build()` is unreachable until they are set.

```java
public final class Transfer {

    public interface FromStage { ToStage from(AccountId id); }
    public interface ToStage   { AmountStage to(AccountId id); }
    public interface AmountStage { FinalStage amount(Money money); }
    public interface FinalStage {
        FinalStage reference(String ref);
        FinalStage idempotencyKey(String key);
        Transfer build();
    }

    public static FromStage builder() { return new Stages(); }

    private static final class Stages implements FromStage, ToStage, AmountStage, FinalStage {
        private AccountId from, to;
        private Money amount;
        private String reference, idempotencyKey;

        public ToStage from(AccountId id)   { this.from = id; return this; }
        public AmountStage to(AccountId id) { this.to = id; return this; }
        public FinalStage amount(Money m)   { this.amount = m; return this; }
        public FinalStage reference(String r)      { this.reference = r; return this; }
        public FinalStage idempotencyKey(String k) { this.idempotencyKey = k; return this; }

        public Transfer build() {
            if (from.equals(to)) throw new IllegalArgumentException("self transfer");
            if (!amount.isPositive()) throw new IllegalArgumentException("amount must be positive");
            return new Transfer(from, to, amount, reference,
                                idempotencyKey != null ? idempotencyKey : UUID.randomUUID().toString());
        }
    }
    // fields + private constructor omitted
}
```

`Transfer.builder().from(a).to(b).amount(m).build()` compiles; omitting `.amount(...)` does not. Use this sparingly — it triples the interface count — but it is the right answer for a small number of high-stakes types like money movement.

### Where it appears in the JDK and Spring

| Class | Note |
|---|---|
| `StringBuilder` | The original, though it is mutable-by-design rather than build-once |
| `HttpRequest.newBuilder()` / `HttpClient.newBuilder()` (Java 11+) | Textbook immutable builder |
| `Stream.Builder<T>` | `Stream.builder().add(x).build()` |
| `Calendar.Builder`, `Locale.Builder`, `DateTimeFormatterBuilder` | `DateTimeFormatterBuilder` is a builder whose `build()` result depends on call *order* |
| `ProcessBuilder` | Mutable configuration + `start()` as the commit point |
| `Thread.ofVirtual().name("x-", 0).factory()` (Java 21) | Builder producing a `ThreadFactory` |
| Spring `UriComponentsBuilder`, `MockMvcRequestBuilders`, `BeanDefinitionBuilder` | Everywhere in the framework |
| Spring Security `HttpSecurity` | A builder whose `build()` returns `SecurityFilterChain` |
| `Jwts.builder()` (jjwt), `WebClient.builder()` | Third-party but ubiquitous |

`HttpSecurity` is instructive: it is a builder that is *not* reusable, and calling `build()` twice throws. If your builder is single-use, say so and enforce it.

### Lombok `@Builder` pitfalls

`@Builder` removes real boilerplate and introduces four specific production hazards.

**1. No validation.** `@Builder` generates `build()` calling the all-args constructor, so nothing checks required fields. `new ShippingLabel.Builder().build()` compiles and produces an object with null everything, which then NPEs three layers away from the mistake.

```java
// Lombok with the validation actually restored:
@Builder
public record CreateUser(String email, String passwordHash, Set<Role> roles) {
    public CreateUser {
        Objects.requireNonNull(email, "email");
        Objects.requireNonNull(passwordHash, "passwordHash");
        roles = roles == null ? Set.of() : Set.copyOf(roles);
    }
}
```

On a record, `@Builder`'s `build()` calls the canonical constructor, so the compact constructor's checks do run. On a **class**, `@Builder` + `@AllArgsConstructor` means your handwritten validation in a different constructor is bypassed entirely — the failure mode people get wrong.

**2. Mutable collections leak.** `@Builder` assigns the collection reference straight through. The caller keeps a reference to the same `ArrayList` and can mutate the "immutable" object afterwards. `@Singular` fixes it by producing an unmodifiable copy:

```java
@Builder
public class Order {
    @Singular private final List<OrderLine> lines;   // builder gets .line(x) and .lines(coll)
}
```

Without `@Singular`, add `List.copyOf` in a custom `build()` or use a record with a compact constructor.

**3. Defaults silently become null.** A field initializer is ignored by the generated builder unless annotated:

```java
@Builder
public class CacheConfig {
    private final Duration ttl = Duration.ofMinutes(5);          // IGNORED by builder → null
    @Builder.Default private final Duration ttl2 = Duration.ofMinutes(5);   // honored
}
```

This produces a `null` `Duration` in production and a passing unit test that happened to set `ttl` explicitly. It is the most common Lombok builder incident I have seen.

**4. `@Builder` + JPA entity.** The generated all-args constructor plus a private no-arg constructor confuses Hibernate proxying, `@Builder` bypasses lifecycle defaults, and builder-created entities skip the field-level initialization Hibernate expects. Do not put `@Builder` on `@Entity`; put it on the DTO and map explicitly.

### When it is the WRONG choice

- **Two or three required fields, no optionals.** A constructor or a record is shorter and clearer. `new Money(amount, currency)` needs no builder.
- **The object is mutable anyway.** If callers will call setters afterwards, the builder buys nothing.
- **The builder is used once.** A builder whose only call site sets every field in a fixed order is a constructor with 30 extra lines.
- **You need to *require* combinations and refuse to validate.** A builder without validation is strictly worse than a constructor, because it removes the compiler's arity check without adding a runtime check.

**Over-engineering smell:** a builder generated for every DTO in the codebase because "it's the convention," including three-field records. Also: a builder with a `validate()` method that callers are supposed to remember to call. If validation is optional, it will be skipped.

### Production scenario: `@Builder.Default` dropped in a refactor

**Problem.** An order service began writing rows with `channel = null` after a routine refactor. Reporting queries grouped by `channel`, so revenue dashboards lost 30% of orders into a null bucket, and a downstream reconciliation job failed its nightly checksum. No exception was thrown anywhere; the column was nullable.

**Cause.** The DTO was converted from a hand-written builder to Lombok:

```java
// Before — hand-written builder
public static final class Builder {
    private Channel channel = Channel.WEB;    // default lived here
    ...
}

// After — Lombok
@Builder
public class CreateOrderCommand {
    private final Channel channel = Channel.WEB;   // initializer ignored by the builder
}
```

Callers that came from the web controller always set `channel` explicitly, which is why unit tests and manual QA passed. The mobile API path relied on the default, and only that path wrote nulls.

**Solution.** Three layers, because one is not enough.

```java
@Builder
public record CreateOrderCommand(
        CustomerId customerId,
        List<OrderLineCommand> lines,
        Channel channel,
        String promotionCode) {

    public CreateOrderCommand {
        Objects.requireNonNull(customerId, "customerId");
        if (lines == null || lines.isEmpty()) {
            throw new IllegalArgumentException("at least one line required");
        }
        lines = List.copyOf(lines);
        channel = channel == null ? Channel.WEB : channel;   // default enforced at construction
    }
}
```

1. Defaults and required checks moved **into the type**, where no construction path can skip them.
2. The database column became `NOT NULL DEFAULT 'WEB'` so a null can never be persisted again.
3. A test asserting the default exists, because the earlier version had no such test — which is the actual root cause.

```java
@Test
void channel_defaults_to_web_when_omitted() {
    var cmd = CreateOrderCommand.builder()
        .customerId(new CustomerId(1L))
        .lines(List.of(new OrderLineCommand("SKU-1", 1)))
        .build();
    assertThat(cmd.channel()).isEqualTo(Channel.WEB);
}
```

**Lesson.** A default that lives in a builder rather than in the type is a default that a future construction path will miss. Put invariants and defaults where every path must pass through them.

---

## 6. Creational — Prototype and Copying

### The problem it solves

You have a configured, expensive-to-build object and want a variant of it. Rebuilding from scratch is slow or the construction inputs are gone; a template you copy and tweak is what you want. The GoF answer is Prototype: the object knows how to copy itself.

Java's answer to Prototype — `Cloneable` and `Object.clone()` — is a well-documented design mistake, and knowing precisely *why* is a standard senior question.

### Why `clone()` is broken

**1. `Cloneable` declares no methods.** It is a marker interface that changes the behavior of a `protected` method on `Object`. You cannot call `clone()` polymorphically through `Cloneable` because the interface has no `clone()`. This inverts how interfaces are supposed to work.

**2. `Object.clone()` is a shallow field-by-field copy.** Reference fields are shared between original and copy:

```java
public class Team implements Cloneable {
    private String name;
    private List<Member> members = new ArrayList<>();

    @Override
    public Team clone() {
        try {
            return (Team) super.clone();   // members points at the SAME ArrayList
        } catch (CloneNotSupportedException e) {
            throw new AssertionError(e);
        }
    }
}

Team a = new Team("A");
Team b = a.clone();
b.addMember(new Member("bob"));   // also appears in a.members
```

Correcting it requires manual deep copy of every mutable field, and the compiler will not remind you when someone adds a field later:

```java
@Override
public Team clone() {
    try {
        Team copy = (Team) super.clone();
        copy.members = new ArrayList<>(this.members);   // still shallow per Member
        return copy;
    } catch (CloneNotSupportedException e) {
        throw new AssertionError(e);
    }
}
```

**3. `clone()` does not run a constructor.** All invariant enforcement in your constructor is bypassed. `final` fields cannot be reassigned in `clone()`, so a class with `final` collection fields literally cannot implement correct cloning without reflection.

**4. `CloneNotSupportedException` is checked** and thrown by a method you already know supports cloning, forcing a meaningless catch block in every implementation.

**5. Contract by convention only.** `x.clone() != x`, `x.clone().getClass() == x.getClass()`, and `x.clone().equals(x)` are documented expectations, not guarantees. Subclasses break them silently.

Bloch's conclusion in *Effective Java*: "provide a copy constructor or copy factory instead," and never implement `Cloneable` in new code. The one place `clone()` remains idiomatic is arrays — `int[] copy = original.clone()` is concise, correct, and fast.

### Copy constructors and copy factories

```java
public final class Team {

    private final String name;
    private final List<Member> members;

    public Team(String name, List<Member> members) {
        this.name = Objects.requireNonNull(name);
        this.members = List.copyOf(members);
    }

    /** Copy constructor: explicit, runs validation, handles depth deliberately. */
    public Team(Team other) {
        this(other.name, other.members);   // Member is immutable, so no deeper copy needed
    }

    /** Copy factory: same thing, better name, can return a cached/shared instance. */
    public static Team copyOf(Team other) { return new Team(other); }

    /** Derivation: the operation people actually wanted from clone(). */
    public Team withName(String newName) { return new Team(newName, members); }

    public Team plusMember(Member m) {
        var next = new ArrayList<>(members);
        next.add(m);
        return new Team(name, next);
    }
}
```

The copy constructor is better than `clone()` on every axis: it is a real constructor so invariants hold, it takes an interface-typed argument if you want (`new ArrayList<>(someCollection)` is a *conversion* constructor), it can be overloaded, and the depth of the copy is an explicit decision visible in the code.

### Records and `with`-style derivation

For records, the copy question mostly dissolves: a record with immutable components does not need copying, because sharing is safe. What you need is **derivation**.

```java
public record Quote(
        QuoteId id,
        CustomerId customer,
        Money amount,
        Instant validUntil,
        List<QuoteLine> lines) {

    public Quote {
        lines = List.copyOf(lines);
    }

    public Quote withAmount(Money amount) {
        return new Quote(id, customer, amount, validUntil, lines);
    }

    public Quote extendedTo(Instant validUntil) {
        if (validUntil.isBefore(this.validUntil)) {
            throw new IllegalArgumentException("cannot shorten validity");
        }
        return new Quote(id, customer, amount, validUntil, lines);
    }

    public Quote plusLine(QuoteLine line) {
        var next = new ArrayList<>(lines);
        next.add(line);
        return new Quote(id, customer, recalculate(next), validUntil, next);
    }
}
```

Note `extendedTo` carries a business rule that a generic `clone()`-and-mutate approach cannot: derivation methods are a place to enforce which transitions are legal.

When the component count makes hand-written `withX` methods tedious, that is the signal to add a `toBuilder()` (see [Builder](#5-creational-builder)) rather than to reach for reflection-based copying.

### Where Prototype genuinely appears

| Real usage | Why a prototype rather than a constructor |
|---|---|
| Spring `@Scope("prototype")` | Naming collision — Spring's prototype scope means "new instance per lookup," which is Factory, not GoF Prototype |
| `Object.clone()` on arrays | The one idiomatic clone |
| `ArrayList(Collection)`, `HashMap(Map)`, `EnumSet.copyOf` | Copy/conversion constructors and factories |
| `BeanUtils.copyProperties` (Spring) | Reflective shallow copy; convenient and a frequent source of silent field-drift bugs |
| Jackson `ObjectMapper.copy()` | Real prototype: a configured mapper is expensive; copy then tweak |
| `DateTimeFormatter.withLocale`, `Locale.forLanguageTag` | Immutable derivation |
| JMeter / test-fixture templates, `Random`-seeded scenario builders | A configured template cloned per test |
| Kryo / protobuf `Message.toBuilder()` | Serialization frameworks give you prototype semantics explicitly |

`ObjectMapper.copy()` is the clearest legitimate example. Building an `ObjectMapper` with modules registered is genuinely expensive and `ObjectMapper` is thread-safe once configured, so the pattern is: build one, `copy()` it when a subsystem needs different serialization settings, and never reconfigure a shared instance at runtime.

### When it is the WRONG choice

- **The type is immutable.** Copying an immutable object is pure waste. Share the reference.
- **The object has identity.** Cloning a JPA `@Entity` produces an object with the same `@Id`, which Hibernate will treat as the same row. "Duplicate this order" must mint a new identity explicitly.
- **You are cloning to escape a mutation bug.** The fix is immutability or defensive copying at the boundary, not defensive copying everywhere.
- **Reflection-based copying across types.** `BeanUtils.copyProperties(entity, dto)` breaks silently when a field is renamed on one side — no compile error, just a null in production. Prefer explicit mapping or a compile-time mapper (MapStruct) that fails the build.

**Over-engineering smell:** a `DeepCopyUtils` class using serialization round-trips (`ObjectOutputStream` → `ObjectInputStream`) to clone domain objects. It is slow, requires `Serializable` everywhere, silently drops transient fields, and is a deserialization-gadget risk. If you need deep copies of a graph that often, the graph should be immutable.

### Production scenario: cloned entity overwrote the original order

**Problem.** A "duplicate order" feature let CSRs copy a past order into a new draft. After release, support reported that duplicating an order **changed the original**: line quantities from the new draft appeared on the historical order, and the original's audit trail showed edits nobody made.

**Cause.** The implementation used `clone()` on the JPA entity.

```java
@Entity
public class Order implements Cloneable {
    @Id @GeneratedValue private Long id;
    @OneToMany(cascade = ALL, orphanRemoval = true) private List<OrderLine> lines = new ArrayList<>();

    @Override public Order clone() {
        try { return (Order) super.clone(); } catch (CloneNotSupportedException e) { throw new AssertionError(e); }
    }
}
```

Two failures compounded. The shallow copy shared the **same `lines` list instance**, so adding a line to the duplicate added it to the original. And `super.clone()` copied the `id` field, so the clone was not a new entity — it was a detached instance with an existing primary key. When the service called `save()`, Hibernate ran `merge`, which updated the original row.

**Solution.** Replace cloning with an explicit domain operation that mints new identity and deep-copies what must be independent.

```java
@Service
public class OrderDuplication {

    private final OrderRepository orders;
    private final Clock clock;

    OrderDuplication(OrderRepository orders, Clock clock) {
        this.orders = orders;
        this.clock = clock;
    }

    @Transactional
    public Order duplicateAsDraft(Long sourceId, UserId actor) {
        Order source = orders.findById(sourceId)
            .orElseThrow(() -> new OrderNotFoundException(sourceId));

        Order draft = Order.newDraft(source.customer(), clock.instant(), actor);

        // Copy only what should carry over. Deliberate omissions are the point:
        // no id, no order number, no payment, no shipment, no audit history, no status.
        for (OrderLine line : source.lines()) {
            draft.addLine(line.sku(), line.quantity(), line.unitPrice());
        }
        draft.setShippingAddress(source.shippingAddress());   // Address is an immutable @Embeddable
        draft.setNote("Duplicated from #" + source.orderNumber());

        return orders.save(draft);
    }
}
```

`Order.newDraft(...)` is a static factory that leaves `id` null so `save()` performs an insert. The loop calls `draft.addLine(...)`, which goes through the entity's own invariant checks — a raw list copy would have skipped them.

Guard test:

```java
@Test
void duplicating_does_not_touch_the_source() {
    Order source = orders.save(anOrderWith(2, "SKU-1"));
    Order draft = duplication.duplicateAsDraft(source.getId(), actor);

    entityManager.flush();
    entityManager.clear();

    Order reloaded = orders.findById(source.getId()).orElseThrow();
    assertThat(draft.getId()).isNotEqualTo(source.getId());
    assertThat(reloaded.lines()).hasSize(2);
    assertThat(reloaded.getUpdatedAt()).isEqualTo(source.getUpdatedAt());
}
```

**Lesson.** Never clone an entity. "Duplicate" is a domain operation with rules about what carries over and what must be new — that decision list is the feature, and `clone()` hides it.

---

## 7. Structural — Adapter

### The problem it solves

You own an interface. Something you do not own has a different one. Adapter is the class that translates between them so the mismatch lives in exactly one place.

The critical property is that Adapter **changes shape, not behavior**. It renames, reorders, converts types, translates error models, and adjusts cardinality. It does not add retries, caching, or logging — that is Decorator. Conflating the two produces classes that are hard to name and impossible to test cleanly.

### Java implementation — wrapping a legacy client

The real version of this problem: a vendor SDK that returns status codes instead of exceptions, uses its own date type, and has a method name from 2009.

```java
// --- Your domain interface. You own this. Nothing vendor-shaped leaks through it. ---
public interface CreditBureau {
    CreditReport fetch(Ssn ssn) throws CreditBureauUnavailableException;
}

public record CreditReport(int score, Instant asOf, List<Delinquency> delinquencies) {}
```

```java
// --- The vendor SDK. You own none of this. ---
public class AcmeBureauClient {
    public AcmeResponse doQuery(AcmeRequest req) { ... }
}
public class AcmeResponse {
    public int getRc();                 // 0 = ok, 12 = not found, 90 = throttled, 91 = down
    public String getFicoValue();       // numeric string, or "" when rc != 0
    public String getRptDate();         // "yyyyMMdd" in America/Chicago
    public AcmeItem[] getItems();       // may be null
}
```

```java
// --- The Adapter. The only class in the codebase that knows Acme exists. ---
@Component
public class AcmeCreditBureauAdapter implements CreditBureau {

    private static final DateTimeFormatter ACME_DATE =
        DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneId.of("America/Chicago"));

    private final AcmeBureauClient client;

    AcmeCreditBureauAdapter(AcmeBureauClient client) { this.client = client; }

    @Override
    public CreditReport fetch(Ssn ssn) {
        AcmeRequest req = new AcmeRequest();
        req.setSsnDigits(ssn.digits());
        req.setProductCd("FICO8");

        AcmeResponse res = client.doQuery(req);

        // Error-model translation: status codes become the domain's exception vocabulary.
        switch (res.getRc()) {
            case 0 -> { /* fall through to mapping */ }
            case 12 -> throw new SubjectNotFoundException(ssn);
            case 90 -> throw new CreditBureauThrottledException();
            case 91, 92 -> throw new CreditBureauUnavailableException("acme rc=" + res.getRc());
            default -> throw new CreditBureauUnavailableException("unmapped acme rc=" + res.getRc());
        }

        return new CreditReport(
            Integer.parseInt(res.getFicoValue()),
            ACME_DATE.parse(res.getRptDate(), Instant::from),
            mapDelinquencies(res.getItems()));
    }

    private List<Delinquency> mapDelinquencies(AcmeItem[] items) {
        if (items == null) return List.of();       // null-array quirk absorbed here
        return Arrays.stream(items)
            .filter(i -> "DLQ".equals(i.getTypeCd()))
            .map(i -> new Delinquency(
                     i.getAcctNbrMasked(),
                     Integer.parseInt(i.getDaysLate()),
                     Money.ofCents(Long.parseLong(i.getAmtCents()))))
            .toList();
    }
}
```

Everything vendor-specific — the timezone, the `yyyyMMdd` format, the numeric string, the null array, the return-code table — is trapped in one file. Swapping to Experian means writing a second adapter, not touching the domain.

### Object adapter vs class adapter

- **Object adapter** (composition, shown above) — holds the adaptee as a field. Works in Java for any adaptee, can adapt multiple adaptees, and can adapt a whole hierarchy.
- **Class adapter** (inheritance) — `class MyThing extends VendorThing implements MyInterface`. Java's single inheritance makes this rarely possible, and it exposes the adaptee's entire API through your type, which defeats the purpose.

Always use the object adapter. The class adapter is a C++ artifact.

### `Arrays.asList` — the JDK's most instructive adapter

```java
String[] array = {"a", "b", "c"};
List<String> view = Arrays.asList(array);

view.set(0, "z");
System.out.println(array[0]);      // "z" — the adapter is a live VIEW

view.add("d");                     // UnsupportedOperationException — fixed-size adaptee
```

This is the canonical Adapter: it makes an array satisfy `List`, and it can only support the operations the adaptee can. Arrays are fixed-size, so `add`/`remove` throw. It is a view, not a copy, so writes pass through. Two bugs come from missing this:

1. `Arrays.asList(x).add(y)` — `UnsupportedOperationException` in production on a code path tests never hit.
2. `Arrays.asList(intArray)` where `intArray` is `int[]` gives `List<int[]>` of size 1, not `List<Integer>` of size N. Use `Arrays.stream(intArray).boxed().toList()`.

`List.of(...)` is different again: fully immutable, rejects nulls, and is a copy. Three similarly named things with three different contracts, which is exactly the kind of detail interviews probe.

### Adapter vs Anti-Corruption Layer

They are the same shape at different scales, and the distinction matters in architecture discussions.

| | Adapter | Anti-Corruption Layer (ACL) |
|---|---|---|
| Scope | One class / one interface | A whole bounded-context boundary |
| Translates | Method signatures and types | Domain models, identifiers, invariants, consistency semantics |
| Typical size | One file | A package: DTOs, mappers, a facade, sometimes its own persistence |
| Failure it prevents | Compile-time mismatch, vendor type leakage | The other system's *model* colonizing your domain |

Concretely: an adapter turns `AcmeResponse` into `CreditReport`. An ACL is what you build when the upstream system's notion of "customer" is a billing account with 47 fields and three overlapping status enums, and you refuse to let that shape into your ordering domain. The ACL owns a mapping table between their IDs and yours, decides which of their statuses collapse into your two, and rejects data that violates your invariants at the boundary.

The failure mode the ACL prevents is not type mismatch — it is **shared model coupling**, where a change to their status enum forces a change in your core domain logic. If you find your domain objects have fields that only exist because an upstream system has them, you needed an ACL and built a passthrough instead.

### Where it appears in the JDK and Spring

| Class | Adapts |
|---|---|
| `Arrays.asList` | `T[]` → `List<T>` (live, fixed-size view) |
| `Collections.list(Enumeration)` | Legacy `Enumeration` → `ArrayList` |
| `Collections.enumeration(Collection)` | Modern `Collection` → legacy `Enumeration` |
| `InputStreamReader` / `OutputStreamWriter` | Byte stream → character stream (the classic "bridge between two type systems") |
| `Channels.newInputStream`, `Channels.newChannel` | NIO channel ↔ IO stream |
| `Collections.newSetFromMap(Map)` | `Map<T,Boolean>` → `Set<T>` |
| `java.sql.Timestamp` ↔ `Instant` via `toInstant()` / `Timestamp.from` | Legacy date ↔ `java.time` |
| `Spliterators.spliterator(Iterator, ...)` | `Iterator` → `Spliterator` for streams |
| Spring `HandlerAdapter` (`RequestMappingHandlerAdapter`) | Arbitrary handler objects → one `handle()` contract for `DispatcherServlet` |
| Spring `MessageConverter` implementations | HTTP body bytes ↔ domain objects |
| Spring `WebMvcConfigurerAdapter` (deprecated) | Historical no-op-defaults adapter, obsoleted by interface `default` methods |
| SLF4J bindings (`slf4j-log4j12`, `jul-to-slf4j`) | One logging API → many backends |

`HandlerAdapter` is the most valuable one to understand: `DispatcherServlet` cannot know about `@RequestMapping` methods, `HttpRequestHandler`, `Controller`, or WebFlux functional routes. Each gets a `HandlerAdapter` that presents a uniform `handle(request, response, handler)` face. That is why you can mix annotation controllers and functional endpoints in one application.

The deprecation of `WebMvcConfigurerAdapter` is also worth knowing: those "Adapter" base classes existed only to provide empty method bodies so implementers did not have to override everything. Java 8 `default` methods eliminated the need, and the entire family (`WebMvcConfigurerAdapter`, `MouseAdapter`-style listeners) is a pattern made obsolete by a language feature.

### When it is the WRONG choice

- **You control both sides.** If both interfaces are yours, change one. An adapter between two of your own types is usually a sign you have two types that should be one.
- **The adapter is a straight passthrough.** `getName()` → `getName()` for fifteen methods with no translation means the interfaces already match; delete the adapter and use the type directly.
- **You are adding behavior.** Retry, caching, metrics, circuit breaking — that is Decorator. An "adapter" with a `Retry` field is misnamed and will accumulate more.
- **You need to adapt in both directions constantly.** Two-way adapters that must stay in sync are a data-model problem; consider whether one representation can be dropped.

**Over-engineering smell:** an adapter interface plus an adapter implementation plus a factory for the adapter, wrapping one vendor SDK that has exactly one implementation. Also: adapting your own DTOs to your own entities via a hand-written adapter per direction per type, when a single mapper class would do.

### Production scenario: adapter leaked the vendor's timezone

**Problem.** A lending platform's credit decisions started rejecting applicants near midnight. Roughly 1.2% of applications got "report too old, please resubmit" and the on-call engineer could not reproduce it during business hours.

**Cause.** The staleness rule was "report must be no more than 30 days old." The adapter parsed the vendor's `rptDate` field (`"20240115"`) like this:

```java
LocalDate d = LocalDate.parse(res.getRptDate(), DateTimeFormatter.BASIC_ISO_DATE);
Instant asOf = d.atStartOfDay(ZoneId.systemDefault()).toInstant();
```

The vendor's dates are in `America/Chicago`. The service ran in UTC pods. `atStartOfDay(systemDefault())` interpreted a Chicago date as a UTC date, shifting `asOf` five to six hours earlier. For a report exactly 30 days old, that shift pushed it past the boundary — but only for requests in the window where the shift crossed the day line, which is why it looked time-of-day dependent and only affected a small percentage.

The deeper problem: the adapter was returning a `LocalDate`-derived `Instant` without ever making the vendor's zone explicit, so the ambiguity was invisible at the call site.

**Solution.** Pin the zone inside the adapter, where the knowledge belongs, and make the domain type unambiguous.

```java
@Component
public class AcmeCreditBureauAdapter implements CreditBureau {

    /** Acme documents all report dates as America/Chicago business dates. */
    private static final ZoneId ACME_ZONE = ZoneId.of("America/Chicago");
    private static final DateTimeFormatter ACME_DATE = DateTimeFormatter.BASIC_ISO_DATE;

    @Override
    public CreditReport fetch(Ssn ssn) {
        AcmeResponse res = call(ssn);
        LocalDate businessDate = LocalDate.parse(res.getRptDate(), ACME_DATE);
        // End of the vendor's business day is the conservative reading of "as of".
        Instant asOf = businessDate.plusDays(1).atStartOfDay(ACME_ZONE).toInstant();
        return new CreditReport(score(res), asOf, mapDelinquencies(res.getItems()));
    }
}
```

Two supporting changes made it not recur:

```java
// 1. Staleness compared in explicit UTC against an injected Clock, never system default.
boolean stale = Duration.between(report.asOf(), clock.instant()).toDays() > 30;

// 2. A test that runs under a hostile default timezone.
@Test
void report_date_is_chicago_regardless_of_jvm_timezone() {
    TimeZone original = TimeZone.getDefault();
    try {
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Tokyo"));
        var report = adapter.fetch(new Ssn("123456789"));
        assertThat(report.asOf()).isEqualTo(
            LocalDate.of(2024, 1, 16).atStartOfDay(ZoneId.of("America/Chicago")).toInstant());
    } finally {
        TimeZone.setDefault(original);
    }
}
```

**Lesson.** An adapter's job is to absorb every representational assumption of the foreign system — timezone, encoding, null semantics, units, rounding. Any assumption it fails to absorb becomes a bug in a caller that has no way to know it exists. `ZoneId.systemDefault()` inside an adapter is almost always a defect.

---

## 8. Structural — Decorator

### The problem it solves

You need to add a behavior — caching, retry, metrics, rate limiting, encryption, auditing — to something that already implements an interface, without modifying it and without a subclass per combination.

The subclass explosion is the motivating arithmetic: with caching, retry, and metrics as independent concerns, inheritance needs `Cached`, `Retrying`, `Metered`, `CachedRetrying`, `CachedMetered`, `RetryingMetered`, `CachedRetryingMetered` — 2ⁿ classes. Decorator needs n, composed at wiring time in whatever order you want.

### Java implementation — layering a client

```java
public interface ProductCatalog {
    Optional<Product> findBySku(String sku);
}

/** The real one. Knows nothing about caching, retries, or metrics. */
@Component
class HttpProductCatalog implements ProductCatalog {
    private final RestClient http;
    HttpProductCatalog(RestClient http) { this.http = http; }

    @Override
    public Optional<Product> findBySku(String sku) {
        try {
            return Optional.ofNullable(
                http.get().uri("/products/{sku}", sku).retrieve().body(Product.class));
        } catch (HttpClientErrorException.NotFound e) {
            return Optional.empty();
        }
    }
}
```

```java
/** Decorator 1: caching. Note it delegates through the SAME interface. */
class CachingProductCatalog implements ProductCatalog {

    private final ProductCatalog delegate;
    private final Cache<String, Optional<Product>> cache;

    CachingProductCatalog(ProductCatalog delegate, Duration ttl, int maxSize) {
        this.delegate = delegate;
        this.cache = Caffeine.newBuilder()
            .maximumSize(maxSize)
            .expireAfterWrite(ttl)
            .build();
    }

    @Override
    public Optional<Product> findBySku(String sku) {
        return cache.get(sku, delegate::findBySku);
    }
}

/** Decorator 2: retry with backoff on transient failures only. */
class RetryingProductCatalog implements ProductCatalog {

    private final ProductCatalog delegate;
    private final int maxAttempts;
    private final Duration backoff;

    RetryingProductCatalog(ProductCatalog delegate, int maxAttempts, Duration backoff) {
        this.delegate = delegate;
        this.maxAttempts = maxAttempts;
        this.backoff = backoff;
    }

    @Override
    public Optional<Product> findBySku(String sku) {
        RuntimeException last = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return delegate.findBySku(sku);
            } catch (HttpServerErrorException | ResourceAccessException e) {
                last = e;
                if (attempt < maxAttempts) sleep(backoff.multipliedBy(1L << (attempt - 1)));
            }
        }
        throw new CatalogUnavailableException("after " + maxAttempts + " attempts", last);
    }

    private static void sleep(Duration d) {
        try { Thread.sleep(d.toMillis()); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new CancellationException(); }
    }
}

/** Decorator 3: metrics. */
class MeteredProductCatalog implements ProductCatalog {

    private final ProductCatalog delegate;
    private final Timer timer;
    private final Counter misses;

    MeteredProductCatalog(ProductCatalog delegate, MeterRegistry registry) {
        this.delegate = delegate;
        this.timer = registry.timer("catalog.findBySku");
        this.misses = registry.counter("catalog.findBySku.miss");
    }

    @Override
    public Optional<Product> findBySku(String sku) {
        return timer.record(() -> {
            var result = delegate.findBySku(sku);
            if (result.isEmpty()) misses.increment();
            return result;
        });
    }
}
```

Wiring, where the order becomes an explicit architectural decision:

```java
@Configuration
class CatalogConfig {

    @Bean
    @Primary
    ProductCatalog productCatalog(HttpProductCatalog http, MeterRegistry registry) {
        ProductCatalog stack = http;
        stack = new RetryingProductCatalog(stack, 3, Duration.ofMillis(100)); // innermost wrap
        stack = new MeteredProductCatalog(stack, registry);
        stack = new CachingProductCatalog(stack, Duration.ofMinutes(5), 10_000);
        return stack;   // call order: caching → metrics → retry → http
    }
}
```

### Ordering matters, and it is not a style preference

Read the wiring outside-in: the outermost decorator sees the call first.

```
caching → metrics → retry → http     (as wired above)
```

| Order | Consequence |
|---|---|
| Cache **outside** retry | Cache hits skip retry entirely. Retry only fires on real upstream calls. Correct. |
| Cache **inside** retry | Every retry attempt hits the cache, which will return the same failure-free cached value or the same miss. Retry becomes useless for cache hits and re-queries the cache pointlessly. |
| Metrics **outside** cache | Timer measures cache hits (microseconds), so p99 looks great and upstream latency is invisible. Usually wrong for SLO monitoring. |
| Metrics **inside** cache, outside retry | Timer measures the total cost of one logical upstream fetch including retries. Usually what you want. |
| Metrics **inside** retry | Timer records per-attempt latency; a 3-attempt failure appears as three fast calls, hiding the 2 s user-visible latency. |
| Retry **outside** circuit breaker | Retries hammer a breaker that is trying to shed load; breaker opens and retries burn attempts on `CallNotPermittedException`. |
| Circuit breaker **outside** retry | Breaker sees the aggregate outcome of a logical call. This is the Resilience4j documented ordering. |

The general rule: **cheap-and-short-circuiting outermost, expensive-and-upstream innermost**, with observability placed where it measures the thing you promised in your SLO. Write the resulting call order in a comment at the wiring site, because it is not recoverable from reading any single class.

### Decorator vs Spring AOP proxy

Spring AOP does the same thing generatively.

```java
@Component
class AopProductCatalog implements ProductCatalog { ... }

@Aspect
@Component
class CatalogMetricsAspect {
    @Around("execution(* com.acme.catalog.ProductCatalog.*(..))")
    Object time(ProceedingJoinPoint pjp) throws Throwable { ... }
}
```

| | Hand-written Decorator | Spring AOP / annotations |
|---|---|---|
| Visibility | Explicit in wiring code; stack trace shows each class | Invisible at the call site; stack traces show `$Proxy` / CGLIB frames |
| Ordering | You write it, in one place | `@Order` on advisors, defaults are subtle, and `@Cacheable` vs `@Transactional` order is a classic bug |
| Per-method control | Trivially different behavior per method | Pointcut expressions, easy to over-match |
| Self-invocation | Works — it is a real object | **Broken** — internal calls bypass the proxy |
| Cross-cutting scale | Tedious for 40 classes | The right tool for 40 classes |
| Testability | Instantiate and pass a fake delegate | Needs a Spring context to exercise the advice |

Rule of thumb: **AOP for truly cross-cutting concerns applied broadly** (transactions, security, tracing). **Hand-written decorators for one important collaborator** where the behavior is part of the design and the ordering is load-bearing. `@Cacheable` on one method with a custom key generator and a conditional is usually clearer as a `CachingXxx` class.

### Where it appears in the JDK and Spring

| Class | Decorates |
|---|---|
| `BufferedInputStream`, `BufferedReader` | Adds buffering to any stream/reader |
| `GZIPOutputStream`, `DeflaterOutputStream`, `CipherOutputStream` | Adds compression / encryption |
| `DataInputStream`, `ObjectOutputStream` | Adds typed read/write |
| `PushbackInputStream`, `LineNumberReader` | Adds unread / line tracking |
| `Collections.unmodifiableList/Map/Set` | Adds immutability enforcement to any collection |
| `Collections.synchronizedList/Map` | Adds locking |
| `Collections.checkedList` | Adds runtime type checking |
| `HttpServletRequestWrapper`, `HttpServletResponseWrapper` | Servlet-level decoration (the basis of most custom filters) |
| Spring `TransactionAwareDataSourceProxy`, `LazyConnectionDataSourceProxy` | Decorate a `DataSource` |
| Spring `DelegatingFilterProxy` | Decorates a bean as a servlet `Filter` |
| Micrometer `TimedExecutorService`, `ExecutorServiceMetrics` | Decorate an executor |
| Resilience4j `Decorators.ofSupplier(...).withRetry(...).withCircuitBreaker(...)` | Explicit functional decorator chain |

The `java.io` chain is worth writing out because it is the pattern's clearest illustration and a frequent interview prompt:

```java
try (var in = new BufferedInputStream(
                  new GZIPInputStream(
                      new FileInputStream(path.toFile())), 64 * 1024)) {
    ...
}
```

Each layer implements `InputStream`, holds an `InputStream`, and adds exactly one concern. Order matters here too: `new GZIPInputStream(new BufferedInputStream(fis))` buffers the *compressed* bytes, which is usually what you want for a slow disk; `new BufferedInputStream(new GZIPInputStream(fis))` buffers the *decompressed* bytes, which reduces the per-call overhead of many small reads. Both are legal, and they have measurably different performance.

### When it is the WRONG choice

- **The concern belongs in the object.** Validation is not a decorator; it is the object's invariant.
- **Many layers, each trivial.** Six decorators on one interface means a `findBySku` stack trace is 40 frames deep and nobody can answer "what actually happens on a call."
- **The decorator needs to know the delegate's concrete type.** If `CachingProductCatalog` casts the delegate to `HttpProductCatalog` to read a field, the abstraction is broken; the concern belongs inside.
- **Interface has 20 methods and you decorate one.** You now write 19 passthrough methods, and every interface change breaks every decorator. Either shrink the interface or use AOP.
- **State must be shared across layers.** Decorators are independent by design; threading state through them recreates a god object with extra steps.

**Over-engineering smell:** a `LoggingXxxDecorator` for every interface in the codebase. That is what tracing instrumentation and `@Observed` are for, and hand-rolled logging decorators produce log lines with no correlation ID and no sampling.

### Production scenario: cache wrapped inside retry, plus a cached failure

**Problem.** During a 40-second upstream catalog outage, a product service returned "product not found" for a top-selling SKU — and kept returning it for the next five minutes **after** the upstream recovered. Sales for that SKU dropped to zero for six minutes. Retries and caching were both "configured correctly" according to the config review.

**Cause.** Two ordering mistakes in one wiring block.

```java
// The broken wiring
ProductCatalog stack = http;
stack = new CachingProductCatalog(stack, Duration.ofMinutes(5), 10_000);
stack = new RetryingProductCatalog(stack, 3, Duration.ofMillis(100));
// call order: retry → caching → http
```

First, retry was **outside** the cache, so all three attempts went through the cache. Second, and worse, `CachingProductCatalog` cached `Optional<Product>` including `Optional.empty()`. During the outage, `HttpProductCatalog` translated an upstream 503 into... nothing useful: an earlier developer had widened its `catch` to `HttpStatusCodeException` and returned `Optional.empty()` for any error status. So the outage produced an empty `Optional`, which was cached for five minutes as a negative result, and retry — sitting outside the cache — happily re-read that cached emptiness on attempts two and three without ever touching upstream.

**Solution.** Three fixes, in order of importance.

```java
// 1. Never turn a server error into an empty result. Only 404 means "absent".
@Override
public Optional<Product> findBySku(String sku) {
    try {
        return Optional.ofNullable(
            http.get().uri("/products/{sku}", sku).retrieve().body(Product.class));
    } catch (HttpClientErrorException.NotFound e) {
        return Optional.empty();                        // genuinely absent
    } catch (HttpStatusCodeException | ResourceAccessException e) {
        throw new CatalogUnavailableException(sku, e);   // transient — must not be cached
    }
}
```

```java
// 2. Cache only successful lookups; give negative results a short, separate TTL.
class CachingProductCatalog implements ProductCatalog {

    private final ProductCatalog delegate;
    private final Cache<String, Product> present;
    private final Cache<String, Boolean> absent;   // negative cache, deliberately short

    CachingProductCatalog(ProductCatalog delegate) {
        this.delegate = delegate;
        this.present = Caffeine.newBuilder()
            .maximumSize(10_000).expireAfterWrite(Duration.ofMinutes(5)).build();
        this.absent = Caffeine.newBuilder()
            .maximumSize(10_000).expireAfterWrite(Duration.ofSeconds(20)).build();
    }

    @Override
    public Optional<Product> findBySku(String sku) {
        Product hit = present.getIfPresent(sku);
        if (hit != null) return Optional.of(hit);
        if (Boolean.TRUE.equals(absent.getIfPresent(sku))) return Optional.empty();

        // An exception here propagates and caches nothing. That is the whole point.
        Optional<Product> result = delegate.findBySku(sku);
        result.ifPresentOrElse(p -> present.put(sku, p), () -> absent.put(sku, true));
        return result;
    }
}
```

```java
// 3. Correct order, documented at the wiring site.
@Bean
@Primary
ProductCatalog productCatalog(HttpProductCatalog http, MeterRegistry registry, CircuitBreaker cb) {
    // Call order (outermost first): cache → breaker → metrics → retry → http
    //   cache outermost   : hits cost nothing and skip all resilience machinery
    //   breaker next      : sheds load before retries can amplify an outage
    //   metrics next      : measures one logical fetch including its retries
    //   retry innermost   : only retries real upstream calls
    ProductCatalog stack = http;
    stack = new RetryingProductCatalog(stack, 3, Duration.ofMillis(100));
    stack = new MeteredProductCatalog(stack, registry);
    stack = new CircuitBreakingProductCatalog(stack, cb);
    stack = new CachingProductCatalog(stack);
    return stack;
}
```

A regression test pinned the behavior that actually mattered:

```java
@Test
void upstream_outage_is_not_cached_as_absent() {
    upstream.failWith(HttpStatus.SERVICE_UNAVAILABLE);
    assertThatThrownBy(() -> catalog.findBySku("SKU-1"))
        .isInstanceOf(CatalogUnavailableException.class);

    upstream.respondWith(product("SKU-1"));
    assertThat(catalog.findBySku("SKU-1")).isPresent();   // recovers immediately
}
```

**Lesson.** Decorator ordering is behavior, not configuration style. And a cache decorator must know the difference between "the answer is no" and "I could not get an answer" — collapsing those two into `Optional.empty()` guarantees that some outage will be cached as a business fact.

---

## 9. Structural — Proxy

### The problem it solves

You need to control **access** to an object while presenting its exact interface. Three classic variants, all present in real backends:

| Variant | Purpose | Real example |
|---|---|---|
| **Virtual proxy** | Defer expensive creation/loading until first use | Hibernate lazy `@ManyToOne` |
| **Protection proxy** | Enforce authorization before delegating | Spring Security `@PreAuthorize` interceptor |
| **Remote proxy** | Make a network call look like a local method call | Feign client, RMI stub, gRPC stub |
| **Smart reference / caching proxy** | Add reference counting, caching, transaction binding | `@Transactional` proxy, `@Cacheable` proxy |

Proxy versus Decorator is a standard question. Structurally they are identical: same interface, holds a delegate. The distinction is **intent and lifecycle ownership**:

- A **Decorator** is given a delegate and adds behavior to it. The caller composes the stack deliberately, and typically several decorators stack.
- A **Proxy** controls access to a subject it may create, lazily load, or refuse to call at all. It usually stands alone, and its existence is often invisible to the caller.

If the wrapper can decide **not to call** the delegate (authorization denied, cache hit, circuit open) or is responsible for **creating** it, "proxy" is the better word.

### JDK dynamic proxy

Works only for **interfaces**. Generates a class implementing the given interfaces and routes every call through one `InvocationHandler`.

```java
public final class AuditingProxy {

    @SuppressWarnings("unchecked")
    public static <T> T wrap(Class<T> iface, T target, AuditLog audit) {
        return (T) Proxy.newProxyInstance(
            iface.getClassLoader(),
            new Class<?>[]{iface},
            (proxy, method, args) -> {
                // Object methods must be handled or you get surprising behavior.
                if (method.getDeclaringClass() == Object.class) {
                    return method.invoke(target, args);
                }
                long start = System.nanoTime();
                try {
                    Object result = method.invoke(target, args);
                    audit.success(iface, method.getName(), Duration.ofNanos(System.nanoTime() - start));
                    return result;
                } catch (InvocationTargetException e) {
                    // Unwrap: otherwise callers see InvocationTargetException, not their exception.
                    audit.failure(iface, method.getName(), e.getTargetException());
                    throw e.getTargetException();
                }
            });
    }
}

ProductCatalog audited = AuditingProxy.wrap(ProductCatalog.class, realCatalog, auditLog);
```

Two details that separate working code from an interview answer: unwrapping `InvocationTargetException` (otherwise every exception from the target is wrapped, breaking `catch` clauses and `@Transactional` rollback rules) and handling `Object` methods (an unhandled `hashCode()` recursing into the handler is a classic infinite loop).

### CGLIB / bytecode subclass proxy

Works on **classes** by generating a subclass and overriding methods. Spring uses it when there is no interface, or when `proxyTargetClass = true`.

```java
public final class LoggingCglibProxy {

    @SuppressWarnings("unchecked")
    public static <T> T wrap(Class<T> type, Object... ctorArgs) {
        Enhancer enhancer = new Enhancer();
        enhancer.setSuperclass(type);
        enhancer.setCallback((MethodInterceptor) (obj, method, args, methodProxy) -> {
            if (Modifier.isFinal(method.getModifiers())) {
                return methodProxy.invokeSuper(obj, args);  // cannot intercept anyway
            }
            log.debug("enter {}", method.getName());
            try {
                return methodProxy.invokeSuper(obj, args);   // NOT method.invoke — no target instance
            } finally {
                log.debug("exit {}", method.getName());
            }
        });
        return (T) enhancer.create(ctorArgTypes(ctorArgs), ctorArgs);
    }
}
```

The constraints are the interesting part, because they cause real Spring bugs:

| Constraint | Consequence in Spring |
|---|---|
| `final` classes cannot be subclassed | `@Transactional` on a `final` class silently does nothing (or fails at startup in newer versions) |
| `final` methods cannot be overridden | `@Transactional` / `@Cacheable` / `@PreAuthorize` on a `final` method is ignored, no warning |
| `private` methods are not intercepted | Same silent no-op |
| `static` methods are not intercepted | Same |
| Subclass constructor runs | Spring uses Objenesis to skip it, so field initializers may not behave as you expect in the proxy instance |
| Proxy is a different class | `getClass()` returns `Foo$$SpringCGLIB$$0`; `getClass().getAnnotation(...)` can miss annotations. Use `AopUtils.getTargetClass(bean)` / `AnnotationUtils.findAnnotation` |
| Fields are **not** copied to the proxy | Reading a field directly off an injected bean reference reads the proxy's null field, not the target's. Always go through methods. |

Java 17+ adds a modern option: `java.lang.invoke` and records make some proxying unnecessary, and for interface proxies `MethodHandles` is faster than reflection. But in Spring, the CGLIB/JDK-proxy distinction is still the thing you must reason about.

### How `@Transactional` actually works

The chain, precisely, because "Spring magic" is not an acceptable answer:

1. `@EnableTransactionManagement` (auto-configured by Boot) registers `InfrastructureAdvisorAutoProxyCreator`, a `BeanPostProcessor`.
2. At bean creation, that post-processor asks each `PointcutAdvisor` whether it applies. `BeanFactoryTransactionAttributeSourceAdvisor` uses `TransactionAttributeSourcePointcut`, which consults `AnnotationTransactionAttributeSource` to look for `@Transactional` on the class or its methods.
3. If it matches, `ProxyFactory` creates a proxy: **JDK dynamic proxy** if the bean implements interfaces and `proxyTargetClass=false`, otherwise **CGLIB**. Spring Boot defaults `spring.aop.proxy-target-class=true`, so CGLIB is the common case.
4. The proxy's method interceptor is `TransactionInterceptor`. On invocation it resolves the `TransactionAttribute` (propagation, isolation, timeout, readOnly, rollbackFor), calls `PlatformTransactionManager.getTransaction(...)`, invokes the target, then commits or rolls back.
5. `DataSourceTransactionManager` binds the `Connection` to the thread via `TransactionSynchronizationManager`. `DataSourceUtils.getConnection(dataSource)` — which `JdbcTemplate` and Hibernate use — returns that bound connection, which is how "everything in the method joins the same transaction" works.
6. Rollback rules: by default, rollback on `RuntimeException` and `Error`; **commit** on checked exceptions. This surprises people every year.

```java
@Service
public class OrderService {

    @Transactional
    public void place(Order order) {
        orders.save(order);
        inventory.reserve(order);   // if this throws IOException (checked) → COMMIT
    }

    @Transactional(rollbackFor = Exception.class)   // explicit when checked exceptions matter
    public void placeStrict(Order order) throws InventoryException { ... }
}
```

### The self-invocation trap

```java
@Service
public class ReportService {

    @Transactional
    public void generateAll(List<Long> ids) {
        for (Long id : ids) {
            generateOne(id);          // ← plain `this` call. Proxy is NOT involved.
        }
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void generateOne(Long id) { ... }   // REQUIRES_NEW never happens
}
```

The caller holds the **proxy**; inside `generateAll`, `this` is the **target**. A `this.generateOne(...)` call goes straight to the target method, so the interceptor never runs and `REQUIRES_NEW` is ignored — all work happens in the outer transaction. One failure rolls back everything, which is the opposite of the intent.

The same trap applies to `@Cacheable`, `@Async`, `@PreAuthorize`, `@Retryable`, and every other proxy-based annotation. Symptoms: "`@Async` runs synchronously," "`@Cacheable` never caches," "`@PreAuthorize` never denies."

Fixes, best first:

```java
// 1. BEST — move the inner method to another bean. The seam becomes a real object boundary.
@Service
public class ReportService {
    private final SingleReportService single;
    ReportService(SingleReportService single) { this.single = single; }

    public void generateAll(List<Long> ids) { ids.forEach(single::generateOne); }
}

@Service
public class SingleReportService {
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void generateOne(Long id) { ... }
}
```

```java
// 2. ACCEPTABLE — TransactionTemplate. Explicit, no proxy involved, no self-reference.
@Service
public class ReportService {
    private final TransactionTemplate newTx;

    ReportService(PlatformTransactionManager tm) {
        this.newTx = new TransactionTemplate(tm);
        this.newTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    public void generateAll(List<Long> ids) {
        for (Long id : ids) {
            newTx.executeWithoutResult(status -> generateOne(id));
        }
    }
}
```

```java
// 3. LAST RESORT — self-injection. Works, but hides the design smell.
@Service
public class ReportService {
    @Lazy private final ReportService self;   // @Lazy avoids the circular-reference failure
    ReportService(@Lazy ReportService self) { this.self = self; }

    public void generateAll(List<Long> ids) { ids.forEach(self::generateOne); }
}
```

`AopContext.currentProxy()` also works but requires `exposeProxy=true` and couples your business code to Spring AOP internals. Avoid.

### Where it appears in the JDK and Spring

| Class | Variant |
|---|---|
| `java.lang.reflect.Proxy` | The JDK's dynamic proxy machinery |
| RMI stubs, `java.rmi` | Remote proxy — the original motivating example |
| `Collections.unmodifiableX` | Protection proxy (also readable as Decorator) |
| Hibernate `@ManyToOne(fetch = LAZY)` fields | Virtual proxy (bytecode-enhanced or `HibernateProxy`) |
| `Session.getReference()` / old `load()` | Returns a virtual proxy; `find()`/`get()` hits the DB |
| Spring `@Transactional`, `@Cacheable`, `@Async`, `@Retryable` | Smart-reference proxies via `BeanPostProcessor` |
| Spring `@Scope("request")` / `@Scope("session")` beans | Scoped proxy so a singleton can hold a request-scoped reference |
| Spring Data `@Repository` interfaces | JDK dynamic proxy over `SimpleJpaRepository` + query derivation |
| Spring Cloud OpenFeign `@FeignClient` | Remote proxy generated from an interface |
| Mockito mocks | Bytecode proxies (ByteBuddy) |
| `DelegatingFilterProxy`, `ScopedProxyFactoryBean` | Framework proxies |

Hibernate's virtual proxy is the source of the most common Java persistence error. `order.getCustomer()` returns a proxy; touching `getCustomer().getName()` after the session closed throws `LazyInitializationException`. The proxy is also why `order.getCustomer().getClass() != Customer.class` and why `instanceof` checks and `equals()` implementations that compare `getClass()` break on proxied entities — use `Hibernate.unproxy(...)` or compare with `instanceof`.

### When it is the WRONG choice

- **You want to add behavior the caller should see.** That is Decorator, and calling it a proxy hides the composition.
- **The interception is silent and load-bearing.** Proxy-based magic that is essential for correctness (transaction boundaries in the wrong place) becomes undebuggable. Explicit `TransactionTemplate` at critical boundaries is sometimes better.
- **Hot path, tight loop.** Reflection-based interception has real cost. A dynamic proxy in a method called ten million times per request is measurable.
- **The proxied thing needs field access.** Proxies intercept methods, not fields.

**Over-engineering smell:** hand-rolling a dynamic proxy for something an `@Aspect` or a plain decorator would do in ten readable lines. Also: a custom annotation + `BeanPostProcessor` + `InvocationHandler` stack for a concern used by exactly one class.

### Production scenario: `@Transactional` silently disabled by `final`

**Problem.** After a Kotlin-to-Java-style "cleanup" PR that added `final` to classes for immutability hygiene, an order-placement endpoint began leaving orphaned rows: an `orders` row with no `order_lines`, or lines with no payment record. No errors in logs. The bug appeared only when a downstream validation threw, roughly 0.3% of requests.

**Cause.** The PR made `OrderService` `final`:

```java
@Service
public final class OrderService {          // ← CGLIB cannot subclass this
    @Transactional
    public void place(Order order) { ... }
}
```

Spring Boot defaults to `proxyTargetClass=true` (CGLIB). `OrderService` had no interface, so CGLIB was the only option, and CGLIB cannot subclass a `final` class. Depending on the exact Spring version, this either fails loudly at startup or — in the version they ran, with a lenient auto-proxy configuration — the bean was registered **unproxied**. `@Transactional` became a no-op annotation. Every write auto-committed independently, so a failure halfway through left partial data. Integration tests used `@DataJpaTest` with its own transaction wrapping each test, which rolled everything back and hid the missing boundary completely.

**Solution.**

```java
@Service
public class OrderService {               // not final — proxyable

    @Transactional
    public void place(Order order) { ... }
}
```

And, more importantly, a test that fails when a transaction boundary disappears:

```java
@SpringBootTest
class TransactionalProxyTest {

    @Autowired ApplicationContext ctx;

    @Test
    void every_transactional_bean_is_actually_proxied() {
        var offenders = Arrays.stream(ctx.getBeanDefinitionNames())
            .map(ctx::getBean)
            .filter(b -> hasTransactionalMethod(AopUtils.getTargetClass(b)))
            .filter(b -> !AopUtils.isAopProxy(b))
            .map(b -> AopUtils.getTargetClass(b).getName())
            .toList();
        assertThat(offenders)
            .as("beans with @Transactional but no proxy (final class? final method?)")
            .isEmpty();
    }

    @Test
    void no_transactional_method_is_final_or_private() {
        // ArchUnit equivalent, catches the failure at its root
        methods().that().areAnnotatedWith(Transactional.class)
            .should().notBeFinal().andShould().bePublic()
            .check(new ClassFileImporter().importPackages("com.acme"));
    }
}
```

Plus a real rollback test that does **not** rely on the test framework's own transaction:

```java
@SpringBootTest
@Transactional(propagation = Propagation.NOT_SUPPORTED)   // do not wrap the test
class OrderRollbackTest {

    @Test
    void failed_placement_leaves_no_partial_data() {
        assertThatThrownBy(() -> orderService.place(orderThatFailsValidation()))
            .isInstanceOf(ValidationException.class);
        assertThat(jdbc.queryForObject("select count(*) from orders", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from order_lines", Integer.class)).isZero();
    }
}
```

**Lesson.** Proxy-based behavior is invisible when it fails. `final` classes, `final` methods, `private` methods, and self-invocation all disable it silently. Any codebase relying on `@Transactional` needs a structural test that the proxies exist, and at least one rollback test that runs outside the test framework's own transaction.

---

## 10. Structural — Facade

### The problem it solves

A subsystem has ten collaborators and a required call sequence. Every caller that reimplements that sequence is a chance to get it wrong — forget the idempotency check, skip the audit event, call the tax service before applying the discount.

Facade provides one coarse-grained entry point that encodes the correct sequence, so callers state intent rather than steps.

### Java implementation — a checkout facade

```java
/** The subsystem: seven collaborators, each with a narrow job. */
@Service
public class CheckoutFacade {

    private final CartRepository carts;
    private final InventoryService inventory;
    private final PricingService pricing;
    private final TaxService tax;
    private final PaymentGateways gateways;
    private final OrderRepository orders;
    private final ApplicationEventPublisher events;
    private final IdempotencyStore idempotency;

    // constructor omitted

    @Transactional
    public CheckoutResult checkout(CheckoutCommand command) {

        // 1. Idempotency first — a retried request must not double-charge.
        Optional<CheckoutResult> replay = idempotency.find(command.idempotencyKey());
        if (replay.isPresent()) return replay.get();

        Cart cart = carts.findActive(command.customerId())
            .orElseThrow(() -> new EmptyCartException(command.customerId()));

        // 2. Reserve before charging. Reversing these means charging for unavailable stock.
        Reservation reservation = inventory.reserve(cart.lines());

        try {
            // 3. Price, then tax on the priced total. Order matters for compliance.
            PricedCart priced = pricing.price(cart, command.promotionCode());
            TaxedCart taxed = tax.apply(priced, command.shipTo());

            // 4. Charge.
            Authorization auth = gateways.forMethod(command.paymentMethod())
                .authorize(new PaymentRequest(taxed.total(), command.paymentToken(),
                                              command.idempotencyKey()));

            // 5. Persist, confirm the reservation, publish.
            Order order = orders.save(Order.from(taxed, auth, reservation));
            inventory.confirm(reservation);
            events.publishEvent(new OrderPlaced(order.id(), order.total(), Instant.now()));

            CheckoutResult result = CheckoutResult.success(order.id(), auth.reference());
            idempotency.record(command.idempotencyKey(), result);
            return result;

        } catch (PaymentDeclinedException e) {
            inventory.release(reservation);     // compensation, not left to the caller
            events.publishEvent(new CheckoutDeclined(command.customerId(), e.reason()));
            return CheckoutResult.declined(e.reason());
        } catch (RuntimeException e) {
            inventory.release(reservation);
            throw e;
        }
    }
}
```

The controller becomes trivial, which is the goal:

```java
@PostMapping("/checkout")
CheckoutResponse checkout(@Valid @RequestBody CheckoutRequest body,
                          @RequestHeader("Idempotency-Key") String key,
                          @AuthenticationPrincipal AppUser user) {
    return CheckoutResponse.from(facade.checkout(body.toCommand(user.id(), key)));
}
```

The facade encodes four things that were previously tribal knowledge: idempotency before anything else, reserve before charge, price before tax, and release the reservation on every failure path. Each of those was a production incident before the facade existed.

Two properties make it a facade rather than a god object: it **delegates all real work** — no pricing arithmetic, no SQL, no HTTP — and the subsystem remains **directly usable** for callers with different needs (a back-office tool can still call `pricing.price(...)` alone).

### Facade in a layered architecture

The service layer is often described as a facade over the domain. That is accurate as long as the facade stays an orchestrator. The distinction that matters:

```java
// Facade: orchestration only. Every line is a delegation or a control-flow decision.
@Transactional
public void cancel(OrderId id, CancellationReason reason) {
    Order order = orders.findById(id).orElseThrow();
    order.cancel(reason);                        // ← business rule lives in the domain object
    refunds.issue(order.payment(), order.total());
    events.publishEvent(new OrderCancelled(id, reason));
}

// God object: the facade grew business rules.
@Transactional
public void cancel(OrderId id, CancellationReason reason) {
    Order order = orders.findById(id).orElseThrow();
    if (order.getStatus() == SHIPPED && Duration.between(order.getShippedAt(), now).toDays() > 30) {
        throw new TooLateToCancelException();     // ← rule that belongs in Order
    }
    if (order.getStatus() == CANCELLED) return;
    order.setStatus(CANCELLED);                   // ← anemic domain model
    order.setCancelledAt(now);
    BigDecimal refund = order.getTotal();
    if (reason == CUSTOMER_CHANGED_MIND) {
        refund = refund.subtract(order.getShippingCost());   // ← more rules
    }
    ...
}
```

The second version cannot be unit-tested without mocking five collaborators, and the cancellation rules cannot be reused by the batch job that cancels abandoned orders.

### Where it appears in the JDK and Spring

| Class | Subsystem it fronts |
|---|---|
| `java.nio.file.Files` | Static facade over `FileSystem`, `Path`, `FileSystemProvider`, channels, attribute views |
| `java.util.Collections` | Facade over wrapper/algorithm implementations |
| `javax.crypto.Cipher` | Facade over JCA providers, key handling, transformations |
| `java.net.http.HttpClient` | Facade over connection pooling, HTTP/2 framing, redirects |
| `ExecutorService` / `Executors` | Facade over thread pools, queues, rejection policies |
| Spring `JdbcTemplate` | Facade over `Connection`, `PreparedStatement`, `ResultSet`, exception translation |
| Spring `JmsTemplate`, `RestTemplate`, `RedisTemplate` | Same shape, different subsystem |
| Spring `TransactionTemplate` | Facade over `PlatformTransactionManager` |
| Spring Security `SecurityContextHolder` | Facade over context storage strategy (also a Singleton smell) |
| SLF4J `LoggerFactory` | Facade over logging backends — the "facade" is in the project's name |

`Files` is the best study: `Files.readString(path)` replaces roughly fifteen lines of channel/charset/exception handling, and the underlying API is still there for the 1% of callers who need it. That is a correct facade — convenient default, escape hatch preserved.

### When it becomes a god class

Warning signs, in order of appearance:

1. **More than ~7 injected collaborators.** Not a hard rule, but a reliable trigger to look closer.
2. **Methods that share no collaborators.** If `checkout()` uses fields A–D and `exportTaxReport()` uses E–G, those are two facades wearing one class name.
3. **Business rules inside the facade.** `if (order.getStatus() == SHIPPED && ...)` belongs in `Order`.
4. **The name is generic.** `OrderService`, `BusinessManager`, `AppFacade` — a name that cannot be wrong is a name that cannot constrain growth.
5. **Every feature adds a method.** A facade should stabilize. A file that grows every sprint is a dumping ground.
6. **Tests need more than ~5 mocks.** The mock count is the coupling count.

The refactor is almost always **split by use case**, not by entity: `Checkout`, `OrderCancellation`, `OrderRefund`, `OrderExport` — each with two or three collaborators. This is the same move as CQRS-style command handlers, without needing the acronym.

### When it is the WRONG choice

- **The subsystem already has one obvious entry point.** Wrapping `PaymentGateway` in `PaymentFacade` that forwards one method is noise.
- **Callers legitimately need fine-grained control.** A facade that hides too much forces callers to bypass it, and then you have two APIs.
- **It becomes the only way in.** If the underlying components are made package-private to "force" facade use, the next requirement that needs 90% of the sequence has to either copy it or add a boolean parameter. Boolean parameters on facade methods (`checkout(cmd, skipTax)`) are the visible symptom.
- **You are using it to avoid fixing a bad subsystem.** A facade over a mess is still a mess, now with one more layer of indirection when you debug it.

**Over-engineering smell:** an interface + implementation pair for a facade with one implementation, injected everywhere as `ICheckoutFacade`. Also: a facade per entity created reflexively, so `CustomerFacade` has one method that calls `customerRepository.findById`.

### Production scenario: facade grew to 23 dependencies and blocked a release

**Problem.** `OrderService` had 23 constructor parameters and 1,900 lines. Two teams needed to change it in the same sprint; every PR conflicted. A merge resolved wrongly and shipped a version where cancellation skipped the refund call, producing 380 cancelled-but-not-refunded orders and a chargeback wave three weeks later.

**Cause.** The class started as a legitimate checkout facade with five collaborators. Over two years, every order-adjacent feature added a method and a dependency: cancellations, refunds, returns, gift wrapping, tax export, subscription renewal, fraud review, warehouse sync. Nothing in the codebase's structure objected. The 23 dependencies also meant the test class had 23 `@Mock` fields and ~4,000 lines, so nobody read the tests closely enough to notice cancellation's refund assertion had been deleted in the merge.

**Solution.** Split by use case. Each new class has the collaborators it actually needs, and the shared invariants moved into the `Order` aggregate where every path must pass through them.

```java
// Before: one class, 23 dependencies.
// After: use-case classes, 2-4 dependencies each.

@Service
public class PlaceOrder {
    private final CartRepository carts;
    private final InventoryService inventory;
    private final CheckoutPricing pricing;
    private final PaymentGateways gateways;
    private final OrderRepository orders;
    private final ApplicationEventPublisher events;

    @Transactional
    public OrderId handle(PlaceOrderCommand cmd) { ... }
}

@Service
public class CancelOrder {
    private final OrderRepository orders;
    private final RefundService refunds;
    private final ApplicationEventPublisher events;

    @Transactional
    public void handle(CancelOrderCommand cmd) {
        Order order = orders.findById(cmd.orderId()).orElseThrow(OrderNotFound::new);
        RefundInstruction instruction = order.cancel(cmd.reason(), cmd.requestedBy());
        refunds.issue(instruction);        // domain decides the amount; service performs the call
        events.publishEvent(new OrderCancelled(order.id(), cmd.reason()));
    }
}

@Service
public class ExportTaxLedger {
    private final OrderRepository orders;
    private final TaxLedgerWriter writer;

    public void handle(YearMonth period) { ... }
}
```

The load-bearing part is `order.cancel(...)` returning a `RefundInstruction`. The domain object now owns "what refund does a cancellation produce," so the batch job that cancels abandoned orders gets the identical rule for free, and a unit test on `Order` covers it with no mocks:

```java
@Test
void cancelling_a_shipped_order_refunds_goods_but_not_shipping() {
    Order order = shippedOrder(Money.eur(100), Money.eur(9));
    RefundInstruction refund = order.cancel(CUSTOMER_CHANGED_MIND, csr());
    assertThat(refund.amount()).isEqualTo(Money.eur(100));
    assertThat(order.status()).isEqualTo(CANCELLED);
}
```

An ArchUnit rule made the regression structurally hard:

```java
@Test
void application_services_stay_small() {
    classes().that().resideInAPackage("..application..")
        .should(haveAtMostConstructorParameters(6))
        .check(new ClassFileImporter().importPackages("com.acme"));
}
```

**Lesson.** A facade is a legitimate pattern with a specific failure mode: it has no natural size limit, and nothing about adding one more method feels wrong at the time. Put a mechanical limit on it (dependency count, or a use-case-per-class convention) and split by use case rather than by entity.

---

## 11. Structural — Composite

### The problem it solves

You have a part-whole hierarchy and want to treat a single item and a group of items identically. Without Composite, every caller writes `if (node instanceof Group) { recurse } else { handle }`, and that check spreads to every operation.

The real backends where this shows up: permission trees, organizational hierarchies, category taxonomies, bill-of-materials, menu structures, and composite validation or filter rules.

### Java implementation — permission tree

```java
public sealed interface Permission permits Grant, PermissionGroup {

    String name();

    /** The uniform operation. Leaf and composite answer the same question. */
    boolean allows(Action action, Resource resource);

    /** Uniform traversal for auditing / UI rendering. */
    Stream<Permission> flatten();
}

public record Grant(String name, Action action, ResourcePattern pattern) implements Permission {

    @Override
    public boolean allows(Action action, Resource resource) {
        return this.action == action && pattern.matches(resource);
    }

    @Override
    public Stream<Permission> flatten() { return Stream.of(this); }
}

public record PermissionGroup(String name, List<Permission> children) implements Permission {

    public PermissionGroup {
        children = List.copyOf(children);
    }

    @Override
    public boolean allows(Action action, Resource resource) {
        return children.stream().anyMatch(c -> c.allows(action, resource));
    }

    @Override
    public Stream<Permission> flatten() {
        return Stream.concat(Stream.of(this), children.stream().flatMap(Permission::flatten));
    }

    public static PermissionGroup of(String name, Permission... children) {
        return new PermissionGroup(name, List.of(children));
    }
}
```

Usage — a role is just a composite, and the caller never branches on node type:

```java
Permission supportRole = PermissionGroup.of("support",
    PermissionGroup.of("orders",
        new Grant("read-orders",   Action.READ,   ResourcePattern.of("order:*")),
        new Grant("cancel-orders", Action.CANCEL, ResourcePattern.of("order:*"))),
    PermissionGroup.of("customers",
        new Grant("read-customers", Action.READ, ResourcePattern.of("customer:*"))),
    new Grant("read-refunds", Action.READ, ResourcePattern.of("refund:*")));

boolean ok = supportRole.allows(Action.CANCEL, Resource.of("order:8891"));   // true
long grantCount = supportRole.flatten().filter(p -> p instanceof Grant).count();
```

`sealed` is the modern improvement over the GoF version. The classic Composite has an abstract `Component` class with `add`/`remove`/`getChild` declared on it, which forces leaves to implement child-management methods they cannot support — usually by throwing `UnsupportedOperationException`. That is the pattern's documented "transparency vs safety" trade-off, and `sealed` resolves it: children live only on `PermissionGroup`, and an exhaustive `switch` can still handle both cases type-safely when a caller genuinely needs to distinguish them.

### Denial, precedence, and why naive Composite is dangerous for permissions

The version above is `anyMatch` — pure allow. Real permission systems need explicit denies, and that changes the composite's combination logic in a way that is easy to get wrong.

```java
public sealed interface Rule permits Allow, Deny, RuleSet {

    Decision decide(Action action, Resource resource);

    enum Decision { ALLOW, DENY, ABSTAIN }
}

public record Allow(Action action, ResourcePattern pattern) implements Rule {
    public Decision decide(Action a, Resource r) {
        return action == a && pattern.matches(r) ? Decision.ALLOW : Decision.ABSTAIN;
    }
}

public record Deny(Action action, ResourcePattern pattern) implements Rule {
    public Decision decide(Action a, Resource r) {
        return action == a && pattern.matches(r) ? Decision.DENY : Decision.ABSTAIN;
    }
}

public record RuleSet(String name, List<Rule> children) implements Rule {

    public RuleSet { children = List.copyOf(children); }

    /** Deny-overrides: any DENY anywhere in the subtree wins. */
    public Decision decide(Action a, Resource r) {
        boolean anyAllow = false;
        for (Rule child : children) {
            switch (child.decide(a, r)) {
                case DENY   -> { return Decision.DENY; }   // short-circuit
                case ALLOW  -> anyAllow = true;
                case ABSTAIN -> { }
            }
        }
        return anyAllow ? Decision.ALLOW : Decision.ABSTAIN;
    }
}
```

The three-valued `Decision` is what makes this correct. With a `boolean`, "no rule matched" and "a rule said no" are indistinguishable, so a subtree that abstains looks identical to one that denies — and the combination logic at the parent cannot tell whether to keep searching.

### Cycle safety

A composite built from user or database input can contain a cycle, and `flatten()` will then recurse until the stack overflows. Any composite assembled at runtime needs a guard:

```java
public Stream<Permission> flatten() {
    return flatten(Collections.newSetFromMap(new IdentityHashMap<>()));
}

private Stream<Permission> flatten(Set<Permission> visited) {
    if (!visited.add(this)) {
        throw new IllegalStateException("cycle detected at " + name());
    }
    return Stream.concat(Stream.of(this),
        children.stream().flatMap(c -> c instanceof PermissionGroup g ? g.flatten(visited)
                                                                     : c.flatten()));
}
```

For a tree loaded from a `parent_id` column, prefer validating acyclicity at write time (or use a closure table / `ltree`) rather than discovering it during a request.

### Menu / UI structure example

```java
public sealed interface MenuNode permits MenuItem, MenuFolder {
    String label();
    boolean visibleTo(Set<String> authorities);
}

public record MenuItem(String label, String href, String requiredAuthority) implements MenuNode {
    public boolean visibleTo(Set<String> authorities) {
        return requiredAuthority == null || authorities.contains(requiredAuthority);
    }
}

public record MenuFolder(String label, List<MenuNode> children) implements MenuNode {

    public MenuFolder { children = List.copyOf(children); }

    /** A folder is visible only if something inside it is. Prevents empty dropdowns. */
    public boolean visibleTo(Set<String> authorities) {
        return children.stream().anyMatch(c -> c.visibleTo(authorities));
    }

    /** Rendering-ready pruned copy. */
    public Optional<MenuFolder> prunedFor(Set<String> authorities) {
        List<MenuNode> kept = children.stream()
            .flatMap(c -> switch (c) {
                case MenuItem i -> i.visibleTo(authorities) ? Stream.of((MenuNode) i) : Stream.of();
                case MenuFolder f -> f.prunedFor(authorities).map(x -> Stream.of((MenuNode) x))
                                                             .orElseGet(Stream::of);
            })
            .toList();
        return kept.isEmpty() ? Optional.empty() : Optional.of(new MenuFolder(label, kept));
    }
}
```

`visibleTo` on the folder is the pattern earning its keep: "a folder is visible if any child is" is one line, expressed once, and correct at any depth.

### Where it appears in the JDK and Spring

| Class | Composite structure |
|---|---|
| `java.io.File` / `java.nio.file.Path` | A path is a file or a directory of paths |
| `javax.swing.JComponent` / `Container` | The canonical GUI composite |
| `org.w3c.dom.Node` | Element with child nodes; `NodeList` traversal |
| `CompositeName`, `CompositeData` (JMX) | Structured composites |
| `Executors.newWorkStealingPool` + `ForkJoinTask` | Tasks that split into subtasks — Composite over work |
| Spring `CompositeCacheManager` | One `CacheManager` fronting several |
| Spring `DelegatingPasswordEncoder` | Composite over encoders keyed by `{id}` prefix |
| Spring `CompositeHealthContributor`, `CompositeMeterRegistry` | Actuator/Micrometer composites |
| Spring Security `AuthorizationManagers.allOf/anyOf` | Composite `AuthorizationManager` |
| Spring Security `FilterChainProxy` | Holds N `SecurityFilterChain`s |
| Jackson `JsonNode` | `ObjectNode`/`ArrayNode` are composites of `ValueNode` leaves |

`CompositeMeterRegistry` is worth a note because it exposes a real Composite subtlety: adding a child registry after meters have been created must retroactively register those meters with the new child. Composites whose children change at runtime need that "catch up" logic, and forgetting it produces "metrics missing from the second backend."

### When it is the WRONG choice

- **The hierarchy is fixed at two levels.** Order and OrderLine is not a Composite; it is a parent with a collection. Composite is for arbitrary-depth recursion.
- **Leaf and composite behavior genuinely differ.** If half the interface throws `UnsupportedOperationException` on leaves, the uniformity you were buying does not exist.
- **You need aggregate queries.** "Total price of this subtree" is fine recursively for 50 nodes and a performance disaster for 500,000 rows loaded from a database. A recursive CTE beats an object graph traversal by orders of magnitude at scale.
- **The tree lives in a database and is deep.** N+1 queries per level. Use a closure table, materialized path, `ltree`, or a `WITH RECURSIVE` query, and build the composite only for the subtree you need.

**Over-engineering smell:** a Composite for a structure that is always exactly one level deep, or a `Component` abstract class with `add`/`remove` that leaves implement by throwing.

### Production scenario: recursive permission check on a deep tree

**Problem.** An enterprise customer with a deep organizational hierarchy (11 levels, ~40,000 nodes) saw API latency go from 80 ms to 14 seconds. Every endpoint. CPU on the app pods sat at 100%; the database was nearly idle.

**Cause.** Permissions were modeled as a Composite loaded from a `permission_node` table with a `parent_id`. `PermissionService.allows(...)` loaded the user's root node and walked the tree. Two problems compounded:

1. **N+1 on traversal.** Children were a lazy `@OneToMany`, so each node visit issued a query. 40,000 nodes meant 40,000 queries per authorization check.
2. **The check ran per authorization decision**, and a typical page made 60 decisions. Caching was absent because "permissions must be fresh."

The idle database was the clue that mattered: the queries were fast individually, and all the time was round-trip latency plus object materialization.

**Solution.** Separate the *authorization decision* from the *tree structure*. The composite is a good model for editing and displaying permissions; it is the wrong model for answering one boolean question 60 times per request.

```java
/** Flattened, immutable, per-user authorization snapshot. Built once per request. */
public record EffectivePermissions(Set<String> grants) {

    public boolean allows(Action action, Resource resource) {
        // "order:CANCEL:8891", "order:CANCEL:*", "order:*:*", "*:*:*"
        return grants.contains(key(action, resource.type(), resource.id()))
            || grants.contains(key(action, resource.type(), "*"))
            || grants.contains(key(action, "*", "*"))
            || grants.contains("*:*:*");
    }

    private static String key(Action a, String type, String id) {
        return type + ":" + a + ":" + id;
    }
}
```

```java
@Component
public class EffectivePermissionsLoader {

    private final JdbcTemplate jdbc;
    private final Cache<UserId, EffectivePermissions> cache;

    public EffectivePermissionsLoader(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.cache = Caffeine.newBuilder()
            .maximumSize(50_000)
            .expireAfterWrite(Duration.ofMinutes(2))   // bounded staleness, explicitly accepted
            .build();
    }

    public EffectivePermissions forUser(UserId user) {
        return cache.get(user, this::load);
    }

    private EffectivePermissions load(UserId user) {
        // One recursive CTE replaces 40,000 lazy-loading queries.
        List<String> grants = jdbc.queryForList("""
            WITH RECURSIVE subtree AS (
                SELECT id, parent_id, kind, action, resource_type, resource_id
                  FROM permission_node
                 WHERE id IN (SELECT node_id FROM user_permission_root WHERE user_id = ?)
                UNION ALL
                SELECT c.id, c.parent_id, c.kind, c.action, c.resource_type, c.resource_id
                  FROM permission_node c
                  JOIN subtree s ON c.parent_id = s.id
            )
            SELECT resource_type || ':' || action || ':' || COALESCE(resource_id, '*')
              FROM subtree
             WHERE kind = 'GRANT'
            """, String.class, user.value());
        return new EffectivePermissions(Set.copyOf(grants));
    }

    @EventListener
    public void onPermissionChanged(PermissionTreeChanged event) {
        event.affectedUsers().forEach(cache::invalidate);   // freshness without polling
    }
}
```

The composite classes stayed, used by the admin UI that edits the tree. The request path uses the flattened snapshot. Latency returned to 85 ms, and the database load went **down** because 2.4 million small queries per minute became a few hundred CTEs.

**Lesson.** Composite is a modeling pattern, not an execution strategy. A recursive object graph is the right shape for editing and displaying a hierarchy, and the wrong shape for answering a hot question. Project the tree into a flat structure for the read path, and invalidate on change events rather than refusing to cache.

---

## 12. Structural — Bridge and Flyweight

Two patterns that are frequently confused with others: Bridge with Adapter and with Strategy, Flyweight with caching and with Singleton. Both have canonical JDK examples that make them concrete.

### Bridge — the problem it solves

You have **two independent dimensions of variation** and inheritance forces you to multiply them. A `Notification` varies by type (alert, digest, receipt) and by transport (email, SMS, push, Slack). Inheritance gives you `EmailAlert`, `SmsAlert`, `PushAlert`, `EmailDigest`, `SmsDigest`, ... — m × n classes, and adding one transport adds m classes.

Bridge splits the hierarchy in two: an **abstraction** hierarchy that varies on one axis and an **implementor** hierarchy that varies on the other, with the abstraction holding a reference to the implementor.

```java
// --- Implementor hierarchy: transports. ---
public interface MessageTransport {
    void send(Recipient to, RenderedMessage message);
    boolean supportsRichText();
    int maxLength();
}

@Component
class EmailTransport implements MessageTransport {
    public void send(Recipient to, RenderedMessage m) { /* SMTP */ }
    public boolean supportsRichText() { return true; }
    public int maxLength() { return 1_000_000; }
}

@Component
class SmsTransport implements MessageTransport {
    public void send(Recipient to, RenderedMessage m) { /* provider API */ }
    public boolean supportsRichText() { return false; }
    public int maxLength() { return 160; }
}
```

```java
// --- Abstraction hierarchy: notification kinds. Holds a transport (the bridge). ---
public abstract class Notification {

    protected final MessageTransport transport;   // ← the bridge

    protected Notification(MessageTransport transport) { this.transport = transport; }

    public final void deliver(Recipient to) {
        RenderedMessage message = render(transport.supportsRichText());
        transport.send(to, message.truncatedTo(transport.maxLength()));
    }

    protected abstract RenderedMessage render(boolean rich);
}

public final class PaymentReceipt extends Notification {
    private final Order order;
    public PaymentReceipt(MessageTransport t, Order order) { super(t); this.order = order; }

    @Override
    protected RenderedMessage render(boolean rich) {
        return rich ? RenderedMessage.html(receiptHtml(order))
                    : RenderedMessage.text(receiptText(order));
    }
}

public final class SecurityAlert extends Notification {
    private final LoginAttempt attempt;
    public SecurityAlert(MessageTransport t, LoginAttempt a) { super(t); this.attempt = a; }

    @Override
    protected RenderedMessage render(boolean rich) {
        return RenderedMessage.text("New sign-in from " + attempt.ip() + " at " + attempt.at());
    }
}
```

`new PaymentReceipt(smsTransport, order)` and `new SecurityAlert(emailTransport, attempt)` — 3 kinds × 4 transports needs 7 classes, not 12, and adding Slack adds one class.

**Bridge vs Strategy vs Adapter**, since this is the standard confusion:

| | Bridge | Strategy | Adapter |
|---|---|---|---|
| Intent | Let two hierarchies vary independently | Swap one algorithm | Make an incompatible interface fit |
| When decided | Usually at construction; structural | Often per call; behavioral | Compile-time mismatch |
| Both sides designed together? | Yes — both hierarchies are yours | Only the interface is yours | The adaptee is not yours |
| Number of hierarchies | Two, deliberately | One (plus implementations) | One wrapper per foreign type |

In practice, DI blurs Bridge and Strategy heavily: injecting a `MessageTransport` into a notification class *is* a bridge, and nobody in a code review will object if you call it strategy. The distinction earns its keep in design discussions about whether you have one axis of variation or two — because if you have two and only model one, you get the class explosion.

### Bridge in the JDBC driver model

JDBC is the textbook example and worth spelling out because interviews ask.

- **Abstraction:** `java.sql.Connection`, `Statement`, `ResultSet`, `DatabaseMetaData` — the API your code uses.
- **Implementor:** each vendor's driver implements those interfaces (`org.postgresql.jdbc.PgConnection`, `oracle.jdbc.driver.T4CConnection`).
- **Bridge point:** `DriverManager.getConnection(url)` resolves an implementor by URL and returns it typed as the abstraction.

Your data-access code varies (repositories, queries, mappers) completely independently of which driver is loaded. Neither hierarchy knows about the other's subclasses. That is Bridge; if it were Adapter, the JDBC interfaces would have been designed *after* the drivers, to paper over their differences.

Hibernate adds a second bridge on top: `Dialect` lets the ORM's abstraction (`SessionFactory`, HQL) vary independently of SQL flavor.

### Where Bridge appears

| Example | Two axes |
|---|---|
| JDBC API ↔ drivers | Data-access code × database vendor |
| SLF4J API ↔ bindings | Logging call sites × logging backend |
| JCA `Cipher` ↔ providers | Cryptographic operations × provider implementation |
| `java.awt.Toolkit` ↔ peer classes | AWT components × native platform |
| Spring `Resource` ↔ `ResourceLoader` | Resource-consuming code × storage (classpath, file, URL, S3) |
| Spring `PlatformTransactionManager` ↔ implementations | Transactional code × transaction technology (JDBC, JTA, JPA) |
| Micrometer `MeterRegistry` ↔ backends | Instrumentation × Prometheus/Datadog/CloudWatch |
| `Flow.Publisher` ↔ reactive implementations | Stream logic × reactive library |

### When Bridge is the WRONG choice

- **Only one axis actually varies.** If there is exactly one transport, the bridge is a constructor parameter that never changes.
- **The axes are not independent.** If `SecurityAlert` needs SMS-specific behavior, they are coupled and the split will leak (`if (transport instanceof SmsTransport)` is the tell).
- **Two axes, small cardinality.** 2 × 2 = 4 classes is not an explosion. Wait for the third value on either axis.

**Over-engineering smell:** a bridge introduced "in case we support another database." You already have one — JDBC. Adding your own abstraction over JDBC to be database-independent, and then writing vendor-specific SQL anyway, is the most common version of this mistake.

### Flyweight — the problem it solves

You need a very large number of objects that are mostly identical. Flyweight splits state into **intrinsic** (shared, immutable, part of the object's identity as a value) and **extrinsic** (varies per use, passed in as parameters), then shares one instance per distinct intrinsic state.

The savings are real: a 12-byte object header plus fields, times millions of instances, is hundreds of megabytes and a great deal of GC pressure.

### `Integer.valueOf` — the JDK's most consequential flyweight

```java
Integer a = 127, b = 127;
Integer c = 128, d = 128;

System.out.println(a == b);   // true  — both from the cache
System.out.println(c == d);   // false — two separate objects
```

`Integer.valueOf` returns a cached instance for values in `[-128, 127]`. Autoboxing calls `valueOf`, so this cache is in effect everywhere. The upper bound is tunable with `-XX:AutoBoxCacheMax=<n>`, which is itself a hazard: code that accidentally depends on `==` working can pass in one environment and fail in another.

The permanent rule: **never compare boxed numbers with `==`**. Use `equals` or unbox. The `128` case is the single most common Java interview trick question, and the underlying reason is Flyweight.

Related caches: `Boolean.valueOf` (two instances, always), `Character.valueOf` (0–127), `Short`/`Long`/`Byte.valueOf` (−128–127), and `Optional.empty()` (one shared instance).

### String interning

String literals are interned automatically in the string constant pool — one instance per distinct literal per JVM.

```java
String a = "hello";
String b = "hello";
String c = new String("hello");
String d = c.intern();

a == b;   // true  — same interned literal
a == c;   // false — new String() forces a distinct object
a == d;   // true  — intern() returns the pooled instance
```

`String.intern()` is a manual flyweight, and calling it on user-supplied data is a real production hazard. In modern HotSpot the pool lives in the heap (not PermGen, since Java 7) but the *string table* is a fixed-size hash table sized by `-XX:StringTableSize` (default ~65,536 buckets). Interning millions of distinct strings degrades that table into long chains, making every subsequent `intern()` call slower — and interned strings are only collected when unreachable, which for a long-lived process often means never in practice.

Deduplicating high-cardinality strings is better done with an explicit bounded map:

```java
/** Bounded, explicit flyweight for repeated tenant identifiers in a hot parse loop. */
final class TenantIdPool {

    private final Cache<String, TenantId> pool = Caffeine.newBuilder()
        .maximumSize(10_000)
        .build();

    TenantId of(String raw) {
        return pool.get(raw, TenantId::new);
    }
}
```

Or, since JDK 8u20, `-XX:+UseStringDeduplication` with G1, which deduplicates the backing `byte[]` of equal strings during GC with no code changes.

### A real flyweight in application code

```java
/**
 * Intrinsic state: currency + scale rules. Shared, one per currency.
 * Extrinsic state: the amount, passed per operation.
 */
public final class CurrencyProfile {

    private static final Map<String, CurrencyProfile> POOL = new ConcurrentHashMap<>();

    private final String code;
    private final int scale;
    private final RoundingMode rounding;
    private final DecimalFormat format;      // expensive to build, and NOT thread-safe

    private CurrencyProfile(String code, int scale, RoundingMode rounding) {
        this.code = code;
        this.scale = scale;
        this.rounding = rounding;
        this.format = buildFormat(code, scale);
    }

    public static CurrencyProfile of(String code) {
        return POOL.computeIfAbsent(code, CurrencyProfile::fromIsoTable);
    }

    public BigDecimal normalize(BigDecimal amount) {      // extrinsic state as a parameter
        return amount.setScale(scale, rounding);
    }

    public String render(BigDecimal amount) {
        synchronized (format) {                            // DecimalFormat is not thread-safe
            return format.format(amount);
        }
    }
}
```

The `synchronized (format)` block is the point of interest: sharing an instance across threads means every mutable or non-thread-safe piece of its state becomes a concurrency problem. This is the hidden cost of Flyweight, and the reason `SimpleDateFormat` in a static field is a classic production bug.

### Where Flyweight appears

| Example | Shared intrinsic state |
|---|---|
| `Integer.valueOf` and friends | Small numeric values |
| String constant pool, `String.intern()` | Distinct string content |
| `Boolean.TRUE` / `FALSE` | Two values |
| `Optional.empty()`, `Collections.emptyList/Map/Set` | The single empty instance |
| `Collectors.toList()` etc. | Stateless collector instances |
| `Charset.forName` | One `Charset` per name |
| `java.time.ZoneId.of`, `ZoneOffset` (cached for common offsets) | Timezone rules |
| Enum constants | The canonical flyweight — one instance per constant, by language design |
| `BigDecimal.ZERO/ONE/TEN`, `Duration.ZERO` | Common constants |
| Netty `PooledByteBufAllocator` | Buffer pooling (object pool rather than strict flyweight) |
| Font/glyph caches, `java.awt.Color` constants | UI resources |

Enums are worth calling out: an enum *is* a flyweight plus a singleton per constant, guaranteed by the JVM. Which is why `==` on enums is correct and idiomatic, unlike on boxed integers.

### When Flyweight causes hidden coupling

This is the part that bites in production.

1. **Shared mutable state.** If the flyweight has any mutable field, every holder shares it. A cached `SimpleDateFormat` or `Calendar` produces garbled dates and `ArrayIndexOutOfBoundsException` under concurrency.
2. **Identity becomes meaningful by accident.** Code that works because two references happen to be `==` breaks when the value moves outside the cache range or the cache is resized.
3. **Unbounded pools are memory leaks.** `ConcurrentHashMap<String, X>` keyed by user input, with no eviction, is a slow OOM with a strong GC root.
4. **Lock contention.** A `synchronized` flyweight accessor on a hot path serializes threads that had no logical relationship. `computeIfAbsent` on a `ConcurrentHashMap` holds a bin lock during the mapping function; a slow or recursive mapping function can deadlock the map.
5. **Debugging confusion.** A breakpoint on a flyweight's method is hit by every logical user of the value, and mutating one during a debug session affects all of them.
6. **Serialization identity loss.** Deserializing a flyweight creates a new instance, so `==` comparisons that held in-process fail after a round trip through a cache or a queue.

The safety rule: **a flyweight must be deeply immutable and its pool must be bounded.** If either is false, you have a shared-state bug waiting for load.

### When Flyweight is the WRONG choice

- **The object count is thousands, not millions.** Modern GC handles short-lived objects extremely well. Pooling small objects usually *hurts* by moving them to old gen.
- **The intrinsic/extrinsic split is unnatural.** If you must thread five extrinsic parameters through every method, the API becomes worse than the memory it saved.
- **You measured nothing.** Flyweight is a memory optimization. Without a heap dump showing the duplication, it is speculation with a real complexity cost.

**Over-engineering smell:** an object pool for DTOs "to reduce GC pressure." Escape analysis, TLAB allocation, and generational GC make short-lived allocation nearly free; pooling adds synchronization and lifecycle bugs. Pool things that are genuinely expensive — connections, threads, large buffers — not objects.

### Production scenario: `==` on cached Integers and a boxed cache key

**Problem.** A pricing service applied the wrong tier discount for exactly the customers whose tier ID was above 127. Customers with tier IDs 1–127 were fine. Discovered when a large enterprise account (tier 340) was charged retail pricing for three months.

**Cause.** Two flyweight-related bugs in one method.

```java
// Bug 1: identity comparison on boxed Integers
private static final Map<Integer, Discount> DISCOUNTS = loadDiscounts();

Discount discountFor(Integer tierId) {
    for (Map.Entry<Integer, Discount> e : DISCOUNTS.entrySet()) {
        if (e.getKey() == tierId) {          // == on Integer
            return e.getValue();
        }
    }
    return Discount.NONE;                     // silent wrong answer
}
```

For tier IDs in `[-128, 127]`, both the map key and the argument came from the `Integer` cache, so `==` was true and the code worked. Above 127, autoboxing created distinct objects, `==` was false, the loop fell through, and `Discount.NONE` was returned — a silent wrong answer rather than an exception, which is why it survived three months.

The second bug made it worse: the tier ID arrived as a `long` from the database in one code path and an `int` in another, so `Long` keys and `Integer` keys coexisted in a `Map<Object, Discount>` used elsewhere. `Long.valueOf(5).equals(Integer.valueOf(5))` is `false`, so even fixing `==` to `equals` left cross-type misses.

**Solution.** Eliminate boxed primitives from the domain entirely by using a typed value object, and let the map do its job.

```java
public record TierId(int value) implements Comparable<TierId> {
    public TierId {
        if (value <= 0) throw new IllegalArgumentException("tierId must be positive");
    }
    public int compareTo(TierId o) { return Integer.compare(value, o.value); }
}

@Component
public class TierDiscounts {

    private final Map<TierId, Discount> byTier;

    TierDiscounts(DiscountRepository repo) {
        this.byTier = repo.findAll().stream()
            .collect(toUnmodifiableMap(r -> new TierId(r.tierId()), DiscountRow::discount));
    }

    /** Missing configuration is an error, not a 0% discount. */
    public Discount forTier(TierId tier) {
        Discount d = byTier.get(tier);
        if (d == null) {
            throw new MissingDiscountConfigurationException(tier);
        }
        return d;
    }
}
```

Three properties of the fix matter more than the `==` correction:

1. `TierId` is a record, so `equals`/`hashCode` are value-based and no cache range exists to depend on.
2. There is no cross-type key problem — a `TierId` cannot be confused with a `Long`.
3. A missing tier now throws instead of silently returning `Discount.NONE`. The original bug's damage came from the silent fallback, not from `==` alone.

A static-analysis rule closed the class of bug:

```java
// ErrorProne's ReferenceEquality / SpotBugs' RC_REF_COMPARISON, enforced as an error
// <compilerArg>-Xep:ReferenceEquality:ERROR</compilerArg>
```

**Lesson.** The `Integer` cache means `==` on boxed values works for small numbers and fails for large ones — the worst possible failure profile, because tests with small fixtures pass. Domain identifiers should be typed value objects, not boxed primitives, and a lookup miss on required configuration should throw rather than default.

---

## 13. Behavioral — Strategy

### The problem it solves

You have a family of algorithms that do the same job — compute shipping cost, validate an address, choose a compression codec — and the caller should not contain a growing `if/else` chain. Strategy extracts the varying algorithm behind an interface (or a functional type) and injects the chosen implementation at runtime.

In modern Java, Strategy is usually **not** a named interface hierarchy. It is a `Function`, `Predicate`, `Comparator`, or a small `sealed interface` with two or three implementations. The pattern name still matters in review because it tells everyone where the next algorithm goes.

### Java implementation — shipping cost without a factory explosion

```java
public sealed interface ShippingCalculator permits FlatRate, WeightBased, FreeOverThreshold {

    Money cost(Order order);

    /** Static factory on the interface — idiomatic since Java 17. */
    static ShippingCalculator flat(Money rate) {
        return new FlatRate(rate);
    }

    static ShippingCalculator weightBased(Money perKg) {
        return new WeightBased(perKg);
    }
}

record FlatRate(Money rate) implements ShippingCalculator {
    @Override public Money cost(Order order) { return rate; }
}

record WeightBased(Money perKg) implements ShippingCalculator {
    @Override
    public Money cost(Order order) {
        return perKg.times(order.totalWeightKg());
    }
}

record FreeOverThreshold(Money threshold, ShippingCalculator delegate) implements ShippingCalculator {
    @Override
    public Money cost(Order order) {
        return order.subtotal().compareTo(threshold) >= 0
            ? Money.ZERO
            : delegate.cost(order);
    }
}
```

Wiring from configuration — the Strategy is chosen once, not per call:

```java
@Configuration
class ShippingConfig {

    @Bean
    ShippingCalculator shippingCalculator(@Value("${shipping.mode}") String mode,
                                          ShippingProperties props) {
        return switch (mode) {
            case "flat"   -> ShippingCalculator.flat(props.flatRate());
            case "weight" -> ShippingCalculator.weightBased(props.perKg());
            default       -> throw new IllegalStateException("unknown shipping.mode: " + mode);
        };
    }
}

@Service
class CheckoutService {
    private final ShippingCalculator shipping;

    CheckoutService(ShippingCalculator shipping) { this.shipping = shipping; }

    Money quote(Order order) {
        return order.subtotal().plus(shipping.cost(order));
    }
}
```

When the variation is a one-liner and unlikely to grow, a lambda is the Strategy:

```java
// Comparator is the canonical JDK Strategy
List<Order> sorted = orders.stream()
    .sorted(Comparator.comparing(Order::createdAt).reversed())
    .toList();

// Predicate as validation Strategy
public void validate(Order order, Predicate<Order> rule) {
    if (!rule.test(order)) throw new ValidationException("rule failed");
}
```

### Where Strategy appears

| Example | What varies |
|---|---|
| `java.util.Comparator` | Sort order |
| `java.util.function.*` | Any single-method behavior |
| `SecurityManager` auth providers (legacy) | Authentication mechanism |
| Spring `ResourceLoader` resolution | How a path string becomes a `Resource` |
| Spring `@Qualifier` + multiple beans of same type | Which implementation to inject |
| Jackson `ObjectMapper` modules / serializers | Serialization rules |
| Resilience4j `Retry` / `RateLimiter` policies | Failure-handling algorithm |
| Payment gateway adapters behind one interface | PSP-specific charge logic |

### When Strategy is the WRONG choice

- **One algorithm, no credible second.** A `PricingStrategy` with a single `StandardPricingStrategy` is speculative generality (see section 1).
- **The variation is data, not behavior.** Country-specific tax rates belong in a table or config map, not nine strategy classes.
- **Algorithms share 90% of their steps.** You need Template Method or a shared private method, not nine copy-pasted Strategies.
- **Selection happens on every call with dozens of cases.** A `Map<String, ShippingCalculator>` or `switch` on a sealed type is clearer than a class per case when cases are records, not services.

**Over-engineering smell:** `AbstractXStrategy` with template methods and a `StrategyFactoryProvider` that reads a config key resolving to one value forever.

### Production scenario: strategy per payment method, but selection is really data

**Problem.** Checkout had `PaymentStrategy` with `CreditCardStrategy`, `PayPalStrategy`, `WalletStrategy`, each 200 lines. Adding a new card network required touching the abstract base because shared fraud-check hooks were in the wrong layer. Integration tests mocked the factory, not the strategies, so a new PSP shipped with a wiring bug that charged the wrong currency for wallet payments.

**Cause.** Strategy was applied where the real variation was **endpoint configuration** (API URL, credentials, webhook secret), not algorithm. Each "strategy" duplicated HTTP retry, idempotency key generation, and metrics — copy-paste with different URLs.

**Solution.** One `PaymentGateway` interface, one HTTP client decorator stack (section 8), and a `Map<PaymentMethod, GatewayConfig>` for data. Method-specific behavior that genuinely differs (3DS flow vs redirect) stays as small sealed types; everything else is shared infrastructure.

```java
public sealed interface PaymentFlow permits CardFlow, RedirectFlow {
    PaymentResult execute(PaymentIntent intent, PaymentGateway gateway);
}

@Service
class PaymentOrchestrator {
    private final Map<PaymentMethod, PaymentFlow> flows;
    private final PaymentGateway gateway;   // shared: retry, metrics, auth

    PaymentResult pay(PaymentIntent intent) {
        return flows.get(intent.method()).execute(intent, gateway);
    }
}
```

The abstract `PaymentStrategy` hierarchy was deleted. Three integration tests per flow replaced twenty factory mocks.

---

## 14. Behavioral — Template Method

### The problem it solves

Several workflows share the same skeleton — load data, transform, persist, notify — but differ in one or two steps. Template Method defines the skeleton in a base class (or a coordinator method) and lets subclasses override specific steps without reimplementing the sequence.

In modern Java, **inheritance-based** Template Method is often replaced by a method that accepts lambdas for the variable steps. Spring's `JdbcTemplate.query(sql, rowMapper)` is the canonical example: the connection acquisition, statement execution, and cleanup are fixed; the row mapping varies.

### Java implementation — both styles

**Inheritance (use when the skeleton is stable and subclasses are a real taxonomy):**

```java
public abstract class AbstractReportJob {

    /** Template method — final so the sequence cannot be broken. */
    public final ReportResult run(ReportRequest request) {
        validate(request);
        List<Row> rows = fetch(request);
        List<Row> filtered = filter(rows, request);
        byte[] output = render(filtered, request.format());
        publish(output, request.destination());
        return new ReportResult(output.length, Instant.now());
    }

    protected void validate(ReportRequest request) {
        Objects.requireNonNull(request.range());
    }

    protected abstract List<Row> fetch(ReportRequest request);

    protected List<Row> filter(List<Row> rows, ReportRequest request) {
        return rows;   // hook — default no-op
    }

    protected abstract byte[] render(List<Row> rows, ExportFormat format);

    protected void publish(byte[] output, Destination dest) {
        dest.write(output);   // hook with sensible default
    }
}
```

**Composition with lambdas (preferred for most Spring services):**

```java
@Component
class ReportPipeline {

    ReportResult run(ReportRequest request,
                     Function<ReportRequest, List<Row>> fetcher,
                     Function<List<Row>, byte[]> renderer) {
        validate(request);
        List<Row> rows = fetcher.apply(request);
        byte[] output = renderer.apply(rows);
        request.destination().write(output);
        return new ReportResult(output.length, Instant.now());
    }

    private void validate(ReportRequest request) {
        if (request.range().isEmpty()) throw new IllegalArgumentException("range required");
    }
}
```

### Where Template Method appears

| Example | Fixed skeleton | Varying step |
|---|---|---|
| `JdbcTemplate` | Connection, statement, cleanup | `RowMapper`, `PreparedStatementSetter` |
| `RestClient` exchange methods | HTTP call lifecycle | Response extractor |
| `HttpServlet.service` | Request dispatch | `doGet`, `doPost`, … |
| JUnit 5 `@BeforeEach` / test method | Test lifecycle | Test body |
| Spring `AbstractController` patterns (legacy) | Request handling | Handler method |
| `InputStream.read` default methods | Bulk read loop | Single-byte `read()` |
| Servlet `FilterChain.doFilter` | Chain traversal | Individual filter logic |

### When Template Method is the WRONG choice

- **Only one implementation exists.** An abstract base with one subclass is indirection without benefit.
- **The skeleton changes as often as the steps.** If step order varies per caller, you do not have a template — you have a script that needs a plain method or a workflow engine.
- **Subclassing ties you to a fragile hierarchy.** Deep inheritance trees break when step 3 of 7 needs to be skipped for one case. Prefer composition.
- **Testing requires subclassing.** If tests must extend `AbstractFoo` to stub one hook, inject the hook as a `Function` instead.

**Over-engineering smell:** `AbstractServiceImpl` in every module with `@Override` on `preProcess`, `postProcess`, `afterCommit` hooks that 95% of subclasses leave empty.

### Production scenario: template method in batch job base class hid transaction boundaries

**Problem.** Nightly ETL jobs extended `AbstractBatchJob`. Each job overrode `processChunk()` but the base class also called `preJob()`, `postJob()`, and `onFailure()` in a fixed order. One job's `postJob()` sent a Kafka completion event while the base class had already committed the JDBC transaction — downstream consumers saw "complete" before rows were visible on the read replica.

**Cause.** The template method owned **transaction and messaging boundaries** that subclasses assumed they controlled. Subclasses overrode hooks without understanding the base class's `@Transactional` scope. The sequence was implicit in inheritance, not visible at the call site.

**Solution.** Replace the hierarchy with an explicit pipeline where transaction and outbox boundaries are visible:

```java
@Component
class BatchRunner {
    private final TransactionTemplate tx;
    private final Outbox outbox;

    void run(BatchJob job) {
        job.validate();
        tx.executeWithoutResult(status -> job.processAll());
        outbox.publish(job.completionEvent());   // after commit via outbox pattern
    }
}
```

Hooks became constructor-injected collaborators, not `@Override` methods. The bug class disappeared because no subclass could send events from inside a template hook.

---

## 15. Behavioral — Observer

### The problem it solves

One object's state change must notify many dependents without hard-wiring their class names. The subject publishes; observers subscribe. Decoupling producers from consumers is essential in UI, domain events, metrics, and audit trails.

Java's original `java.util.Observable` / `Observer` is deprecated since Java 9 — it was poorly designed (notification before state update, no generic typing, `Observable` was a class you had to extend). Modern Java uses **`Flow` (reactive streams)**, **`ApplicationEventPublisher`**, or message brokers.

### Java implementation — Spring domain events

```java
// Event — immutable record, past tense name
public record OrderPlaced(OrderId orderId, CustomerId customer, Money total) {}

@Component
class OrderService {
    private final ApplicationEventPublisher events;
    private final OrderRepository orders;

    @Transactional
    Order placeOrder(PlaceOrderCommand cmd) {
        Order order = orders.save(Order.from(cmd));
        events.publishEvent(new OrderPlaced(order.id(), order.customerId(), order.total()));
        return order;
    }
}

@Component
class InventoryListener {
    @EventListener
    void onOrderPlaced(OrderPlaced event) {
        inventory.reserve(event.orderId());
    }
}

@Component
class EmailListener {
    @EventListener
    @Async   // only if you accept eventual consistency
    void onOrderPlaced(OrderPlaced event) {
        mailer.sendConfirmation(event.customer(), event.orderId());
    }
}
```

**Critical:** `@EventListener` runs in the **same thread** by default, **inside the same transaction** as the publisher. An exception in a listener rolls back the order. Use `@TransactionalEventListener(phase = AFTER_COMMIT)` when the listener must see committed data or must not roll back the publisher.

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
void sendToWarehouse(OrderPlaced event) {
    warehouseApi.notify(event.orderId());   // safe: order is committed
}
```

JDK `Flow` for in-process backpressure (rare in typical Spring CRUD, common in streaming):

```java
var publisher = new SubmissionPublisher<OrderEvent>();
publisher.subscribe(new Flow.Subscriber<>() {
    private Flow.Subscription sub;
    @Override public void onSubscribe(Flow.Subscription s) { sub = s; sub.request(1); }
    @Override public void onNext(OrderEvent item) { handle(item); sub.request(1); }
    @Override public void onError(Throwable t) { log.error("stream failed", t); }
    @Override public void onComplete() { log.info("done"); }
});
```

### Where Observer appears

| Example | Subject | Observers |
|---|---|---|
| Spring `ApplicationEventPublisher` | Any `@Component` | `@EventListener` methods |
| JMX `NotificationEmitter` | MBean | `NotificationListener` |
| `PropertyChangeListener` / JavaFX properties | Bean property | UI bindings |
| Servlet `HttpSessionBindingListener` | HTTP session | Session lifecycle |
| Micrometer `Gauge` / `Counter` listeners | Metrics registry | Exporters |
| Kafka / RabbitMQ consumers | Topic/exchange | `@KafkaListener`, `@RabbitListener` |
| JUnit `@TestInstance(Lifecycle.PER_CLASS)` extensions | Test engine | Extension callbacks |

### When Observer is the WRONG choice

- **One listener, forever.** A direct method call or injected service is simpler.
- **Ordering guarantees matter across listeners.** Spring event order is `@Order` annotation fragile; use an explicit pipeline or saga.
- **Cross-service notification.** In-process events do not survive process restarts or cross JVM boundaries — use an outbox + broker.
- **Listeners do heavy work synchronously.** You will block the publisher and extend transaction hold time. Async or message queue.

**Over-engineering smell:** every service method publishes five events and each listener calls three other services — a distributed monolith disguised as "loose coupling."

### Production scenario: synchronous event listener rolled back paid orders

**Problem.** Payment succeeded at the PSP, but the order status stayed `PENDING`. Customers were charged without confirmation emails. Logs showed `InventoryException: SKU discontinued` in `InventoryListener.onOrderPlaced`.

**Cause.** `OrderService.placeOrder()` was `@Transactional` and published `OrderPlaced` synchronously. `InventoryListener` threw on a discontinued SKU, rolling back the entire transaction — including the order row — **after** the payment service had already called the PSP in a prior HTTP request (called from a different code path that committed separately).

**Cause (deeper).** Mixed transactional boundaries: payment was not in the same transaction as order creation, but inventory listener was. Observer made the failure mode non-local.

**Solution.**

1. `@TransactionalEventListener(AFTER_COMMIT)` for side effects that must not roll back the publisher.
2. Move payment **after** inventory validation, or use a saga with compensating refund.
3. Make inventory reservation idempotent with `reserve(orderId)` keyed by order.

```java
@TransactionalEventListener(phase = AFTER_COMMIT)
void reserveInventory(OrderPlaced event) {
    inventory.reserve(event.orderId());   // throws → order still exists, alert fires
}
```

---

## 16. Behavioral — Command

### The problem it solves

Encapsulate a request as an object so you can queue it, log it, undo it, retry it, or authorize it independently of the code that constructs it. Command turns "do this now" into a first-class value.

In modern Java, **`Runnable`**, **`Callable<T>`**, and **`Supplier<T>`** are commands with no extra ceremony. You need a dedicated Command class when you also need: parameters for audit, `undo()`, serialization, or deferred execution metadata.

### Java implementation — audit-friendly commands

```java
public sealed interface Command permits TransferFunds, CancelSubscription {

    CommandResult execute();

    /** For audit log — what happened, not how. */
    default String describe() { return getClass().getSimpleName(); }
}

public record TransferFunds(AccountId from, AccountId to, Money amount) implements Command {

    @Override
    public CommandResult execute() {
        // delegated to domain service in real code
        return CommandResult.success("transferred " + amount);
    }
}

@Component
class CommandBus {
    private final List<CommandInterceptor> interceptors;
    private final CommandAuditLog audit;

    CommandResult dispatch(Command command) {
        for (var i : interceptors) i.before(command);
        try {
            CommandResult result = command.execute();
            audit.record(command.describe(), result);
            return result;
        } finally {
            for (int j = interceptors.size() - 1; j >= 0; j--) interceptors.get(j).after(command);
        }
    }
}
```

Spring `@Async` and `TaskExecutor` execute commands:

```java
@Bean
TaskExecutor commandExecutor() {
    ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
    ex.setCorePoolSize(4);
    ex.setThreadNamePrefix("cmd-");
    ex.initialize();
    return ex;
}

void enqueue(Runnable command) {
    executor.execute(command);   // Runnable IS a Command
}
```

Undo stack (the case that justifies a class):

```java
interface UndoableCommand extends Command {
    void undo();
}

class TextEditor {
    private final Deque<UndoableCommand> history = new ArrayDeque<>();

    void execute(UndoableCommand cmd) {
        cmd.execute();
        history.push(cmd);
    }

    void undo() {
        if (!history.isEmpty()) history.pop().undo();
    }
}
```

### Where Command appears

| Example | Command object |
|---|---|
| `Runnable` / `Callable` | `executor.submit(task)` |
| Spring `@Scheduled` method | Scheduled job invocation |
| HTTP request → controller | Request DTO + handler method |
| CQRS command handlers | `CreateOrderCommand` → handler |
| `ExecutorService` / virtual thread tasks | Work units |
| Swing `Action` / JavaFX `EventHandler` | UI commands |
| Test `@ParameterizedTest` inputs | Each case is a command to the test body |

### When Command is the WRONG choice

- **No queue, log, undo, or defer requirement.** Call the method.
- **Command class is a thin wrapper around one service call** with no extra metadata — it is a pointless indirection layer.
- **Thousands of command types** differing only by name — consider a data-driven `Map<Operation, Handler>` instead.

**Over-engineering smell:** `CreateUserCommandHandler` that only calls `userService.create(cmd.toEntity())` and adds 40 lines of mapping boilerplate with no audit or validation benefit.

### Production scenario: command bus without idempotency duplicated charges

**Problem.** Retry logic re-submitted `ChargeCustomerCommand` after a timeout. Customers were double-charged when the PSP had processed the first request but the HTTP response timed out.

**Cause.** Commands were retryable by the bus (`@Retryable`) but carried no idempotency key. The command object was introduced "for audit" but audit logged after execution, not before, and did not deduplicate.

**Solution.** Command carries an idempotency key; handler checks dedup store before side effects:

```java
public record ChargeCustomer(CustomerId customer, Money amount, IdempotencyKey key) implements Command {
    @Override
    public CommandResult execute() {
        return billing.chargeIdempotent(key, customer, amount);
    }
}
```

Audit records `(key, status)` **before** calling the PSP. Retries with the same key return the stored result.

---

## 17. Behavioral — Chain of Responsibility

### The problem it solves

A request passes through a chain of handlers. Each handler either processes it or passes it to the next. The sender does not know which handler will succeed — useful for validation pipelines, servlet filters, security checks, and middleware.

### Java implementation — servlet filter chain and domain validation

**Servlet filters (the JDK/Spring chain you already use):**

```java
@Component
@Order(1)
class CorrelationIdFilter implements Filter {
    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        MDC.put("correlationId", UUID.randomUUID().toString());
        try { chain.doFilter(req, res); }
        finally { MDC.clear(); }
    }
}

@Component
@Order(2)
class AuthenticationFilter implements Filter {
    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        if (!authenticated(req)) {
            ((HttpServletResponse) res).sendError(401);
            return;   // chain stops — do NOT call chain.doFilter
        }
        chain.doFilter(req, res);
    }
}
```

**Explicit domain chain:**

```java
public interface ValidationHandler {
    void validate(Order order, ValidationContext ctx);
}

@Component
class ValidationChain {
    private final List<ValidationHandler> handlers;

    ValidationChain(List<ValidationHandler> handlers) {
        this.handlers = handlers;   // Spring injects all ValidationHandler beans in @Order
    }

    void validate(Order order) {
        var ctx = new ValidationContext();
        for (ValidationHandler h : handlers) {
            h.validate(order, ctx);
            if (ctx.hasErrors()) break;   // short-circuit
        }
        ctx.throwIfErrors();
    }
}
```

Spring Security's filter chain is the production-scale version: dozens of filters, strict order, each responsible for one concern.

### Where Chain of Responsibility appears

| Example | Chain |
|---|---|
| Servlet `FilterChain` | HTTP request processing |
| Spring Security filter stack | AuthN, AuthZ, CSRF, session |
| Netty `ChannelPipeline` | Protocol handlers |
| SLF4J / Logback appenders | Logger → appenders |
| Exception handler resolvers (`@ControllerAdvice` list) | Exception → HTTP response |
| ClassLoader delegation | Bootstrap → platform → app |
| OkHttp `Interceptor` chain | Request/response middleware |

### When Chain of Responsibility is the WRONG choice

- **Exactly one handler will ever exist.** Call it directly.
- **Order is dynamic per request in complex ways.** A rules engine or explicit `switch` may be clearer than 15 linked handlers.
- **Handlers need to share mutable context carelessly.** A accumulating `ValidationContext` with no clear contract becomes a hidden global.

**Over-engineering smell:** 12 `@Order` validation beans where half could be a single Bean Validation `@Valid` annotation on the DTO.

### Production scenario: filter order inversion skipped authorization

**Problem.** New `@Order(0)` `RateLimitFilter` was added. Certain admin endpoints returned 200 for unauthenticated users when hit directly (bypassing the UI). Security audit flagged IDOR on `/admin/**`.

**Cause.** Developer assumed `@Order(0)` runs "first" meaning "closest to the controller." In Spring Security, **lower order = earlier in the chain = farther from the controller**. The rate limiter ran before authentication and short-circuited with 429 on some paths, but on admin paths a bug returned early without calling `chain.doFilter` only when a header was missing — skipping the auth filter entirely on a code path that was untested.

**Solution.** Document filter order with an enum; integration test that asserts 401 without token on every secured path. Prefer Spring Security's `SecurityFilterChain` bean over ad-hoc `@Order` filters mixed with security.

```java
@Bean
SecurityFilterChain api(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(auth -> auth.requestMatchers("/admin/**").hasRole("ADMIN"))
        .build();
}
```

---

## 18. Behavioral — State

### The problem it solves

An object's behavior changes when its internal state changes, and the object appears to change class. State pattern replaces large `switch (status)` blocks with polymorphic state objects — or, in modern Java, a **`sealed interface`** with exhaustive `switch`.

### Java implementation — order lifecycle

**Sealed interface + switch (Java 21 — preferred for finite states):**

```java
public sealed interface OrderState permits Draft, Submitted, Paid, Shipped, Cancelled {

    /** Transition or throw — illegal transitions are compile-time visible. */
    OrderState submit(Order order);
    OrderState pay(Order order);
    OrderState ship(Order order);
    OrderState cancel(Order order);
}

record Draft() implements OrderState {
    @Override public OrderState submit(Order o) { return new Submitted(); }
    @Override public OrderState pay(Order o) { throw new IllegalStateException("draft"); }
    @Override public OrderState ship(Order o) { throw new IllegalStateException("draft"); }
    @Override public OrderState cancel(Order o) { return new Cancelled(); }
}

record Paid() implements OrderState {
    @Override public OrderState submit(Order o) { throw new IllegalStateException("paid"); }
    @Override public OrderState pay(Order o) { return this; }
    @Override public OrderState ship(Order o) { return new Shipped(); }
    @Override public OrderState cancel(Order o) { throw new IllegalStateException("cannot cancel paid"); }
}
// Submitted, Shipped, Cancelled similarly...

@Entity
class Order {
    @Enumerated(EnumType.STRING)
    private OrderStatus status;   // persisted enum

    void pay(PaymentService payments) {
        OrderState state = stateFromEnum(status);
        OrderState next = state.pay(this);
        payments.capture(this);
        this.status = enumFromState(next);
    }
}
```

**Enum with behavior (when transitions are simple):**

```java
enum JobState {
    PENDING {
        @Override JobState start() { return RUNNING; }
    },
    RUNNING {
        @Override JobState complete() { return DONE; }
        @Override JobState fail() { return FAILED; }
    },
    DONE, FAILED;

    JobState start()   { throw new IllegalStateException(name()); }
    JobState complete(){ throw new IllegalStateException(name()); }
    JobState fail()    { throw new IllegalStateException(name()); }
}
```

### Where State appears

| Example | States |
|---|---|
| `Thread.State` | NEW, RUNNABLE, BLOCKED, … |
| TCP connection states | CLOSED, ESTABLISHED, … (conceptual) |
| Spring Batch `JobExecution` status | STARTING, STARTED, COMPLETED, FAILED |
| JPA entity lifecycle | transient, managed, detached, removed |
| Reactor `SignalType` / stream states | onNext, onComplete, onError |
| Payment intent status at PSPs | requires_action, succeeded, … |

### When State is the WRONG choice

- **Two states (`enabled`/`disabled`).** A boolean or enum field suffices.
- **States are mostly data flags** with behavior in services, not in the entity — an anemic domain with State objects glued on is worse than a service method with a `switch`.
- **Transition matrix is 15×15** with cross-cutting rules — a workflow engine (Temporal, Camunda) or state machine library beats hand-rolled State classes.

**Over-engineering smell:** `OrderStateFactory` creating state objects that are stateless singletons wrapping the same enum.

### Production scenario: status enum + scattered switch allowed illegal shipment

**Problem.** Orders in `PENDING_PAYMENT` were shipped when a warehouse cron picked up any order not in `CANCELLED`. Finance found revenue recognition mismatches for unpaid shipments.

**Cause.** Status checks were `if (order.getStatus() != CANCELLED)` in the warehouse service, not `status == PAID`. Adding `PENDING_PAYMENT` never updated the warehouse query. State transitions were not centralized — six services compared enum strings differently.

**Solution.** Centralize transitions in the entity (or domain service) and make illegal states unrepresentable at the API:

```java
public Order ship() {
    if (status != OrderStatus.PAID) {
        throw new IllegalStateException("ship requires PAID, was " + status);
    }
    this.status = OrderStatus.SHIPPED;
    return this;
}
```

Warehouse API only accepts `ship(orderId)` which loads and calls `order.ship()`. DB constraint: `CHECK (status != 'SHIPPED' OR paid_at IS NOT NULL)`.

---

## 19. Behavioral — Visitor

### The problem it solves

Perform an operation on each element of a heterogeneous object structure without adding the operation to every element class. Classic Visitor uses double dispatch: `element.accept(visitor)`.

**Java 21 change:** `sealed interface` + **pattern matching `switch`** often replaces Visitor entirely. The "operation" is a method with an exhaustive switch; the compiler checks coverage.

### Java implementation — AST evaluation both ways

**Modern — sealed hierarchy + switch (no Visitor classes):**

```java
public sealed interface Expr permits Literal, Add, Mul {}

record Literal(int value) implements Expr {}
record Add(Expr left, Expr right) implements Expr {}
record Mul(Expr left, Expr right) implements Expr {}

class Evaluator {
    int eval(Expr e) {
        return switch (e) {
            case Literal(int v)           -> v;
            case Add(var l, var r)        -> eval(l) + eval(r);
            case Mul(var l, var r)        -> eval(l) * eval(r);
            // no default — exhaustiveness checked at compile time
        };
    }

    String toSql(Expr e) {
        return switch (e) {
            case Literal(int v)           -> String.valueOf(v);
            case Add(var l, var r)        -> "(" + toSql(l) + " + " + toSql(r) + ")";
            case Mul(var l, var r)        -> "(" + toSql(l) + " * " + toSql(r) + ")";
        };
    }
}
```

**Classic Visitor (when you cannot seal — third-party types, or operations added frequently without modifying switch):**

```java
interface ExprVisitor<T> {
    T visitLiteral(Literal n);
    T visitAdd(Add n);
    T visitMul(Mul n);
}

interface Expr { <T> T accept(ExprVisitor<T> v); }

record Literal(int value) implements Expr {
    public <T> T accept(ExprVisitor<T> v) { return v.visitLiteral(this); }
}
```

### Where Visitor appears

| Example | Structure | Operation |
|---|---|---|
| Compiler AST passes | Expression/statement nodes | Type-check, optimize, codegen |
| `Files.walkFileTree` | `FileVisitor` | Visit files/dirs |
| ASM / Byte Buddy | Class file structure | Transform bytecode |
| Jackson `JsonSerializer` dispatch | Property types | Serialize |
| ANTLR parse tree listeners | Parse nodes | Interpret, lint |
| Document object models | Paragraph, Table, Image | Export HTML, PDF |

### When Visitor is the WRONG choice

- **You own the hierarchy and operations are known.** Sealed + switch is simpler and exhaustiveness-checked.
- **The hierarchy changes weekly.** Every new node type breaks every Visitor — switch is the same problem, but at least localized.
- **One operation, ever.** Put the method on the interface.

**Over-engineering smell:** Visitor with one implementation (`PrintingVisitor`) and no plan for a second operation.

### Production scenario: Visitor for tax calculation broke on every new line item type

**Problem.** Adding `GiftWrapLineItem` required updating five Visitor classes (`TaxVisitor`, `DiscountVisitor`, `ShippingVisitor`, …). A developer updated three of five; gift wrap shipped tax-free for two weeks.

**Cause.** Visitor distributed **business rules across N files** with no compiler help when a new `LineItem` subtype was added (pre-sealed hierarchy, non-exhaustive switches in visitors).

**Solution.** Sealed `LineItem` + one `switch` per concern, or a single `PricingEngine` method that computes all dimensions in one exhaustive switch:

```java
public sealed interface LineItem permits ProductLine, GiftWrapLine, ShippingLine {}

Money taxFor(LineItem item, TaxRules rules) {
    return switch (item) {
        case ProductLine p  -> rules.productTax(p);
        case GiftWrapLine g -> rules.productTax(g);   // same as product — compiler forces you here
        case ShippingLine s -> rules.shippingTax(s);
    };
}
```

Adding a type now produces compile errors in every switch, not silent runtime misses in visitor 4 of 5.

---

## 20. Behavioral — Iterator, Mediator, Memento, Interpreter (brief concrete)

These four appear less often as named patterns in application code today because the JDK or language features subsume them — but interviewers still ask, and the shapes show up in frameworks.

### Iterator

**Problem:** Traverse a collection without exposing its internal structure.

**Java reality:** `Iterable<T>` + enhanced `for` is Iterator built-in. `Stream` is external iteration with laziness.

```java
for (Order o : orderRepository.findByCustomer(id)) { ... }  // Iterator under the hood

// Custom iterable when you wrap a legacy API
record DateRange(LocalDate from, LocalDate to) implements Iterable<LocalDate> {
    @Override
    public Iterator<LocalDate> iterator() {
        return new Iterator<>() {
            LocalDate cur = from;
            public boolean hasNext() { return !cur.isAfter(to); }
            public LocalDate next() {
                if (!hasNext()) throw new NoSuchElementException();
                LocalDate r = cur; cur = cur.plusDays(1); return r;
            }
        };
    }
}
```

**When wrong:** Exposing a raw `Iterator` from a service that could return `Stream` or `List` — callers cannot re-traverse without requesting again.

### Mediator

**Problem:** Many objects talk to each other through a central coordinator instead of N×N references.

**Java reality:** Spring itself is a mediator — components do not `new` each other; the container wires them. Chat room, dialog coordinators, and orchestration services are explicit mediators.

```java
@Component
class BookingMediator {
    private final PaymentService payments;
    private final InventoryService inventory;
    private final NotificationService notify;

    @Transactional
    BookingResult book(BookingRequest req) {
        inventory.hold(req.items());
        var payment = payments.authorize(req.payment());
        var booking = Booking.confirm(req, payment);
        notify.sendConfirmation(booking);
        return new BookingResult(booking);
    }
}
```

**When wrong:** Mediator becomes a **God class** with 2,000 lines orchestrating everything. Split by bounded context or use domain events.

### Memento

**Problem:** Capture and restore object state without breaking encapsulation.

**Java reality:** Serialization snapshots, Git, database `version` columns, undo stacks, JPA `@Version` optimistic locking.

```java
record EditorMemento(String content, int caret) {}

class Editor {
    private String content = "";
    private int caret = 0;

    EditorMemento save() { return new EditorMemento(content, caret); }

    void restore(EditorMemento m) {
        this.content = m.content();
        this.caret = m.caret();
    }
}
```

**When wrong:** Storing full object graphs in mementos on every keystroke — memory explosion. Persist deltas or use event sourcing for audit trails.

### Interpreter

**Problem:** Define a grammar and interpret sentences in it.

**Java reality:** Regex (`Pattern`), SQL parsers, SpEL, OGNL, rule engines (Drools), and **pattern matching switch** over a sealed AST replace hand-rolled Interpreter for most internal DSLs.

```java
// Simple boolean rule DSL: "status=ACTIVE AND tier>2"
public sealed interface Rule permits AndRule, CompareRule {}

record AndRule(Rule left, Rule right) implements Rule {}
record CompareRule(String field, String op, String value) implements Rule {}

boolean eval(Rule rule, Customer c) {
    return switch (rule) {
        case AndRule(var l, var r)              -> eval(l, c) && eval(r, c);
        case CompareRule(var f, var op, var v)  -> compare(c, f, op, v);
    };
}
```

**When wrong:** Building a full parser for five static rules that belong in a database table or config file.

### Combined production scenario: Mediator orchestrator masked partial failure

**Problem.** `OrderOrchestrator` (mediator) called inventory, payment, and shipping in sequence. Shipping API failure left orders `PAID` with inventory held but no shipment — no automatic release.

**Cause.** Mediator had no compensating logic; each step assumed prior steps succeeded. Memento/saga state was not persisted.

**Solution.** Replace sequential mediator calls with a saga: each step has a compensating action; state stored in `order_saga` table (`INVENTORY_HELD`, `PAID`, …). See enterprise patterns (section 23) for outbox/saga notes.

---

## 21. Behavioral — Null Object and Special Case

### The problem it solves

Instead of returning `null` or `Optional.empty()` and forcing every caller to branch, return a **no-op or default implementation** that satisfies the interface with harmless behavior. Special Case (Fowler) extends this to domain-specific sentinel objects like `Customer.UNKNOWN` or `Money.ZERO`.

### Java implementation

```java
public interface Discount {
    Money apply(Money subtotal);
    static Discount none() { return NoneDiscount.INSTANCE; }
}

enum NoneDiscount implements Discount {
    INSTANCE;
    @Override public Money apply(Money subtotal) { return Money.ZERO; }
}

public interface NotificationChannel {
    void send(Message msg);
    static NotificationChannel noop() { return msg -> { /* discard */ }; }
}

@Service
class PromotionService {
    Discount discountFor(Customer c) {
        return promotions.find(c.tier()).orElse(Discount.none());  // never null
    }

    void notifyCustomer(Customer c, Message msg) {
        channelFor(c).send(msg);   // noop channel if unsubscribed — no if (channel != null)
    }
}
```

JDK examples: `Collections.emptyList()`, `Optional.empty()` (not quite Null Object but same motivation), `Reader.nullReader()`, `OutputStream.nullOutputStream()` (Java 11).

### When Null Object is the WRONG choice

- **Failure is exceptional and must not be silent.** Returning a noop `PaymentGateway` that "succeeds" is catastrophic. Use `Optional` or throw.
- **Callers need to distinguish "missing" from "present".** Null Object hides the distinction; use explicit types.
- **The noop implementation violates LSP** — e.g. a `ReadOnlyRepository` that throws on write instead of no-op write confuses callers.

**Over-engineering smell:** `NullCustomerNullObject extends AbstractCustomer` hierarchy when `Optional<Customer>` or empty result type is clearer.

### Production scenario: null object logger swallowed production errors

**Problem.** When SLF4J found no binding, it bound to `NOPLogger`. A mis-packaged Docker image ran for weeks with all error logs discarded. Incident response had no logs.

**Cause.** Null Object (`NOP`) is correct for library defaults but **wrong as a silent production default** when observability is required. The team assumed `@Slf4j` guaranteed a binding; fat-jar merge dropped `logback-classic`.

**Solution.** Fail fast at startup if no logging backend in production profile:

```java
@EventListener(ApplicationReadyEvent.class)
void assertLoggingBackend() {
    if (LoggerFactory.getILoggerFactory().getClass().getName().contains("NOP")) {
        throw new IllegalStateException("No SLF4J binding — logging disabled");
    }
}
```

Domain code: prefer explicit `Optional` for missing entities; reserve Null Object for **safe no-op behavior** (discount = zero, metrics = no-op registry in unit tests).

---

## 22. Concurrency Patterns

These are not GoF patterns but production shapes every senior Java engineer uses alongside the catalog.

### Active Object / Executor proxy

Decouple method invocation from execution by submitting work to an executor. Virtual threads (Java 21) make "one thread per task" cheap for blocking IO.

```java
@Bean
ExecutorService virtualThreadExecutor() {
    return Executors.newVirtualThreadPerTaskExecutor();
}

@Service
class AsyncNotifier {
    private final ExecutorService executor;

    void sendAsync(Email email) {
        executor.submit(() -> mailer.send(email));   // fire-and-forget with error handler
    }
}
```

### Producer-Consumer

```java
BlockingQueue<Task> queue = new LinkedBlockingQueue<>(10_000);

// producer
void submit(Task t) throws InterruptedException {
    queue.put(t);   // backpressure when full
}

// consumer loop
void drain() {
    while (running) {
        Task t = queue.take();
        process(t);
    }
}
```

Spring `@Async` + bounded queue on the executor prevents unbounded memory growth.

### Read-Write Lock

```java
ReadWriteLock rw = new ReentrantReadWriteLock();

Map<String, Config> cache;

Config get(String key) {
    rw.readLock().lock();
    try { return cache.get(key); }
    finally { rw.readLock().unlock(); }
}

void refresh(Map<String, Config> newConfig) {
    rw.writeLock().lock();
    try { cache = newConfig; }
    finally { rw.writeLock().unlock(); }
}
```

`StampedLock` for read-heavy with occasional writes — but harder to get right.

### Double-checked locking / immutable holder

See section 2 (Singleton). Prefer `record Holder(T value)` initialized once in `@PostConstruct` or lazy holder idiom for immutable caches.

### Thread-local context (use sparingly)

```java
// MDC for logging — always clear in finally
MDC.put("tenantId", tenant.id());
try { log.info("processing"); }
finally { MDC.remove("tenantId"); }
```

**Leak pattern:** thread pools + `ThreadLocal` without cleanup → wrong tenant in logs (and data) on reused threads.

### When concurrency patterns hurt

- **`synchronized` on hot paths** — measure; use lock-free structures or split locks.
- **Virtual threads + pinned carriers** — synchronized block inside JDK socket code pins carrier; use ReentrantLock in new code on VT paths if profiling shows pinning.
- **Double-checked locking without `volatile`** — broken on Java memory model.

### Production scenario: shared SimpleDateFormat in flyweight pool

**Problem.** Under load, API responses showed dates from other users' timezones. Stack traces included `ArrayIndexOutOfBoundsException` in `SimpleDateFormat.format`.

**Cause.** `DateFormat` instances cached in a static `ConcurrentHashMap` (Flyweight, section 12) and shared across threads. `SimpleDateFormat` is not thread-safe.

**Solution.** `DateTimeFormatter` (immutable, thread-safe) or `ThreadLocal<SimpleDateFormat>` with cleanup. Better: never use `Date`/`SimpleDateFormat` in new code — use `java.time`.

---

## 23. Enterprise/Architecture Patterns (Repository, DTO, DI, etc.)

GoF patterns operate at class level. Enterprise patterns operate at **system** level. Spring Boot is essentially an opinionated implementation of many of them.

### Repository

Encapsulates persistence; domain speaks in aggregates, not SQL.

```java
public interface OrderRepository {
    Optional<Order> findById(OrderId id);
    Order save(Order order);
    List<Order> findByCustomer(CustomerId customer, PageRequest page);
}

@Repository
class JpaOrderRepository implements OrderRepository {
    private final OrderJpaRepository jpa;

    @Override
    public Optional<Order> findById(OrderId id) {
        return jpa.findById(id.value()).map(OrderMapper::toDomain);
    }
}
```

**When wrong:** Repository per table with 40 methods returning JPA entities everywhere — leak ORM into services. **When right:** One repository per aggregate root; map to domain inside.

### DTO (Data Transfer Object)

Carries data across boundaries — REST, messaging, layers — without behavior. Records are ideal.

```java
public record OrderResponse(OrderId id, String status, Money total, Instant placedAt) {
    static OrderResponse from(Order order) {
        return new OrderResponse(order.id(), order.status().name(), order.total(), order.placedAt());
    }
}
```

**When wrong:** DTO mapped to DTO mapped to DTO through six layers with identical fields. **When right:** Boundary at the API; domain objects stay inside the service layer.

### Dependency Injection (DI)

Objects receive collaborators via constructor; a container (Spring) assembles the graph.

```java
@Service
class OrderService {
    private final OrderRepository orders;
    private final ApplicationEventPublisher events;

    OrderService(OrderRepository orders, ApplicationEventPublisher events) {
        this.orders = orders;
        this.events = events;
    }
}
```

**When wrong:** `@Autowired` field injection in everything; `new` inside services for beans; circular dependencies "fixed" with `@Lazy`. **When right:** Constructor injection, interfaces at boundaries, `@ConfigurationProperties` for config.

### Service Layer / Facade (section 10)

Coordinates domain logic and transactions. One `@Transactional` service method per use case is a common shape.

### Unit of Work

JPA `EntityManager` / Spring `@Transactional` — a transaction scopes a consistent persistence flush. Do not call `save()` after every line; let the transaction commit once.

### Outbox Pattern

Reliable publish-after-commit: write event to `outbox` table in same TX as domain write; separate poller publishes to Kafka.

```java
@Transactional
void placeOrder(Order order) {
    orders.save(order);
    outbox.enqueue(new OrderPlaced(order.id()));   // same transaction
}
```

### Saga / Process Manager

Long-running distributed transactions via compensating steps. Prefer workflow engine when sagas exceed three steps with timeouts.

### Anti-Corruption Layer (section 7 Adapter)

Wrap external API models; never let vendor JSON types into domain.

### Production scenario: anemic domain + DTO explosion

**Problem.** `OrderService` had 1,400 lines. Every method accepted `OrderRequestDTO` and returned `OrderResponseDTO`. Business rules lived in static `OrderUtil` classes. Bugs recurred because invariants were enforced differently in create vs update paths.

**Cause.** DTO and Service Layer patterns were applied without a **domain model**. Repository returned JPA entities directly mutated in controllers.

**Solution.** Rich domain `Order` with behavior; DTO only at REST boundary; repository returns domain types. Service methods become thin:

```java
@Transactional
OrderId place(PlaceOrderCommand cmd) {
    var order = Order.create(cmd);
    orders.save(order);
    events.publish(new OrderPlaced(order.id()));
    return order.id();
}
```

Line count dropped because rules lived in one place.

---

## 24. Anti-Patterns

Recognizing anti-patterns is as important as applying patterns. These recur in Java/Spring codebases.

| Anti-pattern | What it looks like | Why it hurts | Fix |
|---|---|---|---|
| **Golden Hammer** | Every problem gets a Factory/Strategy | Complexity tax on simple code | Plain method until second variation |
| **God Object** | `ApplicationManager` 5k lines | Untestable, merge conflicts | Split by bounded context |
| **Anemic Domain Model** | Entities are getters/setters; logic in services | Invariants scattered | Move behavior to aggregates |
| **Cargo Cult DI** | Interface with one impl "for testing" | Indirection without benefit | Concrete class until needed |
| **Singleton abuse** | Static mutable state everywhere | Hidden deps, test pollution | Spring bean scope or explicit context |
| **Exception-driven flow** | `try/catch` for business branches | Slow, unclear control flow | Return `Result` type or Optional |
| **Magic Singleton cache** | `static Map` of everything | Memory leaks, stale data | Caffeine with bounds + TTL |
| **Lombok @Data on entities** | `equals`/`hashCode` on JPA entity with collections | Infinite loops, data corruption | `@Getter` only; identity equals |
| **Parallel streams for IO** | `list.parallelStream().map(this::httpCall)` | Pool starvation | Virtual threads / bounded executor |
| **Field injection** | `@Autowired` private fields | Untestable without Spring | Constructor injection |
| **Transaction on private method** | `@Transactional` on `private void` | Proxy bypass — no TX | Public method on Spring bean |
| **Self-invocation** | `this.save()` inside same `@Service` | AOP bypass | Inject self or split bean |
| **Stringly typed** | `"ACTIVE".equals(status)` everywhere | Typos, no exhaustiveness | Enum or sealed type |
| **Premature microservices** | 12 services for 12 endpoints | Distributed monolith pain | Modular monolith first |
| **Copy-paste Decorator** | Retry logic in every client | Drift, inconsistent backoff | Shared decorator or Resilience4j |

### Production scenario: @Transactional on private method — partial commits

**Problem.** Money transferred between internal accounts but audit log missing intermittently. Reconciliation showed unbalanced ledger entries.

**Cause.**

```java
@Service
class TransferService {
    @Transactional
    public void transfer(AccountId from, AccountId to, Money amount) {
        ledger.debit(from, amount);
        doCreditAndAudit(to, amount);   // private — NOT proxied
    }

    @Transactional
    private void doCreditAndAudit(AccountId to, Money amount) {
        ledger.credit(to, amount);
        audit.log(...);   // separate TX or none — failure left debit committed
    }
}
```

Spring AOP proxies only intercept **public** methods on the proxied bean. Self-invocation skips the proxy entirely.

**Solution.** One `@Transactional` public method with all steps, or extract `AuditService` as separate bean with `REQUIRES_NEW` if audit must commit independently.

---

## 25. Pattern Selection Guide

Use this when reviewing a design or answering "which pattern?" in an interview. Start from the **problem shape**, not the pattern name.

### Step 1 — What kind of change is coming?

| If the variation is… | Lean toward… |
|---|---|
| Algorithm / policy | Strategy (`Function`, sealed interface) |
| Steps in fixed order | Template Method (or lambda pipeline) |
| Notify many listeners | Observer (events, broker) |
| Request as object (undo, queue) | Command |
| Pipeline of checks | Chain of Responsibility |
| Object behavior by lifecycle phase | State (sealed + switch) |
| Operation on many node types | Visitor or sealed switch |
| Wrap external API | Adapter |
| Add behavior without subclass explosion | Decorator |
| Lazy / access control / remote | Proxy |
| Simplify complex subsystem | Facade |
| Tree structures | Composite |
| Two independent axes of variation | Bridge |
| Millions of similar instances | Flyweight (carefully) |
| Object creation complexity | Builder, Factory |
| Cross-layer data | DTO |
| Persistence hiding | Repository |

### Step 2 — Apply the three questions (section 1)

1. Has it actually varied yet?
2. Will a stranger add the next case?
3. Is a Map/enum/lambda enough?

### Step 3 — Prefer platform idioms

| Old pattern textbook | Modern Java / Spring |
|---|---|
| Strategy interface + impl | `Function` / sealed interface |
| Observer manual list | `ApplicationEventPublisher` |
| Template Method subclass | `JdbcTemplate` + lambda |
| Visitor | Sealed + switch |
| Singleton | Spring bean / enum |
| Factory hierarchy | `@Bean` method + `@ConditionalOnProperty` |

### Step 4 — Red flags to stop

- Pattern name in five class names in one feature.
- More interfaces than call sites.
- Abstraction introduced before second implementation shipped.
- Pattern chosen to "prepare for microservices" with one deployment unit.

---

## 26. Production Debugging Playbook

When behavior is "wrong only sometimes," patterns often mean **indirection** — the bug is in wiring, order, or shared state.

| Symptom | Likely pattern-related cause | First move |
|---|---|---|
| Wrong behavior for some IDs only | Flyweight / boxed `==` | Search `==` on `Integer`/`Long`; use value types |
| Double charge / duplicate side effect | Command retried without idempotency | Log idempotency key; check `@Retryable` |
| Rollback but external API succeeded | Observer in same TX; saga missing | `@TransactionalEventListener(AFTER_COMMIT)` |
| `@Transactional` "doesn't work" | Self-invocation or private method | Call through injected bean; public method |
| Filter/security bypass | Chain order wrong | Integration test all secured paths |
| Missing logs / wrong tenant | ThreadLocal / MDC leak | `finally { MDC.clear() }`; audit pool threads |
| Illegal state transition | State scattered in `if` | Centralize transitions; DB constraint |
| New subtype → wrong totals | Non-exhaustive Visitor/switch | Sealed hierarchy + compile errors |
| Memory grows unbounded | Unbounded Flyweight pool | Heap dump dominators; add eviction |
| "Works in dev, fails in prod" | Singleton static mutable state | Search `static` fields; Spring scope |

### Diagnostic checklist

1. **Draw the call path** from HTTP entry to side effect. Count proxies, filters, listeners.
2. **Identify transaction boundary** — what commits together?
3. **Search for `static` mutable** and shared formatters/caches.
4. **Reproduce under load** — race bugs hide in ThreadLocal and Flyweight.
5. **Enable DEBUG for Spring event publication** — see listener order and failures.
6. **Breakpoint on implementation, not interface** — know which Strategy instance is wired (`@Primary`, `@Qualifier`).

```java
// Quick: who is the bean?
@Autowired ApplicationContext ctx;

void debug() {
    System.out.println(ctx.getBean(PaymentGateway.class).getClass());
}
```

---

## 27. Quick Decision Matrix

| Situation | Reach for | Avoid |
|---|---|---|
| One algorithm, might be two someday | Plain method; extract when second arrives | Strategy hierarchy day one |
| Sort orders three different ways | `Comparator` lambdas | `AbstractOrderSorter` |
| Post-commit email | `@TransactionalEventListener` | Sync `@EventListener` in TX |
| Retry HTTP call | Decorator or Resilience4j | Copy-paste retry in every client |
| 15 validation rules on DTO | Bean Validation annotations | 15-chain `@Order` handlers |
| Finite order states (<10) | Sealed interface + switch | State class per status + factory |
| New line item type monthly | Sealed `LineItem` + exhaustive switch | Visitor forest |
| External SOAP service | Adapter | Rewrite vendor API in domain |
| Cache + metrics + retry on client | Decorator stack | Subclass explosion |
| Two dimensions vary (UI × OS) | Bridge | `if (platform)` in every widget |
| Millions of glyph objects | Flyweight + immutability | `new Glyph()` per character |
| Complex object graph construction | Builder (or record compact ctor) | 12-arg constructor |
| Hide JPA from domain | Repository + mapper | Entity in controller |
| API response shape | Record DTO at boundary | Expose entity JSON |
| Cross-service event | Outbox + Kafka | In-process Observer only |
| Optional config missing | Throw or `Optional` | Null Object that silently no-ops |
| Test needs no SMTP | `NotificationChannel.noop()` | null checks everywhere |
| Debugging "which impl ran?" | `@ConditionalOnProperty` + actuator beans | Guess from logs |

---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>Q1. Strategy vs if/else — when does each win?</summary>

**Strategy wins** when multiple algorithms are owned by different teams, selected at runtime from config, or tested independently — e.g. payment flows per PSP. **if/else wins** when there are two branches that will not grow, or when the variation is a constant lookup (`switch` on enum). In Java 17+, a sealed interface with three records is often clearer than a Strategy interface with three impl classes in the same package.

</details>

<details class="qa-item">
<summary>Q2. Why is java.util.Observable deprecated?</summary>

It required extending `Observable` (composition unfriendly), notification happened before state was consistent, and it was not generic. Use Spring events, `Flow`, or reactive streams instead. For domain events inside a monolith, `ApplicationEventPublisher` + immutable record events is the modern replacement.

</details>

<details class="qa-item">
<summary>Q3. Template Method vs Strategy — what's the difference?</summary>

**Template Method** fixes the **sequence** of steps and varies one or two hooks (inheritance or lambdas). **Strategy** replaces an entire **algorithm** while the caller's structure stays the same. JdbcTemplate is Template Method (fixed JDBC lifecycle, variable mapping). Comparator is Strategy (entire comparison swapped).

</details>

<details class="qa-item">
<summary>Q4. Command vs Strategy?</summary>

Both encapsulate behavior. **Command** emphasizes ** invocation as a request**: queue, log, undo, authorize, idempotency. **Strategy** emphasizes ** interchangeable algorithms** for the same operation. `Runnable` is a Command; `Comparator` is a Strategy. If you need `undo()` or audit metadata, Command; if you need swap-at-injection-time, Strategy.

</details>

<details class="qa-item">
<summary>Q5. When should @EventListener be async?</summary>

When the listener's failure must **not** roll back the publisher, and stale reads are acceptable (email, analytics). Never `@Async` a listener that must enforce invariants on the same aggregate unless you design for eventual consistency and compensations. Prefer `@TransactionalEventListener(AFTER_COMMIT)` over `@Async` when the issue is transaction boundaries, not thread blocking.

</details>

<details class="qa-item">
<summary>Q6. Chain of Responsibility vs Decorator?</summary>

**Chain:** each link may **stop** propagation (filter returns 401 without calling `chain.doFilter`). **Decorator:** every layer **must** delegate to the inner object; you wrap, not short-circuit (unless the decorator intentionally blocks). Filters are chains; `CachingProductCatalog` is a decorator.

</details>

<details class="qa-item">
<summary>Q7. State pattern vs enum with behavior?</summary>

Use **enum with methods** when states are fixed, transitions are simple, and no subclass per state is needed. Use **sealed interface State objects** when each state carries data or collaborators. Use a **workflow engine** when transitions have timeouts, human approval, or persist across restarts.

</details>

<details class="qa-item">
<summary>Q8. Visitor vs sealed switch in Java 21?</summary>

**Sealed + switch:** you own the hierarchy; operations are methods with exhaustiveness checking — preferred for internal ASTs. **Visitor:** third-party classes you cannot seal, or plugins adding operations without recompiling the switch. Compiler checks exhaustiveness only on sealed switches in your module.

</details>

<details class="qa-item">
<summary>Q9. Null Object vs Optional?</summary>

**Optional** means "may be absent" — callers choose how to handle absence. **Null Object** means "always present" but behavior is harmless default (zero discount, noop channel). Never use Null Object for missing entities where wrong silent behavior is dangerous (payment gateway, authentication).

</details>

<details class="qa-item">
<summary>Q10. Why did Flyweight break our Integer tier lookup?</summary>

Autoboxing caches `Integer` values in [-128, 127]. `==` compares identity, so map keys and lookup arguments match only inside the cache range. Fix: value types (`record TierId(int value)`), always use `equals`, enable static analysis for reference equality on boxed types.

</details>

<details class="qa-item">
<summary>Q11. Repository vs DAO?</summary>

**DAO** is often table-centric CRUD. **Repository** is **aggregate-centric** — one per root entity, speaks domain language (`findByCustomer`), hides persistence technology. In Spring Data, `@Repository` interfaces are repositories; don't expose them to controllers — map to domain/DTO at the service boundary.

</details>

<details class="qa-item">
<summary>Q12. Why doesn't @Transactional work on my private method?</summary>

Spring uses runtime proxies (JDK or CGLIB). Only **public** methods on the **proxied bean** invoked **through the proxy** get advice. Private methods and `this.privateMethod()` self-calls bypass the proxy. Fix: public transactional method on a Spring bean, or inject self interface.

</details>

<details class="qa-item">
<summary>Q13. Decorator vs Proxy?</summary>

**Decorator** adds behavior (cache, metrics) — same interface, enriched semantics. **Proxy** controls **access** (lazy init, security, remote stub) — often defers or guards. In practice both wrap a delegate; intent differs. CGLIB transactional proxy is technically Proxy; Micrometer timer wrapper is Decorator.

</details>

<details class="qa-item">
<summary>Q14. How does Spring relate to Mediator?</summary>

The DI container mediates dependencies — components don't locate each other. An `@Service` orchestrator that calls `inventory`, `payment`, and `notify` is an explicit domain mediator. Avoid one mediator class owning every workflow; split by use case.

</details>

<details class="qa-item">
<summary>Q15. Iterator vs Stream?</summary>

**Iterator** / enhanced for: simple traversal, possibly mutable source, early break with `break`. **Stream**: lazy pipelines, functional transforms, collectors — not for mutating elements in place. Don't store a `Stream` in a field; it's single-use.

</details>

<details class="qa-item">
<summary>Q16. Memento vs event sourcing?</summary>

**Memento** snapshots state for undo/restore — point-in-time copy. **Event sourcing** stores the log of changes; state is derived by replay. Event sourcing scales audit and temporal queries; memento suits editor undo stacks. JPA `@Version` is optimistic-lock memento-lite, not full history.

</details>

<details class="qa-item">
<summary>Q17. Double-checked locking — still relevant?</summary>

For singletons, prefer **enum**, **holder idiom**, or **Spring bean**. If you hand-roll lazy init, you need `volatile` (or static holder) for publication safety. Connection pools and registries should be container-managed, not static DCL.

</details>

<details class="qa-item">
<summary>Q18. When is parallelStream the wrong choice?</summary>

Small collections, ordered side effects, blocking IO on the common pool, or non-thread-safe shared state. Use sequential streams, virtual threads with a semaphore for bounded IO concurrency, or an explicit executor you control.

</details>

<details class="qa-item">
<summary>Q19. Abstract Factory vs Factory Method in Spring?</summary>

**Factory Method:** one product, one creation method (`@Bean PaymentGateway stripeGateway()`). **Abstract Factory:** family of related products (`AwsClients`: S3 + SQS + SNS from one config). Use `@Configuration` classes with `@ConditionalOnProperty` for environment-specific families.

</details>

<details class="qa-item">
<summary>Q20. How to test Strategy implementations?</summary>

Inject the strategy under test directly — no factory unless factory logic is what you're testing. Use parameterized tests with one case per implementation. For lambdas passed to services, test the service with different lambda arguments.

</details>

<details class="qa-item">
<summary>Q21. Composite pattern in Spring Security?</summary>

`SecurityFilterChain` is a composite of filters — uniform `Filter` interface, composed list, `doFilter` delegates down the chain. Same shape as UI component trees and file system `FileVisitor` — treat as tree/composite when nodes and leaves share an interface.

</details>

<details class="qa-item">
<summary>Q22. Outbox vs Observer for domain events?</summary>

**Observer** (`ApplicationEventPublisher`) is in-process, same JVM, lost on crash before handlers run. **Outbox** persists the event in the DB transaction, then async relay to Kafka — survives restarts, enables cross-service consumers. Use Observer for local side effects; outbox for integration events.

</details>

<details class="qa-item">
<summary>Q23. Special Case pattern example?</summary>

`Discount.NONE` returning zero, `Customer.GUEST` with read-only permissions, `Collections.emptyList()` instead of null. Distinguished from Null Object: Special Case often carries **domain meaning** (guest user), not just no-op behavior.

</details>

<details class="qa-item">
<summary>Q24. Interpreter vs rule engine?</summary>

Hand-rolled Interpreter (sealed AST + eval) suits **small, stable grammars** you own. Drools/JSON rules suit **business-owned rules** changing weekly without deploy. Don't build a parser for five rules storable in a database column.

</details>

<details class="qa-item">
<summary>Q25. Anti-pattern: interface with one implementation?</summary>

Often **cargo cult DI** — the interface adds indirection without a second implementation or test double need. Acceptable when the interface marks a **boundary** (port in hexagonal architecture) or when JDK/proxy needs an interface. Otherwise use concrete class until pain appears.

</details>

<details class="qa-item">
<summary>Q26. How to debug wrong Spring bean wired?</summary>

Check `@Primary`, `@Qualifier`, `@ConditionalOnProperty`, profile-specific `@Configuration`. Use Actuator `/beans` or `ctx.getBean(PaymentGateway.class).getClass()`. Breakpoint in constructor of suspected impl. `@MockBean` in tests can hide wiring bugs — verify integration test uses real config slice.

</details>

<details class="qa-item">
<summary>Q27. Bridge vs Adapter?</summary>

**Bridge** splits one abstraction into **two intentional axes** designed together (UI × rendering). **Adapter** fixes **one mismatch** between existing incompatible interfaces (legacy SOAP → your `PaymentGateway`). Adapter is retrofit; Bridge is upfront dual hierarchy.

</details>

<details class="qa-item">
<summary>Q28. Saga vs single @Transactional?</summary>

**Single TX** when all resources share one database. **Saga** when steps cross services/DBs with compensations (cancel shipment if payment fails). Local TX + outbox is the middle ground for at-least-once publish. Two-phase commit across microservices is rare; sagas are the practical pattern.

</details>

<details class="qa-item">
<summary>Q29. When does Builder beat a constructor?</summary>

Optional fields with validation rules, cross-field constraints, or readable call sites for objects with many parameters. Records with compact constructors cover many cases. Lombok `@Builder` on JPA entities is an anti-pattern — managed fields and relationships don't belong in builder-heavy graphs without care.

</details>

<details class="qa-item">
<summary>Q30. Pattern names in class names — always wrong?</summary>

Not always — `RetryingClient` describes **behavior** (decorator role). Wrong when names are pure pattern vocabulary without domain meaning: `OrderStrategyFactoryProvider`. Name after domain capability; pattern is implementation detail visible in structure, not necessarily in the type name.

</details>
