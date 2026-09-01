# GraphQL with Spring — Senior Production Reference

Spring Boot 3.2+ / Spring for GraphQL 1.2+ / graphql-java 22.x. This is not a tutorial on writing your first `@QueryMapping`. It is the map of what actually breaks in production after shipping GraphQL behind mobile apps, BFFs, and public APIs — N+1 resolver storms, unbounded query depth, partial errors clients ignore, introspection leaks, and the DataLoader lifecycle nobody documents until the DB melts.

---

## Table of Contents

1. [Mental Model: GraphQL as a Typed Query Layer](#1-mental-model-graphql-as-a-typed-query-layer)
2. [REST vs GraphQL vs gRPC: When Each Wins](#2-rest-vs-graphql-vs-grpc-when-each-wins)
3. [Schema Design: Types, Inputs, Unions, and Naming](#3-schema-design-types-inputs-unions-and-naming)
4. [The GraphQL Execution Engine](#4-the-graphql-execution-engine)
5. [Spring for GraphQL Wiring (Boot 3)](#5-spring-for-graphql-wiring-boot-3)
6. [N+1 Problem and DataLoader](#6-n1-problem-and-dataloader)
7. [Query Complexity and Depth Limits](#7-query-complexity-and-depth-limits)
8. [Pagination: Offset, Cursor, and Relay Connections](#8-pagination-offset-cursor-and-relay-connections)
9. [Mutations: Design, Idempotency, and Side Effects](#9-mutations-design-idempotency-and-side-effects)
10. [Errors: Partial Results, Extensions, and ProblemDetail](#10-errors-partial-results-extensions-and-problemdetail)
11. [Security: AuthN, AuthZ, Field-Level, and Introspection](#11-security-authn-authz-field-level-and-introspection)
12. [Caching: HTTP, Persisted Queries, and CDN](#12-caching-http-persisted-queries-and-cdn)
13. [Subscriptions: WebSocket, SSE, and Scaling](#13-subscriptions-websocket-sse-and-scaling)
14. [Observability: Metrics, Tracing, and Logging](#14-observability-metrics-tracing-and-logging)
15. [Testing: GraphQlTester, WebGraphQlTester, and Contract Tests](#15-testing-graphqltester-webgraphqltester-and-contract-tests)
16. [Schema Evolution and Deprecation](#16-schema-evolution-and-deprecation)
17. [Federation Brief (Apollo / Spring GraphQL)](#17-federation-brief-apollo-spring-graphql)
18. [Performance Tuning and Production SLOs](#18-performance-tuning-and-production-slos)
19. [Migration from REST to GraphQL](#19-migration-from-rest-to-graphql)
20. [Anti-Patterns That Ship to Production](#20-anti-patterns-that-ship-to-production)
21. [Production Debugging Playbook](#21-production-debugging-playbook)
22. [Quick Decision Matrix](#22-quick-decision-matrix)

---


## 1. Mental Model: GraphQL as a Typed Query Layer

### Core concept

GraphQL is not "a REST replacement" or "one endpoint." It is a **typed query language** plus a **runtime execution engine** that resolves a client-specified selection set against a **schema** you publish. The client sends a document (query/mutation/subscription); the server validates it against the schema, executes field resolvers depth-first (with batching opportunities), and returns JSON shaped exactly like the query tree.

Spring for GraphQL (Boot 3.2+) is the **integration layer**: it wires GraphQL Java, maps your `@Controller`-style beans to the schema, bridges DataLoader, security, observability, and HTTP/WebSocket transports. Your resolvers are still where production bugs live — N+1 queries, authorization leaks, and unbounded fan-out.

### Internal working

```
Client POST /graphql  (or GET with persisted query hash)
  └─ Spring Security filter chain (same servlet/reactive stack as REST)
       └─ GraphQlHttpHandler / WebGraphQlHandler
            ├─ Parse document → validate against GraphQLSchema
            ├─ Analyze complexity/depth (if configured)
            ├─ Execute via graphql-java engine
            │    └─ for each field: DataFetcher (your @QueryMapping / @SchemaMapping)
            │         └─ DataLoader batch (optional)
            └─ Serialize GraphQLResponse JSON
                 ├─ data: { ... }
                 └─ errors: [ { message, path, extensions } ]
```

Three objects to keep distinct:

| Object | Question it answers | Spring type |
|---|---|---|
| **Schema** | What types and fields exist? What is valid to ask? | `GraphQLSchema`, `.graphqls` files |
| **DataFetcher** | How do I resolve field `Order.customer`? | `@SchemaMapping`, `@BatchMapping` |
| **Execution** | In what order, with what context, and with what limits? | `ExecutionInput`, `DataLoaderRegistry` |

GraphQL returns **200 OK** for many failure modes — partial `data` plus `errors` is normal. Treating GraphQL like REST status codes is a senior interview trap.

### Production scenario: Mobile app requests `user { orders { items { product { reviews } } } }`

**Problem.** One GraphQL query replaces 4 REST calls in the prototype. Production DB CPU spikes; p99 latency 8s.

**Cause.** Resolver per field without DataLoader: `orders` → N queries for items → M queries for products → P queries for reviews. Client-controlled depth multiplied by list sizes.

**Solution.** Batch loaders, query complexity limits, field-level cost analysis, and schema design that exposes `OrderSummary` vs `OrderDetail` types with different depth.

```yaml
spring:
  graphql:
    graphiql:
      enabled: false   # prod
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Treating GraphQL as "automatically efficient" | N+1 worse than REST if each field hits DB |
| No query depth/complexity limits | Single client query melts DB |
| Returning JPA entities from resolvers | Lazy-load during resolution; session issues |
| Introspection enabled in prod | Schema enumeration aids attackers |
| Same auth as REST but no field-level checks | IDOR via nested fields |

### Debugging scenario

**Observe.** Slow queries; SQL count scales with result rows × nested fields.

**Diagnose.** Enable DataLoader stats; Hibernate query count in staging; trace resolver timings via Micrometer custom timers or OpenTelemetry GraphQL instrumentation.

**Fix.** `@BatchMapping` for associations; DataLoader per request; cap complexity; persist approved queries for mobile.

---

## 2. REST vs GraphQL vs gRPC: When Each Wins

### Core concept

Choosing GraphQL because "clients need flexibility" without measuring operational cost is how teams inherit resolver graphs harder to cache, secure, and version than REST. gRPC wins on internal east-west RPC; REST wins on cacheable public resources and simple CRUD; GraphQL wins when **many clients need different shapes** of the same domain graph and you can invest in schema governance, batching, and query controls.

### Comparison matrix

| Dimension | REST | GraphQL | gRPC |
|---|---|---|---|
| Contract | OpenAPI + URLs | Schema (SDL) | Protobuf |
| Transport | HTTP/1.1–2 | HTTP + WebSocket (subscriptions) | HTTP/2 |
| Over-fetching | Common | Client selects fields | Fixed message shape |
| Under-fetching | Multiple round trips | Single round trip possible | Often one RPC |
| Caching | HTTP cache, CDN | Hard (POST); persisted queries help | None at edge |
| Versioning | URL/header/media type | Schema evolution + `@deprecated` | Proto field numbers |
| Tooling | Universal | Good; needs discipline | Strong internal |
| N+1 risk | Per endpoint design | Per field resolver | Per RPC design |
| Streaming | SSE, chunked | Subscriptions | Server streaming RPC |

### When GraphQL is the right bet

- Mobile and web clients need **different projections** of the same order/customer/catalog graph.
- You operate a **BFF** or public API where product wants rapid iteration on UI data needs without new REST endpoints weekly.
- You can enforce **query cost limits**, persisted queries, and DataLoader batching as non-negotiable platform requirements.
- Read-heavy, graph-shaped domains (e-commerce, social feeds, dashboards).

### When GraphQL is the wrong bet

- Simple CRUD with stable shapes — REST + OpenAPI is cheaper.
- Heavy binary/media, file upload primary use case — REST or gRPC streaming.
- Internal service-to-service with high QPS and strict latency — gRPC or plain REST with binary JSON alternatives.
- Team lacks schema review process — GraphQL becomes an unbounded DB query language for clients.

### Production scenario: "We replaced REST with GraphQL for everything"

**Problem.** Six microservices now expose GraphQL; gateway aggregates schemas. Deploy frequency dropped; incident rate up.

**Cause.** GraphQL at every hop multiplies resolver latency, loses HTTP caching between services, and couples teams via federated schema changes. Internal sync calls do not need client-driven selection.

**Solution.** GraphQL at **edge/BFF only**; internal calls stay gRPC/REST. One graph, many backing services via dedicated fetchers — not GraphQL calling GraphQL calling GraphQL.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| GraphQL between microservices | Latency stacks; no CDN cache; schema coupling |
| Ignoring HTTP caching wins of REST | Origin load higher than old REST for read-heavy pages |
| Using GraphQL for file export/report | Timeouts; memory spikes on large lists |
| gRPC internally + GraphQL externally without BFF | Leaky abstractions; proto and SDL drift |

### Debugging scenario

**Observe.** Leadership asks "why is GraphQL slower than REST for `/products` list?"

**Diagnose.** Compare: REST endpoint returns fixed DTO with one query; GraphQL list + nested fields triggers resolver tree. Profile SQL count per request type.

**Fix.** For cache-friendly public lists, keep REST or expose a `productsSummary` query with complexity cap and no nested resolvers by default.

---

## 3. Schema Design: Types, Inputs, Unions, and Naming

### Core concept

The schema is your **public API contract**. In Spring for GraphQL, schema files live under `src/main/resources/graphql/` (default `**.graphqls`). Spring Boot auto-detects and merges them. Resolver methods bind by **field name** and **parent type** — rename a field in SDL without updating `@SchemaMapping` and you get runtime nulls or `DataFetcherException`s.

Design for **evolution**, not perfection v1: use input types for mutations, separate **payload types** from **entity types**, avoid `JSON` scalar unless you accept unqueryable chaos.

### Internal working

SDL example:

```graphql
type Query {
    order(id: ID!): Order
    orders(filter: OrderFilter, first: Int, after: String): OrderConnection!
}

type Order {
    id: ID!
    status: OrderStatus!
    total: Money!
    customer: Customer!
    lineItems: [LineItem!]!
}

input OrderFilter {
    status: OrderStatus
    customerId: ID
}

enum OrderStatus { PLACED SHIPPED DELIVERED CANCELLED }
```

Spring wiring:

```java
@Controller
public class OrderController {

    @QueryMapping
    public Order order(@Argument UUID id) {
        return orderService.findById(id);
    }

    @SchemaMapping
    public Customer customer(Order order) {
        return customerService.findById(order.customerId());
    }
}
```

Prefer **interface/union** for polymorphic nodes (`SearchResult = Product | Article | User`) so clients use inline fragments and you can add types without breaking old clients.

### Schema design rules (production)

1. **Nullable by default** in GraphQL (`String` not `String!`) except when business invariant requires non-null — broken non-null bubbles errors up the tree.
2. **Separate read models**: `OrderSummary` vs `OrderDetail` controls cost without resolver hacks.
3. **Input types** for mutations; never reuse output types as inputs.
4. **Custom scalars** for `DateTime`, `Money`, `UUID` — register in `RuntimeWiringConfigurer`.
5. **Naming**: `orderById` query vs `order` — be consistent; Relay uses `node(id:)`.
6. **Avoid lists of lists** unless domain requires; prefer connection pattern for pagination.

### Production scenario: Non-null field blows up entire query

**Problem.** Client queries `orders { id customer { email } }`. One order has deleted customer; entire query fails.

**Cause.** `customer: Customer!` on `Order` — null customer propagates GraphQL non-null violation; sibling orders lost.

**Solution.** Make `customer` nullable OR return `Customer` union/`DeletedCustomer` placeholder; handle in UI. Document in schema description.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `String!` everywhere | Partial failures become total failures |
| Exposing internal DB IDs only | OK; exposing internal enum codes breaks clients on rename |
| Giant `User` type with 40 fields | Every query pays authorization on sensitive fields |
| No ` @deprecated` on old fields | Clients never migrate; schema bloat |

### Debugging scenario

**Observe.** Field returns null after schema change; no error in `errors` array.

**Diagnose.** `@SchemaMapping` method name mismatch; wrong parent type; returned null for nullable field silently.

**Fix.** Align SDL field names; add integration test with `GraphQlTester`; enable `spring.graphql.schema.printer.enabled=true` in dev to inspect merged schema.

---

## 4. The GraphQL Execution Engine

### Core concept

graphql-java executes requests in **phases**: parse → validate → analyze (optional) → execute. Execution walks the operation tree **field by field**, breadth-first within a level conceptually, but resolver invocation order follows dependency. Each field gets a `DataFetchingEnvironment` with source object, arguments, selection set, and context.

Understanding **async execution** matters: graphql-java supports `CompletionStage` return types; Spring maps `Mono`/`Flux` on WebFlux. Blocking JDBC in a servlet resolver blocks Tomcat threads — same as MVC.

### Internal working

```
Document
  → OperationDefinition (query/mutation/subscription)
       → SelectionSet (fields)
            → for each Field:
                 resolve type → invoke DataFetcher
                 → if composite type, recurse into sub-selections
```

Key execution concepts:

| Concept | Meaning |
|---|---|
| **DataFetcher** | Function resolving one field |
| **TypeResolver** | Picks concrete type for interface/union |
| **Instrumentation** | Hooks for tracing, complexity, logging |
| **DataLoader** | Batches and caches loads within one request |
| **ExecutionStrategy** | Sync vs async parallel strategies |

Parallel sibling fields: graphql-java may resolve independent sibling fields concurrently (async strategy). Two fields both calling `block()` on JDBC can saturate pool faster than sequential REST.

### ExecutionInput and context

```java
@Bean
public ExecutionGraphQlService executionGraphQlService(GraphQlSource graphQlSource) {
    return GraphQlSource.graphQlService(graphQlSource)
        .transform(builder -> builder
            .instrumentation(new ChainedInstrumentation(
                List.of(new MaxQueryDepthInstrumentation(15),
                        new MaxQueryComplexityInstrumentation(200),
                        new TracingInstrumentation()))));
}
```

Pass per-request context (tenant, user, correlation ID):

```java
@Component
public class RequestContextInterceptor implements WebGraphQlInterceptor {
    @Override
    public Mono<WebGraphQlResponse> intercept(WebGraphQlRequest request, Chain chain) {
        RequestContext ctx = RequestContext.fromSecurity(SecurityContextHolder.getContext());
        request.configureExecutionInput((input, builder) ->
            builder.graphQLContext(Map.of("ctx", ctx)).build());
        return chain.next(request);
    }
}
```

Access in resolver: `@ContextValue("ctx") RequestContext ctx` or `DataFetchingEnvironment.getGraphQlContext()`.

### Production scenario: "Random" field nulls under load

**Problem.** `product { inventory }` intermittently null; no stack trace.

**Cause.** Async DataFetcher throws; exception mapped to null for nullable field; or timeout in downstream service swallowed.

**Solution.** Custom `DataFetcherExceptionResolver`; never swallow; log with path; use non-null only when truly invariant.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Ignoring parallel field execution | Connection pool exhaustion under "simple" queries |
| No GraphQL context for tenant | Cross-tenant data leak in nested resolvers |
| Global singleton mutable state in fetchers | Race conditions across requests |
| `CompletableFuture` not completed | Hanging requests until timeout |

### Debugging scenario

**Observe.** Query hangs until gateway 504.

**Diagnose.** Thread dump: resolvers blocked on JDBC; or incomplete `Mono` never emitted.

**Fix.** Timeouts on downstream calls; `@BatchMapping`; virtual threads (servlet) or reactive stack end-to-end.

---

## 5. Spring for GraphQL Wiring (Boot 3)

### Core concept

Add `spring-boot-starter-graphql`. Boot auto-configures:

- **Schema resources** from `classpath:graphql/**`
- **Annotation scanning** for `@QueryMapping`, `@MutationMapping`, `@SubscriptionMapping`, `@SchemaMapping`, `@BatchMapping`
- **HTTP endpoint** default `/graphql` (MVC or WebFlux depending on classpath)
- **GraphiQL** optional at `/graphiql` when enabled
- **GraphQlSource** bean merging schema + runtime wiring

You do not manually register `GraphQL` servlet unless customizing.

### Dependencies and stack choice

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-graphql</artifactId>
</dependency>
<!-- MVC (default with spring-boot-starter-web) OR WebFlux -->
```

| Stack | Handler | When |
|---|---|---|
| Servlet (MVC) | `GraphQlHttpHandler` via `spring-boot-starter-web` | JPA/JDBC teams; virtual threads |
| Reactive (WebFlux) | `WebGraphQlHandler` | R2DBC; subscriptions at scale; WebClient |

Both can use same `.graphqls` and `@Controller` resolvers; return types differ (`Mono<T>` on WebFlux).

### Configuration properties

```yaml
spring:
  graphql:
    path: /graphql
    graphiql:
      enabled: false
    schema:
      printer:
        enabled: false
      introspection:
        enabled: false   # prod default off
    cors:
      allowed-origins: "https://app.example.com"
    websocket:
      path: /graphql
```

### Runtime wiring custom scalars

```java
@Configuration
public class GraphQlConfig {

    @Bean
    public RuntimeWiringConfigurer runtimeWiringConfigurer() {
        return wiring -> wiring
            .scalar(ExtendedScalars.DateTime)
            .scalar(ExtendedScalars.UUID);
    }
}
```

### Annotated controllers vs schema mapping interfaces

**Controller style** (common):

```java
@Controller
public class BookController {
    @QueryMapping
    public Book book(@Argument String id) { ... }

    @SchemaMapping(typeName = "Book")
    public Author author(Book book) { ... }
}
```

**Mapping interface** (test-friendly):

```java
public interface BookQueryController {
    @QueryMapping
    Book book(@Argument String id);
}
```

### Production scenario: GraphiQL left on in prod

**Problem.** Security scan flags GraphQL introspection; attacker maps admin mutations.

**Cause.** `spring.graphql.graphiql.enabled=true` shipped in prod profile copy-paste.

**Solution.** Profile-specific config; disable introspection; WAF rate limit `/graphql`; auth on all mutations.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Schema files not under `graphql/` | Empty schema; 404 on startup error |
| Missing `@Argument` name match | Always null arguments |
| Mixing WebFlux + blocking without scheduler | Event loop blocked |
| Custom `GraphQlSource` bean without calling super wiring | Scalars and directives missing |

### Debugging scenario

**Observe.** Application starts but all queries "Validation error".

**Diagnose.** SDL syntax error partial load; conflicting type definitions across files; check startup logs for schema parser errors.

**Fix.** `GraphQlSource` schema report; consolidate `.graphqls`; CI schema lint.

---

## 6. N+1 Problem and DataLoader

### Core concept

GraphQL's #1 production footgun: **one DB query per list item per nested field**. DataLoader batches `load(id)` calls that occur in the same execution phase into `loadMany(ids)`, and caches within the **request** scope.

Spring for GraphQL integrates DataLoader via `@BatchMapping` and `BatchLoaderRegistry`.

### Internal working

Without batching:

```
Query: orders { id customer { name } }  → 100 orders
  → 1 query orders
  → 100 queries customer by id
```

With `@BatchMapping`:

```java
@Controller
public class OrderController {

    @BatchMapping(typeName = "Order", field = "customer")
    public Map<Order, Customer> customer(List<Order> orders) {
        Set<UUID> ids = orders.stream().map(Order::customerId).collect(toSet());
        Map<UUID, Customer> byId = customerService.findByIds(ids);
        return orders.stream()
            .collect(toMap(o -> o, o -> byId.get(o.customerId())));
    }
}
```

Spring registers a DataLoader per batch mapping; keys are source objects.

Manual DataLoader (advanced):

```java
@Bean
public DataLoaderRegistrar registrar() {
    return registry -> registry.forTypePair(UUID.class, Customer.class)
        .withName("customerById")
        .registerMappedBatchLoader((ids, env) ->
            Mono.fromCallable(() -> customerService.findByIds(ids))
                .subscribeOn(Schedulers.boundedElastic()));
}
```

Use in resolver:

```java
@SchemaMapping
public CompletableFuture<Customer> customer(Order order, DataLoader<UUID, Customer> loader) {
    return loader.load(order.customerId());
}
```

### DataLoader rules

1. **Request-scoped only** — never singleton DataLoader cache across HTTP requests (stale data + memory leak).
2. **Dispatch timing** — batch fires when event loop dispatches; understand nested levels batch separately.
3. **Ordering** — `Map<Order, Customer>` must return entry per source key; missing key → null field.
4. **Errors** — batch loader throws → entire batch field errors.
5. **Cache key** — use stable IDs, not mutable object identity.

### Production scenario: DataLoader "works in dev, fails in prod"

**Problem.** Staging shows 2 SQL queries; prod shows 200.

**Cause.** Prod data has 100 orders; dev has 2. Forgot `@BatchMapping` on one nested field added last sprint. Or `@Transactional` boundary causes lazy load outside batch.

**Solution.** Query-count integration test with fixture size 50+; Micrometer counter on batch sizes; code review rule: new field on list type → batch or join fetch.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@SchemaMapping` per item DB call | Linear SQL growth |
| Global `@Cacheable` on resolver without tenant key | Cross-tenant cache bleed |
| DataLoader returning wrong map keys | Silent nulls |
| Blocking batch loader on WebFlux event loop | Latency cliffs |

### Debugging scenario

**Observe.** Hibernate logs show repeated `where id=?`.

**Diagnose.** Enable `statistics`; trace which `@SchemaMapping` lacks batch counterpart.

**Fix.** `@BatchMapping`; repository `findByIdIn`; consider SQL join view for hot paths.

---

## 7. Query Complexity and Depth Limits

### Core concept

Clients can send ** arbitrarily deep/wide** queries. Without limits, a authenticated mobile token can DOS your database cheaper than raw SQL injection. **Depth** counts nested fields; **complexity** assigns cost weights (scalar=1, object=child sum, list=multiplier).

graphql-java provides `MaxQueryDepthInstrumentation` and `MaxQueryComplexityInstrumentation`. Spring Boot does not enable them by default — you add them.

### Internal working

```java
@Bean
RuntimeWiringConfigurer complexityConfigurer() {
    return wiring -> {}; // schemas unchanged
}

@Bean
GraphQlSourceBuilderCustomizer sourceCustomizer() {
    return builder -> builder
        .configureGraphQl(context -> context
            .instrumentation(List.of(
                new MaxQueryDepthInstrumentation(12),
                new MaxQueryComplexityInstrumentation(150,
                    env -> { throw new AbortExecutionException("Query too expensive"); }))));
}
```

Custom field costs via `FieldComplexityCalculator`:

```java
(fieldEnv, childComplexity) -> {
    if ("reviews".equals(fieldEnv.getField().getName())) {
        return 5 + childComplexity;
    }
    return 1 + childComplexity;
}
```

Also limit **pagination sizes**:

```java
@QueryMapping
public Connection<Order> orders(@Argument OrderFilter filter,
                                  @Argument int first,
                                  DataFetchingEnvironment env) {
    if (first > 100) throw new GraphQLException("first must be <= 100");
    ...
}
```

### Persisted queries (APQ)

Allow-list query hashes for mobile — reduces attack surface and payload size.

```yaml
# Conceptual: implement via filter or gateway plugin
# Client sends persistedQuery hash + variables only
```

Production pattern: **APQ + complexity limit + auth** for public; ad-hoc GraphiQL only in dev VPN.

### Production scenario: Complexity limit rejects legitimate dashboard

**Problem.** Product complains "query worked yesterday" after platform team enabled complexity 100.

**Cause.** Dashboard added `items { product { category { parent { ... } } } }`; cost 240.

**Solution.** Refactor schema (`DashboardOrder` type with pre-joined fields); raise cost with review; or server-side dedicated resolver aggregating in one SQL.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No limits | DB CPU pegged by one query |
| Depth limit only, no list multiplier | Wide lists still expensive |
| Limits in dev but not prod profiles | Incident during launch traffic |
| Generic error message | Product cannot debug; log rejected query hash |

### Debugging scenario

**Observe.** 403/400 or GraphQL error "max complexity exceeded".

**Diagnose.** Log query document hash and calculated cost; reproduce in GraphiQL with complexity calculator debug.

**Fix.** Tune weights; split query; add field-level `@deprecated` on expensive paths.

---

## 8. Pagination: Offset, Cursor, and Relay Connections

### Core concept

GraphQL has **no standard pagination** in the spec beyond patterns. **Offset/limit** is simple but breaks under concurrent writes (duplicates/skips). **Cursor (keyset)** pagination is stable for feeds. **Relay Connection spec** (`edges { node cursor } pageInfo { hasNextPage endCursor }`) is the ecosystem convention Spring apps often mirror.

### Offset pattern (acceptable for admin, small tables)

```graphql
type Query {
    orders(offset: Int = 0, limit: Int = 20): [Order!]!
}
```

Cap `limit` server-side. Document unstable pagination.

### Cursor / Connection pattern

SDL:

```graphql
type OrderConnection {
    edges: [OrderEdge!]!
    pageInfo: PageInfo!
}

type OrderEdge {
    node: Order!
    cursor: String!
}

type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
}
```

Resolver sketch:

```java
@QueryMapping
public OrderConnection orders(@Argument String after, @Argument Integer first) {
    int pageSize = Math.min(first != null ? first : 20, 100);
    List<Order> rows = orderRepository.findAfter(decodeCursor(after), pageSize + 1);
    boolean hasNext = rows.size() > pageSize;
    if (hasNext) rows = rows.subList(0, pageSize);
    return OrderConnection.from(rows, hasNext);
}
```

Cursor = Base64(`createdAt:id`) — opaque, stable sort key required.

### Spring Data Pageable bridge

```java
@QueryMapping
public OrderConnection orders(@Argument int first, @Argument String after) {
    Pageable pageable = CursorPageable.of(after, first);
    Page<Order> page = orderService.find(pageable);
    return OrderConnectionAdapter.from(page);
}
```

Do not expose raw SQL offset in cursor.

### Production scenario: Duplicate rows in infinite scroll

**Problem.** Mobile feed shows same post twice after refresh.

**Cause.** Offset pagination while new posts inserted at top; or cursor uses non-unique sort key.

**Solution.** Keyset on `(publishedAt, id)`; encode both in cursor; never offset for feeds.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `limit=10000` allowed | OOM / timeout |
| Cursor from offset integer | Same instability as offset |
| `hasNextPage` wrong (no +1 query) | Client stops early or loops |
| Paginating nested lists without limits | Query explosion inside parent list |

### Debugging scenario

**Observe.** Last page empty but `hasNextPage=true`.

**Diagnose.** Off-by-one in over-fetch pattern; cursor decode failure silently resets to start.

**Fix.** Unit test cursor round-trip; integration test three pages with concurrent inserts.

---

## 9. Mutations: Design, Idempotency, and Side Effects

### Core concept

GraphQL mutations are **not CRUD by HTTP verb** — they are **named operations** with input types and should return **payload types** that include both the changed entity and **client-relevant errors** (`CreateOrderPayload { order, userErrors }`). Spec recommends mutations execute **serially** (not parallelized like queries) — order matters if client sends multiple mutations in one document (rare).

Treat mutations as **commands**: validate input, authorize, execute in transaction, publish domain events after commit.

### Mutation design pattern

```graphql
input CreateOrderInput {
    customerId: ID!
    lineItems: [LineItemInput!]!
    idempotencyKey: String
}

type CreateOrderPayload {
    order: Order
    userErrors: [UserError!]!
}

type Mutation {
    createOrder(input: CreateOrderInput!): CreateOrderPayload!
}
```

```java
@MutationMapping
public CreateOrderPayload createOrder(@Argument CreateOrderInput input,
                                      @ContextValue("ctx") RequestContext ctx) {
    if (!ctx.canCreateOrder(input.customerId())) {
        return CreateOrderPayload.error("FORBIDDEN", "Not allowed");
    }
    return orderService.createIdempotent(input);
}
```

### Idempotency

Mobile networks retry POSTs. Store `idempotencyKey` + hash → response mapping in Redis 24h. Same key returns same `order` without double charge.

### Side effects

- **Email/notification** — async after commit (`@TransactionalEventListener`).
- **Cache invalidation** — evict on mutation success, not on read resolver.
- **Subscriptions** — publish event to subscription source after commit.

### Production scenario: Double order on client retry

**Problem.** User charged twice; two orders same cart.

**Cause.** Mutation not idempotent; client retries GraphQL mutation on timeout (always 200 with partial errors possible).

**Solution.** `idempotencyKey` required; unique DB constraint; return existing order on replay.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Mutation returns bare entity, throws on validation | GraphQL errors vs userErrors confusion |
| Long work inside mutation resolver | Gateway timeout; client retries |
| No auth on mutation while query is public | Creates via introspected mutation name |
| Publishing Kafka before commit | Consumers read stale state |

### Debugging scenario

**Observe.** Mutation succeeds but list query shows old data.

**Diagnose.** Read replica lag; cache not evicted; subscription not wired.

**Fix.** Read-your-writes routing; `@CacheEvict` on command service; test mutation→query sequence.

---

## 10. Errors: Partial Results, Extensions, and ProblemDetail

### Core concept

GraphQL error model differs from REST:

- HTTP **200** with `{ "data": { "order": null }, "errors": [...] }` is valid.
- Errors have `message`, `path`, `locations`, `extensions`.
- **Partial success** is feature and footgun — client must check `errors` array.

Spring for GraphQL supports `DataFetcherExceptionResolver`, `GraphQlExceptionHandler` (WebFlux), and `@GraphQlException` mapping.

### Internal working

```java
@Component
public class GraphQlResolverExceptionHandler implements DataFetcherExceptionResolver {

    @Override
    public Mono<List<GraphQLError>> resolveException(Throwable ex, DataFetchingEnvironment env) {
        if (ex instanceof NotFoundException nfe) {
            return Mono.just(List.of(GraphqlErrorBuilder.newError()
                .message(nfe.getMessage())
                .path(env.getExecutionStepInfo().getPath())
                .extensions(Map.of("code", "NOT_FOUND", "classification", "NOT_FOUND"))
                .build()));
        }
        return Mono.just(List.of(GraphqlErrorBuilder.newError()
            .message("Internal error")
            .extensions(Map.of("code", "INTERNAL"))
            .build()));
    }
}
```

Hide stack traces in prod extensions. Map validation to `BAD_USER_INPUT`.

### UserErrors vs exceptions

| Pattern | Use when |
|---|---|
| `userErrors` in mutation payload | Expected validation failures clients display inline |
| `GraphQLError` / exception resolver | Unexpected failures, auth, not found |
| HTTP 401/403 from Spring Security | Before GraphQL executes — no GraphQL body |

### Production scenario: Client shows success with empty data

**Problem.** Checkout UI blank but HTTP 200.

**Cause.** Client parses only `data.createOrder.order`; ignores `errors` where auth failed.

**Solution.** Client SDK must merge errors; server return `userErrors` for business rules; contract tests.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Throwing for expected validation | Pollutes error monitoring |
| Leaking SQL in `message` | Security finding |
| Inconsistent `extensions.code` | Client cannot branch |
| Non-null violation on child wipes parent | Confusing error path |

### Debugging scenario

**Observe.** Sentry flooded with GraphQL "errors" that are normal validation.

**Diagnose.** Resolver throws `IllegalArgumentException` for bad user input.

**Fix.** Return payload `userErrors`; reserve exceptions for 5xx class failures.

---

## 11. Security: AuthN, AuthZ, Field-Level, and Introspection

### Core concept

GraphQL security = **same transport auth as REST** plus **schema-aware authorization**. Spring Security protects `/graphql` with JWT, session, or OAuth2 resource server. That is necessary but **not sufficient**: nested fields must enforce **object- and field-level** rules (`user.email` only for self or admin).

### Transport security

```java
@Bean
SecurityFilterChain api(HttpSecurity http) throws Exception {
    http.securityMatcher("/graphql", "/graphiql")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.POST, "/graphql").authenticated()
            .anyRequest().denyAll())
        .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()));
    return http.build();
}
```

WebFlux: `SecurityWebFilterChain` with `pathMatchers("/graphql")`.

### Field-level authorization

```java
@SchemaMapping
public String email(User user, @AuthenticationPrincipal Jwt jwt) {
    if (!user.id().equals(jwt.getSubject()) && !hasRole(jwt, "ADMIN")) {
        throw new AccessDeniedException("Cannot view email");
    }
    return user.email();
}
```

Better: **Spring Security `@PreAuthorize` on service layer** called from resolver; or GraphQL-specific `@Authorize` patterns via custom instrumentation scanning schema directives:

```graphql
directive @auth(requires: Role = USER) on FIELD_DEFINITION

type Query {
    adminStats: Stats @auth(requires: ADMIN)
}
```

Implement directive wiring in `RuntimeWiringConfigurer`.

### Introspection and GraphiQL

Disable in prod:

```yaml
spring.graphql.schema.introspection.enabled: false
```

Note: determined attackers can still infer schema from field suggestions unless disabled; combine with auth and rate limits.

### Query allow-list for public API

Mobile apps ship persisted queries; unknown query strings rejected at gateway or `WebGraphQlInterceptor`.

### Production scenario: IDOR via nested field

**Problem.** User A queries `order(id: "B's-order-uuid") { id lineItems { sku } }`.

**Cause.** `@QueryMapping order` checks auth; assumed nested fields safe; `lineItems` resolver skips check.

**Solution.** Authorize on **every** entry resolver; pass security context; filter lists in service layer by `ownerId`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auth only at HTTP layer | IDOR via guessed IDs |
| Introspection on public endpoint | Full schema exposed |
| Logging full query + variables with PII | Compliance breach |
| CSRF ignored for cookie auth GraphQL | CSRF mutation from malicious site |

### Debugging scenario

**Observe.** Pen test finds `__schema` in prod.

**Diagnose.** `introspection.enabled` true; or custom GraphiQL proxy.

**Fix.** Disable; WAF rule; verify with introspection query in CI gate for prod config.

---

## 12. Caching: HTTP, Persisted Queries, and CDN

### Core concept

GraphQL defaults to **POST** — bypasses HTTP cache. Caching strategies:

1. **HTTP GET** for persisted queries (hash + variables) — CDN cacheable with care.
2. **Application cache** (Caffeine/Redis) inside DataLoader or service — tenant-scoped keys.
3. **Entity cache** invalidation tied to mutations.
4. **APQ** (Automatic Persisted Queries) — client sends hash, server stores document.

Never cache **per-user** responses at CDN without **Vary** on auth (usually impractical). Cache **public** catalog queries separately.

### HTTP caching with persisted queries

```
GET /graphql?extensions={"persistedQuery":{"version":1,"sha256Hash":"..."}}&variables={"id":"1"}
Cache-Control: public, max-age=60
```

Requires stable responses, no auth-specific fields in cached body, or private cache only.

### Application-level cache

```java
@BatchMapping
public Map<Product, List<Review>> reviews(List<Product> products) {
    // short TTL Redis cache keyed by productId — invalidate on review mutation
}
```

Include **tenantId** in key. TTL short for inventory/pricing.

### Production scenario: CDN serves user A's data to user B

**Problem.** P0 privacy incident.

**Cause.** Cached GraphQL GET at edge for `me { email }` without `private` cache directive; shared cache key.

**Solution.** No CDN for authenticated queries; `Cache-Control: private, no-store` on `/graphql`; persist only anonymous catalog queries.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Cacheable` on `@QueryMapping` with user-specific data | Cross-user leakage |
| No cache eviction on mutation | Stale UI until TTL |
| Caching errors/ partial responses | Poison cache |
| ETag on dynamic GraphQL POST | useless |

### Debugging scenario

**Observe.** Price updates lag 5 minutes.

**Diagnose.** Redis cache on `Product.price` without eviction on `updatePrice` mutation.

**Fix.** `@CacheEvict` or event-driven invalidation; document cache semantics in schema.

---

## 13. Subscriptions: WebSocket, SSE, and Scaling

### Core concept

GraphQL subscriptions deliver **server-push** updates over **WebSocket** (default in Spring for GraphQL) or experimental SSE. Spring registers WebSocket handler at `spring.graphql.websocket.path` (default `/graphql`).

Subscriptions are **long-lived** — tie to WebFlux reactive stack for scale; servlet WebSocket works but thread model differs.

### Internal working

SDL:

```graphql
type Subscription {
    orderStatusChanged(orderId: ID!): Order!
}
```

```java
@Controller
public class OrderSubscriptionController {

    @SubscriptionMapping
    public Flux<Order> orderStatusChanged(@Argument UUID orderId) {
        return orderEventPublisher.stream(orderId)
            .map(event -> orderService.findById(event.orderId()));
    }
}
```

Publisher often **Redis Pub/Sub**, Kafka, or Reactor Sinks:

```java
public Flux<OrderEvent> stream(UUID orderId) {
    return sink.asFlux().filter(e -> e.orderId().equals(orderId));
}
```

WebSocket protocol: `graphql-transport-ws` or legacy `subscriptions-transport-ws` — align client library (Apollo) with server.

### Scaling subscriptions

| Approach | Notes |
|---|---|
| Single instance | In-memory sink — dev only |
| Redis Pub/Sub | Fan-out across pods |
| Kafka consumer per pod | Heavier; durable |
| Authorization on subscribe | Validate `orderId` belongs to user **at connection** |

### Production scenario: Memory leak on reconnect storm

**Problem.** Pods OOM after app release; thousands mobile clients reconnect.

**Cause.** Unbounded sink subscribers; no cleanup on disconnect; each subscription loads full order graph.

**Solution.** `Flux` cancel on client disconnect; weak refs; limit concurrent subs per user; heartbeat.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Subscription resolver hits DB each event without batch | DB storm on price ticks |
| No auth on WebSocket handshake | Open subscription firehose |
| Blocking JPA in subscription mapping | Thread exhaustion |
| Stale Kafka consumer group | Missed events after deploy |

### Debugging scenario

**Observe.** Clients stop receiving events after 60s.

**Diagnose.** ALB idle timeout; missing WebSocket ping; proxy not upgrading.

**Fix.** Configure ping interval; `spring.graphql.websocket.connection-init-timeout`; infra idle timeout > ping.

---

## 14. Observability: Metrics, Tracing, and Logging

### Core concept

GraphQL observability must answer: **which operation**, **which fields**, **how many SQL**, **which client**. HTTP access logs showing `POST /graphql` are insufficient — log **operation name**, **sanitized variables**, **query hash**, duration, error count.

### Metrics (Micrometer)

Custom instrumentation:

```java
public class MetricsInstrumentation extends SimpleInstrumentation {
    private final MeterRegistry registry;

    @Override
    public InstrumentationContext<ExecutionResult> beginExecution(InstrumentationExecutionParameters params) {
        Timer.Sample sample = Timer.start(registry);
        String opName = params.getOperation() != null ? params.getOperation() : "anonymous";
        return new InstrumentationContext<>() {
            @Override
            public void onDispatched(CompletableFuture<ExecutionResult> result) {
                result.whenComplete((r, t) -> {
                    sample.stop(registry.timer("graphql.request", "operation", opName));
                    if (r != null && !r.getErrors().isEmpty()) {
                        registry.counter("graphql.errors", "operation", opName).increment(r.getErrors().size());
                    }
                });
            }
        };
    }
}
```

Track: `graphql.request.duration`, `graphql.datafetcher.duration` (tag field), `dataloader.batch.size`.

### Tracing

OpenTelemetry: span per request + child spans per field (expensive — sample). Propagate trace context to downstream WebClient calls from resolvers.

Spring Boot 3.2+ Micrometer Tracing auto-config works; add GraphQL instrumentation to link resolver spans.

### Logging

```java
@Component
public class LoggingInterceptor implements WebGraphQlInterceptor {
    @Override
    public Mono<WebGraphQlResponse> intercept(WebGraphQlRequest request, Chain chain) {
        log.info("graphql op={} hash={}", request.getOperationName(), sha256(request.getDocument()));
        return chain.next(request).doOnNext(r -> {
            if (!r.getErrors().isEmpty()) log.warn("graphql errors={}", r.getErrors().size());
        });
    }
}
```

Never log full payment variables in prod.

### Production scenario: Cannot correlate DB spike to client

**Problem.** DBA escalation; APM shows `/graphql` only.

**Cause.** No operation name in client requests; all anonymous; 50 different mobile versions.

**Solution.** Require `operationName`; APQ registry maps hash → name; dashboard by hash.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Span per field always on | Trace backend cost 10× |
| Logging full documents | Log volume + PII |
| No error tagging | Alerts on HTTP 200 error rate invisible |
| Missing client version header | Cannot rollback bad app version |

### Debugging scenario

**Observe.** p99 regression after release; narrow to GraphQL.

**Diagnose.** Compare resolver timing metrics by field; new `@SchemaMapping` without batch.

**Fix.** Roll forward with batch mapping; add field timing to CI perf test.

---

## 15. Testing: GraphQlTester, WebGraphQlTester, and Contract Tests

### Core concept

Spring for GraphQL provides **`@GraphQlTest`** slice and **`GraphQlTester`** (binds to `ExecutionGraphQlService`) for unit-level resolver tests without HTTP. **`WebGraphQlTester`** for WebFlux/MVC integration with full filter chain.

Test **schema wiring**, **DataLoader batch behavior**, **error shapes**, and **security** — not only happy path.

### GraphQlTest slice

```java
@GraphQlTest(OrderController.class)
class OrderControllerTest {

    @Autowired GraphQlTester graphQlTester;

    @MockBean OrderService orderService;

    @Test
    void orderById() {
        when(orderService.findById(id)).thenReturn(order);
        graphQlTester.document("""
            query { order(id: "%s") { id status } }
            """.formatted(id))
            .execute()
            .path("order.id").entity(String.class).isEqual(id.toString())
            .path("order.status").entity(String.class).isEqual("PLACED");
    }
}
```

### Batch mapping test

```java
@Test
void batchesCustomerLoads() {
    when(customerService.findByIds(any())).thenReturn(customers);
    graphQlTester.document("query { orders { customer { id } } }")
        .execute();
    verify(customerService, times(1)).findByIds(any());
}
```

### WebGraphQlTester with security

```java
@AutoConfigureWebMvc
@SpringBootTest
class GraphQlSecurityIT {
    @Autowired WebGraphQlTester tester;

    @Test
    void rejectsAnonymousMutation() {
        tester.mutate().document("mutation { createOrder(input: {}) { order { id } } }")
            .execute()
            .errors().expect(status -> status.matches("UNAUTHORIZED|FORBIDDEN"));
    }
}
```

### Contract testing

Publish schema to registry (Hive, Apollo Studio) or Spring Cloud Contract GraphQL (emerging). CI breaks on **breaking schema changes** without `@deprecated` migration path.

### Production scenario: Green tests, prod N+1

**Problem.** Unit tests mock service per call; batch mapping never verified.

**Cause.** `@GraphQlTest` mocks `CustomerService.findById` not `findByIds`.

**Solution.** Integration test with real batch registry; assert single repository call with `DatasourceProxy`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Testing SDL in prod but not merged test resources | Drift |
| No test for partial errors | Client production bugs |
| `@GraphQlTest` without security imports | False confidence |
| Snapshot entire JSON response | Flaky on timestamps |

### Debugging scenario

**Observe.** CI fails on schema test after merge.

**Diagnose.** Two `.graphqls` define same type differently.

**Fix.** Schema merge test on boot context; lint with graphql-schema-linter in pipeline.

---

## 16. Schema Evolution and Deprecation

### Core concept

GraphQL favors **continuous evolution** over `/v2` URLs. Add fields and types freely; **remove** only after deprecation cycle. Clients use introspection or codegen — breaking changes hurt more than REST if mobile apps lag.

### Safe changes

| Change | Safe? |
|---|---|
| Add optional field | Yes |
| Add optional argument with default | Yes |
| Add new type | Yes |
| Add ` @deprecated(reason: "...")` field | Yes |
| Remove field | No — deprecate first |
| Change field type | No |
| Add required argument | Breaking |
| Make nullable → non-null | Breaking if null exists |

### Deprecation workflow

```graphql
type User {
    fullName: String @deprecated(reason: "Use displayName")
    displayName: String!
}
```

Track usage via metrics on deprecated field resolution count; remove when zero for N releases.

### Versioning strategies

1. **Single evolving schema** (most common) + deprecation discipline.
2. **Separate graphs** (`/graphql/storefront` vs `/graphql/admin`) — different SDL files, different security.
3. **Federation** subgraphs version independently with composition checks (see section 17).

### Production scenario: Mobile crash after "harmless" schema change

**Problem.** Old app versions crash on unknown enum value.

**Cause.** Server added `OrderStatus.PROCESSING`; old iOS codegen treats unknown enum as fatal.

**Solution.** Never add enum values without client coordination; or use `String` + validation; feature flag rollout.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Removing field without deprecation | Old clients break silently |
| Renaming field (same as remove+add) | Same |
| No schema registry CI check | Breaking change merges Friday 5pm |
| Changing scalar serialization format | Parsed wrong in clients |

### Debugging scenario

**Observe.** Client codegen fails in CI.

**Diagnose.** Non-null added to input type field clients omit.

**Fix.** Default value; or optional field; communicate in changelog.

---

## 17. Federation Brief (Apollo / Spring GraphQL)

### Core concept

**GraphQL Federation** splits one **supergraph** into **subgraphs** each owning part of the schema. An **router/gateway** (Apollo Router, GraphQL Mesh, Spring GraphQL federation support evolving) plans query execution across services. `@key` directives link entities across subgraphs.

Spring for GraphQL can act as a **subgraph** via federation support packages (spring-graphql federation module) — check version alignment with Boot 3.2+.

### Federation primitives

```graphql
# products subgraph
type Product @key(fields: "id") {
    id: ID!
    name: String!
}

# reviews subgraph
extend type Product @key(fields: "id") {
    id: ID! @external
    reviews: [Review!]!
}
```

Gateway query plan:

```
Query plan:
  Fetch Product from products service
  Fetch reviews(Product.id) from reviews service
```

### Operational concerns

- **N+1 across services** — gateway batching (`@requires` / `@provides`) or dedicated BFF aggregation.
- **Schema composition CI** — `rover subgraph check` before deploy.
- **Latency** — deep federated queries = multiple network hops; set timeouts per subgraph.
- **Ownership** — each team publishes subgraph; breaking `@key` breaks graph.

### When not to federate

<5 services, single team → **monolith GraphQL** or **BFF** simpler. Federation pays at org scale with clear domain boundaries.

### Production scenario: Entity key mismatch

**Problem.** `Product.reviews` always null in gateway.

**Cause.** Reviews subgraph `@key(fields: "id")` but products expose `sku` as logical id; reference resolution fails.

**Solution.** Align `@key` fields; integration test `_entities` representation query in CI.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Circular `@requires` | Composition failure |
| Subgraph returns fields owned by another | Overwrites / composition error |
| No distributed tracing across subgraph calls | Blind latency |
| Federation for 2 services | Operational tax without benefit |

### Debugging scenario

**Observe.** Gateway returns `SUBGRAPH_ERRORS` extensions.

**Diagnose.** Router logs show which subgraph failed; often timeout on one hop.

**Fix.** Per-subgraph circuit breaker; fallback nullable fields; reduce query depth at gateway.

---

## 18. Performance Tuning and Production SLOs

### Core concept

GraphQL performance = **resolver efficiency** + **query governance** + **infra** (pool sizes, timeouts). Target SLOs per **operation name**, not generic `/graphql` p99.

### Tuning checklist

1. **DataLoader everywhere** lists touch associations.
2. **Complexity/depth limits** enforced.
3. **Pagination caps** on all lists.
4. **DTO/projections** — do not hydrate full entity graphs.
5. **Read replicas** for heavy queries; mutations to primary.
6. **Virtual threads** (Boot 3.2 servlet) for blocking JDBC resolvers.
7. **Prepared queries** for hot paths — optional SQL side.
8. **Avoid `Mono.fromCallable` chains** without subscribeOn on WebFlux when blocking.

### JDBC connection pool

GraphQL multiplies concurrent resolver calls. Size pool:

```
pool >= tomcat threads (or expected concurrent resolver JDBC calls)
```

With async parallel fields, same request may hold multiple connections briefly — pool math differs from REST one-query-per-request.

### Query whitelisting for hot mobile path

Pre-parse and cache execution plan for top 10 query hashes — saves parse/validate CPU.

### Production scenario: p99 2s → 200ms

**Problem.** Leadership mandates fix without hardware.

**Cause.** 40 fields resolved serially each calling HTTP inventory service.

**Solution.** Batch inventory API; `@BatchMapping`; parallel async fetcher returning `CompletableFuture`; cache inventory 30s.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| GraphQL on same DB pool as batch jobs | Pool starvation |
| No timeout on downstream in resolver | Cascading hangs |
| Returning 10MB JSON trees | GC pauses |
| Synchronous HTTP between 5 services in one query | Latency sum |

### Debugging scenario

**Observe.** CPU low, latency high.

**Diagnose.** Thread dump blocked on external HTTP; or DB lock wait.

**Fix.** Timeouts; circuit breaker; read-only transaction for queries; index missing on join table.

---

## 19. Migration from REST to GraphQL

### Core concept

Successful migrations are **incremental**: GraphQL as **BFF layer** in front of existing REST services (resolver calls RestClient/WebClient) before rewriting persistence. Big-bang "delete REST" strands partners and breaks HTTP caching for simple reads.

### Phased approach

```
Phase 1: GraphQL facade → existing REST microservices (Strangler Fig)
Phase 2: Move hot resolvers to local DB with DataLoader
Phase 3: Deprecate redundant REST for mobile clients only
Phase 4: Keep REST for partners/webhooks/exports indefinitely if needed
```

### Dual-stack operational rules

- One **source of truth** for business rules (domain service), not duplicated in REST controller and resolver.
- OpenAPI + GraphQL schema both in CI; map fields explicitly.
- Auth model identical; do not weaken REST while building GraphQL.

### REST-to-resolver adapter

```java
@SchemaMapping
public Customer customer(Order order) {
    return restClient.get()
        .uri("/api/customers/{id}", order.customerId())
        .retrieve()
        .body(Customer.class);
}
```

Add batch endpoint `/api/customers?ids=` before production load — or N+1 REST instead of N+1 SQL.

### Production scenario: GraphQL slower than REST wrapper

**Problem.** Team claims migration failed.

**Cause.** Resolver calls REST per field; REST was one aggregated `/order-details` endpoint.

**Solution.** Add aggregated backing API or local join fetch; GraphQL does not magically batch HTTP.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Different validation rules REST vs GraphQL | Bug reports "works in app not web" |
| Removing REST before clients migrate | Partner outage |
| GraphQL exposes internal REST errors raw | Leaky abstraction |
| No rollback plan | Feature flag missing |

### Debugging scenario

**Observe.** Traffic split 50/50 REST/GraphQL; incidents only GraphQL.

**Diagnose.** Compare SQL per request; GraphQL missing DataLoader equivalent of REST join.

**Fix.** Parity tests: same fixture data, assert same JSON shape and DB query count bounds.

---

## 20. Anti-Patterns That Ship to Production

### Core concept

These anti-patterns appear in code review post-incident. Recognize them in design reviews before deploy.

### Anti-pattern catalog

| Anti-pattern | Why it hurts |
|---|---|
| **GraphQL as generic DB query language** | Clients write 15-level queries; no domain boundary |
| **God Query `everything { ... }`** | Single resolver returning map of everything |
| **`JSON` scalar for unstructured blobs** | No schema evolution; no field-level auth |
| **Exposing JPA entities directly** | Lazy load, cycles, `@JsonIgnore` fights GraphQL |
| **Resolver logic duplicated from service layer** | Drift; untested paths |
| **Microservice GraphQL chains** | Latency, failure multiplication |
| **No operation naming** | Unobservable production |
| **Security by obscurity** (hide mutations) | Introspection / guessable names |
| **Synchronous mutations doing async work** | Timeouts + duplicate side effects |
| **Caching authenticated responses at CDN** | Data leaks |
| **Lists without max size** | OOM |
| **Using GraphQL for file upload primary** | Use REST/S3 presigned; `@deprecated` multipart spec |
| **Ignoring mutation idempotency** | Double writes on retry |
| **Field resolver calling slow ML model** | p99 disaster — precompute or separate service |
| **Federation on day one** | Team not ready for composition ops |

### Production scenario: `JSON metadata` field on Order

**Problem.** Cannot add field-level auth; metadata keys unbounded; clients depend on random keys.

**Cause.** Shortcut scalar instead of typed `OrderMetadata`.

**Solution.** Schema typed fields; version metadata via separate type; migrate clients.

### Common misconfigurations and symptoms

| Anti-pattern signal | Symptom |
|---|---|
| Resolver > 100 LOC | Untestable; mixed concerns |
| `@SchemaMapping` calls other GraphQL endpoints | Network hairball |
| Test coverage only on Query not Mutation | Production breaks on write path |
| GraphQL error messages with SQL | Security audit finding |

### Debugging scenario

**Observe.** "Just one more nested field" request weekly.

**Diagnose.** Schema lacks product-specific views; clients exploit flexible graph.

**Fix.** Introduce `OrderForCheckout` type; complexity cost high on generic `Order`; governance review.

---

## 21. Production Debugging Playbook

When GraphQL is slow or wrong, classify **before** blaming the database.

1. **Identify operation.** Require `operationName` or map persisted query hash. Log variables (redacted).

2. **Check HTTP vs GraphQL errors.** 401/403 = Spring Security before execution. 200 + `errors` = resolver/validation.

3. **Reproduce with GraphiQL** (staging VPN) using exact document + variables from access log hash.

4. **Count SQL per request.** Datasource-proxy or Hibernate statistics in staging with production-sized fixture.

5. **Inspect DataLoader.** Verify batch methods invoked once per level; log batch sizes.

6. **Review selection set.** Client may over-fetch; compare to what product thinks they requested.

7. **Complexity/depth rejections.** Log calculated cost; tune or fix client query.

8. **Partial nulls.** Walk `errors[].path` — non-null violation vs auth vs downstream timeout.

9. **Subscription issues.** WebSocket handshake, auth token expiry, proxy idle timeout, Redis pub/sub connectivity.

10. **Cross-service federation.** Router trace which subgraph error; check `_service` SDL sync.

11. **Thread dump** (servlet) or **reactor checkpoint** (WebFlux) if hung — blocked JDBC/HTTP in resolver.

12. **Schema drift.** Compare deployed SDL printer output to schema registry expected version.

13. **Client version.** Correlate bad release with spike in specific operation hash.

14. **Rollback lever.** Feature flag to force REST fallback path for critical flows during incident.

15. **Post-incident.** Add integration test with query hash + max SQL count assertion.

---

## 22. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Mobile needs flexible product graph | GraphQL BFF + DataLoader + complexity limits |
| Public cacheable catalog | REST or GET persisted query + CDN; not POST GraphQL |
| Internal service sync calls | gRPC/REST; not federated GraphQL hop |
| JPA/JDBC domain | Servlet GraphQL + virtual threads OR batch fetch in resolvers |
| Reactive R2DBC stack | WebFlux GraphQL + `Mono`/`Flux` resolvers |
| Prevent resolver N+1 | `@BatchMapping` + repository `IN` queries |
| Public API | Disable introspection; auth all fields; rate limit; APQ |
| Real-time order tracking | Subscription + Redis pub/sub; auth on subscribe |
| Schema change | Add optional fields; `@deprecated` before remove; CI breaking check |
| Mutation with payment | Idempotency key + unique constraint + userErrors payload |
| Error handling | `userErrors` for business; resolver handler for unexpected; no stack in extensions |
| Testing resolvers | `@GraphQlTest` + batch verify; security IT with `WebGraphQlTester` |
| Slow `/graphql` p99 | Field timing metrics; operation names; compare SQL count |
| File upload | REST presigned S3; GraphQL for metadata only |
| Org with 10+ teams owning API | Consider federation + composition CI |
| Small monolith team | Single schema; no federation |
| Migrating from REST | Strangler BFF; parity tests; keep REST for partners |
| Observability | Log operation/hash; Micrometer timer; trace downstream calls |
| Enum breaking mobile | Coordinate release; avoid silent enum additions |
| Admin vs storefront API | Separate schema paths or separate apps |
| GraphQL vs REST greenfield CRUD | REST unless multiple client shapes proven |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Your GraphQL API returns HTTP 200 but the mobile app shows a blank screen. Where do you look first?</summary>

Inspect the `errors` array in the GraphQL response — partial data with null parent fields is valid GraphQL. Check client parsing logic (ignores errors), auth failures expressed as GraphQL errors vs HTTP 403, and non-null violations that nulled parent objects. Server-side: log operation name, paths in errors, and extensions codes.

</details>

<details class="qa-item">
<summary>2. A single GraphQL query generates 500 SQL statements. REST equivalent used 3. Explain how this happens and the fix.</summary>

Classic N+1: list field resolved with `@SchemaMapping` per row, each calling `findById` on nested associations. GraphQL executes a resolver per field per list item. Fix: `@BatchMapping` or DataLoader with `findByIdIn`, or SQL join in service returning DTO graph; add query-count integration test.

</details>

<details class="qa-item">
<summary>3. Why disable introspection in production if the schema is "not secret"?</summary>

Introspection enables attackers to map mutations, sensitive fields, and deprecated paths quickly; aids crafting expensive queries and IDOR probes. Security through obscurity is insufficient alone, but introspection plus automated tools lowers attack cost. Combine with auth, complexity limits, and rate limiting.

</details>

<details class="qa-item">
<summary>4. When should mutations return `userErrors` instead of throwing exceptions?</summary>

Expected validation/business rule failures (invalid coupon, out of stock) that clients display inline should be `userErrors` in the mutation payload with HTTP 200. Unexpected failures (DB down, bug) throw and map via `DataFetcherExceptionResolver` to GraphQL errors with sanitized messages. Keeps alerting signal clean.

</details>

<details class="qa-item">
<summary>5. GraphQL vs REST for a public product catalog cached at CDN edge?</summary>

REST GET with cache headers wins — GraphQL POST is not CDN-friendly by default. If GraphQL required, use persisted queries via GET with long TTL for anonymous catalog query only; separate authenticated endpoint with `Cache-Control: private, no-store`.

</details>

<details class="qa-item">
<summary>6. How do you enforce field-level authorization in Spring for GraphQL?</summary>

Do not rely on HTTP auth alone. Enforce in service layer (`@PreAuthorize`) invoked by every resolver, or schema `@auth` directives wired in `RuntimeWiringConfigurer`, or explicit checks in `@SchemaMapping` for sensitive scalars. Entry-point check on `order(id)` is not enough for nested fields.

</details>

<details class="qa-item">
<summary>7. Explain DataLoader request scope and what goes wrong with a singleton cache.</summary>

DataLoader batches loads within one GraphQL execution and caches results for that request only. Singleton cache across HTTP requests serves stale data across users/tenants and causes memory leaks. Spring registers loaders per request via `BatchLoaderRegistry`.

</details>

<details class="qa-item">
<summary>8. Client sends unnamed query with 12-level nesting. DB melts. Two controls you implement this week?</summary>

(1) `MaxQueryDepthInstrumentation` and `MaxQueryComplexityInstrumentation` with list multipliers. (2) Persisted query allow-list for mobile plus `first` caps on all connections. Log rejected query hashes for product follow-up.

</details>

<details class="qa-item">
<summary>9. `@GraphQlTest` passes but production has N+1. Why?</summary>

Unit tests mock `findById` per call instead of verifying batch `findByIds` invoked once. Slice tests do not catch missing `@BatchMapping`. Fix: integration test with `@SpringBootTest`, real `BatchLoaderRegistry`, and datasource-proxy query count assertion.

</details>

<details class="qa-item">
<summary>10. Order mutation timed out at gateway; user charged twice. Root cause and fix?</summary>

Client retried POST on 504; mutation not idempotent; GraphQL may return 200 on partial errors confusing client. Fix: required `idempotencyKey`, store outcome in Redis, unique business constraint on payment reference, return same payload on replay.

</details>

<details class="qa-item">
<summary>11. WebFlux GraphQL: event loop blocked despite `Mono` return types. Cause?</summary>

Resolver calls `.block()` or JDBC/JPA directly on reactive thread, or `Mono.fromCallable` without `subscribeOn(boundedElastic)`. Fix: true R2DBC reactive chain or offload blocking to bounded elastic with strict pool limits; prefer servlet + virtual threads if mostly blocking.

</details>

<details class="qa-item">
<summary>12. How do partial results interact with non-null fields (`String!`)?</summary>

If a non-null field resolver returns null or throws, GraphQL bubbles error to parent; parent may become null despite siblings resolving. Clients lose whole branches. Use nullable fields when absence is valid; use `userErrors` for business failures instead of nulling required domain fields.

</details>

<details class="qa-item">
<summary>13. Federation: `Product.reviews` null in gateway but reviews subgraph works standalone. Likely cause?</summary>

Entity `@key` mismatch — gateway passes `{ __typename: Product, id: X }` but subgraphs disagree on key field or type extension. Reference resolution fails silently or returns null. Fix: align `@key(fields)`, run composition check in CI, test `_entities` query.

</details>

<details class="qa-item">
<summary>14. What is the difference between query depth and query complexity limits?</summary>

Depth counts nesting levels (prevent `a { b { c { ... }}}`). Complexity assigns weighted cost (lists multiply by child cost, expensive fields weighted higher). Depth alone misses wide queries (`orders { items { product { ... } } }` × 1000). Use both.

</details>

<details class="qa-item">
<summary>15. Should internal microservices communicate via GraphQL?</summary>

Generally no — prefer gRPC or REST with stable contracts. GraphQL between services loses HTTP caching, adds resolver overhead, and couples schemas. GraphQL belongs at edge/BFF facing clients; internal stays RPC/REST unless strong reason.

</details>

<details class="qa-item">
<summary>16. How do you safely evolve schema when mobile clients lag 6 months?</summary>

Add only optional fields and types; never remove/rename without `@deprecated` cycle; avoid new enum values without app coordination; use schema registry CI for breaking detection; track deprecated field usage metrics before removal.

</details>

<details class="qa-item">
<summary>17. Subscription stops after 60 seconds behind ALB. Fix?</summary>

WebSocket idle timeout shorter than client/server ping interval. Configure GraphQL WebSocket keep-alive/ping; raise ALB idle timeout; verify proxy WebSocket upgrade headers end-to-end.

</details>

<details class="qa-item">
<summary>18. REST endpoint `GET /orders/{id}` is cached; GraphQL always hits DB. Why?</summary>

GraphQL typically POST `/graphql` — no HTTP cache; each field resolver may call service/DB independently. Mitigate: application cache in DataLoader, persisted GET queries for hot reads, or dedicated read-optimized resolver using single SQL.

</details>

<details class="qa-item">
<summary>19. Pen test finds CSRF on GraphQL with cookie session auth. Mitigation?</summary>

Enable CSRF for cookie-based apps (`http.csrf` in Spring Security); use SameSite cookies; prefer Bearer tokens for SPA; validate `Origin` header on `/graphql` POST; separate API auth model from browser session where possible.

</details>

<details class="qa-item">
<summary>20. When is `@BatchMapping` insufficient and you need a custom DataLoader?</summary>

When batch load keys are not the parent source object (load by foreign key UUID), when cache key differs from batch key, when loading across multiple types with shared cache, or when integrating non-Spring async batch APIs. Register via `BatchLoaderRegistry` / `DataLoaderRegistrar`.

</details>

<details class="qa-item">
<summary>21. GraphQL migration: team wants to delete all REST day one. Risk?</summary>

Partner integrations, webhooks, CDN-cached pages, ops tooling, and rollback path lost. Strangler pattern: GraphQL BFF for mobile first; parity tests; REST deprecated per client cohort; keep REST for exports and simple cacheable reads indefinitely if needed.

</details>

<details class="qa-item">
<summary>22. How do you test that auth prevents IDOR on nested `order { customer { ssn } }`?</summary>

`WebGraphQlTester` with JWT user A querying order owned by B; expect GraphQL error or null customer with auth extension; verify service layer throws `AccessDeniedException`. Do not test only top-level `order(id)` query auth.

</details>

<details class="qa-item">
<summary>23. Operation name missing in logs — how do you identify bad queries in prod?</summary>

Hash the document server-side; maintain APQ registry mapping hash → name; require clients send `operationName`; log hash in access logs. Alert on top hashes by latency and error rate.

</details>

<details class="qa-item">
<summary>24. Custom scalar `DateTime` parses differently in two services in federation. Symptom?</summary>

Composition may succeed but runtime coercion errors on `_entities` fields; partial null graph. Fix: shared scalar library; schema registry; contract test on scalar serialization round-trip.

</details>

<details class="qa-item">
<summary>25. Is GraphQL a good fit for reporting/export of 100k rows?</summary>

No — GraphQL list fields risk OOM and timeout; use REST/CSV export, cursor streaming async job, or dedicated report API. GraphQL connections should cap `first` (e.g., 100) and reject report-scale queries via complexity limits.

</details>

---

*GraphQL with Spring looks elegant because one endpoint returns exactly what clients ask for. Production pain arrives when what they ask for is unbounded — resolver N+1, missing auth on nested fields, POST bodies that bypass CDN cache, and 200 OK responses hiding errors in JSON. Govern queries, batch loads, authorize every field path, and treat the schema as a versioned public contract — not a database escape hatch.*
