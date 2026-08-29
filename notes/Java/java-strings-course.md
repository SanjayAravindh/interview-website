# Java Strings — Senior-to-Senior Mastery Course
### Java 21 LTS Baseline

---

## Table of Contents

1. [Part 1 — String Fundamentals](#part-1-string-fundamentals)
2. [Part 2 — String Immutability (Deep Dive)](#part-2-string-immutability-deep-dive)
3. [Part 3 — String Internal Representation (Compact Strings)](#part-3-string-internal-representation-compact-strings)
4. [Part 4 — The String Pool](#part-4-the-string-pool)
5. [Part 5 — String Equality](#part-5-string-equality)
6. [Part 6 — String Concatenation](#part-6-string-concatenation)
7. [Part 7 — StringBuilder](#part-7-stringbuilder)
8. [Part 8 — StringBuffer](#part-8-stringbuffer)
9. [Part 9 — String Operations (Core Method Catalogue)](#part-9-string-operations-core-method-catalogue)
10. [Part 10 — trim() vs strip()](#part-10-trim-vs-strip)
11. [Part 11 — Unicode and the Character Model (Major Section)](#part-11-unicode-and-the-character-model-major-section)
12. [Part 12 — Code Points and Unicode Processing (API Deep Dive)](#part-12-code-points-and-unicode-processing-api-deep-dive)
13. [Part 13 — String Encoding and Charset](#part-13-string-encoding-and-charset)
14. [Part 14 — Charset and I/O](#part-14-charset-and-io)
15. [Part 15 — String Splitting and Joining](#part-15-string-splitting-and-joining)
16. [Part 16 — StringJoiner](#part-16-stringjoiner)
17. [Part 17 — String Formatting](#part-17-string-formatting)
18. [Part 18 — String Templates / Modern Java Context](#part-18-string-templates-modern-java-context)
19. [Part 19 — Regular Expressions](#part-19-regular-expressions)
20. [Part 20 — String Replacement](#part-20-string-replacement)
21. [Part 21 — String Searching Algorithms](#part-21-string-searching-algorithms)
22. [Part 22 — String Comparison and Ordering](#part-22-string-comparison-and-ordering)
23. [Part 23 — Locale and Internationalization](#part-23-locale-and-internationalization)
24. [Part 24 — String Hashing](#part-24-string-hashing)
25. [Part 25 — Strings as HashMap Keys (Production Perspective)](#part-25-strings-as-hashmap-keys-production-perspective)
26. [Part 26 — String Normalization](#part-26-string-normalization)
27. [Part 27 — Strings and Security](#part-27-strings-and-security)
28. [Part 28 — Strings and Injection](#part-28-strings-and-injection)
29. [Part 29 — Strings in JSON and REST APIs](#part-29-strings-in-json-and-rest-apis)
30. [Part 30 — Strings and Logging](#part-30-strings-and-logging)
31. [Part 31 — String Performance (Consolidated Analysis)](#part-31-string-performance-consolidated-analysis)
32. [Part 32 — Large String Processing](#part-32-large-string-processing)
33. [Part 33 — String vs StringBuilder vs StringBuffer vs CharSequence](#part-33-string-vs-stringbuilder-vs-stringbuffer-vs-charsequence)
34. [Part 34 — Strings + Collections](#part-34-strings-collections)
35. [Part 35 — Strings + Streams](#part-35-strings-streams)
36. [Part 36 — Modern Java String APIs (Consolidated Reference)](#part-36-modern-java-string-apis-consolidated-reference)
37. [Part 37 — Common Senior-Level Mistakes (Consolidated Catalogue)](#part-37-common-senior-level-mistakes-consolidated-catalogue)
38. [Part 38 — Production Case Studies](#part-38-production-case-studies)
39. [Part 39 — Simplified Internal Implementations](#part-39-simplified-internal-implementations)
40. [Part 40 — Production Debugging](#part-40-production-debugging)

---





## Part 1 — String Fundamentals

`java.lang.String` is a `final` class implementing `CharSequence`, `Comparable<String>`, and `Serializable`. In Java 21, internally it holds:

```java
private final byte[] value;   // NOT char[] since Java 9
private final byte coder;     // LATIN1 (0) or UTF16 (1)
private int hash;             // cached hashCode, lazily computed
private boolean hashIsZero;   // Java 15+, disambiguates "hash not computed" from "hash == 0"
```

**Why `String` is `final`:**
1. **Security/trust boundaries** — prevents subclass substitution attacks against equality/hash-based security checks.
2. **Immutability enforcement** — final blocks a subclass from adding mutable state that would violate the immutability contract.
3. **JVM/JIT optimization** — the JVM can devirtualize and aggressively inline calls since no subclass can exist.

**Why `String` is immutable — the engineering case:**
- String pool correctness (shared instances would be corruptible if mutable)
- Hash code caching soundness (Part 24)
- Thread safety without synchronization
- Security-sensitive contexts (TOCTOU resistance for paths, URLs, etc.)
- Safe sharing without defensive copies

**Literal vs `new String(...)`:**

```java
String name = "Sanjay";              // compile-time constant, interned in pool, no runtime allocation
String name = new String("Sanjay");  // literal is still pooled as a side effect; PLUS a new heap object
```

`"Sanjay" == new String("Sanjay")` → `false`. `new String(...)` is almost always a code smell in modern Java — a redundant heap allocation with no behavioral benefit.

**References vs objects:** reassigning a reference never affects other references to the same object — this is fundamentally reference semantics, made invisible-by-default for Strings because immutability means the underlying object can never itself change.

**Why Strings are objects, not primitives:** variable-length data + coder flag + cached hash don't fit a fixed-size primitive slot; being object-based lets Strings be null, be map keys, be garbage collected, and participate in the object graph generally — at the cost of allocation overhead, which Compact Strings and pooling exist specifically to mitigate.

**`CharSequence`:** the minimal read-oriented abstraction (`length()`, `charAt()`, `subSequence()`, `toString()`) implemented by `String`, `StringBuilder`, `StringBuffer`, `CharBuffer`. APIs that only need to *read* characters should often accept `CharSequence`, not `String` (fully developed in Part 33).

---

## Part 2 — String Immutability (Deep Dive)

**What immutability guarantees, precisely:** once constructed, no operation through any reference, on any thread, at any time, can change a String's character sequence. Enforced by: `final` fields (`value`, `coder`) AND encapsulation — the backing array is never exposed (`toCharArray()`/`getBytes()` return copies).

**The classic misconception, fully dissected:**

```java
String value = "hello";
value.concat(" world");
System.out.println(value);   // "hello" — concat() returns a NEW String; nothing captured it
```

Every "modifying" method (`concat`, `substring`, `replace`, `toUpperCase`, `trim`, `strip`, ...) is a factory method: `String -> String`, no side effects on the receiver.

**Object mutation vs reference reassignment — precise vocabulary:**
- *Mutating an object* = changing state visible through ANY reference to it.
- *Reassigning a reference* = pointing a variable to a DIFFERENT object; other references unaffected.

String structurally permits only the second.

**Defensive design payoff:** immutable fields need zero defensive copying in constructors or getters — a major, underappreciated dividend across the entire JDK.

**Thread safety without synchronization:** any thread can call any method on a shared String reference concurrently, forever, with zero data-race risk — because there's no mutation channel to race on. (Contrast `StringBuilder`, not thread-safe, and `StringBuffer`, thread-safe via real synchronization cost — Part 8.)

**Hashing/caching preview (full mechanics Part 24):** `hash`/`hashIsZero` caching is only correctness-preserving because content can never change post-construction — this is the single clearest illustration of immutability enabling a real, load-bearing optimization.

**Where immutability matters in practice:** file paths and URLs (TOCTOU resistance), HashMap keys (Part 24), concurrent systems generally.

**What immutability does NOT give you:** it says nothing about the *reference variable's* own thread-safety (still needs `volatile`/synchronization if reassigned across threads), and it does not make secret data safe to hold — an immutable String can't be explicitly zeroed, and may persist in memory (and in heap dumps) longer than a mutable, explicitly-cleared alternative (full treatment Part 27).

---

## Part 3 — String Internal Representation (Compact Strings)

**Pre-Java 9:** `private final char[] value;` — always 2 bytes/char, regardless of content.

**Java 9+ (JEP 254 — Compact Strings):** `byte[] value` + `byte coder`. If every character fits in Latin-1 (code points 0–255), stored as 1 byte/char with `coder = LATIN1`. If ANY character needs more, the ENTIRE string falls back to UTF-16 (2 bytes/char, `coder = UTF16`) — an all-or-nothing decision per instance, not per character.

**Why Latin-1 specifically:** strict superset of ASCII, additionally covers common Western-European accented characters in one byte — widens the "cheap" set well beyond pure ASCII.

**Zero public API change:** every method (`charAt`, `length`, `substring`, ...) behaves identically regardless of coder — the JDK dispatches internally to `StringLatin1`/`StringUTF16` helpers.

**`length()` semantics unchanged:** still "number of UTF-16 code units," computed from stored metadata — not affected by Compact Strings.

**Coder propagation in derived Strings:** concatenation/derivation results are UTF-16-coded if ANY contributing character requires it — a single "foreign" character anywhere in a long concatenation chain doubles the memory cost of the ENTIRE result.

**Memory savings:** roughly half the backing-array payload for Latin-1-heavy content; a wash (not a regression) for genuinely non-Latin-1 content. At JVM scale this is a measured, significant aggregate memory and GC-pressure reduction (JEP 254's motivation).

**Disabling:** `-XX:-CompactStrings` reverts to always-UTF-16; essentially never justified without specific profiling evidence.

**Evolution, stated precisely:**
```
Java ≤ 8:  char[] value                — always 2 bytes/char
Java 9+:   byte[] value + byte coder   — 1 or 2 bytes/char, decided per-instance
Java 21:   same model as Java 9 — no further representational change to String
```

---

## Part 4 — The String Pool

**What it is:** a JVM-managed cache guaranteeing at most one canonical `String` instance per distinct content — exploiting immutability's safety-of-sharing for memory savings.

**Where it lives:** PermGen pre-Java-7 (a real OOM hazard); moved to the regular heap since Java 7 (7u40), subject to normal GC. PermGen-tuning flags (`-XX:MaxPermSize`) are obsolete/ignored on Java 8+.

**How Strings enter the pool:**
- Literals — interned automatically at class-load time (JLS §3.10.5).
- Compile-time constant expressions — the compiler constant-folds `"hel" + "lo"` into `"hello"` directly; no runtime concatenation exists in the bytecode at all.
- A `final` variable initialized with a compile-time constant is itself treated as a compile-time constant (constant-folding trap — easy interview gotcha).

```java
String hel = "hel";
String a = hel + "lo";   // runtime concat — hel is a variable — a != "hello" by ==
final String hel2 = "hel";
String b = hel2 + "lo";  // final + compile-time-constant init → folded → b == "hello"
```

**`new String(...)` and the pool:**
```java
String a = new String("hello");
String b = new String("hello");
a == b;                    // false — two independent heap objects
String c = a.intern();     // c is the POOLED instance; a is untouched
c == "hello";               // true
```

**`intern()` mechanics and when it's (in)appropriate:** O(1) hash lookup on a hit, real insertion cost on a miss, and the pool entry lives essentially for the JVM's lifetime (no automatic eviction). Appropriate for genuine, large-scale, measured duplication (categorical data). Inappropriate as a reflexive "performance" habit — interning unique-ish strings adds cost with zero dedup payoff and can prevent GC of data your app no longer needs, historically a real cause of PermGen-era `OutOfMemoryError`.

**`==` vs `.equals()` — why "just use equals" undersells the danger:** runtime-constructed Strings (JDBC, deserialization, `substring`, network decoding) are not guaranteed pool-identical — `==`-based comparisons can pass in testing (literal-constructed test data) and silently fail in production (runtime-constructed data), with zero code change needed to flip the outcome.

**Classloader nuance:** the interned string table is effectively JVM-global, NOT segregated per-classloader — a documented exception to typical classloader-isolation assumptions.

---

## Part 5 — String Equality

```
==                    reference identity
equals()              content equality, case-sensitive
equalsIgnoreCase()    content equality, case-insensitive, locale-independent
contentEquals()       content equality against any CharSequence
Objects.equals()      null-safe wrapper around equals()
compareTo()           lexicographic ordering (Part 22)
```

**`==`:** reference identity only, never content — the only legitimate Strings use case is genuine identity-testing, essentially never in ordinary business logic.

**`equals()` mechanics:** `this == anObject` fast path first (free for pool-identical operands); `instanceof String` type check (never throws on `null` or wrong type — `"x".equals(null)` → `false`); coder-aware but logically-correct comparison across differing Compact-Strings representations.

**`equalsIgnoreCase()`:** NOT `a.toLowerCase().equals(b.toLowerCase())` — that allocates two throwaway Strings AND hits the default-locale Turkish-I landmine (Part 23). The real implementation is locale-independent, per-character, zero-allocation.

**`contentEquals()`:** the fix for `"hello".equals(new StringBuilder("hello"))` returning `false` (the `instanceof String` check fails) — compares actual character content against any `CharSequence`, no forced `toString()`.

**`Objects.equals(a, b)`:** null-safe on both sides, no need for the "literal-first" defensive-ordering trick — the generally most robust default when nullability isn't locally guaranteed.

**Decision table:**
```
Identity check (rare)                              → ==
Two known-non-null Strings                          → a.equals(b)
Either might be null                                → Objects.equals(a, b)
Case-insensitive                                     → a.equalsIgnoreCase(b)
Against a StringBuilder/other CharSequence           → a.contentEquals(b)
Need ordering                                        → a.compareTo(b)
Locale-sensitive human-language equality             → Collator
```

The `status == "SUCCESS"` bug: compiles fine, environment/construction-path-dependent, passes in dev, silently fails in production — the fix is never "intern everywhere," it's `.equals()`/`Objects.equals()`, always.

---

## Part 6 — String Concatenation

**Compile-time constants:** `"Hello " + "World"` → fully folded at compile time; zero runtime cost.

**Java 8 and earlier:** `+` desugars to explicit `StringBuilder` bytecode.

**Java 9+ (JEP 280):** `+` compiles to `invokedynamic` deferring to `StringConcatFactory` at link time — the actual strategy is a JVM implementation detail, can evolve without recompiling your code. Manual `StringBuilder` for a single expression is now more anti-pattern than optimization.

**`a.concat(b)`:** direct, minimal method call; `concat("")` returns `this` (zero-allocation fast path); throws `NullPointerException` on a `null` argument (unlike `+`, which treats `null` as literal `"null"`). Chaining multiple `concat()` calls is worse than `+`/`StringBuilder` — each call allocates a fresh intermediate String.

**The loop-concatenation trap — the single most important lesson in this part:**

```java
String result = "";
for (String item : items) {
    result = result + item;   // re-copies the ENTIRE accumulated result every iteration
}
```

O(n²) total character copies for O(n) final output — because each iteration recopies everything accumulated so far, not just the new piece. The Java 9 `invokedynamic` improvement operates per call-site, not across loop iterations — it does NOT solve this.

**Fix:**
```java
StringBuilder sb = new StringBuilder();
for (String item : items) sb.append(item);
String result = sb.toString();
```
O(n) amortized total work. Switching `+=` to `.concat()` inside the loop does NOT fix anything — same algorithmic trap, different syntax.

**Decision table:**
```
Compile-time constants only                     → +
Single expression, runtime values                → + (Java 9+ handles it well)
Exactly two non-null Strings, hot path            → a.concat(b)
Building incrementally / loop / unknown count     → StringBuilder, declared outside the loop
```

Precision point for interviews: "does `+` use StringBuilder?" — Java 8 and earlier: yes, explicitly. Java 9+: compiles to `invokedynamic`; may or may not use a StringBuilder-like strategy internally — that's now a JVM implementation detail.

---

## Part 7 — StringBuilder

**Internal representation:** `byte[] value` + `byte coder` (same Compact Strings model as String) + `int count` (logical length, distinct from `value.length`, the allocated capacity).

**Growth:** geometric, roughly `(oldCapacity << 1) + 2`, not linear — linear growth would reintroduce O(n²) total resize cost; geometric growth gives O(log n) resizes and amortized O(1) append.

**Pre-sizing:** `new StringBuilder(expectedSize)` genuinely eliminates resize-and-copy cost (not just amortizes it) when the estimate is accurate — a legitimate, common senior habit for predictable-size hot paths.

**`append()`:** heavily overloaded per primitive type specifically to avoid pre-stringification allocation (`sb.append(42)` avoids the intermediate String `sb.append(String.valueOf(42))` would create). O(k) per call, amortized O(1) overhead.

**`insert()`/`delete()`/`replace()`:** O(n) — NOT O(1) — because non-tail operations require shifting the contiguous backing array. Repeated front-insertion in a loop reintroduces an O(n²) pattern structurally identical to the loop-concatenation trap.

**`reverse()`:** O(n), and specifically surrogate-pair-aware — will not split a supplementary character across the swap (full mechanics Part 11).

**`toString()`:** the one unavoidable copy — allocates a right-sized new String from exactly `count` characters. Calling it multiple times produces independent objects each time; capture the result once if reused.

**`ensureCapacity()`/`trimToSize()`:** manual growth-trigger and manual shrink-to-fit — situational, profiling-informed tools.

**Complexity table:**
| Operation | Complexity |
|---|---|
| append() | O(k), amortized O(1) overhead |
| charAt() | O(1) |
| insert()/delete()/replace() (non-tail) | O(n) |
| reverse() | O(n) |
| toString() | O(count) |

**Default choice:** `StringBuilder` for essentially all single-threaded incremental text building — the overwhelming majority of real-world accumulation code.

---

## Part 8 — StringBuffer

Predates `StringBuilder` (Java 1.0 vs Java 5). Shares `AbstractStringBuilder` internals; differs only by wrapping public methods in `synchronized`.

**What thread-safety here guarantees:** method-level atomicity only — no corruption from two threads racing on a single mutating call.

**What it does NOT guarantee:** compound, multi-call sequences are not atomic — the classic check-then-act race (`if (sb.length()==0) sb.append(...)`) still races across two threads even though each individual call is synchronized. True compound atomicity requires your own `synchronized(sb) { ... }` block, at which point StringBuffer's internal locking is redundant.

**Real cost:** every synchronized method call pays lock-acquire/release overhead even with zero contention — biased locking (removed Java 15, JEP 374) and lightweight/thin locking mitigate but never eliminate this. For a purely local, single-thread-used builder, this is pure, unrecoverable waste.

**Why "thread-safe" ≠ "safer default":** synchronization is a targeted tool for a specific hazard (concurrent mutable state shared across threads) — applying it defensively when nothing is ever shared protects against a hazard that doesn't exist. The correct pattern for concurrent text accumulation is usually per-thread-local builders combined afterward, not one shared, contended `StringBuffer`.

**Where you'll still see it:** pre-Java-5 code, some legacy JDK API signatures (e.g., older `Matcher.appendReplacement` overloads, though Java 9+ added `StringBuilder` overloads), outdated-tutorial-derived habits.

**Guidance:** essentially no reason to reach for `StringBuffer` in new Java 21 code.

---

## Part 9 — String Operations (Core Method Catalogue)

```
length()          O(1), cached field
isEmpty()          O(1)
isBlank()          O(n) — Java 11+, Unicode-whitespace-aware, NOT free like isEmpty()
charAt()           O(1) — raw UTF-16 code unit, may be half a surrogate pair
codePointAt()      O(1) amortized — correctly reassembles surrogate pairs
substring()        O(k) — ALWAYS copies since Java 7u6 (was O(1)/shared-array pre-7u6 —
                    causing a documented memory-retention hazard: tiny substring keeping
                    a huge original array alive)
concat()           O(n+m) — empty-arg fast path returns `this`
contains()/indexOf() O(n·m) worst case; startsWith/endsWith are O(m), cheap and preferred
                    over indexOf(x)==0
compareTo()        O(min(n,m)), no allocation, short-circuits on first difference
matches()          Recompiles a Pattern EVERY call — genuine trap in a loop
repeat()           O(n·count) — single correctly-sized allocation (Java 11+)
```

Historical correction worth having exact: `substring()`'s O(1)-shared-array behavior was REMOVED in Java 7u6 specifically because it caused real production memory leaks (tiny substring retaining an entire huge backing array). Current (and Java 21) behavior always copies.

`matches()` recompiles its `Pattern` on every call with no caching — a classic hot-loop trap; compile once, reuse (full treatment Part 19).

---

## Part 10 — trim() vs strip()

`trim()` (Java 1.0): strips any leading/trailing char `<= 0x20` — a blunt numeric threshold, NOT genuine Unicode whitespace. Misses non-breaking space (`\u00A0`), en/em space, ideographic space (`\u3000`), etc.

`strip()`/`stripLeading()`/`stripTrailing()` (Java 11+): use `Character.isWhitespace()`, the JDK's comprehensive, Unicode-standard-aligned whitespace definition.

```java
"\u00A0Sanjay\u00A0".trim().equals("Sanjay");    // false — trim() misses non-breaking space
"\u00A0Sanjay\u00A0".strip().equals("Sanjay");   // true
```

Real bug source: copy-pasted web content (`&nbsp;`) contains non-breaking spaces invisibly; `input.trim().isEmpty()` incorrectly treats such a field as non-blank.

Performance difference is negligible — never choose `trim()` over `strip()` "for speed."

**Guidance:** default to `strip()` in all new Java 11+ code. Only reason to use `trim()`: matching legacy behavior an existing system/test depends on.

---

## Part 11 — Unicode and the Character Model (Major Section)

**Three distinct concepts, routinely conflated:**
```
Code point       — an integer Unicode "character" (0x0–0x10FFFF)
Code unit        — Java's `char` is a UTF-16 code unit (16 bits); some code points need TWO
Grapheme cluster — what a human perceives as one visible character; can span MULTIPLE code points
```

**Java's `char` is a UTF-16 code unit — not a character, not necessarily even one code point.** This is the root of nearly every Unicode bug in Java.

**BMP and surrogate pairs:** the Basic Multilingual Plane (0x0000–0xFFFF) covers most common scripts, each fitting one `char`. Supplementary-plane code points (most emoji, some rare CJK, math symbols) need a **surrogate pair** — two 16-bit code units (high surrogate 0xD800–0xDBFF, low surrogate 0xDC00–0xDFFF).

```java
String emoji = "😀";           // U+1F600 — one code point
emoji.length();                 // 2 — two UTF-16 code units (a surrogate pair)
emoji.charAt(0);                 // lone high surrogate — NOT independently valid
emoji.codePointAt(0);            // 128512 — correctly reassembled
emoji.codePoints().count();      // 1L
```

`charAt()` on a lone surrogate returns invalid, non-standalone UTF-16 if used in isolation — Java does not prevent you from splitting a pair this way.

**Correct iteration:**
```java
value.codePoints().forEach(cp -> { ... });
// or manually:
int i = 0;
while (i < value.length()) {
    int cp = value.codePointAt(i);
    i += Character.charCount(cp);   // 1 or 2, correctly
}
```
Naive `for (char c : value.toCharArray())` silently splits surrogate pairs — harmless for BMP-only text, a real correctness bug for anything with emoji/supplementary characters, and this class of bug typically escapes ASCII-only test suites entirely.

**Performance trade-off:** code-point-aware iteration pays a real, if usually small, per-step overhead versus naive `char` iteration. Use naive iteration only with a provable ASCII/BMP-only guarantee; default to code-point-aware processing for genuine free-text/international input.

**Grapheme clusters — beyond code points:** flag emoji (regional indicator pairs), skin-tone/ZWJ-joined emoji sequences can be multiple code points for one visually-perceived glyph. Core `java.lang` has NO grapheme concept — use `java.text.BreakIterator.getCharacterInstance()` when you genuinely need "how many visible characters did the user type" correctness (e.g., character-limit validation).

**Production implications:** `substring(0,n)` can split a surrogate pair (malformed UTF-16); `length()`-based character limits overcharge emoji by 2; naive reversal corrupts pairs (StringBuilder.reverse() handles this correctly, Part 7.5); regex/searching can behave surprisingly around surrogate pairs and combining characters.

---

## Part 12 — Code Points and Unicode Processing (API Deep Dive)

```
codePointAt(i)        — code point STARTING at char index i
codePointBefore(i)     — code point ENDING at char index i (for backward iteration — direction matters!)
codePointCount(b,e)     — O(k), actual code-point count in a char-index range (not e-b)
offsetByCodePoints(i,n) — char index after advancing n code points, correctly skipping pairs
```

**`chars()` vs `codePoints()`:** both return `IntStream` (never `Stream<Character>`) specifically to avoid boxing every character. `chars()` = code units; `codePoints()` = actual Unicode code points.

**Going back — `Character.toChars(int)` and `StringBuilder.appendCodePoint(int)`:** the latter is the efficient, correct way to build a String from code points, with no intermediate `char[]` allocation per code point.

**Style comparison:**
```
A) toCharArray() + for-each  — full copy upfront, INCORRECT for supplementary chars
B) codePoints() stream        — no upfront copy, correct, good default
C) manual codePointAt+charCount loop — no stream overhead, correct, fastest, most verbose
```
Guidance: B is the right default; drop to C only in profiled, genuinely hot paths. A is presumptively wrong unless BMP-only is a provable guarantee.

---

## Part 13 — String Encoding and Charset

**Core principle: text is not bytes.** Any boundary crossing (file, network, DB, IPC) requires an explicit encoding — never assumption-free.

**`getBytes()` — the dangerous overload:**
```java
byte[] b = s.getBytes();                        // DANGEROUS — platform default charset
byte[] b = s.getBytes(StandardCharsets.UTF_8);   // CORRECT — deterministic
```
Pre-Java-18, `Charset.defaultCharset()` varied by OS/locale — a classic "works on my machine" trap. **Java 18 (JEP 400)** standardized the default to UTF-8 across platforms — but explicit charset arguments remain mandatory practice regardless of version, since the default can still be overridden via `file.encoding`.

**Symmetric risk on decode:** `new String(bytes)` without an explicit charset — mismatched encode/decode charsets produce mojibake; this is inherent to encoding, not a JVM bug.

**Lossy encoding — silent data loss:** encoding into a charset (e.g., `US_ASCII`) that can't represent some characters silently substitutes `?` by default — no exception. Detecting this requires the lower-level `CharsetEncoder` with `CodingErrorAction.REPORT`.

**UTF-8 vs UTF-16 vs platform default:** UTF-8 is the correct default for essentially all external interchange. UTF-16 is Java's *internal* representation, rarely correct for external serialization. Never rely on the implicit platform default, even where it happens to already be UTF-8.

**Rule, stated absolutely:** never call `getBytes()` or `new String(bytes)` without an explicit `Charset`, regardless of Java version.

---

## Part 14 — Charset and I/O

**Byte-oriented vs char-oriented APIs:** `Reader`/`Writer` are `InputStream`/`OutputStream` plus an explicit (or implicit, dangerously) charset — there is no charset-free `Reader`.

`FileReader`/`FileWriter` had NO charset-aware constructor before **Java 11** — hardwired to platform default. Java 11 added `Charset`-accepting constructors; always use them.

**`Files` (NIO.2) — modern, preferred:**
```java
Files.readString(path, StandardCharsets.UTF_8);
Files.writeString(path, content, StandardCharsets.UTF_8);
Files.readAllLines(path, StandardCharsets.UTF_8);
```
Default to UTF-8 by documented contract (Java 11+) — safe, but explicit charset args remain good self-documenting practice.

**`BufferedReader`/streaming:** `Files.newBufferedReader(path, charset)` — the right tool for line-by-line large-file processing (full treatment Part 32).

**HTTP:** `BodyHandlers.ofString()` determines charset from `Content-Type`, falling back to UTF-8 — correctness depends on the SERVER setting that header correctly. **JSON specifically mandates UTF-8** (RFC 8259) — safe to assume regardless of `Content-Type` presence/correctness.

**Where charset bugs actually happen in production:** file I/O with implicit platform-default readers, database columns/connections with mismatched declared charsets, cross-service messaging where producer/consumer disagree on charset — and ALL of these commonly escape ASCII-only test data, since ASCII bytes are identical across most single-byte charsets and UTF-8.

---

## Part 15 — String Splitting and Joining

**`split()` is ALWAYS regex, even when it looks literal:**
```java
"a.b.c".split(".");      // WRONG — "." is regex "any char" — degenerate result
"a.b.c".split("\\.");     // correct
"a.b.c".split(Pattern.quote(delimiter));  // safe for a dynamic/unknown delimiter
```

**Overhead:** pays regex compilation cost every call in principle — though the JDK has an internal (undocumented, non-guaranteed) fast path for simple single-char non-special delimiters. For repeated splitting on the same pattern, compile once explicitly: `Pattern.compile(",").split(line)` in a loop.

**`limit` parameter, precisely:**
```
limit > 0   — at most `limit` elements, pattern applied at most limit-1 times
limit == 0  — (default) trailing empty strings REMOVED
limit < 0   — pattern applied maximally, trailing empties KEPT
```
Default behavior silently drops trailing empty fields — a real bug source for structured/tabular parsing; use `limit = -1` when trailing empties are semantically meaningful. Leading/internal empties are always preserved regardless.

**`splitWithDelimiters()` — Java 21-native addition:** returns delimiters interleaved with content, letting you know exactly which delimiter matched at each split point — impossible with plain `split()`, which discards delimiter text.

**`String.join()`:** no regex at all — direct, efficient, O(total length), uses `StringJoiner` internally. Always prefer over hand-rolled loop-with-manual-boundary-logic.

**When regex splitting is wrong entirely:** genuinely structured/quoted formats (real CSV with quoted commas) need a proper parser/library, not naive `split()` regardless of flavor.

---

## Part 16 — StringJoiner

```java
StringJoiner(CharSequence delimiter)
StringJoiner(CharSequence delimiter, CharSequence prefix, CharSequence suffix)
```
Delimiter goes only between elements; prefix/suffix apply once, at the ends, structurally — even with ZERO elements added (`new StringJoiner(",", "[", "]").toString()` → `"[]"`, not `""`).

`setEmptyValue(CharSequence)` overrides the zero-element output specifically.

`merge(StringJoiner other)` — appends `other`'s already-delimited (not prefix/suffix-wrapped) content as a single element into the receiver.

**Comparison:**
```
Concatenation in a loop     — O(n²), never appropriate at scale
StringBuilder, hand-rolled  — O(n) but YOU manage delimiter-boundary logic manually (easy off-by-one)
StringJoiner                — O(n), boundary handled correctly for you, imperative style
Collectors.joining()         — Stream equivalent, literally implemented via StringJoiner internally
```
Prefer `StringJoiner`/`Collectors.joining()` over hand-rolled boundary logic essentially always.

---

## Part 17 — String Formatting

`String.format()` / `.formatted()` (Java 15+, receiver-first, same underlying `Formatter`) — each call allocates a new `Formatter`, RE-PARSES the format string every time (no caching), and autoboxes primitive varargs — meaningfully slower than direct concatenation/`StringBuilder`, real but usually negligible for occasional/user-facing output, real and worth avoiding in genuine hot loops.

**Locale, dangerous default:**
```java
String.format("%,.2f", n);               // uses default Locale — environment-dependent
String.format(Locale.ROOT, "%,.2f", n);  // deterministic
```
For machine-consumed output, always pass an explicit `Locale` (typically `Locale.ROOT`); for human-facing display, the user's actual locale is correct and desired.

**`%d` is strictly typed** — a `double` argument throws `IllegalFormatConversionException` at RUNTIME, not compile time, since format strings aren't statically checked against arguments.

**`%n` vs `\n`:** `%n` is the platform line separator (`\r\n` on Windows); `\n` is always literal LF. Use `%n` for platform-native text output, a fixed `\n`/protocol-mandated ending for network protocols, JSON, or anything requiring byte-for-byte reproducibility (e.g., generated files that get diffed/hashed across platforms).

For hot numeric formatting, a reused (per-thread, NOT thread-safe) `DecimalFormat` instance avoids `String.format()`'s per-call reparsing cost.

---

## Part 18 — String Templates / Modern Java Context

**String Templates were a PREVIEW feature in Java 21 (JEP 430)**, not standard — requires `--enable-preview`, no stability guarantee, generally inappropriate for production code. A second preview followed in Java 22 (JEP 459) with design revisions; the feature was ultimately withdrawn rather than finalized in that timeframe based on preview feedback. (Verify current disposition against the JDK release notes/JEP index directly if precision is load-bearing — feature-lifecycle history like this is worth confirming against a primary source.)

**For Java 21, standard, non-preview usage:** there is NO built-in string interpolation. Available tools are `String.format()`/`.formatted()`, plain concatenation, and `StringBuilder`.

**Text blocks (`"""..."""`) ARE standard and stable** since Java 15 (JEP 378) — fully usable in Java 21, no flags. They solve multi-line-literal ergonomics, NOT interpolation — still combine with `.formatted()` for value substitution.

```
Text blocks (""")            — STANDARD since Java 15. Fully usable in Java 21.
String Templates (STR."...") — PREVIEW in Java 21/22. NOT standard. Do not use/represent as
                                standard Java 21 syntax.
```

The general discipline: always verify whether a language feature is standard-and-stable in your actual target version before relying on it, and represent its status precisely.

---

## Part 19 — Regular Expressions

`Pattern.compile()` is expensive (parses/builds matching machinery); `Matcher` is stateful, bound to one input, NOT thread-safe or reusable across inputs — but a compiled `Pattern` IS thread-safe/immutable and safely shared/reused.

**Three distinct match semantics:**
```
matches()    — does the ENTIRE input match?
find()        — does SOME substring match, anywhere? Stateful/repeatable — the standard
                "iterate all matches" idiom via while(m.find())
lookingAt()   — does input match starting AT position 0 (not necessarily the whole input)?
```

**Groups:** group 0 is always the whole match; explicit groups number from 1 by opening-paren order. Named groups `(?<name>...)` improve readability/maintainability once a pattern has more than 1-2 groups. Non-capturing groups `(?:...)` group without consuming a number.

**Match-dependent replacement:** `Matcher.appendReplacement(sb, ...)` / `appendTail(sb)` — the `StringBuilder` overload was added in Java 9 specifically to avoid `StringBuffer`'s unneeded synchronization in this common pattern; prefer it.

**Compilation cost:** always compile once, store as `static final Pattern`, reuse — never recompile in a loop.

**Backtracking and ReDoS:** Java's regex engine is a backtracking engine; nested/overlapping quantifiers (`(a+)+`) can cause catastrophic, exponential-time matching on failure — a genuine, documented, named security vulnerability class (ReDoS) when applied to untrusted input. Mitigations: avoid nested-quantifier-on-overlapping-class shapes for untrusted-input patterns; bound input length before matching; consider timeout/circuit-breaker execution or a linear-time-guaranteed engine (RE2/RE2J-style) for security-sensitive validation; prefer well-tested existing patterns over hand-rolled ones for common validation needs.

---

## Part 20 — String Replacement

```
replace(CharSequence, CharSequence)  — LITERAL, never regex, CharSequence-typed params
replace(char, char)                   — cheapest, single-pass character substitution
replaceFirst(String regex, ...)        — REGEX-based, same "recompiles every call" trap as matches()
replaceAll(String regex, ...)          — REGEX-based
```

`replaceAll(".", "-")` replaces EVERY character — same metacharacter trap as `split()`. **Rule: if replacing a literal fixed string, always use `replace()`**, never the regex-named methods — sidesteps escaping entirely and avoids compilation cost.

Regex replacement earns its cost for genuine pattern needs — collapsing whitespace runs, case-insensitive replacement, and specifically for **backreferences** (`$1`, `$2` in the replacement string) restructuring matched content — no literal equivalent exists for this.

For repeated replacement with the same pattern, compile once and reuse via `Pattern.matcher(input).replaceAll(...)`.

Several replacement methods have a no-match fast path returning `this` directly (no allocation) — a JDK implementation detail, not a universally guaranteed contract across every method/version.

---

## Part 21 — String Searching Algorithms

**Naive search:** O(n·m) worst case, but typically close to O(n) in practice since mismatches usually happen early. **The JDK's `indexOf()` is close to this naive approach by design** — NOT Boyer-Moore or KMP — because sophisticated algorithms' preprocessing overhead rarely pays off for the JDK's common case (short needle, single search).

**Boyer-Moore (conceptual):** right-to-left comparison, bad-character/good-suffix rules let it skip ahead by more than one position — best case sublinear, strong average case for longer needles/repeated searches. Not exposed directly in the JDK; reach for a specialized library at genuine scale rather than hand-implementing.

**KMP (conceptual):** precomputes a failure function from the needle; guarantees O(n+m) worst case with no pathological case — the right tool when you need a PROVABLE bound, e.g., against adversarial/untrusted input (an algorithmic-complexity-attack analog to ReDoS).

**Two-way (Crochemore-Perrin):** linear time AND constant space — worth knowing the name/headline property exists; genuinely peripheral to typical Java work.

**Practical guidance:** `indexOf()`/`contains()`/`Pattern` are adequate for the overwhelming majority of real code. Reach for something more specialized only with profiled, measured, genuine bottlenecks at real scale, and generally via an existing library rather than hand-rolled algorithm implementation.

---

## Part 22 — String Comparison and Ordering

`compareTo()` compares raw UTF-16 code-unit VALUES — aligns with familiar alphabetical order only for plain single-case ASCII; diverges immediately for mixed case (`"Zebra" < "apple"` numerically, since uppercase code points are lower) and has no relationship to linguistic closeness for accented characters (`"café"` vs `"cafe"` compares by raw code-point distance, not linguistic similarity).

`compareToIgnoreCase()` fixes case-ordering specifically (locale-independent, like `equalsIgnoreCase()`) but remains code-point-value-based for everything else.

**When raw/case-insensitive `compareTo()` IS correct:** machine identifiers, UUIDs, hashes, `TreeMap`/`TreeSet` internal ordering needing only *some* consistent order, protocol-level case-sensitive comparisons — locale-aware collation would be actively WRONG here.

**`Collator`:** the correct tool for linguistically-correct, locale-aware comparison/sorting of human-facing text. Strength levels (`PRIMARY` ignores case AND accent; `SECONDARY` ignores case, respects accent; `TERTIARY` default, respects both) — `PRIMARY` strength is genuinely useful for accent-insensitive SEARCH matching, something no `compareTo()`-based approach can express at all.

`Collator.getInstance(Locale)` is expensive to construct — construct once, reuse, same discipline as `Pattern`/`DecimalFormat`. NOT guaranteed thread-safe.

**The recurring principle, first fully stated here:** classify every String as machine-facing (deterministic, `Locale`-independent ops) or human-facing (locale-aware ops) — this single classification determines the correct API across comparison, casing, and formatting alike, and recurs explicitly through Parts 23 and beyond.

---

## Part 23 — Locale and Internationalization

`toLowerCase()`/`toUpperCase()` (no-arg) use `Locale.getDefault()` — environment-dependent, same risk class as charset/format defaults.

**The Turkish-I problem, precisely:** Turkish has TWO I/i pairs — dotted (`İ`/`i`, U+0130/U+0069) and dotless (`I`/`ı`, U+0049/U+0131) — distinct phonemes. Under a Turkish locale, `"I".toLowerCase()` produces `'ı'` (dotless), NOT ordinary ASCII `'i'`.

```java
"INACTIVE".toLowerCase();                 // "ınactıve" under a Turkish-locale JVM — DANGEROUS
"INACTIVE".toLowerCase(Locale.ROOT);       // "inactive" — always
"INACTIVE".equalsIgnoreCase("inactive");   // correct, locale-independent by design
```

This is a real, documented, recurring production bug pattern — passes all testing outside Turkish-locale environments, breaks silently and specifically wherever the JVM's default locale happens to be Turkish, with zero connection to the actual (often purely machine-facing) meaning of the string.

**`Locale.ROOT`:** a designated, locale-independent baseline — the correct choice for machine identifiers, status codes, protocol strings.

**The general principle, stated as a rule:** classify every String as human-facing (use the actual user/request `Locale` for case/format/sort operations — this is CORRECT and desired) or machine-facing (always `Locale.ROOT` or the inherently locale-independent method, e.g. `equalsIgnoreCase`, `String.CASE_INSENSITIVE_ORDER`).

Other locale-sensitive operations sharing this discipline: `String.format()` (Part 17), `Collator` (Part 22), date/time formatting (outside this course's direct scope but identical principle).

---

## Part 24 — String Hashing

**The exact, documented, guaranteed formula (JLS-specified, stable across JVMs/versions forever):**
```
s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]
```
```java
int h = 0;
for (int i = 0; i < length(); i++) h = 31 * h + charAt(i);
```
Being a documented, guaranteed algorithm (not merely implementation detail) means you can persist a hash and expect the identical value on any JVM/version, forever — a meaningfully stronger guarantee than the general `Object.hashCode()` contract.

**Why 31:** odd and prime (better distribution, fewer systematic collisions), and `31*i == (i<<5)-i` — a classic, deliberate, historically meaningful compiler optimization.

**Caching mechanism:** `hash`/`hashIsZero` fields — computed at most ONCE per object, ever, because immutability guarantees the content (and thus the correct hash) never changes. `hashIsZero` (Java 15+) specifically disambiguates "not yet computed" from "computed, and genuinely 0" (the empty string and a few specific non-empty inputs legitimately hash to 0), closing a gap that would otherwise defeat caching for those cases.

**Performance:** repeated hashing of the SAME object is essentially free after the first call — a real, substantial reason `Map<String,V>` performs so well despite potentially-long keys. Caching is per-OBJECT, not per-content — two distinct-but-equal String instances each independently compute and cache their own hash (a secondary benefit of pooling: shared instances also share cached hash work).

**HashMap bucket placement:** `HashMap` applies its OWN additional spreading function (XOR-shift on top of `hashCode()`) before masking to bucket count — defends against correlated low-order bits in certain input patterns.

**Collisions:** mathematically unavoidable (pigeonhole principle); `HashMap` handles them via chaining (Java 8+: switches to a balanced tree per-bucket once a chain grows long, defending against worst-case degradation). Collisions don't break correctness — only, in the worst case, degrade lookup from O(1) toward O(log n)/O(n); `equals()`'s correctness is what guarantees you get back the RIGHT value regardless.

**Why Strings are excellent HashMap keys — synthesis:** immutability enables safe caching; the documented algorithm gives stable, predictable, well-distributed hashing; correct `equals()` resolves collisions correctly; no mutation channel means bucket placement can never silently invalidate — this specific combination is the profile of an ideal hash-key type.

---

## Part 25 — Strings as HashMap Keys (Production Perspective)

**The central question: what does "same key" mean for your domain?** `Map<String,User> usersByEmail` with raw `String` keys treats `"Sanjay@Example.com"` and `"sanjay@example.com"` as DIFFERENT keys — very likely wrong for email, causing real "duplicate account from casing" bugs.

**Normalization — the fix:**
```java
String normalizedKey = email.trim().toLowerCase(Locale.ROOT);   // Locale.ROOT — machine-facing identifier
```
Should live at ONE well-defined boundary (a constructor, a factory, a dedicated value type — see below), not scattered ad hoc across call sites, which is fragile and easy to forget at some path.

**Case-insensitive collections:** `new TreeMap<>(String.CASE_INSENSITIVE_ORDER)` gives case-insensitive keys + sorted iteration at O(log n). There is NO standard case-insensitive `HashMap` in the JDK — for O(1)-average case-insensitive lookup, normalize keys yourself before insertion/lookup.

**Memory at scale:** genuinely high-duplication categorical key content (country codes, currency codes) parsed into many separate, non-pooled instances is a legitimate `intern()` use case (Part 4.4's canonical scenario, made concrete). Interning doesn't change lookup correctness (`HashMap` always uses `equals()`, never `==`) — it's purely a memory optimization, never a shortcut enabling `==`-based lookups.

**Stronger alternative — dedicated value types:**
```java
public record EmailAddress(String value) {
    public EmailAddress {
        value = Objects.requireNonNull(value).trim().toLowerCase(Locale.ROOT);
    }
}
```
Makes non-normalized instances structurally impossible to construct — converts a discipline problem (easy to violate accidentally at some call site) into a type-safety problem (structurally prevented). A good default instinct whenever a raw String is standing in for a domain concept with real invariants.

---

## Part 26 — String Normalization

**Combining characters — a different phenomenon than case/locale:** Unicode allows an accented character in TWO forms:
```
Precomposed:  é  →  ONE code point U+00E9
Decomposed:   é  →  TWO code points: e (U+0065) + combining acute (U+0301)
```
Both render identically to a human; `equals()` treats them as different (`length()` differs too: 1 vs 2). This is a deliberate, documented Unicode feature, not a bug.

**Real-world sources:** macOS historically tends toward decomposed (NFD) for filenames/certain input; Windows/most web input tends toward precomposed (NFC) — the SAME accented name, from different sources, can arrive `equals()`-unequal.

**Normalization Forms (`java.text.Normalizer`, Unicode Annex #15):**
```
NFC  — canonical composition (prefer precomposed) — the standard general-purpose default
NFD  — canonical decomposition
NFKC/NFKD — compatibility forms, ALSO fold typographic/formatting variants — lossier,
            appropriate for aggressive search normalization, not exact-fidelity preservation
```
```java
Normalizer.normalize(precomposed, Normalizer.Form.NFC).equals(
    Normalizer.normalize(decomposed, Normalizer.Form.NFC));   // true
```

**Application — authentication/usernames:** without consistent normalization at BOTH registration and login, a user can be locked out of their own account by an invisible composition-form mismatch (different device/input method producing a different form for the visually-identical name). The flip side is more serious: without normalization, an attacker could register a username visually IDENTICAL to an existing one, using a different composition form — a spoofing/impersonation-adjacent vulnerability (related to, but distinct from, Unicode homograph attacks).

**Application — search:** indexes and queries built/typed in differing composition forms silently fail to match unless both are normalized to the same form before indexing/matching.

**Fix, architecturally:** the same "normalize at one well-defined boundary" discipline from Part 25.3, now applied to composition form — `Normalizer.normalize(input, Form.NFC)` consistently at storage AND every lookup/comparison.

---

## Part 27 — Strings and Security

**The one place immutability works against security:** you cannot explicitly zero out or overwrite a String's contents — unlike a `char[]`:
```java
char[] password = readPassword();
try { authenticate(password); }
finally { Arrays.fill(password, '\0'); }   // no equivalent exists for String
```
A secret held as a String persists in memory for an indeterminate time — until unreachable AND collected, and GC doesn't zero reclaimed memory as a security measure.

**Heap dumps — the concrete exposure vector:** a routine diagnostic heap dump captures the complete live object graph, including any plaintext secret currently resident as a String — a genuine, documented class of accidental credential leakage via dumps taken for unrelated debugging purposes.

**Pooling makes this worse:** a secret that accidentally becomes (or gets interned into) a pooled String can persist for the ENTIRE JVM lifetime — hardcoded secret literals are doubly dangerous: source-control exposure PLUS becoming a long-lived, essentially-permanent in-memory artifact the moment the class loads, regardless of whether that code path ever executes.

**`char[]`-with-zeroing — real but limited:** genuinely shrinks the exposure window; does NOT provide airtight guarantees — JIT/escape-analysis optimizations can create uncontrolled transient copies, any forced conversion to `String` (e.g., a library demanding a `String` argument) silently defeats the entire benefit, and OS-level swap/paging is a separate, broader concern outside pure application-code control. For genuinely high-security needs beyond "reasonably careful," further measures (HSMs, short-lived-credential schemes, OS secure-memory facilities) apply, beyond what String/array handling alone can solve.

**Logging — the far more common, everyday exposure vector (full treatment Part 30):** careless/temporary debug-logging of secrets is, in practice, the single most common real-world credential-leakage cause — more so than heap dumps, given log aggregation's broader access and longer retention.

**Checklist:** prefer `char[]` for passwords specifically; never hardcode secrets as literals; never `.intern()` sensitive data; watch for API boundaries forcing char[]→String conversion of secrets; never pass raw secrets to logging calls; understand heap dumps as a real exposure vector; recognize char[]-and-zero as a floor, not a ceiling.

---

## Part 28 — Strings and Injection

**The unifying root cause:** conflating trusted structure/syntax with untrusted data via naive string concatenation, when the result is interpreted as structured syntax by a downstream system — ONE structural mistake recurring across every injection category.

**SQL injection:**
```java
// NEVER
String query = "SELECT * FROM users WHERE username = '" + username + "'";
```
`username = "' OR '1'='1"` returns every row. **Fix — parameterized queries:**
```java
PreparedStatement stmt = connection.prepareStatement("SELECT * FROM users WHERE username = ?");
stmt.setString(1, username);
```
Structurally separates query STRUCTURE from parameter DATA at the level the database itself enforces — fundamentally different, and more robust, than manual escaping.

**Shell injection:** `Runtime.getRuntime().exec("ls " + dir)` lets a semicolon inject a second command. Fix: `ProcessBuilder`'s array-argument form, passing each argument as a distinct, never-shell-interpreted element; avoid invoking a shell at all when you don't need shell features.

**HTML/XSS injection:** raw concatenation into HTML output lets `<script>` tags execute in a victim's browser. Fix: HTML-escape untrusted data before embedding (`&lt;`, `&amp;`, etc.); prefer templating engines with default auto-escaping (Thymeleaf, JSX) over hand-rolled HTML string-building.

**URL injection:** unescaped `&`/`#`/`/` in untrusted data can alter URL structure. Fix: `URLEncoder.encode(value, UTF_8)` for query components — note `URLEncoder` implements `application/x-www-form-urlencoded` (space→`+`), NOT identical to general URI percent-encoding (RFC 3986) — use `java.net.URI`'s own component-wise encoding for non-form contexts.

**Do not conflate encoding schemes:** URL encoding, JSON escaping, HTML escaping, and charset encoding (Part 13) are each correct ONLY for their specific target syntax — using the wrong one for a given context is itself a vulnerability, not a cosmetic error.

**Closing principle:** prefer APIs that structurally separate data from structure over manual escaping wherever available; where unavailable, apply the SPECIFIC scheme for the exact target syntax, at the point of embedding.

---

## Part 29 — Strings in JSON and REST APIs

**JSON escaping:** its own specific rule set (`"`→`\"`, `\`→`\\`, control chars→`\n`/`\uXXXX`, etc., per RFC 8259) — never hand-write this; always use a real library (Jackson, Gson). Manual concatenation risks both malformed JSON and structural-corruption-adjacent issues.

**Deserialization:** correctly reassembles `\uXXXX\uXXXX` surrogate-pair escapes for supplementary characters (Part 11's mechanics apply directly).

**JSON's charset:** RFC 8259 mandates UTF-8 for interchange — safe to assume for JSON bytes specifically, unlike arbitrary HTTP bodies which need `Content-Type` inspection (Part 14.5).

**HTTP headers — a distinct, narrower concern:** header values cannot legitimately contain `\r`/`\n` (the wire-format line terminators); unvalidated injection of these can enable HTTP Response Splitting/header injection. Modern containers/libraries generally validate this automatically, but understanding WHY matters for any lower-level HTTP code.

**Path variables vs query parameters:** query params need URL/form encoding (Part 28); path segments have a distinct concern — an unencoded `/` or `../` in a path variable can alter routing/path structure. Prefer built-in URI-template mechanisms (HttpClient + URI, framework REST client builders) that correctly percent-encode each substituted segment, over manual path-string concatenation.

**Do not conflate contexts, made concrete:** the SAME raw value may need JSON escaping in a JSON body, `\r`/`\n` validation in a header, URL/form encoding in a query parameter, and HTML escaping in a rendered page — FOUR different schemes for four different embedding contexts, applied at the point of embedding, never speculatively upstream, never assuming one context's encoding protects another.

---

## Part 30 — Strings and Logging

**Concatenation in log calls:**
```java
log.debug("User " + userId + " did " + action);   // concatenation ALWAYS happens, even if DEBUG is disabled
```
**Parameterized logging — the fix:**
```java
log.debug("User {} did {}", userId, action);   // formatting SKIPPED entirely if DEBUG disabled
```
The framework checks level-enablement BEFORE substituting `{}` placeholders — near-zero cost when disabled, unlike concatenation which unconditionally builds the message first.

**Lazy argument evaluation — closing a remaining gap:** parameterized logging defers formatting but NOT argument evaluation — Java must evaluate every argument expression before the call executes. If an argument itself is expensive to compute, it still runs even when the level is disabled:
```java
log.debug("State: {}", () -> computeExpensiveSummary());   // SLF4J 2.x-style Supplier overload —
                                                              // computeExpensiveSummary() only runs
                                                              // if DEBUG is actually enabled
```
Use plain parameterized logging for cheap arguments; reach for Supplier-based lazy logging specifically when an argument requires genuine, non-trivial computation.

**Sensitive data leakage — the full treatment (building on Part 27.6):** logging is, in practice, the MOST COMMON real-world credential-exposure vector — more so than heap dumps — because debug-logging statements are frequently added casually and forgotten, and log files are typically far more broadly accessible, aggregated, and long-retained than a heap dump.

**Layered mitigations:** never log raw secrets, full stop, even temporarily; mask/redact when context is genuinely useful (last-4-digits pattern); structured logging with field-level sensitivity annotations where supported; mandatory code-review vigilance specifically for logging statements touching password/token/secret/PII-adjacent variables; automated secret-scanning tooling where feasible.

**Unifying theme (Parts 27–30):** Strings are the primary vehicle for sensitive/attacker-influenceable data moving through an application — the same disciplined, destination-aware question ("where is this String about to go, and have I handled it for that destination") governs correctness and safety across memory, injection surfaces, and logs alike.

---

## Part 31 — String Performance (Consolidated Analysis)

**Allocation sources, consolidated:** literals (none), `new String()` (always), single-expression concatenation (one result), LOOP concatenation (every iteration, O(n²)), `concat()` (unless empty arg), `substring()` (always, since 7u6), case-conversion/`trim`/`strip` (always), `split()` (array + N substrings), `String.format()` (Formatter + result), `StringBuilder.toString()` (once, unavoidable), `toCharArray()`/`getBytes()` (always, a copy), `intern()` (once, on miss).

Almost every derived-String operation allocates by necessity of immutability — the discipline isn't "avoid allocation," it's "avoid REDUNDANT, unnecessary allocation, especially in loops/hot paths."

**GC pressure:** modern generational GC (G1 default in Java 21) handles moderate, ordinary String churn efficiently — most String temporaries die young, exactly what young-gen collection is optimized for. It becomes a genuine problem when allocation volume is disproportionate to actual work (the loop-concatenation trap being the canonical example) — showing up as measurably elevated GC frequency/pause time, potentially affecting P99 latency at scale.

**Worked illustration:** an innocuous-looking `summary += "Order #" + id + ...` loop over 1000 orders performs on the order of hundreds of thousands of unnecessary character copies plus a comparable multiple of extra allocations — invisible in code review, because it reads correctly. The `StringBuilder`-based fix is not more complex, just the right tool.

**Discipline, not paranoia:** write clear, structurally-correct code first (using the right tool by default avoids the WORST anti-patterns without needing profiling at all); profile (JFR, async-profiler) before optimizing further when performance genuinely matters for a specific measured path; optimize the measured bottleneck specifically, not speculatively everywhere.

---

## Part 32 — Large String Processing

**Why "load the whole file as a String" breaks at scale:** a single contiguous backing-array requirement runs into real heap-fragmentation allocation failure well before any theoretical `Integer.MAX_VALUE`-length ceiling — `OutOfMemoryError` despite adequate AGGREGATE free memory, just not enough in one contiguous run; no incremental processing is possible until the whole file is read; derived operations (`substring`, regex) pay costs proportional to the enormous size.

**Streaming — line-by-line:**
```java
try (BufferedReader reader = Files.newBufferedReader(path, UTF_8)) {
    String line;
    while ((line = reader.readLine()) != null) processLine(line);
}
```
Peak memory bounded by buffer size + longest line, NOT total file size.

**`Files.lines()`:** the `Stream<String>` equivalent — MUST be used in try-with-resources; it holds an open file handle underneath, unlike most in-memory Stream sources, and failing to close it leaks the handle.

**Chunk-based raw buffer processing:** for non-line-oriented data, a single REUSED fixed-size buffer array (allocated once, outside the loop) minimizes allocation churn to essentially nothing beyond the fixed buffer — lower overhead than even line-by-line (which still allocates one String per line).

**GC/memory-pressure cost of one giant String:** even when it SUCCEEDS, a multi-GB single String is scanned on every major GC cycle for its entire (long) lifetime, and occupies a large contiguous region that can fragment the heap for other allocations — softer, harder-to-diagnose costs that arrive before an outright OOM.

**Backpressure (brief mention):** for genuinely UNBOUNDED/continuous data sources (not a finite file), a further concept beyond String-processing entirely — reactive-streams/async-I/O architecture (Java `Flow`, Project Reactor) — becomes the relevant next-level concern, outside this course's scope.

**Decision guidance:** small-to-moderate data needing whole-content structure → single String is fine, don't over-engineer; large/incremental-by-nature → `BufferedReader`/`Files.lines()` (line-oriented) or raw chunked `Reader` (non-line-oriented); unbounded/continuous → reactive/backpressure architecture.

---

## Part 33 — String vs StringBuilder vs StringBuffer vs CharSequence

```
              Mutable?  Thread-safe?      Pooled?   Typical use
String         No        Yes (inherent)    Yes (literals)  Fixed value, keys, identifiers
StringBuilder   Yes       No                No        Single-threaded incremental building
StringBuffer    Yes       Yes (synced)      No        Legacy; rare genuine shared-buffer need
CharSequence    N/A       N/A               N/A       ABSTRACTION — parameter/return type, not a
                                                          concrete storage choice
```

**The actual decision:** every property above is DOWNSTREAM of mutable-vs-immutable — String's thread-safety is a direct consequence of immutability; StringBuffer's synchronization is a retrofit ONTO mutability; pooling is only safe BECAUSE of immutability. The real question: fixed final value → `String`; incremental building, single-threaded → `StringBuilder`; genuinely shared, concurrently-mutated, AND method-level atomicity is sufficient (rare) → `StringBuffer` (consider restructuring to avoid shared mutable state first).

**`CharSequence` as API design tool:** accept `CharSequence` for parameters that only READ character data — avoids forcing a caller with a `StringBuilder` mid-construction to pay an unnecessary `.toString()` allocation. Keep `String` when you need String-specific guarantees (as a HashMap key — Part 24's cached hash contract) or String-only methods (`split`, `trim`, `toLowerCase`, none of which are on `CharSequence`) internally.

**The `CharSequence.equals()` trap:** `CharSequence` does NOT declare any `equals()`/`hashCode()` contract — `"hello".equals(new StringBuilder("hello"))` is `false`. NEVER use a raw `CharSequence` as a HashMap key/HashSet element expecting content-based equality — behavior would depend inconsistently on the concrete runtime type stored.

**Return types:** almost always `String` — callers generally want a concrete, immutable, hashable, comparable, unambiguous result; returning `CharSequence` from a public API is unusual and generally discouraged.

---

## Part 34 — Strings + Collections

**`List<String>`:** sorting inherits `compareTo()`'s caveats (Part 22) — use `Collator`/`CASE_INSENSITIVE_ORDER` for human-facing lists. Order-preserving deduplication: route through `LinkedHashSet`. Repeated `contains()` membership checks: convert to `HashSet<String>` for O(1) average, once the O(n) pattern is noticed in a hot path.

**`Set<String>`:** `HashSet<String>` relies entirely on Part 24's cached-hash/equals machinery; the design question that actually matters is Part 25.2's "what counts as the same element" — apply the same normalization discipline. `LinkedHashSet` for order-preserving dedup + O(1) lookup together.

**`Map<String,V>`/`Map<K,String>`:** Part 25's full treatment applies directly for keys; String values additionally inherit charset/locale/security considerations (Parts 13, 23, 27) wherever they cross a boundary.

**Sorting map iteration order:** `TreeMap` with `String.CASE_INSENSITIVE_ORDER` or a `Collator`, chosen per the machine-vs-human classification (Part 23.5).

**Grouping (`Collectors.groupingBy`):** inconsistent key casing across data sources silently produces separate groups for what should be one logical group — normalize the grouping key BEFORE collecting, same fix as Part 25.3.

**Memory at collection scale:** a large collection with high genuine value-duplication (few distinct values across many rows) is a strong, low-risk signal that explicit interning (Part 4.4, 25.5) is worth doing.

**Recurring questions for every collection choice:** what counts as "equal" here (raw vs normalized)? does order need to be human-meaningful or is raw `compareTo()` correct? is there enough duplication to justify interning? is O(1) lookup actually being exploited or is `List.contains()`'s O(n) silently in a hot path?

---

## Part 35 — Strings + Streams

`chars()`/`codePoints()` compose naturally into filter/map/collect pipelines (Part 12 revisited in pipeline context).

`String.lines()` (Java 11+) — the in-memory counterpart to `Files.lines()` (Part 32.3); correctly normalizes `\n`/`\r\n`/`\r` line terminators, unlike a naive `split("\n")`.

`transform(Function<String,R>)` (Java 12+) — purely ergonomic, enables fluent-chain continuity without breaking out for a standalone method call; zero performance difference from the equivalent broken-out code.

`.formatted()` composes more naturally than `String.format(...)` inside a stream `map()` lambda, for the same receiver-first reason noted in Part 17.1.

**Boxing — the real cost when bridging primitive and object streams:** `Stream<String>` itself involves no boxing (String is already a reference type); the concern arises specifically when bridging `IntStream`→`Stream<String>` via `mapToObj()`, which for a code-point-reconstruction task allocates a throwaway single-character String per element — `StringBuilder.appendCodePoint()` (Part 12.6) remains lower-allocation-overhead for that specific task, even though the stream pipeline reads more declaratively.

**When a normal loop is better (explicit, non-stream-promoting stance):** hot-path/high-frequency processing (stream overhead, lambda invocation, boxing at primitive/object boundaries is real, if usually small); branchy, early-termination-heavy logic often reads more clearly as a plain loop; when intermediate stream stages allocate MORE than a loop would need (35's `mapToObj` example); when the pipeline doesn't actually simplify anything over an equally-clear loop.

**When streams genuinely earn their place:** declarative filter/map/collect over a bounded, moderate-size collection (Part 34's `groupingBy`); composing with other already-Stream-based APIs (`Files.lines()`, a query-result stream) to avoid awkward manual bridging.

**Stance:** treat stream-vs-loop as a genuine trade-off decision (readability, allocation profile, hot-path sensitivity), not a reflexive default-to-streams habit.

---

## Part 36 — Modern Java String APIs (Consolidated Reference)

| Method | Since | Purpose |
|---|---|---|
| `isBlank()` | 11 | Unicode-aware "effectively empty" check |
| `strip()`/`stripLeading()`/`stripTrailing()` | 11 | Unicode-aware whitespace removal |
| `lines()` | 11 | Stream<String> by normalized line terminator |
| `repeat(int)` | 11 | Single-allocation repetition |
| `indent(int)` | 12 | Per-line indent add/remove, normalizes line terminators to `\n` |
| `transform(Function)` | 12 | Fluent-chain-friendly function application |
| `formatted(Object...)` | 15 | Receiver-first `String.format()` |
| `translateEscapes()` | 15 | Interpret `\n`/`\t`/`\uXXXX`-style escapes in RUNTIME string content |
| `chars()` | 8 | IntStream of UTF-16 code units |
| `codePoints()` | 8 | IntStream of actual Unicode code points |
| `splitWithDelimiters()` | 21 | Regex split retaining delimiters in the result |

`indent(int)`: adds/removes N spaces per line AND normalizes every line ending to `\n`, guaranteeing a trailing `\n` — genuinely useful for generated/pretty-printed nested text output, with the line-normalization as a real secondary correctness benefit (avoids mixed line-endings in generated files).

`translateEscapes()`: interprets Java escape sequences found IN a String's actual runtime content (not source-code literals, which the compiler already handles at compile time) — useful for config/template/network content arriving with literal `\n`-as-two-characters that should be interpreted as an actual newline. Does NOT do interpolation (that's the withdrawn/preview String Templates territory, Part 18) — only the fixed, well-defined Java escape-sequence set.

**The pattern across Java 11–21's String additions:** each closes a specific, previously-error-prone gap already identified in this course — `isBlank()`/`strip()` close the Unicode-whitespace gap `trim()` left; `repeat()` replaces an error-prone manual idiom; `splitWithDelimiters()` closes a genuine `split()` expressiveness gap. Checking whether Java 11+ already has a standard method before hand-writing something that "feels common" is a good, transferable habit.

---

## Part 37 — Common Senior-Level Mistakes (Consolidated Catalogue)

Each: **Why → What happens → Consequence → Better approach.**

1. **`==` for equality** — pooling-dependent, passes with literals, silently fails with runtime-constructed data → `.equals()`/`Objects.equals()` always.
2. **`length()` as visible-character count** — UTF-16 code units, not characters; supplementary chars count as 2 → `codePointCount()`/`BreakIterator`.
3. **Ignoring Unicode generally** — naive `char` iteration corrupts supplementary content, escapes ASCII-only test suites → `codePoints()`-based processing by default.
4. **Platform-default charset/locale** — environment-dependent, "works on my machine" → explicit `Charset`/`Locale.ROOT`, always.
5. **Regex where literal suffices** — metacharacter traps, unnecessary backtracking-engine overhead → `replace()`/`Pattern.quote()`.
6. **Repeated regex compilation** — `matches()`/`split()`/`replaceAll()` recompile every call → `static final Pattern`, reused.
7. **Excessive loop concatenation** — O(n²), the single most-cited Java String anti-pattern → `StringBuilder` outside the loop.
8. **Mishandling secrets** — Strings can't be zeroed, persist in heap dumps/pools → `char[]` + explicit zeroing; never hardcode/intern secrets.
9. **Logging sensitive Strings** — the most common real-world leakage vector → never log raw secrets; mask/redact; review vigilance.
10. **Ignoring Locale** — Turkish-I, wrong number separators, non-linguistic sort order → classify machine- vs human-facing, choose API accordingly.
11. **Reading huge files into memory** — contiguous-allocation failure risk, GC/fragmentation cost → streaming (`BufferedReader`/`Files.lines()`).
12. **Misusing `intern()`** — helps only genuine high-duplication data; otherwise adds cost and risks permanent retention → reserve for measured, verified duplication.
13. **Unnecessary StringBuilder/StringBuffer** — verbose for single expressions (Java 9+ handles it); needless sync cost without real sharing → trust `+` for one-shot; never `StringBuffer` without verified thread-sharing.
14. **Confusing bytes with characters** — implicit charset assumptions corrupt at every boundary, often escaping ASCII test data → explicit `Charset` everywhere, absolute rule.
15. **Confusing encoding with escaping** — wrong scheme for the target context provides zero real protection → identify the exact target syntax, apply exactly that scheme.
16. **`trim()` where Unicode whitespace handling is needed** — misses non-breaking space and friends → default to `strip()`/`isBlank()`.
17. **Unnecessary String conversions** — forced `.toString()` on CharSequence-capable values, redundant round-trips → accept `CharSequence` where read-only suffices.
18. **Ignoring allocation pressure generally** — compounds invisibly across hot paths into real GC/latency cost → write correct code by default, profile before further optimizing.

---

## Part 38 — Production Case Studies

1. **Millions of temporary Strings/sec** — profile (JFR) to find the specific redundant-allocation source (uncached `Pattern`/`Formatter`, unnecessary conversions) rather than reducing String usage generally.
2. **Loop concatenation** — super-linear scaling with size is the diagnostic signature of the O(n²) trap → `StringBuilder`, pre-sized if size is knowable.
3. **REST API, multilingual input, prod-only corruption** — QA-passes/prod-fails is the signature of BMP-only test data hiding a surrogate-pair bug → `codePointCount()`/`offsetByCodePoints()` for limits/truncation.
4. **Millions of comparisons, slowdown after adding case-insensitivity** — likely the `toLowerCase().equals()` allocation-plus-locale-risk anti-pattern → `equalsIgnoreCase()`.
5. **Expensive DEBUG logging** — check concatenation-vs-parameterized first, then check for eagerly-evaluated expensive arguments → parameterized logging + Supplier-based laziness where needed.
6. **5GB file, intermittent OOM despite "enough" memory** — heap-fragmentation-driven single-contiguous-allocation failure → streaming.
7. **Map<String,V> cache: high memory AND unexplained "duplicate" misses** — TWO separate root causes (normalization gap + genuine unpooled duplication), needing two separate fixes.
8. **Malformed UTF-8 ingestion** — consistent garbling → charset mismatch; sporadic exceptions → genuinely invalid bytes, needing explicit `CodingErrorAction` handling or rejection.
9. **Locale-dependent username failures, Turkish deployment specifically** — the Turkish-I problem manifesting exactly as predicted → audit every case-conversion in the auth path for `Locale.ROOT`/`equalsIgnoreCase()`.
10. **Visually-identical usernames both accepted** — un-normalized composition forms → `Normalizer.normalize(..., Form.NFC)` at registration AND every comparison.

**The pattern:** every symptom reduces to a specific, already-taught mechanism — the actual skill is pattern-matching symptom → category → root cause → fix, which is exactly the senior-engineer diagnostic capability this course targets.

---

## Part 39 — Simplified Internal Implementations

Each: simplified implementation → mechanism → real-JDK differences → why → production implication.

**Concatenation:** naive allocate-and-copy captures the O(n+m)/one-allocation complexity correctly; the real JDK differs via Compact Strings storage and (Java 9+) `invokedynamic`/`StringConcatFactory` late-bound strategy selection.

**StringBuilder:** naive geometric-growth buffer captures the amortized-O(1)-append story correctly; the real JDK differs via Compact Strings storage, precise overflow-safe growth arithmetic, and heavily-overloaded `append()` to avoid boxing/pre-stringification.

**String pool:** a content-keyed `HashMap`-like lookup captures `==`/pooling behavior correctly; the real pool is native JVM code (`StringTable`, HotSpot-internal, `-XX:StringTableSize`-tunable) for bootstrap and performance reasons, and literal interning happens automatically at class-load rather than via explicit calls.

**Hashing:** the simplified formula IS essentially the real, documented algorithm exactly — the only real-JDK addition is caching (`hash`/`hashIsZero`) and coder-aware (but mathematically identical) dispatch.

**Searching (`indexOf`):** naive left-to-right scan-with-early-mismatch-exit is genuinely close to the real JDK's approach — deliberately NOT Boyer-Moore/KMP, because their preprocessing cost isn't justified for typical single-search, short-needle usage; real JDK adds only a cheap first-character pre-check and possible JIT-level vectorized acceleration.

**Unifying lesson:** the real JDK's additions over each simplified model fall into one of three recurring categories — (1) Compact Strings storage optimization, (2) caching/memoization, or (3) a deliberate simplicity-over-sophistication trade-off justified by real usage patterns — a transferable lens for your own low-level performance-sensitive design work.

---

## Part 40 — Production Debugging

Each: **Symptoms → Investigation → Root Cause → Solution → Prevention.**

1. **Equality failures** — env/data-path-dependent match failures → check `==` vs `.equals()` and literal-vs-runtime provenance → `.equals()`/`Objects.equals()` → lint rules flagging `==` on String.
2. **Unicode corruption** — garbled/truncated text for a subset of users/content → reproduce with the specific offending (emoji/multilingual) input → naive char-unit processing → `codePoints()`-based logic → include supplementary-character test cases in the standard suite.
3. **Incorrect encoding** — mojibake at a specific boundary → isolate exactly which boundary via round-trip testing with explicit charsets → mismatched/implicit charset → explicit, matching `Charset` at both ends → zero-exceptions "always explicit charset" rule.
4. **Memory pressure** — elevated GC/heap growth/intermittent OOM → allocation profiling (JFR) + heap dump analysis (MAT) → commonly loop-concat, huge single-String loads, unpooled high-duplication keys, or format/regex churn → root-cause-specific fix → routine (not just reactive) allocation-profiling review.
5. **Excessive GC** — high collection FREQUENCY specifically → correlate allocation rate with request types → hot-path allocation churn → allocation-rate-reduction fixes → allocation-rate awareness as a design-review criterion.
6. **Slow regex** — disproportionate slowness for simple-looking text operations → check for uncached `Pattern.compile()` first (most common cause), then pattern complexity → `static final Pattern`; simplify/bound if genuinely backtracking-heavy → code-review checklist item.
7. **ReDoS** — a specific input causes extreme hang/CPU; thread-pool exhaustion under concurrent load → thread dump showing regex-matching-internals frames dominating → catastrophic backtracking on untrusted input → rewrite pattern, bound input length, timeout/linear-time-engine → security-review checklist item for untrusted-input patterns.
8. **Large allocations** — occasional large spikes correlating with specific operations → allocation profiling correlated with the operation → unbounded whole-payload String loads → streaming + input-size validation → design-review flag for any whole-payload-into-one-String pattern.
9. **Locale bugs** — correct in most regions, wrong in a specific deployment locale → reproduce with `-Duser.language=tr -Duser.country=TR` explicitly → no-arg locale-sensitive method on data needing locale-independence → `Locale.ROOT`/appropriate explicit `Locale` → lint rule flagging no-arg locale-sensitive calls.
10. **Logging overhead** — measurable cost from disabled-level log statements → concatenation vs parameterized, and argument-evaluation cost → unconditional concatenation/eager expensive arguments → parameterized + Supplier-based laziness → lint rules flagging concatenation-based logging calls.
11. **Concatenation bottlenecks** — super-linear scaling signature → `StringBuilder`.
12. **HashMap/String-key problems** — duplicate-seeming entries AND/OR elevated memory (two distinct, independently-fixable root causes) → normalization boundary + targeted interning respectively.
13. **String pool misconceptions** — `.intern()` applied without verified duplication, sometimes correlating with HIGHER memory → remove low-duplication interning; retain only where measured → require explicit justification for any `.intern()` call in review.

---

**TEACHING PHASE COMPLETE — Parts 1–40.**

Practice phase (10 levels: Conceptual, Code Analysis, JVM/Memory, Performance, Unicode, Regex, Production Debugging, API Design, Optimization, Senior Interview) and final strict evaluation/classification to follow separately, per the original course structure.
