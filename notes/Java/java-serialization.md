# Java Serialization & Data Formats — Senior Production Reference

Java 17/21, Spring Boot 3.x, Jackson 2.x, Redis 7.x. This is not a tutorial on `implements Serializable`. It is the map of what actually breaks in production when teams treat byte streams as "just caching" or paste `ObjectOutputStream` into a microservice because it was fast in a spike.

Native Java serialization still exists in session replication, RMI legacies, JMS object messages, some Spring Session Redis defaults, and every CVE write-up since 2015. Modern systems should default to **schema-first, text-or-protobuf formats with explicit versioning**. This note tells you when native serialization is still unavoidable, how to harden it, and how to migrate without a big-bang deploy.

---

## Table of Contents

1. [Mental Model: Bytes, Types, and Trust Boundaries](#1-mental-model-bytes-types-and-trust-boundaries)
2. [Java Native Serialization](#2-java-native-serialization)
3. [serialVersionUID](#3-serialversionuid)
4. [Custom Serialization Hooks](#4-custom-serialization-hooks)
5. [transient and Field Control](#5-transient-and-field-control)
6. [Singleton, Enum, and Immutable Types](#6-singleton-enum-and-immutable-types)
7. [Deserialization Security & ObjectInputFilter](#7-deserialization-security-objectinputfilter)
8. [JSON as a Serialization Format](#8-json-as-a-serialization-format)
9. [Protocol Buffers](#9-protocol-buffers)
10. [Apache Avro](#10-apache-avro)
11. [Schema Evolution Comparison](#11-schema-evolution-comparison)
12. [Distributed Systems Context](#12-distributed-systems-context)
13. [Rolling Deploy Compatibility](#13-rolling-deploy-compatibility)
14. [Performance & Footprint](#14-performance-footprint)
15. [Testing Serialization](#15-testing-serialization)
16. [Spring Data Redis & Session Serializers](#16-spring-data-redis-session-serializers)
17. [Production Debugging Playbook](#17-production-debugging-playbook)
18. [Quick Decision Matrix](#18-quick-decision-matrix)

---


## 1. Mental Model: Bytes, Types, and Trust Boundaries

Serialization is **turning an in-memory object graph into bytes** so it can be stored, sent over the network, or read by another process. Deserialization is the inverse — and the inverse is where production incidents live.

```
Application object graph
  └─ Serializer (Java native / Jackson / Protobuf / Avro)
       └─ bytes (file, Redis, Kafka, HTTP body, session store)
            └─ Deserializer (possibly different version, different service)
                 └─ object graph in another JVM / another release
```

Three axes that every senior decision hangs on:

| Axis | Question | Wrong default |
|---|---|---|
| **Format** | Self-describing (JSON) vs compact binary (Protobuf) vs Java-specific (native) | Native serialization "because it's built in" |
| **Schema** | Explicit `.proto` / Avro schema / OpenAPI vs implicit Java class shape | "We'll just deploy both services together" |
| **Trust** | Who produced these bytes? | Deserializing untrusted input with `ObjectInputStream` |

Native Java serialization embeds **class names, field names, and type tags** in the stream. That makes it reflective, verbose, and **executable** in the wrong hands (gadget chains). JSON and Protobuf are not automatically safe either — polymorphic Jackson types and `readValue` into `Object` recreate the same class of bug — but they are easier to reason about and filter.

Deserialization is **not parsing**. Parsing validates syntax. Deserialization **instantiates classes and runs constructors, readObject hooks, and in some frameworks static initializers**. Treat every deserializer as executing code supplied by the byte producer.

### The five failure modes you will see in incidents

1. **`InvalidClassException`** — `serialVersionUID` mismatch or incompatible class change across a rolling deploy.
2. **`NotSerializableException`** — a new field type or nested object wasn't marked or replaced.
3. **`ClassCastException` after read** — same class name, different classloader (WAR redeploy, OSGi, plugin systems).
4. **Silent corruption** — session/blob deserialized into an object that "works" but has wrong defaults (added field = primitive default, missing enum value = null or exception on use).
5. **Remote code execution** — untrusted bytes + native deserialization or polymorphic JSON → gadget chain.

### Production scenario: "Redis cache worked until we added a field"

**Problem.** A Spring Boot monolith stores `UserSession` in Redis with JDK serialization (default in older Spring Session setups). Team adds `Instant lastActivity` to `UserSession`. Rolling deploy: half the pods write the new shape, half read with old code. Users get random logouts, `InvalidClassException` in logs, support tickets spike.

**Cause.** JDK serialization is **brittle to class changes** unless you manage `serialVersionUID`, optional fields, and custom hooks — and even then rolling deploys need a **dual-read** period or cache flush.

**Solution (immediate).** Flush session keys on deploy or bump key namespace (`session:v2:`). **Solution (durable).** Migrate to JSON (Jackson) or a versioned DTO with explicit schema; never store live entity graphs.

---

## 2. Java Native Serialization

### Core concept

`java.io.Serializable` is a **marker interface**. It promises the JVM may serialize instances using default mechanism: walk non-transient, non-static fields recursively, write class metadata + field values to an `ObjectOutputStream`.

```java
public class OrderSnapshot implements Serializable {
    private static final long serialVersionUID = 1L;

    private final long orderId;
    private final String sku;
    private final BigDecimal amount; // BigDecimal is Serializable

    public OrderSnapshot(long orderId, String sku, BigDecimal amount) {
        this.orderId = orderId;
        this.sku = sku;
        this.amount = amount;
    }
}

// write
try (ObjectOutputStream oos = new ObjectOutputStream(new FileOutputStream("order.bin"))) {
    oos.writeObject(new OrderSnapshot(42L, "WIDGET", new BigDecimal("19.99")));
}

// read
try (ObjectInputStream ois = new ObjectInputStream(new FileInputStream("order.bin"))) {
    OrderSnapshot snap = (OrderSnapshot) ois.readObject();
}
```

Nothing in the language forces you to define `serialVersionUID`; if you omit it, the compiler synthesizes one from field signatures. **Any field rename, type change, or modifier change changes the synthetic UID** → `InvalidClassException` on read.

### Internal working (what actually gets written)

For each object in the graph:

1. **Stream magic** `0xAC 0xED`, version `0x05`.
2. **TC_OBJECT** block: class descriptor (name, `serialVersionUID`, field descriptors, flags).
3. **Field values** in declaration order (for default serialization).
4. **Handles** for back-references to avoid cycles blowing the stream.

The deserializer:

1. Loads class by name from the stream (`Class.forName` semantics).
2. Checks `serialVersionUID` against the local class.
3. Allocates instance **without running constructors** (except special cases).
4. Wires fields, then runs `readObject` if present.

That "no constructor" rule is why singletons break and why security people hate it: attacker-controlled field wiring + gadget `readObject` methods = RCE.

### What is Serializable in the JDK (common surprises)

| Type | Serializable? | Gotcha |
|---|---|---|
| `String`, wrappers, `BigDecimal`, `Date`, `Instant` (Java 8+) | Yes | Prefer immutable types |
| `Enum` | Yes | By name; reordering constants is OK; renaming breaks |
| `Optional` | **No** | Don't put in entity/session; use null or separate field |
| `Path`, `Stream`, `ThreadLocal` | **No** | Obvious after first incident |
| `Logger` | **No** | `transient` or recreate on read |
| Collections from `List.of()` | Serializable impl may differ | Content must be Serializable |
| Hibernate proxies | **Dangerous** | Lazy collections, `$$_javassist_` classes |
| Spring AOP proxies | **Not** the bean you think | Serialize DTO, not `@Transactional` service |

### Production scenario: serializing a JPA entity to "save API calls"

**Problem.** Developer caches `Order` entity (with `@ManyToOne Customer`, lazy `LineItem` list) in Hazelcast via Java serialization. First request works. Second request on another node: `NotSerializableException` or worse, serializes a **detached graph** that re-attaches badly.

**Cause.** ORM entities are object graphs tied to persistence context, not DTOs. Proxies and lazy fields are not stable serialization citizens.

**Solution.** Cache `OrderView` record/DTO built from the entity at the service boundary. One direction: entity → DTO → bytes. Never bytes → entity → DB without explicit merge semantics.

```java
public record OrderView(long id, String customerName, List<LineView> lines) implements Serializable {
    private static final long serialVersionUID = 1L;
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `implements Serializable` on domain entity | LazyInit, huge graphs, `InvalidClassException` on schema change |
| No `serialVersionUID` on long-lived persisted type | Random logouts after any field tweak |
| Serializing `Throwable` or exception cause chains | Massive blobs, classloader leaks in logs pipeline |
| Using Java serialization across service boundaries | Coupling, security, versioning pain |
| `ObjectOutputStream` without resetting for repeated writes | Handle table growth, memory leak in long-lived stream |

### Debugging scenario

**Observe.** `NotSerializableException: com.acme.metrics.RequestTimer` when saving session.

**Diagnose.** Walk the object graph. Quick and dirty:

```java
void assertSerializable(Object root) throws Exception {
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    try (ObjectOutputStream oos = new ObjectOutputStream(bos)) {
        oos.writeObject(root);
    }
}
```

Better: custom `ObjectOutputStream` override `replaceObject` / `annotateClass` to log class names, or use Apache Commons Lang `SerializationUtils` in tests only.

**Fix.** Mark non-serializable fields `transient` and restore in `readObject`, or replace with a DTO that only contains serializable leaves.

### Object graph traversal rules

Default serialization walks **non-transient instance fields** depth-first. Cycles are handled via stream handles (same object written once, referenced by handle id on second encounter). Understanding this explains:

- **Stack overflow** on pathological deep graphs (linked list millions of nodes) — use `maxdepth` filter or flatten DTO.
- **Duplicate subgraph serialization** if two fields point to same mutable object — deserialized graph shares references (usually desired).
- **Parent pointer cycles** in trees — OK with handles; custom `writeObject` rarely needed.

```java
public class Node implements Serializable {
    private static final long serialVersionUID = 1L;
    Node parent; // cycle back — handled by JDK handles
    List<Node> children = new ArrayList<>();
}
```

### writeReplace at the stream level

`writeReplace` on the object can substitute a **serial proxy** before bytes hit the wire — pattern used by `ArrayList`, `EnumSet`, etc. in the JDK. Application code rarely needs this unless you are implementing a collection-like type.

```java
private Object writeReplace() throws ObjectStreamException {
    return new SerializationProxy(this);
}

private static class SerializationProxy implements Serializable {
    private static final long serialVersionUID = 1L;
    private final byte[] canonicalForm;
    // ...
}
```

### Arrays and serialization

Arrays are Serializable if component type is Serializable. **Multi-dimensional arrays** require every level's component type to be Serializable. `byte[]` is common for blobs; prefer **not** wrapping huge `byte[]` inside a session object — store reference (S3 key, file id) instead.

| Array type | Serializable? |
|---|---|
| `byte[]` | Yes |
| `Object[]` holding `String` | Yes |
| `Object[]` holding mixed non-Serializable | **No** at write time |
| `Optional[]` | Component `Optional` is not Serializable |

### Production scenario: ArrayList vs CopyOnWriteArrayList in session

**Problem.** Session stores `CopyOnWriteArrayList<Permission>` for "thread safety." Serialization works, but blob is **O(n²)** on each write because COW copies backing array on mutation — and session replication serializes on every request attribute change.

**Fix.** Use immutable `List.copyOf(permissions)` in a DTO snapshot at login time; mutate session only when permissions actually change, not on every read.

---

## 3. serialVersionUID

### Core concept

`serialVersionUID` is a **`long` that names the shape** the stream expects. On deserialize, local class UID must equal stream UID or you get:

```
java.io.InvalidClassException: com.acme.UserSession;
local class incompatible: stream classdesc serialVersionUID = 1, local class serialVersionUID = 2
```

### Rules that survive code review

1. **Always declare explicitly** on any class that crosses a persistence boundary (session, disk, queue).
2. **Bump intentionally** when you make an incompatible change (remove field, change type, rename field without migration).
3. **Do not bump** for compatible additions if you use optional-field patterns — but document what "compatible" means for your team.
4. **`serialver` tool** (JDK) prints the synthetic UID if you're aligning with an existing stream:

```bash
serialver com.acme.UserSession
```

5. **Records** — still use `serialVersionUID` if you serialize records; components become fields.

### Compatible vs incompatible changes (default serialization)

| Change | Compatible? | Notes |
|---|---|---|
| Add field | Often yes | New field = default value for old streams |
| Remove field | **No** | Old streams still carry it; data loss if not custom-handled |
| Change field type | **No** | UID changes; need migration |
| Change field name | **No** (synthetic UID) | Same binary layout if only name changes? **UID still changes** without custom hooks |
| Add `implements Serializable` | Careful | Old bytes didn't exist |
| Enum: add constant | Yes for old readers | Old readers ignore new values if not received |
| Enum: rename constant | **No** | Deserialized by name |

### Production scenario: emergency hotfix rejected by sessions

**Problem.** Hotfix renames `userName` → `username` (same type). Deploy rolled back twice. `InvalidClassException` fills logs. Synthetic UID changed because field name is in the hash.

**Solution.**

```java
public class UserSession implements Serializable {
    private static final long serialVersionUID = 3L; // bumped once, intentionally

    private String username; // renamed from userName

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        ObjectInputStream.GetField fields = in.readFields();
        // migration: old stream had userName — default serialization won't map; use GetField by old name if you kept UID
        Object legacy = fields.get("userName", null);
        this.username = legacy != null ? (String) legacy : (String) fields.get("username", null);
    }
}
```

Better: **namespace new sessions** (`v4:` Redis key) and force re-login once. Custom migration hooks are easy to get wrong under pressure.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Copy-paste UID from another class | Silent wrong defaults, bizarre field values |
| Bump UID without migration plan | Every persisted blob invalid at once |
| Rely on "we'll flush cache on deploy" without automation | Forgotten on hotfix deploy |
| Same UID after removing `final` or changing hierarchy | Stream layout mismatch, hard-to-debug corruption |

---

## 4. Custom Serialization Hooks

### Core concept

Override points:

| Hook | When it runs | Use for |
|---|---|---|
| `writeObject` / `readObject` | Per-instance, default mechanism bypass partially | Validation, migration, derived fields |
| `writeReplace` / `readResolve` | Replace object before write / after read | Singleton, immutable flyweight |
| `readObjectNoData` | No data for class in stream | Default for new classes in evolved graph |
| `Externalizable` | Full control; **no default field write** | Performance, explicit versioned format |
| `ObjectOutputStream.defaultWriteObject()` | Resume default after custom prefix | Mixed custom + default |

```java
public class Money implements Serializable {
    private static final long serialVersionUID = 1L;
    private long minorUnits;
    private String currency;

    private void writeObject(ObjectOutputStream out) throws IOException {
        out.defaultWriteObject();
        // invariant check on write — fail fast before bad bytes persist
        if (currency == null || currency.length() != 3) {
            throw new InvalidObjectException("currency must be ISO-4217");
        }
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        in.defaultReadObject();
        if (currency == null) {
            currency = "USD"; // migration default for v1 streams
        }
    }
}
```

### Externalizable vs Serializable

`Externalizable` skips reflection walk — you implement `writeExternal` / `readExternal`. **Constructors run** (public no-arg required). Faster and explicit, but every field change is your responsibility.

```java
public class PointV2 implements Externalizable {
    private int x, y, z;

    public PointV2() {} // required

    @Override
    public void writeExternal(ObjectOutput out) throws IOException {
        out.writeByte(2); // format version
        out.writeInt(x);
        out.writeInt(y);
        out.writeInt(z);
    }

    @Override
    public void readExternal(ObjectInput in) throws IOException {
        byte ver = in.readByte();
        x = in.readInt();
        y = in.readInt();
        z = ver >= 2 ? in.readInt() : 0;
    }
}
```

### Production scenario: readObject that assumes non-null new field

**Problem.** `readObject` calls `newField.trim()` but streams written before deploy lack `newField` → NPE on session load → 500 on every request for affected users.

**Fix.** Defensive defaults in `readObject`, or `readObjectNoData`:

```java
private void readObjectNoData() throws ObjectStreamException {
    this.newField = "";
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `readObject` without `defaultReadObject()` when needed | Fields stay default/null incorrectly |
| Validation only on write, not read | Corrupt or attacker bytes pass |
| `writeReplace` returns wrong type | `ClassCastException` on read |
| `Externalizable` missing public no-arg ctor | InstantiationException |

---

## 5. transient and Field Control

### Core concept

`transient` excludes a field from default serialization. On deserialize, it gets **Java defaults** (`null`, `0`, `false`) unless `readObject` reconstructs it.

Use `transient` for:

- **Recomputable** state (caches, indexes, derived sums)
- **Non-serializable** resources (sockets, threads, connections)
- **Sensitive** data you don't want in the blob (raw password — though you shouldn't serialize secrets at all)
- **Context-bound** objects (Spring `ApplicationContext`, loggers)

```java
public class ConnectionHolder implements Serializable {
    private static final long serialVersionUID = 1L;

    private final String host;
    private final int port;
    private transient Connection connection; // rebuilt

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        in.defaultReadObject();
        this.connection = openConnection(host, port);
    }
}
```

### static fields

**Never serialized.** If it looks like instance state but is `static`, you get **one copy per class**, not per object — classic bug when "session" data was accidentally static.

### Production scenario: transient logger NPE

**Problem.** Class has `private Logger log = LoggerFactory.getLogger(getClass());` not transient. `NotSerializableException`. Dev makes it `transient`. After deserialize, `log` is null → NPE on first log line.

**Fix.** Reinitialize in `readObject` or use lazy holder:

```java
private transient Logger log;

private Logger log() {
    if (log == null) {
        log = LoggerFactory.getLogger(getClass());
    }
    return log;
}
```

Or don't serialize classes that log — use DTOs.

---

## 6. Singleton, Enum, and Immutable Types

### Singleton (broken by default)

```java
public class BadSingleton implements Serializable {
    private static final BadSingleton INSTANCE = new BadSingleton();
    public static BadSingleton getInstance() { return INSTANCE; }
}
```

Deserialization creates a **second instance** (no constructor, but new object identity). Fix with `readResolve`:

```java
public class GoodSingleton implements Serializable {
    private static final long serialVersionUID = 1L;
    private static final GoodSingleton INSTANCE = new GoodSingleton();

    public static GoodSingleton getInstance() { return INSTANCE; }

    private GoodSingleton() {}

    private Object readResolve() {
        return INSTANCE;
    }
}
```

Better: **don't serialize singletons**. Serialize IDs, resolve from registry on read.

### Enum serialization

Enums serialize as **name string**. Order of constants can change; names must not. Never add abstract methods that break stable identity assumptions in persisted enums without migration.

```java
public enum OrderStatus { PENDING, PAID, SHIPPED }
// stream stores "PAID" — rename to PAID_OUT breaks old bytes
```

### Immutable types (recommended persisted shape)

Prefer **records or immutable classes** with all fields serializable, no setters, validation in constructor:

```java
public record SessionToken(String subject, Instant expiresAt) implements Serializable {
    private static final long serialVersionUID = 1L;

    public SessionToken {
        Objects.requireNonNull(subject);
        Objects.requireNonNull(expiresAt);
    }
}
```

Immutability doesn't fix versioning, but it eliminates half the "someone mutated cached object" bugs.

### Production scenario: enum value added, old app deserializes new session

**Problem.** New deploy adds `OrderStatus.CANCELLED`. Old pod still running deserializes enum fine, but when **old pod serializes** it never sends CANCELLED. Mixed cluster OK until old pod tries to **display** unknown enum from DB string — separate issue. For Java enum bytes: old JVM reading new enum name **works** if constant exists in old enum. If old JVM lacks the constant:

```
java.lang.IllegalArgumentException: No enum constant com.acme.OrderStatus.CANCELLED
```

**Fix.** Rolling deploy: deploy code with new enum **first**, then start writing new values. Or store enum as **String** in DTO with tolerant parsing.

### readObjectNoData and evolution

When a **new class** is added to an existing object graph mid-evolution, old streams contain no data for that class. JVM calls `readObjectNoData()` if implemented; otherwise fields get defaults. Pair with explicit defaults for invariants:

```java
private void readObjectNoData() throws ObjectStreamException {
    this.permissions = List.of();
    this.createdAt = Instant.EPOCH; // sentinel — validate in business layer
}
```

### Serialization proxy pattern (Joshua Bloch Item 3)

For immutable types that aren't naturally Serializable-friendly:

```java
public final class Period implements Serializable {
    private static final long serialVersionUID = 1L;
    private final Date start;
    private final Date end;

    private Object writeReplace() {
        return new Ser(start.getTime(), end.getTime());
    }

    private static class Ser implements Serializable {
        private static final long serialVersionUID = 1L;
        private final long startMillis;
        private final long endMillis;
        // readResolve reconstructs Period with validation
    }
}
```

Prefer `Instant` in modern code — avoids Date's mutable leak entirely.

---

## 7. Deserialization Security & ObjectInputFilter

### Core concept

**Never deserialize untrusted bytes** with `ObjectInputStream`. Full stop. If you must (legacy app server, old RMI):

1. **Input validation** — size limits, type allowlists.
2. **`ObjectInputFilter`** (JEP 290, Java 9+, enhanced in later releases).
3. **No commons-collections on classpath** (historic gadget fuel) — but gadgets exist in many libraries.
4. **Disable default typing in Jackson** unless you have an explicit allowlist.

```java
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter(
    "com.acme.session.UserSession;com.acme.session.*;java.base/*;!*"
);

try (ObjectInputStream ois = new ObjectInputStream(input)) {
    ois.setObjectInputFilter(filter);
    UserSession session = (UserSession) ois.readObject();
}
```

Filter grammar (simplified):

- `com.acme.Foo` — allow class
- `com.acme.*` — allow package pattern
- `java.base/*` — allow JDK base classes (often needed for String, etc.)
- `!*` — deny everything else not matched
- `maxdepth=`, `maxrefs=`, `maxbytes=`, `maxarray=` — resource limits

Global filter via system property:

```properties
-Djdk.serialFilter=com.acme.**;java.base/**;!*
```

Or `ObjectInputFilter.Config.setSerialFilter(...)` at startup.

### Jackson polymorphic typing (same class of bug)

```java
// NEVER in production without allowlist
objectMapper.enableDefaultTyping(ObjectMapper.DefaultTyping.NON_FINAL);
```

An attacker sends:

```json
["com.sun.org.apache.xalan.internal.xsltc.trax.TemplatesImpl", { ... }]
```

**Do this instead:**

```java
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "@type")
@JsonSubTypes({
    @JsonSubTypes.Type(value = CardPayment.class, name = "card"),
    @JsonSubTypes.Type(value = BankPayment.class, name = "bank")
})
public sealed interface Payment permits CardPayment, BankPayment {}
```

Activate allowlist:

```java
objectMapper.activateDefaultTyping(
    BasicPolymorphicTypeValidator.builder()
        .allowIfSubType(Payment.class)
        .build(),
    ObjectMapper.DefaultTyping.NON_FINAL
);
```

### Production scenario: Redis session deserialization gadget scan

**Problem.** Security scan flags app using `JdkSerializationRedisSerializer`. Pen test attempts ysoserial payload in a session cookie forgery test.

**Fix path:**

1. Immediate: `ObjectInputFilter` allowlist only session DTO classes + limits.
2. Short term: switch to `GenericJackson2JsonRedisSerializer` with **no default typing**, typed DTO.
3. Long term: signed, encrypted session tokens (JWT/opaque) — no arbitrary object graphs in cookies/Redis.

```java
@Bean
RedisSerializer<Object> springSessionDefaultRedisSerializer(ObjectMapper mapper) {
    ObjectMapper sessionMapper = mapper.copy();
    sessionMapper.deactivateDefaultTyping();
    return new GenericJackson2JsonRedisSerializer(sessionMapper);
}
```

### Do not include exploit payloads in docs or tests

When writing tests or documentation, **describe** gadget chains abstractly (e.g. "classpath must not contain chainable `readObject` helpers"). Do **not** paste ysoserial command lines, base64 exploit blobs, or working RCE payloads into the repo. Security scanners and junior copy-paste both treat that as ammunition.

Use tests that assert **filter rejects disallowed class names**:

```java
@Test
void objectInputFilter_rejectsUnexpectedClass() {
    byte[] evil = ... // minimal hand-rolled stream with disallowed class name, not a weaponized chain
    assertThatThrownBy(() -> deserialize(evil))
        .isInstanceOf(InvalidClassException.class);
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No filter on session deserialization | CVE-class RCE on pen test |
| Filter too permissive (`!*`` missing, `*` allowed) | Allowlist bypass |
| `enableDefaultTyping()` on Redis/ObjectMapper | JSON gadget RCE |
| Deserializing HTTP query/cookie parameters | Immediate incident |
| `ObjectInputStream` on admin "import plugin" upload | Game over |

---

## 8. JSON as a Serialization Format

### Core concept

Jackson (Spring Boot default) maps objects ↔ JSON text. **Schema is implicit** in Java/Kotlin types unless you use OpenAPI/JSON Schema as contract.

Strengths: human-readable, debuggable, browser-friendly, git-diffable config/events.
Weaknesses: verbose, no built-in evolution story without discipline, numeric precision (`BigDecimal` config), timezone (`Instant` vs `ZonedDateTime`).

### Spring Boot defaults that matter

```yaml
spring:
  jackson:
    serialization:
      write-dates-as-timestamps: false
    deserialization:
      fail-on-unknown-properties: false # dangerous for strict contracts
    default-property-inclusion: non_null
```

Production services talking to each other should often set `fail-on-unknown-properties: true` on inbound DTOs **during testing**, then decide policy per API.

### DTO pattern (mandatory at boundaries)

```java
public record CreateOrderRequest(
    @NotNull String sku,
    @Min(1) int quantity,
    @JsonProperty("ship_to") Address shipTo
) {}
```

Never return JPA entities from `@RestController` if you care about stable JSON.

### Production scenario: Long IDs rounded in JavaScript

**Problem.** Frontend shows order `9223372036854775807` as `9223372036854775800`. JSON number in JS is IEEE double.

**Fix.** Serialize IDs as String in API:

```java
@JsonSerialize(using = ToStringSerializer.class)
private Long orderId;
```

Or use `String` id in API DTO entirely.

### JSON vs Java serialization (quick)

| Concern | JSON + Jackson | Java native |
|---|---|---|
| Cross-language | Yes | No |
| Size | Larger | Larger than Protobuf, smaller than naive JSON sometimes |
| Schema evolution | Manual (@JsonIgnoreProperties, optional fields) | Fragile |
| Security | Default typing danger | Gadget chains |
| Performance | Good enough for APIs | Faster binary, wrong tool for APIs |

### Jackson modules and Java time

Always register `JavaTimeModule` (Boot auto-config does). Without it, `Instant` may serialize poorly or fail:

```java
ObjectMapper mapper = JsonMapper.builder()
    .addModule(new JavaTimeModule())
    .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
    .build();
```

Prefer **`Instant` for UTC instants** in DTOs; use `ZonedDateTime` only when zone matters for display. Document timezone in OpenAPI.

### Kotlin, records, and Lombok

- **Records** — Jackson 2.12+ supports records as immutable DTOs; constructor parameters map to JSON properties.
- **Kotlin** — `kotlin-module` handles nullability; data classes need `@JsonProperty` on constructor params if JSON names differ.
- **Lombok `@Builder`** — ensure `@JsonDeserialize(builder = ...)` if not using default constructor; serialization to Redis often fails on builder-only types.

```java
@JsonIgnoreProperties(ignoreUnknown = true)
public record Address(
    @JsonProperty("postal_code") String postalCode,
    String country
) {}
```

### Custom serializers (when defaults lie)

Use `@JsonSerialize` / `@JsonDeserialize` when domain type ≠ wire shape:

```java
public class MoneyJson {
    public static class Serializer extends JsonSerializer<Money> {
        @Override
        public void serialize(Money v, JsonGenerator g, SerializerProvider p) throws IOException {
            g.writeStartObject();
            g.writeStringField("amount", v.amount().toPlainString());
            g.writeStringField("currency", v.currency());
            g.writeEndObject();
        }
    }
}
```

Register via module or annotation on `Money` type used in API layer only — keep domain free of Jackson if you care about hexagonal boundaries.

### JSON Schema and OpenAPI as contract

Generate OpenAPI from code **or** schema-first design — but **pin the contract** in CI:

```yaml
# spectral or openapi-diff in pipeline
# breaking: remove property, change type, rename without alias
```

Consumer-driven contract tests (Pact) catch `fail-on-unknown=false` masking producer renames until production.

### Production scenario: circular reference blows stack or infinite JSON

**Problem.** `Department` has `List<Employee>`, each `Employee` has `Department manager`. Jackson default serialization **infinite loops** or writes redundant huge graph.

**Fix.** `@JsonManagedReference` / `@JsonBackReference` (fragile), or better: **DTO without back-edges**:

```java
public record EmployeeView(long id, String name, Long departmentId) {}
```

Never serialize ORM bidirectional graphs directly.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Different `ObjectMapper` per microservice for shared Redis | Random `JsonMappingException` |
| `NON_NULL` on producer, required field added | Old consumer OK; new consumer breaks old producers |
| Mixing Fastjson (legacy) and Jackson | Security CVE history + inconsistent behavior |
| `@JsonInclude(NON_EMPTY)` on collections | Client can't distinguish missing vs empty list |

---

## 9. Protocol Buffers

### Core concept

**Schema-first** binary format from `.proto` files. Code generated via `protoc`. Field numbers are stable identifiers; names can change.

```protobuf
syntax = "proto3";
package com.acme.orders.v1;

message OrderEvent {
  int64 order_id = 1;
  string sku = 2;
  int32 quantity = 3;
  google.type.Money amount = 4; // or custom Money message
}
```

```java
OrderEvent event = OrderEvent.newBuilder()
    .setOrderId(42L)
    .setSku("WIDGET")
    .setQuantity(3)
    .build();
byte[] bytes = event.toByteArray();
OrderEvent parsed = OrderEvent.parseFrom(bytes);
```

### Evolution rules (proto3)

- Never reuse field numbers.
- Adding fields is forward/backward compatible if readers ignore unknown fields (protobuf does).
- Removing required fields (proto2) or changing wire type of number = breakage.
- Use `reserved` for retired numbers/names.

```protobuf
message OrderEvent {
  reserved 5, 6;
  reserved "legacy_discount";
  int64 order_id = 1;
  // ...
}
```

### gRPC

Protobuf is the on-wire format for gRPC. Same evolution rules apply across rolling deploys — old server ignores new fields, new server fills defaults for missing fields.

### Production scenario: breaking change despite "protobuf is safe"

**Problem.** Team changes `int32 quantity` field 3 to `string quantity` (same number). Deploy → parse errors, corrupted data.

**Cause.** Wire type changed on same field number — protobuf doesn't magically migrate.

**Fix.** New field `string quantity_str = 7;`, deprecate old, dual-write, migrate, remove.

### When to choose Protobuf

- Service-to-service high volume
- gRPC already chosen
- Strong need for compact binary + codegen
- Polyglot consumers (Go, Rust, Java)

---

## 10. Apache Avro

### Core concept

**Schema embedded or referenced by ID** (Confluent Schema Registry). JSON-like data model, binary encoding, **excellent for Kafka** event streams.

```json
{
  "type": "record",
  "name": "OrderEvent",
  "namespace": "com.acme.events",
  "fields": [
    { "name": "orderId", "type": "long" },
    { "name": "sku", "type": "string" },
    { "name": "quantity", "type": "int", "default": 1 }
  ]
}
```

Writer schema + reader schema resolution:

- Missing field with default → default used
- Missing field without default → error
- Extra field → ignored

### Schema Registry workflow

```
Producer registers schema v2 → gets id 47
Message payload: [magic byte][id 47][avro bytes]
Consumer fetches schema 47, deserializes, resolves against local reader schema
```

### Production scenario: consumer deployed before producer schema bump

**Problem.** Producer adds non-optional field without default. Old consumer reader schema lacks field → **AvroTypeException**.

**Fix.** New fields must have **defaults** for backward compatibility, or use dual-schema consumption period:

```json
{ "name": "region", "type": "string", "default": "US" }
```

### Avro vs Protobuf (Kafka-centric)

| | Avro | Protobuf |
|---|---|---|
| Schema Registry story | Native fit | Supported |
| JSON-ish ergonomics | High | Lower |
| gRPC | Less common | Native |
| Evolution | Reader/writer resolution | Field number rules |

### SpecificRecord vs GenericRecord

| | SpecificRecord (codegen) | GenericRecord |
|---|---|---|
| Type safety | Compile-time | Runtime schema |
| Performance | Faster field access | Slightly slower |
| Use when | Stable schema, Java primary consumer | Ad hoc topics, exploration |

### Confluent compatibility modes

| Mode | Meaning |
|---|---|
| BACKWARD | New schema can read old data (consumers first) |
| FORWARD | Old schema can read new data (producers first) |
| FULL | Both directions |
| NONE | No checks — incident waiting |

CI should run `mvn schema-registry:validate` or equivalent on PR touching `.avsc`.

### Production scenario: schema id mismatch across environments

**Problem.** Staging Schema Registry id 47 = `OrderEvent v2`. Production id 47 = **different schema** (registry rebuilt). Consumer deserializes garbage silently or throws cryptic Avro errors.

**Fix.** Never rebuild registry from scratch without migration; use subject naming strategy `TopicNameStrategy`; pin schema versions in producer config for critical topics; integration tests against real registry clone.

---

## 11. Schema Evolution Comparison

Use this table in design reviews when someone says "we'll use JSON, it's flexible."

| Mechanism | Add optional field | Remove field | Rename field | Change type | Cross-language | Typical store |
|---|---|---|---|---|---|---|
| Java native | Risky (defaults) | Breaks UID/layout | Breaks synthetic UID | Breaks | No | Sessions, legacy |
| JSON (Jackson) | `@JsonIgnoreProperties(ignoreUnknown=true)` | Old clients ignore if unknown removed from producer carefully | Add alias `@JsonAlias` | Coerce carefully | Yes | REST, Redis |
| Protobuf | Safe (new number) | Never reuse number | Safe (number stable) | **Same number = break** | Yes | gRPC, Kafka |
| Avro | Safe with default | Safe if readers ignore | Alias via default | Promote types with care | Yes | Kafka |
| CSV / ad hoc | Pain | Pain | Pain | Pain | "Yes" | Data lakes |

### Versioning strategies (distributed systems)

1. **Dual write** — write v1 and v2 keys/formats during migration.
2. **Dual read** — try v2, fallback v1 (time-boxed).
3. **Expand → migrate → contract** — add new field/format, backfill, remove old (Martin Fowler parallel for APIs).
4. **Namespace keys** — `cache:user:v3:{id}` invalidates without parsing old bytes.
5. **Feature flag schema** — producer chooses format by flag per tenant.

### Production scenario: Kafka topic without schema registry

**Problem.** Team publishes JSON to Kafka topic. Producer renames `userId` → `user_id`. Three consumers break at different times. Nobody knows which message version is on the topic.

**Fix.** Adopt Schema Registry (Avro/Protobuf/JSON Schema) or embed **`schemaVersion` int** in envelope:

```json
{ "schemaVersion": 2, "payload": { "user_id": "abc" } }
```

Consumers switch on `schemaVersion`. Boring, explicit, works.

---

## 12. Distributed Systems Context

### Where serialization hides

| System | Default tendency | Senior recommendation |
|---|---|---|
| HTTP REST | JSON | OpenAPI contract, explicit DTOs |
| Spring Session Redis | JDK (older) / JSON (newer) | JSON or JWT; avoid JDK |
| Spring Cache `@Cacheable` | Depends on provider | JSON/Kryo with caution; not native Java |
| Kafka | Bytes | Avro/Protobuf + Schema Registry |
| RabbitMQ | Java serialization (legacy) | JSON/MessageConverter |
| Hazelcast/Ignite | Java binary | Portable/DataSerializable or POJO configured |
| gRPC | Protobuf | Keep `.proto` in repo, CI breaking change detection |
| Dubbo/HSF | Various | Project-specific; treat as public API |

### Kafka key vs value

- **Key** — often `String` or `Long` bytes for partitioning stability.
- **Value** — Avro/Protobuf with schema ID.
- **Headers** — String/metadata; don't sneak object graphs.

### Redis

Values are byte arrays. Spring Data Redis:

```java
RedisTemplate<String, OrderView> template = new RedisTemplate<>();
template.setKeySerializer(new StringRedisSerializer());
template.setValueSerializer(new Jackson2JsonRedisSerializer<>(OrderView.class));
```

**Do not** share one `RedisTemplate<Object,Object>` with JDK serializer across services written in different languages.

### Production scenario: microservice A caches, microservice B reads same Redis key

**Problem.** Service A (Java, JDK serialization) writes `UserCache`. Service B (Kotlin, expects JSON) reads garbage or throws.

**Cause.** Serializer coupling without cross-team contract.

**Fix.** Key ownership doc: format = JSON schema v1, owner = team Identity, TTL 15m. Integration test in CI that B reads A's fixture bytes.

### HTTP content negotiation and serialization

REST APIs rarely use Java serialization on the wire — but **content type** still matters:

```http
Accept: application/json
Content-Type: application/json
```

`application/x-java-serialized-object` exists in legacy apps — block at API gateway. Prefer explicit JSON or protobuf (`application/x-protobuf`) with documented schema.

### RabbitMQ MessageConverter

Default `SimpleMessageConverter` uses Java serialization for non-primitive `Message` bodies unless configured:

```java
@Bean
public RabbitTemplate rabbitTemplate(ConnectionFactory cf, Jackson2JsonMessageConverter converter) {
    RabbitTemplate template = new RabbitTemplate(cf);
    template.setMessageConverter(converter);
    return template;
}

@Bean
public Jackson2JsonMessageConverter jackson2JsonMessageConverter(ObjectMapper mapper) {
    return new Jackson2JsonMessageConverter(mapper);
}
```

### gRPC metadata vs message body

Serialization applies to **protobuf message body**. Metadata (headers) is `String`/`ASCII-String` — don't base64 Java-serialize objects into metadata to "avoid schema work."

### Hazelcast `Portable` / `IdentifiedDataSerializable`

If stuck on Hazelcast for caching, prefer **Portable** factory with explicit field indexes over Java serialization for version tolerance and cross-language potential.

### Production scenario: Kafka header used as serialized Java object

**Problem.** Team puts `UserContext` Java-serialized bytes in Kafka header for "routing." Consumer in Go can't read; Java consumer works until deploy changes class → poison pill header on every message.

**Fix.** Headers: String tenant id, trace id, schema version. Payload: Avro/Protobuf full context if needed.

---

## 13. Rolling Deploy Compatibility

### The rolling deploy graph

```
t0: 100% v1 pods, v1 bytes on wire/disk
t1: 80% v1, 20% v2 — BOTH must read BOTH byte formats (or isolate stores)
t2: 0% v1 — safe to drop v1 readers if store flushed
```

### Rules

1. **Backward compatible changes first** — deploy readers that understand v2 **before** writers emit v2.
2. **Forward compatible writers** — v2 writer should still produce v1 if rollback needed (feature flag).
3. **Session/cache** — sticky sessions don't save you if Redis is shared; all pods must read same formats.
4. **Kafka** — consumers lead producer schema changes when adding required fields (defaults required).

### Blue/green vs rolling

Blue/green allows **namespace flush** (new Redis DB, new topic). Rolling requires **dual-read** or **tolerant parsers**.

### Production scenario: rollback after schema change

**Problem.** Deploy v2 writes new session field. Rollback to v1. v1 deserializes (field ignored) but when user updates session, v1 **overwrites** Redis without new field → v2 users lose state.

**Fix.** Don't rollback writers without flush, or embed format version and reject incompatible sessions (force re-auth).

```java
public class UserSession implements Serializable {
    private static final long serialVersionUID = 4L;
    private final int formatVersion = 4;
    // ...
}
```

On read, if `formatVersion > supportedMax`, invalidate session.

### Feature flags and serialization

Use flags to **gate writers** of new format, not readers:

```
if (flags.isEnabled("session-v4-write")) {
    redis.set(keyV4, serializeV4(session));
} else {
    redis.set(keyV3, serializeV3(session));
}
```

Readers try v4 then v3 during migration window. Remove flag only after metrics show zero v3 keys.

### Database BLOB columns

`BYTEA` / `BLOB` storing Java native serialization is a **long-term trap**. Migration path:

1. Add `format_version` column + `payload_json` column.
2. Background job dual-read old blob, write JSON, mark migrated.
3. Stop writing blob; drop after retention.

### Kubernetes rolling update parameters

`maxUnavailable` / `maxSurge` control how many mixed-version pods run. Serialization bugs appear when **>1 version shares Redis/Kafka**. Coordinate deploy with:

- Cache flush Job (init container)
- Readiness probe that fails if serializer self-test fails
- Pod annotation `app.version` for log correlation

### Production scenario: auto-scaling amplifies mixed-version window

**Problem.** HPA scales up v2 pods while v1 still draining. Redis sessions written by v2 fail on v1 during traffic spike.

**Fix.** Surge all v2 before terminating v1 (Recreate strategy for stateful serializer change) **or** ensure byte-level compatibility. For breaking changes, **Recreate** deploy + maintenance window beats rolling.

---

## 14. Performance & Footprint

### Rough ordering (typical POJO, not micro-benchmark gospel)

Fastest / smallest → slowest / largest (general trend):

1. Protobuf / Avro binary
2. Kryo / FST (Java-specific, **not safe for untrusted**)
3. Java native serialization
4. JSON (compact with Jackson after warmup)
5. JSON pretty-print / XML

### Java native costs

- Reflection on first use per class (descriptor cache helps after)
- Class metadata repeated per object type in stream
- GC pressure from boxing and graph allocation

### Jackson costs

- CPU for write/read, UTF-8 encode/decode
- **`ObjectMapper` is expensive to create** — reuse as singleton bean
- Afterburner module (third-party) trades startup for speed — evaluate on JDK 21

### When performance actually matters

- Kafka million/sec — Protobuf/Avro, reuse byte buffers, avoid `toString()` on hot path
- Redis session — JSON often fine; measure p99 before Kryo
- Large graph — **shape matters more than serializer** (don't serialize 10MB lazy lists)

### Production scenario: "Kryo fixed latency" then security audit failed

**Problem.** Team switched Redis to Kryo for speed. Audit: Kryo + untrusted input = same as Java deserialization risk. Internal only? Attacker with SSRF to Redis still internal.

**Fix.** Trusted-process-only Kryo with registered classes, or JSON + compression (Snappy/LZ4 on byte[]), or split hot/cold paths.

### Measurement snippet

```java
@BenchmarkMode(Mode.Throughput)
@Warmup(iterations = 3)
@Measurement(iterations = 5)
public void jacksonRoundTrip(Blackhole bh) throws Exception {
    OrderView v = sample();
    byte[] bytes = mapper.writeValueAsBytes(v);
    bh.consume(mapper.readValue(bytes, OrderView.class));
}
```

Run JMH in CI optionally for critical paths — not for every CRUD DTO.

### Allocation and payload size checklist

Before switching serializers for performance:

1. **Measure p99 end-to-end** — serializer is often noise vs DB/network.
2. **Log payload sizes** at debug for Kafka/Redis top keys — 512KB session is a design bug.
3. **Compress** text JSON with LZ4/Snappy at rest if CPU cheaper than network (Redis/Kafka).
4. **Object reuse** — Protobuf builders, Avro specific record reuse (advanced; watch thread safety).

### Format size illustration (order DTO, illustrative)

| Format | Relative size (typical) | Notes |
|---|---|---|
| Protobuf binary | 1.0× baseline | No field names on wire |
| Avro binary | ~1.0–1.2× | Depends on schema overhead |
| Java native | ~2–4× | Class descriptors per type |
| Jackson compact JSON | ~3–6× | Field names repeated every message |
| Jackson pretty JSON | ~5–10× | Never on Kafka hot path |

Numbers vary by schema; treat as order-of-magnitude for architecture reviews.

### Production scenario: switched to binary but CPU worse

**Problem.** Team moved Kafka from JSON to Avro. Throughput up, but **consumer CPU doubled**. Profiler shows Schema Registry lookups and specific record allocation dominating.

**Cause.** Fetching schema id every message without caching; creating new `SpecificRecord` per message.

**Fix.** Cache schema by id in consumer; reuse deserializer config; batch consume; consider generic record for low-volume topics where codegen overhead isn't worth it.

---

## 15. Testing Serialization

### What to test

1. **Round-trip equality** — write → read → assert semantic equals.
2. **Version n-1 bytes** — fixture file from previous release still reads (golden file test).
3. **Rolling deploy simulation** — old bytes + new code, new bytes + old code (if supported).
4. **Filter rejection** — disallowed classes fail closed.
5. **Size bounds** — session blob > 64KB triggers alarm (design smell).

### Golden file pattern

```java
@Test
void readsV3SessionFixture() throws Exception {
    byte[] fixture = readResource("/fixtures/session-v3.bin");
    UserSession s = deserialize(fixture);
    assertThat(s.username()).isEqualTo("ada");
}

@Test
void currentVersionMatchesGolden() throws Exception {
    UserSession s = sampleSession();
    byte[] bytes = serialize(s);
    assertThat(bytes).isEqualTo(readResource("/fixtures/session-v3.bin"));
}
```

Update golden intentionally when bumping `serialVersionUID`.

### Testcontainers Redis

```java
@Test
void springSessionRoundTrip() {
    // @SpringBootTest + Redis container
    // create session, fetch from Redis raw bytes, assert JSON structure not JDK magic 0xACED
    byte[] raw = redis.get(connection -> connection.get(keyBytes));
    assertThat(raw[0]).isNotEqualTo((byte) 0xAC); // not Java serialization magic
}
```

### Contract tests between services

Pact / schema compatibility for Kafka:

```bash
# confluent schema plugin in CI
mvn schema-registry:validate-compatibility
```

### Common test gaps

| Gap | Risk |
|---|---|
| Only test happy path current version | Deploy breaks on first rolling pod |
| No test for null/new fields | NPE in readObject |
| Mockito mocks in graph | Accidental non-serializable in prod graph |
| Tests use different ObjectMapper than prod | Redis JSON mismatch |

### ArchUnit guardrails

```java
@ArchTest
static final ArchRule noObjectInputStreamInApp =
    noClasses().that().resideInAnyPackage("com.acme..")
        .should().callConstructor(ObjectInputStream.class)
        .because("Use JSON/Protobuf with schema; JDK deserialization is blocked by policy");
```

Allowlist legacy module in `archunit_store` if migration in progress with ticket id.

### Property-based testing (jqwik)

Generate random DTO graphs (bounded depth) and assert round-trip:

```java
@Property
void orderViewRoundTrip(@ForAll("orderViews") OrderView original) throws Exception {
    byte[] bytes = mapper.writeValueAsBytes(original);
    OrderView restored = mapper.readValue(bytes, OrderView.class);
    assertThat(restored).isEqualTo(original);
}
```

Catches subtle `equals`/`hashCode` drift vs serialization field coverage.

### Fuzzing deserialization (security)

Use structure-aware fuzzing on **your parsers** with strict limits — not gadget payloads. Goal: no crash, no hang, bounded memory on malformed JSON/protobuf length delimiters.

---

## 16. Spring Data Redis & Session Serializers

### Spring Session

Default serializer history hurts teams:

- **JDK** — `JdkSerializationRedisSerializer` — compact for Java-only, security/versioning pain.
- **JSON** — `GenericJackson2JsonRedisSerializer` — needs type info if storing `Object`, avoid.
- **Custom** — typed serializer per class.

```java
@Configuration
@EnableRedisHttpSession(maxInactiveIntervalInSeconds = 1800)
public class SessionConfig {

    @Bean
    SpringSessionRedisSerializer springSessionRedisSerializer(ObjectMapper mapper) {
        ObjectMapper copy = mapper.copy();
        copy.registerModule(new JavaTimeModule());
        copy.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        return new GenericJackson2JsonRedisSerializer(copy);
    }
}
```

Prefer storing **session attributes as typed primitives/DTOs**, not arbitrary `Object`.

### RedisTemplate patterns

```java
@Configuration
public class RedisConfig {

    @Bean
    RedisTemplate<String, OrderView> orderCacheTemplate(RedisConnectionFactory cf) {
        RedisTemplate<String, OrderView> t = new RedisTemplate<>();
        t.setConnectionFactory(cf);
        t.setKeySerializer(RedisSerializer.string());
        t.setValueSerializer(new Jackson2JsonRedisSerializer<>(OrderView.class));
        t.setHashKeySerializer(RedisSerializer.string());
        t.setHashValueSerializer(new Jackson2JsonRedisSerializer<>(LineView.class));
        return t;
    }
}
```

### `@Cacheable` with Redis

Spring Cache abstraction uses serializer from cache manager configuration. **Verify** you're not using default JDK when switching Boot versions.

```java
@Bean
RedisCacheManager cacheManager(RedisConnectionFactory cf, ObjectMapper mapper) {
    RedisCacheConfiguration defaults = RedisCacheConfiguration.defaultCacheConfig()
        .serializeKeysWith(RedisSerializationContext.SerializationPair.fromSerializer(RedisSerializer.string()))
        .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(
            new Jackson2JsonRedisSerializer<>(mapper, ProductView.class)));
    return RedisCacheManager.builder(cf).cacheDefaults(defaults).build();
}
```

### Production scenario: GenericJackson2JsonRedisSerializer ClassNotFound after refactor

**Problem.** Redis stores JSON with `"@class":"com.acme.oldpkg.OrderView"`. Package renamed. Deserialization fails for all cache hits.

**Fix.** `@JsonTypeInfo(use = Id.NAME)` with stable logical names, not fully qualified class names:

```java
@JsonTypeName("order-view-v1")
public record OrderView(...) {}
```

Or flush cache on rename deploy (automate in pipeline).

### Lettuce vs Jedis (Spring Boot 3)

Boot defaults to **Lettuce** (async, netty). Serializer choice is independent, but **connection sharing** and `RedisTemplate` thread safety matter: configure one template bean, inject everywhere — ad hoc `new RedisTemplate` duplicates serializers and connection settings.

### Spring Session cookie vs Redis

| Store | Serialization surface |
|---|---|
| Redis indexed session | Value serializer + spring session attribute map |
| JDBC session | Row bytes — often JDK unless customized |
| Cookie only | Base64 JSON/JDK — **size limit 4KB** practical max |

Cookie sessions with JDK serialization hit size limits fast — another reason to prefer compact JWT or server-side Redis JSON.

### `@EnableRedisHttpSession` attributes

```java
@EnableRedisHttpSession(
    maxInactiveIntervalInSeconds = 3600,
    redisNamespace = "myapp:session"
)
```

Changing `redisNamespace` **invalidates all sessions** — useful as deliberate flush lever during serializer migration (`myapp:session:v2`).

### Hash operations vs JSON string value

For partial updates, **`RedisHash`** on a typed object can serialize fields separately — but Spring Data Redis hash serializers must match across services. Prefer whole-value JSON for simplicity unless profiling shows hash field updates are hot.

### Production scenario: GenericJackson2JsonRedisSerializer stores @class everywhere

**Problem.** Redis values look like `{"@class":"com.acme.OrderView","id":1,...}`. Package refactor breaks cache; payload bloated.

**Fix.** Use `Jackson2JsonRedisSerializer<OrderView>(OrderView.class)` for typed template — no `@class` property. For polymorphic lists, use sealed interface + `@JsonTypeInfo(Id.NAME)` with short names.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `RedisTemplate` default serializers not set | JDK binary surprises |
| Multiple `ObjectMapper` beans, wrong one injected | Dates as arrays, modules missing |
| `@Cacheable` without `cacheManager` bean customization | JDK after upgrade |
| Session serializer not a `@Bean` | Boot default JDK in some versions |

---

## 17. Production Debugging Playbook

Work top to bottom when bytes are involved in an incident.

### Phase 1: Identify the serializer

| Clue | Likely format |
|---|---|
| First bytes `AC ED 00 05` | Java native serialization |
| `{` or `[` UTF-8 | JSON |
| Protobuf — binary, not human readable | Need schema |
| Confluent magic `0x0` + schema id | Avro + Registry |

Hex dump first 16 bytes:

```bash
redis-cli --raw GET "spring:session:sessions:abc" | xxd | head
```

### Phase 2: Map the failure to category

| Exception / symptom | Bucket |
|---|---|
| `InvalidClassException` | UID / incompatible class change |
| `NotSerializableException` | Graph contains non-serializable node |
| `ClassCastException` after read | Wrong type assumption or classloader duplicate |
| `JsonMappingException` unknown property | Schema drift, fail-on-unknown true |
| `InvalidTypeIdException` | Jackson polymorphic misconfig |
| Session works on one pod only | Sticky + mixed serializers (rare) or local memory session |
| Sudden Redis memory spike | Larger serialized graphs or JDK metadata bloat |

### Phase 3: Reproduce offline

1. Capture raw bytes (Redis, Kafka message, file) — **redact secrets**.
2. Deserialize in a small `main` or unit test with **production classpath**.
3. Compare class `serialVersionUID` with stream (JD-GUI, or custom dump).

```java
// Dump stream class descriptor — diagnostic only
try (ObjectInputStream ois = new ObjectInputStream(new FileInputStream("blob.bin"))) {
    // use subclass overriding readClassDescriptor to log
}
```

### Phase 4: Mitigate

- **Flush** affected keys/namespaces (sessions, cache).
- **Roll forward** with compatible reader instead of rollback if writers already emitted v2.
- **Enable filter** immediately on any remaining JDK deserialization path.
- **Disable** polymorphic default typing until audited.

### Phase 5: Prevent recurrence

- CI golden-file compatibility test.
- Schema registry compatibility check on PR.
- ArchUnit: no `ObjectInputStream` in application packages except allowlisted module.
- Spring Session serializer bean explicit in config — not accidental default.

### JDK stream dump helper (support tooling)

Subclass for logging only — run in staging:

```java
public class LoggingObjectInputStream extends ObjectInputStream {
    public LoggingObjectInputStream(InputStream in) throws IOException { super(in); }

    @Override
    protected Class<?> resolveClass(ObjectStreamClass desc)
            throws IOException, ClassNotFoundException {
        log.info("Deserializing class: {} uid={}", desc.getName(), desc.getSerialVersionUID());
        return super.resolveClass(desc);
    }
}
```

Stop after identifying unexpected class names — do not run on production attacker-controlled bytes without filter.

### Kafka message forensics

```bash
# kafkacat/kcat consume hex
kcat -C -b broker:9092 -t orders -f '%s\n' -c 1 | xxd | head

# Confluent: magic 0x0, schema id 4 bytes big-endian, then avro payload
```

If magic byte wrong, consumer deserializer doesn't match producer — classic "we upgraded producer only" incident.

### Log correlation fields

When logging serialization failures, include:

- `format=jdk|json|avro|protobuf`
- `serialVersionUID` or `schemaId`
- `payloadBytes` (length only, not content)
- `key` / `sessionId` / `topicPartitionOffset`
- **Never** log full session blob or PII fields from failed parse

### Incident timeline template

```
T+0  Alert: InvalidClassException spike on checkout-api
T+5  Confirm rolling deploy 14:02, change: UserSession.newField
T+10 Hex Redis session → AC ED → JDK serialization confirmed
T+15 Mitigation: bump redisNamespace + force re-login banner
T+30 Root cause: no serialVersionUID bump strategy / no dual-read
T+7d  PR: Jackson session serializer + golden fixture CI test
```

---

## 18. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Browser/API public contract | JSON DTO + OpenAPI; ISO-8601 dates; String IDs if JS clients |
| Java session in Redis, single app | Jackson typed serializer or JWT; not JDK |
| Kafka events, multiple consumers | Avro or Protobuf + Schema Registry |
| gRPC internal calls | Protobuf; breaking change CI on `.proto` |
| Persist to disk long-term | Format with explicit version field; migration job; not raw Java native |
| Legacy RMI/JMS object messages | ObjectInputFilter strict allowlist; plan retirement |
| Need smallest bytes Java-only trusted | Consider Protobuf before Kryo; Kryo only trusted internal |
| Untrusted input | Never `ObjectInputStream`; Jackson `@JsonSubTypes` allowlist only |
| Rolling deploy this week | Dual-read, key namespace bump, or defaults on all new fields |
| Debug mystery blob | Hex magic bytes → identify serializer → golden test |

---

*Serialization choices outlive the sprint that made them. Prefer explicit schemas, boring DTOs, and tests that load last release's bytes — native Java serialization belongs in the museum wing, not the hot path.*

---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>Q1. What do the magic bytes AC ED 00 05 mean?</summary>

They mark the start of a **Java native serialization stream** (`ObjectOutputStream`). `0xAC 0xED` is the stream magic, `0x00 0x05` is the stream version. If you see these in Redis, Kafka, or a session cookie payload, the system is using JDK serialization.

</details>

<details class="qa-item">
<summary>Q2. Why does deserialization skip constructors?</summary>

Default Java deserialization allocates memory with `Unsafe`/internal mechanisms and sets fields directly from the stream so the object matches the serialized state. That breaks singletons (extra instances) and bypasses constructor validation unless you validate in `readObject`.

</details>

<details class="qa-item">
<summary>Q3. When must you change serialVersionUID?</summary>

When you make an **incompatible** change to default serialization layout: remove/rename fields (without migration hooks), change field types, or change class hierarchy in ways that alter the stream contract. Compatible **additions** often keep the same UID if old readers can ignore new fields.

</details>

<details class="qa-item">
<summary>Q4. What is the difference between transient and static for serialization?</summary>

`transient` instance fields are skipped and become defaults on read unless restored in hooks. `static` fields belong to the class and are **never** serialized — but developers mistakenly treat static as session state and create cross-user leaks.

</details>

<details class="qa-item">
<summary>Q5. How do you fix singleton break on deserialization?</summary>

Use `readResolve()` to return the canonical instance, or better: don't serialize the singleton — serialize an ID and look it up. Enums and proper `readResolve` are the textbook fixes.

</details>

<details class="qa-item">
<summary>Q6. What is ObjectInputFilter for?</summary>

JEP 290+ **allowlist/denylist** and resource limits (depth, refs, bytes) on incoming Java serialization streams. It reduces gadget chain RCE risk but is not a substitute for avoiding untrusted native deserialization entirely.

</details>

<details class="qa-item">
<summary>Q7. Why is Jackson default typing dangerous?</summary>

It embeds type names in JSON so polymorphic deserialization knows which class to instantiate. Attackers supply gadget class names on the classpath. Use `@JsonSubTypes` / sealed types with explicit names instead of global default typing.

</details>

<details class="qa-item">
<summary>Q8. Protobuf: can I change field name from foo to bar?</summary>

**Yes** for the same field **number** — wire format uses numbers, not names. Changing **type** on the same number is incompatible. Never reuse field numbers for different semantics.

</details>

<details class="qa-item">
<summary>Q9. Avro: what happens if reader schema lacks a field present in writer?</summary>

If the field has a **default** in reader schema, default is used. If no default, deserialization fails. Always add defaults when evolving Avro schemas for backward compatibility.

</details>

<details class="qa-item">
<summary>Q10. JSON vs Protobuf for a public REST API?</summary>

**JSON** — human debugging, browser clients, OpenAPI. **Protobuf** is wrong default for public REST (use gRPC internally). You can expose Protobuf over REST in niche cases but tooling/ecosystem favors JSON.

</details>

<details class="qa-item">
<summary>Q11. Can I serialize Optional?</summary>

`Optional` does not implement `Serializable`. Unwrap to null or use a separate boolean `hasValue` in DTOs. Same for `Stream`, `Path`, most functional wrappers.

</details>

<details class="qa-item">
<summary>Q12. Why not cache JPA entities?</summary>

Lazy proxies, non-serializable persistence context, huge graphs, and detached state cause `NotSerializableException`, `LazyInitializationException`, or subtle data bugs. Cache DTOs/views at the service boundary.

</details>

<details class="qa-item">
<summary>Q13. Rolling deploy: deploy new readers or writers first?</summary>

Deploy **readers that understand the new format first**, then writers that emit it. For removal, stop writers first, migrate data, then remove readers. Kafka/Avro: new consumers tolerant before producers send required fields without defaults.

</details>

<details class="qa-item">
<summary>Q14. How to detect JDK serializer in Spring Session Redis?</summary>

Inspect raw Redis value bytes for `AC ED`, or check beans for `JdkSerializationRedisSerializer` / missing custom `SpringSessionRedisSerializer`. Spring Boot 2.x+ docs push JSON but verify your config.

</details>

<details class="qa-item">
<summary>Q15. Externalizable vs Serializable — when Externalizable?</summary>

When you need **full control** over wire format and can accept maintaining explicit read/write code. Requires public no-arg constructor. Faster potential, higher maintenance — rare in business apps unless performance proven.

</details>

<details class="qa-item">
<summary>Q16. What is readResolve used for?</summary>

After `readObject`, replace the deserialized instance — classic for **singleton**, **enum-like** flyweights, or converting serialized proxy back to canonical immutable instance.

</details>

<details class="qa-item">
<summary>Q17. How do enum schema changes affect Java serialization?</summary>

Enums serialize by **constant name**. Adding constants is OK if old code never receives new names. **Renaming** breaks old bytes. Removing constants breaks if streams still contain old names.

</details>

<details class="qa-item">
<summary>Q18. Kryo vs Java serialization for Redis?</summary>

Both are **Java-specific and unsafe on untrusted bytes**. Kryo can be faster/smaller for trusted internal caches. Prefer JSON/Protobuf for operability and security; if Kryo, register classes explicitly and never expose to user input paths.

</details>

<details class="qa-item">
<summary>Q19. How to test backward compatibility?</summary>

Keep **golden fixture files** from release n-1 in `src/test/resources`. Test that current code deserializes them and that current serialization matches expected bytes or documented drift. Automate in CI on every PR touching DTOs.

</details>

<details class="qa-item">
<summary>Q20. InvalidClassException after harmless field add — why?</summary>

Possible causes: **synthetic serialVersionUID changed** (forgot explicit UID), changed field type/modifiers, or different class loaded from another module/JAR with same name. Run `serialver` and compare; check classpath duplicates.

</details>

<details class="qa-item">
<summary>Q21. Should BigDecimal be serialized in JSON as number?</summary>

Often serialize as **string** in financial APIs to avoid JSON number precision issues, or ensure Jackson writes plain string decimal. Java native serialization handles `BigDecimal` correctly as Serializable object.

</details>

<details class="qa-item">
<summary>Q22. What is expand-contract for event schemas?</summary>

**Expand:** add new optional/defaulted fields. **Migrate:** dual-read/write, backfill. **Contract:** remove old fields once all consumers upgraded. Same pattern for DB, Kafka, and session DTOs.

</details>

<details class="qa-item">
<summary>Q23. Can two services share Redis cache with different language stacks?</summary>

Only with a **language-neutral format** (JSON, Protobuf bytes with agreed schema). JDK serialization is Java-only. Define key naming, TTL, and schema ownership in a shared doc/contract test.

</details>

<details class="qa-item">
<summary>Q24. What does fail-on-unknown-properties do?</summary>

Jackson fails deserialization when JSON contains properties not on the Java type. **Strict** for inbound APIs you control both sides; **false** for public APIs that must ignore new client fields — but document forward compatibility expectations.

</details>

<details class="qa-item">
<summary>Q25. How to migrate off Java session serialization?</summary>

1) Deploy new serializer reading old JDK (bridge) or flush sessions on maintenance window. 2) Switch Redis serializer to Jackson typed DTO. 3) Bump session namespace or force re-login. 4) Add CI test that session bytes are JSON not `AC ED`.

</details>
