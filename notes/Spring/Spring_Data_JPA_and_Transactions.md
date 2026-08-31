# Spring Data JPA & Transactions Mastery — Senior Production Reference

Spring Boot 3.x / Hibernate 6.x / Jakarta Persistence 3.1. This is not a getting-started guide. It is the map of what actually breaks in production after shipping JPA-backed services at scale — N+1 queries that only appear under load, transactions that silently don't roll back, lazy proxies that explode in JSON serializers, and connection pool starvation that masquerades as "random timeouts."

---

## Table of Contents

1. [1. Mental Model: EntityManager, Session, Persistence Context, Flush Lifecycle](#1-mental-model-entitymanager-session-persistence-context-flush-lifecycle)
2. [2. Spring Data JPA Architecture](#2-spring-data-jpa-architecture)
3. [3. Entity Mapping: Associations, Cascades, Embeddables, Inheritance](#3-entity-mapping-associations-cascades-embeddables-inheritance)
4. [4. Lazy Loading, N+1, Fetch Joins, @EntityGraph, Batch Fetching](#4-lazy-loading-n1-fetch-joins-entitygraph-batch-fetching)
5. [5. Transaction Management: @Transactional Propagation, Isolation, readOnly](#5-transaction-management-transactional-propagation-isolation-readonly)
6. [6. PlatformTransactionManager & TransactionSynchronization](#6-platformtransactionmanager--transactionsynchronization)
7. [7. Transaction Boundaries: Service Layer, Self-Invocation, Private Methods](#7-transaction-boundaries-service-layer-self-invocation-private-methods)
8. [8. Open Session In View (OSIV) / spring.jpa.open-in-view](#8-open-session-in-view-osiv--springjpaopen-in-view)
9. [9. Flush Modes, Dirty Checking, merge vs persist vs update](#9-flush-modes-dirty-checking-merge-vs-persist-vs-update)
10. [10. Optimistic vs Pessimistic Locking (@Version, LockModeType)](#10-optimistic-vs-pessimistic-locking-version-lockmodetype)
11. [11. Auditing (@CreatedDate, Envers)](#11-auditing-createddate-envers)
12. [12. Specifications, Criteria API, Querydsl](#12-specifications-criteria-api-querydsl)
13. [13. Native Queries, SqlResultSetMapping, Stored Procedures](#13-native-queries-sqlresultsetmapping-stored-procedures)
14. [14. Multi-Tenancy (Discriminator, Schema, Database)](#14-multi-tenancy-discriminator-schema-database)
15. [15. Second-Level Cache Pitfalls](#15-second-level-cache-pitfalls)
16. [16. Connection Pool + Transaction Timeout Interactions](#16-connection-pool--transaction-timeout-interactions)
17. [17. @Modifying Queries, Bulk Updates, clearAutomatically](#17-modifying-queries-bulk-updates-clearautomatically)
18. [18. Testing: @DataJpaTest, Testcontainers, @Transactional Rollback](#18-testing-datajpatest-testcontainers-transactional-rollback)
19. [19. Spring Data JDBC vs JPA — When to Use Which](#19-spring-data-jdbc-vs-jpa--when-to-use-which)
20. [20. Production Debugging Playbook](#20-production-debugging-playbook)
21. [21. Quick Decision Matrix](#21-quick-decision-matrix)
22. [22. Scenario-Based Questions](#22-scenario-based-questions)

---

## 1. Mental Model: EntityManager, Session, Persistence Context, Flush Lifecycle

JPA is not "ORM that runs SQL." It is a **unit-of-work** scoped to a **persistence context** — an in-memory first-level cache of managed entity instances keyed by identity (`@Id`). Hibernate's `Session` is the native API; Spring wraps it as `EntityManager`. In Boot 3, you almost never touch either directly — but every production incident eventually reduces to "what was in the persistence context at flush time?"

```
@Service @Transactional
  └─ EntityManager (Spring proxy → SharedEntityManagerCreator)
       └─ Hibernate Session (per transaction OR extended via OSIV)
            └─ Persistence Context (1st-level cache)
                 ├─ managed entities (identity map)
                 ├─ dirty checking (field diffs at flush)
                 └─ flush → SQL to JDBC Connection (from pool)
```

Three objects you must keep distinct:

| Object | Question it answers | Typical type |
|---|---|---|
| `EntityManager` / `Session` | Where are my entities tracked? | `SessionImpl` behind a JDK proxy |
| Persistence context | Which entity instances are **managed** for this scope? | Per-Session map: `(entityClass, id) → instance` |
| JDBC `Connection` | Which physical DB connection executes SQL? | HikariCP pooled connection, bound for transaction duration |

A **managed** entity is attached to the persistence context. Changes to its fields are detected automatically (dirty checking) and written at flush. A **detached** entity is a plain POJO — Hibernate no longer tracks it; `merge()` re-attaches. A **transient** entity has no persistent identity yet — `persist()` schedules INSERT.

### Core concept

The persistence context is the **identity map**. Two calls to `find(Order.class, 42L)` within the same context return the **same Java object reference**. This is why mutating an entity anywhere in the call stack affects what gets flushed — there is no "copy" unless you explicitly detach or DTO-map.

Flush is **not** commit. Flush pushes pending SQL to the database **within** the current transaction. Commit makes the transaction durable. You can flush multiple times in one transaction; you commit once (usually at `@Transactional` method exit).

### Internal working

1. **Transaction begins.** Spring's `JpaTransactionManager.doBegin()` obtains a `EntityManager`, binds it to the transaction (`TransactionSynchronizationManager`), and calls `em.getTransaction().begin()` (resource-local) or joins a JTA transaction.
2. **Load or persist.** `repository.findById()` → `EntityManager.find()` → SELECT if not in context; result becomes **managed**.
3. **Mutation.** Setting `order.setStatus(SHIPPED)` marks the entity dirty in the persistence context. No SQL yet (unless AUTO flush mode triggers).
4. **Flush.** Triggered explicitly (`em.flush()`), implicitly at query time (某些 flush modes), or at transaction commit. Hibernate generates UPDATE/INSERT/DELETE from dirty state.
5. **Commit.** Transaction commits; connection returns to pool; persistence context is cleared; all entities become detached (unless OSIV extends the Session — see section 8).

Hibernate 6 flush order (simplified):

| Order | Action |
|---|---|
| 1 | Entity inserts (respecting dependency order) |
| 2 | Entity updates |
| 3 | Collection element inserts/updates/deletes |
| 4 | Entity deletes |
| 5 | Collection deletes |

Understanding this order explains why a `@PreRemove` listener or FK constraint fails when you delete a parent before orphaning children — the flush order and your cascade settings must align.

**FlushModeType:**

| Mode | Behavior |
|---|---|
| `AUTO` (default) | Flush before queries that might read stale DB state |
| `COMMIT` | Flush only on commit (or explicit flush) — can see stale reads within tx |
| `MANUAL` | Only explicit flush |

### Production scenario: double UPDATE and lost field changes

**Problem.** Two service methods in the same `@Transactional` boundary load the same `Order` by id, modify different fields, and save. One field change disappears in the DB.

**Cause.** Both calls hit the **same managed instance** in the persistence context. The second `findById` does not re-query the database — it returns the cached object. If the second method overwrites the entire object from a DTO (`mapper.toEntity(dto)` replacing the managed instance with a detached copy, then `save()` calls `merge()`), you can clobber in-memory state or generate unexpected UPDATE column sets.

**Solution.** Work on the managed instance returned by the repository, or use DTO projections and `@Modifying` updates for partial field changes. Never `save()` a detached entity built from stale data without merging consciously.

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderRepository orders;

    @Transactional
    public void updateShipping(long id, Address address) {
        Order order = orders.findById(id).orElseThrow();
        order.setShippingAddress(address); // dirty checking handles UPDATE
    }

    @Transactional
    public void updateStatus(long id, OrderStatus status) {
        Order order = orders.findById(id).orElseThrow();
        order.setStatus(status);
    }
}
```

If both run in the same outer transaction, they share one persistence context — this is correct. The bug appears when someone replaces `order` with `orders.save(mapper.fromDto(dto))` where `dto` was built before the other method's changes.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Calling `entityManager.clear()` mid-transaction without understanding | Subsequent lazy loads fail or re-fetch stale; duplicate INSERT attempts |
| Assuming `findById` always hits DB | Stale reads within long transactions |
| Mixing `persist()` and `merge()` on the same logical entity | Duplicate INSERT or `EntityExistsException` |
| `@Transactional` missing on service writing entities | `TransactionRequiredException` or no flush at all |
| Long-running transaction holding managed entities | Memory growth in persistence context; lock duration increases |

### Debugging scenario

**Observe.** UPDATE SQL runs but the column you changed in code is missing from the statement.

**Diagnose.** Enable SQL logging and Hibernate's dirty tracking:

```yaml
logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE
    org.hibernate.event.internal.DefaultFlushEntityEventListener: TRACE
```

Check whether the entity is managed (`entityManager.contains(entity)`). Check whether the field is mapped (`@Column`, not `transient`, not `@Transient`). Check whether a `@DynamicUpdate` entity only includes changed columns — your "missing" column may not have changed from Hibernate's snapshot.

**Fix.** Ensure you're mutating the managed instance. If using Lombok `@Data`, beware `equals`/`hashCode` on entities with collections — see section 3.

---

## 2. Spring Data JPA Architecture

### Core concept

Spring Data JPA is a **factory that generates JDK dynamic proxies** (or bytecode-generated implementations in some cases) implementing your repository interface. The proxy delegates to `SimpleJpaRepository` (default implementation) which holds an `EntityManager`. Custom behavior comes from:

- **Query methods** — parsed at startup by `PartTreeJpaQuery`
- **`@Query`** — `String` or SpEL, compiled by `AbstractStringBasedJpaQuery`
- **Specifications** — composable `Predicate`s
- **Custom fragments** — `YourRepoCustom` + `YourRepoCustomImpl` merged via `JpaRepositoryImplementation`

The proxy also applies **transaction boundaries** on CRUD methods (`@Transactional` on `SimpleJpaRepository` — read-only for queries, read-write for mutations).

### Internal working

Startup sequence (simplified):

```
@EnableJpaRepositories
  └─ JpaRepositoryConfigExtension
       └─ RepositoryBeanDefinitionReader registers factory bean per interface
            └─ JpaRepositoryFactoryBean.getObject()
                 └─ JpaRepositoryFactory.getRepository(interface)
                      ├─ QueryLookupStrategy resolves method → JpaQuery
                      └─ JDK proxy implements interface, routes to JpaQueryExecution
```

**Query derivation** (`findByStatusAndCreatedAtAfter`):

1. `PartTree` parser breaks the method name into parts (`Status`, `CreatedAt`, `After`).
2. `JpaQueryCreator` builds a Criteria query or JPQL string.
3. Type mismatches fail at **startup**, not runtime — unless you use `@Param` wrong.

**@Query** bypasses derivation — you own the JPQL/SQL. Spring validates parameter binding at startup for named parameters.

```java
public interface OrderRepository extends JpaRepository<Order, Long>, JpaSpecificationExecutor<Order> {

    // Derived query → SELECT o FROM Order o WHERE o.status = ?1 AND o.createdAt > ?2
    List<Order> findByStatusAndCreatedAtAfter(OrderStatus status, Instant after);

    @Query("select o from Order o join fetch o.customer c where o.id = :id")
    Optional<Order> findWithCustomer(@Param("id") long id);

    @Query(value = """
        select * from orders o
        where o.status = :status
        order by o.created_at desc
        limit :limit
        """, nativeQuery = true)
    List<Order> topByStatusNative(@Param("status") String status, @Param("limit") int limit);

    // Custom fragment
    // implemented by OrderRepositoryImpl
    List<OrderSummary> searchSummaries(OrderSearchCriteria criteria);
}
```

Custom implementation naming convention:

```java
// OrderRepositoryCustom.java — interface
public interface OrderRepositoryCustom {
    List<OrderSummary> searchSummaries(OrderSearchCriteria criteria);
}

// OrderRepositoryImpl.java — MUST suffix Impl (configurable but default)
@RequiredArgsConstructor
public class OrderRepositoryImpl implements OrderRepositoryCustom {
    private final EntityManager em;

    @Override
    public List<OrderSummary> searchSummaries(OrderSearchCriteria criteria) {
        CriteriaBuilder cb = em.getCriteriaBuilder();
        CriteriaQuery<OrderSummary> cq = cb.createQuery(OrderSummary.class);
        Root<Order> root = cq.from(Order.class);
        cq.select(cb.construct(OrderSummary.class, root.get("id"), root.get("total")));
        // ... predicates
        return em.createQuery(cq).getResultList();
    }
}
```

### Production scenario: repository `@Transactional` vs service `@Transactional` conflict

**Problem.** Team adds `@Transactional(propagation = REQUIRES_NEW)` on a repository method expecting a side effect to commit independently. It never commits separately — everything rolls back with the outer service transaction.

**Cause.** Repository `@Transactional` is applied to the **proxy method**, but if the service already started a transaction, `REQUIRES_NEW` should suspend and create a new one — **unless** the call is self-invocation within the same class or the repository method is `private` (proxy can't intercept). More commonly: the developer used `REQUIRED` (default) unknowingly, or the "independent commit" method is called from within the same bean without going through the proxy.

**Solution.** Put `REQUIRES_NEW` on a **separate Spring bean** (audit writer, outbox publisher), not on the repository. Repositories should stay thin; transaction policy belongs in the service layer.

```java
@Service
@RequiredArgsConstructor
public class AuditService {
    private final AuditLogRepository auditLogs;

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordFailure(String action, String detail) {
        auditLogs.save(new AuditLog(action, detail));
    }
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Repository interface not extending `JpaRepository` / missing `@EnableJpaRepositories` | `No qualifying bean of type 'XRepository'` at startup |
| `OrderRepositoryImpl` wrong suffix or not in scanned package | `Custom` methods throw `UnsupportedOperationException` or empty impl |
| `@Query` JPQL uses entity name vs table name (`from orders` instead of `from Order`) | Startup failure or wrong query |
| `@Param` name mismatch | `QueryCreationException` at startup (good) or binding failure |
| Returning `Optional` for a query that can return multiple rows | `NonUniqueResultException` at runtime |
| `Page` return type without `countQuery` on complex `@Query` | Slow or wrong pagination count |

### Debugging scenario

**Observe.** `findByCustomerEmail` returns empty but SQL run manually finds rows.

**Diagnose.** Log the generated query:

```yaml
logging:
  level:
    org.springframework.data.jpa.repository.query: DEBUG
```

Check: soft-delete filter (`@SQLRestriction`, `@Where`), tenant filter (`@Filter`), wrong enum mapping, case sensitivity on derived query (`Email` vs `email`), or transaction reading a replica that lags.

**Fix.** Align entity filters with expectations; use `@Query` with explicit predicates; verify `@Transactional(readOnly=true)` isn't routing to a lagging replica unintentionally.

---

## 3. Entity Mapping: Associations, Cascades, Embeddables, Inheritance

### Core concept

Entity mapping is a contract between object graph navigation and relational FK constraints. Every association (`@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`) chooses:

- **Ownership** — who owns the FK (`mappedBy` on the inverse side)
- **Fetch type** — `LAZY` (default for collections) vs `EAGER`
- **Cascade** — which operations propagate (`PERSIST`, `MERGE`, `REMOVE`, `ALL`, etc.)
- **Orphan removal** — delete children when removed from collection

Getting any of these wrong produces either **N+1**, **FK constraint violations**, or **cascade DELETE wiping half your database**.

### Internal working

**Bidirectional `@OneToMany` / `@ManyToOne`:**

```java
@Entity
public class Order {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "customer_id", nullable = false)
    private Customer customer;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderLine> lines = new ArrayList<>();

    public void addLine(OrderLine line) {
        lines.add(line);
        line.setOrder(this); // maintain both sides
    }
}

@Entity
public class OrderLine {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;
}
```

Hibernate stores FK on the `@ManyToOne` side (`order_line.order_id`). The `@OneToMany` is inverse — it does not have its own FK column.

**Embeddables:**

```java
@Embeddable
public record Address(String street, String city, String zip) {}

@Entity
public class Customer {
    @Embedded
    @AttributeOverrides({
        @AttributeOverride(name = "city", column = @Column(name = "billing_city"))
    })
    private Address billingAddress;
}
```

**Inheritance strategies:**

| Strategy | DB shape | Tradeoff |
|---|---|---|
| `SINGLE_TABLE` | One table, discriminator column | Fast reads; sparse columns; discriminator discipline required |
| `JOINED` | Base + subclass tables | Normalized; joins on every load |
| `TABLE_PER_CLASS` | Table per concrete class | Polymorphic queries are UNION-heavy; avoid for deep hierarchies |

Hibernate 6 `@MappedSuperclass` is not an entity — no polymorphic queries, but shared column mappings work.

### Production scenario: orphanRemoval deletes production data

**Problem.** Admin removes an `OrderLine` from an order's collection in memory to "cancel one item." The line row is deleted from DB. A month later, finance reports missing line items on fulfilled orders.

**Cause.** `orphanRemoval = true` on `@OneToMany` means removing an element from the collection schedules DELETE on flush — not "disassociate." Developers think they're removing a link; Hibernate deletes the entity.

**Solution.** Model cancellations explicitly (`status = CANCELLED`) or use `@ManyToOne` with a nullable FK and `cascade` without `orphanRemoval`. Reserve `orphanRemoval` for true composition (Order → OrderLine where line cannot exist alone).

### Production scenario: Lombok `@Data` equals/hashCode on entities

**Problem.** Intermittent `LazyInitializationException`, duplicate entities in `Set`, or wrong deduplication in `distinct()`.

**Cause.** `@Data` generates `equals`/`hashCode` using **all fields**, including lazy collections and `@Id` before assignment. Hibernate docs recommend **business key** or **don't implement equals/hashCode** for entities.

**Solution.**

```java
@Entity
@Getter @Setter
@EqualsAndHashCode(onlyExplicitlyIncluded = true)
public class Order {
    @Id @GeneratedValue
    @EqualsAndHashCode.Include
    private Long id;
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `CascadeType.REMOVE` on `@ManyToOne` | Deleting a child deletes the parent |
| `@OneToMany` without `mappedBy` on owning side | Extra join table or FK confusion |
| `EAGER` on collections | Cartesian product explosions |
| `@ManyToMany` without `@OrderColumn` / ordering table when order matters | Random line item order |
| `optional=false` but nullable FK in DB | Schema validation failure at startup |
| `GenerationType.IDENTITY` + batch inserts | Batch insert disabled for that entity |

### Debugging scenario

**Observe.** `ConstraintViolationException: FK_order_customer` on save.

**Diagnose.** Log entity state: is `customer` null? Is it a **transient** reference (id null)? Use `@NotNull` on association + ensure `customerRepository.getReferenceById(id)` or load managed entity before persist.

**Fix.** Persist parent first, or use `cascade = PERSIST` on the association if composition is intended.

---

## 4. Lazy Loading, N+1, Fetch Joins, @EntityGraph, Batch Fetching

### Core concept

Lazy loading defers SELECT until the association is accessed. The proxy (`PersistentBag`, `HibernateProxy`) needs an **open Session**. N+1 is one query for the root list plus one query **per row** when a lazy association is touched in a loop. This is the #1 JPA production performance incident.

Fix hierarchy (prefer top when possible):

1. **DTO projection** — query only needed columns
2. **`join fetch` in JPQL** — single query, watch cartesian products
3. **`@EntityGraph`** — declarative fetch plan on repository method
4. **`@BatchSize` / `hibernate.default_batch_fetch_size`** — batched lazy loads (N+1 → 1 + N/batch)

### Internal working

Lazy proxy initialization:

```java
Order order = orderRepository.findById(1L).orElseThrow();
// SELECT orders ... WHERE id=1

order.getLines().size(); // triggers SELECT order_lines WHERE order_id=1
```

With `hibernate.enable_lazy_load_no_trans=true` (Boot default historically via OSIV), lazy load works outside `@Transactional` service methods **during HTTP render** — masking bugs until you disable OSIV or call the entity from a `@Scheduled` job.

**Fetch join:**

```java
@Query("select distinct o from Order o join fetch o.lines l join fetch o.customer c where o.status = :status")
List<Order> findWithLinesAndCustomer(@Param("status") OrderStatus status);
```

`distinct` matters — join fetch on collections multiplies root rows in the result set; Hibernate deduplicates into one `Order` per id.

**@EntityGraph:**

```java
@EntityGraph(attributePaths = {"customer", "lines"})
Optional<Order> findWithGraphById(Long id);
```

**Batch fetching:**

```java
@Entity
@BatchSize(size = 25)
public class Order { ... }

// or global
spring.jpa.properties.hibernate.default_batch_fetch_size=32
```

Issues 1 query for up to 25 missing associations of the same type.

### Production scenario: N+1 discovered only in prod

**Problem.** Staging has 50 orders; prod has 50,000/day. API latency jumps from 80ms to 4s after launch. DB CPU spikes.

**Cause.** Controller returns `List<Order>` entities; Jackson serializes `customer.name` per order. Each access initializes lazy proxy → N+1. Staging dataset was too small to notice.

**Solution.** Never return entities from REST. Use records/DTOs and a single query.

```java
@Query("""
    select new com.example.api.OrderResponse(o.id, o.status, c.name, o.total)
    from Order o join o.customer c
    where o.status = :status
    """)
List<OrderResponse> findResponsesByStatus(@Param("status") OrderStatus status);
```

Or `@EntityGraph` on a read service method that maps to DTO inside `@Transactional(readOnly = true)`.

### Production scenario: join fetch cartesian product

**Problem.** Query fetching `Order` with `lines` and `payments` (two collections) returns megabytes and times out.

**Cause.** Multiple bag fetch joins create a cartesian product in SQL rows.

**Solution.** Fetch one collection via join; second via `@BatchSize`. Or two queries ( Hibernate `@Fetch(FetchMode.SUBSELECT)` on one collection). Hibernate 6 `@MultipleBagFetchException` at startup if you try two `List` fetch joins in one query.

```java
@Query("select distinct o from Order o join fetch o.lines where o.id = :id")
Optional<Order> findWithLines(@Param("id") long id);
// payments loaded via @BatchSize on Order.payments
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `EAGER` everywhere to "fix" lazy issues | Slow loads always; cartesian products |
| `OpenEntityManagerInViewFilter` + lazy JSON | Hidden N+1; fails when OSIV off |
| `join fetch` + `Pageable` | Wrong count; full result in memory |
| Missing `distinct` on collection fetch join | Duplicate roots in list (Hibernate dedups some cases, not all APIs) |
| `@Transactional(readOnly=true)` on service but lazy load in controller | Works with OSIV; breaks in messaging consumer |

### Debugging scenario

**Observe.** Hibernate statistics show 500 queries for one HTTP request.

**Diagnose.**

```yaml
spring.jpa.properties.hibernate.generate_statistics=true
logging.level.org.hibernate.stat=DEBUG
```

Or datasource-proxy (p6spy, datasource-micrometer). Find the repeating SELECT pattern. Enable query logging temporarily on canary.

**Fix.** Apply one of the fix hierarchy options. Re-test with OSIV disabled (`spring.jpa.open-in-view=false`) to prevent regression.

---

## 5. Transaction Management: @Transactional Propagation, Isolation, readOnly

### Core concept

Spring declarative transactions wrap beans in AOP proxies. `@Transactional` defines:

- **Propagation** — join, suspend, or require existing transaction
- **Isolation** — visibility of concurrent changes (delegated to DB when supported)
- **readOnly** — hint for optimization and, with some drivers, read-only connection
- **rollbackFor / noRollbackFor** — which exceptions trigger rollback
- **timeout** — max transaction duration

Default propagation is `REQUIRED` — join if exists, create if not. Default rollback is **runtime exceptions and Error only** — **checked exceptions commit by default** unless `rollbackFor` specified.

### Internal working

```java
@Transactional(
    propagation = Propagation.REQUIRED,
    isolation = Isolation.READ_COMMITTED,
    readOnly = false,
    timeout = 30,
    rollbackFor = Exception.class
)
public void placeOrder(PlaceOrderCommand cmd) { ... }
```

**Propagation behaviors:**

| Propagation | Behavior |
|---|---|
| `REQUIRED` | Join current tx or create new |
| `REQUIRES_NEW` | Suspend current; always new tx |
| `NESTED` | Savepoint within current tx (requires JDBC savepoint support) |
| `MANDATORY` | Must run inside existing tx; else exception |
| `SUPPORTS` | Join if exists; non-transactional if not |
| `NOT_SUPPORTED` | Suspend current; run without tx |
| `NEVER` | Must not run in tx; else exception |

**Isolation levels** (actual enforcement depends on DB):

| Level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| `READ_UNCOMMITTED` | Possible | Possible | Possible |
| `READ_COMMITTED` | No | Possible | Possible |
| `REPEATABLE_READ` | No | No | Possible (DB-dependent) |
| `SERIALIZABLE` | No | No | No |

PostgreSQL treats `READ_COMMITTED` as default; MySQL InnoDB `REPEATABLE_READ` default. Do not assume Spring's annotation changes behavior the DB doesn't support.

**readOnly=true:**

- Spring sets `FlushMode.MANUAL` / read-only hint on Hibernate Session (version-dependent)
- Can route to read replica if you configured `AbstractRoutingDataSource`
- Does **not** prevent writes if you call `save()` anyway — it's a hint, not a guard

### Production scenario: checked exception commits fraud state

**Problem.** Payment gateway throws `PaymentDeclinedException extends Exception`. Order marked PAID in memory but gateway declined. DB shows PAID.

**Cause.** Checked exception — default `@Transactional` does **not** roll back.

**Solution.**

```java
@Transactional(rollbackFor = Exception.class)
public void checkout(CheckoutRequest req) throws PaymentDeclinedException { ... }
```

Or make domain exceptions extend `RuntimeException`. Team standard: all business failures are unchecked.

### Production scenario: REQUIRES_NEW audit log lost in rollback

**Problem.** Outer transaction rolls back but audit trail of "attempted fraud" is also rolled back.

**Cause.** Audit method used `REQUIRED`, not `REQUIRES_NEW`, or was called via self-invocation (section 7).

**Solution.** Separate bean, `REQUIRES_NEW`, called through injected proxy.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Transactional` on controller | Transaction spans HTTP; connection held during slow client |
| Default rollback on checked exceptions | Partial commits on business failures |
| `REQUIRES_NEW` on private method | Never creates new tx — not proxied |
| `NESTED` expected to commit independently | Savepoint rollback only; outer tx can still roll back all |
| `readOnly=true` with `@Modifying` query | `TransactionRequiredException` or inconsistent flush |
| Isolation `SERIALIZABLE` everywhere | Deadlocks, throughput collapse |

### Debugging scenario

**Observe.** Data partially persisted after error.

**Diagnose.** Log transaction boundaries:

```yaml
logging.level.org.springframework.transaction=TRACE
logging.level.org.springframework.orm.jpa.JpaTransactionManager=DEBUG
```

Check exception type hierarchy. Check whether `catch (Exception e) { ... }` swallows without rethrow. Check multiple datasources — tx manager mismatch.

**Fix.** Explicit rollback rules; rethrow; use `TransactionTemplate` for programmatic control in edge cases.

---

## 6. PlatformTransactionManager & TransactionSynchronization

### Core concept

`PlatformTransactionManager` is Spring's abstraction over local JDBC, JPA, and JTA transactions. For JPA, you use `JpaTransactionManager`. It binds `EntityManager` to the thread via `TransactionSynchronizationManager` — the same mechanism `@Transactional` uses under the hood.

`TransactionSynchronization` callbacks let you run code **after commit**, **after completion**, or **before commit** — the foundation for outbox patterns, cache eviction, and messaging.

### Internal working

```java
@Service
@RequiredArgsConstructor
public class OrderPlacementService {
    private final PlatformTransactionManager txManager;
    private final OrderRepository orders;
    private final ApplicationEventPublisher events;

    public void placeOrder(PlaceOrderCommand cmd) {
        TransactionTemplate template = new TransactionTemplate(txManager);
        template.setTimeout(30);
        Order order = template.execute(status -> {
            Order saved = orders.save(buildOrder(cmd));
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    events.publishEvent(new OrderPlacedEvent(saved.getId()));
                }
            });
            return saved;
        });
    }
}
```

Key `TransactionSynchronization` hooks:

| Callback | When |
|---|---|
| `beforeCommit` | Flush about to happen; can still veto in some setups |
| `beforeCompletion` | Before commit/rollback decision finalized |
| `afterCommit` | Commit succeeded — **safe to publish to Kafka** |
| `afterCompletion` | Commit or rollback — status available |

**Never publish to external messaging in `beforeCommit`** unless you implement transactional outbox — if rollback happens, consumers saw a message for data that doesn't exist.

Boot auto-configures `JpaTransactionManager` when JPA is on classpath. With multiple datasources, you need `@Primary` or `@Qualifier` on both `DataSource` and matching `PlatformTransactionManager`.

```java
@Configuration
public class MultiDataSourceTxConfig {

    @Bean
    @Primary
    PlatformTransactionManager primaryJpaTxManager(
            @Qualifier("primaryEntityManagerFactory") EntityManagerFactory emf) {
        return new JpaTransactionManager(emf);
    }

    @Bean
    PlatformTransactionManager analyticsJpaTxManager(
            @Qualifier("analyticsEntityManagerFactory") EntityManagerFactory emf) {
        return new JpaTransactionManager(emf);
    }
}
```

Use `@Transactional("analyticsJpaTxManager")` on methods targeting analytics DB.

### Production scenario: Kafka message before commit

**Problem.** Consumer processes `OrderCreated` event; calls back to API; order not found. Intermittent.

**Cause.** `@TransactionalEventListener(phase = BEFORE_COMMIT)` or plain `@EventListener` fired before commit; consumer faster than DB commit visibility (or rollback removed the row).

**Solution.**

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) {
    kafkaTemplate.send("orders", event.orderId());
}
```

Better: transactional outbox table in same DB, Debezium/poller publishes after commit.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Transactional` without specifying tx manager (multi-DB) | Writes go to wrong DB or no EM binding |
| `afterCommit` callback throws | Commit already done; partial side effects |
| Registering sync outside active transaction | `IllegalStateException` |
| JTA + resource-local mixed casually | Heuristic commit failures, connection leaks |
| `TransactionTemplate` + `@Transactional` nested blindly | Unexpected propagation |

### Debugging scenario

**Observe.** `EntityManager is closed` in `afterCommit` callback.

**Diagnose.** The persistence context is closed after transaction completion. Don't touch lazy associations in `afterCommit`. Pass ids/primitives to async work.

**Fix.** Publish id-only events; reload in consumer or async worker with new transaction.

---

## 7. Transaction Boundaries: Service Layer, Self-Invocation, Private Methods

### Core concept

Spring AOP proxies intercept **external calls** through the Spring bean. A method calling `this.otherMethod()` inside the same class **bypasses the proxy** — no new transaction, no readOnly, no rollback rules applied on the inner method.

Transaction boundaries belong on the **service layer** (use cases), not repositories (already have defaults), not controllers (too wide), not entities (domain logic shouldn't know Spring).

### Internal working

```java
@Service
public class OrderService {
    @Transactional
    public void cancelOrder(long id) {
        doCancel(id); // self-invocation — @Transactional on doCancel IGNORED
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void doCancel(long id) { ... }
}
```

Fix patterns:

1. **Inject self** (careful — interface-based proxy):

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderRepository orders;
    @Lazy private final OrderService self;

    public void cancelOrder(long id) {
        self.doCancel(id);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void doCancel(long id) { ... }
}
```

2. **Extract to another bean** (preferred):

```java
@Service
@RequiredArgsConstructor
public class OrderCancellationService {
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void cancel(long id) { ... }
}
```

3. **`AopContext.currentProxy()`** — requires `@EnableAspectJAutoProxy(exposeProxy = true)` — rarely worth it.

**Private methods:** `@Transactional` on `private` methods is **silently ignored** (no override possible). Same for `final` methods on CGLIB proxies (class-based proxy).

Proxy mode:

| Mode | Condition | Notes |
|---|---|---|
| JDK proxy | Bean implements interface | Self-injection needs interface type |
| CGLIB | No interface | Concrete class methods proxied unless final |

### Production scenario: readOnly not applied on internal call

**Problem.** Report service method marked `@Transactional(readOnly = true)` but inner `loadHeavyData()` does writes and hits primary DB hard.

**Cause.** Public method calls private `@Transactional(readOnly=true)` helper — annotation ignored on private; or self-invocation on public method.

**Solution.** Move read path to separate bean; enforce layer boundaries in code review.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Transactional` on domain entity | No effect; architectural smell |
| Self-invocation for REQUIRES_NEW | Single tx; partial commits missing |
| Transaction on `@PostConstruct` | Unexpected tx at startup; failures hard to test |
| `@Async` + `@Transactional` on same method | Tx may commit before async work runs — ordering confusion |
| Giant `@Transactional` on class level | Every method in tx; connection held for logging/formatting |

### Debugging scenario

**Observe.** `REQUIRES_NEW` method doesn't commit independently.

**Diagnose.** Put breakpoint in `TransactionAspectSupport` or log `TransactionSynchronizationManager.getCurrentTransactionName()`. Check call stack — is caller same class? Check proxy type.

**Fix.** Extract bean or self-inject through interface.

---

## 8. Open Session In View (OSIV) / spring.jpa.open-in-view

### Core concept

`OpenEntityManagerInViewFilter` (OSIV) keeps the `EntityManager` open for the **entire HTTP request** — from filter entry through view rendering (JSON serialization). Lazy associations load during Jackson writing `customer.address.city`.

Boot default: `spring.jpa.open-in-view=true`. This hides lazy-init bugs and extends connection hold time.

### Internal working

Filter chain:

```
HTTP request
  └─ OpenEntityManagerInViewFilter
       ├─ bind EntityManager to request thread (extends session)
       ├─ DispatcherServlet → Controller → Service (@Transactional may commit here)
       └─ View rendering / MessageConverter still has open Session
            └─ lazy loads succeed
       finally: close EntityManager, release connection (maybe)
```

When service `@Transactional` ends, the **transaction** commits, but OSIV keeps the Session open until response completes. Connection may still be checked out from pool depending on Hibernate release mode (`on_close` vs `after_transaction`).

Hibernate 6 / Boot 3: default connection release mode behavior changed over versions — verify with your exact stack. Treat OSIV as "longer resource hold" regardless.

### Production scenario: disabling OSIV breaks production API

**Problem.** Team sets `spring.jpa.open-in-view=false` per best practice. Half the endpoints throw `LazyInitializationException`.

**Cause.** Controllers return entities with lazy associations; service transaction ended before serialization.

**Solution.** Fix properly — don't re-enable OSIV as permanent band-aid without plan:

```yaml
spring.jpa.open-in-view: false
```

```java
// Explicit fetch in service, return DTO
@Transactional(readOnly = true)
public OrderDetail getOrderDetail(long id) {
    return orderRepository.findDetailById(id).orElseThrow();
}
```

Roll out: disable in staging, run integration tests, fix endpoints, then prod.

### Production scenario: connection pool exhaustion under load

**Problem.** 100 concurrent users, pool size 20, requests hang 30s.

**Cause.** OSIV + slow clients + long JSON serialization holds DB connections. Each request checks out connection at first DB access and may hold until response complete.

**Solution.** Disable OSIV; shorten transactions; increase pool only after fixing hold time; use DTOs.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| OSIV on + `@Transactional` on controller | Very long transactions |
| OSIV off without DTO migration | Widespread LazyInitializationException |
| Assuming readOnly service protects during JSON | OSIV session allows lazy load writes if triggered |
| OSIV in WebFlux (different stack) | Not applicable same way — reactive uses different context |

### Debugging scenario

**Observe.** LazyInitializationException in `@Scheduled` job but HTTP works.

**Diagnose.** HTTP had OSIV; scheduler doesn't. Stack trace points to lazy field access outside `@Transactional`.

**Fix.** `@Transactional` on scheduler service method with fetch join or DTO query.

---

## 9. Flush Modes, Dirty Checking, merge vs persist vs update

### Core concept

Hibernate tracks managed entity state as a snapshot at load time. At flush, it diffs fields and generates UPDATE for changed columns (`@DynamicUpdate` limits columns).

| Operation | Entity state | SQL |
|---|---|---|
| `persist(entity)` | transient → managed | INSERT at flush |
| `merge(entity)` | detached → managed copy | SELECT + INSERT or UPDATE |
| `remove(entity)` | managed → removed | DELETE at flush |
| `save(entity)` (Spring Data) | delegates to `persist` or `merge` based on `isNew()` | INSERT or merge path |

Spring Data `save()` uses `Persistable.isNew()` or `EntityInformation.isNew()` — id null/zero doesn't always mean new if you use assigned ids.

### Internal working

**FlushMode AUTO** flushes before JPQL/Criteria queries that could conflict with pending changes. Example: you INSERT a `Order`, then run `select o from Order o where o.status = PENDING` — AUTO flush ensures the new order appears.

**FlushMode COMMIT** — batch jobs that read millions of rows and write periodically may use COMMIT to avoid flushing on every query — but risk stale query results within tx.

```java
@Transactional
public void bulkAdjust(List<Long> ids) {
    em.setFlushMode(FlushModeType.COMMIT);
    for (Long id : ids) {
        Order o = em.find(Order.class, id);
        o.adjustTotal();
        if (counter++ % 50 == 0) {
            em.flush();
            em.clear(); // detach all — avoid memory blowup
        }
    }
}
```

**merge pitfalls:**

```java
Order detached = orderRepository.findById(1L).orElseThrow(); // tx ends → detached
detached.setStatus(SHIPPED);
orderRepository.save(detached); // merge: may copy state onto managed instance
```

If another transaction changed the same row, merge overwrites with your detached snapshot (last writer wins) unless versioning prevents it.

### Production scenario: persist with non-null id causes duplicate key

**Problem.** Import job `persist()` rows with pre-assigned UUIDs from external system. Random `EntityExistsException`.

**Cause.** Entity has assigned id; Hibernate thinks it's detached/existing and merge path conflicts, or you're calling `persist` on entity Hibernate considers existing.

**Solution.** Implement `Persistable<ID>`:

```java
@Entity
public class ImportedOrder implements Persistable<UUID> {
    @Id
    private UUID id;

    @Transient
    private boolean isNew = true;

    @PostPersist @PostLoad
    void markNotNew() { isNew = false; }

    @Override
    public boolean isNew() { return isNew; }
}
```

### Production scenario: clearAutomatically=false stale persistence context

**Problem.** Bulk `@Modifying` update sets `status='ARCHIVED'` in DB; subsequent `findAll()` in same tx returns old status in entities.

**Cause.** Bulk JPQL bypasses persistence context; managed entities still hold old values.

**Solution.** `@Modifying(clearAutomatically = true, flushAutomatically = true)` or `em.clear()` after bulk update.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `merge` in tight loop | N SELECTs; use `getReference` or bulk update |
| No `@Version` with merge | Lost updates |
| `persist` on detached entity | `PersistentObjectException` |
| `@DynamicUpdate` expected but all columns update | Entity not dirty-tracked (wrong instance) |
| Manual id assignment without `Persistable` | Wrong save path |

### Debugging scenario

**Observe.** INSERT runs twice for same business key.

**Diagnose.** Two transient instances with same id before flush; duplicate persist calls; rollback retry without clear idempotency.

**Fix.** Natural id unique constraint + catch `DataIntegrityViolationException`; use `@GeneratedValue` or proper `Persistable`.

---

## 10. Optimistic vs Pessimistic Locking (@Version, LockModeType)

### Core concept

**Optimistic locking** (`@Version`) detects concurrent updates at flush time — `UPDATE ... WHERE id=? AND version=?`; if row count 0 → `OptimisticLockException`.

**Pessimistic locking** (`LockModeType.PESSIMISTIC_WRITE`) issues `SELECT ... FOR UPDATE` — blocks other writers/readers depending on DB.

Use optimistic for high-read, low-collision. Use pessimistic for inventory/financial counters where retry is expensive or correctness requires serialization.

### Internal working

```java
@Entity
public class Product {
    @Id
    private Long id;

    @Version
    private Long version;

    private int stock;
}
```

```java
@Transactional
public void decrementStock(long productId) {
    Product p = productRepository.findById(productId).orElseThrow();
    if (p.getStock() <= 0) throw new OutOfStockException();
    p.setStock(p.getStock() - 1);
    // flush: UPDATE product SET stock=?, version=version+1 WHERE id=? AND version=?
}
```

Pessimistic:

```java
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("select p from Product p where p.id = :id")
Optional<Product> findByIdForUpdate(@Param("id") long id);
```

Hibernate 6 `@JdbcLock` for timeout hints:

```java
@Lock(LockModeType.PESSIMISTIC_WRITE)
@QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
Optional<Product> findByIdForUpdateWithTimeout(long id);
```

**LockModeType values:**

| Mode | Typical SQL |
|---|---|
| `PESSIMISTIC_READ` | `FOR SHARE` / shared lock |
| `PESSIMISTIC_WRITE` | `FOR UPDATE` |
| `OPTIMISTIC` | No lock at read; version check at flush |
| `PESSIMISTIC_FORCE_INCREMENT` | Lock + version bump |

### Production scenario: lost update without @Version

**Problem.** Two support agents update same ticket; last save wins silently; one's priority change vanishes.

**Cause.** No `@Version`; both read version 1, both write, second overwrites first.

**Solution.** Add `@Version`; handle `OptimisticLockException` with retry or user conflict message.

```java
@ExceptionHandler(OptimisticLockException.class)
ProblemDetail handleStale(OptimisticLockException ex) {
    return ProblemDetail.forStatusAndDetail(CONFLICT, "Record was modified; refresh and retry");
}
```

### Production scenario: pessimistic lock deadlock spiral

**Problem.** Flash sale; DB deadlock graphs show circular waits on `product` rows.

**Cause.** Multiple products locked in different order across transactions.

**Solution.** Lock in consistent global order (sort ids); reduce lock scope; use optimistic + retry for low-stock items; consider DB-native `UPDATE stock = stock - 1 WHERE id=? AND stock > 0`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Version` on `int` with overflow paranoia | Practically fine; Long common |
| Pessimistic lock on `@ManyToOne` without need | Deadlocks spanning joins |
| `@Version` field manually set | Breaks optimistic locking |
| Lock on read-only report query | Throughput collapse |
| `@Lock` on derived query without `@Query` | Ignored or wrong lock applied |

### Debugging scenario

**Observe.** `OptimisticLockException` on entity user didn't edit.

**Diagnose.** Background job updated version; `@Modifying` bulk update didn't bump version (bypasses entity); two tabs same user.

**Fix.** Refresh entity on open; retry policy; ensure bulk updates include version increment or evict from cache.

---

## 11. Auditing (@CreatedDate, Envers)

### Core concept

Spring Data JPA Auditing populates `@CreatedDate`, `@LastModifiedDate`, `@CreatedBy`, `@LastModifiedBy` via `AuditingEntityListener`. Hibernate Envers provides **row-level history** tables tracking every revision.

Auditing answers "who/when"; Envers answers "what did it look like at time T."

### Internal working

Enable auditing:

```java
@Configuration
@EnableJpaAuditing(auditorAwareRef = "auditorAware")
public class AuditingConfig {}

@Component
public class SpringSecurityAuditorAware implements AuditorAware<String> {
    @Override
    public Optional<String> getCurrentAuditor() {
        return Optional.ofNullable(SecurityContextHolder.getContext())
            .map(SecurityContext::getAuthentication)
            .filter(Authentication::isAuthenticated)
            .map(Authentication::getName);
    }
}
```

```java
@Entity
@EntityListeners(AuditingEntityListener.class)
public class Order {
    @CreatedDate
    private Instant createdAt;

    @LastModifiedDate
    private Instant updatedAt;

    @CreatedBy
    private String createdBy;
}
```

Envers:

```java
@Entity
@Audited
public class Order {
    @NotAudited
    private String internalMemo;
}

// query revisions
AuditReader reader = AuditReaderFactory.get(entityManager);
List<Number> revisions = reader.getRevisions(Order.class, orderId);
Order atRev = reader.find(Order.class, orderId, revisions.get(0));
```

### Production scenario: @CreatedBy always null in async worker

**Problem.** Orders created by batch import show `createdBy=null`; HTTP-created orders fine.

**Cause.** `AuditorAware` reads `SecurityContextHolder` — empty in scheduler thread.

**Solution.** Pass actor explicitly for system jobs:

```java
@Service
@RequiredArgsConstructor
public class ImportService {
    private final OrderRepository orders;

    @Transactional
    public void importOrders(List<OrderRow> rows) {
        for (OrderRow row : rows) {
            Order o = map(row);
            o.setCreatedBy("system:import-job");
            orders.save(o);
        }
    }
}
```

Or use `@CreatedBy` with a thread-local override in the job wrapper.

### Production scenario: Envers storage explosion

**Problem.** Table `orders_aud` is 400GB; migrations fail.

**Cause.** `@Audited` on high-churn entities with large columns; every flush creates revision row.

**Solution.** `@NotAudited` on volatile fields; audit selective entities; retention job on `_AUD` tables; consider event sourcing for hot paths instead.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Forgot `@EnableJpaAuditing` | Dates always null |
| `AuditingEntityListener` missing on entity | Partial auditing |
| Envers + `@ElementCollection` | Huge audit tables |
| Expecting Envers on native UPDATE | No revision — bypasses entity layer |
| `@LastModifiedDate` without `@LastModifiedBy` | Incomplete compliance trail |

### Debugging scenario

**Observe.** `createdAt` set but `updatedAt` null on edit.

**Diagnose.** `@LastModifiedDate` missing; entity not dirty (same values saved); listener not registered.

**Fix.** Add field; ensure mutation before flush; verify entity extends audited base class if using mapped superclass listeners.

---

## 12. Specifications, Criteria API, Querydsl

### Core concept

Dynamic queries (optional filters, sort, pagination) degrade into string-concatenated JPQL in junior code. Specifications (`Specification<T>`) compose type-safe predicates. Criteria API is the JPA standard underneath. Querydsl generates meta-model classes (`QOrder`) for fluent queries — excellent for complex reporting; extra build plugin cost.

### Internal working

```java
public record OrderFilter(Optional<OrderStatus> status, Optional<Instant> after, Optional<String> email) {}

public class OrderSpecs {
    public static Specification<Order> statusIs(OrderStatus status) {
        return (root, query, cb) -> cb.equal(root.get("status"), status);
    }

    public static Specification<Order> customerEmailContains(String email) {
        return (root, query, cb) -> {
            Join<Order, Customer> customer = root.join("customer", JoinType.INNER);
            return cb.like(cb.lower(customer.get("email")), "%" + email.toLowerCase() + "%");
        };
    }

    public static Specification<Order> allOf(OrderFilter filter) {
        return Specification.where(filter.status().map(OrderSpecs::statusIs).orElse(null))
            .and(filter.after().map(d -> (Specification<Order>) (root, q, cb) ->
                cb.greaterThan(root.get("createdAt"), d)).orElse(null));
    }
}

// repository
Page<Order> findAll(Specification<Order> spec, Pageable pageable);
```

Avoid `query.distinct(false)` bugs when joining — use `specification` with fetch only in dedicated read methods, not generic `findAll`.

Querydsl (mention — setup):

```xml
<!-- annotation processor for Q-types -->
<dependency>
  <groupId>com.querydsl</groupId>
  <artifactId>querydsl-apt</artifactId>
  <classifier>jakarta</classifier>
  <scope>provided</scope>
</dependency>
```

```java
QOrder order = QOrder.order;
JPAQueryFactory factory = new JPAQueryFactory(em);
List<Order> result = factory.selectFrom(order)
    .where(order.status.eq(OrderStatus.PENDING))
    .fetch();
```

### Production scenario: Specification join duplicates Page total

**Problem.** Paginated order search returns 10 rows but `totalElements` is 10,000; pages mostly empty.

**Cause.** Specification joins collection (`lines`) without `distinct`; count query multiplies rows.

**Solution.**

```java
public static Specification<Order> distinct() {
    return (root, query, cb) -> {
        query.distinct(true);
        return cb.conjunction();
    };
}
```

Or split: id query with filters, then fetch join by ids.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `%email%` like without index | Full table scan |
| Reused Criteria Join in wrong order | Wrong SQL alias |
| Querydsl Q-classes stale after rename | Compile errors |
| Specification for write path with no tx | LazyInitializationException |
| Dynamic OR of AND groups wrong parentheses | Returns entire table |

### Debugging scenario

**Observe.** Slow admin search after adding three optional filters.

**Diagnose.** Enable SQL log; EXPLAIN ANALYZE on generated query. Missing composite index on filtered columns.

**Fix.** Index `(status, created_at)`; rewrite EXISTS subquery instead of join to collection for filter-only.

---

## 13. Native Queries, SqlResultSetMapping, Stored Procedures

### Core concept

Native SQL bypasses entity state management for reads/writes. Use when JPQL can't express the query (window functions, DB-specific hints, CTEs) or for bulk reporting. You lose portability and often bypass automatic flush ordering — manage persistence context manually.

### Internal working

```java
@Query(value = """
    SELECT o.id, o.total, c.name AS customer_name
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.created_at >= :since
    """, nativeQuery = true)
List<OrderReportRow> reportSince(@Param("since") Instant since);

public interface OrderReportRow {
    Long getId();
    BigDecimal getTotal();
    String getCustomerName();
}
```

SqlResultSetMapping for complex mappings:

```java
@SqlResultSetMapping(
    name = "OrderSummaryMapping",
    classes = @ConstructorResult(
        targetClass = OrderSummary.class,
        columns = {
            @ColumnResult(name = "id", type = Long.class),
            @ColumnResult(name = "total", type = BigDecimal.class)
        }
    )
)
@Entity
public class Order { ... }

// used from EntityManager.createNativeQuery("...", "OrderSummaryMapping")
```

Stored procedure:

```java
@Procedure(name = "orders.archive_old")
void archiveOldOrders(@Param("cutoff") Instant cutoff);

// entity mapping
@NamedStoredProcedureQuery(
    name = "orders.archive_old",
    procedureName = "sp_archive_orders",
    parameters = @StoredProcedureParameter(mode = ParameterMode.IN, name = "cutoff", type = Instant.class)
)
@Entity
public class Order { ... }
```

Hibernate 6 `@JdbcTypeCode` for JSON columns in native queries — know your dialect.

### Production scenario: native UPDATE invisible to persistence context

**Problem.** Native query updates statuses; in-memory entities in same request show stale data; downstream Kafka event has wrong status.

**Cause.** Native update doesn't update 1st-level cache.

**Solution.** `em.clear()` after native modifying query; or don't mix entity loads with native updates in same tx; publish events after re-fetch.

### Production scenario: pagination with native query returns wrong page

**Problem.** `nativeQuery` with `Pageable` generates invalid SQL on SQL Server.

**Cause.** Dialect-specific limit/offset syntax; Spring Data needs `@Query(countQuery=...)`.

**Solution.**

```java
@Query(value = "SELECT ... LIMIT :limit OFFSET :offset",
       countQuery = "SELECT count(*) FROM orders WHERE ...",
       nativeQuery = true)
Page<OrderRow> page(..., Pageable pageable);
```

Verify dialect handles parameter binding.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Native SELECT mapped to entity without all columns | `SqlExceptionHelper` mapping errors |
| Snake_case column without `@Column` alias | Null fields in interface projection |
| DDL auto + procedure out of sync | Startup failure |
| Native query in loop | N+1 at SQL level |
| `ddl-auto=update` relying on stored procs | Prod deploy without proc migration |

### Debugging scenario

**Observe.** Interface projection returns all nulls except id.

**Diagnose.** Column aliases must match getter names (`customer_name` → `getCustomer_name` not `getCustomerName`). Use `@SqlResultSetMapping` or explicit alias `AS customerName` with Spring Data closed interface and `@Value("#{...}")` if needed.

**Fix.** Alias columns to match naming strategy; use DTO class mapping instead.

---

## 14. Multi-Tenancy (Discriminator, Schema, Database)

### Core concept

Multi-tenancy isolates tenant data. Hibernate strategies:

| Strategy | Mechanism | Isolation | Cost |
|---|---|---|---|
| DISCRIMINATOR | `tenant_id` column + `@TenantId` / filter | App-level; leak if filter missed | Lowest ops cost |
| SCHEMA | `SET search_path` / schema per tenant | Medium | Migration × tenants |
| DATABASE | Separate DB per tenant | Strongest | Highest ops cost |

Spring + Hibernate 6 `@TenantId` on entity:

```java
@Entity
public class Order {
    @Id
    private Long id;

    @TenantId
    private String tenantId;
}
```

`CurrentTenantIdentifierResolver` supplies tenant from security context:

```java
@Component
public class HeaderTenantResolver implements CurrentTenantIdentifierResolver<String> {
    @Override
    public String resolveCurrentTenantIdentifier() {
        return TenantContext.getRequired();
    }

    @Override
    public boolean validateExistingCurrentSessions() {
        return true;
    }
}
```

### Internal working

DISCRIMINATOR: Hibernate adds `tenant_id = ?` to SQL automatically for `@TenantId` entities. Any `@Query(nativeQuery=true)` **bypasses** tenant filter — footgun.

SCHEMA: `MultiTenantConnectionProvider` selects schema on connection checkout:

```java
public class SchemaMultiTenantConnectionProvider implements MultiTenantConnectionProvider<String> {
    @Override
    public Connection getConnection(String tenantIdentifier) throws SQLException {
        Connection c = dataSource.getConnection();
        c.setSchema(tenantIdentifier);
        return c;
    }
}
```

DATABASE: routing datasource:

```java
public class TenantRoutingDataSource extends AbstractRoutingDataSource {
    @Override
    protected Object determineCurrentLookupKey() {
        return TenantContext.getRequired();
    }
}
```

### Production scenario: cross-tenant data leak via native query

**Problem.** Pen test finds Tenant A sees Tenant B orders via export endpoint.

**Cause.** Developer used native SQL without tenant predicate; `@TenantId` not applied to native queries.

**Solution.** Ban native queries without review; wrap native access in tenant-scoped repository; integration test per tenant; add tenant predicate manually:

```sql
WHERE tenant_id = :tenantId
```

### Production scenario: background job processes wrong tenant

**Problem.** Nightly billing job charges wrong subscriptions.

**Cause.** `TenantContext` ThreadLocal not set in scheduler; resolver returns default tenant "" or null.

**Solution.** Iterate tenants explicitly:

```java
@Scheduled(cron = "0 0 2 * * *")
public void billAllTenants() {
    for (String tenantId : tenantRegistry.allActive()) {
        TenantContext.run(tenantId, () -> billingService.billDue());
    }
}
```

Clear ThreadLocal in `finally`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Missing tenant in JWT but trust header | Spoofing |
| `@TenantId` not on all entities | Partial leak |
| Schema strategy + connection pool reuse without reset | Wrong schema on next request |
| Flyway once for schema-per-tenant | New tenant missing tables |
| Cache keys without tenant prefix | Cross-tenant cache hit |

### Debugging scenario

**Observe.** Random tenant's data in support dashboard.

**Diagnose.** Log `resolveCurrentTenantIdentifier()` at DEBUG on canary. Check MDC; check reactive context if WebFlux.

**Fix.** Mandatory tenant resolver; fail closed if missing; tests assert SQL contains tenant predicate.

---

## 15. Second-Level Cache Pitfalls

### Core concept

First-level cache = persistence context (per Session). Second-level cache = SessionFactory-level shared cache across transactions (`@Cacheable` on entity). Query cache caches result **ids** — even more invalidation complexity.

Providers: EhCache, Caffeine (via JCache), Infinispan, Redis (via Hibernate Redis — less common).

Default in Boot: second-level cache **disabled** unless configured.

### Internal working

```java
@Entity
@Cacheable
@org.hibernate.annotations.Cache(usage = CacheConcurrencyStrategy.READ_WRITE)
public class Product {
    @Id
    private Long id;
    private String sku;
    private BigDecimal price;
}
```

```yaml
spring.jpa.properties.hibernate.cache.use_second_level_cache=true
spring.jpa.properties.hibernate.cache.region.factory_class=org.hibernate.cache.jcache.JCacheRegionFactory
spring.jpa.properties.hibernate.javax.cache.provider=org.ehcache.jsr107.EhcacheCachingProvider
```

Concurrency strategies:

| Strategy | Use case |
|---|---|
| `READ_ONLY` | Immutable reference data |
| `NONSTRICT_READ_WRITE` | Tolerate small stale window |
| `READ_WRITE` | Soft locks for consistency |
| `TRANSACTIONAL` | JTA cache provider required |

Query cache:

```java
@QueryHints(@QueryHint(name = "org.hibernate.cacheable", value = "true"))
List<Product> findByCategory(String category);
```

Invalidation: entity update evicts entity region; query cache regions need manual evict or TTL — stale query cache is a classic bug.

### Production scenario: stale price after update

**Problem.** Product price updated in admin; storefront shows old price for hours.

**Cause.** `@Cacheable` on `Product`; update via `@Modifying` JPQL bypasses cache eviction; or another node still holds cache entry without distributed invalidation.

**Solution.** Evict on write:

```java
@CacheEvict(cacheNames = "products", key = "#id")
@Transactional
public void updatePrice(long id, BigDecimal price) { ... }
```

Or remove L2 cache from mutable entities; cache DTOs at edge/CDN instead.

### Production scenario: `@Cacheable` + lazy collections

**Problem.** `LazyInitializationException` or serialized empty collection when reading cached detached entity.

**Cause.** Cached entity is disassembled/reassembled; lazy collections not initialized.

**Solution.** Cache read-only aggregates without lazy graphs; use `@Cache(usage=READ_ONLY)` on reference data only.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| L2 cache on high-write entity | Stale reads everywhere |
| Query cache without understanding invalidation | Phantom reads |
| No distributed cache in k8s (12 pods) | Each pod different cache |
| `@Cacheable` Spring annotation vs Hibernate `@Cacheable` confusion | Two caching layers fighting |
| Caching `@Entity` with `@OneToMany` eager | Memory bloat in cache region |

### Debugging scenario

**Observe.** DB row updated but application reads old value.

**Diagnose.** Check Hibernate stats cache hit ratio; verify if L2 enabled; check `@Modifying` bypass; check Spring `@Cacheable` on service returning entity from cache outside JPA.

**Fix.** Disable L2 for that entity; evict region; move to immutable reference data pattern.

---

## 16. Connection Pool + Transaction Timeout Interactions

### Core concept

HikariCP (Boot default) pools JDBC connections. A `@Transactional` method checks out a connection at first DB access and holds it until the transaction completes. Long transactions + small pool = thread starvation. `@Transactional(timeout=30)` translates to JDBC query timeout / transaction timeout — behavior varies by driver and whether timeout is enforced at statement or transaction level.

### Internal working

```yaml
spring.datasource.hikari.maximum-pool-size: 20
spring.datasource.hikari.connection-timeout: 30000
spring.datasource.hikari.leak-detection-threshold: 60000
spring.transaction.default-timeout: 30s
```

Hikari metrics: `hikaricp.connections.active`, `pending threads`, `timeout`.

Interaction chain:

```
Thread waits for connection (connection-timeout)
  └─ obtains connection
       └─ @Transactional work (maybe held under OSIV longer)
            └─ statement timeout / tx timeout at DB
                 └─ connection returned to pool (or leaked if exception path bug)
```

JPA streaming (`Stream<T>`) must run within tx and **must close stream** or connection leaks:

```java
@Transactional(readOnly = true)
public void exportOrders(OutputStream out) {
    try (Stream<Order> stream = orderRepository.streamAll()) {
        stream.forEach(o -> writeLine(out, o));
    }
}
```

### Production scenario: pool exhausted — "Cannot get connection"

**Problem.** 503 errors; logs `SQLTransientConnectionException: HikariPool-1 - Connection is not available, request timed out after 30000ms`.

**Cause.** 200 Tomcat threads, pool 20, each request holds connection 2s average under OSIV + external HTTP call inside `@Transactional`.

**Solution.** Remove external calls from transaction; disable OSIV; right-size pool **after** fixing hold time:

```
pool size ≈ ((core_count * 2) + effective_spindle_count)  // old rule
// better: model from (requests/sec * hold_time_ms) / 1000
```

Split read replicas for reports.

### Production scenario: leak detection false positives vs real leaks

**Problem.** Logs warn connection leased for 60s; sometimes legitimate batch job.

**Cause.** `leak-detection-threshold` lower than long report runtime.

**Solution.** Tune threshold; fix real leaks (unclosed `ResultSet`, `Stream`, manual `EntityManager` without close).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `maximum-pool-size` = 200 on small DB | DB CPU melt; context switching |
| Nested `@Transactional` + remote call | Connection held across network |
| `@Async` inherits connection binding | IllegalStateException or leak |
| No timeout on batch job | Runaway tx locks rows |
| Flyway + app same pool maxed | Migrations starve app |

### Debugging scenario

**Observe.** Spikes at top of hour.

**Diagnose.** Micrometer Hikari metrics dashboard; thread dump for blocked `getConnection`; trace slow query log.

**Fix.** Shorten transactions; add index; move cron off peak; consider `pgbouncer`/RDS proxy for connection multiplexing (know prepared statement limitations).

---

## 17. @Modifying Queries, Bulk Updates, clearAutomatically

### Core concept

`@Modifying` on `@Query` executes bulk UPDATE/DELETE JPQL or native SQL **directly against database**, bypassing entity lifecycle and dirty checking. Requires `@Transactional` (Spring Data enforces). Default `clearAutomatically=false` leaves stale entities in persistence context.

### Internal working

```java
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("update Order o set o.status = :newStatus where o.id in :ids")
int bulkUpdateStatus(@Param("ids") Collection<Long> ids, @Param("newStatus") OrderStatus status);

@Modifying
@Query("delete from OrderLine l where l.order.id = :orderId")
void deleteLinesByOrderId(@Param("orderId") long orderId);
```

Return type `int` = affected row count.

Hibernate 6 `@SQLDelete` / `@SQLRestriction` for soft delete:

```java
@Entity
@SQLDelete(sql = "UPDATE orders SET deleted = true WHERE id = ?")
@SQLRestriction("deleted = false")
public class Order { ... }
```

Bulk JPQL won't trigger `@SQLDelete` — use matching WHERE clause.

### Production scenario: bulk archive + JPA load inconsistency

**Problem.** `bulkUpdateStatus(ARCHIVED)` then `findById` in same service returns ACTIVE.

**Cause.** Persistence context not cleared; 1st-level cache stale.

**Solution.** `clearAutomatically = true` or explicit `em.clear()`.

### Production scenario: delete without orphan cleanup

**Problem.** `@Modifying DELETE FROM Order o WHERE o.id = :id` leaves orphan `order_line` rows if FK not CASCADE.

**Cause.** JPQL delete doesn't walk cascades like `entityManager.remove()`.

**Solution.** Delete children first or DB ON DELETE CASCADE; prefer soft delete.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Modifying` without `@Transactional` | `InvalidDataAccessApiUsageException` |
| Bulk update ignores `@Version` | Lost optimistic locking guarantees |
| Expecting `@PreUpdate` listener on bulk | Listener not fired |
| `flushAutomatically=false` before bulk | Wrong row count (pending flush state) |
| RETURNING clause portability | Native-only on PostgreSQL |

### Debugging scenario

**Observe.** `@Modifying` returns 0 rows updated unexpectedly.

**Diagnose.** Flush order; soft-delete filter excludes rows; wrong parameter binding; transaction readOnly.

**Fix.** `@Transactional` read-write; add `AND deleted=false` explicitly; log parameters on canary.

---

## 18. Testing: @DataJpaTest, Testcontainers, @Transactional Rollback

### Core concept

JPA tests sit on a spectrum:

- `@DataJpaTest` — slice: in-memory or Testcontainers DB, only JPA beans, fast
- `@SpringBootTest` — full context; slower; use for integration paths
- `@Transactional` on test class — rollback after each test (default Spring test behavior when using `@Transactional`)

Testcontainers gives prod-like PostgreSQL/MySQL in Docker — catches dialect-specific bugs H2 hides.

### Internal working

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Testcontainers
class OrderRepositoryTest {
    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired OrderRepository orders;

    @Test
    void savesAndFinds() {
        Order o = orders.save(new Order(...));
        assertThat(orders.findById(o.getId())).isPresent();
    }
}
```

`@DataJpaTest` imports `@EntityScan`, configures `TestEntityManager`, **does not** load your `@Service` beans unless `@Import`.

**@Transactional test rollback:**

```java
@SpringBootTest
@Transactional // rolls back after each test method
class OrderServiceIT {
    @Autowired OrderService service;
    @Autowired OrderRepository orders;

    @Test
    void placesOrder() {
        service.placeOrder(...);
        assertThat(orders.count()).isOne();
    } // rollback — count 0 after test
}
```

To commit in one test: `@Commit` or `@Rollback(false)`.

**Testing `@Modifying` and constraints:** use Testcontainers — H2 doesn't enforce same FK/check semantics.

### Production scenario: H2 green, prod migration fails

**Problem.** CI passes; prod Flyway deploy fails on JSON column type.

**Cause.** `@AutoConfigureTestDatabase(replace = ANY)` replaced PostgreSQL with H2; types differ.

**Solution.** Testcontainers + `Replace.NONE`; align Flyway migrations in CI.

### Production scenario: @Transactional test hides missing @Transactional in prod

**Problem.** Test passes; prod throws `TransactionRequiredException`.

**Cause.** Test transaction wraps repository call; prod service missing `@Transactional` on write path.

**Solution.** Add negative test without class-level `@Transactional`; use `@DataJpaTest` for repo, `@SpringBootTest` + `@Commit` for tx boundary tests.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@DataJpaTest` autowiring service | Bean not found |
| Shared Testcontainer without restart between parallel classes | Flaky tests |
| `@DirtiesContext` everywhere | 10-minute CI |
| Mocking `EntityManager` for repo test | Tests implementation not query |
| `@Sql` scripts out of order | FK violations in setup |

### Debugging scenario

**Observe.** Flaky unique constraint failures in tests.

**Diagnose.** Tests not isolated; `@Commit` on one; static ids; parallel execution same DB.

**Fix.** `@Transactional` default rollback; random UUIDs; Testcontainers per class; `@Execution(SAME_THREAD)`.

---

## 19. Spring Data JDBC vs JPA — When to Use Which

### Core concept

**Spring Data JPA** — full ORM, persistence context, lazy loading, caching, complex graphs. Best for rich domain models with associations.

**Spring Data JDBC** — explicit SQL mapping, no lazy loading, no persistence context, aggregate-oriented. Best for simple CRUD on DDD aggregates, performance-predictable reads/writes, when ORM magic hurts more than helps.

### Internal working

Spring Data JDBC:

```java
@Table("orders")
public class Order {
    @Id
    private Long id;
    private OrderStatus status;

    @MappedCollection(idColumn = "order_id")
    private Set<OrderLine> lines = new HashSet<>();
}

public interface OrderRepository extends CrudRepository<Order, Long> {}
```

Loads aggregate in explicit SELECTs — no N+1 surprise, no OSIV debate. Updates replace aggregate state — know your SQL.

JPA shines when:

- Complex object graph navigation
- Optimistic locking, auditing, Envers
- Portable JPQL across DBs (somewhat)
- Existing Hibernate ecosystem (filters, interceptors)

JDBC shines when:

- Microservice owns one-table-ish aggregate
- Predictable SQL latency
- Team tired of LazyInitializationException
- Event sourcing / CQRS read side

Hybrid in one app is possible but **two transaction managers** — avoid unless bounded context split.

### Production scenario: JPA team ships reporting on entities

**Problem.** Report endpoints OOM; GC pauses; query count 50k.

**Cause.** JPA entity graph for read-heavy aggregate export.

**Solution.** Move read model to Spring Data JDBC or plain `@JdbcClient` / jOOQ; keep JPA for write model only (CQRS-lite).

### Production scenario: JDBC aggregate missing child rows

**Problem.** Save order; only header persisted.

**Cause.** Forgot `@MappedCollection`; or save only root without children populated.

**Solution.** JDBC requires explicit aggregate design — document save/load paths; integration test child rows.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| JPA for simple CRUD microservice | Accidental complexity |
| JDBC with cross-aggregate lazy-like loading | Manual join explosion in code |
| Mixing JPA and JDBC same aggregate | Two sources of truth |
| JPA `@ManyToMany` everywhere in new JDBC service | Wrong tool |

### Debugging scenario

**Choose JPA vs JDBC for new payments service.**

**Decision factors:** Need pessimistic row locks + complex state machine with history → JPA + Envers. Need append-only payment records, idempotent inserts, strict SQL → JDBC. Need both → separate read/write stores.

---

## 20. Production Debugging Playbook

When JPA misbehaves in production, it is usually **transaction boundaries**, **session scope**, **N+1**, or **stale cache/persistence context**.

1. **Classify the symptom.**
   - `LazyInitializationException` → session closed; OSIV off; access outside `@Transactional`
   - `OptimisticLockException` → concurrent update; missing retry UX
   - `CannotAcquireLockException` / deadlock → pessimistic locks; wrong order
   - Pool timeout → long tx; OSIV; leak
   - Wrong data → stale L2 cache; bulk update without clear; wrong tenant filter
   - Slow → N+1; missing index; cartesian fetch join

2. **Enable targeted diagnostics on canary only:**

   ```yaml
   logging.level.org.hibernate.SQL: DEBUG
   logging.level.org.hibernate.orm.jdbc.bind: TRACE
   logging.level.org.springframework.transaction: TRACE
   logging.level.org.springframework.orm.jpa: DEBUG
   spring.jpa.properties.hibernate.generate_statistics: true
   ```

   Turn off within hours — log volume and PII risk.

3. **Count queries per request.** Datasource proxy, p6spy, or Hibernate statistics `QueryExecutionCount`. Healthy read endpoint: O(1) queries, not O(n).

4. **Confirm transaction boundaries.** Log `@Transactional` method entry/exit; verify no HTTP/external IO inside. Check self-invocation.

5. **Inspect persistence context.** In staging debugger: `entityManager.contains(entity)`, flush mode, number of managed entities in long batch jobs (`em.clear()` cadence).

6. **Verify SQL matches mental model.** EXPLAIN ANALYZE on prod-like data volume. Check soft-delete filter, tenant predicate, join type.

7. **Connection pool metrics.** Hikari active vs idle; correlation with latency spikes. Thread dump threads blocked on `getConnection`.

8. **Reproduce with OSIV disabled locally.** `spring.jpa.open-in-view=false` exposes lazy bugs before prod.

9. **Schema vs code drift.** Flyway history; Hibernate `ddl-auto` never in prod; check `@Column` length vs DB.

10. **Rollback forensics.** Was exception checked and swallowed? Did `REQUIRES_NEW` actually run? Outbox vs direct Kafka publish timing?

---

## 21. Quick Decision Matrix

| Situation | Do this |
|---|---|
| REST API returns domain graph | DTO + explicit query; never entity with lazy fields |
| Optional filters admin search | `Specification` or Querydsl; index matched columns |
| High-read reference data | `@Cacheable` service DTO or READ_ONLY L2; not mutable entity cache |
| Inventory / wallet / seat booking | Optimistic `@Version` + retry, or pessimistic `FOR UPDATE` + ordered locks |
| Bulk status change 100k rows | `@Modifying` JPQL + `clearAutomatically`; batch job not per-entity load |
| Async / Kafka after DB write | `AFTER_COMMIT` listener or outbox table |
| Independent audit log on failure | Separate bean + `REQUIRES_NEW` via injected proxy |
| Multi-tenant SaaS | `@TenantId` + resolver; ban native SQL without tenant; test cross-tenant |
| Reporting / analytics | Read replica + JDBC/jOOQ; not JPA entity crawl |
| Simple microservice CRUD aggregate | Spring Data JDBC |
| Complex aggregate + history | JPA + Envers on selective entities |
| Lazy load errors after deploy | Fix fetch/DTO; don't re-enable OSIV without cause |
| Tests pass H2, prod fails | Testcontainers PostgreSQL/MySQL in CI |
| Connection pool timeouts | Shorten tx; remove remote calls inside `@Transactional`; then tune pool |
| Lost updates | `@Version` + 409 conflict response |
| JSON column / window functions | Native query or `@JdbcClient`; evict/clear context after |

---

## 22. Scenario-Based Questions

### 1. API returns 500 with LazyInitializationException after disabling OSIV — why?

**Root cause.** Controllers returned JPA entities; Jackson accessed lazy `customer` or `lines` after the service `@Transactional` method committed and closed the persistence context. OSIV previously kept the session open through serialization.

**Fix.** Return DTOs; use `join fetch` or `@EntityGraph` in a `@Transactional(readOnly=true)` service method that maps to the response. Re-enable OSIV only as temporary migration aid, not the end state.

---

### 2. Single order detail endpoint fires 47 SQL queries — what happened?

**Root cause.** Classic N+1: one query for order, then one per line, one per product, one per customer field accessed in the mapper loop. Staging dataset had 3 lines; prod orders average 40 lines.

**Fix.** Single JPQL with `join fetch` for collections needed, `@BatchSize` on secondary associations, or better — projection query returning `OrderDetailDto` in one round trip. Verify with Hibernate statistics: target 1–3 queries.

---

### 3. `@Transactional` rollback doesn't happen on payment failure — data committed?

**Root cause.** Payment failure thrown as checked `Exception`; default Spring rollback applies only to unchecked exceptions. Catch block logged and swallowed without rethrow in some code paths.

**Fix.** `@Transactional(rollbackFor = Exception.class)` or unchecked domain exceptions; never swallow in catch without rethrow; add test asserting DB unchanged on failure.

---

### 4. `REQUIRES_NEW` audit method still rolls back with main transaction — why?

**Root cause.** Self-invocation: outer service called `this.writeAudit()` internally, bypassing Spring proxy. Both run in same transaction.

**Fix.** Move audit to `AuditService` bean; inject and call through proxy. Verify with TRACE logging showing transaction suspend/resume.

---

### 5. OptimisticLockException on every other checkout click — users furious?

**Root cause.** Hot `Product` row with `@Version`; two tabs or double-submit causes concurrent updates. No retry or UI merge strategy.

**Fix.** Idempotent checkout token; retry with exponential backoff on `OptimisticLockException`; UI shows "price changed, refresh"; consider `UPDATE stock = stock - 1 WHERE id=? AND stock>=1` for decrement without full entity merge.

---

### 6. Admin bulk archive updated DB but UI still shows active orders until refresh?

**Root cause.** `@Modifying` bulk JPQL updated rows in database; persistence context still holds old managed `Order` instances with previous status (`clearAutomatically=false` default).

**Fix.** `@Modifying(clearAutomatically=true, flushAutomatically=true)` or `entityManager.clear()` after bulk; re-fetch ids for response; evict Spring `@Cacheable` if present.

---

### 7. Scheduled job throws LazyInitializationException on order.getCustomer().getEmail()?

**Root cause.** Job method not `@Transactional`; or transaction ended before lazy access; no OSIV in scheduler thread.

**Fix.** `@Transactional` on job service with fetch join query returning needed data, or DTO query selecting email directly.

---

### 8. Connection pool exhausted every Monday morning — only reports?

**Root cause.** Weekly report `@Transactional` streaming 2M rows while holding connection; parallel reports × Tomcat threads exceed Hikari pool; each report runs 20 minutes.

**Fix.** Batch processing with `Stream` + periodic `clear()`, read replica, non-JPA export (COPY TO STDOUT), `@Transactional(timeout=...)` fail fast, schedule off peak, separate pool for batch if needed.

---

### 9. Tenant A user sees Tenant B invoice — P1 security incident?

**Root cause.** Native SQL report query without `tenant_id` predicate; `@TenantId` not applied to native queries. Support role runs report across all rows.

**Fix.** Add mandatory tenant filter; code review rule for native SQL; integration test proving tenant isolation; fail if `TenantContext` empty.

---

### 10. `@Version` column null for migrated legacy rows — updates fail?

**Root cause.** Data migration inserted rows with `version IS NULL`; Hibernate optimistic lock requires non-null version.

**Fix.** Backfill `UPDATE product SET version = 0 WHERE version IS NULL`; add NOT NULL default on column; `@Version` on primitive `long` defaults to 0 for new entities.

---

### 11. `@DataJpaTest` passes; production fails FK constraint on save?

**Root cause.** H2 in-memory with `MODE=PostgreSQL` still differs; or test used `@Transactional rollback hiding missing parent entity; prod enforces FK.

**Fix.** Testcontainers with prod dialect; assert parent exists; use Flyway migrations in tests.

---

### 12. Envers audit table growing 5GB/month — compliance wants history but ops suffering?

**Root cause.** `@Audited` on high-churn `Order` entity including line items; every field change duplicates full snapshot.

**Fix.** `@NotAudited` on volatile fields; audit header entity only; archival job on `_AUD` tables; event store for business-critical history instead of full Envers on all tables.

---

### 13. `findById` returns stale data within same request after native update?

**Root cause.** Native UPDATE executed; first-level cache not cleared; subsequent `findById` returns managed entity without re-selecting.

**Fix.** `em.clear()` or `refresh(entity, LockModeType.PESSIMISTIC_WRITE)` after native modify; avoid mixing patterns in one transaction.

---

### 14. Pagination returns duplicate orders across pages?

**Root cause.** Sort by non-unique column (`created_at`) without tie-breaker id; concurrent inserts shift offsets.

**Fix.** `Pageable` sort: `Sort.by("createdAt").and("id")`; or keyset pagination `WHERE (created_at, id) > (:lastCreated, :lastId)`.

---

### 15. `@ManyToMany` join table missing rows after save?

**Root cause.** Owning side not set; only inverse side collections updated; no `mappedBy` sync.

**Fix.** Maintain owning side in domain method; in `@ManyToMany`, one side must own FK join table updates.

---

### 16. Hibernate `@SQLRestriction("deleted = false")` — admin can't see deleted records?

**Root cause.** Global filter applies to all queries including admin restore UI.

**Fix.** Separate repository method with `@Query` including deleted flag bypass ( Hibernate `@Filter` with enable/disable on Session) or use `@SQLRestriction` only on specific entity views.

---

### 17. Second-level cache shows old product price after flash sale update?

**Root cause.** Price updated via `@Modifying` JPQL; L2 cache not evicted; other pods serve cached entity.

**Fix.** Evict cache region on update; distributed cache (Redis) with TTL; don't L2-cache mutable hot entities.

---

### 18. `merge()` caused duplicate OrderLine rows?

**Root cause.** Detached entity graph with lines lacking ids treated as new; cascade MERGE inserts new lines instead of updating.

**Fix.** Load managed aggregate; mutate in place; or match lines by id in merge logic; use `orphanRemoval` carefully.

---

### 19. `@Transactional(readOnly=true)` on service but DB still gets INSERT audit rows?

**Root cause.** Audit aspect or Envers in separate `REQUIRES_NEW` write transaction — expected. Or `readOnly` ignored because method was private/self-invoked and ran read-write default.

**Fix.** Verify proxy applies readOnly; move writes to explicit write service; audit writes intentional.

---

### 20. Spring Data `saveAll` on 50k entities takes hours?

**Root cause.** Identity generation prevents JDBC batching; flush each entity; no `hibernate.jdbc.batch_size`; N round trips.

**Fix.**

```yaml
spring.jpa.properties.hibernate.jdbc.batch_size: 50
spring.jpa.properties.hibernate.order_inserts: true
spring.jpa.properties.hibernate.order_updates: true
```

Use `saveAll` in chunks with `flush()` and `clear()` between batches; consider bulk insert via native SQL for imports.

---

*JPA will not save you from a missing tenant predicate or an N+1 in a loop. The persistence context is powerful and invisible — keep transaction boundaries short, fetch plans explicit, and disable OSIV once your API returns DTOs. Test against the prod database engine, not only H2.*
