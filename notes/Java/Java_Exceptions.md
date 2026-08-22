# Master Java Exceptions — Senior Developer Level


---

# Part 1 — What Is a Java Exception, and Why Does Java Need Exceptions?

### 1. The problem before exceptions existed

Before exception-based error handling was common, languages like C handled failure through **return codes**.

```c
FILE *fp = fopen("data.txt", "r");
if (fp == NULL) {
    // handle error
}
```

This looks harmless in one line. The real problem shows up when errors need to travel *up* through several layers of function calls.

```c
int readConfig() {
    int result = openFile();
    if (result != OK) return result; // propagate manually

    result = parseFile();
    if (result != OK) return result; // propagate manually

    result = validateConfig();
    if (result != OK) return result; // propagate manually

    return OK;
}
```

Every single call site has to remember to check the return code. If even one caller forgets, the error is silently lost, and the program keeps running in a broken state.

This gives us the first core idea:

**Error codes rely on programmer discipline. Exceptions rely on language enforcement.**

### 2. What is an exception, conceptually?

An exception represents **an event that disrupts the normal flow of a program**, signaling that a method could not complete its intended job the way it was designed to.

Two things are packed into that definition, and both matter:

- It's an **event**, not a value. It doesn't sit in a variable waiting to possibly be checked — it actively interrupts execution.
- It means "**could not complete as designed**" — not necessarily "something catastrophic happened." A missing file, invalid input, or a broken network call are all completely ordinary things that happen in real systems; they're "exceptional" relative to that *specific method's* normal contract, not exceptional in the sense of rare or catastrophic.

### 3. Exceptions vs. normal return values

Compare these two designs for a `divide` method:

```java
// Return-code style
int divide(int a, int b) {
    if (b == 0) return Integer.MIN_VALUE; // "error" sentinel
    return a / b;
}
```

```java
// Exception style
int divide(int a, int b) {
    if (b == 0) throw new ArithmeticException("Divide by zero");
    return a / b;
}
```

The return-code version has a subtle but serious flaw: `Integer.MIN_VALUE` is *also a value that could legitimately be returned* if `a` and `b` were something else. There is no way, just by looking at the return type `int`, to distinguish "a real result" from "an encoded failure." The caller has to know the convention, and nothing forces them to check it.

The exception version separates these two channels completely:
- The **return value channel** carries only successful results.
- The **exception channel** carries only failure information.

This is the second core idea:

**Exceptions give failure its own dedicated channel, separate from normal return values, so success and failure can never be confused with each other.**

### 4. Exceptions vs. Errors (informally, for now)

At this stage, just hold this distinction loosely — Part 2 (The Java Throwable Hierarchy) goes deep on the `Throwable` hierarchy:

- **Exception** → a problem an application might reasonably want to detect, react to, or recover from (bad input, missing file, invalid state).
- **Error** → a problem so severe (JVM running out of memory, stack overflow) that application code generally isn't expected to recover from it.

### 5. "Exceptional situations" vs. "expected program flow"

A subtlety senior developers care about: exceptions model **failure to fulfill a method's contract**, not merely "something unusual." Consider:

```java
Optional<User> findUser(String id) { ... }
```

If a user isn't found, is that "exceptional"? Arguably no — a lookup that might not find something is *part of its normal contract*. That's why Java added `Optional` and why methods like `Map.get()` return `null` instead of throwing when a key is absent — "not found" is an expected outcome, not a failure.

Contrast with:

```java
void connectToDatabase() throws SQLException
```

Here, failing to connect genuinely breaks the method's ability to do what it promised. That's a legitimate exception.

This distinction — "expected alternative outcome" vs. "broken contract" — is exactly why misusing exceptions for ordinary control flow (Parts 15: Exception Handling Principles, 22: Common Misconceptions) is considered a design smell.

### 6. Why Java specifically chose an exception-based mechanism

Three deliberate design goals, from the language designers' perspective:

1. **Separation of concerns** — business logic shouldn't be cluttered with error-checking `if` statements at every line; the happy path stays readable, and failure handling is centralized in `catch` blocks.
2. **Guaranteed propagation** — an unhandled exception can never be silently ignored. If nothing catches it, the JVM terminates that thread and prints a stack trace. Compare this to a forgotten `if (result != OK)` check, which fails *silently*.
3. **Rich failure information** — an exception object can carry a message, a type (which conveys *meaning*), a stack trace (exactly where it happened), and a cause (what triggered it). A return code is just an integer.

### Step-by-step: what actually happens when an exception is thrown

```java
void process() {
    System.out.println("Start");
    throw new RuntimeException("Something failed");
}

void main() {
    process();
    System.out.println("This never runs");
}
```

1. `"Start"` prints normally.
2. `throw` creates the exception object and immediately halts normal execution of `process()` — no further line in that method runs.
3. The JVM looks for a matching `catch` block in `process()`. There isn't one.
4. The exception propagates to the caller, `main()`, at the exact point `process()` was called.
5. `main()` also has no handler, so `"This never runs"` never executes.
6. The exception propagates out of `main()`, the thread terminates, and the JVM prints the stack trace to stderr.

**The moment `throw` executes, the normal sequential flow of that method is abandoned entirely.**

---

### Common misconception
> "Exceptions are for handling errors."

**Correct mental model:** Exceptions are for *signaling* that a method could not fulfill its contract, and for giving that signal a guaranteed path to somewhere that can decide what to do about it. Handling is only one possible response — a caller might also just let it propagate further, which is often the *correct* choice.

### Common developer mistake
Treating every `try/catch` as "handling" the problem, when really it's just catching it — logging it and moving on doesn't fix the underlying failure.

### Senior-level perspective
Junior developers think of exceptions as "the way Java reports errors." Senior developers think of exceptions as **a control-flow mechanism with its own channel, its own propagation rules, and its own contract implications for method design** — something that has to be *designed*, not just reacted to when the compiler complains.

---

# Part 2 — The Java Throwable Hierarchy

### 1. Why a hierarchy at all?

Java didn't just create one generic "Exception" class. It built a **type hierarchy**, and that choice is deliberate: it lets code make decisions based on *category* rather than checking every possible failure individually.

```
Throwable
├── Error
└── Exception
      ├── RuntimeException
      └── (other checked exceptions)
```

Because it's a type hierarchy, you can write:

```java
catch (IOException e) { ... }
```

and it will also catch `FileNotFoundException`, since `FileNotFoundException extends IOException`. This is the same polymorphism principle from OOP, applied to failure types instead of business types.

### 2. `Throwable` — the root

`Throwable` is the only type that `throw` and `catch` are allowed to work with in Java. Its main job is structural: it defines the shared contract every throwable thing has —

- a message (`getMessage()`)
- a stack trace (`getStackTrace()` / `printStackTrace()`)
- a cause (`getCause()`) — for chaining, Part 12 (Exception Cause and Chaining)
- suppressed exceptions (`getSuppressed()`) — Part 11 (Suppressed Exceptions)

Two direct subclasses split the world in half based on **who is expected to react**.

### 3. `Error` — problems your code isn't meant to handle

`Error` represents conditions that are typically **outside the application's control and not something ordinary code should try to recover from**:

- `OutOfMemoryError` — the JVM has run out of heap
- `StackOverflowError` — a call stack (often from unbounded recursion) exceeded its limit
- `ExceptionInInitializerError` — a static initializer threw (Part 19: Exceptions During Initialization)

The reasoning: if the JVM itself is in trouble, your `catch` block's own code needs memory and stack space too — there's a real chance the *handler itself* can't execute reliably. That's why catching `Error` is discouraged (with rare, specific exceptions covered in Part 21: Error vs. Exception: Senior-Level Understanding).

### 4. `Exception` — problems your code might reasonably react to

This branch represents failures at the *application* level — things a well-written program can anticipate and potentially do something about: a missing file, invalid user input, a broken network call, a database constraint violation.

`Exception` itself splits again — and this split is the single most debated design decision in the entire hierarchy:

```
Exception
├── RuntimeException          → unchecked
└── everything else           → checked
```

`RuntimeException` is a subclass of `Exception`, not a sibling of it.

### 5. Touring representative exceptions — and *why* each lives where it lives

**Checked exceptions (extend `Exception` directly, not `RuntimeException`)**

- **`IOException`** — represents failures in I/O operations: a file that can't be read, a socket that drops. Checked because I/O interacts with the *outside world* — the filesystem, the network — things fundamentally outside the JVM's control. A well-designed API forces the caller to acknowledge "this external interaction might fail."
- **`SQLException`** — same reasoning, applied to databases: an external system your code doesn't control.
- **`ClassNotFoundException`** — thrown when code tries to load a class by name (`Class.forName(...)`) and it isn't found. Checked because class loading depends on the runtime classpath/environment, which is external configuration.
- **`InterruptedException`** — thrown when a thread is interrupted while blocked (e.g., in `Thread.sleep()`). Checked deliberately, so that thread-interruption — a cooperative cancellation signal — can never be silently ignored by a careless caller.

**Unchecked exceptions (extend `RuntimeException`)**

- **`NullPointerException`** — thrown when code dereferences a `null` reference. Unchecked because null-dereferences are almost always **programming mistakes**, not conditions a caller is expected to plan for structurally at every call site.
- **`IllegalArgumentException`** — thrown when a caller passes an argument that violates a method's precondition. Unchecked because this represents **a caller's bug** — the fix is "call the method correctly," not "handle this at runtime."
- **`IllegalStateException`** — thrown when a method is called at a point where the *object's current state* doesn't permit it. Unchecked — again, this signals incorrect usage, not an expected external failure.
- **`IndexOutOfBoundsException`** — thrown when an index is outside valid bounds. Unchecked — a logic error in the calling code, not an environmental failure.

### The pattern underneath all of this

| | Checked examples | Unchecked examples |
|---|---|---|
| Cause | External systems (files, DB, network, classpath) | Programming mistakes (bad args, bad state, null) |
| Who's "at fault" | Environment / outside world | The calling code itself |
| Expectation | Caller *should* plan for this | Caller should have *prevented* this |

**Checked exceptions model failures external to your program's logic that a caller should be forced to consider; unchecked exceptions model defects in how the program itself was written or called.**

---

### Common misconception
> "RuntimeException means something went wrong at runtime, as opposed to compile time."

**Correct mental model:** *All* exceptions occur at runtime — including checked ones like `IOException`. "Runtime" in `RuntimeException` doesn't mean "when it occurs," it's just the historical name for "the unchecked branch." The real distinction is *compiler enforcement of handling*, not *when the exception happens*.

### Common developer mistake
Assuming an exception's name tells you everything about when to use it, without checking where it sits in the hierarchy. E.g., throwing a raw `Exception` or `RuntimeException` directly instead of a more specific type, which destroys the caller's ability to `catch` selectively.

### Senior-level perspective
A junior developer sees the hierarchy as a reference chart to look up when they hit a compiler error. A senior developer treats **hierarchy placement as part of API design** — when creating a custom exception (Part 13: Custom Exceptions), *where* you put it in the hierarchy is a decision about what contract you're making with every future caller of your code.

---

# Part 3 — Checked vs. Unchecked Exceptions, In Depth

### 1. The actual language rule (not the folklore version)

The Java Language Specification defines it structurally, not semantically:

- **Unchecked exceptions** = `RuntimeException` and all its subclasses, **plus** `Error` and all its subclasses.
- **Checked exceptions** = every other subclass of `Throwable` — i.e., `Exception` and its subclasses, *excluding* `RuntimeException`.

That's it. It's a **class-hierarchy-based rule**, enforced by the compiler purely by checking "does this type extend `RuntimeException` or `Error`, yes or no?" There's no semantic analysis of "is this really external" or "is this really a bug" — the compiler doesn't reason about meaning at all.

This means checked-vs-unchecked is a **compiler bookkeeping mechanism**, not an inherent property of what the failure *means*. The meaning (external vs. programming error, Part 2: The Java Throwable Hierarchy) is a *design convention* Java's own API mostly follows — but nothing stops you from writing a checked exception for a pure logic bug, or an unchecked one for a network failure.

### 2. What "checked" actually enforces — compile-time handling obligation

The compiler enforces that a checked exception must be either **caught** or **declared** at every point in the call chain where it could propagate through.

```java
void readFile() throws IOException {   // declared
    FileReader fr = new FileReader("data.txt"); // can throw FileNotFoundException (IOException subtype)
}

void caller() {
    readFile(); // COMPILE ERROR: unhandled checked exception
}
```

The compiler traces: `readFile()` declares `throws IOException`. `caller()` invokes it without a `try/catch` and without its own `throws IOException`. That's a compile-time error.

Now the unchecked version:

```java
void divide(int a, int b) {
    int result = a / b; // can throw ArithmeticException at runtime
}

void caller() {
    divide(10, 0); // compiles fine — no obligation
}
```

`ArithmeticException extends RuntimeException`. No declaration, no `try/catch`, no compile-time complaint. The program compiles, runs, and only fails *when that line actually executes with `b == 0`*.

The correct version of the "compile time vs runtime" folklore: **it's not that checked exceptions happen at compile time — nothing "happens" at compile time except type-checking.** What's true is that the *compiler enforces an obligation to handle or declare* checked exceptions before it will let the code compile at all. Unchecked exceptions carry no such obligation — the failure is discovered only at actual runtime execution.

### 3. Exception declaration and propagation — the mechanical chain

`throws` (full treatment in Part 5: The `throws` Declaration, In Depth) is how a method makes its checked-exception obligations visible upward:

