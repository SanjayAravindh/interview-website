# Java OOP Mastery — Consolidated Notes

*Senior-level Java OOP course notes: Lesson 1 through Part 13 (concepts only — interview questions, code review drills, and design decision drills omitted).*

---

## Lesson 1: Objects, Classes, State, Behavior, Identity, References

**The problem:** Parallel-array data (`String[] names`, `double[] balances`) separates data from the operations on it — nothing groups related fields together, nothing protects them, and every new field means another array to keep in sync by hand.

**Core model:**
- **Class** = blueprint. **Object** = a concrete instance, allocated on the **heap**, with its own state.
- **State** = current field values. **Behavior** = what an object can do (its methods). **Identity** = the fact that an object is a distinct entity in memory, separate from any other object, regardless of whether its state matches another's.
- **Reference** = a variable doesn't hold the object — it holds an address pointing to it (on the heap).
- **`new`** = (1) allocate heap memory, (2) run the constructor to initialize fields, (3) return a reference, stored in your variable.
- **Garbage collection** = once no reference anywhere points to an object, it becomes eligible for reclamation. No manual `free()`.

**Key code truths:**
```java
Customer a = new Customer("Sanjay", 1000.0);
Customer b = a;          // copies the REFERENCE, not the object — one object, two paths to it
b.deposit(500);
a.getBalance();          // reflects the change — a and b point at the same heap object

Customer c = new Customer("Sanjay", 1000.0);
Customer d = new Customer("Sanjay", 1000.0);
c == d;                  // false — new always allocates a fresh object, even with identical state
```

**Bad design:** Reassigning a method parameter (`c = new Customer(...)` inside a method) never affects the caller's variable — Java passes the *reference* by value. Mutating through the reference (`c.deposit(500)`) *does* affect what the caller sees, since both point at the same object.

**Misconceptions:**
- "Java passes objects by reference" → No — Java passes the reference itself by value.
- "`==` checks if two objects are equal" → `==` on references checks identity (same address), not content equality.
- "Variables hold objects" → Variables of object type hold references to objects.

**Mental model:** A class is a blueprint; an object is a real thing built from it, living on the heap with its own identity. A variable holds a reference (address), not the object. Assignment copies the reference, so multiple variables can point at — and mutate — the same object. `new` always creates a distinct object, even with identical state to another.

---

## Part 2: Encapsulation

**The problem:** `private` fields with unconstrained public setters (`setBalance`) provide *syntactic* privacy with zero real protection — any caller can still push an object into an invalid state.

**Core idea:** Encapsulation means an object can guarantee its own invariants — not "private fields + getters/setters." Key tools: information hiding, validation at the boundary (state-changing methods are the only checkpoint), **Tell, Don't Ask** (tell an object what to do; don't extract its data to compute externally and write it back), and the **Law of Demeter** (talk to immediate collaborators, not through chains: `a.getB().getC().getD()...` is a red flag).

**Comparison:**
```java
account.setBalance(account.getBalance() + 1000); // caller must know and repeat the rule everywhere
account.deposit(1000);                             // rule lives in exactly one place, can validate amount
```

**Bad design:** `getItems()` returning the live internal `List` lets external code do `order.getItems().clear()` — bypasses every rule the object might want to enforce, despite `private` fields.

**Improved design:** State-changing methods (`addItem`) enforce invariants (e.g., "can't modify a shipped order"); getters return defensive copies (`List.copyOf(items)`) instead of live references.

