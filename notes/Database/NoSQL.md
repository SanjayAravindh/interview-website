# NoSQL Data Modeling — Senior Production Reference

MongoDB 7.x, Redis 7.x, Cassandra 4.1/5.0 and ScyllaDB, DynamoDB, Elasticsearch/OpenSearch 8.x, Neo4j 5.x, TimescaleDB. This is not a getting-started guide. It is the map of what actually breaks in production once the dataset outgrows one machine's RAM — the shard key that turns 40 nodes into 1, the unbounded array that hits the 16MB document ceiling on a Tuesday, the tombstone storm that makes a `SELECT` by primary key time out, the hot partition that throttles a table provisioned for 10× the traffic, and the dual write that silently forks your data into two versions of the truth.

The recurring theme: **NoSQL does not remove schema, it moves schema into application code and into a physical layout you can no longer change with `ALTER TABLE`.** In a relational database a bad design costs you a slow query. In a distributed NoSQL store a bad design costs you a migration.

---

## Table of Contents

1. [Mental Model: Choosing a Store](#1-mental-model-choosing-a-store)
2. [Document Databases (MongoDB)](#2-document-databases-mongodb)
3. [Key-Value Stores (Redis)](#3-key-value-stores-redis)
4. [Wide-Column Stores (Cassandra and ScyllaDB)](#4-wide-column-stores-cassandra-and-scylladb)
5. [DynamoDB and Single-Table Design](#5-dynamodb-and-single-table-design)
6. [Search Engines (Elasticsearch and OpenSearch)](#6-search-engines-elasticsearch-and-opensearch)
7. [Graph Databases (Neo4j)](#7-graph-databases-neo4j)
8. [Time-Series (TimescaleDB and InfluxDB)](#8-time-series-timescaledb-and-influxdb)
9. [Consistency, CAP, and Quorum Math](#9-consistency-cap-and-quorum-math)
10. [Polyglot Persistence and Data Ownership](#10-polyglot-persistence-and-data-ownership)
11. [Migration: Relational ↔ NoSQL](#11-migration-relational-nosql)
12. [Modeling Anti-Patterns Catalog](#12-modeling-anti-patterns-catalog)
13. [Cost and Operations](#13-cost-and-operations)
14. [Spring Data Integration](#14-spring-data-integration)
15. [Production Debugging Playbook](#15-production-debugging-playbook)
16. [Quick Decision Matrix](#16-quick-decision-matrix)

---


## 1. Mental Model: Choosing a Store

### Core concept

A relational database is a **general-purpose query engine**: you declare relations, and the planner invents an access path for whatever query arrives later. Every mainstream NoSQL store trades that generality away for a **physical layout that serves one shape of access pattern extremely well at scale**.

That trade has a precise consequence: in an RDBMS you model the *data*, then write queries. In Cassandra, DynamoDB, or a sharded MongoDB cluster you enumerate the *queries first*, then design storage so each query touches exactly one partition. If you cannot enumerate your queries, you are not ready to pick a NoSQL store.

The four questions that actually decide the store:

1. **What is the unit of access?** One aggregate by ID (document/KV), a time-ordered slice within a known key (wide-column), a full-text/faceted match over many docs (search), an unbounded traversal (graph).
2. **What is the partitioning dimension, and is it bounded?** `tenant_id` is a partitioning dimension. `tenant_id` is *not bounded* if one tenant is 60% of your volume.
3. **What consistency do writes need, and across how many entities?** Multi-entity invariants ("balance never negative across two accounts") are relational work until proven otherwise.
4. **What is the write rate and mutation shape?** Append-heavy immutable events, hot in-place counters, and read-mostly reference data have almost nothing in common physically.

### When relational still wins

Seniors are hired to say "no" here. Postgres/MySQL remains the correct default when:

| Signal | Why relational wins |
|---|---|
| Multi-entity invariants, money, inventory, entitlements | Real ACID transactions across arbitrary rows, foreign keys, `SERIALIZABLE` when needed |
| Ad-hoc and analytical queries you cannot predict | A cost-based planner beats hand-designed partitions for unknown queries |
| Data under ~a few TB with a working set that fits RAM | A single Postgres box with good indexes outruns a badly modeled 12-node cluster |
| Many-to-many relationships with equal traversal from both sides | A join table plus two indexes is cheaper than two denormalized tables you must keep in sync |
| Reporting/BI is a first-class requirement | SQL, window functions, and every BI tool on earth |
| Team has no distributed-systems on-call maturity | Repair, compaction, rebalancing, and quorum tuning are a full-time skill |

Postgres also absorbs a large slice of "we need NoSQL" requests: `jsonb` with GIN indexes covers semi-structured documents, `LISTEN/NOTIFY` and `SKIP LOCKED` cover light queueing, `tsvector` covers modest full-text, `pg_trgm` covers fuzzy match, TimescaleDB covers time-series, and logical replication covers CDC. Adding a second store means adding a second failure domain, a second backup story, a second on-call runbook, and a synchronization problem (see [Polyglot Persistence and Data Ownership](#10-polyglot-persistence-and-data-ownership)).

### Internal working

The families differ in **what is physically colocated on disk** and **what the write path costs**.

```
Document store (MongoDB / WiredTiger)
  key: _id (or shard key)  ->  one BSON blob, B-tree indexed, in-place-ish updates
  colocated: everything inside the document
  write path: journal (WAL) -> WiredTiger cache page -> checkpoint every 60s
  cost model: reads are cheap if working set is in cache; document growth causes rewrites

Key-value (Redis)
  key -> value in a single-threaded, in-memory hash table
  colocated: nothing; each key is independent (and lives on one cluster slot)
  write path: memory -> AOF buffer -> fsync (configurable) ; RDB fork snapshots
  cost model: O(1)-ish per op, but ONE slow command stalls every client

Wide-column (Cassandra / Scylla, LSM tree)
  partition key -> (clustering key -> columns), sorted on disk inside the partition
  colocated: the entire partition, sorted by clustering key
  write path: commitlog append + memtable -> flush to immutable SSTable -> compaction
  cost model: writes are ~free; reads may merge N SSTables + skip tombstones

Search (Lucene / Elasticsearch)
  term -> posting list of doc ids (inverted index), immutable segments
  colocated: nothing per-document; the index is term-oriented
  write path: buffer -> translog -> refresh creates a segment (default 1s) -> merge
  cost model: query is fast; indexing and merging burn CPU; updates = delete + reinsert

Graph (Neo4j)
  node -> direct pointers to relationship records (index-free adjacency)
  colocated: a node's edges
  write path: page cache + transaction log
  cost model: hop cost is independent of total graph size
```

Two derived rules that explain most production surprises:

- **LSM stores (Cassandra, Scylla, RocksDB-backed engines) make deletes expensive.** A delete is a write (a tombstone). Delete-heavy workloads degrade reads.
- **Immutable-segment stores (Lucene) make updates expensive.** An update marks the old doc deleted and indexes a new one; reclaiming space needs a merge.

### Production scenario: MongoDB chosen for a payments ledger

**Problem.** A payments team ships a ledger on MongoDB 4.0 because "documents are flexible." Six months in, finance reconciliation finds 1,900 accounts whose `balance` field disagrees with the sum of their `entries`. Support tickets cluster around retries and timeouts.

**Cause.** The service wrote the debit entry, the credit entry, and the two account balance updates as four independent operations. Any failure between them left a partial ledger. There was no cross-document atomicity (and even after upgrading to a replica set with transactions, the code kept the four-write shape). The team also used the balance field as a cache of a derived value with no invariant enforcing it.

**Solution.** Two changes: make the invariant structural, and make the write atomic.

```javascript
// 1. Make entries the source of truth; never store a balance you cannot recompute.
//    Balance becomes a computed pattern with an explicit version for optimistic locking.

// 2. If it must stay in MongoDB: one transaction, majority concerns, retryable.
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const ledger = db.collection("ledger_entries");
    const accounts = db.collection("accounts");

    await ledger.insertMany(
      [
        { txId, accountId: from, amount: -amountMinor, ts: new Date() },
        { txId, accountId: to,   amount:  amountMinor, ts: new Date() },
      ],
      { session, ordered: true }
    );

    // Guard the invariant in the filter, not in application code.
    const debit = await accounts.updateOne(
      { _id: from, balanceMinor: { $gte: amountMinor } },
      { $inc: { balanceMinor: -amountMinor }, $set: { updatedAt: new Date() } },
      { session }
    );
    if (debit.modifiedCount !== 1) throw new Error("INSUFFICIENT_FUNDS");

    await accounts.updateOne(
      { _id: to },
      { $inc: { balanceMinor: amountMinor }, $set: { updatedAt: new Date() } },
      { session }
    );
  }, {
    readConcern:  { level: "snapshot" },
    writeConcern: { w: "majority" },
    readPreference: "primary",
  });
} finally {
  await session.endSession();
}
```

```sql
-- What the team actually shipped in the end: Postgres for the ledger,
-- MongoDB kept only for the merchant-profile documents it was good at.
CREATE TABLE ledger_entry (
  id           bigserial PRIMARY KEY,
  tx_id        uuid        NOT NULL,
  account_id   bigint      NOT NULL REFERENCES account(id),
  amount_minor bigint      NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tx_account UNIQUE (tx_id, account_id)   -- idempotent retries
);

-- Invariant the database enforces, not the service:
ALTER TABLE account ADD CONSTRAINT balance_non_negative CHECK (balance_minor >= 0);
```

The senior lesson is not "MongoDB is bad." It is that `{ w: "majority" }` transactions on a replica set are a *narrow* tool with a 60-second default lifetime and a 16MB oplog-entry ceiling, while money needs an invariant the storage engine refuses to violate.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| Picking a store before enumerating access patterns | Every new feature needs a new secondary index, a scatter-gather query, or a migration |
| Treating "schemaless" as "no schema" | Five shapes of the same document in one collection; every reader is defensive parsing |
| Choosing a distributed store for a 200GB dataset | Higher latency, more ops burden, worse queries than one Postgres instance |
| Monotonically increasing shard/partition key (timestamp, autoincrement, ULID prefix) | One hot node/partition; the rest of the cluster idles |
| Multi-entity invariants enforced only in service code | Reconciliation drift that grows linearly with traffic |
| Adding a second store without deciding ownership | Dual writes, divergence, "which one is right?" incidents |
| Assuming NoSQL means "no migrations" | Backfills of billions of documents with no throttling, saturating the cluster |

### Debugging scenario

**Observe.** A product team reports "MongoDB is slow" three months after launch. p99 read latency went from 8ms to 900ms with only a 2× traffic increase.

**Diagnose.**

```javascript
// 1. Is it the working set or the query plan?
db.serverStatus().wiredTiger.cache["bytes currently in the cache"]
db.serverStatus().wiredTiger.cache["maximum bytes configured"]
db.serverStatus().wiredTiger.cache["pages read into cache"]   // rising fast = thrashing

// 2. What are the actual slow ops?
db.setProfilingLevel(1, { slowms: 100, sampleRate: 0.1 });
db.system.profile.aggregate([
  { $group: { _id: { ns: "$ns", plan: "$planSummary" },
              n: { $sum: 1 }, avgMs: { $avg: "$millis" },
              docs: { $avg: "$docsExamined" }, keys: { $avg: "$keysExamined" } } },
  { $sort: { n: -1 } }, { $limit: 20 }
]);

// 3. Ratio test: docsExamined / nReturned. > 100 means the index is not selective.
db.orders.find({ tenantId: 42, status: "OPEN" }).explain("executionStats");
```

Three findings, in order of likelihood: (a) `COLLSCAN` because a new query shape shipped without an index, (b) `IXSCAN` with a huge `keysExamined` because the compound index column order does not match the predicate/sort, (c) working set no longer fits WiredTiger cache so every read is a disk page fault.

**Fix.** The mental-model fix is different from the tactical fix. Tactically: add the compound index in equality-sort-range order, or raise RAM. Strategically: the collection grew unbounded because the design embedded an ever-growing array, so the working set per query grew with tenant age. That is a *modeling* bug, and no amount of RAM fixes it — see [Document Databases (MongoDB)](#2-document-databases-mongodb).

---

## 2. Document Databases (MongoDB)

### Core concept

A document store's unit of atomicity, of storage, and of retrieval is **one document**. Good MongoDB modeling means: *the data you read together lives together, and the data that grows without bound does not.* Those two rules conflict constantly, and resolving that conflict is the whole job.

BSON is not JSON. It is a binary, length-prefixed, typed format. The practical consequences:

- Every field name is stored **in every document**. `{"transactionAmountInMinorUnits": 1}` × 400M documents is tens of gigabytes of repeated field names. Short keys matter at scale.
- Types are explicit and comparison across types follows a fixed order (`MinKey < Null < Numbers < String < Object < Array < BinData < ObjectId < Boolean < Date < Timestamp < Regex < MaxKey`). `{ age: "30" }` and `{ age: 30 }` are different values and an index range query will silently miss one.
- `Decimal128` exists precisely because `double` cannot represent money. Use it, or store minor units as `long`.
- A document has a **hard 16MB limit** and a **100-level nesting limit**.

### Embedding vs referencing

| Choose embedding when | Choose referencing when |
|---|---|
| Child is read with the parent >90% of the time | Child is queried independently, or by other parents |
| Child count is bounded and small (tens, not thousands) | Child count is unbounded or grows with time |
| Child is updated with the parent (same transaction boundary) | Child is written at a much higher rate than parent |
| Total document stays comfortably under a few hundred KB | Aggregate would approach 16MB |
| One-to-few | One-to-many (many), many-to-many |

The failure mode nobody predicts: **document growth**. WiredTiger does not do in-place growth for a document that outgrows its allocated space; it rewrites the document. A document that grows from 2KB to 400KB by `$push` has been rewritten hundreds of times, each rewrite dirtying cache pages and writing full new versions to the journal and to the oplog. Replication traffic explodes because **the oplog entry for `$push` on a large array can approach the size of the array itself** in some update shapes, and cache pressure grows because the whole document must be resident to modify one element.

### Schema design patterns

**Subset pattern** — embed the hot slice, reference the cold rest.

```javascript
// Product with 8,000 reviews. Embed the 5 most recent; keep all in a separate collection.
// products
{
  _id: ObjectId("..."),
  sku: "SKU-1188",
  name: "Thermal Mug 500ml",
  price: NumberDecimal("18.90"),
  reviewCount: 8123,               // computed pattern
  ratingAvg: 4.31,                 // computed pattern
  recentReviews: [                 // subset pattern: BOUNDED by $slice on write
    { _id: ObjectId("..."), rating: 5, title: "Keeps heat", author: "kk", ts: ISODate("...") }
  ]
}

// Keep the subset bounded at write time — never rely on readers to trim.
db.products.updateOne(
  { _id: productId },
  {
    $push: { recentReviews: { $each: [review], $sort: { ts: -1 }, $slice: 5 } },
    $inc:  { reviewCount: 1 }
  }
);
```

**Bucket pattern** — turn high-frequency small writes into fewer, bounded documents. Essential for time-series and IoT.

```javascript
// BAD: one document per reading -> 2.6B docs/month, index bigger than data
{ deviceId: "d-91", ts: ISODate("2026-08-31T10:00:01Z"), tempC: 21.4 }

// GOOD: one bucket per device per hour, capped at 3600 samples
{
  _id: "d-91#2026-08-31T10",
  deviceId: "d-91",
  bucketStart: ISODate("2026-08-31T10:00:00Z"),
  bucketEnd:   ISODate("2026-08-31T11:00:00Z"),
  count: 3600,
  sumTempC: 77_040.0,           // pre-aggregated so dashboards never scan samples
  minTempC: 19.8,
  maxTempC: 23.1,
  samples: [ { t: 1, v: 21.4 }, { t: 2, v: 21.4 } /* offset seconds, not full dates */ ]
}

// Upsert into the current bucket; the count guard prevents unbounded growth.
db.readings.updateOne(
  { _id: `${deviceId}#${hourKey}`, count: { $lt: 3600 } },
  {
    $push: { samples: { t: offsetSec, v: value } },
    $inc:  { count: 1, sumTempC: value },
    $min:  { minTempC: value },
    $max:  { maxTempC: value },
    $setOnInsert: { deviceId, bucketStart, bucketEnd }
  },
  { upsert: true }
);
```

MongoDB 5.0+ has native **time-series collections** (`timeseries: { timeField, metaField, granularity }`) that implement bucketing internally with columnar compression. Use them for new telemetry workloads; the manual bucket pattern still matters for anything with custom pre-aggregation or for pre-5.0 clusters.

**Computed pattern** — store the answer, not the inputs, when reads outnumber writes by orders of magnitude. `reviewCount`, `ratingAvg`, `orderTotalMinor`. The rule: a computed field must be **recomputable from source data** by a reconciliation job, and the write that changes the source must update the computed field in the same atomic operation (same document, or same transaction).

**Extended reference pattern** — copy the few fields you always display alongside the reference, to eliminate a `$lookup`.

```javascript
// orders — copy the *immutable-at-time-of-order* customer fields.
{
  _id: ObjectId("..."),
  customer: { _id: ObjectId("..."), name: "K. Kowshiga", tier: "GOLD" }, // extended ref
  lines: [ { sku: "SKU-1188", qty: 2, unitPriceMinor: 1890 } ],
  totalMinor: 3780,
  placedAt: ISODate("2026-08-31T10:04:00Z")
}
```

The trap: extended references are **denormalized copies**, and copies go stale. Decide explicitly per field whether staleness is a bug or a feature. For an order, the customer's name *at order time* is correct history and must not be updated. For a product name shown in a cart, staleness is a bug and needs a CDC-driven fan-out update (see [Polyglot Persistence and Data Ownership](#10-polyglot-persistence-and-data-ownership)). Never denormalize a mutable field without owning the propagation path.

**Polymorphic / single-collection pattern** — different entity shapes in one collection, discriminated by a `type` field, so that one index serves a heterogeneous timeline. Pairs with a partial index per type.

### Indexes

```javascript
// Compound index — the ESR rule: Equality, Sort, Range (in that order).
// Query: find({ tenantId: 42, status: "OPEN", createdAt: { $gte: d } }).sort({ createdAt: -1 })
db.orders.createIndex({ tenantId: 1, status: 1, createdAt: -1 });
//                      ^equality   ^equality  ^sort+range (same field here)

// Prefix rule: this index serves { tenantId }, { tenantId, status },
// { tenantId, status, createdAt } — but NOT { status } alone.

// Multikey — automatically created when any indexed field is an array.
db.products.createIndex({ "tags": 1 });
// Constraint: at most ONE array field per compound index (no parallel arrays),
// and multikey indexes cannot be used to provide a covered projection.

// Partial — index only the rows you query. Massive win on skewed status fields.
db.orders.createIndex(
  { tenantId: 1, createdAt: -1 },
  { partialFilterExpression: { status: "OPEN" } }
);
// The query MUST include a predicate that is provably a subset of the filter
// expression, or the planner will not use it. find({tenantId:42}) alone: not used.

// Sparse — legacy cousin of partial; prefer partial.
// TTL — background deleter, granularity ~60s, single-field date index only.
db.sessions.createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 1800 });

// Unique + partial: enforce uniqueness only among non-deleted rows.
db.users.createIndex(
  { email: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $exists: false } } }
);

// Wildcard — for genuinely unpredictable user-defined attribute keys.
db.events.createIndex({ "attrs.$**": 1 });

// Build without blocking writes in production (default since 4.2 is already
// optimized, but always be explicit about rollout on huge collections):
db.orders.createIndex({ tenantId: 1, status: 1 }, { name: "tenant_status", background: true });
```

Index costs that get forgotten: every index is written on every insert and on every update that touches an indexed field; every index consumes WiredTiger cache and competes with documents for RAM; and index entries for TTL deletions still generate oplog traffic. A collection with 14 indexes has a write amplification problem, not an index problem.

Use `$indexStats` to find indexes nobody uses:

```javascript
db.orders.aggregate([{ $indexStats: {} }])
  .toArray()
  .filter(i => i.accesses.ops === 0);   // candidates for removal (check all replicas!)
```

### Aggregation pipeline

Stage order is the optimization. The pipeline is executed as written, minus a set of optimizer rewrites you should not rely on.

```javascript
db.orders.aggregate([
  // 1. $match FIRST, and make it index-eligible. This is the only stage that can
  //    use an index (plus $sort, $geoNear, and a $group with $first on the sort key).
  { $match: { tenantId: 42, placedAt: { $gte: startOfMonth } } },

  // 2. $project/$unset early to shrink documents before expensive stages.
  { $project: { customer: 1, lines: 1, totalMinor: 1, placedAt: 1 } },

  // 3. $unwind explodes the doc count; do it after $match, never before.
  { $unwind: "$lines" },

  { $group: {
      _id: "$lines.sku",
      units: { $sum: "$lines.qty" },
      revenueMinor: { $sum: { $multiply: ["$lines.qty", "$lines.unitPriceMinor"] } },
      orders: { $addToSet: "$_id" }        // careful: $addToSet is unbounded memory
  }},
  { $addFields: { orderCount: { $size: "$orders" } } },
  { $unset: "orders" },

  { $sort: { revenueMinor: -1 } },
  { $limit: 50 },

  // $lookup last, on 50 docs, not on 4 million.
  { $lookup: {
      from: "products",
      localField: "_id",
      foreignField: "sku",
      as: "product",
      pipeline: [ { $project: { name: 1, category: 1 } } ]  // 5.0+: filter inside lookup
  }},
  { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } }
], {
  allowDiskUse: true,        // required if any blocking stage exceeds 100MB
  maxTimeMS: 15000,          // ALWAYS bound an analytical pipeline
  comment: "sku-revenue-report"   // shows up in currentOp/profiler — do this
});
```

Hard limits and behaviors worth memorizing:

| Thing | Limit / behavior |
|---|---|
| Blocking stage memory (`$group`, `$sort`, `$bucket`, `$setWindowFields`) | 100MB, then error unless `allowDiskUse: true` (6.0+ spills by default for `$group`/`$sort`) |
| Result document | 16MB per returned document (use `$out`/`$merge` or a cursor) |
| Pipeline stages | 1000 |
| `$lookup` | Nested-loop-ish; needs an index on `foreignField` or it is a collection scan per input doc |
| `$graphLookup` | 100MB memory cap, cannot be sharded-collection targeted in some versions |
| `$out` | Replaces the whole target collection, drops its indexes; `$merge` upserts and keeps them |
| `$facet` | Runs sub-pipelines on the same input; cannot use indexes inside facets |

### `explain()`

```javascript
db.orders.find({ tenantId: 42, status: "OPEN" })
         .sort({ createdAt: -1 }).limit(20)
         .explain("executionStats");
```

Read it in this order:

1. `winningPlan.stage` — `IXSCAN` (good), `FETCH` over `IXSCAN` (normal), `COLLSCAN` (usually a bug), `SORT` (in-memory sort — the sort was **not** served by the index).
2. `executionStats.nReturned` vs `totalKeysExamined` vs `totalDocsExamined`. The target is `nReturned ≈ docsExamined`. A ratio above ~10 means the index is not selective enough; above 100 means you effectively have no index.
3. `SORT` stage present with `memLimit`/`totalDataSizeSorted` — the query is sorting in memory (32MB cap for a non-`allowDiskUse` find). Fix the index order.
4. `PROJECTION_COVERED` — the query never touched a document. That is the goal for high-QPS lookups.
5. `rejectedPlans` — if the planner keeps re-evaluating, and if a plan-cache entry pinned a bad plan, look at `db.orders.getPlanCache().list()`.
6. `executionTimeMillis` on a **warm** cache vs cold. First run reads pages from disk; don't tune on cold numbers.

`explain("allPlansExecution")` shows the trial period of every candidate plan — that is how you catch a plan-cache flip where the same query is fast for one parameter and slow for another (parameter-sensitive plan).

### Working set vs RAM

WiredTiger's internal cache defaults to `max(50% of (RAM - 1GB), 256MB)`. The filesystem cache uses much of the rest (compressed pages). Your **working set** is the set of index pages plus document pages touched by normal traffic in a window.

The number that matters is the cache eviction/read-in rate, not the size:

```javascript
const s = db.serverStatus().wiredTiger.cache;
s["bytes currently in the cache"];
s["maximum bytes configured"];
s["pages read into cache"];            // delta/sec climbing = working set > cache
s["tracked dirty bytes in the cache"]; // >5% of max and app-thread evictions = write pressure
s["eviction worker thread evicting pages"];
db.serverStatus().wiredTiger["cache"]["pages evicted by application threads"]; // must be ~0
```

If application threads are evicting pages, user requests are paying for cache management. That shows up as latency spikes uncorrelated with query complexity. Fixes, in order of leverage: reduce document size (subset pattern, drop unused fields, shorter field names), drop unused indexes, add RAM, then shard.

### Write concern, read concern, read preference

These are three independent axes and confusing them causes most "MongoDB lost my write" reports.

```javascript
// Write concern — how many members must acknowledge, and is it on disk?
{ w: 1 }                       // primary only: a failover can roll this write back
{ w: "majority" }              // durable across a failover. DEFAULT since 5.0.
{ w: "majority", j: true }     // majority AND journaled on those members
{ w: "majority", wtimeout: 5000 }  // ALWAYS set a timeout, or a degraded PSA set hangs writes
```

```javascript
// Read concern — what snapshot am I allowed to see?
{ level: "local" }        // may include writes that later roll back
{ level: "available" }    // sharded: may return orphaned documents. Fastest, least safe.
{ level: "majority" }     // only majority-committed data (no rollback), but can be stale
{ level: "snapshot" }     // transactions: a single consistent point in time
{ level: "linearizable" } // primary only, single doc, real-time; SLOW — pairs with w:majority
```

```javascript
// Read preference — which member do I talk to?
"primary"             // default; strongest, no scaling
"primaryPreferred"
"secondary"
"secondaryPreferred"  // the classic "let's scale reads" choice — and the classic bug
"nearest"
// Bound the staleness you accept, and tag-route analytics away from OLTP members:
{ mode: "secondary", maxStalenessSeconds: 90, tags: [{ workload: "analytics" }] }
```

The read-your-own-writes trap: `w: "majority"` + `readPreference: secondaryPreferred` does **not** guarantee you read your write. Secondaries apply the oplog asynchronously. Either read from the primary for the read-after-write path, or use **causal consistency**:

```javascript
const session = client.startSession({ causalConsistency: true });
const users = client.db("app").collection("users");
await users.updateOne({ _id: id }, { $set: { tier: "GOLD" } },
                      { session, writeConcern: { w: "majority" } });
// Same session -> afterClusterTime is attached -> the secondary waits until it has caught up.
const fresh = await users.findOne({ _id: id },
                      { session, readConcern: { level: "majority" } });
```

### Transactions

Multi-document transactions exist on replica sets (4.0+) and sharded clusters (4.2+), but they are a **narrow** tool:

| Limit | Value / effect |
|---|---|
| Default lifetime | 60s (`transactionLifetimeLimitSeconds`); then aborted, cache is released |
| Oplog entry | A transaction's changes must fit MongoDB's oplog entry rules; huge transactions fail or fragment |
| Write conflicts | Optimistic; concurrent write to the same document → `TransientTransactionError` (`WriteConflict`). You must retry. |
| Cache | Uncommitted transaction data pins WiredTiger cache; long transactions cause cluster-wide eviction pressure |
| DDL | Cannot create collections/indexes inside a transaction (mostly relaxed in 4.4+, still avoid) |
| Sharded | Two-phase commit across shards: much slower, and cross-shard transactions amplify latency |
| Read concern | Must be `snapshot`, `majority`, or `local`; `snapshot` is the useful one |

Always use the driver's `withTransaction` helper — it implements the required retry loop for `TransientTransactionError` and `UnknownTransactionCommitResult`. Hand-rolled `startTransaction`/`commitTransaction` without retries is a latent data-loss bug.

The senior instinct: if you need a transaction on every write path, your document boundaries are wrong (or the workload is relational).

### Sharding

```javascript
sh.enableSharding("app");

// Ranged: good for range queries on the key, bad if the key is monotonic.
sh.shardCollection("app.orders", { tenantId: 1, placedAt: 1 });

// Hashed: uniform distribution, but destroys range-query targeting.
sh.shardCollection("app.events", { deviceId: "hashed" });

// Compound hashed (4.4+): hash the high-cardinality prefix, keep a range suffix.
sh.shardCollection("app.readings", { deviceId: "hashed", ts: 1 });
```

Shard key selection is the single highest-stakes decision in a MongoDB cluster. Four properties, all required:

1. **High cardinality** — the number of distinct values bounds the number of chunks. `{ country: 1 }` gives you ~200 possible chunks max, and a hard ceiling on scalability.
2. **Low frequency (even distribution)** — cardinality is not enough. `{ tenantId: 1 }` with one tenant at 60% of traffic gives you a hot shard forever.
3. **Non-monotonic** — `{ createdAt: 1 }` or `{ _id: 1 }` (ObjectId is time-prefixed) sends every insert to the chunk holding `MaxKey`. One shard takes 100% of writes while the balancer chases it.
4. **Present in your queries** — a query without the shard key is a **scatter-gather**: mongos fans out to every shard, merges, and your p99 becomes the slowest shard's p99. Sorting or `skip` on a scatter-gather is worse.

**Jumbo chunks.** A chunk that cannot be split because all its documents share one shard-key value gets marked `jumbo` and stops being balanced. Symptoms: `sh.status()` shows wildly uneven chunk counts, one shard's disk fills, the balancer logs "chunk too big to move." Root cause is always low cardinality or high frequency in the shard key. Mitigation: `refineCollectionShardKey` (4.4+) to append a higher-cardinality suffix, or `reshardCollection` (5.0+) to rewrite the collection with a new key — plan for it to copy the entire collection.

```javascript
// 4.4+: append a suffix to increase cardinality. Requires an index on the new key.
db.adminCommand({
  refineCollectionShardKey: "app.orders",
  key: { tenantId: 1, placedAt: 1, _id: 1 }
});

// 5.0+: full resharding. This rewrites all data — schedule it, watch disk and oplog.
db.adminCommand({
  reshardCollection: "app.orders",
  key: { tenantId: "hashed" },
  numInitialChunks: 512
});
```

Also: **pre-split before a bulk load** into a hashed or known-range key, or the whole load lands on one shard while the balancer slowly reacts. And remember the balancer is a background process competing for the same IO as your traffic — use `sh.setBalancerState` windows for heavy periods.

### Change streams

```javascript
const stream = db.collection("orders").watch(
  [
    { $match: { operationType: { $in: ["insert", "update", "replace"] } } },
    { $project: { "fullDocument.internalNotes": 0 } }
  ],
  {
    fullDocument: "updateLookup",           // or "whenAvailable" with pre/post images (6.0+)
    fullDocumentBeforeChange: "whenAvailable",
    resumeAfter: savedResumeToken,          // persist this transactionally with your side effect
    maxAwaitTimeMS: 1000
  }
);

for await (const change of stream) {
  await handle(change);                     // must be idempotent — at-least-once delivery
  await saveResumeToken(change._id);        // persist AFTER the side effect
}
```

Operational truths: change streams read the **oplog**, so if your consumer is down longer than the oplog window you get `ChangeStreamHistoryLost` and must do a full resync. Size the oplog for your worst expected consumer outage (hours, not minutes) and alert on oplog window, not on oplog size. `updateLookup` re-reads the current document, so it can return a *newer* version than the event described — do not treat it as an event-sourced log. Change streams require `majority` read concern support and a replica set.

### Production scenario: unbounded array kills a collection

**Problem.** A notifications service stores one document per user with an embedded `notifications` array. Nine months in: p99 write latency 4s, replication lag spikes to 90s during peak, and some users get `BSONObjectTooLarge: object to insert too large` errors. Reads of a single user document occasionally transfer 12MB.

**Cause.** Unbounded `$push`. Power users accumulated 40,000+ notifications. Each `$push` forced WiredTiger to rewrite a multi-megabyte document, each rewrite generated a large oplog entry, and secondaries could not keep up. The 16MB ceiling then started rejecting writes outright for the heaviest users.

**Solution.** Split the growth dimension out, keep a bounded subset for the UI's first screen, and add a TTL so the collection stops growing forever.

```javascript
// 1. New collection: one document per notification, keyed for the exact read pattern.
db.createCollection("notifications");
db.notifications.createIndex({ userId: 1, createdAt: -1 });
db.notifications.createIndex({ userId: 1, readAt: 1 },
  { partialFilterExpression: { readAt: null } });          // unread badge count
db.notifications.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

// 2. User document keeps only bounded, hot state (subset + computed patterns).
db.users.updateOne({ _id: userId }, {
  $set: { unreadCount: 0 },
  $unset: { notifications: "" }
});

// 3. Write path: insert + bounded preview + counter, in one transaction.
await session.withTransaction(async () => {
  await db.notifications.insertOne({ ...n, userId, createdAt: now, readAt: null }, { session });
  await db.users.updateOne({ _id: userId }, {
    $inc:  { unreadCount: 1 },
    $push: { preview: { $each: [{ id: n._id, title: n.title, ts: now }],
                        $sort: { ts: -1 }, $slice: 10 } }
  }, { session });
}, { writeConcern: { w: "majority" } });

// 4. Read path: cursor pagination on the compound index, never skip().
db.notifications
  .find({ userId, createdAt: { $lt: cursorTs } })
  .sort({ createdAt: -1 })
  .limit(25);
```

Backfill ran as a throttled job that read each user document, `insertMany`'d the array in 500-doc batches, then `$unset` the array — 60M notifications over four days at a rate that kept replication lag under 2s. The rate limiter was driven by measured lag, not by a fixed sleep.

### Production scenario: monotonic shard key wastes 11 of 12 shards

**Problem.** A 12-shard cluster ingesting clickstream data. `mongostat` shows shard 12 at 95% CPU with 30k inserts/sec while shards 1–11 sit near idle. The balancer runs constantly. Insert latency p99 is 700ms.

**Cause.** `sh.shardCollection("app.clicks", { eventTime: 1 })`. Every insert has `eventTime = now`, which falls in the chunk whose upper bound is `MaxKey`. That chunk lives on exactly one shard. The balancer splits and migrates it, and the new max chunk instantly becomes hot again.

**Solution.**

```javascript
// Compound hashed key: hash a high-cardinality prefix, keep time for range scans
// *within* a session. Pre-split so the load spreads from op #1.
db.adminCommand({
  reshardCollection: "app.clicks",
  key: { sessionId: "hashed", eventTime: 1 },
  numInitialChunks: 1024
});

// Verify targeting for the top query shapes — no SHARD_MERGE over all shards.
db.clicks.find({ sessionId: "s-123", eventTime: { $gte: t0 } }).explain()
  .queryPlanner.winningPlan.shards.length;   // want 1

// The analytics query that needs "all clicks in the last hour" is NOT a shard-key
// query. Move it off the OLTP cluster: $merge to a rollup collection, or ship to
// a warehouse via change streams. Do not scatter-gather 12 shards on the read path.
```

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| Unbounded `$push` into an embedded array | Growing latency, replication lag, eventual `BSONObjectTooLarge` at 16MB |
| Monotonic shard key (`_id`, timestamp, sequence) | One hot shard, idle cluster, constant balancer churn |
| `{ w: 1 }` on business-critical writes | Writes silently rolled back after a primary failover |
| `secondaryPreferred` for read-after-write | Users see stale data; "my update didn't save" tickets |
| `w: "majority"` with no `wtimeout` on a PSA (primary-secondary-arbiter) set | Writes block indefinitely when the data-bearing secondary is down |
| Auto index creation in the app (`auto-index-creation: true`) | Surprise index builds on deploy; unindexed queries in prod that "worked locally" |
| `skip`/`limit` pagination on large collections | Page 500 scans 12,500 documents; latency grows linearly with page number |
| Compound index order not matching ESR | `IXSCAN` with huge `keysExamined` plus an in-memory `SORT` stage |
| Storing money as `double` | Rounding drift in totals; reconciliation failures |
| Field names like `transactionAmountInMinorUnits` on billions of docs | Tens of GB of pure field-name overhead; smaller effective cache |
| No `maxTimeMS` on aggregations | One report query pins cache and CPU for minutes |
| `$lookup` with no index on `foreignField` | Collection scan per input document; pipeline goes from 200ms to 6 minutes |
| Oplog sized for "normal" lag only | `ChangeStreamHistoryLost` / secondary requires full initial sync after a 2-hour incident |
| Mixed types in an indexed field (`"30"` vs `30`) | Range queries silently miss documents |

### Debugging scenario

**Observe.** Writes to one collection intermittently take 2–8 seconds. No schema change shipped. CPU is fine. Disk IO shows write bursts every ~60 seconds.

**Diagnose.**

```javascript
// 1. What is running right now, and what is it waiting on?
db.currentOp({ "secs_running": { $gte: 1 }, "active": true }).inprog
  .map(o => ({ op: o.op, ns: o.ns, secs: o.secs_running,
               waiting: o.waitingForLock, plan: o.planSummary, msg: o.msg }));

// 2. Is it checkpoint / cache pressure? (60s cadence is the WiredTiger checkpoint)
db.serverStatus().wiredTiger.cache["tracked dirty bytes in the cache"];
db.serverStatus().wiredTiger.cache["pages evicted by application threads"]; // want 0
db.serverStatus().wiredTiger.transaction["transaction checkpoint most recent time (msecs)"];

// 3. Is it replication? w:majority waits for secondaries.
rs.printSecondaryReplicationInfo();
db.serverStatus().metrics.repl.buffer;
db.getSiblingDB("local").oplog.rs.find().sort({ $natural: -1 }).limit(1).next().wall;

// 4. Is one document being rewritten repeatedly? Look at oplog entry sizes.
db.getSiblingDB("local").oplog.rs.aggregate([
  { $match: { ns: "app.users", op: "u" } },
  { $project: { size: { $bsonSize: "$$ROOT" }, ns: 1 } },
  { $sort: { size: -1 } }, { $limit: 10 }
]);
```

Findings: oplog entries for `app.users` updates averaged 900KB. `pages evicted by application threads` was nonzero. Dirty bytes hit the 20% trigger every checkpoint.

**Fix.** The 60-second cadence pointed at checkpoints, but the *cause* was giant dirty pages from rewriting large documents. Splitting the growing array out of the user document (previous scenario) dropped average oplog entry size to 400 bytes and eliminated the periodic stall. Raising cache size would only have moved the cliff.

---

## 3. Key-Value Stores (Redis)

### Core concept

Redis is a **single-threaded, in-memory data structure server**. Two words in that sentence drive every design decision:

- **In-memory**: your entire keyspace must fit in RAM (plus fork headroom). Redis is not a store you "grow into"; you capacity-plan it.
- **Single-threaded** (for command execution — networking is threaded in 6+, and 7.x adds more I/O threading, but the command loop is still one thread): **one slow command blocks every other client**. `KEYS *` on 40M keys is a multi-second global outage.

The senior question is never "should we use Redis?" It is "is Redis the **cache** or the **system of record** for this data?" The answer changes everything about persistence, eviction, and failover configuration.

| Aspect | Redis as cache | Redis as datastore |
|---|---|---|
| Data loss tolerance | Total loss is a latency event | Total loss is an incident |
| `maxmemory-policy` | `allkeys-lru` / `allkeys-lfu` | `noeviction` (and alert on memory, never evict) |
| Persistence | Optional; RDB for warm restart | AOF `everysec` + RDB, plus replicas |
| TTL | On everything | Only where semantically correct |
| Source of truth | Elsewhere; Redis is rebuildable | Redis; needs backups and PITR thinking |
| Failure plan | Fall through to the database | Failover, and accept async replication loss |

Mixing both in one instance is the most common Redis architecture mistake: an `allkeys-lru` policy will happily evict your "datastore" keys to make room for cache keys.

### Internal working

```
Client ──RESP──> [ I/O threads ] ──> [ single-threaded command loop ]
                                          ├─ dict (hash table) : key -> robj
                                          ├─ expires dict      : key -> expire-at-ms
                                          ├─ per-type encodings (listpack/intset/skiplist/quicklist)
                                          └─ propagation
                                               ├─ AOF buffer  -> fsync per policy
                                               ├─ replication backlog -> replicas (ASYNC)
                                               └─ keyspace notifications (optional)

Background: BGSAVE forks (copy-on-write), AOF rewrite forks, active expire cycle,
            lazy-free threads (UNLINK / lazyfree-* configs)
```

Two internals that explain most incidents:

- **`fork()` for BGSAVE/AOF-rewrite**. The child shares pages copy-on-write. If the parent keeps writing during the snapshot, the OS copies pages, and RSS can approach **2×** the dataset. Combined with `vm.overcommit_memory=0` you get a failed fork and `MISCONF Redis is configured to save RDB snapshots, but it's currently not able to persist` → **all writes rejected**. Set `vm.overcommit_memory=1` and disable transparent huge pages (THP causes 2MB copies instead of 4KB, spiking latency during fork).
- **Encodings**. Small collections use compact representations (`listpack`, `intset`) and convert to full structures past a threshold (`hash-max-listpack-entries`, `set-max-intset-entries`, `zset-max-listpack-entries`). A hash with 100 fields may use 1/10th the memory of one with 200. This is why "many small hashes" beats "one giant hash" *and* beats "many top-level keys" (each top-level key has ~50–90 bytes of dict/robj/expire overhead).

### Data structures and when each is correct

```bash
# STRING — counters, serialized blobs, bitmaps, distributed locks.
SET session:9f3a "<json>" EX 1800
INCRBY  metrics:req:2026-08-31 1
SETRANGE / GETRANGE                      # in-place binary edits
SETBIT  feature:beta:users 918273 1      # 1 bit per user = 12MB for 100M users
BITCOUNT feature:beta:users
# Correct distributed lock: unique token + TTL, released via Lua compare-and-delete.
SET lock:invoice:42 $token NX PX 5000

# HASH — an object with independently updatable fields. Avoids read-modify-write of a blob.
HSET user:1001 name "K" tier GOLD lastSeen 1756640000
HINCRBY user:1001 loginCount 1
HEXPIRE user:1001 3600 FIELDS 1 lastSeen   # 7.4+: per-field TTL

# LIST — queues (prefer Streams), capped activity logs, stacks.
LPUSH  feed:1001 "$eventId"
LTRIM  feed:1001 0 199                    # BOUND IT. Always.
BRPOPLPUSH src dst 0                      # reliable-ish queue; superseded by Streams

# SET — membership, unique visitors, tags, relationship sets.
SADD  tag:redis post:91 post:92
SINTERCARD 2 tag:redis tag:java           # 7.0+: cardinality without materializing
# SINTERSTORE on two 10M-member sets is an O(N) blocking command. Beware.

# ZSET (sorted set) — leaderboards, priority queues, time-ordered indexes, rate limiters.
ZADD leaderboard:2026-08 GT CH 4820 user:1001
ZRANGE leaderboard:2026-08 0 9 REV WITHSCORES
ZRANGEBYSCORE delayed:jobs -inf 1756640000 LIMIT 0 100   # delay queue pattern
ZREMRANGEBYSCORE ratelimit:ip:1.2.3.4 -inf $windowStart  # sliding-window rate limit

# STREAM — append-only log with consumer groups. The right queue primitive in Redis.
XADD orders:events MAXLEN ~ 1000000 '*' type created orderId 42

# HYPERLOGLOG — cardinality in 12KB with ~0.81% error. Not a set; cannot enumerate.
PFADD  uv:2026-08-31 user:1001 user:1002
PFCOUNT uv:2026-08-31
PFMERGE uv:2026-08 uv:2026-08-01 uv:2026-08-02

# GEO (zset under the hood) — proximity search.
GEOADD drivers 77.5946 12.9716 driver:7
GEOSEARCH drivers FROMLONLAT 77.60 12.97 BYRADIUS 3 km ASC COUNT 10
```

Memory reality check: a top-level key costs roughly 50–90 bytes of overhead before its value. 100M tiny keys ≈ 6–9GB of pure overhead. Grouping related fields into hashes (bucketing by a hash of the id) is the standard fix and can cut memory by 5–10×.

### Persistence: RDB vs AOF

| | RDB | AOF |
|---|---|---|
| What it is | Point-in-time binary snapshot | Append-only log of write commands |
| Trigger | `save 900 1` style rules, or `BGSAVE` | Every write, buffered |
| Durability | Lose everything since last snapshot | `appendfsync everysec` → lose ≤1s; `always` → ~none, big latency cost |
| Restart speed | Fast (compact binary load) | Slower (replay), unless `aof-use-rdb-preamble yes` |
| Fork cost | One fork per snapshot | One fork per rewrite (`auto-aof-rewrite-percentage 100`) |
| Disk | Small | Larger; grows until rewrite |

The production default for a Redis **datastore**: both on. `appendfsync everysec`, `aof-use-rdb-preamble yes` (7.x uses a multi-part AOF with a base RDB), plus periodic RDB for offsite backup. For a pure **cache**, RDB only (or nothing) — but be aware that with persistence enabled and a failed background save, Redis stops accepting writes (`stop-writes-on-bgsave-error yes`).

Critical caveat: **Redis replication is asynchronous.** `WAIT numreplicas timeout` gives you a weak barrier (it waits for replica acknowledgement of the replication offset, but does not make the write transactional). A failover can lose acknowledged writes. If that is unacceptable, Redis is the wrong system of record.

### Keyspace design

```
<app>:<entity>:<id>:<sub>        app:user:1001:profile
<app>:<entity>:<id>              app:order:8821
<app>:idx:<field>:<value>        app:idx:email:kk@example.com -> "1001"
```

Rules that survive contact with production:

1. **Colon-namespaced, fixed-arity keys.** You must be able to write a regex for every key family, because one day you will need to find and delete a family.
2. **Never `KEYS` in production.** Use `SCAN` with a cursor and `COUNT`, and accept that SCAN gives weak guarantees (no duplicates missed for keys present throughout, possible duplicates).
3. **Encode the version in the key prefix** (`v2:user:1001`) so a format change is a new keyspace, not a migration.
4. **Every key gets a TTL unless you can explain why not.** Untracked keys without TTL are how a cache becomes a 400GB memory leak.
5. **Keep keys and values small.** A 10MB value is a "big key": it blocks the event loop on serialization, blocks on `DEL` (use `UNLINK`), makes replication bursty, and skews cluster slot balance.

```bash
# Safe iteration and deletion of a key family
redis-cli --scan --pattern 'v1:session:*' | xargs -L 500 redis-cli UNLINK
# Better inside the app: SCAN cursor loop with COUNT 500 and a rate limiter.
```

### Expiration internals

Redis expires keys two ways: **lazily** (on access) and **actively** (a background cycle samples 20 keys from the expires dict, deletes the expired ones, and repeats if >25% were expired, bounded to ~25% of CPU time). Consequences:

- `INFO keyspace` can report more keys than are logically alive.
- A large burst of keys expiring at the same second causes a latency bump and a replication burst (the primary propagates explicit `DEL`s to replicas — **replicas do not expire keys on their own** for reads; they wait for the primary's DEL, though logically-expired keys are hidden from reads).
- **Jitter your TTLs.** `EX 3600` for a million keys written in the same minute creates a synchronized expiry stampede an hour later, which becomes a database stampede. Use `3600 + random(0, 600)`.

`maxmemory-policy` decides what happens at the ceiling:

| Policy | Behavior | Use for |
|---|---|---|
| `noeviction` | Writes fail with OOM error; reads still work | Datastore / queue |
| `allkeys-lru` | Evict least-recently-used from all keys | Pure cache |
| `allkeys-lfu` | Evict least-*frequently*-used (better for skewed access) | Pure cache, hot-set heavy |
| `volatile-lru` / `volatile-ttl` | Evict only keys with a TTL | Mixed instance (still risky) |
| `allkeys-random` | Cheap, dumb | Rarely correct |

`volatile-*` policies have a nasty failure mode: if **no** keys have a TTL, Redis behaves like `noeviction` and starts rejecting writes even though the policy says "evict."

### Redis Cluster and hash slots

Redis Cluster shards the keyspace into **16384 hash slots**, `slot = CRC16(key) mod 16384`, with slots assigned to primaries. Clients cache the slot→node map and follow `MOVED` (permanent) and `ASK` (in-flight migration) redirects.

The rule that breaks naive code: **multi-key commands only work if all keys hash to the same slot.** Otherwise: `CROSSSLOT Keys in request don't hash to the same slot`.

```bash
# Hash tags force colocation: only the substring inside {} is hashed.
MSET {user:1001}:profile "..." {user:1001}:prefs "..."   # same slot, MSET works
SUNIONSTORE {tenant:42}:result {tenant:42}:a {tenant:42}:b

# Lua scripts must declare ALL keys in KEYS[] and they must share a slot.
EVAL "return redis.call('GET', KEYS[1]) .. redis.call('GET', KEYS[2])" 2 \
     "{u:9}:a" "{u:9}:b"
```

Hash tags are a double-edged sword: overusing one tag (`{global}`) puts your entire dataset in one slot on one node. Use them for genuinely-transactional key groups only, and keep tag cardinality high.

Other cluster realities: `SELECT` (multiple DBs) is unsupported; transactions and Lua are per-slot; a `KEYS`/`SCAN` sweep must be run per node; resharding moves slots while serving traffic (expect `ASK` redirects); and a primary with no reachable replica plus `cluster-require-full-coverage yes` takes the **whole cluster** down for writes when it fails.

### Lua scripting and atomicity

A Lua script (or a 7.x `FUNCTION`) runs **atomically**: no other command interleaves. That makes it the correct tool for read-modify-write logic that must not race — but the same property means **a slow script blocks the entire server**, and `SCRIPT KILL` cannot kill a script that has already written.

```lua
-- Correct lock release: only the owner may delete. Compare-and-delete must be atomic.
-- KEYS[1] = lock key, ARGV[1] = token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
```

```lua
-- Atomic sliding-window rate limiter (no race between count and add).
-- KEYS[1] = ratelimit key, ARGV[1] = now_ms, ARGV[2] = window_ms, ARGV[3] = limit
local now, window, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  return {0, count}
end
redis.call('ZADD', KEYS[1], now, now .. '-' .. math.random(1e9))
redis.call('PEXPIRE', KEYS[1], window)
return {1, count + 1}
```

Rules: keep scripts O(small); never generate keys inside the script (breaks cluster routing and replication determinism); prefer `redis.call` over `pcall` unless you handle the error; use `EVALSHA` with a `SCRIPT LOAD` fallback on `NOSCRIPT`; and remember that since Redis 5 scripts replicate their **effects**, not the script, so `math.random` and `TIME` are usable but should still be passed in as ARGV for testability.

`MULTI/EXEC` is *not* a transaction with rollback — it is a batched, atomic-execution queue. A command that fails at runtime does not abort the others. `WATCH` gives optimistic concurrency (the `EXEC` returns nil if a watched key changed), which is fine for low contention but livelocks under high contention. Prefer Lua.

### Redis Streams as a queue

```bash
XADD orders:events MAXLEN ~ 1000000 '*' type ORDER_CREATED orderId 42 tenantId 7
XGROUP CREATE orders:events fulfilment '$' MKSTREAM
XREADGROUP GROUP fulfilment worker-3 COUNT 32 BLOCK 5000 STREAMS orders:events '>'
XACK orders:events fulfilment 1756640000123-0

# Recover messages abandoned by a dead consumer (the Pending Entries List).
XAUTOCLAIM orders:events fulfilment worker-3 60000 0 COUNT 100
XPENDING orders:events fulfilment - + 10          # inspect stuck messages
```

Streams give you consumer groups, at-least-once delivery, a per-consumer Pending Entries List (PEL), and an explicit ack. What they do **not** give you: a dead-letter queue (you build it — check `delivery_count` from `XPENDING` and `XADD` to a DLQ stream, then `XACK`), unbounded retention (you must trim: `MAXLEN ~ N` or `XTRIM MINID`), or partitions (one stream is one key on one slot; to parallelize beyond one node you shard streams by hash tag).

Trimming is the operational trap: without `MAXLEN`/`MINID`, a stream grows until it eats the instance. And `MAXLEN ~` (approximate, trims whole nodes) is far cheaper than exact `MAXLEN`. Also note: trimming does **not** consider unacked entries — you can trim messages that are still pending, losing them.

### Production scenario: `KEYS` in a health check takes down checkout

**Problem.** At 19:40 on a Friday, checkout p99 goes from 40ms to 9 seconds across all pods simultaneously. Redis CPU is at 100% on one core. No deploy happened. `SLOWLOG` shows `KEYS cart:*` taking 4,200ms, repeatedly.

**Cause.** A monitoring sidecar shipped two weeks earlier exported a "cart count" gauge with `KEYS cart:*`, scraped every 15 seconds. It was harmless at 200k keys. A marketing campaign pushed the keyspace to 22M keys, and each `KEYS` scan now blocked the single-threaded server for seconds. Every client waited behind it.

**Solution.**

```lua
-- 1. Kill the KEYS call. Maintain the counter as data, not as a scan.
--    Atomic create-with-count so the gauge cannot drift.
-- KEYS[1] = cart key, KEYS[2] = counter key (same slot via hash tag), ARGV[1] = payload
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', 3600)
if created then redis.call('INCR', KEYS[2]) end
return created and 1 or 0
```

```bash
# Step 2 — Fence the whole class of problem at the server, not in code review.
CONFIG SET maxmemory-policy allkeys-lru      # cache instance, separate from datastore
# redis.conf on the cache instance:
rename-command KEYS ""
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command CONFIG ""
# Step 3 — Make slow commands visible before they page you.
CONFIG SET slowlog-log-slower-than 5000      # microseconds -> 5ms
CONFIG SET latency-monitor-threshold 100     # ms
```

```java
// 4. Client-side: bound the damage. Timeouts + circuit breaker, and cache misses
//    must degrade to the database, not to a 500.
LettuceClientConfiguration cfg = LettuceClientConfiguration.builder()
    .commandTimeout(Duration.ofMillis(150))          // NOT the default 60s
    .clientOptions(ClientOptions.builder()
        .timeoutOptions(TimeoutOptions.enabled(Duration.ofMillis(150)))
        .autoReconnect(true)
        .build())
    .build();
```

If you must count a key family, either maintain a counter, or use `SCAN` with `COUNT 200` spread across many ticks, or read `INFO keyspace` / `DBSIZE` (O(1)) when a total is good enough.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| `KEYS`, `SMEMBERS` on a huge set, `HGETALL` on a 500k-field hash | Global multi-second stalls; every client's p99 spikes together |
| One instance serving both cache and durable data with `allkeys-lru` | Durable keys silently evicted; "data disappeared" incidents |
| `maxmemory` unset (or set above container limit) | OOM-killed container instead of graceful eviction |
| `volatile-lru` with no TTLs on any key | Writes fail with OOM even though the policy says evict |
| No TTL jitter | Synchronized expiry → cache stampede → database overload on the hour |
| `vm.overcommit_memory=0` + THP enabled | `BGSAVE` fork fails → `MISCONF` → all writes rejected; latency spikes during fork |
| Default client `commandTimeout` (60s in Lettuce) | One Redis hiccup exhausts the app's thread pool; cascading failure |
| Big keys (multi-MB values, million-element collections) | Slot imbalance in cluster, blocking `DEL`, replication bursts |
| `DEL` on a big key instead of `UNLINK` | Event-loop stall proportional to element count |
| Multi-key ops across slots in cluster | `CROSSSLOT` errors that only appear in production topology |
| Over-using one hash tag | Whole dataset on one node; cluster "scales" to 1 |
| Streams without `MAXLEN`/`XTRIM` | Memory grows until OOM |
| Treating `WAIT` as durability | Acked writes lost on failover |
| Lua script doing an O(N) loop over a big collection | Server-wide freeze that `SCRIPT KILL` may be unable to stop |

### Debugging scenario

**Observe.** Intermittent 300ms–2s latency on all Redis calls, roughly every 5 minutes, from every client.

**Diagnose.**

```bash
# Step 1 — Is it the server or the network? Measure intrinsic latency on the Redis host.
redis-cli --intrinsic-latency 30
redis-cli --latency-history -i 5

# Step 2 — What does Redis itself blame?
redis-cli LATENCY DOCTOR
redis-cli LATENCY HISTORY fork
redis-cli LATENCY RESET

# Step 3 — Slow commands and their arguments
redis-cli SLOWLOG GET 25

# Step 4 — Fork / persistence pressure
redis-cli INFO persistence | egrep 'rdb_bgsave_in_progress|rdb_last_bgsave_status|latest_fork_usec|aof_rewrite_in_progress'
redis-cli INFO memory     | egrep 'used_memory_human|used_memory_rss_human|mem_fragmentation_ratio|maxmemory_human'

# Step 5 — Who is big? (sampling scan — safe-ish, still run off-peak)
redis-cli --bigkeys
redis-cli --memkeys
redis-cli MEMORY USAGE some:suspect:key SAMPLES 0

# Step 6 — Who is talking? Find the client sending the expensive command.
redis-cli CLIENT LIST | sort -t= -k. | head
redis-cli INFO clients   # blocked_clients, connected_clients
```

`latest_fork_usec` of 1.8 seconds with `rdb_bgsave_in_progress` cycling every 5 minutes matched the latency pattern exactly. `mem_fragmentation_ratio` was 1.9 (RSS almost 2× the dataset), confirming copy-on-write churn.

**Fix.** Move snapshots to a replica (`save ""` on the primary, RDB on the replica), disable transparent huge pages (`echo never > /sys/kernel/mm/transparent_hugepage/enabled`), set `vm.overcommit_memory=1`, and drop the dataset below 50% of instance RAM so fork COW has headroom. Latency spikes disappeared.

---

## 4. Wide-Column Stores (Cassandra and ScyllaDB)

### Core concept

Cassandra is a **distributed, masterless, log-structured store where the primary key dictates physical layout**. There is no query planner, no join, and effectively no ad-hoc query. You get exactly one access pattern per table, and you are expected to create one table per access pattern.

The primary key has two parts and confusing them is the root of most Cassandra failures:

```sql
PRIMARY KEY ( (partition_key_cols), clustering_col_1, clustering_col_2 )
```

- **Partition key** decides *which node* stores the row (`token = murmur3(partition_key)` mapped onto the ring). It must be provided in the `WHERE` clause for any efficient query. It is the unit of colocation and, effectively, the unit of atomicity for batches.
- **Clustering keys** decide the *sort order on disk within the partition*. They give you efficient range scans and `ORDER BY`, but only in the declared order and only within one partition.

The partition is the fundamental object. A partition is read as a unit, repaired as a unit, and compacted as a unit. **Bounded partitions** (a few MB, tens of thousands of rows) are the difference between a healthy cluster and a cluster where a `SELECT` by primary key times out.

### Internal working

```
WRITE:
 coordinator (any node) --> token(partition_key) --> RF replicas
   each replica: commitlog append (durable) + memtable insert (in-memory, sorted)
   memtable full / flush --> immutable SSTable on disk
   background: compaction merges SSTables, drops overwritten cells and expired tombstones

READ:
 coordinator --> replicas per consistency level
   each replica: check row cache -> bloom filter per SSTable -> partition key cache
                 -> partition index / summary -> read from N SSTables
                 -> merge cells by (write timestamp) -> apply tombstones -> result
 coordinator: compare digests; if mismatch -> READ REPAIR (blocking or background)
```

Consequences you must internalize:

- **Writes never read.** No read-modify-write, no uniqueness check, no "does this row exist" — that is why `INSERT` and `UPDATE` are the same operation (an upsert) and why last-write-wins by cell timestamp is the conflict resolution.
- **Reads may merge many SSTables.** If a partition's cells are spread across 40 SSTables, one read touches 40 files. Compaction strategy is therefore a read-latency decision.
- **Deletes are writes.** A delete inserts a **tombstone** with a timestamp. Reads must scan tombstones to know what to suppress.

### Query-first modeling

```sql
-- Access patterns for a messaging app:
--  A) latest N messages in a conversation           (hot, high QPS)
--  B) one message by its id                          (permalink)
--  C) all conversations for a user, most recent first (inbox)
--  D) messages in a conversation for a date range     (export)

-- A + D: partition per conversation per month keeps partitions BOUNDED.
CREATE TABLE messages_by_conversation (
  conversation_id uuid,
  bucket          text,          -- '2026-08'  <-- the anti-unbounded-partition trick
  message_id      timeuuid,      -- clustering: time-ordered, unique
  sender_id       uuid,
  body            text,
  attachments     frozen<list<text>>,
  PRIMARY KEY ((conversation_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = { 'class': 'TimeWindowCompactionStrategy',
                     'compaction_window_unit': 'DAYS',
                     'compaction_window_size': 1 }
  AND default_time_to_live = 0;

-- B: a second table, duplicated data, because there is no secondary lookup for free.
CREATE TABLE message_by_id (
  message_id      timeuuid PRIMARY KEY,
  conversation_id uuid,
  bucket          text,
  sender_id       uuid,
  body            text
);

-- C: inbox, one partition per user, clustered by last activity.
CREATE TABLE conversations_by_user (
  user_id         uuid,
  last_message_at timestamp,
  conversation_id uuid,
  peer_name       text,          -- denormalized for display
  unread_count    int,
  PRIMARY KEY (user_id, last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (last_message_at DESC);

-- The write path fans out to all three tables. This is normal and expected.
-- Atomicity across them: LOGGED BATCH gives atomicity (not isolation) at a cost.
BEGIN LOGGED BATCH
  INSERT INTO messages_by_conversation (conversation_id, bucket, message_id, sender_id, body)
    VALUES (?, ?, ?, ?, ?);
  INSERT INTO message_by_id (message_id, conversation_id, bucket, sender_id, body)
    VALUES (?, ?, ?, ?, ?);
  UPDATE conversations_by_user SET unread_count = unread_count + 1
    WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?;
APPLY BATCH;
```

Denormalization is not a compromise here, it is the design. The cost is that **you own consistency between the tables**. A logged batch guarantees all statements eventually apply (the batchlog is replicated then replayed), but it is not isolated and it is expensive: the coordinator writes a batchlog to two other nodes first. Use logged batches only for genuine multi-table atomicity of a *small* number of statements. Use `UNLOGGED BATCH` **only** when all statements hit the same partition (then it is a performance win); an unlogged batch spanning partitions is slower than concurrent individual writes and generates coordinator hotspots.

### Tombstones and TTL

```sql
-- TTL is per-cell, and expiry creates a tombstone at expiry time.
INSERT INTO sessions (id, data) VALUES (?, ?) USING TTL 3600;
ALTER TABLE events WITH default_time_to_live = 2592000;   -- 30 days

-- gc_grace_seconds: how long tombstones are kept so that a node that was DOWN
-- can learn about the delete during repair. Default 864000 = 10 days.
ALTER TABLE messages WITH gc_grace_seconds = 259200;      -- 3 days (only if you repair often!)
```

The tombstone lifecycle: a delete/TTL-expiry writes a tombstone; the tombstone must survive `gc_grace_seconds` so anti-entropy repair can propagate the delete to replicas that missed it; only after that (and only if compaction sees all relevant SSTables) is it purged. Lower `gc_grace_seconds` **without running repairs inside that window** and deleted data resurrects.

Reads pay for tombstones. Thresholds in `cassandra.yaml`:

```yaml
tombstone_warn_threshold: 1000       # WARN in system.log
tombstone_failure_threshold: 100000  # query aborted: TombstoneOverwhelmingException
```

The classic killer is **range tombstones from a queue pattern**: insert rows, read them, delete them, repeat. The partition accumulates millions of tombstones, and a `SELECT ... LIMIT 10` at the head of the partition must skip every tombstone before it finds a live row. Latency grows monotonically until reads fail. **Cassandra is not a queue.** Use TTL-based expiry with TWCS, or a real queue (Kafka, SQS, Redis Streams).

### Compaction strategies

| Strategy | How it merges | Best for | Cost |
|---|---|---|---|
| **STCS** (SizeTiered) | Groups similarly-sized SSTables and merges | Write-heavy, insert-mostly | Reads may touch many SSTables; needs up to 50% free disk for a big compaction; old data lingers |
| **LCS** (Leveled) | Fixed-size SSTables in levels, each level 10× the previous; a key is in ≤1 SSTable per level | Read-heavy, update-heavy, wide rows read often | High write amplification (10–30×); more IO and CPU |
| **TWCS** (TimeWindow) | One SSTable set per time window, compacts only within a window | Time-series with TTL, append-only, immutable | Only correct if you never update old data and use TTL, not explicit deletes |
| **UCS** (Unified, 5.0) | Configurable spectrum between tiered and leveled | New clusters wanting one knob | Newer; know your `scaling_parameters` |

Getting this wrong is expensive: TWCS on a table with out-of-order writes or explicit deletes never drops SSTables (data spans windows), so disk grows forever. LCS on a write-heavy table burns your IO budget on compaction. STCS on a read-heavy table gives you 20-SSTable reads.

### Tunable consistency

Per-statement consistency level (CL) on both reads and writes:

| CL | Meaning |
|---|---|
| `ANY` | Write accepted if *any* node takes it, including as a hint. Write-only; effectively "maybe." |
| `ONE` / `TWO` / `THREE` | That many replicas must respond |
| `QUORUM` | `floor(RF/2) + 1` across **all** datacenters |
| `LOCAL_QUORUM` | Quorum within the coordinator's datacenter only |
| `EACH_QUORUM` | Quorum in *every* datacenter (writes only) |
| `ALL` | All replicas; any single node down = failed query |
| `LOCAL_ONE` | One replica in the local DC (common for analytics/read-mostly) |
| `SERIAL` / `LOCAL_SERIAL` | Read the latest Paxos-committed value (pairs with LWT) |

**Strong consistency requires `R + W > RF`.** With RF=3: `W=QUORUM(2)` + `R=QUORUM(2)` = 4 > 3 → a read sees the latest write. `W=ONE` + `R=ONE` = 2 ≤ 3 → eventual only.

In multi-DC, **use `LOCAL_QUORUM`, not `QUORUM`.** `QUORUM` with RF=3 per DC across two DCs needs 4 of 6 replicas, which means cross-DC latency on every operation and a query failure when the remote link degrades. `LOCAL_QUORUM` keeps you within one DC — at the price that cross-DC reads are eventually consistent.

Lightweight transactions (LWT) give you compare-and-set via Paxos:

```sql
-- Uniqueness / claim-check. Costs ~4 round trips; ~4x the latency of a normal write.
INSERT INTO users_by_email (email, user_id) VALUES (?, ?) IF NOT EXISTS;
UPDATE inventory SET qty = ? WHERE sku = ? IF qty = ?;   -- CAS
-- Read the result of a LWT with SERIAL/LOCAL_SERIAL, not ONE, or you may read stale.
```

LWTs are correct and slow. They are also **not** a general transaction: they are single-partition CAS. Never put an LWT on a hot path at high QPS, and never mix LWT and non-LWT writes to the same column (the non-LWT write bypasses Paxos and can be silently lost or win incorrectly).

### Hinted handoff, read repair, and repair

- **Hinted handoff**: if a replica is down (up to `max_hint_window_in_ms`, default 3h), the coordinator stores a hint and replays it when the node returns. This is a *convenience*, not a guarantee — hints expire, and hint storage can itself overflow. Never rely on hints for consistency.
- **Read repair**: when replicas return mismatched digests, the coordinator pushes the newest data back. Blocking read repair happens for the replicas needed to satisfy the CL; `read_repair` table option (`BLOCKING`/`NONE` in 4.x) controls it. Read repair only fixes data you actually read.
- **Anti-entropy repair** (`nodetool repair -pr`, or Reaper): the only complete mechanism. **You must run repair on every node within `gc_grace_seconds`** or deletes can resurrect. Incremental repair has historical footguns; full `-pr` (primary range) repairs on a rolling schedule via Cassandra Reaper is the boring, correct answer.

### Production scenario: unbounded partition plus tombstone storm

**Problem.** An audit-log table on a 24-node cluster. `SELECT * FROM audit_by_tenant WHERE tenant_id = ? LIMIT 50` starts timing out for exactly three tenants. `nodetool tablehistograms` shows a max partition size of 4.2GB. Logs are full of `Read 50 live rows and 214,331 tombstone cells` warnings, then `TombstoneOverwhelmingException`.

**Cause.** Two compounding design errors: (1) `PRIMARY KEY ((tenant_id), event_time)` — one partition per tenant, unbounded forever, so the three biggest tenants had multi-GB partitions that cannot fit in memory during compaction or read; (2) a nightly "prune old audit rows" job issued `DELETE` statements, creating hundreds of thousands of tombstones at the head of the clustering order, which every `LIMIT 50` read had to skip.

**Solution.**

```sql
-- 1. Bound the partition with a time bucket in the partition key.
CREATE TABLE audit_by_tenant_v2 (
  tenant_id  uuid,
  day        date,                     -- bucket: one partition per tenant per day
  event_time timeuuid,
  actor_id   uuid,
  action     text,
  payload    text,
  PRIMARY KEY ((tenant_id, day), event_time)
) WITH CLUSTERING ORDER BY (event_time DESC)
  AND default_time_to_live = 7776000            -- 90 days: expiry instead of DELETE
  AND gc_grace_seconds = 259200                 -- 3 days, with repair every 24h
  AND compaction = {
        'class': 'TimeWindowCompactionStrategy',
        'compaction_window_unit': 'DAYS',
        'compaction_window_size': 1,
        'unsafe_aggressive_sstable_expiration': 'false'
      };

-- 2. Never DELETE for retention again. TTL + TWCS lets whole SSTables be dropped
--    when every cell in them has expired — zero tombstone read cost.

-- 3. Reads now specify the bucket. The app iterates days backwards.
SELECT * FROM audit_by_tenant_v2
 WHERE tenant_id = ? AND day = ? LIMIT 50;      -- single-partition, single-SSTable-ish
```

```java
// 4. Driver-side guardrails so a bad query degrades instead of taking a node down.
SimpleStatement stmt = SimpleStatement.newInstance(
        "SELECT * FROM audit_by_tenant_v2 WHERE tenant_id=? AND day=? LIMIT 50", tenantId, day)
    .setConsistencyLevel(DefaultConsistencyLevel.LOCAL_QUORUM)
    .setTimeout(Duration.ofMillis(800))
    .setPageSize(50)
    .setIdempotent(true);      // required for speculative execution / retries
```

Migration ran as a dual-write plus a bucketed backfill (`SELECT` per old partition with paging, `INSERT` into the new table), then a read cutover per tenant, then a `DROP TABLE`. `unsafe_aggressive_sstable_expiration` stayed `false` because the team could not guarantee non-overlapping windows.

### Common misconfigurations and anti-patterns

| Misconfiguration | Symptom |
|---|---|
| `ALLOW FILTERING` in application queries | Full cluster scan per query; coordinator OOM; timeouts that scale with data volume |
| Unbounded partition (no time/hash bucket) | Multi-GB partitions, compaction failures, read timeouts, node instability |
| Low-cardinality partition key (`country`, `status`) | Hotspots; a handful of nodes carry all traffic |
| Using Cassandra as a queue (insert → read → delete) | Tombstone accumulation → monotonically rising read latency → `TombstoneOverwhelmingException` |
| Secondary index (`CREATE INDEX`) on a high-cardinality or high-frequency column | Scatter-gather to all nodes; index itself becomes a hidden unbounded partition |
| `QUORUM` instead of `LOCAL_QUORUM` in multi-DC | Cross-DC latency on every request; total failure when the WAN degrades |
| `R + W <= RF` while expecting read-your-writes | Intermittent stale reads that only appear under node failure |
| Never running repair, or repair interval > `gc_grace_seconds` | Deleted data resurrects |
| `gc_grace_seconds = 0` "to avoid tombstones" | Guaranteed data resurrection after any node outage |
| TWCS on a table with updates to old rows or explicit deletes | SSTables never expire; disk grows without bound |
| LCS on a write-heavy table | Compaction consumes the IO budget; write latency climbs |
| Large `IN` clauses across partitions | One coordinator does N partition reads; p99 = slowest replica |
| `UNLOGGED BATCH` across many partitions | Slower than parallel writes; coordinator becomes a bottleneck |
| Mixing LWT and normal writes on the same column | Lost updates that are nearly impossible to reproduce |
| Collections (`list`, `map`) used as growing containers | Whole collection read/rewritten per update; tombstones on list writes |
| No `setIdempotent(true)` but retries/speculative execution enabled | Duplicate application effects |

### Debugging scenario

**Observe.** p99 read latency on one table jumps from 6ms to 900ms. Only two of 24 nodes show high CPU. No traffic change.

**Diagnose.**

```bash
# Step 1 — Is it one partition / one table? Look at distributions, not averages.
nodetool tablehistograms keyspace.messages_by_conversation
#   -> check "Partition Size" max and "SSTables per read" 99th percentile
nodetool tablestats keyspace.messages_by_conversation
#   -> "Average tombstones per slice", "Maximum tombstones per slice", "SSTable count"

# Step 2 — Are threads queueing or dropping?
nodetool tpstats            # Pending/Blocked on ReadStage, MutationStage; Dropped messages
nodetool compactionstats    # is compaction backed up?
nodetool netstats           # streaming/hints backlog

# Step 3 — Which query, and where does the time go? Trace ONE request, not the fleet.
cqlsh> TRACING ON;
cqlsh> CONSISTENCY LOCAL_QUORUM;
cqlsh> SELECT * FROM messages_by_conversation WHERE conversation_id=? AND bucket=? LIMIT 50;
# The trace shows per-replica time, SSTables read, tombstone skipping, read repair.

# Step 4 — Logs: the truth is usually already written down.
grep -E 'Read [0-9]+ live rows and [0-9]+ tombstone|Batch for .* is of size|GCInspector|Dropping' \
     /var/log/cassandra/system.log

# Step 5 — Ring health / token imbalance
nodetool status keyspace
nodetool ring | awk '{print $NF}' | sort -n | head
```

The trace showed 31 SSTables per read and 180k tombstones skipped on the two hot nodes; `nodetool status` showed those two nodes owned the tokens for the largest tenant.

**Fix.** Immediate mitigation: `nodetool compact` on the affected table during a low-traffic window (accepting the IO cost) plus raising the driver timeout and adding paging so reads stop timing out. Real fix: bucket the partition key and replace deletes with TTL, as in the scenario above. Note that `nodetool compact` (major compaction with STCS) creates one huge SSTable and is a one-time band-aid, not a routine tool.

---

## 5. DynamoDB and Single-Table Design

### Core concept

DynamoDB is a managed key-value/document store with a **hard physical model** and a **pricing model that is part of the design**. You get:

- `PK` (partition key, required) — hashed to pick a partition. Equality only, always.
- `SK` (sort key, optional) — sorted within the partition. Supports `begins_with`, `between`, `<`, `>`, and reverse iteration.
- Everything else is a non-key attribute, invisible to queries unless projected into an index.

Three operations matter: `GetItem` (one item by full key), `Query` (one partition, optional SK condition — this is the only efficient multi-item read), and `Scan` (reads the whole table — a bug in almost every production code path).

Because DynamoDB has no joins and a per-request cost, the dominant pattern is **single-table design**: put multiple entity types in one table with generic key names, and shape the keys so that one `Query` returns a pre-joined, ordered result set (an "item collection").

### Internal working

```
Table -> partitions (transparent). partition = f(hash(PK))
  Each partition: ~10GB storage, ~3000 RCU, ~1000 WCU hard ceiling
  Replicated 3x across AZs; writes ack after a quorum of replicas
  Reads: eventually consistent (default, from any replica, 0.5 RCU)
         strongly consistent (leader replica, 1 RCU, no GSI support)

Capacity: 1 RCU  = 1 strongly-consistent read of up to 4KB/sec
                  = 2 eventually-consistent reads of up to 4KB/sec
          1 WCU  = 1 write of up to 1KB/sec
          Item size is rounded UP to the boundary, per item, per request.

Adaptive capacity: automatically shifts capacity toward hot partitions (minutes)
                   and can split a partition by key range if a key range is hot.
                   It CANNOT split a single hot key. One key = one partition, forever.
```

That last line is the whole game: **the only unfixable hot spot in DynamoDB is a single hot partition key value.**

### Single-table design

```
Table: app
  PK (S)  |  SK (S)                   |  attributes
----------|---------------------------|------------------------------------------------
USER#1001 | PROFILE                   | name, email, tier, createdAt
USER#1001 | ORDER#2026-08-31#8821     | totalMinor, status, GSI1PK=ORDER#8821
USER#1001 | ORDER#2026-08-29#8790     | totalMinor, status
USER#1001 | ADDRESS#HOME              | line1, city, zip
ORDER#8821| METADATA                  | userId, totalMinor, status, placedAt
ORDER#8821| ITEM#SKU-1188             | qty, unitPriceMinor, name
ORDER#8821| ITEM#SKU-2290             | qty, unitPriceMinor, name
```

```javascript
// "Get the user, their addresses, and their 20 most recent orders" — ONE Query.
await ddb.query({
  TableName: "app",
  KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
  ExpressionAttributeValues: {
    ":pk": "USER#1001",
    ":lo": "ADDRESS#",
    ":hi": "ORDER#$"          // '$' > '#' lexically; covers ADDRESS*, ORDER*, PROFILE?
  },
  ScanIndexForward: false,     // newest orders first (SK sorts descending)
  Limit: 40
});

// "Get an order with all of its line items" — ONE Query, pre-joined by design.
await ddb.query({
  TableName: "app",
  KeyConditionExpression: "PK = :pk",
  ExpressionAttributeValues: { ":pk": "ORDER#8821" }
});
```

Because SK sorting is lexicographic, **encode sortable keys as fixed-width, zero-padded, ISO-8601 strings**. `ORDER#2026-08-31T10:04:00Z#8821` sorts correctly; `ORDER#8821` does not sort by time, and `ORDER#9` sorts after `ORDER#10`.

### GSI vs LSI

| | GSI (Global Secondary Index) | LSI (Local Secondary Index) |
|---|---|---|
| Partition key | Any attribute | **Must** be the table's PK |
| Sort key | Any attribute | A different attribute |
| Created | Any time; can be deleted | **Only at table creation**; permanent |
| Consistency | Eventually consistent only | Strongly consistent reads available |
| Capacity | Its **own** RCU/WCU | Shares the table's capacity |
| Count limit | 20 (soft, raisable) | 5 |
| Constraint | None on item collection size | Item collection (PK + all LSIs) capped at **10GB** |
| Throttling | GSI throttling **backpressures the base table writes** | Consumes base table capacity |

The GSI backpressure behavior surprises everyone: if a GSI is under-provisioned, DynamoDB cannot keep the index up to date, and **writes to the base table start throttling** even though the base table has spare capacity. Always provision GSIs for the write rate of the items they index, and prefer on-demand if the pattern is spiky.

**GSI overloading** is the single-table technique for multiple access patterns:

```javascript
// Generic index attributes, reused with different meanings per entity type.
// GSI1: "orders by status, newest first" and "products by category" in ONE index.
{ PK: "ORDER#8821", SK: "METADATA",
  GSI1PK: "STATUS#SHIPPED",  GSI1SK: "2026-08-31T10:04:00Z" }
{ PK: "PRODUCT#SKU-1188", SK: "METADATA",
  GSI1PK: "CATEGORY#DRINKWARE", GSI1SK: "Thermal Mug 500ml" }

// Sparse index: only items that HAVE GSI2PK appear in GSI2.
// Perfect for "all orders currently needing manual review" — a small, hot working set.
{ PK: "ORDER#8899", SK: "METADATA", GSI2PK: "REVIEW_QUEUE", GSI2SK: "2026-08-31T11:00:00Z" }
// When review completes, REMOVE GSI2PK -> the item leaves the index entirely.
```

Projections matter for cost: `KEYS_ONLY` is cheapest (then you do a `BatchGetItem`), `INCLUDE` projects named attributes, `ALL` duplicates the item (and its storage cost and its write cost).

### Capacity, hot partitions, and adaptive capacity

```javascript
// Always ask for the bill. This is how you find the expensive access pattern.
const res = await ddb.query({ /* ... */, ReturnConsumedCapacity: "INDEXES" });
console.log(res.ConsumedCapacity);
// { TableName: 'app', CapacityUnits: 12.5,
//   Table: { CapacityUnits: 6.5 }, GlobalSecondaryIndexes: { GSI1: { CapacityUnits: 6 } } }
```

Provisioned vs on-demand:

| | Provisioned | On-demand |
|---|---|---|
| Cost per unit | ~5–7× cheaper at steady state | Higher per request, zero idle cost |
| Bursts | Needs autoscaling (reacts in minutes) + burst credits | Absorbs 2× the previous peak instantly; doubles further with warm-up |
| Best for | Predictable, high, steady traffic | Spiky, new, or unknown workloads; dev/test |
| Failure mode | `ProvisionedThroughputExceededException` during a spike | A surprise invoice |

Common practice: on-demand for new tables until the pattern is known, then provisioned + autoscaling + reserved capacity for the steady base. Note that switching modes is limited (once per 24 hours per table).

**Hot partitions.** Adaptive capacity isolates and boosts hot partitions automatically, and will split partitions by key range. What it cannot do is split a single key. Symptoms of a hot key: `ThrottledRequests` with total consumed capacity far below provisioned. Fix by **write sharding**:

```javascript
// BAD: PK = "COUNTER#GLOBAL"  -> 1000 WCU ceiling forever.
// GOOD: shard the key, aggregate on read.
const shard = Math.floor(Math.random() * 32);
await ddb.updateItem({
  TableName: "app",
  Key: { PK: { S: `COUNTER#GLOBAL#${shard}` }, SK: { S: "COUNT" } },
  UpdateExpression: "ADD #c :one",
  ExpressionAttributeNames: { "#c": "count" },
  ExpressionAttributeValues: { ":one": { N: "1" } }
});
// Read = 32 GetItems (or a Query on a GSI) summed. Trade read cost for write scale.

// For time-series keys, add a calculated suffix so writes spread:
// PK = `EVENT#${day}#${hash(eventId) % 16}` instead of PK = `EVENT#${day}`.
```

### Condition expressions and optimistic locking

```javascript
// Optimistic locking: the condition IS the lock. No read-then-write race.
try {
  await ddb.updateItem({
    TableName: "app",
    Key: { PK: { S: "ORDER#8821" }, SK: { S: "METADATA" } },
    UpdateExpression: "SET #s = :new, #v = :nextV, updatedAt = :now",
    ConditionExpression: "#v = :curV AND #s = :expectedS",
    ExpressionAttributeNames: { "#s": "status", "#v": "version" },
    ExpressionAttributeValues: {
      ":new": { S: "SHIPPED" }, ":expectedS": { S: "PAID" },
      ":curV": { N: "7" }, ":nextV": { N: "8" }, ":now": { S: nowIso }
    },
    ReturnValuesOnConditionCheckFailure: "ALL_OLD"   // tells you WHY it failed
  });
} catch (e) {
  if (e.name === "ConditionalCheckFailedException") { /* reload and retry or reject */ }
}

// Idempotent create: the classic "insert if not exists".
ConditionExpression: "attribute_not_exists(PK)"

// Atomic counter without read-modify-write:
UpdateExpression: "ADD stockRemaining :delta",
ConditionExpression: "stockRemaining >= :qty"
```

A failed `ConditionalCheckFailedException` still consumes capacity (1 WCU for the attempted write), and — importantly — **is not free but is much cheaper than a distributed lock**. This is the idiomatic DynamoDB concurrency primitive.

### Transactions

```javascript
await ddb.transactWriteItems({
  TransactItems: [
    { Update: { TableName: "app", Key: { PK: {S:"ACCT#A"}, SK: {S:"BAL"} },
                UpdateExpression: "ADD balanceMinor :neg",
                ConditionExpression: "balanceMinor >= :amt",
                ExpressionAttributeValues: { ":neg": {N:"-500"}, ":amt": {N:"500"} } } },
    { Update: { TableName: "app", Key: { PK: {S:"ACCT#B"}, SK: {S:"BAL"} },
                UpdateExpression: "ADD balanceMinor :pos",
                ExpressionAttributeValues: { ":pos": {N:"500"} } } },
    { Put:    { TableName: "app", Item: { PK: {S:"TX#f1e2"}, SK: {S:"METADATA"}, /* ... */ },
                ConditionExpression: "attribute_not_exists(PK)" } }   // idempotency guard
  ],
  ClientRequestToken: idempotencyKey        // 10-minute idempotency window
});
```

Limits: 100 items and 4MB per transaction; no two operations on the same item within one transaction; costs **2× the WCU/RCU** of the equivalent non-transactional operations (two-phase commit); `TransactionCanceledException` carries per-item `CancellationReasons` that you must inspect to know which condition failed. `TransactGetItems` gives a consistent snapshot read across items at 2× RCU.

### DynamoDB Streams

```javascript
// StreamViewType: KEYS_ONLY | NEW_IMAGE | OLD_IMAGE | NEW_AND_OLD_IMAGES
// 24-hour retention, ordered per partition key, at-least-once delivery to Lambda.
export const handler = async (event) => {
  for (const rec of event.Records) {
    // rec.eventName: INSERT | MODIFY | REMOVE
    // rec.dynamodb.SequenceNumber gives per-key ordering
    if (rec.eventName === "REMOVE" && rec.userIdentity?.type === "Service") {
      // This is a TTL deletion, not a user delete. Distinguish them!
    }
    await project(rec);          // MUST be idempotent
  }
};
```

Streams are the correct way to do fan-out: maintain a materialized view, push to Elasticsearch, emit domain events, or build an outbox. Operational notes: a Lambda failure on a shard **blocks that shard** (configure `MaximumRetryAttempts`, `BisectBatchOnFunctionError`, and an `OnFailure` DLQ destination or you get an infinite retry loop); ordering is only guaranteed per partition key; and 24-hour retention means a consumer outage longer than a day requires a rebuild from the table.

TTL is a related tool: set an epoch-seconds attribute, and DynamoDB deletes the item **eventually** (typically within 48 hours, not on the second). TTL deletes consume no WCU and appear in Streams. Never build logic that assumes prompt TTL deletion — filter expired items on read too.

### Production scenario: hot partition throttles a multi-tenant table

**Problem.** A B2B analytics product on DynamoDB. Table provisioned at 20,000 WCU. CloudWatch shows `ConsumedWriteCapacityUnits` averaging 4,200 and `ThrottledRequests` in the thousands per minute. Their biggest customer's dashboard is unusable; everyone else is fine.

**Cause.** `PK = TENANT#<tenantId>`, `SK = <eventTimestamp>`. One enterprise tenant produced 68% of all events. All of their writes went to one partition, which is capped at 1,000 WCU regardless of table provisioning. Adaptive capacity had already boosted that partition to its ceiling and split by SK range as far as it could — but every new write had the maximum timestamp, so the "hottest" range was always the newest one.

**Solution.**

```javascript
// 1. Write sharding: bound fan-out per tenant, sized by tenant tier.
const SHARDS = { FREE: 1, PRO: 4, ENTERPRISE: 64 };
function writeKey(tenantId, tier, eventId) {
  const n = SHARDS[tier];
  const shard = n === 1 ? 0 : Math.abs(hash32(eventId)) % n;
  return {
    PK: `TENANT#${tenantId}#S${String(shard).padStart(3, "0")}`,
    SK: `${isoTs}#${eventId}`
  };
}

// 2. Reads fan out across that tenant's shards in parallel, then merge-sort.
const results = await Promise.all(
  range(SHARDS[tier]).map(shard => ddb.query({
    TableName: "events",
    KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
    ExpressionAttributeValues: {
      ":pk": `TENANT#${tenantId}#S${String(shard).padStart(3, "0")}`,
      ":lo": `${fromIso}#`, ":hi": `${toIso}#$`
    },
    Limit: pageSize
  }))
);
const merged = mergeSortDesc(results.flatMap(r => r.Items), i => i.SK).slice(0, pageSize);

// 3. Pre-aggregate. Dashboards should not read raw events at all.
//    Streams -> Lambda -> rollup items (PK=TENANT#x#ROLLUP, SK=1m#<ts>) with ADD.
```

```bash
# Step 4 — Find the hot key before the customer does.
aws dynamodb update-contributor-insights \
  --table-name events --contributor-insights-action ENABLE
# CloudWatch metric: MostAccessedKeys / ThrottledRequests by key.
# Alarm on ThrottledRequests > 0 AND ConsumedWCU < 60% of provisioned
#   -> that combination means "hot key", not "under-provisioned".
```

The alarm expression is the durable lesson: throttling *with* spare capacity always means key distribution, never provisioning.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| `Scan` in a request path | Cost and latency grow with table size; throttles everything else |
| Low-cardinality PK (`tenantId`, `status`, `date`) | Hot partition, throttling at 1000 WCU / 3000 RCU while the table looks idle |
| Monotonic SK with a single PK | Adaptive capacity cannot help; newest range always hottest |
| Under-provisioned GSI | Base table writes throttle even with spare table capacity |
| GSI projection `ALL` on a large item | 2× storage and 2× write cost, silently |
| LSI created "just in case" | Item collection capped at 10GB; a big customer breaks the table, and LSIs cannot be removed |
| Non-padded numeric or non-ISO timestamps in SK | Lexicographic sort order is wrong (`#9` after `#10`) |
| No `ClientRequestToken` on transactions with client retries | Duplicate transfers |
| Ignoring `ConsumedCapacity` | No idea which access pattern is 80% of the bill |
| Assuming TTL deletes on time | Expired items served to users |
| Lambda stream consumer with no DLQ / bisect | One poison record blocks a shard indefinitely |
| Treating GSI reads as strongly consistent | Read-after-write returns nothing; "the item wasn't saved" bugs |
| Storing large blobs (near the 400KB item limit) | RCU/WCU explosion; every read costs 100 RCU |
| Provisioned mode without autoscaling for spiky traffic | `ProvisionedThroughputExceededException` at every campaign launch |

### Debugging scenario

**Observe.** Sporadic `ProvisionedThroughputExceededException` in application logs; the CloudWatch table graph shows consumed capacity well under the provisioned line.

**Diagnose.**

1. **Compare `ThrottledRequests` against `ConsumedWriteCapacityUnits`.** Throttling with spare capacity ⇒ hot key or hot GSI, not provisioning.
2. **Check per-index metrics.** `ConsumedWriteCapacityUnits` split by `GlobalSecondaryIndexName` finds an under-provisioned GSI backpressuring the table.
3. **Enable Contributor Insights** and read `MostAccessedKeys`. This directly names the offending partition key value.
4. **Turn on `ReturnConsumedCapacity: "INDEXES"`** in the SDK for a sampled percentage of requests and emit it as a metric tagged by access pattern name. Now cost and throttling are attributable to a code path.
5. **Check item sizes.** `Query` returning 1MB pages of 300KB items burns 250 RCU per page. `aws dynamodb describe-table` gives average item size (`TableSizeBytes / ItemCount`).
6. **Look for `Scan`.** CloudTrail or X-Ray will show them. A `Scan` with a `FilterExpression` still reads (and charges for) everything before filtering.

**Fix.** In this case a GSI provisioned at 500 WCU was indexing every write to a table doing 4,000 WCU. Switching that GSI to on-demand stopped the throttling within a minute; the permanent fix was narrowing the GSI to a sparse index so only 3% of items were indexed at all.

---

## 6. Search Engines (Elasticsearch and OpenSearch)

### Core concept

Lucene inverts the data: instead of `document → terms`, it stores `term → sorted list of document ids`. That is why full-text search, faceting, and aggregation over hundreds of millions of documents is fast, and it is also why Elasticsearch is a **derived index, not a system of record**.

Everything else follows from immutability: a Lucene **segment** is written once and never modified. An update is a new document plus a deletion marker on the old one. Space is reclaimed only by **merging** segments. Search visibility requires a **refresh** (creating a new searchable segment), which by default happens once per second — hence "near real-time," not real-time.

### Internal working

```
Index  = N primary shards + R replicas per primary. A shard = one Lucene index.
Doc    -> routing = hash(_routing ?? _id) % number_of_primary_shards   (FIXED at creation)
Write  -> in-memory buffer + translog (fsync per request by default)
Refresh (1s) -> buffer becomes a new searchable SEGMENT (not yet fsynced to a commit point)
Flush        -> Lucene commit, translog truncated
Merge        -> background; combines small segments, physically drops deleted docs
Search -> query phase (each shard returns top-K doc ids + scores)
       -> fetch phase (coordinating node fetches the K documents it actually needs)
```

The `number_of_primary_shards` is immutable because it is the modulus in the routing function. Changing it requires a **reindex**. This single fact drives the aliasing strategy below.

### Analyzers and mapping

```json
PUT /products-v3
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "refresh_interval": "5s",
    "index.mapping.total_fields.limit": 1000,
    "analysis": {
      "analyzer": {
        "product_name": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "english_stop", "english_stemmer"]
        },
        "product_name_search": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "english_stop", "english_stemmer"]
        }
      },
      "filter": {
        "english_stop":    { "type": "stop", "stopwords": "_english_" },
        "english_stemmer": { "type": "stemmer", "language": "english" }
      }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "sku":       { "type": "keyword" },
      "name":      {
        "type": "text",
        "analyzer": "product_name",
        "search_analyzer": "product_name_search",
        "fields": {
          "raw":       { "type": "keyword", "ignore_above": 256 },
          "completion":{ "type": "search_as_you_type" }
        }
      },
      "category":  { "type": "keyword" },
      "priceMinor":{ "type": "long" },
      "inStock":   { "type": "boolean" },
      "attrs":     { "type": "flattened" },
      "updatedAt": { "type": "date", "format": "strict_date_optional_time||epoch_millis" }
    }
  }
}
```

The distinctions that matter:

- **`text` vs `keyword`**: `text` is analyzed (tokenized, lowercased, stemmed) and is for **matching**; `keyword` is stored verbatim and is for **filtering, sorting, and aggregating**. A `text` field cannot be sorted or aggregated efficiently (it needs `fielddata`, which is a memory bomb). The `multi-field` pattern above (`name` + `name.raw`) gives you both.
- **Index-time vs search-time analyzer**: they must produce compatible tokens. A common bug is index-time n-gram + search-time n-gram, which makes every query match everything and destroys relevance. Use n-grams at index time and a plain analyzer at search time.
- **`dynamic: "strict"`** is the single most valuable production setting. Without it, dynamic mapping infers a field for every new JSON key it sees.

**Mapping explosion** is the classic Elasticsearch outage. Someone indexes `{"attrs": {"userId_1001": true}}` or `{"error": {"stacktrace_hash_9f3a": "..."}}`. Each new key becomes a new field in the cluster state. Cluster state is replicated to every node on every change. At tens of thousands of fields the master node spends all its time serializing cluster state, mapping updates queue, indexing stalls, and the cluster goes yellow then red. Defenses, in order:

1. `"dynamic": "strict"` (reject unknown fields) or `"dynamic": false` (store but don't index).
2. `index.mapping.total_fields.limit` (default 1000) — keep it, don't raise it to 10000.
3. The `flattened` field type: an entire JSON object indexed as one field, with all leaf values as keywords. Queryable (`attrs.color: red`), no mapping growth. This is the correct answer for user-defined attributes.
4. The key-value pair pattern: `[{"k":"color","v":"red"}]` with `nested` if you need per-pair correlation.

### Reindex and aliases

Never point your application at a concrete index name. Point it at an **alias**.

```json
// 1. Application reads/writes "products" — which is an alias.
POST /_aliases
{ "actions": [ { "add": { "index": "products-v2", "alias": "products" } } ] }

// 2. New mapping needed (new analyzer, new shard count, field type change).
PUT /products-v3   { /* new settings + mappings as above */ }

// 3. Bulk copy. Throttle it, and use slices for parallelism.
POST /_reindex?wait_for_completion=false&slices=auto&requests_per_second=2000
{
  "source": { "index": "products-v2", "size": 2000 },
  "dest":   { "index": "products-v3", "op_type": "create" },
  "script": { "source": "ctx._source.priceMinor = (long)(ctx._source.remove('price') * 100)" }
}
// Monitor: GET /_tasks?actions=*reindex&detailed

// 4. Atomic cutover — one API call, zero downtime, both actions applied together.
POST /_aliases
{ "actions": [
    { "remove": { "index": "products-v2", "alias": "products" } },
    { "add":    { "index": "products-v3", "alias": "products" } }
] }

// 5. Keep v2 for a rollback window, then delete.
```

Handling writes during a reindex: either (a) dual-write to both indices through a write alias, then reindex only the delta by `updatedAt` range, or (b) rebuild from the system of record entirely (the safest, since Elasticsearch is derived data). The `updatedAt` delta pass must run **after** the cutover too, because documents changed during the switch.

### Refresh interval, shard sizing, and pagination

```json
// Bulk load tuning: disable refresh and replicas, then restore. 3-10x faster indexing.
PUT /products-v3/_settings
{ "index": { "refresh_interval": "-1", "number_of_replicas": 0 } }
// ... bulk index ...
PUT /products-v3/_settings
{ "index": { "refresh_interval": "5s", "number_of_replicas": 1 } }
POST /products-v3/_forcemerge?max_num_segments=1     // read-only indices only!
```

Sizing rules of thumb that hold up in production:

| Rule | Reason |
|---|---|
| Shard size 10–50GB (logs up to 50GB, search 10–30GB) | Recovery time, merge cost, and heap per shard |
| ≤ 20 shards per GB of heap per node | Each shard has fixed overhead (segments, FSTs) |
| Heap ≤ 31GB (compressed oops boundary) | Above ~32GB, pointers stop being compressed; less usable memory |
| Half the RAM to heap, half to the OS page cache | Lucene relies on the page cache for segment reads |
| `number_of_replicas ≥ 1` in production | A lost primary without a replica is data loss on a derived store — and a long rebuild |

**Over-sharding** is more common than under-sharding: someone creates a daily index with 5 shards for 200MB/day of logs, and a year later the cluster has 3,650 shards holding 70GB. Use ILM with rollover on size, and Data Streams for time-series.

**Deep pagination.** `from + size` requires every shard to build and return `from + size` hits, then the coordinating node sorts `shards × (from+size)` results. `index.max_result_window` (default 10,000) is a guardrail, not a suggestion — raising it is how you OOM a cluster.

```json
// CORRECT deep pagination: search_after + a point-in-time (PIT) for a stable view.
POST /products/_pit?keep_alive=2m       // -> { "id": "46ToAwMDaWR5..." }

POST /_search
{
  "size": 100,
  "pit": { "id": "46ToAwMDaWR5...", "keep_alive": "2m" },
  "query": { "term": { "category": "DRINKWARE" } },
  "sort": [ { "priceMinor": "asc" }, { "_shard_doc": "asc" } ],
  "search_after": [ 1890, 421 ],        // last hit's sort values from the previous page
  "track_total_hits": false             // counting all hits is expensive; skip it
}
```

`scroll` still exists but is deprecated for pagination — it pins segment resources per scroll context and is meant for full-index export (and even then `search_after` + PIT with slicing is preferred). Use `track_total_hits: false` or an integer cap when you only need "many results" instead of an exact count.

### Why not a system of record

| Missing property | Consequence |
|---|---|
| No multi-document transactions | Partial updates are permanent; no rollback |
| Near-real-time visibility (refresh) | Read-after-write returns nothing for up to `refresh_interval` |
| No enforced schema evolution / immutable field types | A type change means a full reindex |
| Merge-based space reclamation | Deletes don't free space until merges run |
| Optimistic concurrency only (`if_seq_no`/`if_primary_term`) | Lost updates without careful client handling |
| Cluster state as a single point of coordination | Mapping explosion or too many shards can red the entire cluster |
| Data model tuned for query, not for integrity | No foreign keys, no uniqueness constraints |

The rule: **Elasticsearch must always be rebuildable from another store.** If you cannot answer "how long does a full reindex take, and have you tested it this quarter?" then it is a system of record whether you intended it or not.

### Production scenario: mapping explosion reds the cluster

**Problem.** A logging cluster (6 data nodes, 30GB heap each) goes yellow at 02:00, then red. Indexing latency goes from 20ms to 30s. The master node is pegged at 100% CPU. `GET /_cluster/health` shows thousands of unassigned shards and a `pending_tasks` queue in the thousands.

**Cause.** A service deployed a new structured-logging format that put request parameters at the top level: `{"level":"INFO","param_orderId_8821":"...","param_userId_1001":"..."}`. Dynamic mapping created a field per unique parameter name. Within four hours the daily index mapping had 61,000 fields. Every mapping update is a cluster-state change broadcast to every node; the master could not keep up, and `pending_tasks` (mapping updates) blocked shard allocation.

**Solution.**

```json
// 1. Emergency: stop the bleeding. Block writes to the poisoned index, roll over.
PUT /logs-000412/_settings   { "index.blocks.write": true }
POST /logs-write/_rollover
{ "conditions": { "max_primary_shard_size": "40gb" } }

// 2. Fix the template so the shape cannot recur. flattened + strict.
PUT /_index_template/logs
{
  "index_patterns": ["logs-*"],
  "priority": 200,
  "template": {
    "settings": {
      "index.mapping.total_fields.limit": 1000,
      "index.mapping.depth.limit": 5,
      "index.mapping.nested_fields.limit": 20,
      "refresh_interval": "5s",
      "number_of_shards": 3,
      "number_of_replicas": 1
    },
    "mappings": {
      "dynamic": "strict",
      "properties": {
        "@timestamp": { "type": "date" },
        "level":      { "type": "keyword" },
        "service":    { "type": "keyword" },
        "traceId":    { "type": "keyword" },
        "message":    { "type": "text" },
        "params":     { "type": "flattened" },
        "http": {
          "properties": {
            "status": { "type": "short" },
            "path":   { "type": "keyword", "ignore_above": 512 }
          }
        }
      }
    }
  }
}
```

```json
// 3. Ingest pipeline as a belt-and-braces guard: move unknown top-level keys into params.
PUT /_ingest/pipeline/logs-normalize
{
  "processors": [
    { "script": {
        "lang": "painless",
        "source": """
          def known = ['@timestamp','level','service','traceId','message','params','http'];
          def move = [:];
          def it = ctx.entrySet().iterator();
          while (it.hasNext()) {
            def e = it.next();
            if (!known.contains(e.getKey()) && !e.getKey().startsWith('_')) {
              move[e.getKey()] = e.getValue();
              it.remove();
            }
          }
          if (!move.isEmpty()) {
            if (ctx.params == null) { ctx.params = [:]; }
            ctx.params.putAll(move);
          }
        """
    }},
    { "date": { "field": "@timestamp", "formats": ["ISO8601","UNIX_MS"] } }
  ]
}
```

```json
// 4. ILM so shard count stops growing forever.
PUT /_ilm/policy/logs
{
  "policy": { "phases": {
    "hot":    { "actions": { "rollover": { "max_primary_shard_size": "40gb", "max_age": "1d" } } },
    "warm":   { "min_age": "2d",  "actions": { "forcemerge": { "max_num_segments": 1 },
                                               "shrink": { "number_of_shards": 1 } } },
    "cold":   { "min_age": "14d", "actions": { "searchable_snapshot": { "snapshot_repository": "s3" } } },
    "delete": { "min_age": "45d", "actions": { "delete": {} } }
  }}
}
```

Alerts added afterward: `pending_tasks > 50`, total field count per index > 700, and total cluster shard count vs. `cluster.max_shards_per_node`.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| Dynamic mapping on user-controlled keys | Mapping explosion → master CPU pegged → cluster red |
| Application uses concrete index names instead of aliases | Reindex requires a deploy and downtime |
| `from + size` deep pagination | Coordinating node OOM; `max_result_window` errors at page 100 |
| Daily indices with 5 shards for small volumes | Thousands of tiny shards; heap exhaustion; slow cluster state |
| Heap > 31GB | Loses compressed object pointers; effectively less usable heap |
| `refresh_interval: 1s` during a bulk backfill | 3–10× slower indexing; segment explosion; merge storms |
| `forcemerge` on an actively written index | Huge segments that later must be re-merged; sustained IO |
| Sorting/aggregating on a `text` field (fielddata) | Circuit breaker trips or node OOM |
| `number_of_replicas: 0` in production | One node loss = data loss on a store nobody has a rebuild plan for |
| Elasticsearch as the only copy of business data | Unrecoverable partial updates; no transactions |
| Read-after-write against the search index | "Saved item not found" bugs (refresh not yet occurred) |
| No `_routing` strategy for tenant-scoped queries | Every query hits every shard |
| Index-time and search-time n-grams both enabled | Everything matches everything; relevance is noise |

### Debugging scenario

**Observe.** Search p99 jumps from 90ms to 4s. Indexing is fine. Cluster is green.

**Diagnose.**

```bash
# Step 1 — Shard-level facts first.
GET /_cat/indices?v&s=store.size:desc&h=index,health,pri,rep,docs.count,docs.deleted,store.size
GET /_cat/shards/products?v&h=index,shard,prirep,state,docs,store,node
# docs.deleted approaching docs.count = merge debt; every query filters deletions.

# Step 2 — Where does the time go inside the query?
GET /products/_search?human=true
{ "profile": true, "query": { /* the slow query */ } }
# Look for: huge "build_scorer" times (expensive script/wildcard), or
# "advance" dominating (poor filter ordering / no filter cache hits).

# Step 3 — Is a node hot?
GET /_nodes/hot_threads?threads=3&interval=1s
GET /_nodes/stats/indices,jvm,thread_pool?human=true
# thread_pool.search.rejected > 0 and queue growing = search saturation.

# Step 4 — Circuit breakers and cache pressure.
GET /_nodes/stats/breaker?human=true
GET /_cat/nodes?v&h=name,heap.percent,ram.percent,cpu,load_1m,segments.count

# Step 5 — Slow log — enable per index, not globally.
PUT /products/_settings
{ "index.search.slowlog.threshold.query.warn": "1s",
  "index.search.slowlog.threshold.fetch.warn": "500ms" }
```

The profile showed a `wildcard` query on `name` (leading wildcard, `*mug*`) added by a new "search anywhere" feature. `docs.deleted` was also 38% of `docs.count` because the price-sync job rewrote every document nightly.

**Fix.** Replace the leading wildcard with an `edge_ngram` indexed field (or `match_phrase_prefix` / `search_as_you_type`), which moves the cost to index time. Change the price-sync job to only update changed documents (compare a content hash) so `docs.deleted` stops growing, and schedule a `forcemerge` on the read-only historical indices only.

---

## 7. Graph Databases (Neo4j)

### Core concept

A graph database stores **nodes and relationships as first-class objects with direct pointers**, not as rows in two tables joined at query time. Neo4j's index-free adjacency means traversing from node A to its neighbors costs O(degree of A), independent of total graph size. That is the opposite of a relational join, whose cost grows with table cardinality unless you have exactly the right indexes and the planner picks them.

Use a graph store when the **query is the traversal**: "friends-of-friends within 3 hops," "shortest path between two accounts in a fraud ring," "all permissions reachable from a user through group membership," "impact blast radius if this service fails." If your query can be answered with one or two indexed lookups by ID, Postgres or MongoDB wins on ops simplicity.

Do **not** use a graph database as a general document store. Neo4j has no native sharding story comparable to Cassandra; cluster sizing is vertical-first, and cross-shard traversals do not exist the way you expect from Cassandra's token ring.

### Internal working

```
Node record  ->  label(s) + property store
Relationship ->  start node id, end node id, type, property store
Traversal    ->  follow relationship chain pointers (no index hop per edge)

Storage: record stores + page cache (like an embedded B-tree engine)
Transactions: ACID on a single database; cluster uses Raft for leadership
Cypher planner: pattern matching -> expand from anchor nodes -> filter/prune
```

The planner starts from **anchor nodes** (found by label+property index or internal id) and expands along relationship types. An unindexed anchor turns into a label scan — acceptable at 10k nodes, catastrophic at 10M.

### When traversal beats N joins

| Pattern | Relational cost | Graph cost |
|---|---|---|
| 1-hop neighbors by indexed FK | One join — fine | Overkill |
| Variable-depth path (2–6 hops) | Recursive CTE or repeated self-joins; planner struggles | Native; cost ~ edges visited |
| Shortest path | Dijkstra in app code or expensive SQL | Built-in (`shortestPath`) |
| Pattern match ("A knows B who works at C who owns D") | 3–4 joins + filter explosion | Single Cypher `MATCH` |
| Frequent traversals, rare bulk analytics | Many indexes to maintain | Graph wins on read path |

Rule of thumb: if the **depth is unbounded or the join count scales with business rules**, model it as a graph. If depth is fixed at 1–2 and keys are known upfront, relational is simpler.

### Cypher basics (production subset)

```cypher
// Anchor + 2-hop with relationship type filter and property predicate
MATCH (u:User {email: $email})-[:KNOWS*1..2]->(friend:User)
WHERE friend <> u AND friend.active = true
RETURN DISTINCT friend.email, friend.displayName
LIMIT 50;

// Shortest path — cap hop count or you scan half the graph
MATCH path = shortestPath(
  (a:Account {id: $from})-[:TRANSFERRED*..5]-(b:Account {id: $to})
)
RETURN path, length(path) AS hops;

// MERGE for idempotent graph upsert (common in CDC ingest)
MERGE (u:User {id: $userId})
ON CREATE SET u.createdAt = datetime()
SET u.email = $email, u.updatedAt = datetime()
WITH u
MERGE (g:Group {id: $groupId})
MERGE (u)-[:MEMBER_OF {since: date()}]->(g);
```

```cypher
// EXPLAIN / PROFILE before shipping — look for NodeByLabelScan
PROFILE
MATCH (u:User)-[:PURCHASED]->(p:Product {category: 'electronics'})
WHERE u.country = 'DE'
RETURN u.id, count(p) AS purchases
ORDER BY purchases DESC
LIMIT 20;
```

Indexes you actually create in production:

```cypher
CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE INDEX user_email IF NOT EXISTS FOR (u:User) ON (u.email);
CREATE INDEX product_category IF NOT EXISTS FOR (p:Product) ON (p.category);
// Relationship indexes (Neo4j 5+): only when filtering ON relationship properties
CREATE INDEX transfer_amount IF NOT EXISTS FOR ()-[t:TRANSFERRED]-() ON (t.amount);
```

### Production limits and cluster reality

| Limit / constraint | Practical impact |
|---|---|
| No native multi-key sharding | One logical graph; scale reads with read replicas; writes hit leader |
| Supernodes (degree > ~10k) | Single node with 500k `FOLLOWS` edges makes traversals and writes hot |
| Deep unbounded traversals | `*..` without cap can lock threads and blow heap |
| Write throughput vs Cassandra | Graph writes touch multiple records; expect lower raw ingest TPS |
| HA | Causal cluster: 3+ core servers, read replicas for fan-out |
| Backup | `neo4j-admin backup` / dump; point-in-time needs enterprise + proper config |

### Production scenario: fraud ring detection

**Problem.** A payments team models transfers in Postgres with `from_account`, `to_account`, `amount`. Fraud analysts ask for "show all accounts within 4 hops of this flagged account." The recursive CTE runs 45–120 seconds and times out in prod.

**Cause.** Each hop is a join on a billion-row table. Postgres has no materialized adjacency; the planner repeats index scans per depth level. Even with good indexes, intermediate result sets explode for dense subgraphs.

**Solution.** Stream transfers into Neo4j via CDC (see [Polyglot Persistence and Data Ownership](#10-polyglot-persistence-and-data-ownership)). Postgres remains source of truth for balances; Neo4j is a **derived, query-optimized projection** for link analysis.

```cypher
// Ingest (simplified — run from Kafka consumer)
MERGE (a:Account {id: $fromId})
MERGE (b:Account {id: $toId})
CREATE (a)-[:TRANSFERRED {txId: $txId, amount: $amount, at: datetime($ts)}]->(b);

// Analyst query — sub-second on indexed anchors
MATCH (seed:Account {id: $flaggedId})
MATCH (seed)-[:TRANSFERRED*1..4]-(linked:Account)
RETURN linked.id, min(length(shortestPath((seed)-[:TRANSFERRED*]-(linked)))) AS distance
ORDER BY distance;
```

Operational guardrails: cap traversal depth in the API (`maxHops = 4`), reject queries without indexed anchors, and schedule `MATCH (n) WHERE degree(n) > 10000` reports to find supernodes before they page you.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| No uniqueness constraints on business keys | Duplicate nodes; `MERGE` matches wrong node; silent graph fork |
| Storing large blobs on relationships | Page cache pollution; slow traversals |
| Using Neo4j as primary transactional store for money | No cross-partition ACID at scale; backup/restore complexity |
| Unbounded variable-length paths in user-facing API | GC pauses; thread pool exhaustion |
| Missing relationship type in `MATCH` | Expands all rel types; 10× more edges visited |

---

## 8. Time-Series (TimescaleDB and InfluxDB)

### Core concept

Time-series workloads share a shape: **append-mostly writes keyed by (entity, timestamp)**, queries that aggregate over time windows (`last 24h p99`, `sum by hour`), and data that **ages out** — hot recent data queried constantly, cold historical data queried rarely or never. General-purpose row stores can do this until cardinality, ingest rate, or retention policy make compression and pruning first-class requirements.

Two production paths:

- **TimescaleDB** (Postgres extension): hypertables chunk time into partitions automatically; you keep SQL, joins, and CDC tooling. Best when time-series is part of a relational domain.
- **InfluxDB** (and VictoriaMetrics for metrics-native shops): tag/field model optimized for metrics and high-cardinality ingest. Best when the workload is pure telemetry with no relational joins.

### Internal working (TimescaleDB)

```
Hypertable (logical) -> many chunk tables (physical), partitioned on time column
  INSERT -> router picks chunk by time -> append to chunk's heap/index
  Compression -> columnar per chunk after it ages (order by time, segmentby tags)
  Retention policy -> DROP chunk (not DELETE row-by-row)
  Continuous aggregate -> materialized rollup refreshed on schedule
```

```sql
-- Create hypertable on existing Postgres table
CREATE TABLE metrics (
  time        TIMESTAMPTZ NOT NULL,
  host        TEXT NOT NULL,
  service     TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       DOUBLE PRECISION,
  tags        JSONB
);
SELECT create_hypertable('metrics', 'time', chunk_time_interval => INTERVAL '1 day');

-- Compression after 7 days (run once chunks are cold)
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host, service, metric',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- Retention — drops whole chunks
SELECT add_retention_policy('metrics', INTERVAL '90 days');

-- Continuous aggregate (downsampled hourly)
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       host, service, metric,
       avg(value) AS avg_val,
       max(value) AS max_val,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY value) AS p99
FROM metrics
GROUP BY bucket, host, service, metric;

SELECT add_continuous_aggregate_policy('metrics_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');
```

### Internal working (InfluxDB 2.x)

```
Bucket -> org-scoped container with retention rules
Line protocol: measurement,tag_set field_set timestamp
  cpu,host=web01,region=us-east usage=0.64,idle=0.21 1693497600000000000
Storage engine (TSM/Parquet in 3.x): time-ordered files, tag indexes
Tasks / downsampling -> Flux or SQL (InfluxDB 3) scheduled queries
```

```text
# Line protocol ingest (from Telegraf / app)
http_req_duration,service=checkout,status=200 le=0.25 142.5 1693497600000000000

# Retention via bucket rules (CLI)
influx bucket create -n metrics_raw -r 72h
influx bucket create -n metrics_5m  -r 365d
```

```flux
// Downsample raw -> 5m aggregates (InfluxDB task)
option task = {name: "downsample_5m", every: 5m}
from(bucket: "metrics_raw")
  |> range(start: -10m)
  |> filter(fn: (r) => r._measurement == "http_req_duration")
  |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
  |> to(bucket: "metrics_5m")
```

### Production scenario: cardinality explosion

**Problem.** After deploying a new build, InfluxDB ingest rate is fine but queries time out and disk fills in 48 hours. Cardinality report shows 40M unique series.

**Cause.** A high-cardinality tag — `trace_id` or `user_id` — was added to every point. Each unique tag combination is a series; indexes and memory scale with series count, not point count.

**Solution.** Enforce a **tag budget** in the ingest pipeline: allowlist tags (`host`, `service`, `route`, `status_class`), reject or hash high-cardinality dimensions into logs (Elasticsearch/Loki), store trace-level detail in object storage. For TimescaleDB, the equivalent failure is indexing `(user_id, time)` on a billion-row hypertable without chunk pruning in the query.

```sql
-- TimescaleDB: always constrain time in WHERE — chunk exclusion
SELECT time_bucket('5 minutes', time) AS bucket, avg(value)
FROM metrics
WHERE time > now() - INTERVAL '6 hours'
  AND service = 'checkout'
  AND metric = 'latency_ms'
GROUP BY bucket
ORDER BY bucket;
```

### Retention and downsampling strategy

| Tier | Age | Resolution | Store |
|---|---|---|---|
| Hot | 0–3 days | Raw (1s–15s) | Fast disk, replication |
| Warm | 3–30 days | 1–5 min rollups | Compressed chunks / downsampled bucket |
| Cold | 30–365 days | 1h rollups | Cheaper storage, searchable snapshot |
| Archive | > 1 year | Daily or delete | S3 + Athena, or drop |

**Problem.** Dashboards query raw data for 90-day trends; p99 over 90 days of 1s samples scans billions of rows.

**Cause.** No continuous aggregate / downsample bucket; Grafana defaults to `$__interval` but users pick "last 90 days" at full resolution.

**Solution.** Grafana variables that switch datasource/table by range (`< 24h` → raw, `> 7d` → hourly view). Document the resolution tradeoff in the dashboard title.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| High-cardinality tags/labels | Memory spike; slow queries; compactions never catch up |
| Row-by-row DELETE for retention | Bloat, long locks; use chunk drop / bucket retention |
| No compression policy on Timescale | 10× disk vs compressed peers |
| Continuous aggregate refresh lag | Dashboard shows stale rollups; widen `start_offset` |
| Same retention on raw and rolled-up data | Paying to store duplicates at two resolutions forever |

---

## 9. Consistency, CAP, and Quorum Math

### Core concept

CAP is not "pick two forever." It is: **during a network partition**, you choose between linearizable reads/writes (CP) and availability with stale reads (AP). Most production systems are **PA/EL** most of the time and only face the tradeoff during failures. What seniors actually need is **quorum arithmetic**: for N replicas, read quorum R and write quorum W determine what a client can observe after a write.

Dynamo-style rule: **R + W > N** guarantees that a read quorum overlaps a write quorum, so you can see the latest write (possibly with versioning to resolve concurrent writes). **W = 1, R = 1** is fast and available but you may read stale data indefinitely if replicas diverge.

### Tunables by store

| Store | N (typical) | Default W / R | Tunable? | Notes |
|---|---|---|---|---|
| Cassandra / Scylla | RF (usually 3) | `ONE` / `ONE` | `QUORUM`, `LOCAL_QUORUM`, `ALL` | `LOCAL_QUORUM` = majority in local DC |
| DynamoDB | 3 AZ replicas | Managed | `ConsistentRead=true` for R | Strong read hits leader replica |
| MongoDB replica set | # voting members | `w: majority` common | `readConcern`, `writeConcern` | Linearizable with `readConcern: linearizable` + primary |
| Redis Cluster | 1 primary + replicas | Async replication default | `WAIT N timeout` | `WAIT` is best-effort sync |
| Elasticsearch | `number_of_replicas + 1` | `quorum` default | `wait_for_active_shards` | Not cross-doc transactional |

### Worked examples (RF = 3, so N = 3)

**Example 1 — Strong read-your-writes**

```
W = 2, R = 2  ->  2 + 2 > 3  ✓
Write ack after 2 replicas persist. Read touches 2 replicas; at least one has the latest.
Cassandra: WRITE QUORUM + READ QUORUM (same DC: LOCAL_QUORUM).
Cost: 2× write latency vs ONE; read may hit two nodes.
```

**Example 2 — Fast writes, stale reads OK**

```
W = 1, R = 1  ->  1 + 1 = 2, NOT > 3  ✗
Write ack after one replica. Other replicas catch up async.
Use for: metrics, feature flags, idempotent counters with CRDT merge.
Never use for: inventory, balances, entitlement checks without version checks.
```

**Example 3 — Cassandra LOCAL_QUORUM in multi-DC**

```
RF=3 per DC, CL=LOCAL_QUORUM -> W=2, R=2 within local DC only
Cross-DC: async replication (NetworkTopologyStrategy). Another DC may lag seconds.
Read in us-east sees us-east quorum; not guaranteed to include write replicated from eu-west yet.
Fix for "read anywhere after write": QUORUM across DCs (latency tax) or sticky routing to write DC.
```

**Example 4 — DynamoDB strong read**

```
N=3, strong consistent GetItem: R effectively from leader before respond
2× RCU cost vs eventual. No GSI strong consistency — GSI reads are eventually consistent always.
Bug pattern: write item, immediately query GSI, item "missing" for ~1s.
```

**Example 5 — MongoDB majority write + local read**

```javascript
await coll.insertOne(doc, { writeConcern: { w: "majority", wtimeout: 5000 } });
// Read from secondary with readPreference secondaryPreferred BEFORE replication
// -> may not see the insert
await coll.findOne({ _id: doc._id }, { readConcern: { level: "majority" } });
// On secondary: waits until secondary has applied up to majority commit point
```

### Production scenario: "sometimes we sell the last unit twice"

**Problem.** E-commerce inventory in Cassandra with `ConsistencyLevel.ONE` for reads and writes. Under node failure, two checkout requests both read `qty=1`, both decrement, both succeed. Oversell count spikes during AZ failover drills.

**Cause.** `ONE` does not guarantee overlap between read and write quorums. During partition or repair lag, replicas disagree; last-write-wins by timestamp can also reorder concurrent decrements if clocks skew.

**Solution.** `LOCAL_QUORUM` for both read and write on the inventory table, plus ** lightweight transaction (LWT)** or move inventory to a store with compare-and-set semantics (DynamoDB conditional update, Postgres row lock).

```sql
-- Cassandra LWT (serial consistency under the hood — not free)
UPDATE inventory SET qty = qty - 1
WHERE product_id = ? AND warehouse = ?
IF qty >= 1;
-- Returns [applied] false if another writer won or qty insufficient
```

```javascript
// DynamoDB conditional write (single-item linearizable)
await ddb.update({
  TableName: "inventory",
  Key: { PK: "PRODUCT#1188", SK: "WH#US-EAST" },
  UpdateExpression: "SET qty = qty - :one",
  ConditionExpression: "qty >= :one",
  ExpressionAttributeValues: { ":one": 1 }
}).promise();
```

### PACELC and latency

When **E**lse (no partition), systems still trade **L**atency vs **C**onsistency: MongoDB `readConcern: local` vs `majority`; Cassandra `ONE` vs `QUORUM`; DynamoDB eventual vs strong. Document the choice per endpoint — "catalog browse" vs "payment capture" — not per database.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| `CL.ALL` on hot path | Any single replica down blocks reads/writes |
| Strong consistency on GSI (DynamoDB) | Impossible — design around eventual GSI |
| Assuming Redis replica read is fresh | Stale reads after failover; use `WAIT` or read primary for money |
| No idempotency when W=1 | Retries duplicate side effects |
| Clock skew + LWW in Cassandra | "Newer" write loses silently — use logical clocks or CRDT for conflicts |

---

## 10. Polyglot Persistence and Data Ownership

### Core concept

Polyglot persistence means **more than one database in production**, each chosen for a access pattern — Postgres for transactions, Redis for session cache, Elasticsearch for search, S3 for archives. The hard part is not picking stores; it is **data ownership**: exactly one system is the source of truth for each fact, and every other copy is a **derived projection** with a defined freshness SLA and rebuild path.

Violating single ownership produces the dual-write bug: two stores updated in one request, no atomicity across them, and no deterministic winner when one write succeeds and the other fails.

```
WRONG (dual write in application):
  service -> write Postgres
          -> write Elasticsearch   // if ES fails, Postgres has truth ES lacks
          -> write Redis           // three failure modes, three versions

RIGHT (single write + async projection):
  service -> write Postgres (source of truth)
          -> insert outbox row (same transaction)
  relay   -> read outbox -> publish Kafka
  indexer -> consume -> upsert Elasticsearch
  cache   -> invalidate via event or TTL
```

### The dual-write bug (detailed)

**Problem.** User updates profile name. API writes Postgres, then ES. ES times out. Search still shows old name; profile page shows new name. User "fixes" it again; retry succeeds to ES but Postgres already correct — support sees intermittent wrong results.

**Cause.** No shared transaction across stores. Retries are not idempotent on the ES side without external versioning. Order of operations matters and is not recorded.

**Solution.** **Transactional outbox** in the source database:

```sql
BEGIN;
UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2;
INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_at)
VALUES ('User', $2, 'UserUpdated', $json, now());
COMMIT;
-- Separate poller or Debezium publishes outbox -> Kafka -> ES consumer
```

```java
// Consumer: idempotent upsert with version / external_id
@KafkaListener(topics = "user-events")
void onUserUpdated(UserUpdatedEvent e) {
  esClient.update(u -> u.index("users").id(e.userId())
    .doc("displayName", e.displayName(), "updatedAt", e.updatedAt())
    .docAsUpsert(true)
    .ifSeqNo(e.seqNo())  // or external version field
    .ifPrimaryTerm(e.primaryTerm()),
    UserDoc.class);
}
```

### CDC vs application outbox

| Approach | Pros | Cons |
|---|---|---|
| Transactional outbox | Explicit events; schema you control; easy replay | App code + relay to maintain |
| Debezium / logical replication | No app change for existing tables | Event shape = row change; harder to evolve; ops overhead |
| Dual write | "Simple" in demo | Wrong in production |

CDC fits **projections that mirror tables** (Postgres `users` → Elasticsearch `users`). Outbox fits **domain events** (`OrderPlaced` with computed fields). Many teams use both: CDC for search indexes, outbox for cross-service workflows.

### Data ownership matrix (example)

| Fact | Owner | Projections | Max staleness |
|---|---|---|---|
| User profile | Postgres | ES (search), Redis (session cache) | Search: 5s; cache: TTL 30m |
| Product catalog | Postgres | ES (faceted browse), CDN (images) | ES: 1 min |
| Order state | Postgres | DynamoDB (customer app read model), ES (support search) | App: 10s |
| Session | Redis | None — ephemeral | N/A |
| Metrics | Influx/Timescale | Grafana | Rollup lag 1–5 min |

### Production scenario: cache-aside vs write-through confusion

**Problem.** Product price updated in MongoDB; Redis cache invalidated manually in only one of four microservices. Checkout sees old price from cache; catalog service sees new price.

**Cause.** Cache invalidation owned by **callers** instead of **one pipeline**. No single event stream; each service caches independently.

**Solution.** Postgres/Mongo owns price. Publish `PriceChanged` via outbox. All services **subscribe** and evict local + Redis keys by pattern, or stop caching price entirely and accept one Redis read with short TTL (60s) keyed by `product:{id}:price:v{version}`.

### Rebuild and disaster recovery

Every projection needs a **rebuild script**: "drop ES index, replay Kafka from offset 0 / snapshot + CDC, or full table scan." If you cannot rebuild a projection from the source of truth in a defined time window, that projection is a second source of truth — and you have a distributed consistency problem with no solution.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| Two sources of truth for same field | "Which system is right?" incidents never end |
| Outbox without idempotent consumers | Replay duplicates orders in search index |
| ES as only copy of catalog | Reindex failure = business stop |
| No dead-letter queue on projection consumers | Silent drift; only discovered by user reports |
| Cross-store "Saga" without compensations | Partial state visible forever |

---

## 11. Migration: Relational ↔ NoSQL

### Core concept

Migrating between relational and NoSQL is not a schema dump — it is a **query-model rewrite** with a cutover window. The safe pattern is **dual-read / dual-write (strangler)** with a verifiable backfill, not a big-bang weekend. You need: (1) backward-compatible API, (2) parallel writes or CDC, (3) reconciliation job comparing counts and checksums, (4) feature flag to shift read traffic, (5) rollback path until confidence is high.

Direction matters:

- **SQL → NoSQL**: denormalize, precompute access paths, drop joins from app code.
- **NoSQL → SQL**: often means the team hit invariant or reporting walls — normalize, enforce FKs, migrate derived fields back to computed columns or views.

### Dual-write phase (controlled)

```
Phase 0: Shadow read — new store populated async; responses discarded; compare metrics
Phase 1: Dual-write — app writes old + new; reads still from old
Phase 2: Dual-read  — reads from new with fallback to old on mismatch (sampled)
Phase 3: New-primary — reads/writes new; old receives async updates (reverse CDC)
Phase 4: Decommission old after TTL + reconciliation green for N days
```

```java
// Feature-flagged dual write (pseudo)
if (flags.isEnabled("orders.cassandra.write")) {
  cassandraRepo.save(orderMapper.toCassandra(order));
}
postgresRepo.save(order);  // source of truth until phase 3
```

Never dual-write without **idempotency keys** on both sides. Retries will duplicate.

### Backfill strategies

| Method | When | Risk |
|---|---|---|
| Batch export + transform + bulk load | Initial history, low change rate | Long runtime; snapshot stale at end |
| CDC (Debezium) + initial snapshot | Large tables, need continuous sync | Schema evolution must be managed |
| Change log replay from domain events | Event-sourced system | Requires complete event history |
| `mongoexport` / `COPY` / DynamoDB Import | One-time bulk | Throttling, index build storm after load |

**MongoDB bulk load tips:** drop non-essential indexes before load, restore after; set `writeConcern: { w: 1 }` during backfill only; run during low traffic; validate with `$out` aggregation or hashed counts.

**Cassandra backfill:** use `sstableloader` or Spark Cassandra connector; match **token ranges** to avoid coordinator hotspots; run `repair` after bulk load before cutover.

### Production scenario: Postgres orders → DynamoDB single-table

**Problem.** Team must move 400M orders to DynamoDB for scale. Weekend cutover fails at hour 4: API errors spike, order history incomplete for 2% of users.

**Cause.** Big-bang migration: stopped writing Postgres at midnight, bulk import still running, app pointed at half-filled DynamoDB table. GSI backfill lagged; queries by `userId` returned partial lists.

**Solution.** Strangler with CDC:

1. Model DynamoDB keys (`PK=USER#id`, `SK=ORDER#ts#id`) and deploy write-side dual-write behind flag (5% traffic).
2. Debezium snapshot + stream `orders` → Lambda consumer upserts DynamoDB idempotently (`orderId` as condition).
3. Nightly reconciliation: `COUNT(*)` per user shard in Postgres vs DynamoDB `Query` count; alert on drift > 0.1%.
4. Shadow-read API compares list lengths (sample 1%).
5. Flip read flag per tenant cohort; keep Postgres read fallback 2 weeks.
6. Remove Postgres writes only when reconciliation green 14 days.

```python
# Reconciliation sketch
for user_id in sample_users:
  pg_count = pg.execute("SELECT count(*) FROM orders WHERE user_id = %s", user_id)
  ddb_count = ddb.query(KeyConditionExpression=Key("PK").eq(f"USER#{user_id}"))["Count"]
  if abs(pg_count - ddb_count) > 0:
    report_drift(user_id, pg_count, ddb_count)
```

### Rollback criteria

Keep the old store writable until:

- Error rate on new read path < baseline for 7 days
- Reconciliation job shows zero drift for 14 days
- On-call runbook tested: "flip flag back to Postgres" in < 5 minutes
- Backfill of **new** writes during dual-write phase verified (no gaps in sequence)

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| Cutover before GSI/LSI is ACTIVE | Empty search results; missing secondary lookups |
| Different serialization (dates, decimals) | Silent sort order bugs after migration |
| No idempotency on backfill consumer | Duplicate items on Kafka replay |
| Dropping old DB before TTL on soft-deleted records | Resurrected ghosts in UI |
| Migrating without load test on new access patterns | Hot partitions discovered on day 1 prod traffic |

---

## 12. Modeling Anti-Patterns Catalog

One table per anti-pattern: what it looks like, why it breaks, the fix. If you recognize three of these in one design review, stop the release.

| Anti-pattern | Store | Symptom | Root cause | Fix |
|---|---|---|---|---|
| **Unbounded embedded array** | MongoDB | 16MB doc limit; index miss; RAM per query grows with tenant age | `$push` events into `user.orders[]` forever | Bucket by month; cap array; or separate `orders` collection keyed by `userId` |
| **Hot shard key** | MongoDB, DynamoDB | One shard/partition at 100% CPU; throttling | `shardKey: { country: "US" }` or celebrity user id | Compound key with high-cardinality suffix (`userId#timestamp`) |
| **ALLOW FILTERING as query plan** | Cassandra | Full cluster scan; p99 in minutes | Secondary lookup without lookup table | New table partitioned by lookup key; duplicate data |
| **Wide partition** | Cassandra | Single-partition read timeout | All messages in one `conversation_id` partition | Time bucket in partition key `(conversation_id, month)` |
| **Counter column on hot key** | Cassandra | Hot partition; coordinator contention | Global `likes` counter on viral post | Shard counters (`likes`, `likes`, … merge in app) or external counter (Redis/Dynamo) |
| **Scan in request path** | DynamoDB | Bill spikes; latency cliff | `Scan` with `FilterExpression` | GSI or inverted index; redesign keys |
| **Single hot item key** | DynamoDB | `ProvisionedThroughputExceeded` on one key | All sessions under `PK=GLOBAL#config` | Split keys; cache in memory; DAX |
| **Elasticsearch as system of record** | ES | Unrecoverable corruption; partial updates | No source DB; direct indexing from API | Postgres owns data; ES is projection |
| **Leading wildcard search** | ES | CPU pegged; query timeout | `*term*` on analyzed text | `edge_ngram`, completion suggester, or dedicated keyword field |
| **Redis JSON as database** | Redis | OOM; lost data on failover without AOF | Large documents; no eviction policy | Postgres/Mongo for durable data; Redis for cache only |
| **Cache without TTL or version** | Redis | Stale reads forever after write | `SET` once at startup | TTL + event invalidation + version in key |
| **Dual write two databases** | Any | Divergent copies; heisenbugs | App writes SQL + NoSQL in one method | Outbox/CDC; single owner |
| **Graph supernode** | Neo4j | Traversal timeout | Celebrity with 2M `FOLLOWED_BY` | Fan-out on read model; limit traversal; precompute |
| **High-cardinality metric tags** | Influx | Series explosion; OOM | `userId` as tag | Tag allowlist; logs for high-cardinality dims |
| **Global secondary index on every column** | DynamoDB | Write amplification; GSI throttling base table | "Query anything" SQL mindset | Access-pattern-driven GSIs; sparse indexes |
| **Multi-document "transaction" without retry** | MongoDB | Partial updates on failover | Multi-doc tx without idempotency token | Idempotency key; retryable writes; or single-doc design |
| **Tombstone-heavy delete pattern** | Cassandra | Read latency grows; disk bloat | Daily full replace of wide rows | TTL; `INSERT` new version; TWCS; avoid wide deletes |
| **Same field in 4 denormalized places** | Any | Update misses one copy | Copy-paste modeling | One owner + projection pipeline |
| **Time-series without retention** | TSDB | Disk full; queries slow | "Keep everything forever" | Tiered retention + continuous aggregates |
| **Optimistic lock without version field** | MongoDB/Dynamo | Lost updates | Last write wins silently | `@Version`, `etag`, or conditional `IF` |

### Production scenario: the "Swiss Army" document

**Problem.** MongoDB `accounts` document holds profile, preferences, 10k transaction embeds, KYC blobs, and session tokens. Updates take 800ms; replication lag triggers alerts.

**Cause.** Anti-patterns stacked: unbounded array, large blobs in hot path, whole-document rewrite on any field change.

**Solution.** Split: `accounts` (profile + prefs), `account_transactions` (paginated by `_id` or time), `account_kyc` (GridFS/S3 for blobs), sessions in Redis with TTL. Use change streams or outbox only for fields that must fan out to search.

---

## 13. Cost and Operations

### Core concept

NoSQL bills are **throughput × duration × replication**, not "one server." Hidden costs: GSI write amplification, cross-AZ traffic, Elasticsearch data nodes for heap headroom, Cassandra repair bandwidth, DynamoDB on-demand spikes, MongoDB Atlas storage for working set overflow. Capacity planning starts from **access patterns and SLOs**, not from "how big is the dataset."

### Backup and restore

| Store | Backup approach | Restore pitfall |
|---|---|---|
| MongoDB | Continuous backup / `mongodump` per shard | Restore wrong shard key config; oplog gap |
| Redis | RDB snapshots + AOF; not a DB backup | Restoring stale cache treated as truth |
| Cassandra | Snapshots + incremental + commitlog | Restore without `repair` → missing ranges |
| DynamoDB | PITR (35 days), on-demand backup | GSI must exist before restore |
| Elasticsearch | Snapshot repo (S3); ILM | Restoring single index vs cluster state |
| Neo4j | `neo4j-admin dump` | Cluster rebind UUIDs |

**Problem.** ES snapshot restore to fix one index overwrites cluster routing; unrelated indices go red.

**Cause.** Restored snapshot is cluster-level state from another point in time.

**Solution.** Restore to **new index name** + alias swap; or restore snapshot to isolated cluster and reindex. Test restore quarterly — untested backup is wishful thinking.

### Capacity signals (watch before throttle)

```
MongoDB:     opcounters, queuedReaders, globalLock.currentQueue, working set vs RAM
Redis:       used_memory, evicted_keys, instantaneous_ops_per_sec, blocked_clients
Cassandra:   pending compactions, SSTable count per table, repair status, tombstone warnings
DynamoDB:    ConsumedReadCapacityUnits / ThrottledRequests, hot partition metrics (Contributor Insights)
ES:          JVM heap %, search thread pool rejected, merge throttling, disk watermarks
```

### Index bloat

**MongoDB:** unused indexes cost write amplification. Audit with `$indexStats`; drop indexes with `accesses.ops: 0` for 30 days (after verifying no hidden jobs).

**Elasticsearch:** `docs.deleted` / merge debt. Fix update patterns; `forcemerge` only on read-only indices; ILM rollover prevents monster shards.

**Cassandra:** too many SSTables per partition (`sstable_count` via `nodetool tablestats`). Tune compaction (STCS vs LCS vs TWCS); avoid delete storms.

### Production scenario: DynamoDB bill 3× forecast

**Problem.** On-demand DynamoDB bill jumps from $8k to $26k/month after launch. Contributor Insights shows one GSI consuming 70% of WCUs.

**Cause.** GSI projects **all attributes** on a high-write table; every base write replicates full item to GSI. A sparse GSI was modeled as full projection "for convenience."

**Solution.** `ProjectionType: KEYS_ONLY` or `INCLUDE` minimal attributes; denormalize only what the GSI query returns. Consider removing GSI and embedding lookup keys in base table item collections.

```javascript
// Before: GSI duplicates entire 400KB item on every price tick
// After: sparse GSI with KEYS_ONLY + base table GetItem for details
{ GSI1PK: "CATEGORY#mugs", GSI1SK: "PRICE#00001999#SKU-1188",
  PK: "PRODUCT#SKU-1188", SK: "METADATA", /* full item only on base */ }
```

### Operational checklist (quarterly)

- [ ] Restore drill on one non-prod clone per store type
- [ ] Reconciliation job green (projection vs source)
- [ ] Index audit (drop unused; verify query plans)
- [ ] Retention policies enforced (TSDB, ES ILM, S3 lifecycle)
- [ ] Hot partition / hot key review (DynamoDB CI, MongoDB balancer)
- [ ] Certificate and version EOL calendar (ES, Mongo, Redis)

---

## 14. Spring Data Integration

### Core concept

Spring Data abstracts repositories behind interfaces — convenient until the abstraction **hides the physical access pattern** and generates queries that scan, N+1, or bypass consistency settings you assumed. Senior rule: **read the generated query** (`DEBUG` logging for Mongo/Cassandra, `@Query` explicit for anything non-trivial).

### MongoDB (`spring-boot-starter-data-mongodb`)

```java
public interface OrderRepository extends MongoRepository<Order, String> {
  // Good: matches compound index { userId: 1, placedAt: -1 }
  List<Order> findByUserIdOrderByPlacedAtDesc(String userId, Pageable page);

  // Bad: derived query on unindexed field -> COLLSCAN
  List<Order> findByPromoCode(String promoCode);

  @Query("{ 'userId': ?0, 'status': ?1 }")
  @Meta(comment = "orders-by-user-status")
  List<Order> findActiveForUser(String userId, String status);
}
```

```yaml
# application.yml — do not hide write concern in "defaults" without documenting
spring:
  data:
    mongodb:
      uri: mongodb://.../?retryWrites=true&w=majority
```

| Pitfall | Symptom | Fix |
|---|---|---|
| `@Document` with default `_id` only | Full collection scan on business key | `@Indexed(unique=true)` on lookup fields; compound indexes via `@CompoundIndex` |
| `save()` in loop | N round-trips | `MongoTemplate.bulkOps` or `@Transactional` batch |
| Lazy `@DBRef` | N+1 queries | Embed or explicit `$lookup` aggregation |
| `@Version` missing | Lost updates | Add `Long version`; handle `OptimisticLockingFailureException` |
| `@Transactional` on non-replica-set | Silent no-op transactions | Verify deployment; use session API for multi-doc |
| Large `Pageable` offset | Slow skip | Keyset pagination on `_id` / `placedAt` |

### Redis (`spring-boot-starter-data-redis`)

```java
@RedisHash(value = "session", timeToLive = 1800)
public class UserSession {
  @Id private String id;
  @Indexed private String userId;
}
```

| Pitfall | Symptom | Fix |
|---|---|---|
| `@RedisHash` for durable domain data | Data loss; wrong tool | JPA/Mongo for truth; Redis cache only |
| Default `RedisTemplate` JDK serialization | Opaque keys; upgrade pain | `StringRedisTemplate` + JSON (Jackson) |
| No `@EnableRedisRepositories` scan control | Beans collide | Explicit `@EnableRedisRepositories(basePackages=...)` |
| Cache `@Cacheable` without key design | Thundering herd; stale entries | `@Cacheable(key = "#id", sync = true)` sparingly; TTL |
| Lettuce connection storm | Timeouts under load | Pool config; timeout; circuit breaker |

### Cassandra (`spring-boot-starter-data-cassandra`)

```java
@Table("orders_by_user")
public class OrderByUser {
  @PrimaryKeyColumn(type = PrimaryKeyType.PARTITIONED)
  private UUID userId;
  @PrimaryKeyColumn(type = PrimaryKeyType.CLUSTERED, ordering = Ordering.DESCENDING)
  private Instant placedAt;
  @PrimaryKeyColumn(type = PrimaryKeyType.CLUSTERED)
  private UUID orderId;
}

public interface OrderByUserRepository extends CassandraRepository<OrderByUser, OrderByUserKey> {
  // MUST match partition key prefix — only userId here is valid efficient query
  List<OrderByUser> findByUserId(UUID userId, Pageable page);
}
```

| Pitfall | Symptom | Fix |
|---|---|---|
| Derived query on non-PK column | `ALLOW FILTERING` | New table; `@Query` with explicit partition key |
| `save()` updating clustering key | Insert + orphan old row | Treat clustering keys as immutable |
| `allowFiltering()` in `@Query` | Prod fire | Code review ban; integration test with `QueryLogger` |
| Consistency not set | Stale reads after write | `@Consistency` on repository or template |
| Reactive + blocking mixed | Thread pool deadlock | Pick one stack per service |

### Production scenario: Spring Data Mongo "works in dev"

**Problem.** Dev (single node, 10k docs) passes tests. Prod (sharded, 200M docs) p99 at 8s on `findByStatus`.

**Cause.** `status` is not in shard key and has no index; mongos broadcasts to all shards + in-memory sort.

**Solution.** Compound index `{ status: 1, createdAt: -1 }` if query must live; better: redesign query to include shard key (`tenantId + status` index with tenant in every query). Add `@Indexed` at class level + `@CompoundIndex` for production indexes as code.

```java
@Document(collection = "orders")
@CompoundIndex(name = "tenant_status_created", def = "{'tenantId': 1, 'status': 1, 'createdAt': -1}")
public class Order { ... }
```

---

## 15. Production Debugging Playbook

Cross-store playbook: **observe → narrow blast radius → find the shape (hot key, scan, bloat) → fix model or config → verify with canary**. Subsections below are the commands seniors actually run — not generic "check logs."

### Step 0 — Triage in 5 minutes

| Signal | Likely family | First move |
|---|---|---|
| Single tenant/user slow | Hot key / bad partition | Identify key value in metrics |
| Everything slow | Network, GC, or compaction storm | CPU/IO on nodes; pending compactions |
| Errors only on writes | Quorum / WCU / primary | Write concern; throttling metrics |
| Errors only on reads | Stale replica / missing index | Read preference; `EXPLAIN` |
| Bill spike without latency | Scan / full index rebuild | Query audit; `Scan` count |

### MongoDB

```javascript
// Current op + full collection scan
db.currentOp({ "active": true, "secs_running": { "$gt": 5 } })
db.orders.find({ status: "OPEN" }).explain("executionStats")
// Look for: TOTAL_COLL_SCAN, SHARDING_FILTER, numChunksExamined

// Balancer / chunk jumbo
sh.status()
db.getSiblingDB("config").chunks.find({ ns: "app.orders", jumbo: true }).count()
```

**Problem.** One tenant's queries slow after migration.

**Cause.** Monotonic shard key (`tenantId` + `createdAt`) created jumbo chunk on largest tenant.

**Solution.** Reshard with hashed suffix or pre-split; compound shard key with high-cardinality field.

### Redis

```bash
redis-cli INFO stats | egrep 'instantaneous_ops|evicted|blocked'
redis-cli LATENCY DOCTOR
redis-cli --bigkeys --i 0.01   # off-peak only
redis-cli SLOWLOG GET 20
```

See sections 3 (Key-Value Stores) for intrinsic latency and slow command diagnosis.

### Cassandra / Scylla

```bash
nodetool tablestats keyspace.table | egrep 'SSTable|Space|Bloom|false'
nodetool tpstats
cqlsh -e "TRACING ON; SELECT ...;"  # one slow query
```

Watch `SSTables` per table > 20 and tombstone warnings in logs.

### DynamoDB

```bash
aws dynamodb describe-table --table-name app
aws cloudwatch get-metric-data ... ThrottledRequests, ConsumedReadCapacityUnits
# Enable Contributor Insights for hot keys
```

**Cause/Solution pair:** throttling on GSI only → GSI under-provisioned or write-heavy projection; base table looks fine.

### Elasticsearch

```bash
GET /_cluster/health?level=indices
GET /_nodes/stats/thread_pool,indices,jvm?filter_path=**.search,**.write,**.merge
GET /_cat/thread_pool/search?v&h=node_name,name,active,queue,rejected
```

Profile slow queries; check `docs.deleted` ratio per index.

### End-to-end request tracing

Correlate **app trace id** with store slow logs. If the app span shows 200ms in `OrderRepository` but DB shows 5ms, the problem is N+1 or serialization — not the database. If DB shows 4s, bring `EXPLAIN` / profile to the design review.

### Post-incident requirements

Document: root cause (model vs config vs traffic), exact key/index/partition, fix deployed, reconciliation run result, and **what alarm fires 10 minutes earlier next time**.

---

## 16. Quick Decision Matrix

Use at design review — pick the **first matching row** (top = highest priority constraint).

| If your hard constraint is… | And access pattern is… | Default choice | Escape hatch |
|---|---|---|---|
| ACID across many entities | Arbitrary queries | **Postgres** | Mongo multi-doc tx for ≤ few docs |
| < 10ms read by known key | Session, cache, rate limit | **Redis** | DynamoDB DAX if must be durable |
| Write rate > 50k/s per partition | Time-ordered events in one key | **Shard** (Kafka + consumer) | Never single hot partition |
| Full-text + facets + ranking | Search-first UI | **Elasticsearch** (projection) | Postgres `tsvector` if < 1M docs |
| Known queries only, huge scale | Multi-DC, partition-tolerant | **Cassandra/Scylla** | DynamoDB if managed OK |
| Pay-per-request, spiky traffic | Key-value/document, AWS-native | **DynamoDB** on-demand | Provisioned if steady |
| Flexible schema, rich queries on one aggregate | Document by id | **MongoDB** | Postgres `jsonb` if < few TB |
| Variable-depth relationships | Graph traversal core feature | **Neo4j** (projection) | Postgres recursive CTE if depth ≤ 2 |
| Metrics/logs, heavy aggregation | Time-range rollups | **TimescaleDB** (with SQL) | Influx if pure metrics |
| Immutable events, replay | Event sourcing | **Kafka + Postgres/Cassandra** | Not ES as primary |
| Strong global consistency | Must have | **Postgres** or single-region DynamoDB strong | Not Cassandra CL ONE |
| Lowest ops headcount | Small team | **Fewer stores** — Postgres + Redis + one projection | Resist polyglot sprawl |

### One-line eliminators

- Need JOIN across tenants at runtime → not DynamoDB/Cassandra as primary.
- Need leading wildcard search → not raw Lucene query string on `text`.
- Need cross-row transaction daily → not Cassandra.
- Need durable complex query → not Redis alone.
- Cannot rebuild search index from source → you don't have architecture, you have risk.

### Interview sound bite

*"We pick the store last. We list access patterns, consistency requirements, and retention first. Every secondary store is a projection with an owner, a rebuild path, and a measured staleness SLA — otherwise we're doing distributed dual-write without a transaction log."*

---

---


---


---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>Your team wants MongoDB because "schema is flexible." The domain is a double-entry ledger. What do you say?</summary>

Say no as primary store unless they commit to multi-document transactions, idempotent writes, and never caching derived balances without recomputation. Postgres (or a ledger-specific store) gives ACID across arbitrary rows, constraints, and audit queries. If MongoDB stays, entries are source of truth; balances are computed or updated in one transaction with conditional filters (`balance >= debit`). Flexible schema does not remove financial invariants.

</details>

<details class="qa-item">
<summary>Cassandra table has PRIMARY KEY ((user_id), created_at, order_id). A new requirement queries by order_id alone. Options?</summary>

You cannot efficiently add a global lookup on `order_id` — that is a second access pattern. Create `orders_by_id` with `PRIMARY KEY (order_id)` and duplicate needed columns (write amplification on insert). Alternatively maintain a Kafka-driven materialized view. Never rely on `ALLOW FILTERING` in production. Teach the team: one table per query shape.

</details>

<details class="qa-item">
<summary>DynamoDB: after PutItem, GetItem on base table is strong-consistent and shows the item. Query on GSI returns empty for 2 seconds. Bug or expected?</summary>

Expected. GSI updates are eventually consistent; there is no strong GSI read. Design: avoid read-after-write on GSI for user-facing flows (use base table GetItem with known PK/SK), or UI tolerance / poll, or duplicate minimal lookup attributes on base table item collection.

</details>

<details class="qa-item">
<summary>Redis cluster failover: app reads from replica, user sees old session then gets logged out. Explain.</summary>

Async replication — replica had stale session hash; promotion made stale data authoritative briefly, or app read from replica while primary had newer TTL refresh. Fix: read sessions from primary for critical path, or use `WAIT 1` after write (latency cost), or accept session re-login on failover. Redis is not a durable source of truth without explicit fsync/AOF tradeoffs understood.

</details>

<details class="qa-item">
<summary>Elasticsearch cluster green but searches timeout. docs.deleted is 45% of docs.count. What happened?</summary>

Heavy update workload (same `_id` reindexed) creates delete markers; segments merge lag → every query filters many deleted docs. Fix update pattern (partial doc, external versioning, only changed fields), ILM rollover, forcemerge on read-only old indices, and reduce refresh frequency during bulk reindex.

</details>

<details class="qa-item">
<summary>RF=3 Cassandra, ONE for read and write. Is lost update possible during node failure?</summary>

Yes. ONE means write may ack on one replica while others lag; read may hit stale replica. Concurrent updates last-write-wins by timestamp. Use LOCAL_QUORUM for critical reads/writes, LWT for compare-and-set, or design idempotent counters. ONE is for truly tolerant data (metrics, caches).

</details>

<details class="qa-item">
<summary>Explain R+W>N for RF=5 when you need minimal latency but cannot tolerate stale reads.</summary>

Minimum W and R with R+W>5: e.g. W=3, R=3 (overlap at least one node). Lower latency option W=2, R=4 or W=4, R=2 — still sums to 6. You pay more round-trips than ONE. Pick smallest quorums meeting SLA and consistency proof; tune per table/use case, not globally.

</details>

<details class="qa-item">
<summary>Dual-write Postgres + Elasticsearch in one @Transactional service method — why fails?</summary>

@Transactional only binds JDBC resource; ES client commits outside XA unless explicit XA (rare). ES failure after PG commit → drift. ES success after PG rollback (if ordering wrong) → ghost documents. Use transactional outbox in Postgres + async indexer with idempotent consumer.

</details>

<details class="qa-item">
<summary>Neo4j: MATCH (n:User)-[:KNOWS*]-(m:User) without limit explodes. Production guardrails?</summary>

Cap variable depth (`*1..4`), require indexed anchor (`User {id}`), limit result count, timeout in driver, reject unanchored patterns in API, monitor supernodes (degree), precompute friend lists for celebrities, use graph projection / analytics store for offline batch.

</details>

<details class="qa-item">
<summary>TimescaleDB vs InfluxDB for product metrics with 500 tags, 20k QPS writes?</summary>

Audit tag cardinality first — if tags include request_id/user_id, both will hurt. Influx fits pure metrics pipelines; TimescaleDB if you need SQL joins with product tables and existing Postgres ops. Often: high-cardinality dims to logs, low-cardinality tags to TSDB, rollups via continuous aggregate / Influx task.

</details>

<details class="qa-item">
<summary>MongoDB sharded cluster: find({ status: "ACTIVE" }) without shard key in query. What happens?</summary>

Broadcast to all shards (scatter-gather); each shard COLLSCAN or index scan; mongos merges/sorts. Latency and load scale with cluster size. Fix: include shard key in query, or create targeted aggregation with `$match` on shard key first, or unshard/redesign (status rarely alone should drive query).

</details>

<details class="qa-item">
<summary>How do you migrate 1TB Postgres table to Cassandra without downtime?</summary>

Strangler: CDC/Debezium snapshot + stream to Cassandra writer with idempotent upsert; dual-write phase; reconciliation counts/checksums per partition; shadow reads; flip read traffic by cohort; keep Postgres until reconciliation green 14+ days. Load test Cassandra with production query patterns before cutover. Never big-bang stop writes.

</details>

<details class="qa-item">
<summary>DynamoDB on-demand table throttled on a single partition key. Adaptive capacity didn't help. Why?</summary>

Adaptive capacity cannot split a single hot **partition key value** — one key = one partition ceiling (~3000 RCU / 1000 WCU). Fix: split key (`SHARD#${hash % 16}#USER#id`), write sharding, cache, or queue. Contributor Insights confirms hot key.

</details>

<details class="qa-item">
<summary>Spring Data Cassandra repository method findByEmail — what will happen at runtime?</summary>

Unless `email` is partition key or a heavily restricted table, Spring Data generates query missing partition key → full table scan / ALLOW FILTERING error. Fix: model `users_by_email` table with `PRIMARY KEY (email)` or add lookup table; use explicit @Query with partition key only.

</details>

<details class="qa-item">
<summary>When is denormalizing product name into order documents correct vs wrong?</summary>

Correct when name is **historical snapshot** ("what customer saw at purchase") — immutable. Wrong when showing current catalog name without update path — needs CDC/outbox fan-out on product rename. Document which semantics the field has in schema review.

</details>

<details class="qa-item">
<summary>Cassandra tombstone warning during batch delete of 500k rows in one partition. Fix?</summary>

Delete in smaller time buckets via TTL, drop partition by rewriting table with time bucket in key, use TWCS, run deletes off-peak with lower batch size, or truncate table if whole bucket expires. Prevent unbounded partitions so delete scope stays small.

</details>

<details class="qa-item">
<summary>Design access patterns for: user inbox, message by id, latest messages in thread. Cassandra tables?</summary>

At minimum: `messages_by_thread ((thread_id, month_bucket), msg_id)` for latest/range; `message_by_id (msg_id)` for permalink; `inbox_by_user (user_id, last_activity, thread_id)` for inbox list. Three tables, three writes — normal Cassandra tradeoff.

</details>

<details class="qa-item">
<summary>Postgres + Redis cache-aside: update price in DB, @CacheEvict missed one service. Outcome?</summary>

Split-brain prices across services until TTL expires. Fix: stop per-service eviction; publish PriceChanged event all services consume, or versioned cache keys, or short TTL on price only. Owner is Postgres; cache is disposable projection.

</details>

<details class="qa-item">
<summary>Elasticsearch: why heap > 31GB often hurts performance?</summary>

JVM loses Compressed OOPs above ~32GB heap — pointers double size, effective usable heap drops, GC pressure rises. Better: more nodes with ≤31GB heap each, offload heavy aggregations, use doc values, avoid fielddata on text.

</details>

<details class="qa-item">
<summary>MongoDB 16MB document limit hit on embedded comments array. Quick tactical vs strategic fix?</summary>

Tactical: archive old comments to `comments_archive` collection via `$out`, trim array. Strategic: comments as separate collection `{ postId, createdAt, _id }` with index; paginate; never unbounded embed. Root cause is modeling unbounded 1:N inside document.

</details>

<details class="qa-item">
<summary>How to verify dual-write migration reconciliation?</summary>

Per entity key: count match, checksum/hmac of sorted ids, sample field equality, max(timestamp) lag. Automate nightly; alert on any drift. Block phase 3 cutover until zero drift window met. Log drift samples for replay tooling.

</details>

<details class="qa-item">
<summary>Graph DB for org chart (depth max 5, 2k employees). Overkill?</summary>

Probably yes — adjacency list in Postgres with recursive CTE or closure table handles fixed shallow depth. Neo4j pays off when depth varies, relationship types multiply, or path queries are core product (fraud, permissions, recommendations).

</details>

<details class="qa-item">
<summary>InfluxDB series cardinality 30M after adding pod_name tag on K8s metrics. Action plan?</summary>

Remove high-cardinality tag from allowlist; use lower-cardinality `deployment`, `namespace`; push pod-level detail to logs/traces; drop and recreate bucket if needed; add ingest validation rejecting unknown tags; use recording rules for aggregates that don't need pod granularity.

</details>

<details class="qa-item">
<summary>What question do you ask first in a NoSQL design review?</summary>

"List every query with expected QPS, latency SLO, and consistency requirement — and which one is the partition/shard key for each." If they cannot answer, stop feature work and model access patterns. Store selection comes after queries are enumerated.

</details>

<details class="qa-item">
<summary>DynamoDB LSI vs GSI: customer wants strongly consistent query on alternate sort key within same PK. Possible?</summary>

LSI supports strong consistency and shares partition with base table, but only creatable at table creation, max 5, 10GB item collection limit per PK across LSIs. GSI is eventually consistent only. If requirement is real and table new, LSI may fit; if table exists, redesign item collection on base PK or accept eventual GSI.

</details>

<details class="qa-item">
<summary>Redis `KEYS *` in production admin script caused outage. Alternative?</summary>

`SCAN` with cursor in off-peak, or maintain key indexes in a Redis set on write, or use `redis-cli --bigkeys` sampling, or centralized key naming conventions with known prefixes. Ban `KEYS` in CI/lint for app code; single-threaded Redis blocks on KEYS.

</details>

<details class="qa-item">
<summary>Single-table DynamoDB: USER#1 orders and PROFILE under same PK. Query returns mixed types. How to filter cleanly?</summary>

Use SK prefix conditions: `begins_with(SK, 'ORDER#')` vs exact `SK = 'PROFILE'`. Encode type in SK; optionally add `entityType` attribute for FilterExpression (post-key-filter, still better than Scan). Design SK namespace conventions upfront (`ORDER#`, `ADDRESS#`, `PROFILE`).

</details>

<details class="qa-item">
<summary>After enabling MongoDB readConcern majority on secondary, latency doubled. Expected?</summary>

Yes — secondaries wait until they apply oplog through majority commit point before returning. Fix: read from primary if needed, or accept staleness with `local`, or tune write concern vs read concern pairs per endpoint. Don't blanket majority on all reads without SLO analysis.

</details>

<details class="qa-item">
<summary>When would you choose ScyllaDB over Cassandra?</summary>

When you need lower tail latency, better shard-per-core utilization, and team can adopt Scylla-specific tuning — same data model and CQL mental model. Not a free migration: different repair, tooling, and ops runbooks. Choose for performance/latency SLO, not because "Cassandra is old."

</details>

<details class="qa-item">
<summary>Production incident: all NoSQL stores healthy but app p99 high. Next step?</summary>

Split trace: app time vs DB time vs network. Check connection pool exhaustion, N+1 ORM/repository calls, serialization payload size, retry storms, and missing timeouts. Half of "database slowness" is client-side fan-out or GC. Only then deep-dive store-specific playbook.

</details>
