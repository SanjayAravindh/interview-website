# Microservices Testing — Senior Production Reference

JUnit 5 / Spring Boot 3.x / Testcontainers / Pact / k6 / Chaos Mesh. Servlet and reactive stacks are both covered; differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping microservices — flaky pipelines, contracts that lie, Testcontainers that melt CI, and E2E suites that pass while customers fail.

---

## Table of Contents

1. [Mental Model: One Change Through the Test Stack](#1-mental-model-one-change-through-the-test-stack)
2. [Test Pyramid](#2-test-pyramid)
3. [Shift-Left Testing](#3-shift-left-testing)
4. [Unit Testing](#4-unit-testing)
5. [Integration Testing](#5-integration-testing)
6. [Contract Testing](#6-contract-testing)
7. [Consumer-Driven Contract Testing (Pact)](#7-consumer-driven-contract-testing-pact)
8. [End-to-End Testing](#8-end-to-end-testing)
9. [Testcontainers](#9-testcontainers)
10. [Performance Testing](#10-performance-testing)
11. [Load Testing](#11-load-testing)
12. [Resilience Testing](#12-resilience-testing)
13. [Fault Injection](#13-fault-injection)
14. [Chaos Engineering](#14-chaos-engineering)
15. [Mutation Testing](#15-mutation-testing)
16. [Spring Boot 3 Test Infrastructure](#16-spring-boot-3-test-infrastructure)
17. [CI/CD Test Strategy for Microservices](#17-cicd-test-strategy-for-microservices)
18. [Production Debugging Playbook](#18-production-debugging-playbook)
19. [Quick Decision Matrix](#19-quick-decision-matrix)
20. [Interview Q&A](#20-interview-qa)

---

## 1. Mental Model: One Change Through the Test Stack

Testing microservices is not "write JUnit until coverage is green." It is a **layered verification strategy** that answers different questions at different boundaries: does this class compute correctly, does this service boot with real infrastructure, do two teams agree on an API, does the whole checkout path work, and does the system survive when a dependency dies at 2 a.m.

```
Developer commits
  └─ Pre-commit / local
       ├─ Unit tests (ms)              "does this unit behave?"
       ├─ Static analysis / mutation     "did tests actually assert anything?"
       └─ Contract verify (consumer)   "does our client match provider?"
  └─ CI pipeline
       ├─ Integration (@SpringBootTest + Testcontainers)
       ├─ Contract publish / verify (Pact broker)
       ├─ Component / slice tests
       └─ Smoke / selective E2E
  └─ Pre-prod / staging
       ├─ Load / soak tests
       ├─ Chaos / fault injection
       └─ Full E2E against realistic data
  └─ Production
       ├─ Synthetic probes / canaries
       ├─ Observability SLO alerts
       └─ Game days (controlled chaos)
```

Three objects you must keep distinct:

| Object | Question it answers | Typical tool |
|---|---|---|
| **Unit test** | Does this class/method behave correctly in isolation? | JUnit 5 + Mockito |
| **Integration test** | Does this service work with real (or realistic) infrastructure? | `@SpringBootTest`, Testcontainers |
| **Contract test** | Do producer and consumer agree on the API shape and semantics? | Pact, Spring Cloud Contract |

A **green CI** does not mean **safe to deploy**. Unit tests pass while the wrong JSON field is mapped. Integration tests pass while the contract with the payment service drifted. E2E passes while only the happy path was exercised. Mixing those up is the single most common senior misdiagnosis in microservice test strategy.

### The failure modes CI doesn't catch

| Symptom in prod | What passed in CI | What was missing |
|---|---|---|
| 500 on checkout after deploy | All unit tests | Consumer contract not verified against new provider response |
| Intermittent 503 under load | Integration tests (single-threaded) | Load test, bulkhead/circuit breaker validation |
| Data corruption after retry | Happy-path E2E | Idempotency + fault injection test |
| "Works on my machine" | Local `@SpringBootTest` with H2 | Testcontainers with production-like Postgres |
| Slow deploy pipeline | 4000 E2E tests on every PR | Test pyramid inverted — too many slow tests at the top |

### Production scenario: green pipeline, broken deploy

**Problem.** Order service deploys. CI is green. Within 10 minutes, checkout fails with `JsonMappingException: Unrecognized field "totalAmountCents"`. Inventory service renamed a field three weeks ago; order service's Feign client still expects `totalAmount`.

**Cause.** No consumer-driven contract between order (consumer) and inventory (provider). Integration tests mocked inventory with `@MockBean`. E2E ran against staging where both services were deployed together last week — field rename wasn't in that deploy batch.

**Solution.** Pact consumer test defines expected response shape; provider verifies on every build; broker gates deploy if verification fails. See [Consumer-Driven Contract Testing](#7-consumer-driven-contract-testing-pact).

---

## 2. Test Pyramid

### Core concept

The **test pyramid** (Mike Cohn) describes the ideal **ratio and cost** of tests by layer: many fast, cheap unit tests at the base; fewer integration tests in the middle; even fewer slow, brittle E2E tests at the top.

```
                    ┌─────────┐
                    │   E2E   │  few, slow, high confidence of user journeys
                   ┌┴─────────┴┐
                   │ Integration│  some, medium speed, real wiring
                  ┌┴───────────┴┐
                  │    Unit     │  many, fast, isolated logic
                  └─────────────┘
```

In microservices, add **horizontal slices**:

```
Per service pyramid          Cross-service layer
┌─ unit                      ┌─ contract tests (Pact)
├─ integration (Testcontainers) ├─ component tests (WireMock peers)
├─ component (in-process)    └─ selective E2E (critical paths only)
└─ (minimal) E2E smoke
```

### Internal working — why the shape matters

1. **Unit tests** run in milliseconds, no network, no Docker. Feedback loop is instant. They pin business rules, edge cases, and pure functions.
2. **Integration tests** spin up Spring context + real DB/broker via Testcontainers. They catch wiring, SQL, transaction, and serialization bugs unit tests cannot see.
3. **Contract tests** validate API compatibility without running both services. They scale with team count — each pair is tested independently.
4. **E2E tests** exercise real user flows through gateways and multiple services. They are slow, flaky, and expensive to maintain. Use them for **critical revenue paths only**.

An **inverted pyramid** (ice cream cone) — lots of Selenium/Cypress, few unit tests — produces a pipeline that takes 45 minutes, fails randomly on timing, and still misses contract drift.

### Production scenario: 600 E2E tests, 12-minute feedback loop

**Problem.** Platform team runs 600 Playwright tests on every PR. Median pipeline time: 38 minutes. Developers skip CI and push to main. Flaky tests are `@Disabled` instead of fixed. Production incidents increase.

**Cause.** Pyramid inverted. Business logic that belongs in unit tests is covered only by E2E. Every UI change breaks 40 tests. No contract layer — services tested only through the UI.

**Solution — target ratios (guideline, not law):**

| Layer | % of tests (approx) | Max time in CI |
|---|---|---|
| Unit | 70% | < 2 min |
| Integration + contract | 25% | < 8 min |
| E2E (smoke + critical paths) | 5% | < 5 min |

Move order-calculation tests from Playwright to JUnit. Add Pact between services. Keep E2E for "guest checkout with promo code" and "logged-in reorder" — not for every field validation.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| E2E for every API field validation | 30+ min pipelines, flaky CI |
| No unit tests because "we have integration" | Slow feedback, hard to test edge cases |
| Contract tests replaced by E2E | Cross-team API breaks discovered in staging |
| Same test data in unit and E2E without isolation | Phantom failures when order of execution changes |
| Code coverage gate at 90% with no mutation testing | Tests assert nothing meaningful |

### Debugging scenario

**Observe.** Team claims "we have 85% coverage" but regressions ship weekly.

**Diagnose.** Run mutation testing (PIT) on the module with highest coverage. Mutation score is 42%. Tests hit lines but never assert outcomes.

**Fix.** See [Mutation Testing](#15-mutation-testing). Add assertions on return values and side effects, not just "no exception thrown."

---

## 3. Shift-Left Testing

### Core concept

**Shift-left** means moving verification **earlier** in the software lifecycle — from production/staging back to CI, from CI back to local dev, from QA back to developer ownership. In microservices it also means shifting **cross-service verification** left via contracts instead of waiting for integrated staging.

```
Traditional                          Shift-left
─────────────                        ──────────
Dev → QA env → Staging → Prod        Dev (unit+contract) → CI (integration) → Canary → Prod
         ↑ long feedback                    ↑ minutes
```

Shift-left is not "delete QA." It is **automate repeatable checks** at the cheapest layer and reserve human exploration for risk-based scenarios.

### What to shift left in microservices

| Activity | Shift-left implementation |
|---|---|
| API compatibility | Pact consumer tests in consumer repo; provider verify in provider CI |
| Schema migration | Flyway/Liquibase test against Testcontainers Postgres in PR |
| Security | OWASP dependency check + SAST in CI; `@WithMockUser` / JWT tests locally |
| Performance regression | k6 smoke in CI against ephemeral env; full load in staging |
| Resilience | Fault injection in integration tests (WireMock delays, Toxiproxy) |
| Config validation | `@SpringBootTest` with prod-like `application.yml` profile in CI |

### Production scenario: bugs found in staging week before release

**Problem.** Release train freezes staging for two weeks. QA finds 40 bugs. Release slips. Root cause: developers merge to main without running integration tests locally because "CI will catch it" — but CI only runs unit tests on feature branches.

**Solution.**

```yaml
# .github/workflows/pr.yml — shift-left gates
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: ./mvnw test -Punit
  integration:
    runs-on: ubuntu-latest
    services: {}  # Testcontainers on runner
    steps:
      - run: ./mvnw verify -Pintegration
  contract-consumer:
    steps:
      - run: ./mvnw test -Ppact-consumer
      - run: pact-broker publish ...
  mutation:
    if: github.base_ref == 'main'
    steps:
      - run: ./mvnw org.pitest:pitest-maven:mutationCoverage
```

Developers run `./mvnw verify -Pintegration` locally before push (documented in CONTRIBUTING.md). Pre-commit hook runs unit + contract consumer only (fast).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Shift-left = delete staging | Prod-only bugs (multi-region, real traffic patterns) |
| Contract tests only on main branch | PR merges break consumer before provider deploys |
| "Shift-left" without fixing slow tests | Developers still skip local runs |
| Security scanning only at release | CVEs discovered under deadline pressure |
| Feature flags untested until prod | Flag-off path never exercised in CI |

### Debugging scenario

**Observe.** Pact verification fails on provider after consumer merged new interaction.

**Diagnose.** Consumer published to broker from main; provider PR branch doesn't verify against latest consumer until merge. Provider deployed before consumer — prod break.

**Fix.** Provider CI verifies against **all** consumer versions from broker (including pending). Use `can-i-deploy` before any deploy. See [Pact broker workflow](#7-consumer-driven-contract-testing-pact).

---

## 4. Unit Testing

### Core concept

A **unit test** verifies a single unit of behavior — typically one class or one pure function — **in isolation** from I/O, network, databases, and Spring context. Fast, deterministic, no external dependencies.

In Spring Boot 3 microservices, "unit" usually means:

- Domain logic (pricing, eligibility, state machines)
- Mappers (MapStruct), validators, custom serializers
- Pure functions extracted from `@Service` methods
- Security/authorization helpers tested without MVC

It does **not** mean `@SpringBootTest` with `@MockBean` on every dependency — that is a integration/slice test wearing a unit test costume.

### Internal working — JUnit 5 + Mockito on Boot 3

```java
@ExtendWith(MockitoExtension.class)
class OrderPricingServiceTest {

    @Mock InventoryClient inventoryClient;
    @InjectMocks OrderPricingService pricingService;

    @Test
    void appliesVolumeDiscountWhenQuantityExceedsThreshold() {
        when(inventoryClient.getUnitPrice("SKU-1")).thenReturn(new Money(1000, "USD"));

        OrderLine line = new OrderLine("SKU-1", 50);
        Money total = pricingService.calculateLineTotal(line);

        assertThat(total.amountCents()).isEqualTo(45_000); // 10% off 50 × 1000
        verify(inventoryClient).getUnitPrice("SKU-1");
    }

    @Test
    void rejectsNegativeQuantity() {
        assertThatThrownBy(() -> pricingService.calculateLineTotal(new OrderLine("SKU-1", -1)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("quantity");
    }
}
```

Rules that save incidents:

- **One logical assertion per test** (multiple `assertThat` on the same outcome is fine; testing two behaviors in one `@Test` is not).
- **Never mock what you don't own** at unit level — wrap external SDKs behind your interface, mock the interface.
- **Test behavior, not implementation** — `verify` every call is a smell unless interaction order matters.
- **Use `@ParameterizedTest`** for boundary tables (0, 1, threshold-1, threshold, MAX).

### Spring Boot 3 slice tests (still "unit-ish")

For controllers and repositories, use **slices** — partial context, no full boot:

```java
@WebMvcTest(OrderController.class)
@Import(OrderControllerTestConfig.class)
class OrderControllerTest {

    @Autowired MockMvc mvc;
    @MockBean OrderApplicationService orderService;

    @Test
    @WithMockUser(roles = "CUSTOMER")
    void createOrder_returns201() throws Exception {
        when(orderService.create(any())).thenReturn(new OrderResponse("ord-1", CREATED));

        mvc.perform(post("/api/orders")
                .contentType(APPLICATION_JSON)
                .content("""
                    {"items":[{"sku":"SKU-1","qty":2}]}
                    """))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.id").value("ord-1"));

        verify(orderService).create(argThat(req -> req.items().size() == 1));
    }
}
```

`@WebMvcTest` loads MVC + security filters for that controller only. `@DataJpaTest` loads JPA + in-memory or Testcontainers DB slice. `@JsonTest` for Jackson serializers.

### Production scenario: `@MockBean` everywhere, zero confidence

**Problem.** `OrderServiceTest` uses `@SpringBootTest` and `@MockBean` on 12 dependencies. Test takes 4 seconds. Refactoring `OrderRepository` method signature breaks 30 tests because mocks return defaults that don't match new code paths.

**Cause.** Not unit tests — full context integration tests pretending to be unit tests. Mocks hide incorrect assumptions.

**Solution.** Extract pure domain logic to test without Spring:

```java
// Domain — no Spring
class OrderAggregate {
    void addLine(OrderLine line) {
        if (line.quantity() <= 0) throw new IllegalArgumentException("quantity");
        lines.add(line);
    }
    Money total() { return lines.stream().map(OrderLine::subtotal).reduce(Money.ZERO, Money::add); }
}

// Unit test — instant
@Test
void total_sumsLines() {
    OrderAggregate order = new OrderAggregate();
    order.addLine(new OrderLine("A", 2, money(100)));
    order.addLine(new OrderLine("B", 1, money(50)));
    assertThat(order.total()).isEqualTo(money(250));
}
```

Reserve `@SpringBootTest` for wiring verification in integration tests.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@SpringBootTest` for every service test | 30s+ test suite, flaky context loads |
| Mock returns null for unused stub | NPE in code under test, test still passes until that branch hit |
| Testing private methods via reflection | Tests break on refactor without behavior change |
| No tests for MapStruct mappers | Wrong field mapping in prod, `@WebMvcTest` passes with manual DTO |
| `@Disabled("flaky")` accumulating | Broken window — real failures ignored |

### Debugging scenario

**Observe.** Unit test passes locally, fails in CI with `UnnecessaryStubbingException`.

**Diagnose.** Mockito strict stubs (default in Mockito 5 / Spring Boot 3). You stubbed `inventoryClient.getPrice()` but code path uses `getBulkPrice()`.

**Fix.** Remove unused stubs, or use `@MockitoSettings(strictness = Strictness.LENIENT)` only on legacy tests being migrated — not globally.

---

## 5. Integration Testing

### Core concept

An **integration test** verifies that **multiple components work together** — typically your Spring application with real infrastructure (database, message broker, cache) or realistic substitutes (Testcontainers, WireMock for HTTP peers).

Question it answers: "Does this service boot, connect, persist, publish, and serialize correctly in a production-like environment?"

### Internal working — `@SpringBootTest` layers

| Annotation | Context loaded | Use when |
|---|---|---|
| `@SpringBootTest` | Full application | End-to-end in-process, full wiring |
| `@SpringBootTest(webEnvironment = RANDOM_PORT)` | Full + embedded server | REST client tests against real port |
| `@DataJpaTest` | JPA slice | Repository queries, `@Entity` mapping |
| `@JdbcTest` | JDBC slice | `JdbcTemplate`, Flyway scripts |
| `@AutoConfigureMockMvc` | MVC test client | Controller through full filter chain |
| `@Import(TestcontainersConfiguration.class)` | + containers | Real Postgres, Kafka, Redis |

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Testcontainers
@ActiveProfiles("integration-test")
class OrderIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine")
        .withDatabaseName("orders")
        .withInitScript("schema/order-schema.sql");

    @DynamicPropertySource
    static void registerProps(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired TestRestTemplate restTemplate;
    @Autowired OrderRepository orderRepository;

    @Test
    void createOrder_persistsAndReturnsLocation() {
        CreateOrderRequest body = new CreateOrderRequest(List.of(new LineItem("SKU-1", 2)));

        ResponseEntity<OrderResponse> response = restTemplate.postForEntity(
            "/api/orders", body, OrderResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(orderRepository.findById(response.getBody().id())).isPresent();
    }
}
```

### Testing outbound HTTP without the real peer

Use **WireMock** (standalone or `@WireMockTest`) to simulate inventory, payment, etc.:

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
@AutoConfigureWireMock(port = 0)
class OrderWithInventoryIntegrationTest {

    @Autowired TestRestTemplate restTemplate;

    @Test
    void reservesInventory_onCreate() {
        stubFor(post(urlEqualTo("/internal/reserve"))
            .willReturn(aResponse().withStatus(200)
                .withHeader("Content-Type", "application/json")
                .withBody("""
                    {"reservationId":"res-99","status":"HELD"}
                    """)));

        ResponseEntity<OrderResponse> response = restTemplate.postForEntity(
            "/api/orders", validRequest(), OrderResponse.class);

        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        verify(postRequestedFor(urlEqualTo("/internal/reserve"))
            .withRequestBody(matchingJsonPath("$.items[0].sku", equalTo("SKU-1"))));
    }
}
```

WireMock is for **behavior simulation**. Pact is for **contract compatibility**. Use both.

### Production scenario: H2 passes, Postgres fails in prod

**Problem.** `@DataJpaTest` with H2 validates repository tests. Production uses Postgres with JSONB columns, partial indexes, and `SELECT FOR UPDATE SKIP LOCKED`. Deploy breaks on first concurrent checkout.

**Cause.** H2 is not Postgres. Dialect differences, missing features, different locking semantics.

**Solution.** Testcontainers Postgres for any query that uses Postgres-specific SQL:

```java
@DataJpaTest
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
class OrderRepositoryIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", postgres::getJdbcUrl);
        r.add("spring.datasource.username", postgres::getUsername);
        r.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired OrderRepository repo;
    @Autowired TestEntityManager em;

    @Test
    void findAvailableForUpdate_skipLocked() {
        // exercise SKIP LOCKED query — fails on H2
    }
}
```

### Transaction rollback in tests

```java
@SpringBootTest
@Transactional  // rolls back after each test — default for @DataJpaTest
class OrderServiceIntegrationTest {
    // each test gets clean DB state without truncate scripts
}
```

For tests that **must** commit (e.g., testing `@TransactionalEventListener(phase = AFTER_COMMIT)`), use `@Commit` or `@Transactional(propagation = NOT_SUPPORTED)` on that test method.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@MockBean` on repository in `@SpringBootTest` | Integration test proves nothing about SQL |
| Shared static Testcontainer without reuse | CI OOM, port conflicts, 10 min startup per class |
| No `@ActiveProfiles("test")` | Tests hit real config, send real emails |
| `@DirtiesContext` on every test | Context restart — suite takes 20 minutes |
| WireMock stubs too loose (`anyUrl()`) | Test passes when client calls wrong path |

### Debugging scenario

**Observe.** Integration test passes alone, fails when full suite runs.

**Diagnose.** Test pollution — static mutable state, shared Kafka topic, fixed port binding, test order dependency.

**Fix.** `@BeforeEach` cleanup, `@TestMethodOrder` only as last resort, random ports, `@DynamicPropertySource` for container ports, avoid static counters. Run with `-DforkCount=0` locally to reproduce ordering.

---

## 6. Contract Testing

### Core concept

**Contract testing** verifies that a **service interaction** (request/response messages, headers, status codes) matches an agreed specification — without requiring both services to run in the same test environment.

In microservices, the dominant failure mode is **integration drift**: provider changes a field, consumer breaks in production. Contract tests catch this at build time.

Two models:

| Model | Who defines contract | Tooling |
|---|---|---|
| **Provider-driven** | Provider publishes spec; consumers verify | Spring Cloud Contract, OpenAPI + Dredd |
| **Consumer-driven (CDC)** | Consumer defines expectations; provider verifies | Pact |

Both are valid. **Consumer-driven** scales better when many consumers depend on one provider — the provider implements what consumers actually need, not a speculative OpenAPI doc.

### Internal working — contract vs E2E vs integration

```
E2E:     [Consumer] ──HTTP──► [Provider]     both running, full stack
Integration: [Consumer] ──HTTP──► [WireMock stub]  consumer only, stubbed peer
Contract:  pact file / stub ──► verify on both sides   no simultaneous runtime
```

Contract tests are **fast** and **parallelizable** — each team runs verification in their own CI. They do **not** replace integration tests; they replace the need for integrated staging to catch API mismatches.

### Provider-driven with Spring Cloud Contract (brief)

```groovy
// contracts/order/inventory/reserve.groovy
Contract.make {
    description "reserve inventory"
    request {
        method POST()
        url "/internal/reserve"
        body([
            orderId: $(consumer(anyNonBlankString()), producer("ord-1")),
            items: [[sku: "SKU-1", qty: 2]]
        ])
        headers { contentType(applicationJson()) }
    }
    response {
        status 200
        body([
            reservationId: $(consumer(regex("res-[0-9]+")), producer("res-99")),
            status: "HELD"
        ])
        headers { contentType(applicationJson()) }
    }
}
```

Consumer gets generated stubs; provider runs `verify()` against the contract. Good for **provider-owned APIs**. Less ideal when 15 consumers have different expectations — use Pact CDC instead.

### Production scenario: OpenAPI doc lies

**Problem.** Inventory team maintains `openapi.yaml`. Order team generates Feign client from it. Provider renames `totalAmount` → `totalAmountCents` without updating the doc. Staging E2E didn't run because inventory deploy was delayed.

**Cause.** OpenAPI is documentation, not an executable contract unless verified on every build.

**Solution.** Either:
1. Generate OpenAPI from code + breaking-change detection (openapi-diff in CI), or
2. Pact CDC where consumer defines required fields, provider verify fails on rename.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Contract tests only on provider side | Consumer-specific needs ignored |
| Contracts test URL paths only, not body schema | Field type change slips through |
| No broker / artifact storage | Consumer and provider CI use stale pact files |
| Contract replaced all integration tests | Logic bugs in provider still ship |
| Shared "staging" as only contract enforcement | Weekly integration pain, release train delays |

### Debugging scenario

**Observe.** Pact verification passes but production 500 on deserialization.

**Diagnose.** Contract allowed optional field; consumer sends it; provider's validation rejects unknown enum value not covered in pact example.

**Fix.** Use Pact matching rules (`like`, `eachLike`, regex) for types; add **provider states** that seed enum values; add integration test for edge enum values.

---

## 7. Consumer-Driven Contract Testing (Pact)

### Core concept

**Consumer-driven contract (CDC)** testing with **Pact**: the **consumer** writes a test that defines expected interactions. Pact generates a **pact file**. The **provider** runs verification against that pact — if the provider's actual responses don't match, the build fails.

Flow:

```
Consumer repo                         Pact Broker                    Provider repo
─────────────                         ───────────                    ─────────────
@PactTestFor ──► pact.json ──publish──► [store] ◄──fetch pact── verify @ProviderTest
                                              │
                                         can-i-deploy?
                                              │
                                         deploy gate
```

### Consumer test — Spring Boot 3 + Pact JVM 4.x

**Dependencies (`pom.xml`):**

```xml
<dependency>
    <groupId>au.com.dius.pact.consumer</groupId>
    <artifactId>junit5</artifactId>
    <version>4.6.14</version>
    <scope>test</scope>
</dependency>
```

**Consumer side:**

```java
@ExtendWith(PactConsumerTestExt.class)
@PactTestFor(providerName = "inventory-service", port = "8089")
class InventoryClientContractTest {

    @Autowired
    InventoryClient inventoryClient;  // Feign or RestClient

    @Pact(consumer = "order-service")
    public RequestResponsePact reserveInventory(PactDslWithProvider builder) {
        return builder
            .given("SKU-1 is in stock")
            .uponReceiving("a reservation request for SKU-1")
                .path("/internal/reserve")
                .method("POST")
                .headers("Content-Type", "application/json")
                .body(new PactDslJsonBody()
                    .stringType("orderId", "ord-123")
                    .minArrayLike("items", 1)
                        .stringType("sku", "SKU-1")
                        .integerType("qty", 2)
                    .closeObject()
                    .closeArray())
            .willRespondWith()
                .status(200)
                .headers(Map.of("Content-Type", "application/json"))
                .body(new PactDslJsonBody()
                    .stringType("reservationId", "res-456")
                    .stringValue("status", "HELD"))
            .toPact();
    }

    @Test
    @PactTestFor(pactMethod = "reserveInventory")
    void reserve_returnsHeldStatus() {
        ReservationResponse res = inventoryClient.reserve(
            new ReserveRequest("ord-123", List.of(new Item("SKU-1", 2))));

        assertThat(res.status()).isEqualTo("HELD");
        assertThat(res.reservationId()).isNotBlank();
    }
}
```

Publish to broker in CI:

```bash
pact-broker publish target/pacts \
  --consumer-app-version=$GIT_SHA \
  --broker-base-url=$PACT_BROKER_URL \
  --broker-token=$PACT_BROKER_TOKEN
```

### Provider verification — Spring Boot 3

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
    properties = "server.port=8080")
@Provider("inventory-service")
@PactBroker(url = "${pact.broker.url}", authentication = @PactBrokerAuth(token = "${pact.broker.token}"))
class InventoryProviderPactTest {

    @LocalServerPort int port;

    @BeforeEach
    void setUp(PactVerificationContext context) {
        context.setTarget(new HttpTestTarget("localhost", port));
    }

    @State("SKU-1 is in stock")
    void skuInStock() {
        inventorySeedService.seed("SKU-1", 100);
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verifyPact(PactVerificationContext context) {
        context.verifyInteraction();
    }
}
```

Provider CI fetches **all** consumer pacts from broker and verifies each interaction.

### can-i-deploy gate

Before deploying either service:

```bash
pact-broker can-i-deploy \
  --pacticipant order-service \
  --version $GIT_SHA \
  --to-environment production

pact-broker can-i-deploy \
  --pacticipant inventory-service \
  --version $GIT_SHA \
  --to-environment production
```

Both must pass — consumer version and provider version are compatible with what's already in production.

### Message contracts (Kafka / RabbitMQ)

Async microservices need **message pacts**:

```java
@Pact(consumer = "notification-service")
public MessagePact orderCreatedMessage(MessagePactBuilder builder) {
    return builder
        .given("order ord-1 exists")
        .expectsToReceive("order created event")
        .withContent(new PactDslJsonBody()
            .stringType("orderId", "ord-1")
            .stringValue("eventType", "ORDER_CREATED")
            .datetime("createdAt", "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"))
        .toPact();
}
```

Provider verifies by invoking the message handler with the pact payload.

### Production scenario: provider "fixed" pact by weakening matcher

**Problem.** Provider verification failed after removing `reservationId`. Developer changed pact matcher from `stringType` to `nullValue()` "temporarily." CI green. Production consumers NPE.

**Cause.** Treating pact as obstacle instead of API specification. Broker webhook didn't block merge.

**Solution.** Branch protection: provider verify required check. Code review rule: never weaken pact without consumer team approval. Use `pending pacts` workflow — new consumer interactions don't break provider until explicitly accepted.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Pact tests hit real provider URL | Not a contract test — flaky network dependency |
| Provider states not implemented | Verification passes with empty DB, prod fails |
| Hard-coded port conflicts in CI | Random port in `@PactTestFor`, dynamic target on provider |
| No can-i-deploy | Compatible pairs deploy in wrong order |
| Pact file committed but never published | Stale contracts, drift undetected |
| v3 pact format mismatch | Consumer on JVM 4, provider on old plugin — verify fails cryptically |

### Debugging scenario

**Observe.** `Request mismatch: Expected header Content-Type to match 'application/json'`.

**Diagnose.** Consumer sends `application/json;charset=UTF-8`; pact expects exact match.

**Fix.** Use header matcher: `.matchHeader("Content-Type", "application/json.*", "application/json")`.

---

## 8. End-to-End Testing

### Core concept

**End-to-end (E2E) testing** validates **complete user journeys** through the deployed system — UI, API gateway, multiple microservices, databases, message buses — as a customer or client would experience them.

Question it answers: "Can a real user complete checkout / signup / refund?"

E2E is the **top of the pyramid** — highest confidence for paths covered, highest cost and flakiness.

### Internal working — E2E architecture for microservices

```
┌─────────────┐     ┌─────────┐     ┌──────────────────────────────────┐
│ Playwright  │────►│ Gateway │────►│ order → inventory → payment      │
│ or REST     │     │         │     │         ↓                        │
│ client      │     └─────────┘     │      Kafka → notification      │
└─────────────┘                     └──────────────────────────────────┘
         │
    assertions on UI or API response + optional DB/Kafka peek (careful)
```

**API-level E2E** (no browser) is often sufficient for backend microservice platforms:

```java
@SpringBootTest(webEnvironment = NONE)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class CheckoutE2ETest {

    @Autowired CheckoutApiClient checkoutClient;  // hits deployed staging URL
    @Autowired TestDataCleaner cleaner;

    @BeforeEach
    void setup() { cleaner.resetCustomer("e2e-user@example.com"); }

    @Test
    void guestCheckout_withValidCard_completes() {
        CheckoutResult result = checkoutClient.completeGuestCheckout(
            GuestCheckoutScenario.builder()
                .sku("E2E-SKU-1")
                .paymentMethod(TestCards.VISA_SUCCESS)
                .build());

        assertThat(result.status()).isEqualTo(COMPLETED);
        assertThat(result.orderId()).matches("ord-[a-f0-9-]+");
    }
}
```

**Browser E2E** (Playwright/Cypress) for UI-critical flows only.

### Test data strategy

| Approach | Pros | Cons |
|---|---|---|
| Dedicated E2E tenant / namespace | Isolation | Cost, drift from prod config |
| Synthetic data API (seed endpoint) | Repeatable | Must not exist in prod |
| Clone prod subset | Realistic | PII, expensive |
| `@Transactional` rollback | Clean | Doesn't work across services |

Microservices E2E **cannot** roll back a single DB transaction across order + payment + inventory. Use **compensating cleanup** or isolated E2E environment reset nightly.

### Production scenario: E2E passes, mobile app fails

**Problem.** E2E tests hit `/api/v2/orders` through the web gateway. Mobile app uses `/mobile/v1/orders` on a different BFF with different DTO mapping. Mobile release breaks.

**Cause.** E2E coverage mapped to one entry point only.

**Solution.** Contract tests per client surface (web BFF, mobile BFF). E2E smoke per **client channel** for one critical path each — not duplicate all tests.

### Flakiness controls

```java
@RetryingTest(maxAttempts = 3, minSuccess = 1, suspendForMs = 2000)
void asyncNotification_arrivesWithinTimeout() {
    // order placed ...
    await().atMost(Duration.ofSeconds(15))
        .pollInterval(Duration.ofMillis(500))
        .until(() -> notificationClient.findByOrderId(orderId).isPresent());
}
```

Use Awaitility for async; avoid `Thread.sleep(5000)`. Fix root cause — don't `@Disabled` after three retries.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| E2E in PR pipeline for every commit | 40 min feedback, devs bypass CI |
| Shared staging with manual QA | E2E fails when QA changes data |
| Assert on exact timestamps / UUIDs | Flaky without semantic matchers |
| No idempotency keys in E2E setup | Duplicate orders on retry |
| E2E tests prod | Customer data corruption, PCI violation |

### Debugging scenario

**Observe.** E2E fails at 3 a.m. only.

**Diagnose.** Cron job in staging deletes test users. Batch job locks inventory table.

**Fix.** Dedicated E2E schedule window, `@Tag("e2e")` run on deploy not cron, isolate E2E SKUs from batch processing.

---

## 9. Testcontainers

### Core concept

**Testcontainers** spins up **real** Docker containers (Postgres, Kafka, Redis, LocalStack, etc.) during tests. Your integration tests talk to actual software — not H2, not embedded Kafka that behaves differently.

Spring Boot 3.1+ has first-class support via `@ServiceConnection` and `@DynamicPropertySource`.

### Internal working — lifecycle and reuse

```
JUnit test class
  └─ @Container static PostgreSQLContainer
       ├─ start (once per class if static, or per method if instance)
       ├─ expose random host:port
       ├─ @DynamicPropertySource → spring.datasource.url
       └─ stop (Ryuk container cleans up on JVM exit)
```

**Reuse modes (CI optimization):**

```java
@Container
static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine")
    .withReuse(true);  // requires testcontainers.reuse.enable=true in ~/.testcontainers.properties
```

Spring Boot 3.1 `@ServiceConnection`:

```java
@SpringBootTest
@Testcontainers
class OrderKafkaIntegrationTest {

    @Container
    @ServiceConnection
    static KafkaContainer kafka = new KafkaContainer(DockerImageName.parse("confluentinc/cp-kafka:7.6.0"));

    @Autowired OrderEventListener listener;

    @Test
    void publishesOrderCreated_onSave() {
        orderService.create(validOrder());
        await().atMost(5, SECONDS).until(() -> listener.receivedEvents().size() == 1);
    }
}
```

Boot auto-wires `spring.kafka.bootstrap-servers` from the running container — no manual `@DynamicPropertySource`.

### Multi-container compose pattern

```java
@Testcontainers
public abstract class IntegrationTestBase {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    static GenericContainer<?> redis = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    @Container
    static KafkaContainer kafka = new KafkaContainer(DockerImageName.parse("confluentinc/cp-kafka:7.6.0"));

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", postgres::getJdbcUrl);
        r.add("spring.data.redis.host", redis::getHost);
        r.add("spring.data.redis.port", () -> redis.getMappedPort(6379).toString());
    }
}
```

Extend one base class — avoid starting 4 containers per test class.

### Testcontainers Cloud / Ryuk in CI

GitHub Actions example:

```yaml
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
      - name: Integration tests
        run: ./mvnw verify -Pintegration
        env:
          TESTCONTAINERS_RYUK_DISABLED: false
          DOCKER_HOST: unix:///var/run/docker.sock
```

Use **container reuse** in CI with a persistent Docker layer cache. Parallel jobs need sufficient RAM — Postgres + Kafka + app ≈ 2–4 GB per fork.

### Production scenario: CI OOM and 25-minute suites

**Problem.** 40 test classes each start Postgres + Kafka. CI runners OOM. Suite time 25 minutes.

**Cause.** Instance `@Container` (per method restart), no reuse, `@SpringBootTest` on every class without `@Import` slicing.

**Solution.**

1. Static `@Container` shared via abstract base class.
2. `@Testcontainers(disabledWithoutDocker = true)` for developers without Docker.
3. `@SpringBootTest` once; other classes use `@Import` of tested beans + `@MockBean` for unrelated deps — or `@JdbcTest` / slice.
4. Enable reuse in CI with cached Docker volumes.
5. Split `-Pintegration` to run on main and nightly, smoke subset on PR.

### LocalStack for AWS

```java
@Container
@ServiceConnection
static LocalStackContainer localStack = new LocalStackContainer(DockerImageName.parse("localstack/localstack:3.0"))
    .withServices(S3, SQS, DYNAMODB);
```

Verify S3 upload, SQS listener, DynamoDB repository against LocalStack — catches SDK config errors before deploy.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Fixed port `5432:5432` | Parallel test workers collide |
| No `waitStrategy` on slow images | Tests start before DB ready — flaky |
| Ryuk blocked in corporate K8s CI | Containers leak, disk full |
| Same image tag `postgres:latest` | Non-reproducible failures after image update |
| Testcontainers in unit test profile | Developers without Docker can't compile |

### Debugging scenario

**Observe.** `Could not find a valid Docker environment`.

**Diagnose.** Docker not running locally; CI uses DinD without privileged mode; Windows WSL2 Docker socket not exposed to JVM.

**Fix.** Testcontainers Desktop, `DOCKER_HOST` in CI, `disabledWithoutDocker = true` for local unit-only runs.

---

## 10. Performance Testing

### Core concept

**Performance testing** measures how a system behaves under expected load — latency percentiles, throughput, resource utilization, and degradation points — against **defined SLOs**. It answers: "Will this architecture meet our p99 < 200ms target at peak traffic?"

Distinct from **load testing** (see next section): performance testing often focuses on **baseline profiling** and **regression detection**; load testing pushes toward **breaking point**.

### Internal working — what to measure

| Metric | Definition | Typical SLO |
|---|---|---|
| **Latency p50/p95/p99** | Response time distribution | p99 < 500ms checkout |
| **Throughput** | Requests/sec sustained | 2k RPS per pod |
| **Error rate** | 5xx + timeouts / total | < 0.1% |
| **Saturation** | CPU, heap, pool wait, GC pause | CPU < 70%, pool pending = 0 |
| **Cold start** | First request after scale-from-zero | < 3s |

Tools:

- **k6** — scriptable, CI-friendly, Grafana integration
- **Gatling** — Scala/Java DSL, good reports
- **JMeter** — GUI-heavy, legacy but common
- **Micrometer + Prometheus** — in-test observability

### k6 smoke in CI (Spring Boot 3 staging)

```javascript
// perf/checkout-smoke.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 10,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(99)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE = __ENV.STAGING_URL || 'https://staging.example.com';

export default function () {
  const res = http.post(`${BASE}/api/orders`, JSON.stringify({
    items: [{ sku: 'PERF-SKU-1', qty: 1 }],
  }), { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${__ENV.TOKEN}` } });

  check(res, { 'status 201': (r) => r.status === 201 });
  sleep(0.5);
}
```

Run on deploy to staging — fail pipeline if thresholds breach.

### JVM profiling during performance tests

```yaml
# docker-compose perf run
environment:
  JAVA_TOOL_OPTIONS: >-
    -XX:+FlightRecorder
    -XX:StartFlightRecording=duration=120s,filename=checkout.jfr
    -Dspring.jmx.enabled=true
```

Analyze JFR for lock contention, GC, JDBC wait — correlate with k6 latency spikes.

### Production scenario: "fast in test, slow in prod"

**Problem.** Integration tests show 50ms p99. Production p99 is 2.1s after Black Friday traffic pattern.

**Cause.** Tests used single-threaded `@SpringBootTest`, H2 or local Postgres on SSD, no gateway, no auth introspection, no cross-AZ latency, connection pool size 5 (never contended).

**Solution.** Performance test against **staging that mirrors prod topology** — same pool sizes, replica lag simulated, JWT validation enabled, realistic payload sizes. Use production traffic **shadow/replay** (sanitized) for request mix.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Performance test on laptop only | Wrong conclusions about heap and GC |
| Assert mean latency only | p99 hides tail disasters |
| No warm-up phase | Cold JIT skews first minute |
| Test data fits in DB cache | Unrealistic query performance |
| Ignore downstream mocks | Payment mock responds in 1ms; prod is 400ms |

### Debugging scenario

**Observe.** p99 latency doubled after Spring Boot 3 upgrade; CPU unchanged.

**Diagnose.** Enable Micrometer `@Timed` on repository layer. JDBC span shows wait time up — Hikari pool exhausted. Boot 3 default virtual threads changed thread model; blocking calls pile up differently.

**Fix.** Right-size pool, add bulkhead, re-run k6 with same concurrency as prod peak.

---

## 11. Load Testing

### Core concept

**Load testing** applies **sustained or ramping traffic** to find **capacity limits**, ** bottlenecks**, and **failure modes** under stress — not just whether SLOs pass at normal load.

Questions it answers:

- At what RPS does error rate exceed 1%?
- What breaks first — DB connections, thread pool, Kafka lag, payment provider 429?
- Does autoscaling keep up? Is there a metastable failure after load drops?

### Load test types

| Type | Pattern | Purpose |
|---|---|---|
| **Smoke load** | 10 VUs, 2 min | Sanity after deploy |
| **Load** | Expected peak × 1.2, 30 min | Validate SLO under normal peak |
| **Stress** | Ramp until failure | Find breaking point |
| **Soak / endurance** | 70% peak, 4–24 h | Memory leaks, connection drift |
| **Spike** | 0 → 10× in 30s | Autoscale, circuit breaker behavior |

### k6 stress example

```javascript
export const options = {
  stages: [
    { duration: '5m', target: 100 },
    { duration: '10m', target: 500 },
    { duration: '5m', target: 1000 },
    { duration: '10m', target: 1000 },
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],  // allow higher during stress — document why
  },
};
```

### Load testing microservices safely

1. **Never default to prod** — use isolated load env or dedicated tenant.
2. **Coordinate with vendors** — payment, SMS, email mocks or sandbox keys with rate limits.
3. **Seed realistic data volume** — 10M orders in DB, not 100 rows.
4. **Watch the whole graph** — not just the service under test:

```
k6 → gateway → order → [inventory, payment, Kafka] → notification
                      ↓
                 Postgres, Redis, broker lag
```

5. **Inject idempotency keys** — load test must not create unbounded duplicate charges.

### Production scenario: load test took down staging and blocked releases

**Problem.** Team ran 5k VUs against staging shared with QA. QA blocked; Kafka disk filled; staging unusable for a week.

**Cause.** Shared environment, no resource quotas, load test used real notification webhooks flooding Slack.

**Solution.** Dedicated `load.example.com` namespace, rate-limited sandboxes, feature flags to disable outbound webhooks, Kafka retention tuned for load namespace, schedule load tests off-hours with announcement.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Load test without monitoring | "System slow" with no bottleneck identified |
| Same credentials for all VUs | Auth rate limit fails test, not app |
| Unbounded POST creates prod-like PII | Compliance incident |
| Ignore GC during soak | OOM kill after 6 hours unnoticed |
| Retry storm in load script | Artificially multiplies traffic 3× |

### Debugging scenario

**Observe.** Load test shows 503 at 800 RPS; single-pod manual curl is fine.

**Diagnose.** HPA added pods after latency rose; new pods passed readiness but JVM warm-up + DB connection stampede on cold pods.

**Fix.** Pre-warm endpoints in readiness probe, pool sizing per pod, load test ramp slower, use `minReplicas` during test.

---

## 12. Resilience Testing

### Core concept

**Resilience testing** verifies that **failure handling works as designed** — circuit breakers open, retries stop, fallbacks return degraded data, timeouts fire, bulkheads isolate blast radius. It answers: "When inventory is down, does checkout fail gracefully or hang forever?"

This is **not** full chaos engineering (random prod faults) — it is **controlled, repeatable** failure scenarios in test environments.

### Internal working — resilience test layers

```
Layer 1: Unit — mock dependency throws → assert fallback return value
Layer 2: Integration — WireMock 503/slow → assert circuit OPEN, 503 to client
Layer 3: Component — Toxiproxy latency between Testcontainers services
Layer 4: Staging chaos — Litmus/Chaos Mesh pod kill during load test
```

### Integration test — circuit breaker opens

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
@AutoConfigureWireMock(port = 0)
class OrderResilienceIntegrationTest {

    @Autowired TestRestTemplate restTemplate;
    @Autowired CircuitBreakerRegistry registry;

    @Test
    void inventoryDown_returns503WithRetryAfter() {
        stubFor(post(urlEqualTo("/internal/reserve"))
            .willReturn(aResponse().withStatus(503).withFixedDelay(5000)));

        CircuitBreaker cb = registry.circuitBreaker("inventory");

        for (int i = 0; i < 20; i++) {
            restTemplate.postForEntity("/api/orders", validBody(), Void.class);
        }

        assertThat(cb.getState()).isEqualTo(CircuitBreaker.State.OPEN);

        ResponseEntity<String> response = restTemplate.postForEntity(
            "/api/orders", validBody(), String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(response.getHeaders().getFirst("Retry-After")).isNotNull();
    }
}
```

### Toxiproxy between Testcontainers

```java
@Container
static Network network = Network.newNetwork();

@Container
static ToxiproxyContainer toxiproxy = new ToxiproxyContainer("ghcr.io/shopify/toxiproxy:2.9.0")
    .withNetwork(network);

@Container
static GenericContainer<?> inventory = new GenericContainer<>("inventory-service:test")
    .withNetwork(network)
    .withNetworkAliases("inventory");

@Test
void timeout_tripsCircuitWhenLatencyExceedsThreshold() throws IOException {
    ToxiproxyClient client = new ToxiproxyClient(toxiproxy.getHost(), toxiproxy.getControlPort());
    Proxy proxy = client.createProxy("inventory", "0.0.0.0:8666", "inventory:8080");
    proxy.toxics().latency("latency", ToxicDirection.UPSTREAM, 3000);

    // point order-service config at toxiproxy:8666 for this test
    // assert TimeLimiter / circuit behavior
}
```

### Production scenario: fallback called DB and made outage worse

**Problem.** Resilience test never run. Circuit opened on search service. Fallback method queried analytics DB for "cached" recommendations. Analytics DB melted. Whole site down.

**Cause.** Fallback path untested; shared dependency in fallback.

**Solution.** Resilience test checklist per outbound call: fallback must be O(1), no call to failing dep, no unbounded cache miss storm. Automate WireMock failure suite in CI.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Mock dependency always returns 200 in tests | Breaker never tested |
| Retry enabled in test, disabled in prod | Prod behavior unknown |
| Test only `CallNotPermittedException` | Missing fallback content validation |
| Ignore half-open probe behavior | Flapping breaker in prod |
| Resilience4j config different in test profile | Tests lie |

### Debugging scenario

**Observe.** Resilience test flaky — sometimes OPEN, sometimes not.

**Diagnose.** Sliding window `minimumNumberOfCalls` not reached in short loop; parallel tests share same Resilience4j registry bean name.

**Fix.** `@DirtiesContext` only for resilience tests, or `@Autowired` fresh registry with unique instance id in test config; loop until `minimumNumberOfCalls` met.

---

## 13. Fault Injection

### Core concept

**Fault injection** deliberately introduces **specific faults** — latency, errors, dropped packets, disk full, clock skew, partition — to observe system behavior. Narrower than chaos engineering: **one fault at a time**, hypothesis-driven, often in test/staging.

| Fault type | Injection mechanism | What it validates |
|---|---|---|
| HTTP 500/503 | WireMock, fault filter in mesh | Retry, breaker, fallback |
| Latency | Toxiproxy, `@Delay` filter | Timeout, bulkhead |
| Network partition | iptables, Chaos Mesh `NetworkChaos` | Split-brain, Kafka ISR |
| Pod kill | `kubectl delete pod`, Litmus | K8s restart, in-flight request loss |
| CPU stress | `stress-ng`, Chaos Mesh | HPA, latency under contention |
| DB connection drop | Proxy terminate, `pg_terminate_backend` | Pool recovery, transaction rollback |

### Spring Boot 3 fault injection for local dev (test profile only)

```java
@Configuration
@Profile("fault-injection")
public class FaultInjectionConfig {

    @Bean
    FilterRegistrationBean<FaultInjectionFilter> faultFilter() {
        var bean = new FilterRegistrationBean<>(new FaultInjectionFilter(
            Map.of("/internal/.*", Fault.latency(Duration.ofSeconds(2)))));
        bean.setOrder(Ordered.HIGHEST_PRECEDENCE);
        return bean;
    }
}
```

**Never enable in production.** Use mesh/gateway fault rules in non-prod only with blast radius controls.

### Idempotency under fault injection

```java
@Test
void duplicateSubmit_withSameIdempotencyKey_chargesOnce() {
    wireMock.stubFor(post("/charge").willReturn(aResponse().withStatus(504))); // timeout

    String key = UUID.randomUUID().toString();
    assertThatThrownBy(() -> paymentClient.charge(request, key))
        .isInstanceOf(PaymentTimeoutException.class);

    wireMock.stubFor(post("/charge").willReturn(okJson("{\"status\":\"captured\"}")));

    PaymentResult result = paymentClient.charge(request, key);
    assertThat(result.status()).isEqualTo(CAPTURED);
    verify(1, postRequestedFor(urlEqualTo("/charge"))); // retry deduped or single charge
}
```

### Production scenario: fault injection in prod "by accident"

**Problem.** Engineer left Istio fault delay rule at 100% in prod namespace after debugging. Checkout p99 30s for 2 hours.

**Cause.** GitOps drift; fault rule not namespaced to staging; no alert on synthetic latency.

**Solution.** Policy: fault rules only in `staging-*` namespaces; OPA/Gatekeeper deny `VirtualService` fault in prod; synthetic probe alert on p99; code review for mesh configs.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Multiple simultaneous faults | Can't attribute failure mode |
| Fault injection without metrics | "Something broke" with no timeline |
| Inject on shared DB | All teams' staging down |
| No rollback plan for mesh rules | Extended outage |
| Fault on health check endpoint | K8s kill loop |

### Debugging scenario

**Observe.** After fault test, staging still returns 503.

**Diagnose.** Circuit breaker still OPEN; half-open probes not run; WireMock stub still active.

**Fix.** `@AfterEach` reset WireMock and `registry.getAllCircuitBreakers().forEach(CircuitBreaker::reset)`; document reset in test base class.

---

## 14. Chaos Engineering

### Core concept

**Chaos engineering** is the **disciplined practice** of experimenting on a system to build confidence in its capability to withstand turbulent conditions in production. Unlike ad-hoc fault injection, it follows a **scientic method**:

1. Define **steady-state** (metrics that mean "healthy")
2. Form **hypothesis** ("if we kill one order pod, p99 stays < 500ms and error rate < 0.1%")
3. Introduce **real-world events** (pod kill, AZ failure, broker partition)
4. **Observe** dashboards; abort if blast radius exceeds guardrails
5. **Learn** and harden (fix bugs, tune limits, improve runbooks)

**Game days** are scheduled chaos exercises with cross-team participation.

### Chaos tools in Kubernetes

| Tool | Model | Best for |
|---|---|---|
| **Litmus Chaos** | CRD experiments | K8s-native, open source |
| **Chaos Mesh** | CRD + workflow | Complex multi-step, JVMChaos |
| **Gremlin** | SaaS agent | Enterprise, approvals workflow |
| **AWS FIS / Azure Chaos Studio** | Cloud-level | Region/AZ failure simulation |

Example Litmus pod delete:

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: order-pod-chaos
  namespace: staging
spec:
  appinfo:
    appns: staging
    applabel: app=order-service
    appkind: deployment
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: "60"
            - name: CHAOS_INTERVAL
              value: "15"
            - name: FORCE
              value: "false"
```

Run during business hours in **staging** first; production chaos requires executive approval, error budget headroom, and automated rollback.

### Steady-state hypothesis template

```
Experiment: Kill 1 of 3 inventory pods every 2 minutes for 10 minutes
Steady state:
  - checkout success rate >= 99.5%
  - inventory reserve p99 < 300ms
  - no Kafka consumer lag > 1000 on order-events
Abort if:
  - checkout success < 98% for 2 min
  - payment circuit OPEN > 5 min
  - manual abort from incident commander
```

### Production scenario: chaos in prod without guardrails

**Problem.** "Netflix does chaos so we should too." Junior engineer runs pod chaos in prod during peak. Payment duplicate charges from in-flight retries without idempotency.

**Cause.** No hypothesis, no abort criteria, no idempotency verification, no game day culture.

**Solution.** Start with **staging game days** quarterly. Fix findings. Add **canary chaos** in prod (1% traffic namespace) only after automated resilience tests pass. Require idempotency keys on all POST mutations before prod chaos approval.

### Chaos vs resilience testing

| Aspect | Resilience testing | Chaos engineering |
|---|---|---|
| Environment | CI, staging | Staging → prod (controlled) |
| Faults | Deterministic, scripted | Often random or realistic |
| Goal | Verify known code paths | Discover unknown weaknesses |
| Frequency | Every build | Scheduled / continuous (small blast) |
| Ownership | Dev team | Platform + SRE + product |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Chaos without observability | Can't tell if experiment failed or succeeded |
| Same blast radius prod and staging | Customer impact |
| No communication plan | Support flooded during game day |
| Chaos only on stateless pods | Never test DB failover |
| Stop after first experiment | False confidence |

### Debugging scenario

**Observe.** Chaos experiment "succeeded" but steady-state metrics looked fine — customers complained.

**Diagnose.** Metrics averaged over 5 minutes masked 30s total outage; synthetic probes too coarse; real users hit AZ that was faulted.

**Fix.** Per-AZ metrics, client-side RUM, lower abort threshold, segment chaos by AZ explicitly.

---

## 15. Mutation Testing

### Core concept

**Mutation testing** evaluates **test quality** by introducing small code mutations (change `>` to `>=`, remove negation, return null instead of value) and checking if tests **fail**. If tests still pass after mutation, the mutant **survived** — your tests don't detect that bug.

**Mutation score** = killed mutants / total mutants. High line coverage with low mutation score means **weak assertions**.

### Internal working — PIT (PITest) with Maven

```xml
<plugin>
    <groupId>org.pitest</groupId>
    <artifactId>pitest-maven</artifactId>
    <version>1.15.8</version>
    <configuration>
        <targetClasses>
            <param>com.example.order.domain.*</param>
        </targetClasses>
        <targetTests>
            <param>com.example.order.*Test</param>
        </targetTests>
        <mutators>
            <mutator>STRONGER</mutator>
        </mutators>
        <threshold>80</threshold>
        <timestampedReports>false</timestampedReports>
    </configuration>
</plugin>
```

Run:

```bash
./mvnw org.pitest:pitest-maven:mutationCoverage
```

Report shows survived mutants:

```
OrderPricingService.java:42
  replaced return value with null → SURVIVED
  changed conditional boundary → KILLED
```

Fix test:

```java
@Test
void calculateLineTotal_returnsNonNull() {
    Money total = pricingService.calculateLineTotal(validLine());
    assertThat(total).isNotNull();
    assertThat(total.amountCents()).isPositive();
}
```

### What mutation testing is good for

- Domain logic with branching (pricing, tax, discounts)
- Permission checks (`if (user.canEdit())`)
- State machines (order status transitions)
- Custom validators and serializers

### What to exclude

- Generated code (MapStruct impls, Lombok builders)
- DTOs with no logic
- Configuration classes
- Integration-heavy code (mutation on `@RestController` is slow and low signal)

### Production scenario: 92% coverage, tax bug in prod

**Problem.** VAT calculation wrong for EU B2B reverse charge. Unit tests "covered" the method but only asserted method completed without exception.

**Cause.** No assertion on computed tax amount; mutation score for `TaxCalculator` was 35%.

**Solution.** Add parameterized tests with golden cases; run PIT on `domain` package in CI nightly; gate merge if mutation score drops below 75% on changed domain classes.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| PIT on entire monolith | 4-hour CI job |
| No timeout on PIT | Hung CI |
| Ignore survived mutants | Score never improves |
| Run PIT on integration tests only | Slow, flaky mutants |
| Mutation gate on generated code | Impossible threshold |

### Debugging scenario

**Observe.** PIT kills all mutants but prod still has bugs.

**Diagnose.** PIT only ran on `domain`; bug was in Feign decoder mapping — integration gap.

**Fix.** Mutation on domain; contract + integration tests on boundaries; don't expect PIT to replace all layers.

---

## 16. Spring Boot 3 Test Infrastructure

### Core concept

Spring Boot 3 moved to **Jakarta EE**, **JUnit 5 only**, **Mockito 5** (strict stubs), and improved **Testcontainers** integration. Test infrastructure must align or you get silent behavior differences between test and prod.

### Key Boot 3 test dependencies

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-test</artifactId>
    <scope>test</scope>
</dependency>
<!-- includes JUnit 5, AssertJ, Hamcrest, Mockito, JSONassert, JsonPath -->
```

### Test slices reference

| Annotation | Loads |
|---|---|
| `@WebMvcTest` | `@Controller`, `@ControllerAdvice`, `@JsonComponent`, `@Filter` (limited) |
| `@WebFluxTest` | WebFlux controllers |
| `@DataJpaTest` | JPA, `@Entity`, repositories |
| `@JdbcTest` | `JdbcTemplate`, Flyway/Liquibase |
| `@JsonTest` | Jackson `ObjectMapper` |
| `@RestClientTest` | `@RestClient` / RestTemplate builder |
| `@MockBean` / `@SpyBean` | Replace/add beans in slice |

### `@MockBean` vs `@Mock` vs `@Import`

- `@Mock` (Mockito): pure unit test, no Spring context.
- `@MockBean`: Spring test context replaces bean — use in slices when testing wiring.
- `@Import(MyConfig.class)`: pull in security, mappers, validators not in default slice.

### TestRestTemplate vs WebTestClient vs MockMvc

| Client | Stack | When |
|---|---|---|
| `MockMvc` | Servlet, in-process | `@WebMvcTest`, filter chain testing |
| `TestRestTemplate` | Servlet, embedded server | Full `@SpringBootTest` RANDOM_PORT |
| `WebTestClient` | WebFlux or MockMvc binding | Reactive or unified API |

Boot 3.2+ **`RestClient`** testing:

```java
@AutoConfigureRestClient
class CatalogClientTest {
    @Autowired RestClient.Builder builder;

    @Test
    void fetchesProduct() {
        mockWebServer.enqueue(new MockResponse().setBody("""
            {"id":"p1","name":"Widget"}
            """).addHeader("Content-Type", "application/json"));

        CatalogClient client = new CatalogClient(builder.baseUrl(mockWebServer.url("/").toString()).build());
        assertThat(client.getProduct("p1").name()).isEqualTo("Widget");
    }
}
```

### Observability in tests

```yaml
# application-test.yml
management:
  tracing:
    sampling:
      probability: 1.0
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
```

Assert custom metrics in integration tests:

```java
@Autowired MeterRegistry registry;

@Test
void createOrder_incrementsCounter() {
    orderService.create(valid());
    assertThat(registry.get("orders.created").counter().count()).isEqualTo(1.0);
}
```

### Virtual threads (Java 21) and tests

With `spring.threads.virtual.enabled=true`, blocking mocks in load-style tests behave differently — thread pool exhaustion tests may not reproduce. Document profile: `integration-test` uses platform threads if testing bulkhead semantics tied to thread pools.

### Production scenario: `@WebMvcTest` missing security

**Problem.** Boot 3 upgrade; `@WebMvcTest(OrderController)` returns 401 for all tests.

**Cause.** Security auto-config applies default `anyRequest().authenticated()`; custom `SecurityFilterChain` not in slice.

**Fix.** `@Import(SecurityConfig.class)` or `@AutoConfigureMockMvc(addFilters = false)` only if intentionally testing controller without security — prefer `@WithMockUser` / `jwt()` post-processor.

---

## 17. CI/CD Test Strategy for Microservices

### Core concept

Each microservice repo owns a **test pipeline** that gates deploy. Platform owns **cross-cutting gates** (contract broker, can-i-deploy, synthetic prod probes). Pipeline design determines whether shift-left actually happens or becomes shelfware.

### Recommended pipeline stages

```
PR opened
  ├─ lint / compile
  ├─ unit (parallel modules)
  ├─ mutation (changed domain packages, nightly full)
  ├─ integration (Testcontainers, forkCount=1)
  ├─ contract consumer publish (feature branch to broker with tag)
  └─ static analysis / CVE scan

Merge to main
  ├─ all PR gates
  ├─ contract provider verify
  ├─ can-i-deploy → staging
  ├─ deploy staging
  ├─ smoke E2E + k6 smoke load
  └─ promote prod (canary)

Nightly
  ├─ full E2E suite
  ├─ soak test (2h)
  ├─ chaos staging game day automation
  └─ full PIT mutation
```

### Maven profiles pattern

```xml
<profiles>
    <profile>
        <id>unit</id>
        <build>
            <plugins>
                <plugin>
                    <artifactId>maven-surefire-plugin</artifactId>
                    <configuration>
                        <groups>unit</groups>
                        <excludedGroups>integration,e2e</excludedGroups>
                    </configuration>
                </plugin>
            </plugins>
        </build>
    </profile>
    <profile>
        <id>integration</id>
        <build>
            <plugins>
                <plugin>
                    <artifactId>maven-failsafe-plugin</artifactId>
                    <configuration>
                        <groups>integration</groups>
                    </configuration>
                </plugin>
            </plugins>
        </build>
    </profile>
</profiles>
```

Tag tests:

```java
@Tag("unit")
@Test
void calculatesTotal() { ... }

@Tag("integration")
@Test
void persistsOrder() { ... }
```

### Monorepo vs polyrepo contract flow

| Layout | Contract flow |
|---|---|
| Polyrepo (1 service per repo) | Consumer publishes; provider verifies; broker is source of truth |
| Monorepo | Can run consumer + provider verify in one pipeline; still publish to broker for deploy gates |
| Multi-repo shared library | Library unit tests + consumer pact for each service using the lib |

### Production scenario: deploy order race

**Problem.** Consumer deployed Friday; provider deploy Monday with breaking change. Weekend outages.

**Cause.** No `can-i-deploy`; teams deploy independently.

**Solution.** Deploy pipeline requires both paticipants compatible. Feature flags for backward-compatible provider changes during transition.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `mvn test` skips failsafe | Integration tests never run in CI |
| Parallel jobs share Testcontainers without isolation | Flaky CI |
| Contract publish only on release tag | Drift all sprint |
| E2E blocks every PR | Developers merge without waiting |
| No test result caching | 15 min compile + test every push |

### Debugging scenario

**Observe.** CI integration tests pass 95%; 5% fail with Docker timeout.

**Diagnose.** GitHub-hosted runner Docker pull rate limit; cold image pull every run.

**Fix.** Mirror images to registry cache; `withReuse(true)`; Testcontainers Cloud.

---

## 18. Production Debugging Playbook

When tests pass but production fails — or tests fail "randomly" — work through this sequence.

1. **Classify the failure layer.**
   - Single service logic bug → unit test gap or weak mutation score.
   - Wire/format error between services → contract gap.
   - Only under load → missing load/resilience test.
   - Only after deploy → can-i-deploy / deploy order / feature flag.
   - Only in prod config → profile drift, secret, scale.

2. **Reproduce with the smallest layer.**
   - Don't spin full E2E first. Reproduce with integration + WireMock, then add Testcontainers, then staging E2E.

3. **Check test environment fidelity.**

   ```yaml
   # Diff prod vs integration-test profile
   spring:
     datasource:
       hikari:
         maximum-pool-size: ???  # match prod per pod
   ```

4. **For flaky tests — quarantine, don't ignore.**
   - `@Tag("flaky")` + issue link; run flaky separately; fix within SLA; never `@Disabled` without ticket.

5. **For contract failures — broker timeline.**
   - Which consumer version published new interaction? Did provider verify before merge? Use Pact broker UI graph.

6. **For performance regressions — compare traces.**
   - Same k6 script against last good tag and current SHA on staging; diff p99 by span.

7. **For resilience failures — inspect breaker metrics during incident.**
   - If breaker never opened, test didn't inject enough failures or threshold too high.

8. **For chaos/game day findings — file as code/tests.**
   - Every manual prod discovery becomes automated WireMock/Toxiproxy test or staging chaos experiment.

9. **Verify CI actually ran the gate.**
   - Check GitHub required checks; fork PRs may skip secrets-dependent integration.

10. **Post-incident — add one test at the lowest sufficient layer.**
    - Not "add E2E" by default — add pact interaction, integration assertion, or unit case.

---

## 19. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Pure business rule (tax, discount) | Unit test + mutation (PIT) |
| Repository SQL with Postgres features | `@DataJpaTest` + Testcontainers Postgres |
| Controller HTTP status + JSON shape | `@WebMvcTest` or MockMvc |
| Service boots with Kafka + DB | `@SpringBootTest` + Testcontainers + base class reuse |
| Two teams, API boundary | Pact consumer-driven + broker + can-i-deploy |
| Provider-owned public API, few consumers | Spring Cloud Contract or OpenAPI diff |
| Outbound HTTP behavior when peer down | WireMock + resilience integration test |
| Cross-service user journey (checkout) | API E2E smoke in staging (minimal count) |
| UI regression | Playwright for critical paths only |
| Latency SLO validation | k6 thresholds on staging after deploy |
| Find max capacity | Load/stress test in isolated env |
| Verify circuit breaker / fallback | Resilience integration test with WireMock |
| Network latency between services | Toxiproxy + Testcontainers network |
| K8s restart behavior | Litmus pod-delete in staging during load |
| Prod confidence in turbulence | Chaos game day with steady-state + abort criteria |
| Tests pass but bugs ship | Run PIT on domain; check mutation score |
| Fast PR feedback | Unit + contract consumer; integration nightly |
| Developer without Docker | `@Tag("integration")` skipped locally; CI required |
| Async event contract | Pact message pact + Kafka Testcontainers |
| Security authorization | `@WithMockUser` / `jwt()` unit; security integration separate |
| Flaky async E2E | Awaitility + idempotent setup; fix data races |
| Deploy gate | can-i-deploy + smoke E2E + k6 smoke |
| Weak test suite | Shift-left mutation + contract, not more E2E |

---

## 20. Interview Q&A

### Q1. What is the test pyramid and why does it matter for microservices?

**A.** The test pyramid recommends many fast unit tests at the base, fewer integration tests, and minimal E2E tests at the top. In microservices, add **contract tests** horizontally between services. It matters because inverted pyramids (mostly E2E) produce slow, flaky pipelines and still miss API drift between services. The pyramid optimizes feedback speed and cost while maintaining confidence.

### Q2. What is the difference between integration testing and E2E testing?

**A.** Integration testing verifies **one service** (or a small boundary) with real or realistic infrastructure — e.g., order service + Testcontainers Postgres + WireMock inventory. E2E testing validates **complete user journeys** across many deployed services and the gateway. Integration is faster and localizable; E2E is slower but proves the full path works together.

### Q3. Explain contract testing vs mocking in integration tests.

**A.** Mocking (WireMock, `@MockBean`) simulates a peer's behavior for **your service's test** — you define what you think the peer returns. Contract testing ensures **both sides agree** on request/response structure; the consumer defines expectations (Pact CDC) and the provider proves it satisfies them. Mocks can drift from reality; contracts fail the provider build when they change the API.

### Q4. What is consumer-driven contract testing?

**A.** The **consumer** team writes tests defining required interactions (HTTP path, headers, body fields). These generate pact files. The **provider** runs verification against all consumer pacts. The provider implements only what consumers need and cannot break them without coordinated change. Pact Broker stores versions and supports `can-i-deploy` gates.

### Q5. When would you use Testcontainers instead of H2 or embedded Kafka?

**A.** When production uses features H2 doesn't support (JSONB, `SKIP LOCKED`, specific indexes), when SQL dialect matters, when Kafka client semantics differ from embedded brokers, or when you need exact version parity (Postgres 16, Redis 7). Testcontainers adds Docker dependency and CI cost but gives production fidelity.

### Q6. How do you reduce Testcontainers startup time in CI?

**A.** Use static `@Container` fields shared via a base class, enable container reuse, pin image digests, cache Docker layers, run integration tests in parallel forks with sufficient RAM, use `@ServiceConnection` to avoid manual config, and run full integration on main/nightly while PRs run a smoke subset.

### Q7. What is shift-left testing?

**A.** Moving verification earlier in the lifecycle — unit and contract tests in developer PRs, integration in CI, performance/chaos in staging before prod — instead of discovering defects in QA or production. In microservices, shift-left especially means **contract tests** instead of integrated staging for API compatibility.

### Q8. What is the difference between performance testing and load testing?

**A.** Performance testing measures whether the system meets **latency/throughput SLOs** under expected conditions and profiles bottlenecks. Load testing applies **sustained or increasing traffic** to find capacity limits, breaking points, and failure modes (stress, soak, spike). Performance asks "is it fast enough?"; load asks "how much can it take before it breaks?"

### Q9. How do you test that a circuit breaker actually opens?

**A.** Integration test with WireMock returning repeated 503s or timeouts; invoke the guarded endpoint until `CircuitBreakerRegistry` shows OPEN; assert subsequent calls fail fast with 503/fallback without hitting the wire. Don't mock the circuit breaker itself — mock the remote server.

### Q10. What is chaos engineering vs fault injection?

**A.** Fault injection introduces **specific, controlled faults** (500 errors, 2s latency) often in tests to verify known behavior. Chaos engineering is a **disciplined production/staging practice** with hypotheses, steady-state metrics, guardrails, and abort criteria — often random or realistic failures (pod kill, AZ loss) to discover unknown weaknesses. Fault injection is a tactic; chaos is a program.

### Q11. What is mutation testing and when is it worth the cost?

**A.** Mutation testing modifies code (PIT) and checks if tests fail. Surviving mutants indicate weak assertions. Worth the cost on **domain logic** with branching (pricing, permissions, state machines), run nightly or on changed domain packages — not on DTOs or every integration test. High line coverage with low mutation score is a red flag.

### Q12. How does Pact `can-i-deploy` work?

**A.** Before deploying a version, the broker checks whether that consumer and provider version are **compatible with each other and with what's already in the target environment**. If consumer v2 requires a field provider v1 doesn't have, deploy is blocked. Both services must pass can-i-deploy for safe promotion.

### Q13. Why shouldn't you rely on E2E tests alone for microservices?

**A.** E2E tests are slow, flaky, hard to debug, and don't scale with service count. They miss cases not on critical paths, run late in the pipeline, and don't pin **which pair** of services broke. Contract + integration tests localize failures; E2E confirms a few vital journeys.

### Q14. How do you test Kafka-based async flows in Spring Boot 3?

**A.** Testcontainers Kafka with `@ServiceConnection`, publish event, use Awaitility to assert listener processed message, optional Pact **message pact** for schema. For failure paths, test idempotent consumer with duplicate delivery simulation.

### Q15. What causes flaky E2E tests in microservices and how do you fix them?

**A.** Causes: shared test data, async timing (`Thread.sleep`), missing idempotency, cron jobs interfering, fixed clock/UUID assertions, environment contention. Fixes: isolated E2E namespace, Awaitility, synthetic data APIs, `@Tag("e2e")` scheduling, semantic matchers, compensating cleanup, retry only with root-cause ticket.

### Q16. How do Spring Boot test slices help?

**A.** Slices like `@WebMvcTest`, `@DataJpaTest` load **only relevant beans** — faster than `@SpringBootTest`, clearer failure domain. Use slices for controller/repository focused tests; full boot for wiring across modules.

### Q17. What is a provider state in Pact?

**A.** A **given** clause (`given("SKU-1 is in stock")`) tells the provider how to seed data before verifying an interaction. Provider implements `@State` methods to set up DB/fixtures. Without states, verification runs against empty DB and passes while prod fails.

### Q18. How do you safely load test a system with external payment APIs?

**A.** Use vendor sandbox with rate limits, mock payment in load env, or contractually approved load window. Always use idempotency keys. Never load test prod payment endpoints. Monitor sandbox quota separately.

### Q19. What metrics define steady state for a chaos experiment?

**A.** Business KPIs (checkout success rate, order completion), SLIs (p99 latency, error rate), and dependency health (pool wait, Kafka lag, circuit state) — chosen per hypothesis. Abort when metrics breach pre-defined thresholds for a sustained window.

### Q20. What's wrong with `@SpringBootTest` and `@MockBean` for every test?

**A.** It loads the full context (slow), mocks hide integration defects, and tests become **integration tests with fake dependencies** — proving little about SQL, serialization, or real HTTP. Use unit tests for logic, slices/Testcontainers for real boundaries, mocks only at the edge being tested.

### Q21. How do WireMock and Pact complement each other?

**A.** WireMock stubs peers **during your integration tests** for behavior simulation (503, slow response). Pact verifies **API compatibility** between consumer and provider codebases. Use WireMock for resilience scenarios; Pact for preventing field/path drift across teams.

### Q22. What is resilience testing without chaos?

**A.** Controlled, repeatable failure tests in CI/staging: WireMock errors, Toxiproxy latency, asserting circuit breaker/fallback/timeout behavior. Deterministic and run every build — unlike prod chaos which explores unknowns.

### Q23. How do you organize tests in a microservice CI pipeline?

**A.** PR: unit + contract consumer + fast integration smoke. Main: full integration, provider verify, deploy staging, smoke E2E, k6 smoke. Nightly: full E2E, soak, mutation, chaos staging. Gate prod with can-i-deploy and synthetic probes.

### Q24. Explain the testing implications of Spring Boot 3 / Mockito 5.

**A.** Mockito 5 strict stubs fail on unused stubbings — forces cleaner tests. Jakarta namespace requires updated imports. `@MockBean` still works in slices. Security tests need explicit JWT/`@WithMockUser` setup. Virtual threads change concurrency test assumptions.

### Q25. How would you test a checkout microservices flow end-to-end with minimal E2E?

**A.** Unit: pricing, tax, state machine. Contract: order→inventory, order→payment, order→notification (Pact). Integration: order service + Testcontainers + WireMock for peers. Resilience: inventory 503 → fallback. One E2E smoke: guest checkout on staging. k6 smoke on deploy. can-i-deploy gates both sides.

---

*Green CI is not a certificate of production safety. The pyramid, contracts, containers, and chaos each catch different failures — skip a layer and customers become your QA.*
