# Java Streams — Complete Guide

---


## Table of Contents

1. [What Streams Are (and aren't)](#1-what-streams-are-and-arent)
2. [Creating Streams](#2-creating-streams)
3. [Intermediate Operations (lazy, return a Stream)](#3-intermediate-operations-lazy-return-a-stream)
4. [Terminal Operations (eager, trigger execution)](#4-terminal-operations-eager-trigger-execution)
5. [Collectors (the deep part)](#5-collectors-the-deep-part)
6. [Primitive Streams](#6-primitive-streams)
7. [Optional (streams' constant companion)](#7-optional-streams-constant-companion)
8. [Parallel Streams](#8-parallel-streams)
9. [Common Pitfalls](#9-common-pitfalls)
10. [Quick Self-Check](#quick-self-check)

---


## 1. What Streams Are (and aren't)

A Stream is a **pipeline** over a data source (Collection, array, I/O channel, generator) that applies a sequence of computations. Key properties:

- **Not a data structure** — it doesn't store elements, it computes them on demand.
- **Lazy** — intermediate operations don't run until a terminal operation is invoked.
- **Single-use** — once a terminal operation runs, the stream is consumed. Reusing it throws `IllegalStateException`.
- **Functional, not mutating** — operations return a new stream; the source is (ideally) untouched.
- **Can be sequential or parallel.**

```java
List<String> names = List.of("Sanjay", "Kowshiga", "Ravi");
long count = names.stream()
        .filter(n -> n.length() > 5)
        .count();
```

---

## 2. Creating Streams

```java
Stream.of("a", "b", "c");
Arrays.stream(new int[]{1,2,3});          // IntStream
list.stream();
list.parallelStream();
Stream.iterate(1, n -> n * 2);            // infinite, needs limit()
Stream.iterate(1, n -> n < 100, n -> n*2);// bounded (Java 9+)
Stream.generate(Math::random);            // infinite
IntStream.range(0, 5);                    // 0..4
IntStream.rangeClosed(0, 5);              // 0..5
Files.lines(path);                        // Stream<String>
Stream.empty();
Stream.concat(s1, s2);
```

---

## 3. Intermediate Operations (lazy, return a Stream)

| Operation | Purpose |
|---|---|
| `filter(Predicate)` | keep matching elements |
| `map(Function)` | transform each element |
| `flatMap(Function)` | flatten nested streams |
| `distinct()` | remove duplicates (uses `equals`) |
| `sorted()` / `sorted(Comparator)` | order elements |
| `peek(Consumer)` | side-effect for debugging (avoid for logic) |
| `limit(n)` | truncate to n elements |
| `skip(n)` | drop first n elements |
| `mapMulti` (Java 16+) | like flatMap but imperative, more efficient for few outputs |

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

---

## 4. Terminal Operations (eager, trigger execution)

| Operation | Returns |
|---|---|
| `forEach` / `forEachOrdered` | void |
| `collect(Collector)` | R (list, map, string, custom) |
| `toList()` (Java 16+) | unmodifiable `List<T>` |
| `reduce(...)` | `Optional<T>` or T |
| `count()` | long |
| `anyMatch` / `allMatch` / `noneMatch` | boolean |
| `findFirst` / `findAny` | `Optional<T>` |
| `min` / `max` | `Optional<T>` |
| `toArray()` | Object[] or T[] |

```java
int total = Stream.of(1,2,3,4)
        .reduce(0, Integer::sum);

Optional<String> longest = names.stream()
        .max(Comparator.comparingInt(String::length));
```

---

## 5. Collectors (the deep part)

```java
Collectors.toList();
Collectors.toSet();
Collectors.toUnmodifiableList();
Collectors.toMap(keyFn, valueFn);
Collectors.toMap(keyFn, valueFn, (a,b) -> a);       // merge function for dup keys
Collectors.joining(", ", "[", "]");
Collectors.counting();
Collectors.summingInt / summingDouble / summingLong;
Collectors.averagingInt / averagingDouble;
Collectors.summarizingInt(...);                      // IntSummaryStatistics
Collectors.groupingBy(classifier);                    // Map<K, List<T>>
Collectors.groupingBy(classifier, downstream);         // Map<K, D>
Collectors.groupingBy(classifier, Collectors.counting());
Collectors.partitioningBy(predicate);                   // Map<Boolean, List<T>>
Collectors.mapping(mapper, downstream);
Collectors.reducing(...);
Collectors.teeing(c1, c2, merger);                      // Java 12+
```

```java
Map<Boolean, List<String>> byLength = names.stream()
        .collect(Collectors.partitioningBy(n -> n.length() > 5));

Map<Integer, Long> countByLength = names.stream()
        .collect(Collectors.groupingBy(String::length, Collectors.counting()));

String joined = names.stream()
        .collect(Collectors.joining(", "));
```

---

## 6. Primitive Streams

`IntStream`, `LongStream`, `DoubleStream` avoid boxing overhead.

```java
int sum = IntStream.rangeClosed(1, 10).sum();
OptionalDouble avg = IntStream.of(1,2,3).average();
IntSummaryStatistics stats = IntStream.of(1,2,3).summaryStatistics();

// Bridging
Stream<Integer> boxed = IntStream.range(0,5).boxed();
IntStream unboxed = list.stream().mapToInt(Integer::intValue);
```

---

## 7. Optional (streams' constant companion)

```java
Optional<String> first = names.stream().findFirst();
first.ifPresent(System.out::println);
first.ifPresentOrElse(System.out::println, () -> System.out.println("empty"));
String value = first.orElse("default");
String value2 = first.orElseGet(() -> computeDefault());
String value3 = first.orElseThrow(() -> new NoSuchElementException());
Optional<Integer> len = first.map(String::length);
```

---

## 8. Parallel Streams

```java
list.parallelStream()
    .filter(...)
    .map(...)
    .collect(Collectors.toList());
```

- Uses the **common ForkJoinPool** (shared across the JVM — a slow task on one parallel stream can starve others).
- Good for **large, CPU-bound, stateless, associative** operations.
- Bad for: I/O-bound work, small collections (overhead > gain), `LinkedList`/`Stream.iterate` sources (poor splitting), order-sensitive `forEach` (use `forEachOrdered` if order matters, but that kills parallel benefit).
- `reduce`/`collect` need an **associative**, **stateless** combiner to be correct in parallel.

---

## 9. Common Pitfalls

1. **Reusing a consumed stream** → `IllegalStateException`.
2. **Modifying the source during a stream operation** → `ConcurrentModificationException`.
3. **Using `peek` for actual logic** — it's meant for debugging; JIT may skip it if the result isn't used.
4. **Stateful lambdas in parallel streams** (e.g., mutating an external list inside `forEach`) — not thread-safe.
5. **Infinite streams without `limit`** — hangs forever.
6. **`findAny` vs `findFirst`** — `findAny` is non-deterministic in parallel (fine when you don't care which).
7. **Boxing overhead** — prefer `IntStream`/`LongStream`/`DoubleStream` for numeric-heavy work.
8. **`Collectors.toMap` NPE/dup key** — throws `IllegalStateException` on duplicate keys unless you supply a merge function.
9. **Autoboxing in `reduce` without identity** — returns `Optional`, easy to forget `.get()`/`.orElse()`.

---

---

## Quick Self-Check
If you can explain **why** each of these is true, you've got the topic solid:
1. Why does `stream.filter(...).map(...)` not iterate the source twice?
2. Why does `Collectors.toMap` throw on duplicate keys but `groupingBy` doesn't?
3. Why is `parallelStream()` often slower on a list of 10 elements?
4. Why does `peek` sometimes not run if nothing downstream consumes the stream?
5. Why is `Stream.iterate(1, n -> n+1)` dangerous without `limit` or the bounded overload?


---

## Practice Questions & Answers

### Practice Problems (all topics, with answers)

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
