# Java Concurrency & Multithreading — Complete Mastery Course

---


## Table of Contents

1. [Part 1: Process vs Thread, Why Concurrency Exists, Concurrency vs Parallelism](#part-1-process-vs-thread-why-concurrency-exists-concurrency-vs-parallelism)
2. [Part 2: Thread Creation & Lifecycle](#part-2-thread-creation-lifecycle)
3. [Part 3: Java Memory Model (JMM) — Visibility, Reordering, Happens-Before](#part-3-java-memory-model-jmm-visibility-reordering-happens-before)
4. [Part 4: `volatile` — What It Actually Guarantees (and Doesn't)](#part-4-volatile-what-it-actually-guarantees-and-doesnt)
5. [Part 5: Race Conditions & Atomicity — Real Production Bug Walkthroughs](#part-5-race-conditions-atomicity-real-production-bug-walkthroughs)
6. [Part 6: `synchronized` — Intrinsic Locks, Monitors, Lock Escalation](#part-6-synchronized-intrinsic-locks-monitors-lock-escalation)
7. [Part 7: `wait()` / `notify()` / `notifyAll()` — Classic Producer-Consumer](#part-7-wait-notify-notifyall-classic-producer-consumer)
8. [Part 8: Deadlock, Livelock, Starvation](#part-8-deadlock-livelock-starvation)
9. [Part 9: Thread-Safety Design — Immutability, Thread Confinement, Stateless Design](#part-9-thread-safety-design-immutability-thread-confinement-stateless-design)
10. [Part 10: `ReentrantLock` vs `synchronized`](#part-10-reentrantlock-vs-synchronized)
11. [Part 11: `ReadWriteLock` and `StampedLock`](#part-11-readwritelock-and-stampedlock)
12. [Part 12: `Condition` Objects](#part-12-condition-objects)
13. [Part 13: Executor Framework — `ExecutorService`, `ThreadPoolExecutor` Internals](#part-13-executor-framework-executorservice-threadpoolexecutor-internals)
14. [Part 14: Thread Pool Sizing for Production](#part-14-thread-pool-sizing-for-production)
15. [Part 15: `Callable`, `Future`, Cancellation & Interruption](#part-15-callable-future-cancellation-interruption)
16. [Part 16: `CompletableFuture` — Composition, Async Pipelines, Exception Handling](#part-16-completablefuture-composition-async-pipelines-exception-handling)
17. [Part 17: `ConcurrentHashMap` Internals](#part-17-concurrenthashmap-internals)
18. [Part 18: `CopyOnWriteArrayList`, `BlockingQueue` Family](#part-18-copyonwritearraylist-blockingqueue-family)
19. [Part 19: Atomic Classes & CAS (Compare-And-Swap)](#part-19-atomic-classes-cas-compare-and-swap)
20. [Part 20: `CountDownLatch`, `CyclicBarrier`, `Semaphore`, `Phaser`](#part-20-countdownlatch-cyclicbarrier-semaphore-phaser)
21. [Part 21: `ThreadLocal` — Use Cases, Memory Leak Pitfalls in Thread Pools](#part-21-threadlocal-use-cases-memory-leak-pitfalls-in-thread-pools)
22. [Part 22: Fork/Join Framework & Parallel Streams](#part-22-forkjoin-framework-parallel-streams)
23. [Part 23: Virtual Threads (Project Loom, Java 21) vs Platform Threads](#part-23-virtual-threads-project-loom-java-21-vs-platform-threads)
24. [Part 24: Production Debugging — Thread Dumps, Deadlock Detection, Monitoring](#part-24-production-debugging-thread-dumps-deadlock-detection-monitoring)

---

## Part 1: Process vs Thread, Why Concurrency Exists, Concurrency vs Parallelism

### What is a Process vs a Thread?

A **process** is an independent running instance of a program — it has its own memory space (heap, stack, code segment), its own file descriptors, and its own OS-level resources. Two processes cannot directly touch each other's memory.

A **thread** is a unit of execution *within* a process. A process can have multiple threads, and all threads inside the same process **share the same heap and code segment**, but each thread gets its own:
- Program counter (what instruction it's on)
- Stack (local variables, method call frames)
- Register set

This shared-heap property is exactly why concurrency is hard — and exactly why it's powerful.

### Why does concurrency exist?

Two separate motivations, often confused:

1. **Throughput / hardware utilization** — modern CPUs have multiple cores. A single-threaded program can only ever use one core. To use the other 7, 15, 31 cores, you need multiple threads.
2. **Responsiveness / not blocking** — even on a single core, you don't want one slow I/O call (disk, network, DB) to freeze everything else. While one thread waits on I/O, another can do useful work.

### Concurrency vs Parallelism — the distinction senior interviewers actually probe

- **Concurrency**: dealing with multiple tasks *making progress* over the same time period. Doesn't require multiple cores — a single core can interleave tasks (context switching) and still be "concurrent."
- **Parallelism**: multiple tasks executing *literally at the same instant*, which requires multiple cores.

Analogy: one chef switching between four dishes on one stove = concurrency. Four chefs on four stoves = parallelism. A JVM on a single-core machine can still have 20 threads (concurrency) but zero true parallelism.

### How it works under the hood

The JVM maps Java threads to native OS threads (on modern JVMs, 1:1 mapping — one Java `Thread` = one OS thread), until virtual threads in Java 21 change this (see Part 23). The OS scheduler decides which thread runs on which core and for how long, using time-slicing and priority. Java code has **no control** over exact scheduling.

### Step-by-step example

```java
public class Demo {
    public static void main(String[] args) {
        Runnable task = () -> {
            for (int i = 0; i < 3; i++) {
                System.out.println(Thread.currentThread().getName() + " - " + i);
            }
        };
        Thread t1 = new Thread(task, "Worker-1");
        Thread t2 = new Thread(task, "Worker-2");
        t1.start();
        t2.start();
    }
}
```

Execution trace:
1. `main` thread starts, creates two `Thread` objects (not yet running — just objects).
2. `t1.start()` asks the OS to spin up a real OS thread and begin executing `task.run()` on it. This is asynchronous — `main` doesn't wait.
3. `t2.start()` — same thing, second OS thread.
4. Three threads now exist: `main`, `Worker-1`, `Worker-2`, all runnable simultaneously.
5. The OS scheduler interleaves or parallelizes their execution. Output order between `Worker-1` and `Worker-2` lines is **non-deterministic**.

### Common misconception

"Calling `start()` runs the thread immediately and I can predict thread interleaving order." Wrong — `start()` just makes the thread eligible to run; the scheduler decides when. Also, calling `run()` directly executes the code **on the calling thread** — no new thread is created at all.

### Common developer mistake

Assuming more threads = more speed unconditionally. On a 4-core machine, running 50 CPU-bound threads doesn't make things 50x faster — it adds context-switching overhead and can make things *slower* than 4 well-managed threads.

### Senior-level perspective

Interviewers use "concurrency vs parallelism" as a filter question. A senior also knows: correctness bugs in concurrent code (race conditions, visibility issues) exist **even on a single core**, because concurrency — not parallelism — is what introduces interleaving.

### Real production scenario

A payment service had a background thread pool processing webhook callbacks. On staging (2-core VM) it worked fine. In production (16-core VM), the same code started throwing intermittent `ConcurrentModificationException` on a shared `ArrayList` being read/written by different threads. The bug existed on staging too — it just never got triggered because fewer cores rarely produced the exact interleaving needed to expose the race. Lesson: **concurrency bugs are timing-dependent, not core-count-dependent**.

## Part 2: Thread Creation & Lifecycle

### What is it?

Java gives multiple ways to create a thread, and every thread moves through a well-defined set of states during its life.

### Why does Java provide multiple creation mechanisms?

Extending `Thread` burns your one `extends` slot (no multiple inheritance in Java); `Runnable` decouples "what to run" from "the thread mechanism," which is more flexible — a `Runnable` can be handed to a thread pool instead of a raw `Thread`. `Callable` adds a return value and checked exceptions.

### How it works

**Creation methods:**
```java
// 1. Extend Thread (rarely used in production)
class MyThread extends Thread {
    public void run() { System.out.println("running"); }
}

// 2. Implement Runnable (preferred)
Runnable r = () -> System.out.println("running");
new Thread(r).start();

// 3. Callable (returns a value, can throw checked exceptions)
Callable<Integer> c = () -> { return 42; };
```

**Thread lifecycle — the state machine (`Thread.State`):**
```
NEW → RUNNABLE → (BLOCKED / WAITING / TIMED_WAITING) → TERMINATED
```
- **NEW**: `Thread` object created, `start()` not yet called.
- **RUNNABLE**: eligible to run — includes both actually running and ready-and-waiting for the scheduler.
- **BLOCKED**: waiting to acquire a `synchronized` lock held by another thread.
- **WAITING**: waiting indefinitely — `Object.wait()` with no timeout, `Thread.join()` with no timeout, `LockSupport.park()`.
- **TIMED_WAITING**: same as `WAITING` but with a timeout — `Thread.sleep(ms)`, `wait(ms)`, `join(ms)`.
- **TERMINATED**: `run()` completed. Cannot be restarted.

### Step-by-step example

```java
Thread t = new Thread(() -> {
    try { Thread.sleep(1000); } catch (InterruptedException e) {}
});

System.out.println(t.getState()); // NEW
t.start();
System.out.println(t.getState()); // RUNNABLE (likely)
Thread.sleep(100);
System.out.println(t.getState()); // TIMED_WAITING
t.join();
System.out.println(t.getState()); // TERMINATED
```

### Common misconception

"`RUNNABLE` means the thread is currently executing on a CPU core." False — `RUNNABLE` just means it's *eligible*. Most `RUNNABLE` threads are sitting in the OS run-queue.

### Common developer mistake

Calling `run()` instead of `start()`. Also common: restarting a terminated thread, which throws `IllegalThreadStateException` — need a thread pool for repeated task execution, not a raw `Thread`.

### Senior-level perspective

Seniors rarely create raw `Thread` objects directly — they submit tasks to an `ExecutorService`. But understanding thread state is essential for thread-dump analysis during incidents.

### Real production scenario

An order-processing service had response times randomly spike to 30+ seconds. A thread dump showed dozens of threads `BLOCKED` on the same lock, held by a thread in `TIMED_WAITING` — sleeping inside a `synchronized` block due to a poorly placed `Thread.sleep()` meant for rate-limiting. Fix: never sleep while holding a lock.

### Common developer mistake (bonus — thread naming)

Not naming threads (`new Thread(task, "payment-webhook-worker")`) makes thread dumps show meaningless `Thread-47` names during incidents.

## Part 3: Java Memory Model (JMM) — Visibility, Reordering, Happens-Before

### What is it?

The JMM defines when a write by one thread is guaranteed visible to a read by another thread, and what reorderings the JVM/compiler/CPU may legally perform.

### Why does the JMM exist?

Without it, correctness would depend on the specific CPU/compiler you happened to run on. The JMM is a contract: follow its rules and behavior is consistent across all JVM implementations and hardware.

### How it works

Two problems: **visibility** (writes may sit in a CPU cache and never reach main memory / another core's view) and **reordering** (compiler/JIT/CPU may reorder instructions that don't affect single-threaded correctness, but can produce impossible-looking results across threads).

```java
int a = 0;
boolean flag = false;
// Thread 1
a = 42;
flag = true;
// Thread 2
if (flag) {
    System.out.println(a); // could print 0!
}
```

**Happens-before** rules:
- **Program order rule**: within one thread, each action happens-before every subsequent action in that thread.
- **Monitor lock rule**: an unlock happens-before every subsequent lock on that *same* monitor.
- **Volatile variable rule**: a write to a `volatile` field happens-before every subsequent read of that field.
- **Thread start rule**: `Thread.start()` happens-before any action in the started thread.
- **Thread termination rule**: any action in a thread happens-before another thread's successful return from `join()` on it.
- **Transitivity**: A happens-before B, B happens-before C ⟹ A happens-before C.

### Step-by-step example

```java
volatile boolean flag = false;
int a = 0;
// Thread 1
a = 42;
flag = true;
// Thread 2
if (flag) {
    System.out.println(a); // guaranteed 42
}
```
By the volatile rule + transitivity, Thread 2 is guaranteed to see `a == 42` if it sees `flag == true`.

### Common misconception

"Reads/writes of primitives are atomic, so I don't need synchronization for simple flags." Atomicity and visibility are different problems — an atomic write can still be invisible to another thread indefinitely.

### Common developer mistake

"It worked when I tested it" for unsynchronized shared state. JMM violations are non-deterministic — depend on JIT level, CPU, cache state, load.

### Senior-level perspective

`synchronized`/`volatile` do two jobs at once: mutual exclusion AND happens-before visibility. `volatile` is sometimes used purely for visibility on an uncontended field.

### Real production scenario

A `boolean running = true;` controlling a polling loop, set to `false` by a shutdown hook from another thread, never had `volatile`. Under JIT-optimized hot-loop conditions, the read got hoisted out of the loop and the thread never noticed the shutdown, leaking a thread on every deploy. Fix: mark the field `volatile`.

## Part 4: `volatile` — What It Actually Guarantees (and Doesn't)

### What is it?

`volatile` gives **visibility** (every read sees the most recent write) and restricts certain **reordering**. It does NOT give atomicity for compound operations or mutual exclusion.

### Why does it exist?

`synchronized` gives visibility + atomicity + mutual exclusion but is heavyweight. Sometimes you only need visibility — `volatile` gives that cheaply via memory barriers instead of locking.

### How it works

A `volatile` write inserts a **store barrier** (forces immediate flush to main memory, prevents earlier writes reordering past it). A `volatile` read inserts a **load barrier** (forces a fresh read, prevents later reads reordering before it).

```java
private volatile int count = 0;
public void increment() {
    count++; // NOT thread-safe despite volatile
}
```
`count++` = read, add, write — three steps. Two threads can both read 5, both compute 6, both write 6 — an increment is lost.

### Step-by-step example — correct use case

```java
public class OrderProcessor {
    private volatile boolean shutdownRequested = false;
    public void processLoop() {
        while (!shutdownRequested) { processNextOrder(); }
        cleanup();
    }
    public void shutdown() { shutdownRequested = true; }
}
```
Single-writer, write-once/read-many flag — the textbook correct use of `volatile`.

### Common misconception

"`volatile` is a lightweight substitute for `synchronized` anywhere." Only helps when updates don't depend on current value, or single-writer/multiple-reader.

### Common developer mistake

Using `volatile` on multiple related fields expecting cross-field consistency:
```java
private volatile int minBalance;
private volatile int maxBalance;
// checking minBalance < maxBalance can still race across two separate volatile reads
```
Need a single immutable object bundling both fields, swapped via one volatile reference.

### Senior-level perspective

Checklist: single variable? Write-once-read-many, or single-writer-multi-reader, no compound op? → `volatile`. Multiple fields or compound op? → `AtomicInteger`/`synchronized`/`ReentrantLock`. `volatile` reads/writes aren't free — they bypass caches.

### Real production scenario

A rate limiter used `volatile long requestCount` incremented via `requestCount++`. Under a traffic spike, lost updates let more requests through than the configured limit. Fix: `AtomicLong.incrementAndGet()`.

## Part 5: Race Conditions & Atomicity — Real Production Bug Walkthroughs

### What is it?

A **race condition**: outcome depends on thread interleaving timing. **Atomicity**: an operation executes as one indivisible step, no observable in-between state.

### How it works

The canonical shape is **check-then-act**:
```java
if (!map.containsKey(key)) {   // CHECK
    map.put(key, value);        // ACT
}
```
Another thread can slip in between check and act. Recurs in lazy singleton init, balance checks, cache population, ID generation.

### Step-by-step example — the bug and the fix

```java
class InventoryService {
    private int stock = 10;
    public boolean reserve() {
        if (stock > 0) { stock--; return true; }
        return false;
    }
}
```
Two threads can both pass the check when stock==1, both decrement — stock goes negative, double-sold inventory.

**Fixed:**
```java
public synchronized boolean reserve() {
    if (stock > 0) { stock--; return true; }
    return false;
}
```

### Common misconception

"If each individual line/call is thread-safe, the whole method is." Composing atomic operations does not produce an atomic composite.

### Senior-level perspective

Scan for the check-then-act *shape*, not just shared mutable state. Any "read, decide, act" sequence on shared state is a red flag.

### Real production scenario

A coupon-redemption service using `ConcurrentHashMap` with `get()`-check-`put()` logic allowed 140+ redemptions on a "first 100" coupon, because the get-check-put sequence wasn't atomic even though the map itself was thread-safe. Fix: `merge()`/`compute()`-based atomic update.

## Part 6: `synchronized` — Intrinsic Locks, Monitors, Lock Escalation

### What is it?

Every Java object has an intrinsic monitor lock; `synchronized` uses it for mutual exclusion, providing atomicity + visibility together.

### How it works

```java
public synchronized void increment() { count++; }          // locks 'this'
synchronized (this) { count++; }                             // explicit block
public static synchronized void staticMethod() { ... }        // locks the Class object
```
Monitor acquired on entry, released automatically on exit — **even via exception**. **Reentrant**: a thread already holding the lock can re-acquire it (hold count tracked).

**Lock escalation**: biased locking (deprecated since Java 15) → lightweight/CAS-based spin lock under brief contention → heavyweight OS mutex under sustained contention.

### Step-by-step example

Two threads calling `synchronized increment()` on the same `Counter` instance: one acquires uncontended, the other `BLOCKED` until released — no lost updates.

### Common misconception

"`synchronized` locks the method/fields." False — it locks a specific object's monitor. Two threads on two different instances never block each other.

### Common developer mistake

Locking on a mutable/reassignable field, or on interned `String`s/cached boxed `Integer`s — can cause unrelated code to contend or deadlock via a shared lock object nobody intended to share.

### Senior-level perspective

Default to `synchronized` for simple mutual exclusion; reach for `ReentrantLock` only for capabilities `synchronized` structurally lacks.

### Real production scenario

A cache's lock object was reassigned during a "reload" (`this.lockObject = new Object();`), so some threads locked the old object while others locked the new one — two separate locks protecting one shared map, causing corruption. Fix: `private final` lock object, never reassigned.

## Part 7: `wait()` / `notify()` / `notifyAll()` — Classic Producer-Consumer

### What is it?

`Object` methods for thread **coordination** (not just exclusion) — a thread can release its lock and sleep until told a condition may have changed.

### How it works

Can only be called while holding the object's monitor, or `IllegalMonitorStateException` is thrown.
- `wait()` — releases monitor, enters `WAITING`, parks on wait-set; must re-acquire the monitor before resuming.
- `notify()` — wakes one arbitrary waiter.
- `notifyAll()` — wakes all waiters; they compete for the lock.

**Always use `while`, never `if`:**
```java
synchronized (lock) {
    while (queue.isEmpty()) { lock.wait(); }
}
```
Guards against spurious wakeups and multiple-waiter races.

### Step-by-step example — bounded producer-consumer

```java
class BoundedBuffer {
    private final Queue<Integer> queue = new LinkedList<>();
    private final int capacity;
    private final Object lock = new Object();
    BoundedBuffer(int capacity) { this.capacity = capacity; }
    public void produce(int value) throws InterruptedException {
        synchronized (lock) {
            while (queue.size() == capacity) { lock.wait(); }
            queue.add(value);
            lock.notifyAll();
        }
    }
    public int consume() throws InterruptedException {
        synchronized (lock) {
            while (queue.isEmpty()) { lock.wait(); }
            int value = queue.poll();
            lock.notifyAll();
            return value;
        }
    }
}
```

### Common misconception

"`notify()` immediately hands control to a waiter." No — the notifier must exit the `synchronized` block first, and there's no guarantee which waiter wakes or when it actually runs.

### Common developer mistake

Using `notify()` instead of `notifyAll()` when multiple *kinds* of waiters share a lock — can wake the wrong kind, leaving the right kind stuck.

### Senior-level perspective

Rarely hand-written in modern production code (`BlockingQueue`/`Condition` wrap this), but foundational for understanding those and for legacy-code debugging.

### Real production scenario

A job scheduler used `notify()` (not `notifyAll()`) on a shared lock also used by health-check threads. `notify()` occasionally woke the wrong kind of waiter, stalling jobs. Fix: `notify()` → `notifyAll()`.

## Part 8: Deadlock, Livelock, Starvation

### What is it?

- **Deadlock**: threads waiting for each other in a cycle — no progress ever.
- **Livelock**: threads actively running but never making real progress.
- **Starvation**: a thread perpetually denied resources due to unfair prioritization, not a cycle.

### How it works

**Four necessary conditions for deadlock** (all must hold): mutual exclusion, hold-and-wait, no preemption, circular wait. Breaking any one prevents deadlock.

```java
// Thread 1
synchronized (lockA) { synchronized (lockB) { /* ... */ } }
// Thread 2
synchronized (lockB) { synchronized (lockA) { /* ... */ } }
```
Classic circular-wait deadlock.

### Common developer mistake

Acquiring locks in inconsistent order across code paths. Fix: **lock ordering** — always acquire multiple locks in a consistent, globally-agreed order.

### Senior-level perspective

Reduce the *number* of locks needed (immutability, confinement) before trying to perfectly order many locks.

### Real production scenario

A funds-transfer `transfer(from, to, amount)` locked `from` then `to` — opposite-direction concurrent transfers deadlocked reliably. Fix: lock by a consistent order (e.g., lower account ID first).

## Part 9: Thread-Safety Design — Immutability, Thread Confinement, Stateless Design

### What is it?

Designing shared state so races can't occur at all: **immutability** (state never changes), **thread confinement** (state never actually shared), **stateless design** (no shared mutable state).

### How it works

**Immutability:**
```java
final class Money {
    private final long cents;
    private final String currency;
    Money(long cents, String currency) { this.cents = cents; this.currency = currency; }
    Money add(Money other) { return new Money(this.cents + other.cents, this.currency); }
}
```
Immutable objects are inherently thread-safe with zero synchronization.

**Thread confinement**: local variables are stack-confined by default, as long as they never escape. `ThreadLocal` gives explicit per-thread copies (deep dive Part 21).

**Stateless design**: no mutable instance fields at all — nothing to protect.

### Senior-level perspective — preference order

1. Immutable? 2. Thread-confined? 3. Stateless? 4. Existing concurrent primitive? 5. Hand-rolled locking (last resort).

### Real production scenario

A Spring `@Service` bean cached a `SimpleDateFormat` instance field (not thread-safe internally). Concurrent requests parsing dates produced silently wrong dates. Fix: `java.time.DateTimeFormatter` (immutable) or `ThreadLocal`-confined `SimpleDateFormat`.

## Part 10: `ReentrantLock` vs `synchronized`

### What is it?

An explicit, API-based lock offering the same mutual exclusion/reentrancy as `synchronized`, plus interruptible acquisition, timed/non-blocking attempts, fairness, and multiple wait-conditions.

### How it works

```java
private final ReentrantLock lock = new ReentrantLock();
public void increment() {
    lock.lock();
    try { count++; } finally { lock.unlock(); }  // unlock is MANDATORY, no auto-release
}
```
- `tryLock(timeout, unit)` — give up instead of blocking forever.
- `lockInterruptibly()` — can be interrupted out of waiting.
- `new ReentrantLock(true)` — fair (FIFO) ordering, at a throughput cost.

### Step-by-step example — deadlock avoidance via `tryLock`

```java
public void transfer(Account from, Account to, double amount) {
    while (true) {
        if (from.lock.tryLock()) {
            try {
                if (to.lock.tryLock()) {
                    try { from.debit(amount); to.credit(amount); return; }
                    finally { to.lock.unlock(); }
                }
            } finally { from.lock.unlock(); }
        }
        try { Thread.sleep(new Random().nextInt(10)); } catch (InterruptedException e) {}
    }
}
```
Breaks hold-and-wait; random backoff avoids livelock.

### Senior-level perspective

Reach for `ReentrantLock` only when you need a specific capability `synchronized` lacks — not as a reflexive "more powerful" default.

### Real production scenario

A job coordinator used `tryLock(2, SECONDS)` to fail fast with a 503 rather than pile up blocked threads during a partial outage — turning potential full outage into graceful degradation.

## Part 11: `ReadWriteLock` and `StampedLock`

### What is it?

`ReadWriteLock` splits into a shared read lock and exclusive write lock. `StampedLock` adds a non-blocking **optimistic read** mode.

### How it works

```java
private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
private final Lock readLock = rwLock.readLock();
private final Lock writeLock = rwLock.writeLock();
```
Multiple readers concurrently; writer fully exclusive.

`StampedLock` optimistic read:
```java
long stamp = stampedLock.tryOptimisticRead();
double cx = x, cy = y;
if (!stampedLock.validate(stamp)) {
    stamp = stampedLock.readLock();
    try { cx = x; cy = y; } finally { stampedLock.unlockRead(stamp); }
}
```

### Common developer mistake

`StampedLock` is **not reentrant** — a thread re-acquiring its own write lock will self-deadlock.

### Senior-level perspective

`ReadWriteLock` only wins under sustained, heavy read contention with meaningfully-sized critical sections; `StampedLock`'s optimistic mode reserved for genuinely hot paths.

### Real production scenario

A feature-flag service switched from `synchronized` to `ReentrantReadWriteLock` for a read-heavy, rarely-written config cache, eliminating unnecessary read-side serialization.

## Part 12: `Condition` Objects

### What is it?

The `ReentrantLock`-based equivalent of `wait/notify`, but a single `Lock` can have **multiple independent `Condition`s** — multiple wait-sets instead of one.

### How it works

```java
private final Condition notEmpty = lock.newCondition();
private final Condition notFull = lock.newCondition();
// await() / signal() / signalAll() map to wait() / notify() / notifyAll()
```
Still requires `while` loops, still requires holding the lock to call `await()`/`signal()`.

### Senior-level perspective

Use `Condition` specifically when you need more than one distinct wait scenario on the same protected state. Otherwise, prefer `BlockingQueue` (Part 18), which already implements exactly this pattern internally.

### Real production scenario

A connection pool split `connectionAvailable` (signaled on every return) from `allReturned` (signaled only when fully drained, for shutdown) — eliminating wasted wake-and-recheck cycles a single shared wait-set would cause.

## Part 13: Executor Framework — `ExecutorService`, `ThreadPoolExecutor` Internals

### What is it?

Decouples task submission from thread management — a pool of reusable worker threads instead of raw `Thread` creation per task.

### How it works

```java
new ThreadPoolExecutor(corePoolSize, maximumPoolSize, keepAliveTime, unit, workQueue, threadFactory, rejectionHandler);
```

**Scheduling algorithm:**
1. Below `corePoolSize` → always create a new thread.
2. At `corePoolSize` → queue the task (pool does NOT grow yet).
3. Only if the queue is full → grow up to `maximumPoolSize`.
4. Queue full AND pool at max → **reject**.

**Critical fact:** with an unbounded queue, `maximumPoolSize` is effectively meaningless — the pool never grows past core size since the queue never reports "full."

**`Executors` shortcuts and their risks:**
```java
Executors.newFixedThreadPool(n)     // core=max=n, UNBOUNDED queue — memory growth risk
Executors.newCachedThreadPool()      // core=0, max=MAX_VALUE, SynchronousQueue — unbounded thread creation risk
```

**Rejection policies:** `AbortPolicy` (default, throws), `CallerRunsPolicy` (runs on submitter — natural backpressure), `DiscardPolicy`, `DiscardOldestPolicy`.

### Senior-level perspective

Construct `ThreadPoolExecutor` explicitly with a bounded queue and a deliberate rejection policy — treat pool exhaustion as an expected, handled condition.

### Real production scenario

A notification service's `newFixedThreadPool(10)` with an unbounded queue absorbed a 50x traffic spike into an ever-growing queue until `OutOfMemoryError` crashed the service. Fix: explicit bounded `ArrayBlockingQueue` + `CallerRunsPolicy`.

## Part 14: Thread Pool Sizing for Production

### What is it?

How to actually choose pool size numbers, fundamentally different for CPU-bound vs I/O-bound work.

### How it works

**CPU-bound**: `threads ≈ cores (+1)`. More threads than cores just adds context-switch overhead.

**I/O-bound** (Java Concurrency in Practice formula):
```
threads = cores × (1 + wait_time / compute_time)
```
Measure the actual wait/compute ratio from real traffic — don't guess.

**Separate pools per workload type** — mixing CPU-bound and I/O-bound tasks in one pool means neither can be correctly sized, and one can starve the other.

### Real production scenario

A service sized its downstream-API-calling pool using a CPU-bound formula (`cores+1`) when it should have used the I/O-bound formula — thread dumps showed most threads `WAITING` on network I/O while idle cores went unused. Re-sizing to ~60 threads (I/O-bound formula) dramatically improved throughput with the same hardware.

## Part 15: `Callable`, `Future`, Cancellation & Interruption

### What is it?

`Callable<V>` returns a value and can throw checked exceptions. `Future<V>` is the handle to an eventual async result — check status, block for the result, or cancel.

### How it works

```java
Future<Integer> future = executor.submit(task);
Integer result = future.get();                              // blocks
Integer result2 = future.get(500, TimeUnit.MILLISECONDS);     // bounded wait
```

**Cancellation:** `future.cancel(true)` **interrupts** the running thread — it does not forcibly stop it. If the task never checks for interruption, it keeps running regardless.

**Interruption mechanism:** every thread has an interrupt flag. `interrupt()` sets it. If blocked in an interruptible method (`sleep`, `wait`, `Future.get`, `BlockingQueue.take`), that method throws `InterruptedException` immediately and clears the flag. Otherwise, nothing happens automatically until code explicitly checks `isInterrupted()`/`Thread.interrupted()`.

```java
Runnable task = () -> {
    while (!Thread.currentThread().isInterrupted()) { doWork(); }
};
```

### Common misconception

"`interrupt()` forcibly stops a thread." Completely false — it's cooperative only.

### Common developer mistake

Swallowing `InterruptedException` in an empty catch block — always restore the flag if you can't propagate:
```java
catch (InterruptedException e) {
    Thread.currentThread().interrupt();
    return;
}
```

### Real production scenario

A report-generation service's DB-bound reports cancelled promptly, but a CPU-bound, non-interruption-aware report type ignored `cancel(true)` entirely, running to completion regardless. Fix: add explicit `isInterrupted()` checks in the loop.

## Part 16: `CompletableFuture` — Composition, Async Pipelines, Exception Handling

### What is it?

A composable evolution of `Future` — chain, combine, and transform async operations without blocking `get()` calls mid-pipeline.

### How it works

```java
CompletableFuture<String> pipeline = CompletableFuture
    .supplyAsync(() -> fetchUserId())
    .thenApply(userId -> fetchUserProfile(userId))
    .thenApply(profile -> formatProfile(profile));
```
- `thenApply` — transform (sync on completing thread or common pool).
- `thenApplyAsync` — explicitly run on a pool.
- `thenCompose` — for chaining another `CompletableFuture`-returning call (like `flatMap`).
- `thenCombine` — combine two independent futures once both complete.
- `allOf`/`anyOf` — wait for all / any.
- `exceptionally`/`handle`/`whenComplete` — functional exception handling; unhandled exceptions skip subsequent `thenApply` stages entirely until caught.

### Common developer mistake

Calling `.get()` mid-pipeline defeats the purpose — keep composing with `thenApply`/`thenCompose` and block only once, at the outer boundary.

### Real production scenario

An API gateway calling three independent downstream services sequentially (190ms total) was rewritten with parallel `CompletableFuture.supplyAsync()` calls combined via `allOf`, cutting latency to ~80ms (the slowest single call) — a 58% reduction with no backend changes.

## Part 17: `ConcurrentHashMap` Internals

### What is it?

A thread-safe map achieving high concurrency via fine-grained locking (bucket-level in Java 8+) plus CAS, rather than one global lock.

### How it works

**Evolution:** Java 7 segment-locking (16 segments) → Java 8+ per-bucket locking, mostly lock-free reads.

**Atomic compound methods** — the direct fix for check-then-act races:
```java
map.putIfAbsent("a", 2);
map.compute("a", (k, v) -> v == null ? 1 : v + 1);
map.computeIfAbsent("b", k -> expensiveInit());
map.merge("a", 1, Integer::sum);
```

**`size()` is approximate** under concurrent modification. **Iteration is weakly consistent, not fail-fast** — never throws `ConcurrentModificationException`, may or may not reflect concurrent changes.

### Common developer mistake

Using `size()` in capacity-limiting logic reintroduces a check-then-act race — use `Semaphore` or an atomic counter updated within the same `compute()` call instead.

### Real production scenario

A session store's background cleanup thread iterated and removed expired entries via `entrySet()` while request threads concurrently mutated the map — worked correctly with zero external synchronization because of weakly-consistent iteration semantics, letting the team remove unnecessary defensive locking they'd added out of `HashMap`-era caution.

## Part 18: `CopyOnWriteArrayList`, `BlockingQueue` Family

### What is it?

`CopyOnWriteArrayList`: every mutation copies the entire backing array. `BlockingQueue`: queues with blocking `put()`/`take()` for producer-consumer patterns.

### How it works

Iterators over `CopyOnWriteArrayList` see a frozen snapshot, never throw `ConcurrentModificationException`, at the cost of O(n) copy per write. Ideal for read-heavy/write-rare (listener lists).

**`BlockingQueue` implementations:** `ArrayBlockingQueue` (bounded), `LinkedBlockingQueue` (optionally bounded), `PriorityBlockingQueue`, `SynchronousQueue` (zero capacity — direct handoff), `DelayQueue`.

```java
queue.put(item);      // blocks if full
Task t = queue.take(); // blocks if empty
```
`ArrayBlockingQueue` internally uses exactly the `ReentrantLock` + `Condition` pattern from Part 12.

### Common misconception

"`CopyOnWriteArrayList` is a general-purpose thread-safe list." No — write-heavy use is a poor fit; every write is a full copy.

### Real production scenario

An event-processing listener registry (read on every event, written rarely) switched from `synchronized` iteration to `CopyOnWriteArrayList`, eliminating read-side lock contention entirely.

## Part 19: Atomic Classes & CAS (Compare-And-Swap)

### What is it?

`java.util.concurrent.atomic` classes provide lock-free, thread-safe compound operations via CAS — a hardware-level atomic instruction.

### How it works

```java
counter.incrementAndGet();
counter.compareAndSet(5, 10);
```
CAS retry loop conceptually:
```java
do {
    current = get();
    next = current + 1;
} while (!compareAndSet(current, next));
```
No thread ever blocks — failed CAS just retries.

**ABA problem:** CAS can't detect a value that changed A→B→A between read and CAS — dangerous for lock-free structures like stacks. `AtomicStampedReference` fixes this via a paired version stamp.

**`LongAdder`:** spreads increments across multiple internal cells to reduce single-point CAS contention under very high write concurrency, at the cost of a more expensive `sum()` read.

### Real production scenario

An analytics service's single `AtomicLong` counter, hammered by 200 concurrent threads, showed measurable CAS-retry/cache-line-contention overhead. Switching to `LongAdder` eliminated the bottleneck since the total was read only rarely.

## Part 20: `CountDownLatch`, `CyclicBarrier`, `Semaphore`, `Phaser`

### What is it?

Higher-level coordination utilities: wait-for-N-completions (`CountDownLatch`), wait-for-all-peers-then-proceed-together, reusable (`CyclicBarrier`), limit-concurrent-access (`Semaphore`), dynamic-party generalization (`Phaser`).

### How it works

```java
CountDownLatch latch = new CountDownLatch(3);
latch.countDown(); // called by workers
latch.await();      // blocks until count reaches 0; one-shot, never resets

CyclicBarrier barrier = new CyclicBarrier(3, () -> System.out.println("all arrived"));
barrier.await();     // blocks until all 3 arrive; resets automatically for reuse

Semaphore semaphore = new Semaphore(5);
semaphore.acquire(); try { useResource(); } finally { semaphore.release(); }
```

### Common misconception

`CountDownLatch` and `CyclicBarrier` are interchangeable — they solve genuinely different coordination shapes (one-shot N-events vs reusable peer-rendezvous).

### Real production scenario

A batch job used `CountDownLatch(10)` to wait for 10 parallel chunks to finish before aggregating, and a `Semaphore(8)` to cap concurrent DB connections during those same chunks — two distinct primitives for two distinct concerns.

## Part 21: `ThreadLocal` — Use Cases, Memory Leak Pitfalls in Thread Pools

### What is it?

Gives each thread its own independent copy of a variable, via a private `ThreadLocalMap` on each `Thread` object.

### How it works

```java
private static final ThreadLocal<SimpleDateFormat> DATE_FORMAT =
    ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd"));
```

**The critical thread-pool danger:** pooled threads are reused — a value set during Task A's execution persists in that thread's `ThreadLocalMap` after Task A finishes, silently leaking into Task B if not explicitly cleared.

```java
RequestContext.set(userId);
try { chain.doFilter(request, response); }
finally { RequestContext.clear(); }  // CRITICAL
```
`set(null)` is NOT the same as `remove()` — the entry (and stale reference) remains either way unless removed.

### Real production scenario

A multi-tenant SaaS app's `ThreadLocal` tenant-ID leaked across requests when an exception path skipped the filter's cleanup, causing one tenant to briefly see another tenant's data — a severe security incident traced to missing `finally`-guaranteed `clear()`.

## Part 22: Fork/Join Framework & Parallel Streams

### What is it?

`ForkJoinPool`/`RecursiveTask` for divide-and-conquer parallelism via **work-stealing**. Parallel Streams are a declarative API built on the same machinery.

### How it works

```java
class SumTask extends RecursiveTask<Long> {
    protected Long compute() {
        if (end - start <= THRESHOLD) { /* base case: sum directly */ }
        SumTask left = new SumTask(array, start, mid);
        left.fork();
        long rightResult = right.compute();  // compute right yourself
        long leftResult = left.join();
        return leftResult + rightResult;
    }
}
```
Idle threads "steal" tasks from other threads' queues, keeping all threads busy despite uneven splits.

```java
long total = Arrays.stream(bigArray).parallel().sum();  // same machinery, declarative
```

### Common developer mistake

Blocking I/O inside a parallel stream lambda ties up the shared common `ForkJoinPool`, starving unrelated CPU-bound parallel work elsewhere in the app (including `CompletableFuture`'s default async methods, which share the same pool).

### Real production scenario

A reporting service's HTTP-bound `.parallelStream()` work starved unrelated `CompletableFuture` tasks elsewhere in the app because both shared the small default common pool. Fix: dedicated, separately-sized `ForkJoinPool` for the I/O-bound work.

## Part 23: Virtual Threads (Project Loom, Java 21) vs Platform Threads

### What is it?

Lightweight, JVM-managed threads multiplexed onto a small number of OS "carrier threads" — millions can exist without exhausting OS resources.

### How it works

```java
try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 100_000; i++) {
        executor.submit(() -> { String r = callSlowDownstreamService(); process(r); });
    }
}
```
On a recognized blocking call, the JVM **unmounts** the virtual thread from its carrier, freeing the carrier for other virtual threads; it **remounts** on completion — transparent to your code.

**Critical caveat:** a `synchronized` block that blocks **pins** the carrier thread (can't unmount) — a real, documented limitation. Use `ReentrantLock` instead for virtual-thread-heavy code with blocking critical sections.

### Common misconception

Virtual threads add computational parallelism. False — carrier thread count is still bounded by cores; they solve I/O-bound "waiting" scalability, not CPU-bound throughput.

### Common developer mistake

Pooling virtual threads like platform threads — defeats the point; they're meant to be cheap and disposable, one per task.

### Real production scenario

A service migrated from a `CompletableFuture` async pipeline to sequential blocking code on virtual threads, with comparable throughput and much simpler, more debuggable code — except a legacy `synchronized` cache-population block caused carrier-thread pinning until replaced with `ReentrantLock`.

## Part 24: Production Debugging — Thread Dumps, Deadlock Detection, Monitoring

### What is it?

Practical diagnostic toolkit: reading thread dumps, detecting deadlocks, interpreting metrics, recognizing each failure mode's signature.

### How it works

```bash
jps
jstack <pid> > dump.txt      # take 3, a few seconds apart
jcmd <pid> Thread.print > dump.txt
jmap -dump:live,format=b,file=heap.bin <pid>   # for ThreadLocal leak analysis
```

**Signature table:**
| Symptom | Likely cause |
|---|---|
| "Found one Java-level deadlock" | Deadlock |
| Many `BLOCKED` on one lock, held by a slow thread | Contention / slow critical section |
| `RUNNABLE` repeatedly, high CPU, no progress | Livelock |
| Blocked in `ArrayBlockingQueue.put()` | Dead consumers / undersized queue |
| Blocked in `Semaphore.acquire()` | Permit leak or genuine saturation |
| Growing heap via `Thread→ThreadLocalMap` | `ThreadLocal` leak |
| Growing queue depth, flat submission rate | Pool undersized for current latency |

Always rule out **GC pauses** first — a long stop-the-world pause looks identical to "stuck" from the outside.

### Real production scenario

An on-call engineer correctly ruled out deadlock (varying stack traces across dumps) and GC (clean logs) before finding a steadily climbing executor queue depth — the actual cause was a downstream dependency's silently degraded latency, requiring pool re-sizing, not a code fix.


---




### Practice exercises with answers

















































































































































### Part 25: Realistic Production Scenarios (with Answers)


---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Write a program with two threads incrementing a shared non-volatile, non-atomic `int` counter 100,000 times each. Run it 5 times and observe the final value. Explain why it's rarely 200,000.</summary>

The increments interleave: both threads can read the same value, increment locally, and write back, silently losing updates. This is a lost-update race condition, formalized fully in Parts 3-5.

</details>

<details class="qa-item">
<summary>2. If you have an 8-core machine and a program with only 1 thread, is it concurrent? Is it parallel?</summary>

Neither — a single thread has nothing to interleave or parallelize with. Concurrency and parallelism both require at least two threads/tasks contending for execution.

</details>

<details class="qa-item">
<summary>3. What's the difference in behavior between calling `thread.start()` twice on the same `Thread` object vs calling `thread.run()` twice?</summary>

Calling `start()` twice throws `IllegalThreadStateException` — a `Thread` object is single-use. Calling `run()` twice just executes the method body twice, synchronously, on the calling thread — no new thread is ever created either time.

---

</details>

<details class="qa-item">
<summary>1. Write code that puts a thread into `BLOCKED` state on purpose.</summary>

```java
public class BlockedDemo {
    static final Object lock = new Object();
    public static void main(String[] args) throws InterruptedException {
        Thread t1 = new Thread(() -> {
            synchronized (lock) {
                try { Thread.sleep(3000); } catch (InterruptedException e) {}
            }
        }, "Holder");
        Thread t2 = new Thread(() -> {
            synchronized (lock) { System.out.println("t2 got the lock"); }
        }, "Waiter");
        t1.start();
        Thread.sleep(200);
        t2.start();
        Thread.sleep(200);
        System.out.println("t1 state: " + t1.getState()); // TIMED_WAITING
        System.out.println("t2 state: " + t2.getState()); // BLOCKED
        t1.join(); t2.join();
    }
}
```
`t1` holds the lock while sleeping (`TIMED_WAITING`, not `BLOCKED`); `t2` can't enter the synchronized block so it's `BLOCKED`.

</details>

<details class="qa-item">
<summary>2. What state is a thread in while it's inside `t.join()` — the caller or the target?</summary>

The **caller's** state changes to `WAITING`/`TIMED_WAITING`. The target thread `t` keeps running unaffected.

</details>

<details class="qa-item">
<summary>3. Diagnosing a deadlock via `jstack`.</summary>

Use `jps` to find the PID, then `jstack <pid> > dump.txt`. Modern JVMs print "Found one Java-level deadlock" explicitly at the bottom. Manually: find `BLOCKED` threads, note what each is `waiting to lock` vs what it has `locked`, and look for a cycle. Taking 2-3 dumps a few seconds apart and seeing the same threads stuck confirms it.

---

</details>

<details class="qa-item">
<summary>1. Why might a non-volatile stop-flag work in a quick test but fail after millions of iterations in production?</summary>

Under quick tests the JIT hasn't optimized the loop yet — reads happen to hit memory. Under sustained load, the JIT recognizes the loop as hot and can legally hoist the read out entirely since nothing in-thread modifies the field, effectively turning `while(running)` into `while(true)`.

</details>

<details class="qa-item">
<summary>2. Does `volatile` make `count++` thread-safe?</summary>

No — `count++` is read-modify-write (3 steps). `volatile` makes each individual read/write visible but doesn't stop two threads interleaving between them, causing lost updates.

</details>

<details class="qa-item">
<summary>3. Why is data written before `thread.start()` always visible inside `run()` without `volatile`?</summary>

The JMM's thread start rule: `Thread.start()` happens-before any action in the started thread, so all prior writes are guaranteed visible — a free happens-before edge specifically for thread creation.

---

</details>

<details class="qa-item">
<summary>1. 10 threads × 100,000 increments on `volatile int count` — final value?</summary>

Expect something short of 1,000,000 (e.g. 850,000-990,000) due to lost updates. Switching to `AtomicInteger.incrementAndGet()` produces exactly 1,000,000 every run, since the increment is one indivisible CAS operation.

</details>

<details class="qa-item">
<summary>2. Is a `volatile Config` reference, swapped wholesale, thread-safe? Why does bundling work?</summary>

Yes. `Config` is immutable (no half-updated states possible), and the reference swap is a single atomic pointer change with happens-before guarantees. Two separate `volatile` primitives can't guarantee this — a reader could see old-min + new-max, a combination that never truly existed.

</details>

<details class="qa-item">
<summary>3. Does `volatile` cause `BLOCKED` state? What happens on simultaneous writes?</summary>

No blocking at all with `volatile`. On simultaneous writes, whichever memory barrier completes last wins; the other write is simply overwritten, not queued or merged — no atomicity for compound ops results from this.

---

</details>

<details class="qa-item">
<summary>1. Is `list.size()` then `list.get(list.size()-1)` on `CopyOnWriteArrayList` race-free?</summary>

No — two separate atomic calls; another thread can remove the last element in between, causing `IndexOutOfBoundsException`.

</details>

<details class="qa-item">
<summary>2. Race-free lazy singleton, and why double-checked locking is used.</summary>

```java
class Singleton {
    private static volatile Singleton instance;
    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();
                }
            }
        }
        return instance;
    }
}
```
Plain `synchronized` forces locking on every call forever. Double-checked locking makes the common case (already initialized) lock-free. `volatile` is mandatory to prevent readers seeing a partially-constructed object.

</details>

<details class="qa-item">
<summary>3. Is a `HashMap` read by many threads, written rarely by one, safe?</summary>

No — rare writes don't reduce risk to zero; concurrent resize can corrupt structure or even infinite-loop. Always use `ConcurrentHashMap`.

---

</details>

<details class="qa-item">
<summary>1. Do `synchronized` methods on two different objects block each other?</summary>

No — each object has its own monitor.

</details>

<details class="qa-item">
<summary>2. Why is `synchronized` reentrant, and what would break otherwise?</summary>

JVM tracks a per-thread hold count. Without reentrancy, a `synchronized` method calling another `synchronized` method on the same object would self-deadlock on every call.

</details>

<details class="qa-item">
<summary>3. Is the lock released if an exception is thrown mid-`synchronized` block? Contrast with `ReentrantLock`.</summary>

Yes, automatically — compiler/JVM guarantee. `ReentrantLock` has no such safety net; forgetting `finally` around `unlock()` leaves the lock permanently held.

---

</details>

<details class="qa-item">
<summary>1. What exception is thrown calling `wait()` without the monitor, and why?</summary>

`IllegalMonitorStateException`. Required so the condition-check and wait-registration happen atomically, preventing a missed-signal race.

</details>

<details class="qa-item">
<summary>2. Rewrite with `if` instead of `while`, describe a breaking interleaving.</summary>

With capacity 1: two producers both see "full" (via `if`), one waits, other waits too. Consumer removes one item, `notifyAll()` wakes both. First proceeds to `add()` without re-checking (fine). Second, woken by the same `notifyAll()`, also proceeds without re-checking — pushes size to 2, violating capacity. `while` would have caught this.

</details>

<details class="qa-item">
<summary>3. Why must `wait`/`notify` happen on the same object as the held lock?</summary>

`wait()`/`notify()` require holding the monitor of the object they're called on, so the atomic release-and-register step and the eventual notify are guaranteed to coordinate on the exact same condition/lock pairing — mixing locks would reopen the missed-signal race.

---

</details>

<details class="qa-item">
<summary>1. Fixed funds-transfer via consistent lock ordering.</summary>

```java
public void transfer(Account from, Account to, double amount) {
    Account first = from.getId() < to.getId() ? from : to;
    Account second = from.getId() < to.getId() ? to : from;
    synchronized (first) {
        synchronized (second) {
            from.debit(amount);
            to.credit(amount);
        }
    }
}
```

</details>

<details class="qa-item">
<summary>2. Which of the four conditions does lock ordering break? Name a different strategy for a different condition.</summary>

Breaks **circular wait**. A different strategy — `tryLock()` with timeout, releasing and retrying on failure — breaks **hold and wait** instead.

</details>

<details class="qa-item">
<summary>3. Is livelock detectable the same way as deadlock via thread dump?</summary>

No — livelocked threads show `RUNNABLE`, not `BLOCKED`. Look at CPU usage vs actual throughput progress over time, or repeating identical stack traces across multiple dumps.

---

</details>

<details class="qa-item">
<summary>1. Is `final` always enough for thread-safety? Counter-example.</summary>

No:
```java
final List<String> names = new ArrayList<>();
names.add("x");  // Thread A
names.add("y");  // Thread B — ArrayList itself isn't thread-safe
```
`final` only stops reassignment, not internal mutation races.

</details>

<details class="qa-item">
<summary>2. `SimpleDateFormat` fix via `ThreadLocal`.</summary>

```java
class DateService {
    private static final ThreadLocal<SimpleDateFormat> FORMATTER =
        ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd"));
    public String format(Date date) { return FORMATTER.get().format(date); }
}
```

</details>

<details class="qa-item">
<summary>3. Is handing a locally-built `HashMap` to another thread via a queue safe?</summary>

Yes, as long as the producer never touches it again — confinement via ownership transfer; the queue's happens-before guarantee (Part 18) does the safety work.

---

</details>

<details class="qa-item">
<summary>1. Best-effort `tryLock()` increment.</summary>

```java
public boolean tryIncrement() {
    if (lock.tryLock()) {
        try { count++; return true; } finally { lock.unlock(); }
    }
    return false;
}
```
Useful for optional work like metrics counters where blocking a real request thread isn't worth it.

</details>

<details class="qa-item">
<summary>2. Why is risky code before `try{}` dangerous?</summary>

If it throws before `try` is entered, the paired `finally`'s `unlock()` never runs — lock held forever.

</details>

<details class="qa-item">
<summary>3. Effect of removing random backoff in a high-contention retry loop?</summary>

Livelock + wasted CPU (all threads `RUNNABLE`, colliding repeatedly), possibly starvation for unlucky threads that keep losing races.

---

</details>

<details class="qa-item">
<summary>1. When does `ReadWriteLock` underperform plain `synchronized`?</summary>

Balanced or write-heavy ratios, or light contention — extra bookkeeping cost without the parallel-read benefit materializing.

</details>

<details class="qa-item">
<summary>2. Why is `StampedLock` optimistic read faster with no contention?</summary>

No CAS-based acquire/release, no thread registration — just a version-stamp read and compare, versus `ReadWriteLock`'s real lock-state bookkeeping even when uncontended.

</details>

<details class="qa-item">
<summary>3. Concrete scenario where non-reentrancy bites.</summary>

An `outerUpdate()` holding the write lock calls `innerUpdate()`, which also tries to acquire the same write lock — self-deadlock, since `StampedLock` doesn't recognize "the current holder already has this."

---

</details>

<details class="qa-item">
<summary>1. Connection pool with two `Condition`s — skeleton.</summary>

```java
private final Condition connectionAvailable = lock.newCondition();
private final Condition allReturned = lock.newCondition();
// borrow() awaits connectionAvailable; returnConnection() signals connectionAvailable
// always, and signals allReturned only when borrowedCount reaches 0.
```

</details>

<details class="qa-item">
<summary>2. What happens calling `await()` without the lock?</summary>

`IllegalMonitorStateException` — same reasoning as `wait()`: atomicity of release-and-register requires holding the lock first.

</details>

<details class="qa-item">
<summary>3. Can `Condition`s from two different `Lock`s coordinate?</summary>

No — a `Condition` is tied to the specific lock that created it; unrelated locks have no shared coordination mechanism.

---

</details>

<details class="qa-item">
<summary>1. Trace 8 tasks through `ThreadPoolExecutor(2, 5, 30, SECONDS, new ArrayBlockingQueue<>(3), AbortPolicy)`.</summary>

Tasks 1-2 get new threads (core). Tasks 3-5 queue (queue fills). Tasks 6-8 grow the pool to max (5). A 9th task would be rejected.

</details>

<details class="qa-item">
<summary>2. Why is `CallerRunsPolicy` natural backpressure, and its risk for a web server thread?</summary>

It throttles the submitter to the pool's actual processing rate. Risk: if the caller is a scarce request-handling thread, it becomes unavailable for other requests, potentially cascading into a front-facing outage.

</details>

<details class="qa-item">
<summary>3. Why is `newFixedThreadPool`'s `maximumPoolSize` irrelevant?</summary>

It's implemented with `core == max` and an effectively unbounded `LinkedBlockingQueue` — the queue absorbs everything before the pool would ever need to grow, and it can't grow past `max` anyway since `core == max`.

---

</details>

<details class="qa-item">
<summary>1. 4 cores, 2ms compute / 18ms wait — pool size?</summary>

`4 × (1 + 9) = 40` threads.

</details>

<details class="qa-item">
<summary>2. Why is a shared pool for CPU-heavy and I/O-heavy tasks a design smell?</summary>

Neither workload gets correctly sized, and a burst of slow I/O tasks can starve fast CPU tasks queued behind them (or vice versa).

</details>

<details class="qa-item">
<summary>3. Symptom and metric when downstream latency doubles but pool isn't resized?</summary>

Queue depth (and end-to-end latency) climbs steadily with a flat submission rate — the textbook "pool now under-sized for current downstream latency" signature.

---

</details>

<details class="qa-item">
<summary>1. Cooperative-cancellation `Callable` with periodic checks.</summary>

```java
Callable<Long> partialSum = () -> {
    long sum = 0;
    for (int i = 0; i < 1_000_000_000; i++) {
        if (i % 100_000 == 0 && Thread.currentThread().isInterrupted()) return sum;
        sum += i;
    }
    return sum;
};
```

</details>

<details class="qa-item">
<summary>2. What does `future.get()` throw if already cancelled?</summary>

`CancellationException`, immediately, without blocking — distinct from `ExecutionException` (task threw) and `InterruptedException` (caller interrupted while waiting).

</details>

<details class="qa-item">
<summary>3. Why is an empty `catch (InterruptedException e) {}` a real bug?</summary>

It discards the interrupt signal entirely; `shutdownNow()` during a deploy would interrupt the thread, but a swallowed exception means the loop never notices and ignores the shutdown request, potentially leading to a hard `SIGKILL`.

---

</details>

<details class="qa-item">
<summary>1. Parallel gateway rewrite.</summary>

```java
CompletableFuture<UserInfo> userFuture = CompletableFuture.supplyAsync(() -> fetchUserInfo(userId));
CompletableFuture<Inventory> inventoryFuture = CompletableFuture.supplyAsync(() -> fetchInventory(itemId));
CompletableFuture<Pricing> pricingFuture = CompletableFuture.supplyAsync(() -> fetchPricing(itemId));
CompletableFuture<Response> assembled = CompletableFuture.allOf(userFuture, inventoryFuture, pricingFuture)
    .thenApply(v -> new Response(userFuture.join(), inventoryFuture.join(), pricingFuture.join()));
```

</details>

<details class="qa-item">
<summary>2. Which stages run if the second `thenApply` throws?</summary>

First runs normally, second throws (exceptional completion), third is skipped entirely, `.exceptionally` catches it and produces the fallback.

</details>

<details class="qa-item">
<summary>3. Why does mid-pipeline `.get()` defeat the purpose?</summary>

It blocks the calling thread between each async call, serializing work that could have run in parallel — functionally identical to synchronous sequential calls with extra dispatch overhead.

---

</details>

<details class="qa-item">
<summary>1. Does `computeIfAbsent` run `expensiveInit()` once or twice under a race?</summary>

Exactly once — bucket-level locking serializes the second caller until the first completes and the key is present.

</details>

<details class="qa-item">
<summary>2. Why is modifying the same map from inside `computeIfAbsent`'s lambda dangerous?</summary>

The lambda runs under an internal bucket lock; recursive map mutation risks blocking indefinitely or throwing, an unsupported use case per JDK documentation.

</details>

<details class="qa-item">
<summary>3. Contrast fail-fast (`HashMap`) vs weakly-consistent (`ConcurrentHashMap`) iteration.</summary>

`HashMap`'s iterator throws `ConcurrentModificationException` on structural modification during iteration. `ConcurrentHashMap`'s iterator never throws — it may or may not reflect concurrent inserts, and either outcome is correct under its weakly-consistent contract.

---

</details>

<details class="qa-item">
<summary>1. Is `CopyOnWriteArrayList` good for a frequently-modified shopping cart?</summary>

No — write-heavy usage means constant full-array copies; a regular locked `ArrayList` fits better.

</details>

<details class="qa-item">
<summary>2. Why does `SynchronousQueue`'s zero capacity force `newCachedThreadPool()`'s unbounded thread creation?</summary>

No buffer exists to queue excess tasks in, so the only response to a burst is immediately creating a new thread, up to `Integer.MAX_VALUE`.

</details>

<details class="qa-item">
<summary>3. What happens with producers but no consumers on a bounded `ArrayBlockingQueue`?</summary>

Producers fill the queue to capacity, then subsequent `put()` calls block (`WAITING` inside `notFull.await()` internally) indefinitely — a diagnosable thread-dump signature of dead/stopped consumers.

---

</details>

<details class="qa-item">
<summary>1. Lock-free "increment only if below limit."</summary>

```java
public boolean tryIncrement() {
    while (true) {
        int current = count.get();
        if (current >= LIMIT) return false;
        if (count.compareAndSet(current, current + 1)) return true;
    }
}
```
A single `compareAndSet` can't express this because the check must be re-evaluated fresh on every retry attempt.

</details>

<details class="qa-item">
<summary>2. Explain the ABA problem in a lock-free stack.</summary>

Thread A reads head=X. B pops X, pops Y, pushes X back (X.next now points to Z, not Y). A's CAS sees head is still X and succeeds, setting head to A's stale `X.next` (Y) — but Y is no longer valid, corrupting the stack even though the CAS "succeeded."

</details>

<details class="qa-item">
<summary>3. When would `LongAdder` be worse than `AtomicLong`?</summary>

For a rarely-incremented, frequently-read value (e.g., an active-connections gauge) — `sum()`'s per-read cost of combining cells outweighs the write-side benefit `LongAdder` provides.

---

</details>

<details class="qa-item">
<summary>1. Batch job using both together — see combined skeleton with `CountDownLatch` + `Semaphore` wrapping only the DB-access portion.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. Why can't `CountDownLatch` be reused?</summary>

No reset mechanism by design — once zero, stays zero forever; further `countDown()` calls are harmless no-ops. `CyclicBarrier` exists for the repeating case.

</details>

<details class="qa-item">
<summary>3. Symptom of a `Semaphore` permit leak (double-`acquire()` without matching `release()`)?</summary>

`availablePermits()` trends steadily downward, never recovering even in low-usage periods, eventually reaching 0 and blocking all future `acquire()` calls forever.

---

</details>

<details class="qa-item">
<summary>1. Guaranteed-cleanup filter pattern</summary>

— `set()` before `try`, `clear()` in `finally` wrapping the entire chain invocation.

</details>

<details class="qa-item">
<summary>2. Why doesn't `set(null)` solve the leak the way `remove()` does?</summary>

`set(null)` still leaves an entry in the map (just with a null value) — `remove()` fully deletes it, truly resetting state for the next task on that thread.

</details>

<details class="qa-item">
<summary>3. Is forgetting `remove()` still a bug in a genuinely single-threaded app?</summary>

Far less dangerous — no cross-task contamination risk since the thread is never reused for a different logical context — but still a minor memory-footprint concern if the stored object is large.

---

</details>

<details class="qa-item">
<summary>1. Dedicated pool fix — wrap the parallel stream call in `dedicatedPool.submit(...)`.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. Why is `parallelStream().forEach(x -> results.add(...))` on a plain `ArrayList` unsafe?</summary>

`ArrayList.add()` isn't thread-safe internally — concurrent calls can corrupt internal state, drop elements, or throw.

</details>

<details class="qa-item">
<summary>3. Would `.parallelStream()` help on 50 microsecond-scale elements?</summary>

No — fork/join coordination overhead exceeds the trivial amount of actual work; sequential wins here.

---

</details>

<details class="qa-item">
<summary>1. Why does 500,000 tasks on `newFixedThreadPool(200)` vs `newVirtualThreadPerTaskExecutor()` behave very differently for I/O-bound work?</summary>

The fixed pool queues almost everything behind 200 threads; virtual threads all start essentially immediately since unmounting frees carriers during I/O waits, with no artificial concurrency ceiling.

</details>

<details class="qa-item">
<summary>2. What happens to the carrier thread when a virtual thread blocks inside `synchronized`?</summary>

It stays genuinely blocked/pinned — can't unmount — reintroducing the exact scalability ceiling virtual threads exist to remove, for however many virtual threads hit that code path concurrently.

</details>

<details class="qa-item">
<summary>3. Why is pooling virtual threads counterproductive?</summary>

Creation is already nearly free (no OS-level cost to amortize), so pooling adds bookkeeping overhead and reintroduces an artificial concurrency ceiling for no benefit.

---

</details>

<details class="qa-item">
<summary>1. Is one dump showing `BLOCKED` threads enough to call it a deadlock?</summary>

No — check for the JVM's explicit deadlock report, examine what the holding thread is doing, and take a second dump to see if anything has changed.

</details>

<details class="qa-item">
<summary>2. Why check GC logs early?</summary>

A stop-the-world pause halts every thread and looks identical to a concurrency freeze from the outside; it's a cheap, fast check to rule out before deeper investigation.

</details>

<details class="qa-item">
<summary>3. Steadily declining `Semaphore.availablePermits()` — what to investigate?</summary>

Audit every acquire/release call site for guaranteed `finally`-wrapped release, missing releases on early-return/exception paths, and any accidental double-`acquire()` in retry logic.

---

</details>

<details class="qa-item">
<summary>1. Silent Data Corruption</summary>

— Plain `HashMap` read/written concurrently (scheduled refresh vs request threads) caused sporadic `NullPointerException` under increased traffic. Fix: `volatile` reference to an immutable map, or `ConcurrentHashMap`.

</details>

<details class="qa-item">
<summary>2. The Vanishing Discount</summary>

— An `AtomicInteger`-based "first 500" promo counter was actually correct; the real bug was a swallowed exception in downstream `applyDiscount()` logic. Lesson: verify the atomic primitive is genuinely misused before blaming concurrency.

</details>

<details class="qa-item">
<summary>3. The Friday Deploy That Hung</summary>

— `shutdown()` alone doesn't interrupt running tasks; an uncooperative loop caused `awaitTermination` to time out and a hard kill corrupted writes. Fix: follow a timed-out `awaitTermination` with `shutdownNow()`, and make task code interruption-aware.

</details>

<details class="qa-item">
<summary>4. The Mysterious Memory Growth</summary>

— Steady heap growth over days pointed to a `ThreadLocal` leak on a long-lived pool (confirmed via heap dump showing `Thread→ThreadLocalMap` growth) rather than queue growth (ruled out via flat queue-depth metrics).

</details>

<details class="qa-item">
<summary>5. The Load Balancer False Positive</summary>

— A shared thread pool let slow business requests delay the health-check endpoint, causing false-positive removals from load-balancer rotation. Fix: dedicated, isolated pool for health checks.

</details>

<details class="qa-item">
<summary>6. The Race That Only Happens in Kubernetes</summary>

— More cores in production increased the probability of hitting a pre-existing check-then-act race that rarely triggered on a lower-core staging environment. Fix: audit for check-then-act shapes and make them atomic (locking, `compute()`, or a DB-level unique constraint).

</details>

<details class="qa-item">
<summary>7. The Cache That Made Things Slower</summary>

— A `ReadWriteLock` cache underperformed because actual traffic was closer to 50/50 read/write, not the read-heavy profile the lock is designed for. Fix: measure the actual ratio before choosing the lock type.

</details>

<details class="qa-item">
<summary>8. The Silent Executor Rejection</summary>

— Fire-and-forget `executor.execute()` calls threw `RejectedExecutionException` under pool saturation with no logging/alerting, making a metrics outage invisible. Fix: explicit error handling on submission plus monitored rejection-count metrics.

</details>
