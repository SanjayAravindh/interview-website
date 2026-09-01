# Java Reflection, Proxies & Annotations — Senior Production Reference

Java 17 / 21 baseline, with the Java 8 → 17 migration pain called out where it still bites. This is not an API tour. It is the map of how frameworks actually work under the covers, and what breaks in production when you upgrade a JDK, add a proxy, or ship a native image.

---

## Table of Contents

1. [Mental Model: Reflection Behind Every Framework](#1-mental-model-reflection-behind-every-framework)
2. [Class Objects and Metadata](#2-class-objects-and-metadata)
3. [Instantiating and Invoking](#3-instantiating-and-invoking)
4. [Field Access and setAccessible](#4-field-access-and-setaccessible)
5. [The Java Module System and Strong Encapsulation](#5-the-java-module-system-and-strong-encapsulation)
6. [Which of my dependencies still touch internals? Run at build time, fail the build.](#1-which-of-my-dependencies-still-touch-internals-run-at-build-time-fail-the-build)
7. [Stack trace on every module access check failure (huge time-saver)](#2-stack-trace-on-every-module-access-check-failure-huge-time-saver)
8. [On 11/15, before you upgrade: turn the warning into an error and find them all](#3-on-1115-before-you-upgrade-turn-the-warning-into-an-error-and-find-them-all)
9. [Generics and Reflection](#6-generics-and-reflection)
10. [Annotations](#7-annotations)
11. [Annotation Processing at Compile Time](#8-annotation-processing-at-compile-time)
12. [JDK Dynamic Proxies](#9-jdk-dynamic-proxies)
13. [Bytecode Generation Proxies (CGLIB, ByteBuddy)](#10-bytecode-generation-proxies-cglib-bytebuddy)
14. [How Spring Uses Proxies (self-invocation trap, 3 fixes)](#11-how-spring-uses-proxies-self-invocation-trap-3-fixes)
15. [MethodHandles and VarHandle](#12-methodhandles-and-varhandle)
16. [Records and Sealed Types + reflection](#13-records-and-sealed-types-reflection)
17. [Classloaders hierarchy and debugging](#14-classloaders-hierarchy-and-debugging)
18. [ClassLoader leaks (Tomcat redeploy Metaspace)](#15-classloader-leaks-tomcat-redeploy-metaspace)
19. [Reflection performance](#16-reflection-performance)
20. [GraalVM native image / reflect-config](#17-graalvm-native-image-reflect-config)
21. [Security implications](#18-security-implications)
22. [Testing and debugging reflective code](#19-testing-and-debugging-reflective-code)
23. [When NOT to use reflection](#20-when-not-to-use-reflection)
24. [Production Debugging Playbook](#21-production-debugging-playbook)
25. [Quick Decision Matrix](#22-quick-decision-matrix)

---


## 1. Mental Model: Reflection Behind Every Framework

Reflection is the JVM's answer to one question: **"what do you know about this class at runtime, and what may I do with it?"** Every framework you use is a program that reads that metadata and writes behaviour on top of it. There is no magic layer. There is a `Class<?>`, a `Method`, an `Annotation`, and a proxy.

```
Your code                      Framework                        JVM mechanism
─────────────────────────────────────────────────────────────────────────────────────
@Component class OrderSvc      component scan reads             ClassLoader.getResources
                               class files as bytes,            + ASM class reader (no load)
                               filters on annotations

@Autowired OrderRepo repo      populate the bean                Field.set / Constructor.newInstance
                                                                + generic type resolution

@Transactional void pay()      wrap the bean in a proxy         Proxy.newProxyInstance
                                                                or CGLIB subclass

@Entity class Order            map columns, lazy-load           Field access + bytecode enhancement
                                                                + subclass proxies for @ManyToOne

@JsonProperty String name      bind JSON to fields              Field/Method access, generic type
                                                                from ParameterizedType

@Test void shouldPay()         discover + run                   getDeclaredMethods + Method.invoke

mock(OrderRepo.class)          fake implementation              ByteBuddy subclass/interface impl
                                                                + Objenesis instantiation

ServiceLoader.load(Driver)     plugin discovery                 META-INF/services + TCCL
```

Four capabilities cover 95% of what frameworks do:

| Capability | API | Who uses it |
|---|---|---|
| Discover types | `Class`, classpath scanning, `ClassLoader.getResources` | Spring scan, JPA entity scan, JUnit discovery |
| Read metadata | annotations, generic types, record components | Jackson, Bean Validation, Spring config |
| Create and call | `Constructor.newInstance`, `Method.invoke`, `Field.set` | DI containers, ORMs, serializers |
| Synthesize behaviour | JDK proxies, CGLIB/ByteBuddy, `LambdaMetafactory` | AOP, transactions, mocks, lazy loading |

Once you internalize this, most "why doesn't Spring pick this up?" questions collapse into one of five concrete failures:

1. The class was never **discovered** (wrong package, not a bean, scanned by ASM but filtered out).
2. The annotation was not **visible at runtime** (`RetentionPolicy.CLASS` instead of `RUNTIME`).
3. The member was not **accessible** (module encapsulation, `private` without `setAccessible`, `final` method).
4. The call did not go **through the proxy** (self-invocation, `new`, field injection of the target type).
5. The metadata was **erased** (raw generic type, missing `-parameters`, no config for native image).

A senior engineer debugging "framework magic" is really asking: *which of those five is it?* Every section below is a deeper answer to one of them.

**The cost side.** Reflection buys you decoupling and pays with: no compile-time checking, worse IDE refactoring, slower startup, opaque stack traces, module/native-image friction, and encapsulation holes. Frameworks accept that trade because they cannot know your types. Your application code almost always can.

---

## 2. Class Objects and Metadata

### Core concept

Every loaded type has exactly one `Class` object **per classloader**. `Class` is the entry point to all metadata: name, modifiers, superclass, interfaces, fields, methods, constructors, annotations, generic signature, nest members, permitted subclasses, record components.

Identity matters: `a.getClass() == b.getClass()` is true only if both were loaded by the same classloader. Two copies of the same `.class` file from two loaders are **different types** — the source of "`OrderDto` cannot be cast to `OrderDto`."

### Three ways to get a Class, and they are not the same

```java
// 1. Class literal — compile-time, no initialization, checked by javac
Class<String> a = String.class;

// 2. Instance query — runtime type, erased generics
Object o = "hello";
Class<?> b = o.getClass();          // class java.lang.String
List<String> list = new ArrayList<>();
Class<?> c = list.getClass();       // class java.util.ArrayList — <String> is gone

// 3. Name lookup — runtime string, THROWS, and INITIALIZES
Class<?> d = Class.forName("com.acme.OrderService");
```

| | `X.class` | `x.getClass()` | `Class.forName("X")` |
|---|---|---|---|
| Resolved | Compile time | Runtime, dynamic type | Runtime, by string |
| Typed | `Class<X>` | `Class<? extends \|X\|>` | `Class<?>` |
| Fails how | Compile error | Never (NPE if `x` null) | `ClassNotFoundException` (checked) |
| Runs static init | No | Already ran | **Yes** by default |
| Classloader used | Defining loader of caller | — | **Caller's** loader |

The static-initializer difference is a real production behaviour, not trivia:

```java
// Loads, links, and RUNS static { } — a driver registers itself, a cache warms,
// a static block throws ExceptionInInitializerError
Class.forName("org.postgresql.Driver");

// Loads and links but does NOT initialize — use when you only want metadata
Class<?> c = Class.forName("org.postgresql.Driver", false, loader);
```

`Class.forName(String)` uses the **caller's** classloader. Inside a framework jar loaded by the container's common loader, that is the wrong loader for application classes. Frameworks therefore use `Class.forName(name, false, Thread.currentThread().getContextClassLoader())` or an explicit loader — see [Classloaders](#14-classloaders).

### Naming rules that trip people up

```java
String.class.getName()            // "java.lang.String"
String.class.getSimpleName()      // "String"
String.class.getCanonicalName()   // "java.lang.String"

int.class.getName()               // "int"
int[].class.getName()             // "[I"
String[].class.getName()          // "[Ljava.lang.String;"
String[][].class.getName()        // "[[Ljava.lang.String;"

Map.Entry.class.getName()         // "java.util.Map$Entry"     <-- $ , use for forName
Map.Entry.class.getCanonicalName()// "java.util.Map.Entry"     <-- dots, NOT usable in forName

// anonymous / lambda
Runnable r = () -> {};
r.getClass().getName();           // "com.acme.Demo$$Lambda$14/0x0000..." (unstable, never persist)
```

`Class.forName("java.util.Map.Entry")` throws `ClassNotFoundException`. You need the binary name with `$`. This is the most common cause of config-driven `ClassNotFoundException` for nested types.

### Fields and methods: declared vs public

```java
class Base { public int pub; private int priv; public void pubM() {} private void privM() {} }
class Child extends Base { protected int prot; }
```

| Call | Returns |
|---|---|
| `Child.class.getFields()` | `pub` (public, **inherited included**) |
| `Child.class.getDeclaredFields()` | `prot` only (**declared here**, any modifier, no inheritance) |
| `Child.class.getMethods()` | all public methods incl. inherited and interface `default`, plus `Object`'s public methods |
| `Child.class.getDeclaredMethods()` | methods declared in `Child` only, any modifier, **plus synthetic and bridge methods** |

To get "every field including private and inherited," you must walk the hierarchy yourself:

```java
public static List<Field> allFields(Class<?> type) {
    List<Field> out = new ArrayList<>();
    for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
        for (Field f : c.getDeclaredFields()) {
            if (f.isSynthetic()) continue;              // this$0, jacoco counters, switch maps
            if (Modifier.isStatic(f.getModifiers())) continue;
            out.add(f);
        }
    }
    return out;
}
```

Spring ships this as `ReflectionUtils.doWithFields` / `doWithLocalFields`; use it rather than hand-rolling. It already excludes synthetic members and handles the `Object` stop condition.

### Synthetic and bridge methods

The compiler generates members you never wrote. If you iterate `getDeclaredMethods()` and act on everything, you will act on these too.

```java
interface Repo<T> { T findById(Long id); }

class OrderRepo implements Repo<Order> {
    @Override public Order findById(Long id) { ... }
}
```

`OrderRepo.class.getDeclaredMethods()` returns **two** `findById` methods:

- `Order findById(Long)` — yours
- `Object findById(Long)` — a **bridge method**, `isBridge() == true`, `isSynthetic() == true`, which casts and delegates to yours

A framework that maps "method name → handler" without filtering bridges gets duplicate registrations or picks the erased one and loses the real return type. Always:

```java
for (Method m : type.getDeclaredMethods()) {
    if (m.isBridge() || m.isSynthetic()) continue;
    ...
}
// or, when you have a possibly-bridged method in hand:
Method real = BridgeMethodResolver.findBridgedMethod(m);   // Spring core
```

Other synthetics you will meet: `this$0` on inner classes, `access$000` accessors (pre-nestmates), `$VALUES` on enums, `values()`/`valueOf()` on enums (not synthetic but compiler-generated), lambda bodies `lambda$process$0`, Jacoco's `$jacocoData` field.

### Arrays and primitives

```java
int.class                      // primitive type token; == Integer.TYPE
Integer.class                  // the wrapper class; != int.class
int.class.isPrimitive()        // true
int[].class.getComponentType() // int.class
int[][].class.getComponentType()// int[].class

Object arr = Array.newInstance(String.class, 5);  // -> String[5]
Array.set(arr, 0, "a");
String s = (String) Array.get(arr, 0);
int len   = Array.getLength(arr);

// Building a typed array reflectively (what Collection.toArray(T[]) needs)
@SuppressWarnings("unchecked")
static <T> T[] newArray(Class<T> component, int size) {
    return (T[]) Array.newInstance(component, size);
}
```

`void.class` exists (`Void.TYPE`) and is what `Method.getReturnType()` returns for `void` methods. Checking `m.getReturnType() == Void.class` instead of `void.class` is a real bug in framework code — `Void.class` is the boxed placeholder, only produced by `Void`-typed generics.

### isAssignableFrom vs instanceof vs isInstance

```java
Number.class.isAssignableFrom(Integer.class);   // true  — "can a Number ref hold an Integer?"
Integer.class.isAssignableFrom(Number.class);   // false
Number.class.isInstance(42);                    // true  — reflective instanceof
42 instanceof Number;                           // true  — compile-time known type
```

Read `A.isAssignableFrom(B)` as **"is B a subtype of A"** — the direction reads backwards and is inverted in code reviews constantly. Mnemonic: it mirrors the assignment `A a = (B) b;`.

`isAssignableFrom` on primitives does **no** widening or boxing: `long.class.isAssignableFrom(int.class)` is `false`, and `Integer.class.isAssignableFrom(int.class)` is `false`. Any framework doing type-compatibility checks must handle boxing itself; Spring exposes `ClassUtils.isAssignable(lhs, rhs)` which does.

### Production scenario: a plugin registry that silently registered nothing

**Problem.** A payments platform loads risk-rule plugins from a config list of class names. After a refactor that moved rules into nested static classes, the risk engine started passing every transaction. No exception, no log. The registry map was empty.

**Cause.** Two compounding bugs.

```java
// config: com.acme.risk.Rules.VelocityRule   <-- canonical name written by a human
for (String name : props.getRuleClasses()) {
    try {
        Class<?> c = Class.forName(name);
        if (Rule.class.isAssignableFrom(c)) {
            rules.add((Rule) c.getDeclaredConstructor().newInstance());
        }
    } catch (Exception e) {
        log.debug("skipping {}", name);       // <-- swallowed at DEBUG
    }
}
```

`Class.forName` needs `com.acme.risk.Rules$VelocityRule`; the canonical name threw `ClassNotFoundException`, and the catch block logged at DEBUG, which was off in production. A pipeline that "skips" bad config silently is a pipeline that fails open.

**Solution.**

```java
public List<Rule> load(List<String> classNames) {
    List<Rule> loaded = new ArrayList<>();
    List<String> failures = new ArrayList<>();

    for (String name : classNames) {
        try {
            Class<?> c = Class.forName(name, true, getClass().getClassLoader());
            if (!Rule.class.isAssignableFrom(c)) {
                failures.add(name + ": not a Rule (is " + c.getSuperclass() + ")");
                continue;
            }
            loaded.add(Rule.class.cast(c.getDeclaredConstructor().newInstance()));
        } catch (ClassNotFoundException e) {
            failures.add(name + ": not found — nested classes need Outer$Inner");
        } catch (ReflectiveOperationException e) {
            failures.add(name + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    if (!failures.isEmpty()) {
        // fail CLOSED: a risk engine with missing rules must not start
        throw new IllegalStateException("Rule loading failed: " + failures);
    }
    log.info("Loaded {} risk rules: {}", loaded.size(), names(loaded));
    return loaded;
}
```

Better still: replace the string list with `ServiceLoader<Rule>` or Spring's `List<Rule>` injection so the compiler and the build enforce existence. See [When Not to Use Reflection](#20-when-not-to-use-reflection).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Canonical name (`Outer.Inner`) passed to `Class.forName` | `ClassNotFoundException` on a class that visibly exists |
| `getFields()` expecting private fields | Serializer emits nothing; DI never populates |
| `getDeclaredFields()` without walking superclasses | Inherited fields silently unmapped (base-class audit columns null) |
| No `isBridge()` filter | Duplicate handler registrations; erased `Object` return type used |
| `getReturnType() == Void.class` | `void` methods treated as value-returning |
| `Class.forName` with caller loader inside a library | Works in tests, `ClassNotFoundException` in the container |
| Comparing classes with `equals` across loaders | "X cannot be cast to X" |
| `getSimpleName()` as a map key | Collisions across packages; empty string for anonymous classes |

### Debugging scenario

**Observe.** `OrderDto cannot be cast to OrderDto` in a Tomcat deployment after a hot redeploy.

**Diagnose.** Print identity, not names:

```java
log.error("expected {}@{} actual {}@{}",
    OrderDto.class.getName(), System.identityHashCode(OrderDto.class.getClassLoader()),
    obj.getClass().getName(), System.identityHashCode(obj.getClass().getClassLoader()));
```

Two different loader identity hashes mean two live copies of the class — a stale webapp classloader is still reachable, usually via a cache or a `ThreadLocal`.

**Fix.** Section [ClassLoader Leaks](#15-classloader-leaks). Short term: full restart instead of redeploy. Long term: find the GC root holding the old `WebappClassLoader`.

---

## 3. Instantiating and Invoking

### Core concept

Reflection creates objects through `Constructor`, not `Class`. `Class.newInstance()` was deprecated in Java 9 and should never appear in new code, because it **propagates checked exceptions thrown by the constructor without declaring them** — defeating the compiler's exception checking and producing "impossible" `SQLException` from a method that declares none.

```java
// deprecated — do not use
Object bad = SomeType.class.newInstance();

// correct
Object good = SomeType.class.getDeclaredConstructor().newInstance();
```

`getDeclaredConstructor()` with no args finds the no-arg constructor of any visibility; `getConstructor()` finds only public ones. For non-public constructors you still need `setAccessible(true)`.

### Internal working

```java
Constructor<Order> ctor = Order.class.getDeclaredConstructor(String.class, BigDecimal.class);
ctor.setAccessible(true);                 // required if the ctor is private/package-private
Order o = ctor.newInstance("SKU-1", new BigDecimal("9.99"));
```

Constructor lookup matches **exactly** on erased parameter types. There is no overload resolution, no widening, no autoboxing at *lookup* time:

```java
class Money { Money(long cents) {} }

Money.class.getDeclaredConstructor(Long.class);   // NoSuchMethodException — wrapper != primitive
Money.class.getDeclaredConstructor(long.class);   // correct
Money.class.getDeclaredConstructor(int.class);    // NoSuchMethodException — no widening on lookup
```

At **invocation** time the rules change: arguments are unboxed and then **widened** if needed. So `ctor.newInstance(5)` (an `Integer`) works for a `long` parameter — unbox to `int`, widen to `long`. But `newInstance(5L)` for an `int` parameter fails with `IllegalArgumentException: argument type mismatch`, because narrowing is not applied.

### Method lookup and invocation

```java
Method m = OrderService.class.getDeclaredMethod("pay", String.class, BigDecimal.class);
m.setAccessible(true);
Object result = m.invoke(serviceInstance, "SKU-1", new BigDecimal("9.99"));

// static method: pass null as the receiver
Method parse = Integer.class.getMethod("parseInt", String.class);
int v = (int) parse.invoke(null, "42");
```

`getMethod` searches public methods including inherited and interface defaults. `getDeclaredMethod` searches only the given class, any visibility. For a private method on a superclass you must walk up, or use `ReflectionUtils.findMethod(type, name, paramTypes)`.

### The four invocation pitfalls

**1. Varargs collapse.** `invoke(Object obj, Object... args)` is itself varargs. An `Object[]` you pass gets spread, not wrapped.

```java
Object[] args = { "a", "b" };
m.invoke(target, args);            // TWO arguments "a" and "b"

Method single = Foo.class.getMethod("takesArray", Object[].class);
single.invoke(target, args);       // WRONG: IllegalArgumentException, spread into 2 args
single.invoke(target, (Object) args);            // correct — one arg
single.invoke(target, new Object[] { args });    // also correct, clearer
```

The same trap applies to reflective calls of a **varargs target method**: `void log(String fmt, Object... rest)` has parameter types `[String, Object[]]`, so you must pass exactly two arguments where the second is an `Object[]`.

**2. Null receiver vs null argument.**

```java
m.invoke(null);                 // static method, no args
m.invoke(target);               // instance method, no args
m.invoke(target, (Object) null);// instance method, ONE null argument
m.invoke(target, (Object[]) null); // no arguments, same as invoke(target)
```

Calling an instance method with a `null` receiver throws `NullPointerException`, not `IllegalArgumentException` — a distinction that matters when you catch.

**3. `InvocationTargetException` swallowing the real cause.** Any exception thrown **by the target method** is wrapped. If you log the `InvocationTargetException` you get a stack trace that ends at `Method.invoke` and says nothing about the actual failure.

```java
try {
    method.invoke(target, args);
} catch (InvocationTargetException e) {
    Throwable cause = e.getCause();          // ALWAYS unwrap
    if (cause instanceof RuntimeException re) throw re;
    if (cause instanceof Error err) throw err;
    throw new HandlerInvocationException("handler " + method + " failed", cause);
} catch (IllegalAccessException e) {
    throw new IllegalStateException("not accessible: " + method, e);
}
```

Spring's `ReflectionUtils.handleInvocationTargetException` / `rethrowRuntimeException` does exactly this. Note the asymmetry: `IllegalAccessException` and `IllegalArgumentException` come from the **reflection layer** (your bug), `InvocationTargetException` comes from the **target** (their bug). Treat them differently in logs — conflating them makes every reflective dispatch failure look identical.

**4. Checked exceptions bypass the compiler.** Reflection can invoke a method that throws a checked exception from a context that does not declare it. Once unwrapped and rethrown, you have a checked exception flying through code that never declared it. This is legal at the JVM level — checked exceptions are a compiler construct only. `sneakyThrow` exploits the same hole:

```java
@SuppressWarnings("unchecked")
static <E extends Throwable> void sneakyThrow(Throwable t) throws E { throw (E) t; }
```

Lombok's `@SneakyThrows` is this. It is why a `catch (IOException e)` can be unreachable-by-the-compiler yet still be reached at runtime when reflection or generics erasure is involved.

### Production scenario: a message dispatcher that lost every root cause

**Problem.** A Kafka consumer dispatches to `@KafkaHandler`-style methods reflectively. On-call gets pages for "message processing failed" with stack traces that all look identical:

```
java.lang.reflect.InvocationTargetException
	at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(...)
	at com.acme.Dispatcher.dispatch(Dispatcher.java:88)
```

No cause, no handler name, no partition. Root-causing an incident took hours because the actual `OptimisticLockException` was invisible.

**Cause.** The dispatcher caught `Exception e` and logged `e.getMessage()`. `InvocationTargetException.getMessage()` is `null`, and the wrapped cause was never printed because the logging call used the single-argument form.

**Solution.**

```java
public void dispatch(Object payload, ConsumerRecord<?, ?> record) {
    HandlerMethod handler = registry.find(payload.getClass());
    if (handler == null) {
        throw new NoHandlerException(payload.getClass() + " topic=" + record.topic());
    }
    try {
        handler.method().invoke(handler.bean(), payload);
    } catch (InvocationTargetException e) {
        Throwable cause = e.getCause();
        // context the operator actually needs, plus the REAL exception object
        log.error("handler {}#{} failed topic={} partition={} offset={}",
                handler.bean().getClass().getSimpleName(), handler.method().getName(),
                record.topic(), record.partition(), record.offset(), cause);
        throw new HandlerFailedException(cause);        // preserves cause chain
    } catch (IllegalAccessException e) {
        // configuration/wiring bug, not a message bug — never retry this
        throw new IllegalStateException("handler not accessible: " + handler.method(), e);
    } catch (IllegalArgumentException e) {
        throw new IllegalStateException(
            "argument mismatch: handler expects " + Arrays.toString(handler.method().getParameterTypes())
            + " got " + payload.getClass(), e);
    }
}
```

Two rules that came out of the postmortem: **never** log an `InvocationTargetException` itself, and **never** retry an `IllegalAccessException` / `IllegalArgumentException` — those are deterministic wiring failures and retrying them just multiplies the pages.

### Getting parameter names

By default parameter names are erased to `arg0`, `arg1`. Frameworks that bind by name (Spring MVC `@RequestParam` without a value, Jackson record/constructor binding, `@ConfigurationProperties` constructor binding) need real names.

```java
Parameter[] params = method.getParameters();
params[0].isNamePresent();   // false unless compiled with -parameters
params[0].getName();         // "arg0" or the real name
```

Enable it:

```xml
<plugin>
  <artifactId>maven-compiler-plugin</artifactId>
  <configuration><parameters>true</parameters></configuration>
</plugin>
```

```groovy
tasks.withType(JavaCompile) { options.compilerArgs << '-parameters' }
```

Spring Boot's parent POM sets this already. **Spring Framework 6.1 removed `LocalVariableTableParameterNameDiscoverer`** (the old debug-symbol fallback), so on Boot 3.2+ a module compiled without `-parameters` fails at startup with:

```
java.lang.IllegalArgumentException: Name for argument of type [java.lang.String] not specified,
and parameter name information not available via reflection.
Ensure that the compiler uses the '-parameters' flag.
```

This bites hardest in multi-module builds where one module inherits the Boot parent and another does not.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `Class.newInstance()` | Undeclared checked exception escapes; deprecation warning ignored |
| Wrapper class in `getDeclaredConstructor(...)` lookup | `NoSuchMethodException` on a constructor you can see |
| `Object[]` passed to `invoke` for a single array parameter | `IllegalArgumentException: wrong number of arguments` |
| Logging `InvocationTargetException` without `getCause()` | Every failure looks the same; hours lost per incident |
| Retrying on `IllegalAccessException` | Infinite retry loop / poison-pill storm |
| Missing `-parameters` | `Name for argument of type [...] not specified` at startup on Boot 3.2+ |
| Assuming widening on constructor **lookup** | Works for `invoke`, fails for `getDeclaredConstructor` |
| Anonymous/local class instantiation | Hidden `this$0` first parameter; `NoSuchMethodException` for the "no-arg" constructor |

### Debugging scenario

**Observe.** `IllegalArgumentException: argument type mismatch` when invoking a handler that "obviously" matches.

**Diagnose.** Print both sides. The message alone never tells you which argument.

```java
private static IllegalArgumentException explain(Method m, Object[] args, IllegalArgumentException e) {
    StringBuilder sb = new StringBuilder("argument mismatch for ").append(m).append('\n');
    Class<?>[] expected = m.getParameterTypes();
    for (int i = 0; i < Math.max(expected.length, args.length); i++) {
        sb.append("  [").append(i).append("] expected=")
          .append(i < expected.length ? expected[i].getName() : "<none>")
          .append(" actual=")
          .append(i < args.length && args[i] != null ? args[i].getClass().getName() : "null")
          .append('\n');
    }
    return new IllegalArgumentException(sb.toString(), e);
}
```

Typical findings: an `Integer` where a `long` is fine but a `Long` where an `int` is not; a proxy class where the declaring class was expected; an autoboxed `null` for a primitive parameter (which fails with "argument type mismatch," not NPE).

**Fix.** Normalize arguments at the boundary (convert with a `ConversionService`), assert arity before invoking, and cache a validated `HandlerMethod` at startup instead of resolving per message.

---

## 4. Field Access and setAccessible

### Core concept

`AccessibleObject.setAccessible(true)` suppresses the **Java language access check** for a specific `Field`/`Method`/`Constructor` object. It sets an `override` flag on that reflective object; from then on, `private`, `protected`, and package-private are not enforced *for that object*.

What it does **not** do:

- It does not change the member's modifiers. `Modifier.isPrivate(f.getModifiers())` is still true.
- It does not affect other `Field` objects for the same field — each `getDeclaredField` call returns a **fresh copy** with `override == false`.
- Since Java 9 it does not bypass **module** encapsulation. If the package is not `open`, it throws `InaccessibleObjectException`. See [The Java Module System](#5-the-java-module-system-and-strong-encapsulation).
- It does not make a `final` field writable in the general case.

```java
Field f = Order.class.getDeclaredField("total");
f.setAccessible(true);
BigDecimal total = (BigDecimal) f.get(orderInstance);
f.set(orderInstance, new BigDecimal("0.00"));

// primitives have typed accessors that avoid boxing
Field count = Order.class.getDeclaredField("itemCount");
count.setAccessible(true);
int n = count.getInt(orderInstance);
count.setInt(orderInstance, n + 1);

// static field: null receiver
Field cache = Registry.class.getDeclaredField("INSTANCE");
cache.setAccessible(true);
Object instance = cache.get(null);
```

Use `getInt`/`setInt`/`getLong`/… for primitives in any hot path: `get`/`set` box and allocate on every call.

### Internal working: `canAccess` and the trySetAccessible contract

```java
Field f = target.getClass().getDeclaredField("secret");

f.canAccess(target);          // can I read it right now, without override?
boolean ok = f.trySetAccessible();   // Java 9+: returns false instead of throwing
if (!ok) {
    // module not open — degrade gracefully instead of crashing
    log.debug("skipping inaccessible field {}", f);
}
```

`trySetAccessible()` is the API well-behaved libraries use on Java 9+. `setAccessible(true)` throws `InaccessibleObjectException` (an `Error`-adjacent `RuntimeException`) which most callers never expected. If you write a library that reflects on arbitrary user types, use `trySetAccessible` and skip what you cannot reach.

### The reality of mutating `final` fields

There are three distinct cases, and only one of them ever really worked.

**Case 1 — non-static `final` instance field.** `setAccessible(true)` + `Field.set` works on HotSpot for ordinary classes. It is *not* guaranteed by the JLS, and it is dangerous: the JIT is permitted to constant-fold reads of `final` fields after construction, so some readers may keep observing the old value indefinitely while others see the new one. Also, there are **no memory-model guarantees** — the final-field freeze semantics of the JMM assume the value never changes.

```java
class Config { private final String url = "http://prod"; }

Field f = Config.class.getDeclaredField("url");
f.setAccessible(true);
f.set(config, "http://test");   // "works" on HotSpot; a JIT-compiled reader may still see prod
```

**Case 2 — `static final`.** `Field.set` throws `IllegalAccessException: Can not set static final ... field` even after `setAccessible(true)`. The old workaround was to strip `Modifier.FINAL` from the `modifiers` field of `Field` itself:

```java
// DEAD since Java 12 — NoSuchFieldException: modifiers
Field modifiers = Field.class.getDeclaredField("modifiers");
modifiers.setAccessible(true);
modifiers.setInt(field, field.getModifiers() & ~Modifier.FINAL);
```

Java 12 added `Reflection.registerFieldsToFilter` for `java.lang.reflect.Field`, so `getDeclaredField("modifiers")` throws `NoSuchFieldException`. Libraries that depended on it (older Mockito, older Powermock, older Spring `ReflectionTestUtils` paths, some test fixtures) broke on 12+. There is no supported replacement. `MethodHandles.privateLookupIn(...).unreflectVarHandle(field)` can write a **non-static** final field in an open package but explicitly refuses `static final`.

**Case 3 — compile-time constants.** `private static final String X = "a";` (a constant variable per JLS §4.12.4) is **inlined into every call site at compile time**. Even if you could change the field, nothing would read it. This is why "I changed the constant reflectively and nothing happened" is a common confusion.

**Case 4 — records and hidden classes.** Record fields are `final` and **cannot** be mutated reflectively at all; `Field.set` throws `IllegalAccessException` unconditionally. Same for fields of hidden classes (lambdas). This is deliberate and permanent.

Practical guidance: **never mutate finals in production code.** In tests, mutating a static final is a design smell — inject the value instead. If a third-party library forces it, the honest fix is a wrapper you control.

### `sun.misc.Unsafe`: what it was, where it stands

`Unsafe` provided off-heap allocation, direct field offsets, CAS, and object instantiation without constructors:

```java
// historical — do not write this
Unsafe u = getUnsafeReflectively();
Object o = u.allocateInstance(MyType.class);      // no constructor runs
long off = u.objectFieldOffset(MyType.class.getDeclaredField("value"));
u.putObject(o, off, "injected");
```

Where each capability lives now:

| Unsafe capability | Modern replacement |
|---|---|
| CAS / volatile field access | `VarHandle` (Java 9) — see [MethodHandles and VarHandles](#12-methodhandles-and-varhandles) |
| Off-heap memory | Foreign Function & Memory API, `MemorySegment` / `Arena` (final in Java 22, JEP 454) |
| `allocateInstance` (no-ctor) | Still Unsafe-backed in practice; Objenesis abstracts it per JVM |
| `defineClass` | `MethodHandles.Lookup.defineClass` / `defineHiddenClass` |
| `throwException` | Generic `sneakyThrow` idiom |

JEP 471 (Java 23) deprecated the memory-access methods of `sun.misc.Unsafe` for removal; JDK 24+ prints warnings when they are used, and the plan is removal. Objenesis, Kryo, Netty, and older serialization libraries are the usual sources of those warnings in a modern service. The action item is a dependency upgrade, not a flag.

### Performance of accessible flags

Two separate costs are constantly conflated:

1. **Lookup cost.** `getDeclaredField` / `getDeclaredMethod` performs a linear scan and returns a **defensive copy** of the reflective object. This allocates and is genuinely slow. Never do it per call.
2. **Invocation cost.** With `setAccessible(true)`, each `get`/`invoke` skips the access check. Without it, an access check walks the caller's class and module on every single call. `setAccessible(true)` therefore makes repeated access *faster*, not slower — the opposite of what many people assume.

```java
// Correct shape for anything on a hot path
public final class FastAccessor {
    private final Field field;                 // resolved ONCE at startup

    FastAccessor(Class<?> type, String name) throws NoSuchFieldException {
        this.field = type.getDeclaredField(name);
        this.field.setAccessible(true);        // once
    }

    Object read(Object target) throws IllegalAccessException {
        return field.get(target);              // no lookup, no access check
    }
}
```

Since JDK 18 (JEP 416) core reflection is implemented on top of method handles, so `Method.invoke` on a warm path is far closer to a direct call than it was on Java 8's generated-accessor ("inflation") scheme. The old `-Dsun.reflect.inflationThreshold=0` tuning knob is obsolete on modern JDKs.

### Production scenario: a test helper that corrupted production behaviour

**Problem.** A team used a test utility to set a `static final` feature-flag constant. It worked on Java 8, silently no-oped after the Java 17 upgrade for one flag, and threw `NoSuchFieldException: modifiers` for another. Worse, one service had the helper on the **main** classpath and a scheduled job invoked it, flipping a flag for real traffic.

**Cause.** Three separate misuses stacked: mutating `static final`, relying on the `modifiers` hack, and shipping a test-only class in `src/main/java`.

**Solution.** Make the value injectable and delete the reflection.

```java
// before — untestable constant
public class PricingService {
    private static final boolean USE_NEW_ENGINE = false;
}

// after — a bean, a property, and a real test seam
@Component
public class PricingService {
    private final boolean useNewEngine;

    public PricingService(@Value("${pricing.new-engine:false}") boolean useNewEngine) {
        this.useNewEngine = useNewEngine;
    }
}
```

If you genuinely must poke a field in a test (third-party type, no seam), use the supported test API and keep it in `src/test/java`:

```java
// Spring Test — handles setAccessible and gives a clear failure message
ReflectionTestUtils.setField(target, "retryDelay", Duration.ofMillis(1));

// JUnit 5 + non-static final in an open package
VarHandle vh = MethodHandles.privateLookupIn(Target.class, MethodHandles.lookup())
                            .findVarHandle(Target.class, "retryDelay", Duration.class);
vh.set(target, Duration.ofMillis(1));
```

And add an ArchUnit rule so it never leaks back:

```java
@ArchTest
static final ArchRule no_reflection_utils_in_main =
    noClasses().that().resideOutsideOfPackage("..test..")
        .should().dependOnClassesThat().haveFullyQualifiedName(
            "org.springframework.test.util.ReflectionTestUtils");
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `setAccessible(true)` called per invocation | Allocation + linear lookup on every call; visible in async-profiler as `Class.getDeclaredField` |
| Expecting `setAccessible` to defeat module encapsulation | `InaccessibleObjectException` on Java 17 |
| `Field.set` on `static final` | `IllegalAccessException: Can not set static final ...` |
| `modifiers`-field hack | `NoSuchFieldException: modifiers` on Java 12+ |
| Mutating a compile-time constant | No observable effect anywhere |
| Mutating a record component | `IllegalAccessException`, always |
| `get`/`set` on primitives in a hot loop | Autoboxing garbage; `Integer.valueOf` dominating allocation profiles |
| `setAccessible` on a shared cached `Field` from a library | Cross-library interference; some libraries hand out copies deliberately |

### Debugging scenario

**Observe.** A serializer writes `null` for a field that clearly has a value.

**Diagnose.** Three candidates, distinguished in one dump:

```java
for (Field f : type.getDeclaredFields()) {
    log.info("{} static={} synthetic={} canAccess={} declaringClass={}",
        f.getName(), Modifier.isStatic(f.getModifiers()), f.isSynthetic(),
        f.canAccess(instance), f.getDeclaringClass().getName());
}
```

- Field is declared on a **superclass** → `getDeclaredFields()` on the subclass never saw it.
- `canAccess == false` and no `setAccessible` → the library skipped it silently (many do).
- The value lives on the **target** while you are reflecting on a **proxy** — a CGLIB subclass has its own (empty) copy of nothing, but Objenesis-created proxies skip constructors, so a proxy instance's inherited fields are all default values. Unwrap first: `AopProxyUtils.ultimateTargetClass(bean)` and `((Advised) bean).getTargetSource().getTarget()`.

**Fix.** Walk the hierarchy, call `trySetAccessible` and log skips at WARN, and always reflect on the **target object**, never on the proxy.

---
## 5. The Java Module System and Strong Encapsulation

### Core concept

Before Java 9, `setAccessible(true)` was absolute: any code could reach into any class, including JDK internals. JPMS (Java 9, JSR 376) added a second, **stronger** boundary above the `public/private` boundary: a package is only reflectively accessible from outside its module if the module **opens** it.

Two independent questions now decide access:

1. **Is the type readable?** — `exports` controls compile-time and normal runtime access to public API.
2. **Is deep reflection allowed?** — `opens` controls `setAccessible(true)` on non-public members (and on public members of non-exported packages).

```java
module com.acme.orders {
    requires spring.core;

    exports com.acme.orders.api;                       // public API, no deep reflection
    opens   com.acme.orders.domain to com.fasterxml.jackson.databind;  // qualified open
    opens   com.acme.orders.config;                    // unqualified open — anyone may reflect
}

open module com.acme.legacy { }                        // everything open, escape hatch
```

The critical rule: **`exports` does not imply `opens`.** A Jackson or Hibernate failure of the form "cannot make field accessible" on an exported package is exactly this.

### The timeline, and why your upgrade broke

| JDK | What changed |
|---|---|
| 9 | Modules introduced. JDK internals encapsulated but `--illegal-access=permit` was the **default**: deep reflection into `java.*` produced a warning and worked. |
| 10–15 | Same default, louder warnings ("An illegal reflective access operation has occurred"). |
| 16 | **JEP 396**: default flipped to `--illegal-access=deny`. Illegal access now throws. |
| 17 | **JEP 403**: `--illegal-access` removed entirely; the option is ignored with a warning. Only `--add-opens` / `--add-exports` work. |
| 21+ | Unchanged; additional integrity work (agent-loading warnings, `Unsafe` deprecation) continues in the same direction. |

Note the important subtlety: **classpath code is still in the unnamed module**, and the unnamed module is *open*. So your application classes reflecting on each other work fine. What broke on 16/17 is reflection into **JDK internals** (`java.lang.reflect.Field.modifiers`, `java.util.HashMap` internals, `com.sun.tools.javac.*`, `java.nio.Buffer.cleaner`) and into **named modules** on the module path.

### The exception you will see

```
java.lang.reflect.InaccessibleObjectException: Unable to make field private final
  java.util.Comparator java.util.TreeMap.comparator accessible:
  module java.base does not "opens java.util" to unnamed module @0x2f92e0f4
```

Read the message literally — it names the **module** (`java.base`), the **package** (`java.util`), and the **requesting module** (`unnamed module`, i.e. classpath). That gives you the exact flag:

```
--add-opens java.base/java.util=ALL-UNNAMED
```

`--add-exports` is the weaker sibling: it grants access to **public** members of a non-exported package (compile and normal runtime access), not deep reflection.

```
--add-exports jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED   # can call public API
--add-opens   jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED   # can setAccessible
```

Rule of thumb: `InaccessibleObjectException` → `--add-opens`. `IllegalAccessError` / "package is not visible" at compile time → `--add-exports`.

### Where to put the flags (this is where teams lose a day)

```xml
<!-- Surefire / Failsafe: tests fork a JVM, they do NOT inherit MAVEN_OPTS reliably -->
<plugin>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration>
    <argLine>--add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED</argLine>
  </configuration>
</plugin>
```

```groovy
// Gradle: tests and the application plugin are separate JVMs
tasks.withType(Test) { jvmArgs '--add-opens', 'java.base/java.lang=ALL-UNNAMED' }
application { applicationDefaultJvmArgs = ['--add-opens=java.base/java.util=ALL-UNNAMED'] }
```

```
# Executable jar: flags cannot go in the jar's own manifest as JVM args,
# but the MANIFEST can request opens for the jar's own module usage:
Add-Opens: java.base/java.util java.base/java.lang
```

```dockerfile
# Container: JDK_JAVA_OPTIONS is picked up by the `java` launcher (JDK 9+)
ENV JDK_JAVA_OPTIONS="--add-opens=java.base/java.util=ALL-UNNAMED"
```

Gotchas:

- `JAVA_TOOL_OPTIONS` also works but is picked up by *every* JVM in the container, including `jcmd`, producing noisy "Picked up JAVA_TOOL_OPTIONS" lines that break scripts parsing stdout.
- Surefire's `<argLine>` is **overwritten**, not appended, by Jacoco's `argLine` property. Use `@{argLine}` to combine: `<argLine>@{argLine} --add-opens ...</argLine>`.
- IDE run configurations are separate from the build. "It works in IntelliJ, fails in CI" is almost always this.

### Why Lombok, Mockito, and older ORMs broke on 16/17

| Library | What it reached into | Outcome |
|---|---|---|
| Lombok | `jdk.compiler` internals (`com.sun.tools.javac.*`) to mutate the AST during compilation | Broke hard on 16; fixed in Lombok 1.18.20+ which self-injects the needed opens |
| Mockito (inline/`mock-maker`) | ByteBuddy agent + `Field.modifiers` for final-field stubbing | Needed upgrade; modern Mockito uses supported paths, plus `-XX:+EnableDynamicAgentLoading` on JDK 21 to silence agent warnings |
| Hibernate < 5.4.x | `java.lang.invoke` / bytecode enhancement internals | Upgrade required |
| Older Kryo / Objenesis | `sun.misc.Unsafe`, `Field.modifiers` | Upgrade; the Unsafe path still works but is deprecated (JEP 471) |
| Netty | `java.nio.DirectByteBuffer.cleaner` | Warns without `--add-opens java.base/java.nio=ALL-UNNAMED`, degrades gracefully |
| Older Jackson with private fields in a **named** module | user module not `opens` | `InaccessibleObjectException` at (de)serialization |

The pattern is identical every time: a library used an internal that was never public API, the JDK closed it, and the fix is a dependency upgrade — not a flag.

### Production scenario: `InaccessibleObjectException` after a Java 17 upgrade

**Problem.** A batch service upgraded from Java 11 to 17. Compiles, unit tests pass, and the nightly job dies after 40 minutes:

```
java.lang.reflect.InaccessibleObjectException: Unable to make protected final java.lang.Class
  java.lang.ClassLoader.defineClass(java.lang.String,byte[],int,int) accessible:
  module java.base does not "opens java.lang" to unnamed module @0x1f36e637
	at java.base/java.lang.reflect.AccessibleObject.throwInaccessibleObjectException
	at net.sf.cglib.core.ReflectUtils.defineClass(ReflectUtils.java:61)
```

**Cause.** A transitively pulled, ancient `cglib:cglib:3.2.x` (via an old caching library) defined proxy classes by calling `ClassLoader.defineClass` reflectively. That has been illegal since JDK 16. It only failed at 40 minutes because that code path ran once, lazily, when the report generator built its first proxy.

**Solution — the correct fix, then the stopgap.**

*Correct fix:* remove the standalone CGLIB. Spring has repackaged CGLIB (`org.springframework.cglib`) since 3.2 and it uses `MethodHandles.Lookup.defineClass` on modern JDKs. Find who drags it in:

```bash
mvn dependency:tree -Dincludes=cglib:cglib
./gradlew dependencyInsight --dependency cglib --configuration runtimeClasspath
```

Then exclude it and upgrade the offending library. If a library genuinely needs runtime class definition, ByteBuddy with `ClassLoadingStrategy.UsingLookup` is the supported approach:

```java
Class<?> generated = new ByteBuddy()
    .subclass(Service.class)
    .method(ElementMatchers.named("compute"))
    .intercept(MethodDelegation.to(Interceptor.class))
    .make()
    .load(Service.class.getClassLoader(),
          ClassLoadingStrategy.UsingLookup.of(MethodHandles.privateLookupIn(
              Service.class, MethodHandles.lookup())))
    .getLoaded();
```

*Stopgap* (documented, ticketed, with an expiry):

```
--add-opens java.base/java.lang=ALL-UNNAMED
```

**Why the flag is a stopgap, not a fix:** it re-opens `java.lang` to *all* classpath code, not just the one library. You lose the integrity guarantee for everything, you hide the next occurrence of the same bug, and there is a real chance the JDK removes the escape hatch for specific packages later. Every `--add-opens` in a production launch script should have a comment naming the library and the ticket to remove it.

### Diagnosing before it explodes

```bash
# 1. Which of my dependencies still touch internals? Run at build time, fail the build.
jdeps --multi-release 17 --print-module-deps --ignore-missing-deps target/app.jar
jdeps --jdk-internals target/app.jar        # lists uses of removed/encapsulated internals

# 2. Stack trace on every module access check failure (huge time-saver)
java -Dsun.reflect.debugModuleAccessChecks=true -jar app.jar

# 3. On 11/15, before you upgrade: turn the warning into an error and find them all
java --illegal-access=deny -jar app.jar     # dry-run the JDK 16 default while still on 11
```

That third command is the single highest-value pre-upgrade action: it reproduces JDK 16/17 behaviour on your current JDK, so you can find every illegal access in a soak test rather than in production.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `--add-opens` in `MAVEN_OPTS` only | Build passes, forked Surefire JVM still fails |
| Jacoco overwriting Surefire `argLine` | Flags silently dropped; use `@{argLine}` |
| `--add-exports` used where `--add-opens` was needed | Still `InaccessibleObjectException` |
| `--illegal-access=permit` on 17 | Ignored with a warning; people assume it worked |
| Flags in IDE only | Green locally, red in CI/prod |
| `exports` without `opens` in a modular app | Jackson/Hibernate cannot see private fields |
| Relying on `Field.modifiers` | `NoSuchFieldException: modifiers` (Java 12+), unrelated to modules but often confused with it |
| Adding opens for `ALL-UNNAMED` blanket-wide | Encapsulation lost globally; masks future regressions |

### Debugging scenario

**Observe.** After a JDK bump, one endpoint 500s with `InaccessibleObjectException`; everything else is fine.

**Diagnose.** Read the three nouns in the message: source module, package, requesting module. Then find the **caller** — the frame directly below `AccessibleObject.throwInaccessibleObjectException` names the library. Check its version against its "JDK 17 support" release notes. Run `jdeps --jdk-internals` to see whether it is one of several offenders or the only one.

**Fix.** Upgrade the library. If no version supports 17, add a narrowly scoped, commented `--add-opens` for exactly that package, and open a ticket to replace the dependency. Add a smoke test that exercises the lazy path so the next upgrade fails in CI, not at 03:00.

---

## 6. Generics and Reflection

### Core concept

Generics are erased in the **class file's descriptor** but preserved in the **`Signature` attribute** for classes, fields, methods, and constructors. This is why the following two statements are both true and constantly cause confusion:

- `new ArrayList<String>().getClass()` gives you `ArrayList` with no type argument. The *instance* has no memory of `String`.
- `SomeClass.class.getDeclaredField("names").getGenericType()` gives you `java.util.List<java.lang.String>`. The *declaration* does remember.

**Erasure removes the type argument from values, not from declarations.** Every framework that "knows" your generic type reads it from a declaration site.

### The Type hierarchy

```
java.lang.reflect.Type
 ├── Class<?>                 List, String, int, String[]
 ├── ParameterizedType        List<String>, Map<String, List<Order>>
 ├── TypeVariable<D>          T, E extends Comparable<E>
 ├── WildcardType             ?, ? extends Number, ? super Integer
 └── GenericArrayType         T[], List<String>[]
```

```java
class Holder {
    private Map<String, List<Order>> index;
    private List<? extends Number> numbers;
    private <T extends Comparable<T>> T pick(List<T> items) { return items.get(0); }
}

Field f = Holder.class.getDeclaredField("index");

f.getType();          // interface java.util.Map        <- erased
f.getGenericType();   // java.util.Map<java.lang.String, java.util.List<com.acme.Order>>

ParameterizedType pt = (ParameterizedType) f.getGenericType();
pt.getRawType();                       // interface java.util.Map
pt.getActualTypeArguments()[0];        // class java.lang.String
pt.getActualTypeArguments()[1];        // java.util.List<com.acme.Order>  (another ParameterizedType)
pt.getOwnerType();                     // null (non-nested)
```

Method and constructor equivalents:

```java
Method m = Holder.class.getDeclaredMethod("pick", List.class);
m.getReturnType();            // java.lang.Comparable    <- erasure of T's bound
m.getGenericReturnType();     // T  (a TypeVariable)
m.getGenericParameterTypes(); // [java.util.List<T>]
TypeVariable<Method> tv = m.getTypeParameters()[0];
tv.getName();                 // "T"
tv.getBounds();               // [java.lang.Comparable<T>]
```

### Reading a generic type safely

Never blind-cast to `ParameterizedType`. A raw `List` field, or `List<T>` where `T` is unresolved, will give you `Class` or `TypeVariable` and throw `ClassCastException`.

```java
public static Optional<Class<?>> elementTypeOf(Field field) {
    Type generic = field.getGenericType();
    if (!(generic instanceof ParameterizedType pt)) return Optional.empty();   // raw List
    Type[] args = pt.getActualTypeArguments();
    if (args.length != 1) return Optional.empty();
    return rawOf(args[0]);
}

private static Optional<Class<?>> rawOf(Type t) {
    return switch (t) {
        case Class<?> c -> Optional.of(c);
        case ParameterizedType p -> rawOf(p.getRawType());
        case GenericArrayType g -> rawOf(g.getGenericComponentType())
                .map(c -> Array.newInstance(c, 0).getClass());
        case WildcardType w -> w.getUpperBounds().length > 0 ? rawOf(w.getUpperBounds()[0])
                                                            : Optional.of(Object.class);
        case TypeVariable<?> v -> v.getBounds().length > 0 ? rawOf(v.getBounds()[0])
                                                           : Optional.of(Object.class);
        default -> Optional.empty();
    };
}
```

In Spring, don't write this — `ResolvableType` already does it, including resolving type variables against a concrete subclass:

```java
ResolvableType t = ResolvableType.forField(field);
Class<?> element = t.asCollection().resolveGeneric(0);          // Order.class

// Resolve T from a subclass: class OrderRepo extends BaseRepo<Order, Long>
Class<?> entity = ResolvableType.forClass(OrderRepo.class)
                                .as(BaseRepo.class)
                                .resolveGeneric(0);             // Order.class
```

That last pattern — resolving a superclass's type variable against a concrete subclass — is how Spring Data knows your entity type, how Spring picks the right `ApplicationListener<MyEvent>`, and how a generic `AbstractProcessor<T>` base class can know `T`.

### The anonymous-subclass trick, and why TypeReference exists

You cannot write `List<String>.class` and you cannot recover `String` from a `List<String>` *value*. But you **can** recover it from a declaration — including the declaration of an anonymous subclass:

```java
public abstract class TypeRef<T> {
    private final Type type;

    protected TypeRef() {
        Type superclass = getClass().getGenericSuperclass();       // TypeRef<List<Order>>
        this.type = ((ParameterizedType) superclass).getActualTypeArguments()[0];
    }
    public Type getType() { return type; }
}

// the trailing {} creates an anonymous SUBCLASS whose signature records List<Order>
Type t = new TypeRef<List<Order>>() {}.getType();   // java.util.List<com.acme.Order>
```

That is precisely Jackson's `TypeReference`, Spring's `ParameterizedTypeReference`, Guice's `TypeLiteral`, and Gson's `TypeToken`. Now the API calls make sense:

```java
// Jackson: without TypeReference you get LinkedHashMap, not Order
List<Order> orders = mapper.readValue(json, new TypeReference<List<Order>>() {});

// equivalent, explicit:
JavaType type = mapper.getTypeFactory().constructCollectionType(List.class, Order.class);
List<Order> orders2 = mapper.readValue(json, type);

// Spring RestTemplate / WebClient
ResponseEntity<List<Order>> resp = restTemplate.exchange(
    url, HttpMethod.GET, null, new ParameterizedTypeReference<List<Order>>() {});

Mono<List<Order>> mono = webClient.get().uri(url)
    .retrieve().bodyToMono(new ParameterizedTypeReference<List<Order>>() {});
```

Forgetting the `{}` is a compile error for the abstract versions, which is deliberate API design: they are abstract *so that* you are forced to create a subclass.

### Production scenario: `LinkedHashMap cannot be cast to Order`

**Problem.** An integration service deserializes a paged API response. In tests (single-element list, then `get(0).getId()` never called) everything passes. In production:

```
java.lang.ClassCastException: class java.util.LinkedHashMap cannot be cast to class com.acme.Order
	at com.acme.OrderClient.lambda$fetch$0(OrderClient.java:42)
```

The offending code:

```java
List<Order> orders = mapper.readValue(body, List.class);   // <- type argument is a lie
```

**Cause.** `List.class` tells Jackson "a list of unknown"; it produces `List<LinkedHashMap>`. The unchecked assignment compiles because of erasure; the `ClassCastException` surfaces at the **first element access**, potentially far from the deserialization call. Heap-only failure, no stack frame near the real bug.

**Solution.**

```java
// Option 1 — TypeReference
List<Order> orders = mapper.readValue(body, new TypeReference<List<Order>>() {});

// Option 2 — build the JavaType once and cache it (avoids per-call TypeReference allocation)
private static final JavaType ORDER_LIST =
    TypeFactory.defaultInstance().constructCollectionType(List.class, Order.class);
List<Order> orders = mapper.readValue(body, ORDER_LIST);

// Option 3 — best: a real DTO for the envelope, no generics gymnastics
public record OrderPage(List<Order> content, int page, int totalPages) {}
OrderPage page = mapper.readValue(body, OrderPage.class);
```

Option 3 also fixes the *next* problem: paging metadata that the `List` shape could never carry. Add a guard so the class of failure cannot recur:

```java
mapper.enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);   // catches envelope drift
assertThat(orders).allMatch(o -> o instanceof Order);               // in a contract test
```

### Nested and self-referential generics

```java
// Map<String, List<Map<Long, Order>>> — recursion, not a special case
Type t = field.getGenericType();
// walk: ParameterizedType -> args[1] -> ParameterizedType -> args[0] -> ParameterizedType

// Recursive bound: <T extends Comparable<T>>
TypeVariable<?> v = ...;
v.getBounds()[0];              // Comparable<T>  — contains v itself; guard against infinite walks
```

Any generic-type walker needs a visited set for recursive type variables, or it will stack-overflow on `<T extends Comparable<T>>`. Jackson's `TypeFactory` and Spring's `ResolvableType` both handle this; hand-rolled walkers usually do not.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `readValue(json, List.class)` | `LinkedHashMap cannot be cast to X`, far from the call site |
| `TypeReference` without `{}` | Compile error (good) — or, with a concrete class, silently wrong type |
| Cast to `ParameterizedType` without `instanceof` | `ClassCastException` on raw types and unresolved type variables |
| Using `getType()` instead of `getGenericType()` | Element types lost; collections of `Object` |
| Resolving `T` from an instance rather than a declaration | Always `Object`; erasure |
| No visited-set in a type walker | `StackOverflowError` on recursive bounds |
| `new TypeReference<>() {}` (diamond) | Type argument becomes the inferred target, often not what you want; be explicit |
| Caching `TypeReference` instances per call | Small but real allocation churn; cache `JavaType` instead |

### Debugging scenario

**Observe.** A generic Spring bean is not autowired: "expected at least 1 bean which qualifies as autowire candidate for `Handler<PaymentEvent>`."

**Diagnose.** Spring matches generics using `ResolvableType`. Print what it actually resolved:

```java
ResolvableType required = ResolvableType.forClassWithGenerics(Handler.class, PaymentEvent.class);
for (String name : ctx.getBeanNamesForType(Handler.class)) {
    ResolvableType actual = ResolvableType.forClass(ctx.getType(name)).as(Handler.class);
    log.info("{} -> {} matches={}", name, actual, required.isAssignableFrom(actual));
}
```

Common findings: the bean is declared as a raw `Handler` (type argument erased at the declaration too), or it is created by a `@Bean` method whose **return type** is `Handler` rather than `Handler<PaymentEvent>` — the return type is the declaration Spring reads, so widening it loses the generic. Or a proxy: a JDK proxy implements `Handler` **raw**, so generic matching fails where a CGLIB proxy (which subclasses the concrete generic type) would have worked.

**Fix.** Declare the most specific generic return type on `@Bean` methods and on the class itself. If proxying erased it, switch to class proxies or add an explicit `@Qualifier`.

---

## 7. Annotations

### Core concept

An annotation is an **interface** (`java.lang.annotation.Annotation` subtype) whose instances at runtime are **JDK dynamic proxies**. When you call `myAnno.value()`, you are invoking a proxy backed by `sun.reflect.annotation.AnnotationInvocationHandler`, which reads a `Map<String, Object>` of member values parsed from the class file's `RuntimeVisibleAnnotations` attribute.

That single fact explains several behaviours: annotation instances have value-based `equals`/`hashCode`, a readable `toString`, cannot be `instanceof`-ed against their implementation class, and can be *synthesized* by frameworks (Spring builds its own proxies with merged attributes).

### Retention: the single most common annotation bug

| `@Retention` | In `.java` | In `.class` | Visible to reflection | Use |
|---|---|---|---|---|
| `SOURCE` | yes | **no** | no | `@Override`, `@SuppressWarnings`, Lombok, APT-only markers |
| `CLASS` (default) | yes | yes | **no** | Bytecode tools, static analysis (`@Nullable` in some libs) |
| `RUNTIME` | yes | yes | **yes** | Anything a framework reads at runtime |

**`CLASS` is the default.** Omitting `@Retention` on an annotation you intend to read reflectively produces the classic "my annotation is never found" bug, with no error message anywhere.

```java
// BUG: defaults to CLASS; getAnnotation returns null forever
@Target(ElementType.METHOD)
public @interface Audited { }

// correct
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface Audited {
    String action();
    Severity severity() default Severity.LOW;
    String[] tags() default {};
}
```

Allowed member types are restricted: primitives, `String`, `Class`, enums, other annotations, and single-dimension arrays of those. No `List`, no arbitrary objects, no `null` defaults (use `""` or a sentinel).

### Target, Inherited, Repeatable, meta-annotations

```java
@Target({ElementType.TYPE, ElementType.METHOD})   // where it may be placed
@Retention(RetentionPolicy.RUNTIME)
@Inherited                                        // subclasses "see" it — CLASS targets only
@Documented
public @interface Audited { String action(); }
```

`@Target` values include `TYPE`, `METHOD`, `FIELD`, `PARAMETER`, `CONSTRUCTOR`, `ANNOTATION_TYPE` (meta-annotation), `TYPE_USE` (Java 8, e.g. `List<@NonNull String>`), `TYPE_PARAMETER`, `RECORD_COMPONENT` (Java 16), `MODULE`.

`@Inherited` has two limits people forget:

1. It applies only to **class inheritance**, never to interfaces. An annotation on an interface is never inherited by implementing classes, `@Inherited` or not.
2. It applies only to **type-level** annotations. Method annotations are never inherited; `getAnnotation` on an overriding method returns null even if the overridden method was annotated. Spring works around this in `AnnotatedElementUtils.findMergedAnnotation`, which searches superclass **methods** and interfaces explicitly.

`@Repeatable` needs a container annotation:

```java
@Repeatable(Roles.class)
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface Role { String value(); }

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface Roles { Role[] value(); }

@Role("ADMIN") @Role("AUDITOR")
void purge() {}

// getAnnotation(Role.class) -> null !!  The compiler wrapped them in Roles.
Role[] roles = method.getAnnotationsByType(Role.class);   // correct: both, container unwrapped
```

`getAnnotationsByType` is the only correct accessor for repeatables. Code that calls `getAnnotation` on a repeatable silently sees nothing as soon as a second copy is added — a change that looks harmless in review.

### Reading annotations reflectively

```java
// presence and value
if (method.isAnnotationPresent(Audited.class)) {
    Audited a = method.getAnnotation(Audited.class);
    audit(a.action(), a.severity());
}

// all annotations, including meta-annotations? NO — getAnnotations is direct only
Annotation[] direct = method.getAnnotations();            // present on this element
Annotation[] declared = method.getDeclaredAnnotations();  // same, minus @Inherited ones

// parameters
for (Parameter p : method.getParameters()) {
    if (p.isAnnotationPresent(Sensitive.class)) mask(p.getName());
}
// or the older array form (index-aligned, one array per parameter)
Annotation[][] paramAnnos = method.getParameterAnnotations();

// annotation-on-annotation (meta)
boolean isQualifier = anno.annotationType().isAnnotationPresent(Qualifier.class);
```

Note the trap in the last line: to inspect an annotation's own annotations you need `annotationType()`, not `getClass()`. `anno.getClass()` is the **proxy** class (`com.sun.proxy.$Proxy12`), which has none of your meta-annotations. This is the single most common bug in hand-written annotation scanners.

### Custom annotation end-to-end

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface RateLimited {
    int permitsPerSecond();
    String key() default "";
    Class<? extends KeyResolver> resolver() default DefaultKeyResolver.class;
}
```

```java
@Aspect
@Component
public class RateLimitAspect {

    private final Map<Method, RateLimiter> limiters = new ConcurrentHashMap<>();

    @Around("@annotation(com.acme.RateLimited)")
    public Object limit(ProceedingJoinPoint pjp) throws Throwable {
        MethodSignature sig = (MethodSignature) pjp.getSignature();
        // sig.getMethod() may be the INTERFACE method on a JDK proxy — resolve the target method
        Method target = AopUtils.getMostSpecificMethod(sig.getMethod(), pjp.getTarget().getClass());
        RateLimited anno = AnnotatedElementUtils.findMergedAnnotation(target, RateLimited.class);
        if (anno == null) return pjp.proceed();

        RateLimiter limiter = limiters.computeIfAbsent(target,
            m -> RateLimiter.create(anno.permitsPerSecond()));
        if (!limiter.tryAcquire(Duration.ofMillis(50))) {
            throw new RateLimitExceededException(target.getName());
        }
        return pjp.proceed();
    }
}
```

Three production-grade details in that aspect: resolving the **most specific method** (interface method vs implementation method on a proxy), using `AnnotatedElementUtils` rather than `getAnnotation`, and caching the derived object keyed by `Method` so annotation lookup is not on the hot path.

### Spring's merged and synthesized annotations

Plain reflection has no notion of meta-annotations. `@RestController` is annotated with `@Controller` and `@ResponseBody`, but `clazz.getAnnotation(Controller.class)` on a `@RestController` class returns **null**. Spring builds its own search:

```java
// direct only — usually the wrong tool in a Spring codebase
Transactional t1 = method.getAnnotation(Transactional.class);

// searches meta-annotations on the element itself
Transactional t2 = AnnotatedElementUtils.getMergedAnnotation(method, Transactional.class);

// ALSO searches superclasses, interfaces, and overridden methods
Transactional t3 = AnnotatedElementUtils.findMergedAnnotation(method, Transactional.class);

// modern unified API (Spring 5.2+), with explicit search strategy
Transactional t4 = MergedAnnotations
        .from(method, MergedAnnotations.SearchStrategy.TYPE_HIERARCHY)
        .get(Transactional.class)
        .synthesize();
```

`get*` = local + meta-annotations. `find*` = the full hierarchy. Getting this wrong is why a `@Transactional` on an interface method or a base class sometimes appears to be ignored by *your* code while Spring itself honours it.

**Attribute merging and `@AliasFor`.** Spring lets a composed annotation override a meta-annotation's attributes:

```java
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
@Transactional(readOnly = true)                 // meta-annotation with a preset
public @interface ReadOnlyTx {
    @AliasFor(annotation = Transactional.class, attribute = "timeout")
    int timeout() default 5;
}

@ReadOnlyTx(timeout = 30)
public List<Order> report() { ... }
```

`AnnotatedElementUtils.findMergedAnnotation(method, Transactional.class)` returns a **synthesized** `Transactional` whose `readOnly()` is `true` and `timeout()` is `30`. That instance is a Spring-generated proxy (`SynthesizedAnnotation`), not the JDK's — which is why `getClass()` differs and why `equals` against a raw JDK annotation instance can surprise you (Spring implements it to compare by attributes, so it usually works).

### Annotation binary compatibility

Adding a member **without** a default to an existing annotation is a binary-incompatible change. Classes compiled against the old version have no value for it:

```
java.lang.annotation.IncompleteAnnotationException: com.acme.Audited missing element severity
```

Changing a member's type produces `AnnotationTypeMismatchException` at read time. Removing a member causes `NoSuchMethodError` in code that reads it. In a multi-module monolith with independent build cadences, always add members **with defaults**.

### Production scenario: `@Audited` never fired

**Problem.** A compliance requirement: every method annotated `@Audited` writes an audit row. The aspect worked in a spike, then stopped working after the annotation moved into a shared `common-annotations` module. No error; audit table simply empty for the new services.

**Cause.** During the move, the `@Retention(RUNTIME)` line was dropped (a merge conflict resolution). The default `CLASS` retention means the annotation exists in the bytecode but `getAnnotation` returns null. Nothing fails — the aspect's pointcut simply never matches.

**Solution — restore retention and make it untestable-to-regress:**

```java
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.TYPE})
@Inherited
@Documented
public @interface Audited { String action(); }
```

```java
// meta-test in the shared module: annotations that frameworks read MUST be RUNTIME
@Test
void framework_annotations_are_runtime_retained() {
    Set<Class<?>> annotations = new Reflections("com.acme.common.annotation")
            .getTypesAnnotatedWith(FrameworkRead.class);   // internal marker
    assertThat(annotations).isNotEmpty();
    assertThat(annotations).allSatisfy(a -> {
        Retention r = a.getAnnotation(Retention.class);
        assertThat(r).as("%s must declare @Retention", a).isNotNull();
        assertThat(r.value()).isEqualTo(RetentionPolicy.RUNTIME);
    });
}

// and an integration test that proves the aspect actually fires
@Test
void audited_method_writes_audit_row() {
    service.deleteCustomer(1L);
    assertThat(auditRepository.findAll()).extracting(AuditRow::action).containsExactly("DELETE_CUSTOMER");
}
```

The lesson generalizes: **an annotation-driven feature that silently does nothing when misconfigured needs a test that asserts the effect, not the annotation.**

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Missing `@Retention(RUNTIME)` | Annotation invisible to reflection; feature silently off |
| `getAnnotation` on a `@Repeatable` | Returns null once a second copy exists |
| `anno.getClass()` instead of `anno.annotationType()` | Meta-annotation checks always false (`$Proxy12` has none) |
| Expecting `@Inherited` on methods or interfaces | Annotation not found on subclass/implementation |
| `getAnnotation` where `AnnotatedElementUtils.findMergedAnnotation` is needed | Composed/meta annotations (`@RestController`, `@ReadOnlyTx`) ignored |
| Annotation read from the **proxy** method instead of the target method | Missing on JDK-proxied beans (interface method has no annotation) |
| New annotation member without a default | `IncompleteAnnotationException` in older-compiled modules |
| `@Target` omitted | Annotation placeable anywhere, including places your processor ignores |

### Debugging scenario

**Observe.** `@Transactional` on a method of a Spring bean appears to have no effect for one specific bean.

**Diagnose.** Dump what the framework can actually see:

```java
Class<?> targetClass = AopProxyUtils.ultimateTargetClass(bean);
log.info("bean={} proxy={} target={}", bean.getClass(), AopUtils.isAopProxy(bean), targetClass);
for (Method m : targetClass.getDeclaredMethods()) {
    Transactional t = AnnotatedElementUtils.findMergedAnnotation(m, Transactional.class);
    log.info("  {} tx={} propagation={}", m.getName(), t != null,
             t != null ? t.propagation() : "-");
}
```

If `findMergedAnnotation` finds it but nothing happens at runtime, the annotation is fine and the **proxy** is the problem — go to [How Spring Uses Proxies](#11-how-spring-uses-proxies). If `findMergedAnnotation` returns null, it is a retention/placement problem: check the annotation is `org.springframework.transaction.annotation.Transactional` and not `jakarta.transaction.Transactional` with different defaults, and that the method is `public` (with the default proxy mode, non-public methods are not advised).

---

## 8. Annotation Processing at Compile Time

### Core concept

Annotation processing (APT, JSR 269) runs **inside javac**. A processor sees a semantic model of the code (`Element`, `TypeMirror`) and may **generate new source or class files**. It may not modify existing source — that is the contract, and it is what makes APT safe and incremental-friendly.

Compare the three ways to add behaviour:

| Approach | When | Sees | Can change existing code | Runtime cost | Debuggability |
|---|---|---|---|---|---|
| APT (MapStruct, Dagger, Immutables) | compile | source model | no (generates new files) | zero | generated source is readable |
| Runtime reflection (Spring, Jackson) | runtime | loaded classes | no | lookup + invoke | opaque |
| Bytecode weaving (AspectJ, Hibernate enhancement, Lombok) | compile/load/runtime | bytecode/AST | **yes** | zero–low | hard |

### Writing a processor

```java
@SupportedAnnotationTypes("com.acme.GenerateBuilder")
@SupportedSourceVersion(SourceVersion.RELEASE_17)
public class BuilderProcessor extends AbstractProcessor {

    @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {
        for (Element e : roundEnv.getElementsAnnotatedWith(GenerateBuilder.class)) {
            if (e.getKind() != ElementKind.CLASS) {
                processingEnv.getMessager().printMessage(
                    Diagnostic.Kind.ERROR, "@GenerateBuilder only on classes", e);
                continue;                        // report and continue; never throw
            }
            try {
                writeBuilder((TypeElement) e);
            } catch (IOException ex) {
                processingEnv.getMessager().printMessage(Diagnostic.Kind.ERROR,
                    "failed to generate builder: " + ex.getMessage(), e);
            }
        }
        return true;      // true = these annotations are CLAIMED, later processors won't see them
    }

    private void writeBuilder(TypeElement type) throws IOException {
        String pkg = processingEnv.getElementUtils().getPackageOf(type).getQualifiedName().toString();
        String simple = type.getSimpleName() + "Builder";

        List<VariableElement> fields = ElementFilter.fieldsIn(type.getEnclosedElements()).stream()
            .filter(f -> !f.getModifiers().contains(Modifier.STATIC))
            .toList();

        JavaFileObject file = processingEnv.getFiler()
            .createSourceFile(pkg + "." + simple, type);          // originating element -> incremental
        try (PrintWriter out = new PrintWriter(file.openWriter())) {
            out.printf("package %s;%n%n", pkg);
            out.printf("public final class %s {%n", simple);
            for (VariableElement f : fields) {
                out.printf("  private %s %s;%n", f.asType(), f.getSimpleName());
            }
            for (VariableElement f : fields) {
                out.printf("  public %s %s(%s v) { this.%s = v; return this; }%n",
                    simple, f.getSimpleName(), f.asType(), f.getSimpleName());
            }
            out.printf("  public %s build() { ... }%n", type.getSimpleName());
            out.println("}");
        }
    }
}
```

Registration (pick one):

```
# src/main/resources/META-INF/services/javax.annotation.processing.Processor
com.acme.BuilderProcessor
```

```java
@AutoService(Processor.class)     // Google auto-service generates the file above
public class BuilderProcessor extends AbstractProcessor { }
```

### Rounds

javac runs processors in **rounds**. Round 1 sees your source. If a processor generates new sources, those are compiled in round 2 and processors run again on them — which is how a generated class can itself be annotated and trigger further generation. A final round runs with `roundEnv.processingOver() == true` and no new inputs; that is where aggregating processors write their summary file.

```java
@Override
public boolean process(Set<? extends TypeElement> annos, RoundEnvironment env) {
    if (env.processingOver()) {
        writeRegistry(collected);   // one file listing everything seen across rounds
        return true;
    }
    collected.addAll(env.getElementsAnnotatedWith(Handler.class));
    return true;
}
```

Two hard rules: **never generate the same file twice** (`FilerException: Attempt to recreate a file`), and **never read the content of files you generated** — use accumulated state instead.

### Incremental compilation

Gradle only compiles what changed if the processor declares how it behaves:

```
# src/main/resources/META-INF/gradle/incremental.annotation.processors
com.acme.BuilderProcessor,isolating
com.acme.RegistryProcessor,aggregating
```

- **isolating** — each generated file depends on exactly **one** originating element (the common case: one builder per annotated class). Gradle can recompile just that file. You must pass the originating element to `createSourceFile`.
- **aggregating** — output depends on many inputs (a registry, a service index). Any change re-runs it.
- **undeclared** — Gradle falls back to **full recompilation** of the source set every time. On a large module this alone can add tens of seconds to every incremental build.

A processor that does not declare itself is the most common cause of "our build got slow and nobody knows why."

### Why Lombok is not a normal annotation processor

Lombok registers as an annotation processor, but it does **not** generate new files. It reaches into javac's internal AST (`com.sun.tools.javac.tree.JCTree`) and **mutates the trees of your existing classes** so that `@Getter` adds a method to the class being compiled. That is explicitly outside the JSR 269 contract.

Consequences, all of which are real production/CI issues:

| Consequence | Detail |
|---|---|
| JDK coupling | Depends on `jdk.compiler` internals. Every major JDK release risks breakage; Lombok 1.18.20+ was required for JDK 16, further updates for 17/21/23. A JDK upgrade is gated on a Lombok upgrade. |
| Module opens | On JDK 16+ Lombok self-injects `--add-opens jdk.compiler/...`. If that mechanism is blocked (some hardened builds, some IDEs), compilation fails with `IllegalAccessError` in `com.sun.tools.javac`. |
| Tool disagreement | Any tool that parses source rather than bytecode (some SAST scanners, older SonarQube analyzers, javadoc, some IDE inspections) does not see generated members. |
| Processor ordering | Other processors may run before Lombok's mutation and see a class without the generated methods. MapStruct + Lombok is the classic case; it requires `lombok-mapstruct-binding` on the processor path in the right order. |
| Delombok required | To publish sources, run coverage on generated code, or feed another tool, you need `delombok`. |
| Not a compile-time contract | `@Builder` on a class whose fields change silently changes the builder's API without any source diff. |

None of this means "never use Lombok" — it means the risk is **build-toolchain risk**, and it should be tracked as such: pin the version, upgrade it *before* a JDK upgrade, and know that `mapstruct` + `lombok` ordering will bite.

Well-behaved processors, for contrast:

| Processor | Generates | Notes |
|---|---|---|
| MapStruct | Mapper implementation classes | Pure source generation; the generated mapper is plain readable Java, debuggable, zero reflection at runtime |
| Dagger 2 | DI component/factory classes | Compile-time DI — dependency graph errors are *compile errors*, not startup failures |
| Immutables / AutoValue | Value classes | Isolating; strong equals/hashCode/builders |
| Hibernate JPA Metamodel | `Order_` static metamodel | Enables type-safe Criteria queries |
| Micronaut / Quarkus | Bean definitions, reflection-free wiring | The whole point: move Spring-style work from runtime to compile time for fast startup and native images |

### Production scenario: MapStruct mappers silently mapping nulls after adding Lombok

**Problem.** A team added Lombok `@Data` to DTOs that MapStruct already mapped. The build succeeded. In production, every mapped field came out `null`.

**Cause.** Annotation processors run in an order determined by the processor path. MapStruct ran **before** Lombok mutated the AST, so MapStruct saw DTO classes with fields but **no getters or setters**. MapStruct generated a mapper that compiled (it had nothing to call) and mapped nothing. The only hint was a build warning about unmapped target properties that was not failing the build.

**Solution.**

```xml
<plugin>
  <artifactId>maven-compiler-plugin</artifactId>
  <configuration>
    <annotationProcessorPaths>
      <path><groupId>org.projectlombok</groupId>
            <artifactId>lombok</artifactId><version>${lombok.version}</version></path>
      <path><groupId>org.projectlombok</groupId>
            <artifactId>lombok-mapstruct-binding</artifactId><version>0.2.0</version></path>
      <path><groupId>org.mapstruct</groupId>
            <artifactId>mapstruct-processor</artifactId><version>${mapstruct.version}</version></path>
    </annotationProcessorPaths>
    <compilerArgs>
      <arg>-Amapstruct.unmappedTargetPolicy=ERROR</arg>   <!-- fail the build, not production -->
    </compilerArgs>
  </configuration>
</plugin>
```

`lombok-mapstruct-binding` exists solely to force the ordering. Setting `unmappedTargetPolicy=ERROR` turns the silent failure into a compile error — the single most valuable line in that config.

Verify by reading the generated source, which is the great advantage of APT over reflection:

```bash
cat target/generated-sources/annotations/com/acme/OrderMapperImpl.java
```

If the generated `toDto` method body is empty, the processor ordering is still wrong.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No `META-INF/services` entry and no `@AutoService` | Processor never runs; no error at all |
| Missing `incremental.annotation.processors` declaration | Full recompilation every build; slow CI |
| Not passing originating elements to `createSourceFile` | Gradle downgrades isolating → full recompile |
| Generating the same file in two rounds | `FilerException: Attempt to recreate a file` |
| Throwing from `process()` | `java.lang.RuntimeException` from javac with no user-facing message; use `Messager` |
| Lombok + MapStruct without the binding | Mappers generate empty method bodies |
| `mapstruct.unmappedTargetPolicy` left at WARN | Silent data loss in production |
| Dependency on `tools.jar` / `com.sun.*` in your own processor | Breaks on the next JDK |
| Mixing `annotationProcessorPaths` and processors on the compile classpath | Non-deterministic ordering across machines |

### Debugging scenario

**Observe.** Generated code is missing for one module in a multi-module build, and only in CI.

**Diagnose.**

```bash
# is the processor even discovered?
mvn -X compile | grep -i "annotation processor"
javac -verbose ...                              # lists processors loaded

# what did it generate?
ls -R target/generated-sources/annotations/
./gradlew compileJava --info | grep -i processor
```

Common findings: the module declares `<proc>none</proc>`, or an IDE-only setting differs; the processor is on the **compile classpath** in one module and `annotationProcessorPaths` in another (mixing the two disables classpath discovery); or an `-Werror` + `-Xlint` combination turns a processor warning into a failure only under the CI profile.

**Fix.** Declare processors exclusively via `annotationProcessorPaths` (Maven) / `annotationProcessor` (Gradle), never on the compile classpath. Pin versions. Add a build check that a known generated file exists.

---

## 9. JDK Dynamic Proxies

### Core concept

`java.lang.reflect.Proxy` creates a **runtime-generated class** that implements one or more **interfaces**. Every method call on the proxy is routed to a single `InvocationHandler.invoke(Object proxy, Method method, Object[] args)` callback. That is the entire mechanism behind Spring's interface-based AOP, JPA lazy-loading proxies, Mockito interface mocks, and annotation instances.

```
Client code
    │
    ▼
$Proxy42 implements OrderService  ← generated at runtime by ProxyGenerator
    │
    ▼
InvocationHandler.invoke(proxy, method, args)
    │
    ├── before advice (logging, security, tx begin)
    ├── target.someMethod(args)   ← the real bean
    └── after advice (tx commit, metrics)
```

JDK proxies are **interface-only**. They cannot subclass a concrete class. They cannot intercept `final` methods (there is no override). They cannot intercept methods declared on `Object` (`equals`, `hashCode`, `toString`) unless you explicitly handle them in the handler — the generated class inherits `Object` implementations, not the target's.

### Creating a JDK proxy

```java
OrderService target = new OrderServiceImpl();

OrderService proxy = (OrderService) Proxy.newProxyInstance(
    target.getClass().getClassLoader(),          // usually the target's loader
    new Class<?>[] { OrderService.class },       // every interface the proxy must implement
    (proxyInstance, method, args) -> {
        if (method.getDeclaringClass() == Object.class) {
            // without this, equals/hashCode/toString hit the handler for every proxy
            return method.invoke(target, args);
        }
        log.info("→ {}", method.getName());
        try {
            return method.invoke(target, args);
        } finally {
            log.info("← {}", method.getName());
        }
    }
);
```

`Proxy.newProxyInstance` does three things:

1. Looks up or generates a proxy class for the given interface set + classloader (cached per loader + interface combination).
2. Calls the proxy class's constructor with your `InvocationHandler`.
3. Returns the instance, castable to any of the declared interfaces.

The generated class name is `$ProxyN` in the package `com.sun.proxy` (JDK 8) or unnamed module (JDK 9+). You will see it in heap dumps and thread dumps.

### What the generated bytecode looks like

Conceptually, for each interface method `void pay(String id)`:

```java
public final void pay(String id) {
    try {
        Method m = OrderService.class.getMethod("pay", String.class);
        h.invoke(this, m, new Object[] { id });
    } catch (Throwable t) {
        throw new UndeclaredThrowableException(t);
    }
}
```

Every call pays: method lookup (cached after first call in modern JDKs), array allocation for args, handler dispatch, reflective `Method.invoke` on the target. That is why CGLIB/ByteBuddy exist for hot paths — but for framework interception (transactions, once-per-request) the cost is negligible.

### Limitations that bite in production

| Limitation | Consequence |
|---|---|
| Interfaces only | `@Service` on a class with no interface → Spring uses CGLIB subclass instead |
| No `final` class/method | `final void pay()` cannot be intercepted by any proxy |
| `Object` methods | Two proxies wrapping the same target are **not** `equals` unless you delegate |
| Checked exceptions | Handler must not throw checked exceptions the method doesn't declare — `UndeclaredThrowableException` wraps them |
| Classloader | Proxy class is defined in the **caller's** loader; wrong loader → `ClassCastException` across modules |
| Generic return types | Handler returns `Object`; you cast. Wrong type → `ClassCastException` at the call site, not in the handler |

### Production scenario: proxy `equals` breaks a `HashSet`

**Problem.** A cache keyed by `Set<AuditedService>` never deduplicates, even though the wrapped targets are the same instance.

**Cause.** The default handler forwards `equals` to the **target**, but the **caller** compares two **proxy** instances. `proxy1.equals(proxy2)` calls `target1.equals(target2)` which is `false` (different proxy wrappers, same target). Or worse: `proxy1.equals(proxy1)` calls `target.equals(target)` which is `true`, but `proxy1.equals(proxy2)` with the same target returns `false`.

**Fix.** Always delegate `Object` methods to the proxy instance itself, not the target:

```java
if (method.getDeclaringClass() == Object.class) {
    return method.invoke(proxyInstance, args);   // proxy's own identity
}
```

Spring's `JdkDynamicAopProxy` does exactly this. Hand-rolled proxies often forget it.

### When JDK proxies are the right choice

- The bean already has an interface (repository, client, service API).
- You want a smaller metaspace footprint than a CGLIB subclass per class.
- You are on a platform that forbids subclassing (some security managers, some GraalVM configs).
- You are mocking with Mockito in interface-only style.

---

## 10. Bytecode Generation Proxies (CGLIB, ByteBuddy)

### Core concept

When there is no interface to implement, frameworks **subclass** the concrete type at runtime and **override** non-final methods to insert interception logic. Spring calls this "CGLIB proxying" (historically via `cglib:cglib`, now repackaged inside `spring-core`). Mockito, Hibernate lazy loading, and ByteBuddy-based tools use the same technique with different bytecode libraries.

```
Client code
    │
    ▼
OrderService$$SpringCGLIB$$0 extends OrderService   ← subclass, NOT an interface impl
    │
    ▼
CGLIB MethodInterceptor.intercept(obj, method, args, methodProxy)
    │
    ├── advice chain
    └── methodProxy.invokeSuper(obj, args)   ← calls the REAL superclass method
```

The critical difference from JDK proxies: the client holds a **subclass instance**. `instanceof OrderService` is true. No interface is required.

### CGLIB / Spring CGLIB essentials

```java
Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(OrderService.class);
enhancer.setCallback((MethodInterceptor) (obj, method, args, methodProxy) -> {
    log.info("→ {}", method.getName());
    Object result = methodProxy.invokeSuper(obj, args);   // bypasses the override
    log.info("← {}", method.getName());
    return result;
});
OrderService proxy = (OrderService) enhancer.create();
```

`invokeSuper` is not `Method.invoke`. It calls the **original superclass implementation** through a generated fast path, without re-entering the interceptor. Using `method.invoke(obj, args)` on a CGLIB proxy **re-enters the interceptor** → infinite recursion or double advice.

### What cannot be proxied

| Construct | Why |
|---|---|
| `final` class | Cannot subclass |
| `final` method | Cannot override |
| `private` method | Not overridable; invisible to subclass |
| Package-private method in another package | Subclass in `com.sun.proxy` or generated package may not override |
| Constructor | Not intercepted — `new OrderService()` bypasses the proxy entirely |

Spring Boot 3 / Spring Framework 6 requires **Spring AOT** or runtime CGLIB for class-based proxies. The warning `Bean 'foo' is not eligible for getting processed by all BeanPostProcessors` often means the bean was instantiated too early, before the proxy infrastructure was ready.

### ByteBuddy: the modern bytecode toolkit

CGLIB is in maintenance mode. New tools use ByteBuddy:

```java
OrderService proxy = new ByteBuddy()
    .subclass(OrderService.class)
    .method(ElementMatchers.named("pay"))
    .intercept(MethodDelegation.to(new PayInterceptor()))
    .make()
    .load(OrderService.class.getClassLoader(), ClassLoadingStrategy.Default.WRAPPER)
    .getLoaded()
    .getDeclaredConstructor()
    .newInstance();
```

Mockito 2+, Hibernate 6 enhancers, and many agents use ByteBuddy because it supports Java 17+ features (nest mates, records, sealed classes) and produces cleaner bytecode than legacy CGLIB.

### JDK proxy vs CGLIB / ByteBuddy

| | JDK `Proxy` | CGLIB / ByteBuddy subclass |
|---|---|---|
| Requires interface | Yes | No |
| `instanceof` concrete class | No (only interface) | Yes |
| Metaspace per type | One `$Proxy` per interface set | One subclass per concrete class |
| `final` methods | N/A (interface) | Not intercepted |
| Construction | Lightweight | Heavier (generates class, runs `<clinit>`) |
| Serialization | Awkward (proxy class unknown to remote) | Awkward unless configured |
| GraalVM native | Needs reflection config for generated class | Needs runtime-init or build-time hint |

### Production scenario: `@Transactional` on a `final` method

**Problem.** Developer marks `public final void process()` with `@Transactional`. Tests pass (no real DB). Production shows no transaction boundary — partial commits, no rollback on failure.

**Cause.** Spring AOP cannot override `final` methods. The annotation is silently ignored for proxying purposes (Spring may log at DEBUG: "Unable to proxy interface-implementing methods marked as final").

**Fix.** Remove `final`, or move transactional logic to a separate non-final method / separate bean. Prefer interface-based design so JDK proxying applies and the limitation is visible in code review.

---

## 11. How Spring Uses Proxies (self-invocation trap, 3 fixes)

### Core concept

Spring wraps `@Transactional`, `@Cacheable`, `@Async`, `@Retryable`, and security annotations around beans using AOP proxies. The container injects the **proxy**, not the raw target. Any call that does not go through the proxy reference skips all advice.

```
@Autowired OrderService svc;   // svc is OrderService$$SpringCGLIB$$0

svc.pay("ORD-1");              // ✅ enters TransactionInterceptor

// inside OrderService:
public void pay(String id) {
    this.validate(id);         // ❌ this is the TARGET, not the proxy
    this.doPay(id);            // ❌ @Transactional on doPay is IGNORED
}
```

This is the **self-invocation trap**. It is the #1 "why doesn't my `@Transactional` work?" cause in production, and it has nothing to do with transaction manager configuration.

### How Spring chooses JDK vs CGLIB

| Condition | Proxy type |
|---|---|
| Bean implements an interface AND `spring.aop.proxy-target-class=false` (Boot 2 default) | JDK proxy |
| `spring.aop.proxy-target-class=true` (Boot 2.1+ default) | CGLIB even with interfaces |
| No interface | CGLIB (mandatory) |
| `@Scope(proxyMode = INTERFACES)` | JDK |
| `@Scope(proxyMode = TARGET_CLASS)` | CGLIB |

Boot 3 defaults to `proxy-target-class=true`. Injecting `OrderService` where the bean implements `OrderService` still gives you a CGLIB subclass in most apps.

### Fix 1: Inject self or split the bean

**Split bean (preferred).** Move `doPay()` to `OrderPaymentHandler` with its own `@Transactional`. `OrderService` calls the handler through the injected proxy.

```java
@Service
@RequiredArgsConstructor
class OrderService {
    private final OrderPaymentHandler paymentHandler;   // proxy

    public void pay(String id) {
        validate(id);
        paymentHandler.doPay(id);   // ✅ transactional boundary here
    }
}

@Service
class OrderPaymentHandler {
    @Transactional
    public void doPay(String id) { /* ... */ }
}
```

**Self-injection (works, smells).** Inject the proxied interface into itself:

```java
@Service
public class OrderService implements OrderServiceApi {
    @Lazy @Autowired private OrderServiceApi self;   // the proxy

    public void pay(String id) {
        self.doPay(id);   // ✅ goes through proxy
    }

    @Transactional
    public void doPay(String id) { /* ... */ }
}
```

`@Lazy` avoids the circular dependency at construction time. Use only when splitting is impractical.

### Fix 2: `AopContext.currentProxy()`

Enable expose-proxy:

```java
@EnableAspectJAutoProxy(exposeProxy = true)
```

Then inside the class:

```java
((OrderService) AopContext.currentProxy()).doPay(id);
```

**Downsides.** Ties business code to Spring AOP. Fails if called outside an active proxy context. Hard to test without `SpringExtension`. Prefer bean split.

### Fix 3: AspectJ compile-time / load-time weaving

```xml
<dependency>
  <groupId>org.springframework</groupId>
  <artifactId>spring-aspects</artifactId>
</dependency>
```

```java
@EnableAspectJAutoProxy(mode = AdviceMode.ASPECTJ)
```

AspectJ weaves advice **into the bytecode** of `OrderService` itself. `this.doPay()` is intercepted because the call site is woven, not because of a proxy indirection. Used in performance-sensitive apps and when self-invocation cannot be refactored away. Requires the AspectJ weaver agent or post-compile weaving — heavier build setup.

### Other Spring proxy gotchas

| Gotcha | Detail |
|---|---|
| `new OrderService()` inside a `@Configuration` | Not a Spring bean; no proxy |
| Calling `@Transactional` from same class `private` method | Never proxied (even with CGLIB — private methods aren't overridden) |
| `@Transactional` on `protected` method | CGLIB can intercept; JDK proxy cannot (not on interface) |
| `@Async` self-call | Same trap as `@Transactional` |
| `@Cacheable` on internal method | Cache miss every time if called via `this` |
| Injecting concrete class vs interface | With `proxy-target-class=true`, both get CGLIB; with false, interface injection gets JDK proxy |

### Production scenario: rollback never happens

**Observe.** Integration test calls `orderService.pay()` directly — rollback works. Production endpoint calls `orderService.checkout()` which internally calls `this.pay()` — partial DB writes persist on exception.

**Diagnose.**

```bash
# confirm proxy type
curl localhost:8080/actuator/beans | jq '.contexts.application.beans.orderService'
# scope: singleton, type: OrderService$$SpringCGLIB$$0

# enable Spring transaction debug
logging.level.org.springframework.transaction=DEBUG
logging.level.org.springframework.orm.jpa=DEBUG
```

Log shows `Creating new transaction` for the test's direct `pay()` call but **no** transaction log for the internal `this.pay()` path.

**Fix.** Extract `pay()` to `OrderPaymentService` or use self-injection. Add an ArchUnit test:

```java
@ArchTest
static final ArchRule noTransactionalSelfCalls = noClasses()
    .should(callMethod(where(target(owner(assignableTo(annotatedWith(Transactional.class))))
        .and(origin(owner(sameClass())))));
```

---

## 12. MethodHandles and VarHandle

### Core concept

`java.lang.invoke.MethodHandle` is the JVM's **typed, optimizable** alternative to `Method.invoke`. Introduced in Java 7 for `invokedynamic` (lambdas, string concatenation). Java 9+ added `VarHandle` for field access. Frameworks that care about reflection performance (Jackson after 2.12, Spring's `ReflectivePropertyAccessor`, record serialization) increasingly prefer handles over raw reflection.

```
Method.invoke                    MethodHandle.invoke
─────────────────────────────────────────────────────────────
Checked exceptions               Unchecked (Wraps in Error)
Per-call security check          Lookup-time access check
Boxing on every call             Signature-polymorphic, JIT-inlinable
~100–300 ns/call (cold)          ~5–20 ns/call (after warmup)
```

### MethodHandles.Lookup

Access is granted at **lookup creation time**, not per invocation:

```java
MethodHandles.Lookup lookup = MethodHandles.privateLookupIn(Order.class, MethodHandles.lookup());

// find a method: (Order, String) -> void
MethodType type = MethodType.methodType(void.class, String.class);
MethodHandle pay = lookup.findVirtual(Order.class, "pay", type);

pay.invoke(orderInstance, "ORD-1");                    // void — use invokeExact for zero conversion
Object ignored = pay.invokeExact(orderInstance, "ORD-1");
```

`privateLookupIn` requires the caller module to **open** the target package (or be in the same module). This is the modern, module-aware replacement for `setAccessible(true)` on methods.

Lookup kinds:

| Factory | Access |
|---|---|
| `MethodHandles.lookup()` | Public methods of caller's class, protected/package in same package |
| `MethodHandles.publicLookup()` | Only public methods of public classes in exported packages |
| `privateLookupIn(Class, Lookup)` | Full access to target if module opens or same module |
| `MethodHandles.privateLookupIn` + `--add-opens` | What frameworks do on JDK 17 |

### VarHandle: fields without `Field.set`

```java
VarHandle STATUS = MethodHandles.lookup()
    .findVarHandle(Order.class, "status", OrderStatus.class);

// plain access
STATUS.set(order, OrderStatus.PAID);

// atomic / ordered access
STATUS.compareAndSet(order, OrderStatus.PENDING, OrderStatus.PAID);
int prev = (int) COUNT_HANDLE.getAndAdd(counter, 1);
```

`VarHandle` supports volatile, atomic, and opaque access modes — the reflection API has no equivalent. Used internally by `java.util.concurrent`, records' `equals`/`hashCode`, and Project Panama.

### LambdaMetafactory: reflection-free functional objects

Lambdas are not reflection. `LambdaMetafactory.metafactory` generates a hidden class at runtime (or compile time with AOT):

```java
// what the compiler generates for: Function<Order, String> f = Order::getId;
CallSite site = LambdaMetafactory.metafactory(
    lookup,
    "apply",
    MethodType.methodType(Function.class),
    MethodType.methodType(Object.class, Object.class),       // erased sam
    lookup.findVirtual(Order.class, "getId", MethodType.methodType(String.class)),
    MethodType.methodType(String.class, Order.class)          // impl
);
Function<Order, String> f = (Function<Order, String>) site.getTarget().invoke();
```

No `Method.invoke`. The JVM inlines `f.apply(order)` to a direct `getId()` call after warmup. This is why `stream().map(Order::getId)` is fast and `stream().map(o -> invokeGetter(o, "getId"))` is not.

### When to use which

| Task | API |
|---|---|
| Framework plugin, one-off utility | `Method.invoke` — fine |
| Hot-path serializer, expression language | `MethodHandle` |
| Atomic field update | `VarHandle` or `AtomicReferenceFieldUpdater` |
| Functional interface from method ref | Compiler + `LambdaMetafactory` (automatic) |
| Bytecode generator | ASM / ByteBuddy directly |

---

## 13. Records and Sealed Types + reflection

### Core concept

Java 16 **records** are final, immutable data carriers. The compiler generates `equals`, `hashCode`, `toString`, accessors, and a canonical constructor. Reflection sees them as ordinary classes with extra metadata via `Class.isRecord()` and `Class.getRecordComponents()`.

Java 17 **sealed** types restrict which classes may extend/implement them. Reflection exposes `Class.getPermittedSubclasses()` and `Class.isSealed()`.

Together they change how frameworks discover shape, construct instances, and pattern-match — but they do **not** remove the need for care around encapsulation and proxies.

### Reflecting on records

```java
public record Order(String id, BigDecimal total, Instant createdAt) {}

Class<Order> clazz = Order.class;
clazz.isRecord();                    // true
RecordComponent[] components = clazz.getRecordComponents();

for (RecordComponent rc : components) {
    rc.getName();                    // "id", "total", "createdAt"
    rc.getType();                    // String, BigDecimal, Instant
    rc.getAccessor();                // MethodHandle to the accessor (Java 16+)
    rc.getGenericType();             // full generic signature
    rc.getAnnotation(NotNull.class); // annotations on the component
}

// canonical constructor
Constructor<Order> ctor = clazz.getDeclaredConstructor(String.class, BigDecimal.class, Instant.class);

// compact constructor is NOT visible — only the canonical one with all components
```

**Trap.** `getDeclaredFields()` returns **private final** fields (`id`, `total`, `createdAt`). Frameworks that blindly reflect fields (older Jackson, hand-rolled mappers) may bypass accessors and break immutability guarantees. Modern Jackson uses record introspection; configure `MapperFeature.USE_GETTERS_AS_SETTERS` off for records.

**Trap.** Records cannot be proxied by CGLIB (final class). `@Transactional` on a record "service" is a design smell — records are DTOs, not beans.

### Reflecting on sealed types

```java
public sealed interface Payment permits CardPayment, BankTransfer, WalletPayment {}
public final class CardPayment implements Payment { /* ... */ }
public final class BankTransfer implements Payment { /* ... */ }
public non-sealed class WalletPayment implements Payment { /* ... */ }

Payment.class.isSealed();                          // true
Class<?>[] permitted = Payment.class.getPermittedSubclasses();
// [CardPayment, BankTransfer, WalletPayment]

CardPayment.class.isSealed();                      // false (final leaf)
WalletPayment.class.isSealed();                    // false (non-sealed breaks sealing)
```

Frameworks use this for:

- **Polymorphic deserialization** — Jackson `@JsonSubTypes` can be generated from sealed permits.
- **Exhaustive routing** — switch on sealed interface with compile-time completeness (Java 21).
- **Schema generation** — OpenAPI oneOf from permitted subclasses.

### Production scenario: record deserialization creates mutable copies

**Problem.** API returns `record OrderDto(String id, List<LineItem> items)`. After deserialization, `dto.items().add(x)` mutates shared state across requests.

**Cause.** Jackson deserialized the `List` as `ArrayList` via the canonical constructor's field injection, not an immutable list. The record is shallowly immutable.

**Fix.**

```java
public record OrderDto(String id, List<LineItem> items) {
    public OrderDto {
        items = List.copyOf(items);   // compact constructor — runs before field assignment
    }
}
```

Or `@JsonDeserialize` with a builder that wraps with `List.copyOf`.

---

## 14. Classloaders hierarchy and debugging

### Core concept

A `ClassLoader` loads bytecode and defines `Class` objects. The **delegation model** (Java 2+) asks the parent loader first, then loads locally. Wrong loader = wrong type = `ClassCastException` with identical class names.

```
Bootstrap (null)     → rt.jar / jimage: java.*, jdk.*
    │
Platform (Ext)     → jdk.* extensions
    │
Application        → your classpath (-cp, -jar manifest Class-Path)
    │
Custom             → Tomcat WebappClassLoader, Spring Boot LaunchedURLClassLoader,
                     OSGi bundle, plugin frameworks, ServiceLoader TCCL
```

`ClassLoader.getSystemClassLoader()` returns the application loader. `Thread.currentThread().getContextClassLoader()` (TCCL) is what `ServiceLoader`, JPA, JAXB, and many libraries use — and what breaks when async threads don't inherit it.

### Three loaders you will debug

| Loader | Where | Typical pain |
|---|---|---|
| `AppClassLoader` | `java -jar`, IDE run | Missing dependency, wrong version on classpath |
| `LaunchedURLClassLoader` | Spring Boot fat jar | `BOOT-INF/classes` vs `BOOT-INF/lib/*.jar` separation |
| `WebappClassLoader` | Tomcat per WAR | Class cast across redeploy, leak on undeploy |

### Reading the hierarchy at runtime

```java
ClassLoader cl = OrderService.class.getClassLoader();
while (cl != null) {
    System.out.println(cl);
    cl = cl.getParent();
}
System.out.println("bootstrap");
```

In a thread dump:

```
"http-nio-8080-exec-1" #42 daemon prio=5 os_prio=0
   java.lang.Thread.State: RUNNABLE
        at com.acme.OrderService.pay(OrderService.java:31)
        ...
```

Add `-verbose:class` at startup to log every loaded class and its loader (noisy but definitive).

### `Class.forName` vs `ClassLoader.loadClass`

| | `Class.forName(name)` | `loader.loadClass(name)` |
|---|---|---|
| Initializes class | Yes (default) | No |
| Loader used | **Caller's** loader (caller-sensitive) | The given loader |
| Checked exception | `ClassNotFoundException` | `ClassNotFoundException` |

In a Tomcat webapp, `Class.forName("com.acme.Plugin")` from a library JAR in `shared/lib` uses the **common** loader, not the webapp loader — class not found or wrong version.

**Fix.** Always pass the loader explicitly:

```java
Class<?> c = Thread.currentThread().getContextClassLoader().loadClass("com.acme.Plugin");
```

### Production scenario: `ClassCastException` after Spring Boot upgrade

**Problem.** `OrderDto cannot be cast to OrderDto` in a `@Async` method after upgrading to Boot 3.

**Cause.** The async executor uses a thread pool whose TCCL is the **platform** loader. Code in the async task loads `OrderDto` via TCCL from a different copy than the main thread's `LaunchedURLClassLoader`.

**Fix.**

```java
@Bean
public TaskExecutor applicationTaskExecutor() {
    ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
    ex.setTaskDecorator(runnable -> {
        ClassLoader cl = Thread.currentThread().getContextClassLoader();
        return () -> {
            ClassLoader prev = Thread.currentThread().getContextClassLoader();
            Thread.currentThread().setContextClassLoader(cl);
            try { runnable.run(); }
            finally { Thread.currentThread().setContextClassLoader(prev); }
        };
    });
    return ex;
}
```

---

## 15. ClassLoader leaks (Tomcat redeploy Metaspace)

### Core concept

Classes are garbage-collected only when their **defining ClassLoader** is unreachable. A single stray reference to a `WebappClassLoader` pins **every class** it loaded — thousands of classes, megabytes to gigabytes of Metaspace, until the JVM runs out or you restart.

Tomcat redeploy without restart is the classic production scenario: deploy v1 → deploy v2 → Metaspace climbs → `OutOfMemoryError: Metaspace` after N redeploys.

### What pins the loader

| Pin holder | How it happens |
|---|---|
| `Thread` with non-null `contextClassLoader` | Pool thread created during request; loader set to webapp CL |
| `ThreadLocal` | JDBC driver registration, `SimpleDateFormat` in a static ThreadLocal, Log4j context |
| JDBC `DriverManager` | `DriverManager` is a **static** registry; drivers registered from webapp CL |
| `java.beans.Introspector` | Caches `BeanInfo` keyed by class → pins loader |
| `java.lang.reflect.Proxy` cache | Proxy class cached per loader + interface set |
| Scheduled tasks / timers | `java.util.Timer`, `ScheduledExecutorService` holding runnable from webapp |
| JNDI `InitialContext` | Custom objects in naming context |
| `org.apache.catalina.loader.WebappClassLoader` itself | Reference from a `HashMap` in a singleton |

### The ThreadLocal + Thread pool leak (step by step)

```
1. Request hits webapp → Tomcat assigns http-nio-exec-3
2. Webapp code sets ThreadLocal<SimpleDateFormat> (or any webapp class)
3. Pool thread returns to pool — ThreadLocal NOT cleared
4. Thread holds reference → WebappClassLoader v1
5. Redeploy creates WebappClassLoader v2
6. v1 cannot be GC'd — 50 redeploys → Metaspace exhausted
```

### Detection

```bash
# Metaspace trend
jcmd <pid> VM.metaspace

# who holds the loader?
jmap -dump:live,format=b,file=heap.hprof <pid>
# open in Eclipse MAT → Leak Suspects → "ClassLoader" dominator tree

# Tomcat-specific: enable leak detection
org.apache.catalina.loader.WebappClassLoader.ENABLE_CLEAR_REFERENCES=true
```

In MAT, look for:

- One `WebappClassLoader` instance with a **disposed** context name still in the dominator tree.
- `java.lang.Thread` → `contextClassLoader` → old webapp loader.
- `java.lang.ThreadLocal$ThreadLocalMap` → entry value referencing a webapp class.

### Prevention checklist

```java
// 1. Clear ThreadLocals in a filter (last in chain)
public void doFilter(...) {
    try { chain.doFilter(req, res); }
    finally { ThreadLocalCleaner.clear(); }   // your registry of ThreadLocals
}

// 2. Deregister JDBC drivers on shutdown
ServletContextListener:
    Enumeration<Driver> drivers = DriverManager.getDrivers();
    while (drivers.hasMoreElements()) {
        Driver d = drivers.nextElement();
        if (d.getClass().getClassLoader() == getClass().getClassLoader()) {
            DriverManager.deregisterDriver(d);
        }
    }

// 3. Introspector cleanup
Introspector.flushCaches();

// 4. Shutdown hooks / executors in @PreDestroy
executor.shutdownNow();

// 5. Don't put application classes in shared/lib — only true shared APIs
```

Spring Boot executable WAR on Tomcat still suffers this if you redeploy without restarting the JVM. **Restart the JVM** on deploy in production unless you have verified leak-free undeploy.

---

## 16. Reflection performance

### Core concept

Reflection is slower than direct calls — but "how much slower" depends entirely on **warmup**, **access checks**, and **whether you repeat the same operation**. A framework that looks up `Method` once at startup and invokes it a million times per second is a different problem from code that calls `getDeclaredMethod` inside a request handler.

### Rough cost model (JDK 17+, server JVM, after C2 warmup)

| Operation | Cold (first call) | Warm (cached, accessible) |
|---|---|---|
| Direct virtual call | ~1 ns | ~1 ns |
| `MethodHandle.invokeExact` | ~50 ns | ~2–5 ns |
| `Method.invoke` | ~200–400 ns | ~20–80 ns |
| `Field.get` / `set` | ~150–300 ns | ~15–50 ns |
| `Class.forName` + `newInstance` | ~10–100 µs | — |
| `getDeclaredMethod` (lookup) | ~1–10 µs | cache it |

Numbers vary by JDK version, CPU, and whether `setAccessible(true)` was called. Treat them as order-of-magnitude, not benchmarks.

### What makes reflection slow

1. **Security / access checks** — `Method.invoke` checks caller access on every call unless suppressed via `setAccessible` or module opens.
2. **Boxing** — `invoke(Object, Object...)` boxes primitives; return values are `Object`.
3. **No inline until warmup** — C2 must see a stable target before devirtualizing.
4. **Allocation** — `Object[]` for args, `InvocationTargetException` on failure path.
5. **Megamorphic call sites** — if you reflectively call 100 different methods through one `Method` variable, JIT gives up on inlining.

### Optimization patterns

```java
// BAD: lookup inside hot loop
for (Order o : orders) {
    Method m = Order.class.getMethod("getId");   // lookup every iteration
    m.invoke(o);
}

// GOOD: cache Method / MethodHandle at startup
private static final MethodHandle GET_ID = lookup()
    .findVirtual(Order.class, "getId", methodType(String.class));

for (Order o : orders) {
    GET_ID.invoke(o);
}
```

```java
// Spring's approach: ConcurrentReferenceHashMap<Class<?>, ReflectionUtils.MethodCallback>
// Jackson: BeanDescription built once per type, serializers cached
// Hibernate: bytecode-enhanced entities avoid reflection on hot getters after enhancement
```

### When reflection performance actually matters

| Scenario | Care level |
|---|---|
| DI container startup (scan 5000 classes) | High — use index, ASM scan without loading |
| ORM hydration (10k rows/sec) | High — bytecode enhancement or MethodHandles |
| JSON serialize per API request | Medium — cached serializers mask cost |
| `@Transactional` interceptor | Low — one reflective hop per service method |
| Test framework discovery | Low — once per suite |
| Annotation read at startup | Low — once per bean |

### Production scenario: GC pressure from reflective DTO mapping

**Problem.** P99 latency spikes on a reporting endpoint that maps 50k rows to DTOs via a generic `BeanUtils.copyProperties` loop.

**Profile.**

```bash
async-profiler -e alloc -d 30 -f alloc.html <pid>
# top: java.lang.reflect.Method.invoke, Object[], boxing
```

**Fix.** Replace with MapStruct (compile-time generated code), or cache `MethodHandle` per property pair at mapper init. P99 dropped from 800ms to 40ms in a typical migration — not because reflection is "slow" in absolute terms, but because 50k × 20 properties × boxing = massive allocation.

---

## 17. GraalVM native image / reflect-config

### Core concept

GraalVM **native-image** performs **closed-world analysis** at build time. Any class, method, constructor, or field accessed only via reflection must be **declared** in configuration files, or the native binary fails at runtime with `MissingReflectionRegistrationError` (GraalVM 22+) or silent `null` / `NoSuchMethodException`.

Spring Boot 3 + `--spring-aot` generates most of this. Hand-rolled reflection, third-party libraries, and dynamic proxies still require manual entries.

### What needs registration

| Reflective use | Config type |
|---|---|
| `Class.forName`, `getDeclaredConstructor().newInstance()` | `reflect-config.json` — constructors |
| `getDeclaredMethod` / `invoke` | `reflect-config.json` — methods |
| `Field.get` / `set` | `reflect-config.json` — fields |
| JDK dynamic proxy | `proxy-config.json` — interface list |
| Resource on classpath (`getResource`) | `resource-config.json` |
| JNI | `jni-config.json` |
| Serialization | `serialization-config.json` |

### reflect-config.json shape

```json
[
  {
    "name": "com.acme.OrderDto",
    "allDeclaredConstructors": true,
    "allDeclaredMethods": true,
    "allDeclaredFields": true,
    "queryAllDeclaredMethods": true
  },
  {
    "name": "com.acme.OrderService",
    "methods": [
      { "name": "pay", "parameterTypes": ["java.lang.String"] }
    ]
  }
]
```

Place under `src/main/resources/META-INF/native-image/com.acme/app/` or pass via `native-image -H:ReflectionConfigurationFiles=...`.

### Discovering missing entries

```bash
# agent during JVM test run — records actual reflection use
java -agentlib:native-image-agent=config-output-dir=src/main/resources/META-INF/native-image ...

# run integration tests, then build native
./mvnw -Pnative native:compile

# typical failure
Exception in thread "main" com.oracle.svm.core.jdk.UnsupportedFeatureError:
  Reflective access to com.acme.internal.Helper is not allowed
```

Spring Boot 3 workflow:

```bash
./mvnw -Pnative spring-boot:build-image
# or
./mvnw package -Pnative -DskipTests
```

`spring-boot-maven-plugin` runs AOT processing that generates `reflect-config.json` for beans, JPA entities, Jackson types, and `@ImportRuntimeHints`.

### RuntimeHints (Spring 6+)

```java
@Configuration
@ImportRuntimeHints(MyHints.class)
class NativeConfig {}

class MyHints implements RuntimeHintsRegistrar {
    @Override
    public void registerHints(RuntimeHints hints, ClassLoader cl) {
        hints.reflection().registerType(OrderDto.class, MemberCategory.INVOKE_DECLARED_CONSTRUCTORS);
        hints.proxies().registerJdkProxy(OrderService.class);
    }
}
```

Prefer `RuntimeHints` over hand-edited JSON — it is type-safe and reviewed in code.

### Native image proxy pitfalls

- CGLIB proxies require **runtime initialization** of the proxy generator or pre-generated subclasses at build time.
- `Proxy.newProxyInstance` needs every interface in `proxy-config.json`.
- Hibernate lazy proxies and Mockito are problematic — use `@MockBean` sparingly in native tests; prefer `@WebMvcTest` with real slices.

---

## 18. Security implications

### Core concept

Reflection is a **capability bypass**. It can read private fields, invoke private methods, instantiate non-public constructors, and break immutability — across module boundaries if opens are granted. Every `setAccessible(true)` and `--add-opens` is a deliberate hole in the encapsulation model.

Security managers are deprecated for removal (JEP 411). The module system and `--illegal-access=deny` are the modern control plane.

### Threat model

| Threat | Mechanism |
|---|---|
| Credential theft | Reflect `private char[] password` on a session object |
| Authorization bypass | Call `private boolean isAdmin()` or mutate a `role` field |
| Deserialization gadget | `readObject` → reflective call chain (Commons Collections) |
| JNDI injection | `lookup` → remote class loading → reflective instantiation |
| Template injection | EL/SpEL evaluates expressions with full reflective access |
| Supply chain | Dependency uses `setAccessible` on `java.lang` internals |

### setAccessible is not a security boundary

```java
Field f = String.class.getDeclaredField("value");
f.setAccessible(true);   // fails on JDK 17+ without --add-opens java.base/java.lang
f.set(str, new char[] { 'p', 'w', 'n' });   // mutates "immutable" String (pre-JDK 12 compact strings made this harder)
```

On JDK 17+, this fails unless the module is opened. **Your application** should not rely on `setAccessible` failing for security — an attacker with arbitrary code execution has worse options. The boundary is **preventing arbitrary code execution**, not hardening against reflection after RCE.

### Defensive practices

```java
// 1. Do not reflect on security-sensitive types
// 2. Validate input before reflective dispatch (plugin frameworks)
public void invokePlugin(String className, String methodName) {
    if (!ALLOWED_PLUGINS.contains(className)) throw new SecurityException();
    if (!ALLOWED_METHODS.get(className).contains(methodName)) throw new SecurityException();
    // then reflect
}

// 3. Use SecurityManager replacement: run untrusted code in isolated process / container
// 4. Minimize --add-opens in production images
// 5. Enable JEP 411 successor checks in your supply chain (jdeps, illegal-access warnings)
```

### SpEL and expression injection

```java
// BUG: user input in expression
@Value("#{systemProperties['user.home']}")          // fine — static
expressionParser.parseExpression(userInput).getValue(context);  // RCE if userInput = 
// T(java.lang.Runtime).getRuntime().exec('calc')
```

**Fix.** Use `SimpleEvaluationContext` (no type references, no constructors) for user-facing expressions. Never pass raw user input to `StandardEvaluationContext`.

### Serialization and reflection

Deserialization instantiates objects without calling public constructors. Gadget chains use reflection to wire attacker-controlled method sequences. Mitigations:

- Do not deserialize untrusted data (`ObjectInputStream` on network input).
- Use allowlists (`ObjectInputFilter`).
- Prefer JSON/protobuf with schema validation over Java serialization.

---

## 19. Testing and debugging reflective code

### Core concept

Reflective code fails **at runtime** with stack traces that point at `Method.invoke`, not your business logic. Tests must exercise the reflective path explicitly, and debug tooling must unwrap `InvocationTargetException` and log the looked-up member.

### Testing patterns

```java
// 1. Test the reflective path, not just the public API
@Test
void shouldInvokePrivateValidator() throws Exception {
    Method m = OrderService.class.getDeclaredMethod("validate", String.class);
    m.setAccessible(true);
    assertThatThrownBy(() -> m.invoke(service, "  "))
        .hasCauseInstanceOf(IllegalArgumentException.class);
}

// 2. Prefer testing through the public contract when possible
@Test
void shouldRejectBlankId() {
    assertThatThrownBy(() -> service.pay("  "))
        .isInstanceOf(IllegalArgumentException.class);
}

// 3. Spring reflection test utilities
ReflectionTestUtils.setField(service, "timeout", Duration.ofSeconds(1));
ReflectionTestUtils.invokeMethod(service, "reload");

// 4. Assert annotation presence
@Test
void shouldBeTransactional() throws NoSuchMethodException {
    Method m = OrderService.class.getMethod("pay", String.class);
    assertThat(m.getAnnotation(Transactional.class)).isNotNull();
    assertThat(m.getAnnotation(Transactional.class).readOnly()).isFalse();
}
```

### Debugging checklist

```java
// unwrap the real cause
catch (InvocationTargetException e) {
    Throwable cause = e.getCause() != null ? e.getCause() : e;
    log.error("Reflective call failed", cause);
    throw cause instanceof RuntimeException re ? re : new RuntimeException(cause);
}

// log what you looked up
log.debug("Invoking {}#{}({})", clazz.getName(), method.getName(),
    Arrays.toString(method.getParameterTypes()));
```

```bash
# see what Spring scanned
logging.level.org.springframework.context.annotation=DEBUG
logging.level.org.springframework.beans.factory=DEBUG

# see proxy creation
logging.level.org.springframework.aop=DEBUG

# illegal reflective access (JDK)
java --illegal-access=warn ...
```

### Useful tools

| Tool | Use |
|---|---|
| `ReflectionTestUtils` | Set private fields, invoke private methods in Spring tests |
| ArchUnit | Enforce "no field injection", "no @Transactional on private methods" |
| `-XX:+TraceClassLoading` | Which loader loaded a class |
| IDE "Evaluate Expression" | `order.getClass().getDeclaredFields()` during breakpoint |
| Bytecode Viewer / javap | `javap -c -p target/classes/com/acme/OrderService.class` |

### Production scenario: test passes, prod fails on `getMethod`

**Cause.** Test uses `OrderService.class.getMethod("pay", String.class)` but production code uses `getDeclaredMethod` on an interface impl where `pay` is not public.

**Fix.** Align lookup with production (`getDeclaredMethod` + `setAccessible`), or test against the interface type the framework uses.

---

## 20. When NOT to use reflection

### Core concept

Reflection is the right tool when **the set of types is unknown at compile time** (frameworks, plugins, serialization). It is the wrong tool when **you own the types** and could call them directly — you pay cost, lose type safety, and break refactoring tools for no gain.

### Do not use reflection when

| Situation | Better alternative |
|---|---|
| Mapping DTO ↔ entity in your codebase | MapStruct, records, manual mapper |
| Calling a method on a known type | Direct call or method reference |
| Switching on a fixed set of types | Sealed interface + switch (exhaustive) |
| Plugin with known SPI | `ServiceLoader` + interface (loads class, but you call interface methods) |
| Configuring beans | `@ConfigurationProperties`, constructor injection |
| Testing private methods | Test via public API; if logic is private, extract class |
| "Cleaner" code without imports | It is not cleaner — it is opaque |
| Avoiding compile-time dependency | Depend on an interface module, not reflection |

### Yellow flags in code review

```java
// 🚩 method name from string config with no validation
Method m = clazz.getMethod(config.get("handler"));
m.invoke(bean);

// 🚩 copying fields generically in domain logic
for (Field f : source.getClass().getDeclaredFields()) {
    f.setAccessible(true);
    f.set(target, f.get(source));
}

// 🚩 newInstance in a request handler
Object handler = Class.forName(req.getParameter("type")).getDeclaredConstructor().newInstance();
```

### When reflection IS justified

- Framework internals (Spring, Hibernate, JUnit) — you are building the framework.
- Generic infrastructure (plugin registry with validated allowlist).
- Serialization libraries (JSON, XML) — type discovery is the product.
- Annotation processors — compile-time, not runtime reflection.
- Interop with JVM languages / scripting (JSR-223) with sandboxed context.
- Testing framework internals.

**Rule of thumb.** If the class names and method names are literals in your source code, you almost certainly should not be reflecting.

---

## 21. Production Debugging Playbook

A ordered checklist for "something reflective/framework-magic broke in prod." Work top to bottom; stop when you find the cause.

### Phase 1: Classify the failure

| Symptom | Likely bucket |
|---|---|
| `ClassNotFoundException` / `NoClassDefFoundError` | Classloader / classpath |
| `ClassCastException` (same class name) | Duplicate class, wrong loader |
| `NoSuchMethodException` / `NoSuchFieldException` | API change, wrong lookup (getMethod vs getDeclaredMethod) |
| `IllegalAccessException` / `InaccessibleObjectException` | Module encapsulation |
| `InvocationTargetException` | Real cause buried — unwrap `getCause()` |
| Annotation "not found" | Retention CLASS not RUNTIME, wrong accessor for repeatable |
| `@Transactional` / `@Cacheable` no-op | Self-invocation, final method, not a Spring bean |
| `MissingReflectionRegistrationError` | GraalVM native config |
| Metaspace OOM after redeploy | ClassLoader leak |

### Phase 2: Gather evidence (5 minutes)

```bash
# Exact exception — full chain
grep -A 30 "Caused by" application.log | tail -50

# Which classloader?
jcmd <pid> Thread.print | grep -A5 "http-nio"

# Is it a proxy?
# In debugger or log: bean.getClass().getName() ends with $$SpringCGLIB$$ or $Proxy

# Module access?
java --version
# look for IllegalAccessException: module X does not export Y

# Spring bean graph
curl -s localhost:8080/actuator/beans | jq '.contexts[].beans | keys[]' | grep -i order
```

### Phase 3: Hypothesis tests

**H1: Not going through proxy.**

```java
log.info("Bean class: {}", orderService.getClass());
// com.acme.OrderServiceImpl → NOT proxied
// com.acme.OrderService$$SpringCGLIB$$0 → proxied
```

Add temporary logging in the aspect/interceptor. If it never fires, the call path bypasses the proxy.

**H2: Wrong classloader.**

```java
log.info("OrderDto loader: {}", OrderDto.class.getClassLoader());
log.info("TCCL: {}", Thread.currentThread().getContextClassLoader());
```

If they differ on the failing thread, fix TCCL propagation.

**H3: Module opens missing.**

```bash
java --add-opens java.base/java.lang=ALL-UNNAMED ...   # repro test only
# permanent fix: remove the dependency that needs it, or upgrade the library
```

**H4: Native image missing config.**

```bash
./mvnw -Pnative test
# run with agent to regenerate hints
```

### Phase 4: Fix and prevent

| Fix type | Prevention |
|---|---|
| Split bean for self-invocation | ArchUnit rule on `@Transactional` self-calls |
| Add `RuntimeHints` | Native image in CI |
| Fix TCCL in async | `TaskDecorator` on all custom executors |
| Upgrade library for JDK 21 | jdeps + enforcer in CI |
| `@Retention(RUNTIME)` | Annotation unit test asserting retention |
| Cache MethodHandle at startup | Profiler gate on hot endpoints |

### Phase 5: Post-incident

Document which of the five root failures (discovery, retention, accessibility, proxy bypass, erasure) applied. Add one regression test that would have caught it. Most reflection incidents recur because the team fixed the symptom (`setAccessible(true)`) not the cause (wrong design).

---

## 22. Quick Decision Matrix

Use this when choosing an approach at design time or during an incident triage.

### Proxy selection

| Need | Choose |
|---|---|
| Bean has interface, Boot default | CGLIB (`proxy-target-class=true`) or JDK if explicitly disabled |
| Bean has no interface | CGLIB / ByteBuddy subclass |
| `final` class or method | No runtime proxy — refactor or AspectJ weaving |
| Record / sealed leaf | Not proxiable — use delegation |
| GraalVM native | Prefer compile-time AOT (Spring), avoid runtime CGLIB |
| Mockito test | Interface → JDK mock; class → ByteBuddy subclass mock |

### Reflection vs alternatives

| Need | Choose |
|---|---|
| JSON field mapping | Jackson + `@JsonProperty` (reflective once at startup) |
| DTO mapping in your code | MapStruct (generated code) |
| Dynamic plugin (allowlisted) | `ServiceLoader` or validated `Class.forName` |
| Private method in test | `ReflectionTestUtils` — sparingly |
| Generic type in Jackson | `TypeReference` / `JavaType` |
| Hot loop property access | `MethodHandle` cached at init |
| Field atomic update | `VarHandle` |

### JDK upgrade checklist

| Step | Action |
|---|---|
| 1 | `jdeps --jdk-internals --multi-release 21` on every JAR |
| 2 | `mvn enforcer:enforce` banning `sun.*`, `com.sun.*` |
| 3 | Run tests with `--illegal-access=deny` |
| 4 | Replace `setAccessible` with `MethodHandles.privateLookupIn` where possible |
| 5 | Run native image build in CI if you ship native |
| 6 | Check Spring/Hibernate release notes for proxy and reflection changes |

### Incident → first command

| Symptom | First command / check |
|---|---|
| `ClassCastException` same name | Compare `obj.getClass().getClassLoader()` on both sides |
| `@Transactional` no rollback | `log.info("{}", svc.getClass())` — proxy? self-invocation? |
| `InaccessibleObjectException` | `jdeps` on the stack trace's library JAR |
| Metaspace OOM | `jcmd <pid> GC.class_stats` + heap dump dominators |
| Native image crash at runtime | Re-run tests with `native-image-agent` |
| Annotation not seen | `annotationType().getAnnotation(Retention.class)` |

---

---


---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>Q1. JDK dynamic proxy vs CGLIB — when does Spring pick each?</summary>

With `spring.aop.proxy-target-class=true` (Boot 2.1+ default), Spring uses **CGLIB subclasses** even when interfaces exist. With `false`, beans implementing interfaces get **JDK proxies**. Beans without interfaces always get CGLIB. JDK proxies are lighter on metaspace per interface set; CGLIB allows `instanceof` on the concrete class and can intercept non-interface methods.

</details>

<details class="qa-item">
<summary>Q2. Why does @Transactional not work on a self-invoked method?</summary>

Spring injects a **proxy**. Internal calls use `this`, which is the **raw target**, not the proxy. The `TransactionInterceptor` never runs. Fix by splitting into another bean, self-injecting the interface with `@Lazy`, or using AspectJ weaving.

</details>

<details class="qa-item">
<summary>Q3. What is the difference between getMethod and getDeclaredMethod?</summary>

`getMethod` returns **public** methods including inherited ones. `getDeclaredMethod` returns methods **declared on that class only**, any visibility, excluding inherited. For a `private` method on the exact class, use `getDeclaredMethod` + `setAccessible(true)` or `MethodHandles.privateLookupIn`.

</details>

<details class="qa-item">
<summary>Q4. Why do annotation instances return a $Proxy class from getClass()?</summary>

Runtime annotations are implemented as **JDK dynamic proxies** backed by `AnnotationInvocationHandler`. Always use `annotation.annotationType()` for metadata inspection, never `annotation.getClass()`.

</details>

<details class="qa-item">
<summary>Q5. What causes ClassCastException when both types have the same name?</summary>

The same `.class` file was loaded by **two different ClassLoaders**, producing two distinct `Class` objects. Common in Tomcat redeploy, fat-jar + plugin, or async threads with wrong TCCL. Compare `a.getClass().getClassLoader()` vs `b.getClass().getClassLoader()`.

</details>

<details class="qa-item">
<summary>Q6. Can you create a CGLIB proxy of a final class?</summary>

**No.** Subclass-based proxies require a non-final base class. `record` types and `final` service classes cannot be CGLIB-proxied. Use delegation, an interface, or AspectJ compile-time weaving.

</details>

<details class="qa-item">
<summary>Q7. What is invokeSuper in CGLIB and why not use Method.invoke?</summary>

`methodProxy.invokeSuper(obj, args)` calls the **original superclass implementation** without re-entering the interceptor. `method.invoke(obj, args)` on a CGLIB proxy **re-enters the interceptor**, causing infinite recursion or double application of advice.

</details>

<details class="qa-item">
<summary>Q8. How do MethodHandles differ from Method.invoke for performance?</summary>

`MethodHandle` performs access checks at **lookup time**, supports **invokeExact** with primitive signatures, and is **JIT-inlinable** after warmup. `Method.invoke` checks access per call, boxes arguments, and is harder for the JIT to optimize. Cache handles for hot paths.

</details>

<details class="qa-item">
<summary>Q9. How do you reflectively read a record's components?</summary>

Use `Class.isRecord()` and `Class.getRecordComponents()`. Each `RecordComponent` provides name, type, generic type, accessor `Method`, and `MethodHandle`. Prefer accessors over `getDeclaredFields()` to respect encapsulation.

</details>

<details class="qa-item">
<summary>Q10. What is TypeReference and why the empty braces?</summary>

`new TypeReference<List<Order>>() {}` creates an **anonymous subclass** that captures the generic type argument in its `ParameterizedType` signature. The `{}` is required — without a subclass, the type argument is erased. Used by Jackson, Spring, and Guice for generic deserialization.

</details>

<details class="qa-item">
<summary>Q11. Why does @Retention default break runtime annotation scanning?</summary>

The default is `RetentionPolicy.CLASS` — present in bytecode but **invisible to reflection**. Frameworks using `getAnnotation()` return `null` with no error. Always set `@Retention(RUNTIME)` for runtime-read annotations.

</details>

<details class="qa-item">
<summary>Q12. What pins a WebappClassLoader after Tomcat redeploy?</summary>

Common pins: **pool threads** holding TCCL, **ThreadLocal** values referencing webapp classes, **JDBC drivers** in `DriverManager`, **Introspector** cache, **scheduled tasks**, and **Proxy** class caches. Run `Introspector.flushCaches()`, deregister drivers, shut down executors in `ServletContextListener`.

</details>

<details class="qa-item">
<summary>Q13. What is InaccessibleObjectException on JDK 17?</summary>

Strong encapsulation: a module did not **export** or **open** the package to your module. `setAccessible(true)` on `java.lang` internals fails. Fix by upgrading the library, using public API, or `--add-opens` as a last resort — not as a security control.

</details>

<details class="qa-item">
<summary>Q14. How do you register reflection for GraalVM native image?</summary>

Use `META-INF/native-image/*/reflect-config.json`, the **native-image-agent** during JVM tests, or Spring 6 `RuntimeHintsRegistrar`. Register every reflectively accessed class, constructor, method, and field. JDK proxies need `proxy-config.json` for their interfaces.

</details>

<details class="qa-item">
<summary>Q15. Why must you unwrap InvocationTargetException?</summary>

`Method.invoke` wraps any exception thrown by the target method in `InvocationTargetException`. Logging or rethrowing the wrapper hides the real cause and stack. Always use `e.getCause()` for the actual failure.

</details>

<details class="qa-item">
<summary>Q16. Can @Transactional work on a private method?</summary>

**No** for standard Spring AOP proxies. CGLIB cannot override `private` methods; JDK proxies only see interface methods. Extract transactional logic to a public method on another bean or use AspectJ weaving.

</details>

<details class="qa-item">
<summary>Q17. What is the context classloader and when does it matter?</summary>

`Thread.currentThread().getContextClassLoader()` is the loader used by `ServiceLoader`, many JAX-* stacks, and library code that calls `Class.forName` without an explicit loader. Async threads with a wrong TCCL cause `ClassNotFoundException` or `ClassCastException`. Propagate with `TaskDecorator`.

</details>

<details class="qa-item">
<summary>Q18. VarHandle vs AtomicIntegerFieldUpdater?</summary>

Both provide atomic field updates. `VarHandle` (Java 9+) is the modern API with flexible access modes (volatile, opaque, acquire/release). `Atomic*FieldUpdater` is the legacy approach. Prefer `VarHandle` for new code; use `findVarHandle` with correct lookup access.

</details>

<details class="qa-item">
<summary>Q19. When should you use reflection in application code?</summary>

Almost never for code you own. Justified cases: validated plugin loading, framework development, or interoperability with unknown types at compile time. For DTO mapping, use MapStruct; for behavior variation, use sealed types + switch or Strategy injection.

</details>

<details class="qa-item">
<summary>Q20. How do you debug missing Spring @Component scanning?</summary>

Enable `logging.level.org.springframework.context.annotation=DEBUG`. Verify the class is under the scan base package, not excluded by a filter, has a stereotype annotation, and is not a `final` class (CGLIB proxy issue). For classpath scanning without loading, Spring uses ASM — a typo in package name silently excludes the bean.

</details>

<details class="qa-item">
<summary>Q21. What is exposeProxy in @EnableAspectJAutoProxy?</summary>

`exposeProxy = true` stores the current proxy in `AopContext` so code can call `AopContext.currentProxy()` for self-invocation through the proxy. It couples code to Spring AOP; prefer splitting beans or self-injection instead.

</details>

<details class="qa-item">
<summary>Q22. Why do repeatable annotations need getAnnotationsByType?</summary>

The compiler wraps multiple `@Role` annotations in a container `@Roles`. `getAnnotation(Role.class)` returns **null** when more than one is present. `getAnnotationsByType(Role.class)` unwraps the container and returns all instances.

</details>

<details class="qa-item">
<summary>Q23. How does sealed type reflection help serialization?</summary>

`Class.getPermittedSubclasses()` lists allowed subtypes. Frameworks generate polymorphic type discriminators (Jackson `@JsonSubTypes`, OpenAPI `oneOf`) from this list. Combined with exhaustive `switch` on sealed interfaces (Java 21), you get compile-time and runtime alignment.

</details>

<details class="qa-item">
<summary>Q24. What is the native-image-agent workflow?</summary>

Run tests with `-agentlib:native-image-agent=config-output-dir=...` to record reflective access, resources, and proxies actually used. Merge generated JSON into `META-INF/native-image`. Rebuild native image. Iterate until integration tests pass without `MissingReflectionRegistrationError`.

</details>

<details class="qa-item">
<summary>Q25. SpEL injection risk — what is the safe context?</summary>

`StandardEvaluationContext` allows `T(java.lang.Runtime)` style type references — **never** with user input. For user-supplied expressions use `SimpleEvaluationContext` with limited property access. Treat SpEL like SQL: parameterized, not concatenated from user strings.

</details>
