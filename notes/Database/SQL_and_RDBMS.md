# SQL & RDBMS Mastery — Senior Production Reference

PostgreSQL 15+ / MySQL 8.x (InnoDB). This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping relational backends — slow queries that only appear at scale, lock wait timeouts during batch jobs, replica lag that makes dashboards lie, migrations that lock tables for minutes, and connection pool math that quietly exhausts `max_connections` at 2 AM.

---

## Table of Contents

1. [Mental Model: One Query Through the Engine](#1-mental-model-one-query-through-the-engine)
2. [Relational Model & Integrity Constraints](#2-relational-model-integrity-constraints)
3. [Normalization (1NF–3NF) & When to Denormalize](#3-normalization-1nf3nf-when-to-denormalize)
4. [SQL DDL: Schemas, Types, Constraints, Migrations](#4-sql-ddl-schemas-types-constraints-migrations)
5. [SQL DML: INSERT, UPDATE, DELETE, UPSERT](#5-sql-dml-insert-update-delete-upsert)
6. [Bulk Data Loading: COPY, LOAD DATA, JDBC Batch, Upsert at Scale](#6-bulk-data-loading-copy-load-data-jdbc-batch-upsert-at-scale)
7. [Joins: Inner, Outer, Cross, Self — Semantics That Matter](#7-joins-inner-outer-cross-self-semantics-that-matter)
8. [Subqueries, CTEs, and Correlated Queries](#8-subqueries-ctes-and-correlated-queries)
9. [Aggregates, GROUP BY, HAVING, and DISTINCT Pitfalls](#9-aggregates-group-by-having-and-distinct-pitfalls)
10. [Window Functions: Ranking, Frames, and Production Patterns](#10-window-functions-ranking-frames-and-production-patterns)
11. [Indexes: B-tree, Composite, Covering, Partial](#11-indexes-b-tree-composite-covering-partial)
12. [Index Internals: B+Tree Layout, Clustering, and Physical Cost](#12-index-internals-btree-layout-clustering-and-physical-cost)
13. [EXPLAIN / ANALYZE & Reading Execution Plans](#13-explain-analyze-reading-execution-plans)
14. [Query Optimization Playbook](#14-query-optimization-playbook)
15. [Transactions & ACID — What the Database Actually Guarantees](#15-transactions-acid-what-the-database-actually-guarantees)
16. [Isolation Levels: READ UNCOMMITTED Through SERIALIZABLE](#16-isolation-levels-read-uncommitted-through-serializable)
17. [MVCC: PostgreSQL vs MySQL InnoDB](#17-mvcc-postgresql-vs-mysql-innodb)
18. [Locking: Row, Table, Gap, Next-Key](#18-locking-row-table-gap-next-key)
19. [Deadlocks: Detection, Prevention, Recovery](#19-deadlocks-detection-prevention-recovery)
20. [Connection Pooling Math: max_connections vs App Pods](#20-connection-pooling-math-max_connections-vs-app-pods)
21. [Read Replicas & Replication Lag](#21-read-replicas-replication-lag)
22. [Partitioning & Sharding Basics](#22-partitioning-sharding-basics)
23. [Stored Procedures: When / When Not](#23-stored-procedures-when-when-not)
24. [Flyway / Liquibase Migration Safety](#24-flyway-liquibase-migration-safety)
25. [Production Scenarios: Slow Query, Missing Index, Lock Wait, Replica Lag](#25-production-scenarios-slow-query-missing-index-lock-wait-replica-lag)
26. [Production Debugging Playbook](#26-production-debugging-playbook)
27. [Quick Decision Matrix](#27-quick-decision-matrix)

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

## 6. Bulk Data Loading: COPY, LOAD DATA, JDBC Batch, Upsert at Scale

### Core concept

Loading 50 million rows is not "the same INSERT, more times." Per-row cost is dominated by things that have nothing to do with writing the row: a network round trip, statement parse + plan, a WAL/redo record, index maintenance on every index, constraint checks, and a commit fsync. Bulk loading is the discipline of **amortizing or deleting each of those costs**.

The cost stack for one naive `INSERT` executed in autocommit:

```
INSERT INTO events (...) VALUES (...);
  ├─ network RTT              ~0.2–1.0 ms  (same AZ; 10ms cross-region)
  ├─ parse + plan             ~0.05 ms     (unless prepared/cached)
  ├─ heap/clustered write     ~0.01 ms     (buffer pool, cheap)
  ├─ index maintenance        ~0.02 ms × number_of_indexes
  ├─ WAL / redo record        ~0.01 ms
  └─ COMMIT fsync             ~0.5–5 ms    ← the killer, once PER ROW
```

At 1 ms RTT + 1 ms fsync, the theoretical ceiling is **~500 rows/sec per connection** no matter how fast the disk is. That is why an import "works fine locally" (unix socket, `fsync=off` dev config) and takes 14 hours in production.

### The ladder of loading techniques

| Technique | Round trips for 1M rows | Typical throughput (PG 15, 8 vCPU, gp3, 3 indexes) | When |
|---|---|---|---|
| Single-row `INSERT`, autocommit | 1,000,000 | 400–800 rows/s | Never for bulk |
| Single-row `INSERT`, one transaction | 1,000,000 | 3k–8k rows/s | Still round-trip bound |
| Multi-row `INSERT` (1000 values) | 1,000 | 40k–80k rows/s | Portable, easy, good enough |
| JDBC `addBatch` **without** rewrite flag | 1,000,000 (!) | 3k–8k rows/s | The silent trap |
| JDBC `addBatch` **with** rewrite flag | ~1,000 | 40k–90k rows/s | Default for app-driven loads |
| `COPY ... FROM STDIN` (PG) | streaming | 150k–400k rows/s | Fastest portable-ish path |
| `COPY` into `UNLOGGED` table, no indexes | streaming | 400k–1M rows/s | Staging/ETL only |
| `LOAD DATA INFILE` (MySQL) | streaming | 100k–300k rows/s | MySQL equivalent of COPY |

Numbers are order-of-magnitude, not benchmarks. The **ratios** are the point: COPY is roughly 100× a naive loop, and 4–8× a well-batched INSERT.

### PostgreSQL: `COPY`

```sql
-- Server-side COPY: file must be readable by the postgres OS user (superuser / pg_read_server_files)
COPY events (occurred_at, user_id, kind, payload)
FROM '/var/lib/postgresql/import/events.csv'
WITH (FORMAT csv, HEADER true, DELIMITER ',', NULL '');

-- Client-side \copy in psql: streams over the existing connection, no server file access needed
\copy events (occurred_at, user_id, kind, payload) FROM './events.csv' WITH (FORMAT csv, HEADER true)

-- Pipe from another process (no intermediate file at all)
-- psql -c "\copy events FROM PROGRAM 'zcat /tmp/events.csv.gz' WITH (FORMAT csv)"
```

From Java, use the driver's `CopyManager` — it is dramatically faster than any batch API:

```java
public long copyEvents(Connection conn, Reader csv) throws Exception {
    PGConnection pg = conn.unwrap(PGConnection.class);
    CopyManager copyManager = pg.getCopyAPI();
    return copyManager.copyIn(
        "COPY events (occurred_at, user_id, kind, payload) FROM STDIN WITH (FORMAT csv)",
        csv,
        1 << 16);   // 64 KB buffer; small buffers re-introduce round trips
}
```

`COPY` skips per-row statement planning entirely, writes rows in page-fill order, and (in PG 14+) can use a single WAL record for multiple tuples on the same page. It still fires triggers, still checks constraints, still maintains indexes — those are the costs you remove separately.

### MySQL: `LOAD DATA INFILE`

```sql
-- Server-side: file on the DB host, path must be under secure_file_priv
LOAD DATA INFILE '/var/lib/mysql-files/events.csv'
INTO TABLE events
FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"'
LINES TERMINATED BY '\n'
IGNORE 1 LINES
(@occurred_at, user_id, kind, payload)
SET occurred_at = STR_TO_DATE(@occurred_at, '%Y-%m-%d %H:%i:%s');

-- Client-side: requires local_infile=1 on BOTH server and client/JDBC URL
LOAD DATA LOCAL INFILE './events.csv' INTO TABLE events ...;
```

JDBC: `?allowLoadLocalInfile=true` (MySQL Connector/J 8.0.31+; older drivers used `allowLoadLocalInfileInPath`). This is a deliberate security gate — a malicious server can otherwise ask the client to upload arbitrary local files. Enable it narrowly, on the import job's datasource only, never on the API datasource.

### JDBC batching — and the two flags that decide everything

The single most expensive misunderstanding in Java data loading: `addBatch()` / `executeBatch()` **does not** by itself produce one multi-row statement. By default both major drivers still send N statements — they just pipeline them, saving a little latency, not the parse/execute cost.

| Driver | Flag | What it does |
|---|---|---|
| MySQL Connector/J | `rewriteBatchedStatements=true` | Rewrites N `INSERT INTO t VALUES (…)` into one `INSERT INTO t VALUES (…),(…),(…)` |
| PostgreSQL JDBC | `reWriteBatchedInserts=true` | Same rewrite for simple `INSERT … VALUES (?, ?)` batches |

```
jdbc:mysql://db:3306/app?rewriteBatchedStatements=true&useServerPrepStmts=true&cachePrepStmts=true
jdbc:postgresql://db:5432/app?reWriteBatchedInserts=true
```

```java
private static final int BATCH = 1_000;

public void insertAll(Connection conn, List<Event> events) throws SQLException {
    boolean prevAutoCommit = conn.getAutoCommit();
    conn.setAutoCommit(false);
    String sql = "INSERT INTO events (occurred_at, user_id, kind, payload) VALUES (?, ?, ?, ?)";
    try (PreparedStatement ps = conn.prepareStatement(sql)) {
        int n = 0;
        for (Event e : events) {
            ps.setTimestamp(1, Timestamp.from(e.occurredAt()));
            ps.setLong(2, e.userId());
            ps.setString(3, e.kind());
            ps.setString(4, e.payload());
            ps.addBatch();
            if (++n % BATCH == 0) {
                ps.executeBatch();
                conn.commit();          // transaction sizing: bound lock + WAL exposure
            }
        }
        ps.executeBatch();
        conn.commit();
    } catch (SQLException ex) {
        conn.rollback();
        throw ex;
    } finally {
        conn.setAutoCommit(prevAutoCommit);
    }
}
```

Constraints on the rewrite that bite in production:

- The rewrite only applies to **plain `INSERT ... VALUES`**. Add `ON DUPLICATE KEY UPDATE` (MySQL) or `ON CONFLICT` (PG, pre-9.4.1210 driver behavior varies) and it may silently fall back to one-statement-per-row.
- `getGeneratedKeys()` on a rewritten batch returns fewer/different keys. If you need IDs back, either generate them client-side or use PG `RETURNING` with a non-rewritten path.
- Batch too large and you hit `max_allowed_packet` (MySQL, default 64 MB) or blow up driver memory. `executeBatch()` return codes become `SUCCESS_NO_INFO`.

**Batch size tuning:** throughput climbs steeply to ~500, flattens by ~1000–2000, and degrades past ~10,000 as packet size, driver memory, and lock duration grow. Start at 1,000. Measure. Do not "optimize" to 50,000.

### Removing the other costs: indexes, constraints, logging

For a load into an **empty or staging** table, dropping and rebuilding indexes is usually 2–5× faster than maintaining them row by row, because the rebuild is a single sort + bulk-build instead of N random B-tree descents and page splits.

```sql
-- PostgreSQL: staging load pattern
BEGIN;
DROP INDEX IF EXISTS idx_events_user_time;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_user_fk;
COMMIT;

-- ... COPY 50M rows ...

-- Rebuild concurrently so the table stays writable if it is live
CREATE INDEX CONCURRENTLY idx_events_user_time ON events (user_id, occurred_at DESC);
ALTER TABLE events ADD CONSTRAINT events_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT events_user_fk;   -- ShareUpdateExclusive, does not block writes
ANALYZE events;                                          -- CRITICAL: stats are empty after a bulk load
```

```sql
-- MySQL InnoDB
SET SESSION unique_checks = 0;
SET SESSION foreign_key_checks = 0;
SET SESSION sql_log_bin = 0;      -- ONLY if the replica gets the data another way
LOAD DATA INFILE ...;
SET SESSION foreign_key_checks = 1;
SET SESSION unique_checks = 1;
ANALYZE TABLE events;
```

Disabling `unique_checks` and `foreign_key_checks` means **you** now guarantee the data is clean. If it is not, you get a corrupt-looking table that passes no validation and a very bad afternoon. Only do this into a staging table you can truncate.

### `UNLOGGED` tables (PostgreSQL)

```sql
CREATE UNLOGGED TABLE events_staging (LIKE events INCLUDING DEFAULTS);
-- ... COPY into it: no WAL for the data, ~2-3x faster, near-zero replica lag impact ...
INSERT INTO events SELECT * FROM events_staging;   -- this part IS logged
```

Trade-offs you must state out loud before using this:

| Property | Consequence |
|---|---|
| Not WAL-logged | Contents are **truncated** after any crash or unclean shutdown |
| Not replicated | Does not exist on physical replicas; queries there fail |
| Not restorable by PITR | A backup restore gives you an empty table |
| `ALTER TABLE ... SET LOGGED` | Rewrites the whole table and WAL-logs it — no free lunch |

Correct use: staging/scratch tables that are always rebuilt from a source of truth. Incorrect use: anything a user can see.

### Upsert at scale

```sql
-- PostgreSQL: bulk upsert, one statement, index-driven conflict resolution
INSERT INTO product_prices (sku, price_cents, updated_at)
SELECT sku, price_cents, now() FROM price_import
ON CONFLICT (sku) DO UPDATE
   SET price_cents = EXCLUDED.price_cents,
       updated_at  = EXCLUDED.updated_at
WHERE product_prices.price_cents IS DISTINCT FROM EXCLUDED.price_cents;  -- skip no-op UPDATEs
```

That trailing `WHERE` is the difference between an upsert of 5 million rows and an upsert of the 12,000 rows that actually changed. Without it, every unchanged row still creates a dead tuple, still writes WAL, still bloats the table, and still ships bytes to the replica.

```sql
-- PostgreSQL 15+ / Oracle / SQL Server: MERGE
MERGE INTO product_prices p
USING price_import i ON p.sku = i.sku
WHEN MATCHED AND p.price_cents <> i.price_cents THEN
  UPDATE SET price_cents = i.price_cents, updated_at = now()
WHEN NOT MATCHED THEN
  INSERT (sku, price_cents, updated_at) VALUES (i.sku, i.price_cents, now());
```

```sql
-- MySQL 8
INSERT INTO product_prices (sku, price_cents, updated_at)
SELECT sku, price_cents, NOW(6) FROM price_import AS new
ON DUPLICATE KEY UPDATE
  price_cents = new.price_cents,      -- 8.0.20+ alias form; VALUES() is deprecated
  updated_at  = NOW(6);
```

`MERGE` is not automatically concurrency-safe. In PostgreSQL, `MERGE` under READ COMMITTED can raise a unique violation when two sessions merge the same key concurrently — `INSERT ... ON CONFLICT` handles that case internally, `MERGE` does not. For concurrent writers, prefer `ON CONFLICT`; use `MERGE` for single-writer batch jobs.

### The staging-table pattern (the one to memorize)

```sql
-- 1. Land raw data fast, no constraints, no indexes
CREATE UNLOGGED TABLE stg_orders (LIKE orders INCLUDING DEFAULTS);
-- COPY stg_orders FROM STDIN ...

-- 2. Validate and quarantine in SQL, not in application memory
CREATE TABLE stg_orders_rejected AS
SELECT * FROM stg_orders WHERE total_cents < 0 OR customer_id IS NULL;
DELETE FROM stg_orders s USING stg_orders_rejected r WHERE r.id = s.id;

-- 3. Deduplicate within the batch (source files always have dupes)
DELETE FROM stg_orders a USING stg_orders b
WHERE a.external_id = b.external_id AND a.ctid < b.ctid;

-- 4. Merge into the real table in bounded chunks
INSERT INTO orders (external_id, customer_id, total_cents, created_at)
SELECT external_id, customer_id, total_cents, created_at
FROM stg_orders
ORDER BY external_id
ON CONFLICT (external_id) DO UPDATE
   SET total_cents = EXCLUDED.total_cents
WHERE orders.total_cents IS DISTINCT FROM EXCLUDED.total_cents;

-- 5. Refresh stats, drop staging
ANALYZE orders;
DROP TABLE stg_orders;
```

Every step is restartable, every rejection is inspectable, and the live table is only touched by step 4.

### Transaction sizing and WAL pressure

One giant transaction for 50M rows is not "safer." It is:

- One `xmin` horizon pinned for the whole load → autovacuum cannot clean anything anywhere in the database.
- One rollback that takes as long as the load did (MySQL undo rollback of 50M rows is brutal).
- A WAL burst that outruns replica replay → lag alarm → hot standby conflicts.
- Zero restartability: a network blip at 95% costs you 95%.

| Chunk size | Effect |
|---|---|
| 1 row per tx | Fsync-bound; ~500 rows/s |
| 1k–10k rows per tx | The sweet spot for live tables: short locks, restartable, bounded WAL |
| 100k+ rows per tx | Acceptable in a maintenance window on a quiet system |
| Whole load in one tx | Blocks vacuum, huge rollback risk, replica lag spike |

WAL/redo knobs worth setting **for the duration of a load**, then reverting:

```sql
-- PostgreSQL (postgresql.conf / ALTER SYSTEM; requires reload)
max_wal_size = '16GB'            -- fewer checkpoints during the load
checkpoint_timeout = '30min'
maintenance_work_mem = '2GB'     -- makes CREATE INDEX after the load much faster
-- synchronous_commit = off      -- session-level only, and only for reloadable data
```

```sql
-- MySQL
SET GLOBAL innodb_flush_log_at_trx_commit = 2;   -- lose ≤1s on OS crash; REVERT AFTER LOAD
-- innodb_buffer_pool_size should already be ~70% of RAM
```

`synchronous_commit = off` and `innodb_flush_log_at_trx_commit = 2` trade durability for speed. They are legitimate for a load you can re-run from the source file, and a resume-generating mistake for anything else. Set them `SET LOCAL` / per-session where possible so a forgotten revert cannot become the permanent config.

### Production scenario: nightly catalog import takes 9 hours and lags every replica

**Problem.** A retail platform imports a 40M-row supplier catalog nightly. The job is a Spring Batch writer doing `repository.save()` per item. It started at 40 minutes when the catalog was 2M rows; at 40M rows it runs 9 hours, overruns the morning traffic ramp, and pushes replica lag to 900 seconds — so the storefront serves yesterday's prices while the import is still running.

**Cause.** Three compounding costs. (1) Every `save()` is a separate `INSERT`/`SELECT`+`UPDATE` round trip in its own transaction — the job is fsync- and RTT-bound at roughly 1,200 rows/s, not CPU-bound; DB CPU sat at 15% the whole time. (2) `product` had six indexes, all maintained per row, with random `UUID` values in one of them causing scattered page writes. (3) The writer issued an unconditional `UPDATE` for every row even when nothing changed, so 39.6M no-op updates generated 39.6M dead tuples and ~30 GB of WAL that the replicas had to replay.

**Solution.** Replace the row-by-row writer with COPY into an unlogged staging table, then a single change-only upsert.

```sql
-- Step 1: land the file (client-side COPY from the batch job, ~4 minutes for 40M rows)
CREATE UNLOGGED TABLE stg_product (
  supplier_sku TEXT NOT NULL,
  name         TEXT NOT NULL,
  price_cents  BIGINT NOT NULL,
  in_stock     BOOLEAN NOT NULL
);
-- CopyManager.copyIn("COPY stg_product FROM STDIN WITH (FORMAT csv)", reader, 65536)

-- Step 2: dedupe inside the batch — supplier files ship the same SKU twice
DELETE FROM stg_product a USING stg_product b
WHERE a.supplier_sku = b.supplier_sku AND a.ctid < b.ctid;

CREATE INDEX ON stg_product (supplier_sku);
ANALYZE stg_product;

-- Step 3: upsert ONLY rows that actually differ
INSERT INTO product (supplier_sku, name, price_cents, in_stock, updated_at)
SELECT s.supplier_sku, s.name, s.price_cents, s.in_stock, now()
FROM stg_product s
ON CONFLICT (supplier_sku) DO UPDATE
SET name        = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    in_stock    = EXCLUDED.in_stock,
    updated_at  = now()
WHERE (product.name, product.price_cents, product.in_stock)
      IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.price_cents, EXCLUDED.in_stock);

ANALYZE product;
DROP TABLE stg_product;
```

Chunk step 3 by `supplier_sku` range (200k SKUs per transaction) so no single transaction pins the vacuum horizon for more than a couple of minutes.

Result: 9 hours → 11 minutes. WAL volume dropped from ~30 GB to ~600 MB because only the 380k genuinely-changed rows were written, and peak replica lag fell from 900 s to under 4 s.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `addBatch()` without `rewriteBatchedStatements` / `reWriteBatchedInserts` | "We batch already" but throughput identical to row-by-row; N statements in the query log |
| Batch size 50,000 | `max_allowed_packet` errors, driver OOM, 30-second lock waits |
| No `ANALYZE` after bulk load | Planner thinks the table has 0 rows → nested loops over 40M rows on the next query |
| Whole load in one transaction | Autovacuum stalls database-wide; rollback takes hours; replica lag spike |
| `UNLOGGED` table used for real data | Table silently empty after failover or crash recovery |
| Unconditional upsert with no change filter | Massive dead-tuple/WAL amplification for a handful of real changes |
| Forgot to revert `innodb_flush_log_at_trx_commit=2` | Silent durability downgrade in production forever |
| Indexes dropped on a **live** table during load | Every concurrent read does a seq scan; incident during the "optimization" |

### Debugging scenario

**Observe.** An import job's throughput graph is a flat line at ~900 rows/s regardless of instance size. Scaling the DB from 8 to 32 vCPU changes nothing.

**Diagnose.** Flat throughput that ignores hardware means you are latency-bound, not resource-bound. Confirm: DB CPU low, `pg_stat_statements` shows the INSERT with `calls` equal to the row count and a tiny `mean_exec_time` (0.08 ms) — the server is fast, the *conversation* is slow. `calls ≈ rows` is the definitive fingerprint of an unbatched load.

**Fix.** Batch or COPY. Then re-measure: if throughput is still flat, check `wait_event = WALWrite` (commit fsync per transaction — increase chunk size) or trigger overhead (`SELECT tgname FROM pg_trigger WHERE tgrelid = 'events'::regclass AND NOT tgisinternal`).

---

## 7. Joins: Inner, Outer, Cross, Self — Semantics That Matter

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

## 8. Subqueries, CTEs, and Correlated Queries

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

## 9. Aggregates, GROUP BY, HAVING, and DISTINCT Pitfalls

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

## 10. Window Functions: Ranking, Frames, and Production Patterns

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

## 11. Indexes: B-tree, Composite, Covering, Partial

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

## 12. Index Internals: B+Tree Layout, Clustering, and Physical Cost

### Core concept

An index is not "a lookup table the database consults." It is a **physical data structure whose shape determines which queries are cheap**. Every index decision you make — column order, width, partiality, storage type — is a decision about page layout and I/O count. You cannot reason about index behavior from the SQL alone; you have to know what the pages look like.

### B+tree structure

Relational engines use a **B+tree**, not a B-tree. The distinction matters:

- **Internal (branch) nodes** store only separator keys and child page pointers. They contain no row data.
- **Leaf nodes** store every key, plus a pointer to the row (`ctid` in PostgreSQL, primary key value in an InnoDB secondary index, or the row itself in an InnoDB clustered index).
- **Leaves are linked** in a doubly-linked list, which is what makes range scans and `ORDER BY` on the index key cheap: find the start, then walk sideways without re-descending the tree.

```
                        ┌──────────── root page ────────────┐
                        │ [ •  k=5000  •  k=10000  •  ]     │   1 page
                        └───┬──────────┬──────────┬─────────┘
             ┌──────────────┘          │          └──────────────┐
        ┌────▼─────┐              ┌────▼─────┐              ┌────▼─────┐
        │ internal │              │ internal │   ...        │ internal │   ~700 pages
        └────┬─────┘              └────┬─────┘              └────┬─────┘
   ┌─────────┴────────┐                │                         │
┌──▼───────┐   ┌──────▼───┐      ┌─────▼────┐             ┌──────▼───┐
│ leaf     │◄─►│ leaf     │◄────►│ leaf     │◄─── ... ───►│ leaf     │   ~278,000 pages
│ k→ctid   │   │ k→ctid   │      │ k→ctid   │             │ k→ctid   │
└──────────┘   └──────────┘      └──────────┘             └──────────┘
                     ▲ sibling links: range scans walk here, no re-descent
```

### Fanout and height math (100M rows)

| Quantity | PostgreSQL (8 KB page) | InnoDB (16 KB page) |
|---|---|---|
| Page size | 8192 B | 16384 B |
| Usable per page after headers/special | ~8000 B | ~15000 B (targets 15/16 fill) |
| Bytes per internal entry, `BIGINT` key | ~20 B (8 B index-tuple header + 8 B key + 4 B line pointer) | ~22 B (key + 6 B page number + record header) |
| **Fanout (internal)** | ~400 | ~680 |
| Leaf entries, `BIGINT` key | ~360 (fillfactor 90) | clustered leaf holds full rows |

For a `BIGINT` index over **100,000,000 rows** in PostgreSQL:

```
leaf pages       = 100,000,000 / 360      ≈ 277,778
level-1 pages    =     277,778 / 400      ≈     695
level-2 pages    =         695 / 400      ≈       2
root             =                                1
--------------------------------------------------
tree height      = 4 levels  (root → L2 → L1 → leaf)
index size       ≈ 278,476 pages × 8 KB   ≈ 2.2 GB
```

The operational consequences of that arithmetic:

- **A point lookup in 100M rows costs 4 page accesses, not 100M.** Doubling the table to 200M rows adds *zero* levels (fanout 400 means one more level buys you 400×). Index depth grows logarithmically and practically never exceeds 5 for OLTP tables.
- **The root and level-2 are always in cache** (3 pages). Level-1 is 695 pages ≈ 5.5 MB — also always cached. So a "4-level tree" is realistically **1 physical read** (the leaf) plus **1 more** for the heap row.
- **Key width is the enemy of fanout.** Switch that `BIGINT` to a 36-character `VARCHAR` UUID and per-entry cost goes from 20 B to ~48 B: fanout drops from 400 to ~165, leaf entries from 360 to ~150, and the index grows from 2.2 GB to ~5.4 GB. Same rows, 2.5× the I/O.

### Why index column order matters: the leftmost-prefix rule

A composite index `(a, b, c)` is a B+tree sorted by the **tuple** `(a, b, c)` — like a phone book sorted by last name, then first name, then middle name. You can seek efficiently only on a **prefix** of that sort order.

```sql
CREATE INDEX idx_orders_cst ON orders (customer_id, status, created_at);
```

| Query | Uses the index? | How |
|---|---|---|
| `WHERE customer_id = 42` | ✅ Full seek | Prefix `(a)` |
| `WHERE customer_id = 42 AND status = 'open'` | ✅ Full seek | Prefix `(a, b)` |
| `WHERE customer_id = 42 AND status = 'open' AND created_at > '2026-01-01'` | ✅ Best case | Prefix `(a, b)` + range on `c` |
| `WHERE customer_id = 42 ORDER BY status, created_at` | ✅ Seek + no sort | Index already in that order |
| `WHERE customer_id = 42 AND created_at > '2026-01-01'` | ⚠️ Partial | Seeks on `a` only, then **filters** every row of that customer on `created_at`; `c` cannot be a seek because `b` is unconstrained |
| `WHERE status = 'open'` | ❌ No seek | `b` is not a prefix. PG may do an inefficient index-only *scan* of the whole index if it is narrower than the heap; MySQL does a full scan |
| `WHERE status = 'open' AND created_at > '2026-01-01'` | ❌ No seek | Same reason |
| `WHERE customer_id IN (1,2,3) AND status = 'open'` | ✅ Seek ×3 | Treated as three prefix seeks |
| `WHERE customer_id = 42 ORDER BY created_at` | ⚠️ Seek + sort | Rows for customer 42 are ordered by `(status, created_at)`, not `created_at` — an explicit `Sort` node appears |

**The two rules that follow:**

1. **Equality columns first, range column last.** Once you use a range (`>`, `<`, `BETWEEN`, `LIKE 'x%'`) on a column, every column after it in the index can only be used as a filter, never as a seek boundary.
2. **Match `ORDER BY` direction.** `(status, created_at DESC)` serves `ORDER BY status, created_at DESC` and, by scanning backwards, `ORDER BY status DESC, created_at ASC` — but **not** `ORDER BY status, created_at ASC` without a sort.

```sql
-- Query: WHERE tenant_id = ? AND status = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 50
-- Correct: two equalities, then the range/sort column
CREATE INDEX idx_tickets_hot ON tickets (tenant_id, status, created_at DESC);

-- Wrong: range in the middle wastes the trailing column entirely
CREATE INDEX idx_tickets_bad ON tickets (tenant_id, created_at DESC, status);
```

### Covering indexes and index-only scans

If every column the query touches lives in the index, the engine never needs the table. PostgreSQL calls this an **Index Only Scan**; MySQL reports `Using index` in `EXPLAIN`.

```sql
-- PostgreSQL: INCLUDE columns are stored in the LEAF ONLY, not in internal nodes.
-- They add zero cost to tree height/fanout but make the leaf level wider.
CREATE INDEX idx_orders_cover
ON orders (customer_id, created_at DESC)
INCLUDE (status, total_cents);

-- This query never touches the heap:
SELECT status, total_cents FROM orders
WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20;
```

```sql
-- MySQL: no INCLUDE. Append the payload columns to the key itself.
CREATE INDEX idx_orders_cover ON orders (customer_id, created_at, status, total_cents);
```

**The PostgreSQL catch nobody expects:** an index-only scan still has to verify tuple visibility, because index entries do not carry MVCC information. PostgreSQL consults the **visibility map** — a bitmap with one bit per heap page saying "all tuples on this page are visible to everyone." If the page is not marked all-visible, the scan falls back to a heap fetch for that row.

```
Index Only Scan using idx_orders_cover on orders  (cost=0.57..8.62 rows=20 width=16)
                                                   (actual time=0.031..0.078 rows=20 loops=1)
  Index Cond: (customer_id = 42)
  Heap Fetches: 19        ← 19 of 20 rows still hit the heap. The "index-only" scan isn't.
```

`Heap Fetches` > 0 on a hot table means **autovacuum is not keeping the visibility map current**. The fix is vacuum tuning, not another index:

```sql
ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.02,
                        autovacuum_analyze_scale_factor = 0.01);
VACUUM (ANALYZE) orders;   -- refreshes the visibility map immediately
```

### Clustered vs secondary indexes in InnoDB

This is the single biggest structural difference between InnoDB and PostgreSQL, and it drives half of MySQL performance advice.

| | PostgreSQL | InnoDB |
|---|---|---|
| Table storage | **Heap** — unordered pages; PK is just another B-tree | **Index-organized** — the clustered index *is* the table |
| Primary key index leaf contains | `(pk_value → ctid)` | The entire row |
| Secondary index leaf contains | `(key → ctid)` — direct pointer to heap page/offset | `(key → primary_key_value)` — **not** a physical pointer |
| Reading a non-covered column via secondary index | 1 index descent + 1 heap page read | 1 index descent + **a second full B-tree descent** of the clustered index |
| Cost of a wide PK | Paid once, in the PK index | Paid in **every** secondary index, in every row of every one of them |

That last row is the whole story. In InnoDB, a secondary index entry is `(index_columns, primary_key)`. With a `BIGINT` PK, each secondary entry carries 8 extra bytes. With a `CHAR(36)` UUID PK, it carries 36. Across five secondary indexes and 100M rows that is 100,000,000 × 5 × 28 extra bytes ≈ **14 GB of pure overhead**, all of it competing for buffer pool.

The "second descent" is called a **bookmark lookup**. `EXPLAIN` will not shout about it; you see it as unexpectedly high `handler_read_next` counts and a query that is 3× slower than the row count suggests. The fix is a covering index so the second descent never happens.

### Why a random UUID primary key destroys insert performance

```
SEQUENTIAL PK (BIGINT AUTO_INCREMENT / UUIDv7)
  every insert targets the RIGHTMOST leaf page
  ┌────┬────┬────┬────┬────┬─────┐
  │ ██ │ ██ │ ██ │ ██ │ ██ │ ▓░  │ ← all inserts land here
  └────┴────┴────┴────┴────┴─────┘
  • 1 hot page in the buffer pool, always cached → zero read I/O
  • pages fill to ~15/16 before a clean split at the right edge
  • table size ≈ data size

RANDOM UUIDv4 PK
  every insert targets a RANDOM leaf page out of 1,400,000
  ┌────┬────┬────┬────┬────┬─────┐
  │ ▓░ │ ██ │ ▓░ │ ██ │ ▓░ │ ██  │ ← inserts scattered everywhere
  └─▲──┴────┴──▲─┴────┴─▲──┴─────┘
    │          │        │
  • target page is usually NOT in the buffer pool → 1 random READ per insert
  • a full target page SPLITS 50/50 → two half-empty pages
  • steady state: pages ~50-60% full → table 1.5-2x larger → even worse cache hit rate
```

The collapse is not gradual; it is a **cliff**. While the index fits in the buffer pool, random inserts are fine (all pages cached, no read I/O). The moment the index exceeds the buffer pool, every insert becomes a random read from disk. Throughput falls from ~30k inserts/s to ~2k inserts/s over the span of a few days of growth, which is why the incident always looks like "nothing changed."

Secondary damage from page splits:
- **Fragmentation**: logical order no longer matches physical order, so range scans read 2× the pages.
- **Doubled index size**: 50% fill vs 94% fill.
- **WAL/redo amplification**: a page split writes a full-page image of two pages.

**The fix — time-ordered identifiers.** Keep the properties you actually wanted from UUID (client-side generation, no coordination, non-guessable-ish) while restoring monotonicity:

| Option | Notes |
|---|---|
| `BIGINT` identity/sequence | Fastest, narrowest. Leaks row counts; needs a server round trip or client-side range allocation |
| **UUIDv7** (RFC 9562) | 48-bit Unix-ms timestamp prefix + randomness. Drop-in replacement for v4; native `uuidv7()` in PostgreSQL 18, `pg_uuidv7` extension before that |
| **ULID** | 48-bit timestamp + 80 bits randomness, Crockford base32, lexicographically sortable |
| Snowflake ID | 64-bit: timestamp + node id + sequence. Needs node-id coordination |
| UUIDv4 as a **secondary** unique column | Keep `BIGINT` PK for physical order, expose the UUID externally. Best of both, costs one extra index |

```sql
-- PostgreSQL: store UUIDs as the native uuid type (16 bytes), never as text (36+ bytes)
ALTER TABLE events ALTER COLUMN id TYPE uuid USING id::uuid;

-- MySQL: 16-byte binary, with the v1 time-swap trick if you are stuck on v1
CREATE TABLE events (
  id BINARY(16) PRIMARY KEY,            -- app inserts UUID_TO_BIN(uuid, 1) or a ULID
  ...
) ENGINE=InnoDB;

-- Migration path when you cannot change the PK type: add a sequential surrogate
ALTER TABLE events ADD COLUMN seq BIGINT AUTO_INCREMENT UNIQUE;
```

### Heap vs index-organized tables

| Model | Engines | Strength | Weakness |
|---|---|---|---|
| **Heap** | PostgreSQL (only option), Oracle default, SQL Server without clustered index | Cheap inserts anywhere; all indexes are equal-cost; updates can be HOT | Every index lookup needs a heap visit; no natural clustering |
| **Index-organized / clustered** | InnoDB (mandatory), Oracle IOT, SQL Server clustered index | PK range scans are sequential; PK lookups need no second read | Secondary lookups pay a bookmark lookup; PK width poisons every index; random PK causes splits |

PostgreSQL offers `CLUSTER table USING index` — but this is a **one-time physical reorder** under an `AccessExclusive` lock, and new/updated rows go wherever there is space. It is not maintained. The maintained approximation is `pg_repack --order-by`, or `BRIN` indexes on naturally correlated columns.

### HOT updates (PostgreSQL)

In PostgreSQL, `UPDATE` is `INSERT` + mark-old-dead. Normally that means **every index on the table gets a new entry**, even for indexes on columns you did not touch. **Heap-Only Tuple (HOT)** updates avoid this, under two conditions:

1. No **indexed** column was modified.
2. The new tuple version fits on the **same heap page** as the old one.

When both hold, the new version is chained from the old via `t_ctid` and **no index entry is written at all**. This is the difference between a 5,000/s update workload and a 500/s one.

Condition 2 is why `fillfactor` exists:

```sql
-- Leave 15% of each page free for future HOT updates on an update-heavy table
ALTER TABLE user_sessions SET (fillfactor = 85);
VACUUM FULL user_sessions;   -- or pg_repack, to apply fillfactor to existing pages

-- Measure the HOT ratio: aim for >90% on hot tables
SELECT relname,
       n_tup_upd,
       n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables
WHERE n_tup_upd > 100000
ORDER BY hot_pct NULLS FIRST;
```

A low `hot_pct` on a table you update constantly means either fillfactor is 100 (default) or you are updating an indexed column — often `updated_at`, which somebody indexed "just in case."

### Index bloat and `REINDEX`

B+tree pages are not compacted when entries are deleted. A table that churns keys (queue tables, session tables, anything with a high-water-mark delete pattern) accumulates nearly-empty leaf pages. The index can be 5 GB while holding 500 MB of live entries — and every scan reads the empty pages too.

```sql
-- PostgreSQL: measure (requires CREATE EXTENSION pgstattuple)
SELECT i.indexrelid::regclass AS index_name,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
       s.avg_leaf_density,          -- healthy ≈ 90; bloated < 50
       s.leaf_fragmentation
FROM pg_index i
CROSS JOIN LATERAL pgstatindex(i.indexrelid::regclass::text) s
WHERE pg_relation_size(i.indexrelid) > 100 * 1024 * 1024
ORDER BY s.avg_leaf_density;

-- Rebuild WITHOUT an exclusive lock (PG 12+)
REINDEX INDEX CONCURRENTLY idx_jobs_status_created;
REINDEX TABLE CONCURRENTLY jobs;

-- Pre-12 equivalent: build a twin, then swap
CREATE INDEX CONCURRENTLY idx_jobs_status_created_new ON jobs (status, created_at);
DROP INDEX CONCURRENTLY idx_jobs_status_created;
ALTER INDEX idx_jobs_status_created_new RENAME TO idx_jobs_status_created;
```

```sql
-- MySQL InnoDB: rebuild in place
ALTER TABLE jobs ENGINE=InnoDB, ALGORITHM=INPLACE, LOCK=NONE;
-- or OPTIMIZE TABLE jobs;  (does the same for InnoDB, plus ANALYZE)
```

`REINDEX CONCURRENTLY` leaves an invalid index behind if it fails mid-flight. Always check afterward:

```sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

### Partial (filtered) indexes

Index only the rows you query. The savings compound: smaller index → fewer levels → better cache residency → cheaper writes (rows outside the predicate cost nothing to insert).

```sql
-- PostgreSQL: a queue table where 0.1% of rows are pending
CREATE INDEX CONCURRENTLY idx_jobs_pending
ON jobs (priority DESC, created_at)
WHERE status = 'pending';
-- 200M-row table, 40k pending rows → index is ~1.5 MB instead of ~9 GB

-- Soft-delete pattern: never index the tombstones
CREATE INDEX idx_users_email_active ON users (lower(email)) WHERE deleted_at IS NULL;

-- Enforce "one active subscription per customer" without touching cancelled rows
CREATE UNIQUE INDEX uq_active_sub ON subscriptions (customer_id) WHERE status = 'active';
```

The planner uses a partial index only if it can **prove** the query predicate implies the index predicate. `WHERE status = 'pending'` matches; `WHERE status = $1` with a parameter does **not** (the planner cannot prove it at plan time for a generic plan), and neither does `WHERE status <> 'done'`. This is the #1 reason a partial index looks "ignored."

SQL Server has the same feature as **filtered indexes** (`CREATE INDEX ... WHERE`). **MySQL has no partial indexes** — emulate with a generated column:

```sql
ALTER TABLE jobs ADD COLUMN pending_key BIGINT
  GENERATED ALWAYS AS (IF(status = 'pending', id, NULL)) STORED;
CREATE INDEX idx_jobs_pending ON jobs (pending_key);   -- NULLs are still stored, but the index is narrow
```

### Expression indexes

An index on a **function result**. Required whenever your predicate applies a function to a column, because a plain index on the column is useless there.

```sql
-- PostgreSQL
CREATE INDEX idx_users_lower_email ON users (lower(email));
-- serves: WHERE lower(email) = lower($1)

CREATE INDEX idx_events_day ON events (date_trunc('day', occurred_at));
CREATE INDEX idx_orders_json_status ON orders ((payload->>'status'));

-- MySQL 8.0.13+ functional index (implemented as a hidden generated column)
CREATE INDEX idx_users_lower_email ON users ((LOWER(email)));
```

Two hard requirements: the function must be **`IMMUTABLE`** (PostgreSQL will refuse otherwise — `now()`, `to_char` with a locale-dependent format, and anything reading a GUC are out), and the query must use the expression **byte-identically**. `lower(email)` matches; `LOWER(TRIM(email))` does not.

### Choosing a storage type: GIN, GiST, BRIN, hash

| Type | Data structure | Best for | Cost |
|---|---|---|---|
| **B-tree** | B+tree | `=`, `<`, `>`, `BETWEEN`, `LIKE 'x%'`, `ORDER BY`, uniqueness | The default; nothing else does ordering |
| **Hash** | Hash table | Equality only, on very wide values (long URLs, hashes) | No ranges, no ordering, no uniqueness. WAL-logged and crash-safe only since PG 10. Rarely worth it over B-tree |
| **GIN** | Inverted index (key → posting list of row ids) | Multi-valued columns: `jsonb` containment `@>`, arrays `&&`, full-text `tsvector @@`, trigram `LIKE '%mid%'` | Slow to update (mitigated by the `fastupdate` pending list), large, but enormously fast for "which rows contain this token" |
| **GiST** | Generalized balanced tree over user-defined predicates | Geometry/PostGIS, range types, exclusion constraints, k-NN `ORDER BY location <-> point` | Lossy — may return false positives that need rechecking; slower point lookups than GIN for text search |
| **SP-GiST** | Space-partitioned (quadtree, radix trie) | Non-balanced data: IP prefixes (`inet`), phone prefixes, point clouds | Niche |
| **BRIN** | Min/max summary per block range | Huge, **naturally correlated** tables: append-only time-series, log tables | Index for 1 TB of data is a few MB. Useless the moment physical order stops correlating with the column |

```sql
-- BRIN on an append-only events table: 100 GB table → ~3 MB index
CREATE INDEX idx_events_brin ON events USING BRIN (occurred_at) WITH (pages_per_range = 64);

-- GIN for JSONB containment
CREATE INDEX idx_orders_payload ON orders USING GIN (payload jsonb_path_ops);
SELECT * FROM orders WHERE payload @> '{"channel":"mobile"}';

-- GIN + pg_trgm makes leading-wildcard LIKE indexable
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_products_name_trgm ON products USING GIN (name gin_trgm_ops);
SELECT * FROM products WHERE name ILIKE '%wireless%';   -- now uses the index

-- Exclusion constraint via GiST: no two bookings for the same room may overlap
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings ADD CONSTRAINT no_double_booking
  EXCLUDE USING GiST (room_id WITH =, during WITH &&);
```

Verify BRIN is actually viable before using it — check the physical/logical correlation:

```sql
SELECT attname, correlation FROM pg_stats
WHERE tablename = 'events' AND attname = 'occurred_at';
-- correlation near 1.0 (or -1.0) → BRIN works. Near 0 → BRIN is worthless.
```

### Full-text search indexes

```sql
-- PostgreSQL: generated tsvector column + GIN. Do NOT compute to_tsvector() at query time on every row.
ALTER TABLE articles ADD COLUMN search_vec tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')),  'A') ||
    setweight(to_tsvector('english', coalesce(body,  '')),  'B')
  ) STORED;

CREATE INDEX idx_articles_search ON articles USING GIN (search_vec);

SELECT id, title, ts_rank(search_vec, q) AS rank
FROM articles, websearch_to_tsquery('english', 'postgres index bloat') q
WHERE search_vec @@ q
ORDER BY rank DESC
LIMIT 20;
```

```sql
-- MySQL InnoDB
CREATE FULLTEXT INDEX ft_articles ON articles (title, body);
SELECT id, MATCH(title, body) AGAINST ('index bloat' IN NATURAL LANGUAGE MODE) AS score
FROM articles
WHERE MATCH(title, body) AGAINST ('index bloat' IN NATURAL LANGUAGE MODE)
ORDER BY score DESC LIMIT 20;
```

Know the limits before you promise search: no typo tolerance, stemming is language-configured at index time (changing the config requires a rebuild), relevance ranking is primitive compared to a real search engine, and GIN updates are expensive on write-heavy tables. Built-in FTS is right for "search my 2M support tickets"; it is wrong for "be Elasticsearch."

### Selectivity, cardinality, and when an index makes things *slower*

**Cardinality** = number of distinct values. **Selectivity** = fraction of rows a predicate returns. Indexes pay off when selectivity is *low* (few rows returned).

```sql
-- PostgreSQL: what the planner actually believes about a column
SELECT attname, n_distinct, null_frac, correlation,
       most_common_vals, most_common_freqs
FROM pg_stats
WHERE tablename = 'orders' AND attname IN ('status', 'customer_id');
```

`n_distinct` is negative when it is a **ratio** (`-1` = every value unique). `most_common_freqs` is what tells the planner that `status='completed'` is 94% of rows and `status='refunded'` is 0.1% — the same query text gets two different plans depending on the parameter, which is correct behavior and a frequent source of "the query got slow for no reason."

**An index scan is slower than a sequential scan when:**

| Situation | Why |
|---|---|
| Predicate matches >5–20% of rows | Each match is a random heap read (~8 KB); a seq scan reads sequentially at 10–50× the throughput. Crossover depends on `random_page_cost` (default 4.0 — **should be ~1.1 on SSD/NVMe**) |
| The table is small (< a few thousand rows) | The whole table is 1–20 pages. A seq scan is one read; an index adds tree descents for nothing |
| Low correlation between index order and heap order | 10,000 matching rows scattered across 10,000 different pages = 10,000 random reads |
| The index is bloated | You read the empty pages too |
| The workload is write-dominated | See write amplification below |

```sql
-- The single most impactful PostgreSQL setting on modern storage
ALTER SYSTEM SET random_page_cost = 1.1;    -- default 4.0 assumes spinning disks
ALTER SYSTEM SET effective_cache_size = '48GB';  -- ~75% of RAM; tells the planner what's cacheable
SELECT pg_reload_conf();
```

Leaving `random_page_cost = 4.0` on NVMe is why the planner refuses a perfectly good index and does a sequential scan on a 200M-row table.

### Invisible / hypothetical indexes

Dropping an index to test whether it is needed is a one-way door on a large table — rebuilding takes hours. Every mature engine offers a way to test first.

```sql
-- MySQL 8.0 / Oracle 11g+: make the index invisible to the optimizer but keep it maintained
ALTER TABLE orders ALTER INDEX idx_orders_legacy INVISIBLE;
-- ... watch for regressions for a week ...
ALTER TABLE orders ALTER INDEX idx_orders_legacy VISIBLE;    -- instant rollback
ALTER TABLE orders DROP INDEX idx_orders_legacy;             -- or commit to the drop

-- Test a specific session against an invisible index without making it visible globally
SET SESSION optimizer_switch = 'use_invisible_indexes=on';
```

PostgreSQL has **no** invisible indexes. Use the inverse tool — `hypopg` creates an index that exists only in the planner's imagination, so you can `EXPLAIN` a candidate index without building it:

```sql
CREATE EXTENSION hypopg;
SELECT * FROM hypopg_create_index('CREATE INDEX ON orders (customer_id, created_at DESC)');
EXPLAIN SELECT * FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20;
SELECT hypopg_reset();
```

Find drop candidates first:

```sql
-- PostgreSQL: never scanned, and not backing a constraint
SELECT s.relname AS table_name, s.indexrelname AS index_name,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size, s.idx_scan
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;

-- MySQL
SELECT * FROM sys.schema_unused_indexes;
```

Check `idx_scan` against a window that includes month-end and quarter-end reporting before you drop anything. Also confirm the counters were not reset (`pg_stat_reset()`) and that you are looking at **all** replicas — an index unused on the primary may be the only thing keeping the reporting replica alive.

### Index write amplification

Every index is a tax on every write. One `INSERT` into a table with **N** secondary indexes is **1 + N** B-tree modifications, each potentially a random page read, a dirty page, and a WAL record.

```
INSERT into a table with 8 indexes:
  1 heap/clustered write
+ 8 index descents + 8 leaf modifications
+ 8 WAL records (plus full-page images after each checkpoint)
= ~9x the I/O of the same insert on an index-free table
```

| Indexes | Relative insert cost | Relative delete cost |
|---|---|---|
| 1 (PK only) | 1.0× | 1.0× |
| 3 | ~2.2× | ~2.2× |
| 8 | ~5–9× | ~5–9× (deletes must remove every entry) |

`UPDATE` is worse in PostgreSQL: unless the update is HOT, *all* indexes get a new entry even for untouched columns. In InnoDB, an update to a non-indexed column is in-place and cheap; an update to an indexed column is delete+insert in that index.

Practical ceiling: **5–6 indexes per hot OLTP table**. Past that, consolidate — one well-ordered composite index usually replaces three single-column ones, because the leftmost-prefix rule means `(a, b, c)` already serves `(a)` and `(a, b)`.

### Production scenario: insert throughput fell off a cliff at 60M rows

**Problem.** An IoT ingestion service writes device readings to MySQL 8 / InnoDB. For eight months it sustained 28,000 inserts/sec with headroom. Over four days it degraded to 2,100 inserts/sec. No deploy, no config change, no traffic change. The Kafka consumer lag climbed until the retention window started dropping data. DB CPU was 30%, but disk read IOPS had gone from near zero to 24,000/sec — on a table that only ever gets written to.

**Cause.** The table's primary key was `CHAR(36)` holding a UUIDv4 generated in the application. Two failures compounded:

1. **The cliff.** The clustered index had grown to 42 GB against a 32 GB buffer pool. While the index fit in memory, random insert positions cost nothing. Once it did not, *every* insert had to fetch a random 16 KB leaf page from disk first — hence read IOPS on a write-only table. That is the exact signature of a random-PK cliff, and it is why nothing "changed" on the day it broke.
2. **The amplification.** `CHAR(36)` with `utf8mb4` is 144 bytes per PK value. Every one of the four secondary indexes stored that PK in each entry: 60M rows × 4 indexes × ~144 bytes ≈ **34 GB** of secondary index space existing solely to point back at the clustered index. Page splits from random inserts had left leaf pages ~55% full, roughly doubling everything again.

```sql
-- The confirmation: index far larger than the data it describes
SELECT table_name,
       ROUND(data_length /1024/1024/1024, 1) AS data_gb,
       ROUND(index_length/1024/1024/1024, 1) AS index_gb
FROM information_schema.tables
WHERE table_schema = 'iot' AND table_name = 'reading';
-- data_gb: 42.0   index_gb: 61.3

SHOW ENGINE INNODB STATUS\G
-- BUFFER POOL AND MEMORY: "Buffer pool hit rate 771 / 1000"  ← was 999/1000 in March
```

**Solution.** Move to a monotonic key and keep the UUID as an external identifier only. Done online with `gh-ost` so ingestion never stopped.

```sql
-- 1. New table: sequential BIGINT clustered PK; the UUID becomes a narrow BINARY(16) secondary key
CREATE TABLE reading_v2 (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  external_id   BINARY(16) NOT NULL,            -- 16 bytes, not 144
  device_id     BIGINT UNSIGNED NOT NULL,
  recorded_at   TIMESTAMP(6) NOT NULL,
  value         DOUBLE NOT NULL,
  UNIQUE KEY uq_reading_external (external_id),
  KEY idx_reading_device_time (device_id, recorded_at)   -- 4 indexes consolidated into 1 composite
) ENGINE=InnoDB;

-- 2. Backfill + cutover with gh-ost (no table lock, throttled on replica lag)
-- gh-ost --database=iot --table=reading --alter="ENGINE=InnoDB" \
--         --max-lag-millis=1500 --chunk-size=2000 --execute

-- 3. Application change: generate UUIDv7 instead of v4 for external_id, and store it binary
--    INSERT ... VALUES (UUID_TO_BIN(?, 1), ...)
```

For teams that cannot change the PK type at all, the equivalent PostgreSQL-side fix is the same idea expressed differently:

```sql
-- PostgreSQL: keep uuid as PK but make it time-ordered so inserts go to the right edge
ALTER TABLE reading ALTER COLUMN id SET DEFAULT uuidv7();   -- PG 18; or gen_uuid_v7() from pg_uuidv7
```

Result: clustered index 42 GB → 9.1 GB, secondary indexes 61 GB → 6.4 GB, both comfortably inside the buffer pool. Read IOPS returned to ~0. Sustained throughput went to 41,000 inserts/sec, higher than the original baseline because the composite index replaced four separate ones and cut write amplification from 5× to 3×.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `random_page_cost = 4.0` on SSD/NVMe | Planner picks seq scans over perfectly good indexes; "the index exists but isn't used" |
| Random UUID as clustered PK | Insert throughput cliff once the index exceeds the buffer pool; index larger than the data |
| `VARCHAR`/`CHAR` UUID instead of `uuid`/`BINARY(16)` | 2–4× index size; halved fanout; halved cache hit rate |
| Range column in the middle of a composite index | Trailing columns never used for seeks; unexplained `Sort` nodes |
| Index-only scan with high `Heap Fetches` | Visibility map stale — vacuum problem masquerading as an index problem |
| `fillfactor = 100` on an update-heavy PG table | `n_tup_hot_upd` near zero; every update writes to every index; table bloats |
| Partial index with a parameterized predicate | Index "ignored" because the planner cannot prove predicate implication |
| Expression index whose function is not `IMMUTABLE` | `CREATE INDEX` fails, or the index silently never matches the query |
| BRIN on an uncorrelated column | Index is tiny and matches every block range — full scan with extra steps |
| 12 indexes on a hot OLTP table | Writes 5–9× more expensive; autovacuum/purge falls behind; disk doubles |
| Dropping an index on a hunch instead of `INVISIBLE`/`hypopg` | Multi-hour rebuild during the incident you just caused |

### Debugging scenario

**Observe.** A query that uses `idx_orders_cst (customer_id, status, created_at)` runs in 3 ms for most customers and 4 seconds for twelve of them.

**Diagnose.** This is a **skew** problem, not a missing-index problem. Those twelve are enterprise accounts with 2M orders each; the index seek on `customer_id` is fine, but it returns 2M leaf entries that then need heap visits. Confirm with `EXPLAIN (ANALYZE, BUFFERS)` — look for a huge gap between `rows` returned by the index scan and `rows` after the filter, plus `Rows Removed by Filter` in the millions and `shared read` in the hundreds of thousands.

**Fix.** Depends on the query. If it filters on `status`, the composite already covers it — check that the predicate uses the same type (`status = 'open'::text`, not an implicit cast). If it sorts and limits, add `created_at DESC` as the trailing column so the `LIMIT` can stop early instead of sorting 2M rows. If it aggregates, this is not an OLTP query and belongs on a rollup table or a replica. Verify with `most_common_freqs` in `pg_stats` that the planner knows about the skew; if `n_distinct` is wrong, `ALTER TABLE orders ALTER COLUMN customer_id SET STATISTICS 1000; ANALYZE orders;`.

---

## 13. EXPLAIN / ANALYZE & Reading Execution Plans

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

## 14. Query Optimization Playbook

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

## 15. Transactions & ACID — What the Database Actually Guarantees

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

## 16. Isolation Levels: READ UNCOMMITTED Through SERIALIZABLE

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

## 17. MVCC: PostgreSQL vs MySQL InnoDB

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

## 18. Locking: Row, Table, Gap, Next-Key

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

## 19. Deadlocks: Detection, Prevention, Recovery

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

## 20. Connection Pooling Math: max_connections vs App Pods

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

## 21. Read Replicas & Replication Lag

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

## 22. Partitioning & Sharding Basics

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

## 23. Stored Procedures: When / When Not

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

## 24. Flyway / Liquibase Migration Safety

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

## 25. Production Scenarios: Slow Query, Missing Index, Lock Wait, Replica Lag

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

## 26. Production Debugging Playbook

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

## 27. Quick Decision Matrix

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

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Report returns fewer rows after "optimization" to INNER JOIN?</summary>

**Root cause.** INNER JOIN removed parent rows without child matches. LEFT JOIN was correct for optional relationship.

**Fix.** Restore LEFT JOIN or move filter to join condition vs WHERE. Document cardinality expectations in query comments.

---

</details>

<details class="qa-item">
<summary>2. PostgreSQL disk growing 10GB/day but row count stable?</summary>

**Root cause.** Dead tuples from UPDATE-heavy workload; autovacuum not keeping up; long transactions block vacuum horizon.

**Fix.** Tune autovacuum per table; kill long idle-in-transaction sessions; reduce UPDATE width; `VACUUM (ANALYZE)`; pg_repack if bloated.

---

</details>

<details class="qa-item">
<summary>3. MySQL primary key UUID — insert rate collapsed?</summary>

**Root cause.** Random UUID v4 as InnoDB clustered PK causes random page inserts and splits.

**Fix.** Use monotonic UUID v7 / ULID / BIGINT sequence; or UUID as secondary unique column.

---

</details>

<details class="qa-item">
<summary>4. `SELECT COUNT(*)` on 500M-row table kills production?</summary>

**Root cause.** Full index or heap scan; MVCC must visit visible rows (PG) or index traverse (InnoDB).

**Fix.** Approximate count (`pg_class.reltuples`, `EXPLAIN` estimate); maintain counter table; partition pruning for scoped counts.

---

</details>

<details class="qa-item">
<summary>5. Serializable transaction aborted with 40001 — users see random failures?</summary>

**Root cause.** PostgreSQL SSI detected rw-conflict; high contention on hot rows.

**Fix.** Retry logic; reduce tx scope; downgrade to RR/RC with explicit locking where needed; partition hot row.

---

</details>

<details class="qa-item">
<summary>6. Gap locks blocking inserts — InnoDB RR?</summary>

**Root cause.** Locking read `SELECT ... FOR UPDATE` on range locks gaps; concurrent inserts into gap wait.

**Fix.** Use RC for queue pattern if acceptable; index precise keys; `SKIP LOCKED`; shrink predicate range.

---

</details>

<details class="qa-item">
<summary>7. Flyway V2 edited after production deploy — dev broken?</summary>

**Root cause.** Checksum mismatch; Flyway refuses to migrate.

**Fix.** Never edit applied migrations; add V3 with fix. Use `flyway repair` only if you know exactly what you're doing.

---

</details>

<details class="qa-item">
<summary>8. App works in dev (100 rows), prod query timeout (100M rows)?</summary>

**Root cause.** Missing index; nested loop chosen due to bad stats; dev never representative.

**Fix.** EXPLAIN ANALYZE on staging clone; add index; update statistics; rewrite query.

---

</details>

<details class="qa-item">
<summary>9. Duplicate orders from double-click — only one should exist?</summary>

**Root cause.** No idempotency key unique constraint; two POSTs same payload.

**Fix.** `UNIQUE(idempotency_key)` + UPSERT returning same response hash.

---

</details>

<details class="qa-item">
<summary>10. Replica CPU high but primary fine?</summary>

**Root cause.** Analytics on replica; missing index same as primary; parallel replay workers; or many small commits replay overhead.

**Fix.** Index replica same as primary; throttle heavy queries; dedicated analytics replica.

---

</details>

<details class="qa-item">
<summary>11. `DELETE` faster than `TRUNCATE` team expected — opposite?</summary>

**Root cause.** TRUNCATE is fast but takes AccessExclusive lock (PG) / DDL lock; blocked by long tx. DELETE row-by-row slow but row locks only.

**Fix.** Drop/truncate partition instead; ensure no blocking idle tx before TRUNCATE.

---

</details>

<details class="qa-item">
<summary>12. Connection count 800 but only 20 app instances?</summary>

**Root cause.** Pool misconfigured 40 each; connection leak; pgbouncer not used; health checks opening new connections.

**Fix.** Audit `pg_stat_activity.application_name`; fix leak; deploy pgBouncer; set Hikari max sensibly.

---

</details>

<details class="qa-item">
<summary>13. Window function duplicate rows in report?</summary>

**Root cause.** Join before window multiplied rows; partition key wrong.

**Fix.** Subquery dedup first; apply window on deduped set; verify PARTITION BY keys.

---

</details>

<details class="qa-item">
<summary>14. Partial index not used by planner?</summary>

**Root cause.** Query predicate doesn't match index WHERE clause exactly; parameter type mismatch; stale stats.

**Fix.** Align predicate; cast consistently; ANALYZE; check `enable_indexscan`.

---

</details>

<details class="qa-item">
<summary>15. Sharded by user_id — cross-user report impossible?</summary>

**Root cause.** No single query path across shards.

**Fix.** Fan-out query aggregator service; or replicate to warehouse (BigQuery/Snowflake) for cross-shard analytics.

---

</details>

<details class="qa-item">
<summary>16. Liquibase rollback failed mid-deploy?</summary>

**Root cause.** Rollback script untested; data-dependent; DDL irreversible (DROP COLUMN).

**Fix.** Forward-fix migration; restore from backup if needed; treat rollbacks as emergency only — prefer expand-contract.

---

</details>

<details class="qa-item">
<summary>17. `OR` condition prevents index use?</summary>

**Root cause.** Optimizer can't merge single index scan efficiently.

**Fix.** Rewrite as `UNION ALL` of two indexed queries:

```sql
SELECT id FROM orders WHERE customer_id = 1 AND status = 'open'
UNION ALL
SELECT id FROM orders WHERE customer_id = 1 AND priority = 'urgent';
```

---

</details>

<details class="qa-item">
<summary>18. Hot row updated 1000/sec — throughput ceiling?</summary>

**Root cause.** Row-level serialization; single lock on counter/status row.

**Fix.** Shard counter (split buckets); append-only event log + async aggregate; partition by bucket id.

---

</details>

<details class="qa-item">
<summary>19. JSONB query slow without index?</summary>

**Root cause.** `payload->>'status' = 'active'` seq scans entire table.

**Fix.**

```sql
CREATE INDEX idx_events_status ON events ((payload->>'status'));
-- or JSONB GIN index for containment
CREATE INDEX idx_events_payload ON events USING GIN (payload jsonb_path_ops);
```

---

</details>

<details class="qa-item">
<summary>20. MySQL ONLY_FULL_GROUP_BY breaks legacy report?</summary>

**Root cause.** SELECT lists non-aggregated columns not in GROUP BY — previously allowed loose mode.

**Fix.** Fix query properly; don't disable ONLY_FULL_GROUP_BY globally — fix each report with correct GROUP BY or aggregate.

---

</details>

<details class="qa-item">
<summary>21. Prepared statement plan wrong after data distribution shift?</summary>

**Root cause.** Generic plan cached for parameter values that no longer match statistics (PG `plan_cache_mode`, MySQL plan cache). One popular `status='pending'` went from 1% to 40% of rows.

**Fix.** `ANALYZE` after bulk load; PostgreSQL `SET plan_cache_mode = force_custom_plan` for problematic stmt (session); rewrite query to avoid param on skewed column alone; partial index for hot value.

---

</details>

<details class="qa-item">
<summary>22. Citus / Vitess migration — global sequences exhausted?</summary>

**Root cause.** Sharded DB can't use single `SERIAL` — duplicate ids across shards.

**Fix.** Snowflake/UUID keys; or per-shard sequence ranges allocated by coordinator; never rely on auto-increment alone cross-shard.

</details>

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
