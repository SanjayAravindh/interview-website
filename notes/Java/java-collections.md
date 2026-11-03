# Senior-Level Java Collections Mastery Course
### Java 21 LTS Baseline

---

## Table of Contents

1. [Part 1 — Java Collections Framework Architecture](#part-1-java-collections-framework-architecture)
2. [Part 2 — ArrayList Deep Dive](#part-2-arraylist-deep-dive)
3. [Part 3 — LinkedList Deep Dive](#part-3-linkedlist-deep-dive)
4. [Part 4 — HashSet Deep Dive](#part-4-hashset-deep-dive)
5. [Part 5 — HashMap Deep Dive](#part-5-hashmap-deep-dive)
6. [Part 6 — LinkedHashMap](#part-6-linkedhashmap)
7. [Part 7 — TreeMap](#part-7-treemap)
8. [Part 8 — Sets](#part-8-sets)
9. [Part 9 — Queue and Deque](#part-9-queue-and-deque)
10. [Part 10 — Stack](#part-10-stack)
11. [Part 11 — PriorityQueue](#part-11-priorityqueue)
12. [Part 12 — Immutable and Unmodifiable Collections](#part-12-immutable-and-unmodifiable-collections)
13. [Part 13 — Concurrent Collections](#part-13-concurrent-collections)
14. [Part 14 — CopyOnWrite Collections](#part-14-copyonwrite-collections)
15. [Part 15 — BlockingQueue](#part-15-blockingqueue)
16. [Part 16 — WeakHashMap and Reference-Based Collections](#part-16-weakhashmap-and-reference-based-collections)
17. [Part 17 — EnumMap and EnumSet](#part-17-enummap-and-enumset)
18. [Part 18 — Iterators](#part-18-iterators)
19. [Part 19 — Spliterator and Streams](#part-19-spliterator-and-streams)
20. [Part 20 — Generics + Collections](#part-20-generics-collections)
21. [Part 21 — equals() and hashCode()](#part-21-equals-and-hashcode)
22. [Part 22 — Complexity and Performance](#part-22-complexity-and-performance)
23. [Part 23 — JVM and Memory Perspective](#part-23-jvm-and-memory-perspective)
24. [Part 24 — Java 21 Collections and API Design](#part-24-java-21-collections-and-api-design)
25. [Part 25 — Collections + Virtual Threads](#part-25-collections-virtual-threads)
26. [Part 26 — Real Production Patterns](#part-26-real-production-patterns)
27. [Part 27 — Common Senior-Level Mistakes](#part-27-common-senior-level-mistakes)
28. [Part 28 — Collection Selection Framework](#part-28-collection-selection-framework)
29. [Part 29 — Real-World Case Studies](#part-29-real-world-case-studies)
30. [Part 30 — Simplified Internal Implementations](#part-30-simplified-internal-implementations)
31. [Part 31 — Production Debugging](#part-31-production-debugging)
32. [Part 33 — Final Comprehensive Evaluation](#part-33-final-comprehensive-evaluation)

---

# Part 1 — Java Collections Framework Architecture

> **Key ideas (revise in 1 minute)**
> - `Iterable` is the root. `Collection` is a stronger promise on top of it.
> - `List`, `Set`, and `Queue` add contracts. `Map` is a separate hierarchy because it holds pairs.
> - Java 21's `SequencedCollection` is the shared "has a first and a last" contract.

> **In plain words:** the framework is a set of interfaces so one algorithm can run on many data structures.

## What problem was the Collections Framework designed to solve?

**30-second answer:** The problem was not "how do we store objects." It was how to let algorithms work without knowing the concrete data structure. That is why the framework is interfaces, not a pile of classes like pre-1.2 `Vector`, `Hashtable`, and `Stack`.

- `Collections.sort(list)` does not care whether `list` is an `ArrayList` or a `LinkedList`.
- `Collections.max(collection)` does not care whether it is a `Set` or a `List`.
- The algorithm is written once, against the interface, and works for every implementation that keeps the contract.

**Interview trap:** naming concrete classes (`HashMap`, `ArrayList`) when the question is about the contract. The class is an implementation choice. The interface is the promise.

## Why is `Iterable` the root, not `Collection`?

**30-second answer:** `Iterable<T>` has one abstract method, `iterator()`. Anything that can hand out an `Iterator` can be used in a for-each loop. That is a capability, not a data structure.

```java
Iterator<T> iterator();
```

- `Collection` extends `Iterable`, but so can types outside the framework (NIO's `Path` in some contexts, your own domain classes).
- `Iterable` means "can be iterated." `Collection` means size, membership, add/remove, and bulk operations.
- The split keeps "I can loop over this" from "this is a collection."

**Interview trap:** saying `Collection` is the root of the framework. It is not. `Iterable` is.

## What does `Collection` promise, and what does it leave out?

**30-second answer:** `Collection` is the least common denominator: you can count it, test membership, and bulk-mutate it. It does not promise order, uniqueness, or sorting.

- Size and emptiness: `size()`, `isEmpty()`.
- Membership: `contains()`, `containsAll()`.
- Mutation: `add()`, `remove()`, `addAll()`, `removeAll()`, `retainAll()`, `clear()`.
- Bulk conversion: `toArray()`.
- Since Java 8: `removeIf()`, `stream()`, `parallelStream()`, and `forEach()` inherited from `Iterable`.
- Order, uniqueness, and sorting are added by `List`, `Set`, and `Queue`. Utility methods that do not care about order or duplicates should take `Collection<E>`, not `List<E>`.

**Interview trap:** treating `Collection` as "a list." It is not ordered and it is not unique.

## What does `List` add?

**30-second answer:** A `List` is ordered, indexable, and allows duplicates.

- Positional access: `get(int)`, `set(int, E)`, `add(int, E)`, `remove(int)`.
- Search: `indexOf()`, `lastIndexOf()`.
- `ListIterator`: bidirectional, and it can mutate.
- `subList()` is a view, not a copy. Mutate the view and you mutate the original list.

**Interview trap:** calling `subList` a snapshot. It is a live view. Structural changes to the backing list can fail the view, and changes through the view show up in the original.

## What does `Set` add?

**30-second answer:** Almost no new methods. The value is the contract: no duplicate elements, where duplicate means `equals()`.

- Two types can share method signatures and still mean different things. `Set` is the example.
- Uniqueness is defined by `equals()`, which is why `hashCode()` has to agree with it (Part 4 and Part 21).

**Interview trap:** looking for a `Set` method that "enforces uniqueness." There isn't one. The implementations refuse the duplicate inside `add`.

## What does `Queue` add?

**30-second answer:** A `Queue` is ordered for processing, not for indexing. Each operation has a safe form and a throwing form, because "full" or "empty" is often normal, not exceptional.

| Operation | Returns a special value | Throws |
|---|---|---|
| Insert | `offer(e)` returns false | `add(e)` |
| Remove | `poll()` returns null | `remove()` |
| Peek | `peek()` returns null | `element()` |

- Bounded queues and blocking queues hit capacity on purpose. `offer` fits a non-blocking capacity check. Raw `queue.add()` is rare in production concurrent code for that reason.

**Interview trap:** using `add` / `remove` / `element` on a bounded queue and treating the exception as a bug. Failure at the capacity boundary is a normal outcome.

## What does `Deque` add?

**30-second answer:** `Deque` extends `Queue` to both ends: `addFirst` / `addLast`, `offerFirst` / `offerLast`, `removeFirst` / `removeLast`, `peekFirst` / `peekLast`.

- The same type can be a FIFO queue or a LIFO stack.
- That is why `ArrayDeque` replaces both `LinkedList`-as-queue and the legacy `Stack` class (Part 9 and Part 10).

**Interview trap:** reaching for `Stack` or `LinkedList` when `ArrayDeque` already covers both shapes.

## Why doesn't `Map` extend `Collection`?

**30-second answer:** A `Collection<E>` holds elements of type `E`. A `Map<K,V>` holds pairs. Forcing `Map` to be a `Collection<Map.Entry<K,V>>` breaks the methods people actually want.

- `Collection.add(E e)` would become `add(Map.Entry<K,V>)` on a `Collection<Entry<K,V>>`. The useful operation is `put(K key, V value)`, which replaces on a key collision instead of just inserting.
- `contains(Object o)` on entries would mean "does this exact pair exist." What you usually ask is `containsKey`.
- `Map` is its own root. It still joins the framework through live views: `map.keySet()` returns a `Set<K>`, `map.values()` returns a `Collection<V>`, `map.entrySet()` returns a `Set<Map.Entry<K,V>>`.
- Removing through a view removes from the map. Adding a new entry through `keySet()` is not supported.

**Interview trap:** saying "Map is a Collection of entries" as if that were the type hierarchy. The views exist. The `extends` relationship does not.

**Next questions an interviewer usually asks:**
- Which `Set` is which map in disguise? (Part 8)
- What breaks if `equals` and `hashCode` disagree? (Part 21)

## What do the sorted and navigable interfaces add?

**30-second answer:** `SortedSet` and `SortedMap` iterate in a defined order (natural order or a `Comparator`) and add ranges: `first()`, `last()`, `headSet` / `headMap`, `tailSet` / `tailMap`, `subSet` / `subMap`.

- `NavigableSet` and `NavigableMap` (Java 6) add real navigation: `floor()`, `ceiling()`, `lower()`, `higher()`, `pollFirst()`, `pollLast()`, and a `descendingSet()` / `descendingMap()` view.
- `TreeSet` and `TreeMap` implement the navigable types, which are a strict superset of the sorted types.
- The red-black tree behind them is Part 7.

**Interview trap:** `firstKey()` on a `TreeMap` is O(log n), a walk to the edge. It is not the O(1) head pointer you get from `LinkedHashMap`.

## What did Java 21 add with sequenced collections?

**30-second answer:** JEP 431 added one contract for "this collection has a first element and a last element." Before that, `List`, `LinkedHashSet`, and `LinkedHashMap` each had an order, but no shared way to say so.

Before Java 21:

- `List` could reach the ends only with `get(0)` and `get(size()-1)`.
- `LinkedHashSet` had insertion order and no API for the first or last element without an iterator.
- `LinkedHashMap` had the same gap.
- Reversing a `List` meant `Collections.reverse()` (that mutates) or a hand-written loop. There was no reversed view.

`SequencedCollection<E>` is the uniform contract:

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

- `List` and `Deque` both extend `SequencedCollection`. `SortedSet` extends `SequencedSet`, so `TreeSet` and `ConcurrentSkipListSet` do too. `LinkedHashSet` implements `SequencedSet` directly.
- `SortedMap` extends `SequencedMap`, so `TreeMap` and `ConcurrentSkipListMap` do too. `LinkedHashMap` implements `SequencedMap` and adds `firstEntry()`, `lastEntry()`, `pollFirstEntry()`, `pollLastEntry()`, `putFirst`, `putLast`, `sequencedKeySet()`, `sequencedValues()`, `sequencedEntrySet()`, and `reversed()`.
- `myLinkedHashSet.reversed()` and `myLinkedHashMap.reversed()` are live views, not copies. `LinkedHashMap.sequencedKeySet()`, `sequencedValues()`, and `sequencedEntrySet()` are the ordered views.
- `HashSet` and `HashMap` do not implement the sequenced interfaces. They have no encounter order, so there is nothing to sequence. `EnumSet`, `EnumMap`, `WeakHashMap`, `Hashtable`, and `ConcurrentHashMap` do not either. `CopyOnWriteArraySet` does not. Every `List` does, including `CopyOnWriteArrayList`.

**Interview trap:** calling `map.reversed()` on a `HashMap`. It does not compile. Only the ordered types participate.

**Follow-up: which concrete classes implement each?**

| Interface | Who implements it in the JDK |
|---|---|
| `SequencedCollection` | Every `List` (`ArrayList`, `LinkedList`, `CopyOnWriteArrayList`, `Vector`) and every `Deque` (`ArrayDeque`, `LinkedList`) |
| `SequencedSet` | `LinkedHashSet`, and anything `SortedSet` / `NavigableSet` (`TreeSet`, `ConcurrentSkipListSet`) |
| `SequencedMap` | `LinkedHashMap`, and anything `SortedMap` / `NavigableMap` (`TreeMap`, `ConcurrentSkipListMap`) |

`HashMap` is not on that list. Hash order is not a sequence.

## How do `Iterator`, `ListIterator`, and `Spliterator` differ?

**30-second answer:** `Iterator` walks forward once. `ListIterator` walks both ways and can change the list. `Spliterator` exists so Streams can split a source across threads.

- `Iterator<E>`: `hasNext()`, `next()`, optional `remove()`. One direction, one pass.
- `ListIterator<E>`: adds `hasPrevious()`, `previous()`, `set()`, `add()`, `nextIndex()`, `previousIndex()`. It is the only standard iterator that can mutate in place beyond removal.
- `Spliterator<E>` (Java 8): `trySplit()` partitions a source for parallel streams, plus bits such as `ORDERED`, `SIZED`, and `DISTINCT`. Full treatment in Part 19.

**Interview trap:** using `ListIterator.set` on a `Set`. Sets have no positional iterator.

## What are `Collections` and `Arrays` for?

**30-second answer:** They are not in the interface hierarchy. They are the algorithms half of "interfaces plus algorithms."

- `Collections`: sort, shuffle, legacy synchronized wrappers (`synchronizedList` and the rest), unmodifiable wrappers, `emptyList()` / `singletonList()`, `max()` / `min()`, binary search on a `List`.
- `Arrays`: `sort()`, `binarySearch()`, `asList()` (a fixed-size view over the array, not a resizable `ArrayList`), `Arrays.stream()`, `Arrays.equals()` (element-wise, unlike `array1.equals(array2)`, which is reference equality).

**Interview trap:** `Arrays.asList(existingArray)` and then `add`. The list is fixed-size. `add` throws `UnsupportedOperationException`, and `set` writes through to the array.

## Why do default methods matter here?

**30-second answer:** Before Java 8, a new interface method broke every implementor. Default methods let the JDK add `removeIf()`, `forEach()`, `spliterator()`, `replaceAll()`, and `List.sort()` without breaking `ArrayList`, `LinkedList`, or third-party lists.

- Every implementor inherits a generic version unless it overrides it.
- `ArrayList` overrides `removeIf()` with an array-aware version. A third-party `List` that does not override falls back to the iterator, which is often slower.

**Interview trap:** assuming a default method is as fast as the override on `ArrayList`. The default is correct. It is not always the fast path.

## How does the hierarchy fit together?

**30-second answer:** Start at `Iterable`, branch into `List`, `Set`, and `Queue`, and keep `Map` beside that tree. Every concrete class in this note is "which contracts, and which structure makes them cheap."

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

**Interview trap:** drawing `Map` under `Collection`. It sits beside it.

**Next questions an interviewer usually asks:**
- Why is `ArrayList` the default `List`? (Part 2)
- When does `LinkedList` actually win? (Part 3)

---

# Part 2 — ArrayList Deep Dive

> **Key ideas (revise in 1 minute)**
> - Backed by one `Object[]`. `size` is the logical length. `elementData.length` is the capacity.
> - Growth is 1.5x, not 2x. Append is amortized O(1). Insert or remove in the middle is O(n).
> - It stores references, not inline objects. The index array is cache-friendly. The payload often is not.

> **In plain words:** an ArrayList is a growable array of references, with spare slots at the end so appends are usually cheap.

## How is an `ArrayList` laid out?

**30-second answer:** Two numbers matter. `size` is how many elements are logically in the list. `elementData.length` is the physical array, almost always at least `size`. The gap is why append is amortized O(1): there is usually slack.

```java
transient Object[] elementData;
private int size;
```

**Interview trap:** reading `elementData.length` as "the size of the list." Callers see `size()`. The array is often longer.

## How does capacity grow?

**30-second answer:** The no-arg constructor does not allocate 10 slots. It points at a shared empty array (`DEFAULTCAPACITY_EMPTY_ELEMENTDATA`). The first `add` allocates 10. Later growth is 1.5x, and a bulk `addAll` jumps straight to the required minimum if 1.5x is still too small.

```java
int newCapacity = oldCapacity + (oldCapacity >> 1); // 1.5x growth
```

- Each resize is `Arrays.copyOf(elementData, newCapacity)`, an O(n) copy.
- One `add` is O(1) until a resize, then that one call is O(n). Over the whole life of filling the list to n, the copies form a geometric series and sum to O(n), not O(n²). That is what "amortized O(1)" means.
- Why 1.5x and not 2x: a growth factor under the golden ratio (~1.618) lets old freed blocks be reused by later allocations in some allocator designs. 1.5 does. 2.0 does not.

**Interview trap:** "ArrayList doubles like HashMap." It does not. HashMap doubles. ArrayList grows by half.

## What does each operation actually cost?

**30-second answer:** Index reads and writes are O(1). Anything that shifts the tail, or scans for an object, is O(n). `clear` is O(n) because it nulls slots so the old elements can be collected.

| Operation | Complexity | Why |
|---|---|---|
| `get(index)` | O(1) | direct array index |
| `set(index, e)` | O(1) | direct array write |
| `add(e)` (append) | O(1) amortized | O(n) worst case on resize |
| `add(index, e)` | O(n) | `System.arraycopy` shifts the tail right by one |
| `remove(index)` | O(n) | shifts the tail left, then nulls the last slot |
| `remove(Object)` | O(n) | linear `equals()` scan, then the same shift |
| `contains(Object)` | O(n) | linear scan, `equals()` per element |
| `indexOf(Object)` | O(n) | linear scan |
| `clear()` | O(n) | nulls every slot so GC can reclaim the elements |

- If `clear()` only set `size = 0` and left the slots populated, every object ever stored would stay reachable until the array was resized or the list itself was collected. `remove` nulls the vacated last slot for the same reason.
- `trimToSize()` reallocates the array down to exactly `size`.
- `ensureCapacity(int)` grows once, up front, so a known batch of `add` calls does not resize over and over.

**Interview trap:** "`clear` is O(1) because it just sets size to 0." It must null the slots, or you leak.

## When is insertion O(1), and when is it not?

**30-second answer:** Append is amortized O(1). Insert at an index is always O(n). Even the append has a real O(n) spike on resize. Amortized analysis smooths a long sequence. It does not promise that one call hits a latency budget.

- `add(e)` at the end: O(1) amortized.
- `add(index, e)`: O(n) always, because of the shift.
- A single append that resizes copies the whole array.

**Interview trap:** agreeing with "ArrayList.add is O(1)" with no qualifier. Say amortized, end only, and mention the resize spike. (Part 32, question 38.)

## Where does the memory and cache cost go?

**30-second answer:** The backing array is contiguous, so scanning the references is prefetch-friendly. Each `get(i).someField` is still a pointer chase to wherever that object landed. For `List<Integer>`, values outside the cached range (-128 to 127) are separate heap objects.

- "ArrayList has good cache locality" is half true. The index structure does. The payload often does not.
- Full contrast with `int[]` is in Part 23.

**Interview trap:** promising good locality for a `List` of large objects. You get locality of the pointers, not of the objects.

## Why does `ArrayList` usually beat `LinkedList`?

**30-second answer:** Sequential iteration is a tight index loop. `LinkedList` chases a pointer on every step, allocates a node per element, and gives the JIT less to optimize.

- Same Big-O class for a middle insert does not mean the same wall-clock time. Constants and caches dominate (Part 3).

**Interview trap:** picking `LinkedList` because a textbook says middle insert is O(1). You still pay O(n) to find the node, and then you pay a cache miss per step.

## How does `ArrayList` compare with the neighbors?

**30-second answer:** `ArrayList` is the default `List`. Use a raw array when the size is fixed or you need primitives. Use `CopyOnWriteArrayList` when reads dominate and writes are rare. `LinkedList` is rarely the right list (Part 3).

| | `ArrayList` | `Object[]` / `T[]` | `LinkedList` | `CopyOnWriteArrayList` |
|---|---|---|---|---|
| Backing structure | dynamic array | fixed array | doubly-linked nodes | dynamic array, copied on write |
| Resizable | yes | no | yes | yes |
| `get(index)` | O(1) | O(1) | O(n) | O(1) |
| `add` at end | O(1) amortized | N/A | O(1) | O(n), full copy every write |
| `add` at index | O(n) | N/A | O(1) once positioned, O(n) to find | O(n) |
| Thread safety | none | none | none | iteration is thread-safe |
| Iteration | fast, cache-friendly | fastest | slow, pointer-chasing | fast, over a snapshot |
| Primitive storage | no (boxed) | yes, `int[]` and friends | no (boxed) | no (boxed) |
| Best for | general default | fixed size, hot primitives | rarely — see Part 3 | read-heavy, rarely mutated, concurrent |

**Interview trap:** wrapping an `ArrayList` in `Collections.synchronizedList` and calling that a concurrent list. Compound actions (`check` then `add`) are still races, and every call takes the same lock.

**Next questions an interviewer usually asks:**
- Walk a resize. What is the growth factor? (this part)
- Why is a `LinkedList` get so expensive? (Part 3)

---

# Part 3 — LinkedList Deep Dive

> **Key ideas (revise in 1 minute)**
> - Doubly linked nodes. Head and tail updates are O(1). `get(index)` is O(n).
> - The "O(1) insert" only holds when you already hold the node, usually via a `ListIterator`.
> - Cache misses and per-node headers dominate. `ArrayDeque` wins for queues. `ArrayList` wins for lists.

> **In plain words:** a LinkedList is a chain of nodes with pointers to the first and last, which makes the ends cheap and everything in the middle a walk.

## How is a `LinkedList` laid out?

**30-second answer:** It implements both `List` and `Deque`. Every element is its own `Node` holding the item plus `next` and `prev`. The list caches `first`, `last`, and `size`.

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

**Interview trap:** assuming the nodes sit next to each other in memory. Each node is a separate allocation.

## Why is `get(index)` O(n)?

**30-second answer:** There is no array. The list walks from the nearer end. That cuts the average constant in half. It does not change the class. It is still O(n), not O(log n).

```java
Node<E> node(int index) {
    if (index < (size >> 1)) {
        // walk forward from first
    } else {
        // walk backward from last
    }
}
```

**Interview trap:** "it starts from the closer end, so it is O(log n)." Closer end is still a linear walk.

## When is insert or remove actually O(1)?

**30-second answer:** At a node you already hold, or at the head or tail. At an arbitrary index you walk first, so `add(index, e)` and `remove(index)` are O(n) overall, the same class as `ArrayList`.

- Known `Node`: O(1) relink.
- Head or tail: O(1).
- Arbitrary index: O(n) to find, then O(1) to relink.
- The O(1) middle-insert story is true for a `ListIterator` that is already sitting on the spot.

**Interview trap:** quoting O(1) insert without saying "once positioned."

## Why does it look good on paper and lose in practice?

**30-second answer:** Big-O counts operations. Wall-clock time is operation count times the real cost of one operation, and a pointer chase can be 100x an L1 hit.

- Every node access is a dependent load to a scattered address. Prefetchers love a linear array. They cannot see `next`.
- Each `Node` costs ~32-48 bytes of bookkeeping per element (header plus three references), on top of the payload. A million nodes is tens of megabytes `ArrayList` does not pay, plus more GC.
- Every `next` dereference is a near-guaranteed cache miss (a 100+ cycle stall) versus an L1 hit on an array.
- Bulk array moves use hardware `memmove` and can vectorize (SIMD). A linked list cannot. There is no equivalent for pointer-chasing.

**Interview trap:** "same Big-O, so same speed." Two O(n) scans can differ by an order of magnitude because of cache, allocation, branches, and vectorization.

## When is `LinkedList` actually the right choice?

**30-second answer:** Rarely. A real deque or queue is `ArrayDeque` unless you need `null` elements (`ArrayDeque` forbids null). Heavy middle insert/remove only wins if a `ListIterator` is already there. `null` plus strict `Deque` semantics is the other narrow case.

**Interview trap:** using it as the default queue. `ArrayDeque` has the same Big-O at the ends, better locality, and no per-node object.

## What did Java 21 change for `LinkedList`?

**30-second answer:** It already implemented `List` and `Deque`, so `addFirst`, `addLast`, `getFirst`, `getLast`, `removeFirst`, `removeLast`, and now `reversed()` are there. Most of those already existed via `Deque`. The Java 21 change that matters is `List` in general (no `getFirst()` before) and `LinkedHashSet` / `LinkedHashMap` (no first/last API before).

**Interview trap:** citing `LinkedList.getFirst()` as a Java 21 feature. `Deque` had it. `List.getFirst()` is the new one.

**Next questions an interviewer usually asks:**
- Why is `ArrayDeque` the default deque? (Part 9)
- Where does the per-object header cost come from? (Part 23)

---

# Part 4 — HashSet Deep Dive

> **Key ideas (revise in 1 minute)**
> - A `HashSet` is a `HashMap` whose values are one shared dummy object.
> - The hash picks a bucket. `equals()` finds the element inside it.
> - A bucket of 8+ becomes a tree only after the table has 64+ buckets. That tree is O(log n) only when the keys are `Comparable`.

> **In plain words:** a HashSet is a HashMap that only cares about the keys. Adding an element is putting it in that map with a dummy value.

## What is a `HashSet` actually made of?

**30-second answer:** A thin wrapper. Every element is a key in a backing `HashMap<E, Object>`. `add(e)` is `map.put(e, PRESENT) == null`. `PRESENT` is one shared sentinel, not a new object per element.

```java
private transient HashMap<E, Object> map;
private static final Object PRESENT = new Object();
```

**Interview trap:** describing `HashSet` as its own hash table. The table, the resize, and the trees all live in `HashMap` (Part 5).

## How does a lookup find the bucket?

**30-second answer:** `hashCode()` is mixed, then masked into a bucket index. Inside the bucket, the set compares the stored hash and then `equals()`.

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

- `hashCode()` does not have to be unique. The pigeonhole principle says collisions are guaranteed once the universe of values is bigger than the table.
- Spreading is an XOR fold, not a cryptographic hash:

```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

- The index only uses the low bits. Folding the high 16 bits into the low 16 helps hash functions that vary mostly in the high bits.
- `null` is allowed, once. Its spread hash is 0.

**Interview trap:** thinking a perfect `hashCode` means no collisions. The mask throws away bits. Two different hashes can still share a bucket.

<details>
<summary>Go deeper: when a bucket becomes a tree</summary>

Each bucket starts as a chain. Since Java 8, a chain that reaches `TREEIFY_THRESHOLD` (8) is turned into a red-black tree, but only if the table already has `MIN_TREEIFY_CAPACITY` (64) buckets. Otherwise `HashMap` resizes instead. Untreeification shrinks a tree back to a chain at `UNTREEIFY_THRESHOLD` (6) during resize.

Inside the tree, order is the hash first, then `compareTo` if the keys are `Comparable` and the same class. If that still ties, the class name is compared, and `System.identityHashCode()` is the last tie-breaker.

A treeified lookup is O(log k) only when the colliding keys are `Comparable`. If they are not, `find` can still walk the whole bucket, so the worst case stays O(n). `String` is `Comparable`, which is why the classic hash-flooding attack on string keys got the log bound. A custom key that does not implement `Comparable` does not.

</details>

## What is the average case, and what is the worst case?

**30-second answer:** With a decent hash, add, remove, and contains are O(1) on average. Before Java 8, one bucket could hold every element and a lookup was O(n). Since Java 8, that long chain becomes a tree, and the lookup is O(log n) only when those keys are `Comparable`. Otherwise a lookup can still scan the bucket.

**Interview trap:** "Java 8 made every HashSet lookup O(log n) in the worst case." That sentence is true for `Comparable` keys. It is not true for keys that only implement `equals` and `hashCode`.

## Why did hash-flooding attacks matter?

**30-second answer:** If an attacker controls keys (HTTP parameters, JSON keys) and can force them into one bucket, O(1) operations become O(n) and a request can burn a core. That attack is why Java 8 treeifies long buckets.

- Treeification limits the damage for `Comparable` keys such as `String`.
- It is not a substitute for a hash that spreads real traffic.

**Interview trap:** treating treeification as a complete DoS fix for every key type. Non-comparable keys can still degrade toward a scan.

## When does the table resize?

**30-second answer:** Default load factor is 0.75. When `size > capacity * loadFactor`, the table doubles and entries move. The full mechanism, including the lo/hi split, is Part 5.

**Interview trap:** expecting a `HashSet` to shrink after you remove most of the elements. It does not. The table stays large.

## What happens if you mutate an element after inserting it?

**30-second answer:** `contains` hashes the element as it is now and looks in that bucket. The element is still sitting in the bucket computed from the old hash. The lookup misses. The set still reports the old size. This is not a `HashSet` bug. It is what happens when hash state changes after insertion.

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

- Prefer records, or any immutable type, for `HashSet` elements and `HashMap` keys.
- The same trap on a map also loses the value (Part 5).

**Interview trap:** "the set is corrupted, so size() is wrong." `size()` is still 1. Iteration can still find `p`, because iteration walks every bucket. `contains` and `remove` look in the new bucket and miss.

## What is the `equals` / `hashCode` contract, in one pass?

**30-second answer:** If `a.equals(b)`, then `a.hashCode() == b.hashCode()` must be true. `hashCode()` must stay stable for an object you do not modify. Breaking the first rule silently breaks `HashSet` and `HashMap`. The reverse is not required: unequal objects may share a hash. That is just a collision.

**Interview trap:** overriding `equals` and forgetting `hashCode`, or the other way around. Part 21 states the full contract.

**Next questions an interviewer usually asks:**
- Walk `HashMap.put`, including resize. (Part 5)
- What does a bad `Comparator` do to a `TreeSet`? (Part 7)

---

# Part 5 — HashMap Deep Dive

> **Key ideas (revise in 1 minute)**
> - An array of buckets; the hash picks the bucket and `equals()` finds the key.
> - Default 16 buckets, doubles once size passes 75% full.
> - Capacity is always a power of two so the index is a fast bitmask.
> - A long collision chain (8+) becomes a red-black tree once the table has 64+ buckets.
> - Not thread-safe; use ConcurrentHashMap for shared maps.

> **In plain words:** a HashMap is an array of buckets. The key's hash picks the bucket; inside the bucket, `equals()` finds the exact key. That's the whole idea; everything below is how Java keeps it fast.

## How does HashMap store and find entries?

**30-second answer:** It keeps an array of buckets (default 16). `put` hashes the key, picks bucket `hash & (capacity - 1)`, and either drops the entry in or walks that bucket comparing hash then `equals()`. When size passes `capacity × 0.75`, the array doubles.

- **Buckets:** `Node<K,V>[] table`; each node holds `hash`, `key`, `value`, `next` (a linked chain).
- **Lazy:** `new HashMap<>()` has a `null` table until the first `put`.
- **Lookup:** same hash → bucket → compare hash, then `equals()`. `get` never resizes.
- **Collisions:** a chain of 8+ in a table of 64+ buckets becomes a red-black tree.
- **Resize:** at `size > threshold` (16 × 0.75 = 12), capacity doubles and every entry is moved.

```java
Map<String, Integer> m = new HashMap<>();  // table == null
m.put("A", 10);   // allocates 16 buckets, threshold 12, stores in bucket hash & 15
m.get("A");       // same hash -> same bucket -> equals() match -> 10
```

**Interview trap:** mutating a field used in `hashCode()` after inserting the key makes the entry unreachable via `get()`/`containsKey()`.

```visualizer hashmap
```

<details>
<summary>Go deeper: internal fields and the put() walk-through</summary>

```java
transient Node<K,V>[] table;   // the bucket array
transient int size;
int threshold;                  // resize trigger = capacity * loadFactor
final float loadFactor;         // default 0.75f

static class Node<K,V> implements Map.Entry<K,V> {
    final int hash;
    final K key;
    V value;
    Node<K,V> next;   // singly-linked chain within a bucket
}

// Since Java 8, treeified nodes:
static final class TreeNode<K,V> extends LinkedHashMap.Entry<K,V> {
    TreeNode<K,V> parent, left, right, prev;
    boolean red;
}
```

`put("A", 10)` step by step:

1. `table` is `null` → `resize()` allocates `new Node[16]`, `threshold = 12`.
2. `hash = spread("A".hashCode())`.
3. `index = hash & 15`.
4. Empty bucket → place `Node("A", 10, hash)`. Otherwise walk the chain/tree comparing `hash` then `equals()`; replace the value on a match, else append.
5. If `size > threshold` → `resize()` after insertion.

`get("A")`: same hash/index, walk comparing hash then equals; no mutation, no resize check.

</details>

## Why is HashMap capacity always a power of two?

**30-second answer:** So the bucket index can be a fast bitmask, `hash & (capacity - 1)`, instead of a slower `%` division.

- Default capacity 16; every resize doubles it.
- With a power of two, `capacity - 1` is all 1-bits (15 = `1111`), so the mask keeps only the low bits of the hash. That's why HashMap first mixes in the high bits with `h ^ (h >>> 16)`; the mixing is what spreads keys evenly.
- For non-negative hashes this equals `hash % capacity`; with a negative hash the `&` still gives a valid index where `%` would go negative.

**Interview trap:** `new HashMap<>(17)` doesn't give 17 buckets; it rounds up to 32.

## What happens on a collision, and when does a bucket become a tree?

**30-second answer:** Colliding keys share a bucket as a linked list (O(k) search). Since Java 8, a list of 8 turns into a red-black tree (O(log k)), but only if the table already has 64+ buckets; otherwise HashMap just resizes.

- `TREEIFY_THRESHOLD = 8`, `MIN_TREEIFY_CAPACITY = 64`.
- Why the 64 gate: a long chain in a small table usually means "table too small", which resizing fixes.
- `UNTREEIFY_THRESHOLD = 6`: a tree bucket turns back into a list if it shrinks to 6 during a resize.

**Interview trap:** since Java 8 a treeified bucket is O(log n), but only when the colliding keys are `Comparable`; without that, a lookup can still scan the whole bucket, so its worst case stays O(n).

<details>
<summary>Go deeper: tree ordering</summary>

Inside the tree, entries are ordered by hash first, then by `compareTo` if the keys are `Comparable` and of the same class. If that still ties, the class name is compared, and `System.identityHashCode()` is the last tie-breaker.

</details>

## How does resizing work?

**30-second answer:** Capacity doubles, threshold is recomputed, and every entry moves. Each entry either stays at index `i` or moves to `i + oldCapacity`, so Java splits each bucket in one pass without recomputing hashes.

- Doubling adds exactly one more hash bit to the index.
- That bit decides: 0 → stay at `i` ("lo" list), 1 → move to `i + oldCapacity` ("hi" list).
- Relative order inside each list is preserved.
- Still O(n) overall; it's just cheaper per entry.
- HashMap **never shrinks**; `remove` doesn't trigger a resize.

**Interview tip:** pre-size when you know N: `new HashMap<>((int) (N / 0.75f) + 1)` avoids repeated resize-and-rehash passes (capacity must be ≥ N / loadFactor, rounded up to a power of two).

## Which HashMap methods should I know beyond put/get?

**30-second answer:** `merge` for counters, `computeIfAbsent` for map-of-lists, `putIfAbsent` for a single-lookup insert, and `containsKey` to tell "absent" from "mapped to null".

```java
counts.merge(word, 1, Integer::sum);
groups.computeIfAbsent(key, k -> new ArrayList<>()).add(item);
```

<details>
<summary>Go deeper: full method family</summary>

- `remove(k)`: hash, index, bucket walk, unlink, `size--`. No resize on removal.
- `containsKey(k)`: same lookup as `get`, but distinguishes "key absent" from "key present with `null` value", which `get()` can't.
- `putIfAbsent(k, v)`: insert only if absent; one lookup instead of two.
- `computeIfAbsent(k, fn)`: lazily-initialised nested collections.
- `computeIfPresent(k, fn)`: acts only if present; removes the entry if `fn` returns `null`.
- `compute(k, fn)`: unconditional; removes the entry if `fn` returns `null`.
- `merge(k, value, fn)`: the classic counter idiom.
- Mutable keys: same mechanism as HashSet (Part 4), with a bigger blast radius, because the value becomes unreachable too.

</details>

## HashMap vs Hashtable vs ConcurrentHashMap

| | HashMap | Hashtable | ConcurrentHashMap |
|---|---|---|---|
| Thread-safe | No | Yes, one lock for the whole map | Yes, locks only one bucket at a time |
| Null key / values | One null key, null values allowed | Not allowed | Not allowed |
| Speed under many threads | Not safe to share | Slow | Fast |
| Use today? | Single-thread code | Legacy only | Shared maps |

**Next questions an interviewer usually asks:**
- How does ConcurrentHashMap stay thread-safe without locking the whole map? (Java Concurrency, Part 17)
- Why do `hashCode()` and `equals()` have to agree? (Part 4, HashSet)

# Part 6 — LinkedHashMap

> **Key ideas (revise in 1 minute)**
> - A `HashMap` plus a doubly linked list through every entry, so iteration has a defined order.
> - Default is insertion order. `accessOrder = true` moves a key to the tail on `get` and `put`.
> - Override `removeEldestEntry` for a bounded LRU. It is not thread-safe and it has no TTL.

> **In plain words:** a LinkedHashMap is a HashMap that also remembers the order you inserted (or touched) the keys.

## How does `LinkedHashMap` add order on top of `HashMap`?

**30-second answer:** It extends `HashMap` and threads a doubly linked list through the entries. Lookup still uses the bucket, so it stays O(1) on average. Iteration follows the list, so it is O(n) in the number of entries, not in the table length. A plain `HashMap` iteration walks empty buckets too.

```java
static class Entry<K,V> extends HashMap.Node<K,V> {
    Entry<K,V> before, after;   // the ordering linked list
}

transient LinkedHashMap.Entry<K,V> head, tail;
```

**Interview trap:** saying iteration is faster because "it is still a hash table." The win is not visiting empty buckets. The lookup cost is the same as `HashMap`.

## What is the difference between insertion order and access order?

**30-second answer:** Pass `accessOrder` to the three-argument constructor. `accessOrder = false` (the default) keeps insertion order, and putting an existing key does not move it. `accessOrder=true` moves that key to the tail on every `get` or `put`, via `afterNodeAccess()`. In access-order mode, `get` is no longer a pure read.

```java
new LinkedHashMap<>(initialCapacity, loadFactor, accessOrder)
```

**Interview trap:** using access-order mode and expecting `get` to be side-effect free. It relinks. That also makes it a poor fit for a concurrent map: a read would be a write.

## How do you build an LRU cache with `removeEldestEntry`?

**30-second answer:** After every `put` and `putAll`, `LinkedHashMap` calls `removeEldestEntry` with the current head. Return true to drop that eldest entry. The default returns false. One override on an access-order map is a bounded LRU.

```java
protected boolean removeEldestEntry(Map.Entry<K,V> eldest) {
    return false; // default: never remove anything
}
```

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

- `size() > maxSize` runs after the new entry is in, so a max of 500 lets the size hit 501 and then drops the eldest, leaving 500.
- The hook rides on machinery the class already had for order. You do not write your own list.

**Interview trap:** forgetting `accessOrder = true` and calling the result an LRU. Without it you evict the oldest insertion, which is FIFO, not least-recently used.

## Why is this a weak production cache?

**30-second answer:** It is not thread-safe (concurrent relinking corrupts the list). It has no TTL. It is pure LRU, not LFU or weighted eviction. If you never override `removeEldestEntry`, it grows without bound.

**Interview trap:** sharing one `LinkedHashMap` across requests. Use `ConcurrentHashMap` plus a real cache (Caffeine) once you need TTL, weights, or concurrency.

## How does it compare with `HashMap`, `ConcurrentHashMap`, and Redis?

**30-second answer:** In-process maps die with the process and are invisible to other instances. If the cache must survive a restart or be shared, the structure inside the JVM is the wrong layer. You want Redis (or something like it).

| | `HashMap` | `LinkedHashMap` | `ConcurrentHashMap` | Redis (external) |
|---|---|---|---|---|
| Ordering | none | insertion or access order | none | depends on structure |
| Thread safety | none | none | yes, fine-grained | yes (serialized) |
| Built-in LRU | no | yes | no | yes, configurable |
| Survives restart | no | no | no | yes |
| Shared across instances | no | no | no | yes — the feature that matters |

**Interview trap:** tuning an in-process LRU and then discovering the second app instance has a cold cache. Sharing was the requirement. The map type cannot meet it.

## What did Java 21 add on `LinkedHashMap`?

**30-second answer:** Because it implements `SequencedMap`, the ends are O(1) and you can insert at either end. `putFirst` and `putLast` did not exist before. There was no way to force a key to the front of the iteration order.

```java
map.firstEntry();        // O(1), reads head
map.lastEntry();         // O(1), reads tail
map.pollFirstEntry();    // removes and returns first
map.pollLastEntry();     // removes and returns last
map.putFirst("z", 0);    // insert at front — new capability
map.putLast("y", 4);     // insert/move to end
SequencedMap<String,Integer> rev = map.reversed(); // live reversed VIEW
```

**Interview trap:** treating `reversed()` as a copy. It is a live view. Writes through it show up in the original map.

**Next questions an interviewer usually asks:**
- Why is there no safe `removeEldestEntry` on `ConcurrentHashMap`? (Part 13, and Part 32 question 11)
- When do you want sort order instead of insertion order? (Part 7)

---

# Part 7 — TreeMap

> **Key ideas (revise in 1 minute)**
> - A red-black tree. No hashing. Every operation is O(log n), including `firstKey`.
> - Key identity is `compare == 0`, not `equals()`. A comparator that disagrees with `equals` silently drops keys.
> - Pay the log cost only when you actually need sorted order or ranges. Otherwise use `HashMap` or `LinkedHashMap`.

> **In plain words:** a TreeMap keeps keys in sorted order in a balanced tree, so ranges and neighbors are cheap and plain gets are not.

## What is `TreeMap` built on?

**30-second answer:** A red-black tree. Comparisons decide everything. There is no hash.

```java
private transient Entry<K,V> root;

static final class Entry<K,V> implements Map.Entry<K,V> {
    K key;
    V value;
    Entry<K,V> left, right, parent;
    boolean color = BLACK;
}
```

**Interview trap:** describing `TreeMap` as "a sorted HashMap." The lookup path never calls `hashCode()`.

## Why does the tree have to stay balanced?

**30-second answer:** A plain BST becomes a linked list if you insert in sorted order, and lookup falls to O(n). Red-black rules keep the height O(log n) no matter the insertion order.

**Interview trap:** "TreeMap is O(log n) on average, like HashMap." It is O(log n) in the worst case. HashMap is O(1) on average and can be worse. They are not the same shape.

## What are the red-black invariants?

**30-second answer:** Five rules. The one that bounds the height is that every root-to-leaf path has the same number of black nodes, and a red node cannot have a red child. Together those make the longest path at most twice the shortest, so the height is O(log n).

1. Every node is red or black.
2. The root is black.
3. A red node cannot have a red child.
4. Every path from the root to a leaf has the same number of black nodes.
5. From (3) and (4): the longest path is at most twice the shortest.

**Interview trap:** reciting the colors and not saying what they buy you. The point is the height bound.

## What do rotations do?

**30-second answer:** A left or right rotation is an O(1) local rewrite that keeps in-order traversal the same. Fixing a violation after insert or delete takes O(log n) rotations in the worst case, and inserts are often O(1) amortized in the number of rotations.

**Follow-up: what pointers move in one left rotation?**

`TreeMap` rotates left at a node `p` whose right child is `r`:

- `p.right` becomes `r.left`, and if that subtree exists its parent becomes `p`.
- `r` takes `p`'s parent (or becomes the root).
- `r.left` becomes `p`, and `p.parent` becomes `r`.

```
      p                 r
     / \               / \
    a   r      =>     p   c
       / \           / \
      b   c         a   b
```

A typical insert that needs this: keys 10, then 20, then 30 (natural order). 30 sits on a red-red right spine. One left rotation at 10, then a recolor, leaves 20 black with 10 and 30 red. In-order is still 10, 20, 30.

**Interview trap:** saying a rotation changes sort order. It changes shape. The in-order sequence stays the same.

## Where does the order come from?

**30-second answer:** Either the keys' `compareTo`, or a `Comparator` you pass in. Every comparison goes through that. Never through `hashCode()` or `equals()`.

```java
new TreeMap<K,V>();                     // requires K implements Comparable<K>
new TreeMap<K,V>(Comparator<K> cmp);    // uses supplied comparator
```

**Interview trap:** a `TreeMap` of a type that is not `Comparable`, with no comparator. That fails at the first `put`, not at construction.

## What happens if the comparator disagrees with `equals`?

**30-second answer:** `TreeMap` treats `compare == 0` as "same key," even when `equals` says they differ. The second `put` overwrites the first and `size()` stays 1. The fix is a tie-breaker so two unequal keys never compare as zero.

```java
Comparator<Person> byAge = Comparator.comparingInt(Person::getAge);
TreeMap<Person, String> map = new TreeMap<>(byAge);

map.put(new Person("Alice", 30), "engineer");
map.put(new Person("Bob", 30), "designer");   // same age!

map.size(); // 1, not 2
```

- Fix: `Comparator.comparingInt(Person::getAge).thenComparing(Person::getName)`.
- The same rule applies to `TreeSet`. This is the bug behind "the set silently lost an entry."

**Interview trap:** testing only `equals` and assuming the tree agrees. The tree never calls `equals` to decide key identity.

## What do the operations cost?

**30-second answer:** `put`, `get`, and `remove` are O(log n). So are `firstKey` and `lastKey`: they walk one path. They are not O(1) the way `LinkedHashMap`'s head and tail are. `floorKey`, `ceilingKey`, `lowerKey`, and `higherKey` are the same kind of descent. That is the `NavigableMap` part.

- `floor` / `lower`: at or below, versus strictly below.
- `ceiling` / `higher`: at or above, versus strictly above.

**Interview trap:** mixing up `floor` and `lower`. `lower` never returns the key you passed if it is present. `floor` does.

## What do the range views cover?

**30-second answer:** `headMap`, `tailMap`, and `subMap` are live views. A mutation inside the bounds shows up in the original map, and the other way around. They are not copies.

```java
map.headMap(toKey);              // key < toKey
map.tailMap(fromKey);             // key >= fromKey
map.subMap(fromKey, toKey);       // [fromKey, toKey)
```

**Interview trap:** putting a key outside the view's range. The view throws. The backing map would have accepted it.

## When is `TreeMap` the right tool, and when is it not?

**30-second answer:** Use it when sorted iteration is continuous, or you need ranges (`subMap`, `floorKey`) or a continuously maintained first and last key. Do not use it just because "we might want order later."

- Insertion order, O(1) lookup: `LinkedHashMap`.
- One sorted snapshot at read time: `HashMap`, copy the keys, sort the list once.
- `TreeMap` charges O(log n) on every write. That cost is worth it only if you use the order.

**Interview trap:** `TreeMap` for a leaderboard of "current top 10" with no range queries. A size-10 heap does that in O(log 10) per update (Part 11).

**Next questions an interviewer usually asks:**
- Which `Set` wraps this map? (Part 8)
- What is the concurrent sorted map? (`ConcurrentSkipListMap`, Part 13)

---

# Part 8 — Sets

> **Key ideas (revise in 1 minute)**
> - `HashSet`, `LinkedHashSet`, and `TreeSet` are maps with a dummy value. Their costs match the map.
> - `EnumSet` is a bit vector, not a map. `CopyOnWriteArraySet` is a copied array.
> - Pick by order, ranges, concurrency, and whether the universe is an enum.

> **In plain words:** most sets are a map that ignores the value. Choose the set by choosing the map you actually wanted.

## Why is each common `Set` "a map in a trench coat"?

**30-second answer:** `HashSet` wraps `HashMap`. `TreeSet` wraps a `TreeMap` (`NavigableMap<E,Object>`). `LinkedHashSet` extends `HashSet` and uses a package-private constructor that installs a `LinkedHashMap` instead. They inherit the map's performance, including its traps.

**Interview trap:** expecting `TreeSet.contains` to use `hashCode()`. It uses the comparator, same as `TreeMap`.

## How do the JDK sets compare?

**30-second answer:** `HashSet` is the default. Add order only if you need it. Add a tree only if you need sort or ranges. An enum domain should be an `EnumSet`. Concurrency splits into copy-on-write (small, rare writes), a skip list (sorted), or `ConcurrentHashMap.newKeySet()` (general).

| | `HashSet` | `LinkedHashSet` | `TreeSet` | `EnumSet` | `CopyOnWriteArraySet` | `ConcurrentSkipListSet` |
|---|---|---|---|---|---|---|
| Backing | `HashMap` | `LinkedHashMap` | `TreeMap` | bit vector | `CopyOnWriteArrayList` | `ConcurrentSkipListMap` |
| Ordering | none | insertion/access | sorted | enum declaration order | insertion order | sorted |
| add/remove/contains | O(1) avg | O(1) avg | O(log n) | O(1) bit ops | O(n) write, O(1) read | O(log n) |
| Thread safety | none | none | none | none | yes | yes |
| Range queries | no | no | yes | no | no | yes |
| Null elements | one allowed | one allowed | not allowed | not allowed | allowed | not allowed |
| Best for | general default | uniqueness + order | uniqueness + sorted + range | fixed enum universe | read-heavy, rare writes | sorted + concurrent |

**Interview trap:** `TreeSet` of a type with a sloppy comparator. `compare == 0` drops the element even when `equals` is false (Part 7).

## Why is `EnumSet` different?

**30-second answer:** It is not a wrapped map. It is a bit vector: one `long` for up to 64 constants (`RegularEnumSet`), a `long[]` beyond that (`JumboEnumSet`). `add`, `remove`, and `contains` are bitwise. No hashing, no per-element node. Part 17 goes through it.

**Interview trap:** putting `null` in an `EnumSet`. Null is not a constant. It is rejected.

## Why is `CopyOnWriteArraySet` the odd one out?

**30-second answer:** It is a `CopyOnWriteArrayList`. `add` scans with `contains` (O(n)), then copies the whole array to append (another O(n)). That only pays off for a small set that is rarely written and often iterated under concurrency, such as a listener list.

**Interview trap:** using it to deduplicate a large stream. Every add copies the array.

## What did Java 21 add for sets?

**30-second answer:** `LinkedHashSet` implements `SequencedSet`, so the ends and `reversed()` are real API. `TreeSet` already had most of this through `NavigableSet` and now exposes it as `SequencedSet` too. `HashSet` does not implement `SequencedSet`. It has no order to expose.

```java
set.getFirst(); set.getLast();
set.addFirst("z"); set.addLast("y");
SequencedSet<String> rev = set.reversed();
```

**Interview trap:** `HashSet.getFirst()`. It does not exist. There is no defined first element.

## How do you pick a `Set`?

**30-second answer:** Walk the questions in order. Uniqueness first, then order, then ranges, then enum, then concurrency, then size.

1. Do you need uniqueness, or is this actually a `List`?
2. Any order? None → `HashSet`. Insertion or access order → `LinkedHashSet`. Full sort → `TreeSet`.
3. Ranges or navigation? → `TreeSet`.
4. A fixed, small, compile-time enum? → `EnumSet`.
5. Concurrency? Read-heavy and small → `CopyOnWriteArraySet`. Sorted and concurrent → `ConcurrentSkipListSet`. General concurrent uniqueness → `ConcurrentHashMap.newKeySet()`.
6. Large, write-heavy, and concurrent? Do not use `CopyOnWriteArraySet`.
7. Memory: `EnumSet` and `HashSet` are the cheap ones. `TreeSet` and `ConcurrentSkipListSet` pay more per node.

**Interview trap:** jumping to "thread-safe" before deciding whether you needed a set at all.

**Next questions an interviewer usually asks:**
- `ArrayDeque` versus `LinkedList` for a queue? (Part 9)
- `EnumSet` bits in more detail? (Part 17)

---

# Part 9 — Queue and Deque

> **Key ideas (revise in 1 minute)**
> - `ArrayDeque` is a ring buffer. Both ends are O(1). It is the default queue, deque, and stack.
> - Java 21 wraps indexes with `inc` / `dec`, not a power-of-two bitmask. One slot stays empty.
> - It rejects `null`. `LinkedList` is the deque that allows `null`.

> **In plain words:** an ArrayDeque is an array used as a circle, so adding at either end does not slide the other elements.

## How does `ArrayDeque` store elements?

**30-second answer:** One array plus two indexes. `head` is the next element to remove from the front. `tail` is the next slot to fill at the back. The indexes wrap. Elements never shift just because you added at the front.

```java
transient E[] elements;
transient int head;
transient int tail;
```

- On Java 21 the array length is not forced to a power of two. `new ArrayDeque<>(numElements)` allocates `numElements + 1` slots (at least 1). One slot stays empty so the deque can tell "empty" from "full."
- `addFirst` stores at `head = dec(head, length)`, which is `head - 1`, wrapping to `length - 1` when it would go negative.
- `addLast` stores at the current `tail`, then sets `tail = inc(tail, length)`, which is `tail + 1`, wrapping to 0 at the end.
- If an insert makes `head == tail`, the array was full and `grow` runs.

**Interview trap:** using the pre-21 bitmask on a Java 21 deque whose length is not a power of two. `(i + 1) & (length - 1)` is wrong when `length` is 9. `inc` / `dec` are the real wrap.

<details>
<summary>Go deeper: the pre-Java 21 ring, and today's growth</summary>

Through JDK 20 the array length was a power of two and the wrap was a mask:

```java
head = (head - 1) & (elements.length - 1);   // addFirst
tail = (tail + 1) & (elements.length - 1);   // addLast
```

That mask equals modulo only because `length` was a power of two. Java 21 dropped the restriction. `dec` and `inc` are plain wrap-around, and they match the old mask when the length happens to be a power of two.

Growth changed too. The old deque doubled, like `HashMap`. On Java 21 the new length is `2 * old + 2` while the array is shorter than 64, and `old + (old >> 1)` from 64 up. It still copies into a new array and resets the ring so `head = 0` and the elements sit contiguously from the start.

`null` is rejected. The implementation uses null as an empty slot, so a null element would look like a hole.

</details>

## Why does `ArrayDeque` beat `LinkedList` and `Stack`?

**30-second answer:** Same O(1) at both ends as `LinkedList`, with array locality and no per-node object. It is a rare case of a strictly better default, not a trade-off. The costs you give up: no `get(index)`, and no nulls.

- `Stack` extends `Vector`, so every call is `synchronized`, which is wasted in one thread and still not enough for compound actions across threads (Part 10).

**Interview trap:** "`ArrayDeque` cannot be a stack." It can. `push` is `addFirst`, `pop` is `removeFirst`.

## Which method is the queue form, and which is the stack form?

**30-second answer:** A deque used as a queue adds and removes at opposite ends. A deque used as a stack adds and removes at the front. The throwing methods and the null-returning methods match Part 1.

| Operation | `Queue` (FIFO) | `Deque` as queue | `Deque` as stack |
|---|---|---|---|
| Insert | `offer(e)` / `add(e)` | `offerLast` / `addLast` | `push` = `addFirst` |
| Remove | `poll()` / `remove()` | `pollFirst` / `removeFirst` | `pop` = `removeFirst` |
| Peek | `peek()` / `element()` | `peekFirst` / `getFirst` | `peek` = `peekFirst` |

**Interview trap:** `pop` on an empty `ArrayDeque` throws. `poll` returns null. Pick the one that matches "empty is exceptional" versus "empty is normal."

## What did Java 21 add for deques?

**30-second answer:** `Deque` already had first/last methods. Java 21 adds `reversed()`, a live reversed view, and the shared `SequencedCollection` type so a deque, a list, and a linked hash set can be talked about the same way.

**Interview trap:** expecting `Queue` itself to be sequenced. `Queue` is not a `SequencedCollection`. `Deque` is.

## What should you reach for by default?

**30-second answer:** `ArrayDeque` for almost every deque, queue, or stack. `LinkedList` only when you need null elements. `java.util.Stack` almost never.

**Interview trap:** `PriorityQueue` when you wanted FIFO. A heap is not a queue in insertion order (Part 11).

**Next questions an interviewer usually asks:**
- Trace `addFirst` and `addLast` on a wrapped ring. (Part 32, question 7)
- Why is `Stack` legacy? (Part 10)

---

# Part 10 — Stack

> **Key ideas (revise in 1 minute)**
> - `java.util.Stack` extends `Vector`. Every method is synchronized, and the full `List` API is exposed.
> - Synchronization on one call is not atomicity of a sequence of calls.
> - The Java 21 stack is a `Deque` variable holding an `ArrayDeque`.

> **In plain words:** the Stack class is a synchronized Vector that happens to have push and pop. It is not the structure you want for a stack.

## What is `Stack` actually?

**30-second answer:** A `Vector` subclass. Every method is `synchronized`. That costs a lock even in one thread, and it still does not make "push then pop" atomic across threads, because each call locks and unlocks on its own.

```java
public class Stack<E> extends Vector<E>
```

**Interview trap:** "Stack is thread-safe, so I can use it from many threads." Each call is locked. A check-then-act across two calls is not.

## Why is that a legacy design?

**30-second answer:** Three concrete reasons. The lock is unconditional. The type extends `Vector` rather than `Deque`, so `get(index)` and `add(index, e)` are legal and nothing forces LIFO. Growth is `Vector`'s doubling, an older policy than `ArrayList`'s 1.5x.

**Interview trap:** treating "it extends List" as a feature for a stack. It means any caller can poke the middle.

## How does it compare with `Deque` and `ArrayDeque`?

**30-second answer:** Declare a `Deque`. Construct an `ArrayDeque`. You get LIFO, no lock, and a ring buffer. Keep `java.util.Stack` only where an old API demands that exact class.

| | `Stack` | `Deque` (interface) | `ArrayDeque` |
|---|---|---|---|
| Backing | `Vector` | — | ring buffer |
| Thread safety | synchronized per call, not for compound actions | none promised | none |
| API discipline | full `List` API | LIFO-shaped methods | same as `Deque` |
| Null elements | allowed | depends on the class | not allowed |
| Modern status | legacy | the type to declare | the implementation to construct |

```java
Deque<Integer> stack = new ArrayDeque<>();
stack.push(1); stack.push(2); stack.push(3);
stack.pop();      // 3
stack.peek();      // 2
```

**Interview trap:** synchronizing on a `Stack` and also calling its methods. The methods already lock on `this`. External locking on the same object is easy to get wrong, and you still do not want this class.

**Next questions an interviewer usually asks:**
- Min-heap versus stack? (Part 11)
- A thread-safe stack? Often an `ArrayDeque` owned by one thread, or a concurrent deque if it is actually shared.

---

# Part 11 — PriorityQueue

> **Key ideas (revise in 1 minute)**
> - A binary heap in an array. Default is a min-heap: `poll` returns the smallest.
> - `offer` and `poll` are O(log n). `peek` is O(1). `remove(Object)` and `contains` are O(n).
> - Iteration is heap order, not sorted order. Only a loop of `poll` sorts.

> **In plain words:** a PriorityQueue is a heap. The smallest element sits at the front of the array. The rest is only partly ordered.

## How is the heap stored?

**30-second answer:** A compact array. Index arithmetic is the tree. There are no child pointers. The default comparator is natural order, so the smallest element is the root. Pass `Comparator.reverseOrder()` for a max-heap.

```java
transient Object[] queue;
private int size;
private final Comparator<? super E> comparator; // null → natural ordering
```

```
parent  = (i - 1) / 2
left    = 2*i + 1
right   = 2*i + 2
```

**Interview trap:** assuming the array is sorted. It is a heap. Children are only ordered relative to their parent.

## What do `offer`, `poll`, and `peek` do?

**30-second answer:** `offer` writes at `queue[size]` and sifts up while the heap property is broken. `poll` moves the last element to the root and sifts down. Both are O(log n), bounded by the height. `peek` returns `queue[0]` and is O(1).

- Sift up: compare with the parent, swap if the child should be above, repeat toward the root.
- Sift down: compare with the children, swap with the smaller one (per the comparator), repeat toward the leaves.

**Interview trap:** `remove(Object)` is not `poll`. `poll` already knows the root. `remove(Object)` has no index, so it scans the array, which is O(n), and then sifts. `contains` is the same scan.

## Why is building a heap from a collection O(n)?

**30-second answer:** `new PriorityQueue<>(collection)` uses Floyd's heapify. It sifts down from the last non-leaf back toward the root. Most nodes are near the bottom, so those sifts are short. The total is O(n), not O(n log n) of inserting one by one.

**Interview trap:** saying "n inserts, so O(n log n)" for the constructor. The constructor does not do that.

## What does each operation cost?

**30-second answer:** The heap gives you the extreme element quickly. It does not help you find an arbitrary element.

| Operation | Complexity | Why |
|---|---|---|
| `offer(e)` | O(log n) | sift-up, bounded by height |
| `poll()` | O(log n) | sift-down, bounded by height |
| `peek()` | O(1) | the root is the min (or the max, if you reversed the comparator) |
| `remove(Object)` | O(n) | linear scan first; the heap has no index by value |
| `contains(Object)` | O(n) | same scan |
| construct from a collection | O(n) | Floyd's heapify |

**Interview trap:** quoting O(log n) for `remove(someTask)`. That is `poll`. Arbitrary remove is linear.

## Why is iteration not sorted?

**30-second answer:** `iterator()` walks the array. The heap property only says the root is the extreme element. Siblings and cousins can be in any order. `new ArrayList<>(pq)` uses that iterator, so the list is not sorted. A loop of `poll` is sorted, and it empties the heap.

```java
PriorityQueue<Integer> pq = new PriorityQueue<>(List.of(5, 1, 4, 2, 3));
for (int x : pq) { ... }   // NOT guaranteed sorted order
```

- With `Comparator.reverseOrder()` and inserts 5, 1, 4, 2, 3, the array iteration is `[5, 3, 4, 1, 2]`. Poll order is `[5, 4, 3, 2, 1]`.
- The heap is not stable. If the comparator says two tasks are equal, their relative order is not FIFO.

**Interview trap:** printing a `PriorityQueue` and thinking the print order is the priority order.

## Where is a heap the right structure?

**30-second answer:** Top-K and Kth largest/smallest (a heap of size K while you scan, O(n log K)). Schedulers and Dijkstra or Prim. Merging K sorted streams (a heap of the K current heads, O(n log K)).

- For Dijkstra with decrease-key, the JDK heap has no O(log n) priority update. People re-insert and skip stale entries, or they use an indexed heap, or a `TreeSet` on `(distance, nodeId)`.

**Interview trap:** a `PriorityQueue` as a fair task queue. Equal priorities do not come out in arrival order.

**Next questions an interviewer usually asks:**
- `remove(Object)` versus `poll`. (Part 32, question 8)
- Immutable snapshot versus unmodifiable view. (Part 12)

---

# Part 12 — Immutable and Unmodifiable Collections

> **Key ideas (revise in 1 minute)**
> - `List.of` / `Set.of` / `Map.of` and the `copyOf` methods are immutable. No reference can change them.
> - `Collections.unmodifiableList` is a view. The backing collection can still change.
> - Immutable means thread-safe for the collection itself. Unmodifiable does not.

> **In plain words:** unmodifiable means "you can't change it through this reference." Immutable means "nobody can change it."

## What do `List.of`, `Set.of`, and `Map.of` guarantee?

**30-second answer:** `List.of`, `Set.of`, and `Map.of` are immutable. Every mutator throws `UnsupportedOperationException`, forever. Nothing holds a back door. They reject null at construction with a `NullPointerException`. `Set.of` throws `IllegalArgumentException` on a duplicate instead of quietly keeping one.

**Interview trap:** `List.of(array).set(0, x)` and also `List.of` of a mutable object. The list structure is frozen. The objects inside it are not, unless those objects are immutable too.

## What does `copyOf` add?

**30-second answer:** `List.copyOf`, `Set.copyOf`, and `Map.copyOf` are real defensive copies. Later mutation of the source does not show up in the snapshot. If the source is already an immutable instance of the same kind, the JDK returns that same instance instead of copying again.

```java
List<String> mutable = new ArrayList<>(List.of("a", "b"));
List<String> snapshot = List.copyOf(mutable);
mutable.add("c");
snapshot.size(); // still 2
```

**Interview trap:** `List.copyOf` on a list whose elements are mutable objects, and assuming the elements were cloned. Only the list structure is copied. The element references are shared.

## What does `Collections.unmodifiableList` actually do?

**30-second answer:** It blocks mutation through the wrapper. It does not block mutation through any other reference to the same list. The view sees those changes. That is a common production bug: hand out an "unmodifiable" list and keep mutating the original.

```java
List<String> mutable = new ArrayList<>(List.of("a", "b"));
List<String> view = Collections.unmodifiableList(mutable);
view.add("c");        // throws UnsupportedOperationException
mutable.add("c");     // succeeds!
view.size();           // 3 — the view SAW the mutation
```

**Interview trap:** publishing `Collections.unmodifiableList(internal)` and calling it thread-safe. If another thread mutates `internal`, readers of the view data-race.

## Which word means which promise?

**30-second answer:** Use the three words precisely. Most bugs in this area are two of them being treated as the same.

| Term | Meaning |
|---|---|
| Mutable | can be changed through any reference |
| Immutable | cannot be changed through any reference, ever |
| Unmodifiable | cannot be changed through this specific reference only |

**Interview trap:** the word "immutable" in a code review that only wrapped the return value. Ask who else holds the backing list.

## How should an API expose internal state?

**30-second answer:** Three options, in increasing honesty. (1) Return the live mutable list. Callers can corrupt you. (2) Return an unmodifiable view. Callers cannot mutate through it, but your later mutations leak out, and a caller who kept an element can still mutate that element. (3) Return `List.copyOf` or build with `List.of`. That is the only one that means "this will not change."

**Interview trap:** defensive-copying on the way out and forgetting the way in. A caller who keeps the list they passed you can mutate your state later. Copy on both boundaries (Part 24).

## What does this mean for threads and for memory?

**30-second answer:** A truly immutable collection has no mutable structure to race on, so sharing it needs no lock. An unmodifiable view has none of that protection if the backing collection is still being written. `List.of` uses tiny special cases for zero, one, and two elements and does not keep growth slack. `Collections.unmodifiableList` is only a thin wrapper. It is cheap because it does not copy, and that cheapness is the leak.

**Interview trap:** "unmodifiable, so we saved a copy and stayed thread-safe." You saved a copy. You did not get thread safety.

**Next questions an interviewer usually asks:**
- How do you publish a config map to many virtual threads? (Part 25 and Part 26: swap a `volatile` immutable snapshot)
- What does `ConcurrentHashMap` do that a synchronized `HashMap` does not? (Part 13)

# Part 13 — Concurrent Collections

> **Key ideas (revise in 1 minute)**
> - A plain `HashMap` can lose entries, throw, or (on old JDKs) spin forever if two threads mutate it.
> - `ConcurrentHashMap` uses CAS for an empty bin, a lock on the bin head otherwise, and no lock on `get`.
> - `null` keys and values are forbidden. `get() == null` must mean "absent."

> **In plain words:** a ConcurrentHashMap lets many threads update different keys without taking one lock for the whole map.

## Why is a plain `HashMap` unsafe to share?

**30-second answer:** Two writers can break the bucket chain and lose entries (lost updates). Iteration during a write can throw `ConcurrentModificationException` or show a torn read. On Java 7 and earlier, the old prepend-based rehash could build a circular chain under a concurrent resize and peg a core at 100%. Java 8's lo/hi resize preserves order and avoids that particular cycle. Concurrent mutation is still unsafe.

**Interview trap:** "Java 8 fixed concurrent HashMap." It fixed one infinite-loop bug. It did not add synchronization. Share a `ConcurrentHashMap`, or do not share the map.

## How does Java 8+ `ConcurrentHashMap` work?

**30-second answer:** Empty-bin inserts are a CAS, with no lock. Colliding inserts lock only that bin's head. `get` never locks. A resize can be helped along by any thread that arrives mid-resize.

- Before Java 8 the map used segment-based locking (16 segments by default), each with its own lock. That was coarser.
- CAS covers the common case: `compareAndSwapObject` into an empty bin.
- Bin-level locking: a collision synchronizes on that bucket's head node, not on the whole table.
- `get` is a volatile read of the `Node[] table` and of the node links. Nodes are safely published before a reader can see them, so a reader never needs the bin lock.
- Resize is cooperative. A thread that hits a `ForwardingNode` helps move buckets instead of waiting for one thread to finish the whole table.

```visualizer concurrenthashmap
```

**Interview trap:** "`get` locks for a short time." It does not lock at all. The publication is the `volatile` table (and the volatile/final fields on the node), not a lock.

## Where do `compute`, `merge`, and `putIfAbsent` actually matter?

**30-second answer:** Check-then-act is still a race on a concurrent map. `containsKey` then `put` is two calls. Another thread fits in between. `computeIfAbsent`, `merge`, `compute`, and `putIfAbsent` do the read and the write as one atomic action per key.

```java
// WRONG — race condition
if (!map.containsKey(key)) { map.put(key, computeExpensiveValue()); }

// CORRECT — atomic per-key
map.computeIfAbsent(key, k -> computeExpensiveValue());
```

- The mapping function runs while that bin is locked, so it must be short.
- Do not update the same map from inside the function. On an empty bin, `computeIfAbsent` installs a `ReservationNode` for the duration of the lambda. A nested update of any key in that same bin throws `IllegalStateException: Recursive update`. A nested update of a different bin might not throw, and can still deadlock if two threads lock bins in opposite orders. The JDK docs forbid updating any other mapping of this map from the function.
- Fix: build the value with no callback into this map, then insert it. Use a different map for scratch state.

**Interview trap:** `putIfAbsent` of a freshly computed value when the value is expensive. `putIfAbsent` evaluates the value before the call. Two threads can both compute it. `computeIfAbsent` runs the function only if the key is absent.

## How do the thread-safe map options compare?

**30-second answer:** `ConcurrentHashMap` is the default shared map. A hand-rolled lock or `Collections.synchronizedMap` locks the whole map, blocks readers behind writers, and still races on compound actions unless you lock them yourself. Iteration on `ConcurrentHashMap` is weakly consistent and does not throw `ConcurrentModificationException`.

| | `HashMap` + your lock | `Collections.synchronizedMap` | `ConcurrentHashMap` |
|---|---|---|---|
| Locking granularity | whatever you wrote | one lock, the whole map | per bin, CAS if the bin is empty |
| Read concurrency | blocked by writers | blocked | not blocked |
| Compound actions | safe only if you lock them | still racy | atomic via `compute` / `merge` |
| Iteration | must lock externally | must lock externally | weakly consistent, no CME |
| Null keys/values | allowed | allowed | not allowed |

- Null is banned because `get() == null` would mean either "absent" or "present and null," and a follow-up `containsKey` is useless if another thread can change the map between the two calls.

**Interview trap:** `synchronizedMap` and then `put` inside `compute` of a different structure. Also: wrapping a `HashMap` in `synchronized` and believing `get` then `put` of a counter is atomic. It is not. Use `merge` or a `LongAdder`.

## What are the other concurrent collections?

**30-second answer:** `ConcurrentLinkedQueue` and `ConcurrentLinkedDeque` are lock-free CAS queues in the Michael-Scott family, and they are unbounded. `ConcurrentSkipListMap` and `ConcurrentSkipListSet` are the sorted concurrent analogues of `TreeMap` and `TreeSet`. They use a skip list, not a red-black tree, because a skip list is much easier to update lock-free. Expected cost is O(log n). Height is probabilistic. Blocking queues are Part 15.

- Choose a skip list over `ConcurrentHashMap` only when you need sorted keys or ranges (`subMap`, `headMap`, `tailMap`). You pay more memory and slower point lookups. You gain order.
- `ConcurrentHashMap` is the default "thread-safe map." Leave it for sorted-plus-concurrent, or for a genuine need for null (which usually means a redesign, not a `Hashtable`).

**Interview trap:** `ConcurrentSkipListMap` "because it is faster than ConcurrentHashMap." It is not, for plain get/put. It is faster only in the sense that a hash map cannot do the range query at all.

**Next questions an interviewer usually asks:**
- Why does `CopyOnWriteArrayList` not use a bin lock? (Part 14)
- What does a bounded queue give you that these maps do not? Backpressure. (Part 15)

---

# Part 14 — CopyOnWrite Collections

> **Key ideas (revise in 1 minute)**
> - Every write copies the whole array and publishes it with one volatile write.
> - Readers and iterators never lock, and iterators never throw `ConcurrentModificationException`.
> - The copy is O(n) per write. Right for rare writes. Wrong for a hot update path.

> **In plain words:** a CopyOnWrite list never edits the array a reader is looking at. It builds a new array and swings the reference.

## What happens on a write?

**30-second answer:** Take the lock, copy the array, apply the change to the copy, publish `this.array = newArray` with one volatile write, release the lock. Every write copies the whole array. There is no slack capacity. The copy is the publication mechanism, so it cannot be skipped.

```java
private transient volatile Object[] array;
```

**Interview trap:** "add is amortized O(1), like ArrayList." It is O(n) every time. There is no spare capacity to absorb the next write, because the next write must publish a fresh array.

## Why do reads take no lock?

**30-second answer:** `array` is volatile, so a reader sees either the old array or the new one, never a torn mix. The writer does not mutate the array the reader holds. Once that is true, a lock on the read path adds nothing.

**Interview trap:** expecting a read to see a write that happened halfway through the iteration. It sees the snapshot from when the iterator was created. That is the point.

## What does the iterator actually capture?

**30-second answer:** The iterator copies the array reference once, at creation, and walks that array. Writers later swing `array` to a different object. The iterator never looks at `modCount`, because its array cannot change. It therefore never throws `ConcurrentModificationException`. The cost is staleness: writes after the iterator was created are invisible to it.

**Interview trap:** "it doesn't throw because it is well tested." It doesn't throw because the iterator holds a private frozen array.

## What do the copies cost?

**30-second answer:** Each write allocates a new array of about n slots. m writes while the list sits near size n allocate on the order of m × n slots over that period. That is real GC pressure as soon as writes are not rare.

- `CopyOnWriteArraySet` is this list plus an O(n) `contains` scan before the copy. Two linear passes per add.
- It fits event listeners and rarely changing registries: few writes, many iterations, and "don't fail the dispatch because the set changed" is the behavior you want.
- It does not fit a write-heavy, large collection. Throughput falls apart and the collector works overtime.

**Interview trap:** a copy-on-write list of millions of elements "because reads must be fast." The reads are fast. The next write copies millions of references.

**Next questions an interviewer usually asks:**
- Bounded versus unbounded queues? (Part 15)
- Listener lists in Part 26 and Part 29.

---

# Part 15 — BlockingQueue

> **Key ideas (revise in 1 minute)**
> - A blocking queue can park a producer when it is full and a consumer when it is empty.
> - An unbounded queue never pushes back. Under overload it grows until the process runs out of memory.
> - `ArrayBlockingQueue` is one lock. `LinkedBlockingQueue` splits put and take. `SynchronousQueue` holds nothing.

> **In plain words:** a blocking queue is a hand-off. If the other side is not ready, the caller waits instead of failing or buffering forever.

## What are the four ways to put and take?

**30-second answer:** Four insertion/removal styles: throw-on-failure, return a special value, block indefinitely, or block-with-timeout. The blocking forms are `put` / `take` and the timed `offer` / `poll`. They throw `InterruptedException` because waiting is interruptible.

```java
void put(E e) throws InterruptedException;     // blocks if full
E take() throws InterruptedException;            // blocks if empty
boolean offer(E e, long timeout, TimeUnit unit) throws InterruptedException;
E poll(long timeout, TimeUnit unit) throws InterruptedException;
```

- The non-blocking pair from Part 1 is still there: `add` / `offer`, `remove` / `poll`, `element` / `peek`.

**Interview trap:** catching `InterruptedException` and ignoring it. Restore the interrupt flag, or the caller cannot tell the thread was asked to stop.

## How does this become producer-consumer, and why bound it?

**30-second answer:** Producers call `put`. Consumers call `take`. The queue owns the `ReentrantLock` and the two `Condition`s. You do not write `wait` / `notify`. A bounded `put` blocks when the queue is full, so a fast producer slows down. An unbounded queue never does that. It hides the imbalance until `OutOfMemoryError`. An unbounded queue in a pipeline is a deferred out-of-memory, not a convenience.

**Interview trap:** `LinkedBlockingQueue` with no capacity "so producers are never blocked." That is how a slow consumer takes down the process.

## Which implementation matches which shape?

**30-second answer:** Pick the bound, the lock split, and whether you need priority or delay.

- `ArrayBlockingQueue`: fixed circular array, always bounded, one lock for put and take, optional fairness.
- `LinkedBlockingQueue`: linked nodes, optional bound, two separate locks (put-side and take-side). Usually higher throughput than the single-lock array queue under concurrent load.
- `PriorityBlockingQueue`: unbounded heap. `put` never blocks, because there is no full state. Iteration is still not sorted (Part 11).
- `DelayQueue`: unbounded. Elements implement `Delayed`. `take` waits until the head's delay has expired, even if the queue is not empty. Scheduled retries and cache expiry.
- `SynchronousQueue`: zero capacity. `put` completes only when a `take` is already waiting. This is the hand-off inside `Executors.newCachedThreadPool()`.

**Interview trap:** `PriorityBlockingQueue` as a bounded work queue. It is unbounded. It will not apply backpressure.

## What does fairness mean here?

**30-second answer:** Fairness is about threads waiting on the lock, not about the data order. The data is already ordered by the queue. A fair lock hands the lock to the longest-waiting thread. That has a real throughput cost.

**Interview trap:** turning fairness on "to be safe" on a hot queue. You pay for FIFO among waiters. Most work queues do not need it.

## Where does this show up in a backend?

**30-second answer:** Thread-pool work queues (bounded versus unbounded is an architecture choice), in-process pipelines, and load shedding. A full bounded queue is a signal. You can reject, shed, or wait. A queue that only grows is a signal you will see later, as an OOM.

- `BlockingQueue.take` and `put` park in a way virtual threads unmount from, so producer-consumer with backpressure scales on virtual threads (Part 25). `synchronized` pinning is a different mechanism.

**Interview trap:** an unbounded `LinkedBlockingQueue` as a thread-pool queue, which is the default of `Executors.newFixedThreadPool`. A slow task plus a fast submitter buffers without limit.

**Next questions an interviewer usually asks:**
- `WeakHashMap` as a cache? (Part 16)
- `EnumMap` when the key is an enum? (Part 17)

---

# Part 16 — WeakHashMap and Reference-Based Collections

> **Key ideas (revise in 1 minute)**
> - Strong references keep an object alive. Weak references do not. Soft references last until memory is tight. Phantom references are for cleanup, and `get` is always null.
> - `WeakHashMap` wraps keys in weak references and holds values strongly. Cleanup is lazy, via a `ReferenceQueue`.
> - It is for canonicalizing metadata, not for a cache. A cache wants to keep values alive. This map does the opposite.

> **In plain words:** a WeakHashMap drops an entry when nothing else still points at the key. It does not try to remember the value for you.

## How strong is each kind of reference?

**30-second answer:** Strong is the normal reference: reachable means not collectable. Weak (`WeakReference`) does not keep the object alive; the next GC can reclaim it if nothing strong remains. Soft (`SoftReference`) is cleared under memory pressure, typically late, close to an allocation failure. Phantom (`PhantomReference`) never hands the object back (`get` returns null). It exists so you can run cleanup after the object is otherwise gone. No standard JDK collection is built on soft or phantom references. Cache libraries use soft references. `WeakHashMap` uses weak references for its keys.

**Interview trap:** "soft and weak are the same, soft is just nicer." Soft tries to keep the object. Weak does not.

## How does `WeakHashMap` expunge entries?

**30-second answer:** The key is inside a `WeakReference`. The value is strong. When the key is no longer strongly reachable, the entry becomes garbage. The map does not scan continuously. It cleans up lazily, on later map operations, through an internal `ReferenceQueue`.

**Interview trap:** expecting the entry to disappear at the exact moment the key becomes unreachable. It disappears on a later operation, after a GC has enqueued the reference.

## What is it good for, and why is it a bad cache?

**30-second answer:** Canonicalization is the job it is good at: bookkeeping whose lifetime should follow an object you do not own. Metadata keyed by a `Class`, for example, goes away when that class is gone, with no explicit remove. It is a bad general cache because a cache's job is to keep the value alive long enough to hit. This map will not keep the key alive. Entries can vanish before the first hit, depending on unrelated GC timing. For a real cache, use a bounded LRU or a library such as Caffeine. Soft references are the older "memory-sensitive cache" idea, and a size-bounded cache is usually clearer.

**Interview trap:** a `WeakHashMap<String, Value>` cache where the lookup key is a new `String` each time, or where some other structure holds the keys strongly. Either you never hit (different instances, collected between calls) or you never evict (something else pinned the key). A canonical key, such as `String.intern` or a key pool, is part of using this map correctly. It is still the wrong default cache.

**Next questions an interviewer usually asks:**
- `EnumMap` versus `HashMap<Enum, V>`? (Part 17)
- Fail-fast iterators? (Part 18)

---

# Part 17 — EnumMap and EnumSet

> **Key ideas (revise in 1 minute)**
> - An enum's constants are a fixed, dense `ordinal()` space.
> - `EnumSet` is a bit vector. `EnumMap` is an array indexed by ordinal. No hashing, no nodes.
> - If the key or element type is an enum, these are the default, not a later optimization.

> **In plain words:** enums are a small fixed list, so the JDK stores them as bits and array slots instead of hash nodes.

## Why can an enum skip hashing?

**30-second answer:** The set of keys is closed at compile time, small, and numbered from zero with no gaps. `ordinal()` is already a perfect index.

**Interview trap:** using the enum's `name()` as a `HashMap` key. You pay for hashing and for a node per entry, and you lose ordinal order for free.

## How is `EnumSet` stored?

**30-second answer:** `RegularEnumSet` (64 constants or fewer) is one `long`, one bit per constant. `add`, `remove`, and `contains` are single bitwise instructions. Nothing is allocated per element. `JumboEnumSet` (more than 64) uses a `long[]`. Union, intersection, and complement are word-wide bitwise operations, effectively O(1) for the common small enum.

**Interview trap:** `EnumSet` does not implement `SequencedSet`, even though iteration follows declaration order. Do not call `getFirst` on it.

## How is `EnumMap` stored?

**30-second answer:** One array. `vals[k.ordinal()]` is the value. `put` and `get` are a single index, O(1), with no hash and no `equals`. Iteration follows declaration order because the array does. Set operations on an `EnumSet` (union, intersection, complement) are word-level bitwise ops across the whole set.

```java
private transient Object[] vals;
```

**Interview trap:** a null key. Enums have no null constant. `EnumMap` rejects it. Values may be null, and the implementation has to distinguish "no mapping" from "mapped to null" without a hash node. Do not assume `get() == null` means absent until you have checked the version of the contract you are on. Prefer `containsKey` when a null value is legal.

## What do you save versus `HashSet` / `HashMap`?

**30-second answer:** `EnumSet` stores a bit, not a `Node`. `EnumMap` stores one array slot, not a `Node`. Iteration order is ordinal order, always, instead of unspecified hash order.

| | `EnumSet` / `EnumMap` | `HashSet<Enum>` / `HashMap<Enum, V>` |
|---|---|---|
| Per element | a bit, or one array slot | a full node |
| `get` / `contains` | index or bit test | hash, then `equals` |
| Iteration order | declaration order | unspecified |

**Interview trap:** reaching for `EnumMap` after a profile. If the type is an enum, start there. The API is the same shape, and every other axis is better.

**Next questions an interviewer usually asks:**
- Why did `list.remove` inside a for-each throw? (Part 18)
- When does `parallel()` help? (Part 19)

---

# Part 18 — Iterators

> **Key ideas (revise in 1 minute)**
> - Structural edits bump `modCount`. The iterator saved `expectedModCount` and throws `ConcurrentModificationException` if they differ.
> - That check is a single-threaded debugging aid. It is not a lock, and it is not cross-thread safe.
> - Remove through the iterator, or use `removeIf`, or collect and then `removeAll`.

> **In plain words:** a fail-fast iterator notices that the collection changed underneath it and throws, instead of quietly walking a broken structure.

## What can `Iterator` and `ListIterator` do?

**30-second answer:** `Iterator` moves forward and may `remove` the last element it returned. `ListIterator` also moves backward and can `set` or `add`. That only makes sense on a `List`. A `Set` or a map view has no index to insert at.

**Interview trap:** calling `iterator.remove()` before `next()`. It throws `IllegalStateException`. Remove applies to the element you just returned.

## How does `modCount` detect a concurrent modification?

**30-second answer:** The collection keeps `modCount`, starting at 0. A structural change increments it. Replacing a value with `set(index, e)` is not structural, so it does not. The iterator copies `modCount` into `expectedModCount` at creation. Every `next()` checks `modCount != expectedModCount` and throws `ConcurrentModificationException` when they differ. The iterator's own `remove` or `add` updates `expectedModCount` so it stays legal.

```java
protected transient int modCount = 0;
```

**Interview trap:** `HashMap.put` of an existing key only replaces the value. That does not bump `modCount`. `put` of a new key does. The same loop can throw or not depending on whether the key was new. And `hasNext` on `HashMap` does not check `modCount`. The check is inside `next`. A one-entry map whose iterator is already exhausted will not throw if you `put` a second key after the only `next` (Part 32, question 12).

## Why is this fail-fast, not fail-safe?

**30-second answer:** It is a best-effort check for one thread, so a bug throws now instead of corrupting quietly. It is not a guarantee that every misuse throws, and it is not a concurrent collection.

```java
for (Integer i : list) {
    if (i == 3) list.remove(i);   // NOT through the iterator
}
// throws ConcurrentModificationException
```

- Prefer, in order: `iterator.remove()`, then `removeIf()`, then collect-then-`removeAll()` after the loop.
- `ArrayList`'s `iterator.remove` is still an O(n) shift. The iterator does not make the shift cheaper. It keeps the bookkeeping consistent. `LinkedList`'s remove, once you are positioned, is O(1).

**Interview trap:** "fail-fast means thread-safe." `modCount` is a plain `int` with no cross-thread visibility guarantee. Another thread's write might throw CME, might throw something else, or might corrupt the structure and throw nothing. It was never a synchronization protocol. Use a concurrent collection (Part 13, Part 14).

**Next questions an interviewer usually asks:**
- What is `trySplit` for? (Part 19)
- `? extends` versus `? super`? (Part 20)

---

# Part 19 — Spliterator and Streams

> **Key ideas (revise in 1 minute)**
> - `Iterator` cannot split. `Spliterator.trySplit` hands part of the source to another thread.
> - An `ArrayList` split is index arithmetic, O(1), with no copy. Linked and hash sources split less evenly.
> - Characteristic bits let the stream skip work. Default to sequential. `parallel()` needs a measurement.

> **In plain words:** a spliterator is an iterator that can break off a chunk so another thread can walk that chunk.

## Why wasn't `Iterator` enough?

**30-second answer:** Parallel streams need a way to partition the source. `Spliterator` was added in Java 8 for that. `trySplit` returns a new spliterator over a prefix and leaves `this` covering the rest. It returns null when it cannot split further.

```java
boolean tryAdvance(Consumer<? super T> action);
void forEachRemaining(Consumer<? super T> action);
Spliterator<T> trySplit();
long estimateSize();
int characteristics();
```

**Interview trap:** assuming every collection splits into equal, cheap halves. `ArrayList` does. A linked list or a hash table often does not.

## What do the characteristic bits tell the stream?

**30-second answer:** They are hints: `ORDERED`, `DISTINCT`, `SORTED`, `SIZED`, `SUBSIZED`, `NONNULL`, `IMMUTABLE`, `CONCURRENT`. The stream uses them to skip work. `sorted()` can be a no-op if `SORTED` is already set. `ArrayList`'s spliterator tracks `origin` and `fence` indexes, so `trySplit` is arithmetic and copies nothing. That is why array sources parallelize predictably.

**Interview trap:** a `CONCURRENT` source and a pipeline that still shares a mutable accumulator. The source being concurrent does not make your `forEach` body thread-safe.

## When does `parallel()` help, and when does it hurt?

**30-second answer:** It helps when the source splits cheaply and evenly, each element does real work, the pipeline is stateless, and the data is large. It hurts when tasks block on the common `ForkJoinPool` (that pool is shared with the rest of the JVM), when you need order (`forEachOrdered` spends the gain back), when the body does blocking I/O, or when the per-element work is tiny and coordination dominates.

- Default to a sequential stream.
- Reach for `parallel()` with a reason you measured, not a reason you hoped.

**Interview trap:** `parallel()` inside a web request that also uses the common pool elsewhere. Blocking I/O on that pool stalls unrelated parallel work. A dedicated `ForkJoinPool` is the isolation valve, and even then the body has to be worth splitting.

**Next questions an interviewer usually asks:**
- PECS? (Part 20)
- What exactly breaks if `hashCode` does not match `equals`? (Part 21)

---

# Part 20 — Generics + Collections

> **Key ideas (revise in 1 minute)**
> - Generics moved collection casts from runtime to compile time. The type arguments are erased.
> - `List<String>` is not a `List<Object>`. Invariance blocks a bad insert through a wider reference.
> - PECS: producer is `? extends`, consumer is `? super`. Read and write means a plain `T`.

> **In plain words:** generics stop you putting the wrong type in a collection. Wildcards say whether a collection is a source of values, a destination, or both.

## Why do collections need generics?

**30-second answer:** Before generics, every collection held `Object` and the caller cast. The cast failed far from the `add` that inserted the wrong type. Generics make that a compile error.

**Interview trap:** a raw `List` "to keep it simple." You turned the compile error back into a runtime `ClassCastException`.

## What does type erasure change?

**30-second answer:** `List<String>` and `List<Integer>` are the same class at runtime. You cannot `new T[10]` inside a generic class. `instanceof List<String>` is illegal. You cannot overload two methods whose erasures are identical. An instance does not carry its type arguments for reflection. Reifiable information has to be passed another way (a `Class<T>` token, or a superclass token).

**Interview trap:** `list instanceof List<String>`. It does not compile. At runtime there is no `String` to test.

## Why are generics invariant?

**30-second answer:** `List<String>` is not a subtype of `List<Object>`. If it were, you could `add` an `Integer` through the `List<Object>` reference and the next `get` as `String` would throw. Invariance is the fix, not a missing feature.

```java
List<Object> objs = new ArrayList<String>(); // does NOT compile
```

**Interview trap:** "arrays are covariant, so lists should be too." Arrays are covariant, and `String[]` stored in an `Object[]` then given an `Integer` throws `ArrayStoreException` at runtime. Generics refuse that program at compile time instead.

## What do `? extends` and `? super` allow?

**30-second answer:** `? extends T` is a producer. You can read a `T`. You cannot write anything except null, because the real element type might be a subtype. `? super T` is a consumer. You can write a `T`. You can only read it back as `Object`.

**Interview trap:** `List<? extends Number> nums` and then `nums.add(1)`. The list might be a `List<Double>`. The compiler rejects the add.

## What is PECS?

**30-second answer:** Producer Extends, Consumer Super. A source you only read is `? extends T`. A destination you only write is `? super T`. `Collections.copy` is the picture: `src` produces, `dest` consumes.

```java
static <T> void copy(List<? super T> dest, List<? extends T> src)
```

- `max` needs both a producer collection and a comparison bound that allows a superclass to be the one that implements `Comparable`:

```java
static <T extends Comparable<? super T>> T max(Collection<? extends T> coll)
```

- `Collection<? extends T>` is the producer. `Comparable<? super T>` lets you compare through a superclass that owns the ordering, which is what `ScheduledFuture` and similar hierarchies need.
- API rule: read-only parameter → `? extends T`. Write-only → `? super T`. Both directions → plain `T`, no wildcard.

**Interview trap:** `<? super T>` on a method that returns the collection's elements as `T`. You cannot. You only know they are `Object`.

**Next questions an interviewer usually asks:**
- Mutate a key after `set.add`. What does `contains` do? (Part 21)
- Big-O versus the cache. (Part 22)

# Part 21 — equals() and hashCode()

> **Key ideas (revise in 1 minute)**
> - Default `equals` is `==`. Logical equality means overriding both `equals` and `hashCode`.
> - If `a.equals(b)`, the hash codes must match. The reverse is not required.
> - A hash or a comparison that changes after insertion makes the element unreachable. Records avoid that by being immutable and generating both methods.

> **In plain words:** equals says "same value." hashCode says "look in this bucket." They have to tell the same story, and the story cannot change while the object sits in a set.

## How is identity different from logical equality?

**30-second answer:** `Object.equals` is reference equality. Two `new` objects are never equal, even with the same fields. Domain types usually want logical equality, and then they must override `hashCode` too. Leaving the identity hash in place puts equal objects in different buckets.

**Interview trap:** overriding `equals` only. `HashSet` will store both "equal" objects, because their identity hashes differ.

## What does `equals` require?

**30-second answer:** Reflexive, symmetric, transitive, consistent, and `x.equals(null)` is false. Symmetric is the one people break with subclasses that add a field and compare it only on one side.

**Interview trap:** `equals` that throws on null, or that is order-dependent. `a.equals(b)` and `b.equals(a)` must agree.

## What does `hashCode` require?

**30-second answer:** Repeated calls on an unchanged object return the same int. And the load-bearing direction: equal objects must have equal hash codes. Unequal objects may share a hash. That is a collision, handled by the bucket chain or tree. A hash that changes when an equality field changes breaks every hash collection the object is already in.

**Interview trap:** memorizing "equal hash codes mean equal objects." They do not. Collisions are legal. The failure direction is equal objects with different hashes.

## Why do records fit this?

**30-second answer:** A Java record generates `equals` and `hashCode` from its components, and the components are implicitly final. That closes the mutable-key trap for those fields. You can still break it by putting a mutable object inside the record and using that object's changing state in a hand-written `equals`. The record itself does not mutate.

**Interview trap:** a record component that is an array. Generated `equals` uses reference equality for arrays, not `Arrays.equals`. Two records with equal array contents are not equal.

## What happens if you mutate a set element after insertion?

**30-second answer:** `contains` and `remove` recompute the hash and look in the new bucket. The object is still in the old bucket. Both calls miss. `size()` is unchanged. Iteration still finds it, because iteration does not hash. The object is stuck until you happen to walk that bucket.

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

- Any structure that placed the element using a property of the element (hash, or `compareTo`) needs that property to stay stable for the whole membership.
- Prefer records. If a field participates in hash or comparison, treat it as final once the object is inserted.

**Interview trap:** "remove the mutated object by iterating." You can, if you remove through the iterator when you see it. `remove(p)` using the new hash will not find it.

**Next questions an interviewer usually asks:**
- Which structure is O(1) average versus O(log n)? (Part 22)
- What does boxing a million ints actually allocate? (Part 23)

---

# Part 22 — Complexity and Performance

> **Key ideas (revise in 1 minute)**
> - Big-O is how cost scales, not the cost of one call on your machine.
> - The same O(n) can differ by 5–20x because of cache, allocation, and contention.
> - Read the row for the operation you actually call. `PriorityQueue.remove(Object)` is not `poll`.

> **In plain words:** pick a structure by the operation you do most, then check whether the constant factors and the memory layout survive your n.

## How do the common structures compare?

**30-second answer:** Hash structures win point lookups. Trees win order and ranges. Arrays win scans. Heaps win "give me the current extreme." Deques win both ends. Nothing wins every column.

| | Lookup | Insert | Remove | Contains | Iteration | Ordering | Memory/element |
|---|---|---|---|---|---|---|---|
| **ArrayList** | O(1) idx | O(1) amort (end) / O(n) | O(n) | O(n) | O(n), cache-friendly | none | low |
| **LinkedList** | O(n) | O(1) ends / O(n) arb | O(1) ends / O(n) arb | O(n) | O(n), cache-hostile | none | high |
| **HashSet** | — | O(1) avg | O(1) avg | O(1) avg | O(capacity) | none | medium |
| **LinkedHashSet** | — | O(1) avg | O(1) avg | O(1) avg | O(n), ins/access order | insertion/access | med-high |
| **TreeSet** | — | O(log n) | O(log n) | O(log n) | O(n), sorted | full sort + range | high |
| **HashMap** | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(capacity) | none | medium |
| **LinkedHashMap** | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(n), ordered | insertion/access | med-high |
| **TreeMap** | O(log n) | O(log n) | O(log n) | O(log n) | O(n), sorted | full sort + range | high |
| **PriorityQueue** | O(1) min | O(log n) | O(log n) top / O(n) arb | O(n) | O(n), heap order | none in iteration | low |
| **ArrayDeque** | — | O(1) both ends | O(1) both ends | O(n) | O(n), cache-friendly | insertion order | low |
| **ConcurrentHashMap** | O(1) avg | O(1) avg | O(1) avg | O(1) avg | O(capacity), weak | none | medium+ |

- Hash iteration is O(capacity), not O(n), because it walks empty buckets. `LinkedHashMap` iteration is O(n) because it walks the entry list.
- `ConcurrentHashMap` iteration is weakly consistent. It does not throw CME. It also does not promise a frozen snapshot the way copy-on-write does.

**Interview trap:** quoting the insert column when the hot call is `contains` on a `PriorityQueue`. That cell is O(n).

## What sits outside Big-O?

**30-second answer:** Wall-clock cost is the operation count times the cost of one operation. The second term moves with the cache, allocation, branches, vectorization, locks or CAS, and what the JIT can see.

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

- `ArrayList` versus `LinkedList` iteration: both O(n), often 5–20x apart in real time, from locality and per-node overhead.
- `HashMap.get` is O(1) only with a hash that spreads. A bad `hashCode` makes the constant terrible at any load factor.
- `ArrayDeque` versus `ConcurrentLinkedQueue` with no real contention: the CAS and volatile traffic is pure overhead. Do not pay for concurrency you do not have.

```
Big-O + constants + memory layout + allocation pattern + cache locality + CPU behavior + contention = actual production performance
```

**Interview trap:** ending the answer at "it's O(1)." A senior answer names the constant, the layout, and the contention.

**Next questions an interviewer usually asks:**
- Header size and boxing? (Part 23)
- What should the method return? (Part 24)

---

# Part 23 — JVM and Memory Perspective

> **Key ideas (revise in 1 minute)**
> - Every object pays a header before its fields: mark word plus class pointer, then alignment.
> - A boxed `Integer` is a heap object of about 16 bytes for 4 bytes of data.
> - `Integer` caches -128..127, so `==` on boxed values is accidentally true inside that range and false outside. Use `equals`.

> **In plain words:** collections store references. The objects those references point at each carry a header, and boxing turns a number into one of those objects.

## What does every object pay before its fields?

**30-second answer:** A mark word (8 bytes) and a class pointer (4 bytes compressed, 8 if compressed class pointers are off). That is 12–16 bytes before any field, then padding to 8-byte alignment. A `LinkedList` node pays this on top of three references. An `ArrayList` pays it once for the list and once for the backing array, not once per slot.

**Interview trap:** counting only the payload. A million small nodes are mostly headers.

## What is a compressed ordinary object pointer?

**30-second answer:** Compressed oops are 4-byte references on typical heaps (under ~32GB). Above that threshold, or with compression disabled, references are 8 bytes. That doubles the size of every reference-heavy structure: hash nodes, linked nodes, the `ArrayList` backing array.

**Interview trap:** a heap sized just past the compressed-oops threshold "for headroom." You can grow the process and shrink the useful capacity, because every reference got wider.

## What does boxing cost inside a collection?

**30-second answer:** `list.add(i)` on a `List<Integer>` calls `Integer.valueOf(i)`. Each box is its own object, about 16 bytes of heap for 4 bytes of int, scattered wherever allocation left it. A million of them is a million headers plus a million pointers in the list.

```java
List<Integer> list = new ArrayList<>();
for (int i = 0; i < 1_000_000; i++) { list.add(i); }   // autobox: Integer.valueOf(i)
```

- The cache exception: `Integer.valueOf` returns a cached instance for -128 through 127. `==` is true for 100 and 100, and false for 200 and 200. Compare boxed numbers with `equals`, never `==`.

```java
Integer a = 100; Integer b = 100; a == b;   // true — cached (-128..127)
Integer c = 200; Integer d = 200; c == d;   // false — not cached
```

**Interview trap:** `==` in a test that only uses small integers. It passes. Production values outside the cache fail.

## How does `List<Integer>` compare with `int[]`?

**30-second answer:** A million `int`s in an array is about 4 MB, contiguous, no boxes, friendly to the prefetcher, and vectorizable. A `List<Integer>` is about 4 MB of references plus up to about 16 MB of scattered boxes, roughly 5x the memory, a pointer chase per element, and no vectorization. Use a primitive array on a large numeric hot path. `List<Integer>` is fine everywhere else.

**Interview trap:** a stream of boxed integers on the hot path "for cleanliness," then blaming the collector.

## How does this show up in GC?

**30-second answer:** Every extra node and every extra box is both footprint and allocation rate. Allocation rate is what makes the collector run. Copy-on-write writes, resize copies, and boxing in a loop are the usual collection-shaped sources. Pre-size when you know n. Prefer primitive arrays when the element is a number and the loop is hot.

**Interview trap:** a cache that "only" stores integers as keys and values. You stored two objects per entry, plus a node.

**Next questions an interviewer usually asks:**
- What should a Java 21 API return? (Part 24)
- Do virtual threads make a `HashMap` safe? (Part 25)

---

# Part 24 — Java 21 Collections and API Design

> **Key ideas (revise in 1 minute)**
> - Return the interface, not `ArrayList` or `HashMap`.
> - Decide explicitly: live reference, unmodifiable view, or snapshot. Write it down.
> - `SequencedCollection` lets the type say "there is a first and a last," so the prose does not have to.

> **In plain words:** the return type is a promise about mutation, identity, and order. Pick the type that tells the truth.

## What is the caller allowed to assume?

**30-second answer:** Three questions. Can they mutate what you returned? Will it keep changing when your state changes? Can they rely on iteration order? If the signature does not answer those, the Javadoc has to, and someone will miss the Javadoc.

**Interview trap:** an interface that is silent, plus a caller who caches the list and is surprised when your next update shows up in it.

## Why return the interface?

**30-second answer:** `List<Order>` lets you switch the implementation. `ArrayList<Order>` freezes the class into every caller. Return `SequencedMap` or `SequencedCollection` when order is part of the contract, not a habit of the current class.

```java
public List<Order> getOrders() { ... }   // prefer this
public ArrayList<Order> getOrders() { ... }  // over this — leaks implementation detail
```

**Interview trap:** returning `HashMap` because that is what the field is. Callers start depending on unspecified iteration order.

## What should the default return be?

**30-second answer:** An immutable snapshot, unless a live view is the actual contract. `List.copyOf` is the snapshot. A compact constructor is the place to copy on the way in, before the field is assigned.

```java
public List<Order> getOrders() {
    return List.copyOf(orders);   // genuine snapshot
}
```

```java
public record OrderSummary(List<Order> orders) {
    public OrderSummary {
        orders = List.copyOf(orders);   // compact constructor — defend before assignment
    }
}
```

**Interview trap:** `List.copyOf` on the way out and a public field, or a getter that returns the field, on the way in. Copy both boundaries.

## What belongs in the contract, in writing?

**30-second answer:** Mutable or not. Live view or snapshot. What a second call returns (same instance, fresh snapshot, or a view that moved). Null or not. Order or not. "It's a list" leaves all of that implicit.

```java
public SequencedCollection<AuditEntry> getAuditTrail() { ... }
```

- `SequencedCollection` says first, last, and `reversed` are meaningful. The type carries the order promise.

**Interview trap:** `Collections.unmodifiableSequencedMap` when you needed a snapshot. The wrapper preserves the sequenced contract and stays live. `copyOf` does not preserve a custom `SequencedMap` class. It returns an immutable map that may not be sequenced. Pick the one that matches the promise. If order must survive the copy, copy into a `LinkedHashMap` and then wrap, or document that the snapshot is unordered.

## What does a modernized legacy getter look like?

**30-second answer:** Stop returning the live `HashMap`. If the caller needs order, return a `SequencedMap` view or a snapshot, and read the ends with `firstEntry` instead of iterating.

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

- Checklist: (1) Am I leaking a concrete type? (2) Is this a live reference, an unmodifiable view, or a snapshot, and is that written down? (3) Does the return type say the order, via `SequencedCollection` / `SequencedSet` / `SequencedMap`, if order matters? (4) Did I copy on the way in?

**Interview trap:** `unmodifiableSequencedMap` around a map that is not sequenced. The input has to be a `SequencedMap`, which a `LinkedHashMap` is and a `HashMap` is not.

**Next questions an interviewer usually asks:**
- What changes when those callers are virtual threads? (Part 25)
- Which pattern is this: cache, dedup, queue, counter? (Part 26)

---

# Part 25 — Collections + Virtual Threads

> **Key ideas (revise in 1 minute)**
> - Virtual threads (JEP 444) are a scheduler. They do not change the memory model, and they do not make a `HashMap` safe.
> - More concurrency makes latent races show up. Code that survived 200 platform threads can fail at tens of thousands of virtual threads.
> - In Java 21, `synchronized` and native calls pin the carrier. `BlockingQueue` built on `ReentrantLock` unmounts instead.

> **In plain words:** virtual threads make blocking cheap. They do not make shared data safe. A data race is still a data race, and you will hit it more often.

## What did virtual threads actually change?

**30-second answer:** They are cheap threads the JVM mounts on a small set of carrier platform threads, and they unmount when they block in a way the JDK knows how to park. Scheduling changed. The Java Memory Model did not. "Thread-safe" means the same thing it meant before.

**Interview trap:** "we moved to virtual threads, so the shared HashMap is fine now." The map does not know what kind of thread called `put`.

## What gets riskier as the thread count goes up?

**30-second answer:** Shared mutable collections. Two hundred platform threads can lose the race rarely enough that tests stay green. Fifty thousand virtual threads run the same check-then-act much more often. `HashMap` and `ArrayList` shared across requests were never safe. They were merely quiet.

- Coarse locks get worse too. `Collections.synchronizedMap` and `ArrayBlockingQueue`'s single lock become hotter bottlenecks. `ConcurrentHashMap`'s per-bin locking and `LinkedBlockingQueue`'s split locks get more valuable, not less.
- In Java 21, a virtual thread that blocks inside `synchronized`, or in a native method, is pinned to its carrier (JEP 444). It cannot unmount. `Object.wait()` / `notify()` need that monitor, so they pin too. Pinning was not removed in Java 21. A pile of pinned carriers is a scheduler problem, not a collections API problem, but a fat `synchronized` around a `HashMap` is how you get there.
- `BlockingQueue.take` and `put` park through `ReentrantLock`, which unmounts. Producer-consumer with a bounded queue is a pattern virtual threads handle well.

**Interview trap:** replacing `synchronized` with a virtual-thread-per-request and leaving the `HashMap`. You scaled the race. Move the shared structure to `ConcurrentHashMap`, or stop sharing it. Publish an immutable snapshot through a `volatile` field if readers dominate (Part 26).

**Next questions an interviewer usually asks:**
- Counter: `AtomicInteger` or `LongAdder`? (Part 26)
- The mistake list. Which of these did we just commit? (Part 27)

---

# Part 26 — Real Production Patterns

> **Key ideas (revise in 1 minute)**
> - Name the job first: cache, dedup, order, queue, or counter. The structure follows.
> - A shared cache that must outlive one process is Redis, not a clever map.
> - Hot counters want `LongAdder`. Cold ones are fine as `AtomicInteger` or `merge`.

> **In plain words:** production code keeps rediscovering the same five shapes. Match the shape, then the concurrency, then the bound.

## Which structure is a cache?

**30-second answer:** Single-threaded and bounded: `HashMap`, or `LinkedHashMap` with `removeEldestEntry` if you want LRU. Concurrent, moderate size: `ConcurrentHashMap` plus an eviction policy, or Caffeine once you need TTL or weights. A config map refreshed as a whole: build the new map, then publish it by writing an `AtomicReference<Map<K,V>>` or a `volatile` field. Readers keep using the old snapshot until the write.

**Interview trap:** an unbounded `ConcurrentHashMap` "cache." That is a leak with a concurrent API.

## Which structure dedups, orders, or queues?

**30-second answer:** Dedup follows Part 8: `HashSet`, `LinkedHashSet`, or `TreeSet` in one thread. Across threads, `ConcurrentHashMap.newKeySet()`, not `CopyOnWriteArraySet`, once the set is large or writes are common. Order: `LinkedHashMap` / `LinkedHashSet` for insertion order, `TreeMap` / `TreeSet` for a continuous sort and ranges, `ArrayList` plus one `Collections.sort` when you only need the order at the end. Queues: `ArrayDeque` in one thread, `PriorityQueue` for priority, a bounded `ArrayBlockingQueue` or `LinkedBlockingQueue` for producer-consumer, `ConcurrentLinkedQueue` when you need concurrent and non-blocking.

**Interview trap:** `ConcurrentLinkedQueue` as a worker queue. It will not block the producer, so it will not apply backpressure.

## How should a counter be stored?

**30-second answer:** One thread: `map.merge(key, 1, Integer::sum)`. Many threads, little contention per key: `ConcurrentHashMap<K, AtomicInteger>`. Many threads hitting the same key: `ConcurrentHashMap<K, LongAdder>`. A `LongAdder` spreads increments across cells so CAS retries do not all land on one cache line. `sum()` adds the base and every cell. It is not an atomic snapshot, and it costs more than `AtomicInteger.get()`, which is one volatile read. A `ConcurrentHashMap<K, Integer>` updated with `compute` is correct and allocates a new `Integer` on every increment. That churn is optional. Don't pay it on a hot key.

| Situation | Structure |
|---|---|
| One thread | `Map.merge(key, 1, Integer::sum)` |
| Concurrent, low contention per key | `ConcurrentHashMap<K, AtomicInteger>` |
| Concurrent, one hot key | `ConcurrentHashMap<K, LongAdder>` |
| Concurrent, `compute` on boxed `Integer` | correct, and it allocates every time |

**Interview trap:** `LongAdder` for a counter you use as a lock-free sequence number. `sum()` can miss an in-flight increment. If you need an exact, atomic value, use `AtomicLong`.

**Next questions an interviewer usually asks:**
- Which of the classic mistakes is this? (Part 27)
- Walk the selection tree out loud. (Part 28)

---

# Part 27 — Common Senior-Level Mistakes

> **Key ideas (revise in 1 minute)**
> - Most of these are a right fact (O(1), thread-safe, unmodifiable) applied to the wrong operation.
> - The fix is usually a different type, not a faster version of the same type.
> - Immutable keys, real eviction, and atomic compound updates cover a large share of the incidents.

> **In plain words:** the mistakes below are the same traps as the earlier parts, listed as "why people do it, what happens, what to do instead."

## What do people get wrong, and what should they do instead?

**30-second answer:** Read the arrow as the replacement, not as a style note. Each line is a behavior you can reproduce.

1. **`LinkedList` because insertion is O(1).** Ignores the cache-hostile constants (Part 3). → `ArrayList` or `ArrayDeque`.
2. **`HashMap` when order matters.** Iteration order is unspecified and can change. → `LinkedHashMap` or `TreeMap`.
3. **`TreeMap` for a rare sort.** You pay O(log n) on every write. → `HashMap`, then sort once.
4. **`Collections.synchronizedX` as "the concurrent collection."** Compound actions are still races. → `ConcurrentHashMap` and `compute` / `merge`.
5. **Work inside a `ConcurrentHashMap` `compute` lambda that touches the same map.** Detectable recursive updates throw `IllegalStateException`. Others can deadlock. → keep the function short and off this map.
6. **Mutating a key after insert.** Lookup misses, `size` still counts it. → immutable keys, records.
7. **Fail-fast means thread-safe.** `modCount` is not a memory barrier. → a real concurrent collection.
8. **`PriorityQueue` iteration is sorted.** Only `poll` yields sorted order. → drain with `poll`.
9. **`parallel()` by default.** Coordination, the common pool, ordering, and shared mutable state. → sequential, then measure.
10. **`CopyOnWriteArrayList` on a write-heavy path.** O(n) copy per write. → rare writes, small n, or a different structure.
11. **`WeakHashMap` as a normal cache.** Entries disappear before a hit. → a bounded cache.
12. **Default `HashMap` capacity on a bulk load.** Repeated resize. → `(int) (N / 0.75f) + 1`.
13. **Boxing on a numeric hot path.** About 16 bytes and a pointer chase per value. → a primitive array.
14. **Returning a live mutable collection.** Callers corrupt your state. → `List.copyOf`, or a documented view.
15. **Aliasing on the way in.** The caller mutates the list they handed you. → copy at the boundary.
16. **Unmodifiable treated as immutable.** The view follows the backing collection. → use the precise word. Snapshot when you mean stable.
17. **Hand-rolled first, last, and reverse on Java 21.** The sequenced types already do this. → `getFirst`, `getLast`, `reversed`.

**Interview trap:** fixing (4) by adding more `synchronized` blocks around the same `HashMap`. The granularity is still wrong, and the compound action is only safe if every caller takes the same lock. `ConcurrentHashMap` makes the common compound actions atomic without that discipline.

**Next questions an interviewer usually asks:**
- Apply the tree to one sentence from a ticket. (Part 28)
- A case from Part 29, out loud, with the rejected alternative.

---

# Part 28 — Collection Selection Framework

> **Key ideas (revise in 1 minute)**
> - Decide the family first: list, set, map, or queue. That mistake is the expensive one to undo.
> - Then uniqueness, order, ranges, enum, concurrency, memory, and scale.
> - End by saying the trade-off. "It's O(1)" is not a selection.

> **In plain words:** walk the questions in order. The first "yes" that picks a family should be hard to get wrong, because everything later is a swap inside that family.

## What is the order of the decision tree?

**30-second answer:** Family, then uniqueness, then what kind of order, then ranges, then enum, then concurrency and the read/write ratio, then memory, then scale. State the trade-off last, in one sentence.

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

**Interview trap:** starting at step 6 because the ticket said "thread-safe." You can make the wrong family concurrent. You still have the wrong family.

## How does the tree land on one answer?

**30-second answer:** "Thread-safe, mostly read, predictable iteration, rare writes." Step 1 is iteration. Step 3 is stable order. Step 6 is read-heavy and rare writes. That is `CopyOnWriteArrayList` (or the set, if uniqueness matters). The trade-off is an O(n) copy on write and a snapshot iterator, in exchange for lock-free reads and no CME. The trade-off is acceptable because writes were stated to be rare.

**Interview trap:** answering `ConcurrentHashMap` because it was the last concurrent type you learned. This requirement is about iteration order and read cost, not about key-value lookup.

## Why is the order of the tree the point?

**30-second answer:** Swapping `HashMap` for `ConcurrentHashMap` is a local edit. Discovering you needed a queue, not a list, after the API shipped, is not. Family mistakes outlive implementation mistakes.

- "Senior" here means you can say which step you are on, which alternative you rejected, and what that alternative fails at. A choice defended only by "O(1)" or "thread-safe" skipped most of the tree.

**Next questions an interviewer usually asks:**
- The twelve short cases. (Part 29)
- Build a tiny version and say what you left out. (Part 30)

---

# Part 29 — Real-World Case Studies

> **Key ideas (revise in 1 minute)**
> - Each case cites an earlier part. The point is the reason, not the class name.
> - Say the rejected alternative in the same breath.
> - Scale and concurrency change the answer even when the access pattern does not.

> **In plain words:** these are the selection tree applied to one-sentence requirements. If you cannot point at the part that justifies the choice, you guessed.

## Which structure fits each of these?

**30-second answer:** Name the class, the part that justifies it, and what you refused.

1. **10 million records, frequent lookup by ID.** `HashMap<ID,Record>`, pre-sized to `(10_000_000/0.75)+1`. No order was requested, so not a tree (Part 5, Part 22).
2. **10,000 reads/sec, very few writes.** `ConcurrentHashMap` if it is a map. `CopyOnWriteArrayList` or `CopyOnWriteArraySet` if it is a small collection (Part 13, Part 14).
3. **Many threads updating counters.** `ConcurrentHashMap<K, LongAdder>` when the same key is hot, otherwise `AtomicInteger` (Part 26).
4. **Keep insertion order.** `LinkedHashMap` or `LinkedHashSet` (Part 6, Part 8).
5. **Sorted ranges.** `TreeMap` / `TreeSet`, or `ConcurrentSkipListMap` / `ConcurrentSkipListSet` if it is shared (Part 7, Part 13).
6. **Top 100 highest-priority tasks.** A bounded min-heap `PriorityQueue`, O(n log 100) (Part 11).
7. **LRU.** `LinkedHashMap` with `accessOrder = true` and `removeEldestEntry`, or Caffeine if it is concurrent (Part 6).
8. **Producer-consumer.** A bounded `ArrayBlockingQueue` or `LinkedBlockingQueue` (Part 15).
9. **Thread-safe listeners.** `CopyOnWriteArrayList` or `CopyOnWriteArraySet` (Part 14).
10. **Memory-efficient enum lookup.** `EnumMap` / `EnumSet`, unconditionally (Part 17).
11. **Virtual threads sharing state.** Whatever Part 13 says, usually `ConcurrentHashMap`, biased to fine-grained locks because of Part 25.
12. **API returns an ordered read-only collection.** Return `SequencedCollection<T>`. Back it with `List.copyOf` for a snapshot, or an unmodifiable sequenced view if a live reflection is the contract (Part 24).

**Interview trap:** answering (6) with a `TreeSet` of every task. You can. You pay O(log n) with n in the millions to produce 100 results. The heap stays at 100.

---

# Part 30 — Simplified Internal Implementations

> **Key ideas (revise in 1 minute)**
> - A teaching hash map is a bucket array, a mask, and a chain. Resize that calls `put` again is not the JDK resize.
> - A teaching tree with no rotations becomes a list if you insert in order. That is why red-black trees exist.
> - A teaching ring with no growth still shows why both ends are O(1).

> **In plain words:** these three classes are the smallest code that still behaves like the real idea. Each comment at the end is the production feature they deliberately omit.

## What does a minimal hash map have to do?

**30-second answer:** Spread the hash, mask it into a bucket, walk the chain for `equals`, and resize when `size` passes `capacity * 0.75`. The JDK also treeifies, splits buckets by one hash bit instead of rehashing, and implements remove, iterators, and views. This version does none of that. Its resize calls `put`, which recomputes hashes and reverses chain order.

<details>
<summary>Go deeper: SimpleHashMap</summary>

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

The real JDK treeifies at 8 entries once the table is large enough, which bounds the worst case for comparable keys and blunts hash flooding. Resize uses the lo/hi bit split and keeps relative order, instead of calling `put` and reversing the chain. Remove, iterators, and the collection views are absent here.

</details>

**Interview trap:** this `indexFor` uses `hashCode` directly. A negative hash masked with `&` is still a valid index. `hashCode % length` would not be, for a negative hash. The JDK's `HashMap` also mixes with `h ^ (h >>> 16)` before the mask. This teaching version does that mix. It does not store the hash on the node, so every comparison calls `equals` even when the hashes differ.

## What does a minimal tree map omit?

**30-second answer:** Insert and search by `compareTo`, with no rotations. Sorted input degenerates to a linked list. That single failure is the reason `TreeMap` is red-black.

<details>
<summary>Go deeper: SimpleTreeMap</summary>

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

No rebalancing. Insert keys in sorted order and the right spine is a list. Lookup is O(n). Red-black rotations exist to make that impossible.

</details>

**Interview trap:** `compareTo == 0` overwrites, same as `TreeMap`. This toy map has the comparator-versus-equals trap even without balancing.

## What does a minimal ring buffer omit?

**30-second answer:** Both ends wrap with a mask, so neither add shifts elements. The real `ArrayDeque` also grows, implements the full `Deque` and `Queue` contracts, and rejects null. Java 21 wraps with `inc` / `dec` rather than requiring a power-of-two length. This snippet is the power-of-two form, which makes the mask correct.

<details>
<summary>Go deeper: SimpleArrayDeque</summary>

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

The real `ArrayDeque` adds automatic growth, the full interface, and null rejection. This one does not check full versus empty. A production ring leaves a slot empty or keeps `size` honest before it overwrites.

</details>

**Interview trap:** the mask is only valid when `capacity` is a power of two. `new SimpleArrayDeque(10)` wraps to the wrong index.

## Why write these at all?

**30-second answer:** The mechanism becomes something you can step through. Every omission is a production requirement: treeification, order-preserving resize, balancing, growth, null rejection. Knowing the core idea and knowing what production adds are different skills. This part is the line between them.

---

# Part 31 — Production Debugging

> **Key ideas (revise in 1 minute)**
> - Symptom, then the check, then the mechanism, then the fix. Do not start with the fix.
> - Most collection incidents are one of: equals/hashCode, unbounded growth, a coarse lock, or check-then-act.
> - A `HashMap` table that is huge while `size()` is small did not shrink. Rebuild it.

> **In plain words:** debugging a collection bug is the selection tree run backwards. The symptom names the mechanism. The mechanism names the part you already read.

## How do you go from a symptom to a mechanism?

**30-second answer:** Match the symptom to one of the thirteen patterns. Confirm with the check, then apply the fix. Do not add a lock until you know which mechanism you are looking at.

1. **Unexpected duplicates in a `Set`.** Compare `hashCode` for objects that claim to be equal. Cause: `equals` without `hashCode`, or the reverse. Fix: override both, and test the contract.
2. **Missing `HashMap` entries.** Were hash-relevant fields changed after insert? Cause: mutable key, or a broken equals/hashCode pair. Fix: immutable keys, records.
3. **`ConcurrentModificationException`.** A structural edit inside a for-each, not through the iterator. Fix: `iterator.remove`, `removeIf`, or collect and then remove.
4. **A leak that is "just a collection."** Heap dump. Find the collection that grows, and who points at it. Statics are the usual root. Cause: unbounded cache, unbounded queue, or listeners that never unregister. Fix: a bound and real eviction, a bounded queue, explicit deregistration, or a weak reference used for the job it is good at.
5. **High GC.** Allocation rate: boxing, copy-on-write, tiny objects. Fix: primitive arrays on the hot path, pre-size.
6. **Lookups that should be fast and are not.** Histogram `hash % capacity` on real keys, and the treeification rate. Cause: a degenerate `hashCode`. Fix: `Objects.hash`, or a record, checked against production keys.
7. **Lock contention.** Thread dumps show many threads `BLOCKED` on one monitor. Cause: a coarse lock at a higher concurrency than you designed for. Fix: a concurrent structure that matches the access pattern.
8. **Wrong order.** The declared type does not promise the order the code assumes. Cause: `HashMap` or `HashSet` where a linked or tree variant was required. Fix: the type that encodes the guarantee. Never depend on unspecified iteration order.
9. **Mutable keys, at incident scale.** Same mechanism as (2), often with the mutation and the map in different modules. Fix: audit key types, move to records.
10. **A bad `hashCode`, at production scale.** Same as (6). Often one root cause behind both duplicates and slow lookups.
11. **Lost concurrent updates.** Is the collection actually thread-safe? Is there a check-then-act even if it is? Fix: `ConcurrentHashMap` with `compute`, `merge`, or `computeIfAbsent`.
12. **Memory that does not come back.** `HashMap` never shrinks its table after a mass `remove`. The profiler shows a table array far larger than `size()`. Fix: rebuild at a sensible capacity if this shape is expected.
13. **Getting slower over time.** A comparator that is not a pure function, or hash clustering from real keys that tests never produced. Fix: comparator purity, and `hashCode` against production key distributions.

Nearly every one of these is the equals/hashCode contract, growth without eviction, a coarse lock, or check-then-act. The forward question is "given the requirement, which structure." The reverse question is "given the symptom, which of those mechanisms is it."

**Interview trap:** resizing the heap for (12). The table is large because the map does not shrink. A bigger heap delays the page. It does not fix the retention.

---

## Practice Questions & Answers

### Part 32 — Final Practice Phase — Level 1 — Conceptual Exercises

<details class="qa-item">
<summary>1. Why does `Map<K,V>` not extend `Collection<E>`? Name the two concrete method-signature conflicts that would arise if it did.</summary>

**30-second answer:** A map holds pairs. A collection holds single elements. Forcing one hierarchy makes `add` and `contains` mean the wrong thing.

- `Collection.add(E)` would have to be `add(Map.Entry<K,V>)`. The operation people need is `put(K, V)`, which takes two arguments and replaces on a matching key.
- `contains(Object)` would mean "this exact pair is present." The useful question is `containsKey`. Iteration has the same split: a collection has one iterator, a map has `keySet`, `values`, and `entrySet`.
- The JDK keeps `Map` as its own root and connects it with those views.

**Interview trap:** answering "because a map has two type parameters." The type parameters are a symptom. The conflicting operations are the reason.

</details>

<details class="qa-item">
<summary>2. Explain the difference between `SequencedCollection`, `SequencedSet`, and `SequencedMap`.</summary>

**30-second answer:** All three mean "there is a defined encounter order with a first element and a last element." They differ by what else they promise. `SequencedCollection` is the shared contract (`getFirst`, `getLast`, `addFirst`, `addLast`, `removeFirst`, `removeLast`, `reversed`). `SequencedSet` adds set uniqueness. `SequencedMap` is the pair version: `firstEntry`, `lastEntry`, `pollFirstEntry`, `pollLastEntry`, `putFirst`, `putLast`, and sequenced key, value, and entry views.

**Follow-up: which concrete classes implement each, and why doesn't `HashMap` implement `SequencedMap`?**

- `SequencedCollection`: every `List` (`ArrayList`, `LinkedList`, `CopyOnWriteArrayList`, `Vector`) and every `Deque` (`ArrayDeque`, `LinkedList`). `List` and `Deque` extend it. `Queue` does not.
- `SequencedSet`: `LinkedHashSet`, plus `SortedSet` / `NavigableSet` (`TreeSet`, `ConcurrentSkipListSet`). `HashSet`, `EnumSet`, and `CopyOnWriteArraySet` do not.
- `SequencedMap`: `LinkedHashMap`, plus `SortedMap` / `NavigableMap` (`TreeMap`, `ConcurrentSkipListMap`). `HashMap`, `ConcurrentHashMap`, `EnumMap`, `WeakHashMap`, and `Hashtable` do not.
- `HashMap` has no encounter order. A first or last key would be an accident of hashing. There is nothing for `SequencedMap` to promise, so it does not implement the interface.

**Interview trap:** `LinkedHashMap.reversed()` is a view. It is not a copy, and `HashMap` will not compile against that method.

</details>

<details class="qa-item">
<summary>3. You need a `Set` with no duplicates, sorted iteration, and O(log n) range queries. Which class?</summary>

**30-second answer:** `TreeSet` (a `NavigableSet`). It is a red-black tree: O(log n) add, remove, and contains, sorted iteration, and `subSet` / `headSet` / `tailSet`.

**Follow-up: what must the `Comparator` get right so you do not silently lose entries?**

- The comparator must be consistent with `equals`. If `compare(a, b)` is 0, `equals` must be true.
- `TreeSet` decides "already present" with the comparator, not with `equals`. Two unequal elements that compare as 0 collapse to one, and the second `add` returns false.
- The same rule drops keys in a `TreeMap`. Add a tie-breaker (`thenComparing` on a unique field) when the sort key is not a full identity.

**Interview trap:** a comparator on one field (age, score, priority) with no unique tie-breaker. The set looks like it "lost" data. It treated them as duplicates.

</details>

<details class="qa-item">
<summary>4. What's the precise difference between "unmodifiable" and "immutable"?</summary>

**30-second answer:** Unmodifiable means this reference has no mutators. Immutable means no reference can change the collection, ever.

- An unmodifiable view can still change if something else holds the backing collection.
- `List.of` and `List.copyOf` are immutable. `Collections.unmodifiableList` is a view.

**Follow-up: where does treating them as the same cause a bug?**

```java
List<String> backing = new ArrayList<>(List.of("a"));
List<String> view = Collections.unmodifiableList(backing);
backing.add("b"); // mutates through backing reference
System.out.println(view.size()); // 2 — view changed!
```

- `view.add` would throw. `backing.add` does not. The view's size becomes 2.
- Sharing that view across threads is not thread-safe. Share `List.copyOf` if you meant "this will not change."

**Interview trap:** calling the wrapper immutable in an API doc. Callers will cache it and miss your later writes, or race on them.

</details>

<details class="qa-item">
<summary>5. Name three Java 21 additions to the Collections Framework.</summary>

**30-second answer:** JEP 431 filled holes where a collection already had an order and had no uniform way to talk about the ends.

1. **`SequencedCollection`, `SequencedSet`, and `SequencedMap`.** One contract for first, last, and `reversed`. Before Java 21, `LinkedHashSet` had insertion order and no first/last method at all.
2. **`List.getFirst` / `getLast` / `addFirst` / `addLast` / `removeFirst` / `removeLast`.** A `List` used to need `get(0)` and `get(size() - 1)`. `Collections.reverse` mutates. `Deque` already had the end methods. The gap was `List`, not `Deque`.
3. **`LinkedHashMap` sequenced views and `putFirst` / `putLast`.** `sequencedKeySet`, `sequencedValues`, `sequencedEntrySet`, and `reversed` are ordered views. `putFirst` can place a key at the front. Nothing in the pre-21 API could do that.

`HashMap` does not implement `SequencedMap`. Hash bucket order is not a sequence.

**Interview trap:** listing `addFirst` on `Deque` as a Java 21 feature. `Deque` had it. The new fact is that `List` and the linked hash types share the contract, and `reversed()` is a view.

</details>

### Part 32 — Final Practice Phase — Level 2 — Implementation Exercises

<details class="qa-item">
<summary>6. Walk through, step by step, what happens internally when `HashMap.put()` triggers a resize from capacity 16 to 32.</summary>

**30-second answer:** The table doubles to 32, the threshold becomes 24, and every entry either stays at index `i` or moves to `i + 16`. The hash is not recomputed. One more bit of the hash already stored on the node decides which.

1. The default map resizes after `size` passes 12 (`16 * 0.75`). The insert happens, then `resize` runs.
2. A new `Node[32]` is allocated. `threshold` becomes `32 * 0.75 = 24`.
3. The old index was `hash & 15`. The new index is `hash & 31`. Doubling brings in exactly one new bit, value 16.

**Follow-up: explain the lo/hi bit-split, and why it avoids recomputing full hashes.**

- That new bit is already in the node's `hash` field. If it is 0, the entry stays at `i` (the "lo" chain). If it is 1, it moves to `i + oldCapacity` (the "hi" chain).
- Each old bucket is split into those two chains in one pass. Relative order inside each chain is kept.
- Nothing calls `hashCode()` again. The work is a bit test and a pointer swing, still O(n) overall because every entry is visited, but cheaper per entry than a fresh hash.
- `HashMap` does not shrink on `remove`. The 32-slot table stays 32 even if you delete everything.

**Interview trap:** "resize rehashes every key." It relocates using the stored hash. It does not call `hashCode` again.

</details>

<details class="qa-item">
<summary>7. Trace `ArrayDeque.addFirst()` and `addLast()` on a deque of capacity 8 that currently has `head=6, tail=2` (already wrapped around).</summary>

**30-second answer:** The front moves one slot backward. The back writes where `tail` already points and then advances `tail`. On a ring of length 8 the two calls do not disturb each other.

**Follow-up: what are the indexes after one of each call?**

Length 8. Java 21 wraps with `dec` / `inc`. The pre-21 mask `(index ± 1) & 7` gives the same numbers, because 8 is a power of two.

- `addFirst` from `head=6`: new head is `dec(6, 8) = 5`. The element is stored at index 5. `tail` stays 2.
- `addLast` from `tail=2`: the element is stored at index 2, then `tail` becomes `inc(2, 8) = 3`. `head` stays 6.
- One of each, from the original state, ends at `head=5`, `tail=3`. The front element sits at 5. The back element sits at 2.
- `head` does not meet `tail`, so neither call grows the array.

A fresh `new ArrayDeque<>(8)` on Java 21 allocates length 9 (one spare slot), not 8. This exercise means a ring whose length is 8, which is the length the index math uses.

**Interview trap:** reporting a sorted picture of the logical contents and skipping head and tail. The question asks for the indexes.

</details>

<details class="qa-item">
<summary>8. Explain exactly why `PriorityQueue.remove(Object)` is O(n) while `poll()` is O(log n), even though both conceptually "remove an element."</summary>

**30-second answer:** `poll` already knows the slot. `remove(Object)` has to find the object first, and a heap has no index by value.

- `poll` takes the root (index 0), moves the last element there, shrinks `size`, and sifts down. The sift is at most the height, O(log n).
- `remove(Object)` scans the array until `equals` hits, which is O(n), then removes that index and sifts. The scan dominates.
- `contains` is the same scan.
- If you remove arbitrary elements often, the heap is the wrong structure. Keep a side index, or use a `TreeSet` when order is the point.

**Interview trap:** "both remove, so both are O(log n)." The log bound is for the element the heap is organized around. Everything else is a linear search.

</details>

<details class="qa-item">
<summary>9. Walk through `TreeMap.put()` inserting a key that needs one left rotation to restore the red-black invariants.</summary>

**30-second answer:** Insert 10, then 20, then 30, natural order. 30 hangs off a red 20, which hangs off a black 10, all on the right. That is a red-red violation fixed by rotating left at 10 and recoloring.

Before the rotation:

```
    10(B)
      \
      20(R)
        \
        30(R)
```

`rotateLeft(10)` with `r = 20`:

- `10.right` becomes `20.left` (null).
- `20` takes `10`'s parent. The parent is null, so `20` becomes the root.
- `20.left` becomes `10`, and `10.parent` becomes `20`.
- `30` stays `20.right`. Its parent is still `20`.

Then the colors flip so the new root is black and its children are red:

```
      20(B)
     /    \
  10(R)   30(R)
```

In-order is still 10, 20, 30. A rotation changes shape, not sort order.

**Follow-up: which pointers are reassigned?**

- `p.right = r.left`
- if `r.left` exists, `r.left.parent = p`
- `r.parent = p.parent` (and the parent slot, or the root, now points at `r`)
- `r.left = p`
- `p.parent = r`

**Interview trap:** describing a color flip as a rotation. Recoloring does not move pointers. The rotation is the five assignments above.

</details>

<details class="qa-item">
<summary>10. Explain why `ConcurrentHashMap.get()` requires no locking at all, but `put()` sometimes does. What specific field modifier makes the lock-free read safe?</summary>

**30-second answer:** `get` reads a volatile table and follows node links that were published safely. `put` into an empty bin is a CAS. `put` into an occupied bin locks that bin's head.

- The reader never takes the bin lock. It can miss a write that has not been published yet. It cannot see a half-built node.
- The modifier is `volatile` on the table reference (and the volatile or final fields on the node that publish the key, value, and next pointer). That is what makes the lock-free read safe.
- `synchronized` on the bin head is only the writer path for a non-empty bin, plus resize cooperation through a `ForwardingNode`.

**Interview trap:** "`volatile` means atomic increment." It does not. It makes the published read safe. The atomic update is the CAS or the bin lock.

</details>

<details class="qa-item">
<summary>11. Implement a `removeEldestEntry()` override for a `LinkedHashMap`-based cache that evicts once size exceeds 500.</summary>

**30-second answer:** After each `put`, return true when `size()` is greater than 500. The new entry is already counted, so the eldest is dropped and the size settles at 500. Pass `true` for access order if this cache is an LRU. The default order evicts the oldest insertion, which is FIFO.

```java
class BoundedCache<K, V> extends LinkedHashMap<K, V> {
    BoundedCache() {
        super(16, 0.75f, true); // accessOrder: get/put move the key to the tail
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > 500;
    }
}
```

**Follow-up: why is there no safe equivalent on `ConcurrentHashMap`?**

- There is no `removeEldestEntry` hook, and there is no global insertion or access list kept under one lock.
- `size()` is not a gate you can hold across the following remove. Another put lands in between.
- Access-order LRU relinks on `get`. `ConcurrentHashMap.get` is lock-free on purpose. A relink on read would be a write on the hot path.
- Two bins would have to agree on "who is eldest" atomically. They do not share that order.
- The practical replacement is a cache library (Caffeine) or a whole-map snapshot swap if you refresh everything at once.

**Interview trap:** a `synchronized` block that checks `size()` and then removes an arbitrary key. You serialized the map, and you still did not know which key was eldest.

</details>

### Part 32 — Final Practice Phase — Level 3 — Code Analysis

<details class="qa-item">
<summary>12. What does this print, and why?</summary>

The loop prints nothing. The code is:

```java
Map<String, Integer> map = new HashMap<>();
map.put("a", 1);
for (String key : map.keySet()) {
    if (key.equals("a")) map.put("b", 2);
}
```


**30-second answer:** It prints nothing, and it does not throw. After the loop the map contains `a=1` and `b=2`.

- The map has one entry, so the iterator's `next` consumes `"a"` and finds nothing after it.
- `put("b", 2)` is a structural change and bumps `modCount`.
- `HashMap`'s `hasNext` only checks whether another node is queued. It does not check `modCount`. The check lives in `next`.
- The loop condition is already false, so `next` never runs again, and the mismatch is never observed.
- Add another key before the loop and the same `put` throws `ConcurrentModificationException`, because `next` runs again. Replacing the value of an existing key does not bump `modCount`.

**Interview trap:** "any structural change inside for-each throws." It throws on the next iterator call. If there is no next call, you get a silent successful update. Do not rely on that. Use a copy of the key set, or do not mutate during iteration.




</details>
<details class="qa-item">
<summary>13. What does this print, and why?</summary>

This prints `3`. The code is:

```java
List<Integer> list = List.of(1, 2, 3);
List<Integer> mutable = new ArrayList<>(list);
mutable.add(4);
System.out.println(list.size());
```


**30-second answer:** It prints `3`. `new ArrayList<>(list)` copies the elements. `mutable.add(4)` changes the copy. `List.of` is immutable and still has the original three elements.

**Interview trap:** `Collections.unmodifiableList` in place of the `ArrayList` constructor. That would be a view, and the sizes would move together. This code copies.




</details>
<details class="qa-item">
<summary>14. What does this print, and why?</summary>

This prints `2`. The code is:

```java
Set<int[]> set = new HashSet<>();
set.add(new int[]{1, 2, 3});
set.add(new int[]{1, 2, 3});
System.out.println(set.size());
```


**30-second answer:** It prints `2`. Arrays use identity `equals` and identity `hashCode`, not the contents. The two `new int[]` objects are different keys, so both are stored.

- `Arrays.equals` and `Arrays.hashCode` compare contents. `int[]` does not use them.
- A `List<Integer>` or a record of the three numbers would collapse to one element.

**Interview trap:** "`HashSet` calls `Arrays.equals` for arrays." It calls `Object.equals`. Content equality is opt-in.




</details>
<details class="qa-item">
<summary>15. What does this print, and why?</summary>

This prints `[5, 3, 4, 1, 2]`, which is heap order, not sorted order. The code is:

```java
PriorityQueue<Integer> pq = new PriorityQueue<>(Comparator.reverseOrder());
pq.addAll(List.of(5, 1, 4, 2, 3));
List<Integer> result = new ArrayList<>(pq);
System.out.println(result);
```


**30-second answer:** It prints `[5, 3, 4, 1, 2]`. `reverseOrder` makes a max-heap, so `poll` would yield `[5, 4, 3, 2, 1]`. `new ArrayList<>(pq)` does not poll. It iterates the heap array, which is not sorted.

- Insert order 5, 1, 4, 2, 3. Each `add` sifts up under the reversed comparator. The array ends as 5, 3, 4, 1, 2.
- The root is the only position the heap fully orders.

**Interview trap:** expecting `[5, 4, 3, 2, 1]` because the comparator is reversed. That is the poll order. The list constructor never polls.




</details>
<details class="qa-item">
<summary>16. What does this print, and why?</summary>

This prints `[1, 2]`. The code is:

```java
Map<String, List<Integer>> map = new HashMap<>();
map.computeIfAbsent("key", k -> new ArrayList<>()).add(1);
map.computeIfAbsent("key", k -> new ArrayList<>()).add(2);
System.out.println(map.get("key"));
```


**30-second answer:** It prints `[1, 2]`. The first `computeIfAbsent` inserts a new list and the `add(1)` hits that list. The second call finds the key present, does not run the lambda, and returns the same list. `add(2)` appends to it.

**Interview trap:** thinking each `computeIfAbsent` replaces the list. It only computes when the key is absent. `compute` would replace. `put` would replace.




</details>
<details class="qa-item">
<summary>17. What does this print, and why?</summary>

This throws `ConcurrentModificationException` and prints nothing. The code is:

```java
List<String> names = new ArrayList<>(List.of("a", "b", "c", "d"));
Iterator<String> it = names.iterator();
while (it.hasNext()) {
    String s = it.next();
    if (s.equals("b")) names.remove(s);
}
```


**30-second answer:** It throws `ConcurrentModificationException`. It does not print. `names.remove("b")` is a structural change on the list, not on the iterator, so `modCount` moves and the iterator's `expectedModCount` does not.

- `"a"` is returned fine. `"b"` is returned fine. Then `remove` runs. The next `it.next()` (toward `"c"`) sees the mismatch and throws.
- `it.remove()` after `next` would delete `"b"` and update `expectedModCount`. `removeIf` is the other clean fix.

**Interview trap:** `names.remove` versus `it.remove`. Same word. Only the iterator method keeps the fail-fast counter in sync.



</details>

### Part 32 — Final Practice Phase — Level 4 — Performance Exercises

<details class="qa-item">
<summary>18. A service holds a 50-million-entry lookup table, built once at startup from a bulk load, then read millions of times per minute with no further writes. What do you use?</summary>

**30-second answer:** A `HashMap` pre-sized so the load does not resize, then publish it safely if other threads will read it (`Map.copyOf`, or a `volatile` field written once the load finishes).

- O(1) expected reads. Less memory per entry than a tree.
- Reject `TreeMap`: O(log n) on 50 million, and you did not ask for order.
- Reject `ConcurrentHashMap` if nothing writes after publication. You would pay for bins, volatiles, and no nulls, for a map that is read-only. If a writer can still sneak in, then it is not read-only and `ConcurrentHashMap` is the right rejection of `HashMap`.
- If the heap cannot hold it, the next step is off-heap or a compressed representation, not a different `java.util` map.

**Interview trap:** `ConcurrentHashMap` "because production." Concurrency has a cost. This brief has a single publisher and then readers.

</details>

<details class="qa-item">
<summary>19. A leaderboard needs the current top 10 scores at all times, updated by thousands of score submissions per second from a single-threaded event-processing pipeline. What do you use?</summary>

**30-second answer:** A `PriorityQueue` of size 10. One thread, so no concurrent wrapper. Each update is O(log 10).

- For the ten highest scores, keep a min-heap of the current top 10. A new score enters only if it beats the root, then you `poll` the old root. The root is the smallest of the winners, which is exactly the cutoff.
- Reject `TreeSet` of every score: correct, higher constant, and it grows without a bound.
- Reject `ConcurrentSkipListMap`: there is no second thread.
- If the score domain is tiny, a bucket per score plus a pointer to the current best also works. That is a special case, not the default.

**Interview trap:** a max-heap of every submission. You can `poll` the best, and you stored millions of losers. The bound of 10 is the point.

</details>

<details class="qa-item">
<summary>20. A rarely-changing list of ~15 feature-flag listeners is iterated on every request in a highly concurrent service. What do you use?</summary>

**30-second answer:** `CopyOnWriteArrayList`. Iteration takes no lock and sees a stable snapshot. A rare registration copies an array of 15 references, which is cheap.

- Reject a plain `ArrayList` plus "we'll remember to lock." Every request would take that lock, and a forgotten lock is a CME or a torn read.
- Reject `Collections.synchronizedList` for the same reason: the lock is on the read path.
- Reject `CopyOnWriteArrayList` the moment registrations become frequent or the list becomes large. Fifteen and rare is the fit.

**Interview trap:** `ConcurrentLinkedQueue` for listeners. You can iterate it, and you get weak consistency plus no snapshot. Copy-on-write matches "don't change the list I'm dispatching to."

</details>

<details class="qa-item">
<summary>21. A batch job needs to deduplicate 200 million log lines by a derived key, single-threaded, memory being the primary constraint. What do you use?</summary>

**30-second answer:** If the key set fits in RAM, a `HashSet` pre-sized so it does not resize, or a primitive set (`LongOpenHashSet` or similar) when the key is a number. If it does not fit, sort and scan on disk, or a Bloom filter with a second pass to confirm the hits.

- Reject `TreeSet`. The per-node overhead is the thing you are short of, and you did not ask for order.
- Set the initial capacity from `n / 0.75` so the bulk insert does not rehash.
- A Bloom filter alone will drop or accept false positives. The second pass is part of the answer if the dedup must be exact.

**Interview trap:** `HashSet<String>` of the raw line when the key is a hash you could store as a `long`. You kept the whole line alive.

</details>

<details class="qa-item">
<summary>22. A cache of parsed configuration objects needs to survive being read by 50,000 concurrent virtual threads, refreshed roughly once per minute. What do you use?</summary>

**30-second answer:** Build the new map off to the side and publish it with one volatile write. Readers never lock. `Map.copyOf` gives you an immutable snapshot. A `volatile` field or an `AtomicReference` is the publication.

- `ConcurrentHashMap` fits if individual keys are filled lazily and updates are per key. A once-a-minute full refresh does not need per-bin locks: build the new map, then `configCache = newMap` on a volatile field.
- Reject `Collections.synchronizedMap`. Every virtual thread takes the same lock, and a blocking `synchronized` can pin the carrier in Java 21.
- Caffeine with `refreshAfterWrite` is the production version of this once you want TTL, refresh, and metrics instead of a hand-rolled swap.

**Interview trap:** swapping the map without a volatile or atomic reference. Readers can keep seeing a stale reference forever, or observe a partially published object. The reference write has to be safe publication.

</details>

### Part 32 — Final Practice Phase — Level 5 — Concurrency Exercises

<details class="qa-item">
<summary>23. Why is this unsafe, and how do you fix it with one atomic `ConcurrentHashMap` operation?</summary>

The increment can be lost. The code is:

```java
ConcurrentHashMap<String, Integer> counts = new ConcurrentHashMap<>();
if (!counts.containsKey(key)) {
    counts.put(key, 0);
}
counts.put(key, counts.get(key) + 1);
```


**30-second answer:** Two threads can both pass `containsKey`, both `put` 0, both read the same current value, and both write that value plus one. One increment is lost. `get` then `put` is a separate race even after the key exists.

- `merge` does the read-modify-write under the bin lock: `counts.merge(key, 1, Integer::sum)`.
- `compute` is the same idea if the function is not a simple sum.
- A hot key wants `ConcurrentHashMap<String, LongAdder>` and `add(1)`, so the CAS is striped instead of boxed on every hit.
- Do not call back into `counts` from inside the `merge` function.

**Interview trap:** `putIfAbsent(key, 0)` followed by `get` + `put`. You fixed the missing-key race and left the lost-update race.




</details>
<details class="qa-item">
<summary>24. Under what specific circumstance does calling a mutating method on a `ConcurrentHashMap` from inside a `computeIfAbsent` lambda (on the same map) cause a problem? What's the fix?</summary>

**30-second answer:** The lambda runs while the bin is locked. If this `computeIfAbsent` is the first insert into an empty bin, the map installs a `ReservationNode` until the lambda returns. Any nested mutation of a key in that same bin, including the key being computed, sees the reservation and throws `IllegalStateException: Recursive update`.

- Confirmed on Java 21: `computeIfAbsent(k, ...)` that calls `computeIfAbsent` or `merge` on `k` throws. So does `put` of another key that hashes to the same empty bin.
- `put` of a key in a different bin often does not throw. It is still forbidden. Two threads can lock bin A then bin B and bin B then bin A and deadlock. The docs say the function must not update any other mapping of this map.
- A nested update of an already-occupied bin can re-enter the same `synchronized` and corrupt the chain the outer call is walking. "It didn't throw" is not "it was safe."
- Fix: compute the value without touching this map, then insert it. Scratch state goes in a different map. If you already have the value, `putIfAbsent` does not need a callback.

**Interview trap:** catching `IllegalStateException` and retrying. You papered over a self-deadlock. Structure the update so the lambda does not re-enter.

</details>

<details class="qa-item">
<summary>25. You're migrating a thread-per-request service from a fixed platform-thread pool (200 threads) to virtual threads. Name two categories of latent bugs in existing shared-collection code that are more likely to surface after this migration, and why.</summary>

**30-second answer:** The bugs were already real. Virtual threads run them often enough to see.

1. **Unsynchronized shared collections.** A `HashMap` or `ArrayList` touched by every request lost updates and threw CME rarely at 200 threads. At tens of thousands of virtual threads the same check-then-act shows up. Virtual threads did not make those classes safe.
2. **Coarse `synchronized` around a shared structure.** More waiters, longer pin times. In Java 21 a virtual thread blocked in `synchronized` stays pinned to its carrier (JEP 444), so a hot monitor also shrinks the carrier pool. `Collections.synchronizedMap` is this bug with a library name.

**Interview trap:** a third category people invent, "virtual threads break `ConcurrentHashMap`." They do not. They expose the code that was never concurrent.

</details>

<details class="qa-item">
<summary>26. Explain the throughput difference you'd expect between `AtomicInteger` and `LongAdder` for a counter incremented by 500 threads simultaneously.</summary>

**30-second answer:** `AtomicInteger` makes every increment CAS the same volatile cell. Five hundred threads bounce that cache line and retry. Throughput flattens. `LongAdder` gives contending threads their own cells and adds them up later, so increments scale with the cores and use more memory.

**Follow-up: why is `LongAdder.sum()` more expensive than `AtomicInteger.get()`?**

- `get` is one volatile read, and it is the current value.
- `sum` walks the base plus every cell. It does more loads. It is also not an atomic snapshot: increments that land while `sum` is running can be missed.
- Under no contention the two are close. Under this 500-thread hammer, `LongAdder` is the increment path and `AtomicInteger` is the wrong one, unless you need a single exact value for control flow rather than statistics.

**Interview trap:** `LongAdder` as a lock-free ID generator. `sum` is a statistic. `AtomicLong.getAndIncrement` is an ID.

</details>

<details class="qa-item">
<summary>27. Why does `CopyOnWriteArrayList`'s iterator never throw `ConcurrentModificationException`, structurally — not "because it's well-tested," but because of what specific mechanism?</summary>

**30-second answer:** The iterator captures the `array` reference when it is created and walks that array only. A writer allocates a new array and publishes it with a volatile write to the field. The iterator's array is never structurally modified, so there is no `modCount` check to fail.

- A `HashMap` iterator compares `modCount` because it walks a structure the writer mutates in place.
- The copy-on-write iterator can be stale. It cannot be torn, and it cannot throw CME for a later write.
- That is also why each write is O(n). The fresh array is the mechanism that makes the snapshot true.

**Interview trap:** "it takes a lock for the whole iteration." Reads do not lock. The lock is on the writer, around the copy.

</details>

### Part 32 — Final Practice Phase — Level 6 — Production Debugging Exercises

<details class="qa-item">
<summary>28. A `Set<CustomKey>` used for request deduplication starts admitting duplicate requests only after several days of uptime, never in fresh restarts or in tests. What is going on?</summary>

**30-second answer:** A key field that participates in `hashCode` or `equals` is changing after the key was inserted. Fresh tests insert and look up before the mutation. A days-long process mutates the key (a counter, a status, a timestamp) and later lookups hash to a different bucket.

- Confirm: log `hashCode` before insert and again when a duplicate is admitted. Reproduce with a key you mutate after `add`.
- `size` still counts the stranded object. Iteration can still see it. `contains` cannot.
- Fix: immutable keys, or a `hashCode` taken only from fields that never change. A record is the usual shape.
- A broken contract (`equals` without `hashCode`) usually fails immediately, not after days. The delay is the clue that the object used to be stable.

**Interview trap:** "the set is not thread-safe" as the whole answer. A race can lose entries. It does not specifically wait several days and then fail only for keys that were mutated. Ask what changed on the key.

</details>

<details class="qa-item">
<summary>29. A service's heap usage climbs steadily and never drops, even after a full GC, and a heap histogram shows one `HashMap`'s internal table array is far larger than its live entry count would suggest. What is going on?</summary>

**30-second answer:** `HashMap` resizes up and never resizes down. A spike filled the table. Later `remove` calls dropped `size` and left the array. A full GC cannot free it, because the map still references the array.

- Confirm: `size()` versus the table length in a heap dump, or with JOL. A table of 2^20 for a map of 100 entries is this bug.
- Also check for keys that are stuck (mutable keys, or a static map that still holds them). "Table much larger than size" is specifically the no-shrink case. "Size itself is huge" is an unbounded cache.
- Fix: build a new `HashMap` at the capacity you need and copy the live entries. For a cache, use eviction so the spike cannot pin a giant table in the first place.

**Interview trap:** calling `clear` and expecting the array to shrink. `clear` nulls slots and sets `size` to 0. The array length stays.

</details>

<details class="qa-item">
<summary>30. Threads occasionally block for hundreds of milliseconds on a `synchronized` block wrapping a shared `HashMap`, under moderate concurrent load that was fine in staging. What is going on?</summary>

**30-second answer:** Every reader and writer takes the same monitor. Staging did not have this concurrency, so the queue on that lock stayed short. Production stacks them up for hundreds of milliseconds.

- Confirm: thread dumps, many threads `BLOCKED` on that synchronized block, owner running a `HashMap` operation.
- Fix: `ConcurrentHashMap`. If reads dominate and writes are rare and bulk, publish an immutable snapshot instead. Sharding into several maps is the manual version of per-bin locking.
- Do not "fix" a hot `HashMap` by keeping the `synchronized` and making the critical section larger.

**Interview trap:** `Collections.synchronizedMap` as the upgrade. It is the same one-lock design with a standard name.

</details>

<details class="qa-item">
<summary>31. A `PriorityQueue`-backed task scheduler occasionally runs a lower-priority task before a higher-priority one that was added earlier in the same batch, even though every consumer uses `poll()`. What is going on?</summary>

**30-second answer:** The heap is not stable. `poll` returns the extreme element according to the comparator. If the comparator only looks at a priority enum, two tasks with that priority compare as equal, and the heap may return either. Earlier insertion does not win.

- Confirm: the comparator's `compare` returns 0 for tasks you still consider ordered. Insert two equal-priority tasks and `poll` them. The order will not reliably be FIFO.
- Fix: include a sequence or a timestamp as a tie-breaker, so `compare` is 0 only when you truly do not care. A `LinkedHashMap` does not replace the heap. It preserves insertion order and ignores priority.
- `poll` being "correct" does not add FIFO. It only reads the heap order you defined.

**Interview trap:** switching to `PriorityQueue` with no comparator change and hoping stability appears. The JDK heap does not document FIFO for ties, and it does not provide it.

</details>

<details class="qa-item">
<summary>32. A `WeakHashMap`-based "cache" has a near-zero hit rate in production even though the same keys are requested repeatedly within a short window. What is going on?</summary>

**30-second answer:** Either the keys are distinct objects that are not strongly reachable, so GC drops the entry before the next request, or you are looking up with a different instance than the one you inserted. `WeakHashMap` does not keep the key alive. That is the opposite of a cache.

- A new `String` on every request, not interned and not canonical, is a different key. The previous one becomes weakly reachable and disappears.
- If some other structure holds the keys strongly, entries will not expire, which is a different bug (the map never shrinks). Near-zero hits with repeated logical keys points at identity, not at a pin.
- Fix: a canonical key pool if you truly need weak keys. For a cache, use Caffeine or a bounded `LinkedHashMap` with a TTL or a size cap.

**Interview trap:** "turn the references from weak to soft" and keeping the same design. Soft references delay the miss until memory pressure. They do not fix key identity, and they are still not an eviction policy you can explain.

</details>

### Part 32 — Final Practice Phase — Level 7 — Design Exercises

<details class="qa-item">
<summary>33. A rate limiter tracking request counts per API key over a sliding 60-second window, at about 50,000 requests/sec across many virtual threads. What do you use?</summary>

**30-second answer:** Shard by key. `ConcurrentHashMap<String, LongAdder>` (or a small ring of buckets per key for a real sliding window) keeps the hot update off a single lock. One global `synchronized` counter will pin carriers and collapse throughput.

- A sliding window is not one number. Keep a few time slices (for example 1-second buckets) and sum the ones inside 60 seconds, or store timestamps if you truly need an exact window and can afford it.
- At this rate, an in-process map is per instance. A limit that must hold across instances belongs in Redis or a similar store. Count-Min Sketch is the approximate option when exact per-key counts do not fit.
- `expireAfterWrite(60s)` in Caffeine is a fixed window from the last write, not a sliding 60-second sum. Use it only if that is actually the product rule.
- Virtual threads do not change the structure. They punish a coarse lock (Part 25).

**Interview trap:** one `AtomicLong` per key inside a `synchronized` block around the whole map. You paid for `AtomicLong` and then serialized anyway.

</details>

<details class="qa-item">
<summary>34. An in-memory audit log must expose read-only access to the last 10,000 entries in insertion order, safely to many concurrent readers, while a single writer appends continuously. What do you use?</summary>

**30-second answer:** One writer appends to a ring of 10,000 slots. Readers do not walk the live ring. They read an immutable snapshot published through an `AtomicReference` or a `volatile` field.

- `CopyOnWriteArrayList` gives you the snapshot semantics and the insertion order, and it copies all 10,000 entries on every append. A continuous writer makes that copy the hot path. Prefer the ring plus a snapshot taken on a cadence, or a copy handed to readers only when they ask.
- `ArrayDeque` alone is not thread-safe. The single writer can own it. The publication to readers has to be a safe publish of an immutable list (`List.copyOf` of the current window).
- Declare the read API as `SequencedCollection` or `List` of an immutable copy so callers cannot append to the log.

**Interview trap:** `LinkedHashMap` with access order. You asked for insertion order and a fixed window, under concurrent readers. Access order also turns every read into a structural edit.

</details>

<details class="qa-item">
<summary>35. A graph algorithm needs to repeatedly extract the minimum-distance unvisited node (Dijkstra) from about 1 million nodes, and occasionally update the priority of a node already in the structure. What do you use?</summary>

**30-second answer:** A `PriorityQueue` plus a way to ignore stale entries, because the JDK heap cannot decrease a key in O(log n). On decrease-key, insert a new pair `(distance, node)` and skip a polled entry when a better distance is already known. A `HashMap` from node to best distance is that check.

- An indexed heap (handle to the array slot) makes the update O(log n) for real. The JDK does not ship one.
- `TreeSet` ordered by `(distance, nodeId)` can remove and reinsert in O(log n). The constant is higher than a binary heap, and it works.
- This inner loop is normally one thread. A concurrent skip list is not the default Dijkstra structure.

**Interview trap:** `PriorityQueue.remove(node)` on each update. That remove is O(n), and you do it on a million nodes. Lazy reinsert is the usual repair.

</details>

### Part 32 — Final Practice Phase — Level 8 — Senior Interview Exercises

<details class="qa-item">
<summary>36. "Walk me through what happens, step by step, when you call `put()` on a `HashMap` that's about to trigger a resize."</summary>

**30-second answer:** Hash, mask, walk the bin, insert, and if `size` crossed the threshold, double the table and split every bin by one extra hash bit.

1. Spread `hashCode` (`h ^ (h >>> 16)`), then the index is `(n - 1) & hash`.
2. Walk the chain or the tree. Replace the value if the key is already there. Otherwise append.
3. If `size` exceeds `capacity * loadFactor`, resize to twice the capacity.
4. Each old bin splits into a lo chain (stay at `i`) and a hi chain (`i + oldCapacity`) using the newly relevant bit. `hashCode` is not called again.
5. A bin that reaches length 8 in a table of at least 64 buckets becomes a tree. The tree is O(log n) only when the keys are `Comparable`.
6. `size` increments on a real insert. The whole resize is O(n). Across many inserts it is amortized O(1) per `put`.

**Interview trap:** treeifying before the table has 64 buckets. Below that, a long chain causes a resize, not a tree.

</details>

<details class="qa-item">
<summary>37. "Why would you ever choose `ConcurrentSkipListMap` over `ConcurrentHashMap`?"</summary>

**30-second answer:** When you need the keys sorted, or you need `subMap` / `headMap` / `tailMap`, under concurrency. You gain navigable order. You give up the cheaper memory and the faster point lookup of hash bins.

**Follow-up: what are you giving up, and what are you gaining?**

- Gain: sorted iteration and range views, without a full-map lock. The structure is a skip list, which is practical to update lock-free. Expected cost is O(log n).
- Cost: higher per-entry memory and slower `get` / `put` than `ConcurrentHashMap`. Height is probabilistic.
- Do not pick it for a plain lookup table. `ConcurrentHashMap` wins that, and it does not implement `SequencedMap`. The skip list does, because `NavigableMap` extends `SequencedMap`.

**Interview trap:** "skip list is lock-free, so it is always faster." Lock-free is about progress, not about beating a hash.

</details>

<details class="qa-item">
<summary>38. "A colleague says `ArrayList.add()` is O(1). Do you agree?"</summary>

**30-second answer:** Agree only for an append, and only amortized. A single `add` that resizes copies the array and is O(n). `add(index, element)` shifts the tail and is O(n) every time.

**Follow-up: what would you refine?**

- Amortized O(1) means the copies across a long series of appends sum to linear, not that every call is cheap. A latency-sensitive call can hit the copy.
- Growth is 1.5x (`old + (old >> 1)`), not doubling. The first `add` on a default list allocates 10.
- If you know `n`, `ensureCapacity` or the sized constructor pays for one allocation.
- `add` of a primitive into `List<Integer>` also boxes. The array write is the small part.

**Interview trap:** "O(1) because the end is free." The end is free until the array is full, and the middle is never free.

</details>

<details class="qa-item">
<summary>39. "Explain the `equals()`/`hashCode()` contract to me as if I'd never seen it, then show me what breaks if you violate the load-bearing direction of it."</summary>

**30-second answer:** `equals` means "treat these as the same value." `hashCode` means "start the search in this bucket." If two objects are equal, they must name the same bucket. If they name different buckets, the collection will not find the one by looking up the other.

- Unequal objects may share a hash. The bucket chain handles that. That direction is not the contract people break.
- Break `equals` implies `hashCode`: insert `a`, look up an equal `b` with a different hash, `get` returns null. A mutable key is the same failure in slow motion. You inserted under the old hash and you look up under the new one.
- Fix: generate both from the same immutable fields. Records do this. Test that equal instances have equal hashes, and that a key's hash does not change while it is in the map.

**Interview trap:** "make hashCode return a constant, so the contract holds." The contract holds, and every key lands in one bucket. You built a linked list. Correct and useless.

</details>

<details class="qa-item">
<summary>40. "We need a thread-safe, mostly-read collection with predictable iteration behavior and minimal write frequency. What do you choose, and what are you trading away?"</summary>

**30-second answer:** `CopyOnWriteArrayList`, or `CopyOnWriteArraySet` if you also need uniqueness. Readers walk a snapshot with no lock. Iteration order is the array order, stable for the life of that iterator.

- You trade an O(n) copy and a new array on every write, plus iterators that do not see writes that happen after they start.
- That trade is acceptable only while writes stay rare and n stays modest. The question says both.
- A map-shaped version of the same idea is an immutable snapshot swapped through a `volatile` field. `ConcurrentHashMap` is the wrong default here: it is thread-safe, and its iteration order is not a defined sequence.

**Interview trap:** `Collections.synchronizedList` plus an external lock around the iterator. Readers are no longer mostly-read in cost. Every iteration takes the lock.

</details>

---

## Part 33 — Final Comprehensive Evaluation

> **Key ideas (revise in 1 minute)**
> - This is a scored oral or written capstone. No new APIs.
> - Forty-five to sixty minutes, five blocks, 20 points. The senior bar is at least 16, with no zero on block A or block D.
> - Part 32 is the answer key. This part only lists the must-hit phrases.

> **In plain words:** close the notes, answer under a timer, and score whether you can still name the mechanism.

### How do you run it?

**30-second answer:** Close the earlier answers. Speak or write under a timer. Score each block 0–2 (0 = blank or the wrong mechanism, 1 = the right direction, 2 = precise, including the trade-off). Passing senior bar: **≥ 16 / 20**, with no zero on block A or block D.

**Interview trap:** scoring a two for the class name alone. The point is the mechanism.

### What is in each block?

**30-second answer:** Internals, selection, concurrency, production, and a design-plus-interview block. Ten minutes and four points each.

**Block A — Internals (10 minutes, 4 pts)**

1. Walk `HashMap.put` that triggers a 16 → 32 resize: lo/hi split, why hashes are not fully recomputed.
2. Why `get` on `ConcurrentHashMap` can be lock-free, and what publication (`volatile` / ordered writes) makes that safe.
3. Why `PriorityQueue.remove(Object)` is O(n) while `poll` is O(log n).
4. Unmodifiable versus immutable — one snippet where confusing them is a production bug.

**Block B — Selection (10 minutes, 4 pts)**

For each workload, name the structure, one rejected alternative, and the failure mode of the reject:

1. 50M read-only lookup after a single bulk load.
2. Top-10 leaderboard, single writer thread, thousands of updates/sec.
3. ~15 listeners, iterated on every request, rare writes, many virtual threads.
4. Dedup 200M keys, single-threaded, memory-bound.

**Block C — Concurrency (10 minutes, 4 pts)**

1. Fix the classic `containsKey` + `put` + `get+1` race on `ConcurrentHashMap` with one atomic API.
2. What breaks if `computeIfAbsent` mutates the same map?
3. Two bug classes that surface when you move from 200 platform threads to many virtual threads.
4. `CopyOnWriteArrayList` iterator versus `HashMap` fail-fast — the structural reason, not "it's tested."

**Block D — Production (10 minutes, 4 pts)**

Pick two. For each: the root mechanism, how you confirm, the fix.

1. Dedup `Set<CustomKey>` admits duplicates only after days of uptime.
2. One `HashMap` table array is huge compared with `size()`.
3. Threads pile up in `synchronized` around a `HashMap` only in prod.
4. `WeakHashMap` "cache" with a near-zero hit rate.

**Block E — Design + interview (10 minutes, 4 pts)**

1. Rate limiter: 50k rps, per-API-key sliding 60s window, virtual threads — collection strategy.
2. Verbal: refine "`ArrayList.add` is O(1)."
3. When `ConcurrentSkipListMap` instead of `ConcurrentHashMap` — gain and cost.
4. `equals` / `hashCode` contract in one minute, then the load-bearing direction that loses map entries.

**Interview trap:** treating block D as "name a tool." The score is the mechanism (mutable hash, table never shrinks, coarse lock, weak keys).

### What are the must-hit phrases?

**30-second answer:** Use the Part 32 answers as the full key. The evaluation only requires these hits.

- **A1:** one bit of the stored hash selects the lo chain or the hi chain. No full rehash.
- **A2:** published node fields. The bin lock is only on some writes.
- **A3:** `remove` scans. `poll` is the root plus a sift.
- **A4:** `unmodifiableList(backing)` still changes when `backing.add` runs.
- **B:** HashMap / min-heap-of-10 / COWAL / HashSet-or-external-sort-or-Bloom.
- **C1:** `merge`, or `compute`, or a `LongAdder` inside the concurrent map.
- **C2:** recursive update, `IllegalStateException`.
- **C3:** races on unsynchronized collections, and fat `synchronized` contention (pinning in Java 21).
- **C4:** the iterator holds a snapshot array. `HashMap` compares `modCount`.
- **D:** mutable `hashCode`. The table never shrinks. A coarse lock. Weak keys without a strong canonical key.
- **E:** a striped `ConcurrentHashMap` plus a window, or Redis. Amortized O(1) append, O(n) insert-at-index and resize. Skip list for ordered ranges. `equals` implies the same `hashCode`.

### Sign-off: when are you done?

**30-second answer:** If you clear the bar, the collections track is complete. If a block is a zero, go back to the matching part — hashing, `ConcurrentHashMap`, the heap, immutability, or virtual threads — and do not start a new topic until you can explain that mechanism without the notes.

**Interview trap:** rereading the whole note after a zero on one block. Repair the mechanism you missed.

---

*End of taught curriculum, practice phase, and final evaluation.*