```java
void low() throws IOException { ... }

void mid() throws IOException {   // must declare — doesn't catch, just passes it up
    low();
}

void high() {
    try {
        mid();                    // must handle — it's the top of this chain
    } catch (IOException e) {
        // handle
    }
}
```

Every method between the `throw` site and the eventual `catch` has exactly two choices for a checked exception: **catch it**, or **declare it and pass the obligation to its own caller**. There's no third option.

### 4. API contracts — the real reason this matters

A method's signature, including its `throws` clause, is part of its **public contract**. Consider:

```java
public void save(User user) throws SQLException;
```

Just by reading this signature — without reading a single line of the implementation or any documentation — a caller knows: *this can fail due to database problems, and I am required to make a decision about it.* That's the entire value proposition of checked exceptions: **the type system forces the failure mode into the API's visible contract**, rather than leaving it as an undocumented possibility a caller might never discover until production.

### 5. Why checked exceptions exist — the design philosophy

Java's designers wanted to solve the C-style problem from Part 1 (What Is a Java Exception, and Why Does Java Need Exceptions?) — errors silently ignored — but wanted the *compiler*, not just discipline or documentation, to guarantee it couldn't happen for a specific category of failure: predictable, recoverable, externally-caused failures (I/O, networking, database access) where "just crash" is rarely acceptable in real software.

The intended contract:
- **Checked** → "this can fail in a way that's foreseeable and where the caller should have a real plan" (retry, fallback, user-facing message).
- **Unchecked** → "this represents a defect — fix the code, don't write a `catch` block to paper over a bug."

### 6. Advantages of checked exceptions

- **Forces acknowledgment** — a caller literally cannot ignore the possibility of failure; the compiler blocks the build.
- **Self-documenting APIs** — the signature tells you what can go wrong, no separate documentation required.
- **Catches "forgot to handle it" bugs at compile time** rather than in production.

### 7. Disadvantages of checked exceptions

- **Boilerplate pressure** — deep call chains force every intermediate method to add `throws`, even ones with no meaningful way to handle the failure themselves.
- **Encourages bad "handling"** — because the compiler *demands* something be done, developers under pressure often write:
  ```java
  try {
      riskyIO();
  } catch (IOException e) {
      // do nothing — just to satisfy the compiler
  }
  ```
  This is arguably *worse* than an unchecked exception propagating naturally, because the failure is now truly silenced.
- **Breaks functional-style / lambda code** — checked exceptions don't compose well with functional interfaces (you can't throw a checked exception from inside a standard `Runnable.run()` without wrapping it).
- **Versioning fragility** — adding a new checked exception to a method later is a **binary/source compatibility break** for every caller. Unchecked exceptions can be added freely without breaking any existing calling code.

### 8. When checked exceptions genuinely make sense

