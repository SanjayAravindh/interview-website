# Senior-Level Java Generics Mastery Course
### Java 21 LTS Baseline

---

## Table of Contents

1. [Part 1 — Why Generics Exist](#part-1-why-generics-exist)
2. [Part 2 — Type Erasure: The Runtime Truth](#part-2-type-erasure-the-runtime-truth)
3. [Part 3 — Bridge Methods and Synthetic Methods](#part-3-bridge-methods-and-synthetic-methods)
4. [Part 4 — Raw Types and Legacy Compatibility](#part-4-raw-types-and-legacy-compatibility)
5. [Part 5 — Unchecked Warnings and Suppression](#part-5-unchecked-warnings-and-suppression)
6. [Part 6 — Generic Classes and Interfaces](#part-6-generic-classes-and-interfaces)
7. [Part 7 — Generic Methods](#part-7-generic-methods)
8. [Part 8 — Bounded Type Parameters](#part-8-bounded-type-parameters)
9. [Part 9 — Wildcards: `? extends`, `? super`, `?`](#part-9-wildcards-extends-super)
10. [Part 10 — PECS: Producer Extends, Consumer Super](#part-10-pecs-producer-extends-consumer-super)
11. [Part 11 — Wildcard Capture](#part-11-wildcard-capture)
12. [Part 12 — Generic Arrays Prohibition](#part-12-generic-arrays-prohibition)
13. [Part 13 — Recursive Generics](#part-13-recursive-generics)
14. [Part 14 — Type Inference](#part-14-type-inference)
15. [Part 15 — Diamond Operator](#part-15-diamond-operator)
16. [Part 16 — Intersection Types](#part-16-intersection-types)
17. [Part 17 — Generic Exception Limitations](#part-17-generic-exception-limitations)
18. [Part 18 — Generics vs Polymorphism](#part-18-generics-vs-polymorphism)
19. [Part 19 — Collections API Generics Patterns](#part-19-collections-api-generics-patterns)
20. [Part 20 — Generic Factories](#part-20-generic-factories)
21. [Part 21 — EnumSet and EnumMap](#part-21-enumset-and-enummap)
22. [Part 22 — Reflection Limitations with Generics](#part-22-reflection-limitations-with-generics)
23. [Part 23 — Production Pitfalls](#part-23-production-pitfalls)
24. [Part 24 — Interview Mental Models](#part-24-interview-mental-models)
25. [Part 25 — Practice Questions & Answers](#part-25-practice-questions-answers)

---

# Part 1 — Why Generics Exist

## The pre-generics problem

Before Java 5 (2004), every collection held `Object`:

```java
// Pre-Java 5 style (still compiles today as raw types)
List list = new ArrayList();
list.add("hello");
list.add(42);           // no compile-time error — anything goes
String s = (String) list.get(1); // compiles fine, ClassCastException at runtime
```

The cast failure happens **far from the mistake**. The bug is at `add(42)`; the crash is at `get(1)`. In a large codebase, those two lines may be in different modules, written by different teams, merged weeks apart. Static typing's entire value proposition — catching errors early — was hollow for the most error-prone API surface in Java: collections.

## What generics buy you

Generics reintroduce **parametric polymorphism** to Java: a type or method can be parameterized by one or more type variables (`T`, `E`, `K`, `V`), and the compiler checks that usage is consistent **at compile time**.

```java
List<String> names = new ArrayList<>();
names.add("Alice");
names.add(42);          // compile error — int is not a String
String s = names.get(0); // no cast needed — compiler knows it's String
```

Three concrete wins:
1. **Type safety at compile time** — wrong types rejected before deployment.
2. **Elimination of casts** — cleaner code, fewer `ClassCastException` surfaces.
3. **Richer APIs** — methods can express relationships between types (`Map<K,V>`, `Comparator<T>`, `Class<T>`).

## Generics are a compile-time fiction

This is the single most important sentence in this entire course:

> **Java generics exist only in source code and compiler metadata. They are erased at runtime.**

`List<String>` and `List<Integer>` are the **same class** at runtime (`ArrayList`). The JVM has no notion of "this list holds Strings." Everything generics-related is enforced by the compiler and then discarded. Every advanced generics topic — erasure, bridge methods, wildcard capture, reflection gaps, heap pollution — flows from this one design decision.

Why erasure? Backward compatibility. Java 5 had to run on JVMs that already existed and had to interoperate with libraries compiled without generics. Reification (keeping type parameters at runtime, as in C#) would have broken binary compatibility with every pre-5 `.class` file.

## The mental model for interviews

Generics are **compiler-checked documentation** that becomes invisible at runtime. They make Java feel statically typed for collections and APIs, but the runtime is still dynamically typed `Object` references under the hood. Senior developers internalize both views simultaneously.

---

# Part 2 — Type Erasure: The Runtime Truth

## What erasure does

The compiler replaces every type parameter with its **erasure** — the upper bound of the type variable, or `Object` if unbounded:

```java
// Source
class Box<T> {
    T value;
    void set(T v) { value = v; }
    T get() { return value; }
}

// Conceptual erasure (what the compiler generates)
class Box {
    Object value;
    void set(Object v) { value = v; }
    Object get() { return value; }
}
```

For bounded type parameters:

```java
// Source
class NumberBox<T extends Number> {
    T value;
}

// Erasure
class NumberBox {
    Number value;  // upper bound, not Object
}
```

## Consequences you must know cold

### 1. No `new T()` or `new T[]`

The compiler doesn't know what `T` is at runtime, so it can't allocate:

```java
class Factory<T> {
    T create() {
        return new T();     // compile error
    }
    T[] array() {
        return new T[10];   // compile error
    }
}
```

Workarounds: pass a `Class<T>` or `Supplier<T>`, use an `Object[]` internally with unchecked cast (see Part 12).

### 2. `instanceof` doesn't work with parameterized types

```java
List<String> list = new ArrayList<>();
if (list instanceof List<String>) { }  // compile error
if (list instanceof List) { }         // legal — raw type or unparameterized
```

Java 16+ allows `instanceof` with **concrete** parameterized types in some patterns, but `List<String>` vs `List<Integer>` distinction is still impossible at runtime because erasure makes them identical.

### 3. Cannot overload on erased-equivalent signatures

```java
void process(List<String> strings) { }
void process(List<Integer> ints) { }  // compile error — same erasure: process(List)
```

### 4. Generic type info is not on instances

```java
List<String> strings = new ArrayList<>();
// At runtime, strings.getClass() == ArrayList.class
// No "String" anywhere in the object's class metadata
```

### 5. Casts are inserted by the compiler

When you write:

```java
String s = list.get(0);
```

The compiler actually generates:

```java
String s = (String) list.get(0);
```

The cast is unchecked at compile time (compiler trusts the generic declaration) but **checked at runtime**. If heap pollution occurred, this is where `ClassCastException` fires — often far from the pollution source.

## Reifiable vs non-reifiable types

A **reifiable type** is a type whose runtime representation carries full type information:
- Primitive types (`int`, `double`)
- Non-generic classes (`String`, `ArrayList` — the raw class)
- Arrays of reifiable component types (`String[]`, `int[]`)
- Wildcard types with **only** `?` (unbounded) or `? extends`/`? super` where the bound is erased to a reifiable type

A **non-reifiable type** loses information at erasure:
- `List<String>` → `List`
- `T` → `Object` or upper bound
- `List<? extends Serializable>` → `List`

Arrays of non-reifiable types are illegal (`new List<String>[10]`) because array stores check element type at runtime via `ArrayStoreException`, but erasure would make that check meaningless.

## `javap` proof

Compile a simple generic class and disassemble:

```bash
javac Box.java && javap -c Box
```

You'll see `Object` everywhere where `T` appeared in source, plus synthetic bridge methods if `T` participated in inheritance (Part 3).

---

# Part 3 — Bridge Methods and Synthetic Methods

## Why bridge methods exist

Generics + inheritance + erasure create a signature mismatch. Consider:

```java
class Node<T> {
    T data;
    void setData(T data) { this.data = data; }
}

class MyNode extends Node<String> {
    // inherits setData(T) which erases to setData(Object)
    // but we want setData(String) for type safety in subclasses
}
```

After erasure, `Node` has `setData(Object)`. A subclass that overrides with a more specific type would need `setData(String)`. But `setData(String)` is **not** an override of `setData(Object)` in Java's method resolution — different erased signatures.

Without bridge methods, polymorphic calls through a `Node` reference to a `MyNode` would call the wrong method or fail to compile.

## What the compiler generates

```java
class MyNode extends Node<String> {
    void setData(String data) { this.data = data; }

    // Synthetic bridge method — you never write this
    @Override
    void setData(Object data) {
        setData((String) data);  // casts and delegates
    }
}
```

The bridge method:
- Has the **erased signature** of the superclass method (`Object` parameter).
- Is marked `synthetic` and `bridge` in bytecode.
- Delegates to the type-specific method with an unchecked cast.

## Real-world example: `Comparable<T>`

```java
class Apple implements Comparable<Apple> {
  public int compareTo(Apple other) { ... }
}
```

Erasure makes `Comparable<Apple>` become `Comparable` with `compareTo(Object)`. The compiler generates:

```java
public int compareTo(Object o) { return compareTo((Apple) o); }  // bridge
public int compareTo(Apple other) { ... }                        // real method
```

This is why `Comparable` works with arrays and legacy APIs that call `compareTo(Object)` — the bridge satisfies the erased contract.

## Interview angle

"If generics are erased, how does overriding work with generic methods?" → Bridge methods. The compiler synthesizes erased-signature methods that cast and forward. You can see them with `javap -v` as `ACC_BRIDGE | ACC_SYNTHETIC`.

## Synthetic methods beyond bridges

The compiler also generates synthetic methods for:
- Private methods in interfaces (Java 8+ default method access).
- Lambda and inner class accessors.
- Enum `values()` / `valueOf()` in some patterns.

Bridge methods are the generics-specific subset.

---

# Part 4 — Raw Types and Legacy Compatibility

## What a raw type is

Using a generic class or interface **without** type arguments:

```java
List list = new ArrayList();       // raw List
list.add("hello");
list.add(42);
```

Raw types exist solely for migration from pre-Java 5 code. They are **not** a feature you should use in modern code.

## Raw type behavior

A raw type is treated as the erasure of the generic type:

```java
List raw = new ArrayList();
List<String> typed = new ArrayList<>();

raw = typed;    // legal — both are List at runtime
typed = raw;    // legal but generates unchecked warning — compiler can't verify safety
```

Assignment from raw to parameterized type is allowed (with warning) because legacy code had to compile. The compiler inserts implicit unchecked casts on `get()` operations.

## Heap pollution via raw types

```java
List<String> strings = new ArrayList<>();
List raw = strings;
raw.add(42);                    // unchecked warning, but compiles
String s = strings.get(0);      // ClassCastException — Integer cannot be cast to String
```

The `add(42)` went through the raw reference, bypassing generic checking. The `List<String>` is now polluted. The exception fires on `get()`, not on `add()`.

## `@SuppressWarnings("rawtypes")` vs fixing the code

Suppress only in genuine legacy interop boundaries (calling old libraries, deserialization glue). Never suppress in application logic — fix the types.

## Raw types in method signatures

```java
void legacy(List list) { }           // raw — avoid
void modern(List<String> list) { } // parameterized — use this
```

Mixing raw and parameterized overloads can cause confusion because erasure may make them identical at runtime.

---

# Part 5 — Unchecked Warnings and Suppression

## Categories of unchecked warnings

| Warning | Typical cause |
|---|---|
| `unchecked call` | Calling generic method on raw type |
| `unchecked conversion` | Assigning raw to parameterized |
| `unchecked cast` | Casting `(T)` or `(List<String>)` without proof |

## Example: unchecked conversion

```java
List<String> list = new ArrayList();  // warning: unchecked conversion
// ArrayList is raw on RHS if you omit <String> on constructor in older style
List<String> list = new ArrayList<>(); // diamond fixes RHS — no warning
```

## Example: unchecked cast

```java
@SuppressWarnings("unchecked")
static <T> T[] toArray(List<T> list, T[] array) {
    return (T[]) list.toArray(array);  // internally may use Object[]
}
```

## `@SafeVarargs`

Marks a **final or static** method with varargs of generic type as safe for callers:

```java
@SafeVarargs
static <T> List<T> asList(T... elements) {
    return List.of(elements);
}
```

Without `@SafeVarargs`, callers get warnings because varargs creates `T[]` which is a generic array. The annotation shifts responsibility to the method author.

## Production discipline

- Treat unchecked warnings as bugs unless you can articulate why they're safe.
- Scope `@SuppressWarnings("unchecked")` to the **narrowest** block or method.
- Never blanket-suppress at class level in application code.
- In code review, any suppression demands a one-line justification comment.

---

# Part 6 — Generic Classes and Interfaces

## Declaring generic classes

```java
public class Pair<K, V> {
    private final K key;
    private final V value;

    public Pair(K key, V value) {
        this.key = key;
        this.value = value;
    }

    public K getKey() { return key; }
    public V getValue() { return value; }
}
```

Type parameters are declared after the class name, before the extends clause:

```java
public class SortedList<E extends Comparable<E>> extends AbstractList<E> { ... }
```

## Generic interfaces

```java
public interface Repository<T, ID> {
    Optional<T> findById(ID id);
    void save(T entity);
    void delete(T entity);
}
```

Implementations can be generic classes or can specify concrete types:

```java
class UserRepository implements Repository<User, Long> {
    public Optional<User> findById(Long id) { ... }
    // T=User, ID=Long throughout
}
```

## Static context cannot use class type parameters

```java
class Box<T> {
    static T value;           // compile error — T belongs to instances
    static T create() { }     // compile error
    static <U> U create(U u) { return u; }  // legal — U is method-scoped
}
```

Class-level `T` is tied to each instance's type argument. Static members exist without an instance, so they can't reference instance-scoped type parameters.

## Multiple type parameters

```java
public interface Map<K, V> {
    V get(K key);
    V put(K key, V value);
    Set<K> keySet();
    Set<Map.Entry<K, V>> entrySet();
}
```

The relationships between `K` and `V` are expressed in the signature — `get` takes `K` and returns `V`. This is parametric polymorphism: one interface definition, infinitely many concrete type combinations.

## Type parameter naming conventions

| Letter | Typical meaning |
|---|---|
| `E` | Element (collections) |
| `K` | Key |
| `V` | Value |
| `N` | Number |
| `T` | Type (general) |
| `S`, `U`, `V` | 2nd, 3rd, 4th types |

These are conventions, not rules. Use descriptive names when clarity helps: `Repository<Entity, Id>`.

---

# Part 7 — Generic Methods

## Generic methods vs generic classes

A generic **method** declares its own type parameters, independent of the class:

```java
public class Utils {
    // Generic method — <T> before return type
    public static <T> T identity(T value) {
        return value;
    }

    public static <T> void swap(List<T> list, int i, int j) {
        T tmp = list.get(i);
        list.set(i, list.get(j));
        list.set(j, tmp);
    }
}
```

`Utils` is not a generic class — `T` exists only within each method call's scope.

## Inference at the call site

```java
String s = Utils.identity("hello");  // T inferred as String
Integer n = Utils.identity(42);      // T inferred as Integer
```

Explicit type argument is optional when inference works:

```java
String s = Utils.<String>identity("hello");  // explicit T
```

## Generic methods in non-generic classes

Most utility methods in `Collections`, `Arrays`, and `Comparator` are generic methods on non-generic classes:

```java
public static <T> void sort(List<T> list, Comparator<? super T> c) { ... }
public static <T> T requireNonNull(T obj) { ... }
```

## Bounded generic methods

```java
public static <T extends Comparable<T>> T max(List<T> list) {
    T max = list.get(0);
    for (T item : list) {
        if (item.compareTo(max) > 0) max = item;
    }
    return max;
}
```

The bound on `T` ensures `compareTo` is available without casting.

## Generic constructors

Constructors can also declare type parameters (rare):

```java
class Foo {
    <T> Foo(T value) { ... }
}
```

More commonly, the class itself is generic and the constructor uses the class's `T`.

---

# Part 8 — Bounded Type Parameters

## Upper bounds: `T extends Bound`

Restricts `T` to be a subtype of `Bound` (class or interface):

```java
class NumberBox<T extends Number> {
    private T value;
    public double doubleValue() { return value.doubleValue(); }  // Number methods available
}
```

Multiple bounds with intersection (Part 16):

```java
class Processor<T extends Number & Comparable<T>> { ... }
```

## Lower bounds on type parameters — don't exist

Java does **not** allow `T super SomeType` as a type parameter bound. Lower bounds exist only for **wildcards** (`? super T`). This asymmetry is a language design choice — use wildcards when you need contravariance.

## Bounded types in APIs

```java
// Collections.max — the canonical example
public static <T extends Object & Comparable<? super T>> T max(Collection<? extends T> coll)
```

Breaking this down:
- `T extends Object & Comparable<? super T>` — `T` must be Comparable to something it can compare against (often itself or a superclass).
- `Collection<? extends T>` — read-only producer of `T` elements.

## When to bound vs when to wildcard

| Situation | Use |
|---|---|
| You **create** instances of `T` | Bounded type parameter `T extends Foo` |
| You only **read** elements | Wildcard `? extends T` |
| You only **write** elements | Wildcard `? super T` |
| You read and write | Plain `T` |

---

# Part 9 — Wildcards: `? extends`, `? super`, `?`

## Why wildcards exist

Generics are **invariant**: `List<String>` is not a subtype of `List<Object>`. This is correct — otherwise:

```java
List<Object> objects = new ArrayList<String>();  // if this compiled...
objects.add(42);  // would put Integer into a List<String>
```

But sometimes you want **flexibility** without sacrificing safety. Wildcards provide controlled covariance and contravariance.

## Unbounded wildcard: `?`

`List<?>` — a list of **unknown** type. You can read elements as `Object`; you cannot add anything except `null`:

```java
List<?> list = new ArrayList<String>();
Object o = list.get(0);   // read as Object — legal
list.add("hello");        // compile error — don't know the real type
list.add(null);           // legal — null is valid for any reference type
```

`List<?>` is **not** the same as `List<Object>`:
- `List<Object>` — you can add any Object.
- `List<?>` — read-only from the perspective of adding (except null).

## Upper bounded wildcard: `? extends T` (covariant)

`List<? extends Number>` — a list of some specific subtype of `Number`, unknown which:

```java
List<? extends Number> nums = new ArrayList<Integer>();
Number n = nums.get(0);     // read as Number — legal
nums.add(42);               // compile error — might be List<Double>
nums.add(null);             // legal
```

Safe to **read** (producer). Unsafe to **write** (except null) because you don't know the actual element type.

## Lower bounded wildcard: `? super T` (contravariant)

`List<? super Integer>` — a list that can hold `Integer` and any supertype:

```java
List<? super Integer> ints = new ArrayList<Integer>();
ints.add(42);               // legal — Integer fits any supertype list that accepts Integer
Object o = ints.get(0);     // read only as Object — don't know exact element type
Integer i = ints.get(0);    // compile error
```

Safe to **write** `T` (consumer). Unsafe to **read** as `T` because the list might be `List<Number>` or `List<Object>`.

## Wildcard summary table

| Wildcard | Read as | Write | Role |
|---|---|---|---|
| `?` | `Object` | only `null` | Unknown type |
| `? extends T` | `T` | only `null` | Producer (source) |
| `? super T` | `Object` | `T` and subtypes | Consumer (sink) |
| `T` | `T` | `T` | Both read and write |

## Invariance demonstrated

```java
List<String> strings = new ArrayList<>();
List<? extends Object> objects = strings;  // legal — covariance via extends
// List<Object> objects = strings;         // illegal — invariant

List<Object> objs = new ArrayList<>();
List<? super String> sink = objs;          // legal — contravariance via super
```

---

# Part 10 — PECS: Producer Extends, Consumer Super

## The rule

Joshua Bloch's **PECS** (Producer Extends, Consumer Super):

- If a parameter produces (you **read** from it) `T` values → use `? extends T`
- If a parameter consumes (you **write** to it) `T` values → use `? super T`
- If it does both → use plain `T` (no wildcard)

## Canonical example: `Collections.copy`

```java
public static <T> void copy(List<? super T> dest, List<? extends T> src) {
    for (int i = 0; i < src.size(); i++) {
        dest.set(i, src.get(i));
    }
}
```

- `src` is a **producer** — we only read from it → `? extends T`
- `dest` is a **consumer** — we only write to it → `? super T`
- `T` is the common type we copy (e.g., `Integer` when copying `ArrayList<Integer>` to `ArrayList<Number>`)

Usage:

```java
List<Integer> ints = new ArrayList<>(List.of(1, 2, 3));
List<Number> numbers = new ArrayList<>(List.of(0.0, 0.0, 0.0));
Collections.copy(numbers, ints);  // T inferred as Integer
```

## PECS in API design

```java
// Bad — overly restrictive
void addAll(List<T> dest, List<T> src) { ... }

// Good — PECS
void addAll(List<? super T> dest, List<? extends T> src) {
    for (T item : src) {
        dest.add(item);
    }
}
```

With PECS, you can add `List<Integer>` to `List<Number>` — essential for real APIs.

## PECS with `Comparator`

```java
public static <T> void sort(List<T> list, Comparator<? super T> c) { ... }
```

The list **produces** `T` elements for comparison. The comparator **consumes** `T` (or any supertype) for comparison. So comparator uses `? super T`.

This is why `Comparator<Number>` works with `List<Integer>`:

```java
List<Integer> ints = new ArrayList<>(List.of(3, 1, 2));
ints.sort(Comparator.naturalOrder());  // Comparator<? super Integer>
```

## PECS failure: using `extends` on a consumer

```java
// WRONG
void fill(List<? extends Number> list) {
    list.add(42);  // compile error — extends makes it a producer, not consumer
}

// RIGHT
void fill(List<? super Integer> list) {
    list.add(42);  // consumer — super
}
```

## PECS failure: using `super` on a producer

```java
// WRONG
double sum(List<? super Number> list) {
    double total = 0;
    for (Number n : list) {  // compile error — can't iterate as Number
        total += n.doubleValue();
    }
    return total;
}

// RIGHT
double sum(List<? extends Number> list) {
    double total = 0;
    for (Number n : list) {
        total += n.doubleValue();
    }
    return total;
}
```

## Mental shortcut

Ask: "Am I pulling items **out** of this parameter, or pushing items **into** it?"
- Pulling out → `extends`
- Pushing in → `super`
- Both → plain `T`

---

# Part 11 — Wildcard Capture

## The problem

You cannot use a wildcard type as a type argument to another generic method in some situations because the compiler cannot name the wildcard's capture type:

```java
void swap(List<?> list, int i, int j) {
    // list.set(i, list.get(j));  // compile error in some formulations
}
```

The compiler doesn't know what `?` is — it can't verify `set` and `get` use the same type.

## The solution: helper with capture

```java
void swap(List<?> list, int i, int j) {
    swapHelper(list, i, j);
}

private static <T> void swapHelper(List<T> list, int i, int j) {
    T tmp = list.get(i);
    list.set(i, list.get(j));
    list.set(j, tmp);
}
```

The compiler **captures** the wildcard: for this invocation, `T` is treated as the unknown element type of `list`. All operations within `swapHelper` are type-consistent.

## Capture conversion

When the compiler sees `List<?>` passed to `List<T>`, it performs a **capture conversion** — creates a fresh type variable (synthetic name like `CAP#1`) that stands for "whatever `?` is for this call."

You never write `CAP#1` — it's internal. But understanding capture explains why helper methods with named type parameters are the standard pattern for wildcard manipulation.

## `Collections.max` capture

```java
public static <T extends Object & Comparable<? super T>> T max(Collection<? extends T> coll) {
    // Internally needs to compare elements — capture makes T the common type
}
```

## What you cannot do with wildcards

```java
void bad(List<?> list) {
    List<Object> objects = list;  // compile error — invariant
    list.add(list.get(0));        // compile error — can't relate ? to itself
}
```

---

# Part 12 — Generic Arrays Prohibition

## Why `new T[]` is illegal

Arrays are **reified** — they check element type at runtime via `ArrayStoreException`. Generics are **erased** — no runtime type for `T`. Creating `new T[10]` would create an array that claims to hold `T` but can't enforce it.

```java
class Box<T> {
    T[] create(int size) {
        return new T[size];  // compile error
    }
}
```

## Why `List<String>[]` is illegal

```java
List<String>[] array = new List<String>[10];  // compile error
```

If it compiled:

```java
List<String>[] arr = new List<String>[10];
List<Integer> ints = new ArrayList<>();
arr[0] = ints;  // ArrayStoreException at best, silent corruption at worst
```

Erasure makes `List<String>[]` and `List<Integer>[]` the same array type at runtime — no way to distinguish.

## Legal: `String[]`, `int[]`

Arrays of **reifiable** types work normally.

## Workaround 1: `Object[]` + unchecked cast

```java
@SuppressWarnings("unchecked")
T[] create(int size) {
    return (T[]) new Object[size];
}
```

Used internally by `ArrayList.toArray(T[])`. Safe if you never let external code write wrong types into the array. **Heap pollution risk** if misused.

## Workaround 2: `Class<T>` token

```java
T[] create(Class<T> type, int size) {
    return (T[]) Array.newInstance(type, size);
}
```

`Array.newInstance` creates a properly typed array at runtime because `Class<T>` is reified. This is the type-safe approach for generic array creation.

## Workaround 3: use `List<T>` instead of `T[]`

Modern code prefers `List<T>` or `ArrayList<T>` over generic arrays. No reification issues, no cast hacks.

## Varargs + generics

```java
public static <T> List<T> asList(T... elements) { ... }
```

Varargs creates `T[]` under the hood. `@SafeVarargs` on static/final methods tells the compiler the method won't misuse the array. Callers of non-`@SafeVarargs` varargs generic methods get unchecked warnings.

## `toArray(T[])` pattern

```java
String[] arr = list.toArray(new String[0]);  // preferred — zero-sized array, sized correctly by JVM
```

Passing `new String[0]` is more efficient than `new String[list.size()]` in modern JVMs — the returned array is correctly sized.

---

# Part 13 — Recursive Generics

## What recursive generics are

A type parameter bound references the type being declared:

```java
interface Comparable<T extends Comparable<T>> { ... }
enum Enum<E extends Enum<E>> { ... }
```

The type parameter appears in its own bound — "recursive."

## `Comparable<T>` — the classic example

```java
public interface Comparable<T> {
    int compareTo(T other);
}
```

Why `T extends Comparable<T>` in methods?

```java
public static <T extends Comparable<T>> T max(T[] array) { ... }
```

This says: `T` must be comparable **to itself** (or a type that `T` can compare against via the recursive bound). An `Apple` implements `Comparable<Apple>` — `compareTo` takes `Apple`.

## F-bounded polymorphism

Sometimes you need `T` comparable to a **supertype**:

```java
public static <T extends Comparable<? super T>> T max(Collection<? extends T> coll)
```

`? super T` in the `Comparable` bound allows `Integer` in a `Collection<Integer>` even though `Integer.compareTo` accepts `Integer` — `Integer` implements `Comparable<Integer>`, and `Integer` is a `? super Integer`.

This is **F-bounded** polymorphism (bounded quantification) — the bound references the type itself in a flexible way.

## `Enum<E extends Enum<E>>`

```java
public abstract class Enum<E extends Enum<E>> implements Comparable<E>, Serializable {
    public final int compareTo(E other) { ... }
}
```

Each enum constant's class is a concrete enum type (`Season`, `Day`). `Season extends Enum<Season>`. The recursive bound ensures `compareTo` is between constants of the **same** enum type, not arbitrary enums.

```java
enum Season { SPRING, SUMMER }
enum Day { MONDAY, TUESDAY }
// Season.SPRING.compareTo(Day.MONDAY);  // compile error — different enum types
```

## `Class<T>` — another recursive pattern

```java
public final class Class<T> {
    T cast(Object obj) { ... }
    T newInstance() { ... }  // deprecated
}
```

`Class<String>`'s `cast` returns `String`. The `T` links the class token to the type it represents.

## When recursive bounds confuse people

```java
class Foo<T extends Comparable<T>> { }  // T must compare to itself
class Bar<T extends Comparable<Bar<T>>> { }  // rare — T compares to Bar<T>
```

The first is standard. The second appears in advanced APIs (e.g., some builder patterns). Read the bound as a constraint on what operations are available on `T`.

---

# Part 14 — Type Inference

## What inference does

The compiler deduces type arguments from context so you don't write them explicitly:

```java
List<String> list = new ArrayList<>();  // diamond infers <String>
String s = Collections.<String>emptyList();  // explicit when needed
```

## Inference contexts

Type inference applies in:
- Generic method invocations
- Generic class instantiation (`new ArrayList<>()`)
- Lambda parameter types (when target type is known)
- Method reference target types

## Multi-argument inference

```java
Map<String, List<Integer>> map = new HashMap<>();
map.put("key", new ArrayList<>());  // infers ArrayList<Integer> from Map's value type
```

## Inference with method references

```java
List<String> names = List.of("a", "bb", "ccc");
names.sort(Comparator.comparing(String::length));  // T inferred as String
```

## Inference limitations

Sometimes inference fails and you must specify explicitly:

```java
// Inference may fail — explicit type argument needed
Collections.<String>emptyList();
Stream.<String>empty();
```

Common failure: chained calls where intermediate type is too generic:

```java
// May need explicit type
List<String> list = Stream.of("a", "b").collect(Collectors.toList());
// Works in modern Java — inference improved over versions
```

## Java 8+ improved inference

Java 8 extended inference to lambda and method reference contexts. Java 9+ added more contexts. Java 21 continues refinements — but the core model is the same: compiler matches actual argument types against generic signatures to solve for type variables.

## Inference vs erasure

Inference is **compile-time only**. It never changes runtime behavior. Failed inference is a compile error, not a runtime surprise.

---

# Part 15 — Diamond Operator

## Before diamond (Java 7+)

```java
Map<String, List<Integer>> map = new HashMap<String, List<Integer>>();
```

Redundant type arguments on both sides.

## With diamond

```java
Map<String, List<Integer>> map = new HashMap<>();
```

The compiler infers `HashMap<String, List<Integer>>` from the left-hand side.

## Diamond with anonymous classes — limitation

```java
// Compile error — anonymous classes need explicit type args
Runnable r = new Runnable<>() { public void run() {} };

// Must write:
Runnable r = new Runnable() { public void run() {} };
```

Anonymous classes have no left-hand generic context in the same way — the diamond cannot infer.

## Diamond in Java 9+ `var`

```java
var list = new ArrayList<String>();  // var is ArrayList<String>
var map = new HashMap<String, Integer>();  // inferred fully
```

`var` infers the **full** parameterized type from the constructor — not raw.

## Empty diamond in method chains

```java
return new ArrayList<>(List.of(1, 2, 3));  // return type determines inference
```

---

# Part 16 — Intersection Types

## What intersection types are

A type that is **multiple types at once** — rarely written directly in Java source, but they appear in generics bounds and inference:

```java
<T extends Number & Comparable<T>> void process(T value) {
    double d = value.doubleValue();   // Number
    int cmp = value.compareTo(value); // Comparable
}
```

`T` must extend **both** `Number` and `Comparable<T>` — an intersection bound.

## Intersection in casts (rare, internal)

The compiler uses intersection types for some cast expressions:

```java
// Internal — you don't write this
// (Serializable & Comparable) result of some generic inference
```

## `Class<? extends Serializable & Comparable>`

Bounds can combine class + interfaces:

```java
<T extends Number & Serializable & Comparable<? super T>>
```

Order: class first, then interfaces.

## Intersection types in lambda inference

When a lambda's target type is an intersection (e.g., `Serializable & Runnable`), the compiler infers a synthetic intersection type. You interact with this through APIs, not by writing intersection types in source.

## Practical use

Intersection bounds let you require multiple capabilities on one type parameter without wrapping:

```java
static <T extends AutoCloseable & Flushable> void writeAndClose(T stream) {
    stream.flush();
    stream.close();
}
```

One type parameter, multiple interface contracts.

---

# Part 17 — Generic Exception Limitations

## Cannot catch generic exceptions

```java
try {
    ...
} catch (T ex) { }  // compile error — T is not known to be Exception
```

Type parameters cannot represent caught exception types because erasure would make catch blocks meaningless.

## Cannot throw generic type parameters

```java
class Box<T extends Exception> {
    void doWork() throws T { }  // legal declaration
    void fail() throws T {
        throw new T();  // compile error — can't instantiate exception from T
    }
}
```

You can **declare** `throws T` when `T extends Exception`, but you can't `throw new T()`.

## What works

```java
class ApiException extends Exception { }
class Client<T extends Exception> {
    void execute() throws T {  // T is known to be some Exception subtype at compile time
        throw new ApiException();  // legal if T is ApiException or superclass
    }
}
```

## Bounded exception type parameters — rare in practice

```java
interface ThrowingCallable<T, E extends Exception> {
    T call() throws E;
}
```

Allows callers to know the exception type. Used in some frameworks but uncommon in everyday code.

## Unchecked exceptions — no issue

`RuntimeException` and subclasses aren't checked — generics don't restrict them:

```java
class Box<T> {
    void fail() {
        throw new RuntimeException();  // always legal
    }
}
```

## Interview answer

"Can you have a generic exception class?" — Yes, `class MyException<T> extends Exception` compiles. "Can you throw `T` when `T extends Exception`?" — No, you can't instantiate or throw a type variable. "Can you declare `throws T`?" — Yes, for propagation typing in advanced APIs.

---

# Part 18 — Generics vs Polymorphism

## Two kinds of polymorphism

| Kind | Mechanism | When resolved |
|---|---|---|
| **Subtype polymorphism** | Inheritance, interfaces | Runtime (dynamic dispatch) |
| **Parametric polymorphism** | Generics | Compile time (erasure) |

They solve different problems and coexist.

## Subtype polymorphism example

```java
List list = new ArrayList();  // ArrayList substituted where List expected
list.add("hello");            // dynamic dispatch on add
```

Runtime knows the object is `ArrayList`. Method dispatch uses actual object type.

## Parametric polymorphism example

```java
List<String> strings = new ArrayList<>();
strings.add("hello");  // compile-time check that argument is String
```

No runtime type parameter. Check happens at compile time, then erases to `List.add(Object)`.

## Generics are not runtime polymorphism

```java
List<String> strings = new ArrayList<>();
List<Integer> ints = new ArrayList<>();

strings.getClass() == ints.getClass();  // true — both ArrayList.class
```

You cannot dispatch on type parameter at runtime:

```java
// IMPOSSIBLE in Java
if (T == String.class) { ... }  // compile error
```

## Combining both

```java
interface Processor<T> {
    void process(T item);  // parametric — T checked at compile time
}

class StringProcessor implements Processor<String> {
  public void process(String item) { ... }  // subtype — override with bridge method
}

Processor p = new StringProcessor();
p.process("hello");  // subtype dispatch + compile-time checking
```

## Generics vs method overloading

```java
void print(List<String> list) { }
void print(List<Integer> list) { }  // compile error — same erasure
```

Subtype polymorphism via overloading doesn't work with generic signatures that erase to the same method.

## The senior synthesis

Polymorphism lets you write code against supertypes and specialize behavior via subclasses — **runtime**. Generics let you write code that is type-safe for any type argument — **compile time**. Java chose erasure so subtype polymorphism (legacy bytecode) wouldn't break, which means generics **don't** participate in runtime dispatch.

---

# Part 19 — Collections API Generics Patterns

## Read-only parameters: `? extends T`

```java
int total = 0;
for (Integer i : list) { total += i; }  // list is List<? extends Number>
```

`Collections.max`, `Collections.min`, `containsAll`, `addAll` source — all use `? extends T` for source collections.

## Write-only parameters: `? super T`

```java
void addNumbers(List<? super Integer> list) {
    list.add(42);
}
```

`Collections.copy` destination, `Comparator<? super T>`, `Consumer<? super T>` in streams.

## Both read and write: plain `T`

```java
void replaceAll(List<T> list, T value) {
    for (int i = 0; i < list.size(); i++) {
        list.set(i, value);
    }
}
```

## `Map` generics

```java
Map<String, List<Integer>> map = new HashMap<>();
map.put("scores", List.of(90, 85));
List<Integer> scores = map.get("scores");
```

`Map<K,V>` — key and value type parameters are independent. `Map<String, Integer>` is not a subtype of `Map<String, Object>` (invariance).

## `Map.Entry` and iteration

```java
for (Map.Entry<String, Integer> entry : map.entrySet()) {
    String key = entry.getKey();
    Integer value = entry.getValue();
}
```

## `computeIfAbsent` — generics preserved

```java
Map<String, List<Integer>> map = new HashMap<>();
map.computeIfAbsent("key", k -> new ArrayList<>()).add(1);
```

Diamond + inference: `new ArrayList<>()` becomes `ArrayList<Integer>` from context.

## `Collections.emptyList()` vs `List.of()`

```java
List<String> empty1 = Collections.emptyList();  // generic, inferred
List<String> empty2 = List.of();                // Java 9+, inferred
```

Both return immutable empty lists with correct type.

## `Class<? extends T>` in APIs

```java
Optional<User> user = repository.findById(User.class, id);
List<User> users = entityManager.createQuery("...", User.class).getResultList();
```

`Class<T>` is a reified type token — links runtime class to compile-time `T`.

## Wildcard in `Set` operations

```java
boolean hasAll = set.containsAll(other);  // other is Collection<?>
```

`contains` takes `Object` — no wildcard needed. `containsAll` takes `Collection<?>` because it only reads.

## Immutable collections preserve generics

```java
List<String> immutable = List.copyOf(mutableList);
Map<String, Integer> map = Map.copyOf(mutableMap);
```

---

# Part 20 — Generic Factories

## The problem

You can't `new T()`. How do factories create instances?

## Pattern 1: `Class<T>` token

```java
public static <T> T create(Class<T> clazz) throws Exception {
    return clazz.getDeclaredConstructor().newInstance();
}

String s = create(String.class);
```

Requires public no-arg constructor. Works because `Class<T>` is reified.

## Pattern 2: `Supplier<T>`

```java
public static <T> T create(Supplier<T> supplier) {
    return supplier.get();
}

String s = create(() -> "hello");
User u = create(User::new);
```

Preferred in modern Java — no reflection, works with any constructor logic.

## Pattern 3: explicit factory interface

```java
interface Factory<T> {
    T create();
}

class UserFactory implements Factory<User> {
    public User create() { return new User(); }
}
```

## `Optional` factory

```java
Optional<String> opt = Optional.of("value");
Optional<String> empty = Optional.empty();
```

Generic factory methods on `Optional` itself.

## `Collections` generic factories

```java
List<String> list = Collections.emptyList();
Set<Integer> set = Collections.singleton(42);
Map<String, Integer> map = Collections.singletonMap("key", 1);
```

All infer types from arguments or explicit type arguments.

## `Stream` factories

```java
Stream<String> stream = Stream.of("a", "b");
Stream<String> empty = Stream.empty();
IntStream ints = IntStream.range(0, 10);
```

## Generic builder pattern

```java
class Builder<T> {
    private final Supplier<T> constructor;
    private final Consumer<T> initializer = t -> {};

    Builder(Supplier<T> constructor) { this.constructor = constructor; }

    T build() {
        T instance = constructor.get();
        initializer.accept(instance);
        return instance;
    }
}
```

Type parameter `T` flows through the builder to the product type.

---

# Part 21 — EnumSet and EnumMap

## Type-safe enum collections

`EnumSet<E extends Enum<E>>` and `EnumMap<K extends Enum<K>, V>` are among the most type-safe collections in Java because the key/type is constrained to a **finite, known enum type**.

## `EnumSet`

```java
enum Day { MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY }

EnumSet<Day> weekends = EnumSet.of(Day.SATURDAY, Day.SUNDAY);
EnumSet<Day> weekdays = EnumSet.complementOf(weekends);
EnumSet<Day> all = EnumSet.allOf(Day.class);
```

Implementation: bit vector over enum ordinals — `add`/`remove`/`contains` are O(1), extremely compact and fast.

```java
// Internal concept — not actual source
// long bits — one bit per enum constant
```

No duplicate possible — enum constants are unique. Iteration order is natural enum declaration order.

## `EnumMap`

```java
EnumMap<Day, String> schedule = new EnumMap<>(Day.class);
schedule.put(Day.MONDAY, "Gym");
schedule.put(Day.FRIDAY, "Review");
```

Array-backed by enum ordinal — O(1) get/put, cache-friendly, no hashing. Keys are the enum universe — no `null` keys (enum constants only).

## Why not `HashMap<Day, String>`?

`EnumMap` is faster, more memory-efficient, and iteration order is deterministic (ordinal order). Always prefer `EnumMap` for enum keys.

## Generic bounds

```java
public class EnumMap<K extends Enum<K>, V> { ... }
public abstract class EnumSet<E extends Enum<E>> { ... }
```

Recursive generic bound ensures `K`/`E` is an enum type. You cannot create `EnumMap<Object, String>` — compile error.

## `EnumSet` noneOf / allOf require `Class<E>`

```java
EnumSet<Day> empty = EnumSet.noneOf(Day.class);
```

The `Class<E>` token provides the enum type at runtime (reified) — needed because you might want an empty set before any element exists.

---

# Part 22 — Reflection Limitations with Generics

## `getClass()` doesn't carry type parameters

```java
List<String> strings = new ArrayList<>();
Class<?> clazz = strings.getClass();  // ArrayList.class — no String
```

## Type tokens: `Class<T>` is reified

```java
Class<String> stringClass = String.class;
Class<List> rawListClass = List.class;  // raw — no parameter
```

There is no `Class<List<String>>` — you cannot write `List<String>.class`.

## `getGenericSuperclass()` and `ParameterizedType`

For subclasses that **specify** type arguments:

```java
class StringList extends ArrayList<String> { }
```

```java
Type type = StringList.class.getGenericSuperclass();
if (type instanceof ParameterizedType pt) {
    Type arg = pt.getActualTypeArguments()[0];  // String
}
```

This works because subclass bytecode stores generic signature metadata.

## Erasure strikes again

```java
List<String> list = new ArrayList<>();
Type gt = list.getClass().getGenericSuperclass();  // doesn't give you String
```

For a plain `ArrayList<String>`, you don't get `String` from the instance — the instance doesn't know.

## `TypeToken` pattern (Guava)

Libraries use anonymous subclasses to capture type:

```java
// Guava style
TypeToken<List<String>> token = new TypeToken<List<String>>() {};
Type type = token.getType();  // captures via subclass generic signature
```

The anonymous `TypeToken<List<String>>` subclass carries `List<String>` in its `extends` clause — preserved in bytecode.

## Spring, Jackson, Gson

Frameworks use similar tricks (super type tokens, `@JsonTypeInfo`, `TypeReference`) to retain generic type information for deserialization:

```java
// Jackson
List<User> users = mapper.readValue(json, new TypeReference<List<User>>() {});
```

Without this, `readValue` would return `List` of raw `Map` or `LinkedHashMap`.

## `instanceof` with parameterized types — Java 16+

```java
if (obj instanceof List<?> list) {  // pattern matching — unbounded wildcard ok
    for (Object o : list) { ... }
}
```

Still cannot distinguish `List<String>` from `List<Integer>` at runtime.

## Interview summary

Reflection can recover generic type arguments **only** from symbolic references in bytecode (superclass, method signatures of declared methods, anonymous subclass trick). Never from erased instances alone.

---

# Part 23 — Production Pitfalls

## Heap pollution

**Definition:** When a variable of a parameterized type refers to an object not of that type, because unchecked operations inserted incompatible elements.

```java
List<String> strings = new ArrayList<>();
List raw = strings;
raw.add(42);  // unchecked — pollutes heap
String s = strings.get(0);  // ClassCastException here, not at add
```

**Prevention:**
- Never use raw types in application code.
- Avoid unchecked casts without justification.
- Use `@SuppressWarnings("unchecked")` only with documented safety proof.

## ClassCastException far from source

The compiler inserts casts on generic `get()`:

```java
String s = list.get(0);  // runtime: (String) list.get(0)
```

If pollution occurred 50 frames earlier, the stack trace points at `get()`, not at the bad `add()`. Production debugging requires searching for raw types, unchecked casts, or serialization/deserialization mismatches.

## Mutable raw types in legacy interop

```java
// Library returns raw List from pre-generics API
List rawFromLib = legacyApi.getItems();
List<String> items = rawFromLib;  // unchecked warning — latent bug
```

Fix at the boundary: wrap, copy with validation, or migrate the library.

## Serialization generic mismatch

Deserializing old data with changed generic signatures can produce wrong types in collections. Prefer explicit DTO classes over generic containers in serialized formats.

## `toArray()` vs `toArray(T[])`

```java
Object[] arr = list.toArray();           // Object[] — not String[]
String[] arr2 = list.toArray(new String[0]);  // correctly typed
```

Returning `Object[]` from a `List<String>` and casting to `String[]` throws `ArrayStoreException`.

## Over-aggressive wildcards in public APIs

```java
// Too loose — callers can't use returned values meaningfully
public List<?> getItems() { ... }

// Better
public List<String> getItems() { ... }
```

Wildcards are for **parameters** (PECS), not returns, unless you genuinely mean "unknown element type."

## `Arrays.asList` and primitives

```java
List<int> list = Arrays.asList(1, 2, 3);  // compile error
List<Integer> list = Arrays.asList(1, 2, 3);  // boxed
int[] arr = {1, 2, 3};
List<int[]> list2 = Arrays.asList(arr);  // List of int arrays, not ints!
```

## Generic constructor capture in loops

```java
List<String> list = new ArrayList<>();
for (String s : list) { }  // fine
List<? extends String> wild = list;
for (String s : wild) { }  // fine — String is bound
```

## Performance: generics have zero runtime cost

Erasure means no runtime overhead for type parameters. Boxing of primitives in `List<Integer>` is the cost — use `IntStream`, `int[]`, or specialized collections for hot numeric paths.

## Checklist for code review

1. Any raw type usage?
2. Any unchecked cast without `@SuppressWarnings` and comment?
3. Public API returns wildcard unnecessarily?
4. Generic array creation?
5. Legacy `List` without type parameter in method signature?
6. `ClassCastException` handler — trace backward for pollution?

---

# Part 24 — Interview Mental Models

## Model 1: Compiler fiction

Generics are a compile-time lens. The runtime sees `Object` and raw types. Every advanced question is a consequence of erasure.

## Model 2: Invariance is intentional

`List<String>` is not a `List<Object>`. Wildcards add flexibility without breaking type safety. PECS tells you which wildcard.

## Model 3: Producer vs consumer

Pull data out → `extends`. Push data in → `super`. Both → plain `T`. Memorize through `Collections.copy`.

## Model 4: Reified vs non-reifiable

Arrays and `Class<T>` know their type at runtime. `List<String>` does not. Generic arrays are illegal because arrays need reification.

## Model 5: Bridge methods preserve polymorphism

Erasure would break overriding without synthetic bridge methods. `Comparable`, enum `compareTo`, generic class inheritance all rely on this.

## Model 6: Type tokens for runtime type

When you need runtime type of `T`, pass `Class<T>`, `TypeReference`, or `TypeToken` — never expect it from `T` alone.

## Model 7: Heap pollution is the runtime failure mode

Compile-time generics fail at runtime only when unchecked code violated the type system. The exception is `ClassCastException` on implicit cast from `get()`.

## Model 8: F-bounds for Comparable

`Comparable<? super T>` is more flexible than `Comparable<T>` — allows `Integer` sorting in generic algorithms.

## Quick decision tree

```
Need type parameter on class/interface? → declare <T>
Need local method type parameter? → <T> on method
Only reading from parameter? → ? extends T
Only writing to parameter? → ? super T
Reading and writing? → plain T
Need new T() or T[]? → Supplier<T> or Class<T> or List<T>
Need runtime type of T? → Class<T> or TypeToken pattern
Legacy code without types? → raw type (migrate, don't spread)
```

## What senior interviews probe

1. Erasure consequences (3+ examples).
2. PECS with a novel example (not just copy).
3. Why `List<String>` isn't `List<Object>`.
4. Bridge methods — what and why.
5. Heap pollution scenario and fix.
6. `Comparable<T>` recursive bound explanation.
7. Wildcard capture — why helper method needed.
8. Reflection — how to get `List<String>` type at runtime.
9. Generic array prohibition — connect to reification.
10. Design a generic API method signature for a given use case.

---

# Part 25 — Practice Questions & Answers

### Level 1 — Conceptual

<details class="qa-item">
<summary>1. Why were Java generics implemented with erasure instead of reification? What compatibility problem would reification have caused?</summary>

Java 5 had to run on existing JVMs and interoperate with billions of lines of pre-generics bytecode. **Reification** (keeping `List<String>` distinct from `List<Integer>` at runtime) would have changed class file layouts, broken binary compatibility with non-generic libraries, and required JVM changes that would split the ecosystem. **Erasure** compiles generics to the same bytecode as raw types (with casts and bridge methods), so old `.class` files still load and link. The tradeoff is no runtime type parameter information on instances and the entire advanced generics complexity surface.

</details>

<details class="qa-item">
<summary>2. Explain why `List&lt;String&gt;` is not a subtype of `List&lt;Object&gt;`. What would break if it were?</summary>

Generics are **invariant**. If `List<String>` were a `List<Object>`, this would compile:

```java
List<Object> objs = new ArrayList<String>();
objs.add(42);  // Integer into what is actually a List<String>
String s = ((ArrayList<String>) objs).get(1);  // ClassCastException
```

The widened reference would allow writes that violate the actual list's element type. Invariance prevents inserting wrong types through a widened reference. Covariance is available safely via `? extends` for read-only use.

</details>

<details class="qa-item">
<summary>3. What is heap pollution? Write a 4-line example where the exception line is far from the pollution line.</summary>

Heap pollution: a parameterized variable refers to an object containing elements of the wrong type due to unchecked operations.

```java
List<String> strings = new ArrayList<>();
List raw = strings;       // line 1 — boundary
raw.add(42);              // line 2 — pollution (unchecked)
// ... hundreds of lines ...
String s = strings.get(0); // line N — ClassCastException
```

The bug is at `add(42)` through the raw reference. The crash is at `get(0)` when the compiler-inserted `(String)` cast fails.

</details>

<details class="qa-item">
<summary>4. What are bridge methods? Why does `Comparable&lt;Apple&gt;` need one?</summary>

Bridge methods are **synthetic methods** the compiler generates when a generic class/interface method's erasure doesn't match the subclass's overriding method signature.

`Apple implements Comparable<Apple>` has `int compareTo(Apple)`. Erasure of `Comparable<Apple>` requires `int compareTo(Object)`. The compiler generates:

```java
public int compareTo(Object o) { return compareTo((Apple) o); }  // bridge
public int compareTo(Apple other) { ... }  // real override
```

Without the bridge, polymorphic calls through `Comparable` (erased to `compareTo(Object)`) wouldn't dispatch to `Apple.compareTo(Apple)`.

</details>

<details class="qa-item">
<summary>5. State the PECS rule and apply it to design the signature of a method that merges two lists into a destination list.</summary>

**PECS:** Producer Extends, Consumer Super.

- Source lists **produce** elements → `? extends T`
- Destination **consumes** elements → `? super T`

```java
static <T> void merge(List<? super T> dest,
                      List<? extends T> src1,
                      List<? extends T> src2) {
    dest.addAll(src1);
    dest.addAll(src2);
}
```

`T` is inferred from the most specific common type (e.g., `Integer` when merging `List<Integer>` into `List<Number>`).

</details>

### Level 2 — Code Analysis

<details class="qa-item">
<summary>6. What does this print? Explain.</summary>

```java
List<? extends Number> nums = new ArrayList<Integer>();
nums.add(42);
```

**Compile error** on `nums.add(42)`. `? extends Number` makes `nums` a **producer** — you cannot add `Integer` because the compiler doesn't know if the list is `ArrayList<Integer>`, `ArrayList<Double>`, etc. Only `null` can be added to `? extends` lists.

</details>

<details class="qa-item">
<summary>7. What does this print? Explain.</summary>

```java
List<? super Integer> list = new ArrayList<Number>();
list.add(42);
Integer i = list.get(0);
```

`add(42)` **compiles** — `? super Integer` is a consumer. `Integer i = list.get(0)` **compile error** — you can only read as `Object`, not `Integer`, because the list might be `ArrayList<Object>` holding non-Integers. Fix: `Object o = list.get(0);` or use a typed reference `List<Integer> ints = new ArrayList<>()` if you need both read and write as `Integer`.

</details>

<details class="qa-item">
<summary>8. Will this compile? If it runs, what happens?</summary>

```java
List<String>[] array = new List<String>[10];
```

**Compile error.** Cannot create generic array `List<String>[]`. Arrays are reified; `List<String>` and `List<Integer>` erase to the same array type — runtime store check would be meaningless. Use `List<List<String>>` or `ArrayList[]` with unchecked warnings (legacy only).

</details>

<details class="qa-item">
<summary>9. What is the output?</summary>

```java
List<String> a = new ArrayList<>();
List<String> b = new ArrayList<>();
System.out.println(a.getClass() == b.getClass());
System.out.println(a.getClass() == ArrayList.class);
```

```
true
true
```

All `ArrayList<String>`, `ArrayList<Integer>`, raw `ArrayList` share the same runtime class: `ArrayList.class`. Type parameters are erased.

</details>

<details class="qa-item">
<summary>10. Explain the compile error and fix.</summary>

```java
void swap(List<?> list, int i, int j) {
    list.set(i, list.get(j));
}
```

Compile error: cannot set `list` with `list.get(j)` because `?` is unknown — compiler can't verify get and set use the same type. **Fix:** capture helper:

```java
void swap(List<?> list, int i, int j) {
    swapHelper(list, i, j);
}
private static <T> void swapHelper(List<T> list, int i, int j) {
    T tmp = list.get(i);
    list.set(i, list.get(j));
    list.set(j, tmp);
}
```

</details>

<details class="qa-item">
<summary>11. What happens at runtime?</summary>

```java
List raw = new ArrayList();
List<Integer> ints = raw;
ints.add(42);
String s = (String) ints.get(0);
```

`add(42)` succeeds (unchecked). `(String) ints.get(0)` throws **ClassCastException** — `Integer` cannot be cast to `String`. Demonstrates heap pollution via raw type assignment to parameterized variable.

</details>

<details class="qa-item">
<summary>12. Which overload is called? Does it compile?</summary>

```java
void print(List<String> list) { System.out.println("strings"); }
void print(List<Integer> list) { System.out.println("ints"); }
print(new ArrayList<>());
```

**Compile error** — both overloads have the same erasure `print(List)`. Java cannot define both. At call site, `new ArrayList<>()` has no type argument — inference fails to distinguish overloads. Must use single method with `List<?>` or explicit type: `print(new ArrayList<String>())`.

</details>

### Level 3 — Design & API

<details class="qa-item">
<summary>13. Design a generic method `firstDuplicate` that returns the first duplicate element in a list, or null if none. Choose the best signature.</summary>

```java
static <T> T firstDuplicate(List<T> list) {
    Set<T> seen = new HashSet<>();
    for (T item : list) {
        if (seen.contains(item)) return item;
        seen.add(item);
    }
    return null;
}
```

Uses plain `T` — need to read and write `T` to the `Set`. `equals`/`hashCode` on `T` required. Return type `T` not `? extends T` because we return the actual element.

</details>

<details class="qa-item">
<summary>14. Why is `Comparator&lt;? super T&gt;` used in `List.sort` instead of `Comparator&lt;T&gt;`?</summary>

Allows comparing `Integer` elements with a `Comparator<Number>` or `Comparator<Object>` — the list **produces** `T` for comparison; the comparator **consumes** values to compare. PECS: comparator is a consumer of `T`. Example:

```java
List<Integer> ints = List.of(3, 1, 2);
ints.sort(Comparator.naturalOrder());  // Comparator<Integer>
List<Integer> ints2 = new ArrayList<>(ints);
ints2.sort((Comparator<Number>) Comparator.naturalOrder());  // also valid
```

</details>

<details class="qa-item">
<summary>15. Explain `Comparable&lt;T&gt;` vs `Comparable&lt;? super T&gt;` in `Collections.max` signature.</summary>

```java
public static <T extends Object & Comparable<? super T>> T max(Collection<? extends T> coll)
```

- `Collection<? extends T>` — producer of `T` elements.
- `Comparable<? super T>` — `T` must be comparable to itself **or** to some supertype. Example: `Integer` implements `Comparable<Integer>`. For `T=Integer`, `Comparable<? super Integer>` accepts `Comparable<Integer>`, `Comparable<Number>`, `Comparable<Object>`.

Without `? super T`, some legal types would be rejected. This is F-bounded polymorphism.

</details>

<details class="qa-item">
<summary>16. How would you implement a type-safe generic `fromJson(String json, Class&lt;T&gt; clazz)` without raw types?</summary>

```java
static <T> T fromJson(String json, Class<T> clazz) {
    // Jackson example
    ObjectMapper mapper = new ObjectMapper();
    return mapper.readValue(json, clazz);
}
```

`Class<T>` is reified — links runtime `Class` object to compile-time `T`. For generic types like `List<User>`, use `TypeReference`:

```java
List<User> users = mapper.readValue(json, new TypeReference<List<User>>() {});
```

Anonymous subclass captures generic signature in bytecode.

</details>

<details class="qa-item">
<summary>17. Why does `EnumSet&lt;Day&gt;` not use a hash table internally?</summary>

Enums have a fixed, known universe of constants with stable `ordinal()` values (0..n-1). `EnumSet` uses a bit vector — one bit per enum constant. `add(Day.SATURDAY)` sets bit 5; `contains` checks bit; `addAll` is bitwise OR. O(1) operations, minimal memory (long stores 64 constants). Hashing would be slower and unnecessary — the key space is fixed at compile time.

</details>

### Level 4 — Production & Debugging

<details class="qa-item">
<summary>18. A service throws `ClassCastException` in `ArrayList.get` inside a cache class. The stack trace shows no cast in source. How do you find the root cause?</summary>

The compiler inserted `(ExpectedType)` cast at generic `get()`. Root causes:
1. Raw type `List` assignment to `List<ExpectedType>` somewhere.
2. Unchecked cast when building the list.
3. Deserialization producing wrong element types.
4. Reflection adding wrong types.

Search codebase for: raw `List`, `@SuppressWarnings("unchecked")`, `List` without type params in field declarations, legacy API returns. Add logging at list construction boundaries. Reproduce with strict `-Xlint:unchecked`.

</details>

<details class="qa-item">
<summary>19. When is `@SuppressWarnings("unchecked")` justified? Give one good and one bad example.</summary>

**Good:** Internal array in generic class — proven no external writes:

```java
@SuppressWarnings("unchecked")
private T[] elements = (T[]) new Object[capacity];
// Only this class writes elements, always T
```

**Bad:** Class-level suppression hiding all unchecked issues:

```java
@SuppressWarnings("unchecked")  // BAD — blanket
public class Service {
    List items = legacy.getList();  // hidden pollution
}
```

Justify with comment explaining why safe; scope to narrowest block.

</details>

<details class="qa-item">
<summary>20. A team uses `List&lt;?&gt;` as return type everywhere "for flexibility." What's wrong with this?</summary>

`List<?>` is an **immutable producer** from caller's view — callers cannot add (except null) and can only consume as `Object`. Every caller must cast or pattern-match to use elements. "Flexibility" for the API author becomes burden for every consumer. Return concrete type `List<String>` or bounded wildcard only when truly unknown. Wildcards belong primarily in **parameters** (PECS), not returns.

</details>

### Level 5 — Senior Interview Scenarios

<details class="qa-item">
<summary>21. "Walk me through what happens when `TreeSet&lt;Apple&gt;` calls `compareTo` on an element during `add`."</summary>

1. `TreeSet.add(apple)` navigates the red-black tree using `compareTo`.
2. `TreeSet` holds `Comparator<? super Apple>` or natural ordering — `Apple` implements `Comparable<Apple>`.
3. Polymorphic call may go through `Comparable.compareTo(Object)` — **bridge method** on `Apple`.
4. Bridge casts `Object` to `Apple` and calls `Apple.compareTo(Apple)`.
5. Comparison result determines tree position.
6. No generic type check at runtime — if a non-Apple snuck in via raw type, `ClassCastException` in bridge cast.

</details>

<details class="qa-item">
<summary>22. Implement a generic method `copyIf` that copies elements matching a predicate from source to destination. Full signature with wildcards.</summary>

```java
static <T> void copyIf(List<? super T> dest,
                       List<? extends T> src,
                       Predicate<? super T> predicate) {
    for (T item : src) {
        if (predicate.test(item)) {
            dest.add(item);
        }
    }
}
```

- `src` — producer → `? extends T`
- `dest` — consumer → `? super T`
- `predicate` — consumes `T` for test → `? super T`

</details>

<details class="qa-item">
<summary>23. Why can't you write `class Box&lt;T extends Exception&gt; { void fail() throws T { throw new T(); } }`?</summary>

`throws T` is legal when `T extends Exception` — declares that callers must handle `T`. But `throw new T()` fails because:
1. Cannot instantiate type variable (`new T()` illegal).
2. Erasure — runtime doesn't know what `T` is to create exception.
3. Even `throw (T) new ApiException()` requires knowing a concrete type.

Declare `throws T` for propagation in generic wrappers; throw concrete exceptions inside body.

</details>

<details class="qa-item">
<summary>24. What is the difference between `List&lt;?&gt;` and `List&lt;Object&gt;`?</summary>

| | `List<?>` | `List<Object>` |
|---|---|---|
| Add | only `null` | any `Object` |
| Get | `Object` | `Object` |
| Assignment from `List&lt;String&gt;` | yes | no |

`List<?>` — unknown element type, read-only sink for adds.
`List<Object>` — known to hold any Object, full write access.
`List<String>` is assignable to `List<?>` but not `List<Object>` (invariance).

</details>

<details class="qa-item">
<summary>25. Write the mental model you'd explain to a junior in 60 seconds about when to use `T` vs `? extends T` vs `? super T`.</summary>

**`T`** — I know the exact type and need to read and write it. Use in class definitions and when both operations happen.

**`? extends T`** — I'm only **pulling** items out (producer). Like reading from a source list. Can't add real elements.

**`? super T`** — I'm only **pushing** items in (consumer). Like writing to a destination. Can't read back as `T`.

**PECS:** Producer Extends, Consumer Super. `Collections.copy(dest, src)` — dest is super, src is extends. When both read and write, skip wildcards — use `T`.

</details>

<details class="qa-item">
<summary>26. Analyze: why does this compile in Java but seem contradictory?</summary>

```java
List<Number> nums1 = new ArrayList<Integer>();           // compile error
List<? extends Number> nums2 = new ArrayList<Integer>(); // compiles
Number n = nums2.get(0);                                 // compiles
```

The apparent contradiction: `Integer` extends `Number`, yet you cannot assign `ArrayList<Integer>` to `List<Number>`.

**Invariance:** `List<Integer>` is not a subtype of `List<Number>`. If it were, you could `nums1.add(3.14)` into what is actually a list of integers.

**Covariance via wildcard:** `List<? extends Number>` means "a list of some *specific* subtype of Number" — here `Integer`. You can read as `Number` but cannot add (except `null`) because the compiler doesn't know the exact subtype.

`nums2.get(0)` returns `Number` (the capture of the `extends` bound). `Integer` widens to `Number` — legal assignment.

</details>

<details class="qa-item">
<summary>27. How do you obtain the type `List&lt;String&gt;` at runtime for deserialization without passing `Class&lt;List&lt;String&gt;&gt;`?</summary>

`Class<List<String>>` doesn't exist — cannot write `List<String>.class`.

Options:
1. **Anonymous `TypeReference`** (Jackson): `new TypeReference<List<String>>() {}` — subclass carries generic supertype in bytecode.
2. **Guava `TypeToken`**: `new TypeToken<List<String>>() {}`.
3. **`ParameterizedType` from method generic signature** — if your method is `void handle(List<String> items)`, reflect on method parameter `getGenericParameterTypes()`.
4. **Pass `java.lang.reflect.Type`** explicitly from caller who captured it via above tricks.

Never from instance: `list.getClass()` gives only `ArrayList.class`.

</details>

---

## Appendix — Quick Reference Card

```
Erasure:        T → Object (or upper bound)
Invariance:     List<String> ≠ List<Object>
Covariance:     List<? extends Number> ← List<Integer>
Contravariance: List<? super Integer> ← List<Number>

PECS:           Producer ? extends T | Consumer ? super T

Illegal:        new T(), new T[], List<String>[], catch(T), throw new T()
Legal:          Class<T>, Supplier<T>, List<T>, bridge methods

Runtime type:   Class<T> token, TypeReference, TypeToken
Failure mode:   Heap pollution → ClassCastException on get()
```

---

*End of Senior-Level Java Generics Mastery Course — Java 21 LTS Baseline*
