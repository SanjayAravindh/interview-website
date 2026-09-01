# Distributed Systems Fundamentals — Senior Production Reference

Microservices, multi-region deployments, and cloud-native stacks. This is not a textbook chapter on theoretical CS. It is the map of what actually breaks in production after shipping distributed backends — when the network is not reliable, clocks lie, and "it worked on my laptop" means nothing.

---

## Table of Contents

1. [Mental Model: What Breaks First in Distributed Systems](#1-mental-model-what-breaks-first-in-distributed-systems)
2. [CAP Theorem](#2-cap-theorem)
3. [PACELC Theorem](#3-pacelc-theorem)
4. [Consistency Models — The Full Spectrum](#4-consistency-models-the-full-spectrum)
5. [Strong Consistency](#5-strong-consistency)
6. [Eventual Consistency](#6-eventual-consistency)
7. [Session Guarantees — Read-Your-Writes, Monotonic Reads, Consistent Prefix](#7-session-guarantees-read-your-writes-monotonic-reads-consistent-prefix)
8. [Network Partitions](#8-network-partitions)
9. [Failure Detection — Heartbeats, Timeouts, and Phi-Accrual](#9-failure-detection-heartbeats-timeouts-and-phi-accrual)
10. [Split Brain](#10-split-brain)
11. [Split Brain Prevention in Practice](#11-split-brain-prevention-in-practice)
12. [Clock Synchronization](#12-clock-synchronization)
13. [Logical Clocks, Vector Clocks, and Hybrid Logical Clocks](#13-logical-clocks-vector-clocks-and-hybrid-logical-clocks)
14. [Distributed Consensus](#14-distributed-consensus)
15. [Quorum](#15-quorum)
16. [Leader Election](#16-leader-election)
17. [Fencing Tokens](#17-fencing-tokens)
18. [Idempotency and Exactly-Once Reality](#18-idempotency-and-exactly-once-reality)
19. [CRDTs — Conflict-Free Replicated Data Types](#19-crdts-conflict-free-replicated-data-types)
20. [Backpressure and Queueing Theory](#20-backpressure-and-queueing-theory)
21. [Distributed Systems Failure Catalog](#21-distributed-systems-failure-catalog)
22. [Putting It Together: System Profiles](#22-putting-it-together-system-profiles)
23. [Production Debugging Playbook](#23-production-debugging-playbook)
24. [Quick Decision Matrix](#24-quick-decision-matrix)

---


## 1. Mental Model: What Breaks First in Distributed Systems

A distributed system is a collection of **independent computers** that appear to the user as **one coherent system**. The word "independent" is the entire problem. Each node has its own CPU, memory, clock, disk, and network interface. They communicate over a network that can delay, drop, reorder, duplicate, or partition messages.

```
Client
  └─ Load balancer
       ├─ Service A (pod 1) ──► Cache (Redis)
       ├─ Service A (pod 2) ──► Message broker (Kafka)
       └─ Service B (pod N) ──► Database (PostgreSQL primary + replicas)
            └─ Cross-AZ network (can partition, can add 50–200ms RTT)
```

Three facts you must internalize before CAP, PACELC, or consensus make sense:

| Fact | What it means in production |
|---|---|
| **There is no shared memory** | Two services cannot atomically update the same variable. "Lock in Redis" is still a network call. |
| **There is no global clock** | `System.currentTimeMillis()` on two machines can disagree by seconds. Ordering by timestamp is a heuristic, not truth. |
| **Failures are partial and correlated** | One AZ goes dark; half your Kafka ISR survives; the DB primary fails over but apps still point at the old IP for 30 seconds. |

The senior misdiagnosis pattern: treating distributed failures like single-process bugs. "We added a retry" does not fix split brain. "We use transactions" does not fix cross-service consistency unless you designed for it (2PC, sagas, outbox, or accepting eventual consistency).

**Latency is a consistency input.** A "strongly consistent" read that takes 400 ms under partition may be worse for the business than a stale read that takes 5 ms — PACELC exists because CAP ignores normal-operation trade-offs.

**The network is not "usually fine."** It is fine until it isn't, and when it isn't, every design choice you made under "happy path" gets audited at 3 AM.

### Production scenario: "It works in staging"

**Problem.** A fintech team ships an inventory service with in-memory locks (`synchronized`) inside each pod. Staging has one replica. Black Friday: three pods, oversold 400 units. Root cause: each pod thought it had exclusive access to inventory count in its JVM heap.

**Solution.** Move authoritative state to a single source (DB row with `SELECT ... FOR UPDATE`, or Redis `WATCH`/`MULTI`, or dedicated inventory partition in Kafka with single consumer). Accept that coordination has a cost — measure it.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Assuming single-node semantics in a cluster | Duplicate charges, double inventory deduction, lost updates |
| Using wall-clock time for ordering across services | Events applied out of order; "later" writes win incorrectly |
| No idempotency keys on retries | Duplicate side effects after timeout + retry |
| Health check passes but dependency is degraded | Traffic routed to nodes that fail every write |
| Treating cache as source of truth | Stale reads served as current; cache invalidation races |

### Debugging scenario

**Observe.** Users report "I paid but order is pending." Payment service logs show success; order service shows no payment event.

**Diagnose.** Trace IDs across services. Check: Was the HTTP call retried after a timeout? Did the message publish fail after DB commit? Is the consumer lagging or in a rebalance loop? Look for **at-least-once delivery without idempotency**.

**Fix.** Outbox pattern for payment → order; idempotency key on order creation; monitor consumer lag and DLQ depth.

---

## 2. CAP Theorem

### Core concept

**CAP** (Brewer, 2000): In the presence of a **network partition**, a distributed data store must choose between:

- **C — Consistency:** Every read receives the most recent write or an error. Linearizable / strong semantics across all nodes.
- **A — Availability:** Every request receives a non-error response, without guarantee that it reflects the latest write.
- **P — Partition tolerance:** The system continues to operate despite arbitrary message loss or delay between nodes (i.e., the network can "split" subsets of nodes from each other).

The theorem says you cannot have all three **at the same time during a partition**. In practice **P is not optional** — networks partition. So the real choice during a partition is **CP** or **AP**.

```
        Consistency (C)
              /\
             /  \
            /    \
           /  CA  \     ← CA systems exist only in theory / single-node
          /________\
   Availability (A) ——— Partition tolerance (P)  [P is mandatory in distributed systems]
```

**During normal operation** (no partition), you can often achieve both C and A. CAP is about the **failure mode**, not the steady state.

### Internal working — what "partition" means

A partition is not "the whole datacenter is down." It is **any** situation where some nodes cannot communicate with others, but clients may still reach **both sides**:

```
     Zone A                    |  network cut  |                    Zone B
  [Node 1] [Node 2]            |               |            [Node 3] [Node 4]
       ↑ clients still here     |               |     clients still here ↑
```

Example: Node 1 and 2 form a majority; Node 3 and 4 are isolated. If you require **C**, writes that cannot reach a quorum must **fail** (refuse write or block). If you require **A**, both sides may accept writes → **divergent state** when the partition heals (conflict resolution required).

### CP vs AP — concrete behavior

| Choice | During partition | Example systems | Trade-off |
|---|---|---|---|
| **CP** | Minority partition rejects writes (or entire cluster read-only) | etcd, ZooKeeper, Consul (with consistency mode), MongoDB primary (strict) | Unavailability on minority side; no stale writes |
| **AP** | All reachable nodes accept reads/writes | Cassandra, DynamoDB (tunable), Riak, CouchDB | Stale reads; conflicts; need LWW, CRDTs, or merge |

**CAP is about the data store's behavior under partition**, not your microservice's HTTP timeout. Your service can return 503 (available in the CAP sense for *some* nodes) while the cluster is CP internally.

### Production scenario: Redis Cluster split during AZ failure

**Problem.** E-commerce cart stored in Redis Cluster. AZ-a loses connectivity to AZ-b. Without proper cluster config, both sides accept writes. Carts merge incorrectly; items disappear or duplicate.

**Solution.** Understand Redis Cluster's CP-ish behavior: writes go to master; minority partition cannot elect new masters if quorum lost. Configure `cluster-node-timeout`, ensure odd number of masters across AZs, use **Redlock cautiously** (it is not a silver bullet — see Martin Kleppmann's analysis). For cart data, many teams accept AP with TTL + client-side merge or session stickiness to one AZ.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Declaring "we chose CAP-A" while using a CP database as SoT | Confusion in incident response; wrong expectations |
| Single-region "CA" mental model in multi-AZ deploy | Split brain on network blip |
| No documented partition behavior | On-call guesses whether to fail open or closed |
| Using CAP to justify any bug | "We're AP so duplicates are fine" without product sign-off |

### Debugging scenario

**Observe.** During a network incident, half of API calls return 503 from the DB layer; the other half succeed with **old** data.

**Diagnose.** CP system: minority partition correctly rejecting writes; clients hitting replicas not caught up. Check replication lag, quorum size, which AZ lost majority.

**Fix.** Route traffic to quorum side; mark degraded mode in UI; do not "fix" by disabling quorum checks.

---

## 3. PACELC Theorem

### Core concept

**PACELC** (Abadi, 2012) extends CAP:

- **If P (Partition):** choose **A** or **C** (same as CAP).
- **Else (normal operation):** choose **L (Latency)** or **C (Consistency)**.

CAP ignores the everyday trade-off: even without partition, strong consistency often costs extra round-trips (read from leader, quorum reads, cross-region sync).

```
                    Partition?
                   /          \
                 Yes           No
                /                \
           PA or PC            EL or EC
        (Availability          (Latency vs
         vs Consistency)        Consistency)
```

### PACELC classifications (informal but useful in interviews)

| System | P | Else |
|---|---|---|
| **Dynamo / Cassandra** | PA | EL (tunable consistency; default favors latency) |
| **MongoDB** | PC | EL (replica reads can be stale) |
| **PostgreSQL (sync rep)** | PC | EC (sync replica = higher commit latency) |
| **etcd / ZooKeeper** | PC | EC |
| **Spanner** | PC | EC (TrueTime bounds clock uncertainty; still pays latency for global consistency) |

**Interview line that lands:** "CAP tells you what happens when the network breaks; PACELC tells you what you trade every day when it doesn't."

### Internal working — latency vs consistency in normal operation

Strong read paths often require:

1. Contact leader or quorum of replicas.
2. Wait for replication acknowledgment.
3. Avoid local replica serve (or use "read your writes" session tokens).

Example — Cassandra `QUORUM` read:

```
Client → Coordinator → Replica 1 (digest)
                    → Replica 2 (digest)
                    → Replica 3 (digest)
         merge + repair if mismatch  (adds RTT vs ONE)
```

Example — PostgreSQL synchronous replication:

```
Client → Primary → WAL flush locally
                → wait for standby ACK  (adds 1 RTT to commit)
                → COMMIT to client
```

### Production scenario: "We need strong consistency" on a globally distributed app

**Problem.** Product demands linearizable reads worldwide. Team deploys CockroachDB/Spanner-style expectations on async-replicated Postgres with read replicas in 5 regions. Reads from local replica show stale inventory; overselling returns.

**Solution.** Pick explicitly:

- **EC path:** All reads/writes to primary region; edge caches with short TTL; accept cross-region write latency.
- **EL path:** Local replica reads with version checks; sagas/compensation for oversell rare cases.
- **True EC (Spanner-like):** Budget for GPS/atomic clock infra and cross-region Paxos latency.

Document PACELC choice in ADR; do not let each team infer differently.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `readPreference=nearest` with financial balances | Stale balance displayed; user overdrafts |
| Async replication + "strong consistency" SLA | SLA breach only under load |
| Ignoring EL cost in API design | p99 latency spikes when enabling quorum reads |

### Debugging scenario

**Observe.** p99 read latency doubled after enabling "strong reads" flag.

**Diagnose.** Measure round-trips per read path. Check if reads now hit leader cross-AZ. PACELC: you bought EC at the cost of L.

**Fix.** Scope strong reads to operations that need them (balance before transfer); use eventual for catalog browsing.

---

## 4. Consistency Models — The Full Spectrum

### Core concept

A **consistency model** is a contract between the distributed store and the application: **what values can a read return, and when?** Stronger models are easier to reason about but cost latency and availability.

```
Strongest ◄────────────────────────────────────────────► Weakest
Linearizability → Sequential → Causal → PRAM → Eventual → Weak
```

| Model | Guarantee (intuition) | Typical use |
|---|---|---|
| **Linearizability** | Every operation appears to happen atomically at some point between its start and end; real-time order respected | Leader election, distributed locks, money ledger |
| **Sequential consistency** | All nodes see same order of ops; not necessarily real-time order | Some shared-memory formal models |
| **Causal consistency** | Causally related ops seen in order; concurrent ops may differ | Social feeds, comment threads |
| **Read-your-writes** | Session sees its own updates | User profile after save |
| **Monotonic reads** | Session never sees older data after seeing newer | Pagination, dashboards |
| **Eventual consistency** | If no new writes, all replicas converge | DNS, CDN, Cassandra with ONE |
| **Weak / monotonic writes** | Minimal guarantees | Metrics, analytics pipelines |

**CAP "Consistency"** maps most closely to **linearizability** in formal literature — but vendors often mean "no stale replica reads" or "atomic visibility," which is weaker. Always ask **which consistency**.

### Internal working — session and consistency tokens

Many AP systems offer **tunable consistency** via:

- **Consistency level** per query (`ONE`, `QUORUM`, `ALL`).
- **Session tokens** (Dynamo-style): after write, client sends token with read; coordinator routes to replica that has seen token.
- **Version vectors / Lamport clocks** for causal ordering.

```
Write(v=5) → returns token T5
Read + token T5 → coordinator picks replica ≥ T5
Read without token → may return v=3 from stale replica
```

### Production scenario: inconsistent product catalog after cache + DB + search index

**Problem.** Product price updated in PostgreSQL; Redis cache invalidated via fire-and-forget; Elasticsearch async indexer 30s behind. User sees three prices on listing page, detail page, and checkout.

**Solution.** Define **consistency tiers** per surface:

- Checkout: read through primary DB or strong cache with locking.
- Detail: cache-aside with version stamp; reject stale checkout if version mismatch.
- Search: label "prices may vary" or hide price in search results.

Use **outbox + CDC** for index sync; monitor lag.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Mixing models in one user journey without UX handling | "Ghost" states, flip-flopping UI |
| No version field on entities | Lost updates, last-writer-wins surprises |
| Assuming ORM `@Transactional` crosses services | Partial commits across boundaries |

### Debugging scenario

**Observe.** Bug "only happens sometimes" on multi-tab usage.

**Diagnose.** Session stickiness lost → read-your-writes broken. User writes on tab A (pod 1), reads on tab B (pod 2 stale cache).

**Fix.** Session affinity or centralized session store; include user session version in cache key.

---

## 5. Strong Consistency

### Core concept

**Strong consistency** in production usually means one of:

1. **Linearizability** — gold standard for correctness proofs.
2. **Sequential + external consistency** — Spanner's marketing aligns here.
3. **Pragmatic strong** — all reads go to leader; sync replication; no stale replica reads.

Single-node RDBMS transactions are strongly consistent **within one database**. Distributed strong consistency requires **consensus or single leader + sync replication**.

### Internal working — mechanisms

| Mechanism | How it provides strength | Cost |
|---|---|---|
| **Single leader** | All writes through one node; reads from leader or sync replicas | Leader bottleneck; failover complexity |
| **Quorum reads/writes** | R + W > N prevents stale quorum read | Extra RTT; tuning needed |
| **Consensus log (Raft/Paxos)** | Agreed order of ops applied identically | Latency; majority required |
| **2PC / XA** | Atomic commit across resources | Blocking; fragile under partition |
| **Spanner TrueTime** | Commit wait for clock uncertainty bound | Infrastructure; cross-region latency |

**Linearizability check (informal):** If operation A completes before B starts (in real time), A must appear before B in the history all clients see.

### Raft write path (simplified)

```
Client → Leader: append entry
Leader → Followers: AppendEntries RPC
Majority ack → commit on leader → apply state machine → ack client
Followers apply when entry committed
```

If leader isolated (minority), it cannot commit; new leader elected on majority partition → **no split brain commits** when protocol followed.

### Production scenario: money transfer between accounts

**Problem.** Transfer debits account A on service 1, credits account B on service 2. Network timeout after debit; retry credits twice.

**Solution options (strongest to most practical):

1. **Single ledger DB** — both accounts in one transactional store (simplest strong consistency).
2. **Saga with compensation** — not linearizable globally; business accepts interim states with clear UX.
3. **2PC across DBs** — strong but fragile; rarely used at scale across heterogeneous stores.

Senior answer: "Strong consistency for money usually means **one authoritative ledger** or **consensus on the transfer command** (event sourcing + single partition), not two-phase REST calls."

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Read from async replica for balance | Double spend visibility |
| Leader election without fencing | Zombie leader writes after partition heals |
| `READ COMMITTED` assumed sufficient for invariant | Lost updates under concurrent transactions |

### Debugging scenario

**Observe.** After DB failover, duplicate primary keys in a sharded system.

**Diagnose.** Split brain: two nodes thought they were primary; both accepted writes. Check STONITH, `etcd` lease, MongoDB replica set election rules.

**Fix.** Enable fencing tokens; use consensus-managed leader; run reconciliation job with audit.

---

## 6. Eventual Consistency

### Core concept

**Eventual consistency:** If updates stop, all replicas **eventually** converge to the same value. No guarantee **when**, and reads **during** convergence may return stale or divergent values.

This is not "no consistency." It is a **deliberate contract** enabling AP systems, geo-replication, and high write availability.

### Internal working — convergence mechanisms

1. **Anti-entropy repair** — background comparison and merge (Merkle trees in Cassandra).
2. **Read repair** — on read, coordinator fixes stale replicas.
3. **Hinted handoff** — temporary storage for writes when replica down.
4. **Last-writer-wins (LWW)** — timestamp decides winner (dangerous with clock skew).
5. **CRDTs** — mathematically mergeable structures (counters, sets, OR-sets).
6. **Operational transform / custom merge** — domain-specific conflict resolution.

```
Time ──►
Replica A:  v=10 ──write v=15──► v=15
Replica B:  v=10 ──write v=12──► v=12  (partition)
         ... partition heals ...
Merge(LWW): v=15 if ts(15) > ts(12)  OR  conflict flag for manual merge
```

### Production scenario: shopping cart across devices

**Problem.** User adds item on phone (AP region US); laptop (AP region EU) shows empty cart for 2 minutes.

**Solution paths:

- **Session/user cart key** with `QUORUM` writes for cart mutations only (PACELC: pay latency on cart path).
- **CRDT cart** (add-wins set) for merge without loss.
- **UX:** show "syncing" state; merge on login.

Product must accept stale window or pay coordination cost.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| LWW with unsynchronized clocks | Wrong winner; data loss silent |
| No conflict detection | Lost updates invisible until audit |
| Deleting "losing" branch without audit | Compliance / support cannot explain state |

### Debugging scenario

**Observe.** Cassandra repair jobs running constantly; p99 reads elevated.

**Diagnose.** High write divergence during partition recovery; check `gc_grace_seconds`, tombstone accumulation, inconsistent read levels (`LOCAL_ONE` writes + `QUORUM` reads mismatch).

**Fix.** Align CL policies; run incremental repair on schedule; consider STRONG for critical column family only.

---

## 7. Session Guarantees — Read-Your-Writes, Monotonic Reads, Consistent Prefix

### Core concept

Global consistency models (linearizability, causal) are expensive because they constrain **all** clients. **Session guarantees** (also called *client-centric consistency*) are much cheaper: they constrain only what **one client's own session** can observe. In 90% of "our app feels broken" bug reports, the missing property is a session guarantee, not linearizability.

| Guarantee | Contract for a single session | Bug you see without it |
|---|---|---|
| **Read-your-writes (RYW)** | A read after your own write sees that write or newer | User saves profile, page reloads showing old name |
| **Monotonic reads** | Once you have seen version V, you never see < V | Refresh shows the new comment, refresh again and it's gone |
| **Monotonic writes** | Your writes are applied in the order you issued them | "Set status=active" then "set plan=pro" applied in reverse |
| **Writes-follow-reads** | A write you make after reading V is ordered after V | Reply appears before the message it replies to |
| **Consistent prefix reads** | You see writes in an order consistent with some causal prefix — never a gap | You see message #3 and #5 but never #4 |

These are **per-session**, so two different users may legitimately see different states. That is usually fine. What is never fine is one user watching their own data go backwards.

### Internal working — the three implementation strategies

**Strategy 1: sticky routing.** Pin the session to one replica (or one region). Simple, and gives RYW + monotonic reads for free because a single replica's own log is monotonic. Fails when the replica dies (session loses its guarantees exactly when you need them most) and creates hot replicas.

**Strategy 2: version/LSN tokens.** The write path returns a monotonic position (Postgres LSN, MongoDB `operationTime` + cluster time, Cosmos DB session token, Cassandra write timestamp, Kafka offset). The client echoes it on subsequent reads; the read path either routes to a replica that has applied ≥ token, or waits, or falls back to the primary.

**Strategy 3: read from primary for tainted keys.** After a write, mark `(session, entityId)` "recently written" in a short-TTL store (Redis, 5× measured p99 replication lag). Reads for that pair bypass replicas. Cheapest retrofit for an existing app with no token plumbing.

```
Client              API                 Primary            Replica
  │  PUT /profile     │                    │                  │
  ├──────────────────►│  UPDATE ...        │                  │
  │                   ├───────────────────►│                  │
  │                   │  lsn=0/16B3748     │──── async WAL ──►│  (lags 40ms–8s)
  │◄── 200 + X-Read-Token: 0/16B3748 ──────┤                  │
  │                   │                    │                  │
  │  GET /profile     │                    │                  │
  │  X-Read-Token: 0/16B3748               │                  │
  ├──────────────────►│  replica_lsn ≥ token ? read replica : read primary
```

### How much staleness are you actually hiding?

Measure it, do not guess. Postgres:

```sql
-- On each standby: how far behind is it, in bytes and seconds?
SELECT pg_last_wal_receive_lsn()                     AS received,
       pg_last_wal_replay_lsn()                      AS replayed,
       pg_wal_lsn_diff(pg_last_wal_receive_lsn(),
                       pg_last_wal_replay_lsn())     AS replay_bytes_behind,
       EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS seconds_behind;

-- On the primary: per-standby flush/replay positions
SELECT application_name, state, sent_lsn, flush_lsn, replay_lsn,
       write_lag, flush_lag, replay_lag
FROM   pg_stat_replication;
```

Rule of thumb for token TTL / stickiness window: `5 × p99(replay_lag)`, floor of 2 seconds, and alarm if p99 replay lag exceeds 25% of that window.

### Java: passing a version token through a request

```java
// Contract: every mutating response carries X-Read-Token; clients echo it on reads.
public record ReadToken(long lsn) {
    static final String HEADER = "X-Read-Token";
    static ReadToken parse(String raw) {
        return (raw == null || raw.isBlank()) ? new ReadToken(0L) : new ReadToken(Long.parseLong(raw));
    }
}
```

```java
/** Per-request holder so the routing DataSource can see the client's token. */
public final class ReadTokenContext {
    private static final ThreadLocal<Long> REQUIRED_LSN = new ThreadLocal<>();

    public static void require(long lsn) { REQUIRED_LSN.set(lsn); }
    public static long required()        { Long v = REQUIRED_LSN.get(); return v == null ? 0L : v; }
    public static void clear()           { REQUIRED_LSN.remove(); }
}
```

```java
@Component
public class ReadTokenFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        try {
            ReadTokenContext.require(ReadToken.parse(req.getHeader(ReadToken.HEADER)).lsn());
            chain.doFilter(req, res);
        } finally {
            ReadTokenContext.clear(); // MUST clear: thread pools are reused
        }
    }
}
```

```java
/**
 * Routes reads to a replica only when that replica has replayed past the client's token.
 * Replica positions are refreshed by a background poller, not per request.
 */
public class LsnAwareRoutingDataSource extends AbstractRoutingDataSource {

    private final ReplicaLsnRegistry registry; // name -> last known replay LSN

    public LsnAwareRoutingDataSource(ReplicaLsnRegistry registry) { this.registry = registry; }

    @Override
    protected Object determineCurrentLookupKey() {
        if (TransactionSynchronizationManager.isCurrentTransactionReadOnly()) {
            long needed = ReadTokenContext.required();
            return registry.replicaAtOrAfter(needed)   // Optional<String>
                           .orElse("primary");         // fail safe, never fail stale
        }
        return "primary";
    }
}
```

```java
@RestController
@RequestMapping("/profiles")
public class ProfileController {

    private final ProfileService service;

    ProfileController(ProfileService service) { this.service = service; }

    @PutMapping("/{id}")
    public ResponseEntity<ProfileView> update(@PathVariable String id, @RequestBody ProfileUpdate body) {
        // service.update() returns the commit LSN captured inside the write transaction
        WriteResult<ProfileView> result = service.update(id, body);
        return ResponseEntity.ok()
                .header(ReadToken.HEADER, Long.toString(result.lsn()))
                .body(result.value());
    }

    @GetMapping("/{id}")
    public ResponseEntity<ProfileView> get(@PathVariable String id) {
        // Routing already happened in LsnAwareRoutingDataSource based on the echoed token.
        ProfileView view = service.findById(id);
        return ResponseEntity.ok()
                .header(ReadToken.HEADER, Long.toString(ReadTokenContext.required()))
                .body(view);
    }
}
```

Capturing the commit position inside the write transaction:

```java
@Transactional
public WriteResult<ProfileView> update(String id, ProfileUpdate body) {
    ProfileEntity saved = repo.save(repo.getReferenceById(id).apply(body));
    // pg_current_wal_insert_lsn() read in the same TX is >= this write's position
    long lsn = jdbc.queryForObject(
        "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '0/0')::bigint", Long.class);
    return new WriteResult<>(ProfileView.of(saved), lsn);
}
```

**Monotonic reads** come free from the same token if the client always echoes the **maximum** token it has ever seen — that is the client-side rule that matters:

```java
// Browser / mobile SDK side
private final AtomicLong highWaterMark = new AtomicLong(0);

void observe(HttpResponse<?> res) {
    long seen = ReadToken.parse(res.headers().firstValue(ReadToken.HEADER).orElse(null)).lsn();
    highWaterMark.accumulateAndGet(seen, Math::max); // never go backwards
}
```

### Exposing it at the API layer

Do not leak raw LSNs to third parties — they are internal, cluster-specific, and go backwards after a restore from backup. Wrap them:

```java
// Opaque, signed, cluster-scoped so a token from cluster A cannot be replayed on cluster B.
static String encode(long lsn, String clusterId, byte[] key) { /* HMAC(lsn|clusterId) + base64url */ }
```

```yaml
# OpenAPI documentation of the contract — make the guarantee part of the API, not folklore
components:
  headers:
    X-Read-Token:
      description: >
        Opaque consistency token. Echo the highest value you have received to obtain
        read-your-writes and monotonic reads. Tokens expire after 10 minutes; expired
        tokens fall back to primary reads. Omitting the header means eventually
        consistent reads with up to 10s staleness.
      schema: { type: string, maxLength: 128 }
```

Vendor-native equivalents worth naming in an interview:

| Store | Session mechanism |
|---|---|
| **MongoDB** | Causal consistency sessions: `startSession(causalConsistency: true)`, `afterClusterTime` on reads |
| **Azure Cosmos DB** | `Session` consistency level with an explicit session token per client |
| **DynamoDB** | `ConsistentRead=true` per `GetItem` (leader read, 2× RCU cost) |
| **Cassandra** | No native session tokens; use `LOCAL_QUORUM` R+W, or sticky coordinator |
| **PostgreSQL** | LSN comparison + `recovery_min_apply_delay=0`; pgpool/pgcat lag-aware routing |
| **Kafka Streams** | `read-your-writes` via interactive queries + offset lag checks on the state store |

### Production scenario: "Save worked, then my change vanished"

**Problem.** A HR SaaS moves 70% of read traffic to three Postgres read replicas to cut primary CPU. Within a day, support tickets spike: managers edit an employee record, the success toast appears, the page reloads showing the **old** values, and they edit again — creating duplicate audit entries and, in 14 cases, overwriting a colleague's concurrent edit. Errors: none. Dashboards: green.

**Cause.** The ORM's read-only routing sent the post-save `GET` to a replica lagging 300 ms–9 s (nightly bulk import pushed replay lag to 9 s). Read-your-writes was silently dropped when replicas were introduced. The duplicate edits came from users retrying, and the lost updates came from the second edit being computed from stale field values (no optimistic locking either).

**Solution.** Three layers, cheapest first:

```java
// 1. Immediate mitigation: 30s "recently written" taint per (user, entity) -> primary reads
@Around("@annotation(org.springframework.transaction.annotation.Transactional)")
public Object taintOnWrite(ProceedingJoinPoint pjp) throws Throwable {
    Object out = pjp.proceed();
    taintStore.taint(currentUserId(), entityIdOf(pjp), Duration.ofSeconds(30));
    return out;
}
```

```java
// 2. Proper fix: LSN token plumbed through the API (code above) + optimistic locking
@Entity
public class EmployeeEntity {
    @Id private UUID id;
    @Version private long version;   // rejects the stale-read overwrite outright
}
```

```yaml
# Step 3 — Guardrail: alert before users notice
groups:
  - name: replication
    rules:
      - alert: ReplicaReplayLagHigh
        expr: max(pg_replication_lag_seconds) > 2
        for: 2m
        labels: { severity: warning }
        annotations:
          summary: "Replica lag {{ $value }}s exceeds the 2s read-your-writes window"
```

Math that justified the token work: p99 replay lag 9 s, ~4,200 profile saves/hour, and measurement showed 61% of saves were followed by a read within 3 s. Expected stale-read exposure was `4200 × 0.61 × P(lag > read delay) ≈ 190 bad reads/hour` — matching the ticket volume almost exactly.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Transactional(readOnly = true)` on a method called right after a write | Read hits replica; read-your-writes broken for that path only (hard to reproduce) |
| Session stickiness at the load balancer but not at the DB layer | RYW works until a pod restart, then breaks for a subset of users |
| Token stored in memory on the client, lost on tab refresh | Guarantee silently degrades to eventual on reload |
| Same token issued across clusters, then DR failover | Token compares against a different WAL timeline; reads block or fail forever |
| No maximum wait when waiting for a replica to catch up | Request pile-up during lag spikes → thread pool exhaustion |
| Monotonic reads assumed from "read from nearest replica" | Two nearest replicas alternate; user sees data flip back and forth |

### Debugging scenario

**Observe.** "Data goes backwards on refresh," reproducible only for some users, only sometimes.

**Diagnose.** Log the serving replica identity and its replay position on every read (`X-Served-By`, `X-Replica-Lsn`). Then group support-reported request IDs by replica. If a user's consecutive reads show a **decreasing** LSN, you have a monotonic-reads violation caused by cross-replica load balancing, not a cache bug.

**Fix.** Echo the max-seen token from the client, route with `LsnAwareRoutingDataSource`, and add a hard cap: if no replica satisfies the token within 50 ms, read the primary. Never serve a read you know violates the guarantee.

---

## 8. Network Partitions

### Core concept

A **network partition** is a failure mode where nodes are grouped into subsets that cannot communicate with each other, but **each subset may still serve clients**. Partitions are:

- Transient (seconds) or prolonged (hours).
- Partial (some links down) or complete between sets.
- Often asymmetric (A can reach B but not vice versa).

**CAP and split brain** are partition stories. Most production incidents are **partial failures** — one dependency slow, not full cut.

### Internal working — failure detectors and timeouts

Systems detect partitions via:

- **Heartbeats** — missed N beats → suspect / unreachable.
- **TCP timeouts** — ambiguous (slow vs dead).
- **Phi accrual failure detector** — Cassandra/Kafka use adaptive suspicion.
- **Lease expiration** — if holder doesn't renew, assume dead (requires clock care).

```
Node A ──heartbeat──► Node B
         (lost)
Node A marks B failed → may trigger re-replication, re-election
Node B may still be alive → dual activity if both sides "primary"
```

**Important:** Timeout does not prove death — it proves **uncertainty**. Retries amplify load during gray failures.

### Production scenario: Kubernetes network policy misconfiguration

**Problem.** New NetworkPolicy blocks pod-to-pod traffic between `payment` and `ledger` namespaces intermittently (CNIs reload). Payment service times out; circuit breaker opens; ledger never receives events; reconciliation gap grows.

**Solution.** Monitor **partial connectivity** (service mesh metrics, golden signals between pairs). Idempotent consumers; alert on breaker open > N minutes; chaos test network policies.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Aggressive keepalive vs load balancer idle timeout | Connection reset storms |
| Same timeout for all dependencies | Cascading retries |
| No jitter on retries | Thundering herd on recovery |
| Ignoring asymmetric partitions | Flapping leader elections |

### Debugging scenario

**Observe.** "Split" between two AZs — each thinks the other is down.

**Diagnose.** Traceroute / mesh telemetry; check recent deploy of network policy, DNS, security group. Correlate with maintenance window.

**Fix.** Roll back change; fail traffic to healthy AZ; verify quorum before accepting writes.

---

## 9. Failure Detection — Heartbeats, Timeouts, and Phi-Accrual

### Core concept

Every distributed system needs to answer "is node X dead?" and **no algorithm can answer it correctly**. In an asynchronous network, "no response for T seconds" is indistinguishable from "slow." A failure detector is therefore a **tunable guess**, characterized by two competing properties:

- **Completeness / detection time** — how fast do we notice a real crash?
- **Accuracy** — how rarely do we declare a live node dead (false positive)?

You cannot maximize both. Every knob you turn to detect faster increases false positives, and **every false positive on a leader is a potential split brain**.

```
            ┌──────────────── the only real tradeoff ────────────────┐
timeout →   short                                                long
detection   fast (200ms)                                  slow (30s)
false pos.  frequent  ← election storms, split brain       rare
downtime    low if accurate                        long stall on real crash
```

### Internal working — three families

**1. Fixed-timeout heartbeats.** Node sends `HEARTBEAT` every `Δi`; the monitor marks it dead after `Δto` with no beat. Simple, and terrible at handling load-dependent latency: a GC pause or a noisy neighbour looks identical to a crash.

```
detection_time ≈ Δto + Δi        (worst case: beat sent just before failure)
false_positive if  network_delay + gc_pause > Δto
```

**2. Phi-accrual (Hayashibara et al.; used by Cassandra, Akka Cluster, ScyllaDB).** Instead of a boolean, output a **suspicion level** φ derived from the distribution of recent inter-arrival times. If heartbeats historically arrive every 1 s ± 0.1 s and one is 1.2 s late, φ is low; if the pattern was tight and the beat is 5 s late, φ is high.

```
φ(t_now) = -log10( P(next heartbeat arrives later than t_now - t_last) )

Assume inter-arrival ~ Normal(mean, stddev) fitted over a sliding window.

φ = 1  →  ~10% chance we are wrong
φ = 2  →  ~1% chance
φ = 8  →  ~10^-8 chance   (Cassandra default threshold)
```

The value of φ is that it **adapts**: under a load spike that doubles all latencies, the fitted mean rises and φ stays low, so you do not fail over the whole cluster because the network got busy.

```yaml
# cassandra.yaml — phi threshold and window
phi_convict_threshold: 8          # raise to 10-12 on noisy cloud networks / EBS-backed nodes
failure_detector: org.apache.cassandra.gms.FailureDetector
# gossip interval is fixed at 1s; the window is the last 1000 intervals
```

```conf
# Akka Cluster (akka.cluster.failure-detector) — phi accrual, explicit knobs
akka.cluster.failure-detector {
  implementation-class = "akka.remote.PhiAccrualFailureDetector"
  heartbeat-interval   = 1 s
  threshold            = 8.0
  min-std-deviation    = 100 ms   # floor: prevents a too-tight distribution from over-reacting
  acceptable-heartbeat-pause = 3 s # explicit allowance for GC pauses
  expected-response-after = 1 s
}
```

`acceptable-heartbeat-pause` is the knob most teams need and never set. It is the honest admission that your JVM will stop for a second.

**3. Gossip / SWIM membership (Consul-Serf, Hashicorp Nomad, Redis Cluster, ScyllaDB, Uber Ringpop).** No central monitor. Each node periodically pings a random peer; on failure it asks **k other nodes** to probe the suspect (*indirect probe*), which filters out one-off network glitches and asymmetric partitions. Membership changes are then disseminated via infection-style gossip.

```
SWIM protocol period (every T = 1s):
  1. Node A picks random member B, sends PING, waits for ACK within T'
  2. No ACK  → A picks k=3 random members, sends PING-REQ(B)
  3. Each C  → PING B, forwards ACK to A if received      (indirect probe)
  4. Still nothing → A marks B "suspect", gossips SUSPECT(B, incarnation=7)
  5. B, on hearing SUSPECT about itself, gossips ALIVE(B, incarnation=8)  ← refutation
  6. If no refutation within suspicion_timeout → gossip CONFIRM(B) = dead

suspicion_timeout ≈ suspicion_mult × log(N+1) × probe_interval
  Consul default: 4 × log(N+1) × 1s  →  N=100: ~18s, N=1000: ~28s
```

Two mechanics carry all the weight:

- **Incarnation numbers** — a monotonic per-node counter that lets a node *refute* a false suspicion. Without it, a single false positive is permanent.
- **Indirect probes** — the reason SWIM tolerates asymmetric partitions (A cannot reach B, but C can).

```hcl
# Consul agent — LAN gossip tuning (consul.hcl)
performance {
  raft_multiplier = 1          # 1 = production/low-latency; 5 = dev. Multiplies ALL raft timers
}
# Effective LAN defaults, tune via the "wan"/"lan" gossip templates:
#   probe_interval        = 1s
#   probe_timeout         = 500ms
#   suspicion_mult        = 4
#   retransmit_mult       = 4
# WAN pool (cross-region) uses 5x larger values because RTT is 10-100x larger.
```

### Tuning numbers from real systems

| System | Heartbeat / probe | Declared-dead window | Notes |
|---|---|---|---|
| **etcd (Raft)** | `--heartbeat-interval 100ms` | `--election-timeout 1000ms` | Rule: election ≥ 10× heartbeat, and heartbeat ≥ p99 RTT |
| **Kubernetes kubelet → API** | `nodeLeaseDurationSeconds 40`, renew every 10 s | `node-monitor-grace-period 40s` | Then 5 min `pod-eviction-timeout` before pods are evicted |
| **Kafka (KRaft)** | `broker.heartbeat.interval.ms 2000` | `broker.session.timeout.ms 9000` | Controller fences the broker, shrinking ISR |
| **Kafka consumer group** | `heartbeat.interval.ms 3000` | `session.timeout.ms 45000` | Plus `max.poll.interval.ms 300000` for processing stalls |
| **Cassandra** | gossip 1 s | φ ≥ 8 (≈ 10 s typical) | `phi_convict_threshold` raise to 10–12 on cloud disks |
| **Consul LAN** | 1 s probe | ~18 s at N=100 | WAN pool ~5× slower on purpose |
| **MongoDB replica set** | `heartbeatIntervalMillis 2000` | `electionTimeoutMillis 10000` | Lower only with sub-ms, stable RTT |
| **Redis Sentinel** | 1 s PING | `down-after-milliseconds 30000` | Then quorum of Sentinels must agree |
| **HAProxy / ALB** | 2–5 s | 2–3 consecutive failures | Not a cluster failure detector — do not use it to gate leadership |

The universal rule: **`timeout > p99.9(RTT) + max_gc_pause + max_scheduler_delay`**. On a cloud VM with an untuned JVM, `max_gc_pause` alone can be 2 s, which is why a 1 s Sentinel timeout produces phantom failovers.

### How a false positive becomes a split brain

```
t=0.0s   Leader L (holding a 5s lease) enters a 6.5s stop-the-world GC pause
t=1.0s   Followers miss heartbeat #1
t=2.0s   Followers miss heartbeat #2
t=3.0s   Follower F1 timeout fires → becomes candidate, term 8
t=3.4s   F1 wins majority (F1 + F2 + F3), starts accepting writes as leader
t=5.0s   L's lease has expired — but L is not running, so it cannot know
t=6.5s   L resumes. Its last known state: "I am leader of term 7, lease valid until t=5.0"
         L's next action depends entirely on what it checks BEFORE writing:
           (a) writes immediately            → TWO LEADERS WROTE  → split brain
           (b) re-validates lease with quorum → learns term 8      → steps down (safe)
           (c) writes with fencing token 7    → storage rejects < 8 → safe
```

Path (a) is the default in hand-rolled leader election. Paths (b) and (c) are why Raft carries **term numbers on every RPC** and why you need [Fencing Tokens](#17-fencing-tokens).

### Production scenario: Sentinel failover storm from JVM GC

**Problem.** A payments read-cache tier (Redis primary + 2 replicas, 3 Sentinels) failed over 14 times in one afternoon. Each failover dropped ~4,000 in-flight commands and produced a 20–40 s window of `READONLY You can't write against a read only replica` errors from the Java clients. Redis itself logged no crash, no OOM, `INFO` showed uptime in days.

**Cause.** Two independent false positives stacked. The Redis host was co-tenanted with a batch job that saturated the NIC for 3–8 s at a time, and `down-after-milliseconds` was lowered to `3000` by a previous engineer "to fail over faster." Sentinel then convicted a perfectly healthy primary every time the NIC stalled. The clients' 40 s recovery came from Lettuce topology refresh being disabled.

**Solution.**

```conf
# sentinel.conf — detection window sized to observed stalls, not to wishes
sentinel monitor payments-cache 10.0.3.11 6379 2   # quorum 2 of 3 Sentinels
sentinel down-after-milliseconds payments-cache 15000   # was 3000; observed p99.9 stall = 8s
sentinel failover-timeout payments-cache 60000
sentinel parallel-syncs payments-cache 1
# Prevents promoting a replica that is far behind (implicit data-loss guard)
sentinel auth-pass payments-cache <secret>
```

```conf
# redis.conf on every node — stop a lagging replica from being a promotion candidate
replica-priority 100
min-replicas-to-write 1
min-replicas-max-lag 10
repl-ping-replica-period 5
```

```java
// Client side: make failover a 2s event instead of a 40s outage
@Bean
LettuceConnectionFactory redisConnectionFactory(RedisSentinelConfiguration sentinelConfig) {
    ClusterTopologyRefreshOptions.builder(); // (cluster mode analogue)
    ClientOptions options = ClientOptions.builder()
            .socketOptions(SocketOptions.builder()
                    .connectTimeout(Duration.ofMillis(500))
                    .keepAlive(true)
                    .build())
            .timeoutOptions(TimeoutOptions.enabled(Duration.ofSeconds(1)))
            .disconnectedBehavior(ClientOptions.DisconnectedBehavior.REJECT_COMMANDS)
            .build();

    LettuceClientConfiguration clientConfig = LettuceClientConfiguration.builder()
            .clientOptions(options)
            .commandTimeout(Duration.ofSeconds(1))
            .build();
    return new LettuceConnectionFactory(sentinelConfig, clientConfig);
}
```

Detection-window math that settled the argument: observed NIC stall distribution had p99 = 4.1 s and p99.9 = 8.3 s. With `down-after=3000ms`, the probability of at least one false conviction per hour across 3 nodes was near 1. Setting it to 15 s costs **12 extra seconds** of downtime on a genuine crash (a once-a-quarter event) and eliminated 14 outages in one afternoon. Trading 12 s of rare downtime for zero split-brain windows is the correct trade for a cache in front of a payments ledger.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Timeout tuned below max GC pause | Periodic phantom failovers correlated with GC logs |
| Election timeout < 10× heartbeat interval | Continuous leader churn, "leader changed" every few seconds |
| Same timeouts for LAN and WAN/gossip pools | Cross-region members flap in and out of membership |
| No indirect probing (naive heartbeat) | Asymmetric partition marks a healthy node dead permanently |
| Missing incarnation/refutation mechanism | A node once suspected can never rejoin without a restart |
| Load-balancer health check used as cluster membership | LB removes node, cluster still counts it in quorum — or vice versa |
| Health endpoint that only returns `200 OK` | Node with a dead DB pool stays in rotation (liveness ≠ readiness) |
| `raft_multiplier` left at 5 in production Consul | 5× slower detection and failover than intended |

### Debugging scenario

**Observe.** A cluster reports members flapping `alive → suspect → alive` every few minutes; no node actually restarts.

**Diagnose.** Correlate three time series on one graph: heartbeat inter-arrival p99, JVM GC pause duration (`jvm_gc_pause_seconds_max`), and network RTT between the specific pair. If GC spikes align with suspicion events, the detector is right about the symptom and wrong about the cause. If only one direction of a pair fails, you have an asymmetric partition (check security groups / NetworkPolicy, not the detector).

```promql
# Are we convicting nodes during pauses rather than crashes?
max_over_time(jvm_gc_pause_seconds_max[5m]) > 0.8 * (
  cluster_failure_detector_timeout_seconds
)
```

**Fix.** Raise `acceptable-heartbeat-pause` / φ threshold to cover measured p99.9 pauses, fix the pause (G1/ZGC tuning, heap sizing) in parallel, and ensure that any promotion resulting from a suspicion is fenced so a false positive costs availability, never correctness.

---

## 10. Split Brain

### Core concept

**Split brain** occurs when **two or more nodes believe they are the authoritative primary** for the same role (DB primary, Kafka controller, cluster leader), typically due to partition + imperfect failure detection. Both accept writes → **divergent irreconcilable state** without merge strategy.

Split brain is the **operational nightmare** of CP/AP debates: you wanted availability during partition and got two truths.

```
Partition:
  Side 1: [Primary?] [Replica]     |     Side 2: [Primary?] [Replica]
          accepts writes             |             accepts writes
          ──────────────────────────┼──────────────────────────────
                    clients on both sides get "success"
```

### Internal working — prevention vs cure

| Approach | Mechanism |
|---|---|
| **Quorum / majority** | Only majority partition may elect leader / accept writes |
| **Fencing (STONITH)** | New leader disables old leader via power/API token |
| **Epoch / generation numbers** | Reject writes from old epoch (object storage, some DBs) |
| **Tie-breaker node** | 3rd site witness (e.g., MongoDB arbiter — use carefully) |
| **Manual intervention** | Ops picks winner; discard loser data |

**Kafka** (KIP-500): metadata quorum prevents dual controllers in correct config.

**PostgreSQL**: primary + synchronous standby; avoid dual primary without external consensus (Patroni uses DCS with leader lock).

**Redis Sentinel/Cluster**: majority required for failover.

### Production scenario: Patroni split brain during etcd outage

**Problem.** Patroni uses etcd for leader lock. etcd degraded; two Postgres nodes promote themselves. Both accept writes for 90 seconds.

**Solution.** STONITH via cloud API; `nofailover` flags; ensure DCS has odd-member quorum across AZs; **fencing** hook kills old primary's VIP or shuts instance. Run `pg_rewind` or rebuild replica from backup on loser.

Post-incident: compare row counts; audit financial tables; event replay from outbox.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Two nodes with `primary` flag after partition heals | Duplicate key, conflicting business IDs |
| Arbiter without data center isolation | Wrong side wins election |
| `auto_failover` without `min_replicas_to_write` | Promote empty or stale node |
| No fencing | Zombie primary after "successful" failover |

### Debugging scenario

**Observe.** Duplicate invoice numbers after "brief network blip."

**Diagnose.** Check DB role history, Patroni/ Orchestrator logs, DCS lease times. Identify overlapping primary windows.

**Fix.** Stop loser immediately; restore from winner snapshot; implement sequences only on leader or use UUID.

---

## 11. Split Brain Prevention in Practice

### Core concept

Section 10 described the failure. This section is the **checklist of mechanisms that actually stop it**, with the exact configuration lines and the exact arithmetic of when data is lost. There are only four real mechanisms, and serious systems use three of them at once:

| Mechanism | What it guarantees | Where it fails |
|---|---|---|
| **Quorum writes** | A write is only durable if a majority acknowledged it; two disjoint majorities cannot exist | Useless if you also allow non-quorum writes ("unclean" promotion, `acks=1`) |
| **Epoch / generation / fencing tokens** | The **storage layer** rejects operations from a stale leader | Requires the storage layer to check; shared filesystems and object stores often do not by default |
| **STONITH / power fencing** | The old leader is physically unable to write | Needs out-of-band control (IPMI, cloud API); the fencing path itself can be partitioned |
| **Lease + clock discipline** | A leader self-demotes before its lease expires | Depends on bounded clock error and bounded process pauses — both routinely violated |

**The rule to memorize:** quorum prevents two leaders from both *committing*; fencing prevents a stale leader from *corrupting shared state*. Quorum alone is not enough when the loser can still reach the data.

### Internal working — epoch/generation numbers

An epoch is a monotonically increasing integer bumped on **every** leadership change. Every write carries it, and the receiving side stores the highest epoch it has seen and rejects anything lower.

```
Term/epoch in real systems:
  Raft            "term"                      (etcd, Consul, CockroachDB, TiKV)
  ZooKeeper       "epoch" = high 32 bits of zxid
  Kafka           "leader epoch" per partition (+ "controller epoch")
  MongoDB         replica-set "term" in the oplog
  GFS/HDFS        "generation stamp" / "block generation"
  Azure/S3-style  ETag / conditional PUT (If-Match) as an epoch surrogate
```

```sql
-- Minimal epoch guard usable with any RDBMS shared by multiple would-be leaders
CREATE TABLE cluster_epoch (
    resource   TEXT PRIMARY KEY,
    epoch      BIGINT NOT NULL,
    holder     TEXT   NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Promotion: bump epoch atomically, learn your own token
UPDATE cluster_epoch
   SET epoch = epoch + 1, holder = :nodeId, acquired_at = now()
 WHERE resource = 'shard-42'
RETURNING epoch;

-- Every subsequent write is guarded by the epoch the writer believes it holds
UPDATE shard_42_state
   SET payload = :payload, epoch = :myEpoch
 WHERE (SELECT epoch FROM cluster_epoch WHERE resource = 'shard-42') = :myEpoch;
-- 0 rows updated  =>  you are a zombie leader. Stop. Do not retry. Self-terminate.
```

### The 2-node cluster: exactly why it cannot work

```
N = 2, majority = floor(2/2) + 1 = 2

Partition between the two nodes:
  Node A sees 1 of 2 reachable  → 1 < 2 → cannot form majority → read-only
  Node B sees 1 of 2 reachable  → 1 < 2 → cannot form majority → read-only
  Result: 100% write unavailability from a single link failure.

Node B crashes (not a partition):
  Node A sees 1 of 2            → still cannot form majority   → read-only
  Result: a 2-node cluster tolerates ZERO failures for writes.

To "fix" availability, operators lower the threshold to 1:
  Node A accepts writes with 1 ack
  Node B accepts writes with 1 ack
  Partition → both accept → SPLIT BRAIN, guaranteed, by configuration.
```

A 2-node cluster is strictly worse than a single node for availability **and** strictly worse than 3 nodes for correctness. The fix is a third **vote**, which does not have to be a third full data replica:

| Third-vote option | Cost | Caveat |
|---|---|---|
| Full third replica in a third AZ | 3× storage | Best choice; also improves read capacity |
| **Witness / arbiter** (MongoDB arbiter, SQL Server witness, Patroni + 3-node etcd) | Tiny VM | Arbiter holds no data → with 1 data node down you have 1 copy of data; MongoDB explicitly discourages arbiters with `w:majority` |
| **Tiebreaker in object storage** (conditional PUT / DynamoDB conditional write) | Cents | Adds a cloud-service dependency to your failover path |
| Quorum device (`corosync-qdevice`) | Small VM | Must live in a third failure domain, or it is decoration |

Critical placement rule: **the third vote must be in a third failure domain.** Two nodes in AZ-a and an arbiter in AZ-a means an AZ-a failure takes the majority with it, and an AZ-a *isolation* leaves the majority on the side you did not want.

### Kafka: `acks=all` + `min.insync.replicas` — exactly when data is lost

Setup: `replication.factor=3`, and a producer writing to partition P whose leader is broker 1, ISR = {1, 2, 3}.

```
replication.factor = 3
min.insync.replicas = 2
acks = all               ("all" means all members of the *current ISR*, not all replicas)
unclean.leader.election.enable = false
```

Walk the cases:

```
CASE 1 — healthy: ISR={1,2,3}, min.isr=2, acks=all
  Producer write is acked only after 1,2,3 have it in their logs.
  Any single broker can be lost with zero data loss.  ✅

CASE 2 — one replica falls behind: ISR shrinks to {1,2}
  |ISR| = 2 >= min.isr = 2  → writes continue, acked by {1,2}.
  Lose broker 1 → broker 2 has every acked record → elected → zero loss.  ✅
  You are now running with NO spare: losing another broker stops writes.

CASE 3 — two replicas out: ISR = {1}
  |ISR| = 1 < min.isr = 2
  → leader REFUSES the produce request:
       org.apache.kafka.common.errors.NotEnoughReplicasException
  Writes are unavailable. Data is NOT lost. This is the CP choice, working.  ✅

CASE 4 — the misconfiguration: min.insync.replicas = 1 (or acks = 1)
  ISR = {1}. Producer writes records 1000..1500, acked by broker 1 alone.
  Broker 1 dies before brokers 2,3 catch up.
  Broker 2 (last offset 999) is in ISR? No — it was removed. So:
     unclean.leader.election.enable=false → partition is OFFLINE until broker 1 returns
     unclean.leader.election.enable=true  → broker 2 becomes leader at offset 999
                                            → records 1000..1500 are GONE, silently,
                                              and the producer already got acks for them.  ❌
  Exact loss = (leader's last offset) - (new leader's last offset) = 1500 - 999 = 501 records.

CASE 5 — the subtle one: acks=all, min.insync.replicas=2, RF=3, but 3 brokers in 2 AZs
  AZ-a: brokers 1,2   AZ-b: broker 3
  AZ-a is isolated. ISR on the AZ-a side = {1,2} → still >= 2 → writes continue in AZ-a.
  Controller quorum lives in AZ-b + a third AZ → it fences brokers 1,2 and elects 3.
  Producers pinned to stale metadata retry against broker 1 and get
     NOT_LEADER_OR_FOLLOWER / FENCED_LEADER_EPOCH  ← leader epoch saves you.
  Without leader-epoch fencing (pre-KIP-101 semantics) those writes would diverge.  ✅ with fencing
```

The durability identity worth memorizing:

```
tolerable_broker_failures_without_loss = min.insync.replicas - 1     (with acks=all)
tolerable_broker_failures_without_downtime = replication.factor - min.insync.replicas

RF=3, min.isr=2  →  0 loss with 1 failure, writes survive 1 failure.   (the standard choice)
RF=3, min.isr=3  →  0 loss with 2 failures, but ANY single failure stops writes.
RF=5, min.isr=3  →  0 loss with 2 failures, writes survive 2 failures. (financial tier)
```

```properties
# server.properties — cluster-wide guardrails
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
auto.leader.rebalance.enable=true
# KRaft controller quorum: 3 or 5 voters, spread across 3 AZs, never 2
controller.quorum.voters=1@kc1:9093,2@kc2:9093,3@kc3:9093
broker.session.timeout.ms=9000
broker.heartbeat.interval.ms=2000
```

```java
@Bean
public ProducerFactory<String, OrderEvent> producerFactory() {
    Map<String, Object> p = new HashMap<>();
    p.put(ProducerConfig.ACKS_CONFIG, "all");                       // never "1" for ledger data
    p.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);          // dedup on retry within a producer session
    p.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5); // <=5 required with idempotence
    p.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
    p.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120_000);      // bounds total retry window
    p.put(ProducerConfig.MAX_BLOCK_MS_CONFIG, 5_000);               // fail fast instead of hanging threads
    // Surface NotEnoughReplicasException to the app: it means "the cluster chose C over A".
    return new DefaultKafkaProducerFactory<>(p);
}
```

```yaml
# Alert on the state that silently removes your durability guarantee
- alert: KafkaIsrShrunkToMinimum
  expr: kafka_cluster_partition_insyncreplicascount == kafka_topic_min_insync_replicas
  for: 5m
  annotations:
    summary: "Partition is at min.insync.replicas — one more failure stops writes"
- alert: KafkaUnderMinIsr
  expr: kafka_server_replicamanager_underminisrpartitioncount > 0
  for: 1m
  annotations:
    summary: "Producers with acks=all are being rejected (CP behaviour engaged)"
```

### MongoDB: majority write concern

```javascript
// Write that survives a primary loss without rollback
db.ledger.insertOne(
  { txnId: "T-91821", amountMinor: 4599, currency: "EUR" },
  { writeConcern: { w: "majority", j: true, wtimeout: 5000 } }
);

// Read that never sees a write which could later be rolled back
db.ledger.find({ txnId: "T-91821" })
         .readConcern("majority");     // or "linearizable" for reads on the primary

// Causal session: read-your-writes across primary failover
const s = db.getMongo().startSession({ causalConsistency: true });
```

```yaml
# mongod.conf / replica set config essentials
replication:
  replSetName: rs-ledger
# rs.conf() essentials:
#   settings.electionTimeoutMillis: 10000
#   members: 3 or 5 data-bearing, spread across 3 AZs
#   writeConcernMajorityJournalDefault: true
#   NO arbiters when using w:majority on a 3-member set:
#     PSA (primary-secondary-arbiter) + one secondary down
#     => majority = 2, but only 1 data node exists => w:majority blocks forever.
```

`wtimeout` is a **trap**: on timeout, MongoDB returns an error but **does not roll back** the write — it may still replicate and commit later. Treat `wtimeout` as "unknown outcome" and resolve it by reading with `readConcern: majority`, not by retrying blindly.

### PostgreSQL: `synchronous_commit` levels

```conf
# postgresql.conf on the primary
synchronous_standby_names = 'ANY 1 (standby_az_b, standby_az_c)'   # quorum-style: any 1 of 2
synchronous_commit = on
wal_level = replica
max_wal_senders = 10
wal_sender_timeout = 10s
```

| `synchronous_commit` | Primary waits for | Data loss window | Commit latency |
|---|---|---|---|
| `off` | nothing (background flush) | up to `wal_writer_delay` (default 200 ms) of committed TX on crash | lowest |
| `local` | local WAL fsync | zero on primary crash; **standby may lack it** → loss on failover | +1 fsync |
| `remote_write` | standby received into OS buffers | lost if standby OS/host crashes simultaneously | +1 RTT |
| `on` (default) | standby WAL fsync to disk | zero for single-node loss | +1 RTT + 1 remote fsync |
| `remote_apply` | standby has **applied** (visible to readers) | zero, and read replicas are non-stale | +1 RTT + replay time (highest) |

```
Cross-AZ arithmetic (measured, us-east-1):
  same-AZ RTT      ~0.25 ms   → synchronous_commit=on costs ~0.5-1 ms/commit
  cross-AZ RTT     ~1.2 ms    → ~2-3 ms/commit
  cross-region RTT ~70 ms     → ~140 ms/commit  ← this is why nobody runs sync rep to another continent

At 2,000 commits/s single-threaded-per-connection, cross-AZ sync commit
caps a single session at ~330-500 TPS. You need concurrency, batching, or
group commit (commit_delay/commit_siblings) to hit the same throughput.
```

The availability trap: with `synchronous_standby_names = 'standby_az_b'` (a **named single** standby) and that standby down, **every commit on the primary blocks forever**. Use `ANY 1 (a, b)` so the primary can proceed as long as one of two standbys is alive, and monitor `pg_stat_replication` row count.

```sql
-- Alert source: are we actually synchronous right now?
SELECT count(*) FILTER (WHERE sync_state = 'sync')  AS sync_standbys,
       count(*)                                     AS total_standbys
FROM   pg_stat_replication;
-- sync_standbys = 0 while synchronous_commit=on  =>  commits are about to hang
```

### Production scenario: 2-node Patroni "cost optimization" loses 501 Kafka records and duplicates invoices

**Problem.** To cut a cloud bill, a team reduced a 3-node Patroni/Postgres cluster to 2 nodes and, separately, set `min.insync.replicas=1` on the `invoices` Kafka topic "because producers were getting `NotEnoughReplicasException` during a rolling restart." Six weeks later, a 90-second AZ isolation produced: two Postgres primaries accepting writes, 47 duplicate invoice numbers, and 501 Kafka records that had been acked to the producer but did not exist after leader election.

**Cause.** Three independent guard removals compounded:
1. 2 nodes → majority = 2 → to keep writes working, someone had set the etcd cluster to 2 members as well, so *neither* side could establish a valid majority; Patroni's `nofailover`/`nosync` guards were also off, and both nodes promoted.
2. No fencing: the demoted primary retained its VIP and kept serving writes for 90 s.
3. `min.insync.replicas=1` + a broker loss = exactly CASE 4 above. The `NotEnoughReplicasException` had been the system **correctly** refusing to lose data; silencing it converted an availability blip into permanent data loss.

**Solution.**

```yaml
# patroni.yml — quorum, fencing, and refusal to promote a stale node
scope: pg-invoices
bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576        # 1MB: refuse to promote a node further behind
    synchronous_mode: true                  # only a sync standby may be promoted
    synchronous_mode_strict: false          # false => allow degraded writes if NO standby (choose deliberately)
    postgresql:
      parameters:
        synchronous_commit: 'on'
        synchronous_standby_names: 'ANY 1 (pg2, pg3)'
tags:
  nofailover: false
  nosync: false
# Watchdog = self-fencing: if Patroni cannot renew the leader key, the kernel resets the box.
watchdog:
  mode: required                            # 'required' refuses to run leader without a watchdog device
  device: /dev/watchdog
  safety_margin: 5
```

```bash
# etcd back to 3 members in 3 AZs. Verify the arithmetic before trusting it.
etcdctl member list -w table
etcdctl endpoint status --cluster -w table   # confirm exactly one leader, 3 healthy
etcdctl endpoint health --cluster
```

```bash
# STONITH path validated by a game day, not by hope
# Step 1 — New leader bumps epoch in DCS (Patroni does this)
# Step 2 — Fencing hook detaches the VIP / stops the instance via cloud API
aws ec2 modify-instance-attribute --instance-id i-oldprimary --no-source-dest-check
aws ec2 stop-instances --instance-ids i-oldprimary --force
# Step 3 — Only then does the new leader accept traffic
```

```properties
# Kafka: restore the durability contract, and fix the ACTUAL cause of the exception
min.insync.replicas=2
unclean.leader.election.enable=false
# The rolling restart problem is solved by rack awareness + controlled shutdown,
# not by lowering min.isr:
broker.rack=us-east-1a
controlled.shutdown.enable=true
controlled.shutdown.max.retries=3
```

Reconciliation after the fact: replay the outbox table on both former primaries, diff invoice numbers, and switch invoice IDs from a Postgres `SEQUENCE` (which duplicates across split primaries) to a `(shard_epoch, sequence)` composite so a future split brain produces *distinguishable* IDs rather than colliding ones.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Even number of voters (2, 4) in etcd/ZooKeeper/Raft | Zero fault tolerance for writes, or split votes and election flapping |
| Arbiter/witness in the same AZ as a data node | Losing that AZ loses the majority; failover into the wrong side |
| `min.insync.replicas=1` with `acks=all` | Producer gets acks that survive nothing; silent loss on leader change |
| `unclean.leader.election.enable=true` | Partition recovers by discarding acked records |
| `synchronous_standby_names` naming a single standby | Primary commits hang indefinitely when that standby is down |
| MongoDB PSA topology with `w:majority` | Writes block forever after one secondary fails |
| Promotion without VIP/DNS fencing | Old primary keeps serving writes for the DNS TTL |
| `watchdog: off` in Patroni | Nothing stops a paused leader from resuming and writing |
| Epoch stored but never checked on the write path | Fencing exists on paper only |
| Failover tested only by graceful shutdown | Real incidents are pauses and partitions, which behave completely differently |

### Debugging scenario

**Observe.** After a brief network event, both `pg1` and `pg2` logs contain `database system is ready to accept connections` (not "read only") with overlapping timestamps.

**Diagnose.** Build a leadership timeline from three independent sources — Patroni's history key (`etcdctl get /service/pg-invoices/history`), each node's `pg_controldata` timeline ID, and the DCS leader-key TTL events. Overlapping leader windows in the DCS history plus two distinct timeline IDs (`TimeLineID: 7` on both) is proof of divergence, not lag.

```bash
patronictl -c /etc/patroni.yml history          # promotions with timelines and LSNs
pg_controldata /var/lib/postgresql/data | grep -i timeline
etcdctl get /service/pg-invoices/ --prefix      # leader key, holder, TTL
```

**Fix.** Immediately stop the loser (do not let it "catch up"), identify the divergence LSN, `pg_rewind` or rebuild the loser from the winner, then replay the loser's exclusive writes through the application's idempotent ingestion path so they are re-applied with correct invariants rather than merged at the row level. Add the watchdog, restore 3 voters, and schedule a partition game day to prove the fix.

---

## 12. Clock Synchronization

### Core concept

Computers measure time with **oscillators** that drift. **NTP** and **PTP** synchronize wall clocks, but:

- Skew between machines is common (milliseconds to seconds).
- **Clock jumps** happen (NTP step correction).
- **Leap seconds** and manual time changes break ordering assumptions.

Distributed systems use:

- **Wall clock time** — human-readable; dangerous for ordering alone.
- **Logical clocks** — Lamport, vector clocks (causal order, not duration).
- **Hybrid Logical Clocks (HLC)** — CockroachDB-style; physical + logical.
- **TrueTime (Spanner)** — GPS + atomic clocks; ** uncertainty interval** `[earliest, latest]`.

**Leslie Lamport:** "The concept of time is fundamental to our way of thinking. It is derived from the more basic concept of the order in which events occur."

### Internal working — the five ways clocks actually break

**1. Free-running drift.** A commodity crystal oscillator drifts 10–100 ppm (parts per million) when unsynchronized.

```
drift 50 ppm  =  50 µs per second
              =  50e-6 × 86400 s  =  4.32 s per day
              =  ~30 s per week

Chrony/ntpd normally hold offset within:
  LAN + local NTP server ........ 0.1-2 ms
  Public pool over WAN .......... 5-50 ms
  AWS Time Sync Service (link-local 169.254.169.123) ... <1 ms, often <100 µs
  PTP hardware timestamping (AWS ENA PTP, on-prem grandmaster) ... 1-100 µs
```

Practical consequence: any algorithm whose correctness depends on "server A's timestamp is comparable to server B's within 1 ms" is broken by default on a public NTP pool.

**2. Steps and slews.** NTP corrects small offsets by *slewing* (bending the clock rate ≤ 500 ppm) and large offsets by *stepping* (jumping). A step makes wall clock time **go backwards**.

```conf
# /etc/chrony/chrony.conf on database and consensus nodes
server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4   # AWS Time Sync
makestep 1.0 3          # allow a step ONLY for the first 3 updates after boot
maxslewrate 100         # bend gently afterwards; never jump a running DB node
rtcsync
leapsecmode slew        # DO NOT step for leap seconds
smoothtime 400 0.001 leaponly   # if this node serves time to others, smear the leap
logchange 0.1           # log any correction > 100ms: this is your audit trail
```

The single most important line for a stateful node is `makestep 1.0 3`: after boot, a running database's clock must **never** jump. Kill the step, keep the slew, and alarm on `chronyc tracking` offset.

```bash
chronyc tracking      # System time offset, RMS, frequency, skew, leap status
chronyc sources -v    # per-source reachability and measured offsets
chronyc sourcestats   # frequency drift per source; catches a lying upstream
```

**3. Leap seconds.** UTC has had 27 positive leap seconds; a positive leap inserts `23:59:60`. Historically this produced a repeated second (`23:59:59` twice) that broke `while (t2 < t1)` loops. The 2012 leap second caused kernel livelocks (futex bug) that took down Reddit, Mozilla, and Qantas systems. Modern practice is **smearing**: Google, AWS, and Facebook stretch the extra second over hours so no clock ever repeats or reverses. The rule: **all nodes in one cluster must use the same leap strategy.** Mixing a smearing NTP source with a stepping one gives you up to 1 s of *deliberate* skew for hours.

**4. VM pause, live migration, and container throttling.** These are the clock bugs that survive perfect NTP, because the process is not running at all.

```
Sources of multi-second invisible pauses:
  JVM stop-the-world GC (untuned G1, 8GB+ heap) ......... 200 ms - 6 s
  VM live migration blackout (vMotion / cloud maintenance)  0.5 - 5 s
  Hypervisor host CPU steal / oversubscription .......... 100 ms - 10 s
  cgroup CPU throttling (K8s CPU limits, cfs_quota) ..... 10 ms - 2 s per period
  Snapshot / hibernate resume .......................... seconds to hours
  Swapping (page-in of a large heap) ................... seconds
  fsync on a stalled EBS volume ........................ 1 - 30 s
```

A paused process wakes up believing no time has passed. Its lease looks valid. This is precisely the false-positive-to-split-brain path in section 9.

```yaml
# Kubernetes: CPU limits cause invisible pauses that look like clock/network failures
resources:
  requests: { cpu: "2", memory: "4Gi" }
  limits:   { memory: "4Gi" }        # memory limit yes; CPU limit often NO for latency-critical pods
# Watch this metric before blaming the network:
#   rate(container_cpu_cfs_throttled_seconds_total[5m]) > 0
```

**5. `System.currentTimeMillis()` goes backwards.** It reads the wall clock. It is subject to steps, leap handling, manual `date` changes, and VM resume. It must never be used to measure elapsed time, build timeouts, generate monotonic IDs, or order events.

```java
// WRONG: can produce negative durations, or a 30-minute "duration" from an NTP step
long start = System.currentTimeMillis();
doWork();
long elapsedMs = System.currentTimeMillis() - start;     // may be negative

// RIGHT: nanoTime() is monotonic (per-JVM, arbitrary origin, never steps)
long start = System.nanoTime();
doWork();
long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);

// RIGHT, with the modern API making the intent explicit
Clock wall = Clock.systemUTC();                 // for timestamps humans read
// java.time has no monotonic clock; use nanoTime or Duration from nanoTime deltas
Instant loggedAt = wall.instant();              // fine for logs, NOT for ordering across hosts
```

```java
/** Defensive monotonic guard for anything that must never emit a decreasing timestamp. */
public final class MonotonicWallClock {
    private final AtomicLong last = new AtomicLong(Long.MIN_VALUE);
    private final Clock clock;

    public MonotonicWallClock(Clock clock) { this.clock = clock; }

    /** Returns a wall-clock millis value that never decreases for this process. */
    public long millis() {
        while (true) {
            long now  = clock.millis();
            long prev = last.get();
            if (now > prev) {
                if (last.compareAndSet(prev, now)) return now;
            } else {
                // Clock went backwards (step / leap / resume). Do not emit prev-1.
                long bumped = prev + 1;
                if (last.compareAndSet(prev, bumped)) {
                    BACKWARDS_COUNTER.increment();   // ALERT on this; it means NTP stepped a live node
                    return bumped;
                }
            }
        }
    }
    private static final LongAdder BACKWARDS_COUNTER = new LongAdder();
}
```

This is exactly the trick inside HLC implementations and inside Twitter-Snowflake ID generators — a Snowflake generator that sees the clock move backwards must either wait or refuse, because emitting a lower timestamp means emitting a **duplicate ID**.

### Worked example: how last-write-wins silently deletes a paying customer's data

Setup: two app servers, `app-a` and `app-b`, writing to a LWW store (Cassandra with client-side timestamps, DynamoDB with a `lastModified` guard, or a Redis `SET` where the app compares timestamps). `app-a`'s clock is **+400 ms** ahead of `app-b`. Both are "NTP synced" against a public pool; nobody monitors offset.

```
Real time (ground truth)     app-a (clock +400ms)        app-b (clock +0ms)
-------------------------------------------------------------------------------
T+0.000  user sets           writes {plan: "pro"}
         plan = pro          ts = 10:00:00.400
T+0.000                      ─────────► store: {plan:"pro", ts=10:00:00.400}

T+0.150  user (same person,                              reads {plan:"pro"}
         second tab) sets                                 writes {addons:["seats"]}
         addons                                           ts = 10:00:00.150

T+0.150                                                  ─────────► store compares:
                                                          incoming ts 10:00:00.150
                                                          stored   ts 10:00:00.400
                                                          incoming < stored → DISCARD

Result: the addon write is silently dropped. No error. No conflict. No log line.
        The HTTP response was 200. The user's seats never appear.
        Every retry from app-b loses again, until real time passes 10:00:00.400
        — i.e. the write is dead for 400ms, and any write issued in that window vanishes.
```

Make the loss quantitative:

```
skew                      = 400 ms
writes per second (peak)  = 850
fraction routed to app-b  = 50%
window in which an app-b write loses to an existing app-a write for the same key = 400 ms

Expected silent losses ≈ writes/s × P(same key contended within 400ms) × 0.5
With 0.8% of writes hitting a key touched in the last 400ms:
   850 × 0.008 × 0.5 ≈ 3.4 lost writes/second ≈ 12,240 per hour, all returning HTTP 200.
```

Now the vicious version — **LWW plus a delete**:

```
T+0  app-a (clock +5min, NTP never checked): writes {email:"x@y.z"} ts=10:05:00
T+1  GDPR deletion job on app-b: DELETE       ts=10:00:01  (tombstone)
     Store: tombstone ts 10:00:01 < data ts 10:05:00 → the DATA WINS.
     The record is not deleted. The deletion job reports success.
     You now have a compliance violation that no test can catch,
     because on a correctly-synced cluster the same code passes.
```

Three fixes, in order of strength:

| Fix | Effect | Cost |
|---|---|---|
| **Server-side timestamps only** (never client/app-supplied) | Removes app-server skew from the equation; skew is now only between DB nodes | Loses the ability to replay historical writes |
| **Version/CAS instead of timestamps** (`@Version`, `IF version = ?`, DynamoDB `ConditionExpression`) | Conflicts become explicit errors you can retry or merge | Requires read-before-write or optimistic-retry loops |
| **CRDT or explicit merge** (see [CRDTs](#19-crdts-conflict-free-replicated-data-types)) | Concurrent writes both survive; convergence is provable | Larger metadata; not all types are expressible |

```sql
-- Postgres: make the conflict explicit rather than timestamp-resolved
UPDATE subscription
   SET plan = :plan, version = version + 1
 WHERE id = :id AND version = :expectedVersion;
-- 0 rows => somebody else won. Re-read, re-apply, retry. Nothing is silently lost.
```

```java
// DynamoDB: conditional write = CAS, no clocks involved
UpdateItemRequest req = UpdateItemRequest.builder()
        .tableName("subscription")
        .key(Map.of("id", AttributeValue.fromS(id)))
        .updateExpression("SET #plan = :plan, #v = :newV")
        .conditionExpression("#v = :expectedV")          // fails with ConditionalCheckFailedException
        .expressionAttributeNames(Map.of("#plan", "plan", "#v", "version"))
        .expressionAttributeValues(Map.of(
                ":plan",      AttributeValue.fromS(plan),
                ":newV",      AttributeValue.fromN(Long.toString(expectedVersion + 1)),
                ":expectedV", AttributeValue.fromN(Long.toString(expectedVersion))))
        .build();
```

### Monitoring clocks like a first-class dependency

```yaml
# node_exporter exposes NTP/chrony metrics; alert BEFORE correctness breaks
- alert: ClockOffsetHigh
  expr: abs(node_timex_offset_seconds) > 0.050
  for: 5m
  annotations: { summary: "Clock offset {{ $value }}s — LWW and lease logic at risk" }

- alert: ClockNotSynchronised
  expr: node_timex_sync_status == 0
  for: 10m
  annotations: { summary: "Node is not NTP-synchronised (free-running oscillator)" }

- alert: ClockSteppedBackwards
  expr: increase(app_wall_clock_backwards_total[10m]) > 0
  annotations: { summary: "Wall clock moved backwards on a live node — check makestep" }

- alert: LeapStatusAbnormal
  expr: node_timex_status{} != 0
  for: 30m
```

Add pairwise skew to your tracing: stamp each span with both `nanoTime` deltas and wall-clock instants, and compute observed skew from request/response pairs (`client_send`, `server_recv`, `server_send`, `client_recv`) — the same arithmetic NTP uses. A trace that shows a server span *starting before* the client span that caused it is a skew report, not a tracing bug.

### Internal working — Lamport and vector clocks

**Lamport clock:** On send, increment and attach timestamp; on receive, `max(local, received) + 1`. Gives total order extension of causal order **but** `a < b` does not imply causation.

**Vector clock:** Per-node counter vector; can detect **concurrent** events (true conflicts).

```
Event on A: (A:1)
Send to B:  (A:2, B:0)
Receive on B: (A:2, B:3)
Concurrent if neither vector dominates the other → conflict
```

**HLC example (simplified):**

```
hlc = max(physical_time, last_hlc) + logical_tick
commit_wait until physical_time > transaction_timestamp + uncertainty  (Spanner-style)
```

### Production scenario: LWW deletes resurrected by clock skew

**Problem.** Cassandra LWW tombstone on user PII delete; replica with clock 5 minutes ahead accepts old write after delete with "future" timestamp → ghost data violates GDPR.

**Solution.** Disable NTP step on DB nodes; use `LOCAL_QUORUM` for deletes; run repair; for compliance columns use **strong consistency** or centralized delete log; never trust client timestamps for LWW.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Client-supplied timestamps in LWW | Malicious or buggy clients win |
| NTP not monitored | Silent drift; ordered events wrong |
| Using `now()` across services for idempotency window | Duplicate processing |
| TTL based on wall clock during leap second | Early/late expiration |

### Debugging scenario

**Observe.** Events in Kafka appear "out of order" in consumer logs.

**Diagnose.** Producer clocks skewed; **Kafka ordering is per-partition by offset**, not timestamp. If using CreateTime for analytics, skew shows as disorder.

**Fix.** Use broker receive time; sync NTP; for causality use sequence numbers in payload.

---

## 13. Logical Clocks, Vector Clocks, and Hybrid Logical Clocks

### Core concept

Wall clocks answer "what time is it?" — a question no distributed system needs. What systems need is "**did A happen before B, or were they concurrent?**" That is the *happens-before* relation (Lamport, 1978), and it is defined without any physical clock:

```
a → b  ("a happens before b")  iff  any of:
  1. a and b are on the same node and a precedes b in program order
  2. a is the send of a message and b is its receive
  3. transitivity: a → c and c → b

If neither a → b nor b → a, then a and b are CONCURRENT (a ∥ b).
Concurrency is the definition of a genuine conflict.
```

Three tools, increasing in power and cost:

| Tool | Size | Can order causally related events | Can **detect** concurrency | Comparable to wall time |
|---|---|---|---|---|
| **Lamport clock** | 1 integer | Yes | **No** | No |
| **Vector clock** | N integers (one per node) | Yes | **Yes** | No |
| **Hybrid logical clock (HLC)** | 8–12 bytes (physical + counter) | Yes | Partially (via counter) | **Yes**, within clock error |
| **TrueTime / bounded-uncertainty** | interval `[earliest, latest]` | Yes | N/A (waits it out) | Yes, with proven bound |

### Internal working — Lamport clocks

```
Rules (each node keeps one counter L, starting at 0):
  local event / send:  L = L + 1 ;  attach L to the message
  on receive(m):       L = max(L, m.L) + 1

Guarantee:   a → b  implies  L(a) < L(b)
NOT true:    L(a) < L(b)  implies  a → b        ← the whole limitation
Total order: break ties with node id → (L, nodeId) is a total order consistent with causality
```

```java
public final class LamportClock {
    private final AtomicLong counter = new AtomicLong(0);
    private final String nodeId;

    public LamportClock(String nodeId) { this.nodeId = nodeId; }

    /** Call before emitting any event or message. */
    public Stamp tick() {
        return new Stamp(counter.incrementAndGet(), nodeId);
    }

    /** Call on receipt of a stamped message, before processing it. */
    public Stamp observe(Stamp received) {
        long updated = counter.accumulateAndGet(received.value(), (cur, in) -> Math.max(cur, in) + 1);
        return new Stamp(updated, nodeId);
    }

    /** Total order consistent with happens-before; ties broken deterministically. */
    public record Stamp(long value, String nodeId) implements Comparable<Stamp> {
        @Override public int compareTo(Stamp o) {
            int c = Long.compare(value, o.value);
            return c != 0 ? c : nodeId.compareTo(o.nodeId);
        }
    }
}
```

Lamport clocks are enough when you need *a* consistent order that everyone agrees on (e.g. deterministic tie-breaking in a state machine) and you do **not** need to know whether two writes truly conflicted.

### Internal working — vector clocks, with a full worked example

```
Rules (node i keeps V[1..N], all zeros initially):
  local event / send on node i:  V[i] = V[i] + 1 ;  attach copy of V
  on receive(m) at node i:       V = elementwise max(V, m.V) ;  then V[i] = V[i] + 1

Comparison of two vectors A and B:
  A ≤ B          iff  A[k] ≤ B[k] for all k
  A → B (A before B)   iff  A ≤ B and A ≠ B
  A ∥ B (concurrent)   iff  neither A ≤ B nor B ≤ A
```

Worked example — a shared shopping cart replicated on three nodes `A`, `B`, `C`. Vectors written as `(a,b,c)`.

```
step  where  action                                   resulting vector    cart value
----------------------------------------------------------------------------------------
 1     A     client adds "book"                        (1,0,0)            {book}
 2     A→B   replicate                                 B receives (1,0,0)
             B applies                                 (1,1,0)            {book}
 3     B     client adds "pen"                         (1,2,0)            {book,pen}
 4    ─── network partition: C is isolated from A and B ───
 5     C     client (mobile, hit C) adds "lamp"
             C's last known state was (1,0,0) from step 2 gossip
                                                       (1,0,1)            {book,lamp}
 6     B     client removes "book"                     (1,3,0)            {pen}
 7    ─── partition heals; B and C exchange states ───
 8           compare B=(1,3,0) with C=(1,0,1):
               B ≤ C ?  b: 3 ≤ 0 ? NO
               C ≤ B ?  c: 1 ≤ 0 ? NO
             → neither dominates → B ∥ C → GENUINE CONFLICT
             A single LWW timestamp would silently pick one and lose either
             the "lamp" add or the "book" remove.
 9           application-level merge (add-wins for a cart):
               siblings: {pen} @ (1,3,0)  and  {book,lamp} @ (1,0,1)
               merged value {pen, book, lamp}? or {pen, lamp} if remove-wins for book?
               ← THIS IS A BUSINESS DECISION, and the vector clock's job is
                 to force you to make it explicitly instead of losing data.
             merged vector = elementwise max + local tick = (1,3,1) then (1,4,1) on B
```

```java
/** Immutable vector clock. Node ids are stable strings (pod name, replica id). */
public final class VectorClock {

    private final Map<String, Long> counters;

    public static final VectorClock EMPTY = new VectorClock(Map.of());

    private VectorClock(Map<String, Long> counters) {
        this.counters = Map.copyOf(counters);
    }

    /** Local event on nodeId: increment that node's own counter. */
    public VectorClock increment(String nodeId) {
        Map<String, Long> next = new HashMap<>(counters);
        next.merge(nodeId, 1L, Long::sum);
        return new VectorClock(next);
    }

    /** On receive: elementwise max, then the receiver ticks itself. */
    public VectorClock mergeAndTick(VectorClock other, String selfId) {
        Map<String, Long> next = new HashMap<>(counters);
        other.counters.forEach((k, v) -> next.merge(k, v, Math::max));
        next.merge(selfId, 1L, Long::sum);
        return new VectorClock(next);
    }

    private long at(String nodeId) { return counters.getOrDefault(nodeId, 0L); }

    private Set<String> keys(VectorClock other) {
        Set<String> all = new HashSet<>(counters.keySet());
        all.addAll(other.counters.keySet());
        return all;
    }

    public enum Ord { BEFORE, AFTER, EQUAL, CONCURRENT }

    public Ord compare(VectorClock other) {
        boolean anyLess = false, anyGreater = false;
        for (String k : keys(other)) {
            long mine = at(k), theirs = other.at(k);
            if (mine < theirs) anyLess = true;
            if (mine > theirs) anyGreater = true;
            if (anyLess && anyGreater) return Ord.CONCURRENT;   // early exit
        }
        if (!anyLess && !anyGreater) return Ord.EQUAL;
        return anyLess ? Ord.BEFORE : Ord.AFTER;
    }

    public boolean isConcurrentWith(VectorClock other) { return compare(other) == Ord.CONCURRENT; }

    @Override public String toString() {
        return new TreeMap<>(counters).toString();   // sorted → stable in logs and tests
    }
}
```

```java
/** Replica write path: detect conflicts instead of silently overwriting. */
public final class VersionedStore<T> {

    private final String selfId;
    private final Map<String, List<Versioned<T>>> data = new ConcurrentHashMap<>();  // siblings per key
    private final BinaryOperator<T> merge;   // domain merge, e.g. add-wins set union

    public VersionedStore(String selfId, BinaryOperator<T> merge) {
        this.selfId = selfId; this.merge = merge;
    }

    public record Versioned<T>(T value, VectorClock clock) {}

    /** Local write, based on the siblings the client had read. */
    public Versioned<T> put(String key, T value, VectorClock basedOn) {
        Versioned<T> written = new Versioned<>(value, basedOn.increment(selfId));
        data.put(key, List.of(written));      // the client resolved everything it read
        return written;
    }

    /** Replicated write from a peer: keep only causally maximal siblings. */
    public void apply(String key, Versioned<T> incoming) {
        data.compute(key, (k, existing) -> {
            if (existing == null) return List.of(incoming);
            List<Versioned<T>> kept = new ArrayList<>();
            for (Versioned<T> cur : existing) {
                switch (cur.clock().compare(incoming.clock())) {
                    case BEFORE -> { /* cur is obsolete: drop it */ }
                    case AFTER, EQUAL -> { return existing; }   // incoming already covered
                    case CONCURRENT -> kept.add(cur);           // real conflict: keep as sibling
                }
            }
            kept.add(incoming);
            return List.copyOf(kept);
        });
    }

    /** Read: either return siblings to the client, or auto-merge if the domain allows. */
    public Versioned<T> get(String key) {
        List<Versioned<T>> siblings = data.getOrDefault(key, List.of());
        if (siblings.isEmpty()) return null;
        if (siblings.size() == 1) return siblings.get(0);
        SIBLING_COUNT.record(siblings.size());     // ALERT: unbounded sibling growth = merge bug
        T value = siblings.stream().map(Versioned::value).reduce(merge).orElseThrow();
        VectorClock clock = siblings.stream().map(Versioned::clock)
                .reduce(VectorClock.EMPTY, (a, b) -> a.mergeAndTick(b, selfId));
        return new Versioned<>(value, clock);
    }

    private static final DistributionSummary SIBLING_COUNT =
            Metrics.summary("store.siblings.per.read");
}
```

**The cost that kills vector clocks in practice:** the vector grows with the number of writer identities. Dynamo used `(node, counter)` pairs and had to **truncate** the oldest entries past 10, which can produce false-concurrency (and Riak later moved to *dotted version vectors* for exactly this reason). If your writers are clients rather than servers, the vector is unbounded — always key vectors by **server replica id**, never by client id.

### Internal working — hybrid logical clocks (HLC)

HLC is the pragmatic winner in modern databases (CockroachDB, YugabyteDB, MongoDB's cluster time, ScyllaDB's proposals) because it gives causality **and** a timestamp that is within clock-error of real time, in 64 bits.

```
State per node: (l, c)   l = logical physical time (ms), c = counter
pt() = local physical clock reading

send / local event:
   l_prev = l
   l = max(l_prev, pt())
   c = (l == l_prev) ? c + 1 : 0
   emit (l, c)

receive (l_m, c_m):
   l_prev = l
   l = max(l_prev, l_m, pt())
   if      l == l_prev && l == l_m : c = max(c, c_m) + 1
   else if l == l_prev             : c = c + 1
   else if l == l_m                : c = c_m + 1
   else                            : c = 0

Properties:
  a → b  implies  (l_a, c_a) < (l_b, c_b)        (causality preserved)
  |l - pt()| ≤ ε   where ε = max clock skew       (stays close to real time)
  Fixed size: 48 bits of ms + 16 bits of counter fits in one long.
```

```java
/** 64-bit hybrid logical clock: 48 bits physical millis, 16 bits logical counter. */
public final class HybridLogicalClock {

    private static final int  COUNTER_BITS = 16;
    private static final long COUNTER_MASK = (1L << COUNTER_BITS) - 1;
    /** Refuse to run if the peer/local clock is this far ahead: it means NTP is broken. */
    private static final long MAX_SKEW_MS = 500;

    private final LongSupplier physicalMillis;
    private final AtomicLong state = new AtomicLong(0);   // packed (l << 16) | c

    public HybridLogicalClock(LongSupplier physicalMillis) { this.physicalMillis = physicalMillis; }

    public long now() {
        return state.updateAndGet(prev -> {
            long lPrev = prev >>> COUNTER_BITS, cPrev = prev & COUNTER_MASK;
            long pt = physicalMillis.getAsLong();
            long l  = Math.max(lPrev, pt);
            long c  = (l == lPrev) ? cPrev + 1 : 0;
            if (c > COUNTER_MASK) { l += 1; c = 0; }      // counter overflow: borrow a millisecond
            return (l << COUNTER_BITS) | c;
        });
    }

    public long update(long remote) {
        long remoteL = remote >>> COUNTER_BITS, remoteC = remote & COUNTER_MASK;
        long pt = physicalMillis.getAsLong();
        if (remoteL > pt + MAX_SKEW_MS) {
            // A peer claiming to be far in the future would drag OUR clock forward permanently.
            throw new ClockSkewException("peer HLC " + remoteL + " exceeds local " + pt
                    + " by more than " + MAX_SKEW_MS + "ms");
        }
        return state.updateAndGet(prev -> {
            long lPrev = prev >>> COUNTER_BITS, cPrev = prev & COUNTER_MASK;
            long l = Math.max(Math.max(lPrev, remoteL), pt);
            long c;
            if      (l == lPrev && l == remoteL) c = Math.max(cPrev, remoteC) + 1;
            else if (l == lPrev)                 c = cPrev + 1;
            else if (l == remoteL)               c = remoteC + 1;
            else                                 c = 0;
            if (c > COUNTER_MASK) { l += 1; c = 0; }
            return (l << COUNTER_BITS) | c;
        });
    }

    public static String format(long hlc) {
        return Instant.ofEpochMilli(hlc >>> COUNTER_BITS) + "+" + (hlc & COUNTER_MASK);
    }

    public static final class ClockSkewException extends RuntimeException {
        ClockSkewException(String m) { super(m); }
    }
}
```

The `MAX_SKEW_MS` guard is not decoration. CockroachDB nodes **self-terminate** when they detect they are outside the configured `--max-offset` (default 500 ms) of a majority of peers, because continuing would break its serializability argument. A single node with a wildly wrong clock must remove itself rather than poison the cluster's timestamps.

### TrueTime and bounded uncertainty

Spanner does not pretend clocks are exact; it makes the error **explicit and bounded**.

```
TrueTime API:
  TT.now() → interval [earliest, latest]   with the guarantee that absolute time ∈ interval
  ε = (latest - earliest) / 2              typically 1-7 ms, sawtooth as it re-syncs to
                                           GPS receivers + atomic clocks per datacenter

Commit protocol (external consistency):
  1. Acquire locks, choose s = TT.now().latest
  2. COMMIT WAIT: block until TT.now().earliest > s
       → guarantees that when the client sees the commit, real time has passed s
  3. Release locks, reply

Consequence: every read-write transaction pays ~2ε (≈ 5-14 ms) of deliberate waiting.
Spanner traded latency for a property nothing else offered: linearizable reads
across continents without a global lock.
```

AWS offers the same idea as a service, without the atomic clocks:

```bash
# AWS Time Sync + ClockBound: bounded error you can query from your application
#   /etc/chrony/chrony.conf: server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4
sudo systemctl start clockbound
# clockbound returns (earliest, latest) with typical error under 100 microseconds
# on instances with PTP hardware clock support (ENA PTP / Nitro).
```

```java
// Sketch of a commit-wait using a bounded-error clock source (ClockBound / TrueTime style)
record TimeInterval(long earliestMicros, long latestMicros) {}

long chooseCommitTimestamp(BoundedClock clock) throws InterruptedException {
    long s = clock.now().latestMicros();          // pick the latest possible "now"
    while (clock.now().earliestMicros() <= s) {   // commit wait
        TimeUnit.MICROSECONDS.sleep(200);
    }
    return s;                                     // safe to expose: real time has passed s
}
```

### Which one do you actually use?

| Requirement | Choice |
|---|---|
| Deterministic tie-break in a replicated state machine | Lamport `(counter, nodeId)` |
| Detect true concurrent writes and surface siblings | Vector clock / dotted version vector |
| Timestamps that are both causal and human-meaningful, MVCC snapshots | HLC |
| Serializable/external consistency across regions | Bounded-uncertainty clock + commit wait (Spanner, ClockBound) |
| Ordering within one stream/partition | The log offset. Do not invent a clock. |

### Production scenario: Kafka consumer builds a materialized view with wall-clock ordering

**Problem.** An order-status projection consumes `order-events` from 24 partitions and writes a "current status" row per order. Support reports orders stuck in `SHIPPED` after being `DELIVERED`, roughly 60–90 times a day, and always for orders whose events were produced by different services. The projection had a guard: `if (event.timestamp >= row.updatedAt) apply(event)` — using `ProducerRecord` `CreateTime`.

**Cause.** `CreateTime` is the **producer's wall clock**. Three producer services on three node pools had offsets of −220 ms, +40 ms, and +610 ms against the pool. A `DELIVERED` event produced by the slow-clocked logistics service carried a timestamp *earlier* than the `SHIPPED` event from the warehouse service, so the guard rejected it. The events themselves were causally ordered (both keyed by `orderId`, so same partition, correct offset order) — the code threw that ordering away and substituted clocks.

**Solution.** Order by the thing that is actually ordered, and carry a causal stamp for cross-partition cases.

```java
@KafkaListener(topics = "order-events", concurrency = "8")
public void onEvent(ConsumerRecord<String, OrderEvent> rec) {
    // 1. Within a partition, the offset IS the order. Use it, not the clock.
    long position = rec.offset();

    // 2. Across partitions/streams, use the causal stamp carried in the payload.
    long eventHlc = rec.value().hlc();
    hlc.update(eventHlc);                        // keep our clock causally ahead

    projection.applyIfNewer(rec.value().orderId(), rec.partition(), position, eventHlc, rec.value());
}
```

```sql
-- Idempotent, monotonic projection upsert: (partition, offset) for same-partition order,
-- hlc for cross-partition order. Never wall clock.
INSERT INTO order_status (order_id, status, src_partition, src_offset, hlc)
VALUES (:orderId, :status, :partition, :offset, :hlc)
ON CONFLICT (order_id) DO UPDATE
   SET status        = EXCLUDED.status,
       src_partition = EXCLUDED.src_partition,
       src_offset    = EXCLUDED.src_offset,
       hlc           = EXCLUDED.hlc
 WHERE (EXCLUDED.src_partition = order_status.src_partition
        AND EXCLUDED.src_offset > order_status.src_offset)
    OR (EXCLUDED.src_partition <> order_status.src_partition
        AND EXCLUDED.hlc > order_status.hlc);
-- 0 rows affected = stale/duplicate event, correctly ignored. Count it as a metric.
```

```properties
# Also: stop trusting producer clocks for anything operational
log.message.timestamp.type=LogAppendTime   # broker stamps it; monotonic per partition
```

Additionally, model the state machine explicitly so an out-of-order event cannot regress status regardless of ordering source:

```java
private static final Map<Status, Set<Status>> ALLOWED = Map.of(
    Status.CREATED,   EnumSet.of(Status.PAID, Status.CANCELLED),
    Status.PAID,      EnumSet.of(Status.SHIPPED, Status.REFUNDED),
    Status.SHIPPED,   EnumSet.of(Status.DELIVERED, Status.LOST),
    Status.DELIVERED, EnumSet.of(Status.RETURNED));

boolean canTransition(Status from, Status to) {
    return ALLOWED.getOrDefault(from, Set.of()).contains(to);
}
```

Belt and braces: causality for ordering, offsets for dedup, and a state machine that refuses impossible transitions even when both fail.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `CreateTime` (producer clock) used to order events | Rare, unreproducible out-of-order applications correlated with specific producer hosts |
| Vector clocks keyed by client id | Vectors grow unbounded; storage and comparison cost explodes |
| Truncating vector clocks without dotted version vectors | False conflicts appear; siblings multiply |
| Siblings returned to clients but never merged | Sibling count grows until reads time out (classic Riak outage) |
| HLC without a max-skew guard | One bad clock drags the whole cluster's timestamps hours into the future, permanently |
| HLC counter too narrow (8 bits) for burst rate | Counter overflow silently borrows milliseconds; timestamps drift ahead of real time |
| Assuming `L(a) < L(b)` means `a → b` (Lamport) | Bogus "causal" chains in audit trails and debugging |
| Mixing HLC and wall clock in the same comparison | Non-transitive ordering; MVCC snapshot anomalies |

### Debugging scenario

**Observe.** An event-sourced aggregate occasionally rejects a valid command with "version conflict," and the audit log shows two events with the *same* logical timestamp.

**Diagnose.** Print the full stamp, not just its physical part: `Instant + counter`. Equal `(l, c)` from two nodes means the counter is being reset instead of maxed on receive (the `l == lPrev && l == remoteL` branch is missing), which is the single most common HLC implementation bug. Verify with a property test:

```java
@Test
void hlcIsStrictlyIncreasingUnderCausality() {
    HybridLogicalClock a = new HybridLogicalClock(() -> 1_000L);   // frozen clock, worst case
    HybridLogicalClock b = new HybridLogicalClock(() -> 1_000L);
    long last = 0;
    for (int i = 0; i < 100_000; i++) {
        long ta = a.now();
        long tb = b.update(ta);          // b receives from a
        assertThat(tb).isGreaterThan(ta);   // causality must hold with a FROZEN physical clock
        assertThat(ta).isGreaterThan(last);
        last = tb;
    }
}
```

**Fix.** Correct the receive branch, widen the counter to 16 bits, add the skew guard, and add the frozen-clock property test to CI — a frozen physical clock is the only reliable way to test that your logical component is doing the work.

---

## 14. Distributed Consensus

### Core concept

**Distributed consensus:** Multiple nodes agree on a **single value** or **log order** despite failures. Used for leader election, config management, atomic broadcast.

**Requirements (informal):**

- **Agreement** — all correct nodes decide same value.
- **Validity** — decided value was proposed.
- **Termination** — eventually a decision is reached (with liveness assumptions).
- **Integrity** — at most one decision.

**FLP impossibility:** No deterministic consensus in **asynchronous** system with even one crash failure. Real systems use **partial synchrony** (timeouts that are eventually right) or randomization.

### Internal working — Paxos vs Raft

**Paxos (Lamport):** Proposer, acceptor, learner roles; multi-Paxos for log. Correct but famously hard to implement.

**Raft (Ongaro):** Leader-based; log replication; strong understandability. Used in etcd, Consul, CockroachDB (Raft per range), TiKV.

**Raft leader election (simplified):**

```
Follower timeout → Candidate → RequestVote RPC
Win majority → become Leader → send AppendEntries heartbeats
Other candidates step down if see higher term
```

**Safety:** Leader only commits entry after majority replication; committed entries survive if new leader elected (from majority overlap).

**Zab (ZooKeeper):** Primary order broadcast; similar role to Raft for log entries on the ZK data tree.

**Raft log replication — step by step (5-node cluster, term 7):**

```
Client ──► Leader (node 3, term=7)
              │
              ├─ AppendEntries(index=42, entry=SET x=5) ──► Followers 1,2,4,5
              │     majority ack from {1,2,3}  →  entry 42 COMMITTED at index 42
              │     leader applies to state machine, responds 200 to client
              │
              └─ If follower 5 is partitioned:
                    leader still commits with {1,2,3}
                    follower 5's log diverges at next election → overwritten on rejoin
```

**Pre-vote (Raft extension in etcd/Consul):** Before starting a real election, a candidate sends **PreVote** RPCs with `term+1` but does not increment its own term yet. If it would not win (partitioned minority, or leader still alive), it **aborts** — preventing a partitioned node from bumping the cluster term and forcing the real leader to step down. Production symptom without pre-vote: minority partition triggers election → higher term → majority leader demoted → **unnecessary failover** during transient network blip.

**Linearizable reads without writing:** Naive leader read is wrong if the node **thinks** it is leader but lost quorum. Safe patterns:

| Pattern | Mechanism | Cost |
|---|---|---|
| **ReadIndex** | Leader confirms it still holds leadership (heartbeat quorum ack) before serving read | +1 RTT |
| **Lease read** | Leader assumes leadership for lease duration without re-check (risky under clock skew) | 0 extra RTT |
| **Quorum read** | Read from R nodes with version check | R RTTs |

etcd uses ReadIndex by default for linearizable reads; `serializable` reads skip it (stale possible on former leader).

**Membership changes (joint consensus):** Adding or removing voters is dangerous if done naively — two disjoint majorities could both commit conflicting entries. Raft uses **joint configuration**: old+new majority required during transition, then switches to new-only majority. Never shrink etcd to 2 voters "temporarily" without understanding this.

**Log compaction:** Unbounded Raft logs fill disk and slow recovery. **Snapshots** capture applied state + last included index/term; followers catch up via `InstallSnapshot` RPC instead of replaying millions of entries. Production rule: snapshot after N entries or M bytes; verify restore in DR drills.

**Crash vs Byzantine faults:** Raft/Paxos assume **crash-stop** nodes (fail silent or stop). Byzantine nodes can lie; requires PBFT or similar — 3f+1 nodes to tolerate f Byzantine. Most microservice stacks use crash fault tolerance; don't conflate "we use Raft" with "we tolerate malicious nodes."

**When you need consensus vs when you don't:**

| Need | Use consensus (Raft/etcd) | Skip consensus |
|---|---|---|
| Cluster membership, leader, config | Yes | — |
| Per-shard ordering at scale | Raft per range (Cockroach) | Single Kafka partition per key |
| Every user write globally | Expensive | Shard by user_id; single writer per shard |
| Read-heavy catalog | No | Leader + async replicas + eventual |

### Production scenario: etcd quorum loss during rolling upgrade

**Problem.** 3-node etcd cluster; ops takes 2 nodes down for upgrade simultaneously. Cluster read-only; Kubernetes API fails; cascading deploy freeze.

**Solution.** Never reduce quorum below majority simultaneously; use 5 nodes for 2 simultaneous failures tolerance; maintenance: one node at a time; verify `etcdctl endpoint health` between steps.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Even number of voters (split votes) | Election flapping |
| Learners mistaken for voters | False quorum assumptions |
| Large Raft logs without snapshot | Slow recovery; disk full |
| Cross-region Raft without latency budget | Timeouts; constant elections |

### Debugging scenario

**Observe.** Consul/etcd "leader changed" logs every few seconds.

**Diagnose.** Network latency near election timeout; CPU starvation on nodes; clock jump. Check RTT vs `election-timeout` (Raft: typically 10× heartbeat).

**Fix.** Tune timeouts; fix network; add resources; ensure single leader process per node.

### Raft commit index — what "committed" means in an incident

```
Index:  1    2    3    4    5    6
Leader: [A]  [B]  [C]  [D]  [E]  [F]
        ✓✓✓  ✓✓✓  ✓✓✓  ✓✓   ✗    ✗     ← partition at index 4
                              ↑
                    committed = 3 (majority of 3/5 replicated)
                    index 4-5 uncommitted on minority leader — lost on failover
```

If a client received ack for index 5 from a leader that was then isolated in the minority, that write is **not committed** under Raft rules — the client must retry on the new leader. Application code that treats "leader ack" as durable without understanding commit index is a common source of "we lost data but got 200 OK."

### Debugging scenario — split vote loop

**Observe.** Five-node Raft cluster elects no stable leader for 30+ seconds after all nodes restart simultaneously.

**Diagnose.** All nodes started as candidates at once; random election timeouts collided; no node reached majority before another election started. Check `election-timeout` spread (should be randomized, e.g. 150–300 ms), network partition, or clock jump resetting timers.

**Fix.** Ensure randomized election timeout; verify odd voter count; one node at a time restart during maintenance; increase `election-timeout` if cross-region RTT is high.

---

## 15. Quorum

### Core concept

A **quorum** is the minimum number of nodes that must participate in an operation for the system to make progress or guarantee consistency.

For replica set size **N**:

- **Write quorum W** — writes acknowledged by W nodes.
- **Read quorum R** — reads consult R nodes.
- **If R + W > N**, read overlaps write quorum → **strong read** possible (Monotonic quorum read with version checks).

Common formula: majority `W = floor(N/2) + 1` for fault tolerance **f** where **N = 2f + 1**.

```
N=3, W=2, R=2  →  R+W=4 > 3  (tolerate 1 failure)
N=5, W=3, R=3  →  tolerate 2 failures
```

### Internal working — sloppy quorum and hinted handoff

**Sloppy quorum (Dynamo):** During failure, write to **alternative** nodes outside preference list; return when W acknowledgments received anywhere — improves availability; repair on recovery.

**Hinted handoff:** Temporary delegate for failed node; write forwarded when node returns.

**Quorum vs leader-based:** Raft commits on majority of **log entries**; Cassandra quorum is **per operation** tunable (`LOCAL_QUORUM`, `EACH_QUORUM`).

| Consistency Level (Cassandra) | Behavior |
|---|---|
| `ONE` | Fast; stale likely |
| `QUORUM` | Majority of replicas |
| `LOCAL_QUORUM` | Majority in local DC |
| `ALL` | All replicas; unavailable if one down |

**Witness / arbiter nodes:** A node that votes but holds no data — breaks even-count ties without doubling storage cost. MongoDB arbiter, SQL Server witness in quorum. **Caution:** witness in same AZ as a data node does not survive AZ loss; place witness in third AZ.

**Dynamic quorum math after RF change:**

```
RF=3, QUORUM=2  →  tolerate 1 replica down
RF=4, QUORUM=2  →  still tolerate 1 down (NOT 2!) — overlap math changed
RF=5, QUORUM=3  →  tolerate 2 down
```

After changing RF, recalculate every service's consistency level — do not assume "QUORUM" means the same fault tolerance.

**Quorum reads with versions:** Cassandra returns multiple versions when replicas disagree; coordinator reconciles (last-write-wins by default, or returns all versions for application merge). Strong read requires `SERIAL` / `LOCAL_SERIAL` lightweight transactions in CQL — 4 round-trips, not free.

**Worked example — 5-node cluster, RF=5, QUORUM=3:**

```
Write v=100 acknowledged by nodes {A,B,C}  →  durable (3 of 5)
Node D,E lagging with v=99

Read QUORUM from {C,D,E}:
  responses: v=100 (C), v=99 (D), v=99 (E)
  majority value = v=100 (3 responses, v=100 wins by count or timestamp)  ✓

Read ONE from {E} only:
  response: v=99  →  stale read guaranteed possible  ✗
```

**Witness math — 2 data nodes + 1 witness (N=3 effective votes, witness holds no data):**

```
Partition: data-A + witness in AZ-1 | data-B alone in AZ-2
  AZ-1 side: 2 votes ≥ majority → can elect leader, accept writes
  AZ-2 side: 1 vote < majority  → read-only

Risk: witness co-located with data-A → AZ-1 failure loses majority AND both data copies
Rule: witness in third AZ; never co-locate with either data node
```

**Monotonic quorum reads:** Client tracks highest version seen `V_max`. Each subsequent read must return version ≥ `V_max`. Coordinator selects replicas known to have ≥ `V_max` (via gossip or explicit version exchange) before responding. Without monotonic quorum reads, two consecutive QUORUM reads can still go backwards if they hit different replica sets.

**Hinted handoff failure mode:** Node C down; writes go to hints on D and E. C returns; hints replay. If C was down so long hints expired (or C's data was GC'd), **data loss** unless repair/anti-entropy runs. Monitor hint size and replay lag; cap partition tolerance by hint retention window.

### Production scenario: RF=3 but W=1 for "performance"

**Problem.** Team sets default write CL to ONE for latency. During node failure, only one replica has new data; QUORUM read after repair lag returns old value → customer sees reverted state.

**Solution.** Match CL to SLA: `LOCAL_QUORUM` writes + reads for customer data; document stale window for analytics at ONE; monitor `ConsistencyLevel` metrics.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| RF < quorum formula assumes | Cannot survive advertised failures |
| Different CL per microservice on same table | Nondeterministic user experience |
| Quorum across uneven DC replica placement | LOCAL_QUORUM ignores failed DC incorrectly |

### Debugging scenario

**Observe.** After adding 4th replica, more read inconsistencies.

**Diagnose.** RF changed but apps still use CL=QUORUM (now 2 of 4 — overlap math changed). Recalculate R+W>N.

**Fix.** Update CL or use `SERIAL`/`LOCAL_SERIAL` where supported; run repair.

### Quorum overlap proof (interview whiteboard)

For N=3, W=2, R=2: any read quorum (2 nodes) intersects any write quorum (2 nodes) in at least one node → that node has the latest write (if write succeeded). With W=1, R=1: read and write may hit disjoint single replicas → stale read guaranteed possible.

```
Write quorum {A,B}     Read quorum {B,C}  → overlap {B} ✓
Write quorum {A} only  Read quorum {C} only → overlap ∅ ✗ stale
```

---

## 16. Leader Election

### Core concept

**Leader election** selects one node as coordinator for ordering writes, batch jobs, shard ownership, or singleton work. Goals:

- **At most one leader** at a time (safety).
- **Eventually a leader** if majority alive (liveness).

Mechanisms:

- **Bullying / ring** — academic; rare in prod.
- **ZooKeeper ephemeral sequential nodes** — min sequence wins; watch predecessor.
- **etcd lease + transaction** — create key with lease; TTL expires → re-elect.
- **Raft built-in** — integrated with consensus log.
- **Database advisory locks** — `pg_advisory_lock` (fragile across DB failover unless tied to primary role).
- **Kubernetes Lease** — controller-runtime pattern.

### Internal working — ZooKeeper vs etcd pattern

**ZooKeeper:**

```
Create EPHEMERAL_SEQUENTIAL /election/node-
  → /election/node-0000000001, node-0000000002
Lowest sequence = leader
Others watch next-lower node
Session expire → ephemeral deleted → wake watcher → re-run
```

**etcd (Kubernetes control plane):**

```
Campaign: txn create leader key if not exists, attach lease
Keepalive lease while leader
On partition: minority cannot renew; majority elects new leader
```

**Split brain prevention:** Leader must hold **majority-valid lease** or **majority vote**; fencing on promotion.

**Kubernetes Lease (controller-runtime):**

```java
// Simplified pattern — production uses leader-election library
LeaderElectionConfig config = new LeaderElectionConfig(
    "my-controller-leader",
    Duration.ofSeconds(15),   // lease duration
    Duration.ofSeconds(10),   // renew deadline
    Duration.ofSeconds(2),    // retry period
    () -> { /* onStartLeading */ },
    () -> { /* onStopLeading */ }
);
```

Only the lease holder runs the reconciler loop. On partition, minority cannot renew → steps down. **Still not fencing** unless downstream storage checks lease resourceVersion or a monotonic epoch.

**Tie-breaking:** When two candidates have same log completeness, Raft breaks ties by **randomized election timeout** — lower ID does not automatically win (unlike bully). ZooKeeper breaks ties by **lowest sequence number** on ephemeral sequential node.

**Lease renewal vs work duration:** Rule of thumb: `lease_ttl > 3 × renew_interval > 3 × p99.9(gc_pause + network_jitter)`. If your job runs longer than lease TTL without renewal, you need heartbeat renewal inside the job (ShedLock `lockAtMostFor` extension) or a workflow engine with checkpointing.

**etcd leader campaign — what actually happens:**

```
1. Candidate creates txn: IF leader key absent → PUT with lease L
2. On success: candidate holds lease; mod_revision of key = fencing token
3. Keepalive goroutine renews L every TTL/3
4. Partition: minority cannot renew → lease expires → key deleted → new election
5. Old leader resumes: keepalive fails → must step down BEFORE writing
```

```java
// etcd4j-style campaign (simplified — production uses jetcd LeaderElection)
public Optional<Long> tryAcquireLeader(EtcdClient etcd, String key, long ttlSeconds) {
    long leaseId = etcd.grantLease(ttlSeconds);
    TxnResponse resp = etcd.txn()
        .If(new Cmp(key, Cmp.Op.EQUAL, CmpTarget.create(0)))  // key version = 0 (absent)
        .Then(Op.put(key, ByteSequence.from(myNodeId), PutOption.newBuilder().withLeaseId(leaseId).build()))
        .Else(Op.get(key))
        .commit();
    if (resp.isSucceeded()) {
        startKeepalive(leaseId, ttlSeconds / 3);
        return Optional.of(resp.getPut().getModRevision());  // fencing token
    }
    return Optional.empty();
}
```

**Split vote — numeric walkthrough (5 voters, simultaneous restart):**

```
t=0   All 5 followers timeout simultaneously → all become candidates
t=1   Each requests votes for term=1 from others
      No candidate gets 3 votes (each votes for self) → split vote
t=2   Randomized election timeout (150–300ms) → node 3 times out first at 187ms
t=3   Node 3 becomes candidate term=2, wins votes from {1,2,3,4,5} → leader
Without randomization: infinite split vote loop at 30+ seconds
```

**Pre-vote prevents false demotion:** Node 4 partitioned, times out, would start election at term=8. Pre-vote fails (no quorum). Node 4 stays follower at term=7. Real leader unaffected. Without pre-vote: term bumps to 8, real leader steps down, cluster flaps.

### Production scenario: duplicate scheduled job execution

**Problem.** Spring `@Scheduled` on 8 pods; no leader election; nightly billing batch runs 8 times; duplicate charges.

**Solution options:**

1. **ShedLock** — DB/Redis lock with TTL.
2. **Kubernetes Job** — single pod CronJob.
3. **Leader election via Curator / etcd** — one worker runs task.
4. **Partition billing key in Kafka** — single consumer per partition (preferred at scale).

Ensure lock TTL > max job duration + fencing token passed to downstream idempotent API.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Lock without TTL | Dead leader blocks forever |
| TTL too short | Two leaders briefly overlap |
| Leader continues after losing lease | Split brain writes |
| Election on even nodes without tie-break | Split votes |

### Debugging scenario

**Observe.** Two pods log "I am the leader" simultaneously for 10 seconds.

**Diagnose.** Compare lease TTL, GC pauses, clock skew. Check if both acquired lock before mutual exclusion visible.

**Fix.** Increase TTL margin; use compare-and-delete with fencing token; JVM pause monitoring.

### Leader election vs distributed lock — know the difference

| Property | Leader election | Distributed lock (Redis SET NX) |
|---|---|---|
| Purpose | One active worker / writer | Mutual exclusion for a critical section |
| Typical holder | One per cluster/shard | Many locks, many holders |
| Split-brain risk | Two leaders | Two lock holders after TTL expiry |
| Fencing | Epoch/token to storage | Requires explicit token design |
| Good for | Controllers, batch schedulers | Short critical sections |

Prefer **partition ownership** (Kafka consumer per partition) over cluster-wide leader election when scale demands it — natural sharding without a global choke point.

---

## 17. Fencing Tokens

### Core concept

A **fencing token** is a **monotonically increasing number** (or epoch) issued by the lock/leader service when a node acquires leadership. Every write to shared storage must carry the current token; storage **rejects** any write with a token lower than the highest it has already accepted.

**Why locks alone fail:** A distributed lock (Redis `SET NX`, etcd lease, ZooKeeper ephemeral node) only tells the holder "you may proceed." It does not tell **storage** who is allowed to write. After a GC pause or network partition, the old holder can wake up still believing it holds the lock and corrupt state — the lock service may have already granted the lock to someone else.

**Martin Kleppmann's formulation:** The lock is an optimization; the **fencing token checked at the storage layer** is the safety mechanism.

Token sources:

| Source | Token value | Monotonic? |
|---|---|---|
| **ZooKeeper** | `zxid` of the lock znode | Yes (per ensemble) |
| **etcd** | `mod_revision` of the leader key | Yes |
| **Raft term + log index** | `(term, index)` pair | Yes per shard |
| **Dedicated table** | `SELECT MAX(epoch)+1` under TX | Yes if single writer to table |
| **Patroni / Postgres** | Timeline ID + promotion epoch | Yes per cluster history |

### Internal working — GC pause + lease expiry (worked example)

```
t=0.0s   Node L acquires etcd lease, receives fencing token T=42
         L begins writing block B to shared object store

t=0.5s   L enters 8s stop-the-world GC pause (heap pressure, untuned G1)

t=1.0s   etcd lease TTL (5s) expires — L cannot renew (paused)

t=1.2s   Node F wins election, receives token T=43
         F writes block B' to object store with token 43 → ACCEPTED
         Storage records: last_token = 43

t=2.0s   F completes failover; traffic routes to F

t=8.5s   L resumes from GC
         L still holds local "I am leader" flag (never re-checked lease)
         L writes block B with token 42

WITHOUT fencing:  B overwrites B'  →  split-brain data loss
WITH fencing:    storage rejects token 42 < 43  →  L's write fails, L must step down
```

The storage check must be **atomic with the write**:

```sql
-- Pattern: conditional update on epoch column
UPDATE account_balance
   SET balance = :newBalance, fencing_epoch = :token
 WHERE id = :id AND fencing_epoch < :token;
-- 0 rows updated → stale leader; abort and re-elect
```

```java
// DynamoDB conditional write on fencing epoch
UpdateItemRequest.builder()
    .conditionExpression("attribute_not_exists(fencing_epoch) OR fencing_epoch < :token")
    .expressionAttributeValues(Map.of(":token", AttributeValue.fromN("43")))
    ...
```

### Internal working — monotonic token to storage

Three layers must align:

```
┌─────────────┐     acquire      ┌──────────────┐     write(token)     ┌─────────────┐
│  Candidate  │ ───────────────► │ Lock service │                      │   Storage   │
│   node      │ ◄─────────────── │ (etcd/ZK)    │                      │  (SoT)      │
└─────────────┘   token T=43     └──────────────┘                      └─────────────┘
       │                                                                      ▲
       └──────────────────────────────────────────────────────────────────────┘
                              every mutation carries T; storage rejects T < max_seen
```

**Anti-patterns:**

- Token stored only in application memory, never sent to storage.
- Token checked in application code but storage API has no conditional write.
- Shared NFS/SAN without epoch — both primaries can write the same file.
- Object store PUT without `If-Match` / generation precondition.

### Production scenario: zombie primary after Patroni failover

**Problem.** Postgres Patroni fails over from `pg1` to `pg2`. Old primary `pg1` was paused (kernel freeze during EBS stall) for 45s. When it resumes, it still accepts connections on the old VIP for 30s until DNS TTL expires. Application connection pool writes duplicate invoice rows.

**Cause.** No fencing at the storage layer — Postgres on `pg1` did not know it was demoted until Patroni callback ran, and apps bypassed Patroni entirely via cached connections.

**Solution.**

```bash
# Step 1 — STONITH: stop the old instance before promoting (game-day tested)
aws ec2 stop-instances --instance-ids i-pg1-old --force

# Step 2 — Patroni callback script on promote
#!/bin/bash
# detach-old-vip.sh — runs on new primary ONLY after epoch bump in DCS
OLD_LEADER_IP=$(curl -s http://127.0.0.1:8008/leader | jq -r .previous_leader)
aws ec2 stop-instances --instance-ids "$(resolve_instance $OLD_LEADER_IP)" --force
```

```sql
-- Application-level epoch on financial tables (belt + suspenders)
ALTER TABLE invoices ADD COLUMN write_epoch BIGINT NOT NULL DEFAULT 0;
-- Every INSERT/UPDATE includes epoch from Patroni / DCS; reject lower epochs in trigger
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Lock without token propagation to SoT | Rare duplicate writes after GC pause |
| Token checked in app, not in storage TX | Race between check and write |
| Shared filesystem without generation lock | Both primaries corrupt WAL/data files |
| Epoch bumped in DCS but not on write path | Fencing exists on paper only |
| Assuming cloud LB stops old primary traffic instantly | 30–120s dual-write window |

### Debugging scenario

**Observe.** After failover, row counts differ between former primary and new primary; overlapping write timestamps.

**Diagnose.** Build leadership timeline from DCS history + `pg_controldata` timelines. Check if any write carried `fencing_epoch` lower than current cluster epoch. Search logs for "conditional check failed" / `0 rows updated` on epoch-guarded tables.

**Fix.** STONITH old primary immediately; reconcile from winner; add epoch column + conditional writes on all mutation paths.

---

## 18. Idempotency and Exactly-Once Reality

### Core concept

**At-least-once delivery** is the default in distributed systems (retries, message redelivery, consumer crash after process-before-ack). **Exactly-once** end-to-end is impossible without cooperation from all layers (FLP-adjacent). **Effectively-once** means: duplicates may arrive, but **side effects happen once** — via idempotency keys, deduplication stores, and natural unique constraints.

```
At-least-once broker  +  idempotent consumer  =  effectively-once processing
At-least-once HTTP    +  idempotency key      =  effectively-once API
```

### Internal working — dedup store

```
Consumer receives message {eventId: "evt-9f3a", payload: {...}}
  │
  ├─► BEGIN TX
  │     INSERT INTO processed_events (event_id, processed_at, result_hash)
  │       VALUES ('evt-9f3a', now(), ...)
  │     ON CONFLICT (event_id) DO NOTHING
  │     RETURNING event_id
  │
  ├─► IF no row returned → duplicate → ACK and skip (return cached outcome)
  │
  ├─► ELSE execute business logic
  │
  └─► COMMIT → ACK broker
```

**Dedup key selection:**

| Source | Key | Collision risk |
|---|---|---|
| Broker message ID | `kafka offset + partition` | Safe within topic; not across topics |
| Business event ID | `paymentId`, `orderId` | Best when domain owns uniqueness |
| Content hash | `SHA256(payload)` | Dangerous if payload can legitimately repeat |
| Composite | `(tenantId, idempotencyKey)` | Multi-tenant APIs |

### Internal working — TTL sizing for dedup store

TTL must cover the **maximum redelivery window**, not the average:

```
TTL ≥ max(
  broker_retention,
  consumer_max_processing_time + rebalance_grace,
  client_retry_window (exponential backoff sum),
  DLQ_replay_horizon
)
```

Worked example:

```
Client retry: 5 attempts, backoff 1s + 2s + 4s + 8s + 16s = 31s max
Kafka retention: 7 days
Consumer crash: unacked message redelivered after session.timeout.ms = 45s
Rebalance: max.poll.interval.ms = 300s (5 min) — consumer considered dead, partition reassigned

Dedup TTL for payment events:
  min = 7 days (match retention — replay from offset 0 must still dedupe)
  OR forever for money (store in ledger table with UNIQUE on event_id)

Dedup TTL for analytics click events:
  min = 48h (acceptable duplicate click count < 0.01% SLA)
```

**Storage cost math:**

```
events/day        = 2,000,000
dedup row bytes   = 64 (event_id UUID + timestamp + status)
TTL               = 7 days

Storage ≈ 2M × 64 × 7 ≈ 896 MB  (plus index overhead ~2×)
```

### Java — idempotent Kafka consumer with dedup store

```java
@KafkaListener(topics = "payments")
@Transactional
public void onPayment(ConsumerRecord<String, PaymentEvent> record) {
    String eventId = record.value().eventId();

    int inserted = jdbcTemplate.update(
        "INSERT INTO processed_events (event_id, topic, partition, offset, status) " +
        "VALUES (?, ?, ?, ?, 'IN_PROGRESS') ON CONFLICT (event_id) DO NOTHING",
        eventId, record.topic(), record.partition(), record.offset());

    if (inserted == 0) {
        log.info("Duplicate event {}, skipping", eventId);
        return; // ack happens after method returns
    }

    paymentService.apply(record.value());

    jdbcTemplate.update(
        "UPDATE processed_events SET status = 'COMPLETED' WHERE event_id = ?",
        eventId);
}
```

```java
// HTTP idempotency — Stripe-style header
@PostMapping("/charges")
public ResponseEntity<ChargeResponse> charge(
        @RequestHeader("Idempotency-Key") String key,
        @RequestBody ChargeRequest req) {
    return idempotencyService.execute(key, "charge", () -> chargeService.charge(req));
}
```

### Production scenario: duplicate charges after payment gateway timeout

**Problem.** Client POST `/charges` times out at 30s; server completed at 35s. Client retries with same body but **new** random idempotency key. Customer charged twice.

**Cause.** Idempotency key not required; client generated new key per retry.

**Solution.** Require `Idempotency-Key` header; reject missing key on POST; document that clients must reuse the same key for retries of the same logical operation; store `(key, scope) → response` for 24h minimum.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Dedup outside business TX | Process twice on crash between dedup insert and side effect |
| TTL shorter than retry window | Duplicate side effects after key expires |
| `IN_PROGRESS` without timeout | Stuck key blocks legitimate retry forever |
| Dedup on consumer only, not producer | Duplicate publishes from producer retry |
| Content-hash as idempotency key | Legitimate duplicate payloads rejected |

### Debugging scenario

**Observe.** 0.3% duplicate order lines; all have different `request_id` but same cart contents within 60s.

**Diagnose.** Access logs show pairs of POST with 30s gap (client timeout). Idempotency table empty — feature deployed but not enforced on route.

**Fix.** Enforce header; return `409` without key; backfill monitoring on duplicate `business_key` inserts caught by unique constraint.

---

## 19. CRDTs — Conflict-Free Replicated Data Types

### Core concept

**CRDTs** are data structures designed so that concurrent updates on different replicas **always merge** to the same state without coordination — **commutative, associative, idempotent** merge function. They turn "partition healed, now merge" from an ops nightmare into a math guarantee.

Two families:

| Family | Mechanism | Examples |
|---|---|---|
| **State-based (CvRDT)** | Merge function on full state; send state | G-Counter, G-Set |
| **Op-based (CmRDT)** | Replay operations; ops must be commutative | OR-Set, PN-Counter |

Use when: high write availability during partition, concurrent edits expected, automatic merge acceptable. Avoid when: business rules require single winner (inventory count), or merge semantics are not expressible.

### Internal working — G-Counter (grow-only counter)

Each replica maintains a vector of per-replica counts. Value = **sum of all per-replica counts**. Increment only on own index.

```
Replica A: {A:3, B:1, C:0}  →  value = 4
Replica B: {A:2, B:2, C:1}  →  value = 5

Merge(A, B) = {A: max(3,2), B: max(1,2), C: max(0,1)} = {A:3, B:2, C:1} → value = 6
```

Cannot decrement — use **PN-Counter** (two G-Counters: P and N) for increment/decrement.

```java
/** Minimal G-Counter — state-based CRDT; merge is per-replica max then sum. */
public final class GCounter {
    private final String replicaId;
    private final Map<String, Long> counts = new ConcurrentHashMap<>();

    public GCounter(String replicaId) { this.replicaId = replicaId; }

    public void increment() {
        counts.merge(replicaId, 1L, Long::sum);
    }

    public long value() {
        return counts.values().stream().mapToLong(Long::longValue).sum();
    }

    public void merge(GCounter other) {
        other.counts.forEach((id, c) ->
            counts.merge(id, c, Math::max));  // commutative, associative, idempotent
    }
}
```

### Internal working — LWW-Register (last-writer-wins)

Each write carries `(value, timestamp, replica_id)`. Merge picks highest timestamp; tie-break by replica_id.

```
A writes ("pro",  t=100, node=A)
B writes ("free", t=105, node=B)   ← wins after merge

Concurrent with clock skew:
A writes ("pro",  t=200, node=A)   ← skewed clock wins incorrectly
```

LWW-Register is a CRDT but **not** semantically safe under clock skew — prefer **version vectors** or server-side timestamps for registers that matter.

### Internal working — OR-Set (observed-remove set)

Add tags an element with a unique identifier; remove tombstones specific add-tags. Re-add after remove works correctly (unlike G-Set).

```
add("seat-7", uuid-1)   on A
add("seat-7", uuid-2)   on B   (concurrent)
remove("seat-7", uuid-1) on A

Merge: element "seat-7" still present (uuid-2 tag survives)
```

### Java — minimal OR-Set style cart merge

```java
public final class OrSet<T> {
    private final Map<T, Set<UUID>> added = new ConcurrentHashMap<>();
    private final Map<T, Set<UUID>> removed = new ConcurrentHashMap<>();

    public void add(T element) {
        added.computeIfAbsent(element, k -> ConcurrentHashMap.newKeySet()).add(UUID.randomUUID());
    }

    public void remove(T element) {
        Set<UUID> tags = added.get(element);
        if (tags != null) removed.put(element, new HashSet<>(tags));
    }

    public Set<T> elements() {
        return added.entrySet().stream()
            .filter(e -> {
                Set<UUID> dead = removed.getOrDefault(e.getKey(), Set.of());
                return e.getValue().stream().anyMatch(tag -> !dead.contains(tag));
            })
            .map(Map.Entry::getKey)
            .collect(Collectors.toUnmodifiableSet());
    }

    public void merge(OrSet<T> other) {
        other.added.forEach((k, tags) ->
            added.computeIfAbsent(k, x -> ConcurrentHashMap.newKeySet()).addAll(tags));
        other.removed.forEach((k, tags) ->
            removed.computeIfAbsent(k, x -> ConcurrentHashMap.newKeySet()).addAll(tags));
    }
}
```

Production libraries: **Riak DT**, **Redis CRDT** (Enterprise), **Automerge** (JSON CRDT), **Yjs** (collaborative editing). For JVM services, many teams use CRDT semantics via **event sourcing** (add-wins events) rather than shipping custom CRDT code.

### Production scenario: collaborative shopping cart across devices

**Problem.** User adds items on phone (AP Cassandra `LOCAL_ONE`); tablet reads stale; both add same SKU during partition; merge loses one quantity.

**Solution.** Model cart as OR-Set of `(sku, lineId)` pairs; quantity as G-Counter per lineId. On sync, merge without conflict. Display total = sum of merged counters. Accept that "remove all" during partition may need tombstone grace period.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| LWW-Register with client timestamps | Skewed node wins; silent data loss |
| G-Counter for inventory that can decrease | Cannot represent returns; count only goes up |
| CRDT without garbage collection on tombstones | Metadata grows forever; OR-Set bloat |
| CRDT for money balances | Merge semantics wrong for finance — use authoritative ledger |

### Debugging scenario

**Observe.** After partition heals, cart item count differs per device; refresh fixes it.

**Diagnose.** Check if merge function invoked on read path; compare replica states pre-merge; look for LWW on registers where OR-Set was needed.

**Fix.** Migrate cart lines to OR-Set + G-Counter; add integration test that merges two divergent replica states and asserts convergence.

---

## 20. Backpressure and Queueing Theory

### Core concept

**Backpressure** is the mechanism by which a **slow downstream** signals upstream to **slow down or stop** — preventing unbounded queues, OOM, broker disk fill, and cascading failure. Without backpressure, systems absorb overload into memory until they collapse (retry storms make this worse).

| Layer | Backpressure mechanism |
|---|---|
| **TCP** | Receive window shrinks |
| **HTTP/2** | Stream flow control |
| **Reactive Streams** | `request(n)` demand signal |
| **Kafka consumer** | `pause()` partitions; lag grows |
| **RabbitMQ** | `basicQos(prefetch)`; memory alarm blocks publishers |
| **Thread pool** | `CallerRunsPolicy` / bounded queue rejection |
| **API gateway** | Rate limit 429; circuit breaker open |

### Internal working — Little's Law

**L = λ × W**

| Symbol | Meaning | Production reading |
|---|---|---|
| **L** | Average items in system (queue depth + in service) | Connection pool pending, Kafka lag, thread pool queue |
| **λ** | Arrival rate (requests/sec, messages/sec) | RPS, produce rate |
| **W** | Average time in system (wait + service) | p50/p99 latency, consumer processing time |

**If λ is stable but L is growing, W must be growing** — something got slower. Adding pods when the bottleneck is a shared DB primary increases λ to the DB without reducing W.

Worked example:

```
Checkout service:
  λ = 500 RPS
  W = 200 ms average (measured end-to-end)
  L = 500 × 0.2 = 100 requests in flight (connections, threads, queues)

Deploy slows DB queries: W → 800 ms
  L = 500 × 0.8 = 400 in flight
  If pool max = 200 → 200 requests queue → timeouts → retries → λ_effective doubles
  → death spiral
```

**Utilization and queueing:** As utilization ρ → 1 (server busy fraction), wait time explodes (M/M/1 intuition: `W_q = ρ/(μ(1-ρ))`). Running DB at 95% CPU is not "efficient" — it is a tail-latency trap.

### Internal working — tail latency fan-out

A request that calls N independent services in parallel has p99 ≈ worst of N p99s (if any failure fails the request):

```
Single service p99 = 200 ms
Fan-out to 10 services (parallel):
  P(all < 200ms) = 0.99^10 ≈ 0.90  →  10% of requests exceed 200ms on at least one leg

Fan-out to 50 sequential hops at p99=50ms each:
  Tail stacks: 50 × 50ms = 2.5s best case at p99 — untenable
```

**Mitigations:**

- Reduce fan-out (BFF aggregation, materialized views).
- Hedged requests (send backup after delay) — doubles load; use sparingly.
- Timeout per dependency < client timeout; bulkhead isolation.
- **Partial response** with defaults for non-critical legs.

```java
// Bulkhead — bounded queue + reject fast instead of unbounded wait
@Bean
public ThreadPoolExecutor inventoryPool() {
    return new ThreadPoolExecutor(
        10, 10, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(50),
        new ThreadPoolExecutor.AbortPolicy()); // throws RejectedExecutionException → map to 503
}
```

### Production scenario: Kafka lag spiral during DB outage

**Problem.** Inventory consumer lag hits 2M messages; DB recovers; consumers catch up at 5k msg/s but produce rate is 8k msg/s; lag never clears; retention deletes unprocessed messages.

**Cause.** No backpressure on producer; consumer could not signal upstream; retry storm on inventory API during outage filled the topic.

**Solution.**

```java
// Consumer-side: pause when downstream unhealthy
@Scheduled(fixedRate = 5000)
void adjustConsumption() {
    if (inventoryDb.health().isDown() || inventoryDb.pool().getPending() > 100) {
        listenerContainer.pause();
    } else {
        listenerContainer.resume();
    }
}
```

```java
// Producer-side: fail fast when lag exceeds threshold
if (lagExporter.maxLag("inventory-updates") > 500_000) {
    throw new ServiceUnavailableException("inventory pipeline overloaded");
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Unbounded executor queues | Heap OOM before any rejection |
| Infinite client retries | Retry storm amplifies λ |
| No `max.poll.interval` tuning | Consumer kicked; endless rebalance |
| Synchronous fan-out without timeouts | One slow leg blocks entire request |
| Scaling consumers without scaling DB | Lag clears to DB meltdown |

### Debugging scenario

**Observe.** p99 latency 8s; p50 still 80ms; CPU 40%.

**Diagnose.** Trace shows one dependency sporadically slow (gray failure). Thread dump shows hundreds of threads blocked on `Future.get()`. Little's Law: queue depth 800 at λ=400 → W=2s average wait.

**Fix.** Per-dependency timeout 300ms; circuit breaker; async where possible; fix gray dependency (connection pool to exhausted downstream).

---

## 21. Distributed Systems Failure Catalog

Quick reference for on-call: **failure → symptom → detection → mitigation**. Not exhaustive — patterns that recur in production.

| Failure | Symptom | Detection | Mitigation |
|---|---|---|---|
| **Network partition** | Minority AZ writes fail; split brain if misconfigured | etcd/Consul health; cross-AZ error rate spike; `ping` mesh | Route to majority; fail closed on minority; game-day partition tests |
| **GC pause > lease TTL** | Phantom failover; duplicate leaders briefly | JVM GC logs correlated with leader changes; `jvm_gc_pause_seconds` | Tune GC; increase lease TTL; fencing tokens to storage |
| **Clock skew / jump** | LWW loses writes; lease logic breaks | `node_timex_offset_seconds`; trace timestamp inversions | chrony/PTP; server-side timestamps only; version/CAS not wall clock |
| **Replica lag** | Stale reads; read-your-writes broken | `pg_stat_replication`; Cassandra `nodetool tablestats` | Route session reads to primary; lag-aware routing; consistency tokens |
| **Retry without idempotency** | Duplicate records/charges | Duplicate POST in access logs; unique constraint violations | Idempotency-Key; dedup store; natural unique keys |
| **Lost quorum** | Cluster read-only; K8s API down | `etcdctl endpoint health`; voter count | Restore nodes one at a time; never 2-node voter cluster |
| **Split brain** | Conflicting writes; duplicate IDs | Overlapping leader logs; dual timeline IDs | STONITH; fencing epoch; reconcile from winner |
| **Consumer lag** | Stale projections; missed SLA | Kafka lag exporter; oldest message age | Scale consumers; backpressure producer; extend retention temporarily |
| **Hot key / shard** | Single partition throttled; uneven CPU | Per-key metrics; Cassandra hotspot detection | Salt keys; dedicated partition; cache hot path |
| **Thundering herd** | DB spike after cache expiry | Cache miss rate; connection pool pending | Singleflight; jittered TTL; stale-while-revalidate |
| **Cascading failure** | One service down takes out fleet | Circuit breaker open metrics; error budget burn | Bulkheads; timeouts; degrade non-critical features |
| **Gray failure** | p99 up, p50 normal; "flaky" | Outlier detection on dependency latency | Adaptive timeouts; shed load; fix slow tail |
| **Message redelivery** | Duplicate side effects | Same `eventId` processed twice in logs | Idempotent consumer; dedup table with TTL ≥ retention |
| **Unclean leader election (Kafka)** | Missing messages after failover | `unclean.leader.election.enable`; ISR shrink logs | `min.insync.replicas=2`; disable unclean election |
| **Tombstone pile-up (Cassandra)** | Read timeouts; repair slow | `nodetool tablestats` tombstone counts | `gc_grace_seconds` tuning; avoid wide partitions |
| **Connection pool exhaustion** | `Timeout waiting for connection` | Hikari `pending threads`; pool metrics | Right-size pool; reduce per-pod connections; read replicas |
| **DNS / VIP stale after failover** | Traffic to dead primary | Dual-write window; connection errors to old IP | Lower TTL; connection validation; STONITH old node |
| **Phi-accrual false positive** | Node flapping in/out of ring | Suspicion level graphs; GC correlation | Raise `phi_convict_threshold`; fix root cause not threshold |
| **2PC coordinator crash** | In-doubt transactions; blocked resources | `pg_prepared_xacts`; heuristic rollback logs | Avoid cross-DB 2PC; saga + outbox |
| **Outbox not published** | Downstream never sees event | Outbox table growing; no consumer lag | Outbox relay monitor; alert on unpublished age |

---

## 22. Putting It Together: System Profiles

This section maps real systems to CAP/PACELC/consistency/election — interview gold when you connect theory to names.

| System | Partition behavior | Normal op | Consistency default | Leader / quorum |
|---|---|---|---|---|
| **etcd** | CP | EC | Linearizable reads/writes with quorum | Raft leader |
| **ZooKeeper** | CP | EC | Sequential consistency (linearizable writes) | Zab leader |
| **Kafka** | Available with min ISR trade-offs | EL | Per-partition ordering; not global | Controller + partition leaders |
| **Cassandra** | AP | EL (tunable) | Tunable CL; eventual default | Per-node; no global leader |
| **PostgreSQL** | PC (primary) | EC with sync rep | Strong on primary | Single primary + sync/async standbys |
| **Redis Cluster** | CP-ish (majority slots) | EL | Per key master; async replication default | Slot primary election |
| **DynamoDB** | AP | EL | Eventual default; optional strong reads | Partition leaders hidden |
| **Spanner** | PC | EC | External consistency via TrueTime | Paxos per shard |
| **CockroachDB** | PC | EC | Serializable global transactions | Raft per range |
| **MongoDB** | PC (default) | EL with secondary reads | Primary writes; secondary reads eventual | Replica set primary election |
| **Consul** | CP (with consistency mode) | EC | Strong in consistency mode | Raft leader |
| **Hazelcast / Ignite** | AP by default | EL | Partitioned in-memory; split-brain merge config | Split-brain protection quorum |

### Cross-cutting patterns that appear in every profile

**Pattern 1 — Single writer per shard.** Whether Kafka partition leader, Raft leader, or DB primary, most systems serialize writes through one authority per shard to avoid conflict explosion.

**Pattern 2 — Replication before ack.** Strong systems wait for N replicas; AP systems ack after one and repair later. Your p99 write latency is largely "how many replicas did you wait for?"

**Pattern 3 — Metadata separate from data.** Large systems run consensus on small metadata (who is leader, schema, routing) and looser consistency on bulk data (object storage, analytics).

**Pattern 4 — Human runbooks for split brain.** Automated prevention is mandatory; automated merge without domain logic is dangerous. Finance and inventory keep reconciliation jobs.

### Production scenario: polyglot persistence without polyglot consistency story

**Problem.** Order service on Postgres (strong), catalog on Elasticsearch (eventual), cart on Redis (AP), inventory on Cassandra (LOCAL_QUORUM). Product asks "why is checkout wrong?" Each team says their store is "consistent."

**Solution.** Draw an **end-to-end consistency map** per user journey:

```
Checkout journey:
  Cart (Redis) ──► Inventory (Cassandra QUORUM) ──► Order (Postgres TX) ──► Payment (external)
       │                      │                           │
   session token          reservation TTL            outbox → search index (eventual)
```

Document staleness budget per step. Checkout path uses strongest stores; recommendations use weakest.

### Production scenario: migrating monolith DB to services without losing consistency

**Problem.** Team splits Order table from User table into two services with separate databases. Foreign keys gone; orphan orders appear.

**Solution.** Choose explicitly:

- **Saga:** Create order pending → reserve user quota → confirm or compensate.
- **Shared DB temporarily:** Strangler fig — split services, same DB, then split DB with outbox.
- **Event sourcing:** Single ordered log both projections consume — consensus on log partition.

Never assume "eventual consistency will probably work out."

### Design exercise: global notifications service

- **High write volume, tolerate delay:** AP + eventual (Cassandra/Dynamo).
- **Must not duplicate push to mobile:** idempotent consumer + dedupe key (strong per user-device in DB).
- **Read unread count:** strong or `QUORUM` + CRDT counter.

### Design exercise: ride-sharing dispatch

- **Driver location:** AP; stale 2 seconds OK; high write rate.
- **Trip assignment:** linearizable or DB row lock on trip ID; only one driver assigned.
- **Fare calculation:** strong on completed trip record; eventual on estimates shown during ride.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Each team picks own CAP story | Architecture reviews fail; incidents blame wrong layer |
| Strong store behind AP cache with no TTL discipline | Users see impossible states |
| Elasticsearch as SoT for transactional data | Lost updates on reindex |
| Ignoring cross-store ordering | Side effects run before cause commits |

### Debugging scenario

**Observe.** "Only EU users" see wrong subscription tier after plan change.

**Diagnose.** US primary updated Postgres; EU CDN + read replica + edge cache chain 60s stale; billing webhook idempotent but UI reads stale tier.

**Fix.** Read-your-writes token on subscription API; purge CDN on plan change event; strong read on billing gate.

---

## 23. Production Debugging Playbook

When a distributed bug is "random," it is usually **partial failure**, **stale replica**, **duplicate message**, or **two leaders for a window**.

1. **Classify the symptom.** Stale data → consistency/replication. Duplicates → idempotency/retry. Total outage → quorum/leader. Flapping → election timeout/network.

2. **Establish timeline with correlated clocks (UTC).** Note NTP alerts on involved nodes. Wall clock skew explains LWW ghosts.

3. **Identify authoritative source of truth.** Which store wins on conflict? Is there actually one?

4. **Check partition/quorum state.** DB role, etcd health, Kafka ISR, Cassandra `nodetool status`, Redis cluster slots.

5. **Trace one broken request end-to-end.** Trace ID through sync path: API → cache → DB → outbox → consumer.

6. **Measure replication lag.** Postgres `pg_stat_replication`, MySQL `Seconds_Behind_Master`, Cassandra read repair stats, Kafka consumer lag.

7. **Inspect retry and timeout config.** Client timeout < server processing → duplicate submits. Exponential backoff with jitter.

8. **Look for split brain window.** Overlapping primary logs, dual controller, two leaders in logs with overlapping timestamps.

9. **Validate failure detector settings.** Too aggressive → unnecessary failover; too lenient → zombie primary.

10. **Chaos or game day reproduction.** Partition dependency in staging before changing production timeouts.

11. **Document PACELC decision after incident.** Update ADR so next on-call does not re-debate AP vs CP under pressure.

12. **Run reconciliation jobs.** Financial systems: compare ledger sum to transaction log daily; alert on drift.

### Symptom → likely cause → first command (cheat sheet)

| Symptom | Likely cause | First checks |
|---|---|---|
| Writes fail minority AZ only | CP quorum loss | DB/etcd role, `kubectl get lease`, Patroni history |
| Reads flip-flop values | Replica lag / AP reads | Lag metrics; which replica served read |
| Duplicate records same ID | Retry without idempotency | Access logs for duplicate POST; idempotency table |
| Cluster "frozen" | Lost quorum entirely | Voter count alive; recent deploy reducing nodes |
| Sudden p99 spike cross-region | Sync replication / quorum CL | Trace write path RTT; CL settings change in deploy |
| Job ran N times | Missing leader election | Pod count vs lock holder logs |
| Data "came back" after delete | LWW + clock skew / repair | Tombstone metrics; compare timestamps across replicas |

### Gray failure signals (partial slowness, not hard down)

Gray failures are worse than hard failures because health checks pass:

- Dependency p99 up but p50 normal — tail latency partition.
- TCP connects but app hangs — thread pool exhaustion on slow dependency.
- Intermittent `Connection reset` — LB idle timeout vs keepalive mismatch.

**Response:** Outlier detection on dependency latency; adaptive timeouts; bulkhead isolation; do not infinite retry.

### Post-incident consistency audit checklist

- [ ] Was there a partition or only slow network? (Different remediation.)
- [ ] Did any two primaries/leaders overlap in time? (Split brain.)
- [ ] Maximum replication lag during incident? (Stale read window quantified.)
- [ ] Were retries idempotent? Count duplicate side effects.
- [ ] Clock skew on nodes involved? (NTP graphs.)
- [ ] Was PACELC trade-off documented for affected path?
- [ ] Reconciliation job caught drift? If not, add one.

---

## 24. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Money, inventory deduction, seat booking | Single authoritative store or consensus; linearizable or DB transaction; idempotency keys |
| Social feed, view counts, analytics | Eventual OK; CRDT or periodic aggregation; monotonic reads for UX |
| Global low-latency reads, stale OK | AP + local replicas; version stamps on critical fields |
| Global strong consistency | Spanner/Cockroach/yugabyte or single region primary + read from primary |
| Network partition likely (multi-AZ) | Odd quorum nodes; majority write; minority fails closed for CP data |
| Singleton background job | K8s CronJob, ShedLock, or Kafka single-partition consumer |
| Cross-service transaction | Saga + outbox; avoid 2PC across heterogeneous systems |
| Ordering events | Kafka partition key; not wall clock |
| Conflict resolution | Detect (vector clock/version); merge (CRDT); or LWW with synced clocks + audit |
| Leader failure | Automated failover with fencing; manual runbook for split brain |
| Cache + DB | Cache-aside with TTL; invalidate via outbox; strong read path bypasses cache |
| Microservice read-your-writes | Sticky session or token routing to replica that has write |
| Choosing Cassandra CL | `LOCAL_QUORUM` for customer paths; `ONE` only for derived analytics |
| etcd/Consul for config | Always quorum across AZs; never 2-node voter cluster |
| Debugging "flaky" tests | Embedded single-node != prod; use Testcontainers cluster or contract tests |

---

*Distributed systems do not fail because you missed a design pattern. They fail because the network, clocks, and concurrency were treated as someone else's problem. Own the trade-offs explicitly — CAP at partition, PACELC every day — and test the failure modes before production teaches you.*


---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Explain CAP in one minute to a product manager.</summary>

When the network breaks between parts of our system, we choose: either **stop some users from writing** so data stays correct (consistent), or **keep everyone writing** and fix conflicts later (available). We cannot pretend the network never breaks, so this choice is real. Most products need a mix: money path consistent, recommendation feed can lag.

---

</details>

<details class="qa-item">
<summary>2. How is PACELC different from CAP?</summary>

CAP only talks about network partition. PACELC adds: **even when the network is fine**, strong consistency usually costs extra latency (more round-trips). So daily we trade **L vs C**; during partition we trade **A vs C**. Cassandra is PA/EL; etcd is PC/EC.

---

</details>

<details class="qa-item">
<summary>3. Your DB is "strongly consistent." Your system is not. Why?</summary>

Strong consistency inside PostgreSQL does not span microservices. Service A commits; service B fails — no global transaction unless we designed saga/outbox/2PC. Also read replicas break strong reads if apps use them. Consistency is **end-to-end**, not a property of one component.

---

</details>

<details class="qa-item">
<summary>4. Network partition happens. You have 5-node etcd. 2 nodes isolated. What happens?</summary>

Majority is 3 nodes. The side with 3 nodes continues (leader on that side if needed). The 2-node minority **cannot commit new writes** or elect a valid leader for cluster state. Clients talking to minority get errors/timeouts — **CP behavior**. Ops should route control plane traffic to majority side.

---

</details>

<details class="qa-item">
<summary>5. What is split brain and how do you prevent it?</summary>

Two nodes both act as primary and accept conflicting writes. Prevent with **majority quorum** for leadership, **fencing tokens** so old primary cannot write, **epoch numbers**, and **STONITH**. After detection, stop loser immediately and reconcile from winner.

---

</details>

<details class="qa-item">
<summary>6. When is eventual consistency acceptable for a bank balance?</summary>

Display balance on dashboard — often eventual with short staleness OK with disclaimer. **Debit authorization** — not eventual; must be linearizable or transactional on authoritative ledger. Many banks show eventual cached balance but authorize against primary with row lock.

---

</details>

<details class="qa-item">
<summary>7. Compare quorum read (R+W>N) vs reading the leader.</summary>

Both can give strong reads if implemented correctly. Leader read is simpler mental model; one RTT to leader. Quorum read consults R replicas without single leader bottleneck but needs version reconciliation. Raft leader read is common; Cassandra uses quorum math per operation.

---

</details>

<details class="qa-item">
<summary>8. Why can't we use wall clock for event ordering across services?</summary>

Clocks skew and jump. Service A's `10:00:01` may be before B's `10:00:00` in real time. Use **logical sequences** (Kafka offset), **Lamport/vector clocks** for causality, or **central allocator** (DB sequence). LWW with wall clock fails silently.

---

</details>

<details class="qa-item">
<summary>9. Explain Raft leader election at a whiteboard.</summary>

Followers timeout randomly; candidate requests votes; need majority for term N+1; winner sends heartbeats; log entries replicate with majority commit before apply. Higher term supersedes lower; split vote retries with random backoff. Safety from overlapping majorities carrying committed entries.

---

</details>

<details class="qa-item">
<summary>10. Kafka is AP or CP?</summary>

Nuanced. Kafka prioritizes **availability and partition tolerance** with **strong ordering per partition**. If `min.insync.replicas` not met, producer can fail (CP-like for those writes). Under unclean leader election (disabled in prod), availability vs consistency trade-off explicit. Not a CAP label replacement — describe ISR and acks.

---

</details>

<details class="qa-item">
<summary>11. You see duplicate API writes after deploy. Root cause?</summary>

Classic: client timeout < server success; client retries POST without idempotency key. Server processed twice. Fix: `Idempotency-Key` header stored in DB with unique constraint; return same response for replay; use outbox for side effects.

---

</details>

<details class="qa-item">
<summary>12. Cassandra `LOCAL_QUORUM` vs `QUORUM` in multi-DC deployment.</summary>

`QUORUM` is global majority — cross-DC latency every op. `LOCAL_QUORUM` is majority within local DC — faster; better survives inter-DC partition but **async replication** between DCs means global eventual across DCs. Pick per use case; financial single-DC strong often uses LOCAL_QUORUM in primary DC only.

---

</details>

<details class="qa-item">
<summary>13. How does Spanner get "global strong consistency"?</summary>

Paxos replication per shard plus **TrueTime** — GPS/atomic clocks give bounded clock uncertainty; **commit wait** until uncertainty passes before commit visible. Pays latency (especially cross-region). Not magic — infrastructure + EC trade-off daily.

---

</details>

<details class="qa-item">
<summary>14. Design leader election for 12 worker pods processing a shard.</summary>

Options: Kubernetes **Lease** object (controller-runtime); **Curator** on ZooKeeper; **Redis Redlock** only if understood limitations; best at scale: **assign shard to Kafka partition** — partition has single consumer in group. Include fencing token in downstream writes; TTL > max processing time.

---

</details>

<details class="qa-item">
<summary>15. Partition heals after both sides accepted writes. Now what?</summary>

Depends on model. **LWW** picks timestamps (risky). **CRDT** merges automatically. **Manual merge** for business conflicts. **Winner DC** discards loser (ops decision). Run **anti-entropy repair**, audit logs, customer notifications. Prevention beats cure — majority write during partition.

---

</details>

<details class="qa-item">
<summary>16. What is the FLP impossibility result and does it matter?</summary>

Fischer-Lynch-Paterson: no deterministic consensus in fully asynchronous model with one crash. Matters because pure async protocols cannot guarantee both safety and liveness — real systems use **timeouts** (partial synchrony), **Randomized algorithms**, or **leader-based Raft** with failure detectors. Explains why election timers exist.

---

</details>

<details class="qa-item">
<summary>17. `READ COMMITTED` on primary vs read replica for reporting.</summary>

Primary READ COMMITTED sees latest committed on primary. Replica may lag seconds — reports wrong totals. Strong reporting: read primary, snapshot export, or CQRS projection with version. Eventual reporting: label "as of T-5min."

---

</details>

<details class="qa-item">
<summary>18. How do vector clocks detect conflicts?</summary>

Each replica maintains counter vector. On write, increment own counter. Compare vectors: if one dominates other, causally ordered; if neither dominates — **concurrent conflict** — application merge required. Used in Dynamo descendants, Riak, some CRDT metadata.

---

</details>

<details class="qa-item">
<summary>19. Ops wants 2-node database cluster to save cost. Your response?</summary>

2-node voter/quorum cannot tolerate any failure without split risk. Minimum production HA: **3 nodes** or 2 data + **witness** in third AZ. Even number clusters need tie-breaker. Cost saved becomes outage cost.

---

</details>

<details class="qa-item">
<summary>20. Explain hinted handoff to a junior engineer.</summary>

Replica down temporarily; coordinator stores write "hint" elsewhere; when replica returns, hint forwarded. Improves **availability** during failure. Part of sloppy quorum family. Must run repair — hints are not permanent storage.

---

</details>

<details class="qa-item">
<summary>21. Microservice A calls B calls C — all succeed locally. Global failure?</summary>

Partial failure: A succeeds, B succeeds, C fails — B may rollback local TX but A already committed → inconsistent. Need **saga** (compensating transactions), **outbox events**, or **orchestration** with idempotent steps. Distributed "strong consistency" needs coordinated commit design.

---

</details>

<details class="qa-item">
<summary>22. Why monotonic reads matter for UX.</summary>

User refreshes page and sees **older** data than previous page — confusing, looks like data loss. Monotonic reads guarantee session never goes backward in time. Implement with session stickiness, version tokens, or always read same replica for session.

---

</details>

<details class="qa-item">
<summary>23. Compare 2PC and Saga for order payment.</summary>

**2PC:** prepare/commit across DBs — blocks on coordinator failure; holds locks; fragile cross heterogeneous stores. **Saga:** local TX + publish event + compensating steps (cancel reservation, refund). Saga is **eventually consistent** globally but **available**; preferred in microservices with clear compensations.

---

</details>

<details class="qa-item">
<summary>24. etcd lease keeps expiring on one node. Impact?</summary>

If that node is leader (K8s, Patroni), flapping leadership → API slowness, DB failover storms. Diagnose: disk IO, CPU starvation (GC), network to etcd. Increase lease cautiously; fix root cause — longer lease only masks pauses.

---

</details>

<details class="qa-item">
<summary>25. "We use Redis for strong consistency."</summary>

Single Redis primary gives strong per-key ops on primary. Redis Cluster adds partition behavior; **async replication** by default — not linearizable across failover without Redlock/controversy and **wait** command (`WAIT` replicas). Clarify: strong for single key on primary with fsync and sync repl, not global ACID transaction across keys without careful design.

---

</details>

<details class="qa-item">
<summary>26. How does PostgreSQL synchronous replication affect PACELC?</summary>

Normal operation: each commit waits for standby ACK — **EC**, higher commit latency especially cross-AZ. On standby failure: policy `synchronous_commit=remote_write` vs `on` trades durability vs availability. Partition: primary may block commits if cannot reach sync standbys — **PC** tendency.

---

</details>

<details class="qa-item">
<summary>27. Customer asks "zero data loss" during AZ failure. Architecture?</summary>

Sync replication to second AZ (Postgres sync standby, Kafka `acks=all` + `min.insync.replicas=2`), consensus metadata (3 AZ etcd), **no write ack until durable quorum**, automated failover with fencing, regular DR drills. Accept cross-AZ latency on write path. Cannot have zero loss + single AZ + low latency + partition survival — state trade-offs explicitly.

---

</details>

<details class="qa-item">
<summary>28. Detecting silent split brain in object storage.</summary>

Compare **generation numbers** on writes; old primary writes rejected after new epoch. Monitor dual write metrics; checksum bucket object lists from both sides; alert if two active endpoints accept PUT for same key namespace.

---

</details>

<details class="qa-item">
<summary>29. Causal consistency example in chat app.</summary>

Message B replies to A — all users must see A before B. Unrelated messages C and D may appear in different order on different clients. Implement with parent message ID vector or sequence chain; not full linearizability needed — saves latency vs strong global order.

---

</details>

<details class="qa-item">
<summary>30. Interview: "Is CP or AP better?"</summary>

Wrong question. **Better for what SLA?** Payments CP on ledger; product catalog AP with merge. Good architects **decompose** system by bounded context and assign PACELC per path. Measure stale read rate and p99 latency; let product own the trade-off.

---

</details>

<details class="qa-item">
<summary>31. Thundering herd after cache expiry during partition recovery.</summary>

Many clients miss cache; hit DB simultaneously; DB saturated; timeouts; retries amplify. Mitigate: **singleflight** lock per key, stale-while-revalidate, jittered TTL, circuit breaker to DB, read replicas with rate limit.

---

</details>

<details class="qa-item">
<summary>32. Why odd number of nodes in consensus clusters?</summary>

Majority of N is floor(N/2)+1. Odd N avoids tied votes (4 nodes → need 3, tolerates 1 failure same as 3 nodes but more cost). 5 nodes tolerate 2 failures; 3 tolerate 1. Even clusters waste capacity or need arbiter.

---

</details>

<details class="qa-item">
<summary>33. Linearizability vs serializability (database).</summary>

**Linearizability:** real-time order of individual ops on register/object. **Serializability:** transaction isolation — equivalent to some serial order of transactions. Serializable DB does not automatically linearize across **different** DB shards without distributed protocol. Related but not identical — senior distinction matters in interviews.

---

</details>

<details class="qa-item">
<summary>34. You added a read replica. Latency improved. Bugs increased. Why?</summary>

Apps now read stale state; read-your-writes violated; reporting off; cache invalidation races with replica lag. Fix: route session reads to primary or lag-aware routing; use replica only for explicit eventual queries.

---

</details>

<details class="qa-item">
<summary>35. Design idempotency for payment webhook retries.</summary>

Store webhook `event_id` with unique index; process in TX; on duplicate return 200 with original outcome. Use deterministic idempotency key from provider. TTL cleanup for old keys. Never rely solely on "we check status first" — race between duplicate deliveries.

---

</details>

<details class="qa-item">
<summary>36. What is a fencing token and where have you used one?</summary>

Monotonically increasing token issued with leadership (from ZooKeeper zxid, etcd revision, or dedicated table). Downstream storage rejects writes with token lower than last seen — prevents zombie leader after partition from corrupting state. Use when stale primary can still reach shared storage (shared SAN, object store without epoch check).

---

</details>

<details class="qa-item">
<summary>37. Explain `min.insync.replicas` in Kafka in CAP terms.</summary>

Producer with `acks=all` waits for all in-sync replicas. If ISR shrinks below `min.insync.replicas`, broker rejects produce — **choosing consistency over availability** for those writes. Lowering min ISR or using `acks=1` increases availability during failure at risk of lost messages on unclean leader election (if misconfigured).

---

</details>

<details class="qa-item">
<summary>38. Can you have strong consistency without consensus?</summary>

Yes on **single leader** with synchronous replication to followers that reject reads until caught up — consensus not always separate product (Raft embeds both). Single-node RDBMS is strongly consistent without distributed consensus. Multi-leader without coordination — cannot be linearizable.

---

</details>

<details class="qa-item">
<summary>39. What happens to open transactions during DB failover?</summary>

Connections drop; in-flight TX abort on old primary; clients must retry idempotently. New primary may not have last committed TX if async replication — **RPO** determines data loss window. Sync rep reduces loss; lengthens commit. Apps must handle `SerializationFailure`, duplicate key on retry.

---

</details>

<details class="qa-item">
<summary>40. How does Dynamo's consistent hashing relate to partitions?</summary>

Consistent hashing maps keys to ring positions; nodes own ranges. On node add/remove, only adjacent ranges move — minimizes data motion. **Network partition** is unrelated to hash ring — partition is connectivity failure; ring is load/sharding. During partition, quorum rules decide which side of ring accepts writes for a key's replicas.

---

</details>

<details class="qa-item">
<summary>41. Why is "at-least-once delivery" the default in messaging?</summary>

Achieving exactly-once end-to-end requires idempotent consumers + dedupe or transactional outbox/inbox — broker ack after process can duplicate on consumer crash after process before ack. Kafka offers idempotent producer and EOS within stream processing, but cross-service exactly-once still needs application design.

---

</details>

<details class="qa-item">
<summary>42. Compare bully algorithm vs Raft for leader election.</summary>

Bully: highest-ID node wins; O(n²) messages; simple but not fault-tolerant under partition without quorum. Raft: majority vote + term numbers; proven safety. Production uses Raft/Zab/ephemeral ZK nodes, not raw bully.

---

</details>

<details class="qa-item">
<summary>43. What is read repair vs anti-entropy?</summary>

**Read repair:** fix inconsistencies when read detects mismatch (lazy, on hot paths). **Anti-entropy:** background full/incremental comparison (Merkle tree) even without reads. Both needed in AP stores; read repair alone misses cold data.

---

</details>

<details class="qa-item">
<summary>44. Session guarantees bundle — what to ask vendors.</summary>

Ask: linearizable? read-your-writes? monotonic reads? monotonic writes? consistent prefix? Causal? Default CL? Behavior on partition? Failover RPO/RTO? "Strong" marketing without these answers is useless.

---

</details>

<details class="qa-item">
<summary>45. Incident: "Network fixed but data still wrong."</summary>

Partition healed but divergent writes not merged. Run repair jobs; compare vector clocks/versions; execute business merge. Prevention: majority writes during partition; don't "fail open" both sides for same key without CRDT. Teach on-call: healing network ≠ healing data.

</details>

<details class="qa-item">
<summary>46. Walk through a fencing token failure after GC pause.</summary>

Leader L gets token 42, enters 8s GC pause. Lease expires; follower F gets token 43 and writes. L resumes and writes with 42. Without storage-side fencing, L corrupts F's data. With fencing, storage rejects 42 < 43. Fix: monotonic token on every write; STONITH or lease re-validation before any mutation after pause.

---

</details>

<details class="qa-item">
<summary>47. How do you size idempotency key TTL?</summary>

TTL must exceed the maximum retry/redelivery window: sum of client backoff, broker retention, consumer `session.timeout` + `max.poll.interval`, and any DLQ replay horizon. Money paths: often permanent (unique constraint on event_id). Analytics: 24–48h may suffice. Undersized TTL causes duplicate side effects that look like "random" bugs.

---

</details>

<details class="qa-item">
<summary>48. G-Counter vs PN-Counter — when to use which?</summary>

G-Counter only increments — good for view counts, likes, metrics. PN-Counter (two G-Counters: increments and decrements) supports add/remove — shopping cart quantity, inventory reservations. Neither replaces a strongly consistent ledger for money; both merge concurrently without coordination.

---

</details>

<details class="qa-item">
<summary>49. State Little's Law and apply it to a growing connection pool queue.</summary>

L = λ × W. If arrival rate λ is stable but queue depth L grows, average time in system W increased — something slowed (DB, GC, dependency). Adding app pods raises λ to the shared bottleneck. Fix the slow resource or shed load; don't scale consumers into an exhausted DB pool.

---

</details>

<details class="qa-item">
<summary>50. Why does fan-out inflate tail latency?</summary>

Parallel call to N services: user-visible p99 approaches the worst of N legs. Ten services at p99=200ms each → ~10% of requests hit at least one slow leg. Reduce fan-out (BFF, caching), set per-dependency timeouts, use bulkheads, and avoid sequential chains of many hops.

---

</details>

<details class="qa-item">
<summary>51. OR-Set vs LWW-Register for a shared document title.</summary>

LWW-Register picks one winner by timestamp — simple but loses concurrent edits silently under skew. OR-Set tracks add/remove with unique tags — correct add/remove semantics under concurrency but not ideal for a single scalar title. For collaborative text, use a text CRDT (Yjs, Automerge); for a single field, version/CAS with explicit conflict error may be better than blind LWW.

---

</details>

<details class="qa-item">
<summary>52. What is effectively-once processing?</summary>

Duplicates may be delivered (at-least-once), but side effects occur once — achieved by idempotency keys, dedup store, or natural unique constraints. Kafka EOS + transactional producer helps within a stream; cross-service still needs application dedup. Not magic exactly-once end-to-end.

---

</details>

<details class="qa-item">
<summary>53. Raft joint consensus — why can't I remove two etcd nodes at once?</summary>

Removing voters changes the majority definition. Naive removal can create two disjoint majorities that both commit conflicting entries. Raft uses joint configuration: transition requires old+new majority, then switches to new-only. Ops: one membership change at a time; verify quorum between steps.

---

</details>

<details class="qa-item">
<summary>54. Consumer lag growing but CPU low — what is wrong?</summary>

Downstream bottleneck (DB, external API), not consumer CPU. Little's Law: lag is L growing because W (processing time) increased. Check pool pending, slow queries, gray failures. Pausing consumption or backpressuring producers beats blindly adding consumer pods that hammer the same DB.

---

</details>

<details class="qa-item">
<summary>55. Failure catalog: network partition — first three actions?</summary>

1) Identify which side has quorum (etcd/DB role, voter count). 2) Route traffic to majority side; fail closed on minority for CP data. 3) Alert on dual-primary indicators — do not wait for user tickets. After heal: reconcile divergent writes; network fix ≠ data fix.

---

</details>

<details class="qa-item">
<summary>56. Compare Redlock vs etcd lease for distributed locking.</summary>

**Redlock** (Redis): multiple independent Redis nodes, quorum to acquire. Fast, but no fencing token by default; GC pause + clock drift can produce dual holders (Kleppmann critique). **etcd lease:** linearizable create-with-lease; `mod_revision` is a fencing token; minority partition cannot renew. Use etcd/ZK for locks guarding shared storage; Redlock only for coarse coordination where duplicate work is harmless.

---

</details>

<details class="qa-item">
<summary>57. What is phi accrual failure detection and when does it beat fixed timeout?</summary>

Phi accrual tracks arrival intervals of heartbeats and computes suspicion level φ — how unlikely the current gap is given history. **Beats fixed timeout** when latency is variable (WAN, container throttling): adapts to normal jitter instead of one global threshold. **Fails** when history is too short (cold start) or heartbeats are irregular by design. Cassandra, Akka Cluster, and Consul use variants; tune `phi_convict_threshold` against GC pause p99.9, not p50.

---

</details>

<details class="qa-item">
<summary>58. Design read-your-writes for multi-region Postgres.</summary>

Writes go to primary region only. Return commit LSN (or HMAC-wrapped token) in API response. Reads echo token; router sends to a replica with `replay_lsn ≥ token`, or primary if none within 50 ms. For DR: tokens are cluster-scoped — invalidate on failover to new cluster. Multi-region without sync rep: accept eventual for cross-region reads; enforce RYW only within the write region via token routing.

---

</details>

<details class="qa-item">
<summary>59. What happens when Kafka consumer commits offset before processing completes?</summary>

**At-most-once:** message processed 0 or 1 times; crash after commit loses the message forever. Opposite of auto-commit-after-process (at-least-once). Use only when loss is acceptable (metrics, sampling). For money/orders: process → dedup insert in TX → commit offset manually after TX commits. Never `enable.auto.commit=true` on critical consumers without idempotent handlers.

---

</details>

<details class="qa-item">
<summary>60. Explain hinted handoff failure during partition heal.</summary>

Node C down; coordinators store write hints on D/E. C returns; hints replay to C. **Failure modes:** (1) hints expired before C returned — data never arrives unless repair runs; (2) C's disk was wiped and rejoined empty — hints apply to wrong baseline; (3) concurrent writes during replay create conflicts. Mitigation: monitor `TotalHints`; cap max hint window; run `nodetool repair` after extended outage; use `QUORUM` writes so hints are a performance optimization, not the durability path.

---

</details>

<details class="qa-item">
<summary>61. When would you choose OR-Set over LWW-Register?</summary>

**OR-Set** when adds and removes are both meaningful and concurrent add+remove must resolve correctly (shopping cart lines, collaborative tags). **LWW-Register** when there is a single scalar value and "latest timestamp wins" is acceptable (feature flag, config blob) — but only with **server-side or HLC timestamps**, never client wall clock. LWW silently drops concurrent writes; OR-Set preserves adds that happened on both sides.

---

</details>

<details class="qa-item">
<summary>62. How does backpressure differ from rate limiting?</summary>

**Rate limiting** caps λ (arrival rate) at a fixed threshold regardless of downstream speed — proactive, often per-client. **Backpressure** is reactive: downstream signals "I am full" and upstream slows or stops — TCP window, `RejectedExecutionException`, Kafka `pause()`. Rate limit without backpressure still queues unbounded if limit > capacity. Production needs both: rate limit at edge, backpressure at each hop.

---

</details>

<details class="qa-item">
<summary>63. What is the difference between a fencing token and a generation stamp?</summary>

Same concept, different names. **Fencing token:** monotonic integer from lock service (etcd `mod_revision`, ZK `zxid`). **Generation stamp:** GFS/HDFS term for block version; S3 `If-Match` ETag. Both require storage to reject operations with stale generation. The token must be checked **inside the storage transaction**, not in application memory before an unguarded write.

---

</details>

<details class="qa-item">
<summary>64. Incident: etcd quorum lost during AZ failure — recovery steps?</summary>

1) Confirm voter count: `etcdctl endpoint status --cluster` — need majority alive. 2) **Do not** start all nodes simultaneously if data dirs diverged. 3) Restore from snapshot on one member if quorum unrecoverable; re-add members one at a time with `etcdctl member add`. 4) Verify single leader before unblocking Kubernetes API. 5) Post-incident: expand to 5 voters across 3 AZs; never roll 2+ voters at once. Data fix ≠ etcd fix — reconcile app state separately.

---

</details>

<details class="qa-item">
<summary>65. Why is 2PC avoided across heterogeneous microservices?</summary>

2PC requires all participants to block until coordinator decides; coordinator crash leaves **in-doubt transactions** requiring heuristic rollback. Cross-DB 2PC couples availability (any participant down blocks commit), holds locks for network RTT, and lacks a standard timeout story across Postgres + Kafka + HTTP. **Saga + outbox** gives explicit compensations, at-least-once with idempotency, and per-service autonomy. Reserve 2PC for homogeneous clusters (same DB vendor, XA rarely in cloud-native).

---

</details>
