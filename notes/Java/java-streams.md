# Java Streams — Complete Guide

Java 8 introduced streams; Java 16–21 added `toList()`, `mapMulti`, `takeWhile`/`dropWhile`, and tighter integration with records and pattern matching. This is not a syntax cheat sheet — it is the map of what actually breaks in production when teams treat streams as "fancy for-loops."

---

## Table of Contents

1. [What Streams Are](#1-what-streams-are)
2. [Creating Streams](#2-creating-streams)
3. [Intermediate Operations](#3-intermediate-operations)
4. [Terminal Operations](#4-terminal-operations)
5. [Stream Internals: Spliterator, Pipelines, and Sinks](#5-stream-internals-spliterator-pipelines-and-sinks)
6. [Collectors (the deep part)](#6-collectors-the-deep-part)
7. [Collectors Complete Tour](#7-collectors-complete-tour)
8. [Writing a Custom Collector](#8-writing-a-custom-collector)
9. [flatMap in Depth](#9-flatmap-in-depth)
10. [Primitive Streams](#10-primitive-streams)
11. [Primitive Streams in Depth](#11-primitive-streams-in-depth)
12. [Infinite and Generated Streams](#12-infinite-and-generated-streams)
13. [Optional Done Right](#13-optional-done-right)
14. [Parallel Streams Reality Check](#14-parallel-streams-reality-check)
15. [Streams over IO Resources](#15-streams-over-io-resources)
16. [Grouping and Reporting Recipes](#16-grouping-and-reporting-recipes)
17. [Debugging and Readability](#17-debugging-and-readability)
18. [Performance and Anti-Patterns Catalog](#18-performance-and-anti-patterns-catalog)
19. [Production Debugging Playbook](#19-production-debugging-playbook)
20. [Quick Decision Matrix](#20-quick-decision-matrix)
21. [Quick Self-Check](#quick-self-check)

---


## 1. What Streams Are

A **Stream** is a **pipeline** over a data source (collection, array, I/O channel, generator, spliterator) that applies a sequence of computations. It is not a data structure — it does not store elements; it **pulls** them on demand through a chain of operations.

### Core properties

| Property | Meaning | Production consequence |
|---|---|---|
| Not a data structure | No storage; elements come from a source | You cannot "add to" or "get index 3 from" a stream |
| Lazy (intermediates) | `filter`/`map` build a pipeline; nothing runs until a terminal op | `stream.filter(...).map(...)` does **not** iterate twice — see Self-Check Q1 |
| Single-use | After a terminal operation, the stream is consumed | Reusing throws `IllegalStateException` |
| Functional (ideally) | Operations return new streams; source should stay untouched | Mutating source during traversal → `ConcurrentModificationException` |
| Sequential or parallel | Same API; parallel uses ForkJoin splitting | Parallel is not "free speed" — see Section 14 |

```java
List<String> names = List.of("Sanjay", "Kowshiga", "Ravi");
long count = names.stream()
        .filter(n -> n.length() > 5)
        .count();
```

### What streams are **not**

- **Not a replacement for every loop.** A three-line indexed mutation or early `break` with complex state is often clearer as a `for`.
- **Not inherently parallel-safe.** Parallel streams require thread-safe sources, stateless operations, and associative combiners.
- **Not a Collection.** `Stream<T>` does not extend `Collection<T>`. You collect **into** collections at the end.
- **Not always evaluated.** Without a terminal operation, intermediate ops are no-ops (pipeline is built but never executed).

### Stream vs Collection vs Iterator

```
Collection  →  stores elements, supports add/remove/size
Iterator    →  pull one element at a time, imperative hasNext/next
Stream      →  declarative pipeline, lazy fusion, optional parallelism
Spliterator →  split + traverse; streams are built on spliterators
```

### Production scenario: "the stream didn't run"

**Problem.** A junior dev writes a validation pipeline that never rejects bad rows. Code review shows `orders.stream().filter(this::isValid).map(this::normalize)` with no terminal operation. Unit test mocks never fire. Production silently passes corrupt data to the next layer.

**Cause.** Intermediate operations are **lazy**. Building a pipeline does not consume the source. Without `collect`, `forEach`, `anyMatch`, etc., nothing executes.

**Solution.** Always end with a terminal operation. For validation, prefer `allMatch`/`noneMatch` or collect to a result:

```java
boolean allValid = orders.stream().allMatch(this::isValid);
List<Order> normalized = orders.stream()
        .filter(this::isValid)
        .map(this::normalize)
        .toList();
```

---

## 2. Creating Streams

### From collections and arrays

```java
List<String> list = List.of("a", "b", "c");
Stream<String> fromList = list.stream();
Stream<String> parallel = list.parallelStream();

String[] arr = {"x", "y", "z"};
Stream<String> fromArray = Arrays.stream(arr);
Stream<String> fromArrayRange = Arrays.stream(arr, 0, 2); // "x", "y"

IntStream fromIntArray = Arrays.stream(new int[]{1, 2, 3});
```

### Factory methods

```java
Stream.of("a", "b", "c");
Stream.ofNullable(maybeNull);           // Java 9+: empty if null, else single element
Stream.empty();

IntStream.range(0, 5);                  // 0..4
IntStream.rangeClosed(0, 5);            // 0..5
```

### Generated and infinite streams

```java
Stream.iterate(1, n -> n * 2);                    // infinite — needs limit()
Stream.iterate(1, n -> n < 100, n -> n * 2);      // bounded (Java 9+)
Stream.generate(() -> UUID.randomUUID());         // infinite supplier
Stream.generate(Math::random);
```

### I/O and concatenation

```java
Stream<String> lines = Files.lines(path);         // must close — see Section 15
Stream.concat(streamA, streamB);                  // concatenates two streams
```

### From builders and primitives

```java
Stream.Builder<String> builder = Stream.builder();
builder.add("a").add("b");
Stream<String> built = builder.build();

IntStream intStream = IntStream.of(1, 2, 3);
```

### Spliterator-backed streams

```java
Spliterator<String> spliterator = list.spliterator();
Stream<String> fromSpliterator = StreamSupport.stream(spliterator, false); // false = sequential
```

### Production scenario: infinite stream hangs CI

**Problem.** A report generator uses `Stream.iterate(0, i -> i + 1).map(this::fetchPage)` without `limit` or `takeWhile`. Locally it "works" with small datasets. CI hangs until timeout.

**Cause.** `Stream.iterate(seed, next)` is **unbounded**. Each terminal op tries to consume forever.

**Solution.** Use the Java 9 bounded overload, or `takeWhile`/`limit`:

```java
Stream.iterate(0, page -> page < totalPages, page -> page + 1)
        .map(this::fetchPage)
        .flatMap(Collection::stream)
        .toList();
```

---

## 3. Intermediate Operations

Intermediate operations are **lazy**, **return a Stream**, and can be **fused** into a single pass over the source when a terminal operation runs.

| Operation | Purpose | Notes |
|---|---|---|
| `filter(Predicate)` | Keep matching elements | Short-circuit terminals may not evaluate all |
| `map(Function)` | 1:1 transform | Boxing if mapping to objects from primitives |
| `flatMap(Function)` | 1:many flatten | See Section 9 |
| `distinct()` | Remove duplicates | Uses `equals`/`hashCode` |
| `sorted()` / `sorted(Comparator)` | Order elements | Buffered — needs full stream (or prefix for some ops) |
| `peek(Consumer)` | Side-effect for debugging | Not for business logic — see Section 17 |
| `limit(n)` | Truncate to n elements | Short-circuit friendly |
| `skip(n)` | Drop first n elements | May still traverse skipped elements on some sources |
| `takeWhile` / `dropWhile` | Java 9+ prefix/suffix split | `takeWhile` short-circuits |
| `mapMulti` | Java 16+ imperative flatMap | Often faster for 0–1 outputs per element |

```java
List<Integer> lengths = names.stream()
        .map(String::length)
        .distinct()
        .sorted()
        .collect(Collectors.toList());

List<Character> chars = List.of("ab", "cd").stream()
        .flatMap(s -> s.chars().mapToObj(c -> (char) c))
        .toList();
```

### Lazy fusion example

```java
// One traversal when terminal runs:
names.stream()
     .filter(n -> { System.out.println("filter " + n); return n.length() > 3; })
     .map(n -> { System.out.println("map " + n); return n.toUpperCase(); })
     .findFirst();
// Prints filter/map only until first match passes filter — not the whole list
```

### Stateful vs stateless intermediates

| Stateless | Stateful |
|---|---|
| `filter`, `map`, `flatMap`, `peek` | `distinct`, `sorted`, `limit`, `skip` |
| Can short-circuit early with `findFirst` | `sorted` must see all elements (or use min/max instead) |

### Production scenario: sorted() on a 2M-row export

**Problem.** Export job OOMs after switching from `ORDER BY` in SQL to `stream().sorted()` in Java.

**Cause.** `sorted()` buffers **all** elements into memory before emitting the first sorted element.

**Solution.** Sort in the database, use a `PriorityQueue` for top-K, or stream to disk with external sort. Do not `sorted()` millions of rows in heap unless you mean to.

---

## 4. Terminal Operations

Terminal operations **trigger execution** and **consume** the stream.

| Operation | Returns | Short-circuit? |
|---|---|---|
| `forEach` / `forEachOrdered` | void | No |
| `collect(Collector)` | R | No (unless upstream short-circuits) |
| `toList()` (Java 16+) | unmodifiable `List<T>` | No |
| `reduce(...)` | `Optional<T>` or T | No |
| `count()` | long | No |
| `anyMatch` / `allMatch` / `noneMatch` | boolean | **Yes** |
| `findFirst` / `findAny` | `Optional<T>` | **Yes** |
| `min` / `max` | `Optional<T>` | No (needs full scan unless sorted) |
| `toArray()` | Object[] or T[] | No |

```java
int total = Stream.of(1, 2, 3, 4)
        .reduce(0, Integer::sum);

Optional<String> longest = names.stream()
        .max(Comparator.comparingInt(String::length));

boolean hasAdmin = users.stream().anyMatch(u -> u.hasRole("ADMIN"));
```

### reduce variants

```java
// Optional result — empty stream → Optional.empty()
Optional<Integer> product = numbers.stream()
        .reduce((a, b) -> a * b);

// Identity + accumulator — empty stream → identity (0)
int sum = numbers.stream().reduce(0, Integer::sum);

// Identity + accumulator + combiner (required for parallel correctness)
int parallelSum = numbers.parallelStream()
        .reduce(0, Integer::sum, Integer::sum);
```

### collect vs reduce

- **`collect`** — flexible, uses `Collector` with supplier/accumulator/combiner/finisher; preferred for grouping, maps, strings.
- **`reduce`** — general folding; combiner must be **associative** for parallel streams.

### Production scenario: findAny in parallel tests flake

**Problem.** Integration test expects `findFirst()` to return the lowest-ID row. Code uses `findAny()` on a `parallelStream()`. Test passes 95% of runs.

**Cause.** `findAny()` is explicitly **non-deterministic** in parallel — any matching element from any fork is valid.

**Solution.** Use `findFirst()` when order matters, or collect and sort deterministically. Use `findAny()` only when any match suffices (e.g., existence check).

---

## 5. Stream Internals: Spliterator, Pipelines, and Sinks

Understanding internals separates senior debugging from guessing.

### Spliterator

Every stream source exposes a **`Spliterator<T>`** — **spl**it + **iterator**:

| Method | Role |
|---|---|
| `tryAdvance(Consumer)` | Pull next element |
| `forEachRemaining(Consumer)` | Bulk remaining |
| `trySplit()` | Split for parallel; returns null if cannot split |
| `estimateSize()` | Hint for splitting |
| `characteristics()` | `ORDERED`, `SIZED`, `SUBSIZED`, `DISTINCT`, `SORTED`, `IMMUTABLE`, `CONCURRENT`, `NONNULL` |

```java
Spliterator<String> spl = list.spliterator();
spl.forEachRemaining(System.out::println);
```

**Good parallel sources:** `ArrayList`, arrays, `IntStream.range`, `HashMap` values (with caveats).  
**Poor parallel sources:** `LinkedList`, `Stream.iterate`, infinite streams, IO lines.

### Pipeline structure

```
Source (Spliterator)
  → StreamHead
  → IntermediateOp (filter)
  → IntermediateOp (map)
  → TerminalOp (collect)
       └── Sink chain (wrapped consumers, fused)
```

When you call `.filter().map().collect()`:

1. Each intermediate op wraps the previous **Sink** (downstream consumer).
2. Terminal op drives the pipeline from the source spliterator.
3. **Fusion:** adjacent stateless ops often run in one pass without materializing intermediate streams.

### Sink abstraction

Internally, `Sink` is the consumer interface the pipeline uses. `filter` wraps the downstream sink:

```
downstream.accept(element) only if predicate.test(element)
```

This is why lazy fusion works — no intermediate `List` is created between `filter` and `map`.

### Stream flags

The pipeline tracks characteristics (`SIZED`, `ORDERED`, etc.). Optimizations:

- `count()` on a `SIZED` stream may read size without traversing.
- `sorted()` on already-`SORTED` stream may skip work.
- Parallel + `ORDERED` + `forEach` vs `forEachOrdered` affects encounter order.

### Production scenario: parallelStream on LinkedList

**Problem.** Team parallelizes aggregation over a `LinkedList<Transaction>` expecting 4× speedup. CPU pegs, runtime **increases**.

**Cause.** `LinkedList`'s spliterator splits poorly — `trySplit()` yields tiny chunks, fork/join overhead dominates, cache locality is terrible.

**Solution.** Copy to `ArrayList` first if parallel is justified, or stay sequential:

```java
List<Transaction> copy = new ArrayList<>(linkedList); // if mutable copy OK
copy.parallelStream().collect(...);
// Often better: process sequentially or push aggregation to DB
```

---

## 6. Collectors (the deep part)

`Collectors` is the primary way to **materialize** stream results into aggregates.

### Anatomy of a Collector

```java
Collector<T, A, R> = supplier()      // creates mutable accumulator (A)
                   + accumulator()  // fold one element into A
                   + combiner()     // merge two A's (parallel)
                   + finisher()     // A → R (optional; identity if CONCURRENT+IDENTITY_FINISH)
                   + characteristics()
```

| Characteristic | Meaning |
|---|---|
| `CONCURRENT` | Accumulator can be updated concurrently (thread-safe A) |
| `UNORDERED` | Encounter order not preserved |
| `IDENTITY_FINISH` | Finisher is identity — A is already R |

### Common collectors (quick reference)

```java
Collectors.toList();
Collectors.toSet();
Collectors.toUnmodifiableList();          // Java 10+
Collectors.toCollection(ArrayList::new);
Collectors.toMap(keyFn, valueFn);
Collectors.toMap(keyFn, valueFn, mergeFn);
Collectors.toMap(keyFn, valueFn, mergeFn, mapSupplier);
Collectors.joining(", ", "[", "]");
Collectors.counting();
Collectors.summingInt / summingDouble / summingLong;
Collectors.averagingInt / averagingDouble;
Collectors.summarizingInt(...);         // IntSummaryStatistics
Collectors.groupingBy(classifier);
Collectors.groupingBy(classifier, downstream);
Collectors.partitioningBy(predicate);
Collectors.mapping(mapper, downstream);
Collectors.reducing(...);
Collectors.teeing(c1, c2, merger);        // Java 12+
Collectors.collectingAndThen(d, finisher);
Collectors.filtering(predicate, downstream); // Java 9+
```

```java
Map<Boolean, List<String>> byLength = names.stream()
        .collect(Collectors.partitioningBy(n -> n.length() > 5));

Map<Integer, Long> countByLength = names.stream()
        .collect(Collectors.groupingBy(String::length, Collectors.counting()));

String joined = names.stream()
        .collect(Collectors.joining(", "));
```

### groupingBy vs toMap

| | `groupingBy` | `toMap` |
|---|---|---|
| Duplicate keys | Groups into `List` (or downstream) | Throws `IllegalStateException` without merge fn |
| Null keys | `NullPointerException` | `NullPointerException` |
| Return type | `Map<K, List<T>>` (default) | `Map<K, V>` |

### Production scenario: toMap duplicate key crash on deploy

**Problem.** `Collectors.toMap(Employee::getEmail, Employee::getSalary)` throws `IllegalStateException: Duplicate key` after HR merge imports duplicate emails.

**Cause.** `toMap` without merge function uses `Map.merge` semantics that **reject** duplicate keys.

**Solution.** Supply merge function or use `groupingBy`:

```java
Map<String, Double> salaries = employees.stream()
        .collect(Collectors.toMap(
                Employee::getEmail,
                Employee::getSalary,
                (existing, replacement) -> existing)); // or max, sum, etc.

Map<String, List<Employee>> byEmail = employees.stream()
        .collect(Collectors.groupingBy(Employee::getEmail));
```

---

## 7. Collectors Complete Tour

Every major built-in collector with a concrete example.

### toList / toSet / toCollection

```java
List<String> list = stream.collect(Collectors.toList());           // mutable ArrayList
List<String> unmod = stream.collect(Collectors.toUnmodifiableList());
Set<String> set = stream.collect(Collectors.toSet());            // HashSet
Set<String> tree = stream.collect(Collectors.toCollection(TreeSet::new));
List<String> j16 = stream.toList();                                // unmodifiable, Java 16+
```

### toMap family

```java
Map<String, Integer> m1 = pairs.stream()
        .collect(Collectors.toMap(Pair::key, Pair::value));

Map<String, Integer> merged = pairs.stream()
        .collect(Collectors.toMap(Pair::key, Pair::value, Integer::sum));

Map<String, Integer> linked = pairs.stream()
        .collect(Collectors.toMap(Pair::key, Pair::value, Integer::sum, LinkedHashMap::new));
```

### joining

```java
String csv = names.stream().collect(Collectors.joining(", "));
String bracketed = names.stream().collect(Collectors.joining(", ", "[", "]"));
```

### counting and numeric summaries

```java
Long count = stream.collect(Collectors.counting());
Integer sum = stream.collect(Collectors.summingInt(String::length));
Double avg = stream.collect(Collectors.averagingDouble(Employee::getSalary));
IntSummaryStatistics stats = intStream.boxed()
        .collect(Collectors.summarizingInt(Integer::intValue));
```

### groupingBy with downstreams

```java
// Map<Dept, Long>
Map<String, Long> headcount = employees.stream()
        .collect(Collectors.groupingBy(Employee::getDepartment, Collectors.counting()));

// Map<Dept, Optional<Employee>> — highest paid per dept
Map<String, Optional<Employee>> topByDept = employees.stream()
        .collect(Collectors.groupingBy(
                Employee::getDepartment,
                Collectors.maxBy(Comparator.comparingDouble(Employee::getSalary))));

// Map<Dept, Set<String>> — unique skills per dept
Map<String, Set<String>> skills = employees.stream()
        .collect(Collectors.groupingBy(
                Employee::getDepartment,
                Collectors.flatMapping(e -> e.getSkills().stream(), Collectors.toSet())));
```

### partitioningBy

Always `Map<Boolean, D>` — exactly two buckets:

```java
Map<Boolean, List<Order>> shipped = orders.stream()
        .collect(Collectors.partitioningBy(Order::isShipped));

Map<Boolean, Long> counts = orders.stream()
        .collect(Collectors.partitioningBy(Order::isShipped, Collectors.counting()));
```

### mapping + filtering downstream (Java 9+)

```java
Map<String, List<String>> activeNamesByDept = employees.stream()
        .collect(Collectors.groupingBy(
                Employee::getDepartment,
                Collectors.filtering(Employee::isActive,
                        Collectors.mapping(Employee::getName, Collectors.toList()))));
```

### reducing as downstream

```java
Map<String, Integer> totalSalaryByDept = employees.stream()
        .collect(Collectors.groupingBy(
                Employee::getDepartment,
                Collectors.reducing(0, e -> (int) e.getSalary(), Integer::sum)));
```

### teeing (Java 12+)

Single pass, two collectors, merge results:

```java
record MinMax<T>(T min, T max) {}

MinMax<Integer> mm = numbers.stream()
        .collect(Collectors.teeing(
                Collectors.minBy(Integer::compareTo),
                Collectors.maxBy(Integer::compareTo),
                (min, max) -> new MinMax<>(min.orElseThrow(), max.orElseThrow())));
```

### collectingAndThen

```java
List<String> immutable = names.stream()
        .collect(Collectors.collectingAndThen(
                Collectors.toList(),
                Collections::unmodifiableList));
```

---

## 8. Writing a Custom Collector

Use `Collector.of` when no built-in fits — e.g., append-only CSV builder, histogram with fixed buckets, or domain-specific aggregate.

### Collector.of signature

```java
Collector<T, A, R> Collector.of(
    Supplier<A> supplier,
    BiConsumer<A, T> accumulator,
    BinaryOperator<A> combiner,
    Function<A, R> finisher,
    Collector.Characteristics... characteristics
);
```

### Example: comma-separated StringBuilder

```java
Collector<String, StringBuilder, String> joiningCustom = Collector.of(
        StringBuilder::new,
        (sb, s) -> { if (sb.length() > 0) sb.append(','); sb.append(s); },
        (sb1, sb2) -> { sb1.append(sb2); return sb1; },
        StringBuilder::toString
);

String result = List.of("a", "b", "c").stream().collect(joiningCustom);
// "a,b,c"
```

### Combiner correctness (critical for parallel)

The combiner must produce the same result as sequential accumulation:

```java
// WRONG — loses data if combiner discards sb2
(sb1, sb2) -> sb1

// RIGHT — merge sb2 into sb1
(sb1, sb2) -> { sb1.append(sb2); return sb1; }
```

Test custom collectors with **parallel** streams and randomized split sizes.

### Example: frequency map (HashMap merge)

```java
Collector<String, ?, Map<String, Long>> freq = Collector.of(
        HashMap::new,
        (map, word) -> map.merge(word, 1L, Long::sum),
        (m1, m2) -> { m2.forEach((k, v) -> m1.merge(k, v, Long::sum)); return m1; },
        Function.identity(),
        Collector.Characteristics.UNORDERED
);
```

### When to use CONCURRENT

Only if accumulator is thread-safe **and** combiner semantics still hold. Most custom collectors use **non-concurrent** `HashMap`/`StringBuilder` — parallel stream still works via combiner merging per fork.

### Production scenario: custom collector loses half the rows in parallel

**Problem.** Custom `Collector` sums revenue correctly in unit tests (sequential) but under-reports in production (parallel).

**Cause.** Combiner returns `sb1` without merging `sb2`, or `HashMap` combiner overwrites instead of merging counts.

**Solution.** Property-test combiner: `combine(fold(a), fold(b))` must equal `fold(a ++ b)` for random splits.

---

## 9. flatMap in Depth

`flatMap` maps each element to a **Stream** and flattens into one stream. It is the bridge for nested structures, optionals, and IO lines.

### Basic flatten

```java
List<List<Integer>> nested = List.of(List.of(1, 2), List.of(3, 4));
List<Integer> flat = nested.stream()
        .flatMap(List::stream)
        .toList();
```

### Optional::stream (Java 9+)

Avoid `flatMap(o -> o.isPresent() ? Stream.of(o.get()) : Stream.empty())`:

```java
List<String> present = optionals.stream()
        .flatMap(Optional::stream)
        .toList();
```

### mapMulti vs flatMap (Java 16+)

When each input produces **0 or 1** (or few) outputs, `mapMulti` avoids allocating intermediate streams:

```java
// flatMap — creates Stream per element
words.stream().flatMap(w -> w.isBlank() ? Stream.empty() : Stream.of(w.trim()));

// mapMulti — no per-element Stream object
words.stream().mapMulti((w, consumer) -> {
    if (!w.isBlank()) consumer.accept(w.trim());
});
```

For **many** outputs per element, `flatMap` or `mapMulti` with multiple `consumer.accept` calls both work; benchmark if hot path.

### flatMap with IO

```java
List<Path> files = ...;
List<String> allLines = files.stream()
        .flatMap(path -> {
            try {
                return Files.lines(path);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        })
        .toList(); // CAUTION: streams from Files.lines must be closed — see Section 15
```

Prefer try-with-resources per file or sequential processing for resource safety.

### Short-circuit limits

`flatMap` is **not** short-circuit-friendly in all cases — inner streams may still be partially evaluated. With `limit(1)` after flatMap, outer stream stops early but inner stream creation still happens per outer element until limit satisfied.

```java
Stream.of("abc", "def").flatMap(s -> s.chars().mapToObj(c -> (char) c))
        .limit(2)
        .forEach(System.out::println); // 'a', 'b' — stops early
```

### Production scenario: flatMap opens 10k file streams

**Problem.** Batch job flatMaps `Files.lines` over 10k paths, runs out of file descriptors.

**Cause.** Each path opens a stream; lazy pipeline may hold many open streams before terminal completes; no try-with-resources.

**Solution.** Process files sequentially with try-with-resources, or use a custom spliterator. See Section 15.

---

## 10. Primitive Streams

`IntStream`, `LongStream`, and `DoubleStream` avoid boxing overhead for numeric pipelines.

```java
int sum = IntStream.rangeClosed(1, 10).sum();
OptionalDouble avg = IntStream.of(1, 2, 3).average();
IntSummaryStatistics stats = IntStream.of(1, 2, 3).summaryStatistics();

// Bridging
Stream<Integer> boxed = IntStream.range(0, 5).boxed();
IntStream unboxed = list.stream().mapToInt(Integer::intValue);
```

### When to use

| Use primitive stream | Stay on object stream |
|---|---|
| Sum, avg, min, max on numbers | Non-numeric objects |
| Large numeric arrays | Need null elements |
| `range`/`rangeClosed` loops | Custom objects with numeric fields only occasionally |

### Quick conversions

```java
DoubleStream.of(1.0, 2.0);
IntStream intFromDouble = doubleStream.mapToInt(d -> (int) d);
Stream<String> fromInt = IntStream.range(0, n).mapToObj(i -> "item-" + i);
```

---

## 11. Primitive Streams in Depth

### range vs rangeClosed

```java
IntStream.range(0, 5);        // 0, 1, 2, 3, 4
IntStream.rangeClosed(0, 5);  // 0, 1, 2, 3, 4, 5
LongStream.range(0, 1_000_000L);
```

Spliterator for `range` is **SIZED** and splits well — good parallel source.

### Bridging patterns

```java
// Object → primitive
int totalLength = words.stream().mapToInt(String::length).sum();

// primitive → object
List<String> labels = IntStream.range(0, 10)
        .mapToObj(i -> "row-" + i)
        .toList();

// flatMapToInt
int totalChars = sentences.stream()
        .flatMapToInt(s -> s.chars())
        .sum();
```

### Overflow

`IntStream.sum()` uses `int` arithmetic — overflows silently like any int math:

```java
IntStream.range(1, 1_000_000).sum(); // wraps if large enough
// Use .asLongStream() or .mapToLong().sum() for big ranges
long safe = IntStream.range(1, 1_000_000).asLongStream().sum();
```

### Boxing benchmark story

Micro-benchmark (conceptual — always JMH on your workload):

```
1M integers, sum only:
  IntStream.sum()           ~ few ms, minimal allocations
  stream().reduce(Integer::sum)  ~ allocates 1M Integer boxes, GC pressure, slower
```

Production rule: numeric aggregation on large collections → `mapToInt`/`mapToLong`/`mapToDouble` first.

### summaryStatistics

One pass for min, max, sum, count, average:

```java
IntSummaryStatistics stats = IntStream.of(3, 1, 4, 1, 5).summaryStatistics();
stats.getMin(); stats.getMax(); stats.getSum(); stats.getAverage(); stats.getCount();
```

### Production scenario: Integer sum overflow in billing

**Problem.** Micro-transaction totals wrong by billions cents after migration to streams.

**Cause.** `mapToInt(Transaction::getCents).sum()` overflows `int` at ~2.1B cents (~21M dollars).

**Solution.** Use `mapToLong` or `BigInteger`:

```java
long totalCents = transactions.stream()
        .mapToLong(Transaction::getCents)
        .sum();
```

---

## 12. Infinite and Generated Streams

### iterate

```java
// Unbounded — MUST limit or takeWhile
Stream.iterate(0, n -> n + 1)
        .limit(100)
        .forEach(System.out::println);

// Java 9 bounded
Stream.iterate(0, n -> n < 100, n -> n + 1)
        .forEach(System.out::println);
```

### generate

```java
Stream.generate(() -> random.nextGaussian())
        .limit(1000)
        .collect(Collectors.averagingDouble(d -> d));
```

### takeWhile / dropWhile (Java 9+)

```java
List<Integer> nums = List.of(1, 2, 3, 4, 5, 1, 2);
nums.stream().takeWhile(n -> n < 4).toList();  // [1, 2, 3] — stops at first false
nums.stream().dropWhile(n -> n < 4).toList();  // [4, 5, 1, 2]
```

On **ordered** streams, `takeWhile` is short-circuit. On **unordered** streams, behavior may process more elements (Javadoc: may not stop immediately).

### Fibonacci and stateful iterate

```java
Stream.iterate(new int[]{0, 1}, f -> new int[]{f[1], f[0] + f[1]})
        .limit(10)
        .map(f -> f[0])
        .forEach(System.out::println);
```

### Production scenario: takeWhile on unordered parallel stream

**Problem.** Log parser uses `parallelStream().takeWhile(line -> !line.isBlank())` expecting to stop at first blank line. Sometimes consumes entire file.

**Cause.** Unordered parallel streams do not guarantee prefix semantics for `takeWhile`.

**Solution.** Use **sequential** stream for prefix truncation, or parse imperatively.

---

## 13. Optional Done Right

`Optional` is streams' constant companion — `findFirst`, `reduce`, `min`, `max` all return it.

### Rules

1. **Never** use `Optional` as a field type or method parameter in public API (except return type where absence is meaningful).
2. **Never** call `get()` without `isPresent()` check — use `orElse`, `orElseThrow`, `ifPresent`.
3. Prefer **`orElseGet(Supplier)`** over **`orElse(default)`** when default is expensive.
4. Chain with `map`/`flatMap`; use `Optional::stream` in stream pipelines (Java 9+).

```java
Optional<String> first = names.stream().findFirst();
first.ifPresent(System.out::println);
first.ifPresentOrElse(System.out::println, () -> System.out.println("empty"));
String value = first.orElse("default");
String value2 = first.orElseGet(() -> computeDefault());  // lazy
String value3 = first.orElseThrow(() -> new NoSuchElementException());
Optional<Integer> len = first.map(String::length);
```

### orElse vs orElseGet

```java
// BAD — computeDefault() ALWAYS runs
String s = opt.orElse(computeDefault());

// GOOD — computeDefault() only if empty
String s = opt.orElseGet(this::computeDefault);
```

### flatMap for nested Optional

```java
Optional<String> city = optionalUser
        .flatMap(User::getAddress)
        .flatMap(Address::getCity);
```

### Production scenario: orElse hammers database every call

**Problem.** Cache miss path uses `cache.get(key).orElse(loadFromDb(key))`. DB load happens even on cache hit.

**Cause.** `orElse` evaluates argument **eagerly**.

**Solution.** `orElseGet(() -> loadFromDb(key))`.

---

## 14. Parallel Streams Reality Check

```java
list.parallelStream()
    .filter(...)
    .map(...)
    .collect(Collectors.toList());
```

### Common ForkJoinPool

Parallel streams use **`ForkJoinPool.commonPool()`** by default:

- Size ≈ `Runtime.getRuntime().availableProcessors() - 1` (unless adjusted).
- **Shared JVM-wide** — one blocked parallel stream starves others.
- Java 21+: common pool may use **virtual threads** as worker carriers in some configurations — still one pool, still shared.

### When parallel helps

- **Large** data (typically tens of thousands+ — measure).
- **CPU-bound**, stateless, associative ops.
- **Good spliterator** source (`ArrayList`, arrays, `IntStream.range`).

### When parallel hurts

- Small collections (fork/join overhead > work).
- **I/O-bound** work inside `map` (blocks common pool threads).
- `LinkedList`, `Stream.iterate`, IO streams.
- Order-sensitive side effects without synchronization.

**Virtual threads / structured concurrency:** parallel streams still share **`ForkJoinPool.commonPool()`** — they do **not** automatically become one-virtual-thread-per-element. For many blocking I/O calls, prefer `Executors.newVirtualThreadPerTaskExecutor()` or `StructuredTaskScope` (Concurrency Parts 23–25), not `parallelStream()`. If you must parallel-stream I/O, isolate it on a **dedicated** `ForkJoinPool` so you do not starve `CompletableFuture` defaults.

### Custom pool (Java 8+ pattern)

Parallel streams cannot easily switch pools — workaround:

```java
ForkJoinPool customPool = new ForkJoinPool(4);
try {
    customPool.submit(() ->
            list.parallelStream().map(heavyCpu).collect(Collectors.toList())
    ).get();
} finally {
    customPool.shutdown();
}
```

For I/O-bound fan-out, prefer **virtual threads** (Java 21) or explicit `ExecutorService`, not `parallelStream`.

### Virtual threads pointer

```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<Result>> futures = items.stream()
            .map(item -> executor.submit(() -> process(item)))
            .toList();
    // collect futures — NOT parallelStream for blocking IO
}
```

### Production scenario: parallelStream in a servlet blocks the app

**Problem.** REST endpoint calls `bigList.parallelStream().map(this::slowHttpCall)` under load. Latency spikes for unrelated endpoints.

**Cause.** Blocking I/O on **common pool** threads; pool exhaustion.

**Solution.** Virtual threads, dedicated executor, or async HTTP client with bounded concurrency — not parallel streams.

---

## 15. Streams over IO Resources

### Files.lines

```java
try (Stream<String> lines = Files.lines(path)) {
    long count = lines.filter(l -> l.contains("ERROR")).count();
} // stream closed here — REQUIRED
```

`Files.lines` returns a stream backed by a file channel / reader. **Must close** or leak file descriptors.

### Walk file tree

```java
try (Stream<Path> paths = Files.walk(startDir)) {
    paths.filter(Files::isRegularFile)
         .filter(p -> p.toString().endsWith(".log"))
         .flatMap(path -> {
             try {
                 return Files.lines(path);
             } catch (IOException e) {
                 throw new UncheckedIOException(e);
             }
         })
         .filter(line -> line.contains("ERROR"))
         .limit(1000)
         .forEach(this::handle);
}
// Nested Files.lines in flatMap without close is risky — prefer per-file try-with-resources
```

Safer per-file pattern:

```java
try (Stream<Path> paths = Files.walk(startDir)) {
    paths.filter(Files::isRegularFile)
         .forEach(this::processFileSafely);
}

void processFileSafely(Path path) {
    try (Stream<String> lines = Files.lines(path)) {
        lines.filter(l -> l.contains("ERROR")).forEach(this::handle);
    } catch (IOException e) {
        log.warn("Skip {}", path, e);
    }
}
```

### JDBC Stream (ResultSet)

```java
// Spring JdbcTemplate example pattern
jdbcTemplate.query(con -> {
    PreparedStatement ps = con.prepareStatement(
            "SELECT id, name FROM users WHERE active = ?",
            ResultSet.TYPE_FORWARD_ONLY,
            ResultSet.CONCUR_READ_ONLY);
    ps.setFetchSize(500);  // MySQL/Postgres streaming hint
    ps.setBoolean(1, true);
    return ps;
}, rs -> {
    List<User> batch = new ArrayList<>();
    while (rs.next()) {
        batch.add(mapRow(rs));
        if (batch.size() >= 500) {
            processBatch(batch);
            batch.clear();
        }
    }
    processBatch(batch);
});
```

Some drivers support `Stream` over ResultSet — always close stream/connection per driver docs.

### Production scenario: ulimit file descriptor exhaustion

**Problem.** Nightly job processes 50k log files via `flatMap(Files::lines)` without closing. Morning alerts: `Too many open files`.

**Cause.** Each lazy stream holds an open FD until closed.

**Solution.** One stream per file in try-with-resources; never flatMap unclosed IO streams at scale.

---

## 16. Grouping and Reporting Recipes

### Word frequency

```java
Map<String, Long> freq = Arrays.stream(text.split("\\s+"))
        .collect(Collectors.groupingBy(w -> w, Collectors.counting()));
```

### Top-K (avoid full sort)

```java
// Top 10 words by frequency — use min-heap of size K
record WordCount(String word, long count) {}

PriorityQueue<WordCount> top10 = freq.entrySet().stream()
        .map(e -> new WordCount(e.getKey(), e.getValue()))
        .collect(Collectors.toCollection(() ->
                new PriorityQueue<>(Comparator.comparingLong(WordCount::count))));

// Better: explicit partial sort or stream limit after sorted (if K small, full sort OK for moderate maps)
List<Map.Entry<String, Long>> top = freq.entrySet().stream()
        .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
        .limit(10)
        .toList();
```

### Invert map (value → keys)

```java
Map<String, String> countryToCapital = Map.of("India", "Delhi", "France", "Paris");
Map<String, List<String>> capitalToCountries = countryToCapital.entrySet().stream()
        .collect(Collectors.groupingBy(
                Map.Entry::getValue,
                Collectors.mapping(Map.Entry::getKey, Collectors.toList())));
```

### Zip two lists (no built-in zip)

```java
List<String> keys = List.of("a", "b", "c");
List<Integer> vals = List.of(1, 2, 3);
IntStream.range(0, Math.min(keys.size(), vals.size()))
        .mapToObj(i -> Map.entry(keys.get(i), vals.get(i)))
        .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
```

Java 21+: consider `Stream.iterate` with index or third-party `Streams.zip` from Guava if already on classpath.

### Multi-level grouping

```java
Map<String, Map<String, Long>> byDeptAndRole = employees.stream()
        .collect(Collectors.groupingBy(
                Employee::getDepartment,
                Collectors.groupingBy(Employee::getRole, Collectors.counting())));
```

### Production scenario: reporting OOM on groupingBy

**Problem.** Dashboard groups 5M events by `userId` into `Map<Long, List<Event>>`.

**Cause.** Default downstream is `toList()` — materializes every event in heap per user.

**Solution.** Downstream `counting()`, aggregate in DB, or streaming export:

```java
Map<Long, Long> eventCountByUser = events.stream()
        .collect(Collectors.groupingBy(Event::getUserId, Collectors.counting()));
```

---

## 17. Debugging and Readability

### peek — limits

```java
names.stream()
     .peek(n -> log.debug("before filter: {}", n))
     .filter(n -> n.length() > 3)
     .peek(n -> log.debug("after filter: {}", n))
     .map(String::toUpperCase)
     .collect(Collectors.toList());
```

- **Only for debugging** — not for mutating elements or counting (use `reduce`/`collect`).
- JIT may elide `peek` if pipeline optimization proves no observable effect (rare but possible).
- Do not leave `peek` with side effects in production code.

### When a for-loop wins

| Prefer loop | Prefer stream |
|---|---|
| Indexed access with early `break`/`continue` | Declarative filter/map/collect |
| Mutating existing array in place | Immutable transformation pipeline |
| Complex nested state machine | Straight-line data transforms |
| Hot path with 5 elements | Large collection aggregation |
| Need `try/catch` per element with continue | Uniform exception policy |

```java
// Clear loop — find first match with custom break logic
User found = null;
for (User u : users) {
    if (u.isActive() && u.matches(query)) {
        found = u;
        break;
    }
}
```

### Naming and structure

Extract meaningful method references:

```java
// Hard to read
.stream().filter(x -> x.getStatus() == Status.ACTIVE && x.getBalance() > 0)

// Better
.stream().filter(User::isActiveWithBalance)
```

### Production scenario: peek "fixes" race in code review

**Problem.** Dev adds `peek(x -> cache.put(x.getId(), x))` "to populate cache" inside parallel stream.

**Cause.** `peek` is for debugging; parallel + shared mutable cache = data race.

**Solution.** Explicit `collect` then populate cache, or use concurrent map with clear lifecycle.

---

## 18. Performance and Anti-Patterns Catalog

| Anti-pattern | Symptom | Fix |
|---|---|---|
| `stream().sorted()` on huge data | OOM, long GC pauses | Sort in DB; external sort; top-K heap |
| `parallelStream()` on small lists | Slower than loop | Stay sequential |
| `parallelStream()` + blocking IO | Thread starvation, tail latency | Virtual threads / executor |
| `Collectors.toMap` without merge | `IllegalStateException` on dup keys | Merge fn or `groupingBy` |
| Boxed `reduce` on 1M ints | GC churn | `mapToInt().sum()` |
| `flatMap(Files::lines)` unclosed | FD leaks | try-with-resources per file |
| Reused consumed stream | `IllegalStateException` | New stream per terminal |
| Mutate source during stream | `ConcurrentModificationException` | Copy first or use concurrent collection |
| `peek` for business logic | Silent bugs, races | `map`/`collect` |
| Infinite stream no `limit` | Hung thread | `limit`/`takeWhile`/bounded iterate |
| `findAny` when need deterministic | Flaky tests | `findFirst` or sort |
| Stateful lambda in parallel | Wrong counts, corruption | Collectors or concurrent structures |
| `orElse(expensive())` | Wasted work every call | `orElseGet` |
| `IntStream.sum` on huge cents | Overflow | `mapToLong` / `BigDecimal` |

---

## 19. Production Debugging Playbook

| Symptom | Likely cause | First check |
|---|---|---|
| `IllegalStateException: stream has already been operated upon` | Stream reuse | Search for saved `Stream<?>` fields or reused local |
| `IllegalStateException: Duplicate key` in collect | `toMap` without merge | Stack trace → collector; add merge or groupingBy |
| `ConcurrentModificationException` | Source modified during traversal | Concurrent writes to backing list/map |
| Job hangs forever | Infinite stream / blocking terminal | `iterate`/`generate` without limit; blocked IO in map |
| `Too many open files` | Unclosed `Files.lines` | flatMap IO pattern; add try-with-resources |
| Parallel slower than sequential | Small data or bad spliterator | Size check; source type (`LinkedList`?) |
| Flaky parallel test | `findAny`, race in forEach | Deterministic collector; `findFirst` |
| OOM during collect/groupingBy | Materializing huge lists per key | Change downstream to `counting`; push to DB |
| Wrong sum/average | Overflow or null boxing | Primitive streams; null filter before map |
| peek doesn't show in logs | Log level; optimized away | Confirm terminal runs; use proper debugger |
| CPU pegged, low throughput | Parallel on IO | Move blocking work off common pool |
| Empty result but pipeline "looks fine" | No terminal op ran | Add terminal; verify lazy pipeline |

### Diagnostic snippet

```java
// Log stream characteristics (custom debug)
Spliterator<?> sp = list.stream().spliterator();
System.out.println(Spliterators.spliteratorCharacteristics(sp));
System.out.println("estimateSize=" + sp.estimateSize());
System.out.println("parallel=" + list.parallelStream().isParallel());
```

---

## 20. Quick Decision Matrix

| Need | Choose |
|---|---|
| Transform list → list | `stream().map().toList()` |
| Filter + collect | `stream().filter().collect(toList())` |
| Sum/average ints | `stream().mapToInt().sum()` |
| Group by key | `Collectors.groupingBy` |
| Key → value map (unique keys) | `Collectors.toMap` |
| Key → value map (dup keys) | `toMap` + merge or `groupingBy` |
| Join strings | `Collectors.joining` |
| Any/all/none | `anyMatch` / `allMatch` / `noneMatch` |
| First match | `filter().findFirst()` |
| Flatten nested lists | `flatMap(Collection::stream)` |
| Optional values in stream | `flatMap(Optional::stream)` |
| 0–1 outputs per element | `mapMulti` |
| Min and max one pass | `Collectors.teeing` |
| Prefix of sorted stream | `takeWhile` (sequential) |
| Read file line by line | `Files.lines` + try-with-resources |
| CPU parallel on huge ArrayList | `parallelStream()` (measure!) |
| Blocking IO on many items | Virtual threads / executor |
| Custom aggregate | `Collector.of` |
| Debug values mid-pipeline | `peek` (dev only) |
| Complex break/continue/index | for-loop |

---

## Quick Self-Check

If you can explain **why** each of these is true, you've got the topic solid:

1. Why does `stream.filter(...).map(...)` not iterate the source twice?
2. Why does `Collectors.toMap` throw on duplicate keys but `groupingBy` doesn't?
3. Why is `parallelStream()` often slower on a list of 10 elements?
4. Why does `peek` sometimes not run if nothing downstream consumes the stream?
5. Why is `Stream.iterate(1, n -> n+1)` dangerous without `limit` or the bounded overload?

---

### Practice Problems (all topics, with answers)


---

## Practice Questions & Answers

<details class="qa-item">
<summary>Q1. Filter + map + collect</summary>

Given `List<String> words`, return a list of uppercase words longer than 3 letters.

```java
List<String> result = words.stream()
        .filter(w -> w.length() > 3)
        .map(String::toUpperCase)
        .collect(Collectors.toList());
```

</details>

<details class="qa-item">
<summary>Q2. Sum of squares of even numbers</summary>

```java
int sum = IntStream.rangeClosed(1, 10)
        .filter(n -> n % 2 == 0)
        .map(n -> n * n)
        .sum();
// 4+16+36+64+100 = 220
```

</details>

<details class="qa-item">
<summary>Q3. flatMap — flatten a list of lists</summary>

```java
List<List<Integer>> nested = List.of(List.of(1,2), List.of(3,4), List.of(5));
List<Integer> flat = nested.stream()
        .flatMap(List::stream)
        .collect(Collectors.toList());
// [1,2,3,4,5]
```

</details>

<details class="qa-item">
<summary>Q4. Group employees by department</summary>

```java
Map<String, List<Employee>> byDept = employees.stream()
        .collect(Collectors.groupingBy(Employee::getDepartment));
```

</details>

<details class="qa-item">
<summary>Q5. Group + count per department</summary>

```java
Map<String, Long> countByDept = employees.stream()
        .collect(Collectors.groupingBy(Employee::getDepartment, Collectors.counting()));
```

</details>

<details class="qa-item">
<summary>Q6. Group + average salary per department</summary>

```java
Map<String, Double> avgSalaryByDept = employees.stream()
        .collect(Collectors.groupingBy(Employee::getDepartment,
                 Collectors.averagingDouble(Employee::getSalary)));
```

</details>

<details class="qa-item">
<summary>Q7. Partition numbers into even/odd</summary>

```java
Map<Boolean, List<Integer>> partitioned = numbers.stream()
        .collect(Collectors.partitioningBy(n -> n % 2 == 0));
```

</details>

<details class="qa-item">
<summary>Q8. Find the highest-paid employee</summary>

```java
Optional<Employee> topEarner = employees.stream()
        .max(Comparator.comparingDouble(Employee::getSalary));
```

</details>

<details class="qa-item">
<summary>Q9. Sort by multiple fields</summary>

Sort employees by department, then by salary descending.
```java
List<Employee> sorted = employees.stream()
        .sorted(Comparator.comparing(Employee::getDepartment)
                .thenComparing(Employee::getSalary, Comparator.reverseOrder()))
        .collect(Collectors.toList());
```

</details>

<details class="qa-item">
<summary>Q10. Distinct + joining</summary>

Get a comma-separated string of unique departments.
```java
String depts = employees.stream()
        .map(Employee::getDepartment)
        .distinct()
        .sorted()
        .collect(Collectors.joining(", "));
```

</details>

<details class="qa-item">
<summary>Q11. reduce — find product of a list</summary>

```java
int product = List.of(1,2,3,4).stream()
        .reduce(1, (a,b) -> a * b);
// 24
```

</details>

<details class="qa-item">
<summary>Q12. reduce — find the longest string</summary>

```java
Optional<String> longest = words.stream()
        .reduce((a,b) -> a.length() >= b.length() ? a : b);
```

</details>

<details class="qa-item">
<summary>Q13. Convert list to Map (name -> salary), handling duplicate keys</summary>

```java
Map<String, Double> nameToSalary = employees.stream()
        .collect(Collectors.toMap(Employee::getName, Employee::getSalary,
                 (existing, replacement) -> existing));
```

</details>

<details class="qa-item">
<summary>Q14. Check if all/any/none match a condition</summary>

```java
boolean allAdults   = people.stream().allMatch(p -> p.getAge() >= 18);
boolean anyMinor    = people.stream().anyMatch(p -> p.getAge() < 18);
boolean noneNegative = people.stream().noneMatch(p -> p.getAge() < 0);
```

</details>

<details class="qa-item">
<summary>Q15. Word frequency counter</summary>

```java
String text = "the quick brown fox the lazy dog the fox";
Map<String, Long> freq = Arrays.stream(text.split(" "))
        .collect(Collectors.groupingBy(w -> w, Collectors.counting()));
// {the=3, quick=1, brown=1, fox=2, lazy=1, dog=1}
```

</details>

<details class="qa-item">
<summary>Q16. Find the second-highest number</summary>

```java
Optional<Integer> second = numbers.stream()
        .distinct()
        .sorted(Comparator.reverseOrder())
        .skip(1)
        .findFirst();
```

</details>

<details class="qa-item">
<summary>Q17. Sum using IntStream vs boxed reduce (know the difference)</summary>

```java
// Preferred - no boxing
int sum1 = numbers.stream().mapToInt(Integer::intValue).sum();

// Works but boxes every element
int sum2 = numbers.stream().reduce(0, Integer::sum);
```

</details>

<details class="qa-item">
<summary>Q18. Custom Collector with teeing (Java 12+)</summary>

Get min and max in a single pass.
```java
var minMax = numbers.stream()
        .collect(Collectors.teeing(
                Collectors.minBy(Integer::compareTo),
                Collectors.maxBy(Integer::compareTo),
                (min, max) -> min.get() + " - " + max.get()));
```

</details>

<details class="qa-item">
<summary>Q19. Infinite stream with iterate + limit</summary>

Generate first 10 Fibonacci numbers.
```java
Stream.iterate(new int[]{0,1}, f -> new int[]{f[1], f[0]+f[1]})
        .limit(10)
        .map(f -> f[0])
        .forEach(System.out::println);
```

</details>

<details class="qa-item">
<summary>Q20. Parallel stream pitfall — spot the bug</summary>

```java
List<Integer> results = new ArrayList<>();
numbers.parallelStream().forEach(results::add);   // BUG: ArrayList not thread-safe
```
**Fix:** use `.collect(Collectors.toList())` instead of a side-effecting `forEach`, or use a `synchronizedList` / `Collectors.toCollection(CopyOnWriteArrayList::new)`.

</details>

<details class="qa-item">
<summary>Q21. Stream reuse bug — spot it</summary>

```java
Stream<String> s = names.stream();
long count = s.count();
s.forEach(System.out::println);  // throws IllegalStateException
```
**Fix:** create a new stream for each terminal operation (`names.stream()` again), or collect once into a `List` and iterate that.

</details>

<details class="qa-item">
<summary>Q22. groupingBy with a nested downstream collector</summary>

Group employees by department, and within each get a list of names only.
```java
Map<String, List<String>> namesByDept = employees.stream()
        .collect(Collectors.groupingBy(Employee::getDepartment,
                 Collectors.mapping(Employee::getName, Collectors.toList())));
```

</details>

<details class="qa-item">
<summary>Q23. Convert Map<K,V> to Stream and back</summary>

```java
Map<String, Integer> scores = Map.of("A", 90, "B", 75, "C", 60);
Map<String, String> grades = scores.entrySet().stream()
        .collect(Collectors.toMap(Map.Entry::getKey,
                 e -> e.getValue() >= 80 ? "Pass" : "Fail"));
```

</details>

<details class="qa-item">
<summary>Q24. IntSummaryStatistics — get min, max, avg, sum in one pass</summary>

```java
IntSummaryStatistics stats = numbers.stream()
        .mapToInt(Integer::intValue)
        .summaryStatistics();
System.out.println(stats.getMin() + " " + stats.getMax() + " " + stats.getAverage());
```

</details>

<details class="qa-item">
<summary>Q25. Chained Optional pipeline</summary>

Given an `Optional<Employee>`, get the department name in uppercase, defaulting to "UNKNOWN".
```java
String dept = optionalEmployee
        .map(Employee::getDepartment)
        .map(String::toUpperCase)
        .orElse("UNKNOWN");
```

</details>

<details class="qa-item">
<summary>Q26. mapMulti — emit 0, 1, or 2 tags per product without nested streams</summary>

```java
record Product(String name, String primaryTag, String secondaryTag) {}

List<String> allTags = products.stream()
        .mapMulti((p, consumer) -> {
            if (p.primaryTag() != null) consumer.accept(p.primaryTag());
            if (p.secondaryTag() != null) consumer.accept(p.secondaryTag());
        })
        .distinct()
        .toList();
```

</details>

<details class="qa-item">
<summary>Q27. Custom Collector — build a histogram of score buckets</summary>

```java
Collector<Integer, ?, Map<String, Long>> bucketCollector = Collector.of(
        HashMap::new,
        (map, score) -> {
            String bucket = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : "F";
            map.merge(bucket, 1L, Long::sum);
        },
        (m1, m2) -> { m2.forEach((k, v) -> m1.merge(k, v, Long::sum)); return m1; },
        Function.identity()
);

Map<String, Long> histogram = scores.stream().collect(bucketCollector);
```

</details>

<details class="qa-item">
<summary>Q28. flatMap Optional::stream — skip empty optionals in a pipeline</summary>

```java
List<Optional<String>> maybeNames = List.of(
        Optional.of("Ada"), Optional.empty(), Optional.of("Grace"));

List<String> names = maybeNames.stream()
        .flatMap(Optional::stream)
        .toList();
// [Ada, Grace]
```

</details>

<details class="qa-item">
<summary>Q29. takeWhile — take log lines until first blank line</summary>

```java
List<String> headerLines;
try (Stream<String> lines = Files.lines(path)) {
    headerLines = lines.takeWhile(line -> !line.isBlank()).toList();
}
```

Use on a **sequential** stream for predictable prefix behavior.

</details>

<details class="qa-item">
<summary>Q30. Files.lines — count ERROR lines safely</summary>

```java
long errorCount;
try (Stream<String> lines = Files.lines(logPath)) {
    errorCount = lines.filter(l -> l.contains("ERROR")).count();
}
```

Never rely on GC to close file streams opened at scale.

</details>

<details class="qa-item">
<summary>Q31. groupingBy + filtering downstream — active employees only per dept</summary>

```java
Map<String, Long> activeByDept = employees.stream()
        .collect(Collectors.groupingBy(
                Employee::getDepartment,
                Collectors.filtering(Employee::isActive, Collectors.counting())));
```

</details>

<details class="qa-item">
<summary>Q32. teeing — average and max salary in one pass</summary>

```java
record AvgMax(double avg, double max) {}

AvgMax stats = employees.stream()
        .collect(Collectors.teeing(
                Collectors.averagingDouble(Employee::getSalary),
                Collectors.mapping(Employee::getSalary,
                        Collectors.maxBy(Double::compareTo)),
                (avg, maxOpt) -> new AvgMax(avg, maxOpt.orElse(0.0))));
```

</details>

<details class="qa-item">
<summary>Q33. Zip two lists into a map by index</summary>

```java
List<String> keys = List.of("x", "y", "z");
List<Integer> values = List.of(10, 20, 30);

Map<String, Integer> zipped = IntStream.range(0, Math.min(keys.size(), values.size()))
        .boxed()
        .collect(Collectors.toMap(keys::get, values::get));
```

</details>

<details class="qa-item">
<summary>Q34. Primitive overflow — sum cents with long</summary>

```java
long totalCents = transactions.stream()
        .mapToLong(Transaction::getCents)
        .sum();
```

Avoid `mapToInt().sum()` when totals can exceed ~2.1 billion.

</details>

<details class="qa-item">
<summary>Q35. Spliterator-aware — when NOT to parallelize LinkedList</summary>

```java
// Sequential — poor split characteristics
long sum = linkedList.stream()
        .mapToInt(Item::getValue)
        .sum();

// If parallel required, copy to ArrayList first (if acceptable)
long parallelSum = new ArrayList<>(linkedList).parallelStream()
        .mapToInt(Item::getValue)
        .sum();
```

</details>

<details class="qa-item">
<summary>Q36. orElseGet vs orElse — lazy default from cache/DB</summary>

```java
// Wrong — loads from DB even when cache hit
User user = cache.get(id).orElse(userRepository.findById(id));

// Right — DB only on cache miss
User user = cache.get(id).orElseGet(() -> userRepository.findById(id));
```

</details>

<details class="qa-item">
<summary>Q37. collectingAndThen — mutable list then freeze</summary>

```java
List<String> frozen = names.stream()
        .filter(n -> !n.isBlank())
        .collect(Collectors.collectingAndThen(
                Collectors.toList(),
                List::copyOf));
```

</details>
