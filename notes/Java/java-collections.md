# Senior-Level Java Collections Mastery Course
### Java 21 LTS Baseline

---

## Table of Contents

1. [Part 1 — Java Collections Framework Architecture](#part-1-java-collections-framework-architecture)
2. [Java 21's addition: `SequencedCollection`, `SequencedSet`, `SequencedMap`](#java-21s-addition-sequencedcollection-sequencedset-sequencedmap)
3. [Part 2 — ArrayList Deep Dive](#part-2-arraylist-deep-dive)
4. [Part 3 — LinkedList Deep Dive](#part-3-linkedlist-deep-dive)
5. [Java 21 relevance](#java-21-relevance)
6. [Part 4 — HashSet Deep Dive](#part-4-hashset-deep-dive)
7. [Part 5 — HashMap Deep Dive](#part-5-hashmap-deep-dive)
8. [Part 6 — LinkedHashMap](#part-6-linkedhashmap)
9. [Java 21 sequenced APIs on LinkedHashMap](#java-21-sequenced-apis-on-linkedhashmap)
10. [Part 7 — TreeMap](#part-7-treemap)
11. [Part 8 — Sets](#part-8-sets)
12. [Java 21: `SequencedSet`, `reversed()`, first/last operations](#java-21-sequencedset-reversed-firstlast-operations)
13. [Part 9 — Queue and Deque](#part-9-queue-and-deque)
14. [Java 21 sequenced APIs](#java-21-sequenced-apis)
15. [Part 10 — Stack](#part-10-stack)
16. [Part 11 — PriorityQueue](#part-11-priorityqueue)
17. [Part 12 — Immutable and Unmodifiable Collections](#part-12-immutable-and-unmodifiable-collections)
18. [Part 13 — Concurrent Collections](#part-13-concurrent-collections)
19. [Part 14 — CopyOnWrite Collections](#part-14-copyonwrite-collections)
20. [Part 15 — BlockingQueue](#part-15-blockingqueue)
21. [Part 16 — WeakHashMap and Reference-Based Collections](#part-16-weakhashmap-and-reference-based-collections)
22. [Part 17 — EnumMap and EnumSet](#part-17-enummap-and-enumset)
23. [Part 18 — Iterators](#part-18-iterators)
24. [Part 19 — Spliterator and Streams](#part-19-spliterator-and-streams)
25. [Part 20 — Generics + Collections](#part-20-generics-collections)
26. [Part 21 — equals() and hashCode()](#part-21-equals-and-hashcode)
27. [Part 22 — Complexity and Performance](#part-22-complexity-and-performance)
28. [Part 23 — JVM and Memory Perspective](#part-23-jvm-and-memory-perspective)
29. [Part 24 — Java 21 Collections and API Design](#part-24-java-21-collections-and-api-design)
30. [Part 25 — Collections + Virtual Threads](#part-25-collections-virtual-threads)
31. [Part 26 — Real Production Patterns](#part-26-real-production-patterns)
32. [Part 27 — Common Senior-Level Mistakes](#part-27-common-senior-level-mistakes)
33. [Part 28 — Collection Selection Framework](#part-28-collection-selection-framework)
34. [Part 29 — Real-World Case Studies](#part-29-real-world-case-studies)
35. [Part 30 — Simplified Internal Implementations](#part-30-simplified-internal-implementations)
36. [Part 31 — Production Debugging](#part-31-production-debugging)

---





# Part 1 — Java Collections Framework Architecture

Let's build the mental model first, because everything else in this course hangs off it.

## The core design question

When the Collections Framework was designed (JDK 1.2, later heavily reshaped), the problem wasn't "how do we store a bunch of objects." It was: **how do we let algorithms operate on data structures without knowing which concrete data structure they're dealing with?** That's the entire reason the framework is interface-heavy rather than a grab-bag of concrete classes like `Vector`, `Hashtable`, `Stack` from pre-1.2 Java.

This is interface-based programming taken seriously: `Collections.sort(list)` doesn't care if `list` is an `ArrayList` or a `LinkedList`. `Collections.max(collection)` doesn't care if it's a `Set` or a `List`. The algorithm is written once, against the interface, and works for every implementation that satisfies the contract.

## The root: `Iterable`

`Iterable<T>` is the actual root — not `Collection`. It has exactly one abstract method:

```java
Iterator<T> iterator();
```

That's it. Anything that can hand out an `Iterator` can be used in a for-each loop. This is deliberately minimal — it's a capability, not a data structure. `Collection` extends `Iterable`, but so could (and do) other things outside the Collections Framework entirely, like NIO's `Path` in some contexts, or your own domain classes.

Why does this matter architecturally? Because it decouples "can be iterated" from "is a collection." A `Collection` is a specific commitment (size, add/remove, bulk operations); `Iterable` is a much weaker, more general commitment.

## `Collection<E>`

`Collection` adds the actual collection contract on top of `Iterable`:

- Size and emptiness: `size()`, `isEmpty()`
- Membership: `contains()`, `containsAll()`
- Mutation: `add()`, `remove()`, `addAll()`, `removeAll()`, `retainAll()`, `clear()`
- Bulk conversion: `toArray()`
- Since Java 8: default methods like `removeIf()`, `stream()`, `parallelStream()`, `forEach()` (inherited from `Iterable`)

Notice `Collection` does **not** define ordering, does **not** define uniqueness, does **not** define sorting. Those are added by the three sub-interfaces: `List`, `Set`, `Queue`. `Collection` itself is deliberately the "least common denominator" — anything you can iterate, count, and bulk-mutate.

This is why generic utility methods that don't care about order or duplicates are written against `Collection<E>`, not against `List<E>`.

## The three branches: `List`, `Set`, `Queue`

**`List<E>`** adds:
- Positional access: `get(int)`, `set(int, E)`, `add(int, E)`, `remove(int)`
- Search by position: `indexOf()`, `lastIndexOf()`
- `ListIterator` (bidirectional, mutation-capable iterator)
- `subList()` — a *view*, not a copy (important, we'll hit this again)

The contract of `List` is: **ordered, indexable, duplicates allowed.**

**`Set<E>`** adds almost nothing method-wise — it has the *same* method signatures as `Collection` in most cases. The entire value of `Set` is in the **contract**, not new methods: no duplicate elements, as defined by `equals()`. This is a great example of why the framework leans on interfaces to express contracts, not just APIs. Two types can have identical method signatures and still be semantically completely different.

**`Queue<E>`** adds ordering semantics oriented around *processing*, not indexing:
- `offer()`, `poll()`, `peek()` — the "safe" variants (return null/false on failure)
- `add()`, `remove()`, `element()` — the "throwing" variants (throw on failure)

The dual-method design (`offer`/`add`, `poll`/`remove`, `peek`/`element`) exists because queues are often used at capacity boundaries (bounded queues, blocking queues) where failure is a *normal* outcome, not exceptional. A senior-level detail: this is why you almost never see raw `queue.add()` in production concurrent code — `offer()` composes much better with capacity checks and non-blocking design.

**`Deque<E>`** extends `Queue` and generalizes it to both ends: `addFirst/addLast`, `offerFirst/offerLast`, `removeFirst/removeLast`, `peekFirst/peekLast`. `Deque` is expressive enough to implement a `Queue` (FIFO) and a `Stack` (LIFO) simultaneously — which is precisely why `ArrayDeque` is the modern replacement for both `LinkedList`-as-queue and the legacy `Stack` class. We'll dig into that in Part 9/10.

## Why doesn't `Map` extend `Collection`?

This trips people up, and the answer is genuinely architectural, not accidental.

A `Collection<E>` holds elements of type `E`. A `Map<K, V>` holds *pairs*. If `Map` extended `Collection<Map.Entry<K,V>>`, you'd immediately hit type-signature conflicts:

- `Collection.add(E e)` would become `add(Map.Entry<K,V>)` — but the natural, useful operation on a map is `put(K key, V value)`, which has a completely different signature and different semantics (it *replaces* on key collision rather than just inserting).
- `contains(Object o)` on a `Collection<Entry<K,V>>` would mean "does this exact key-value pair exist," but what you almost always want to ask a map is "does this **key** exist" — a different, more useful operation (`containsKey`).

Rather than force an awkward fit, the designers made `Map<K,V>` a **parallel, standalone hierarchy** with its own root. It still integrates with the rest of the framework through **view collections**: `map.keySet()` returns a `Set<K>`, `map.values()` returns a `Collection<V>`, `map.entrySet()` returns a `Set<Map.Entry<K,V>>`. These are live views — mutate the view, mutate the map (mostly; adding new entries via `keySet()` isn't supported, but removal is).

This is a recurring theme in the framework's design philosophy: **prefer a clean, purpose-fit contract over forcing everything into one interface hierarchy.**

## Ordered/sorted extensions: `SortedSet`, `NavigableSet`, `SortedMap`, `NavigableMap`

`SortedSet` (and `SortedMap`) guarantee iteration in a defined order (natural ordering or a supplied `Comparator`), and add range operations: `first()`, `last()`, `headSet()`, `tailSet()`, `subSet()`.

`NavigableSet`/`NavigableMap` (added in Java 6) extended this further with true navigation: `floor()`, `ceiling()`, `lower()`, `higher()`, `pollFirst()`, `pollLast()`, and a `descendingSet()`/`descendingMap()` view. `TreeSet` and `TreeMap` implement the Navigable versions, which is a strict superset of `Sorted`. We'll go deep on the red-black tree internals in Part 7.

## Java 21's addition: `SequencedCollection`, `SequencedSet`, `SequencedMap`

This is the newest structural addition to the framework (JEP 431, finalized in Java 21), and it fixes a genuine, long-standing gap: **there was no unified way to say "this collection has a well-defined encounter order with a first and last element" across `List`, `LinkedHashSet`, and `LinkedHashMap`.**

Before Java 21:
- `List` had positional first/last access, but only via `get(0)` / `get(size()-1)` — clunky and inconsistent with `Deque`'s naming.
- `LinkedHashSet` had a defined insertion order but **no API** to get the first or last element without an iterator.
- `LinkedHashMap` had the same gap.
- Reversing a `List` required `Collections.reverse()` (mutating!) or manual iteration; there was no reversed *view*.

`SequencedCollection<E>` introduces a uniform contract:

```java
interface SequencedCollection<E> extends Collection<E> {
    SequencedCollection<E> reversed();
    void addFirst(E e);
    void addLast(E e);
    E getFirst();
    E getLast();
    E removeFirst();
    E removeLast();
}
```

`List` and `Deque` now both extend `SequencedCollection`. `LinkedHashSet` implements `SequencedSet` (which extends both `SequencedCollection` and `Set`). `LinkedHashMap` implements `SequencedMap`, which adds `firstEntry()`, `lastEntry()`, `pollFirstEntry()`, `pollLastEntry()`, `sequencedKeySet()`, `sequencedValues()`, `sequencedEntrySet()`, and its own `reversed()`.

The practical effect: `myLinkedHashSet.reversed()` and `myLinkedHashMap.reversed()` are now first-class, giving you an efficient reversed **view** (not a copy) — something previously only easy for `List`/`Deque`. We'll apply this concretely when we cover `LinkedHashMap` (Part 6) and `Set` (Part 8).

One important nuance for a senior developer: `HashSet` and `HashMap` do **not** implement the Sequenced interfaces, because they have no defined encounter order in the first place — there's nothing to sequence. Only the ordered variants (`LinkedHashSet`, `LinkedHashMap`, `TreeSet`, `TreeMap`, `List`, `Deque`) participate.

## Iteration machinery: `Iterator`, `ListIterator`, `Spliterator`

- `Iterator<E>`: `hasNext()`, `next()`, `remove()` (optional operation). Unidirectional, single-pass.
- `ListIterator<E>`: extends `Iterator`, adds `hasPrevious()`, `previous()`, `set()`, `add()`, and positional info (`nextIndex()`, `previousIndex()`). Bidirectional, and the only standard iterator that supports in-place mutation beyond removal.
- `Spliterator<E>`: introduced in Java 8 specifically to support the Streams API — designed for **splitting** (`trySplit()`) so a source can be partitioned across threads for parallel streams, plus characteristic bits (`ORDERED`, `SIZED`, `DISTINCT`, etc.) that let stream operations optimize themselves. We'll cover this properly in Part 19.

## The utility classes: `Collections` and `Arrays`

These are **not** part of the interface hierarchy — they're static utility classes, the "algorithms" half of the "interfaces + algorithms" split that defines the whole framework's philosophy.

- `Collections`: sorting, shuffling, synchronized wrappers (`synchronizedList`, etc. — legacy), unmodifiable wrappers, `emptyList()`/`singletonList()`, `max()`/`min()`, binary search for `List`.
- `Arrays`: the array-world equivalent — `sort()`, `binarySearch()`, `asList()` (a classic gotcha — it's a fixed-size *view* over the array, not a real resizable `ArrayList`), `Arrays.stream()`, `Arrays.equals()` (element-wise comparison, unlike `array1.equals(array2)` which is reference equality).

## Default methods and why they matter architecturally

Before Java 8, adding a method to an interface broke every implementer in the ecosystem. Default methods solved this: `removeIf()`, `forEach()`, `spliterator()`, `replaceAll()`, `sort()` (on `List`) were all added to existing interfaces *without* breaking `ArrayList`, `LinkedList`, or any third-party implementation, because they ship with a default implementation in the interface itself.

Default methods let you evolve a widely-implemented interface without a breaking change, at the cost that every implementer inherits a *generic, possibly suboptimal* implementation unless they choose to override it. `ArrayList` overrides `removeIf()` with an array-aware version; a naive third-party `List` implementation would fall back to the default, which uses the iterator and is often worse.

## Mentally navigating the framework

```
Iterable
  └── Collection
        ├── List ──────────────┐
        ├── Set                 ├── SequencedCollection (Java 21)
        │     ├── SortedSet     │
        │     │     └── NavigableSet
        │     └── SequencedSet (Java 21)
        └── Queue
              └── Deque ────────┘

Map (separate hierarchy)
  ├── SortedMap
  │     └── NavigableMap
  └── SequencedMap (Java 21)
```

Every concrete class you'll meet in this course (`ArrayList`, `HashMap`, `TreeSet`, `ConcurrentHashMap`, `ArrayDeque`...) is answering the question: *which interface contracts does it satisfy, and what internal data structure does it use to satisfy them efficiently?* That's the lens for every remaining part.


---

# Part 2 — ArrayList Deep Dive

## Internal structure

`ArrayList<E>` is backed by a plain `Object[]` array:

```java
transient Object[] elementData;
private int size;
```

Two distinct numbers matter: **`size`** — the number of actual elements logically in the list — and **`elementData.length`** (capacity) — the physical length of the backing array, which is almost always ≥ `size`. This gap is why `ArrayList` can offer amortized O(1) `add()` at the end: there's usually pre-allocated slack.

## Capacity growth — the actual algorithm

Default no-arg constructor: `elementData` starts as a shared empty array (`DEFAULTCAPACITY_EMPTY_ELEMENTDATA`) — **not** pre-sized to 10. The first `add()` call triggers allocation to capacity 10 (a deliberate micro-optimization for lists that are constructed but never populated).

When growth is needed:

```java
int newCapacity = oldCapacity + (oldCapacity >> 1); // 1.5x growth
```

Growth is **1.5x**, not doubling (a common misconception). If `newCapacity` still isn't enough (e.g. a bulk `addAll`), it jumps straight to the required minimum.

Why 1.5x and not 2x? A classic space/time trade-off. There's a well-known mathematical property: **growth factor must be < golden ratio (~1.618) for old freed memory blocks to eventually be reusable by future allocations** in certain allocator designs — 1.5 satisfies that; 2.0 doesn't.

Each resize is `Arrays.copyOf(elementData, newCapacity)` — a full O(n) array copy. This is why growth is **amortized** O(1), not true O(1): individual `add()` calls are O(1), but occasionally you eat an O(n) copy. The *sum* of all resize copies across the life of filling the list to size n is bounded by a geometric series summing to O(n), not O(n²).

## Operations — complexity and what actually happens

| Operation | Complexity | Why |
|---|---|---|
| `get(index)` | O(1) | direct array index |
| `set(index, e)` | O(1) | direct array write |
| `add(e)` (append) | O(1) amortized | as above; O(n) worst case on resize |
| `add(index, e)` | O(n) | `System.arraycopy` shifts everything after `index` right by one |
| `remove(index)` | O(n) | shifts everything after `index` left by one, then nulls the last slot |
| `remove(Object)` | O(n) | linear scan via `equals()`, then the O(n) shift |
| `contains(Object)` | O(n) | linear scan, `equals()` per element |
| `indexOf(Object)` | O(n) | linear scan |
| `clear()` | O(n) | nulls every slot (releases references for GC) |

That `clear()` detail is genuinely senior-level: if `clear()` merely set `size = 0` without nulling slots, every object ever held would remain strongly reachable through the backing array until the array itself is resized or GC'd — a silent memory leak. Same reasoning applies to `remove()` nulling the vacated last slot.

`trimToSize()` — reallocates the backing array to exactly `size`, freeing slack capacity. `ensureCapacity(int)` — pre-grows the array in one shot, avoiding multiple incremental resizes; use when you know you're about to `add()` many elements.

## Why insertion isn't "always O(1)" — precision matters

- **Append at the end** (`add(e)`): O(1) amortized.
- **Insert at an arbitrary index** (`add(index, e)`): O(n) always.
- Even the "O(1)" append has a real O(n) spike on resize — amortized analysis smooths this over *long sequences*, but individual calls can miss latency deadlines.

## Memory overhead, object references, cache locality

An `ArrayList<E>` stores **references**, not objects inline. The backing array itself is contiguous — scanning it is a cache-friendly, prefetcher-friendly linear scan. But dereferencing each element (`get(i).someField`) is a **pointer chase** to wherever that object landed on the heap. For `List<Integer>`, this is especially painful: unless the value falls in the cached Integer range (-128 to 127), each element is a separate heap-allocated boxed object. So "ArrayList has good cache locality" is a half-truth: the *index structure* has excellent locality, but the *payload* often doesn't.

## Why ArrayList is usually faster than LinkedList in practice

`ArrayList`'s contiguous backing array means sequential iteration is cache-friendly and branch-predictor-friendly. `LinkedList` pays a pointer-chase penalty on every step, plus per-node object overhead, and the JIT has a much harder time optimizing pointer-chasing loops than array-index loops.

## Comparison table: ArrayList vs raw arrays vs LinkedList vs CopyOnWriteArrayList

| | `ArrayList` | `Object[]`/`T[]` | `LinkedList` | `CopyOnWriteArrayList` |
|---|---|---|---|---|
| Backing structure | dynamic array | fixed array | doubly-linked nodes | dynamic array (copied on write) |
| Resizable | yes | no | yes | yes |
| `get(index)` | O(1) | O(1) | O(n) | O(1) |
| `add` at end | O(1) amortized | N/A | O(1) | O(n) — full array copy every write |
| `add` at index | O(n) | N/A | O(1) once positioned, O(n) to find | O(n) |
| Thread safety | none | none | none | fully thread-safe for iteration |
| Iteration | fast, cache-friendly | fastest | slow, pointer-chasing | fast, but iterates a snapshot |
| Primitive storage | no (boxed) | yes if `int[]` etc. | no (boxed) | no (boxed) |
| Best for | general-purpose default | fixed-size, performance-critical, primitives | rarely — see Part 3 | read-heavy, rarely-mutated, concurrent |

Practical takeaway: **`ArrayList` is the correct default choice for `List`** in the overwhelming majority of cases.

---

# Part 3 — LinkedList Deep Dive

## Internal structure

`LinkedList<E>` implements both `List` and `Deque`, backed by a **doubly-linked list** of nodes:

```java
private static class Node<E> {
    E item;
    Node<E> next;
    Node<E> prev;
}

transient Node<E> first;
transient Node<E> last;
transient int size;
```

Every element is a separately heap-allocated `Node` object holding a reference to the payload plus two more references (`next`, `prev`). The list tracks `first`, `last`, and `size` (cached, not recomputed).

## Traversal and index lookup

`get(index)` is O(n):

```java
Node<E> node(int index) {
    if (index < (size >> 1)) {
        // walk forward from first
    } else {
        // walk backward from last
    }
}
```

It picks whichever end is closer — this halves the average constant but does **not** change the complexity class; it's still O(n), not O(log n) — a common interview trap.

## Insertion and removal

- **At a known `Node` reference**: O(1).
- **At head or tail**: O(1).
- **At an arbitrary index**: O(n) — you must first walk to that index before the O(1) relink.

So `add(index, e)`/`remove(index)` are O(n) overall — same complexity class as `ArrayList`'s equivalent. The "O(1) insertion" story only holds when you're already holding a `ListIterator` positioned at the right spot.

## Why LinkedList looks attractive on paper but performs poorly in practice

**1. Big-O hides constants, and LinkedList's constants are brutal.** Every node access is a pointer dereference to a scattered heap location. Modern CPUs assume predictable memory access; hardware prefetchers detect linear-stride array access and pull upcoming cache lines ahead of time. Pointer-chasing defeats this — each `next` dereference is a near-guaranteed cache miss (100+ cycle stall), versus a near-free L1 hit for array access.

**Algorithmic complexity measures operation count, not wall-clock time.** Wall-clock time = operation count × real cost per operation, and real cost varies by 100x+ depending on cache behavior.

**2. Per-element memory overhead.** Each `Node<E>` costs ~32-48 bytes of pure bookkeeping overhead per element (header + 3 references), versus `ArrayList`'s single reference slot per element. For a million elements, that's tens of megabytes of pure overhead `ArrayList` doesn't pay — plus more GC pressure.

**3. No vectorization / SIMD-friendliness.** Bulk array operations use hardware-accelerated `memmove` intrinsics. There's no equivalent for pointer-chasing — every step is a genuinely sequential dependent load.

## Big-O vs actual performance — the general lesson

Big-O tells you how cost *scales*, not what the cost actually *is* at your n. Two structures with the same complexity class can differ by orders of magnitude in real wall-clock time due to cache locality, allocation patterns, branch prediction, and vectorization opportunity.

## So when is `LinkedList` actually the right choice?

Genuinely rare: a real `Deque`/`Queue` need where `ArrayDeque` doesn't fit for some specific reason; heavy insertion/removal in the middle of a large sequence via an already-positioned `ListIterator`; or a need for `null` elements with strict `Deque` semantics.

## Java 21 relevance

`LinkedList` implements `SequencedCollection` (via `List` and `Deque`), so `addFirst`/`addLast`/`getFirst`/`getLast`/`removeFirst`/`removeLast`/`reversed()` are available — but these mostly already existed via `Deque`. What Java 21 changes meaningfully is `List` in general (no `getFirst()` before) and `LinkedHashSet`/`LinkedHashMap` (no first/last API at all before).

---

# Part 4 — HashSet Deep Dive

`HashSet<E>` is a thin wrapper over `HashMap`:

```java
private transient HashMap<E, Object> map;
private static final Object PRESENT = new Object();
```

Every `HashSet` element is stored as a **key** in a backing `HashMap<E, Object>`, with a shared dummy sentinel value. `add(e)` is literally `map.put(e, PRESENT) == null`.

## The hashing pipeline

```
hashCode()
    ↓
hash spreading (spread function mixes high bits into low bits)
    ↓
bucket/index calculation (hash & (capacity - 1))
    ↓
bucket lookup (walk the bucket's chain/tree)
    ↓
equals() to confirm exact match
```

**`hashCode()`** — its job is only to bucket similar objects into different slots with reasonable distribution — not to be unique (pigeonhole principle guarantees collisions for a large enough input universe).

**Hash spreading**:

```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

Bucket index is `hash & (capacity - 1)` — only the low bits matter. XOR-folding the high 16 bits into the low 16 improves distribution for hash functions that vary mostly in high bits, without the cost of a cryptographic-strength hash.

**Bucket lookup** — each bucket holds a **chain** of colliding entries. Since Java 8, if a bucket's chain grows past 8 entries (and the table is ≥64 buckets), it's **treeified** into a small red-black tree, changing worst-case lookup in that bucket from O(n) to O(log n).

## Average O(1), worst-case behavior

Average case O(1) with good hash distribution. Pre-Java-8 worst case: O(n) (all elements in one bucket). Java 8+ worst case: O(log n) per affected bucket via treeification.

## Hash collision attacks

A real, historically-exploited vulnerability: if an attacker controls input used as keys/elements (HTTP params, JSON keys) and can craft values that all hash to the same bucket, they force O(1)-average operations into O(n), enabling CPU-exhaustion DoS. This is the actual historical motivation for Java 8 treeification.

## Load factor and resizing (preview)

Default load factor 0.75 — when `size > capacity * loadFactor`, the table doubles and rehashes. Full treatment in Part 5.

## Mutable elements — a genuinely dangerous trap

```java
class Point {
    int x, y;
    // equals/hashCode based on x, y
}

Set<Point> points = new HashSet<>();
Point p = new Point(1, 2);
points.add(p);          // stored in bucket computed from hash(1,2)

p.x = 99;                // mutate AFTER insertion

points.contains(p);      // likely false!
```

`contains(p)` recomputes `hashCode()` on `p`'s *current* state (x=99) to pick a bucket — but `p` physically still sits in the *old* bucket. The set looks in the wrong bucket entirely. This isn't a `HashSet` bug — it's a direct consequence of using mutable state as a hash key. Prefer immutable types (records) for anything used as a `HashSet` element or `HashMap` key.

## The `equals()`/`hashCode()` contract, stated precisely

1. If `a.equals(b)` is `true`, then `a.hashCode() == b.hashCode()` **must** hold.
2. `hashCode()` must be **consistent** across repeated calls on an unmodified object.
3. Violating rule 1 silently corrupts `HashSet`/`HashMap` behavior.


---

# Part 5 — HashMap Deep Dive

## Internal structure

```java
transient Node<K,V>[] table;   // the bucket array
transient int size;
int threshold;                  // resize trigger = capacity * loadFactor
final float loadFactor;         // default 0.75f
```

```java
static class Node<K,V> implements Map.Entry<K,V> {
    final int hash;
    final K key;
    V value;
    Node<K,V> next;   // singly-linked chain within a bucket
}
```

Plus, since Java 8, treeified nodes:

```java
static final class TreeNode<K,V> extends LinkedHashMap.Entry<K,V> {
    TreeNode<K,V> parent, left, right, prev;
    boolean red;
}
```

`table` is lazily allocated — a brand-new `HashMap<>()` has a `null` table until the first `put()`.

## Why power-of-two capacity matters

Default initial capacity 16; every resize doubles it. Bucket index:

```java
index = hash & (capacity - 1)
```

A bitmask, not modulo — only correct/uniform when capacity is a power of two, because `capacity - 1` is then a contiguous run of 1-bits. This is mathematically equivalent to `hash % capacity` but a single fast bitwise AND instead of a slower division/modulo instruction.

## Walking through `put("A", 10)` step by step

1. `table` is `null` → `resize()` allocates `table = new Node[16]`, `threshold = 12`.
2. Compute `hash = spread("A".hashCode())`.
3. Compute bucket index: `index = hash & 15`.
4. If `table[index]` is `null` → place new `Node("A", 10, hash)` directly. If not null → walk chain/tree comparing `hash` then `equals()`; replace value on match, else append.
5. Check `size > threshold` → trigger `resize()` after insertion if needed.

`get("A")` — same hash/index computation, walk the chain comparing hash then equals, no mutation, no resize check.

## Collision handling — chain vs tree

Chain search is O(k) for chain length k. **Treeification**: bucket chain reaches `TREEIFY_THRESHOLD` (8) **and** table capacity ≥ `MIN_TREEIFY_CAPACITY` (64) → converts to a red-black tree, O(log k) worst case within that bucket. The capacity-64 gate exists because a long chain in a small table is more likely "table too small overall" (fixed by resizing) than a genuine pathological collision. **Untreeification**: shrinks back to a chain if a treeified bucket drops to `UNTREEIFY_THRESHOLD` (6) during a resize.

If keys implement `Comparable`, that's used for tree ordering; otherwise `System.identityHashCode()` is the tiebreaker.

## Resizing — the full mechanism, and the clever bit-splitting trick

`resize()`: allocates a new table at 2× capacity (always doubling), recomputes threshold, rehashes every entry. Since capacity always doubles and index is `hash & (capacity - 1)`, going from capacity 16 to 32 means exactly **one additional bit** of the hash now participates. For any entry, its old and new index differ by at most that one bit — every entry in old bucket `i` goes to new bucket `i` or `i + oldCapacity`. The JDK splits each old bucket's chain into "lo" and "hi" chains in one pass based on that single bit, preserving relative order — cheaper than recomputing from scratch, though still O(n) overall.

## `put`, `get`, `remove`, `containsKey`

- `remove(k)`: hash, index, bucket walk, unlink, `size--`. **No resize on removal** — `HashMap` never shrinks its table automatically.
- `containsKey(k)`: same lookup path as `get`, but distinguishes "key absent" from "key present with `null` value," which `get()` alone can't.

## The computational family: `compute`, `computeIfAbsent`, `computeIfPresent`, `merge`, `putIfAbsent`

- **`putIfAbsent(k, v)`**: insert only if absent; one lookup instead of two.
- **`computeIfAbsent(k, fn)`**: canonical idiom for lazily-initialized nested collections — `map.computeIfAbsent(key, k -> new ArrayList<>()).add(item)`.
- **`computeIfPresent(k, fn)`**: only acts if present; can remove on `null` return.
- **`compute(k, fn)`**: unconditional; removes entry if function returns `null`.
- **`merge(k, value, fn)`**: classic counter idiom — `map.merge(key, 1, Integer::sum)`.

## Mutable keys — same trap as HashSet, worse blast radius

Identical mechanism to Part 4 — mutate a key's hash-relevant fields after insertion and the entry becomes unreachable via `get()`/`containsKey()`.

## Initial capacity and performance tuning

Pre-sizing avoids repeated resize-and-rehash passes. To hold N entries without resize: `capacity ≥ N / loadFactor`, rounded up to next power of two. Reliable formula: `new HashMap<>((int) (N / 0.75f) + 1)`.

---

# Part 6 — LinkedHashMap

## Internal structure — hash table + linked ordering, layered on HashMap

`LinkedHashMap<K,V>` **extends `HashMap<K,V>`** directly, adding a doubly-linked list threading through all entries:

```java
static class Entry<K,V> extends HashMap.Node<K,V> {
    Entry<K,V> before, after;   // the ordering linked list
}

transient LinkedHashMap.Entry<K,V> head, tail;
```

Lookup uses the *bucket* structure (O(1) average, same as `HashMap`). Iteration uses the *linked list* structure — O(1) per element regardless of table sparsity, unlike plain `HashMap` iteration.

## Insertion order vs access order

```java
new LinkedHashMap<>(initialCapacity, loadFactor, accessOrder)
```

- **`accessOrder = false`** (default): insertion order; re-inserting an existing key doesn't move it.
- **`accessOrder = true`**: access order; every `get()`/`put()` on an existing key moves it to the tail (via `afterNodeAccess()`). Note: access-order mode means `get()` has a side effect (relinking) — no longer a "pure" read.

## LRU caching via `removeEldestEntry()`

```java
protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
    return false; // default: never remove anything
}
```

A protected hook, called automatically after every `put()`/`putAll()`, passed the current head (eldest entry). Classic bounded LRU cache:

```java
class LruCache<K,V> extends LinkedHashMap<K,V> {
    private final int maxSize;

    LruCache(int maxSize) {
        super(16, 0.75f, true); // accessOrder = true
        this.maxSize = maxSize;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
        return size() > maxSize;
    }
}
```

The entire LRU eviction policy is a one-method override riding on infrastructure that already exists for other reasons.

## Limitations as a production cache

Not thread-safe (concurrent relinking can corrupt structure); no TTL/expiration; pure LRU only (no LFU, no weighted eviction); unbounded memory risk if `removeEldestEntry()` isn't overridden.

## Comparison: HashMap vs LinkedHashMap vs ConcurrentHashMap vs Redis

| | `HashMap` | `LinkedHashMap` | `ConcurrentHashMap` | Redis (external) |
|---|---|---|---|---|
| Ordering | none | insertion or access order | none | depends on structure |
| Thread safety | none | none | yes, fine-grained | yes (serialized) |
| Built-in LRU | no | yes | no | yes, configurable |
| Survives restart | no | no | no | yes |
| Shared across instances | no | no | no | yes — the killer feature |

The senior decision point: does this cache need to be shared across multiple app instances, or survive a restart? If yes, in-process caching is architecturally wrong regardless of tuning — you need Redis.

## Java 21 sequenced APIs on LinkedHashMap

```java
map.firstEntry();        // O(1), reads head
map.lastEntry();         // O(1), reads tail
map.pollFirstEntry();    // removes and returns first
map.pollLastEntry();     // removes and returns last
map.putFirst("z", 0);    // insert at front — new capability
map.putLast("y", 4);     // insert/move to end
SequencedMap<String,Integer> rev = map.reversed(); // live reversed VIEW
```

`putFirst`/`putLast` are genuinely new capability — pre-21 there was no way to force a key to the front of iteration order at all.

---

# Part 7 — TreeMap

## The structural shift

`TreeMap` is backed by a **red-black tree** — O(log n), no hashing anywhere, comparisons drive everything.

```java
private transient Entry<K,V> root;

static final class Entry<K,V> implements Map.Entry<K,V> {
    K key;
    V value;
    Entry<K,V> left, right, parent;
    boolean color = BLACK;
}
```

## Why balancing matters

A naive BST degenerates to a linked list under sorted-order insertion — O(n) lookup. Red-black trees guarantee O(log n) worst case regardless of insertion order.

## The red-black invariants

1. Every node is red or black.
2. Root is always black.
3. Red nodes cannot have red children.
4. Every root-to-leaf path has the same number of black nodes.
5. (Implied) Longest path ≤ twice the shortest — this caps height at O(log n).

## Rotations and rebalancing

**Left rotation** and **right rotation** — O(1) local restructurings preserving in-order traversal. Fixing any violation after insert/delete requires O(log n) rotations worst case (often O(1) amortized for inserts).

## `Comparator` vs natural ordering

```java
new TreeMap<K,V>();                     // requires K implements Comparable<K>
new TreeMap<K,V>(Comparator<K> cmp);    // uses supplied comparator
```

Every comparison goes through `compareTo`/`compare` — never `hashCode()`/`equals()`.

## Comparator consistency with `equals` — a real trap

`TreeMap` determines key identity via `compareTo == 0`, **not** `equals()`. If a comparator says two objects are "equal" (compare returns 0) but `.equals()` disagrees, `TreeMap` treats them as duplicate keys — second `put()` silently overwrites the first.

```java
Comparator<Person> byAge = Comparator.comparingInt(Person::getAge);
TreeMap<Person, String> map = new TreeMap<>(byAge);

map.put(new Person("Alice", 30), "engineer");
map.put(new Person("Bob", 30), "designer");   // same age!

map.size(); // 1, not 2
```

Fix with a tiebreaker: `Comparator.comparingInt(Person::getAge).thenComparing(Person::getName)`.

## Operations

- `put`/`get`/`remove`: O(log n).
- `firstKey()`/`lastKey()`: O(log n) — walk one path, not O(1) like `LinkedHashMap`.
- `floorKey`/`ceilingKey`/`lowerKey`/`higherKey`: O(log n) tree descents — the `NavigableMap` contribution.

## Range queries

```java
map.headMap(toKey);              // key < toKey
map.tailMap(fromKey);             // key >= fromKey
map.subMap(fromKey, toKey);       // [fromKey, toKey)
```

Live views, not copies — mutations propagate both ways within bounds.

## When TreeMap is the right choice

Sorted iteration order needed continuously; range queries (`floorKey`, `subMap`); continuously-maintained `firstKey()`/`lastKey()`.

## When it's the wrong choice

Reaching for `TreeMap` "for ordering" when you actually need insertion order (`LinkedHashMap`, O(1)) or a one-time sorted snapshot (`HashMap` + one `List` sort at read time) — `TreeMap`'s O(log n) tax on every write is a real, continuous cost only justified when genuinely exploiting ordering/range-query capability.


---

# Part 8 — Sets

## The unifying insight: every `Set` here is a `Map` wearing a trench coat

`HashSet` wraps `HashMap`; `TreeSet` wraps `TreeMap` (`NavigableMap<E,Object>` internally). `LinkedHashSet` extends `HashSet`, using a package-private constructor that builds a `LinkedHashMap` instead. All three inherit every performance characteristic already derived for their backing `Map`.

## The comparison

| | `HashSet` | `LinkedHashSet` | `TreeSet` | `EnumSet` | `CopyOnWriteArraySet` | `ConcurrentSkipListSet` |
|---|---|---|---|---|---|---|
| Backing | `HashMap` | `LinkedHashMap` | `TreeMap` | bit vector | `CopyOnWriteArrayList` | `ConcurrentSkipListMap` |
| Ordering | none | insertion/access | sorted | enum declaration order | insertion order | sorted |
| add/remove/contains | O(1) avg | O(1) avg | O(log n) | O(1) bit ops | O(n) write, O(1) read | O(log n) |
| Thread safety | none | none | none | none | fully thread-safe | fully thread-safe |
| Range queries | no | no | yes | no | no | yes |
| Null elements | one allowed | one allowed | not allowed | not allowed | allowed | not allowed |
| Best for | general default | uniqueness + order | uniqueness + sorted + range | fixed enum universe | read-heavy rare-write concurrent | sorted + concurrent |

## `EnumSet` — worth calling out specially

Not a wrapped `Map` at all — internally a **bit vector** (`long` for ≤64 constants, `long[]` beyond). `add`/`remove`/`contains` are literal bitwise operations — no hashing, no allocation per element. Full treatment in Part 17.

## `CopyOnWriteArraySet` — the odd one out structurally

Built on `CopyOnWriteArrayList` — `add()` does a linear O(n) `contains()` scan then, if absent, an O(n) full-array copy-and-append. Makes sense only for small sets, rarely written, frequently iterated concurrently (e.g. event listeners).

## Java 21: `SequencedSet`, `reversed()`, first/last operations

```java
set.getFirst(); set.getLast();
set.addFirst("z"); set.addLast("y");
SequencedSet<String> rev = set.reversed();
```

`LinkedHashSet` now implements `SequencedSet`. `TreeSet` also gains `SequencedSet` conformance (it already had most of this via `NavigableSet`). `HashSet` does **not** implement `SequencedSet` — no defined order to sequence.

## Building the selection framework

1. Do I need uniqueness at all, or actually a `List`?
2. Do I need any ordering guarantee? No → `HashSet`. Insertion/access order → `LinkedHashSet`. Full sort → `TreeSet`.
3. Range queries/navigation needed? → `TreeSet`.
4. Fixed, small, compile-time-known enum domain? → `EnumSet`.
5. Concurrency needed? Read-heavy small → `CopyOnWriteArraySet`. Sorted + concurrent → `ConcurrentSkipListSet`. General concurrent uniqueness at scale → `ConcurrentHashMap.newKeySet()`.
6. Read/write ratio and scale? Large + write-heavy + concurrent → avoid `CopyOnWriteArraySet`.
7. Memory sensitivity? `EnumSet`/`HashSet` cheapest; `TreeSet`/`ConcurrentSkipListSet` carry more per-node overhead.

---

# Part 9 — Queue and Deque

## `ArrayDeque` internals — the circular buffer

```java
transient E[] elements;
transient int head;
transient int tail;
```

A **fixed-size backing array used as a ring buffer**. Both indices wrap using modulo-power-of-two arithmetic:

```java
head = (head - 1) & (elements.length - 1);   // addFirst
tail = (tail + 1) & (elements.length - 1);   // addLast
```

By letting the "logical start" float and wrap within a fixed-size array, both ends become O(1) without ever shifting elements — unlike a plain array-backed deque starting at index 0.

## Growth

When `head`/`tail` collide, `ArrayDeque` **doubles** capacity (like `HashMap`) and copies into a new array, resetting `head = 0`.

## Why `ArrayDeque` beats `LinkedList`

Same Big-O (O(1) at both ends) as `LinkedList`, but with `ArrayList`-style cache locality and zero per-node object overhead. A rare case of a strictly dominant option, not a genuine trade-off. Caveat: no positional `get(index)`, and `null` elements are disallowed (used internally as a sentinel).

## Why `ArrayDeque` beats legacy `Stack`

`Stack extends Vector`, meaning every operation is `synchronized` — unnecessary overhead in single-threaded code, and *still insufficient* for genuine multi-threaded correctness as compound operations aren't atomic. Full comparison in Part 10.

## Queue vs Deque method families

| Operation | `Queue` (FIFO) | `Deque` as Queue | `Deque` as Stack |
|---|---|---|---|
| Insert | `offer(e)`/`add(e)` | `offerLast(e)`/`addLast(e)` | `push(e)` = `addFirst(e)` |
| Remove | `poll()`/`remove()` | `pollFirst()`/`removeFirst()` | `pop()` = `removeFirst()` |
| Peek | `peek()`/`element()` | `peekFirst()`/`getFirst()` | `peek()` = `peekFirst()` |

## Java 21 sequenced APIs

`Deque` already had first/last methods pre-21. Java 21 adds `reversed()` (a live reversed view) plus the unification benefit of `SequencedCollection`.

## Practical takeaway

Default to `ArrayDeque` for essentially all `Deque`/`Queue`/`Stack`-shaped needs. Reach for `LinkedList` only if you need `null` elements; reach for `Stack` essentially never.

---

# Part 10 — Stack

## What `Stack` actually is

```java
public class Stack<E> extends Vector<E>
```

Every method is `synchronized` — unconditional overhead even single-threaded, and insufficient for real multi-threaded correctness since compound operations (push then pop across threads) aren't atomic as a sequence.

## Why this is a legacy design, concretely

1. **Unconditional synchronization** — lock acquisition on every `push`/`pop`, zero benefit single-threaded.
2. **Extends `Vector`, not `Deque`** — inherits full `List` API (`get(index)`, `add(index,e)`), so nothing enforces LIFO discipline; a caller could reach in at an arbitrary index.
3. **Growth policy** — `Vector` doubles by default, a different, older design than `ArrayList`'s 1.5x.

## The comparison

| | `Stack` | `Deque` (interface) | `ArrayDeque` (implementation) |
|---|---|---|---|
| Backing | `Vector` | — | ring buffer |
| Thread safety | synchronized, not compound-safe | none guaranteed | none |
| API discipline | full `List` API exposed | LIFO-appropriate only | same |
| Null elements | allowed | interface-dependent | disallowed |
| Modern status | legacy | current, recommended | current, recommended |

## The modern Java 21 approach

```java
Deque<Integer> stack = new ArrayDeque<>();
stack.push(1); stack.push(2); stack.push(3);
stack.pop();      // 3
stack.peek();      // 2
```

Declare as `Deque<E>`, instantiate `ArrayDeque<>`. Correct LIFO semantics, no unnecessary synchronization, ring-buffer performance. Reach for actual `java.util.Stack` today only for legacy API compatibility.

---

# Part 11 — PriorityQueue

## The structural idea: a binary heap over an array

```java
transient Object[] queue;
private int size;
private final Comparator<? super E> comparator; // null → natural ordering
```

Java's `PriorityQueue` is a **min-heap by default** — `poll()` always returns the smallest element.

## The array-as-tree trick

```
parent  = (i - 1) / 2
left    = 2*i + 1
right   = 2*i + 2
```

A complete binary tree stored in a flat array with no pointers — implicit structure via index arithmetic.

## `offer()` — insertion via sift-up

Place at `queue[size]`, then **sift up**: compare to parent, swap if violating heap property, repeat toward root. O(log n).

## `poll()` — removal via sift-down

Move last element to root, shrink size, then **sift down**: compare to children, swap with smaller child if violating, repeat toward leaves. O(log n).

## `peek()` — O(1)

Just `queue[0]`.

## Heapify — building a heap from an existing collection

`new PriorityQueue<>(existingCollection)` uses **Floyd's heapify** — O(n), not O(n log n) — by sifting down from the last non-leaf node backward toward the root, exploiting that most nodes are near the bottom (low height, cheap sift-down).

## Complexity summary

| Operation | Complexity | Why |
|---|---|---|
| `offer(e)` | O(log n) | sift-up bounded by height |
| `poll()` | O(log n) | sift-down bounded by height |
| `peek()` | O(1) | root is always min |
| `remove(Object)` | O(n) | must linear scan first, heap gives no shortcut |
| `contains(Object)` | O(n) | same |
| construction from collection | O(n) | Floyd's heapify |

## Why iteration is NOT sorted — the trap in the name

```java
PriorityQueue<Integer> pq = new PriorityQueue<>(List.of(5, 1, 4, 2, 3));
for (int x : pq) { ... }   // NOT guaranteed sorted order
```

`iterator()` walks raw array (heap) order. The heap property only guarantees the *root* is the minimum — nothing about sibling/cross-subtree order. Only repeated `poll()` yields sorted output.

## Applications

**Top-K / Kth largest-smallest**: maintain a min-heap of size K while scanning — O(n log K).
**Scheduling/priority processing**: task schedulers, Dijkstra's/Prim's.
**Merging K sorted streams**: min-heap of K heads — O(n log K).


---

# Part 12 — Immutable and Unmodifiable Collections

## `List.of()`, `Set.of()`, `Map.of()` — truly immutable, from scratch

Genuinely immutable — every mutating method throws `UnsupportedOperationException` unconditionally, forever. No reference anywhere can mutate the instance. Rejects `null` elements at construction (immediate NPE). `Set.of()` throws `IllegalArgumentException` on duplicate elements rather than silently deduplicating.

## `List.copyOf()`, `Set.copyOf()`, `Map.copyOf()` — immutable snapshot

```java
List<String> mutable = new ArrayList<>(List.of("a", "b"));
List<String> snapshot = List.copyOf(mutable);
mutable.add("c");
snapshot.size(); // still 2
```

A genuine **defensive copy** — independent, immutable, unaffected by later source mutation. If called on something already immutable, the JDK returns the **same instance** rather than copying again.

## `Collections.unmodifiableList()` etc. — a VIEW, not a copy

```java
List<String> mutable = new ArrayList<>(List.of("a", "b"));
List<String> view = Collections.unmodifiableList(mutable);
view.add("c");        // throws UnsupportedOperationException
mutable.add("c");     // succeeds!
view.size();           // 3 — the view SAW the mutation
```

Blocks mutation *through the view*, but not through any other reference to the same backing list. A real, common production bug: exposing an "unmodifiable" view while still mutating the backing collection elsewhere.

## Precise vocabulary

| Term | Meaning |
|---|---|
| Mutable | can be changed through any reference |
| Immutable | cannot be changed through *any* reference, ever |
| Unmodifiable | cannot be changed *through this specific reference* only |

## Defensive copying, aliasing, and API design

Three options for exposing internal state: (1) raw mutable reference — worst; (2) unmodifiable view — blocks external mutation but still leaky if internally mutated; (3) defensive copy/immutable snapshot — the only option that genuinely delivers on "immutable" as a promise.

## Thread safety implications

Genuine immutability gives thread safety for free — no mutable state to race on. Unmodifiable views give none of this if the backing collection is mutated concurrently by another thread.

## Memory

`List.of()` etc. use specialized zero/one/two-element implementations avoiding even general array overhead, with no growth slack. `Collections.unmodifiableList()` allocates only a thin wrapper — cheap because it protects nothing structurally.

---

# Part 13 — Concurrent Collections

## Why plain `HashMap` is unsafe under concurrency — precisely

**Lost updates**: concurrent writers can corrupt bucket-chain pointers, causing entries to silently disappear. **Infinite loops during resize** (the classic Java 7-and-earlier bug): old prepend-based rehashing could produce a circular chain under concurrent resize, pegging a CPU core at 100%. Java 8's redesigned resize (lo/hi bit-split, preserves order) avoids this specific bug but concurrent mutation is still fundamentally unsafe. **Torn reads**: iterating during concurrent mutation can throw `ConcurrentModificationException` or see inconsistent state.

## `ConcurrentHashMap` — the Java 8+ architecture

Pre-Java-8: **segment-based locking** (16 segments, coarse). Java 8 redesign:

**1. CAS for the common case** — inserting into an empty bucket uses `compareAndSwapObject`, no lock at all.

**2. Bin-level (per-bucket) locking** — collisions synchronize on that bucket's head node only, not the whole table.

**3. Volatile reads for `get()`** — no locking at all, ever; safe because nodes are effectively append-only once published.

**4. Cooperative, multi-threaded resizing** — any thread calling `put()` during a resize can help migrate buckets in parallel via `ForwardingNode` sentinels, distributing resize cost across active threads rather than one long serial pause.

## `compute`, `merge`, `putIfAbsent` — where atomicity actually matters

```java
// WRONG — race condition
if (!map.containsKey(key)) { map.put(key, computeExpensiveValue()); }

// CORRECT — atomic per-key
map.computeIfAbsent(key, k -> computeExpensiveValue());
```

Caveat: the mapping function runs while holding that bin's lock — must be fast and must not recursively mutate the same map (deadlock/infinite-loop risk).

## Comparison table

| | `HashMap` + manual sync | `Collections.synchronizedMap()` | `ConcurrentHashMap` |
|---|---|---|---|
| Locking granularity | whatever you write | whole-map, single lock | per-bin, CAS for empty-bin |
| Read concurrency | blocked by writers | blocked | not blocked — lock-free |
| Compound-op safety | only if you wrap it | still racy | atomic via compute/merge |
| Iteration | must externally sync | must externally sync | weakly consistent, never throws CME |
| Null keys/values | allowed | allowed | disallowed |

`ConcurrentHashMap` bans `null` because `get() == null` would be ambiguous under concurrency (absent vs present-with-null), and the disambiguation pattern (follow-up `containsKey`) is unreliable when another thread can mutate between calls.

## The other concurrent collections

**`ConcurrentLinkedQueue`/`Deque`** — lock-free, CAS-based (Michael-Scott lineage), unbounded.

**`ConcurrentSkipListMap`/`Set`** — concurrent sorted analog to `TreeMap`/`TreeSet`, built on a **skip list** rather than a red-black tree specifically because skip lists are far more amenable to lock-free concurrent implementation. Expected O(log n), probabilistic height.

**`BlockingQueue` family** — full treatment in Part 15.

## Practical decision guidance

`ConcurrentHashMap` is close to the unconditional default for "thread-safe map." Reach elsewhere for sorted+concurrent (`ConcurrentSkipListMap`) or when `null` support is genuinely needed.

---

# Part 14 — CopyOnWrite Collections

## The core mechanism, precisely

```java
private transient volatile Object[] array;
```

Every write: acquire lock → read current array → allocate brand new array, copy relevant contents → apply mutation → `this.array = newArray` (single volatile write) → release lock. **Every write copies the entire backing array**, always O(n).

## Why reads need no locking at all

Because `array` is `volatile`, readers see a complete, consistent array — either pre- or post-write, never torn. Once mutation never touches memory a reader is looking at (writers always build a new array), reads are safe without locking.

## Snapshot iterators

The iterator captures the `array` reference once, at creation. **Never throws `ConcurrentModificationException`, by construction** — it's walking a private, frozen snapshot. Trade-off: won't reflect any writes after the iterator was created.

## Memory cost — worth quantifying

Every write allocates a full new array of size ~n. m writes to a list stabilizing at size n ≈ m × n array slots allocated over that period — real, non-trivial GC pressure under any non-trivial write rate.

## Write cost in context

`ArrayList.add()` is amortized O(1) because slack capacity absorbs future writes. `CopyOnWriteArrayList.add()` copies **every single write, unconditionally** — no equivalent slack concept, since every write must produce a fresh array for the safe-publish mechanism to work.

## `CopyOnWriteArraySet`

Just `CopyOnWriteArrayList` underneath, with `add()` doing an O(n) `contains()` scan before the O(n) copy-and-append — two O(n) passes instead of one.

## Production examples

**Event listeners/observers** — rare writes, frequent iteration, snapshot semantics align with "don't crash mid-dispatch." **Configuration listeners/rarely-changing registries** — similar shape.

## Where it's a trap

Any workload with genuinely frequent writes at scale — O(n) copy cost compounding into severe throughput collapse and GC pressure.

---

# Part 15 — BlockingQueue

## The core idea: a queue that can make a thread wait

```java
void put(E e) throws InterruptedException;     // blocks if full
E take() throws InterruptedException;            // blocks if empty
boolean offer(E e, long timeout, TimeUnit unit) throws InterruptedException;
E poll(long timeout, TimeUnit unit) throws InterruptedException;
```

Four insertion/removal styles total: throw-on-failure, return-special-value, block-indefinitely, block-with-timeout.

## Producer-consumer, concretely

Producers call `put()`, consumers call `take()`. Internal locking (`ReentrantLock` + two `Condition`s) handles all coordination — no manual wait/notify needed.

## Backpressure — why bounded queues matter architecturally

An **unbounded** queue means producers can never be forced to slow down — under sustained overload, the queue grows without bound until `OutOfMemoryError`. A **bounded** queue makes `put()` block once full, forcing the imbalance to become visible rather than hidden inside an ever-growing queue. **An unbounded queue anywhere in a system is a deferred OOM, not a convenience.**

## The implementations

**`ArrayBlockingQueue`** — fixed-size circular array, always bounded, **single shared lock** for both put/take (with optional fairness).

**`LinkedBlockingQueue`** — linked nodes, optionally bounded, **two separate locks** (put-side, take-side) — generally better throughput than `ArrayBlockingQueue` under heavy concurrent load.

**`PriorityBlockingQueue`** — unbounded wrapper around `PriorityQueue`'s heap; `put()` never actually blocks (no "full" state); same "iteration not sorted" caveat.

**`DelayQueue`** — unbounded, elements implement `Delayed`; `take()` blocks until the head's delay expires even if non-empty. Use case: scheduled retries, cache expiration.

**`SynchronousQueue`** — **zero capacity**; `put()` must rendezvous directly with a waiting `take()`. Used internally by `Executors.newCachedThreadPool()`.

## Fairness

FIFO ordering among threads contending for the lock (not the data itself, which is always ordered appropriately regardless). Real throughput cost for the fairness guarantee.

## Relating this to backend systems

Thread pool work queues (bounded vs unbounded is a direct architectural decision), in-process producer-consumer pipelines, rate limiting/load shedding via natural backpressure.


---

# Part 16 — WeakHashMap and Reference-Based Collections

## The reference strength spectrum

**Strong references** — the default; unconditionally ineligible for collection while reachable. Every collection covered so far holds strong references.

**Weak references** (`WeakReference<T>`) — don't keep an object alive; collected at the next GC cycle if only weakly reachable. `WeakHashMap` uses these for its **keys**.

**Soft references** (`SoftReference<T>`) — collected under memory pressure, typically only just before OOM. No standard JDK collection is built directly on these, but cache libraries use them.

**Phantom references** (`PhantomReference<T>`) — for post-finalization cleanup notification; `get()` always returns `null`. Niche.

## How `WeakHashMap` actually works

Each entry's **key** is wrapped in a `WeakReference`; the **value** is held strongly. If nothing else strongly references the key, the entry becomes eligible for removal, cleaned up **lazily** on subsequent map operations via an internal `ReferenceQueue`.

## Canonicalization — the use case it's actually good at

Bookkeeping data whose lifetime should be tied to something you don't own the lifecycle of (e.g., metadata keyed by a dynamically-generated `Class` object) — so the map entry disappears automatically when the associated object becomes unreachable, with no manual cleanup.

## Why it should NOT casually be used as a general-purpose cache

A cache's purpose is usually to keep something alive; `WeakHashMap`'s mechanism is to *not* keep it alive on the map's account — the opposite goal. Entries can vanish before ever producing a cache hit, non-deterministically, based on unrelated GC timing. For actual caching, use soft references or (better) a bounded LRU/proper caching library (Caffeine).

---

# Part 17 — EnumMap and EnumSet

## Why enums enable a fundamentally different implementation

The complete universe of possible keys is fixed, small, and known at compile time — every constant has a dense, contiguous `ordinal()`.

## `EnumSet` internals — the bit vector

**`RegularEnumSet`** (≤64 constants): a single `long`, one bit per constant. `add`/`remove`/`contains` are single bitwise instructions — no hashing, no allocation. **`JumboEnumSet`** (>64): backed by `long[]`.

Set operations (union/intersection/complement) become word-level bitwise ops across the whole set — O(1)-ish for the common case.

## `EnumMap` internals — parallel arrays indexed by ordinal

```java
private transient Object[] vals;
```

`vals[k.ordinal()]` directly holds the value. `put`/`get` are O(1) with a trivial constant — single array index, no hashing, no `equals()` ever needed. Iteration order is naturally ordinal (declaration) order, for free.

## Comparison: EnumSet/EnumMap vs HashSet\<Enum\>/HashMap\<Enum,V\>

Per-element overhead: **zero** (a bit) for `EnumSet` vs a full `Node` for `HashSet`; one array slot for `EnumMap` vs a full `Node` for `HashMap`. Iteration order: ordinal order (always) vs unspecified.

## The practical rule

If your key/element type is an enum, `EnumMap`/`EnumSet` should be the **default**, not an optimization considered later — strictly better on every axis with zero API ergonomics lost.

---

# Part 18 — Iterators

## `Iterator` and `ListIterator` — the contracts, revisited

`ListIterator` adds bidirectional traversal and in-place mutation — meaningful only for `List`, since `Set`/`Map` views have no positional "previous" or index-based insert.

## The mechanism: `modCount`

```java
protected transient int modCount = 0;
```

Every structural modification increments `modCount` (not `set(index,e)` — value replacement isn't structural). An iterator snapshots `expectedModCount` at creation; every `next()` checks `modCount != expectedModCount` and throws `ConcurrentModificationException` if so. The iterator's own `remove()`/`add()` updates `expectedModCount` to stay in sync.

## Why this is fail-**fast**, not fail-safe

A **best-effort**, single-threaded debugging aid — converts silent corruption into an immediate, loud exception.

## The classic trap

```java
for (Integer i : list) {
    if (i == 3) list.remove(i);   // NOT through the iterator
}
// throws ConcurrentModificationException
```

Fixes, in preference order: iterator's own `remove()`; `removeIf()`; collect-then-`removeAll()`.

## "Fail-fast does NOT mean thread-safe"

`modCount` is a single-threaded correctness aid with **zero memory-visibility guarantees across threads**. Concurrent modification might throw CME, might throw an unrelated exception, or might silently corrupt with no exception at all. It was never designed as a synchronization mechanism.

## `iterator.remove()` mechanics

On `ArrayList`, still an O(n) shift internally — the iterator doesn't avoid the cost, just keeps its own bookkeeping consistent. On `LinkedList`, genuinely O(1) once positioned.

---

# Part 19 — Spliterator and Streams

## Why `Iterator` wasn't enough for Streams

Parallel execution needed a **splitting** primitive — `Spliterator` ("splittable iterator") was purpose-built for this.

## The core methods

```java
boolean tryAdvance(Consumer<? super T> action);
void forEachRemaining(Consumer<? super T> action);
Spliterator<T> trySplit();
long estimateSize();
int characteristics();
```

`trySplit()` partitions off a prefix into a new spliterator, mutating `this` to cover the remainder. Returns `null` when unsplittable.

## `ArrayList`'s spliterator — splitting concretely

Tracks `origin`/`fence` indices; `trySplit()` is O(1) arithmetic — no copying. This is why array-backed sources parallelize predictably; linked/hash sources split less cheaply or less evenly.

## Characteristics — the optimization hint bits

`ORDERED`, `DISTINCT`, `SORTED`, `SIZED`, `SUBSIZED`, `NONNULL`, `IMMUTABLE`, `CONCURRENT` — let the Streams framework skip defensive work (e.g. `sorted()` becomes a no-op if `SORTED` is already known).

## When parallel streams help — and when they're a trap

**Help when**: source splits cheaply/evenly; per-element work is substantial; operation is stateless/side-effect-free; dataset is genuinely large.

**Dangerous when**: the shared common `ForkJoinPool` gets starved by unrelated blocking work elsewhere in the same JVM; ordered operations lose their advantage (`forEachOrdered()` reintroduces cost); blocking I/O inside a parallel stream ties up scarce shared threads; small/cheap-per-element workloads regress from coordination overhead.

## The practical rule

Default to sequential streams. Reach for `.parallel()` only with an articulated, *measured* justification.


---

# Part 20 — Generics + Collections

## Why generics exist for collections specifically

Pre-generics, every collection held `Object`, requiring unchecked casts that could fail at runtime far from the mistake. Generics move type errors to compile time.

## Type erasure

`List<String>` and `List<Integer>` are the same class at runtime. Consequences: can't do `new T[10]` in a generic class; `instanceof` doesn't work with parameterized types; can't overload on erased-equivalent generic signatures; generic type args aren't available via reflection on an instance.

## Invariance — the default, and why it's not a bug

```java
List<Object> objs = new ArrayList<String>(); // does NOT compile
```

Java generics are invariant by default — deliberately, to prevent inserting a wrong type through a widened reference and getting a `ClassCastException` later, elsewhere.

## Covariance and contravariance via wildcards

**`? extends T`** — covariant, safe to read, unsafe to write (beyond `null`).
**`? super T`** — contravariant, safe to write a `T`, unsafe to read a specific type back (beyond `Object`).

## PECS — Producer Extends, Consumer Super

```java
static <T> void copy(List<? super T> dest, List<? extends T> src)
```

`src` only produces (read from) → `extends`. `dest` only consumes (written to) → `super`.

## Bounded wildcards and generic methods together

```java
static <T extends Comparable<? super T>> T max(Collection<? extends T> coll)
```

`Collection<? extends T>` — a producer, so `extends`. The `Comparable<? super T>` bound accommodates hierarchies where only a common superclass implements `Comparable`.

## The practical takeaway for API design

Read-only parameter → `? extends T`. Write-only → `? super T`. Both read and write → plain `T`, no wildcard.

---

# Part 21 — equals() and hashCode()

## Object identity vs logical equality

`Object`'s default `equals()` is `==` (reference identity). Most domain classes want logical equality instead, requiring overriding both `equals()` and `hashCode()`.

## The `equals()` contract, precisely

Reflexive, symmetric, transitive, consistent, and `x.equals(null)` is always `false`.

## The `hashCode()` contract, precisely

Consistency across repeated calls; and the load-bearing rule: **if `a.equals(b)`, then `a.hashCode() == b.hashCode()` must hold.** The reverse is NOT required — unequal objects may share a hash (a collision, handled by bucket chains).

## Records — why they're a natural fit here

Java 21 records auto-generate contractually-correct `equals()`/`hashCode()`, and are implicitly immutable — directly closing the mutable-hash-key trap.

## Demonstration: mutating equality-relevant state after insertion into a `Set`

```java
Set<MutablePoint> points = new HashSet<>();
MutablePoint p = new MutablePoint(1, 2);
points.add(p);                      // placed in bucket B (from hash(1,2))

points.contains(p);   // true

p.x = 99;              // mutate AFTER insertion

points.contains(p);   // false! looks in a DIFFERENT bucket now
points.size();         // 1 — p is still physically present
// iteration finds p fine — it walks every bucket sequentially
points.remove(p);     // false! same wrong-bucket problem — p is stuck forever
```

`contains`/`remove` recompute the hash fresh each time and look in the *current* (wrong) bucket, while `p` physically still sits in its *original* bucket. Not a `HashSet` bug — a direct consequence of the contract requiring hash stability for the object's entire membership.

## Collection corruption — the general lesson

Any collection whose internal structure depends on a property of its elements (hash, comparison result) requires that property to remain stable for the entire membership duration. Prefer immutable types/records; treat hash/comparison-relevant fields as effectively final once inserted otherwise.

---

# Part 22 — Complexity and Performance

## The comprehensive comparison table

| | Lookup | Insert | Remove | Contains | Iteration | Ordering | Memory/element |
|---|---|---|---|---|---|---|---|
| **ArrayList** | O(1) idx | O(1) amort (end)/O(n) | O(n) | O(n) | O(n), cache-friendly | none | low |
| **LinkedList** | O(n) | O(1) ends/O(n) arb | O(1) ends/O(n) arb | O(n) | O(n), cache-hostile | none | high |
| **HashSet** | — | O(1) avg | O(1) avg | O(1) avg | O(capacity) | none | medium |
| **LinkedHashSet** | — | O(1) avg | O(1) avg | O(1) avg | O(n), ins/access order | insertion/access | med-high |
| **TreeSet** | — | O(log n) | O(log n) | O(log n) | O(n), sorted | full sort+range | high |
| **HashMap** | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(capacity) | none | medium |
| **LinkedHashMap** | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(n), ordered | insertion/access | med-high |
| **TreeMap** | O(log n) | O(log n) | O(log n) | O(log n) | O(n), sorted | full sort+range | high |
| **PriorityQueue** | O(1) min | O(log n) | O(log n) top/O(n) arb | O(n) | O(n), heap order | none in iteration | low |
| **ArrayDeque** | — | O(1) both ends | O(1) both ends | O(n) | O(n), cache-friendly | insertion order | low |
| **ConcurrentHashMap** | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(capacity), weak | none | medium+ |

## Going beyond Big-O

```
real wall-clock cost = (operation count, per Big-O) × (cost per operation)

cost per operation depends on:
    - cache locality
    - memory allocation pattern
    - branch prediction
    - vectorization opportunity
    - lock/CAS contention
    - JIT optimization ability
```

## Concrete illustrations

`ArrayList` vs `LinkedList` iteration: same O(n), but 5-20x real difference from cache locality and per-element overhead. `HashMap.get()`: nominal O(1) assumes well-distributed hash — poor `hashCode()` degrades real performance regardless of load factor. `ArrayDeque` vs `ConcurrentLinkedQueue` uncontended: CAS/volatile machinery is pure overhead when no real contention exists.

## The synthesis formula

```
Big-O + constants + memory layout + allocation pattern + cache locality + CPU behavior + contention = actual production performance
```

---

# Part 23 — JVM and Memory Perspective

## The object header — the fixed tax every object pays

Mark word (8 bytes) + klass pointer (4 bytes compressed / 8 uncompressed) = 12-16 bytes minimum before any field data, plus 8-byte alignment padding.

## References — compressed oops

4-byte references on typical heap sizes (under ~32GB), 8-byte beyond that threshold or with compression disabled.

## Boxing and unboxing — the mechanism, and its collection-specific cost

```java
List<Integer> list = new ArrayList<>();
for (int i = 0; i < 1_000_000; i++) { list.add(i); }   // autobox: Integer.valueOf(i)
```

Each boxed `Integer` costs ~16 bytes of heap for logically 4 bytes of data — real GC pressure and scattered-heap cache-locality cost.

## Integer caching — the exception that proves the rule

```java
Integer a = 100; Integer b = 100; a == b;   // true — cached (-128..127)
Integer c = 200; Integer d = 200; c == d;   // false — not cached
```

Always use `.equals()`, never `==`, for boxed comparison.

## `List<Integer>` vs `int[]` — the full, concrete contrast

`int[]` of a million ints: ~4MB contiguous, zero boxing, fully cache/prefetcher-friendly, vectorizable. `List<Integer>`: ~4MB for references **plus** up to ~16MB scattered across boxed objects — roughly **5x** the memory, with a pointer-chase per element and no vectorization. Prefer primitive arrays for large-scale numeric hot paths; `List<Integer>` is fine for everyday, non-hot-path code.

## GC, allocation, and object churn

Every extra per-node/per-boxed-value object is simultaneously a memory-footprint cost and a GC-frequency/pause cost.

---


# Part 24 — Java 21 Collections and API Design

## The central design question: what does your API actually promise?

Can the caller mutate what they got back? Will it stay in sync with internal state? Can they rely on iteration order?

## Returning interfaces, not concrete types

```java
public List<Order> getOrders() { ... }   // prefer this
public ArrayList<Order> getOrders() { ... }  // over this — leaks implementation detail
```

## Returning immutable values as the default posture

```java
public List<Order> getOrders() {
    return List.copyOf(orders);   // genuine snapshot
}
```

## Defensive copying at both boundaries

```java
public record OrderSummary(List<Order> orders) {
    public OrderSummary {
        orders = List.copyOf(orders);   // compact constructor — defend before assignment
    }
}
```

## API contracts — being explicit, not just implicit-via-convention

Document: mutable or not, live view or snapshot, repeated-call behavior, nullability.

## Sequenced interfaces in API design

```java
public SequencedCollection<AuditEntry> getAuditTrail() { ... }
```

Communicates first/last/reversed guarantees via the type itself, not just prose.

## Modernizing a legacy-style API — worked example

```java
// Legacy
public HashMap<String, Object> getData() { return data; }   // leaked type, live mutable ref

// Java 21 modernized
public SequencedMap<String, Object> getData() {
    return Collections.unmodifiableSequencedMap(data);   // preserves SequencedMap contract
}
public Object getFirstInserted() {
    var entry = data.firstEntry();   // O(1)
    return entry == null ? null : entry.getValue();
}
```

## The design checklist

(1) Am I leaking a concrete type? (2) Live reference, unmodifiable view, or snapshot — documented? (3) Does the return type communicate meaningful order via `SequencedCollection`/`Set`/`Map`? (4) Am I defensively copying on the way in?

---

# Part 25 — Collections + Virtual Threads

## What virtual threads actually change

Virtual threads (JEP 444, Java 21) are cheap, JVM-managed threads that unmount from their carrier platform thread on blocking operations. This is purely a **scheduling** innovation — it does not change the Java Memory Model or what "thread-safe" means.

## The central warning

**Virtual threads do not make non-thread-safe collections thread-safe.** A `HashMap` doesn't know or care whether the threads touching it are virtual or platform — its internal state has no synchronization either way.

## Shared mutable state — the actual risk surface

Virtual threads enable dramatically higher concurrency, which makes latent races in shared collections **more likely to surface**, not less — code that "worked" under 200 platform threads can fail visibly under 50,000 virtual threads.

## Contention — where virtual threads do interact meaningfully

Blocking on `synchronized` can historically **pin** a virtual thread to its carrier (largely improved in Java 21, but some edge cases like `Object.wait()`/`notify()` retained caveats). Coarse single-lock structures (`Collections.synchronizedMap()`, `ArrayBlockingQueue`'s shared lock) become **worse** bottlenecks at high virtual-thread concurrency — making `ConcurrentHashMap`'s fine-grained locking and `LinkedBlockingQueue`'s split locks more valuable, not less.

## Blocking queues under virtual threads

`BlockingQueue.take()`/`put()` blocking is exactly the kind of operation virtual threads handle well (favorable unmounting, not pinning-prone) — producer-consumer patterns with backpressure scale genuinely well.

## Summary judgment

Virtual threads change nothing about which collections need thread-safety, but they change the *scale* at which contention and pinning become visible.

---

# Part 26 — Real Production Patterns

## Caching

Simple bounded, single-threaded: `HashMap`. LRU, single-threaded: `LinkedHashMap` + `removeEldestEntry()`. Concurrent, moderate scale: `ConcurrentHashMap` + manual eviction, or a real library (Caffeine) once TTL/weighted eviction is needed. Config cache, read-heavy: `ConcurrentHashMap` or the atomic-reference-swap pattern (`AtomicReference<Map<K,V>>` swapped wholesale on refresh).

## Deduplication

Single-threaded: `HashSet`/`LinkedHashSet`/`TreeSet` per Part 8's framework. Concurrent: `ConcurrentHashMap.newKeySet()` over `CopyOnWriteArraySet` for anything beyond small/rare-write sets.

## Ordering

Continuous insertion order: `LinkedHashMap`/`Set`. Continuous sort + range queries: `TreeMap`/`Set`. One-time sorted output: `ArrayList` + `Collections.sort()`.

## Queues

Simple in-process: `ArrayDeque`. Priority-ordered: `PriorityQueue`. Producer-consumer with backpressure: bounded `ArrayBlockingQueue`/`LinkedBlockingQueue`. High-throughput, no blocking needed: `ConcurrentLinkedQueue`.

## Counters — the full trade-off table

Single-threaded: `Map<K,Integer>` + `merge(key, 1, Integer::sum)`. Concurrent, low contention per key: `ConcurrentHashMap<K, AtomicInteger>`. Concurrent, high contention on the same counter: `ConcurrentHashMap<K, LongAdder>` — striped internal cells trade slightly higher memory/read cost for dramatically better write throughput under real contention. Plain `ConcurrentHashMap<K,Integer>` via `compute()`: correct but allocates a new boxed `Integer` on every increment — avoidable churn.

---

# Part 27 — Common Senior-Level Mistakes

Each follows: why it's made → what happens → consequence → better approach.

1. **Using `LinkedList` because insertion is O(1).** Ignores real-world cache-hostile constants (Part 3). → Default to `ArrayList`/`ArrayDeque`.
2. **Using `HashMap` when ordering is required.** Iteration order is unspecified and can silently change. → `LinkedHashMap`/`TreeMap`.
3. **Using `TreeMap` unnecessarily.** Pays O(log n) continuously for a benefit only used occasionally. → `HashMap` + one-time sort.
4. **Synchronizing collections blindly.** `Collections.synchronizedX()` still leaves compound operations racy. → `ConcurrentHashMap` with atomic compound methods.
5. **Misusing `ConcurrentHashMap`.** Nested mutation inside `compute`-family lambdas can deadlock. → keep mapping functions fast, non-recursive.
6. **Mutating `HashMap`/`HashSet` keys after insertion.** Entry becomes unreachable via lookup while still physically present. → immutable keys/records.
7. **Assuming fail-fast means thread-safe.** `modCount` has zero cross-thread visibility guarantees. → genuinely concurrent collections.
8. **Assuming `PriorityQueue` iteration is sorted.** Only `poll()` yields sorted order. → drain via `poll()` loop.
9. **Blindly using parallel streams.** Coordination overhead, shared pool contention, ordering loss, correctness bugs from shared mutable state. → default sequential, measure first.
10. **Using `CopyOnWriteArrayList` for write-heavy workloads.** O(n) copy per write. → reserve for read-heavy, rarely-mutated, small collections.
11. **Using `WeakHashMap` as a normal cache.** Entries can vanish before ever being hit. → soft references or a proper bounded/evicting cache.
12. **Ignoring initial `HashMap` capacity.** Repeated resize-and-rehash cycles while bulk-loading. → pre-size with `(N/0.75f)+1`.
13. **Excessive boxing.** ~16 bytes per boxed value for 4 bytes of data, scattered on the heap. → primitive arrays for numeric hot paths.
14. **Returning mutable collections from APIs.** Callers can corrupt internal state directly. → `List.copyOf` or documented unmodifiable view.
15. **Exposing internal collection state (aliasing).** Caller's later mutation of a handed-in collection retroactively corrupts your state. → defensive copy on the way in and out.
16. **Confusing immutable and unmodifiable collections.** An "unmodifiable" view still reflects mutation through other references. → use precise vocabulary; default to genuine immutability when stability is actually needed.
17. **Ignoring Java 21 Sequenced Collections.** Hand-rolling first/last/reversal logic Java 21 now provides directly. → `getFirst()`/`getLast()`/`reversed()`/`SequencedCollection`.


---

# Part 28 — Collection Selection Framework

## The decision tree

```
1. What's the DOMINANT access pattern?
   ├── Positional/indexed access needed?          → List family
   ├── Membership/uniqueness is the point?          → Set family
   ├── Key→value association needed?                → Map family
   └── Process-in-order / FIFO-LIFO-priority?        → Queue/Deque family

2. Is UNIQUENESS required?
   ├── No  → List, or a Map's values
   └── Yes → Set, or a Map's keys

3. Is ORDERING required, and what kind?
   ├── None                    → Hash-based (HashSet/HashMap)
   ├── Insertion or access order → Linked (LinkedHashSet/LinkedHashMap)
   ├── Full sort order, always   → Tree (TreeSet/TreeMap)
   └── Priority (process next, not full order) → PriorityQueue

4. Are RANGE QUERIES / navigation needed?
   └── Yes → TreeSet/TreeMap (or ConcurrentSkipListMap/Set if also concurrent)

5. Is the domain a FIXED, SMALL, KNOWN-AT-COMPILE-TIME enum?
   └── Yes → EnumSet/EnumMap, essentially unconditionally

6. Is CONCURRENCY genuinely required?
   ├── No  → plain implementations
   └── Yes → what's the READ/WRITE RATIO and SCALE?
             ├── Read-heavy, rarely mutated, small           → CopyOnWriteArrayList/Set
             ├── General-purpose concurrent map/set at scale → ConcurrentHashMap / .newKeySet()
             ├── Sorted + concurrent                          → ConcurrentSkipListMap/Set
             ├── Lock-free queue, no blocking needed          → ConcurrentLinkedQueue/Deque
             └── Producer-consumer, need blocking/backpressure → BlockingQueue family (bounded)

7. What's the MEMORY profile?
   ├── Primitive-heavy, hot path, large n → primitive arrays
   ├── Enum-keyed                          → EnumMap/EnumSet
   └── General case                        → accept Node/Entry overhead

8. What EXPECTED SCALE?
   → Small: almost any choice performs fine.
   → Large: every overhead byte and O(log n) vs O(1) difference compounds.

9. FINALIZE the choice, and state the TRADE-OFF explicitly.
```

## Worked example

**Requirement:** *"We need a thread-safe, mostly-read collection with predictable iteration behavior and minimal write frequency."*

Step 1: iteration/reads dominant. Step 3: "predictable iteration behavior" → stable order needed. Step 6: thread-safe + explicitly read-heavy/rare-write → `CopyOnWriteArrayList`'s exact target profile; its snapshot-iterator behavior delivers the "predictable" requirement directly.

**Answer: `CopyOnWriteArrayList`** (or `Set` if uniqueness matters), trade-off explicitly stated: O(n) write cost and "snapshot, not live" iteration in exchange for lock-free reads and an iterator that can never throw CME — justified because writes are stated to be rare.

## Why the order of the tree matters

Structural family (List vs Set vs Map vs Queue) mistakes are usually much harder to fix later than implementation-within-family mistakes (e.g. `HashMap` vs `ConcurrentHashMap` is a swap).

## What "senior-level" actually means here

A collection choice defended only by "it's O(1)" or "it's thread-safe" has skipped most of this tree.

---

# Part 29 — Real-World Case Studies

1. **10 million records, frequent lookup by ID** → `HashMap<ID,Record>`, pre-sized to `(10_000_000/0.75)+1`. No ordering requested, so hash-based over tree-based.
2. **10,000 reads/sec, very few writes** → `ConcurrentHashMap` (map-like) or `CopyOnWriteArrayList`/`Set` (collection-like), per the exact read-heavy profile.
3. **Multiple threads updating counters** → `ConcurrentHashMap<K, LongAdder>` under real per-key contention, else `AtomicInteger`.
4. **Insertion order must be preserved** → `LinkedHashMap`/`LinkedHashSet`.
5. **Sorted range queries required** → `TreeMap`/`TreeSet` (or `ConcurrentSkipListMap`/`Set` if concurrent).
6. **Top 100 highest-priority tasks** → bounded min-heap `PriorityQueue`, O(n log 100).
7. **LRU behavior required** → `LinkedHashMap` + `accessOrder=true` + `removeEldestEntry()`, or Caffeine if concurrent.
8. **Producer-consumer processing** → bounded `BlockingQueue` (`ArrayBlockingQueue`/`LinkedBlockingQueue`).
9. **Thread-safe event listeners** → `CopyOnWriteArrayList`/`Set`.
10. **Memory-efficient enum lookup** → `EnumMap`/`EnumSet`, unconditionally.
11. **Virtual threads accessing shared state** → whatever Part 13 calls for (usually `ConcurrentHashMap`), biased toward fine-grained options given Part 25's contention-at-scale point.
12. **API returning an ordered read-only collection** → `SequencedCollection<T>` return type, backed by `List.copyOf(...)` for a snapshot, or an unmodifiable sequenced view if live-reflection is the actual intended contract.

Every answer here cites a specific earlier part as its justification, not a memorized rule — that's the actual test.

---

# Part 30 — Simplified Internal Implementations

## `SimpleHashMap<K,V>`

```java
class SimpleHashMap<K, V> {
    static class Node<K, V> {
        final K key;
        V value;
        Node<K, V> next;
        Node(K key, V value) { this.key = key; this.value = value; }
    }

    private Node<K, V>[] table;
    private int size;
    private static final int DEFAULT_CAPACITY = 16;
    private static final float LOAD_FACTOR = 0.75f;

    @SuppressWarnings("unchecked")
    SimpleHashMap() {
        table = new Node[DEFAULT_CAPACITY];
    }

    private int indexFor(K key) {
        int h = key.hashCode();
        h ^= (h >>> 16);
        return h & (table.length - 1);
    }

    V put(K key, V value) {
        int idx = indexFor(key);
        Node<K, V> node = table[idx];
        while (node != null) {
            if (node.key.equals(key)) {
                V old = node.value;
                node.value = value;
                return old;
            }
            node = node.next;
        }
        Node<K, V> newNode = new Node<>(key, value);
        newNode.next = table[idx];
        table[idx] = newNode;
        size++;
        if (size > table.length * LOAD_FACTOR) resize();
        return null;
    }

    V get(K key) {
        Node<K, V> node = table[indexFor(key)];
        while (node != null) {
            if (node.key.equals(key)) return node.value;
            node = node.next;
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private void resize() {
        Node<K, V>[] oldTable = table;
        table = new Node[oldTable.length * 2];
        size = 0;
        for (Node<K, V> head : oldTable) {
            Node<K, V> node = head;
            while (node != null) {
                Node<K, V> next = node.next;
                put(node.key, node.value);
                node = next;
            }
        }
    }
}
```

**What the real JDK does differently:** treeification at 8 entries (attack resistance, worst-case bound); the resize here naively calls `put()` (recomputing hashes, reversing chain order) instead of the real lo/hi bit-split trick that preserves order without redundant work; no `remove()`, no iterator, no view collections.

## `SimpleTreeMap<K,V>` (unbalanced BST)

```java
class SimpleTreeMap<K extends Comparable<K>, V> {
    static class Node<K, V> {
        K key; V value;
        Node<K, V> left, right;
        Node(K key, V value) { this.key = key; this.value = value; }
    }

    private Node<K, V> root;

    void put(K key, V value) { root = put(root, key, value); }

    private Node<K, V> put(Node<K, V> node, K key, V value) {
        if (node == null) return new Node<>(key, value);
        int cmp = key.compareTo(node.key);
        if (cmp < 0) node.left = put(node.left, key, value);
        else if (cmp > 0) node.right = put(node.right, key, value);
        else node.value = value;
        return node;
    }

    V get(K key) {
        Node<K, V> node = root;
        while (node != null) {
            int cmp = key.compareTo(node.key);
            if (cmp < 0) node = node.left;
            else if (cmp > 0) node = node.right;
            else return node.value;
        }
        return null;
    }
}
```

No rebalancing at all — insert keys in sorted order and this degenerates into a linked list, exactly demonstrating why red-black balancing exists.

## `SimpleArrayDeque<E>` (ring buffer core, no growth)

```java
class SimpleArrayDeque<E> {
    private Object[] elements;
    private int head = 0, tail = 0;
    private int size = 0;

    SimpleArrayDeque(int capacity) { elements = new Object[capacity]; }

    void addFirst(E e) {
        head = (head - 1) & (elements.length - 1);
        elements[head] = e;
        size++;
    }

    void addLast(E e) {
        elements[tail] = e;
        tail = (tail + 1) & (elements.length - 1);
        size++;
    }

    @SuppressWarnings("unchecked")
    E removeFirst() {
        E e = (E) elements[head];
        elements[head] = null;
        head = (head + 1) & (elements.length - 1);
        size--;
        return e;
    }
}
```

The real `ArrayDeque` adds automatic doubling, full `Deque`/`Queue` interface implementation, and null-rejection.

## The pedagogical point

Building these forces the mechanism to become concrete rather than descriptive — and each omission, examined explicitly, is exactly what separates "understand the core idea" from "understand what production-grade requires."

---

# Part 31 — Production Debugging

Format: symptom → diagnosis → root cause → solution.

1. **Unexpected duplicates in a `Set`.** Diagnosis: compare `hashCode()` values for "identical" objects. Root cause: `equals()` overridden without `hashCode()` (or vice versa). Solution: always override both together; test the contract explicitly.
2. **Missing `HashMap` entries.** Diagnosis: check if the key's hash-relevant fields were mutated post-insertion. Root cause: mutable-key trap, or broken equals/hashCode pairing. Solution: immutable keys/records.
3. **`ConcurrentModificationException`.** Diagnosis: look for structural mutation inside a for-each loop via a non-iterator reference. Solution: `iterator.remove()`/`removeIf()`/collect-then-remove.
4. **Memory leaks involving collections.** Diagnosis: heap dump, look for an ever-growing collection and what holds a strong reference to it (static fields are the classic culprit). Root cause: unbounded cache, unbounded queue, or undischarged listener registrations. Solution: bounded structures with real eviction; bounded queues; explicit deregistration or weak references used correctly.
5. **High GC activity.** Diagnosis: check allocation rate — boxing in numeric loops, CopyOnWrite writes, excessive small-object churn. Solution: primitive arrays in hot paths; pre-size collections.
6. **Slow lookups that "should" be fast.** Diagnosis: histogram actual production hash-mod-capacity distribution; check treeification rate. Root cause: poor/degenerate `hashCode()`. Solution: `Objects.hash(...)` or record-generated hashing, validated against real data.
7. **Lock contention.** Diagnosis: thread dumps showing many threads `BLOCKED` on the same monitor. Root cause: a coarse-grained lock under higher concurrency than designed for. Solution: fine-grained concurrent structures matched to the access pattern.
8. **Incorrect ordering.** Diagnosis: check the actual declared collection type against the ordering the code assumes. Root cause: `HashMap`/`HashSet` used where a linked/tree variant was needed. Solution: switch to the type that encodes the needed guarantee; never rely on unspecified iteration order.
9. **Mutable keys corrupting a `Map`/`Set` (incident scale).** Same mechanism as #2, discovered as a systemic pattern — often mutation and map usage live in unrelated parts of the codebase. Solution: audit for mutable types used as keys; migrate to records.
10. **Poor `hashCode()` (production-scale).** Same as #6; often compounds with #1 and #6 simultaneously as a single root cause.
11. **Concurrent updates losing data.** Diagnosis: confirm the collection is genuinely thread-safe; check for check-then-act patterns even on safe collections. Solution: `ConcurrentHashMap` plus `compute`/`merge`/`computeIfAbsent` for atomic read-modify-write.
12. **Unexpected memory growth.** Specific sub-case: `HashMap` never shrinks its table after mass removal — profiler shows a table array much larger than current entry count. Solution: rebuild the map at a sensible size if this pattern is expected.
13. **Collection performance degradation over time.** Diagnosis: check for a comparator that isn't a pure, stable function, or hash clustering triggered by real-data drift not present in test data. Solution: audit comparator purity; revisit `hashCode()` against real production key distributions.

## The unifying debugging instinct

Nearly every scenario traces back to a small handful of root mechanisms: the equals/hashCode contract, unbounded growth without eviction, coarse-grained locking under real contention, and check-then-act races on concurrent structures. Production debugging is the same mental model run in reverse: instead of "given this requirement, what structure and why," it's "given this symptom, which known failure mechanism does it match."


---


---

## Practice Questions & Answers

### Part 32 — Final Practice Phase — Level 1 — Conceptual Exercises

<details class="qa-item">
<summary>1. Why does `Map<K,V>` not extend `Collection<E>`? Name the two concrete method-signature conflicts that would arise if it did.</summary>

`Map` is a **key-value** abstraction, not a single-element collection. If it extended `Collection<E>`, two signature clashes appear:

1. **`add(E e)`** — `Collection.add` adds one element; `Map` needs `put(K, V)` with two arguments.
2. **`iterator()` / `contains(Object o)`** — `Collection` iterates/contains **values** (or elements); `Map` has distinct `keySet()`, `values()`, `entrySet()` views with different semantics.

The framework uses separate interfaces to keep contracts precise.

</details>

<details class="qa-item">
<summary>2. Explain the difference between `SequencedCollection`, `SequencedSet`, and `SequencedMap`</summary>

which concrete classes implement each, and why doesn't `HashMap` implement `SequencedMap`?

</details>

<details class="qa-item">
<summary>3. You need a `Set` with: no duplicates, sorted iteration, and O(log n) range queries. Which class, and what's the one thing you must get right about your `Comparator` to avoid silently losing entries?</summary>

`Map` is a **key-value** abstraction, not a single-element collection. If it extended `Collection<E>`, two signature clashes appear:

1. **`add(E e)`** — `Collection.add` adds one element; `Map` needs `put(K, V)` with two arguments.
2. **`iterator()` / `contains(Object o)`** — `Collection` iterates/contains **values** (or elements); `Map` has distinct `keySet()`, `values()`, `entrySet()` views with different semantics.

The framework uses separate interfaces to keep contracts precise.

</details>

<details class="qa-item">
<summary>4. What's the precise difference between "unmodifiable" and "immutable"? Give a concrete code example where treating them as equivalent causes a bug.</summary>

- **Unmodifiable** — no mutating methods on the *view*; backing collection may still change.
- **Immutable** — no mutation possible at all; contents never change after creation.

```java
List<String> backing = new ArrayList<>(List.of("a"));
List<String> view = Collections.unmodifiableList(backing);
backing.add("b"); // mutates through backing reference
System.out.println(view.size()); // 2 — view changed!
```

`List.of()` / `List.copyOf()` are truly immutable — safe to share.

</details>

<details class="qa-item">
<summary>5. Name three Java 21 additions to the Collections Framework and, for each, name the specific pre-21 gap it closes.</summary>

1. **`SequencedCollection` / `SequencedSet` / `SequencedMap`** — uniform first/last/get/reversed operations; pre-21, `LinkedHashMap` had `firstKey` patterns but no shared API.
2. **`addFirst` / `addLast` on `Deque`** via sequenced interfaces — consistent deque semantics across implementations.
3. **`LinkedHashMap.sequencedKeySet()` / `sequencedValues()`** — ordered views with predictable iteration without extra wrappers.

(Java 21 also formalized sequenced collections; `HashMap` does **not** implement `SequencedMap` because hash order is not meaningful sequence.)

</details>

### Part 32 — Final Practice Phase — Level 2 — Implementation Exercises

<details class="qa-item">
<summary>6. Walk through, step by step, what happens internally when `HashMap.put()` triggers a resize from capacity 16 to 32</summary>

specifically explain the lo/hi bit-split mechanism and why it avoids recomputing full hashes.

</details>

<details class="qa-item">
<summary>7. Trace `ArrayDeque.addFirst()` and `addLast()` on a deque of capacity 8 that currently has `head=6, tail=2` (i.e., already wrapped around)</summary>

show the resulting indices after one of each call.

</details>

<details class="qa-item">
<summary>8. Explain exactly why `PriorityQueue.remove(Object)` is O(n) while `poll()` is O(log n), even though both conceptually "remove an element."</summary>

- **Unmodifiable** — no mutating methods on the *view*; backing collection may still change.
- **Immutable** — no mutation possible at all; contents never change after creation.

```java
List<String> backing = new ArrayList<>(List.of("a"));
List<String> view = Collections.unmodifiableList(backing);
backing.add("b"); // mutates through backing reference
System.out.println(view.size()); // 2 — view changed!
```

`List.of()` / `List.copyOf()` are truly immutable — safe to share.

</details>

<details class="qa-item">
<summary>9. Walk through `TreeMap.put()` inserting a new key that requires one left rotation to restore the red-black invariants</summary>

describe what pointer reassignments occur.

</details>

<details class="qa-item">
<summary>10. Explain why `ConcurrentHashMap.get()` requires no locking at all, but `put()` sometimes does. What specific field modifier makes the lock-free read safe?</summary>

`get()` reads the volatile `Node[] table` reference and walks bin lists — reads see published nodes via **volatile**/`final` field semantics without locking the whole map. `put()` may CAS into an empty bin or **lock a single bin** (`synchronized` on the bin head) for insertion/update/resizing. The `volatile` (or equivalent safe publication) on table and node fields ensures readers never see torn/partial structure.

</details>

<details class="qa-item">
<summary>11. Implement (on paper or in an artifact) a `removeEldestEntry()` override for a `LinkedHashMap`-based cache that evicts once size exceeds 500</summary>

then explain why this exact pattern has no safe equivalent on `ConcurrentHashMap`.

</details>

### Part 32 — Final Practice Phase — Level 3 — Code Analysis

<details class="qa-item">
<summary>12. ```java</summary>

Map<String, Integer> map = new HashMap<>();
map.put("a", 1);
for (String key : map.keySet()) {
    if (key.equals("a")) map.put("b", 2);
}
```

</details>

<details class="qa-item">
<summary>13. ```java</summary>

List<Integer> list = List.of(1, 2, 3);
List<Integer> mutable = new ArrayList<>(list);
mutable.add(4);
System.out.println(list.size());
```

</details>

<details class="qa-item">
<summary>14. ```java</summary>

Set<int[]> set = new HashSet<>();
set.add(new int[]{1, 2, 3});
set.add(new int[]{1, 2, 3});
System.out.println(set.size());
```

</details>

<details class="qa-item">
<summary>15. ```java</summary>

PriorityQueue<Integer> pq = new PriorityQueue<>(Comparator.reverseOrder());
pq.addAll(List.of(5, 1, 4, 2, 3));
List<Integer> result = new ArrayList<>(pq);
System.out.println(result);
```

</details>

<details class="qa-item">
<summary>16. ```java</summary>

Map<String, List<Integer>> map = new HashMap<>();
map.computeIfAbsent("key", k -> new ArrayList<>()).add(1);
map.computeIfAbsent("key", k -> new ArrayList<>()).add(2);
System.out.println(map.get("key"));
```

</details>

<details class="qa-item">
<summary>17. ```java</summary>

List<String> names = new ArrayList<>(List.of("a", "b", "c", "d"));
Iterator<String> it = names.iterator();
while (it.hasNext()) {
    String s = it.next();
    if (s.equals("b")) names.remove(s);
}
```

</details>

### Part 32 — Final Practice Phase — Level 4 — Performance Exercises

<details class="qa-item">
<summary>18. A service holds a 50-million-entry lookup table, built once at startup from a bulk load, then read millions of times per minute with no further writes.</summary>

**`HashMap`** (or pre-sized `HashMap` with known capacity to avoid resizes during load). O(1) expected reads, minimal memory overhead vs tree structures. Reject **`ConcurrentHashMap`** — unnecessary concurrency overhead if truly read-only after publish (use immutable snapshot or `Map.copyOf` if sharing). Reject **`TreeMap`** — O(log n) reads and higher per-entry cost. Consider off-heap or compressed storage only if heap is prohibitive.

</details>

<details class="qa-item">
<summary>19. A leaderboard needs the current top 10 scores at all times, updated by thousands of score submissions per second from a single-threaded event-processing pipeline.</summary>

**`PriorityQueue`** (min-heap of size 10 for top-10 highest if using reverse comparator, or maintain size-10 heap). Single-threaded → no concurrency wrapper needed. O(log 10) per update. Reject **`TreeSet`** — also works but higher constant factor; reject **`ConcurrentSkipListMap`** — no concurrency needed. Alternative: bucket by score + `TreeMap` if score range is small.

</details>

<details class="qa-item">
<summary>20. A rarely-changing list of ~15 feature-flag listeners is iterated on every single request across a highly concurrent service.</summary>

**`CopyOnWriteArrayList`** — reads (iteration) are lock-free on a snapshot; writes (rare listener registration) copy the array. Perfect read-heavy, write-rare. Reject plain `ArrayList` + lock — iterator would need synchronization every request. Reject `Collections.synchronizedList` — every iteration locks.

</details>

<details class="qa-item">
<summary>21. A batch job needs to deduplicate 200 million log lines by a derived key, single-threaded, memory being the primary constraint.</summary>

If exact dedup fits RAM: **`HashSet`** of keys (or `LongOpenHashSet` / primitive set if keys are numeric). If not: **sort + scan** external disk (no in-memory set), or **Bloom filter** for probabilistic dedup with second-pass confirmation. Reject `TreeSet` — higher memory per entry. Tune initial capacity/load factor to avoid resize churn during bulk insert.

</details>

<details class="qa-item">
<summary>22. A cache of parsed configuration objects needs to survive being read by 50,000 concurrent virtual threads, refreshed roughly once per minute.</summary>

**`volatile` reference swap** to immutable `Map.copyOf(snapshot)` refreshed atomically each minute — readers see stable snapshot without locking. Or **`ConcurrentHashMap`** if per-key lazy loading. For single bulk refresh: build new map, then `configCache = newMap` (volatile field). Reject `Collections.synchronizedMap` — pins under massive read concurrency. Caffeine with `refreshAfterWrite` is the production-grade choice.

</details>

### Part 32 — Final Practice Phase — Level 5 — Concurrency Exercises

<details class="qa-item">
<summary>23. Explain precisely why this is unsafe, and fix it using `ConcurrentHashMap`'s atomic operations:</summary>

```java
ConcurrentHashMap<String, Integer> counts = new ConcurrentHashMap<>();
if (!counts.containsKey(key)) {
    counts.put(key, 0);
}
counts.put(key, counts.get(key) + 1);
```

</details>

<details class="qa-item">
<summary>24. Under what specific circumstance does calling a mutating method on a `ConcurrentHashMap` from inside a `computeIfAbsent` lambda (on the *same* map) cause a problem? What's the fix?</summary>

**`PriorityQueue`** (min-heap of size 10 for top-10 highest if using reverse comparator, or maintain size-10 heap). Single-threaded → no concurrency wrapper needed. O(log 10) per update. Reject **`TreeSet`** — also works but higher constant factor; reject **`ConcurrentSkipListMap`** — no concurrency needed. Alternative: bucket by score + `TreeMap` if score range is small.

</details>

<details class="qa-item">
<summary>25. You're migrating a thread-per-request service from a fixed platform-thread pool (200 threads) to virtual threads. Name two categories of latent bugs in existing shared-collection code that are more likely to surface after this migration, and why.</summary>

1. **Non-thread-safe collections under hidden concurrency** — `HashMap`/`ArrayList` shared across requests were "safe" at 200 platform threads with low collision; 50k virtual threads expose check-then-act races and `ConcurrentModificationException`.
2. **`synchronized` on shared structures** — more concurrent access causes lock contention and long pin times; virtual threads magnify scheduler queue depth when blocking on fat locks.

</details>

<details class="qa-item">
<summary>26. Explain the throughput difference you'd expect between `AtomicInteger` and `LongAdder` for a counter incremented by 500 threads simultaneously</summary>

and why `LongAdder`'s `.sum()` is comparatively more expensive than `AtomicInteger.get()`.

</details>

<details class="qa-item">
<summary>27. Why does `CopyOnWriteArrayList`'s iterator never throw `ConcurrentModificationException`, structurally</summary>

not "because it's well-tested," but because of what specific mechanism?

</details>

### Part 32 — Final Practice Phase — Level 6 — Production Debugging Exercises

<details class="qa-item">
<summary>28. A `Set<CustomKey>` used for request deduplication starts admitting duplicate requests only after several days of uptime, never in fresh restarts or in tests.</summary>

1. **Non-thread-safe collections under hidden concurrency** — `HashMap`/`ArrayList` shared across requests were "safe" at 200 platform threads with low collision; 50k virtual threads expose check-then-act races and `ConcurrentModificationException`.
2. **`synchronized` on shared structures** — more concurrent access causes lock contention and long pin times; virtual threads magnify scheduler queue depth when blocking on fat locks.

</details>

<details class="qa-item">
<summary>29. A service's heap usage climbs steadily and never drops, even after a full GC, and a heap histogram shows one `HashMap`'s internal table array is far larger than its live entry count would suggest.</summary>

**HashMap resize without shrink** — table was huge during a spike, entries removed but capacity never shrinks (HashMap doesn't compact). Or **retained keys** (e.g. `Integer` cache, interned strings) holding references. **Confirm:** compare `map.size()` vs table length via heap dump or JOL. **Fix:** rebuild into new `HashMap` with right initial capacity, or use cache with eviction (Caffeine).

</details>

<details class="qa-item">
<summary>30. Threads occasionally block for hundreds of milliseconds on what a thread dump shows as a `synchronized` block wrapping a shared `HashMap`, under moderate concurrent load that wasn't a problem in staging.</summary>

**Coarse lock on non-concurrent `HashMap`** — all readers and writers serialize on one monitor. Staging had lower concurrency. **Fix:** `ConcurrentHashMap`, or read-write lock if reads dominate, or partition into shard maps. Never wrap plain `HashMap` in `synchronized` for high-traffic paths.

</details>

<details class="qa-item">
<summary>31. A `PriorityQueue`-backed task scheduler occasionally processes a lower-priority task before a higher-priority one that was added earlier in the same batch, despite `poll()` being used correctly every time it's called.</summary>

`PriorityQueue` is **not stable** — equal-priority (or comparator-equal) elements have no FIFO guarantee. If comparator treats distinct tasks as equal (e.g. only compares priority enum, not sequence), heap order is arbitrary. **Fix:** comparator includes sequence/timestamp, or use `LinkedHashMap` + separate structure, or `PriorityQueue` with unique sequence in comparison.

</details>

<details class="qa-item">
<summary>32. A `WeakHashMap`-based "cache" has a near-zero hit rate in production despite the same keys being requested repeatedly within a short window.</summary>

**Keys are strongly reachable elsewhere** — `WeakHashMap` entries survive only if keys are weakly reachable. If you store the same `String` in a strong `Set` or static cache, weak entries never clear but also **new keys** are different instances (not interned) → misses. Or **GC clears entries too aggressively** between requests if nothing else strongly references keys. **Fix:** use `String.intern()` / canonical key pool, or switch to Caffeine with TTL/size bounds.

</details>

### Part 32 — Final Practice Phase — Level 7 — Design Exercises

<details class="qa-item">
<summary>33. A rate limiter tracking request counts per API key over a sliding 60-second window, serving ~50,000 requests/sec across many concurrent virtual threads.</summary>

**Per-key `ConcurrentHashMap` + lock-free or striped counters** — e.g. `ConcurrentHashMap<String, LongAdder>` with window reset, or bucketed time slices. For sliding window at scale: **Redis/Central store** or approximate counting (Count-Min Sketch). In-memory: avoid one global lock; shard by key hash. Caffeine with `expireAfterWrite(60s)` for per-key windows if approximate limits suffice.

</details>

<details class="qa-item">
<summary>34. An in-memory audit log that must expose read-only access to the last 10,000 entries in insertion order, safely to many concurrent readers, while a single writer appends continuously.</summary>

**Circular buffer** of 10k slots + **volatile/COW snapshot** for readers, or `ArrayDeque` with copy-on-write snapshot on read path. Production pattern: single writer thread appends to queue; readers get `List.copyOf` snapshot or immutable ring buffer view. `CopyOnWriteArrayList` works if 10k copies are acceptable on each write (usually not) — prefer ring buffer + atomic reference to immutable list snapshot periodically.

</details>

<details class="qa-item">
<summary>35. A graph algorithm needing to repeatedly extract the minimum-distance unvisited node (Dijkstra's-style) from a set of ~1 million nodes, with occasional priority updates for nodes already in the structure.</summary>

**`PriorityQueue` + `HashMap` for node→heap entry** (or **indexed heap**). Standard `PriorityQueue` lacks O(log n) arbitrary priority update — use lazy deletion (re-insert with new priority) or custom indexed heap. For concurrent: not typical in Dijkstra inner loop. **`TreeSet`** with explicit comparator on (distance, nodeId) works but higher constant factors than binary heap.

</details>

### Part 32 — Final Practice Phase — Level 8 — Senior Interview Exercises

<details class="qa-item">
<summary>36. "Walk me through what happens, step by step, when you call `put()` on a `HashMap` that's about to trigger a resize."</summary>

1. Compute `hash`, find bin index `(n-1) & hash`.
2. Walk bin chain / tree.
3. If threshold exceeded (`size > capacity * loadFactor`), **resize** 2x.
4. Allocate new table; **split each old bin** using high bit of hash (lo/hi chains) without rehashing every key from scratch.
5. Insert new entry in appropriate bin (tree if bin length > 8).
6. Increment `size`.

Resize is O(n) but amortized O(1) per put.

</details>

<details class="qa-item">
<summary>37. "Why would you ever choose `ConcurrentSkipListMap` over `ConcurrentHashMap`? What are you giving up, and what are you gaining?"</summary>

Choose **`ConcurrentSkipListMap`** when you need **sorted keys**, `subMap`/`headMap`/`tailMap`, or concurrent navigable operations. You gain sorted iteration and range queries. You give up **lower memory overhead and faster point lookups** — skip list has higher constant factors than CHM hash bins. Never choose it for plain key-value get/put without ordering need.

</details>

<details class="qa-item">
<summary>38. "A colleague says `ArrayList.add()` is O(1). Do you agree? Push back on the parts of that claim you'd want to refine."</summary>

**Amortized O(1)** for append at end — occasional O(n) resize when capacity exhausted. **O(n)** if add at index `i` (shift elements). Worst-case single add is O(n) due to resize copying entire backing array. Also: `add` triggers `ensureCapacity` — if you know size upfront, presize to avoid repeated resizes.

</details>

<details class="qa-item">
<summary>39. "Explain the `equals()`/`hashCode()` contract to me as if I'd never seen it, then show me what breaks if you violate the load-bearing direction of it."</summary>

Equal objects must have equal hash codes. Hash-based collections place objects in buckets by `hashCode`; lookup uses `equals` within bucket. **Violating `equals` → `hashCode`:** object in wrong bucket → `get` returns null even though `equals` would match. Example: mutable key changes hash after insert → lost entry. **Fix:** immutable keys, or constant `hashCode` from stable fields.

</details>

<details class="qa-item">
<summary>40. "We need a thread-safe, mostly-read collection with predictable iteration behavior and minimal write frequency. What do you choose, and what are you trading away?"</summary>

---

*End of taught curriculum and practice phase. Part 33 (Final Comprehensive Evaluation) follows only after Level 1-8 exercises above have been attempted.*

</details>
