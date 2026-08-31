# Distributed Systems Fundamentals — Senior Production Reference

Microservices, multi-region deployments, and cloud-native stacks. This is not a textbook chapter on theoretical CS. It is the map of what actually breaks in production after shipping distributed backends — when the network is not reliable, clocks lie, and "it worked on my laptop" means nothing.

---

## Table of Contents

1. [1. Mental Model: What Breaks First in Distributed Systems](#1-mental-model-what-breaks-first-in-distributed-systems)
2. [2. CAP Theorem](#2-cap-theorem)
3. [3. PACELC Theorem](#3-pacelc-theorem)
4. [4. Consistency Models — The Full Spectrum](#4-consistency-models--the-full-spectrum)
5. [5. Strong Consistency](#5-strong-consistency)
6. [6. Eventual Consistency](#6-eventual-consistency)
7. [7. Network Partitions](#7-network-partitions)
8. [8. Split Brain](#8-split-brain)
9. [9. Clock Synchronization](#9-clock-synchronization)
10. [10. Distributed Consensus](#10-distributed-consensus)
11. [11. Quorum](#11-quorum)
12. [12. Leader Election](#12-leader-election)
13. [13. Putting It Together: System Profiles](#13-putting-it-together-system-profiles)
14. [14. Production Debugging Playbook](#14-production-debugging-playbook)
15. [15. Quick Decision Matrix](#15-quick-decision-matrix)
16. [16. Scenario Q&A — Interview and Production](#16-scenario-qa--interview-and-production)

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

## 7. Network Partitions

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

## 8. Split Brain

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

## 9. Clock Synchronization

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

## 10. Distributed Consensus

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

**Zab (ZooKeeper):** Primary order broadcast; similar role to Raft for ZK data tree.

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

---

## 11. Quorum

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

---

## 12. Leader Election

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

### Production scenario: duplicate scheduled job execution

**Problem.** Spring `@Scheduled` on 8 pods; no leader election; nightly billing batch runs 8 times; duplicate charges.

**Solution options:

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

---

## 13. Putting It Together: System Profiles

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

## 14. Production Debugging Playbook

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

## 15. Quick Decision Matrix

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

## 16. Scenario Q&A — Interview and Production

### Q1. Explain CAP in one minute to a product manager.

**Answer.** When the network breaks between parts of our system, we choose: either **stop some users from writing** so data stays correct (consistent), or **keep everyone writing** and fix conflicts later (available). We cannot pretend the network never breaks, so this choice is real. Most products need a mix: money path consistent, recommendation feed can lag.

---

### Q2. How is PACELC different from CAP?

**Answer.** CAP only talks about network partition. PACELC adds: **even when the network is fine**, strong consistency usually costs extra latency (more round-trips). So daily we trade **L vs C**; during partition we trade **A vs C**. Cassandra is PA/EL; etcd is PC/EC.

---

### Q3. Your DB is "strongly consistent." Your system is not. Why?

**Answer.** Strong consistency inside PostgreSQL does not span microservices. Service A commits; service B fails — no global transaction unless we designed saga/outbox/2PC. Also read replicas break strong reads if apps use them. Consistency is **end-to-end**, not a property of one component.

---

### Q4. Network partition happens. You have 5-node etcd. 2 nodes isolated. What happens?

**Answer.** Majority is 3 nodes. The side with 3 nodes continues (leader on that side if needed). The 2-node minority **cannot commit new writes** or elect a valid leader for cluster state. Clients talking to minority get errors/timeouts — **CP behavior**. Ops should route control plane traffic to majority side.

---

### Q5. What is split brain and how do you prevent it?

**Answer.** Two nodes both act as primary and accept conflicting writes. Prevent with **majority quorum** for leadership, **fencing tokens** so old primary cannot write, **epoch numbers**, and **STONITH**. After detection, stop loser immediately and reconcile from winner.

---

### Q6. When is eventual consistency acceptable for a bank balance?

**Answer.** Display balance on dashboard — often eventual with short staleness OK with disclaimer. **Debit authorization** — not eventual; must be linearizable or transactional on authoritative ledger. Many banks show eventual cached balance but authorize against primary with row lock.

---

### Q7. Compare quorum read (R+W>N) vs reading the leader.

**Answer.** Both can give strong reads if implemented correctly. Leader read is simpler mental model; one RTT to leader. Quorum read consults R replicas without single leader bottleneck but needs version reconciliation. Raft leader read is common; Cassandra uses quorum math per operation.

---

### Q8. Why can't we use wall clock for event ordering across services?

**Answer.** Clocks skew and jump. Service A's `10:00:01` may be before B's `10:00:00` in real time. Use **logical sequences** (Kafka offset), **Lamport/vector clocks** for causality, or **central allocator** (DB sequence). LWW with wall clock fails silently.

---

### Q9. Explain Raft leader election at a whiteboard.

**Answer.** Followers timeout randomly; candidate requests votes; need majority for term N+1; winner sends heartbeats; log entries replicate with majority commit before apply. Higher term supersedes lower; split vote retries with random backoff. Safety from overlapping majorities carrying committed entries.

---

### Q10. Kafka is AP or CP?

**Answer.** Nuanced. Kafka prioritizes **availability and partition tolerance** with **strong ordering per partition**. If `min.insync.replicas` not met, producer can fail (CP-like for those writes). Under unclean leader election (disabled in prod), availability vs consistency trade-off explicit. Not a CAP label replacement — describe ISR and acks.

---

### Q11. You see duplicate API writes after deploy. Root cause?

**Answer.** Classic: client timeout < server success; client retries POST without idempotency key. Server processed twice. Fix: `Idempotency-Key` header stored in DB with unique constraint; return same response for replay; use outbox for side effects.

---

### Q12. Cassandra `LOCAL_QUORUM` vs `QUORUM` in multi-DC deployment.

**Answer.** `QUORUM` is global majority — cross-DC latency every op. `LOCAL_QUORUM` is majority within local DC — faster; better survives inter-DC partition but **async replication** between DCs means global eventual across DCs. Pick per use case; financial single-DC strong often uses LOCAL_QUORUM in primary DC only.

---

### Q13. How does Spanner get "global strong consistency"?

**Answer.** Paxos replication per shard plus **TrueTime** — GPS/atomic clocks give bounded clock uncertainty; **commit wait** until uncertainty passes before commit visible. Pays latency (especially cross-region). Not magic — infrastructure + EC trade-off daily.

---

### Q14. Design leader election for 12 worker pods processing a shard.

**Answer.** Options: Kubernetes **Lease** object (controller-runtime); **Curator** on ZooKeeper; **Redis Redlock** only if understood limitations; best at scale: **assign shard to Kafka partition** — partition has single consumer in group. Include fencing token in downstream writes; TTL > max processing time.

---

### Q15. Partition heals after both sides accepted writes. Now what?

**Answer.** Depends on model. **LWW** picks timestamps (risky). **CRDT** merges automatically. **Manual merge** for business conflicts. **Winner DC** discards loser (ops decision). Run **anti-entropy repair**, audit logs, customer notifications. Prevention beats cure — majority write during partition.

---

### Q16. What is the FLP impossibility result and does it matter?

**Answer.** Fischer-Lynch-Paterson: no deterministic consensus in fully asynchronous model with one crash. Matters because pure async protocols cannot guarantee both safety and liveness — real systems use **timeouts** (partial synchrony), **Randomized algorithms**, or **leader-based Raft** with failure detectors. Explains why election timers exist.

---

### Q17. `READ COMMITTED` on primary vs read replica for reporting.

**Answer.** Primary READ COMMITTED sees latest committed on primary. Replica may lag seconds — reports wrong totals. Strong reporting: read primary, snapshot export, or CQRS projection with version. Eventual reporting: label "as of T-5min."

---

### Q18. How do vector clocks detect conflicts?

**Answer.** Each replica maintains counter vector. On write, increment own counter. Compare vectors: if one dominates other, causally ordered; if neither dominates — **concurrent conflict** — application merge required. Used in Dynamo descendants, Riak, some CRDT metadata.

---

### Q19. Ops wants 2-node database cluster to save cost. Your response?

**Answer.** 2-node voter/quorum cannot tolerate any failure without split risk. Minimum production HA: **3 nodes** or 2 data + **witness** in third AZ. Even number clusters need tie-breaker. Cost saved becomes outage cost.

---

### Q20. Explain hinted handoff to a junior engineer.

**Answer.** Replica down temporarily; coordinator stores write "hint" elsewhere; when replica returns, hint forwarded. Improves **availability** during failure. Part of sloppy quorum family. Must run repair — hints are not permanent storage.

---

### Q21. Microservice A calls B calls C — all succeed locally. Global failure?

**Answer.** Partial failure: A succeeds, B succeeds, C fails — B may rollback local TX but A already committed → inconsistent. Need **saga** (compensating transactions), **outbox events**, or **orchestration** with idempotent steps. Distributed "strong consistency" needs coordinated commit design.

---

### Q22. Why monotonic reads matter for UX.

**Answer.** User refreshes page and sees **older** data than previous page — confusing, looks like data loss. Monotonic reads guarantee session never goes backward in time. Implement with session stickiness, version tokens, or always read same replica for session.

---

### Q23. Compare 2PC and Saga for order payment.

**Answer.** **2PC:** prepare/commit across DBs — blocks on coordinator failure; holds locks; fragile cross heterogeneous stores. **Saga:** local TX + publish event + compensating steps (cancel reservation, refund). Saga is **eventually consistent** globally but **available**; preferred in microservices with clear compensations.

---

### Q24. etcd lease keeps expiring on one node. Impact?

**Answer.** If that node is leader (K8s, Patroni), flapping leadership → API slowness, DB failover storms. Diagnose: disk IO, CPU starvation (GC), network to etcd. Increase lease cautiously; fix root cause — longer lease only masks pauses.

---

### Q25. "We use Redis for strong consistency."

**Answer.** Single Redis primary gives strong per-key ops on primary. Redis Cluster adds partition behavior; **async replication** by default — not linearizable across failover without Redlock/controversy and **wait** command (`WAIT` replicas). Clarify: strong for single key on primary with fsync and sync repl, not global ACID transaction across keys without careful design.

---

### Q26. How does PostgreSQL synchronous replication affect PACELC?

**Answer.** Normal operation: each commit waits for standby ACK — **EC**, higher commit latency especially cross-AZ. On standby failure: policy `synchronous_commit=remote_write` vs `on` trades durability vs availability. Partition: primary may block commits if cannot reach sync standbys — **PC** tendency.

---

### Q27. Customer asks "zero data loss" during AZ failure. Architecture?

**Answer.** Sync replication to second AZ (Postgres sync standby, Kafka `acks=all` + `min.insync.replicas=2`), consensus metadata (3 AZ etcd), **no write ack until durable quorum**, automated failover with fencing, regular DR drills. Accept cross-AZ latency on write path. Cannot have zero loss + single AZ + low latency + partition survival — state trade-offs explicitly.

---

### Q28. Detecting silent split brain in object storage.

**Answer.** Compare **generation numbers** on writes; old primary writes rejected after new epoch. Monitor dual write metrics; checksum bucket object lists from both sides; alert if two active endpoints accept PUT for same key namespace.

---

### Q29. Causal consistency example in chat app.

**Answer.** Message B replies to A — all users must see A before B. Unrelated messages C and D may appear in different order on different clients. Implement with parent message ID vector or sequence chain; not full linearizability needed — saves latency vs strong global order.

---

### Q30. Interview: "Is CP or AP better?"

**Answer.** Wrong question. **Better for what SLA?** Payments CP on ledger; product catalog AP with merge. Good architects **decompose** system by bounded context and assign PACELC per path. Measure stale read rate and p99 latency; let product own the trade-off.

---

### Q31. Thundering herd after cache expiry during partition recovery.

**Answer.** Many clients miss cache; hit DB simultaneously; DB saturated; timeouts; retries amplify. Mitigate: **singleflight** lock per key, stale-while-revalidate, jittered TTL, circuit breaker to DB, read replicas with rate limit.

---

### Q32. Why odd number of nodes in consensus clusters?

**Answer.** Majority of N is floor(N/2)+1. Odd N avoids tied votes (4 nodes → need 3, tolerates 1 failure same as 3 nodes but more cost). 5 nodes tolerate 2 failures; 3 tolerate 1. Even clusters waste capacity or need arbiter.

---

### Q33. Linearizability vs serializability (database).

**Answer.** **Linearizability:** real-time order of individual ops on register/object. **Serializability:** transaction isolation — equivalent to some serial order of transactions. Serializable DB does not automatically linearize across **different** DB shards without distributed protocol. Related but not identical — senior distinction matters in interviews.

---

### Q34. You added a read replica. Latency improved. Bugs increased. Why?

**Answer.** Apps now read stale state; read-your-writes violated; reporting off; cache invalidation races with replica lag. Fix: route session reads to primary or lag-aware routing; use replica only for explicit eventual queries.

---

### Q35. Design idempotency for payment webhook retries.

**Answer.** Store webhook `event_id` with unique index; process in TX; on duplicate return 200 with original outcome. Use deterministic idempotency key from provider. TTL cleanup for old keys. Never rely solely on "we check status first" — race between duplicate deliveries.

---

### Q36. What is a fencing token and where have you used one?

**Answer.** Monotonically increasing token issued with leadership (from ZooKeeper zxid, etcd revision, or dedicated table). Downstream storage rejects writes with token lower than last seen — prevents zombie leader after partition from corrupting state. Use when stale primary can still reach shared storage (shared SAN, object store without epoch check).

---

### Q37. Explain `min.insync.replicas` in Kafka in CAP terms.

**Answer.** Producer with `acks=all` waits for all in-sync replicas. If ISR shrinks below `min.insync.replicas`, broker rejects produce — **choosing consistency over availability** for those writes. Lowering min ISR or using `acks=1` increases availability during failure at risk of lost messages on unclean leader election (if misconfigured).

---

### Q38. Can you have strong consistency without consensus?

**Answer.** Yes on **single leader** with synchronous replication to followers that reject reads until caught up — consensus not always separate product (Raft embeds both). Single-node RDBMS is strongly consistent without distributed consensus. Multi-leader without coordination — cannot be linearizable.

---

### Q39. What happens to open transactions during DB failover?

**Answer.** Connections drop; in-flight TX abort on old primary; clients must retry idempotently. New primary may not have last committed TX if async replication — **RPO** determines data loss window. Sync rep reduces loss; lengthens commit. Apps must handle `SerializationFailure`, duplicate key on retry.

---

### Q40. How does Dynamo's consistent hashing relate to partitions?

**Answer.** Consistent hashing maps keys to ring positions; nodes own ranges. On node add/remove, only adjacent ranges move — minimizes data motion. **Network partition** is unrelated to hash ring — partition is connectivity failure; ring is load/sharding. During partition, quorum rules decide which side of ring accepts writes for a key's replicas.

---

### Q41. Why is "at-least-once delivery" the default in messaging?

**Answer.** Achieving exactly-once end-to-end requires idempotent consumers + dedupe or transactional outbox/inbox — broker ack after process can duplicate on consumer crash after process before ack. Kafka offers idempotent producer and EOS within stream processing, but cross-service exactly-once still needs application design.

---

### Q42. Compare bully algorithm vs Raft for leader election.

**Answer.** Bully: highest-ID node wins; O(n²) messages; simple but not fault-tolerant under partition without quorum. Raft: majority vote + term numbers; proven safety. Production uses Raft/Zab/ephemeral ZK nodes, not raw bully.

---

### Q43. What is read repair vs anti-entropy?

**Answer.** **Read repair:** fix inconsistencies when read detects mismatch (lazy, on hot paths). **Anti-entropy:** background full/incremental comparison (Merkle tree) even without reads. Both needed in AP stores; read repair alone misses cold data.

---

### Q44. Session guarantees bundle — what to ask vendors.

**Answer.** Ask: linearizable? read-your-writes? monotonic reads? monotonic writes? consistent prefix? Causal? Default CL? Behavior on partition? Failover RPO/RTO? "Strong" marketing without these answers is useless.

---

### Q45. Incident: "Network fixed but data still wrong."

**Answer.** Partition healed but divergent writes not merged. Run repair jobs; compare vector clocks/versions; execute business merge. Prevention: majority writes during partition; don't "fail open" both sides for same key without CRDT. Teach on-call: healing network ≠ healing data.

---

*Distributed systems do not fail because you missed a design pattern. They fail because the network, clocks, and concurrency were treated as someone else's problem. Own the trade-offs explicitly — CAP at partition, PACELC every day — and test the failure modes before production teaches you.*