When failure is:
- **Foreseeable** (you can articulate the failure mode in advance)
- **Recoverable** (a caller could plausibly do something different in response — retry, fallback, prompt the user)
- **Not a bug** (nothing was written incorrectly — the environment simply didn't cooperate)

File I/O and network calls are the textbook case.

### 9. When unchecked exceptions make sense

When failure represents:
- **A programming defect** — invalid arguments, broken invariants, null where non-null was required. There's no meaningful "runtime recovery" for a bug.
- **A condition so pervasive that requiring declaration everywhere would be absurd** — imagine if `ArithmeticException` or `NullPointerException` were checked. Nearly *every* method could throw them, and `throws` clauses would balloon into meaninglessness.

### 10. Why experienced developers actually disagree about this

- **Pro-checked camp**: compiler-enforced contracts prevent an entire category of "forgot to handle it" production bugs; explicit is better than implicit.
- **Anti-checked / "unchecked-everywhere" camp**: checked exceptions in practice mostly produce *boilerplate and empty catch blocks* rather than thoughtful handling; most callers can't meaningfully recover anyway; checked exceptions actively fight against composability (lambdas, generic wrapper code).

A concrete piece of evidence for the "anti" side: Spring's data-access exceptions (`DataAccessException` and friends) are deliberately **unchecked**, specifically as a reaction against `SQLException` being checked — Spring's designers judged that forcing every DAO-layer method to declare or catch `SQLException` produced more harm (boilerplate, swallowed exceptions) than good.

**Checked exceptions are a tool with a real, narrow sweet spot (foreseeable, recoverable, externally-caused failures at API boundaries) — not a default you should reach for, and not something to reject outright either.**

---

### Common misconception
> "Checked exceptions happen at compile time; unchecked ones happen at runtime."

**Correct mental model:** *Every* exception — checked or unchecked — is thrown and occurs at runtime, full stop. What differs is **whether the compiler enforces a handling/declaration obligation before it will compile the code at all.**

### Common developer mistake
Treating "make the compiler happy" as equivalent to "handled the problem correctly" — e.g., adding `throws Exception` to every method signature just to silence errors, or writing empty catch blocks.

### Senior-level perspective
A junior developer treats checked-vs-unchecked as a rule to obey. A senior developer treats it as **a design decision with real trade-offs to weigh per situation** — and recognizes that even within the Java ecosystem itself, thoughtful engineers have landed on different answers (see the Spring example above).

---

# Part 4 — The `throw` Statement, In Depth

### 1. What `throw` actually does

`throw` is a statement that takes a `Throwable` instance and **immediately abandons normal execution**, handing control to the exception-propagation machinery (Parts 6–7).

```java
throw new RuntimeException("Something failed");
```

Two things happen here:

1. `new RuntimeException("Something failed")` — ordinary object construction. It allocates the instance, runs its constructor (which captures the current call stack into the object), and evaluates to a reference.
2. `throw <that reference>` — this is the special part. Not a method call, not a `return`, not a jump to a label. The JVM stops executing the current method at that exact point and begins searching for a handler.

### 2. What can be thrown — and why it must derive from `Throwable`

The compiler enforces, at compile time, that the operand of `throw` must be `Throwable` or a subtype:

```java
throw "some string"; // COMPILE ERROR — String is not a Throwable
throw new RuntimeException("ok"); // fine
```

Why restrict it to `Throwable`? Because `catch` blocks need a **uniform contract** to match against. Requiring a common ancestor is what makes `catch (SomeType e) { e.getMessage(); }` type-safe and guaranteed to compile.

There's also a JVM-level reason: `Throwable` carries `Throwable.fillInStackTrace()`, called automatically inside `Throwable`'s constructor — this is where the stack trace is actually captured, at construction time, not at `throw` time.

### 3. Compile-time behavior: checked exceptions and `throw`

If the thrown type is **checked**, the enclosing method must either catch it or declare it:

```java
void save() {
    throw new java.io.IOException("disk full"); // COMPILE ERROR
    // must add: void save() throws IOException
}
```

```java
void save() throws java.io.IOException {
    throw new java.io.IOException("disk full"); // fine — declared
}
```

For **unchecked** exceptions, no declaration obligation exists.

### 4. Runtime behavior: what happens the instant `throw` executes

```java
void step3() {
    System.out.println("before throw");
    throw new RuntimeException("failure at step 3");
    // unreachable
}
```

1. `"before throw"` prints.
2. The `RuntimeException` object is constructed (stack trace captured here).
3. `throw` executes: the current method's execution is abandoned **immediately** — no code after the `throw` statement in that method will ever run.
4. Control transfers to whatever exception-handling search is next — first checking for a matching `catch` in the current method's enclosing `try` blocks (Part 8: `try` and `catch`, In Depth), then propagating to the caller (Parts 6–7).

The compiler actually flags any code physically placed after an unconditional `throw` in the same block as **unreachable code** — a compile error.

### 5. Throwing a *new* exception vs. throwing an *existing* one

```java
throw new RuntimeException("failed");
```
vs.
```java
catch (IOException e) {
    throw e; // rethrow the SAME object
}
```

**`throw new RuntimeException(...)`** constructs a brand-new `Throwable`. Its stack trace is captured *right here, right now*. If there was a previous exception that led to this new one being created, that original exception is now **gone** unless you explicitly pass it as a cause (Part 12: Exception Cause and Chaining).

**`throw existingException;`** (a "rethrow") throws the **exact same object reference** that was already caught. Its stack trace is **not** recaptured — it still reflects wherever that exception was *originally* constructed.

### Tricky example — walk through this carefully

```java
void methodA() {
    try {
        methodB();
    } catch (RuntimeException e) {
        System.out.println("Caught in A, rethrowing");
        throw e; // rethrow — SAME exception object
    }
}

void methodB() {
    throw new RuntimeException("original failure in B");
}

void main() {
    methodA();
}
```

Step-by-step:
1. `methodB()` constructs a new `RuntimeException` — stack trace captured **at this point**, showing `methodB` as the origin.
2. `throw` in `methodB()` propagates up to `methodA()`'s `try` block.
3. `methodA()`'s `catch (RuntimeException e)` matches — the same object is bound to `e`.
4. `"Caught in A, rethrowing"` prints.
5. `throw e;` re-throws the **identical object** — its stack trace still says "originally thrown in `methodB`."
6. It propagates out of `methodA()`, to `main()`, which also doesn't catch it — the thread terminates and prints the stack trace, which correctly points to `methodB` as the true origin.

Now contrast:

```java
} catch (RuntimeException e) {
    throw new RuntimeException("wrapped failure"); // NEW exception, cause lost!
}
```

Here, the *original* exception object (and its stack trace pointing to `methodB`) is discarded entirely. The fix is always to pass the original as a cause: `new RuntimeException("wrapped failure", e)`.

---

### Common misconception
> "Rethrowing an exception and throwing a new one are basically the same thing, as long as the message is similar."

**Correct mental model:** Rethrowing (`throw e`) preserves the *exact original object* — same stack trace, same identity. Throwing a new exception constructs a *different* object with a *new* stack trace — and unless you explicitly attach the original as a cause, that original failure information is **permanently lost**.

### Common developer mistake
Catching an exception purely to log it, then throwing a brand-new exception without attaching the original as the cause — destroying the actual root-cause stack trace.

### Senior-level perspective
A junior developer sees `throw` as "the way you signal an error." A senior developer treats *what specifically gets thrown* — a rethrow of the same object vs. a newly constructed wrapper — as a decision with real, permanent consequences for whoever has to debug this exception in production.

---

# Part 5 — The `throws` Declaration, In Depth

### 1. What `throws` actually is — and the misconception to kill immediately

```java
public void read() throws IOException {
    // ...
}
```

> **"`throws` throws an exception."**

This is **false**. `throws` is not a statement. It performs **no action at all** at runtime. Nothing is thrown by the word `throws` itself — ever. It is purely a **declaration**, part of a method's signature, checked by the *compiler*. At runtime, the JVM doesn't even "look at" the `throws` clause — it has already done its job at compile time.

| | `throw` | `throws` |
|---|---|---|
| What it is | A statement | Part of a method signature |
| When it acts | At runtime, when executed | Never "acts" — compile-time only |
| What it does | Actually constructs/propagates an exception | Declares *that a checked exception might propagate* out of this method |
| Can appear | Inside a method body | Only in a method/constructor signature |

**`throws` is a promise a method makes about what checked exceptions might come out of it — not a mechanism that causes anything to happen.**

### 2. Why `throws` exists

`throws` is the syntax that lets a method satisfy the handle-or-declare obligation by **declaring**, rather than catching.

```java
void low() throws IOException {
    throw new IOException("disk error");
}

void mid() throws IOException {  // declares — passes obligation upward
    low();
}
```

### 3. Checked exception declaration — the compiler's actual check

If a method's body can, directly or indirectly, cause a checked exception to propagate out of it, that checked exception type (or a supertype) **must** appear in the method's `throws` clause, unless it's caught inside the method.

```java
void save() {
    java.io.FileWriter fw = new java.io.FileWriter("out.txt"); 
    // COMPILE ERROR: unhandled checked exception
}
```

Fix, option A — declare it:
```java
void save() throws java.io.IOException {
    java.io.FileWriter fw = new java.io.FileWriter("out.txt"); // fine
}
```

Fix, option B — catch it instead:
```java
void save() {
    try {
        java.io.FileWriter fw = new java.io.FileWriter("out.txt");
    } catch (java.io.IOException e) {
        // handled here — no need to declare
    }
}
```

### 4. Multiple declared exceptions

```java
void process() throws java.io.IOException, java.sql.SQLException {
    // ... can throw either
}
```

Callers must then handle (or further declare) *both* possibilities.

### 5. Declaring unchecked exceptions — legal, but means something different

```java
void validate(int age) throws IllegalArgumentException {
    if (age < 0) throw new IllegalArgumentException("age cannot be negative");
}
```

This compiles fine, but since `IllegalArgumentException` extends `RuntimeException`, the compiler places **zero enforcement obligation** on any caller. Declaring it at all is purely **documentation** — signaling intent to human readers and tools without imposing a compile-time obligation.

### 6. Method contracts

A method's full signature — parameters, return type, *and* `throws` clause — collectively defines its contract with callers. Adding a **new checked** exception to an existing method's `throws` clause is a **breaking change**; adding an unchecked one breaks nothing at compile time.

### 7. `throw` vs. `throws` — the clean, final distinction

|  | `throw` | `throws` |
|---|---|---|
| Part of speech | Statement | Signature modifier |
| Location | Inside a method/constructor body | After the parameter list, in a signature |
| Effect | Actually transfers control, halts normal execution | No runtime effect whatsoever |
| Cardinality | Takes exactly one `Throwable` instance | Can list multiple exception *types* |
| Analogy | "I am now failing, right here, right now" | "I might fail with one of these types — be ready" |

**`throw` is an action; `throws` is a declaration about possible future actions taken somewhere inside this method.**

---

### Common misconception
> "`throws` throws the exception."

**Correct mental model:** `throws` never throws anything — it has zero runtime behavior. It exists purely so the compiler can verify that checked exceptions are acknowledged (caught or further declared) at every point in a call chain.

### Common developer mistake
Reflexively adding `throws Exception` to a method signature just to make a compile error go away, without thinking about *which* specific exceptions can actually occur.

### Senior-level perspective
A junior developer treats `throws Exception` as a quick fix for a compiler complaint. A senior developer treats the `throws` clause as **precise, load-bearing API documentation**.

---

# Part 6 — Exception Propagation, In Depth

### 1. The setup: a call chain

```java
void methodA() {
    methodB();
}

void methodB() {
    methodC();
}

void methodC() {
    throw new RuntimeException("failure in C");
}

void main() {
    methodA();
}
```

Call chain: `main() → methodA() → methodB() → methodC() → throw`

Propagation is the answer to: **once `throw` executes deep inside this chain, how does the JVM decide what happens next, and how far does it travel?**

### 2. The search algorithm — precisely

When `throw` executes inside `methodC()`:

1. The JVM first checks: is there a `try` block currently active, directly in `methodC()`, that surrounds the point where `throw` executed, with a `catch` clause that matches this exception's type?
2. If yes → control jumps directly to that `catch` block. Propagation stops here.
3. If no → `methodC()`'s execution is **abandoned entirely**, and the exception is handed to `methodB()` at the exact call-site line.
4. The same check repeats in `methodB()`, then `methodA()`, then `main()`.
5. If it reaches the very top of the call stack with still no handler found → **uncaught exception**. The JVM's default handler prints the exception type, message, and full stack trace to stderr, and terminates that thread.

### 3. What happens to each method as it's abandoned

- Each method's execution stops **immediately** — no further statements run.
- Local variables are simply discarded — the frame is removed.
- **The original exception object itself is not modified, copied, or recreated as it moves through this chain.** It is the *same object*, reference-passed up through each level. Its stack trace reflects only where it was originally created.

### 4. How checked exceptions constrain this chain

If `methodC()` throws a **checked** exception, every method in the chain must either catch it or declare it via `throws`.

```java
void methodC() throws java.io.IOException {
    throw new java.io.IOException("failure in C");
}

void methodB() throws java.io.IOException {  // must declare
    methodC();
}

void methodA() throws java.io.IOException {  // must declare
    methodB();
}

void main() {
    try {
        methodA();          // finally caught here
    } catch (java.io.IOException e) {
        System.out.println("Handled: " + e.getMessage());
    }
}
```

For checked exceptions, the **propagation path is visible in the source code itself**. For unchecked exceptions, propagation happens with **zero visible trace in any signature**.

### 5. Uncaught exceptions — what the caller (and the user) actually observes

```
Exception in thread "main" java.lang.RuntimeException: failure in C
    at methodC(Example.java:10)
    at methodB(Example.java:6)
    at methodA(Example.java:2)
    at main(Example.java:15)
```

The stack trace **lists every frame the exception passed through**, top to bottom, from where it originated down to the entry point.

### 6. How the original exception is preserved through propagation

Propagation does **not** re-throw, re-construct, or re-wrap anything automatically. The JVM's exception-propagation mechanism is purely about **unwinding stack frames and searching for a handler** — it never touches the exception object's content.

### Step-by-step walkthrough — a genuinely mixed example

```java
void methodA() {
    try {
        methodB();
    } catch (IllegalStateException e) {
        System.out.println("A caught it");
    }
}

void methodB() {
    methodC();
}

void methodC() {
    throw new NullPointerException("boom"); // NOTE: not IllegalStateException
}
```

1. `methodC()` throws `NullPointerException`.
2. No handler in `methodC()` → propagates to `methodB()`.
3. No `try` at all in `methodB()` → propagates to `methodA()`.
4. `methodA()` **does** have a `try/catch`, but the `catch` only matches `IllegalStateException` — and `NullPointerException` is not a subtype. **No match.**
5. Because there's no matching handler, it continues propagating upward past `methodA()`, exactly as if the `try/catch` weren't there for this particular exception type.

**A `try/catch` only intercepts exceptions whose type matches its specific `catch` clause(s). An exception of a non-matching type passes straight through as if it didn't exist.**

---

### Common misconception
> "If a method has a try/catch anywhere in it, any exception happening inside that method will be caught there."

**Correct mental model:** A `try/catch` only intercepts exceptions whose type matches its specific `catch` clause(s) (Part 8: `try` and `catch`, In Depth, covers matching precisely).

### Common developer mistake
Assuming a caught exception's stack trace will show where it was *caught*, rather than where it was *originally constructed*.

### Senior-level perspective
A junior developer thinks of propagation as "the error bubbles up until something catches it." A senior developer thinks of it as a **precise, mechanical stack-unwinding search algorithm** — deterministic, frame-by-frame.

---

# Part 7 — Stack Unwinding

### 1. What the call stack looks like before anything goes wrong

Every method invocation gets its own **stack frame**, pushed onto the thread's call stack when the method is entered.

```java
void main() {
    methodA();
}
void methodA() {
    int x = 10;
    methodB();
}
void methodB() {
    int y = 20;
    methodC();
}
void methodC() {
    int z = 30;
    throw new RuntimeException("boom");
}
```

Right before the `throw` executes, the call stack looks like this (top = most recently entered):

```
[ methodC ]  z = 30
[ methodB ]  y = 20
[ methodA ]  x = 10
[ main    ]
```

### 2. What "unwinding" means, precisely

**Stack unwinding is the process of popping frames off the call stack, one by one, starting from the top, until a frame is found that can handle the exception.**

Assuming **no** `try/catch` anywhere:

1. `throw` executes in `methodC`. The JVM checks `methodC`'s frame for a matching handler. None exists.
2. `methodC`'s frame is **popped**. Its local variable `z` ceases to exist. `methodC` never resumes.
3. Control returns to the point in `methodB` where `methodC()` was called, and the JVM checks: does `methodB`'s frame have a handler?
4. No → `methodB`'s frame is popped too. `y` ceases to exist.
5. Same check in `methodA` → no handler → popped. `x` ceases to exist.
6. Same check in `main` → no handler → popped.
7. Stack is now empty. The JVM's default uncaught-exception handler prints the stack trace and the thread terminates.

### 3. What happens to local state during unwinding — and why it matters

`x`, `y`, and `z` are simply **gone** the moment their frame is popped. There is no automatic saving, no rollback, no undo of side effects those methods may have already caused. This is exactly why resource cleanup during unwinding is a real design problem — **stack unwinding guarantees local variables are discarded, but does *not* automatically guarantee that resources those variables referenced get properly released** — unless you use `finally` (Part 9: `finally`, In Depth) or try-with-resources (Part 10: Try-With-Resources).

### 4. Where a handler stops the unwind

```java
void main() {
    methodA();
}
void methodA() {
    try {
        methodB();
    } catch (RuntimeException e) {
        System.out.println("Caught in methodA");
    }
}
void methodB() {
    methodC();
}
void methodC() {
    throw new RuntimeException("boom");
}
```

```
[ methodC ]   →  popped (no handler)
[ methodB ]   →  popped (no handler)
[ methodA ]   →  HAS a matching try/catch — unwinding STOPS here
[ main    ]   →  never touched — methodA's frame is still active
```

**Unwinding is not "pop everything, then figure out who handles it." It's "search one frame at a time from the top, popping only frames that don't have a matching handler, stopping the instant one does."**

### 5. Visual summary of the whole flow

```
main()
  ↓ calls
methodA()  ← try/catch lives here
  ↓ calls
methodB()
  ↓ calls
methodC()
  ↓
throw new RuntimeException("boom")
  ↓
Search methodC's frame  → no handler → POP
  ↓
Search methodB's frame  → no handler → POP
  ↓
Search methodA's frame  → HANDLER FOUND → unwinding stops, catch block runs
  (main's frame: never inspected, never popped, still waiting for methodA to return normally)
```

### 6. Why this design (briefly, staying in scope)

- **Irreversibility** — once a frame is popped, its local state is gone forever. There's no equivalent of "retry from where it failed" built into the language — any retry logic has to be written explicitly.
- **Cleanup obligation falls on the code, not the JVM** — anything needing explicit cleanup will leak unless the code guarantees cleanup *during* the unwind, not after. This is the direct motivation for `finally` (Part 9: `finally`, In Depth) and try-with-resources (Part 10: Try-With-Resources).

---

### Common misconception
> "Stack unwinding pops the entire stack down to main, and then Java figures out who catches it."

**Correct mental model:** Unwinding is a frame-by-frame, top-down search that **stops the instant a matching handler is found**. Frames below the handler are never even inspected.

### Common developer mistake
Assuming that after an exception is caught several layers up, the methods in between are somehow still "paused" and could theoretically be returned to. They are not — their frames are permanently destroyed.

### Senior-level perspective
A junior developer treats stack unwinding as an invisible implementation detail. A senior developer treats it as the direct explanation for *why* resource-cleanup patterns are non-negotiable in exception-heavy code.

---

# Part 8 — `try` and `catch`, In Depth

### 1. The basic mechanics

```java
try {
    riskyOperation();
} catch (SomeException e) {
    // handling
}
```

A `try` block defines a region of code being **monitored** for exceptions. A `catch` clause declares two things simultaneously: **what type of exception it's willing to handle**, and **the code that runs if a match is found**.

### 2. Exception matching — the precise rule

**A `catch (T e)` clause matches a thrown exception if the thrown object's actual runtime class is `T`, or is a subclass of `T`.**

```java
try {
    throw new java.io.FileNotFoundException("missing");
} catch (java.io.IOException e) {
    // MATCHES — FileNotFoundException extends IOException
    System.out.println("Caught: " + e.getClass().getSimpleName());
}
```

### 3. Multiple catch blocks and catch ordering

```java
try {
    process();
} catch (java.io.FileNotFoundException e) {
    System.out.println("File missing");
} catch (java.io.IOException e) {
    System.out.println("Other I/O problem");
} catch (Exception e) {
    System.out.println("Something else");
}
```

When multiple `catch` blocks are present, Java evaluates them **top to bottom**, using the **first one that matches** — not the "most specific" one, the *first textually listed* one.

Reversing the order:

```java
try {
    process();
} catch (java.io.IOException e) {
    System.out.println("Other I/O problem");
} catch (java.io.FileNotFoundException e) {  // COMPILE ERROR
    System.out.println("File missing");
}
```

This **does not compile** — since `FileNotFoundException` is a subtype of `IOException` and `IOException`'s catch comes first, the `FileNotFoundException` catch could **never possibly execute**. Java treats this as unreachable code.

**The rule: catch blocks must be ordered from most specific to least specific.**

### 4. Parent vs. child exception — why `catch (Exception e)` is often problematic

```java
try {
    readFile();
    parseData();
    saveToDatabase();
} catch (Exception e) {
    System.out.println("Something went wrong");
}
```

Problems this causes:
- **Loss of information** — the handling code has no idea *which* operation actually failed.
- **Accidentally catching bugs, not just expected failures** — a `NullPointerException` from a genuine coding mistake gets caught and "handled" the same as a legitimate I/O failure.
- **Violates the "catch what you can handle" principle** (Part 15: Exception Handling Principles) — a single generic response usually can't meaningfully "handle" three unrelated failure categories.

### When broad catching *can* be justified

- **A top-level boundary** — e.g., a request handler in a server framework, or `main()`, where the goal genuinely is "don't let this thread die no matter what; log everything and respond gracefully."
- **A last-resort safety net**, explicitly documented as such.

**Is this broad catch a deliberate architectural boundary, or is it a substitute for actually thinking about what can fail?**

### 5. Analyzing the specific order example

```java
try {
    // code
} catch (IOException e) {
    // ...
} catch (Exception e) {
    // ...
}
```

`IOException` (more specific) is listed first, `Exception` (broader) second. This **is legal** — it compiles, because `IOException` genuinely is more specific than the catch below it. Specific handling for failures you understand, with a broader safety net beneath for anything unanticipated.

### 6. Multi-catch — one block, several types

```java
try {
    process();
} catch (java.io.IOException | java.sql.SQLException e) {
    System.out.println("Operation failed: " + e.getMessage());
}
```

Rules:
- The listed types must not be in a subtype/supertype relationship with each other.
- `e`'s **static type**, inside the block, is the closest common supertype of the listed alternatives.
- `e` is implicitly treated as effectively `final`.

### 7. Nested try/catch

```java
try {
    process();
} catch (java.io.IOException e) {
    try {
        notifyMonitoringSystem(e); // this call might ALSO throw
    } catch (RuntimeException notifyFailure) {
        System.out.println("Even the notification failed: " + notifyFailure.getMessage());
    }
    System.out.println("Original failure: " + e.getMessage());
}
```

The code that runs in response to a failure can itself fail, and needs its own protection, independent of the outer handling logic.

### 8. Catching specific vs. broad — connecting back to design

**Catch the most specific type you can meaningfully respond to differently, and let genuinely broad "something unexpected happened" catches exist only as deliberate, well-understood boundaries** — not as a default reflex to make the compiler stop complaining.

---

### Common misconception
> "`catch (Exception e)` is a safe, convenient way to make sure nothing ever crashes my program."

**Correct mental model:** It *prevents* crashes at the cost of **hiding what actually failed** — including genuine bugs. "Nothing crashes" is not the same as "the program is working correctly."

### Common developer mistake
Ordering catch blocks from general to specific out of habit — either fails to compile or makes the specific handler completely dead code.

### Senior-level perspective
A senior developer reads a stack of `catch` blocks as a **deliberately designed decision tree** — each clause representing a distinct, intentional response to a distinct category of failure, ordered by specificity, with any broad catch-all placed last and treated as a boundary of last resort.

---

# Part 9 — `finally`, In Depth

### 1. Why `finally` exists

`finally` exists to guarantee cleanup happens **no matter how the method exits** — whether it returns normally, throws a checked exception, throws an unchecked exception, or even if a `catch` block itself throws.

```java
java.io.FileWriter fw = null;
try {
    fw = new java.io.FileWriter("out.txt");
    fw.write("data");
} catch (java.io.IOException e) {
    System.out.println("Write failed: " + e.getMessage());
} finally {
    if (fw != null) {
        try {
            fw.close();
        } catch (java.io.IOException e) {
            System.out.println("Close failed too: " + e.getMessage());
        }
    }
}
```

### 2. The four ways a `try` (or `catch`) block can exit, and `finally`'s behavior in each

1. **Normal completion** → `finally` runs, then execution continues.
2. **An exception is thrown and caught**, and the `catch` block completes normally → `finally` runs after, then execution continues.
3. **An exception is thrown and not caught** → `finally` still runs, **then** the exception continues propagating — `finally` doesn't stop or swallow it.
4. **The `try` (or `catch`) block exits via `return`, `break`, or `continue`** → `finally` still runs **before** control actually transfers.

**`finally` runs on every single path out of the `try`/`catch`, with no exceptions to that rule** — but *what happens after* depends on how control was leaving.

### 3. The tricky case: `return` inside both `try` and `finally`

```java
int test() {
    try {
        return 10;
    } finally {
        return 20;
    }
}
```

**Step by step:**

1. `try` block executes `return 10;`. Java computes the return value `10` and **holds it**, then checks for `finally`.
2. Before actually returning, `finally` executes.
3. `finally` itself executes `return 20;` — a **new, independent return**.
4. Because `finally`'s `return` also exits the method, it **completely discards the pending return value of `10`**. The method returns `20`.

**`test()` returns `20`. The `10` is silently discarded.**

This is why this pattern is flagged by virtually every static analysis tool: **a `return` (or `throw`, or `break`/`continue`) inside `finally` unconditionally overrides whatever the `try` or `catch` block was trying to do**, silently.

### 4. The second tricky case: `throw` inside `finally`

```java
void test() {
    try {
        throw new RuntimeException("A");
    } finally {
        throw new RuntimeException("B");
    }
}
```

**Step by step:**

1. `try` throws `RuntimeException("A")`. Java checks for a `finally` block.
2. `finally` executes. Partway through, it throws `RuntimeException("B")`.
3. This new exception **completely replaces** the original — `RuntimeException("A")` is **abandoned mid-propagation**, never seen by any caller, not chained, not logged.
4. The method throws `RuntimeException("B")` only.

**Whatever `finally` does to leave the block — return, throw, break, continue — wins, unconditionally, discarding whatever the `try`/`catch` block was doing, including an in-flight exception.**

Contrast this with a **suppressed exception** (Part 11: Suppressed Exceptions) — a different, safer mechanism specifically designed to preserve both exceptions when a resource's automatic `close()` throws during propagation.

### 5. "`finally` always executes" — the limitations

Real, documented exceptions:

- **`System.exit()`** called inside `try`/`catch` terminates the JVM immediately — `finally` **never runs**.
- **The JVM crashes or is killed** — `finally` obviously can't run if the process no longer exists.
- **An infinite loop or the thread hangs inside the `try` block** — if the `try` block never finishes, `finally` never gets the chance to run.
- **`StackOverflowError` or `OutOfMemoryError` at the exact moment `finally` itself tries to run** — may fail partway through or not run properly.

**`finally` is guaranteed to run for every *normal* Java-level control-flow exit from `try`/`catch` — but it is not a guarantee that survives process termination or catastrophic JVM failure.**

---

### Common misconception
> "`finally` always executes, no matter what."

**Correct mental model:** `finally` is guaranteed to run for every *ordinary language-level* way of leaving `try`/`catch` — but it is not immune to `System.exit()`, a killed/crashed process, an infinite loop, or a fatal `Error` during `finally` itself.

### Common developer mistake
Putting `return` or `throw` inside a `finally` block, usually unintentionally — silently discarding whatever the `try`/`catch` was actually trying to communicate.

### Senior-level perspective
A senior developer knows: **`finally` doesn't just "also run" — it has the power to completely override the outcome of `try`/`catch`, silently, for return values and in-flight exceptions alike.** This is exactly why try-with-resources (Part 10: Try-With-Resources) is generally preferred for resource cleanup.

---

# Part 10 — Try-With-Resources

### 1. The problem this solves — manual cleanup is genuinely hard to get right

```java
java.io.FileReader fr = null;
try {
    fr = new java.io.FileReader("data.txt");
    // use fr
} finally {
    if (fr != null) {
        fr.close(); // this itself can throw IOException!
    }
}
```

The `null` check is required because if `new FileReader(...)` itself throws, `fr` is never assigned. With two resources, this pattern gets significantly worse, and this is exactly the boilerplate-under-pressure situation flagged in Part 3 (Checked vs. Unchecked Exceptions, In Depth) — developers routinely get the null-checks, close-ordering, or exception-swallowing subtly wrong.

### 2. `AutoCloseable` and `Closeable`

```java
public interface AutoCloseable {
    void close() throws Exception;
}
```

```java
public interface Closeable extends AutoCloseable {
    void close() throws java.io.IOException; // narrows the declared exception type
}
```

`Closeable` narrows `close()`'s declared exception from `Exception` to the more specific `IOException` — legal because a subinterface can *narrow*, but never *broaden*, a declared checked exception (Part 17: Exception Behavior in Method Overriding).

### 3. Basic syntax and what it desugars to

```java
try (java.io.FileReader fr = new java.io.FileReader("data.txt")) {
    // use fr
} catch (java.io.IOException e) {
    System.out.println("Failed: " + e.getMessage());
}
```

Conceptually equivalent to:

```java
java.io.FileReader fr = new java.io.FileReader("data.txt");
try {
    // use fr
} finally {
    fr.close(); // guaranteed, automatically inserted
} 
```

...except with **correct exception-preserving behavior** that the naive hand-written `finally` version doesn't give you for free (Part 11: Suppressed Exceptions).

### 4. Resource lifecycle — when construction, use, and closing happen

1. Each resource expression is evaluated and constructed, **in the order written**.
2. If any resource's constructor throws, resources already successfully constructed *before* it are still closed.
3. The `try` block body executes.
4. Once the body finishes — normally or via exception — **every successfully-constructed resource is automatically closed**.
5. Only after all closing is complete does control leave the `try` block.

### 5. Multiple resources and closing order

```java
try (java.io.FileReader fr1 = new java.io.FileReader("a.txt");
     java.io.FileReader fr2 = new java.io.FileReader("b.txt")) {
    // use both
}
```

Resources are **constructed in the order declared** (`fr1` then `fr2`), but **closed in the reverse order** (`fr2` first, then `fr1`) — "last acquired, first released."

If `fr2`'s construction throws (after `fr1` succeeded), Java still closes `fr1` before letting that failure propagate.

### 6. Exceptions during closing — the problem this section sets up for Part 11 (Suppressed Exceptions)

```java
try (Resource r = new Resource()) {
    throw new RuntimeException("body failed");
    // when the try block exits, r.close() runs automatically —
    // suppose close() ALSO throws IllegalStateException("close failed")
}
```

**The exception from the body (`"body failed"`) becomes the primary exception that actually propagates**, and the exception from `close()` (`"close failed"`) is **attached to it as a suppressed exception** rather than replacing it. Both are preserved.

### 7. Why try-with-resources is safer than manual cleanup — summary

| | Manual `finally` cleanup | Try-with-resources |
|---|---|---|
| Null-check needed before `close()`? | Yes, manually | Automatic |
| Multiple resources closed in correct order? | Manual, error-prone | Automatic, guaranteed reverse order |
| Exception in body + exception in close, both preserved? | No — second silently replaces first | Yes — first is primary, second becomes suppressed |
| Boilerplate | Significant, scales badly | Minimal |

---

### Common misconception
> "Try-with-resources is just syntactic sugar for putting `close()` in a `finally` block — same behavior, less typing."

**Correct mental model:** It's syntactic sugar for something **behaviorally better** — it correctly preserves both exceptions when the body fails *and* closing fails, whereas a naive `finally` silently discards one of them.

### Common developer mistake
Assuming any class with a method literally named `close()` can be used in try-with-resources. Only types implementing `AutoCloseable` (or `Closeable`) qualify.

### Senior-level perspective
A senior developer recognizes try-with-resources as **the correct default for anything implementing `AutoCloseable`**, specifically because of its superior exception-preservation guarantees.

---

# Part 11 — Suppressed Exceptions

### 1. The scenario, precisely

```java
class Resource implements AutoCloseable {
    void doWork() {
        throw new RuntimeException("work failed");
    }
    @Override
    public void close() {
        throw new IllegalStateException("close failed");
    }
}

void run() {
    try (Resource r = new Resource()) {
        r.doWork(); // throws RuntimeException("work failed")
        // close() throws IllegalStateException("close failed")
    }
}
```

### 2. Which becomes primary, which becomes suppressed

**Rule: the exception from the `try` block body becomes the primary (propagating) exception. Any exception thrown during the automatic `close()` call is attached to it as a suppressed exception, rather than replacing it.**

```java
try {
    run();
} catch (RuntimeException e) {
    System.out.println("Primary: " + e.getMessage());
    for (Throwable suppressed : e.getSuppressed()) {
        System.out.println("Suppressed: " + suppressed.getMessage());
    }
}
```

Output:
```
Primary: work failed
Suppressed: close failed
```

Compare this to the equivalent hand-written `finally` version (Part 9: `finally`, In Depth), where the second exception would have **completely replaced** the first, and the first would simply be gone.

### 3. `getSuppressed()`

```java
public final Throwable[] getSuppressed()
```

Returns an array — possibly empty — of every exception that was suppressed in relation to this one. Multiple resources can each contribute a suppressed exception to the same primary, in closing order.

### 4. The edge case: what if the body succeeds but `close()` fails?

```java
try (Resource r = new Resource()) {
    // body completes normally — no exception here
} 
// close() throws IllegalStateException("close failed")
```

If there's no exception from the body, there's nothing for the close-time exception to be suppressed *underneath* — it simply becomes the primary (and only) exception itself.

### 5. Why this matters for debugging — the real payoff

```
java.lang.RuntimeException: work failed
    at Resource.doWork(Resource.java:4)
    at run(Example.java:11)
    Suppressed: java.lang.IllegalStateException: close failed
        at Resource.close(Resource.java:8)
        at run(Example.java:10)
```

This tells you **the complete truth**: the real operation failed for one reason, *and* cleanup independently failed for a different reason — both visible, both stack traces intact.

### 6. Why hand-writing this yourself is easy to get subtly wrong

```java
Resource r = new Resource();
try {
    r.doWork();
} finally {
    try {
        r.close();
    } catch (Exception closeEx) {
        // now what? log it? throw it? attach it to something?
    }
}
```

The honest answer requires manually implementing exactly the primary/suppressed logic Java gives you for free — checking whether an exception is *already* propagating, and calling `addSuppressed()` on it rather than throwing directly.

---

### Common misconception
> "If the body throws and close() also throws, Java just picks whichever one is 'more severe' to show you."

**Correct mental model:** There's no severity judgment involved. The rule is purely positional: **the exception from the `try` block body is always primary; anything thrown during the resulting automatic `close()` is always suppressed and attached underneath it.**

### Common developer mistake
Catching the primary exception and logging only `e.getMessage()` without also checking `e.getSuppressed()` — silently missing real diagnostic information.

### Senior-level perspective
A senior developer recognizes `Suppressed:` in a stack trace as a specific, meaningful signal: **two independent failures occurred at the same exit point**, and both need to be understood.

---

# Part 12 — Exception Cause and Chaining

### 1. The problem this solves

```java
void saveUser(User user) throws UserServiceException {
    try {
        database.insert(user);
    } catch (SQLException e) {
        throw new UserServiceException("Could not save user"); // PROBLEM: e is discarded
    }
}
```

This compiles and "works" — but silently destroys the original `SQLException`. Whoever catches `UserServiceException` later sees only `"Could not save user"` — no indication of *why*.

**Exception chaining exists to solve exactly this: translate an exception to a more meaningful type for your API's callers, without losing the original failure information.**

### 2. `throw new MyException(msg, e)` vs. `throw e` vs. `throw new RuntimeException(e)`

```java
// Option A — rethrow the SAME object
} catch (SQLException e) {
    throw e;
}
```
Same object, same original stack trace, no translation at all — sometimes appropriate, often leaks a low-level type to callers who shouldn't need to know about it.

```java
// Option B — wrap, WITH the cause preserved
} catch (SQLException e) {
    throw new UserServiceException("Could not save user", e);
}
```
A **new** object with its own new stack trace, but it also carries a reference to `e` as its **cause**. Nothing is lost.

```java
// Option C — wrap, WITHOUT the cause
} catch (SQLException e) {
    throw new UserServiceException("Could not save user"); // no second argument!
}
```
`e` is simply gone — permanently unrecoverable. This is: **losing the cause**.

### 3. `getCause()` and `initCause()`

```java
public Throwable getCause()
```
Returns the exception that caused this one, or `null`.

```java
public Throwable initCause(Throwable cause)
```
Sets the cause **after** construction — usable exactly once. In practice, passing the cause directly into a constructor (`new UserServiceException(msg, e)`) is by far the more common and idiomatic approach.

### 4. What a chained exception's stack trace actually looks like

```
UserServiceException: Could not save user
    at saveUser(Example.java:5)
    at main(Example.java:12)
Caused by: java.sql.SQLException: connection refused
    at Database.insert(Database.java:22)
    at saveUser(Example.java:3)
    ... 1 more
```

Two full stack traces, both preserved, explicitly linked by the `Caused by:` marker.

### 5. Chains can be multiple levels deep

```
Caused by: java.sql.SQLException: connection refused
Caused by: java.net.ConnectException: Connection timed out
```

Each layer of a system can translate the exception it received into something meaningful for *its* callers, without severing the link to what came before.

### 6. Suppressed vs. cause — the precise difference

| | Cause (`getCause()`) | Suppressed (`getSuppressed()`) |
|---|---|---|
| Represents | "This exception happened **because of** that earlier one" | "This *other*, independent exception **also** happened, at the same exit point" |
| Relationship | Causal — one triggered the other, sequentially | Coincidental — both are real failures, but neither caused the other |
| When it's set | Explicitly, by the developer, when translating/wrapping an exception | Automatically, by try-with-resources, when body-exception and close-exception collide |
| Typical scenario | Layered translation | Resource cleanup colliding with a body failure |

### 7. Why cause chains matter for debugging — tying it together

**Whenever you catch an exception in order to throw a different, more meaningful one, always ask whether the original carries information a future debugger will need — and if it might, pass it as the cause.**

---

### Common misconception
> "Rethrowing and wrapping are basically the same thing — both just 'pass the exception along.'"

**Correct mental model:** Rethrowing (`throw e`) propagates the **identical object**, unchanged. Wrapping (`throw new X(msg, e)`) creates a **genuinely new object** that *references* the original as its cause.

### Common developer mistake
Wrapping an exception for a good reason but forgetting the second constructor argument — silently throwing away the one piece of information that would have mattered most during debugging.

### Senior-level perspective
A senior developer treats the **absence of a cause argument** in a wrapped exception as an immediate code-review flag.

---

# Part 13 — Custom Exceptions

### 1. Why custom exceptions exist at all

The real question a senior developer asks before writing `class MyException extends Exception` is: **does a built-in type already say what I mean, or does my failure represent a distinct concept that deserves its own name?**

- **Domain meaning** — `IllegalArgumentException` says nothing about *what business rule was violated*. `InsufficientFundsException` names the actual domain concept.
- **Selective catching at API boundaries** — if your data-access layer only ever throws your own `UserServiceException` (rather than leaking `SQLException`, `IOException`, etc.), callers of your service layer can catch exactly one type.

### 2. Extending `Exception` vs. extending `RuntimeException`

```java
// Checked custom exception
class InsufficientFundsException extends Exception {
    public InsufficientFundsException(String message) {
        super(message);
    }
}
```

```java
// Unchecked custom exception
class InsufficientFundsException extends RuntimeException {
    public InsufficientFundsException(String message) {
        super(message);
    }
}
```

Apply the same reasoning from Part 3 (Checked vs. Unchecked Exceptions, In Depth): is this failure **foreseeable and something the caller could reasonably act on differently**? → checked. Is it closer to **a violated precondition or a programming mistake**? → unchecked.

Much of the modern Java ecosystem (Spring, and many newer libraries) leans toward **unchecked custom exceptions by default**, specifically to avoid the boilerplate/empty-catch problems from Part 3 (Checked vs. Unchecked Exceptions, In Depth).

### 3. Constructors — the standard pattern to follow

```java
class InsufficientFundsException extends RuntimeException {

    public InsufficientFundsException(String message) {
        super(message);
    }

    public InsufficientFundsException(String message, Throwable cause) {
        super(message, cause);
    }
}
```

The second constructor is what makes `throw new InsufficientFundsException("...", e)` possible at all — skip it, and anyone using your exception type is structurally *unable* to preserve a cause when wrapping.

### 4. Custom fields — adding structured context beyond a message

```java
class InsufficientFundsException extends RuntimeException {
    private final java.math.BigDecimal requested;
    private final java.math.BigDecimal available;

    public InsufficientFundsException(java.math.BigDecimal requested, java.math.BigDecimal available) {
        super("Requested " + requested + " but only " + available + " available");
        this.requested = requested;
        this.available = available;
    }

    public java.math.BigDecimal getRequested() { return requested; }
    public java.math.BigDecimal getAvailable() { return available; }
}
```

```java
catch (InsufficientFundsException e) {
    BigDecimal shortfall = e.getRequested().subtract(e.getAvailable());
    // meaningful, structured recovery logic — impossible from a message string alone
}
```

### 5. Exception hierarchy design — organizing multiple custom exceptions

```java
abstract class UserServiceException extends RuntimeException {
    protected UserServiceException(String message, Throwable cause) {
        super(message, cause);
    }
}

class UserNotFoundException extends UserServiceException {
    public UserNotFoundException(String id) {
        super("No user found with id " + id, null);
    }
}

class DuplicateUserException extends UserServiceException {
    public DuplicateUserException(String id, Throwable cause) {
        super("User already exists with id " + id, cause);
    }
}
```

Callers can catch `UserServiceException` broadly, or catch specific subtypes when they need to react differently.

### 6. When to create a custom exception vs. reuse an existing one

**Reuse an existing exception when:**
- The situation is a genuine, generic violation already well-captured by a built-in type.
- You're deep inside a single method where no caller will ever meaningfully distinguish this failure from a generic one.

**Create a custom exception when:**
- The failure represents a **real domain concept** that deserves a name of its own.
- You want callers at an API boundary to catch a specific, stable type without knowing your internal implementation.
- You need structured data attached to the failure.

**Bad design example** — creating one exception class per method, for failures that aren't actually distinct:

```java
class UserNameTooLongException extends RuntimeException { ... }
class UserNameTooShortException extends RuntimeException { ... }
class UserNameContainsInvalidCharsException extends RuntimeException { ... }
class UserEmailInvalidFormatException extends RuntimeException { ... }
```

These are all really just "**validation failed**, here's which field and why" — one class with a `field` and `reason` field would serve every caller equally well.

**Another bad design**: a custom exception with no `(String, Throwable)` overload — structurally preventing anyone from ever chaining a cause into it.

---

### Common misconception
> "Every distinct failure reason in my application deserves its own custom exception class."

**Correct mental model:** A custom exception should represent a **domain concept a caller might reasonably need to distinguish and react to differently** — not merely "a different string I could put in a message."

### Common developer mistake
Designing a custom exception without a `(String message, Throwable cause)` constructor, then later discovering it can't wrap a lower-level exception.

### Senior-level perspective
The bar for "this deserves its own class" is **meaningfully distinct handling**, not merely "a different failure reason exists."

---

# Part 14 — Exception Naming and Design

### 1. Naming — precision over vagueness

```java
throw new Exception("Failed");
```

vs.

```java
throw new InsufficientFundsException("Withdrawal of 500.00 failed: only 320.00 available");
```

An exception's **type name alone** should communicate most of the story before anyone even reads the message. A useful discipline: an exception's name should describe **what specifically went wrong**, not the fact that *something* went wrong.

### 2. Meaningful messages — what should actually be in one

```java
// Vague — technically true, useless in practice
throw new InsufficientFundsException("Insufficient funds");

// Concrete — actionable
throw new InsufficientFundsException(
    "Withdrawal of 500.00 failed for account 8842: only 320.00 available");
```

When structured data is available, put it in **both** the message (for humans scanning logs) and dedicated fields (for code that wants to react programmatically).

### 3. Exception granularity — how many types is "enough"?

**Too coarse** — one exception type for an entire subsystem, with the actual reason buried only in the message string. A caller wanting to react differently has no way to do so without **parsing the message string**.

**Too fine** — a distinct exception class for every conceivable variation, where every caller writes near-identical `catch` blocks for types that are never actually handled differently.

**The right granularity**: one type per **behaviorally distinct** failure — distinct meaning "a caller might reasonably need to catch this specifically and do something genuinely different in response."

```java
throw new OutOfStockException(sku, requestedQty, availableQty);
throw new PaymentDeclinedException(reason);
throw new InvalidShippingAddressException(field, value);
```

### 4. Domain meaning vs. technical detail

```java
// Technical detail leaking through
throw new RuntimeException("SQL constraint violation: uq_user_email");
```

```java
// Domain meaning
throw new DuplicateUserException(email);
```

The wrapper's name should match the abstraction level of its caller, not the abstraction level of what failed underneath it.

### 5. Reusability — designing for more than one call site

```java
class ValidationException extends RuntimeException {
    private final String field;
    private final Object rejectedValue;

    public ValidationException(String field, Object rejectedValue, String reason) {
        super("Validation failed for field '" + field + "': " + reason);
        this.field = field;
        this.rejectedValue = rejectedValue;
    }

    public String getField() { return field; }
    public Object getRejectedValue() { return rejectedValue; }
}
```

"One class, parameterized" avoids both the too-coarse trap and the too-fine trap by making the *distinguishing information* data rather than type.

### 6. Error context — how much information is "enough"?

- **Too little context** — `"Operation failed"` — forces reconstruction from scratch.
- **Too much context** — dumping entire objects, full request bodies, or sensitive data (passwords, tokens, credit card numbers) into an exception message that will end up in logs.

**Include enough identifying information to locate and understand the specific failure — without including entire object graphs or anything that shouldn't be persisted in a log in the first place.**

### 7. Preserving causes — the naming-and-design tie-in to Part 12 (Exception Cause and Chaining)

A well-named, well-designed exception that **drops its cause** is still a badly designed exception overall, no matter how good its message is.

---

### Common misconception
> "As long as the exception has a clear name, the message content doesn't matter much — the type already says what happened."

**Correct mental model:** The type communicates the **category** of failure; the message communicates the **specific instance** of it. Both are needed.

### Common developer mistake
Writing exception messages that make sense *only* with the surrounding code visible — effectively useless once separated from that context in an aggregated log viewer.

### Senior-level perspective
Good naming and message design directly determines how fast a future incident gets resolved.

---

# Part 15 — Exception Handling Principles

## Principle 1 — Catch only what you can handle

**Bad approach**
```java
try {
    processOrder(order);
} catch (Exception e) {
    System.out.println("Something went wrong");
}
```

**Why it's bad**
"Handling" here means nothing more than printing a line and moving on. Whatever `processOrder` was supposed to accomplish has silently *not* happened.

**Better approach**
```java
try {
    processOrder(order);
} catch (PaymentDeclinedException e) {
    notifyCustomer(order, e);
    orderRepository.markFailed(order, e);
}
```

**Why it's better**
This handler does something genuinely responsive to *this specific* failure.

**Senior-level consideration**
The test is "**does catching this here let me do something meaningfully different than if I let it propagate?**" If not, don't catch it, or catch it only at an explicitly-designed last-resort boundary.

---

## Principle 2 — Don't swallow exceptions

**Bad approach**
```java
try {
    sendNotification(user);
} catch (Exception e) {
    // nothing here
}
```

**Why it's bad**
The single most dangerous pattern: the failure is caught, and **all information about it is destroyed**.

**Better approach**
```java
try {
    sendNotification(user);
} catch (NotificationException e) {
    logger.warn("Failed to notify user {}", user.getId(), e);
}
```

**Why it's better**
The failure is now visible, even though the code decided not to escalate it.

**Senior-level consideration**
An empty `catch` block should be treated as close to a compile error in code review.

---

## Principle 3 — Don't lose the original cause

**Bad approach**
```java
} catch (SQLException e) {
    throw new UserServiceException("Could not save user");
}
```

**Better approach**
```java
} catch (SQLException e) {
    throw new UserServiceException("Could not save user", e);
}
```

**Senior-level consideration**
Any time you write `throw new SomeException(...)` inside a `catch` block, the immediate next thought should be "does my exception type accept a cause, and did I pass one?"

---

## Principle 4 — Don't catch unnecessarily broad exceptions

**Bad approach**
```java
try {
    validateInput(request);
    chargeCard(request);
    shipOrder(request);
} catch (Throwable t) {
    log.error("Order failed", t);
}
```

**Why it's bad**
`Throwable` catches *everything*, including `Error` subtypes like `OutOfMemoryError`. A JVM-level catastrophe gets handled identically to "the card was declined."

**Better approach**
```java
} catch (ValidationException | PaymentException | ShippingException e) {
    log.error("Order failed", e);
    orderRepository.markFailed(request, e);
}
```

**Senior-level consideration**
`catch (Exception e)` and especially `catch (Throwable t)` should be reserved for genuine architectural boundaries — not sprinkled throughout business logic as a defensive habit.

---

## Principle 5 — Don't use exceptions as normal control flow

**Bad approach**
```java
try {
    return cache.get(key);
} catch (KeyNotFoundException e) {
    return computeAndCache(key);
}
```

**Why it's bad**
A cache miss is not exceptional — it's a completely normal, expected outcome.

**Better approach**
```java
Optional<Value> cached = cache.get(key);
return cached.orElseGet(() -> computeAndCache(key));
```

**Senior-level consideration**
If a "failure" happens on a large fraction of calls under completely normal operation, it's very likely **not** exception-worthy.

---

## Principle 6 — Don't blindly log and rethrow

**Bad approach**
```java
// Layer 1, Layer 2, Layer 3 — each does:
try {
    process();
} catch (ProcessingException e) {
    log.error("Processing failed", e);
    throw e;
}
```

**Why it's bad**
The exact same failure now appears **three times** in the logs.

**Better approach**
Only the layer that actually decides not to handle further, or the top-level boundary, logs it — once.

**Senior-level consideration**
Ask, at every `catch` block: "**am I the one deciding what ultimately happens with this failure, or am I just watching it pass through?**"

---

## Principle 7 — Write meaningful exception messages

**Bad approach**
```java
throw new ValidationException("Invalid input");
```

**Better approach**
```java
throw new ValidationException("email", providedEmail, "must contain '@'");
```

(Fully covered in Part 14: Exception Naming and Design.)

---

## Principle 8 — Catch specific exceptions when possible

**Bad approach**
```java
try {
    int id = Integer.parseInt(request.getParam("id"));
    User user = userRepository.findById(id);
    user.activate();
} catch (Exception e) {
    return ResponseEntity.status(500).body("Error");
}
```

**Why it's bad**
Three genuinely different failure modes collapse into an identical, unhelpful 500 response.

**Better approach**
```java
} catch (NumberFormatException e) {
    return ResponseEntity.status(400).body("Invalid id format");
} catch (UserNotFoundException e) {
    return ResponseEntity.status(404).body("User not found");
} catch (IllegalStateException e) {
    return ResponseEntity.status(409).body("User already active");
}
```

**Senior-level consideration**
The cost of over-broad catching isn't just less precise logging — it's a genuinely worse API for whoever's calling your code.

---

## Principle 9 — Preserve useful context

**Bad approach**
```java
} catch (InventoryException e) {
    throw new OrderProcessingException("Could not process order", e); // lost: which SKU? which quantity?
}
```

**Better approach**
```java
} catch (InventoryException e) {
    throw new OrderProcessingException(
        "Could not process order for SKU " + sku + " (qty " + quantity + ")", e);
}
```

**Senior-level consideration**
Preserving the cause keeps what the lower layer knew; adding message context at each wrap point keeps what *this* layer knew. Both together give a complete picture.

---

### Common misconception
> "Following these principles means writing more defensive code — more try/catch blocks, more handling."

**Correct mental model:** Several of these principles (1, 5, 6) actually argue for **fewer, more deliberate** catch blocks.

### Common developer mistake
Applying these principles inconsistently — a beautifully specific, cause-preserving exception, swallowed two layers up by a lazy `catch (Exception e) {}`.

### Senior-level perspective
A senior developer sees exception handling as a **single coherent design discipline running from the `throw` site all the way to wherever the failure is finally resolved**.

---

# Part 16 — Exception Handling vs. Exception Throwing

### 1. The eight distinct concepts, defined precisely

| Concept | Precise meaning | Where covered |
|---|---|---|
| **Detecting a failure** | Code determines something has gone wrong | Implicit throughout |
| **Throwing** | Constructing a `Throwable` and executing `throw` on it | Part 4 (The `throw` Statement, In Depth) |
| **Propagating** | The exception moving up the call stack, unhandled, frame by frame | Parts 6–7 |
| **Catching** | A `catch` clause's type matches the exception, control transfers | Part 8 (`try` and `catch`, In Depth) |
| **Handling** | Code in a `catch` block genuinely *resolves* the situation | Part 15 (Exception Handling Principles), Principle 1 |
| **Rethrowing** | `throw e` — propagating the *same* object onward | Part 4 (The `throw` Statement, In Depth) |
| **Wrapping** | `throw new X(msg, e)` — a *new* exception referencing the original as cause | Part 12 (Exception Cause and Chaining) |
| **Suppressing** | A second exception during cleanup gets attached rather than replacing the first | Part 11 (Suppressed Exceptions) |

**Catching and handling are not the same thing.** You can catch an exception and do nothing meaningful with it — that's catching *without* handling. Handling presupposes catching, but catching does not imply handling.

### 2. The full lifecycle, worked through on one realistic example

```java
void chargeCard(Order order) {
    try {
        paymentGateway.charge(order.getAmount(), order.getCardToken());
    } catch (GatewayTimeoutException e) {
        throw new PaymentProcessingException("Payment timed out for order " + order.getId(), e);
    }
}

void processOrder(Order order) {
    try {
        chargeCard(order);
    } catch (PaymentProcessingException e) {
        logger.error("Order failed", e);
        notificationService.alertOpsTeam(order, e);
        orderRepository.markFailed(order, e);
    }
}
```

1. **Failure detected** — `paymentGateway.charge()` determines the network call didn't complete in time.
2. **Exception thrown** — constructs and throws a `GatewayTimeoutException`.
3. **Exception propagated** — travels up to the `try` block inside `chargeCard()`.
4. **Exception caught** — `chargeCard()`'s `catch` matches.
5. **Exception wrapped** — a *new* `PaymentProcessingException` is constructed, with the original as cause, and thrown. `chargeCard()` caught but did **not** handle in the "genuinely resolved" sense.
6. **Exception propagated again** — travels up to `processOrder()`.
7. **Exception caught again** — `processOrder()`'s `catch` matches.
8. **Exception handled** — logging, alerting, and marking the order failed are real, meaningful responses that resolve what to do.

### 3. Alternative paths from the same starting point

**Path A — rethrow instead of wrap:**
```java
} catch (GatewayTimeoutException e) {
    throw e; // same object, no translation
}
```
The lower-level type leaks through to a higher-level caller.

**Path B — actually handle, don't propagate further at all:**
```java
} catch (GatewayTimeoutException e) {
    return retryWithBackoff(order); // genuinely resolves it right here
}
```
No wrapping, no further propagation — `processOrder()` never even sees an exception.

**Path C — suppression enters the picture, if cleanup is involved:**
```java
try (var conn = paymentGateway.openConnection()) {
    conn.charge(order.getAmount());
} // if charge() throws AND conn.close() also throws, the close-time exception is suppressed
```

### 4. Why this vocabulary precision matters practically

"I'll just handle it here" said about a `catch` block that actually only logs and rethrows is a category error — that's *catching and propagating*, not *handling*.

---

### Common misconception
> "If a catch block runs, the exception has been 'handled.'"

**Correct mental model:** A `catch` block running means the exception was **caught** — a purely mechanical, type-matching event. Whether it was **handled** depends on what that block actually does.

### Common developer mistake
Describing every `catch` block indiscriminately as "error handling" — makes it hard to locate *where* a failure category is ultimately resolved.

### Senior-level perspective
A senior developer can look at any given `catch` block and immediately classify which stage it represents — catch-and-handle, catch-and-wrap, catch-and-rethrow, or catch-only-to-clean-up-then-rethrow.

---

# Part 17 — Exception Behavior in Method Overriding

### 1. The rule, stated precisely

**An overriding method may declare the same checked exceptions as the overridden method, narrower checked exceptions (subtypes), or fewer of them — but it may never declare a new or broader checked exception that the overridden method didn't already permit.**

Unchecked exceptions are **entirely unconstrained** by this rule.

### 2. Why this rule exists — it's really about substitutability

```java
class Parent {
    void process() throws IOException {
        // ...
    }
}

class Child extends Parent {
    @Override
    void process() throws SQLException { // COMPILE ERROR
        // ...
    }
}
```

```java
Parent p = new Child();
try {
    p.process();
} catch (IOException e) {
    // caller wrote this based on Parent's contract
}
```

**Polymorphism requires that a subclass be usable anywhere its parent type is expected**, without the caller needing to know or care which actual subclass it's dealing with. If `Child.process()` were allowed to throw an unrelated checked `SQLException`, the caller's `catch (IOException e)` would not catch it, and an exception the caller had no way to anticipate would propagate right past their handling code.

### 3. What IS allowed — narrowing

```java
class Child extends Parent {
    @Override
    void process() throws FileNotFoundException { // fine — FileNotFoundException extends IOException
    }
}
```

`FileNotFoundException` is a **subtype** of `IOException`, so any caller expecting to catch `IOException` will still successfully catch a `FileNotFoundException` too.

Also allowed — declaring **fewer** exceptions, including none at all:

```java
class Child extends Parent {
    @Override
    void process() { // no throws clause at all — also fine
    }
}
```

### 4. Multiple declared exceptions — the rule applies per-exception

```java
class Parent {
    void process() throws IOException, SQLException {
    }
}

class Child extends Parent {
    @Override
    void process() throws FileNotFoundException, SQLTimeoutException { // fine
    }
}
```

Each exception `Child` declares must be a subtype of *some* exception `Parent` declared:

```java
class Child extends Parent {
    @Override
    void process() throws FileNotFoundException, ClassNotFoundException { // COMPILE ERROR
        // ClassNotFoundException is not a subtype of IOException or SQLException
    }
}
```

### 5. Unchecked exceptions in overriding — no constraint at all

```java
class Parent {
    void process() {
        // no throws clause — declares nothing
    }
}

class Child extends Parent {
    @Override
    void process() throws IllegalStateException { // perfectly legal
        throw new IllegalStateException("not ready");
    }
}
```

Legal because unchecked exceptions were never part of the compiler-enforced contract to begin with — any method can always throw an unchecked exception, invisibly to the compiler.

### 6. Tying it back to Part 10 (Try-With-Resources) — why this rule matters for `AutoCloseable`/`Closeable`

```java
public interface AutoCloseable {
    void close() throws Exception;
}
public interface Closeable extends AutoCloseable {
    void close() throws IOException; // narrows Exception → IOException — legal by this exact rule
}
```

This is exactly the same overriding rule applied to an interface method instead of a class method.

### Step-by-step: what the compiler actually checks

Given `Child.process() throws X` overriding `Parent.process() throws Y1, Y2, ...`:

1. For each checked exception `X` that `Child` declares, the compiler checks: is `X` equal to, or a subtype of, *at least one* `Yi` in `Parent`'s list?
2. If yes for every declared `X` → compiles.
3. If any declared checked `X` has no matching supertype anywhere in `Parent`'s list → compile error.
4. Unchecked exceptions declared by `Child` are never checked against this rule at all.

---

### Common misconception
> "An overriding method must declare exactly the same exceptions as the method it overrides."

**Correct mental model:** It must declare the **same, narrower, or fewer** checked exceptions than the parent — never broader or entirely new ones.

### Common developer mistake
Assuming this rule also restricts unchecked exceptions — either avoiding declaring them in an override out of an unfounded worry, or being surprised when a subclass introduces a brand-new `RuntimeException` type nobody declared anywhere.

### Senior-level perspective
A senior developer recognizes this rule as the exception-specific instance of the **Liskov Substitution Principle**, applied specifically to checked-exception contracts — it exists to preserve the compile-time safety guarantee that makes checked exceptions worth having at all.

---

# Part 18 — Exceptions in Constructors

### 1. Constructors can throw checked exceptions, exactly like methods

```java
class DatabaseConnection {
    DatabaseConnection(String url) throws java.sql.SQLException {
        if (!isReachable(url)) {
            throw new java.sql.SQLException("Cannot reach " + url);
        }
    }
}
```

The exact same rules from Parts 3 (Checked vs. Unchecked Exceptions, In Depth) and 5 (The `throws` Declaration, In Depth) apply: a checked exception declared on a constructor must be caught or declared by whatever calls `new DatabaseConnection(url)`.

```java
void connect() throws java.sql.SQLException {
    DatabaseConnection conn = new DatabaseConnection("jdbc:..."); // must handle or declare
}
```

### 2. Constructors can throw unchecked exceptions too

```java
class Account {
    private final java.math.BigDecimal balance;

    Account(java.math.BigDecimal balance) {
        if (balance.signum() < 0) {
            throw new IllegalArgumentException("Initial balance cannot be negative");
        }
        this.balance = balance;
    }
}
```

No declaration obligation. This is one of the most common, idiomatic uses of unchecked exceptions: **enforcing invariants at construction time** so an object can never exist in an invalid state.

### 3. What happens when object creation fails — no object is ever produced

If a constructor throws — checked or unchecked — **the `new` expression never completes, and no reference to the object is ever returned to the caller.**

```java
Account a = new Account(new java.math.BigDecimal("-50")); // throws IllegalArgumentException
// this line never finishes — 'a' is never assigned anything
```

There is no partially-constructed object the caller could get a reference to — the exception propagates out of `new Account(...)` exactly like out of any method call (Part 6: Exception Propagation, In Depth).

### 4. Partially initialized objects — the internal, not external, story

```java
class Order {
    private final String id;
    private java.util.List<Item> items;

    Order(String id, java.util.List<Item> rawItems) {
        this.id = id;
        this.items = validate(rawItems); // throws before assignment lands
    }
}
```

If `validate()` throws, `this.id` was already set — but since no reference to `this` ever reaches the caller (section 3), that partially-set state is simply unreachable and eligible for garbage collection.

Where this *does* matter: if the constructor already caused **external side effects** — registered itself in a static collection, opened a file handle, started a thread — those side effects are **not automatically undone**:

```java
class Widget {
    private static final java.util.List<Widget> ALL = new java.util.ArrayList<>();

    Widget(String name) {
        ALL.add(this); // side effect happens immediately
        if (name == null) {
            throw new IllegalArgumentException("name required"); // ALL still contains 'this'!
        }
    }
}
```

A reference to the half-built object has already leaked into `ALL` before the exception was thrown. This is a real bug pattern: **publishing a reference to `this` before construction is guaranteed to succeed is dangerous if the constructor can still fail afterward.**

### 5. Why constructor failure has special implications

- **From the caller's perspective**: constructor failure is "clean" — no object exists at all.
- **From the constructor's own implementation**: not automatically clean internally — any side effect before the failure point already happened. Discipline: **do validation and anything that can fail *before* any external side effect or reference-publishing, not after.**

---

### Common misconception
> "If a constructor throws partway through, you get back a partially-built, damaged object."

**Correct mental model:** You get back **nothing at all**. The real danger isn't a damaged object surviving into the caller's hands — it's any external side effect that happened before the failure point, which is not automatically rolled back.

### Common developer mistake
Performing an external side effect early in a constructor, before validation that can still fail — leaking a reference to an object whose construction ultimately doesn't succeed.

### Senior-level perspective
A senior developer audits constructors for **ordering**: validation and anything that can fail should happen before any side effect that publishes a reference to the object.

---

# Part 19 — Exceptions During Initialization

### 1. Two kinds of initialization that can fail

- **Instance initialization** — instance variable initializers and initializer blocks, which run as part of every constructor call.
- **Static initialization** — static variable initializers and static blocks, which run **once**, the first time a class is actively used.

### 2. Instance initialization failures — nothing new, mechanically

```java
class Account {
    private int balance = 100 / 0; // instance initializer — throws ArithmeticException
}
```

Behaves exactly like the constructor-failure story from Part 18 (Exceptions in Constructors) — no object produced, ordinary propagation.

### 3. Static initialization failures — genuinely different, because it runs once

```java
class Config {
    static final int MAX_CONNECTIONS = 100 / 0; // static initializer — throws ArithmeticException
}
```

```java
void useConfig() {
    System.out.println(Config.MAX_CONNECTIONS); // triggers static init — fails
}
```

**What the caller actually observes: `ExceptionInInitializerError`, not the original `ArithmeticException` directly.**

### 4. `ExceptionInInitializerError`

An `Error` (Part 2: The Java Throwable Hierarchy), not an `Exception` — a failed static initializer means the class itself couldn't establish its shared, static invariants, treated as more fundamental than a single failed object construction. The original exception is preserved as the cause (the chaining mechanism from Part 12: Exception Cause and Chaining):

```java
try {
    System.out.println(Config.MAX_CONNECTIONS);
} catch (ExceptionInInitializerError e) {
    System.out.println("Cause: " + e.getCause()); // the original ArithmeticException
}
```

### 5. Initialization failure propagation — what happens on subsequent attempts

Once static initialization has failed, **the JVM marks that class as permanently unusable** for the remainder of that class loader's lifetime. Any *subsequent* attempt to use the class throws `NoClassDefFoundError`, not another `ExceptionInInitializerError` — the JVM never re-runs a static initializer that already failed once.

### 6. What a caller observes — summary

| Situation | What propagates |
|---|---|
| First use of a class whose static initializer throws | `ExceptionInInitializerError`, with the original exception as cause |
| Any subsequent use of that same (now-broken) class | `NoClassDefFoundError` |
| Instance initializer throws during `new SomeClass()` | The original exception itself — same as any constructor failure |

---

### Common misconception
> "If a static initializer throws, you just get the original exception, same as anywhere else."

**Correct mental model:** The *first* failure gives `ExceptionInInitializerError` with the original as cause. **Every subsequent** attempt gets `NoClassDefFoundError` instead, because the JVM never retries a failed static initializer.

### Common developer mistake
Writing a `catch` block that only anticipates `ExceptionInInitializerError`, missing that a *later* use of the same broken class throws `NoClassDefFoundError` instead.

### Senior-level perspective
A static initializer with even a rare failure path can render a class **permanently unusable for the rest of the application's run**. Anything genuinely risky (a real DB connection) is usually better performed lazily, on demand, with its own retry logic, rather than baked into static initialization.

---

# Part 20 — Exception Performance

### 1. Where the actual cost comes from — it's not the `throw` itself

**Cost 1 — Stack trace capture, at construction time.** `Throwable`'s constructor calls `fillInStackTrace()`, which walks the entire current call stack — cost proportional to stack depth, paid every time, regardless of whether the exception is ever caught or used.

**Cost 2 — The `throw`/`catch`/unwind machinery itself** — smaller, closer to a few extra method calls; modern JVMs are well optimized here.

**The concentrated cost is capturing the stack trace, not the propagation mechanism itself.**

### 2. Why exception-heavy code can be expensive — the real scenario

```java
int parseOrDefault(String s) {
    try {
        return Integer.parseInt(s);
    } catch (NumberFormatException e) {
        return 0; // called on a large fraction of inputs, by design, in a tight loop
    }
}
```

If a meaningful fraction of inputs are routinely non-numeric, every one pays the full stack-trace-capture cost for an outcome that isn't really exceptional. Same anti-pattern as Part 15 (Exception Handling Principles), Principle 5 — now viewed through a performance lens.

### 3. Suppressing stack trace capture — a technique with a serious caveat

```java
class FastValidationException extends RuntimeException {
    FastValidationException(String message) {
        super(message, null, false, false); // writableStackTrace = false
    }
}
```

Eliminates the stack-trace cost entirely, but the resulting exception has **no stack trace at all**. Only appropriate when: the type is used at very high frequency, genuinely performance-sensitive, and the message alone is sufficient to diagnose the failure without the call path.

### 4. Correcting the misconception

- **Genuinely exceptional, infrequent conditions**: negligible performance impact in virtually any real system.
- **Exceptions used as routine control flow, at high frequency**: this is where the "exceptions are slow" folklore has real substance — correctly attributed to a specific, avoidable misuse.

### 5. When performance considerations actually matter — a practical checklist

- Frequency — genuinely rare, or a significant fraction of normal calls?
- Call stack depth at the throw site.
- Actual measured impact — has profiling identified this as a hot spot, or is this premature optimization?

---

### Common misconception
> "Exceptions are always extremely slow, so they should be avoided even for genuine error conditions."

**Correct mental model:** The cost is concentrated in stack-trace capture, scaling with depth and frequency. For genuinely exceptional, infrequent conditions, it's negligible. It only matters at high construction frequency — usually itself a design problem independent of performance.

### Common developer mistake
Reaching for the no-stack-trace constructor preemptively on a rarely-thrown exception, sacrificing debuggability for a benefit never actually needed.

### Senior-level perspective
A senior developer knows precisely where the cost lives, identifies the specific scenario where it matters, and reaches for a fix only when profiling data — not folklore — has identified a genuine bottleneck.

---

# Part 21 — Error vs. Exception: Senior-Level Understanding

### 1. The sharper distinction

- **`Exception`** — the application's own logic and state remain trustworthy; the JVM is healthy; the problem is a specific, localized failure.
- **`Error`** — that trust breaks down, either because the JVM itself is compromised (`OutOfMemoryError`, `StackOverflowError`), or because something fundamental about the application's ability to start correctly has failed (`ExceptionInInitializerError`).

The real distinction: **whether the rest of your running program can still be trusted after this happens.**

### 2. Why blindly catching `Error` is dangerous

```java
try {
    processLargeDataset(data);
} catch (Throwable t) {
    log.error("Failed", t);
    continue;
}
```

- The condition that caused it likely hasn't gone away (heap exhaustion is systemic, not localized).
- Application state may already be corrupted (a lock never released, a half-written structure).
- The `catch` block itself needs resources to run — which may not be available.

### 3. When catching an `Error` might be justified

- **Top-level application boundaries** failing gracefully and reporting — failing that one unit of work cleanly, not continuing normal operation.
- **`StackOverflowError` specifically**, in narrow, isolated cases — sometimes genuinely localized to one bad recursive call.
- **Monitoring/observability infrastructure**, whose entire job is detecting and reporting catastrophe.

### 4. Why `Throwable` should rarely be caught

`catch (Exception e)` as a top-level boundary is sometimes justified; `catch (Throwable t)` requires a specifically stronger justification — usually one of section 3's narrow cases.

### 5. Recoverability, revisited — application-level vs. JVM-level

- `Exception` is recoverable **by application code** — the failure is scoped to what that code understands.
- `Error` is recoverable, at best, **by the JVM or operating environment** (restarting a process, an orchestration layer restarting a container) — not by the specific line of code that encountered it.

**It's not that recovery is philosophically impossible — it's that the code doing the catching is almost never the right layer to attempt it.**

---

### Common misconception
> "You should never catch Error, full stop."

**Correct mental model:** The default is strongly against it, but genuine, narrow exceptions exist — always with the goal of failing cleanly/reporting, never silently continuing.

### Common developer mistake
Broadening `catch (Exception e)` to `catch (Throwable t)` "to be extra safe" without recognizing this adds dangerous JVM-catastrophe-handling behavior.

### Senior-level perspective
Broadest is not safest here — catching `Error` alongside `Exception` treats "the JVM might be in serious trouble" identically to "this operation failed for an ordinary reason," which is backwards.

---

# Part 22 — Common Misconceptions

**Statement → Verdict → Correct mental model → Example**, consolidated from Parts 1–21:

1. **"Checked exceptions happen at compile time."** False — all exceptions occur at runtime; the compiler only enforces a handling/declaration obligation for checked ones (Part 3: Checked vs. Unchecked Exceptions, In Depth).

2. **"`throws` throws the exception."** False — `throws` is a zero-runtime-behavior declaration; only `throw` actually does anything (Parts 4–5).

3. **"RuntimeException means the JVM failed."** False — `RuntimeException` is just the unchecked branch of `Exception`; JVM trouble is signaled by `Error` (Part 2: The Java Throwable Hierarchy, Part 21: Error vs. Exception: Senior-Level Understanding).

4. **"`finally` always executes."** Mostly true — except `System.exit()`, a killed process, an infinite `try` block, or a fatal `Error` during `finally` itself (Part 9: `finally`, In Depth).

5. **"You should always catch exceptions."** False — catch only where you can do something meaningfully different (Part 15: Exception Handling Principles, Principle 1).

6. **"You should never catch Error."** Mostly true, with narrow, deliberate exceptions — top-level boundaries, isolated `StackOverflowError` handling, monitoring infrastructure (Part 21: Error vs. Exception: Senior-Level Understanding).

7. **"Exceptions are always slow."** False as a blanket claim — cost is concentrated in stack-trace capture, scaling with depth and frequency (Part 20: Exception Performance).

8. **"Logging an exception means handling it."** False — logging makes it visible; handling means actually resolving it (Part 15: Exception Handling Principles, Part 16: Exception Handling vs. Exception Throwing).

9. **"Catching an exception means the problem is fixed."** False — catching is mechanical type-matching; only the catch block's actual response can "fix" anything (Part 8: `try` and `catch`, In Depth, Part 16: Exception Handling vs. Exception Throwing).

10. **"Every failure needs a custom exception."** False — only failures needing genuinely distinct handling justify a new type (Part 13: Custom Exceptions).

11. **"Every exception should be caught where it occurs."** False — often best left to propagate to a layer with more context/authority (Part 6: Exception Propagation, In Depth, Part 15: Exception Handling Principles).

12. **"A RuntimeException should never be caught."** False — unchecked means not compiler-enforced, not "shouldn't be caught" (Part 3: Checked vs. Unchecked Exceptions, In Depth, Part 15: Exception Handling Principles).

13. **"A checked exception is always better than an unchecked exception."** False — each has a genuine design sweet spot; real, unresolved community disagreement exists (Part 3: Checked vs. Unchecked Exceptions, In Depth).

14. **"The exception message is enough; the cause isn't important."** False — the cause chain preserves the actual root failure a message alone can't (Part 12: Exception Cause and Chaining).

15. **"Rethrowing and wrapping are the same thing."** False — rethrowing propagates the identical object; wrapping creates a new one referencing the original as cause (Part 4: The `throw` Statement, In Depth, Part 12: Exception Cause and Chaining, Part 16: Exception Handling vs. Exception Throwing).

### Senior-level perspective
Almost none of these are *completely* false in every case — they're oversimplifications that collapse a genuine nuance into a blanket rule. The senior-level habit is asking, for any absolute-sounding statement about exceptions, "is this actually always true, or true in the common case with specific, understandable exceptions?"

---

# Part 23 — Realistic Java Exception Scenarios

## Scenario 1 — Checked exception, caller doesn't handle it
**Situation:** `userRepository.findById()` throws checked `SQLException`; `updateUserEmail()` calls it without declaring or catching.
**Correct behavior:** Catch and **wrap** in a domain-meaningful exception, preserving the cause:
```java
public void updateUserEmail(String userId, String newEmail) {
    User user;
    try {
        user = userRepository.findById(userId);
    } catch (SQLException e) {
        throw new UserServiceException("Could not load user " + userId, e);
    }
    user.setEmail(newEmail);
    userRepository.save(user);
}
```
**Senior-level decision:** Wrapping (Part 12: Exception Cause and Chaining) avoids leaking a persistence-layer detail into the service layer's contract; declaring `throws SQLException` upward is the lazy alternative.
**Trade-off:** An unchecked `UserServiceException` (Spring-style) is usually preferable to a new checked type if callers never need to differentiate SQL failures specifically.

## Scenario 2 — A `finally` block throws another exception
**Situation:** `process()` throws, then `cleanup()` in `finally` also throws — silently replaces the first (Part 9: `finally`, In Depth).
**Correct behavior:** Prefer try-with-resources if `cleanup()` is resource-closing (automatic suppression, Part 10–11); otherwise manually track and attach via `addSuppressed()`.
**Senior-level decision:** This is exactly why try-with-resources exists — hand-rolled preservation is fragile.
**Trade-off:** If `cleanup()` truly can't fail, plain `finally` is fine — but that assumption should be verified.

## Scenario 3 — Both main operation and cleanup throw
**Situation:** Try-with-resources body and `close()` both throw.
**Correct behavior:** No fix needed — try-with-resources already makes the body's exception primary and the close exception suppressed (Part 11: Suppressed Exceptions). Responsibility is to check `getSuppressed()` when debugging.
**Senior-level decision:** A suppressed exception can sometimes be more diagnostically useful than the primary one.

## Scenario 4 — Catching `Exception` and continuing
**Situation:** Three unrelated steps wrapped in one `catch (Exception e)` that logs and continues.
**Correct behavior:** Catch specific types per step, each handled distinctly (Part 15: Exception Handling Principles, Principle 8).
**Senior-level decision:** Broad catching hides which step failed and risks catching genuine bugs alongside expected failures.
**Trade-off:** Justified only as a deliberate, documented top-level batch-processing boundary — not a reflex.

## Scenario 5 — Logging and rethrowing at every layer
**Situation:** Every layer in a call chain logs the same exception and rethrows it.
**Correct behavior:** Log exactly once — at the top-level boundary or the layer actually deciding what happens next (Part 15: Exception Handling Principles, Principle 6). Intermediate layers just propagate, no logging.
**Trade-off:** Multiple log points are justified only if each adds genuinely distinct diagnostic context, not the same exception restated.

## Scenario 6 — Lower-level exception wrapped, cause lost
**Situation:** `throw new UserServiceException("Could not save user");` inside a `catch (SQLException e)`.
**Correct behavior:** Pass the cause: `throw new UserServiceException("Could not save user", e);`
**Senior-level decision:** Omitting the cause is close to an automatic code-review flag (Part 12: Exception Cause and Chaining, Part 15: Exception Handling Principles, Principle 3); also requires the exception class to actually support a `(String, Throwable)` constructor (Part 13: Custom Exceptions).

## Scenario 7 — Custom exception hierarchy has too many classes
**Situation:** Four near-identical `UserNameTooLongException`/etc. classes, all handled the same way by every caller.
**Correct behavior:** Collapse into one parameterized `ValidationException(field, reason)` (Part 14: Exception Naming and Design, section 5).
**Senior-level decision:** The test is behavioral distinctness — does any caller need to react differently? If not, one class beats many.
**Trade-off:** Genuinely distinct handling (different HTTP status, different recovery flow) justifies separate types.

## Scenario 8 — A constructor throws an exception
**Situation:** `Account` constructor registers `this` in a static list *before* validating balance, which can throw.
**Correct behavior:** Reorder — validate first, publish/register `this` only after success (Part 18: Exceptions in Constructors, section 4).
**Senior-level decision:** No object reaches the caller on failure, but side effects performed before the failure point are never automatically undone — a real, exploitable bug pattern.

## Scenario 9 — Overridden method declares an incompatible checked exception
**Situation:** `Child.process()` overrides `Parent.process() throws IOException` with `throws SQLException` — compile error.
**Correct behavior:** Don't widen `Parent`'s declaration to accommodate `Child`. Either wrap the SQL failure as an IOException-compatible type, or reconsider whether `Child` should extend `Parent` at all.
**Senior-level decision:** This is the Liskov Substitution Principle applied to exceptions (Part 17: Exception Behavior in Method Overriding) — protects every caller who wrote `catch (IOException e)` against `Parent`'s contract.

## Scenario 10 — Exceptions used for expected outcomes
**Situation:** A routine cache miss is modeled as a thrown `KeyNotFoundException`, caught on nearly every call.
**Correct behavior:** Model "not found" as a normal return value (`Optional`), not an exception (Part 15: Exception Handling Principles, Principle 5).
**Senior-level decision:** The litmus test — if a "failure" happens on a large fraction of calls under normal operation, it's a routine alternative outcome, not an exception. Also a Part 20 (Exception Performance) performance issue, but the design problem is primary.

---

# Part 24 — Complete Concept Check

| Area | Covered in |
|---|---|
| What exceptions are, why they exist | Part 1 (What Is a Java Exception, and Why Does Java Need Exceptions?) |
| `Throwable` hierarchy | Part 2 (The Java Throwable Hierarchy) |
| `Error` vs `Exception` (structural + senior-level) | Part 2 (The Java Throwable Hierarchy), Part 21 (Error vs. Exception: Senior-Level Understanding) |
| Checked exceptions | Part 3 (Checked vs. Unchecked Exceptions, In Depth) |
| Unchecked exceptions | Part 3 (Checked vs. Unchecked Exceptions, In Depth) |
| `throw` | Part 4 (The `throw` Statement, In Depth) |
| `throws` | Part 5 (The `throws` Declaration, In Depth) |
| Exception propagation | Part 6 (Exception Propagation, In Depth) |
| Stack unwinding | Part 7 (Stack Unwinding) |
| `try` / `catch` | Part 8 (`try` and `catch`, In Depth) |
| Multiple catch blocks, multi-catch, catch ordering | Part 8 (`try` and `catch`, In Depth) |
| `finally` | Part 9 (`finally`, In Depth) |
| `return` + `finally` | Part 9 (`finally`, In Depth) |
| `throw` + `finally` | Part 9 (`finally`, In Depth) |
| Try-with-resources | Part 10 (Try-With-Resources) |
| `AutoCloseable` / `Closeable` | Part 10 (Try-With-Resources) |
| Suppressed exceptions | Part 11 (Suppressed Exceptions) |
| Exception causes / chaining | Part 12 (Exception Cause and Chaining) |
| Rethrowing | Part 4 (The `throw` Statement, In Depth), Part 12 (Exception Cause and Chaining), Part 16 (Exception Handling vs. Exception Throwing) |
| Wrapping | Part 12 (Exception Cause and Chaining), Part 16 (Exception Handling vs. Exception Throwing) |
| Custom exceptions | Part 13 (Custom Exceptions) |
| Exception naming / hierarchy design | Part 14 (Exception Naming and Design) |
| Exception messages / context | Part 14 (Exception Naming and Design) |
| Exception handling principles (9 principles) | Part 15 (Exception Handling Principles) |
| Handling vs. throwing (8-stage vocabulary) | Part 16 (Exception Handling vs. Exception Throwing) |
| Exceptions in method overriding | Part 17 (Exception Behavior in Method Overriding) |
| Exceptions in constructors | Part 18 (Exceptions in Constructors) |
| Initialization-related exceptions | Part 19 (Exceptions During Initialization) |
| Exception performance | Part 20 (Exception Performance) |
| `Error` handling decisions | Part 21 (Error vs. Exception: Senior-Level Understanding) |
| Common misconceptions | Part 22 (Common Misconceptions) |
| Practical scenarios | Part 23 (Realistic Java Exception Scenarios) |

### The single thread running through the whole course

**Every exception-handling decision — checked vs. unchecked, catch vs. propagate, rethrow vs. wrap, catch `Exception` vs. a specific type, log vs. stay silent — is really the same question asked at a different layer: "who is actually positioned to do something meaningful about this failure, and what does everyone else along the way owe to that eventual point of resolution?"** Design (Parts 13–14) is about naming failures so that question has a clear answer. The principles (Part 15: Exception Handling Principles) are about not answering it lazily. The vocabulary (Part 16: Exception Handling vs. Exception Throwing) is about being precise regarding who's actually doing what. Everything else — propagation, unwinding, suppression, chaining — is the mechanism that ensures the answer doesn't get lost in transit.

---

# Appendix — Most Common Java Exceptions and Their Reasons

A quick-reference table of the exceptions encountered most often in real Java code, why each occurs, and where in this course its design reasoning is covered in depth.

## Unchecked (`RuntimeException` and subtypes)

| Exception | Typical cause | Course reference |
|---|---|---|
| `NullPointerException` | Dereferencing a `null` reference — calling a method or accessing a field on an object that wasn't initialized, wasn't found, or was never assigned. | Part 2 (The Java Throwable Hierarchy), §5 |
| `IllegalArgumentException` | A caller passed an argument that violates the method's precondition (e.g., a negative value where only positive is valid). Signals a caller-side bug, not an environmental failure. | Part 2 (The Java Throwable Hierarchy), §5; Part 13 (Custom Exceptions), §2 |
| `IllegalStateException` | A method was called at a point where the object's *current state* doesn't permit it (e.g., calling `next()` on an exhausted `Iterator`, or using a resource after it's been closed). | Part 2 (The Java Throwable Hierarchy), §5 |
| `IndexOutOfBoundsException` (and `ArrayIndexOutOfBoundsException`, `StringIndexOutOfBoundsException`) | An index used to access an array, `List`, or `String` fell outside the valid range `[0, length)`. Almost always an off-by-one or unvalidated-input bug. | Part 2 (The Java Throwable Hierarchy), §5 |
| `ClassCastException` | An object was cast to a type it isn't actually an instance of at runtime (e.g., casting an `Integer` stored in an `Object` variable to a `String`). | Part 2 (The Java Throwable Hierarchy) (hierarchy reasoning) |
| `NumberFormatException` | A string passed to `Integer.parseInt()`, `Double.parseDouble()`, etc. isn't a valid representation of that numeric type. Technically a subtype of `IllegalArgumentException`. | Part 2 (The Java Throwable Hierarchy), §5 |
| `ArithmeticException` | An illegal arithmetic operation — most commonly integer division by zero (`int` division; floating-point division by zero instead produces `Infinity`/`NaN`, no exception). | Part 1 (What Is a Java Exception, and Why Does Java Need Exceptions?), §3 |
| `ConcurrentModificationException` | A collection was structurally modified (add/remove) while being iterated, other than through the iterator's own `remove()` method — detected via a fail-fast modification count, not full thread-safety enforcement. | (design-adjacent to the "programming mistake" category from Part 2: The Java Throwable Hierarchy) |
| `UnsupportedOperationException` | An operation was attempted that the specific implementation doesn't support (e.g., calling `.add()` on a `List` created via `List.of(...)` or `Collections.unmodifiableList(...)`). | Part 2 (The Java Throwable Hierarchy), §5 (unchecked = caller-side usage error) |
| `NoSuchElementException` | Calling `next()` on an `Iterator`/`Scanner` that has no more elements, or `.get()` on an empty `Optional`. | Part 1 (What Is a Java Exception, and Why Does Java Need Exceptions?), §5 (expected-outcome vs. broken-contract distinction) |

## Checked (`Exception`, non-`RuntimeException`)

| Exception | Typical cause | Course reference |
|---|---|---|
| `IOException` (and subtypes like `FileNotFoundException`, `EOFException`) | A failure during an I/O operation — a file that can't be opened/read/written, a stream that closes unexpectedly. Represents an external-world failure outside the JVM's control. | Part 2 (The Java Throwable Hierarchy), §5 |
| `SQLException` | A failure interacting with a database — connection issues, constraint violations, malformed queries. External system, checked deliberately. | Part 2 (The Java Throwable Hierarchy), §5; Part 3 (Checked vs. Unchecked Exceptions, In Depth), §10 (Spring's unchecked-wrapping reaction) |
| `ClassNotFoundException` | Code attempted to load a class by name (`Class.forName(...)`) and the class wasn't found on the classpath — an environment/configuration issue. | Part 2 (The Java Throwable Hierarchy), §5 |
| `InterruptedException` | A thread was interrupted while blocked (e.g., in `Thread.sleep()`, `Object.wait()`). Checked specifically so a cancellation signal can never be silently ignored. | Part 2 (The Java Throwable Hierarchy), §5 |
| `ParseException` | Text couldn't be parsed into a structured form (e.g., `SimpleDateFormat.parse()` on a malformed date string). | Part 2 (The Java Throwable Hierarchy) (external/malformed-input category) |
| `CloneNotSupportedException` | `Object.clone()` was called on a class that doesn't implement `Cloneable`. | Part 2 (The Java Throwable Hierarchy) (checked = compiler-enforced acknowledgment) |

## `Error` (not meant to be caught in ordinary code)

| Error | Typical cause | Course reference |
|---|---|---|
| `OutOfMemoryError` | The JVM heap (or another memory region) is exhausted and a new allocation can't be satisfied. Systemic, not localized — Part 21 (Error vs. Exception: Senior-Level Understanding) covers why catching this is dangerous. | Part 21 (Error vs. Exception: Senior-Level Understanding), §2 |
| `StackOverflowError` | A call stack exceeded its limit — almost always unbounded or excessive recursion. One of the few `Error`s sometimes caught in narrow, isolated cases. | Part 21 (Error vs. Exception: Senior-Level Understanding), §3 |
| `ExceptionInInitializerError` | A static initializer threw during class initialization; wraps the original exception as its cause. | Part 19 (Exceptions During Initialization), §4 |
| `NoClassDefFoundError` | A class that previously failed static initialization (or is missing at runtime despite being present at compile time) is referenced again. | Part 19 (Exceptions During Initialization), §5 |
| `AssertionError` | An `assert` statement's condition evaluated to `false` (only active when assertions are enabled via `-ea`). Signals a violated internal invariant the code assumed could never happen. | Part 21 (Error vs. Exception: Senior-Level Understanding) (design-adjacent — a "this should be impossible" signal) |

### How to use this table with the rest of the course

The table tells you *what* commonly throws and *when* — the "why does it belong in this category" reasoning (checked vs. unchecked vs. `Error`, and what that implies for handling) is in Part 2 (The Java Throwable Hierarchy) and Part 3 (Checked vs. Unchecked Exceptions, In Depth) for the structural placement, Part 15 (Exception Handling Principles) for how to actually respond to each category, and Part 21 (Error vs. Exception: Senior-Level Understanding) specifically for why the `Error` row is handled so differently from the other two.
