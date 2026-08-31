# SQL & RDBMS Mastery — Senior Production Reference

PostgreSQL 15+ / MySQL 8.x (InnoDB). This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping relational backends — slow queries that only appear at scale, lock wait timeouts during batch jobs, replica lag that makes dashboards lie, migrations that lock tables for minutes, and connection pool math that quietly exhausts `max_connections` at 2 AM.

---

## Table of Contents

1. [Mental Model: One Query Through the Engine](#1-mental-model-one-query-through-the-engine)
2. [Relational Model & Integrity Constraints](#2-relational-model-integrity-constraints)
3. [Normalization (1NF–3NF) & When to Denormalize](#3-normalization-1nf3nf-when-to-denormalize)
4. [SQL DDL: Schemas, Types, Constraints, Migrations](#4-sql-ddl-schemas-types-constraints-migrations)
5. [SQL DML: INSERT, UPDATE, DELETE, UPSERT](#5-sql-dml-insert-update-delete-upsert)
6. [Joins: Inner, Outer, Cross, Self — Semantics That Matter](#6-joins-inner-outer-cross-self-semantics-that-matter)
7. [Subqueries, CTEs, and Correlated Queries](#7-subqueries-ctes-and-correlated-queries)
8. [Aggregates, GROUP BY, HAVING, and DISTINCT Pitfalls](#8-aggregates-group-by-having-and-distinct-pitfalls)
9. [Window Functions: Ranking, Frames, and Production Patterns](#9-window-functions-ranking-frames-and-production-patterns)
10. [Indexes: B-tree, Composite, Covering, Partial](#10-indexes-b-tree-composite-covering-partial)
11. [EXPLAIN / ANALYZE & Reading Execution Plans](#11-explain-analyze-reading-execution-plans)
12. [Query Optimization Playbook](#12-query-optimization-playbook)
13. [Transactions & ACID — What the Database Actually Guarantees](#13-transactions-acid-what-the-database-actually-guarantees)
14. [Isolation Levels: READ UNCOMMITTED Through SERIALIZABLE](#14-isolation-levels-read-uncommitted-through-serializable)
15. [MVCC: PostgreSQL vs MySQL InnoDB](#15-mvcc-postgresql-vs-mysql-innodb)
16. [Locking: Row, Table, Gap, Next-Key](#16-locking-row-table-gap-next-key)
17. [Deadlocks: Detection, Prevention, Recovery](#17-deadlocks-detection-prevention-recovery)
18. [Connection Pooling Math: max_connections vs App Pods](#18-connection-pooling-math-max_connections-vs-app-pods)
19. [Read Replicas & Replication Lag](#19-read-replicas-replication-lag)
20. [Partitioning & Sharding Basics](#20-partitioning-sharding-basics)
21. [Stored Procedures: When / When Not](#21-stored-procedures-when-when-not)
22. [Flyway / Liquibase Migration Safety](#22-flyway-liquibase-migration-safety)
23. [Production Scenarios: Slow Query, Missing Index, Lock Wait, Replica Lag](#23-production-scenarios-slow-query-missing-index-lock-wait-replica-lag)
24. [Production Debugging Playbook](#24-production-debugging-playbook)
25. [Quick Decision Matrix](#25-quick-decision-matrix)
26. [Scenario-Based Questions](#26-scenario-based-questions)
27. [Appendix A: Set Operations & NULL Semantics](#appendix-a-set-operations-null-semantics)
28. [Appendix B: Monitoring Queries (Copy-Paste Starters)](#appendix-b-monitoring-queries-copy-paste-starters)
29. [Appendix C: Isolation Level Cheat Sheet (Engine Behavior)](#appendix-c-isolation-level-cheat-sheet-engine-behavior)

---

## 1. Mental Model: One Query Through the Engine

A relational database is not "a place you store rows." It is a **transactional storage engine** behind a **SQL planner/executor** that turns declarative queries into physical access paths — sequential scans, index seeks, nested loops, hash joins — while coordinating **MVCC visibility**, **locks**, and **WAL/redo logs** so concurrent sessions do not corrupt each other.

```
Client (app / psql / JDBC)
  └─ Connection (session state: isolation level, temp tables, prepared stmts)
       └─ Connection pool (HikariCP / pgBouncer) — NOT the database
            └─ Database server process
                 ├─ Parser / Analyzer (syntax → query tree)
                 ├─ Rewriter (rules, views, RLS policies in PG)
                 ├─ Planner / Optimizer (cost model → plan tree)
                 ├─ Executor (operators: Seq Scan, Index Scan, Hash Join, Sort, Aggregate)
                 │    └─ Buffer pool / InnoDB buffer pool (cached pages)
                 │         └─ Storage (heap pages, B-tree index pages, WAL/binlog)
                 └─ Transaction manager (MVCC snapshots, lock manager, deadlock detector)
```

Three layers you must keep distinct:

| Layer | Question it answers | Production failure mode |
|---|---|---|
| SQL semantics | What rows *should* this query return? | Wrong JOIN type, duplicate aggregates, NULL logic bugs |
| Query plan | *How* will the engine fetch those rows? | Seq scan on 200M rows, nested loop on cartesian product |
| Concurrency | What can other sessions see while this runs? | Phantom reads, lost updates, lock wait timeout, deadlocks |

A slow query is rarely "SQL is slow." It is usually **wrong plan + missing index + stale statistics + lock contention + pool starvation** stacked together. A replica lag incident is rarely "replication is broken." It is **large transactions on primary + long-running analytics on replica + synchronous settings mis-tuned**.

---

## 2. Relational Model & Integrity Constraints

### Core concept

The relational model organizes data into **relations** (tables): sets of tuples (rows) where each tuple maps attributes (columns) to atomic values. Relationships between tables are expressed via **keys**, not pointers — though the engine implements them as B-tree indexes and foreign-key metadata.

| Concept | Definition | Production note |
|---|---|---|
| Primary key (PK) | Uniquely identifies a row; ideally stable, narrow, non-null | Surrogate keys (`BIGSERIAL` / `AUTO_INCREMENT`) beat natural keys that change |
| Foreign key (FK) | Child column(s) reference parent PK; enforces referential integrity | Cascades (`ON DELETE CASCADE`) are convenient and dangerous at scale |
| Unique constraint | Alternate business keys (`email`, `order_number`) | NULL handling differs: PG allows multiple NULLs in UNIQUE; MySQL InnoDB treats NULL as distinct in unique indexes (multiple NULLs allowed) |
| Check constraint | Row-level predicate (`price >= 0`) | Prefer DB checks for invariants that must never break, not all validation |
| Not null | Column cannot store SQL NULL | `NULL` means unknown — not empty string, not zero |

### Internal working

**PostgreSQL** stores rows in heap pages. PK creates a unique B-tree index (unless `PRIMARY KEY` uses `USING HASH` — rare). FK adds a trigger-like mechanism: on INSERT/UPDATE to child, parent row must exist; on DELETE/UPDATE of parent, action depends on `ON DELETE` / `ON UPDATE`.

**MySQL InnoDB** clusters the table by PK — the PK index leaf pages **are** the row data. Secondary indexes store `(index_columns, PK_columns)` pointing to clustered index. This makes narrow, monotonic PKs (BIGINT auto-increment) critical — random UUID PKs cause page splits and bloat.

### Production scenario: orphan rows without FK

**Problem.** Microservice A writes `orders`; service B writes `shipments` with `order_id`. No FK because "services own their data." Support finds shipments for deleted orders. Finance reconciliation fails.

**Solution.** Either enforce FK if shared database (monolith or modular monolith), or enforce **synchronous contract** (event + idempotency) and periodic reconciliation job. If you skip FK, you own orphan detection forever.

```sql
-- PostgreSQL: add FK with NOT VALID first (PG 9.1+), validate later off-peak
ALTER TABLE shipments
  ADD CONSTRAINT fk_shipments_order
  FOREIGN KEY (order_id) REFERENCES orders(id)
  NOT VALID;

-- Clean orphans first
DELETE FROM shipments s
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = s.order_id);

ALTER TABLE shipments VALIDATE CONSTRAINT fk_shipments_order;
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Natural key as PK (email, SKU that gets merged) | CASCADE updates ripple; ORM merge hell; FK rewrites |
| UUID v4 as clustered PK in InnoDB | Fragmentation, buffer pool churn, insert slowdown |
| FK with `ON DELETE CASCADE` on deep graph | Single parent delete locks/d cascades millions of child deletes |
| No unique constraint on business key | Duplicate rows from retry/idempotency bugs |
| `VARCHAR(255)` everywhere by default | Oversized index entries; wrong charset/collation surprises in MySQL |

### Debugging scenario

**Observe.** `INSERT INTO order_items ...` fails with FK violation but order "exists" in the API.

**Diagnose.** Order row not committed yet (read-your-writes broken across connections). Wrong schema/database. Soft-deleted parent still visible to app but hard-deleted in DB. Replication lag — writing to primary, reading from stale replica.

**Fix.** Same connection/transaction for related inserts. Align soft-delete semantics with FK (don't hard-delete parent while children exist unless intended).

---

## 3. Normalization (1NF–3NF) & When to Denormalize

### Core concept

Normalization reduces redundancy and update anomalies by decomposing tables so facts are stored once.

| Normal form | Rule (practical) | Violation example |
|---|---|---|
| **1NF** | Atomic columns; no repeating groups | `tags` column storing `"a,b,c"` instead of junction table |
| **2NF** | 1NF + no partial dependency on composite PK | `(order_id, product_id) → product_name` when `product_name` depends only on `product_id` |
| **3NF** | 2NF + no transitive dependency on non-key attributes | `orders(customer_id, customer_city)` when city depends on `customer_id` |

**BCNF** (stricter 3NF): every determinant is a candidate key. Most OLTP schemas target 3NF/BCNF unless there is a measured read reason not to.

### When to denormalize (senior rule)

Denormalize only when you can name **the read path, the write cost, and the consistency story**:

| Pattern | When | Consistency mechanism |
|---|---|---|
| Materialized counters (`order_count` on customer) | Hot read, rare write | Transactional update in same tx as insert; or async reconcile |
| Snapshot columns (`product_name` on order_line) | Historical immutability | Accept staleness on catalog rename; never update in place for past orders |
| Summary tables / rollups | Dashboard latency SLA | Batch ETL, triggers (careful), or CQRS projection |
| JSONB / JSON column for semi-structured attrs | Schema volatility, read-heavy document shape | Partial indexes; validate in app; avoid querying deep paths without index support |

Denormalization without a reconciliation job is how **dashboard totals diverge from ledger truth**.

### Production scenario: over-normalized chat messages

**Problem.** Every message fetch joins `messages → users → avatars → presence`. P99 latency spikes at 500 RPS.

**Solution.** Keep normalized source of truth. Add read-optimized projection: `message_feed_view` table or cache with `(message_id, author_display_name, avatar_url_snapshot)`. Write path updates both in one transaction or via outbox event.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| EAV (entity-attribute-value) for core domain | Un-indexable queries; impossible FK integrity |
| Denormalized counters updated outside transaction | Drift; angry finance |
| Splitting 1:1 tables "for purity" with no gain | Join tax on every read |
| JSON blob for relational facts you filter on | Full table scans; cannot enforce constraints |

---

## 4. SQL DDL: Schemas, Types, Constraints, Migrations

### Core concept

DDL defines structure. In production, **how** you apply DDL matters as much as **what** — `ALTER TABLE` on large tables can lock, rewrite, or replicate slowly.

### PostgreSQL vs MySQL DDL highlights

| Operation | PostgreSQL | MySQL InnoDB |
|---|---|---|
| Add nullable column | Fast (metadata only, PG 11+) | Instant if algorithm=INSTANT supported |
| Add column with DEFAULT | Fast metadata + no rewrite (PG 11+) | Instant in 8.0.12+ for constant default |
| Change column type | May rewrite table | Often copies entire table |
| Create index | `CREATE INDEX CONCURRENTLY` (no blocking writes) | Online DDL depends on `ALGORITHM` / `LOCK` |
| Drop column | Fast mark dropped (PG) | May rebuild |

### Types that save incidents

```sql
-- PostgreSQL: use proper types
CREATE TABLE payments (
  id          BIGSERIAL PRIMARY KEY,
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency    CHAR(3) NOT NULL,
  status      payment_status NOT NULL,  -- ENUM type or TEXT + CHECK
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MySQL: prefer DECIMAL for money; never FLOAT
CREATE TABLE payments (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  amount_cents BIGINT NOT NULL,
  currency     CHAR(3) NOT NULL,
  status       ENUM('pending','captured','failed') NOT NULL,
  created_at   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB;
```

**Rules:**

- Money: `BIGINT` cents or `DECIMAL(p,s)` — never binary floats.
- Timestamps: `TIMESTAMPTZ` in PostgreSQL; `TIMESTAMP(6)` + UTC discipline in MySQL.
- Booleans: PostgreSQL `BOOLEAN`; MySQL `TINYINT(1)` or `BOOLEAN` alias — be consistent in ORM.

### Production scenario: adding NOT NULL to 400M-row table

**Problem.** `ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';` on MySQL 5.7 locks table for hours.

**Solution (PostgreSQL pattern):**

```sql
ALTER TABLE users ADD COLUMN tier TEXT;
UPDATE users SET tier = 'free' WHERE tier IS NULL;  -- batched in app if needed
ALTER TABLE users ALTER COLUMN tier SET NOT NULL;
ALTER TABLE users ALTER COLUMN tier SET DEFAULT 'free';
```

**Solution (MySQL 8):** use instant ADD COLUMN when supported; otherwise gh-ost / pt-online-schema-change for zero-downtime.

---

## 5. SQL DML: INSERT, UPDATE, DELETE, UPSERT

### Core concept

DML mutates data. Production DML must be **idempotent**, **batched**, and **lock-aware**.

### INSERT patterns

```sql
-- Multi-row insert (always prefer over single-row in loops)
INSERT INTO order_items (order_id, product_id, qty, unit_price_cents)
VALUES
  (1001, 42, 2, 1999),
  (1001, 77, 1, 4500);

-- PostgreSQL: RETURNING for outbox / event ids
INSERT INTO outbox (aggregate_id, payload)
VALUES (1001, '{"type":"OrderCreated"}')
RETURNING id;
```

### UPSERT (idempotency)

```sql
-- PostgreSQL
INSERT INTO idempotency_keys (key, response_hash, created_at)
VALUES ('req-abc', 'hash...', now())
ON CONFLICT (key) DO NOTHING;

-- MySQL
INSERT INTO idempotency_keys (`key`, response_hash, created_at)
VALUES ('req-abc', 'hash...', NOW(6))
ON DUPLICATE KEY UPDATE `key` = `key`;  -- no-op
```

### UPDATE / DELETE safety

```sql
-- ALWAYS restrict updates — missing WHERE is a resume event
UPDATE accounts SET balance_cents = balance_cents - 1000
WHERE id = 42 AND balance_cents >= 1000;

-- Batch deletes to avoid long locks
DELETE FROM audit_log
WHERE created_at < now() - interval '90 days'
  AND id IN (
    SELECT id FROM audit_log
    WHERE created_at < now() - interval '90 days'
    LIMIT 10000
  );
```

### Production scenario: ORM save() in a loop

**Problem.** Import job inserts 100k rows one `INSERT` at a time. Pool exhausted; replication lag spikes.

**Solution.** JDBC batching, multi-row INSERT, or `COPY` / `LOAD DATA`. Chunk commits (e.g. 1k rows per tx) balance lock duration vs redo volume.

---

## 6. Joins: Inner, Outer, Cross, Self — Semantics That Matter

### Core concept

Joins combine relations. The **type** determines what happens to non-matching rows — the #1 source of silent data bugs in reporting.

| Join | Keeps | Typical use |
|---|---|---|
| `INNER JOIN` | Only matching rows both sides | Fact tables, enforced relationships |
| `LEFT [OUTER] JOIN` | All left + matching right (NULL if none) | Optional relationships; preserve driving table |
| `RIGHT [OUTER] JOIN` | All right + matching left | Rare; rewrite as LEFT for readability |
| `FULL [OUTER] JOIN` | All from both; NULLs where no match | Reconciliation, diff reports (PG yes; MySQL no native FULL) |
| `CROSS JOIN` | Cartesian product | Explicit small sets; accidental = disaster |
| `SELF JOIN` | Table joined to itself | Hierarchies, sequential rows, dedup |

### Internal working (planner view)

Nested loop: for each outer row, seek inner index — good for small outer + indexed inner.

Hash join: build hash table on one side — good for equi-joins at scale.

Merge join: both sides sorted on join key — good when inputs pre-sorted or index provides order.

**MySQL** optimizer sometimes prefers nested loops; **PostgreSQL** cost model may pick hash join at lower row estimates. Wrong row estimates → wrong join type → catastrophe.

### Examples

```sql
-- INNER: orders with at least one item
SELECT o.id, o.total_cents
FROM orders o
INNER JOIN order_items oi ON oi.order_id = o.id
WHERE o.created_at >= '2026-01-01';

-- LEFT: all customers, including those with zero orders
SELECT c.id, c.email, COUNT(o.id) AS order_count
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.email;

-- SELF: employees and their managers
SELECT e.id, e.name, m.name AS manager_name
FROM employees e
LEFT JOIN employees m ON m.id = e.manager_id;

-- Anti-join pattern (NOT EXISTS often beats LEFT WHERE NULL)
SELECT c.id
FROM customers c
WHERE NOT EXISTS (
  SELECT 1 FROM orders o WHERE o.customer_id = c.id
);
```

### Production scenario: INNER JOIN drops revenue

**Problem.** Finance report joins `orders INNER JOIN payments` — omits orders paid via legacy system without payment rows. Revenue under-reported by 8%.

**Solution.** `LEFT JOIN payments` + explicit `COALESCE(payment_status, 'legacy')` + data quality alerts on NULL payments for new orders.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Implicit comma join without WHERE | Cross product; DB melts |
| LEFT JOIN then filter on right table in WHERE | Accidentally INNER JOIN |
| Join on non-indexed columns | Nested loop + seq scan; hours |
| OR in join condition | Prevents index use; full scans |

---

## 7. Subqueries, CTEs, and Correlated Queries

### Core concept

Subqueries nest SELECT inside another statement. **Correlated** subqueries reference outer query rows — often O(n²) if optimizer cannot decorrelate.

### Forms

```sql
-- Scalar subquery
SELECT id, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
FROM orders o;

-- IN / EXISTS
SELECT id FROM products p
WHERE EXISTS (
  SELECT 1 FROM order_items oi WHERE oi.product_id = p.id AND oi.created_at > now() - interval '7 days'
);

-- CTE (PostgreSQL, MySQL 8+)
WITH recent_orders AS (
  SELECT * FROM orders WHERE created_at > now() - interval '30 days'
)
SELECT c.email, COUNT(*) 
FROM customers c
JOIN recent_orders ro ON ro.customer_id = c.id
GROUP BY c.email;
```

### PostgreSQL: CTE materialization

Before PG 12, CTEs were **optimization fences** (always materialized). PG 12+ allows inlining unless `AS MATERIALIZED`:

```sql
WITH big AS MATERIALIZED (
  SELECT ... heavy ...
)
SELECT ... FROM big ...;
```

Use `MATERIALIZED` when the CTE is referenced many times and caching helps; omit when it blocks predicate pushdown.

### Production scenario: correlated subquery in batch job

**Problem.** Nightly job:

```sql
UPDATE products p SET last_sold_at = (
  SELECT MAX(oi.created_at) FROM order_items oi WHERE oi.product_id = p.id
);
```

Runs 6 hours — one subquery per product.

**Solution.** Rewrite as join:

```sql
UPDATE products p
SET last_sold_at = s.max_created
FROM (
  SELECT product_id, MAX(created_at) AS max_created
  FROM order_items
  GROUP BY product_id
) s
WHERE p.id = s.product_id;
```

---

## 8. Aggregates, GROUP BY, HAVING, and DISTINCT Pitfalls

### Core concept

Aggregates collapse rows. `GROUP BY` must include all non-aggregated selected columns (SQL standard; MySQL ONLY_FULL_GROUP_BY mode enforces this).

```sql
SELECT customer_id, DATE_TRUNC('month', created_at) AS month, SUM(total_cents)
FROM orders
WHERE status = 'completed'
GROUP BY customer_id, DATE_TRUNC('month', created_at)
HAVING SUM(total_cents) > 100000;
```

### DISTINCT vs GROUP BY

`SELECT DISTINCT a, b` ≈ `GROUP BY a, b` without aggregates. DISTINCT hides duplicate-causing join bugs — prefer fixing join cardinality.

### Production scenario: average of averages

**Problem.** Dashboard computes `AVG(daily_avg_latency)` across shards — statistically wrong.

**Solution.** Aggregate raw samples: `SUM(total_latency)/SUM(request_count)` or use percentiles on raw data (see window functions).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Missing column in GROUP BY (MySQL legacy mode) | Nondeterministic results |
| COUNT(*) with LEFT JOIN | Inflated counts — use COUNT(DISTINCT o.id) or subquery |
| Filtering aggregates in WHERE instead of HAVING | Wrong results or syntax error |
| BIGINT overflow in SUM | Negative totals — use NUMERIC |

---

## 9. Window Functions: Ranking, Frames, and Production Patterns

### Core concept

Window functions compute over a **partition** without collapsing rows like GROUP BY.

```sql
SELECT
  id,
  customer_id,
  total_cents,
  ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn,
  SUM(total_cents) OVER (PARTITION BY customer_id ORDER BY created_at
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM orders;
```

### Common functions

| Function | Purpose |
|---|---|
| `ROW_NUMBER()` | Unique rank; ties get different numbers |
| `RANK()` / `DENSE_RANK()` | Ties same rank; gaps differ |
| `LAG()` / `LEAD()` | Previous/next row in partition |
| `NTILE(n)` | Bucket into n groups |
| `PERCENT_RANK()` | Relative standing |

### Production patterns

**Dedup latest row per key:**

```sql
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC) AS rn
  FROM sessions
) t WHERE rn = 1;
```

**Moving average (7-day):**

```sql
SELECT day, avg_daily,
  AVG(avg_daily) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS ma7
FROM daily_metrics;
```

**Top-N per group** (PostgreSQL: also `DISTINCT ON`):

```sql
SELECT DISTINCT ON (customer_id) customer_id, id, total_cents
FROM orders
ORDER BY customer_id, total_cents DESC;
```

### Production scenario: pagination with ROW_NUMBER

**Problem.** Offset pagination `LIMIT 20 OFFSET 100000` sorts 100k rows every page.

**Solution.** Keyset pagination:

```sql
SELECT id, created_at, amount
FROM payments
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

---

## 10. Indexes: B-tree, Composite, Covering, Partial

### Core concept

B-tree (default) supports equality and range on sortable types. Index entries are `(key_columns, heap_ctid/PK)` — engine uses index to locate rows.

### Index types (production)

| Type | When | Example |
|---|---|---|
| Single-column | High selectivity filters | `CREATE INDEX ON orders(customer_id)` |
| Composite | Multi-column WHERE + ORDER BY | `(status, created_at DESC)` |
| Covering / INCLUDE | Index-only scan avoids heap | PG: `INCLUDE (total_cents)`; MySQL: secondary index includes PK + needed cols |
| Partial | Subset of rows | `WHERE status = 'pending'` |
| Expression | Function in predicate | `(LOWER(email))` |

### Composite index column order

Leftmost prefix rule: index `(a, b, c)` serves `WHERE a=?`, `WHERE a=? AND b=?`, not `WHERE b=?` alone.

Put **equality columns first**, **range columns last**. Match `ORDER BY` direction when possible.

```sql
-- PostgreSQL partial index for hot queue
CREATE INDEX CONCURRENTLY idx_orders_pending_created
ON orders (created_at)
WHERE status = 'pending';

-- MySQL covering-ish: index all filter + select columns you need
CREATE INDEX idx_orders_customer_status_created
ON orders (customer_id, status, created_at);
```

### Production scenario: index on every column

**Problem.** Team adds indexes for every report filter. Writes slow 40%; autovacuum / purge can't keep up; disk doubles.

**Solution.** Index for **proven** slow queries; drop unused (`pg_stat_user_indexes`, MySQL `sys.schema_unused_indexes`). Prefer composite over index sprawl.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Index on low-cardinality column alone | Planner ignores; seq scan anyway |
| Wrong column order in composite | Index not used |
| Function on indexed column in WHERE | Index unusable unless expression index |
| Missing index on FK child column | Lock escalation on parent delete; slow joins |

---

## 11. EXPLAIN / ANALYZE & Reading Execution Plans

### Core concept

`EXPLAIN` shows planned operations. `EXPLAIN ANALYZE` executes and shows **actual** rows/times (PostgreSQL). MySQL `EXPLAIN ANALYZE` (8.0.18+) similar.

### PostgreSQL

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT o.id, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at > now() - interval '7 days';
```

Read bottom-up (or top-down depending on format):

| Node | Red flag |
|---|---|
| `Seq Scan` on large table | Missing index or bad selectivity estimate |
| `Nested Loop` with huge outer | Wrong join order |
| `Hash Join` spilling to disk | `work_mem` too low |
| `Sort` with large rows | Missing index for ORDER BY |
| `Rows Removed by Filter` high | Index not selective enough |
| `Buffers: read` high | Cold cache or too much data touched |

### MySQL

```sql
EXPLAIN FORMAT=TREE
SELECT o.id FROM orders o WHERE o.customer_id = 42 AND o.status = 'open';

EXPLAIN ANALYZE
SELECT o.id FROM orders o WHERE o.customer_id = 42;
```

Watch `type`: `ALL` = full scan (bad on big tables). `ref`/`range`/`const` better. `Extra`: `Using filesort`, `Using temporary` — investigate.

### Production scenario: estimated vs actual rows off by 1000×

**Problem.** Planner chooses nested loop; actual 2M rows; query times out.

**Diagnose.** Stale statistics. Correlated columns not captured. Skewed distribution (one status value = 99% rows).

**Fix.**

```sql
-- PostgreSQL
ANALYZE orders;
-- Extended statistics for correlated cols
CREATE STATISTICS orders_status_created (dependencies) ON status, created_at FROM orders;

-- MySQL
ANALYZE TABLE orders;
-- Consider histogram / index stats tuning
```

---

## 12. Query Optimization Playbook

### Ordered steps (do not skip)

1. **Capture exact SQL** — ORM query log, `pg_stat_statements`, MySQL Performance Schema / slow query log.
2. **EXPLAIN ANALYZE** on production-like data volume — not dev with 500 rows.
3. **Check row counts** — estimates vs actual at each node.
4. **Index for selective predicates** — composite matching WHERE + ORDER BY.
5. **Rewrite query** — eliminate SELECT *, subquery → join, EXISTS vs IN for NULL safety.
6. **Reduce round trips** — batch, CTE materialization when beneficial.
7. **Connection / lock check** — fast plan still waits on `Lock: transactionid`.
8. **Re-test under load** — plan cache, buffer cache warm, concurrent writes.

### Rewrite catalog

| Bad pattern | Better |
|---|---|
| `WHERE YEAR(created_at) = 2026` | Range on column: `created_at >= '2026-01-01' AND created_at < '2027-01-01'` |
| `OR` across columns | `UNION ALL` of two indexed queries |
| `NOT IN (subquery)` with NULLs | `NOT EXISTS` |
| `COUNT(*)` existence check | `EXISTS` |
| View stacked on view | Materialized view or explicit query |

### PostgreSQL knobs (use surgically)

```sql
SET LOCAL work_mem = '256MB';  -- session only, for big sort/hash
SET enable_seqscan = off;      -- NEVER globally; debugging only
```

### MySQL hints (last resort)

```sql
SELECT /*+ INDEX(orders idx_orders_customer_status) */ id FROM orders ...
```

Hints mask statistics problems — fix stats and schema first.

---

## 13. Transactions & ACID — What the Database Actually Guarantees

### ACID

| Property | Meaning | Production reality |
|---|---|---|
| Atomicity | All or nothing | Unchecked exceptions after partial JDBC batch may leave partial commits if autocommit |
| Consistency | Constraints hold | App must enforce cross-table invariants DB doesn't know |
| Isolation | Concurrent txs don't interfere | Level-dependent; never "full" unless SERIALIZABLE |
| Durability | Committed survives crash | Depends on `sync_commit`, binlog fsync, battery-backed cache |

### Transaction boundaries

```sql
BEGIN;
-- reads and writes
COMMIT;  -- or ROLLBACK;
```

**Rules:**

- Keep transactions **short**. Long txs hold MVCC versions (PG) or undo logs (InnoDB) — bloat, lag, locks.
- One business operation = one transaction unless saga/outbox pattern.
- Read-only analytics: `BEGIN READ ONLY` (PG) or replica + consistent snapshot.

### Production scenario: long transaction blocks vacuum

**Problem.** Admin opens transaction in psql, goes to lunch. PostgreSQL cannot freeze tuples; autovacuum pressure; queries slow globally.

**Fix.** Monitor `pg_stat_activity.xact_start`, `state`. Set `idle_in_transaction_session_timeout`. Kill offenders. Educate: never leave interactive tx open.

---

## 14. Isolation Levels: READ UNCOMMITTED Through SERIALIZABLE

### ANSI levels

| Level | Dirty read | Non-repeatable read | Phantom read |
|---|---|---|---|
| READ UNCOMMITTED | Possible* | Possible | Possible |
| READ COMMITTED | No | Possible | Possible |
| REPEATABLE READ | No | No | Possible† |
| SERIALIZABLE | No | No | No |

\* PostgreSQL treats READ UNCOMMITTED as READ COMMITTED.

† PostgreSQL RR prevents phantoms for standard SQL; MySQL InnoDB RR + MVCC snapshot also prevents phantoms for normal DML in practice.

### Defaults

| Engine | Default | Notes |
|---|---|---|
| PostgreSQL | READ COMMITTED | Each statement new snapshot |
| MySQL InnoDB | REPEATABLE READ | Consistent read snapshot for tx duration |

### PostgreSQL phenomena

**READ COMMITTED:** statement sees committed rows as of statement start. Two UPDATEs in one tx can see different snapshots — **non-repeatable read** within tx if you SELECT twice.

**REPEATABLE READ:** snapshot at tx start. Writers may get **serialization failure** (`40001`) on conflict — retry required.

**SERIALIZABLE:** SSI — detects rw-dependencies; more aborts, strongest guarantee.

### MySQL InnoDB

**READ COMMITTED:** similar to PG RC — less gap locking, more phantoms possible in theory.

**REPEATABLE READ:** consistent reads use undo log snapshot; **next-key locks** on current reads prevent phantoms for locking reads.

### Production scenario: lost update

**Problem.**

```sql
-- Tx1 and Tx2 both read balance 1000
UPDATE accounts SET balance = 1000 - 100 WHERE id = 1;  -- both write 900
```

**Fix.** Optimistic: `UPDATE ... SET balance = balance - 100 WHERE id = 1 AND balance >= 100` (check affected rows). Pessimistic: `SELECT ... FOR UPDATE`.

---

## 15. MVCC: PostgreSQL vs MySQL InnoDB

### Core concept

Multi-Version Concurrency Control: readers don't block writers; writers don't block readers (usually). Old row versions kept until vacuum/purge.

### PostgreSQL MVCC

- Each row has `xmin`, `xmax` transaction IDs.
- UPDATE = insert new row version + mark old dead.
- `VACUUM` reclaims dead tuples; **bloat** if vacuum can't keep up.
- No undo log for consistent read — old versions live in heap until vacuumed.
- Transaction ID wraparound requires aggressive vacuum — monitor `age(datfrozenxid)`.

### MySQL InnoDB MVCC

- Clustered index holds current row; undo log chain holds history.
- Read view for RR snapshot traverses undo chain.
- Purge thread removes old undo asynchronously.
- Secondary index reads may need **rollback** if index entry stale (rare edge cases during purge).

### Comparison table

| Aspect | PostgreSQL | InnoDB |
|---|---|---|
| Version storage | Heap tuples | Undo log |
| Bloat mechanism | Dead tuples in table/index | Undo length / history list length |
| Cleanup | autovacuum | purge thread |
| Hot update same row | Creates new tuple; index updates all indexes | In-place if indexed cols unchanged; else delete+insert |
| Long tx impact | Blocks vacuum; xmin horizon | Extends undo; slows purge |

### Production scenario: table bloat after bulk UPDATE

**Problem.** PostgreSQL `orders` 200GB after migration UPDATE; indexes 2× size; sequential scans slower.

**Fix.** `VACUUM (ANALYZE)` won't shrink file — need `VACUUM FULL` (locks) or `pg_repack`. Prevent: batch updates, fillfactor, avoid updating indexed columns unnecessarily.

---

## 16. Locking: Row, Table, Gap, Next-Key

### Lock types

| Lock | Scope | Typical cause |
|---|---|---|
| Row lock | Single row | `SELECT FOR UPDATE`, conflicting UPDATE |
| Table lock | Whole table | DDL, `LOCK TABLE`, unindexed FK checks (MySQL legacy) |
| Gap lock (InnoDB) | Index gap between keys | RR + locking read prevents phantom insert |
| Next-key lock (InnoDB) | Gap + right-side record | Default for RR current reads |
| Predicate lock (PG SSI) | Serializable conflicts | rw-conflict detection |

### PostgreSQL lock modes (relation)

`AccessShare` (SELECT) → `RowExclusive` (INSERT/UPDATE) → `ShareRowExclusive` → `Exclusive` → `AccessExclusive` (DDL — blocks all).

### InnoDB

Row locks via index — if no index, may lock **all rows** (gap locks entire table effect).

```sql
-- PostgreSQL: inspect locks
SELECT locktype, relation::regclass, mode, granted, pid
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE NOT granted;

-- MySQL
SELECT * FROM performance_schema.data_locks;
SELECT * FROM sys.innodb_lock_waits;
```

### Production scenario: lock wait timeout on batch

**Problem.** Batch job `SELECT * FROM orders WHERE status='pending' FOR UPDATE SKIP LOCKED` — still timeouts.

**Diagnose.** MySQL: `innodb_lock_wait_timeout` (default 50s). Another tx holds rows without commit. DDL migration holds metadata lock.

**Fix.** Smaller batches; `SKIP LOCKED` (PG 9.5+, MySQL 8+) for worker queues; schedule away from migrations; index `status` so scan doesn't touch entire table.

---

## 17. Deadlocks: Detection, Prevention, Recovery

### Core concept

Cycle of waits: Tx1 locks A waits B; Tx2 locks B waits A. Engine detects and **aborts one victim**.

### PostgreSQL

```text
ERROR: deadlock detected
DETAIL: Process 12345 waits for ShareLock on transaction 67890; blocked by process 54321...
```

Check `pg_stat_database.deadlocks`. Log `deadlock_timeout` (default 1s) before detection.

### MySQL

```text
ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction
```

`SHOW ENGINE INNODB STATUS\G` — LATEST DETECTED DEADLOCK section.

### Prevention patterns

1. **Consistent lock order** — always lock `(customer_id, order_id)` in ascending id order.
2. **Smaller transactions** — less overlap.
3. **Index access paths** — same rows locked in same order.
4. **Avoid user interaction inside tx** — HTTP call holding FOR UPDATE.
5. **Retry on 40001 / 1213** — exponential backoff with jitter.

### Production scenario: deadlock only under load

**Problem.** Transfer between accounts deadlocks 0.1% of requests.

**Cause.** Two concurrent transfers A→B and B→A lock rows in opposite order.

**Fix.**

```sql
-- Always lock lower id first in application
SELECT id FROM accounts WHERE id IN (?, ?) ORDER BY id FOR UPDATE;
```

---

## 18. Connection Pooling Math: max_connections vs App Pods

### Core concept

Each app instance holds a pool of open connections. Total connections = **pods × pool size** (+ admin + replicas + batch workers + migration tools).

### Formula

```
required_connections =
  (app_pods × pool_max) +
  (worker_pods × pool_max) +
  admin_reserve +
  replication_slots +
  headroom (10-20%)

pool_max per pod ≤ floor((max_connections - overhead) / app_pods)
```

### Example

- PostgreSQL `max_connections = 200`
- Reserve 30 for admin/replication/monitoring
- 170 for apps; 10 pods → **17 max per pod** (not 50)

If Hikari `maximumPoolSize=50` × 10 pods = 500 → **connection storms**, `FATAL: too many connections`, thundering herd on restart.

### Pool sizing heuristics

| Guideline | Rationale |
|---|---|
| Pool size ≈ `(cores × 2) + effective_spindle_count` (legacy rule) | Too small → wait; too large → CPU context switch, lock contention |
| For SSD/NVMe OLTP: often **10–30 per instance** sufficient | Measure wait time in pool metrics |
| Separate pools for batch vs OLTP | Long reports don't starve checkout |
| Use pgBouncer **transaction pooling** for many short transactions | Cuts server process count; breaks session features (prepared stmts, temp tables) |

### Production scenario: pod autoscale exhausts DB

**Problem.** HPA scales 5 → 50 pods during flash sale. DB rejects connections; checkout 503.

**Fix.** Cap HPA; pgBouncer in front; reduce pool size as pod count rises (dynamic config hard — prefer fixed max pods + queue at app). Queue requests in app vs opening unlimited connections.

### MySQL

`max_connections` similar. Also watch `thread_cache_size`, `innodb_thread_concurrency` (usually don't tune). Connection errors in `Aborted_connects`.

---

## 19. Read Replicas & Replication Lag

### Core concept

Primary accepts writes; replicas replay WAL (PG streaming replication) or binlog (MySQL async/semi-sync). **Lag** = time or bytes behind primary.

### PostgreSQL

- Physical replication: byte-identical cluster copies.
- Monitor: `pg_stat_replication.replay_lag`, `write_lag`, `flush_lag`.
- Hot standby accepts reads; queries see data as of replay position.

### MySQL

- Async default: commit on primary doesn't wait for replica ack.
- Semi-sync: waits for at least one replica ack — lower data loss risk, higher commit latency.
- GTID simplifies failover; still doesn't eliminate lag.

### Reading from replicas — rules

| Workload | Safe on replica? |
|---|---|
| Idempotent read (product catalog) | Yes with lag tolerance |
| User session / auth | Risky — stale session state |
| Read-your-writes after registration | **No** unless routing or sync |
| Financial balance | **No** without strong consistency path |
| Analytics | Yes — label dashboards "delayed" |

### Lag causes

- Large transactions (single COPY, bulk UPDATE).
- Missing index on replica replay (same as primary — replay applies WAL).
- Long queries on replica block replay (PG hot standby conflict: `max_standby_streaming_delay`).
- Network bandwidth.
- Parallel workers saturated on primary generating WAL faster than replay.

### Production scenario: user sees paid order as pending

**Problem.** Payment webhook writes primary; mobile app reads replica; UI polls replica — 30s lag during peak.

**Fix.** Route user-specific reads to primary after write (sticky session / "read-your-writes" flag for 5s). Or synchronous replica for critical read (PG synchronous_commit + quorum). Display "processing" state.

### PostgreSQL hot standby conflict

```sql
-- On replica, cancel long report or tune primary
-- primary: hot_standby_feedback = on (tradeoff: vacuum bloat)
-- replica: max_standby_streaming_delay
```

---

## 20. Partitioning & Sharding Basics

### Partitioning (single DB, split tables)

**Range** (time-series), **list** (region), **hash** (even spread).

```sql
-- PostgreSQL declarative partitioning
CREATE TABLE measurements (
  id BIGSERIAL,
  sensor_id INT NOT NULL,
  measured_at TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION
) PARTITION BY RANGE (measured_at);

CREATE TABLE measurements_2026_08 PARTITION OF measurements
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

**Benefits:** partition pruning, drop old data instantly, smaller indexes per partition.

**Costs:** global unique constraints harder (need partition key in PK); query must filter on partition key; DDL on parent propagates.

### MySQL partitioning

```sql
CREATE TABLE measurements (
  id BIGINT AUTO_INCREMENT,
  measured_at DATETIME NOT NULL,
  value DOUBLE,
  PRIMARY KEY (id, measured_at)
) PARTITION BY RANGE (TO_DAYS(measured_at)) (...);
```

PK must include partition key. Fewer features than PG for partitioning but workable for time-series.

### Sharding (multiple DBs)

Split data by **shard key** (`tenant_id`, `user_id % N`). Application or proxy (Vitess, Citus, pg_shard) routes queries.

| Concern | Impact |
|---|---|
| Cross-shard joins | Avoid; denormalize or query aggregator |
| Transactions | No global ACID without 2PC — use sagas |
| Rebalancing | Operational pain |
| Auto-increment IDs | Use global ID scheme (Snowflake, UUID) |

### When to partition vs shard

| Signal | Action |
|---|---|
| Table > few hundred GB; maintenance windows painful | Partition |
| Single writer CPU/IO maxed; vertical scale exhausted | Shard |
| Queries always scoped by tenant | Shard by tenant or partition by tenant |

---

## 21. Stored Procedures: When / When Not

### When stored procedures help

- **Stable, performance-critical** logic close to data (complex batch in one round trip).
- **Security boundary** — grant EXECUTE not table access.
- **Legacy enterprise** DB-centric apps.
- **Atomic multi-step** rules already owned by DBA team.

### When to avoid

- **Application business logic** in procedures — version control, testing, deployment coupling.
- **Microservices** — each service can't share procedure deployment lifecycle easily.
- **ORM-heavy** teams — impedance mismatch.
- **Cloud-managed DB** portability requirements.

### PostgreSQL (plpgsql)

```sql
CREATE OR REPLACE FUNCTION transfer_funds(from_id BIGINT, to_id BIGINT, amount BIGINT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts SET balance_cents = balance_cents - amount
  WHERE id = from_id AND balance_cents >= amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient funds'; END IF;
  UPDATE accounts SET balance_cents = balance_cents + amount WHERE id = to_id;
END;
$$;
```

### MySQL

```sql
CREATE PROCEDURE transfer_funds(IN from_id BIGINT, IN to_id BIGINT, IN amount BIGINT)
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN ROLLBACK; RESIGNAL; END;
  START TRANSACTION;
  UPDATE accounts SET balance_cents = balance_cents - amount
  WHERE id = from_id AND balance_cents >= amount;
  IF ROW_COUNT() = 0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'insufficient funds'; END IF;
  UPDATE accounts SET balance_cents = balance_cents + amount WHERE id = to_id;
  COMMIT;
END;
```

### Production note

Flyway/Liquibase can deploy procedures — but **rolling deploy** with two app versions requires backward-compatible procedure changes (expand-contract).

---

## 22. Flyway / Liquibase Migration Safety

### Core concept

Schema migrations are production code. A bad migration is a **P0 outage** — metadata locks, table rewrites, data loss.

### Flyway conventions

- Versioned: `V1__create_orders.sql`, `V2__add_index.sql`
- Repeatable: `R__views.sql`
- **Never edit applied migrations** — add new version instead.
- Baseline existing DB: `flyway baseline`.

### Liquibase

- Changelog XML/YAML/SQL with changesets and rollback blocks.
- `preConditions` prevent double apply.
- Rollbacks often untested — treat as best-effort.

### Safety rules

| Rule | Why |
|---|---|
| Backward-compatible expand first | Old app still runs during deploy |
| Separate DDL from DML backfill | Long DML in migration blocks deploy pipeline |
| Online index creation | PG `CONCURRENTLY`; MySQL online DDL or gh-ost |
| Lock timeout | `SET lock_timeout = '5s'` (PG) — fail fast vs hang deploy |
| Test on prod-sized clone | Time the migration |
| One destructive change per release | Drop column release after code stops reading |

### Expand-contract example

```sql
-- V10: add nullable column (safe)
ALTER TABLE orders ADD COLUMN discount_cents BIGINT;

-- App V2 writes discount_cents

-- V11: backfill (batched job, not blocking migration)
-- UPDATE orders SET discount_cents = 0 WHERE discount_cents IS NULL;

-- V12: NOT NULL + default after backfill
ALTER TABLE orders ALTER COLUMN discount_cents SET NOT NULL;

-- V13: drop old column after app V3 removed usage
-- ALTER TABLE orders DROP COLUMN legacy_discount;
```

### Production scenario: Flyway migration locks orders table

**Problem.** `V47__add_fk.sql` adds FK with full table validation during peak.

**Fix.** `NOT VALID` + `VALIDATE CONSTRAINT` off-peak. Use gh-ost for MySQL column changes. Run heavy migrations in maintenance window with feature flag freeze.

---

## 23. Production Scenarios: Slow Query, Missing Index, Lock Wait, Replica Lag

### Scenario A: Slow query — dashboard timeout

**Observe.** `/api/revenue` P99 45s; CPU normal; disk read saturated.

**Diagnose.**

```sql
-- PostgreSQL: find query
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE query ILIKE '%orders%'
ORDER BY total_exec_time DESC LIMIT 10;
```

EXPLAIN ANALYZE shows seq scan on `orders` filtering `created_at` range.

**Fix.** Index `(created_at)` or `(status, created_at)` matching WHERE. Consider summary table for dashboard.

---

### Scenario B: Missing index on FK

**Observe.** Parent `DELETE FROM customers WHERE id=?` takes 30s; blocks other deletes.

**Diagnose.** Child `orders.customer_id` has no index — InnoDB scans all order rows to check FK; PostgreSQL similar for FK checks on delete.

**Fix.** `CREATE INDEX CONCURRENTLY idx_orders_customer_id ON orders(customer_id);`

---

### Scenario C: Lock wait timeout

**Observe.** Checkout fails `Lock wait timeout exceeded`; MySQL `sys.innodb_lock_waits` shows blocker migration.

**Diagnose.** `ALTER TABLE` metadata lock chain: migration waiting on long SELECT; app waiting on metadata lock.

**Fix.** Kill long-running SELECT on replica/primary; use online schema change tool; set `lock_wait_timeout` lower in session for app queries to fail fast vs hang.

---

### Scenario D: Replica lag during ETL

**Observe.** Replica lag alert 600s; nightly ETL COPY 50GB on primary.

**Diagnose.** WAL generation spike; replica IO can't keep up; long query on replica conflicts.

**Fix.** Move ETL to primary off-peak with throttling; logical replication slot monitoring; increase replica IO; pause non-critical replica queries during ETL.

---

### Scenario E: Connection pool exhaustion masquerading as slow DB

**Observe.** Timeouts everywhere; DB CPU 20%; Hikari "Connection is not available, request timed out after 30000ms".

**Diagnose.** Pool too small vs threads; leak (connections not returned); pods scaled up.

**Fix.** Fix leak (`try-with-resources`); right-size pool; pgBouncer; limit Tomcat/async threads ≤ total connections budget.

---

## 24. Production Debugging Playbook

When a database incident is "random," it is usually **locks**, **plan regression**, **pool math**, or **lag**.

1. **Classify the symptom.** Timeout vs error vs wrong data vs slowness. Wrong data on replica → lag/consistency. Timeout → lock or pool. Slowness → plan/IO.

2. **Check connection layer first.** Pool active/idle/waiting threads. `max_connections` headroom. pgBouncer queue depth.

3. **Identify blocking session (MySQL).**

   ```sql
   SELECT * FROM sys.innodb_lock_waits;
   SELECT * FROM performance_schema.data_locks;
   SHOW PROCESSLIST;
   ```

4. **Identify blocking session (PostgreSQL).**

   ```sql
   SELECT pid, wait_event_type, wait_event, state, query, xact_start
   FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY xact_start NULLS LAST;

   SELECT * FROM pg_locks WHERE NOT granted;
   ```

5. **Capture slow query plan.** `EXPLAIN (ANALYZE, BUFFERS)`. Compare to yesterday's plan — did stats change? new index missing? parameter sniffing?

6. **Check replication.**

   ```sql
   -- PostgreSQL
   SELECT application_name, state, sync_state, write_lag, flush_lag, replay_lag
   FROM pg_stat_replication;

   -- MySQL
   SHOW REPLICA STATUS\G  -- Seconds_Behind_Source (approximate)
   ```

7. **Check bloat / vacuum / history.**

   ```sql
   -- PostgreSQL
   SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;

   -- MySQL
   SELECT COUNT FROM information_schema.innodb_metrics WHERE name='trx_rseg_history_len';
   ```

8. **Check disk and cache hit ratio.**

   ```sql
   -- PostgreSQL buffer hit
   SELECT sum(heap_blks_hit) / nullif(sum(heap_blks_hit + heap_blks_read), 0) AS hit_ratio
   FROM pg_statio_user_tables;
   ```

9. **Rollback mitigation.** Kill query (`pg_cancel_backend` / `pg_terminate_backend`; MySQL `KILL QUERY`). Fail over read traffic to primary if replica bad. Scale down pods if connection storm.

10. **Post-incident.** Add alert on lag, pool wait, deadlocks, long transactions, seq scans on large tables. Add migration review checklist.

---

## 25. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Filter + sort on same columns | Composite index matching order |
| Partial table hot set (`status='pending'`) | Partial index (PG) or composite leading with status |
| Money calculations | BIGINT cents or DECIMAL — never FLOAT |
| Idempotent API writes | UNIQUE key + ON CONFLICT / ON DUPLICATE KEY |
| Read-heavy, write-rare catalog | Cache + replica OK with TTL |
| Read-after-write UX | Primary routing or sync replica for session |
| Table > 100GB time-series | Range partition by time |
| Cross-tenant analytics | CQRS projection / warehouse — not OLTP scans |
| Schema change on large table | Online migration tool; expand-contract |
| Long-running report | Replica + snapshot isolation; avoid primary |
| Queue workers competing for rows | `FOR UPDATE SKIP LOCKED` |
| Deadlocks under load | Lock ordering + retry with jitter |
| Too many connections | pgBouncer + reduce pool × pods |
| ORM N+1 | JOIN fetch, batch size, or explicit query |
| Full outer diff | PostgreSQL FULL JOIN; MySQL UNION LEFT+RIGHT |
| Global uniqueness across shards | App-generated UUID / Snowflake — not AUTO_INCREMENT |

---

## 26. Scenario-Based Questions

### 1. Report returns fewer rows after "optimization" to INNER JOIN?

**Root cause.** INNER JOIN removed parent rows without child matches. LEFT JOIN was correct for optional relationship.

**Fix.** Restore LEFT JOIN or move filter to join condition vs WHERE. Document cardinality expectations in query comments.

---

### 2. PostgreSQL disk growing 10GB/day but row count stable?

**Root cause.** Dead tuples from UPDATE-heavy workload; autovacuum not keeping up; long transactions block vacuum horizon.

**Fix.** Tune autovacuum per table; kill long idle-in-transaction sessions; reduce UPDATE width; `VACUUM (ANALYZE)`; pg_repack if bloated.

---

### 3. MySQL primary key UUID — insert rate collapsed?

**Root cause.** Random UUID v4 as InnoDB clustered PK causes random page inserts and splits.

**Fix.** Use monotonic UUID v7 / ULID / BIGINT sequence; or UUID as secondary unique column.

---

### 4. `SELECT COUNT(*)` on 500M-row table kills production?

**Root cause.** Full index or heap scan; MVCC must visit visible rows (PG) or index traverse (InnoDB).

**Fix.** Approximate count (`pg_class.reltuples`, `EXPLAIN` estimate); maintain counter table; partition pruning for scoped counts.

---

### 5. Serializable transaction aborted with 40001 — users see random failures?

**Root cause.** PostgreSQL SSI detected rw-conflict; high contention on hot rows.

**Fix.** Retry logic; reduce tx scope; downgrade to RR/RC with explicit locking where needed; partition hot row.

---

### 6. Gap locks blocking inserts — InnoDB RR?

**Root cause.** Locking read `SELECT ... FOR UPDATE` on range locks gaps; concurrent inserts into gap wait.

**Fix.** Use RC for queue pattern if acceptable; index precise keys; `SKIP LOCKED`; shrink predicate range.

---

### 7. Flyway V2 edited after production deploy — dev broken?

**Root cause.** Checksum mismatch; Flyway refuses to migrate.

**Fix.** Never edit applied migrations; add V3 with fix. Use `flyway repair` only if you know exactly what you're doing.

---

### 8. App works in dev (100 rows), prod query timeout (100M rows)?

**Root cause.** Missing index; nested loop chosen due to bad stats; dev never representative.

**Fix.** EXPLAIN ANALYZE on staging clone; add index; update statistics; rewrite query.

---

### 9. Duplicate orders from double-click — only one should exist?

**Root cause.** No idempotency key unique constraint; two POSTs same payload.

**Fix.** `UNIQUE(idempotency_key)` + UPSERT returning same response hash.

---

### 10. Replica CPU high but primary fine?

**Root cause.** Analytics on replica; missing index same as primary; parallel replay workers; or many small commits replay overhead.

**Fix.** Index replica same as primary; throttle heavy queries; dedicated analytics replica.

---

### 11. `DELETE` faster than `TRUNCATE` team expected — opposite?

**Root cause.** TRUNCATE is fast but takes AccessExclusive lock (PG) / DDL lock; blocked by long tx. DELETE row-by-row slow but row locks only.

**Fix.** Drop/truncate partition instead; ensure no blocking idle tx before TRUNCATE.

---

### 12. Connection count 800 but only 20 app instances?

**Root cause.** Pool misconfigured 40 each; connection leak; pgbouncer not used; health checks opening new connections.

**Fix.** Audit `pg_stat_activity.application_name`; fix leak; deploy pgBouncer; set Hikari max sensibly.

---

### 13. Window function duplicate rows in report?

**Root cause.** Join before window multiplied rows; partition key wrong.

**Fix.** Subquery dedup first; apply window on deduped set; verify PARTITION BY keys.

---

### 14. Partial index not used by planner?

**Root cause.** Query predicate doesn't match index WHERE clause exactly; parameter type mismatch; stale stats.

**Fix.** Align predicate; cast consistently; ANALYZE; check `enable_indexscan`.

---

### 15. Sharded by user_id — cross-user report impossible?

**Root cause.** No single query path across shards.

**Fix.** Fan-out query aggregator service; or replicate to warehouse (BigQuery/Snowflake) for cross-shard analytics.

---

### 16. Liquibase rollback failed mid-deploy?

**Root cause.** Rollback script untested; data-dependent; DDL irreversible (DROP COLUMN).

**Fix.** Forward-fix migration; restore from backup if needed; treat rollbacks as emergency only — prefer expand-contract.

---

### 17. `OR` condition prevents index use?

**Root cause.** Optimizer can't merge single index scan efficiently.

**Fix.** Rewrite as `UNION ALL` of two indexed queries:

```sql
SELECT id FROM orders WHERE customer_id = 1 AND status = 'open'
UNION ALL
SELECT id FROM orders WHERE customer_id = 1 AND priority = 'urgent';
```

---

### 18. Hot row updated 1000/sec — throughput ceiling?

**Root cause.** Row-level serialization; single lock on counter/status row.

**Fix.** Shard counter (split buckets); append-only event log + async aggregate; partition by bucket id.

---

### 19. JSONB query slow without index?

**Root cause.** `payload->>'status' = 'active'` seq scans entire table.

**Fix.**

```sql
CREATE INDEX idx_events_status ON events ((payload->>'status'));
-- or JSONB GIN index for containment
CREATE INDEX idx_events_payload ON events USING GIN (payload jsonb_path_ops);
```

---

### 20. MySQL ONLY_FULL_GROUP_BY breaks legacy report?

**Root cause.** SELECT lists non-aggregated columns not in GROUP BY — previously allowed loose mode.

**Fix.** Fix query properly; don't disable ONLY_FULL_GROUP_BY globally — fix each report with correct GROUP BY or aggregate.

---

### 21. Prepared statement plan wrong after data distribution shift?

**Root cause.** Generic plan cached for parameter values that no longer match statistics (PG `plan_cache_mode`, MySQL plan cache). One popular `status='pending'` went from 1% to 40% of rows.

**Fix.** `ANALYZE` after bulk load; PostgreSQL `SET plan_cache_mode = force_custom_plan` for problematic stmt (session); rewrite query to avoid param on skewed column alone; partial index for hot value.

---

### 22. Citus / Vitess migration — global sequences exhausted?

**Root cause.** Sharded DB can't use single `SERIAL` — duplicate ids across shards.

**Fix.** Snowflake/UUID keys; or per-shard sequence ranges allocated by coordinator; never rely on auto-increment alone cross-shard.

---

## Appendix A: Set Operations & NULL Semantics

### UNION / INTERSECT / EXCEPT

```sql
-- Active users who ordered in both periods (INTERSECT — PG; MySQL 8.0.31+)
SELECT user_id FROM orders WHERE created_at >= '2026-01-01'
INTERSECT
SELECT user_id FROM orders WHERE created_at >= '2025-01-01';

-- MySQL alternative before INTERSECT support
SELECT DISTINCT a.user_id
FROM orders a
INNER JOIN orders b ON a.user_id = b.user_id
WHERE a.created_at >= '2026-01-01' AND b.created_at >= '2025-01-01';

-- EXCEPT: users in cohort A not in cohort B
SELECT user_id FROM trial_users
EXCEPT
SELECT user_id FROM paid_users;
```

`UNION` deduplicates; `UNION ALL` preserves duplicates and is cheaper — prefer ALL when duplicates impossible or acceptable.

### NULL three-valued logic

| Expression | Result |
|---|---|
| `NULL = NULL` | UNKNOWN (not TRUE) |
| `NULL IS NULL` | TRUE |
| `WHERE col = NULL` | Never matches — use `IS NULL` |
| `COUNT(*)` | Counts all rows including NULLs |
| `COUNT(col)` | Counts non-NULL values only |
| `AVG(col)` | Ignores NULLs — can bias averages |

Production bug pattern: `WHERE optional_fk = NULL` returns zero rows silently. Code review rule: ban `= NULL` in SQL linters.

---

## Appendix B: Monitoring Queries (Copy-Paste Starters)

### PostgreSQL

```sql
-- Top statements by total time
SELECT queryid, left(query, 120), calls,
       round(total_exec_time::numeric, 2) AS total_ms,
       round(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 20;

-- Tables needing vacuum
SELECT schemaname, relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC LIMIT 20;

-- Long running queries
SELECT pid, now() - xact_start AS xact_age, state, wait_event_type, wait_event,
       left(query, 200) AS query
FROM pg_stat_activity
WHERE state != 'idle' AND pid != pg_backend_pid()
ORDER BY xact_start NULLS LAST;
```

### MySQL InnoDB

```sql
-- Slow digest (Performance Schema enabled)
SELECT DIGEST_TEXT, COUNT_STAR, ROUND(AVG_TIMER_WAIT/1e12, 3) AS avg_sec,
       ROUND(SUM_TIMER_WAIT/1e12, 3) AS total_sec
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC LIMIT 20;

-- InnoDB status snapshot
SHOW ENGINE INNODB STATUS\G

-- Lock waits
SELECT * FROM sys.innodb_lock_waits;
```

Enable `pg_stat_statements` (PG) and Performance Schema (MySQL) in every non-trivial production environment — without them you are guessing.

---

## Appendix C: Isolation Level Cheat Sheet (Engine Behavior)

| Scenario | PostgreSQL RC | PostgreSQL RR | InnoDB RC | InnoDB RR |
|---|---|---|---|---|
| Default | Yes | Optional | Optional | Yes (default) |
| Statement vs tx snapshot | Per statement | Per transaction | Per statement | Per transaction |
| Non-repeatable read in one tx | Yes | No | Yes | No |
| Serialization failures | Rare | Possible (`40001`) | Rare | Deadlock/lock wait more common |
| Gap locks on SELECT | No (MVCC read) | No for plain SELECT | Less | Yes for locking reads |
| Best for OLTP checkout | Default RC + explicit row locks | When need stable reads in tx | Often chosen to reduce gap locks | Default; understand next-key |

Choose isolation explicitly in connection pool init — do not assume driver default matches DBA expectation across environments.

---

*The database will not save you from missing indexes, long transactions, or reading your own writes from a lagging replica. SQL semantics tell you what should be true; the execution plan tells you what will actually happen; MVCC and locks tell you what others will see while you do it. Measure on production volume, keep migrations boring, and size connection pools with arithmetic — not defaults.*
