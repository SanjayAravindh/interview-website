const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { ROOT } = require("../lib/notes");

const filePath = path.join(ROOT, "notes/Spring/Spring_Data_JPA_and_Transactions.md");
let md = fs.readFileSync(filePath, "utf8");

function splitSections(content) {
  const match = content.match(/^([\s\S]*?)(^## \d+\.[\s\S]*)$/m);
  if (!match) throw new Error("Could not find first numbered section");
  const preamble = match[1];
  const body = match[2];
  const parts = body.split(/^## \d+\.\s+/m);
  const titles = [...body.matchAll(/^## (\d+\.\s+.+)$/gm)].map((m) => m[1]);
  const sections = titles.map((title, i) => ({
    title,
    content: parts[i + 1] || "",
  }));
  return { preamble, sections };
}

function buildSection(num, title, content) {
  return `## ${num}. ${title}\n\n${content.trim()}\n\n---\n`;
}

const { preamble, sections: raw } = splitSections(md);

const byNum = {};
for (const s of raw) {
  const n = parseInt(s.title, 10);
  byNum[n] = s.content;
}

const titles = {
  1: "Mental Model: EntityManager, Session, Persistence Context, Flush Lifecycle",
  2: "Spring Data JPA Architecture",
  3: "Entity Mapping: Associations, Cascades, Embeddables, Inheritance",
  4: "Entity Design Pitfalls Catalog",
  5: "Lazy Loading, N+1, Fetch Joins, @EntityGraph, Batch Fetching",
  6: "Fetching Strategy Decision Tree",
  7: "Projections (interface, open/closed, DTO, constructor JPQL, records, dynamic projections, SQL comparison)",
  8: "DTO Mapping Strategies (MapStruct vs manual, transaction boundary)",
  9: "Transaction Management: @Transactional Propagation, Isolation, readOnly",
  10: "All @Transactional Propagation Values with Worked Examples + Matrix",
  11: "Rollback Rules (UnexpectedRollbackException sequence)",
  12: "Isolation Levels via @Transactional",
  13: "PlatformTransactionManager & TransactionSynchronization",
  14: "Transaction Boundaries: Service Layer, Self-Invocation, Private Methods",
  15: "Open Session In View (OSIV) / spring.jpa.open-in-view",
  16: "Flush Modes, Dirty Checking, merge vs persist vs update",
  17: "Hibernate 6 Specifics (SQM, batching, @BatchSize, IDENTITY batch failure)",
  18: "Read-Only Transactions and Performance",
  19: "Optimistic vs Pessimistic Locking (@Version, LockModeType)",
  20: "Concurrency Locking Recap with SKIP LOCKED Queue Pattern",
  21: "Auditing (@CreatedDate, Envers)",
  22: "Specifications, Criteria API, Querydsl",
  23: "Native Queries, SqlResultSetMapping, Stored Procedures",
  24: "Multi-Tenancy (Discriminator, Schema, Database)",
  25: "Second-Level Cache Pitfalls",
  26: "Connection Pool + Transaction Timeout Interactions",
  27: "@Modifying Queries, Bulk Updates, clearAutomatically",
  28: "Testing: @DataJpaTest, Testcontainers, @Transactional Rollback",
  29: "Spring Data JDBC vs JPA — When to Use Which",
  30: "Pagination, Sorting, and Keyset Patterns",
  31: "Custom Repositories, Query Hints, and Fetch Profiles",
  32: "Production Debugging Playbook",
  33: "Quick Decision Matrix",
};

// Map old section numbers to content (before reorder)
const old = byNum;

// Reordered content sources
byNum[1] = old[1];
byNum[2] = old[2];
byNum[3] = old[3];
byNum[4] = old[4];
byNum[5] = old[5];
byNum[6] = old[6];
byNum[7] = old[7];
byNum[8] = old[8];
byNum[9] = old[9];
byNum[10] = old[10];
byNum[11] = old[11];
byNum[12] = old[12];
byNum[13] = old[13];
byNum[14] = old[14];
byNum[15] = old[15];
byNum[16] = old[16];
byNum[17] = old[20]; // Hibernate 6
byNum[18] = old[17]; // Read-only
byNum[19] = old[19]; // Optimistic/Pessimistic
byNum[20] = old[18]; // Concurrency recap
for (let i = 21; i <= 29; i++) byNum[i] = old[i];
byNum[32] = old[30]; // Production Debugging
byNum[33] = old[31]; // Quick Decision Matrix

// --- Section 7: SQL comparison ---
const sqlComparison = `
### SQL comparison by projection type

| Projection type | Typical SQL shape | Round trips | Persistence context | N+1 risk |
|---|---|---|---|---|
| Closed interface | \`SELECT o.id, o.order_number, o.status FROM orders o WHERE ...\` | 1 | None | Low if derived query only selects root columns |
| Open interface (SpEL) | Same root SELECT; SpEL may fire extra SELECTs per row | 1 + lazy | None for root | **High** if \`@Value\` touches associations |
| DTO class (property names) | Same as closed interface | 1 | None | Low |
| Constructor / record JPQL | \`SELECT o.id, o.order_number, c.name FROM orders o JOIN customer c ...\` | 1 | None | **None** — joins explicit in JPQL |
| Dynamic \`Class<T>\` | Varies by runtime type argument | 1 | None if projection type | Medium — must whitelist allowed types |
| Full entity \`Order.class\` | \`SELECT o.* FROM orders o ...\` | 1 | **Yes** — managed | High if lazy fields accessed after query |

**Rule of thumb:** constructor/record projections give you the SQL you wrote; interface projections give you the SQL Spring Data inferred — verify both in integration tests.
`;
if (!byNum[7].includes("SQL comparison by projection type")) {
  byNum[7] = byNum[7].replace(
    "Nothing in a projection enters the persistence context — no dirty checking, no proxies, no `LazyInitializationException`.",
    "Nothing in a projection enters the persistence context — no dirty checking, no proxies, no `LazyInitializationException`." +
      sqlComparison
  );
}

// --- Section 8: MapStruct vs manual ---
const mapstructCompare = `
### MapStruct vs manual mapping

| Concern | Manual mapping | MapStruct |
|---|---|---|
| Compile-time safety | Full control; typos caught in IDE | Generated code; wrong \`@Mapping\` caught at compile |
| Lazy association risk | Visible in one method | Hidden in generated impl — review \`*MapperImpl.java\` |
| Performance | Zero overhead | Zero overhead (no reflection) |
| Boilerplate | High for large graphs | Low; \`@Mapping\` for nested paths |
| Testability | Trivial unit test | Test generated impl or integration |
| Transaction boundary | Same rule: map inside \`@Transactional(readOnly=true)\` | Same |

Use **projections + MapStruct** for list screens; use **manual mapping** when logic is non-trivial (conditional fields, security redaction, computed aggregates). Never use **ModelMapper/BeanUtils reflection** on hot paths — property name guessing breaks silently under refactor.
`;
if (!byNum[8].includes("MapStruct vs manual mapping")) {
  byNum[8] = byNum[8].replace(
    "### Internal working\n\n**Manual mapping**",
    mapstructCompare + "\n### Internal working\n\n**Manual mapping**"
  );
}

// --- Section 10: extra propagation examples ---
const propagationExamples = `
**Worked examples for less-used propagation values:**

\`\`\`java
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

// NEVER — utility that must never run inside a transaction (e.g. calls external API that opens its own)
@Service
public class ExternalPricingClient {
    @Transactional(propagation = Propagation.NEVER)
    public BigDecimal fetchLivePrice(String sku) {
        return restClient.getPrice(sku); // IllegalTransactionStateException if called from @Transactional service
    }
}
\`\`\`
`;
if (!byNum[10].includes("Worked examples for less-used propagation")) {
  byNum[10] = byNum[10].replace(
    "**`NOT_SUPPORTED` use case**",
    propagationExamples + "\n**`NOT_SUPPORTED` use case**"
  );
}

// --- Section 17: @BatchSize + IDENTITY (Hibernate 6) ---
const batchSizeBlock = `
**\`@BatchSize\` on entities and collections:**

\`@BatchSize\` batches lazy loads — N+1 becomes 1 + ceil(N/batchSize) queries instead of 1 + N:

\`\`\`java
@Entity
@BatchSize(size = 25)
public class Order {
    @OneToMany(mappedBy = "order")
    @BatchSize(size = 25)
    private List<OrderLine> lines;
}

// Global default (applies when @BatchSize not on entity):
// spring.jpa.properties.hibernate.default_batch_fetch_size: 32
\`\`\`

When Hibernate lazy-loads \`lines\` for 100 orders, it issues \`WHERE order_id IN (?,?,...)\` in batches of 25 — four queries instead of 100. Pair with \`@BatchSize\` on \`@ManyToOne\` inverse sides when you cannot fetch-join two collections (section 6).

**\`IDENTITY\` vs \`SEQUENCE\` — the batch failure mode:**

| Id strategy | JDBC batch INSERT? | Why |
|---|---|---|
| \`GenerationType.IDENTITY\` | **No** | Driver must execute INSERT immediately to retrieve generated key |
| \`GenerationType.SEQUENCE\` (allocationSize = batch_size) | **Yes** | IDs pre-allocated from sequence; Hibernate batches INSERT statements |
| \`GenerationType.TABLE\` | Yes (with tuning) | Similar to sequence but higher overhead |

\`\`\`java
// IDENTITY — batch_size ignored for inserts; one round trip per row
@Id @GeneratedValue(strategy = GenerationType.IDENTITY)
private Long id;

// SEQUENCE — batch-friendly
@Id
@GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "order_seq")
@SequenceGenerator(name = "order_seq", sequenceName = "order_seq", allocationSize = 50)
private Long id;
\`\`\`

Symptom: \`hibernate.jdbc.batch_size=50\` configured but SQL log shows single-row INSERTs — check id generator first before tuning flush cadence.
`;
if (!byNum[17].includes("@BatchSize` on entities and collections")) {
  byNum[17] = byNum[17].replace(
    "**Identity columns block batching**",
    batchSizeBlock + "\n**Identity columns block batching**"
  );
}

// --- Section 18: update title references ---
byNum[18] = byNum[18].replace(
  "## 17. Read-Only and Performance",
  ""
);
byNum[18] = byNum[18].replace(
  "Combined with projections (section 7) and short transactions",
  "Combined with projections (section 7) and short transactions"
);

// --- Section 20: SKIP LOCKED queue pattern ---
const skipLocked = `
### SKIP LOCKED queue pattern (PostgreSQL / MySQL 8+)

Work-queue consumers competing for the same rows need **pessimistic lock + skip locked rows already claimed** — avoids thundering herd blocking on \`FOR UPDATE\`:

\`\`\`java
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
\`\`\`

| Pattern | SQL | Use when |
|---|---|---|
| \`FOR UPDATE\` | Blocks until row free | Single consumer or strict ordering |
| \`FOR UPDATE SKIP LOCKED\` | Skips rows locked by other workers | Horizontally scaled job workers |
| \`FOR UPDATE NOWAIT\` | Fails immediately if row locked | Fail-fast single attempt |
| Optimistic \`@Version\` + status CAS | \`UPDATE ... WHERE status='PENDING' AND version=?\` | Low collision; no row lock held during processing |

**Production notes:** keep claim transaction **short** — lock only during status transition PENDING→PROCESSING; do heavy work in a separate tx or after commit. On PostgreSQL, \`SKIP LOCKED\` requires \`FOR UPDATE\`; Hibernate \`@Lock(PESSIMISTIC_WRITE)\` on native query passes through dialect-specific clause. MySQL 8+ supports \`SKIP LOCKED\`; verify dialect in Testcontainers before prod.

**Anti-pattern:** long-running processing inside the same \`@Transactional\` that holds \`FOR UPDATE\` — blocks all other workers on hot queue rows and causes lock wait timeouts.
`;
if (!byNum[20].includes("SKIP LOCKED queue pattern")) {
  byNum[20] = byNum[20].replace(
    "JPA offers two families of concurrency control",
    skipLocked + "\n### Core concept\n\nJPA offers two families of concurrency control"
  );
  // Remove duplicate ### Core concept if we added one before existing
  byNum[20] = byNum[20].replace(
    "### Core concept\n\n### Core concept\n\n",
    "### Core concept\n\n"
  );
  byNum[20] = byNum[20].replace(
    "Section 19 goes deep on each mode",
    "Section 19 goes deep on each mode"
  );
}

// --- New section 30 ---
byNum[30] = `
### Core concept

Spring Data \`Pageable\` / \`Sort\` translate to \`LIMIT/OFFSET\` (or dialect equivalents). Offset pagination is simple but **degrades on deep pages** — \`OFFSET 100000\` scans and discards 100k rows. **Keyset (seek) pagination** uses the last seen sort key as a cursor: \`WHERE (created_at, id) > (:cursorCreated, :cursorId)\` — constant-time regardless of page depth.

### Internal working

\`\`\`java
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
\`\`\`

**\`Page\` vs \`Slice\` vs \`List\`:**

| Return type | Extra COUNT query? | When |
|---|---|---|
| \`Page<T>\` | **Yes** — \`select count(*)\` for total pages | Admin grids needing "page 47 of 200" |
| \`Slice<T>\` | No — hasNext from limit+1 trick | Infinite scroll; mobile feeds |
| \`List<T>\` + explicit limit | No | Keyset cursors; export batches |

**Sort stability:** always add a unique tie-breaker (\`id\`) when sorting by non-unique columns (\`created_at\`, \`name\`) — prevents duplicate/missing rows across pages when concurrent inserts occur (see Q&A item 14).

**Fetch join + pagination trap:** \`join fetch\` with \`Pageable\` often loads all rows in memory then slices in Hibernate — use two queries (ids page, then fetch join by ids) or projection.

### Production scenario: duplicate rows across API pages

**Problem.** Mobile feed shows same order twice after user scrolls.

**Cause.** Sort by \`created_at\` only; new row inserted between page fetches shifts offset window.

**Solution.** Keyset pagination with \`(created_at, id)\` composite cursor; or stable sort with tie-breaker id.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Deep \`OFFSET\` on large table | p99 latency grows linearly with page number |
| \`Page\` on high-traffic list | Double query load (COUNT + SELECT) |
| fetch join + Pageable | Memory spike; wrong page size |
| Unstable sort column | Duplicate/missing rows across pages |

### Debugging scenario

**Observe.** Page 500 timeout; COUNT query 2s.

**Diagnose.** \`EXPLAIN ANALYZE\` on COUNT and SELECT; check index on sort columns + filter columns.

**Fix.** Keyset pagination; denormalized count cache; or \`Slice\` without total count.
`;

// --- New section 31 ---
byNum[31] = `
### Core concept

Spring Data repository interfaces compose from **fragments** — custom implementation classes wired automatically when you extend a custom interface. Use for complex queries that exceed derived method naming, or when you need programmatic Criteria/Querydsl without polluting the main repository.

### Internal working

\`\`\`java
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
\`\`\`

**Query hints and fetch profiles:**

\`\`\`java
@QueryHints(@QueryHint(name = "org.hibernate.readOnly", value = "true"))
@Query("select o from Order o where o.status = :s")
List<Order> findReadOnly(@Param("s") OrderStatus s);

// Named fetch profile on entity (Hibernate)
@Entity
@NamedEntityGraph(name = "Order.detail", attributeNodes = {
    @NamedAttributeNode("customer"), @NamedAttributeNode("lines")
})
public class Order { ... }

@EntityGraph(value = "Order.detail", type = EntityGraph.EntityGraphType.FETCH)
Optional<Order> findDetailById(Long id);
\`\`\`

| Mechanism | Purpose |
|---|---|
| \`@QueryHint\` | Pass provider-specific hints (readOnly, fetchSize, timeout) |
| \`@EntityGraph\` / \`@NamedEntityGraph\` | Declarative fetch plan override per query |
| \`@Query(..., hints = @QueryHint(...))\` | Per-query timeout for SLA enforcement |
| Custom fragment | Dynamic Criteria, native SQL with fallback, multi-step fetch |

Custom repos inherit the caller's transaction — no special propagation. Keep write logic in services; custom repos return projections or mutate only when the service opened a write transaction.

### Production scenario: custom repo bypasses tenant filter

**Problem.** \`OrderRepositoryImpl\` uses Criteria API; tenant B data visible to tenant A.

**Cause.** Native Criteria query without \`tenantId\` predicate; \`@TenantId\` not applied to programmatic queries.

**Solution.** Always add tenant predicate from \`TenantContext\`; or use Hibernate \`@Filter\` enabled on Session.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Custom impl class named wrong (\`OrderRepositoryCustomImpl\` vs \`OrderRepositoryImpl\`) | Custom methods not wired; empty bean |
| \`@Transactional\` on custom impl | Redundant; wrong layer |
| Query hints copied from Hibernate 5 docs | Ignored silently on Hibernate 6 |
| EntityGraph + fetch join in same query | Conflicting fetch plans; cartesian product |

### Debugging scenario

**Observe.** \`searchOrders\` custom method not found at runtime.

**Diagnose.** Verify class name \`{InterfaceName}Impl\` in same package; check \`@EnableJpaRepositories\` base package.

**Fix.** Rename to \`OrderRepositoryImpl\`; add integration test calling custom method.
`;

// Fix internal section references
let body = "";
for (let i = 1; i <= 33; i++) {
  body += buildSection(i, titles[i], byNum[i]);
}

// Extract Q&A and footer from original
const qaMatch = md.match(/(\n## Practice Questions[\s\S]*)$/);
let qaBlock = qaMatch ? qaMatch[1] : "";

const newQaItems = `
<details class="qa-item">
<summary>33. Keyset pagination API returns empty page 2 but data exists?</summary>

**Root cause.** Cursor used \`created_at\` only without tie-breaker \`id\`; equal timestamps across rows caused cursor to skip valid records.

**Fix.** Composite cursor \`(created_at, id)\`; document cursor encoding for clients; integration test with concurrent inserts during pagination.

---

</details>

<details class="qa-item">
<summary>34. Page<T> list endpoint doubles database load — COUNT query dominates?</summary>

**Root cause.** \`Page\` always runs \`select count(*)\` with same WHERE clause; on tables with 10M rows and partial index mismatch, COUNT scans millions of rows per request.

**Fix.** Switch to \`Slice<T>\` for infinite scroll; cache approximate counts; denormalize count column; or keyset without total pages.

---

</details>

<details class="qa-item">
<summary>35. Custom OrderRepositoryImpl not invoked — Spring Data uses default methods only?</summary>

**Root cause.** Implementation class named \`OrderRepositoryCustomImpl\` instead of required \`OrderRepositoryImpl\`, or wrong package outside \`@EnableJpaRepositories\` scan.

**Fix.** Rename to \`{InterfaceName}Impl\`; verify bean in context; add \`@DataJpaTest\` calling custom method.

---

</details>

<details class="qa-item">
<summary>36. SKIP LOCKED job workers all idle but queue has PENDING rows?</summary>

**Root cause.** Stale \`PROCESSING\` rows from crashed workers never reset; or transaction isolation prevents seeing new rows; or \`FOR UPDATE\` without \`SKIP LOCKED\` causes workers blocked on each other.

**Fix.** Reaper job resets \`PROCESSING\` older than timeout; use \`SKIP LOCKED\`; keep claim tx short; monitor lock waits.

---

</details>

<details class="qa-item">
<summary>37. @BatchSize configured but still 500 SELECTs for order lines?</summary>

**Root cause.** \`@BatchSize\` on entity not applied — association accessed outside batch context; or \`hibernate.default_batch_fetch_size\` not set and entity lacks annotation; or each order loaded in separate persistence context after \`clear()\`.

**Fix.** Set \`default_batch_fetch_size\`; annotate collection; avoid \`clear()\` between parent and child access; verify with statistics.

---

</details>

<details class="qa-item">
<summary>38. MANDATORY propagation throws IllegalTransactionStateException in test?</summary>

**Root cause.** Test calls repository/service method with \`MANDATORY\` without wrapping test in \`@Transactional\`; or \`NOT_SUPPORTED\` outer method suspended the tx.

**Fix.** Wrap test in \`@Transactional\`; or call through service that opens \`REQUIRED\` tx first; document MANDATORY as "internal API only."

---

</details>

<details class="qa-item">
<summary>39. Constructor projection JPQL fails after package refactor?</summary>

**Root cause.** \`select new com.oldpkg.OrderRow(...)\` uses fully qualified class name; package move leaves stale JPQL string — fails at query creation or returns wrong type.

**Fix.** Centralize JPQL in \`@Query\` constants; add startup integration test executing every custom query; use records in stable API module.

---

</details>

<details class="qa-item">
<summary>40. readOnly transaction still holds connection 30s on report endpoint?</summary>

**Root cause.** OSIV extends session through JSON serialization; or report runs slow aggregation inside single \`@Transactional(readOnly=true)\` without streaming.

**Fix.** Disable OSIV; return DTO; stream via \`NOT_SUPPORTED\` JDBC on read replica; paginate or pre-aggregate.

---

</details>

<details class="qa-item">
<summary>41. NESTED savepoint inner rollback but outer commits — data inconsistent?</summary>

**Root cause.** Outer caught inner exception and continued; inner rolled back to savepoint but outer logic assumed inner work persisted; misunderstanding NESTED vs REQUIRES_NEW.

**Fix.** Use \`REQUIRES_NEW\` for truly independent units; with NESTED, check inner outcome before outer commit; prefer fail-fast over partial savepoint recovery.

---

</details>

<details class="qa-item">
<summary>42. MapStruct maps entity to DTO but exposes internal costPrice field?</summary>

**Root cause.** Mapper maps all matching property names; \`costPrice\` on entity maps to DTO unless explicitly ignored; no security layer on outbound mapping.

**Fix.** \`@Mapping(target = "costPrice", ignore = true)\`; separate internal vs public DTO types; code review mapper interfaces like API contracts.

---

</details>

<details class="qa-item">
<summary>43. Isolation REPEATABLE_READ on PostgreSQL — job sees phantom new orders mid-run?</summary>

**Root cause.** PostgreSQL \`REPEATABLE_READ\` uses snapshot isolation — phantoms in **read** sense blocked, but concurrent commits visible on **new queries** in some patterns; or job used multiple transactions.

**Fix.** Single tx for reconcile; or export id snapshot first; understand PG snapshot vs MySQL next-key locking differences.

---

</details>

<details class="qa-item">
<summary>44. Dynamic projection Class from query param caused unexpected full entity load?</summary>

**Root cause.** Client passed \`Order.class\` instead of \`OrderSummary.class\`; Spring Data hydrated full managed entities — memory spike and lazy risk.

**Fix.** Whitelist allowed projection types in service enum; reject unknown classes; never expose \`Class<T>\` parameter to HTTP layer.

</details>
`;

// Insert new Q&A before closing footer
if (!qaBlock.includes("33. Keyset pagination")) {
  const footerMatch = qaBlock.match(/\n\*JPA will not save you[\s\S]*$/);
  const footer = footerMatch ? footerMatch[0] : "";
  const qaWithoutFooter = footer ? qaBlock.slice(0, -footer.length) : qaBlock;
  qaBlock = qaWithoutFooter.trimEnd() + "\n\n" + newQaItems + "\n\n" + footer.trim() + "\n";
}

// Fix section references in full content
let full = preamble.replace(/\n## Table of Contents[\s\S]*?\n---\n+/g, "\n") + body;

full = full.replace(/see section 20\b/g, "see section 17");
full = full.replace(/section 28\)/g, "section 28)");
full = full.replace(/\(section 28\)/g, "(section 28)");

fs.writeFileSync(filePath, full.trim() + "\n" + qaBlock.trim() + "\n", "utf8");

execSync('node scripts/reformat-one-note.js notes/Spring/Spring_Data_JPA_and_Transactions.md', {
  cwd: ROOT,
  stdio: "inherit",
});

execSync("node scripts/validate-toc-links.js", { cwd: ROOT, stdio: "inherit" });

const final = fs.readFileSync(filePath, "utf8");
const lineCount = final.split("\n").length;
const sectionCount = (final.match(/^## \d+\./gm) || []).length;
const qaCount = (final.match(/<details class="qa-item">/g) || []).length;
console.log(JSON.stringify({ lineCount, sectionCount, qaCount }, null, 2));
