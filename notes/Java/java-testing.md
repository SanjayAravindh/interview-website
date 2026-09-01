# Java Unit Testing — JUnit 5, Mockito, AssertJ — Senior Production Reference

JUnit 5 (Jupiter) / Mockito 5.x / AssertJ 3.x. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping Java backends — flaky CI, mocks that lie, tests that pass while customers fail, and coverage numbers that mean nothing.

For **contract testing**, **Testcontainers**, **Pact**, **load/chaos testing**, and **microservice integration strategy**, see [Microservices Testing](../microservices/testing.md). This note owns the **unit and narrow slice** layer: fast, deterministic tests that run in milliseconds and catch logic bugs before they reach the integration suite.

---

## Table of Contents

1. [Mental Model: What a Unit Test Actually Proves](#1-mental-model-what-a-unit-test-actually-proves)
2. [JUnit 5 Architecture and Test Pyramid Boundaries](#2-junit-5-architecture-and-test-pyramid-boundaries)
3. [JUnit 5 Architecture — Platform, Jupiter, Vintage](#3-junit-5-architecture-platform-jupiter-vintage)
4. [Lifecycle, Nesting, and Display Names](#4-lifecycle-nesting-and-display-names)
5. [Assertions: JUnit 5 vs AssertJ](#5-assertions-junit-5-vs-assertj)
6. [Parameterized Tests](#6-parameterized-tests)
7. [Conditional Execution, Tags, and Environments](#7-conditional-execution-tags-and-environments)
8. [JUnit 5 Extension Model](#8-junit-5-extension-model)
9. [Mockito Fundamentals: Mocks, Stubs, and Spies](#9-mockito-fundamentals-mocks-stubs-and-spies)
10. [Stubbing, Verification, and Argument Matchers](#10-stubbing-verification-and-argument-matchers)
11. [Static, Final, void, and Constructor Mocking](#11-static-final-void-and-constructor-mocking)
12. [Mocking Limits and Mockito Pitfalls](#12-mocking-limits-and-mockito-pitfalls)
13. [What NOT to Mock](#13-what-not-to-mock)
14. [Designing for Testability and Hard Things to Test](#14-designing-for-testability-and-hard-things-to-test)
15. [Testing I/O, Files, and Classpath Resources](#15-testing-io-files-and-classpath-resources)
16. [Testing Concurrency and Async Code](#16-testing-concurrency-and-async-code)
17. [Test Doubles Taxonomy: Fake, Stub, Mock, Spy](#17-test-doubles-taxonomy-fake-stub-mock-spy)
18. [Spring @MockBean and Slice Tests — Brief Pointer](#18-spring-mockbean-and-slice-tests-brief-pointer)
19. [Coverage Metrics and PIT Mutation Testing](#19-coverage-metrics-and-pit-mutation-testing)
20. [Test Data Builders and Object Mothers](#20-test-data-builders-and-object-mothers)
21. [Flaky Tests: Diagnosis and Fixes](#21-flaky-tests-diagnosis-and-fixes)
22. [Maven Surefire and Gradle Test Configuration](#22-maven-surefire-and-gradle-test-configuration)
23. [Production Debugging Playbook](#23-production-debugging-playbook)
24. [Quick Decision Matrix](#24-quick-decision-matrix)

---


## 1. Mental Model: What a Unit Test Actually Proves

Unit testing in Java is not "write @Test until JaCoCo is green." It is a **disciplined isolation strategy** that answers: does this unit behave correctly given controlled inputs, without real databases, networks, or clocks?

```
Developer saves file
  └─ IDE / pre-commit
       ├─ Unit tests (JUnit 5 + Mockito + AssertJ)     "does this class compute?"
       ├─ ArchUnit / mutation (optional)               "did tests assert anything real?"
       └─ Static analysis
  └─ CI pipeline
       ├─ Full unit suite (parallel forks)
       ├─ Integration (@SpringBootTest + Testcontainers)  → see microservices/testing.md
       └─ Contract / E2E (separate note)
```

Three objects you must keep distinct:

| Object | Question it answers | Typical tool |
|---|---|---|
| **Unit under test (SUT)** | What behavior am I verifying? | Plain Java class, service method |
| **Test double** | What dependency am I replacing? | Mockito mock, stub, spy, fake |
| **Assertion** | What outcome proves correctness? | AssertJ fluent API, JUnit assertions |

A **green unit suite** does not mean **safe to deploy**. Unit tests pass while the wrong exception type is caught. Mocks pass while real HTTP clients time out. AssertJ passes while time zones silently shift. Mixing those up is the single most common senior misdiagnosis in test strategy.

### The failure modes unit tests don't catch

| Symptom in prod | What passed locally | What was missing |
|---|---|---|
| 500 after deploy | All unit tests | Integration test with real Postgres JSON column |
| Intermittent NPE | Mock returned non-null always | Test with empty Optional from real repo |
| Wrong currency rounding | `assertEquals(10.0, result)` | AssertJ `isEqualByComparingTo` + scale |
| Race under load | Sequential unit test | Concurrency test or integration stress |
| API contract drift | Service unit test with mocked client | Pact verify — see [microservices/testing.md](../microservices/testing.md) |

### Production scenario: green unit tests, broken checkout

**Problem.** `OrderServiceTest` mocks `PaymentClient.charge()` to return success. Production calls real Stripe; field `amountCents` vs `amount` mismatch → 400 from provider. Unit tests never saw the wire format.

**Cause.** Unit tests verified **your** logic against a **mock contract you invented**, not the provider's contract.

**Solution.** Keep unit tests for pricing rules and idempotency keys. Add **contract tests** ([microservices/testing.md](../microservices/testing.md)) for wire format. Never assume a mock's return shape equals production JSON.





---

## 2. JUnit 5 Architecture and Test Pyramid Boundaries

JUnit 5 is three modules. Confusing them causes "why doesn't my `@Rule` work?" and classpath conflicts between Vintage and Jupiter.

```
┌─────────────────────────────────────────────────────────┐
│                    JUnit Platform                        │
│  Launcher, TestEngine discovery, EngineExecutionListener │
└────────────┬───────────────────────┬────────────────────┘
             │                       │
    ┌────────▼────────┐     ┌────────▼────────┐
    │  JUnit Jupiter  │     │  JUnit Vintage  │
    │  (JUnit 5 API)  │     │  (JUnit 4 runner)│
    └─────────────────┘     └─────────────────┘
```

| Module | Role |
|---|---|
| **Platform** | Discovered by Maven Surefire, Gradle, IDE |
| **Jupiter** | `@Test`, `@BeforeEach`, `@ExtendWith` — all new tests |
| **Vintage** | Legacy JUnit 4 only — do not add new tests here |

### Test pyramid and boundaries (unit layer vs integration)

This note owns the **base of the pyramid**. For integration, contract, and E2E layers see [`microservices/testing.md`](../microservices/testing.md).

The test pyramid is not dogma — it is **cost management**. Each layer has different failure modes, speed, and maintenance burden.

```
                    ┌─────────────┐
                    │  E2E / UI   │  few, slow, brittle
                    ├─────────────┤
                    │  Contract   │  consumer-driven API agreement
                    ├─────────────┤
                    │ Integration │  real infra (Testcontainers)
                    ├─────────────┤
                    │    Unit     │  many, fast, isolated  ← THIS NOTE
                    └─────────────┘
```

| Layer | Speed | What it catches | What it misses |
|---|---|---|---|
| Unit | ms | Logic bugs, edge cases, algorithm errors | Wiring, SQL dialect, HTTP serialization |
| Integration | seconds | Bean wiring, SQL, messaging | Cross-service contract drift |
| Contract | seconds | API shape mismatch between teams | Business logic inside one service |
| E2E | minutes | Full user journeys | Root cause localization |

### What belongs in unit tests (this note)

- Pure functions: pricing, validation, mapping (with mocked ports)
- Domain rules: state transitions, invariants
- Error handling branches: retry logic, fallback decisions
- Algorithm correctness: sorting, aggregation, pagination math

### What does NOT belong here (defer to [microservices/testing.md](../microservices/testing.md))

- **Testcontainers** — Postgres, Kafka, Redis in Docker
- **Pact / Spring Cloud Contract** — consumer-provider agreement
- **@SpringBootTest full context** — unless you accept slower "component" tests
- **Load / chaos / k6** — performance and resilience

### Production scenario: inverted pyramid, 45-minute PR builds

**Problem.** Team has 200 E2E tests, 50 integration tests, 300 unit tests. Every PR waits 45 minutes. Developers skip running tests locally. Flaky E2E causes "retry until green" culture.

**Cause.** Unit layer is under-invested; business logic leaked into controllers without extractable services. Every change triggers full stack tests.

**Solution.**

1. Extract testable domain services from controllers.
2. Push wire-format checks to contract tests (see [microservices/testing.md](../microservices/testing.md)).
3. Target: thousands of unit tests, hundreds of integration, dozens of E2E.



---

## 3. JUnit 5 Architecture — Platform, Jupiter, Vintage

JUnit 5 is three modules. Confusing them causes "why doesn't Vintage run my JUnit 4 tests" incidents.

| Module | Role | Maven artifact |
|---|---|---|
| **JUnit Platform** | Launcher, engine discovery, CI integration | `junit-platform-launcher` |
| **JUnit Jupiter** | JUnit 5 programming model (`@Test`, extensions) | `junit-jupiter` |
| **JUnit Vintage** | Runs JUnit 3/4 tests on Platform | `junit-vintage-engine` |

```
JUnit Platform (launcher)
  ├─ Jupiter Engine  → org.junit.jupiter
  ├─ Vintage Engine  → org.junit (4.x)
  └─ Custom engines  → e.g. Cucumber, ArchUnit as tests
```

### Core annotations (Jupiter)

| Annotation | Purpose |
|---|---|
| `@Test` | Test method |
| `@BeforeEach` / `@AfterEach` | Per-test setup/teardown |
| `@BeforeAll` / `@AfterAll` | Once per class (static unless `@TestInstance(Lifecycle.PER_CLASS)`) |
| `@DisplayName` | Human-readable name in reports |
| `@Disabled` | Skip with reason |
| `@Nested` | Inner test classes for grouping |
| `@Tag` | Filter tests (`@Tag("slow")`) |
| `@ExtendWith` | Register extensions (Mockito, Spring, custom) |

### Production scenario: mixed JUnit 4 and 5 on Boot 3

**Problem.** Legacy tests use `@RunWith(SpringRunner.class)` and `@Test` from `org.junit`. New tests use Jupiter. CI runs only Jupiter — 400 legacy tests silently skipped.

**Cause.** Missing `junit-vintage-engine` dependency, or Surefire `<groups>` excludes Vintage.

**Solution.**

```xml
<dependency>
  <groupId>org.junit.vintage</groupId>
  <artifactId>junit-vintage-engine</artifactId>
  <scope>test</scope>
</dependency>
```

Migrate incrementally: `@ExtendWith(SpringExtension.class)` + Jupiter imports. Do not leave Vintage on forever — it blocks Jupiter-only features (`@ParameterizedTest`, extension model).



---

## 4. Lifecycle, Nesting, and Display Names

### Test instance lifecycle

```java
@TestInstance(Lifecycle.PER_CLASS)
class ExpensiveSetupTest {

    private Connection connection;

    @BeforeAll
    void connectOnce() {
        connection = openTestConnection();
    }

    @AfterAll
    void closeOnce() {
        connection.close();
    }

    @Test
    void case1() { /* uses connection */ }

    @Test
    void case2() { /* uses connection */ }
}
```

`PER_CLASS` shares state — faster setup, but tests can pollute each other if they mutate shared fields. Prefer `PER_METHOD` (default) for isolation.

### @Nested for hierarchical structure

```java
@DisplayName("OrderService")
class OrderServiceTest {

    @Nested
    @DisplayName("when inventory is available")
    class WhenAvailable {

        @BeforeEach
        void stubInventory() {
            when(inventoryClient.check(stockId)).thenReturn(Available.yes(10));
        }

        @Test
        void placesOrder() { /* ... */ }
    }

    @Nested
    @DisplayName("when inventory is unavailable")
    class WhenUnavailable {

        @BeforeEach
        void stubInventory() {
            when(inventoryClient.check(stockId)).thenReturn(Available.no());
        }

        @Test
        void rejectsOrder() { /* ... */ }
    }
}
```

`@Nested` inner classes must be **non-static**. Outer class setup runs, then inner `@BeforeEach`, then test. This mirrors BDD "given/when/then" without Cucumber overhead.

### Production scenario: shared mutable state in @BeforeEach

**Problem.** Test A sets `service.setDiscount(0.1)` in `@BeforeEach`. Test B assumes no discount. Order depends on `@Order` annotation but both pass locally, fail on CI when order changes.

**Cause.** Mutable SUT or shared mock configuration leaking between tests.

**Solution.** Immutable test fixtures. Reset mocks in `@AfterEach` (`Mockito.reset(mock)`) or use fresh mocks per test. Never rely on test execution order.

### Common misconfigurations

| Misconfiguration | Symptom |
|---|---|
| `@BeforeAll` non-static with PER_METHOD | InitializationError at class load |
| Static `@Nested` inner class | Jupiter ignores nested tests |
| `@DirtiesContext` in unit tests | Pulling Spring into unit layer unnecessarily |
| `@Order` without `@TestMethodOrder` | Order annotation ignored |

### @TestMethodOrder when order truly matters

Prefer **no order dependency**. If legacy suite requires deterministic order (shared file append):

```java
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class LegacyAppendTest {

    static Path logFile;

    @BeforeAll
    static void init(@TempDir Path dir) {
        logFile = dir.resolve("audit.log");
    }

    @Test @Order(1)
    void writesHeader() throws IOException {
        Files.writeString(logFile, "HEADER\n");
    }

    @Test @Order(2)
    void appendsRow() throws IOException {
        Files.writeString(logFile, "row-1\n", StandardOpenOption.APPEND);
        assertThat(Files.readString(logFile)).contains("HEADER", "row-1");
    }
}
```

Better fix: refactor to pass accumulated state explicitly instead of relying on test order.

### Production scenario: @Nested + @BeforeEach stub drift

**Problem.** Outer `@BeforeEach` stubs `when(repo.count()).thenReturn(5L)`. Inner nested class `@BeforeEach` stubs `when(repo.count()).thenReturn(0L)` but outer runs first — stub overwritten, test expects 5, gets 0.

**Cause.** Mockito stubs last-write-wins on same method signature.

**Solution.** Scope stubs to nested class only; avoid outer stubs that inner overrides. Or use separate mock instances per nested class (rare). Document stub ownership in nested `@DisplayName`.



---

## 5. Assertions: JUnit 5 vs AssertJ

JUnit 5 ships `org.junit.jupiter.api.Assertions`. AssertJ (`assertThat`) is the production standard for readable failures.

### JUnit 5 basics

```java
import static org.junit.jupiter.api.Assertions.*;

assertEquals(expected, actual);
assertThrows(IllegalArgumentException.class, () -> service.process(null));
assertAll("order",
    () -> assertEquals("CONFIRMED", order.status()),
    () -> assertTrue(order.total().signum() > 0)
);
```

`assertAll` runs all assertions and reports all failures — critical for setup-heavy tests.

### AssertJ — use this in production codebases

```java
import static org.assertj.core.api.Assertions.*;

assertThat(order)
    .isNotNull()
    .extracting(Order::status, Order::total)
    .containsExactly(Status.CONFIRMED, new BigDecimal("99.99"));

assertThatThrownBy(() -> service.charge(null))
    .isInstanceOf(IllegalArgumentException.class)
    .hasMessageContaining("amount");

assertThat(list)
    .hasSize(3)
    .extracting(User::email)
    .containsExactly("a@test.com", "b@test.com", "c@test.com");
```

### BigDecimal and floating point

```java
// WRONG — double imprecision
assertEquals(0.1 + 0.2, result);  // may fail or pass incorrectly

// RIGHT
assertThat(result).isEqualByComparingTo(new BigDecimal("0.30"));

// For doubles when you must
assertThat(actual).isCloseTo(expected, within(0.001));
```

### Production scenario: assertEquals on List order

**Problem.** Test asserts `assertEquals(List.of(a, b, c), service.findAll())`. Passes locally. Fails on CI when DB returns different order.

**Cause.** Order not guaranteed unless `ORDER BY` specified. `assertEquals` on lists is order-sensitive.

**Solution.**

```java
assertThat(service.findAll())
    .containsExactlyInAnyOrder(a, b, c);
// or
assertThat(service.findAll()).hasSameElementsAs(expected);
```



---

## 6. Parameterized Tests

Replace copy-paste tests with `@ParameterizedTest`:

```java
@ParameterizedTest
@CsvSource({
    "0, false",
    "1, false",
    "18, true",
    "17, false"
})
void isAdult(int age, boolean expected) {
    assertThat(AgePolicy.isAdult(age)).isEqualTo(expected);
}

@ParameterizedTest
@MethodSource("invalidEmails")
void rejectsInvalidEmail(String email) {
    assertThatThrownBy(() -> Email.of(email))
        .isInstanceOf(IllegalArgumentException.class);
}

static Stream<String> invalidEmails() {
    return Stream.of("", "not-an-email", "@missing-local.com");
}

@ParameterizedTest
@EnumSource(value = Status.class, names = {"ACTIVE", "PENDING"})
void allowedTransitionsFrom(Status from) {
    assertThat(stateMachine.canTransition(from, Status.CANCELLED)).isTrue();
}
```

### @ValueSource, @NullAndEmptySource, @NullSource

```java
@ParameterizedTest
@NullAndEmptySource
@ValueSource(strings = {"  ", "\t"})
void blankNamesRejected(String name) {
    assertThatThrownBy(() -> User.create(name)).isInstanceOf(IllegalArgumentException.class);
}
```

### Production scenario: 40 nearly identical tests

**Problem.** File has `testDiscount1` through `testDiscount40` differing only in input/output. Maintenance nightmare; reviewers skip reading them.

**Solution.** One `@ParameterizedTest` with `@CsvFileSource` or `@MethodSource`. Add cases by adding rows, not methods.

```java
@ParameterizedTest
@CsvFileSource(resources = "/discount-cases.csv", numLinesToSkip = 1)
void applyDiscount(int qty, String tier, BigDecimal expected) {
    assertThat(pricing.apply(qty, Tier.valueOf(tier))).isEqualByComparingTo(expected);
}
```



---

## 7. Conditional Execution, Tags, and Environments

### @EnabledOnOs, @DisabledOnJre, @EnabledIf

```java
@EnabledOnOs(OS.WINDOWS)
@Test
void windowsSpecificPathHandling() { /* ... */ }

@EnabledIfEnvironmentVariable(named = "RUN_INTEGRATION", matches = "true")
@Test
void heavyTest() { /* ... */ }
```

Prefer **tags** over environment variables for CI filtering:

```java
@Tag("slow")
@Tag("integration")
@Test
void fullReindex() { /* ... */ }
```

Maven Surefire:

```xml
<configuration>
  <groups>fast</groups>
  <excludedGroups>slow,integration</excludedGroups>
</configuration>
```

### Production scenario: "works locally, skipped in CI"

**Problem.** Developer adds `@EnabledIf("isDev")` referencing a method that checks `spring.profiles.active`. CI has no profile → test never runs → regression ships.

**Solution.** Document tag strategy. Default CI runs `fast` tag only. Nightly runs all. Never gate **unit** tests on environment — only integration/slow tests.

---

## 8. JUnit 5 Extension Model

Extensions replace JUnit 4 rules/runners. They hook lifecycle callbacks and parameter resolution.

```java
public class DatabaseExtension implements BeforeEachCallback, AfterEachCallback {

    @Override
    public void beforeEach(ExtensionContext ctx) {
        // setup
    }

    @Override
    public void afterEach(ExtensionContext ctx) {
        // teardown
    }
}

@ExtendWith(DatabaseExtension.class)
class MyTest { /* ... */ }
```

### Built-in extensions you use daily

| Extension | Source | Purpose |
|---|---|---|
| `MockitoExtension` | mockito-junit-jupiter | `@Mock`, `@InjectMocks`, strict stubs |
| `SpringExtension` | spring-test | `@SpringBootTest`, `@WebMvcTest` |
| `OutputCaptureExtension` | spring-boot-test | Capture System.out/err |
| `TimeoutExtension` | Jupiter | `@Timeout(2)` per test |

### Custom ParameterResolver

```java
public class UserResolver implements ParameterResolver {
    @Override
    public boolean supportsParameter(ParameterContext pc, ExtensionContext ec) {
        return pc.getParameter().getType() == User.class;
    }

    @Override
    public Object resolveParameter(ParameterContext pc, ExtensionContext ec) {
        return User.builder().id("test-1").build();
    }
}
```

### Production scenario: MockitoExtension not registered

**Problem.** `@Mock UserRepository repo` is null in test. NPE on `when(repo.find...)`.

**Cause.** Missing `@ExtendWith(MockitoExtension.class)` or `@MockitoSettings`. JUnit 5 does not auto-initialize mocks (unlike `@RunWith(MockitoJUnitRunner.class)` in JUnit 4).

**Solution.**

```java
@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock UserRepository repo;
    @InjectMocks UserService service;
}
```

Or use `@MockitoSettings(strictness = Strictness.LENIENT)` only when you have a documented reason.



---

## 9. Mockito Fundamentals: Mocks, Stubs, and Spies

### @Mock vs manual

```java
@Mock PaymentGateway gateway;

// manual
PaymentGateway gateway = mock(PaymentGateway.class);
```

### Stubbing

```java
when(gateway.charge(any(Money.class))).thenReturn(ChargeResult.success("ch_123"));
when(gateway.charge(argThat(m -> m.amount().isNegative()))).thenThrow(new IllegalArgumentException());

when(repo.findById(404L)).thenReturn(Optional.empty());
```

### @InjectMocks

Mockito injects mocks into constructor or fields (constructor preferred):

```java
@InjectMocks OrderService service;  // injects @Mock fields into OrderService
```

If multiple constructors exist, Mockito picks the **largest** one injectable with mocks. Ambiguity → manual construction:

```java
service = new OrderService(repo, gateway, clock);
```

### Spy — partial mock

```java
List<String> list = spy(new ArrayList<>(List.of("a", "b")));
when(list.size()).thenReturn(100);  // stub one method
list.add("c");                     // real method runs
```

**Danger:** spying on real objects with complex internals. Prefer mocking interfaces.

### Production scenario: @InjectMocks with final field

**Problem.** `@InjectMocks` leaves `private final Clock clock` null. NPE in test.

**Cause.** Field injection on immutable fields fails silently in some Mockito versions; or no setter/constructor param for `Clock`.

**Solution.** Constructor injection in production code:

```java
@RequiredArgsConstructor
class OrderService {
    private final OrderRepository repo;
    private final Clock clock;
}
```

Then `@InjectMocks` uses constructor. Or pass explicitly: `new OrderService(repo, Clock.fixed(...))`.



---

## 10. Stubbing, Verification, and Argument Matchers

### verify basics

```java
verify(gateway).charge(moneyCaptor.capture());
verify(repo, times(1)).save(any(Order.class));
verify(emailService, never()).send(any());
verify(cache, timeout(500)).evict("orders");
verifyNoInteractions(auditLogger);
verifyNoMoreInteractions(gateway);
```

### ArgumentCaptor

```java
@Captor ArgumentCaptor<Order> orderCaptor;

@Test
void savesOrderWithCorrectTotal() {
    service.placeOrder(request);
    verify(repo).save(orderCaptor.capture());
    assertThat(orderCaptor.getValue().total()).isEqualByComparingTo("49.99");
}
```

Use captors when return value doesn't expose what was passed to dependency.

### Matchers

```java
when(repo.findByStatus(eq(Status.ACTIVE), any(Pageable.class))).thenReturn(page);

verify(gateway).charge(argThat(m ->
    m.currency().equals(Currency.USD) && m.amount().compareTo(BigDecimal.ZERO) > 0));
```

**Rule:** if you use a matcher for one argument, **all** arguments must be matchers:

```java
// WRONG
when(repo.findById(1L, any())).thenReturn(...);

// RIGHT
when(repo.findById(eq(1L), any())).thenReturn(...);
```

### Production scenario: verify called but wrong arguments

**Problem.** Test verifies `verify(repo).save(any())` — passes when save is called with **wrong** entity state.

**Cause.** Over-use of `any()` — test proves interaction happened, not correctness.

**Solution.** Combine captor + AssertJ on captured value, or `argThat` with meaningful predicate.



---

## 11. Static, Final, void, and Constructor Mocking

### Mocking static methods (mockito-inline)

```java
try (MockedStatic<IdGenerator> mocked = mockStatic(IdGenerator.class)) {
    mocked.when(IdGenerator::next).thenReturn("fixed-id");
    Order order = service.createOrder(dto);
    assertThat(order.id()).isEqualTo("fixed-id");
}
```

Always use **try-with-resources** — static mock leaks into other tests if not closed.

### Mocking final classes/methods

Requires `mockito-inline` (default in Mockito 5+ / Spring Boot 3):

```java
@Mock FinalLegacyClient client;  // works with inline mock maker
```

### void methods

```java
doNothing().when(audit).log(anyString());
doThrow(new RuntimeException("disk full")).when(audit).log("fail");

verify(audit).log("order.created");
```

Use `doReturn().when()` for spies to avoid calling real method during stubbing:

```java
doReturn(42).when(spy).compute();  // not when(spy).compute() which may invoke real method
```

### doAnswer for custom behavior

```java
doAnswer(inv -> {
    Order o = inv.getArgument(0);
    o.markProcessed();
    return null;
}).when(processor).handle(any(Order.class));
```

### Production scenario: static mock not closed — flaky CI

**Problem.** Test A mocks `Instant.now()`. Test B runs later, gets frozen time. Passes alone, fails in suite.

**Cause.** `MockedStatic` not closed (pre-try-with-resources code or exception before close).

**Solution.** Always:

```java
try (MockedStatic<Instant> clock = mockStatic(Instant.class, CALLS_REAL_METHODS)) {
    clock.when(Instant::now).thenReturn(fixedInstant);
    // test body
}
```



---

## 12. Mocking Limits and Mockito Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Stubbing wrong overload | Mock returns null | Match exact parameter types |
| any() for primitives | Unexpected stub miss | Use `anyInt()`, `anyLong()` |
| Spy + when().thenReturn() | Real method called | Use `doReturn().when(spy)` |
| Static mock leak | Flaky order-dependent tests | try-with-resources |
| verify on non-mock | NotAMockException | Wrap with @Mock |
| equals() vs eq() | Matcher in wrong place | Use eq() for literal values when mixing matchers |
| @Captor not initialized | Null captor | `@ExtendWith(MockitoExtension.class)` |
| Mocking value objects | Fragile tests | Use real instances for DTOs/records |

### Mockito vs manual fakes

When mock setup exceeds ~10 lines, consider a **fake** implementation:

```java
class InMemoryOrderRepository implements OrderRepository {
    private final Map<Long, Order> store = new ConcurrentHashMap<>();
    @Override public Order save(Order o) { store.put(o.id(), o); return o; }
    @Override public Optional<Order> findById(Long id) { return Optional.ofNullable(store.get(id)); }
}
```

Fakes test more realistically without Docker. Still unit-level if no external I/O.



---

## 13. What NOT to Mock

Mock **boundaries**, not **your domain**.

| Do mock | Do not mock |
|---|---|
| HTTP clients, message brokers, email SMTP | Your own value objects (`Money`, `OrderLine`) |
| Repositories in **service unit tests** | Pure functions / calculators in same module |
| Clock, `Random` (or inject seeded) | Collections you own inside the SUT |
| External SDKs | MapStruct mappers — test with real mapping |
| Other team's services | DTOs/records used as data |

### The "mock the database" trap

Mocking `JdbcTemplate` or `EntityManager` in a test labeled "unit" proves **you stubbed SQL correctly**, not that SQL is correct. Repository query logic belongs in `@DataJpaTest` + Testcontainers — see [`microservices/testing.md` §5](../microservices/testing.md#5-integration-testing).

### Production scenario: mocked repository for every test

**Problem.** 80 tests each stub five repository methods. Refactoring the repository interface breaks 80 files.

**Solution.** Introduce `InMemoryOrderRepository` fake used by default. Mock only error paths (`save` throws).

---

## 14. Designing for Testability and Hard Things to Test

### Designing for testability

Testability is **seams** — injection points for time, I/O, and identity.

```java
public class OrderService {
    private final OrderRepository repo;
    private final Clock clock;

    public OrderService(OrderRepository repo, Clock clock) {
        this.repo = repo;
        this.clock = clock;
    }

    public Order placeOrder(PlaceOrderCommand cmd) {
        Order order = Order.create(cmd, clock.instant());
        repo.save(order);
        return order;
    }
}
```

Extract pure functions for fee/tax math — test without mocks. Avoid `new RestTemplate()` inside methods, static `Config.getInstance()`, and testing private methods via reflection.

### Hard things to test

| Hard thing | Strategy |
|---|---|
| **Time** | Inject `Clock`; `Clock.fixed(...)` in tests |
| **Random / UUID** | Inject `Supplier<UUID>` |
| **Static legacy calls** | Adapter + mock adapter; static mock last resort |
| **Async / `@Async`** | Unit-test sync core; `Awaitility` in integration |
| **Retry / resilience** | Unit-test policy math; fault injection in [`testing.md` §12](../microservices/testing.md#12-resilience-testing) |

### Exceptions, time, and randomness (examples)

### Exceptions

```java
assertThatThrownBy(() -> service.refund(alreadyRefunded))
    .isInstanceOf(InvalidStateException.class)
    .hasFieldOrPropertyWithValue("errorCode", "ALREADY_REFUNDED")
    .satisfies(ex -> assertThat(((InvalidStateException) ex).orderId()).isEqualTo(42L));
```

### Clock injection — always in production code

```java
class TokenService {
    private final Clock clock;
    TokenService(Clock clock) { this.clock = clock; }

    boolean isExpired(Instant expiresAt) {
        return Instant.now(clock).isAfter(expiresAt);
    }
}

@Test
void expiredWhenPastNow() {
    Clock fixed = Clock.fixed(Instant.parse("2025-06-01T12:00:00Z"), ZoneOffset.UTC);
    TokenService svc = new TokenService(fixed);
    assertThat(svc.isExpired(Instant.parse("2025-05-01T00:00:00Z"))).isTrue();
}
```

Never `Thread.sleep` in unit tests. Use `Awaitility` for async waits (with short timeouts):

```java
await().atMost(Duration.ofSeconds(2))
    .untilAsserted(() -> assertThat(cache.get(key)).isPresent());
```

### Randomness

Inject `Random` or `Supplier<UUID>`:

```java
when(idSupplier.get()).thenReturn(UUID.fromString("00000000-0000-0000-0000-000000000001"));
```



---

## 15. Testing I/O, Files, and Classpath Resources

### JUnit TempDir

```java
@TempDir Path tempDir;

@Test
void writesExportFile() throws IOException {
    Path out = tempDir.resolve("export.csv");
    exporter.write(out, data);
    assertThat(out)
        .content()
        .contains("header1,header2");
}
```

### In-memory file systems (jimfs) for complex paths

```java
FileSystem fs = Jimfs.newFileSystem(Configuration.unix());
Path config = fs.getPath("/app/config.yml");
Files.writeString(config, "key: value");
```

### Production scenario: test reads src/main/resources — passes locally, fails in CI

**Problem.** Test uses `Paths.get("src/test/resources/fixture.json")` — relative to working directory.

**Solution.**

```java
URL url = getClass().getResource("/fixture.json");
Path path = Path.of(url.toURI());
// or
String json = Files.readString(Path.of(getClass().getResource("/fixture.json").toURI()));
```

Classpath resources only — never filesystem paths to source tree.

---

## 16. Testing Concurrency and Async Code

Unit tests for concurrent code are hard. Strategies:

1. **Test the algorithm sequentially** — pure function over shared data structure with injected lock.
2. **Use CountDownLatch** to coordinate threads in controlled scenarios.
3. **Defer stress testing** to integration/load layer ([microservices/testing.md](../microservices/testing.md)).

```java
@Test
void concurrentIncrements() throws Exception {
    Counter counter = new Counter();
    int threads = 10;
    CountDownLatch start = new CountDownLatch(1);
    CountDownLatch done = new CountDownLatch(threads);

    for (int i = 0; i < threads; i++) {
        new Thread(() -> {
            try { start.await(); counter.increment(); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            finally { done.countDown(); }
        }).start();
    }
    start.countDown();
    assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
    assertThat(counter.get()).isEqualTo(threads);
}
```

### CompletableFuture testing

```java
@Test
void asyncResult() {
    CompletableFuture<String> future = service.fetchAsync("id");
    assertThat(future). completesWithin(1, TimeUnit.SECONDS);
    assertThat(future.join()).isEqualTo("expected");
}
```

AssertJ 3.24+ has `CompletableFutureAssert`. Otherwise use Awaitility.



---

## 17. Test Doubles Taxonomy: Fake, Stub, Mock, Spy

| Type | Definition | When to use |
|---|---|---|
| **Dummy** | Passed but never used | Satisfy compiler signature |
| **Stub** | Returns canned answers | State verification unnecessary |
| **Mock** | Pre-programmed + verify interactions | Command objects, side effects |
| **Spy** | Partial real object | Legacy class, verify one call |
| **Fake** | Working simplified impl | In-memory repo, fake SMTP |

Martin Fowler's distinction: **mocks are about behavior verification**, **stubs about state setup**. Mockito blurs the line — use intentionally.

### Production scenario: mock repository for every test

**Problem.** 80 tests each stub 5 repository methods. Refactoring repository interface breaks 80 files.

**Solution.** Introduce `InMemoryOrderRepository` fake used by default. Mock only for error paths (`save` throws).

---

## 18. Spring @MockBean and Slice Tests — Brief Pointer

`@MockBean` replaces a bean in the **Spring ApplicationContext** during slice or full Spring tests — not for pure unit tests (use `@Mock` + `MockitoExtension`).

```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {
    @Autowired MockMvc mockMvc;
    @MockBean OrderService orderService;

    @Test
    void returns201() throws Exception {
        when(orderService.create(any())).thenReturn(new OrderResponse("1"));
        mockMvc.perform(post("/api/orders").contentType(APPLICATION_JSON).content(body))
            .andExpect(status().isCreated());
    }
}
```

**Anti-pattern:** `@SpringBootTest` + `@MockBean` on many dependencies for service logic — slow, proves neither logic nor wiring. Unit-test the service with `@Mock`; integration-test with Testcontainers per [`microservices/testing.md`](../microservices/testing.md).

Optional **ArchUnit** enforces package layering (domain free of Spring imports) — structure guard, not behavior proof.

---

## 19. Coverage Metrics and PIT Mutation Testing

**JaCoCo** measures lines/branches executed. **PIT** mutates bytecode (`>=` → `>`) and checks if tests fail.

```xml
<!-- JaCoCo -->
<plugin>
    <groupId>org.jacoco</groupId>
    <artifactId>jacoco-maven-plugin</artifactId>
    <executions>
        <execution><goals><goal>prepare-agent</goal></goals></execution>
        <execution><id>report</id><phase>test</phase><goals><goal>report</goal></goals></execution>
    </executions>
</plugin>
```

Gate **branch coverage** on domain packages, not blind 90% on DTOs. Run PIT nightly on core modules — too slow for every PR. Cross-ref [`testing.md` §15](../microservices/testing.md#15-mutation-testing).

| Mutation survived | Missing test |
|---|---|
| Changed conditional boundary | Off-by-one / `@CsvSource` boundary |
| Replaced return value | Weak assertion |
| Removed method call | No `verify` or outcome assert |



---

## 20. Test Data Builders and Object Mothers

### Test Data Builder

```java
class OrderBuilder {
    private Long id = 1L;
    private Status status = Status.DRAFT;
    private BigDecimal total = new BigDecimal("10.00");

    OrderBuilder withStatus(Status s) { this.status = s; return this; }
    OrderBuilder withTotal(String t) { this.total = new BigDecimal(t); return this; }
    Order build() { return new Order(id, status, total); }

    static OrderBuilder anOrder() { return new OrderBuilder(); }
}

// usage
Order order = anOrder().withStatus(Status.PAID).withTotal("99.99").build();
```

### Object Mother

```java
class Orders {
    static Order paidOrder() { return anOrder().withStatus(Status.PAID).build(); }
    static Order cancelledOrder() { return anOrder().withStatus(Status.CANCELLED).build(); }
}
```

Avoid **shared mutable fixtures**:

```java
// BAD — static mutable
public static Order STANDARD_ORDER = new Order(...);
```

Each test should build fresh data unless explicitly testing immutability.

---

## 21. Flaky Tests: Diagnosis and Fixes

| Smell | Fix |
|---|---|
| `Thread.sleep(1000)` | Awaitility / inject clock |
| `@Order` dependency | Isolate tests, no shared state |
| Real network call | Mock WebClient or wiremock in integration layer |
| Fixed `Instant.now()` without injection | Clock abstraction |
| Random without seed | Fixed Random(42) or injected supplier |
| Locale-dependent dates | `Locale.US` in test or `Clock` + `ZoneId.of("UTC")` |
| File path separators | `Path.of` / `@TempDir` |
| Collection order assumptions | `containsExactlyInAnyOrder` |

### Production scenario: 3% flaky CI on timezone boundary

**Problem.** Tests run at 23:59 UTC fail on date rollover — `LocalDate.now()` in SUT.

**Solution.** Inject `Clock`. In test: `Clock.fixed(...)`. Never call `now()` statically in domain code.



---

## 22. Maven Surefire and Gradle Test Configuration

### Maven Surefire defaults (tune for monorepos)

```xml
<plugin>
  <artifactId>maven-surefire-plugin</artifactId>
  <configuration>
    <parallel>classes</parallel>
    <threadCount>4</threadCount>
    <groups>fast</groups>
    <excludedGroups>slow,integration,flaky</excludedGroups>
    <rerunFailingTestsCount>0</rerunFailingTestsCount>
  </configuration>
</plugin>
```

**Do not** `rerunFailingTestsCount=2` as permanent policy — it hides flakiness.

### Fail fast vs full report

PR builds: fail fast, run unit only. Main branch: full suite + integration ([microservices/testing.md](../microservices/testing.md)).

### JaCoCo gates

```xml
<minimum>0.80</minimum>
```

Apply to **new/changed** code via diff coverage tools when possible — not blind global 80% on legacy modules.

### Gradle test task (equivalent knobs)

```kotlin
tasks.test {
    useJUnitPlatform {
        includeTags("fast")
        excludeTags("slow", "integration", "flaky")
    }
    maxParallelForks = Runtime.getRuntime().availableProcessors() / 2
    failFast = System.getenv("CI") == "true"
}
```

### Test naming and structure conventions

| Convention | Example | Why |
|---|---|---|
| Method name describes behavior | `shouldRejectOrderWhenInventoryZero()` | Surefire report readable without @DisplayName |
| `@DisplayName` for stakeholders | `@DisplayName("Refund policy: partial refund blocked after 30 days")` | BDD language in CI dashboards |
| One logical assertion focus | Single `assertThat` chain on related fields | Easier failure diagnosis |
| No `test1`, `test2` | — | Code review red flag |

### Production scenario: Surefire fork reuse hides static pollution

**Problem.** Individual test passes. Full module fails with wrong singleton state. `-reuseForks=false` makes failure disappear intermittently.

**Cause.** Static field in production or test code mutated; fork reuse carries state across classes.

**Solution.** Fix static mutable state. As temporary mitigation: `<reuseForks>false</reuseForks>` in Surefire (slower). Grep for `static` mutable in `src/main` and `src/test`.











---

## 23. Production Debugging Playbook

When "tests pass locally, fail in CI":

1. **Check timezone/locale.** `TZ=UTC` in CI Dockerfile. Compare `user.timezone` system property.

2. **Check parallel execution.** Run locally with same Surefire config: `mvn -Dparallel=classes -DthreadCount=4 test`.

3. **Check test order.** Run single test vs class vs module: `mvn -Dtest=OrderServiceTest#method test`.

4. **Check for static mock/time leak.** Grep for `mockStatic` without try-with-resources.

5. **Check classpath resources.** No relative paths to `src/`.

6. **Check Mockito strict stubs.** CI may run tests in different order exposing `UnnecessaryStubbingException`.

7. **Read Surefire reports.** `target/surefire-reports/*.txt` — full stack trace, not IDE summary.

8. **OutOfMemory in CI.** Reduce fork parallelism or increase `-Xmx` for test JVM.

| Symptom | Likely cause |
|---|---|
| UnnecessaryStubbingException | Unused when() in test or @BeforeEach |
| NullPointerException on @Mock field | Missing MockitoExtension |
| IllegalStateException stream consumed | Reused Stream in test data |
| Wrong number of invocations | verify too strict / async not awaited |
| 403 in @WebMvcTest | Missing `@Import(SecurityConfig)` or `@AutoConfigureMockMvc(addFilters = false)` |
| JSON strict mismatch | Field order or float formatting — use jsonPath |

---

## 24. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Pure domain logic | Plain JUnit + AssertJ, no Spring |
| External HTTP client | Mock interface in unit; WireMock/Testcontainers in integration |
| Repository CRUD logic | In-memory fake or `@DataJpaTest`; Testcontainers for SQL quirks |
| Controller JSON mapping | `@WebMvcTest` + MockMvc |
| Static time/UUID | Inject Clock / Supplier; mock in test |
| void side-effect method | `doAnswer` / verify interaction |
| 40 similar input cases | `@ParameterizedTest` |
| Flaky async | Awaitility with short timeout; fix production timeout too |
| API contract with other team | Pact — [microservices/testing.md](../microservices/testing.md) |
| Real Postgres behavior | Testcontainers — [microservices/testing.md](../microservices/testing.md) |
| Layering violations | ArchUnit |
| Weak assertions | AssertJ + mutation testing on domain |
| Legacy JUnit 4 tests | Vintage engine, migrate to Jupiter |

---

*Unit tests prove your logic under controlled lies (mocks). Integration and contract tests prove the lies match reality. Keep both — in the right layer.*

---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>Q1. What is the difference between a unit test and an integration test?</summary>

A **unit test** exercises one unit (class/method) in **isolation**, replacing external dependencies with test doubles. It should be fast (milliseconds), deterministic, and not require Spring context, databases, or network.

An **integration test** verifies that **multiple components work together** with real or realistic infrastructure (DB, HTTP, message broker). See [microservices/testing.md](../microservices/testing.md) for Spring Boot integration patterns and Testcontainers.

The boundary is not "uses Spring" — a `@ExtendWith(MockitoExtension.class)` test with no Spring is still a unit test. A `@DataJpaTest` with H2 is a slice integration test.

</details>

<details class="qa-item">
<summary>Q2. Why do senior teams distrust coverage percentages?</summary>

Coverage measures **lines executed**, not **behavior verified**. A test that calls every branch but asserts nothing useful yields 100% coverage and zero confidence.

Mutation testing (Pitest) helps: it mutates code (`>` → `>=`) and checks if tests fail. High coverage + low mutation score = tests that "touch" code without catching regressions.

Use coverage as a **floor** (e.g. 80% on new code), not a **ceiling** goal. Pair with AssertJ assertions on outcomes, not just "no exception thrown."

</details>

<details class="qa-item">
<summary>Q3. Should I mock the database in unit tests?</summary>

**Yes** for repository *interfaces* when testing service logic — mock `OrderRepository` to return canned entities.

**No** when testing query logic, JPQL, or native SQL — that belongs in `@DataJpaTest` + Testcontainers (integration layer).

Anti-pattern: mocking `EntityManager` and `Query` to simulate SQL. You are testing Mockito setup, not your query.

</details>

<details class="qa-item">
<summary>Q4. @BeforeAll fails with "method must be static" — why?</summary>

By default JUnit 5 uses `@TestInstance(Lifecycle.PER_METHOD)` — a new test instance per method. `@BeforeAll` runs before any instance exists, so it must be **static**.

Fix options:
1. Make `@BeforeAll` method `static`.
2. Or annotate class with `@TestInstance(Lifecycle.PER_CLASS)` to share one instance (use carefully with mutable state).

</details>

<details class="qa-item">
<summary>Q17. @TestInstance(PER_CLASS) — when is it worth the risk?</summary>

Use when:
- `@BeforeAll` needs expensive one-time setup (large fixture load, single embedded server for **component** tests).
- All tests are read-only against shared immutable data.

Avoid when:
- Tests mutate shared fields.
- Parallel test execution is enabled.
- Mockito `@Mock` fields could retain invocation history between methods unless reset.

For pure unit tests, default `PER_METHOD` is almost always correct.

</details>

<details class="qa-item">
<summary>Q5. assertThrows vs assertThatThrownBy — which to use?</summary>

Both work. Prefer **AssertJ** for chained message/cause checks:

```java
assertThatThrownBy(() -> parser.parse("{"))
    .isInstanceOf(JsonParseException.class)
    .hasMessageContaining("Unexpected end-of-input")
    .hasNoCause();
```

JUnit `assertThrows` returns the exception if you need to inspect further:

```java
var ex = assertThrows(ValidationException.class, () -> validator.validate(dto));
assertThat(ex.getViolations()).hasSize(2);
```

</details>

<details class="qa-item">
<summary>Q6. Can I use @ParameterizedTest with @Nested?</summary>

Yes. Parameterized tests work inside `@Nested` classes. Each nested class can have its own `@BeforeEach` stubbing plus shared parameter sources from the outer class (if `static` method source) or inner class.

Keep parameter sources **static** when defined in the test class — Jupiter requirement for `@MethodSource` on static methods, or use `@MethodSource("factory")` with instance method if using `@TestInstance(PER_CLASS)`.

</details>

<details class="qa-item">
<summary>Q7. What is strict stubbing in Mockito 2+?</summary>

By default, **unused stubs fail the test**. This catches tests that stub behavior never exercised — often copy-paste errors or tests that don't assert the right path.

```java
// Fails with UnnecessaryStubbingException if service never calls findById(1L)
when(repo.findById(1L)).thenReturn(Optional.of(user));
service.deleteAll();  // never uses findById
```

Fix: remove unused stub, use `lenient()` for shared `@BeforeEach` setup, or `@MockitoSettings(strictness = Strictness.LENIENT)` on the class (last resort).

</details>

<details class="qa-item">
<summary>Q8. mock() vs @Mock — any difference?</summary>

Functionally equivalent when `@ExtendWith(MockitoExtension.class)` initializes `@Mock` fields before each test.

`@Mock` is cleaner for multiple dependencies. `mock()` useful in local scope or dynamic type:

```java
PaymentGateway gw = mock(PaymentGateway.class, "primaryGateway");
```

</details>

<details class="qa-item">
<summary>Q9. verify vs verifyNoMoreInteractions — when?</summary>

`verify(mock).method()` checks **at least one** call (default times(1) for single verify line).

`verifyNoMoreInteractions(mock)` fails if **any** method was called beyond what you already verified. Useful after testing a "happy path" to ensure no surprise side effects:

```java
verify(gateway).charge(any());
verify(repo).save(any());
verifyNoMoreInteractions(gateway, repo);
```

Do not combine with lenient stubs on same mock without understanding order — can be brittle.

</details>

<details class="qa-item">
<summary>Q10. Can I mock constructors?</summary>

Yes with `mockito-inline`:

```java
try (MockedConstruction<ExpensiveClient> ignored = mockConstruction(ExpensiveClient.class,
        (mock, ctx) -> when(mock.fetch()).thenReturn("cached"))) {
    service.run();
}
```

Use sparingly — usually a design smell (hard to test = hard to use). Prefer dependency injection of a factory interface.

</details>

<details class="qa-item">
<summary>Q11. Why does Mockito fail on Java 21+ with agent warnings?</summary>

Mockito 5 uses the **inline mock maker** which attaches a Java agent for bytecode manipulation. Some JVM configs warn about dynamic agent loading.

Ensure `mockito-core` 5.x and `-javaagent` not duplicated. In Spring Boot 3.2+, test starter handles this. If issues persist, check for conflicting ByteBuddy versions on the classpath.

</details>

<details class="qa-item">
<summary>Q12. How do I test ScheduledExecutorService without waiting?</summary>

Don't use real scheduler in unit tests. Extract task logic to a method and test directly. Verify scheduling with mock:

```java
verify(scheduler).schedule(captor.capture(), eq(5L), eq(TimeUnit.MINUTES));
captor.getValue().run();  // execute task synchronously in test
```

</details>

<details class="qa-item">
<summary>Q13. Should I use parallel test execution in JUnit?</summary>

JUnit 5 can run **test methods** in parallel (`junit.jupiter.execution.parallel.enabled=true`) — different from `parallelStream()` in production code.

Enable only when tests are **fully isolated** (no shared static state, no shared temp files). Mockito mocks are per-test — safe. Shared `@BeforeAll` DB — not safe.

Maven Surefire parallel **classes** is more common than Jupiter method parallel.

</details>

<details class="qa-item">
<summary>Q14. @MockBean vs @Mock in Spring tests?</summary>

`@MockBean` replaces a Spring context bean with a Mockito mock — needed in `@WebMvcTest` / `@SpringBootTest`.

`@Mock` with `@ExtendWith(MockitoExtension.class)` is for **non-Spring** unit tests.

Do not `@MockBean` in pure unit tests — you pay Spring startup cost for no reason.

</details>

<details class="qa-item">
<summary>Q15. Pitest kills CI — how to scope it?</summary>

```xml
<targetClasses>
  <param>com.example.domain.*</param>
</targetClasses>
<excludedTestClasses>
  <param>*IntegrationTest</param>
</excludedTestClasses>
```

Run in dedicated pipeline stage. Do not block PR on full mutation unless team commits to maintaining it.

</details>

<details class="qa-item">
<summary>Q16. How do I quarantine flaky tests without ignoring forever?</summary>

1. `@Tag("flaky")` + exclude from PR pipeline.
2. Open ticket with owner; link test class in issue.
3. Fix or delete within sprint — quarantine is temporary.
4. Never `@Disabled` without issue reference in reason string.

</details>

<details class="qa-item">
<summary>Q18. How many assertions per test?</summary>

No hard limit — but one **behavior** per test. Multiple AssertJ checks on the same returned object are fine:

```java
assertThat(result)
    .isNotNull()
    .extracting(OrderDto::id, OrderDto::status)
    .containsExactly("42", Status.CONFIRMED);
```

Split tests when verifying unrelated behaviors (success path vs audit log vs metrics). Overloaded tests fail for multiple reasons and slow debugging.

</details>

<details class="qa-item">
<summary>Q19. Should unit tests hit the filesystem?</summary>

Yes when **file I/O is the behavior under test** (export writer, parser). Use `@TempDir` — never `/tmp` or project source paths.

No when testing business logic that happens to persist — mock the `FileStorage` port. Integration tests with real S3/minio belong in [microservices/testing.md](../microservices/testing.md).

</details>

<details class="qa-item">
<summary>Q20. assertThat(actual).isEqualTo(expected) vs isSameAs?</summary>

- `isEqualTo` — value equality (`equals()`).
- `isSameAs` — reference identity (`==`).

For records and DTOs, use `isEqualTo`. For Mockito-verified singletons or enum constants, `isSameAs` documents intent.

For collections, prefer `containsExactly` (order) or `containsExactlyInAnyOrder` over `isEqualTo` on lists — failure messages are clearer.

</details>

<details class="qa-item">
<summary>Q21. How do I test private methods?</summary>

**Don't** — test through public API. Private methods are implementation details.

If "untestable" private logic appears:
1. Extract package-private class (same package test).
2. Extract pure function to package-private static utility.
3. Use reflection only as last resort — brittle across refactors.

ArchUnit can enforce "no test imports from main private API hacks."

</details>

<details class="qa-item">
<summary>Q22. Mockito verify in @AfterEach — anti-pattern?</summary>

Usually yes. Verification belongs **in the test** that sets up the scenario. Global `@AfterEach verifyNoMoreInteractions()` causes false failures when `@BeforeEach` stubs trigger incidental calls.

Exception: custom base class for specialized contract-style unit tests where every test must leave no side effects — document heavily.

</details>
