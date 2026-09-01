# Spring Data JPA & Transactions Mastery — Senior Production Reference

Spring Boot 3.x / Hibernate 6.x / Jakarta Persistence 3.1. This is not a getting-started guide. It is the map of what actually breaks in production after shipping JPA-backed services at scale — N+1 queries that only appear under load, transactions that silently don't roll back, lazy proxies that explode in JSON serializers, and connection pool starvation that masquerades as "random timeouts."

---

## Table of Contents

1. [Mental Model: EntityManager, Session, Persistence Context, Flush Lifecycle](#1-mental-model-entitymanager-session-persistence-context-flush-lifecycle)
2. [Spring Data JPA Architecture](#2-spring-data-jpa-architecture)
3. [Entity Mapping: Associations, Cascades, Embeddables, Inheritance](#3-entity-mapping-associations-cascades-embeddables-inheritance)
4. [Entity Design Pitfalls Catalog](#4-entity-design-pitfalls-catalog)
5. [Lazy Loading, N+1, Fetch Joins, @EntityGraph, Batch Fetching](#5-lazy-loading-n1-fetch-joins-entitygraph-batch-fetching)
6. [Fetching Strategy Decision Tree](#6-fetching-strategy-decision-tree)
7. [Projections (interface, open/closed, DTO, constructor JPQL, records, dynamic projections, SQL comparison)](#7-projections-interface-openclosed-dto-constructor-jpql-records-dynamic-projections-sql-comparison)
8. [DTO Mapping Strategies (MapStruct vs manual, transaction boundary)](#8-dto-mapping-strategies-mapstruct-vs-manual-transaction-boundary)
9. [Transaction Management: @Transactional Propagation, Isolation, readOnly](#9-transaction-management-transactional-propagation-isolation-readonly)
10. [All @Transactional Propagation Values with Worked Examples + Matrix](#10-all-transactional-propagation-values-with-worked-examples-matrix)
11. [Rollback Rules (UnexpectedRollbackException sequence)](#11-rollback-rules-unexpectedrollbackexception-sequence)
12. [Isolation Levels via @Transactional](#12-isolation-levels-via-transactional)
13. [PlatformTransactionManager & TransactionSynchronization](#13-platformtransactionmanager-transactionsynchronization)
14. [Transaction Boundaries: Service Layer, Self-Invocation, Private Methods](#14-transaction-boundaries-service-layer-self-invocation-private-methods)
15. [Open Session In View (OSIV) / spring.jpa.open-in-view](#15-open-session-in-view-osiv-springjpaopen-in-view)
16. [Flush Modes, Dirty Checking, merge vs persist vs update](#16-flush-modes-dirty-checking-merge-vs-persist-vs-update)
17. [Hibernate 6 Specifics (SQM, batching, @BatchSize, IDENTITY batch failure)](#17-hibernate-6-specifics-sqm-batching-batchsize-identity-batch-failure)
18. [Read-Only Transactions and Performance](#18-read-only-transactions-and-performance)
19. [Optimistic vs Pessimistic Locking (@Version, LockModeType)](#19-optimistic-vs-pessimistic-locking-version-lockmodetype)
20. [Concurrency Locking Recap with SKIP LOCKED Queue Pattern](#20-concurrency-locking-recap-with-skip-locked-queue-pattern)
21. [Auditing (@CreatedDate, Envers)](#21-auditing-createddate-envers)
22. [Specifications, Criteria API, Querydsl](#22-specifications-criteria-api-querydsl)
23. [Native Queries, SqlResultSetMapping, Stored Procedures](#23-native-queries-sqlresultsetmapping-stored-procedures)
24. [Multi-Tenancy (Discriminator, Schema, Database)](#24-multi-tenancy-discriminator-schema-database)
25. [Second-Level Cache Pitfalls](#25-second-level-cache-pitfalls)
26. [Connection Pool + Transaction Timeout Interactions](#26-connection-pool-transaction-timeout-interactions)
27. [@Modifying Queries, Bulk Updates, clearAutomatically](#27-modifying-queries-bulk-updates-clearautomatically)
28. [Testing: @DataJpaTest, Testcontainers, @Transactional Rollback](#28-testing-datajpatest-testcontainers-transactional-rollback)
29. [Spring Data JDBC vs JPA — When to Use Which](#29-spring-data-jdbc-vs-jpa-when-to-use-which)
30. [Pagination, Sorting, and Keyset Patterns](#30-pagination-sorting-and-keyset-patterns)
31. [Custom Repositories, Query Hints, and Fetch Profiles](#31-custom-repositories-query-hints-and-fetch-profiles)
32. [Production Debugging Playbook](#32-production-debugging-playbook)
33. [Quick Decision Matrix](#33-quick-decision-matrix)

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
5. **Commit.** Transaction commits; connection returns to pool; persistence context is cleared; all entities become detached (unless OSIV extends the Session — see section 15).

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

**Fix.** Ensure you're mutating the managed instance. If using Lombok `@Data`, beware `equals`/`hashCode` on entities with collections — see sections 3 and 4.

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

## 4. Entity Design Pitfalls Catalog

### Core concept

Section 3 covered *how* to map associations. This section is the catalog of mapping decisions that compile, pass code review, pass H2 tests — and then corrupt data or collapse performance in production. Each item here has been a real incident somewhere. Treat this as the checklist you run against a new entity before it reaches a migration.

The unifying theme: **an entity is not a POJO.** It has a lifecycle (transient → managed → detached → removed), an identity that may not exist yet, proxies that lie about their class, and collections that Hibernate replaces with its own implementations at load time. Every pitfall below is a place where "normal Java thinking" collides with one of those four facts.

### Internal working

**1. `equals`/`hashCode` — the pre-flush `HashSet` trap**

Three strategies, in order of preference:

| Strategy | Rule | When it breaks |
|---|---|---|
| Business/natural key | `equals` on immutable business fields (`sku`, `email`, `orderNumber`) | Requires a truly immutable natural key |
| ID with null guard | `equals` returns `false` if either id is null; `hashCode` is a **constant** | Degrades `HashSet` to a list scan — fine for small collections |
| ID naive (`Objects.equals(id, other.id)`, `Objects.hash(id)`) | Simplest | **Broken** — this is the pre-flush trap |

The trap, concretely:

```java
Order order = new Order();
Set<OrderLine> lines = new HashSet<>();

OrderLine line = new OrderLine("SKU-1", 2);   // id == null
lines.add(line);                              // hashCode() computed from null id → bucket A
assertThat(lines.contains(line)).isTrue();    // passes

em.persist(order);
em.flush();                                   // Hibernate assigns line.id = 5001

assertThat(lines.contains(line)).isFalse();   // FAILS — hashCode changed, wrong bucket
lines.remove(line);                           // silently does nothing
```

`hashCode()` **must be stable for the object's lifetime while it is in a hash container**. `@GeneratedValue` makes ID-based `hashCode` unstable by definition, because the id changes exactly once — at flush — and nobody rehashes the set. The symptoms are indirect and awful: `orphanRemoval` fires on the wrong element, `Set.remove()` no-ops, `contains()` returns false for an element that is visibly present, and Hibernate's own collection-dirtying logic (which uses the set's semantics) computes the wrong delete list.

Correct implementations:

```java
// Preferred: natural key
@Entity
public class Product {
    @Id @GeneratedValue private Long id;

    @NaturalId
    @Column(nullable = false, updatable = false, unique = true)
    private String sku;

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        // instanceof, NOT getClass() — Hibernate proxies are subclasses
        if (!(o instanceof Product other)) return false;
        return sku != null && sku.equals(other.sku);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(sku); // immutable → stable
    }
}
```

```java
// Fallback: ID with null care + constant hashCode
@Entity
public class Order {
    @Id @GeneratedValue private Long id;

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Order other)) return false;
        return id != null && id.equals(other.getId()); // null id → never equal to anything else
    }

    @Override
    public int hashCode() {
        return 31; // constant: stable across the id assignment at flush
    }
}
```

Two subtleties in that code that are easy to miss. First, `instanceof` instead of `getClass() != o.getClass()`: a lazy `@ManyToOne` gives you `Order$HibernateProxy$xyz`, whose `getClass()` is a generated subclass, so `getClass()`-based equality declares a proxy unequal to the entity it proxies. Second, always compare through the **getter** (`other.getId()`) not the field (`other.id`) — reading a field directly on a proxy bypasses the interceptor that triggers initialization and returns `null` for every field.

**2. Bidirectional relationship sync methods**

Hibernate writes the FK from the **owning** side (`@ManyToOne`). If you only touch the inverse `@OneToMany` collection, the FK is never set — or, with `nullable = false`, the insert fails. If you only touch the owning side, your in-memory collection is stale for the rest of the transaction. Encapsulate both:

```java
@Entity
public class Order {
    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private final List<OrderLine> lines = new ArrayList<>();

    public void addLine(OrderLine line) {
        lines.add(line);
        line.setOrder(this);
    }

    public void removeLine(OrderLine line) {
        lines.remove(line);
        line.setOrder(null); // required for orphanRemoval to fire the DELETE
    }

    public List<OrderLine> getLines() {
        return Collections.unmodifiableList(lines); // callers cannot desync the graph
    }
}
```

Returning an unmodifiable view is the part teams skip, and it is the part that prevents the bug. A public mutable getter means any caller can do `order.getLines().add(line)` and skip your sync logic.

**3. `CascadeType.ALL` + `orphanRemoval` on a large collection**

`CascadeType.ALL` includes `REMOVE`. Combined with `orphanRemoval` on a collection with 100k children, `orderRepository.delete(order)` does this:

```sql
select * from order_lines where order_id = ?   -- loads all 100k into the persistence context
delete from order_lines where id = ?           -- ×100,000, one statement per row
delete from orders where id = ?
```

Hibernate must load every child to fire lifecycle callbacks and cascade further. That is 100k managed entities in the persistence context (OOM risk) and 100k round trips. For bulk composition, bypass the entity layer:

```java
@Modifying
@Query("delete from OrderLine l where l.order.id = :orderId")
int deleteLinesByOrderId(@Param("orderId") long orderId);
```

Or push it to the schema with `ON DELETE CASCADE` and tell Hibernate not to bother:

```java
@OneToMany(mappedBy = "order")
@OnDelete(action = OnDeleteAction.CASCADE) // emits ON DELETE CASCADE in generated DDL
private List<OrderLine> lines = new ArrayList<>();
```

**4. Unidirectional `@OneToMany` — the delete-all-then-reinsert pattern**

A `@OneToMany` **without** `mappedBy` has no inverse side, so Hibernate has nowhere to record which row changed. Its only correct strategy is to wipe the association and rewrite it:

```java
@Entity
public class Order {
    @OneToMany(cascade = CascadeType.ALL) // NO mappedBy — unidirectional
    @JoinColumn(name = "order_id")
    private List<OrderLine> lines = new ArrayList<>();
}
```

Remove one line out of five and Hibernate emits:

```sql
update order_lines set order_id = null where order_id = ?   -- detach all 5
update order_lines set order_id = ? where id = ?            -- reattach line 1
update order_lines set order_id = ? where id = ?            -- reattach line 2
update order_lines set order_id = ? where id = ?            -- reattach line 3
update order_lines set order_id = ? where id = ?            -- reattach line 4
```

Five statements to delete one row, and it needs `order_id` to be nullable. With `@OrderColumn` it gets worse — the index column is rewritten for every element after the removal point. Always make `@OneToMany` bidirectional with `mappedBy`, or model the child with a `@ManyToOne` and query it directly.

**5. `List` vs `Set`, and `MultipleBagFetchException`**

| Collection type | Hibernate calls it | Fetch-join limit | Notes |
|---|---|---|---|
| `List` without `@OrderColumn` | **bag** (unordered, duplicates allowed) | **One bag per query** | Two `join fetch` on bags → `MultipleBagFetchException` at bootstrap |
| `List` with `@OrderColumn` | list (indexed) | One | Index column maintenance cost on middle-removal |
| `Set` | set | Multiple sets fetch-joinable | Requires correct `equals`/`hashCode` (see item 1) |

```
org.hibernate.loader.MultipleBagFetchException:
  cannot simultaneously fetch multiple bags: [com.acme.Order.lines, com.acme.Order.payments]
```

This fails at **startup** (for `@EntityGraph`/`@NamedEntityGraph`) or at query-parse time, not under load — which is the one merciful thing about it. Three fixes: change both to `Set`, fetch one collection and `@BatchSize` the other, or run two queries. Note that switching to `Set` makes the SQL *legal* but still produces a Cartesian product of `lines × payments` rows on the wire; legal is not the same as fast. See section 6.

**6. `@ElementCollection` — value semantics, delete-and-reinsert**

`@ElementCollection` holds **values**, not entities: no identity, no lifecycle, no independent queries. Because rows have no id, any modification rewrites the whole collection:

```java
@Entity
public class Customer {
    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "customer_tags", joinColumns = @JoinColumn(name = "customer_id"))
    @Column(name = "tag")
    private Set<String> tags = new HashSet<>();
}
```

Adding one tag to a 50-element set:

```sql
delete from customer_tags where customer_id = ?  -- all 50 gone
insert into customer_tags (customer_id, tag) values (?, ?)  -- ×51
```

Use `@ElementCollection` only for genuinely small, rarely-modified value sets. Anything with a lifecycle, an audit requirement, or more than ~20 elements should be a real entity with `@OneToMany`. Also: Envers on an `@ElementCollection` writes the full delete/reinsert churn into the audit tables.

**7. `@Enumerated(ORDINAL)` — silent data corruption**

`ORDINAL` is the JPA **default** when you write a bare `@Enumerated`, and it stores the enum's declaration index:

```java
public enum OrderStatus { PENDING, PAID, SHIPPED, CANCELLED }
// PENDING=0, PAID=1, SHIPPED=2, CANCELLED=3
```

Someone alphabetizes the enum, or inserts `REFUNDED` in the middle, and every historical row silently changes meaning. There is no error, no constraint violation, no failing test — the database still holds `2`, it just means something different now. Always:

```java
@Enumerated(EnumType.STRING)
@Column(name = "status", length = 20, nullable = false)
private OrderStatus status;
```

Add a DB `CHECK` constraint or a lookup table so an unknown string fails loudly rather than throwing `IllegalArgumentException: No enum constant` deep in a mapper. If you have inherited `ORDINAL` columns, migrate with an explicit mapping table — do not "just switch to STRING" and hope.

**8. `@Lob` and streaming**

`@Lob` on `String`/`byte[]` loads the entire value into heap on every entity load, even when nobody reads it. A 20MB PDF column on an entity fetched in a list of 100 is 2GB of heap.

```java
// Bad: 20MB into heap on every load
@Lob private byte[] document;

// Better: separate entity, lazy, loaded only on demand
@Entity
public class OrderDocument {
    @Id private Long orderId;

    @Lob
    @Basic(fetch = FetchType.LAZY) // needs bytecode enhancement — see section 20
    private byte[] content;
}
```

`@Basic(fetch = LAZY)` on a scalar is a **hint that Hibernate ignores** without bytecode enhancement (`hibernate-enhance-maven-plugin` with `enableLazyInitialization`). The reliable pattern is a separate table/entity, or streaming outside JPA:

```java
jdbcTemplate.query("select content from order_documents where order_id = ?",
    rs -> { try (InputStream in = rs.getBinaryStream(1)) { in.transferTo(out); } return null; },
    orderId);
```

**9. UUID primary keys and index locality**

Random UUIDv4 primary keys destroy B-tree insert locality: each insert lands in a random leaf page, so the working set of dirty pages is the whole index instead of the tail. On InnoDB (clustered PK) this also fragments the table itself. See the SQL note for the page-split mechanics and measured write-amplification numbers.

```java
// Hibernate 6: time-ordered UUIDv7-style generator — sequential prefix, keeps locality
@Id
@GeneratedValue
@UuidGenerator(style = UuidGenerator.Style.TIME)
private UUID id;
```

Also store it as a real `uuid`/`binary(16)` type, not `varchar(36)` — 16 bytes vs 36, and every secondary index in InnoDB carries a copy of the PK.

**10. `@ManyToOne(fetch = LAZY)` is not the default**

`@ManyToOne` and `@OneToOne` default to **`EAGER`**; only `@OneToMany` and `@ManyToMany` default to `LAZY`. This is the single highest-leverage line in this entire section:

```java
@ManyToOne(fetch = FetchType.LAZY, optional = false)
@JoinColumn(name = "customer_id", nullable = false)
private Customer customer;
```

Without it, loading one `Order` joins or selects `Customer`, which eagerly loads *its* `@ManyToOne`s, transitively. A five-entity chain of default `@ManyToOne`s means loading a list of 100 orders issues hundreds of queries nobody asked for — and no amount of `@EntityGraph` tuning can turn `EAGER` off at query time. `EAGER` is a permanent, global decision; `LAZY` is a default you override per use case.

`@OneToOne(fetch = LAZY)` on the **inverse** (`mappedBy`) side additionally cannot be lazy without bytecode enhancement: Hibernate must query to know whether the row exists, so it cannot hand back a proxy. Use `@MapsId` (item 11) or bytecode enhancement.

**11. `@MapsId` — shared primary key for `@OneToOne`**

The naive `@OneToOne` gives the child its own id plus an FK, which allows two children to reference the same parent and forces an extra column and index. `@MapsId` makes the FK *be* the PK:

```java
@Entity
public class OrderDetail {
    @Id
    private Long id; // no @GeneratedValue — derived from the association

    @MapsId
    @OneToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "id")
    private Order order;
}
```

One column instead of two, the 1:1 cardinality is enforced by the PK itself, and the owning side becomes genuinely lazy because the id is already known.

**12. Composite keys: `@EmbeddedId` vs `@IdClass`**

| Aspect | `@EmbeddedId` | `@IdClass` |
|---|---|---|
| Key shape | One embedded object field | Key fields duplicated on the entity |
| JPQL | `o.id.orderId` | `o.orderId` |
| Readability | Explicit, groups the key | Flatter queries |
| Requirements | `@Embeddable`, `equals`/`hashCode`, `Serializable`, no-arg ctor | Same on the ID class, plus mirrored fields |

```java
@Embeddable
public class OrderLineId implements Serializable {
    private Long orderId;
    private Integer lineNo;
    // no-arg ctor, equals, hashCode REQUIRED
}

@Entity
public class OrderLine {
    @EmbeddedId
    private OrderLineId id;

    @MapsId("orderId") // maps the orderId part of the composite key to this association
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "order_id")
    private Order order;
}
```

Prefer `@EmbeddedId`. Both require correct `equals`/`hashCode` **on the key class** — the persistence context is a `Map` keyed by `(entityClass, id)`, so a broken key `hashCode` means `find()` misses entities that are already managed and you get duplicate inserts. In greenfield designs, prefer a surrogate `@Id` plus a unique constraint on the business tuple; composite keys propagate into every FK that references the table.

### Production scenario: orphanRemoval fires on the wrong line after flush

**Problem.** An invoice-correction endpoint removes a single line from an order. In production it deletes the *wrong* line roughly 30% of the time, and occasionally deletes two. The unit test passes every run.

**Cause.** `OrderLine` used Lombok `@EqualsAndHashCode` restricted to the generated `id`, and `Order.lines` was a `HashSet`. Lines added within the request had `id == null` when they entered the set, so they were bucketed on `Objects.hash((Object) null)`. After `flush()` assigned real ids, `hashCode()` changed but the set was never rehashed. `lines.remove(target)` looked in the bucket for the *new* hash, found nothing there, and returned `false` — while Hibernate's own collection-diffing walked the set with the same broken semantics and produced a delete list that did not match intent. The test passed because it never flushed between `add` and `remove`, so no hash ever changed.

**Solution.** Give `OrderLine` a stable identity — a natural key if one exists, otherwise a client-generated UUID assigned in the constructor so it is non-null from birth:

```java
@Entity
public class OrderLine {
    @Id @GeneratedValue private Long id;

    // Stable from construction: independent of the DB-generated id.
    @Column(name = "line_uid", nullable = false, updatable = false, unique = true)
    private final UUID lineUid = UUID.randomUUID();

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof OrderLine other)) return false;
        return lineUid.equals(other.lineUid);
    }

    @Override
    public int hashCode() {
        return lineUid.hashCode();
    }
}
```

And make the regression test flush in the middle, which is the only way this class of bug is caught:

```java
@Test
void setSemanticsSurviveFlush() {
    Order order = new Order();
    OrderLine line = new OrderLine("SKU-1", 2);
    order.addLine(line);
    em.persist(order);

    em.flush(); // <-- the step the original test skipped; ids get assigned here

    assertThat(order.getLines()).contains(line);
    order.removeLine(line);
    em.flush();
    assertThat(em.createQuery("select count(l) from OrderLine l", Long.class)
        .getSingleResult()).isZero();
}
```

### Production scenario: `@Enumerated(ORDINAL)` corrupts six months of orders

**Problem.** A refactor adds a `REFUNDED` status. After deploy, the dashboard shows thousands of historical `SHIPPED` orders as `CANCELLED`, and the fulfilment integration starts re-shipping paid orders.

**Cause.** `@Enumerated` with no `EnumType` argument defaults to `ORDINAL`. The enum was `{PENDING, PAID, SHIPPED, CANCELLED}` and the refactor inserted `REFUNDED` after `PAID`, shifting `SHIPPED` from 2 to 3 and `CANCELLED` from 3 to 4. Every existing row storing `2` now decoded as `REFUNDED` and `3` as `SHIPPED`. Nothing threw: the integers were all still valid ordinals. The enum change was reviewed as a pure code change with no migration attached, because no column definition appeared in the diff.

**Solution.** Migrate to `STRING` with an explicit mapping keyed off the *old* ordinals, then constrain the column so future unknown values fail loudly.

```sql
alter table orders add column status_str varchar(20);

-- Explicit old-ordinal → name mapping, written against the PRE-refactor enum order.
update orders set status_str = case status
    when 0 then 'PENDING'
    when 1 then 'PAID'
    when 2 then 'SHIPPED'
    when 3 then 'CANCELLED'
end;

alter table orders alter column status_str set not null;
alter table orders drop column status;
alter table orders rename column status_str to status;
alter table orders add constraint orders_status_chk
    check (status in ('PENDING','PAID','SHIPPED','CANCELLED','REFUNDED'));
```

```java
@Enumerated(EnumType.STRING)
@Column(name = "status", length = 20, nullable = false)
private OrderStatus status;
```

The migration must run **before** the code that adds `REFUNDED` ships — order the deploy as migration first, then application. Add an ArchUnit or Checkstyle rule banning bare `@Enumerated` so this cannot recur:

```java
@ArchTest
static final ArchRule no_ordinal_enums = fields()
    .that().areAnnotatedWith(Enumerated.class)
    .should(haveEnumTypeString());
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Lombok `@Data` / `@EqualsAndHashCode` on an entity | Unstable `hashCode`; `Set.remove()` no-ops; lazy fields initialized by `toString()` |
| `getClass()` comparison in `equals` | Proxy never equals entity; duplicates in `Set`; failed `contains()` |
| Reading `other.id` field instead of `other.getId()` | `null` from an uninitialized proxy; everything unequal |
| Bare `@Enumerated` | `ORDINAL` storage; silent corruption on enum reorder |
| `@OneToMany` without `mappedBy` | Delete-all-then-reinsert on every collection change |
| Two `List` collections fetch-joined | `MultipleBagFetchException` at bootstrap |
| `@ElementCollection` with hundreds of rows | Full delete + reinsert on any change |
| `@Lob` on a hot entity | Heap spikes; slow list queries |
| Default `@ManyToOne` (EAGER) | Transitive eager graph; hundreds of unasked-for queries |
| `@OneToOne` inverse side expected lazy | Always eager without bytecode enhancement |
| Composite key class without `equals`/`hashCode` | Duplicate inserts; `find()` misses managed entities |
| Random UUIDv4 clustered PK | Index fragmentation; write amplification |

### Debugging scenario

**Observe.** Deleting one child row emits six SQL statements, and `order_id` must be nullable for it to work at all.

**Diagnose.** Log the statements and look at their *shape*, not just their count:

```yaml
logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.jdbc.bind: TRACE
```

`update order_lines set order_id = null where order_id = ?` followed by N reattach updates is the unmistakable signature of a unidirectional `@OneToMany`. Check the mapping for a missing `mappedBy`. If instead you see one `delete` per row for a bulk parent delete, that is `CascadeType.REMOVE` walking the collection. If you see a full `delete` + reinsert of every element, look for `@ElementCollection`.

**Fix.** Add the inverse `@ManyToOne` and `mappedBy`, add sync methods that maintain both sides, and make the child FK `nullable = false` — which then *prevents* the delete-all-reinsert pattern from ever being introduced again, because it would violate the constraint.

---

## 5. Lazy Loading, N+1, Fetch Joins, @EntityGraph, Batch Fetching

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

## 6. Fetching Strategy Decision Tree

### Core concept

Section 5 listed the tools. This section is the **decision procedure**: given a use case, which fetch strategy do you pick, and what does the emitted SQL look like when you do?

The governing rule: **fetch type is a mapping-level default; fetch plan is a query-level decision.** Map everything `LAZY`, then declare per query exactly what that query needs. `EAGER` in the mapping is a global, irreversible commitment — there is no `@EntityGraph` that turns it off — so it converts a per-query decision into an architecture decision, always in the wrong direction.

```
What does this use case need?
│
├─ A few scalar fields, no behaviour, read-only?
│    └─ PROJECTION (section 7). One query, only those columns.
│       Beats every fetch strategy — nothing to initialize.
│
├─ A full aggregate to MUTATE (one root)?
│    ├─ one collection needed  →  join fetch / @EntityGraph
│    └─ 2+ collections needed  →  fetch one, @BatchSize or SUBSELECT the rest
│                                  (or one query per collection on the same root)
│
├─ A PAGE of roots plus their collections?
│    └─ TWO-QUERY PATTERN: page the ids, then fetch by id list.
│       NEVER join fetch a collection with Pageable.
│
├─ A list of roots plus their @ManyToOne parents?
│    └─ join fetch (no row multiplication) or @EntityGraph
│
└─ Already-loaded entities, association needed conditionally?
     └─ @BatchSize (batched lazy) or Hibernate.initialize() at a known point
```

### Internal working

**Baseline: what lazy actually emits**

```java
List<Order> orders = orderRepository.findByStatus(PENDING); // 100 rows
for (Order o : orders) {
    total = total.add(o.getCustomer().getDiscountRate()); // LAZY @ManyToOne
}
```

```sql
select o.* from orders o where o.status = 'PENDING';                 -- 1
select c.* from customers c where c.id = ?;                          -- ×100
```

101 queries. Now each fix, with its SQL.

**`join fetch` on a `@ManyToOne` — the safe case**

```java
@Query("select o from Order o join fetch o.customer where o.status = :status")
List<Order> findByStatusWithCustomer(@Param("status") OrderStatus status);
```

```sql
select o.id, o.status, o.total, o.customer_id,
       c.id, c.name, c.discount_rate
from orders o
join customers c on c.id = o.customer_id
where o.status = ?;
```

One query, 100 rows, no multiplication — a `@ManyToOne` join fetch is always to-one, so the root row count is preserved. This is the cheapest correct fix and it composes: you can join fetch several to-one associations in one query without any Cartesian risk.

**`join fetch` on a collection — row multiplication**

```java
@Query("select o from Order o join fetch o.lines where o.status = :status")
List<Order> findByStatusWithLines(@Param("status") OrderStatus status);
```

```sql
select o.id, o.status, o.total,
       l.id, l.order_id, l.sku, l.qty
from orders o
join order_lines l on l.order_id = o.id
where o.status = ?;
```

100 orders × 8 lines average = 800 rows on the wire, with every order column repeated 8 times. Hibernate 6 deduplicates roots automatically — **`distinct` in JPQL is no longer needed for that purpose** (Hibernate 6 sets `hibernate.query.passDistinctThrough=false` semantics by default and does not push `DISTINCT` into SQL for entity queries). Adding `distinct` on Hibernate 5 was necessary; on 6 it can push a real `SELECT DISTINCT` to the database and cost you a sort over the whole result set. Drop it.

The wire cost is the real problem and it is quadratic in the number of collections. Two collections at 8 and 3 elements is 24 rows per order — 2,400 rows to return 100 orders.

**`@EntityGraph` — the same plan, declaratively**

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    // FETCH: listed paths EAGER, everything else falls back to its mapped default
    @EntityGraph(attributePaths = {"customer", "lines"}, type = EntityGraph.EntityGraphType.FETCH)
    Optional<Order> findWithCustomerAndLinesById(Long id);

    // LOAD: listed paths EAGER, unlisted paths keep their mapping (EAGER stays EAGER)
    @EntityGraph(attributePaths = {"customer"}, type = EntityGraph.EntityGraphType.LOAD)
    Optional<Order> findWithCustomerById(Long id);
}
```

| Type | Listed attributes | Unlisted attributes |
|---|---|---|
| `FETCH` (default in Spring Data) | `EAGER` | Treated as `LAZY` regardless of mapping |
| `LOAD` | `EAGER` | Keep their **mapped** fetch type |

`FETCH` is what you almost always want: it makes the query's fetch plan total and explicit, so a stray `EAGER` in the mapping does not leak extra joins into your carefully tuned query. `LOAD` is for the case where you want to *add* to the mapped defaults. Note that `@EntityGraph` generates **LEFT OUTER JOIN**, whereas `join fetch` in JPQL defaults to inner join — so `@EntityGraph` on a nullable `@ManyToOne` keeps roots with no parent, while `join fetch` silently drops them. That difference has caused more "missing rows" incidents than the performance difference has caused outages.

Named graphs, when the same plan is reused:

```java
@Entity
@NamedEntityGraph(
    name = "Order.detail",
    attributeNodes = {
        @NamedAttributeNode("customer"),
        @NamedAttributeNode(value = "lines", subgraph = "lines.product")
    },
    subgraphs = @NamedSubgraph(
        name = "lines.product",
        attributeNodes = @NamedAttributeNode("product"))
)
public class Order { ... }

// repository
@EntityGraph("Order.detail")
Optional<Order> findDetailById(Long id);
```

Subgraphs are how you fetch two levels deep (`order → lines → product`) in one query. The `attributePaths` form supports dotted paths for the same effect: `attributePaths = {"lines", "lines.product"}`.

**`join fetch` + `Pageable` — the in-memory pagination trap**

```java
@Query("select o from Order o join fetch o.lines")
Page<Order> findAllWithLines(Pageable pageable); // ← broken
```

```
WARN org.hibernate.orm.query -
  HHH90003004: firstResult/maxResults specified with collection fetch;
  applying in memory
```

Hibernate cannot apply `LIMIT`/`OFFSET` to the multiplied row set, because 20 SQL rows might be 3 orders or 20 orders — the boundary is meaningless. So it **removes the limit from the SQL, fetches the entire result set into heap, and paginates the deduplicated list in Java.** Ten million orders, page 1 of 20: ten million rows loaded to return twenty. This is a `WARN`, not an error, so it ships to production and looks like "the DB got slow."

The count query is broken too. Spring Data derives `select count(o) from Order o join fetch o.lines`, which counts multiplied rows, so `totalElements` reports line count rather than order count and the UI shows phantom pages.

**Fix: the two-query pattern**

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    // Query 1: page over ROOT rows only — real SQL LIMIT/OFFSET, correct count
    @Query(value = "select o.id from Order o where o.status = :status",
           countQuery = "select count(o.id) from Order o where o.status = :status")
    Page<Long> findIdPage(@Param("status") OrderStatus status, Pageable pageable);

    // Query 2: fetch the full graph for exactly those ids — no LIMIT, no multiplication problem
    @Query("select distinct o from Order o join fetch o.lines where o.id in :ids")
    List<Order> findAllWithLinesByIdIn(@Param("ids") List<Long> ids);
}
```

```java
@Transactional(readOnly = true)
public Page<OrderDto> page(OrderStatus status, Pageable pageable) {
    Page<Long> ids = orders.findIdPage(status, pageable);
    if (ids.isEmpty()) {
        return Page.empty(pageable);
    }
    List<Order> loaded = orders.findAllWithLinesByIdIn(ids.getContent());

    // Query 2 returns rows in DB order; restore the page's sort order.
    Map<Long, Order> byId = loaded.stream()
        .collect(Collectors.toMap(Order::getId, Function.identity()));
    List<OrderDto> content = ids.getContent().stream()
        .map(byId::get)
        .map(OrderDto::from)
        .toList();

    return new PageImpl<>(content, pageable, ids.getTotalElements());
}
```

Two queries, both with correct SQL, bounded memory, and a correct total. The re-ordering step matters — the `in :ids` query has no `ORDER BY`, so without it your carefully sorted page comes back shuffled.

**`@BatchSize` — batched lazy loading**

```java
@Entity
public class Order {
    @OneToMany(mappedBy = "order")
    @BatchSize(size = 25)
    private List<OrderLine> lines = new ArrayList<>();
}
```

Touching `lines` on the first of 100 orders makes Hibernate load 25 orders' collections at once:

```sql
select l.* from order_lines l where l.order_id in (?,?,?, ... 25 params);
```

100 orders → 1 + 4 queries instead of 1 + 100. Set it globally so you get the benefit without annotating every association:

```yaml
spring:
  jpa:
    properties:
      hibernate:
        default_batch_fetch_size: 32
```

This one property is the highest value-per-character line in a JPA configuration. It cannot fix a true N+1 down to one query, but it turns a 500-query request into a 16-query request with zero code change, and it is the correct partner for the "fetch one collection, batch the rest" pattern.

**Subselect fetching**

```java
@OneToMany(mappedBy = "order")
@Fetch(FetchMode.SUBSELECT)
private List<OrderLine> lines = new ArrayList<>();
```

```sql
select l.* from order_lines l
where l.order_id in (select o.id from orders o where o.status = ?); -- original query re-run
```

One extra query regardless of root count — better than `@BatchSize` for large result sets. The cost: the original query's `WHERE` clause is re-executed by the database, so an expensive predicate is paid twice. `SUBSELECT` also only works for collections loaded from a query, not from `find()`.

**`Hibernate.initialize()` — conditional initialization**

```java
@Transactional(readOnly = true)
public OrderView load(long id, boolean includeLines) {
    Order order = orders.findById(id).orElseThrow();
    if (includeLines) {
        Hibernate.initialize(order.getLines()); // explicit, inside the transaction
    }
    return OrderView.of(order, includeLines);
}
```

Useful when the fetch decision is genuinely dynamic and you want it at a visible line of code rather than hidden in a getter call three layers down. `Hibernate.isInitialized(x)` lets a mapper check before touching. Prefer dynamic projections (section 7) when the *shape* varies, not just the depth.

**When a projection beats every fetch strategy**

The order-list screen shows order number, status, customer name, and line count. With the best possible fetch strategy:

```sql
select o.*, c.*, l.* from orders o
join customers c on c.id = o.customer_id
left join order_lines l on l.order_id = o.id
where o.status = ?;
-- 800 rows, ~40 columns, full entity hydration, 900 managed objects in the persistence context
```

With a projection:

```java
public record OrderRow(Long id, String orderNumber, OrderStatus status,
                       String customerName, long lineCount) {}

@Query("""
    select new com.acme.api.OrderRow(o.id, o.orderNumber, o.status, c.name, count(l.id))
    from Order o
    join o.customer c
    left join o.lines l
    where o.status = :status
    group by o.id, o.orderNumber, o.status, c.name
    """)
List<OrderRow> rows(@Param("status") OrderStatus status);
```

```sql
select o.id, o.order_number, o.status, c.name, count(l.id)
from orders o
join customers c on c.id = o.customer_id
left join order_lines l on l.order_id = o.id
where o.status = ?
group by o.id, o.order_number, o.status, c.name;
-- 100 rows, 5 columns, zero managed entities, zero dirty checking, zero proxies
```

100 rows instead of 800, five columns instead of forty, and nothing enters the persistence context — so there is no dirty-check pass at flush and no `LazyInitializationException` possible downstream. **No fetch strategy can beat not loading the data.** If the use case is read-only and does not need entity behaviour, stop tuning fetch plans and write a projection.

### Production scenario: `Pageable` + `join fetch` OOMs the pod at 10M rows

**Problem.** The admin order list is `Page<Order>` with `@EntityGraph(attributePaths = "lines")`. It works for 18 months. When the `orders` table passes ten million rows, the pod OOMs on the first request after every restart, and `totalElements` has been reporting roughly eight times the real order count the whole time — nobody noticed because the UI only shows page numbers.

**Cause.** `@EntityGraph` on a collection combined with `Pageable` triggers HHH90003004. Hibernate dropped `LIMIT`/`OFFSET` from the SQL, streamed all ten million multiplied rows into the persistence context, deduplicated in Java, and returned twenty. The count query counted joined rows, hence the 8× inflation (average lines per order). The `WARN` was in the logs from day one, filtered out by the log pipeline as noise.

```
WARN o.h.orm.query : HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory
```

**Solution.** Two-query pattern, and a projection for the list screen since it only needs five fields.

```java
public interface OrderRepository extends JpaRepository<Order, Long> {

    @Query(value = """
            select new com.acme.api.OrderRow(o.id, o.orderNumber, o.status, c.name, count(l.id))
            from Order o
            join o.customer c
            left join o.lines l
            where (:status is null or o.status = :status)
            group by o.id, o.orderNumber, o.status, c.name
            """,
           countQuery = """
            select count(o.id) from Order o
            where (:status is null or o.status = :status)
            """)
    Page<OrderRow> pageRows(@Param("status") OrderStatus status, Pageable pageable);
}
```

The explicit `countQuery` is mandatory here: the derived count would wrap the `group by` and count groups through a subquery on some dialects and fail outright on others. With `LIMIT 20 OFFSET 0` restored to real SQL and only five columns projected, the endpoint went from OOM to 14ms.

Guard the regression with a query-count assertion (section 28) and promote the Hibernate warning to an error so it can never be filtered again:

```yaml
logging:
  level:
    org.hibernate.orm.query: WARN   # keep HHH90003004 visible
```

```java
@Test
void orderListPageDoesNotFetchCollectionsInMemory() {
    SQLStatementCountValidator.reset();
    orders.pageRows(PENDING, PageRequest.of(0, 20));
    SQLStatementCountValidator.assertSelectCount(1);
}
```

### Production scenario: `@EntityGraph` inner-join semantics hides orders without a customer

**Problem.** After switching a query from `@EntityGraph` to a hand-written `join fetch` for "performance parity," the daily reconciliation report drops 340 orders. No error, no warning; the totals just do not add up.

**Cause.** `@EntityGraph` emits `LEFT OUTER JOIN`. JPQL `join fetch` without `left` emits `INNER JOIN`. The 340 orders were guest checkouts with `customer_id IS NULL`, and the inner join silently excluded them. The two forms are usually described as equivalent, and for a non-nullable association they are — the mapping had `optional = true` and nobody checked.

**Solution.** Use `left join fetch` whenever the association is nullable, and make the mapping state the intent so the next reader can see it:

```java
@ManyToOne(fetch = FetchType.LAZY, optional = true) // guest checkout: no customer
@JoinColumn(name = "customer_id")
private Customer customer;
```

```java
@Query("select o from Order o left join fetch o.customer where o.createdAt >= :since")
List<Order> findSinceWithCustomer(@Param("since") Instant since);
```

```sql
select o.*, c.* from orders o
left join customers c on c.id = o.customer_id
where o.created_at >= ?;
```

Add a test that asserts the row count is preserved — the only reliable guard against a join-type regression:

```java
@Test
void nullableAssociationFetchKeepsAllRoots() {
    long all = orders.count();
    assertThat(orders.findSinceWithCustomer(Instant.EPOCH)).hasSize((int) all);
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `EAGER` in the mapping | Extra joins on every query; no way to opt out per query |
| `join fetch` collection + `Pageable` | HHH90003004; whole table in heap; inflated `totalElements` |
| Derived count query over a `group by` projection | Wrong `totalElements` or dialect-specific SQL error |
| `distinct` kept in Hibernate 6 entity queries | Real `SELECT DISTINCT` pushed to DB; needless sort |
| `join fetch` (inner) on a nullable association | Roots silently dropped from results |
| Two collection fetch joins | `MultipleBagFetchException`, or a Cartesian product with `Set` |
| No `default_batch_fetch_size` | Every unavoidable lazy load is a full N+1 |
| `@Fetch(SUBSELECT)` on an expensive query | Original `WHERE` predicate executed twice |
| `Hibernate.initialize` outside the transaction | `LazyInitializationException` |
| `in :ids` fetch query with no re-ordering step | Page content returned in arbitrary order |

### Debugging scenario

**Observe.** A paginated endpoint returns 20 rows in 6 seconds and heap climbs on every call.

**Diagnose.** Look for the warning first — it names the exact problem:

```yaml
logging:
  level:
    org.hibernate.SQL: DEBUG
    org.hibernate.orm.query: WARN
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true
```

If `HHH90003004` appears, stop — it is in-memory pagination and nothing else matters. If not, check whether the emitted SQL contains `limit`/`offset` at all; its absence with a `Pageable` parameter is the same diagnosis by another route. Then compare `Statistics.getEntityLoadCount()` against the page size: loading 10,000 entities to return 20 is conclusive.

**Fix.** Replace with the two-query pattern, or drop to a projection if the screen is read-only. Then assert the query count in a test so the regression cannot return.

---

## 7. Projections (interface, open/closed, DTO, constructor JPQL, records, dynamic projections, SQL comparison)

### Core concept

A **projection** is a query result that is not a managed entity. Spring Data JPA supports several projection types — each trades type safety, query flexibility, and runtime cost differently. The governing rule from section 6 applies here: if the use case is read-only and does not need entity behaviour, **stop loading entities** and project only the columns you need.

| Projection type | Mechanism | Best for |
|---|---|---|
| **Interface (closed)** | Spring Data generates implementation from getter names | Simple column subsets; derived queries |
| **Interface (open / SpEL)** | `@Value("#{...}")` on getters | Computed fields; nested paths |
| **DTO class** | Class with matching property names | Imperative mapping; Jackson-friendly |
| **Constructor / record** | JPQL `select new ...` | Explicit, type-safe, one query |
| **Dynamic** | `Class<T>` or `Optional<Class<T>>` parameter | Same repository method, varying shape |

Nothing in a projection enters the persistence context — no dirty checking, no proxies, no `LazyInitializationException`.

### SQL comparison by projection type

| Projection type | Typical SQL shape | Round trips | Persistence context | N+1 risk |
|---|---|---|---|---|
| Closed interface | `SELECT o.id, o.order_number, o.status FROM orders o WHERE ...` | 1 | None | Low if derived query only selects root columns |
| Open interface (SpEL) | Same root SELECT; SpEL may fire extra SELECTs per row | 1 + lazy | None for root | **High** if `@Value` touches associations |
| DTO class (property names) | Same as closed interface | 1 | None | Low |
| Constructor / record JPQL | `SELECT o.id, o.order_number, c.name FROM orders o JOIN customer c ...` | 1 | None | **None** — joins explicit in JPQL |
| Dynamic `Class<T>` | Varies by runtime type argument | 1 | None if projection type | Medium — must whitelist allowed types |
| Full entity `Order.class` | `SELECT o.* FROM orders o ...` | 1 | **Yes** — managed | High if lazy fields accessed after query |

**Rule of thumb:** constructor/record projections give you the SQL you wrote; interface projections give you the SQL Spring Data inferred — verify both in integration tests.

### Internal working

**Closed interface projection** — Spring Data matches getter names to entity properties:

```java
public interface OrderSummary {
    Long getId();
    String getOrderNumber();
    OrderStatus getStatus();
}

public interface OrderRepository extends JpaRepository<Order, Long> {
    List<OrderSummary> findByStatus(OrderStatus status);
    // SELECT o.id, o.order_number, o.status FROM orders o WHERE o.status = ?
}
```

Only properties with getters are selected. Adding `getCustomerName()` without a matching path fails at startup (closed projection).

**Open interface projection** — SpEL expressions compute values:

```java
public interface OrderRow {
    Long getId();
    String getOrderNumber();

    @Value("#{target.customer.name}")
    String getCustomerName();

    @Value("#{target.lines.size()}")
    int getLineCount();
}
```

Open projections can trigger lazy loads if the query did not fetch `customer` or `lines` — you traded entity hydration for **hidden N+1 inside the projection**. Always pair open projections with explicit `join` in `@Query` or verify SQL in tests.

**DTO class projection** — property names must match entity aliases:

```java
public class OrderListDto {
    private final Long id;
    private final String orderNumber;
    private final OrderStatus status;

    public OrderListDto(Long id, String orderNumber, OrderStatus status) {
        this.id = id;
        this.orderNumber = orderNumber;
        this.status = status;
    }
    // getters
}

List<OrderListDto> findByStatus(OrderStatus status);
```

**Constructor / record projection** — explicit JPQL, full control over SQL:

```java
public record OrderRow(Long id, String orderNumber, OrderStatus status, String customerName) {}

@Query("""
    select new com.acme.api.OrderRow(o.id, o.orderNumber, o.status, c.name)
    from Order o join o.customer c
    where o.status = :status
    """)
List<OrderRow> rows(@Param("status") OrderStatus status);
```

Records are ideal for read models: immutable, equals/hashCode for free, Jackson serializes cleanly. Constructor expressions must use the **fully qualified class name** in JPQL.

**Dynamic projections** — one method, multiple return shapes:

```java
<T> List<T> findByStatus(OrderStatus status, Class<T> type);

// Usage
List<OrderSummary> summaries = repo.findByStatus(PENDING, OrderSummary.class);
List<Order> entities = repo.findByStatus(PENDING, Order.class); // full entity when needed
```

Spring Data inspects the `Class` argument at runtime and builds the appropriate select list. Useful for admin vs API views without duplicating repository methods — but harder to reason about in code review; document the allowed types.

**Nested projections:**

```java
public interface OrderDetail {
    Long getId();
    CustomerSummary getCustomer();

    interface CustomerSummary {
        Long getId();
        String getName();
    }
}
```

Generates joins to fetch nested interface properties. Prefer flat constructor projections for complex reports where you control every join explicitly.

### Production scenario: open projection N+1 in production only

**Problem.** Order list endpoint returns 200 rows in 80ms in staging; 4.2s in production.

**Cause.** `OrderRow` open projection uses `@Value("#{target.customer.name}")` but the derived query selects only `Order` columns. Hibernate lazy-loads `customer` once per row — 201 queries.

**Solution.** Replace with constructor projection and explicit join:

```java
@Query("""
    select new com.acme.api.OrderRow(o.id, o.orderNumber, o.status, c.name)
    from Order o join o.customer c where o.status = :status
    """)
List<OrderRow> rows(@Param("status") OrderStatus status);
```

Assert `select count = 1` in integration test.

### Production scenario: interface projection breaks after field rename

**Problem.** Refactor renames `orderNumber` → `referenceCode`; API returns null for number field; no compile error.

**Cause.** Closed interface projection binds by getter name at runtime. `getOrderNumber()` no longer maps to a property.

**Solution.** Prefer records with constructor expressions (compile-time JPQL validation in some IDEs) or integration tests asserting non-null fields. For interface projections, treat getter names as API contracts.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Open projection without fetch plan | N+1 hidden inside getter SpEL |
| `select new` with wrong package in JPQL | `QueryException` at startup |
| Dynamic projection with arbitrary `Class` from user input | SQL injection via class loading — whitelist types |
| Interface projection on `@ManyToOne` without join | Null or lazy exception |
| Returning projection from OSIV-disabled API without `readOnly` tx | Works but unnecessary flush overhead if entities leaked in |

### Debugging scenario

**Observe.** Projection query returns fewer columns than expected; some fields always null.

**Diagnose.** Enable SQL logging; compare selected columns to interface getters. For open projections, log whether lazy associations initialize during mapping.

**Fix.** Switch to explicit `@Query` with constructor expression; add query-count test.

---

## 8. DTO Mapping Strategies (MapStruct vs manual, transaction boundary)

### Core concept

Projections (section 7) fetch only needed columns **in the database**. DTO mapping transforms **entities or query results** into API response shapes **in Java**. The critical production decision is **where** mapping runs relative to the transaction boundary:

```
@Transactional(readOnly = true)     ← persistence context alive
  ├─ load entity / projection
  ├─ map to DTO  ← SAFE: lazy associations still reachable if needed
  └─ return DTO
← transaction ends; session closed
Controller serializes DTO  ← no Hibernate involvement
```

Mapping **after** the transaction closes is only safe if the DTO is fully populated — any lazy access during mapping throws `LazyInitializationException`.

### MapStruct vs manual mapping

| Concern | Manual mapping | MapStruct |
|---|---|---|
| Compile-time safety | Full control; typos caught in IDE | Generated code; wrong `@Mapping` caught at compile |
| Lazy association risk | Visible in one method | Hidden in generated impl — review `*MapperImpl.java` |
| Performance | Zero overhead | Zero overhead (no reflection) |
| Boilerplate | High for large graphs | Low; `@Mapping` for nested paths |
| Testability | Trivial unit test | Test generated impl or integration |
| Transaction boundary | Same rule: map inside `@Transactional(readOnly=true)` | Same |

Use **projections + MapStruct** for list screens; use **manual mapping** when logic is non-trivial (conditional fields, security redaction, computed aggregates). Never use **ModelMapper/BeanUtils reflection** on hot paths — property name guessing breaks silently under refactor.

### Internal working

**Manual mapping** — explicit, zero magic:

```java
@Transactional(readOnly = true)
public OrderDetailDto getDetail(long id) {
    Order order = orders.findDetailById(id).orElseThrow();
    return new OrderDetailDto(
        order.getId(),
        order.getOrderNumber(),
        order.getCustomer().getName(),
        order.getLines().stream().map(l -> new LineDto(l.getSku(), l.getQty())).toList()
    );
}
```

**MapStruct** — compile-time mapper generation:

```java
@Mapper(componentModel = "spring")
public interface OrderMapper {
    @Mapping(source = "customer.name", target = "customerName")
    OrderDetailDto toDetail(Order order);

    List<OrderListDto> toListDtos(List<OrderSummary> projections);
}

@Service
@RequiredArgsConstructor
public class OrderQueryService {
    private final OrderRepository orders;
    private final OrderMapper mapper;

    @Transactional(readOnly = true)
    public OrderDetailDto getDetail(long id) {
        return mapper.toDetail(orders.findDetailById(id).orElseThrow());
    }
}
```

MapStruct generates implementation at compile time — no reflection, debugger-friendly. `@Mapping` handles nested paths; `@AfterMapping` for computed fields.

**MapStruct + projections** — map projection interface directly to API DTO:

```java
@Mapper(componentModel = "spring")
public interface OrderMapper {
    OrderListDto toListDto(OrderSummary projection);
}
```

No entity in the path — fastest and safest for list screens.

**Transaction boundary rules:**

| Pattern | Safe? | Notes |
|---|---|---|
| Map inside `@Transactional(readOnly=true)` service | Yes | Preferred |
| Map in controller after service returns entity | Only if EAGER or fully initialized | OSIV masks bugs |
| `@Async` mapping after service returns entity | No | Session closed |
| MapStruct in repository | No | Wrong layer |
| Entity → DTO in Jackson `@JsonSerialize` | No | Lazy loads during HTTP write |

**`@Transactional` on mapper bean** — do not. Mappers are stateless; transaction policy stays on services.

### Production scenario: MapStruct triggers lazy load in mapper

**Problem.** `OrderMapper.toDetail()` works in dev; `LazyInitializationException` in prod after OSIV disabled.

**Cause.** MapStruct generated code calls `order.getLines().size()` for a mapping expression; lines not fetched in service query.

**Solution.** Either add `lines` to `@EntityGraph` on `findDetailById`, or map from a constructor projection that includes line data:

```java
@Query("""
    select new com.acme.api.OrderDetailDto(o.id, o.orderNumber, c.name, l.sku, l.qty)
    from Order o join o.customer c join o.lines l where o.id = :id
    """)
List<OrderDetailDto> findDetailRows(@Param("id") long id);
```

Flatten duplicate root rows in service, or use DTO projection + separate line query.

### Production scenario: mapping detached entity after merge

**Problem.** Update endpoint returns stale DTO; client shows old status after successful save.

**Cause.** Service called `mapper.toDto(detachedInput)` instead of `mapper.toDto(managedEntity)` after save. Detached snapshot missing DB-generated fields (`updatedAt`, `@Version`).

**Solution.** Always map the **return value** of `save()` or the managed instance from `findById`:

```java
@Transactional
public OrderDetailDto update(long id, UpdateOrderRequest req) {
    Order order = orders.findById(id).orElseThrow();
    order.apply(req);
    return mapper.toDetail(order); // managed instance, post-flush state
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| MapStruct `componentModel = "spring"` missing | `NoSuchBeanDefinitionException` |
| Circular mapper dependencies | Startup failure; split mappers |
| Mapping entities in filter/interceptor | LazyInitializationException |
| `ModelMapper` reflection in hot path | Slow; unpredictable property matching |
| DTO mapped outside tx with lazy fields | Intermittent 500s after OSIV off |

### Debugging scenario

**Observe.** MapStruct-generated impl has unexpected null fields.

**Diagnose.** Open `target/generated-sources/annotations/...MapperImpl.java`; trace which getters are called. Compare to fetch plan in SQL log.

**Fix.** Add explicit `@Mapping`, fetch join, or switch to projection query.

---

## 9. Transaction Management: @Transactional Propagation, Isolation, readOnly

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

**Cause.** Audit method used `REQUIRED`, not `REQUIRES_NEW`, or was called via self-invocation (section 14).

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

## 10. All @Transactional Propagation Values with Worked Examples + Matrix

### Core concept

Propagation answers: **when this method runs, what happens to the caller's transaction?** Seven values exist; most production bugs involve misunderstanding `REQUIRED` vs `REQUIRES_NEW` vs `NESTED`, or expecting propagation to work through self-invocation (section 14).

### Internal working

**Complete propagation matrix:**

| Propagation | Existing tx? | Behavior | New physical tx? | Outer tx on failure |
|---|---|---|---|---|
| `REQUIRED` (default) | Yes | Join | No | Rolls back together |
| `REQUIRED` | No | Create new | Yes | N/A |
| `REQUIRES_NEW` | Yes | **Suspend** outer; create new | Yes | Outer **unaffected** by inner rollback |
| `REQUIRES_NEW` | No | Create new | Yes | N/A |
| `NESTED` | Yes | Savepoint in outer | No (savepoint) | Inner rollback to savepoint; outer may still commit |
| `NESTED` | No | Same as `REQUIRED` | Yes | N/A |
| `MANDATORY` | Yes | Join | No | Rolls back together |
| `MANDATORY` | No | **`IllegalTransactionStateException`** | — | — |
| `SUPPORTS` | Yes | Join (non-tx if read-only path) | No | Rolls back together |
| `SUPPORTS` | No | Run **without** transaction | No | No rollback |
| `NOT_SUPPORTED` | Yes | **Suspend** outer | No | Outer suspended; no tx during method |
| `NOT_SUPPORTED` | No | Run without transaction | No | N/A |
| `NEVER` | Yes | **`IllegalTransactionStateException`** | — | — |
| `NEVER` | No | Run without transaction | No | N/A |

**`REQUIRES_NEW` audit logging — the canonical pattern:**

Audit records must survive main transaction rollback (fraud attempt logged even when order placement rolls back). This requires a **separate Spring bean** with `REQUIRES_NEW` — never self-invocation.

```java
@Service
@RequiredArgsConstructor
public class OrderPlacementService {
    private final OrderRepository orders;
    private final AuditService audit; // separate bean — proxy applies REQUIRES_NEW

    @Transactional(rollbackFor = Exception.class)
    public void placeOrder(PlaceOrderCommand cmd) {
        audit.logAttempt("ORDER_PLACE", cmd.customerId(), cmd.orderId()); // commits independently
        try {
            orders.save(buildOrder(cmd));
            chargePayment(cmd);
        } catch (PaymentDeclinedException e) {
            audit.logFailure("ORDER_PLACE", cmd.orderId(), e.getMessage()); // still commits
            throw e; // outer rolls back order row; audit rows remain
        }
    }
}

@Service
public class AuditService {
    private final AuditLogRepository auditLogs;

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void logAttempt(String action, long actorId, UUID correlationId) {
        auditLogs.save(new AuditLog(action, actorId, correlationId, Instant.now()));
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void logFailure(String action, UUID correlationId, String reason) {
        auditLogs.save(AuditLog.failure(action, correlationId, reason));
    }
}
```

Transaction log (TRACE) shows suspend/resume:

```
Creating new transaction with name [AuditService.logAttempt]: PROPAGATION_REQUIRES_NEW
Suspending current transaction
...
Committing JPA transaction on EntityManager [AuditService.logAttempt]
Resuming suspended transaction after completion of inner transaction
```

**`NESTED` vs `REQUIRES_NEW`:**

- `NESTED` uses JDBC savepoints — inner rollback rolls back to savepoint; outer transaction can still commit. Requires savepoint-capable driver.
- `REQUIRES_NEW` is a fully independent transaction — inner commit is durable even if outer later rolls back (and vice versa).

Use `NESTED` rarely (partial rollback within one business operation). Use `REQUIRES_NEW` for audit, outbox side-writes, and "always persist" telemetry.

**Worked examples for less-used propagation values:**

```java
// MANDATORY — repository layer expects caller to open tx
@Service
public class LedgerService {
    @Transactional(propagation = Propagation.MANDATORY)
    public void postEntry(LedgerEntry entry) {
        ledgerRepo.save(entry); // throws IllegalTransactionStateException if no outer tx
    }
}

// SUPPORTS — cache warm-up: join tx if present, otherwise fine without
@Service
public class ReferenceDataService {
    @Transactional(propagation = Propagation.SUPPORTS, readOnly = true)
    public List<CountryDto> listCountries() {
        return countryRepo.findAllProjectedBy(); // works inside or outside tx
    }
}

// NOT_SUPPORTED — suspend outer tx for long JDBC export
@Service
public class ReportExportService {
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public void streamToCsv(OutputStream out) {
        jdbcTemplate.query("select * from orders", rs -> { /* no connection held by outer write tx */ });
    }
}

// NEVER — utility that must never run inside a transaction
@Service
public class ExternalPricingClient {
    @Transactional(propagation = Propagation.NEVER)
    public BigDecimal fetchLivePrice(String sku) {
        return restClient.getPrice(sku); // IllegalTransactionStateException if called from @Transactional service
    }
}
```

**`NOT_SUPPORTED` use case** — run heavy read outside transaction to avoid holding connection:

```java
@Transactional(propagation = Propagation.NOT_SUPPORTED)
public List<ReportRow> generateReportUnscoped() {
    // No tx — long-running read without pinning a connection to a write tx
    return jdbcTemplate.query("select ...", rowMapper);
}
```

### Production scenario: audit lost because same bean

**Problem.** Fraud audit table empty after failed checkout; logs show "audit saved."

**Cause.** `placeOrder()` called `this.writeAudit()` — same class, no proxy, `REQUIRED` joined outer tx, everything rolled back.

**Solution.** Extract `AuditService`; inject and call through Spring proxy. Verify with `org.springframework.transaction=TRACE`.

### Production scenario: NESTED expected to commit independently

**Problem.** Developer used `NESTED` expecting inner method commit to survive outer rollback.

**Cause.** `NESTED` only rolls back to savepoint — if outer transaction rolls back entirely, **all** work including committed savepoint region is undone at the physical transaction level.

**Solution.** Use `REQUIRES_NEW` for true independence; understand savepoint semantics before using `NESTED`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `REQUIRES_NEW` on same bean as caller | Joins outer tx; audit lost on rollback |
| `MANDATORY` on repository without service tx | `IllegalTransactionStateException` |
| `NEVER` on method called from `@Transactional` service | Startup-time or runtime exception |
| `NESTED` on non-savepoint driver | Degrades to `REQUIRED` or fails |
| `NOT_SUPPORTED` then `save()` | `TransactionRequiredException` or auto-commit per statement |

### Debugging scenario

**Observe.** Independent commit doesn't happen.

**Diagnose.** Enable TRACE on `org.springframework.transaction.interceptor` and `JpaTransactionManager`. Confirm "Suspending" and "Creating new transaction" appear. Check call stack for same-class invocation.

**Fix.** Extract bean; verify with integration test that outer rollback leaves inner rows committed.

---

## 11. Rollback Rules (UnexpectedRollbackException sequence)

### Core concept

Spring marks a transaction **rollback-only** when an unchecked exception propagates out of a `@Transactional` method (default), or when any configured `rollbackFor` exception escapes. Once rollback-only, **commit is forbidden** — attempting commit throws `UnexpectedRollbackException`. This confuses teams who catch exceptions and "recover" without understanding the tx flag.

### Internal working

**Default rollback rules:**

| Exception type | Default rollback? | Override |
|---|---|---|
| `RuntimeException` / unchecked | Yes | `noRollbackFor` |
| `Error` | Yes | `noRollbackFor` |
| Checked `Exception` | **No — commits** | `rollbackFor = Exception.class` |
| Custom business exception extending `RuntimeException` | Yes | — |

```java
@Transactional(rollbackFor = Exception.class, noRollbackFor = OptimisticLockException.class)
public void process(OrderCommand cmd) throws BusinessException { ... }
```

**UnexpectedRollbackException sequence:**

```
1. OuterService.process()     @Transactional REQUIRED — tx A starts
2.   InnerService.fail()      @Transactional REQUIRED — joins tx A
3.     throw RuntimeException — Spring marks tx A rollback-only
4.   catch (RuntimeException e) { log; return; }  — exception swallowed in outer
5. OuterService.process() completes "normally"
6. Spring attempts COMMIT on tx A
7. TransactionManager discovers rollback-only flag
8. Throws UnexpectedRollbackException: "Transaction rolled back because it has been marked as rollback-only"
```

The data is rolled back, but the caller thought it succeeded — worse than a visible failure.

**Participating vs initiating transaction:**

When inner `REQUIRES_NEW` throws, only inner tx rolls back. When inner `REQUIRED` throws and is caught in outer without rethrow, outer is still rollback-only.

```java
@Transactional
public void outer() {
    try {
        innerService.throwsRuntime(); // marks tx rollback-only
    } catch (RuntimeException ignored) {
        // swallow — STILL rollback-only
    }
    // completes → UnexpectedRollbackException on commit
}
```

**Programmatic rollback:**

```java
@Transactional
public void cancelIfInvalid(Order o) {
    if (!o.isValid()) {
        TransactionAspectSupport.currentTransactionStatus().setRollbackOnly();
        return; // no exception, but tx will not commit
    }
}
```

Use when business rules require rollback without throwing through multiple layers.

### Production scenario: swallowed exception, silent rollback

**Problem.** Batch job reports "processed 500 records"; database shows 0 changes.

**Cause.** Per-record `RuntimeException` caught in loop; transaction marked rollback-only on first failure; job completes; commit fails or entire batch rolled back.

**Solution.** `REQUIRES_NEW` per record, or fail fast on first error, or `noRollbackFor` only for truly recoverable cases:

```java
@Transactional
public void processBatch(List<Long> ids) {
    for (Long id : ids) {
        recordProcessor.processOne(id); // REQUIRES_NEW per id
    }
}
```

### Production scenario: checked exception commits payment

**Problem.** Covered in section 9 — `PaymentDeclinedException extends Exception` commits order state.

**Solution.** `rollbackFor = Exception.class` or unchecked domain exceptions. Team standard: business failures are `RuntimeException`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Catch `RuntimeException` without rethrow in `@Transactional` | `UnexpectedRollbackException` or silent rollback |
| `rollbackFor` on interface but not implementation | Default rules on impl (annotation inheritance varies) |
| `@Transactional` on `protected` method (class-based proxy) | May not apply — use public methods |
| Testing without asserting rollback | False positive green tests |
| `setRollbackOnly()` then return success DTO | Client thinks success; DB unchanged |

### Debugging scenario

**Observe.** `UnexpectedRollbackException` in logs; caller received 200 OK.

**Diagnose.**

```yaml
logging.level.org.springframework.transaction.interceptor: TRACE
logging.level.org.springframework.transaction.support: DEBUG
```

Find first `Participating transaction failed - marking existing transaction as rollback-only`. Trace catch blocks that swallow without `setRollbackOnly` awareness.

**Fix.** Rethrow, use `REQUIRES_NEW` for isolated failure domains, or exit early before commit with explicit error response.

---

## 12. Isolation Levels via @Transactional

### Core concept

`@Transactional(isolation = ...)` sets the isolation level for the **database connection** when the transaction starts. Spring delegates to the JDBC driver / database — it does not implement isolation in application memory. If the DB ignores a level (common: PostgreSQL treats `READ_UNCOMMITTED` as `READ_COMMITTED`), Spring cannot enforce stricter semantics.

### Internal working

```java
@Transactional(isolation = Isolation.REPEATABLE_READ, readOnly = true)
public BigDecimal reconcileAccount(long accountId) {
    Account a = accounts.findById(accountId).orElseThrow();
    List<LedgerEntry> entries = ledger.findByAccountId(accountId);
    return a.getBalance().subtract(entries.stream().map(LedgerEntry::getAmount).reduce(ZERO, BigDecimal::add));
}
```

**Isolation levels and phenomena:**

| Level | Dirty read | Non-repeatable read | Phantom read | Typical default |
|---|---|---|---|---|
| `READ_UNCOMMITTED` | Possible | Possible | Possible | Rarely used |
| `READ_COMMITTED` | No | Possible | Possible | PostgreSQL, SQL Server |
| `REPEATABLE_READ` | No | No | Possible* | MySQL InnoDB |
| `SERIALIZABLE` | No | No | No | Strict; perf cost |

*PostgreSQL `REPEATABLE_READ` uses snapshot isolation — phantoms for write conflicts raise serialization failures. MySQL InnoDB `REPEATABLE_READ` with next-key locking reduces phantoms for index scans.

**What Spring actually does:**

```java
// JpaTransactionManager.doBegin()
Connection con = DataSourceUtils.getConnection(dataSource);
con.setTransactionIsolation(isolationLevel); // JDBC constant from Isolation enum
```

Isolation is set per physical transaction. `REQUIRES_NEW` gets a **new connection** with the inner method's isolation level — can differ from outer.

**Combining with JPA:**

JPA does not cache isolation semantics — the persistence context still shows snapshot from first read within the transaction. Non-repeatable reads are prevented at DB level for `REPEATABLE_READ`; phantom inserts may still appear in iteration unless DB uses gap locks.

```java
@Transactional(isolation = Isolation.SERIALIZABLE)
public void transfer(long from, long to, BigDecimal amount) {
    Account source = accounts.findByIdForUpdate(from); // pessimistic + serializable
    Account dest = accounts.findByIdForUpdate(to);
    source.debit(amount);
    dest.credit(amount);
}
```

Prefer **optimistic `@Version`** or **ordered pessimistic locks** before blanket `SERIALIZABLE` — throughput collapses under contention.

**Read-only + isolation:**

```java
@Transactional(readOnly = true, isolation = Isolation.READ_COMMITTED)
public ReportDto buildReport(ReportCriteria criteria) { ... }
```

`readOnly` does not weaken isolation — you still see committed data per level. Route to replica only if your routing datasource respects read-only hint.

### Production scenario: phantom rows in reconciliation

**Problem.** Nightly reconciliation counts ledger entries twice when concurrent inserts run during the job.

**Cause.** Default `READ_COMMITTED`; cursor iteration sees new rows inserted after scan started.

**Solution.** `REPEATABLE_READ` or snapshot export (`COPY` at consistent point), or lock account for duration of reconcile. For long jobs, export ids first then process in batches.

### Production scenario: SERIALIZABLE deadlock storm

**Problem.** Team set `SERIALIZABLE` on all write services; deadlock rate 40× baseline.

**Cause.** Every transaction serializes all reads and writes; lock ordering conflicts.

**Solution.** Drop to `READ_COMMITTED` + `@Version` + retry; reserve `SERIALIZABLE` for rare financial close operations.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Assuming Spring enforces isolation without DB support | Phenomena still occur |
| `READ_UNCOMMITTED` on PostgreSQL | Behaves as `READ_COMMITTED` |
| Different isolation outer vs inner `REQUIRES_NEW` | Surprising visibility between txs |
| Long `REPEATABLE_READ` + high write contention | Serialization failures, retries |
| Isolation on read-only report without index | Slow scans hold snapshots |

### Debugging scenario

**Observe.** Same query returns different row counts within one `@Transactional` method.

**Diagnose.** Log `connection.getTransactionIsolation()`. Check DB default vs annotation. Look for `autoCommit=true` leaks (no real transaction).

**Fix.** Explicit isolation on method; verify with concurrent integration test; document DB-specific behavior in team wiki.

---

## 13. PlatformTransactionManager & TransactionSynchronization

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

## 14. Transaction Boundaries: Service Layer, Self-Invocation, Private Methods

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

## 15. Open Session In View (OSIV) / spring.jpa.open-in-view

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

## 16. Flush Modes, Dirty Checking, merge vs persist vs update

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

## 17. Hibernate 6 Specifics (SQM, batching, @BatchSize, IDENTITY batch failure)

### Core concept

Spring Boot 3 ships **Hibernate 6.x** with a rewritten query engine (SQM — Semantic Query Model), changed defaults, and JDBC batching improvements. Code and config written for Hibernate 5 often breaks subtly or leaves performance on the table. This section covers what senior engineers must know on Boot 3.

### Internal working

**SQM (Semantic Query Model):**

Hibernate 6 parses JPQL/HQL into SQM, optimizes, then generates SQL per dialect. Legacy HQL AST is gone.

| Hibernate 5 habit | Hibernate 6 change |
|---|---|
| `distinct` in entity queries to dedupe roots | Often unnecessary; can push expensive SQL `DISTINCT` |
| `org.hibernate.Query` | `org.hibernate.query.Query` |
| `javax.persistence.*` | `jakarta.persistence.*` |
| Criteria API internal | JPA Criteria still works; Hibernate Criteria removed |
| Implicit join syntax quirks | Stricter SQM translation |

```java
// Hibernate 6: tuple / DTO queries use SQM constructor expressions
@Query("select new com.acme.OrderRow(o.id, o.status) from Order o where o.status = :s")
List<OrderRow> rows(@Param("s") OrderStatus s);
```

Enable query plan logging during migration:

```yaml
logging.level.org.hibernate.orm.query.plan: DEBUG
```

**JDBC batching:**

Without batching, `saveAll` on 10k entities = 10k round trips. Enable:

```yaml
spring.jpa.properties.hibernate.jdbc.batch_size: 50
spring.jpa.properties.hibernate.order_inserts: true
spring.jpa.properties.hibernate.order_updates: true
spring.jpa.properties.hibernate.jdbc.batch_versioned_data: true  # batch versioned updates
```

```java
@Transactional
public void importOrders(List<Order> batch) {
    for (int i = 0; i < batch.size(); i++) {
        em.persist(batch.get(i));
        if (i % 50 == 0) {
            em.flush();
            em.clear();
        }
    }
}
```

**`@BatchSize` on entities and collections:**

`@BatchSize` batches lazy loads — N+1 becomes 1 + ceil(N/batchSize) queries instead of 1 + N:

```java
@Entity
@BatchSize(size = 25)
public class Order {
    @OneToMany(mappedBy = "order")
    @BatchSize(size = 25)
    private List<OrderLine> lines;
}

// Global default (applies when @BatchSize not on entity):
// spring.jpa.properties.hibernate.default_batch_fetch_size: 32
```

When Hibernate lazy-loads `lines` for 100 orders, it issues `WHERE order_id IN (?,?,...)` in batches of 25 — four queries instead of 100. Pair with `@BatchSize` on `@ManyToOne` inverse sides when you cannot fetch-join two collections (section 6).

**`IDENTITY` vs `SEQUENCE` — the batch failure mode:**

| Id strategy | JDBC batch INSERT? | Why |
|---|---|---|
| `GenerationType.IDENTITY` | **No** | Driver must execute INSERT immediately to retrieve generated key |
| `GenerationType.SEQUENCE` (allocationSize = batch_size) | **Yes** | IDs pre-allocated from sequence; Hibernate batches INSERT statements |
| `GenerationType.TABLE` | Yes (with tuning) | Similar to sequence but higher overhead |

```java
// IDENTITY — batch_size ignored for inserts; one round trip per row
@Id @GeneratedValue(strategy = GenerationType.IDENTITY)
private Long id;

// SEQUENCE — batch-friendly
@Id
@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "order_seq")
@SequenceGenerator(name = "order_seq", sequenceName = "order_seq", allocationSize = 50)
private Long id;
```

Symptom: `hibernate.jdbc.batch_size=50` configured but SQL log shows single-row INSERTs — check id generator first before tuning flush cadence.

**Identity columns block batching** — `GenerationType.IDENTITY` forces immediate insert per row. Use `SEQUENCE` or `TABLE` for batch-friendly ids:

```java
@Id
@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "order_seq")
@SequenceGenerator(name = "order_seq", sequenceName = "order_seq", allocationSize = 50)
private Long id;
```

**`@DynamicUpdate`:**

Generates `UPDATE` with only changed columns — reduces write amplification and optimistic lock collision surface.

```java
@Entity
@DynamicUpdate
public class Order {
    @Id private Long id;
    private OrderStatus status;
    private String shippingNotes;
    private BigDecimal total;
}
```

Changing only `status` emits:

```sql
update orders set status = ? where id = ? and version = ?
```

Not all columns. Requires Hibernate to track dirty fields on the **managed** instance — merging detached DTOs may still update all columns if Hibernate treats the whole entity as dirty.

**`@DynamicInsert`** — symmetric for INSERT (only non-null columns) — useful for wide sparse tables.

**Bytecode enhancement (Hibernate 6):**

```xml
<plugin>
  <groupId>org.hibernate.orm.tooling</groupId>
  <artifactId>hibernate-enhance-maven-plugin</artifactId>
  <executions><execution><goals><goal>enhance</goal></goals></execution></executions>
  <configuration>
    <enableLazyInitialization>true</enableLazyInitialization>
    <enableDirtyTracking>true</enableDirtyTracking>
  </configuration>
</plugin>
```

Enables true lazy basic fields and can improve dirty tracking precision for `@DynamicUpdate`.

**Other Hibernate 6 defaults worth knowing:**

```yaml
spring.jpa.properties.hibernate.query.passDistinctThrough: false
spring.jpa.properties.hibernate.type.preferred_instant_jdbc_type: TIMESTAMP_UTC
```

### Production scenario: upgrade from Boot 2 — distinct regression

**Problem.** After Boot 3 migration, order list query 3× slower.

**Cause.** Hibernate 5 relied on JPQL `distinct` for in-memory dedupe; Hibernate 6 pushes `DISTINCT` to SQL → sort/hash on large joined result.

**Solution.** Remove unnecessary `distinct` from entity queries; use two-query pattern or projection.

### Production scenario: saveAll still one insert per row

**Problem.** Batch import config has `batch_size=50` but SQL log shows individual INSERTs.

**Cause.** `IDENTITY` id generation; or `save()` interleaved with queries flushing each row.

**Solution.** Switch to `SEQUENCE` with `allocationSize` matching batch size; `order_inserts=true`; avoid flush between inserts in batch loop.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `IDENTITY` + expecting JDBC batch | No batching; N round trips |
| `@DynamicUpdate` on detached merge path | Full column UPDATE still |
| Hibernate 5 query hints copied verbatim | Ignored or different behavior |
| No enhance plugin + `@Basic(LAZY)` | LOB loads eagerly |
| `ddl-auto=update` in prod | Schema drift; use Flyway |

### Debugging scenario

**Observe.** Slow writes after Hibernate 6 upgrade.

**Diagnose.** `hibernate.generate_statistics: true`; check `getJdbcBatchCount()`. Log SQL — repeated single-row INSERTs vs batched.

**Fix.** Sequence generator; batch properties; flush/clear cadence.

---

## 18. Read-Only Transactions and Performance

### Core concept

`@Transactional(readOnly = true)` is a **hint** to Spring, Hibernate, and optionally your routing datasource. It does not prevent writes — code can still call `save()` — but when applied correctly it reduces flush overhead, enables driver optimizations, and documents intent. Combined with projections (section 7) and short transactions, it is the primary pattern for fast read APIs.

### Internal working

What `readOnly = true` triggers (stack-dependent):

| Layer | Effect |
|---|---|
| Spring `JpaTransactionManager` | Sets `flushMode` to commit/manual; marks transaction read-only |
| Hibernate 6 Session | `session.setDefaultReadOnly(true)` on loaded entities; skips dirty checking at flush |
| JDBC driver (some) | `connection.setReadOnly(true)` — PostgreSQL may route to replica if configured |
| HikariCP | No special behavior; connection still checked out for tx duration |

```java
@Transactional(readOnly = true)
public Page<OrderListDto> listOrders(OrderStatus status, Pageable pageable) {
    return orders.pageRows(status, pageable).map(OrderListDto::from);
}
```

**`@Basic(fetch = LAZY)` on scalars** — Hibernate ignores lazy fetch on basic types unless bytecode enhancement is enabled:

```xml
<!-- pom.xml: hibernate-enhance-maven-plugin -->
<plugin>
  <groupId>org.hibernate.orm.tooling</groupId>
  <artifactId>hibernate-enhance-maven-plugin</artifactId>
  <configuration>
    <enableLazyInitialization>true</enableLazyInitialization>
  </configuration>
</plugin>
```

Without enhancement, `@Lob` columns load eagerly on every entity fetch — see section 4 pitfall 8. Reliable pattern: separate table/entity or JDBC streaming.

**Performance checklist for read paths:**

1. `readOnly = true` on service query methods
2. Projection or DTO — not full entity graph
3. No `save()` / `merge()` in read path
4. Fetch plan explicit (`join fetch`, `@EntityGraph`, or projection SQL)
5. `default_batch_fetch_size` for unavoidable lazy paths
6. Disable OSIV; do not rely on session extending past service return
7. Query count assertion in tests (section 28)

```yaml
spring:
  jpa:
    properties:
      hibernate:
        query.in_clause_parameter_padding: true  # Hibernate 6 — better plan cache reuse
        default_batch_fetch_size: 32
```

### Production scenario: readOnly ignored on private helper

**Problem.** Report marked read-only still generates UPDATE statements in SQL log.

**Cause.** Public `generateReport()` called private `@Transactional(readOnly=true) loadData()` — annotation ignored on private method; outer default read-write tx applied.

**Solution.** Public read-only method on service or extract `ReportQueryService` bean.

### Production scenario: readOnly with @Modifying in same class

**Problem.** `IllegalStateException` or unexpected writes during "read" endpoint.

**Cause.** Class-level `@Transactional` without `readOnly`; one method runs `@Modifying` cleanup in same bean.

**Solution.** Split read and write services; never mix modifying queries in read-only service class.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `readOnly` on private/self-invoked method | Full read-write behavior |
| Assuming readOnly blocks `save()` | Writes still execute |
| readOnly + long OSIV request | Connection held despite no writes |
| No bytecode enhance + `@Lob` on entity | Heap spikes on list endpoints |
| readOnly without projection | Dirty checking still runs on managed entities |

### Debugging scenario

**Observe.** Read endpoint slow; `Statistics.getFlushCount() > 0`.

**Diagnose.** Check for accidental entity mutation in mapper; verify `readOnly` applied (TRACE transaction). Count managed entities vs DTO return.

**Fix.** Projection query; `readOnly`; ensure no flush triggers.

---

## 19. Optimistic vs Pessimistic Locking (@Version, LockModeType)

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

## 20. Concurrency Locking Recap with SKIP LOCKED Queue Pattern

### SKIP LOCKED queue pattern (PostgreSQL / MySQL 8+)

Work-queue consumers competing for the same rows need **pessimistic lock + skip locked rows already claimed** — avoids thundering herd blocking on `FOR UPDATE`:

```java
public interface JobRepository extends JpaRepository<Job, Long> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query(value = """
        select * from jobs
        where status = 'PENDING'
        order by created_at
        limit :batch
        for update skip locked
        """, nativeQuery = true)
    List<Job> claimNextBatch(@Param("batch") int batch);
}

@Service
@RequiredArgsConstructor
public class JobWorker {
    private final JobRepository jobs;

    @Transactional
    public void processBatch() {
        List<Job> claimed = jobs.claimNextBatch(10);
        for (Job job : claimed) {
            job.setStatus(JobStatus.PROCESSING);
            // business logic; on success → COMPLETED, on failure → retry/DLQ
        }
    }
}
```

| Pattern | SQL | Use when |
|---|---|---|
| `FOR UPDATE` | Blocks until row free | Single consumer or strict ordering |
| `FOR UPDATE SKIP LOCKED` | Skips rows locked by other workers | Horizontally scaled job workers |
| `FOR UPDATE NOWAIT` | Fails immediately if row locked | Fail-fast single attempt |
| Optimistic `@Version` + status CAS | `UPDATE ... WHERE status='PENDING' AND version=?` | Low collision; no row lock held during processing |

**Production notes:** keep claim transaction **short** — lock only during status transition PENDING→PROCESSING; do heavy work in a separate tx or after commit. On PostgreSQL, `SKIP LOCKED` requires `FOR UPDATE`; Hibernate `@Lock(PESSIMISTIC_WRITE)` on native query passes through dialect-specific clause. MySQL 8+ supports `SKIP LOCKED`; verify dialect in Testcontainers before prod.

**Anti-pattern:** long-running processing inside the same `@Transactional` that holds `FOR UPDATE` — blocks all other workers on hot queue rows and causes lock wait timeouts.

### Core concept

JPA offers two families of concurrency control: **optimistic** (`@Version`, compare-and-swap at flush) and **pessimistic** (`SELECT ... FOR UPDATE` at read). Section 19 covers each mode in depth; this section is the **decision recap with copy-paste patterns** for interviews and code review.

### Internal working

**When to use which:**

| Scenario | Strategy | Pattern |
|---|---|---|
| CRUD with occasional conflicts | Optimistic `@Version` | Retry on `OptimisticLockException` |
| Inventory / seat / wallet decrement | Pessimistic or atomic UPDATE | `FOR UPDATE` or `UPDATE ... WHERE stock >= ?` |
| Long-running read + rare write | Optimistic | Version check only at commit |
| High collision same row | Pessimistic + ordered locks | Sort ids before locking |
| Bulk admin update | `@Modifying` bypasses version | Manual version bump or accept risk |

**Optimistic — complete pattern:**

```java
@Entity
public class Product {
    @Id private Long id;
    @Version private Long version;
    private int stock;
}

@Service
@RequiredArgsConstructor
public class InventoryService {
    private final ProductRepository products;

    @Transactional
    public void adjustStock(long productId, int delta) {
        int attempts = 0;
        while (true) {
            try {
                Product p = products.findById(productId).orElseThrow();
                p.setStock(p.getStock() + delta);
                return; // flush at commit; version checked
            } catch (OptimisticLockException ex) {
                if (++attempts >= 3) throw ex;
            }
        }
    }
}
```

**Pessimistic — complete pattern:**

```java
public interface ProductRepository extends JpaRepository<Product, Long> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Product p where p.id = :id")
    Optional<Product> findByIdForUpdate(@Param("id") long id);
}

@Transactional
public void transferStock(long fromId, long toId, int qty) {
    long first = Math.min(fromId, toId);
    long second = Math.max(fromId, toId);
    Product firstProduct = products.findByIdForUpdate(first).orElseThrow();
    Product secondProduct = products.findByIdForUpdate(second).orElseThrow();
    // debit/credit using firstProduct and secondProduct by id match
}
```

**Atomic SQL without loading entity:**

```java
@Modifying
@Query("update Product p set p.stock = p.stock - :qty, p.version = p.version + 1 " +
       "where p.id = :id and p.stock >= :qty")
int decrementStock(@Param("id") long id, @Param("qty") int qty);
// returns 0 rows updated → out of stock, no OptimisticLockException
```

**Lock mode quick reference:**

```java
@Lock(LockModeType.PESSIMISTIC_READ)   // shared lock — others can read, not write
@Lock(LockModeType.PESSIMISTIC_WRITE)  // exclusive — blocks writers
@Lock(LockModeType.OPTIMISTIC)         // version check even without @Version field read
@Lock(LockModeType.OPTIMISTIC_FORCE_INCREMENT) // increment version at read time
```

### Production scenario: lost update without any strategy

**Problem.** Two tabs edit ticket priority; last save wins; no error shown.

**Solution.** Add `@Version`; return 409 on `OptimisticLockException`; UI refresh prompt.

### Production scenario: optimistic retry storm on flash sale

**Problem.** 10k concurrent checkouts; all retry on same `Product` row; DB CPU 100%.

**Solution.** Switch hot SKU to `decrementStock` atomic UPDATE or short pessimistic lock; queue checkout per product shard.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Version` + `@Modifying` bulk update | Version stale; false optimistic conflicts |
| Pessimistic lock without timeout | Hung threads until lock wait timeout |
| Lock rows in random order | Deadlock cycles |
| `@Version` null on migrated data | `OptimisticLockException` on every update |

### Debugging scenario

**Observe.** Frequent `OptimisticLockException` or deadlocks.

**Diagnose.** Log lock waits (`pg_locks`, `SHOW ENGINE INNODB STATUS`). Check version column values before/after. Graph collision rate per entity id.

**Fix.** Match strategy to collision rate; ordered locks; atomic SQL for counters.

---

## 21. Auditing (@CreatedDate, Envers)

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

## 22. Specifications, Criteria API, Querydsl

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

## 23. Native Queries, SqlResultSetMapping, Stored Procedures

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

## 24. Multi-Tenancy (Discriminator, Schema, Database)

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

## 25. Second-Level Cache Pitfalls

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

## 26. Connection Pool + Transaction Timeout Interactions

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

## 27. @Modifying Queries, Bulk Updates, clearAutomatically

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

## 28. Testing: @DataJpaTest, Testcontainers, @Transactional Rollback

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

## 29. Spring Data JDBC vs JPA — When to Use Which

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

## 30. Pagination, Sorting, and Keyset Patterns

### Core concept

Spring Data `Pageable` / `Sort` translate to `LIMIT/OFFSET` (or dialect equivalents). Offset pagination is simple but **degrades on deep pages** — `OFFSET 100000` scans and discards 100k rows. **Keyset (seek) pagination** uses the last seen sort key as a cursor: `WHERE (created_at, id) > (:cursorCreated, :cursorId)` — constant-time regardless of page depth.

### Internal working

```java
// Offset pagination — fine for admin UI page 1–20
Page<Order> page = orders.findByStatus(status, PageRequest.of(pageNum, 20,
    Sort.by("createdAt").descending().and(Sort.by("id").descending())));

// Keyset pagination — API feeds infinite scroll
@Query("""
    select o from Order o
    where o.status = :status
      and (o.createdAt < :cursorCreated
           or (o.createdAt = :cursorCreated and o.id < :cursorId))
    order by o.createdAt desc, o.id desc
    """)
List<Order> findNextPage(
    @Param("status") OrderStatus status,
    @Param("cursorCreated") Instant cursorCreated,
    @Param("cursorId") long cursorId,
    Pageable limit);
```

**`Page` vs `Slice` vs `List`:**

| Return type | Extra COUNT query? | When |
|---|---|---|
| `Page<T>` | **Yes** — `select count(*)` for total pages | Admin grids needing "page 47 of 200" |
| `Slice<T>` | No — hasNext from limit+1 trick | Infinite scroll; mobile feeds |
| `List<T>` + explicit limit | No | Keyset cursors; export batches |

**Sort stability:** always add a unique tie-breaker (`id`) when sorting by non-unique columns (`created_at`, `name`) — prevents duplicate/missing rows across pages when concurrent inserts occur.

**Fetch join + pagination trap:** `join fetch` with `Pageable` often loads all rows in memory then slices in Hibernate — use two queries (ids page, then fetch join by ids) or projection.

### Production scenario: duplicate rows across API pages

**Problem.** Mobile feed shows same order twice after user scrolls.

**Cause.** Sort by `created_at` only; new row inserted between page fetches shifts offset window.

**Solution.** Keyset pagination with `(created_at, id)` composite cursor; or stable sort with tie-breaker id.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Deep `OFFSET` on large table | p99 latency grows linearly with page number |
| `Page` on high-traffic list | Double query load (COUNT + SELECT) |
| fetch join + Pageable | Memory spike; wrong page size |
| Unstable sort column | Duplicate/missing rows across pages |

### Debugging scenario

**Observe.** Page 500 timeout; COUNT query 2s.

**Diagnose.** `EXPLAIN ANALYZE` on COUNT and SELECT; check index on sort columns + filter columns.

**Fix.** Keyset pagination; denormalized count cache; or `Slice` without total count.

---

## 31. Custom Repositories, Query Hints, and Fetch Profiles

### Core concept

Spring Data repository interfaces compose from **fragments** — custom implementation classes wired automatically when you extend a custom interface. Use for complex queries that exceed derived method naming, or when you need programmatic Criteria/Querydsl without polluting the main repository.

### Internal working

```java
public interface OrderRepositoryCustom {
    List<OrderSummary> searchOrders(OrderSearchCriteria criteria, Pageable pageable);
}

@RequiredArgsConstructor
public class OrderRepositoryImpl implements OrderRepositoryCustom {
    private final EntityManager em;

    @Override
    public List<OrderSummary> searchOrders(OrderSearchCriteria c, Pageable pageable) {
        CriteriaBuilder cb = em.getCriteriaBuilder();
        CriteriaQuery<OrderSummary> q = cb.createQuery(OrderSummary.class);
        Root<Order> root = q.from(Order.class);
        List<Predicate> preds = new ArrayList<>();
        if (c.status() != null) preds.add(cb.equal(root.get("status"), c.status()));
        if (c.customerId() != null) preds.add(cb.equal(root.get("customer").get("id"), c.customerId()));
        q.select(cb.construct(OrderSummary.class,
            root.get("id"), root.get("orderNumber"), root.get("status")));
        q.where(preds.toArray(Predicate[]::new));
        return em.createQuery(q).setFirstResult((int) pageable.getOffset())
            .setMaxResults(pageable.getPageSize()).getResultList();
    }
}

public interface OrderRepository extends JpaRepository<Order, Long>, OrderRepositoryCustom {}
```

**Query hints and fetch profiles:**

```java
@QueryHints(@QueryHint(name = "org.hibernate.readOnly", value = "true"))
@Query("select o from Order o where o.status = :s")
List<Order> findReadOnly(@Param("s") OrderStatus s);

@Entity
@NamedEntityGraph(name = "Order.detail", attributeNodes = {
    @NamedAttributeNode("customer"), @NamedAttributeNode("lines")
})
public class Order { ... }

@EntityGraph(value = "Order.detail", type = EntityGraph.EntityGraphType.FETCH)
Optional<Order> findDetailById(Long id);
```

| Mechanism | Purpose |
|---|---|
| `@QueryHint` | Pass provider-specific hints (readOnly, fetchSize, timeout) |
| `@EntityGraph` / `@NamedEntityGraph` | Declarative fetch plan override per query |
| `@Query(..., hints = @QueryHint(...))` | Per-query timeout for SLA enforcement |
| Custom fragment | Dynamic Criteria, native SQL with fallback, multi-step fetch |

Custom repos inherit the caller's transaction — no special propagation. Keep write logic in services; custom repos return projections or mutate only when the service opened a write transaction.

### Production scenario: custom repo bypasses tenant filter

**Problem.** `OrderRepositoryImpl` uses Criteria API; tenant B data visible to tenant A.

**Cause.** Native Criteria query without `tenantId` predicate; `@TenantId` not applied to programmatic queries.

**Solution.** Always add tenant predicate from `TenantContext`; or use Hibernate `@Filter` enabled on Session.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Custom impl class named wrong | Custom methods not wired; empty bean |
| `@Transactional` on custom impl | Redundant; wrong layer |
| Query hints copied from Hibernate 5 docs | Ignored silently on Hibernate 6 |
| EntityGraph + fetch join in same query | Conflicting fetch plans; cartesian product |

### Debugging scenario

**Observe.** `searchOrders` custom method not found at runtime.

**Diagnose.** Verify class name `{InterfaceName}Impl` in same package; check `@EnableJpaRepositories` base package.

**Fix.** Rename to `OrderRepositoryImpl`; add integration test calling custom method.

---

## 32. Production Debugging Playbook

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

## 33. Quick Decision Matrix

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

---

*JPA will not save you from a missing tenant predicate or an N+1 in a loop. The persistence context is powerful and invisible — keep transaction boundaries short, fetch plans explicit, and disable OSIV once your API returns DTOs. Test against the prod database engine, not only H2.*


---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. API returns 500 with LazyInitializationException after disabling OSIV — why?</summary>

**Root cause.** Controllers returned JPA entities; Jackson accessed lazy `customer` or `lines` after the service `@Transactional` method committed and closed the persistence context. OSIV previously kept the session open through serialization.

**Fix.** Return DTOs; use `join fetch` or `@EntityGraph` in a `@Transactional(readOnly=true)` service method that maps to the response. Re-enable OSIV only as temporary migration aid, not the end state.

---

</details>

<details class="qa-item">
<summary>2. Single order detail endpoint fires 47 SQL queries — what happened?</summary>

**Root cause.** Classic N+1: one query for order, then one per line, one per product, one per customer field accessed in the mapper loop. Staging dataset had 3 lines; prod orders average 40 lines.

**Fix.** Single JPQL with `join fetch` for collections needed, `@BatchSize` on secondary associations, or better — projection query returning `OrderDetailDto` in one round trip. Verify with Hibernate statistics: target 1–3 queries.

---

</details>

<details class="qa-item">
<summary>3. `@Transactional` rollback doesn't happen on payment failure — data committed?</summary>

**Root cause.** Payment failure thrown as checked `Exception`; default Spring rollback applies only to unchecked exceptions. Catch block logged and swallowed without rethrow in some code paths.

**Fix.** `@Transactional(rollbackFor = Exception.class)` or unchecked domain exceptions; never swallow in catch without rethrow; add test asserting DB unchanged on failure.

---

</details>

<details class="qa-item">
<summary>4. `REQUIRES_NEW` audit method still rolls back with main transaction — why?</summary>

**Root cause.** Self-invocation: outer service called `this.writeAudit()` internally, bypassing Spring proxy. Both run in same transaction.

**Fix.** Move audit to `AuditService` bean; inject and call through proxy. Verify with TRACE logging showing transaction suspend/resume.

---

</details>

<details class="qa-item">
<summary>5. OptimisticLockException on every other checkout click — users furious?</summary>

**Root cause.** Hot `Product` row with `@Version`; two tabs or double-submit causes concurrent updates. No retry or UI merge strategy.

**Fix.** Idempotent checkout token; retry with exponential backoff on `OptimisticLockException`; UI shows "price changed, refresh"; consider `UPDATE stock = stock - 1 WHERE id=? AND stock>=1` for decrement without full entity merge.

---

</details>

<details class="qa-item">
<summary>6. Admin bulk archive updated DB but UI still shows active orders until refresh?</summary>

**Root cause.** `@Modifying` bulk JPQL updated rows in database; persistence context still holds old managed `Order` instances with previous status (`clearAutomatically=false` default).

**Fix.** `@Modifying(clearAutomatically=true, flushAutomatically=true)` or `entityManager.clear()` after bulk; re-fetch ids for response; evict Spring `@Cacheable` if present.

---

</details>

<details class="qa-item">
<summary>7. Scheduled job throws LazyInitializationException on order.getCustomer().getEmail()?</summary>

**Root cause.** Job method not `@Transactional`; or transaction ended before lazy access; no OSIV in scheduler thread.

**Fix.** `@Transactional` on job service with fetch join query returning needed data, or DTO query selecting email directly.

---

</details>

<details class="qa-item">
<summary>8. Connection pool exhausted every Monday morning — only reports?</summary>

**Root cause.** Weekly report `@Transactional` streaming 2M rows while holding connection; parallel reports × Tomcat threads exceed Hikari pool; each report runs 20 minutes.

**Fix.** Batch processing with `Stream` + periodic `clear()`, read replica, non-JPA export (COPY TO STDOUT), `@Transactional(timeout=...)` fail fast, schedule off peak, separate pool for batch if needed.

---

</details>

<details class="qa-item">
<summary>9. Tenant A user sees Tenant B invoice — P1 security incident?</summary>

**Root cause.** Native SQL report query without `tenant_id` predicate; `@TenantId` not applied to native queries. Support role runs report across all rows.

**Fix.** Add mandatory tenant filter; code review rule for native SQL; integration test proving tenant isolation; fail if `TenantContext` empty.

---

</details>

<details class="qa-item">
<summary>10. `@Version` column null for migrated legacy rows — updates fail?</summary>

**Root cause.** Data migration inserted rows with `version IS NULL`; Hibernate optimistic lock requires non-null version.

**Fix.** Backfill `UPDATE product SET version = 0 WHERE version IS NULL`; add NOT NULL default on column; `@Version` on primitive `long` defaults to 0 for new entities.

---

</details>

<details class="qa-item">
<summary>11. `@DataJpaTest` passes; production fails FK constraint on save?</summary>

**Root cause.** H2 in-memory with `MODE=PostgreSQL` still differs; or test used `@Transactional rollback hiding missing parent entity; prod enforces FK.

**Fix.** Testcontainers with prod dialect; assert parent exists; use Flyway migrations in tests.

---

</details>

<details class="qa-item">
<summary>12. Envers audit table growing 5GB/month — compliance wants history but ops suffering?</summary>

**Root cause.** `@Audited` on high-churn `Order` entity including line items; every field change duplicates full snapshot.

**Fix.** `@NotAudited` on volatile fields; audit header entity only; archival job on `_AUD` tables; event store for business-critical history instead of full Envers on all tables.

---

</details>

<details class="qa-item">
<summary>13. `findById` returns stale data within same request after native update?</summary>

**Root cause.** Native UPDATE executed; first-level cache not cleared; subsequent `findById` returns managed entity without re-selecting.

**Fix.** `em.clear()` or `refresh(entity, LockModeType.PESSIMISTIC_WRITE)` after native modify; avoid mixing patterns in one transaction.

---

</details>

<details class="qa-item">
<summary>14. Pagination returns duplicate orders across pages?</summary>

**Root cause.** Sort by non-unique column (`created_at`) without tie-breaker id; concurrent inserts shift offsets.

**Fix.** `Pageable` sort: `Sort.by("createdAt").and("id")`; or keyset pagination `WHERE (created_at, id) > (:lastCreated, :lastId)`.

---

</details>

<details class="qa-item">
<summary>15. `@ManyToMany` join table missing rows after save?</summary>

**Root cause.** Owning side not set; only inverse side collections updated; no `mappedBy` sync.

**Fix.** Maintain owning side in domain method; in `@ManyToMany`, one side must own FK join table updates.

---

</details>

<details class="qa-item">
<summary>16. Hibernate `@SQLRestriction("deleted = false")` — admin can't see deleted records?</summary>

**Root cause.** Global filter applies to all queries including admin restore UI.

**Fix.** Separate repository method with `@Query` including deleted flag bypass ( Hibernate `@Filter` with enable/disable on Session) or use `@SQLRestriction` only on specific entity views.

---

</details>

<details class="qa-item">
<summary>17. Second-level cache shows old product price after flash sale update?</summary>

**Root cause.** Price updated via `@Modifying` JPQL; L2 cache not evicted; other pods serve cached entity.

**Fix.** Evict cache region on update; distributed cache (Redis) with TTL; don't L2-cache mutable hot entities.

---

</details>

<details class="qa-item">
<summary>18. `merge()` caused duplicate OrderLine rows?</summary>

**Root cause.** Detached entity graph with lines lacking ids treated as new; cascade MERGE inserts new lines instead of updating.

**Fix.** Load managed aggregate; mutate in place; or match lines by id in merge logic; use `orphanRemoval` carefully.

---

</details>

<details class="qa-item">
<summary>19. `@Transactional(readOnly=true)` on service but DB still gets INSERT audit rows?</summary>

**Root cause.** Audit aspect or Envers in separate `REQUIRES_NEW` write transaction — expected. Or `readOnly` ignored because method was private/self-invoked and ran read-write default.

**Fix.** Verify proxy applies readOnly; move writes to explicit write service; audit writes intentional.

---

</details>

<details class="qa-item">
<summary>20. Spring Data `saveAll` on 50k entities takes hours?</summary>

**Root cause.** Identity generation prevents JDBC batching; flush each entity; no `hibernate.jdbc.batch_size`; N round trips.

**Fix.**

```yaml
spring.jpa.properties.hibernate.jdbc.batch_size: 50
spring.jpa.properties.hibernate.order_inserts: true
spring.jpa.properties.hibernate.order_updates: true
```

Use `saveAll` in chunks with `flush()` and `clear()` between batches; consider bulk insert via native SQL for imports.

</details>

<details class="qa-item">
<summary>21. Closed interface projection returns null for renamed entity field — no compile error?</summary>

**Root cause.** Spring Data binds interface getters to entity properties by name at runtime. Refactoring `orderNumber` → `referenceCode` leaves `getOrderNumber()` unmapped.

**Fix.** Integration test asserting non-null projection fields; prefer `record` + `select new` constructor expressions for compile-time JPQL checks; treat interface getter names as API contracts.

---

</details>

<details class="qa-item">
<summary>22. Open projection `@Value("#{target.customer.name}")` causes N+1 — staging was fast?</summary>

**Root cause.** Derived query selects only root columns; SpEL triggers lazy `customer` load per row. Staging had 5 orders; prod has thousands.

**Fix.** Explicit `@Query` with `join o.customer c` and constructor projection; assert `select count = 1` in test.

---

</details>

<details class="qa-item">
<summary>23. MapStruct mapper throws LazyInitializationException after OSIV disabled?</summary>

**Root cause.** Generated mapper calls `order.getLines()` but service query did not fetch lines; mapping ran inside tx but association uninitialized.

**Fix.** Add `lines` to `@EntityGraph` on repository method, or map from projection/DTO query that includes line data in SQL.

---

</details>

<details class="qa-item">
<summary>24. Method completes without exception but UnexpectedRollbackException in logs?</summary>

**Root cause.** Inner `@Transactional` method threw `RuntimeException` caught and swallowed in outer method; transaction marked rollback-only; commit forbidden.

**Fix.** Rethrow, use `REQUIRES_NEW` per isolated unit of work, or `TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()` with explicit error response — never swallow runtime exceptions in transactional outer method.

---

</details>

<details class="qa-item">
<summary>25. REQUIRES_NEW audit still rolls back with order — verified annotation is correct?</summary>

**Root cause.** `placeOrder()` called `this.writeAudit()` — self-invocation bypasses Spring proxy; both methods share outer `REQUIRED` transaction.

**Fix.** Extract `AuditService` bean; inject and call through proxy; confirm TRACE log shows "Suspending current transaction" and "Creating new transaction".

---

</details>

<details class="qa-item">
<summary>26. Checked `BusinessException` commits partial order state?</summary>

**Root cause.** Default `@Transactional` rolls back only unchecked exceptions; checked exception propagates as normal completion from Spring's perspective.

**Fix.** `@Transactional(rollbackFor = Exception.class)` or make domain exceptions extend `RuntimeException`; add test asserting DB unchanged on failure.

---

</details>

<details class="qa-item">
<summary>27. Same query returns different row counts within one @Transactional read?</summary>

**Root cause.** Default `READ_COMMITTED` allows phantom inserts during long iteration; or no real transaction (`autoCommit` leak).

**Fix.** `isolation = REPEATABLE_READ` for reconcile jobs, or snapshot ids first; log `connection.getTransactionIsolation()` to verify level applied.

---

</details>

<details class="qa-item">
<summary>28. readOnly=true on service but SQL log shows UPDATE statements?</summary>

**Root cause.** `readOnly` on private helper called from public method without annotation — ignored; or class-level read-write default applies.

**Fix.** Public `@Transactional(readOnly=true)` on entry method; split read/write services; verify with `org.springframework.transaction=TRACE`.

---

</details>

<details class="qa-item">
<summary>29. Dynamic projection `findByStatus(status, userSuppliedClass)` — security review flagged?</summary>

**Root cause.** Passing arbitrary `Class` from request enables unintended entity hydration or class-loading attack surface.

**Fix.** Whitelist allowed projection types in service layer; never pass user input directly as `Class<T>` to repository.

---

</details>

<details class="qa-item">
<summary>30. Hibernate 6 upgrade — order list query 3× slower with distinct in JPQL?</summary>

**Root cause.** Hibernate 6 pushes `DISTINCT` to SQL; expensive sort/hash on large joined result; H5 relied on in-memory dedupe.

**Fix.** Remove unnecessary `distinct` from entity queries; use two-query pattern or flat constructor projection.

---

</details>

<details class="qa-item">
<summary>31. jdbc.batch_size=50 configured but SQL log shows single-row INSERTs?</summary>

**Root cause.** `GenerationType.IDENTITY` prevents JDBC batching; or flush between each `persist()` call.

**Fix.** Switch to `SEQUENCE` with `allocationSize=50`; set `order_inserts=true`; batch loop with periodic `flush()`/`clear()` only at chunk boundaries.

---

</details>

<details class="qa-item">
<summary>32. @DynamicUpdate entity still UPDATEs all columns?</summary>

**Root cause.** Mapping detached DTO via `merge()` replaces managed snapshot; Hibernate marks all fields dirty; or mutating wrong instance.

**Fix.** Mutate managed entity from `findById`; avoid full-entity merge from stale DTO; verify with SQL log that only changed columns appear.

</details>

<details class="qa-item">
<summary>33. Keyset pagination API returns empty page 2 but data exists?</summary>

**Root cause.** Cursor used `created_at` only without tie-breaker `id`; equal timestamps across rows caused cursor to skip valid records.

**Fix.** Composite cursor `(created_at, id)`; document cursor encoding for clients; integration test with concurrent inserts during pagination.

---

</details>

<details class="qa-item">
<summary>34. Page<T> list endpoint doubles database load — COUNT query dominates?</summary>

**Root cause.** `Page` always runs `select count(*)` with same WHERE clause; on tables with 10M rows and partial index mismatch, COUNT scans millions of rows per request.

**Fix.** Switch to `Slice<T>` for infinite scroll; cache approximate counts; denormalize count column; or keyset without total pages.

---

</details>

<details class="qa-item">
<summary>35. Custom OrderRepositoryImpl not invoked — Spring Data uses default methods only?</summary>

**Root cause.** Implementation class named `OrderRepositoryCustomImpl` instead of required `OrderRepositoryImpl`, or wrong package outside `@EnableJpaRepositories` scan.

**Fix.** Rename to `{InterfaceName}Impl`; verify bean in context; add `@DataJpaTest` calling custom method.

---

</details>

<details class="qa-item">
<summary>36. SKIP LOCKED job workers all idle but queue has PENDING rows?</summary>

**Root cause.** Stale `PROCESSING` rows from crashed workers never reset; or workers block each other with `FOR UPDATE` without `SKIP LOCKED`.

**Fix.** Reaper job resets `PROCESSING` older than timeout; use `SKIP LOCKED`; keep claim tx short; monitor lock waits.

---

</details>

<details class="qa-item">
<summary>37. @BatchSize configured but still 500 SELECTs for order lines?</summary>

**Root cause.** `@BatchSize` not applied — association accessed outside batch context; or `clear()` between parent and child access in same logical read.

**Fix.** Set `default_batch_fetch_size`; annotate collection; avoid `clear()` between parent and child access; verify with Hibernate statistics.

---

</details>

<details class="qa-item">
<summary>38. MANDATORY propagation throws IllegalTransactionStateException in test?</summary>

**Root cause.** Test calls service with `MANDATORY` without wrapping in `@Transactional`; or outer `NOT_SUPPORTED` suspended the tx.

**Fix.** Wrap test in `@Transactional`; or call through service that opens `REQUIRED` tx first; document MANDATORY as internal API only.

---

</details>

<details class="qa-item">
<summary>39. Constructor projection JPQL fails after package refactor?</summary>

**Root cause.** `select new com.oldpkg.OrderRow(...)` uses fully qualified class name; package move leaves stale JPQL string.

**Fix.** Centralize JPQL in constants; add startup integration test executing every custom query; use records in stable API module.

---

</details>

<details class="qa-item">
<summary>40. readOnly transaction still holds connection 30s on report endpoint?</summary>

**Root cause.** OSIV extends session through JSON serialization; or report runs slow aggregation inside single `@Transactional(readOnly=true)` without streaming.

**Fix.** Disable OSIV; return DTO; stream via `NOT_SUPPORTED` JDBC on read replica; paginate or pre-aggregate.

---

</details>

<details class="qa-item">
<summary>41. NESTED savepoint inner rollback but outer commits — data inconsistent?</summary>

**Root cause.** Outer caught inner exception and continued; inner rolled back to savepoint but outer logic assumed inner work persisted.

**Fix.** Use `REQUIRES_NEW` for truly independent units; with NESTED, check inner outcome before outer commit; prefer fail-fast.

---

</details>

<details class="qa-item">
<summary>42. MapStruct maps entity to DTO but exposes internal costPrice field?</summary>

**Root cause.** Mapper maps all matching property names; `costPrice` on entity maps to DTO unless explicitly ignored.

**Fix.** `@Mapping(target = "costPrice", ignore = true)`; separate internal vs public DTO types; code review mapper interfaces like API contracts.

---

</details>

<details class="qa-item">
<summary>43. Isolation REPEATABLE_READ on PostgreSQL — job sees phantom new orders mid-run?</summary>

**Root cause.** PostgreSQL `REPEATABLE_READ` uses snapshot isolation — behavior differs from MySQL next-key locking; job may use multiple transactions.

**Fix.** Single tx for reconcile; or export id snapshot first; document DB-specific isolation semantics in team wiki.

---

</details>

<details class="qa-item">
<summary>44. Dynamic projection Class from query param caused unexpected full entity load?</summary>

**Root cause.** Client passed `Order.class` instead of `OrderSummary.class`; Spring Data hydrated full managed entities — memory spike and lazy risk.

**Fix.** Whitelist allowed projection types in service enum; reject unknown classes; never expose `Class<T>` parameter to HTTP layer.

</details>