**Trade-offs:** Getters/setters are fine for simple, unconstrained data (a `Point`'s x/y, DTOs). The smell is a setter for a field that participates in a business rule or a relationship with other fields (e.g., `startDate` must precede `endDate`).

**Misconceptions:**
- "Encapsulation = private fields + getters/setters" → can provide zero real protection if the setter is unconstrained or the getter leaks a mutable reference.
- "Using a getter breaks encapsulation" → reading state isn't the problem; unrestricted writing and leaking mutable references are.

**Mental model:** Encapsulation is an object controlling how its own state can change, so it can guarantee its invariants. If a caller can reach in and put the object into an invalid state, encapsulation has failed regardless of `private`.

---

## Part 3: Abstraction

**The problem:** `OrderService` depending directly on `StripePaymentService` (a concrete class) means every payment-provider change ripples through `OrderService`, and there's no seam for testing without hitting Stripe.

**Core idea:** Abstraction = exposing *what* something does while hiding *how*. Enables **Dependency Inversion**: high-level modules (`OrderService`) and low-level modules (`StripePaymentService`) both depend on a shared abstraction (`PaymentService` interface) instead of the high-level module depending directly on the low-level one.

```java
interface PaymentService { PaymentResult charge(Money amount, PaymentToken token); }
class StripePaymentService implements PaymentService { ... }
class OrderService {
    private final PaymentService paymentService; // depends on the abstraction
    OrderService(PaymentService paymentService) { this.paymentService = paymentService; }
}
```

This makes `OrderService` swappable (new providers, fakes for tests) with zero changes to `OrderService` itself.

**Bad design (over-abstraction):** An interface (`AddressValidator`) with exactly one implementation forever, no external dependency to mock, no realistic swap scenario — pure overhead (extra file, extra name, `AddressValidatorImpl`-style naming smell).

**Trade-offs:** Introduce an interface when there's a genuine second implementation, a genuine testing seam (external dependency to fake), or a genuine architectural/plugin boundary — not by default.

**Misconceptions:**
- "Interfaces are the only way to achieve abstraction" → abstract classes and even well-designed concrete classes provide abstraction too.
- "More abstraction = better design" → overhead without a real variation point or testing need.
- "Abstract classes and interfaces are interchangeable" → interfaces = pure contracts (+ default/static methods since Java 8, no state); abstract classes = partial shared implementation + state, but single inheritance only.

**Mental model:** Abstraction means depending on what something does, not how — so implementations can vary or be swapped without touching dependents. Reach for interfaces/abstract classes when there's a real second implementation, testing seam, or architectural boundary — not reflexively.

---

## Part 4: Inheritance

**The problem:** Modeling `Developer`/`Manager`/`Contractor` all as `extends Employee` purely because they share some fields (name, baseSalary) — but `Contractor` has no meaningful `baseSalary`, and ends up overriding `submitTimesheet()` just to throw an exception.

**Core idea:** Inheritance should model a true **IS-A** relationship — a subtype must be substitutable anywhere the supertype is expected *and behave correctly there* (not just compile). If a subclass overrides a method just to disable it, or carries fields it never uses, that's a strong signal the hierarchy models a convenience-driven code-reuse relationship (HAS-A), not a true IS-A.

**Mechanics:** `extends`, method overriding, constructors are not inherited (must call `super(...)` first), `protected` (visible to subclasses + package), `final` on class/method (prevents subclassing/overriding), initialization order (superclass fully initializes before subclass).

**Bad hierarchy:** `Contractor extends Employee` forced to carry an unused `baseSalary` field and override `submitTimesheet()` to throw `UnsupportedOperationException`.

**Improved design:** Extract only the truly universal fields into `Employee` (name/id/email); pull `calculateSalary()` into a separate `SalaryCalculable` interface implemented differently per type; let `Contractor` not extend `Employee` at all if it doesn't share the timesheet/baseSalary assumptions. **Favor composition over inheritance** — extract shared pieces into composed/injected objects or narrow interfaces instead of forcing everything through one `extends` chain.

**Trade-offs:** Inheritance gives automatic reuse + polymorphic substitutability, but creates tight parent-child coupling (fragile base class), single inheritance only, and easy misuse for reuse alone. Composition gives flexibility and no fragile-base-class risk, at the cost of more explicit wiring.

**Misconceptions:**
- "Inheritance is always better for code reuse" → reusing code without a true IS-A relationship produces exactly the `Contractor` problem.
- "If two classes share fields, they should share a superclass" → shared data ≠ shared identity/substitutability.

**Mental model:** Inheritance should model a true IS-A relationship where the subtype can be substituted anywhere the supertype is expected without breaking any of its promises. A subclass overriding a method just to disable it, or carrying unused fields, signals composition is the better fix.

---

## Part 5: Polymorphism

**The problem:** A big `if/else` (or `instanceof` chain) dispatching on a payment-type tag — every new type means editing the same method again.

**Core idea:** Calling the same method name on different objects and having each execute its own behavior, without the caller checking type.

**Two kinds:**
- **Compile-time polymorphism (overloading):** same method name, different parameter lists; resolved by the compiler based on static argument types — unrelated to inheritance.
- **Runtime polymorphism (overriding + dynamic dispatch):** which overridden implementation runs is decided at runtime based on the object's *actual* (runtime) type, not the variable's declared type.

```java
Payment p = new CreditCardPayment();
// compile-time type: Payment (governs which methods you're allowed to call)
// runtime type: CreditCardPayment (governs which implementation actually executes)
p.pay(); // runs CreditCardPayment's implementation, via dynamic dispatch
```

**Upcasting** (subtype → supertype reference) is always safe/implicit. **Downcasting** requires an explicit cast and risks `ClassCastException` if the runtime type doesn't match.

**Fix for the original problem:**
```java
interface Payment { void pay(Money amount); }
class CreditCardPayment implements Payment { public void pay(Money amount) { ... } }
class OrderService {
    void processPayment(Order order, Payment payment) { payment.pay(order.getTotal()); } // no if/else, ever
}
```
Adding a 20th payment type means one new class — `OrderService` is never touched again.

**Common misuse:** `instanceof` chains casting to call type-specific logic are the same problem as the original `if/else`, just dressed up — the method should live on the shared interface instead.

**Misconceptions:**
- "Overloading is runtime polymorphism" → No, resolved at compile time.
- "Overriding is compile-time polymorphism" → No, resolved at runtime via dynamic dispatch.
- "Casting changes the actual object" → No, casting only changes what the compiler allows; the object and its runtime-dispatched behavior are unaffected.

**Mental model:** Runtime polymorphism = the JVM picks the implementation based on the object's actual runtime type, not the declared variable type — letting you code against a shared interface while getting correct type-specific behavior with zero type-checking branches.

---

## Part 6: The `Object` Class and Equality

**The problem:** Two `Product` objects with identical SKUs are treated as different in a `HashSet` — Java's default "sameness" is identity, not equivalence.

**Core defaults (from `Object`):** `equals()` defaults to `this == other` (identity); `hashCode()` defaults to something identity-derived; `toString()` defaults to `ClassName@hexHash`.

**`==` vs `.equals()`:** `==` always compares references for object types and can't be overridden. `.equals()` is a method — defaults to identity, but can be overridden to express content-based equivalence.

**The equals/hashCode contract:** If `a.equals(b)` is `true`, then `a.hashCode()` **must** equal `b.hashCode()` — required for `HashMap`/`HashSet` to work correctly, since they use the hash to pick a bucket and `equals()` to find the exact match *within* that bucket.

```java
class Product {
    @Override public boolean equals(Object other) {
        if (this == other) return true;
        if (other == null || getClass() != other.getClass()) return false;
        return Objects.equals(this.sku, ((Product) other).sku);
    }
    @Override public int hashCode() { return Objects.hash(sku); } // same field(s) as equals()
}
```

**Common bugs:**
- Overriding `equals()` but forgetting `hashCode()` → `.equals()` says true, but the objects land in different `HashMap` buckets, so lookups silently fail.
- Mutating a field used in `hashCode()` after the object is already in a hash-based collection → the object becomes unfindable in its own original bucket.

**Trade-offs:** Content-based equality suits value-like objects (`Money`). Entity-like objects (`Customer` backed by a DB row) are often better compared by a stable ID rather than all mutable fields.

**Misconceptions:**
- "`==` and `.equals()` are interchangeable" → `==` is fixed identity comparison; `.equals()` is overridable.
- "If I override `equals()`, `hashCode()` keeps working fine" → No, must override both together, using the same fields.
- "Same hash code means equal objects" → Backwards — hash collisions between unequal objects are normal and expected.

**Mental model:** `==` always means identity and can't change. `.equals()` defaults to identity but should be overridden for value-like objects to express content equivalence — and whenever overridden, `hashCode()` must be overridden too, using the same fields.

---

## Part 7: Immutability

**The problem:**
```java
class User {
    private final List<String> roles;
    public User(List<String> roles) { this.roles = roles; }       // stores caller's live reference
    public List<String> getRoles() { return roles; }                // returns the live internal list
}
```
`final` only prevents reassigning `this.roles` to a *different* list — it does nothing to stop the list it already points to from being mutated, either by the caller (who kept a reference) or by anyone holding the object via `getRoles()`.

**True immutability requires all of:** `final` fields, no setters, **defensive copying on the way in** (constructor copies mutable arguments, doesn't store the caller's reference), **defensive copying (or immutable view) on the way out** (getters never return live mutable internals), the class itself should be `final` (prevent subclass-introduced mutability), and any fields that are themselves mutable objects must be protected the same way.

```java
final class User {
    private final List<String> roles;
    public User(List<String> roles) { this.roles = List.copyOf(roles); } // copy in, unmodifiable
    public List<String> getRoles() { return roles; }                      // safe — already immutable
}
```

**Records** (Java 16+) give most of this for free for simple data carriers (implicitly `private final`, no setters, implicitly `final` class) — but do **not** auto-defensive-copy mutable fields you pass in or return; you must add that yourself in a compact constructor if a record holds something mutable like a `List`.

```java
record Money(BigDecimal amount, Currency currency) {
    Money { if (amount.signum() < 0) throw new IllegalArgumentException(); } // compact constructor validation
    Money add(Money other) { ... return new Money(...); }                    // returns a NEW value, never mutates
}
```

**Thread-safety:** Immutable objects can never be written to after construction, so there's no possible data race on them — safe to share across threads with zero synchronization.

**Trade-offs:** Immutability costs allocation on every "change" (a new object each time) and defensive-copy overhead; worth it for value objects and hash-map keys, less clear-cut for large, frequently-mutated collections in hot paths.

**Misconceptions:**
- "`final` makes an object immutable" → only prevents field reassignment, not mutation of the referenced object.
- "A record is always better than a normal class" → wrong for behavior-heavy classes, inheritance needs, or mutable fields needing manual copying.
- "Private constructors automatically make objects immutable" → only controls who can construct; says nothing about post-construction mutation via other methods.

**Mental model:** True immutability needs more than `final` — no setters, defensive copying both directions, and a class that can't be subclassed to break the guarantee. Immutable objects eliminate shared-mutable-reference bugs and are inherently thread-safe, at the cost of allocating new objects for every change.

---

## Part 8: Composition

**The problem:** `class Car extends Engine` — a `Car` is not an `Engine` (fails the IS-A test from Part 4); it's forced through inheritance purely to reuse `start()`, exposing `Engine`'s full API as if it were `Car`'s own, and locking in exactly one engine forever.

**Core idea:** Composition models **HAS-A** via a field reference to a collaborator object; the containing class **delegates** work to it.

```java
interface Engine { void start(); }
class PetrolEngine implements Engine { public void start() { ... } }
class Car {
    private final Engine engine;                 // Car HAS-A Engine
    Car(Engine engine) { this.engine = engine; }  // dependency injection
    void drive() { engine.start(); ... }          // delegation
}
```

Swapping `PetrolEngine` for `ElectricEngine` requires zero changes to `Car`. This is also the exact shape Spring's dependency injection expects (constructor injection of collaborators).

**Why preferred in modern apps:** avoids the fragile-base-class problem, supports combining multiple independent collaborators (no single-inheritance limit), and makes unit testing trivial (inject a fake collaborator).

**Trade-offs:** More boilerplate (explicit delegating calls, explicit wiring) than "free" inherited methods; behavior is spread across collaborators rather than centralized in one readable inheritance chain. Inheritance remains right when there's a genuine, stable IS-A relationship needing real polymorphic substitutability.

**Misconceptions:**
- "Composition means dependency injection" → DI is a *technique* for wiring composed objects; composition is the underlying structural relationship — you can compose with plain `new` calls, no framework needed.
- "Composition is just inheritance with extra steps" → different substitutability/coupling properties: swappable at runtime, no forced exposure of the collaborator's full API.

**Mental model:** Composition models HAS-A via a field reference, delegating work rather than inheriting it — enabling swappable collaborators, combining multiple capabilities freely, and easy isolated testing. Favored by default; inheritance reserved for genuine, stable IS-A relationships needing polymorphic substitutability.

---

## Part 9: Cohesion and Coupling

**The problem — low cohesion:** `OrderManager` with `createOrder`, `calculateTax`, `sendWelcomeEmail`, `generateShippingLabel`, `logAuditEvent`, `formatCurrency` — six barely-related responsibilities in one class.

**The problem — high coupling:** `PricingService` directly constructing and calling `StripeApiClient` just to read a fee percentage — pricing logic now depends on a specific payment vendor.

**Core idea:** **High cohesion** = everything inside a class supports one coherent purpose. **Low coupling** = a class depends on as little as possible about other classes' internals, ideally via stable abstractions.

**Fixes:** Split `OrderManager` into `OrderService`, `TaxCalculator`, `WelcomeEmailSender`, `ShippingLabelGenerator` — each with one job. Introduce a `FeeProvider` interface injected into `PricingService`, removing the direct Stripe dependency.

**Temporal coupling:** a sneaky form where A must call B's methods in a specific, undocumented order for correctness (e.g., `checkout()` silently assuming `validateInventory()` ran first).

**Effect on practice:** low cohesion makes unit tests drag in unrelated setup; high coupling makes tests slow/brittle (need real dependencies or complex mocking). High cohesion limits a change's blast radius to one class; low coupling stops a vendor/implementation swap from rippling outward. This scales directly to microservice boundaries (cohesive service = one business capability; low coupling = well-defined APIs, not shared databases).

**Mental model:** High cohesion: everything in a class supports one clear responsibility. Low coupling: a class depends on as little as possible about others' internals, ideally via stable abstractions. Together they're what makes a codebase safe to change.

---

## Part 10: SOLID

### S — Single Responsibility Principle
**Bad:** `OrderService.createOrder()` doing validation, persistence, tax calc, email, and audit logging all in one method — multiple unrelated "reasons to change" collide.
**Fix:** Extract `OrderValidator`, `OrderRepository`, `TaxCalculator`, `EmailNotifier`, `AuditLogger`; `OrderService` orchestrates by composing them.
**Precise definition:** SRP = "one reason to change," not "one method" or "tiny classes." **Overapplication:** splitting `OrderIdGenerator`/`Validator`/`Formatter` into three classes that always change together for the same reason is fragmentation, not higher cohesion.

### O — Open/Closed Principle
**Bad:** `if/else` chain on `customerType` in `DiscountCalculator` — every new tier means editing existing, working code.
**Fix:** `DiscountStrategy` interface + one implementation per tier (polymorphism, Part 5) — `DiscountCalculator` never changes when a new tier is added. **Open for extension, closed for modification.**
**Overapplication:** introducing a `Strategy` interface for something with no real, recurring variation is premature (YAGNI tension).

### L — Liskov Substitution Principle
**Bad:** `Square extends Rectangle` overriding `setWidth`/`setHeight` to keep both equal — breaks code written correctly against `Rectangle`'s contract (independent width/height mutation).
**Precise definition:** subtypes must be substitutable for their base types **without altering program correctness** — not just compiling, but behaving correctly.
**Fix:** Model both as immutable `Shape` implementations exposing only `area()` — removing the mutable setters removes the contract that was being violated.
**Generalizes to:** any subtype forced to override a method just to disable it (e.g., `Contractor.submitTimesheet()` from Part 4) is an LSP violation, not just a geometry-textbook case.

### I — Interface Segregation Principle
**Bad:** Fat `Worker { work(); eat(); sleep(); }` forces `RobotWorker` to fake `eat()`/`sleep()` with thrown exceptions.
**Fix:** Split into `Workable`, `Eatable`, `Sleepable` — implementers only take on what genuinely applies; callers depend only on the capability they need.
**Overapplication:** splitting a naturally cohesive multi-method interface (every real implementer needs all the methods together) into needless single-method interfaces adds indirection without benefit.

### D — Dependency Inversion Principle
**Bad:** `OrderService` (high-level policy) directly depending on `StripePaymentService` (low-level detail).
**Precise definition:** both high-level and low-level modules should depend on a shared abstraction; the dependency arrow points *toward* the abstraction, not from high-level down to low-level detail.
**Connection to Spring:** this is exactly what Spring's DI container automates — `OrderService` depends on `PaymentService`; Spring wires in whichever concrete bean implements it.
**Key distinction:** Dependency **Injection** is the mechanical technique (supply a dependency from outside). Dependency **Inversion** is the architectural principle (depend on abstractions). You can use DI without achieving DIP — injecting a concrete class with no interface is still tight coupling, just wired in from outside.

**SOLID mental model:** S — one reason to change. O — extend via new code, not edits to existing code. L — a subtype must behave correctly wherever its supertype is expected, not just compile. I — don't force implementers to support methods they can't meaningfully provide. D — both high- and low-level code depend on a shared abstraction, dependency arrow pointing toward it.

---

## Part 11: Design Patterns Through OOP

Each pattern: problem it solves → the pattern's shape → where it shows up in production → its trade-off.

- **Strategy** — replaces type-based `if/else` for interchangeable algorithms with an interface + one implementation per variant (the `DiscountStrategy` example from Part 10). JDK example: `Comparator<T>`.
- **Factory / Factory Method** — centralizes complex/conditional object-creation logic in one place (`PaymentFactory.create(type)`) instead of scattering `if/else` type-selection everywhere; Factory Method lets subclasses decide what to instantiate via an overridden creation method. Doesn't eliminate the conditional — relocates it to one maintainable spot.
- **Builder** — solves telescoping constructors / unreadable long parameter lists for objects with many optional fields, especially immutable ones (Part 7); a nested `Builder` class accumulates values via chained calls, then `.build()` constructs the final immutable object. JDK example: `HttpClient.newBuilder()`.
- **Template Method** — fixes a shared algorithm skeleton in a (often `final`) method in a superclass, with a few varying steps left `abstract` for subclasses to fill in. Avoids duplicating the shared steps across near-identical classes; relies on inheritance, so carries Part 4's fragile-base-class risk — Strategy (composition-based) is often preferred for the same "vary one part" problem today.
- **Observer** — decouples "something happened" from "everyone who needs to react" via a listener interface and a list of registered listeners the subject notifies, instead of hardcoding every reaction into the triggering class (OCP-friendly: new listeners are pure additions). JDK/Spring example: `ApplicationEventPublisher`/`@EventListener`.
- **Decorator** — adds behavior (logging, caching, compression) to an object by wrapping it in another object implementing the same interface, avoiding a combinatorial explosion of subclasses for every combination of add-ons. JDK example: `new BufferedReader(new InputStreamReader(new FileInputStream(file)))`.
- **Adapter** — translates an incompatible third-party/legacy interface into the shape your application expects, isolating vendor-specific quirks to one class. Distinct from Decorator: Adapter translates shape (behavior unchanged); Decorator adds behavior (shape unchanged).
- **Command** — represents "an action to perform" as an object itself (with `execute()`/`undo()`), enabling queuing, logging, undo/redo, or deferred execution — more than a plain lambda can offer since it can carry an `undo()` counterpart.
- **State** — represents each of an object's states as its own object implementing a shared interface, replacing scattered `if (status.equals(...))` checks duplicated across every method; illegal transitions become structurally impossible to forget, and new states are additive (OCP-friendly). Distinct from an enum+switch, which still scatters transition *logic* even if it centralizes the state *data*.

**Patterns mental model:** Every pattern here is a named response to a recurring problem already covered in Parts 1–10 — Strategy/State replace conditional branching with polymorphism; Factory centralizes creation decisions; Builder tames complex immutable-object construction; Template Method varies one algorithm step via inheritance; Observer/Command decouple triggers from actions; Decorator/Adapter both wrap, for different purposes (behavior vs. interface translation). Apply a pattern because its originating problem is genuinely present — not by default.

---

## Part 12: OOP in Real Java Applications (Summary)

A realistic Spring Boot slice (`Customer`, `Order`, `Product`, `Money`, `PaymentService`, `NotificationSender`, `InventoryService`, `OrderRepository`) demonstrates every principle above working together:

- **Value objects** (`Money`, `OrderItem`) as immutable records with content-based equality (Parts 6, 7).
- **Entities** (`Customer`, `Order`) with ID-based equality, enforced invariants inside their own methods (Tell, Don't Ask — Part 2), and defensive-copy getters.
- **Interfaces** reserved for genuine architectural boundaries with real implementations and testing needs (`PaymentService`, `NotificationSender`, `InventoryService`, `OrderRepository`) — not for plain domain data classes (Part 3).
- **Services** composing multiple narrow collaborators via constructor injection (Parts 8, 10 DIP) rather than absorbing every concern themselves (SRP, Part 10).
- **DTOs** (`PlaceOrderRequest`, `OrderResponse`) guarding the API boundary so untrusted input never bypasses the domain object's own validation — a domain object with enforced invariants should never be deserialized directly from a request body.
- **Narrow, named exceptions** per distinct failure mode, mirroring Part 4's IS-A discipline.

**The anti-pattern this design avoids:** a single ~300-line `OrderService.placeOrder(Map<String,Object>)` method mixing raw-map parsing, inline string-concatenated SQL (SQL-injection risk), a hardcoded Stripe URL, and inline email sending — violating encapsulation, abstraction, SRP, and testability simultaneously. The fix is exactly the decomposition above: real domain objects owning their own validation, injected abstractions at every genuine boundary, DTOs at the API edge, and a thin orchestrating service.

**Mental model:** A well-designed backend slice mirrors the domain: entities with enforced invariants, immutable value objects for pure data, interfaces at genuine boundaries, DTOs guarding untrusted input, and a thin composing service — nearly every principle from the course shows up as a concrete, load-bearing decision.

---

## Part 13: Misconceptions Experienced Developers Know Beginners Often Get Wrong

A consolidated list (each traces back to a part above where it's covered in depth):

1. **OOP means using classes everywhere** — OOP is about modeling state+behavior+relationships properly, not maximizing class count; plain static utilities are fine when there's no state or invariant to own.
2. **Encapsulation means private fields + getters/setters** — see Part 2.
3. **Inheritance is always better for code reuse** — see Part 4.
4. **Interfaces are always better than classes** — an interface only earns its place with real variation, a testing seam, or an architectural boundary (Part 3).
5. **Every class should have an interface** — see Part 3's `AddressValidator` example.
6. **More abstraction means better design** — see Part 3.
7. **SOLID means smaller classes** — SRP is about reasons to change, not line/method count (Part 10).
8. **Dependency injection automatically makes code loosely coupled** — DI ≠ DIP; injecting a concrete class is still tight coupling (Part 10).
9. **Polymorphism only means method overriding** — overloading is compile-time polymorphism too (Part 5).
10. **`==` and `equals()` are interchangeable** — see Part 6.
11. **`final` makes an object immutable** — only prevents field reassignment (Part 7).
12. **A record is always better than a normal class** — wrong for behavior-heavy or inheritance-needing classes (Part 7).
13. **Composition means dependency injection** — composition is the structural relationship; DI is one wiring technique (Part 8).
14. **Design patterns always improve code** — only when the pattern's originating problem is genuinely present (Part 11).
15. **More classes means better OOP** — same error as #1 and #7; cohesion/coupling/correct modeling matter, not class count.
16. **Getters and setters are always good** — fine for unconstrained data, a smell for invariant-bearing fields (Part 2).
17. **Private constructors automatically make objects immutable** — only controls who can construct, not post-construction mutation (Part 7).
18. **An abstract class is simply a class that cannot be instantiated** — non-instantiability is a side effect of an incomplete blueprint (partial implementation + unfinished contract), not the defining purpose.
19. **Interfaces cannot contain implementation** — since Java 8, `default`/`static` methods can carry real implementation (e.g., `Comparator.reversed()`); interfaces still can't hold instance state, though.
20. **Java does not support multiple inheritance** — true only for class implementation inheritance; a class can implement any number of interfaces (multiple inheritance of contract/default behavior).
21. **Overloading is runtime polymorphism / Overriding is compile-time polymorphism** — exactly backwards: overloading resolves at compile time, overriding resolves at runtime via dynamic dispatch (Part 5).

**Root-cause mental model:** nearly every misconception above comes from mistaking a mechanical Java rule (the `private` keyword, `final`, "can't instantiate," "no multiple inheritance") for the design principle it was meant to serve (protecting invariants, genuine immutability, incomplete contracts, avoiding implementation ambiguity). Always ask: is this a hard language rule, or a design goal the language merely gives tools to pursue?
