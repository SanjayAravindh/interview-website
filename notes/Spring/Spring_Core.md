# Spring Core Mastery — Complete Course (Parts 1–25)

---



## Table of Contents

1. [Part 1: Spring Philosophy & IoC Fundamentals](#part-1-spring-philosophy-ioc-fundamentals)
2. [Part 2: BeanFactory vs ApplicationContext](#part-2-beanfactory-vs-applicationcontext)
3. [Part 3: Configuration Metadata — XML, Annotation, and Java Config Compared](#part-3-configuration-metadata-xml-annotation-and-java-config-compared)
4. [Part 4: Dependency Injection Types — Constructor, Setter, and Field Injection](#part-4-dependency-injection-types-constructor-setter-and-field-injection)
5. [Part 5: Autowiring & Ambiguity Resolution](#part-5-autowiring-ambiguity-resolution)
6. [Part 6: Bean Scopes](#part-6-bean-scopes)
7. [Part 7: Bean Lifecycle](#part-7-bean-lifecycle)
8. [Part 8: BeanPostProcessor & BeanFactoryPostProcessor](#part-8-beanpostprocessor-beanfactorypostprocessor)
9. [Part 9: Circular Dependencies](#part-9-circular-dependencies)
10. [Part 10: Component Scanning](#part-10-component-scanning)
11. [Part 11: Java Config Deep Dive](#part-11-java-config-deep-dive)
12. [Part 12: Environment Abstraction — Profiles, PropertySources, `@Value`](#part-12-environment-abstraction-profiles-propertysources-value)
13. [Part 13: SpEL (Spring Expression Language)](#part-13-spel-spring-expression-language)
14. [Part 14: Resource Abstraction](#part-14-resource-abstraction)
15. [Part 15: Application Events](#part-15-application-events)
16. [Part 16: AOP Concepts — Proxies, JDK Dynamic Proxy vs CGLIB](#part-16-aop-concepts-proxies-jdk-dynamic-proxy-vs-cglib)
17. [Part 17: AOP Implementation — `@Aspect`, Pointcut Expressions, Advice Types](#part-17-aop-implementation-aspect-pointcut-expressions-advice-types)
18. [Part 18: AOP Internals & Pitfalls — Self-Invocation, Proxy Limitations](#part-18-aop-internals-pitfalls-self-invocation-proxy-limitations)
19. [Part 19: Type Conversion & Data Binding](#part-19-type-conversion-data-binding)
20. [Part 20: Validation](#part-20-validation)
21. [Part 21: Task Execution & Scheduling](#part-21-task-execution-scheduling)
22. [Part 22: FactoryBean & Advanced Bean Creation](#part-22-factorybean-advanced-bean-creation)
23. [Part 23: ApplicationContext Hierarchies](#part-23-applicationcontext-hierarchies)
24. [Part 24: Testing Spring Applications](#part-24-testing-spring-applications)
25. [Part 25: Production/Debugging Capstone — Synthesizing Everything](#part-25-productiondebugging-capstone-synthesizing-everything)

---

# Part 1: Spring Philosophy & IoC Fundamentals

## Why Spring exists

Before Spring (early 2000s), Java EE apps were dominated by EJB 2.x — heavyweight, required implementing container-specific interfaces, hard to unit test (needed an app server just to instantiate an object). Rod Johnson's *Expert One-on-One J2EE Design and Development* (2002) argued you could build enterprise apps with **plain old Java objects (POJOs)** if you had a lightweight container managing object creation and wiring. That became Spring.

The core insight: **separate "what an object needs" from "how it gets it."** A class declares its dependencies (via constructor/setter), and something external supplies them. That's Inversion of Control.

## Inversion of Control (IoC) vs Dependency Injection (DI)

These terms get used interchangeably but aren't identical:

- **IoC** is the broader principle: control over object creation/flow is inverted — the framework calls your code, not the other way around (compare: in a library, *you* call functions; in a framework, *it* calls *you*). Template Method pattern, event listeners, and DI are all forms of IoC.
- **DI** is the specific technique Spring uses to implement IoC for object wiring: an external assembler (the container) constructs objects and injects their dependencies.

```java
// Without DI — the class controls its own dependency creation
class OrderService {
    private PaymentGateway gateway = new StripeGateway(); // tightly coupled
}

// With DI — dependency is handed in from outside
class OrderService {
    private final PaymentGateway gateway;
    OrderService(PaymentGateway gateway) { // control inverted
        this.gateway = gateway;
    }
}
```

The `OrderService` no longer decides *which* `PaymentGateway` implementation it gets — that decision moved outward, to whoever assembles the object graph (the Spring container, or in a test, you directly).

## The core container: BeanFactory

At the root of everything is `BeanFactory` — the most basic container interface. It knows how to:
- Read bean definitions (metadata: class, dependencies, scope, lifecycle callbacks)
- Instantiate beans
- Wire dependencies between them
- Manage bean lifecycle

`ApplicationContext` (covered in depth in Part 2) is a sub-interface that adds enterprise features — event publishing, internationalization, AOP integration, environment abstraction. In practice you almost always use `ApplicationContext`; `BeanFactory` is the foundational contract underneath it.

## A bean, defined precisely

A "bean" is just an object instantiated, assembled, and managed by the Spring IoC container. What makes it a "bean" rather than a plain object you `new`'d yourself is that its **lifecycle and wiring are externalized** into a `BeanDefinition` — metadata describing the class, constructor args, property values, scope, and lifecycle callbacks. The container reads this metadata (from XML, annotations, or Java config) and does the construction for you.

## Why this matters for testability

```java
// Tightly coupled — can't test OrderService without a real Stripe connection
class OrderService {
    private PaymentGateway gateway = new StripeGateway();
}

// Loosely coupled — inject a mock in tests, real impl in production
class OrderService {
    OrderService(PaymentGateway gateway) { this.gateway = gateway; }
}

@Test
void testOrder() {
    OrderService service = new OrderService(new FakePaymentGateway());
    // no Spring container needed at all for this unit test
}
```

Notice: DI as a *pattern* doesn't require Spring. Spring's value-add is automating the wiring at scale.

## Production scenario: the "god constructor" smell

A constructor with 14 injected dependencies works — Spring will happily wire it — but it's a design smell IoC exposes rather than hides: constructor injection makes coupling visible. The fix is decomposing the class into smaller collaborators, not switching to field injection to hide the problem.

## Debugging scenario: `NoSuchBeanDefinitionException`

**Diagnosis approach (Observe → Diagnose → Mitigate → Fix):**
- **Observe:** Read the full stack trace — which bean's constructor/field is requesting the missing type?
- **Diagnose:** Common causes: not annotated as a component; outside the component-scan base package; conditionally registered and condition unmet.
- **Mitigate:** Roll back if this surfaces post-deploy.
- **Fix:** Correct the scan path/annotation/condition.

# Part 2: BeanFactory vs ApplicationContext

## The interface hierarchy

```
BeanFactory (root interface)
   ├── ListableBeanFactory
   ├── HierarchicalBeanFactory
   └── AutowireCapableBeanFactory

ApplicationContext extends: ListableBeanFactory, HierarchicalBeanFactory,
                             MessageSource, ApplicationEventPublisher,
                             ResourcePatternResolver, EnvironmentCapable
```

Most `ApplicationContext` implementations hold a `DefaultListableBeanFactory` internally and delegate to it.

## Concrete implementations

| Class | Config source | Typical use |
|---|---|---|
| `ClassPathXmlApplicationContext` | XML on classpath | Legacy Spring apps |
| `FileSystemXmlApplicationContext` | XML on filesystem | Legacy |
| `AnnotationConfigApplicationContext` | `@Configuration` classes | Modern non-Boot Spring |
| `AnnotationConfigServletWebServerApplicationContext` | Config + embedded servlet container | Spring Boot web apps |
| `GenericApplicationContext` | Programmatic | Testing, dynamic registration |

## Key behavioral differences

**1. Lazy vs eager instantiation** — `BeanFactory` is lazy; `ApplicationContext` eagerly instantiates all singletons at startup unless marked lazy. This is deliberate: fail fast.

**2. Automatic BeanPostProcessor/BeanFactoryPostProcessor registration** — `ApplicationContext` auto-detects these; raw `BeanFactory` needs manual registration. This is why `@Autowired`, `@Transactional`, `${...}` "just work."

**3. i18n, events, resource loading** — only `ApplicationContext` implements `MessageSource`, `ApplicationEventPublisher`, `ResourcePatternResolver`.

## Why always use ApplicationContext

`BeanFactory` remains relevant only as the SPI underneath, and as a teaching device.

## Production scenario: startup time regression from eager instantiation

A new `@Component` wrapping a third-party SDK does slow synchronous I/O in its constructor/`@PostConstruct`, and because `ApplicationContext` eagerly instantiates singletons, startup time jumps. Diagnose via Boot's `ApplicationStartup`/actuator `/actuator/startup`, or bisect by marking the bean `@Lazy`. Fix: move slow I/O out of construction.

## Debugging scenario: `@Autowired` field null when object is manually `new`'d

`@Autowired` is processed by `AutowiredAnnotationBeanPostProcessor`, which only runs on container-instantiated objects. `new ReportScheduler()` bypasses the container entirely. Fix: let Spring manage it, or use `AutowireCapableBeanFactory.autowireBean()`.

# Part 3: Configuration Metadata — XML, Annotation, and Java Config Compared

## Style 1: XML configuration

```xml
<beans xmlns="http://www.springframework.org/schema/beans" ...>
    <bean id="paymentGateway" class="com.acme.StripeGateway">
        <property name="apiKey" value="${stripe.api.key}"/>
    </bean>
    <bean id="orderService" class="com.acme.OrderService">
        <constructor-arg ref="paymentGateway"/>
    </bean>
    <context:component-scan base-package="com.acme.services"/>
</beans>
```
Verbose, no compile-time safety, still shows up in legacy enterprise systems.

## Style 2: Annotation-based (component scanning)

```java
@Service
public class OrderService {
    private final PaymentGateway gateway;
    @Autowired
    public OrderService(PaymentGateway gateway) { this.gateway = gateway; }
}
@Component
public class StripeGateway implements PaymentGateway { }
```
```java
@Configuration
@ComponentScan(basePackages = "com.acme.services")
public class AppConfig { }
```

## Style 3: Java-based configuration

```java
@Configuration
public class AppConfig {
    @Bean
    public PaymentGateway paymentGateway(@Value("${stripe.api.key}") String apiKey) {
        return new StripeGateway(apiKey);
    }
    @Bean
    public OrderService orderService(PaymentGateway gateway) {
        return new OrderService(gateway);
    }
}
```
Full programmatic control; this is the style Boot's own auto-configuration is built on.

## `@Component` vs `@Bean`

| | `@Component` | `@Bean` |
|---|---|---|
| Applies to | A class you own | A method, typically for classes you don't own |
| Discovery | Component scanning | Explicit declaration |
| Use case | Your own classes | Third-party library classes |

## `@Configuration` internals: CGLIB proxying

By default, `@Configuration` classes are CGLIB-proxied (`proxyBeanMethods = true`) so that calling one `@Bean` method from another returns the cached singleton instead of creating a duplicate. Disabling it (`proxyBeanMethods = false`, common in Boot's own auto-config for startup performance) means direct `@Bean`-method-to-`@Bean`-method calls silently create duplicate instances — the safe pattern is injecting dependencies as method parameters instead.

```java
@Configuration(proxyBeanMethods = false)
public class AppConfig {
    @Bean
    public PaymentGateway paymentGateway() { return new StripeGateway(); }
    @Bean
    public OrderService orderService(PaymentGateway gateway) { // injected, not called directly
        return new OrderService(gateway);
    }
}
```

## Mixing styles

```java
@Configuration
@ImportResource("classpath:legacy-beans.xml")
@ComponentScan("com.acme")
public class AppConfig {
    @Bean
    public ObjectMapper objectMapper() { ... }
}
```
Common mid-migration.

## Production scenario: silent duplicate bean creation after disabling proxyBeanMethods

Doubling a `HikariDataSource` because one `@Bean` method called another directly after `proxyBeanMethods = false` was applied globally. Fix: inject as parameters instead of calling methods directly.

## Debugging scenario: bean defined in both XML and annotation config

`BeanDefinitionStoreException` from a leftover XML `<bean id="dataSource">` still imported alongside a new `@Bean` of the same name. Boot disallows overriding by default since 2.1 specifically to catch this.

# Part 4: Dependency Injection Types — Constructor, Setter, and Field Injection

## The three mechanisms

Constructor, setter, and field injection all achieve the same wiring but differ in guarantees.

## Constructor injection — the recommended default

1. **Immutability** — only constructor injection allows `final` fields.
2. **Guaranteed non-null state** — the object can't exist half-wired.
3. **Testability without a container** — plain `new` works.
4. **Circular dependency detection** — fails fast at startup (Part 9).
5. **Signals design intent** — a huge constructor is a visible smell.

## Setter injection — for optional dependencies

```java
@Service
public class NotificationService {
    private SmsService smsService;
    @Autowired(required = false)
    public void setSmsService(SmsService smsService) { this.smsService = smsService; }
}
```

## Field injection — discouraged

No immutability, hides dependencies, harder to unit test, can silently mask circular dependencies.

## `@Autowired` becomes implicit with a single constructor

Since Spring 4.3, a class with exactly one constructor doesn't need `@Autowired` on it explicitly.

## Lombok interaction

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final PaymentGateway gateway;
    private final InventoryService inventory;
}
```

## Production scenario: field injection masking a missing dependency in production only

A missing bean combined with defensive `required = false` usage converted a startup failure into a runtime NPE under specific traffic. Fix: constructor injection, and reserve optional injection (`ObjectProvider`) for genuinely optional dependencies.

## Debugging scenario: `UnsatisfiedDependencyException` only in test context

A constructor gained a new parameter but the test's mock setup wasn't updated — constructor injection surfaces this precisely (parameter index named in the exception).

# Part 5: Autowiring & Ambiguity Resolution

## Resolution order

1. By type.
2. If zero matches → `NoSuchBeanDefinitionException` (unless optional).
3. If multiple matches → `@Qualifier`/`@Primary`.
4. Still ambiguous → match injection-point name against bean name.
5. Still ambiguous → `NoUniqueBeanDefinitionException`.

## `@Qualifier`

```java
@Component("stripeGateway")
public class StripeGateway implements PaymentGateway { }
@Component("paypalGateway")
public class PaypalGateway implements PaymentGateway { }

@Service
public class OrderService {
    public OrderService(@Qualifier("stripeGateway") PaymentGateway gateway) { ... }
}
```
Custom qualifier annotations avoid magic-string typos.

## `@Primary`

Sets a default winner among multiple candidates; doesn't prevent explicit `@Qualifier` overrides elsewhere.

## `@Resource` — name-first resolution

Resolves by name first, falling back to type — the inverse of `@Autowired`+`@Qualifier`. More common in older/portable code.

## Autowiring collections

```java
@Service
public class NotificationDispatcher {
    private final List<NotificationChannel> channels;
    public NotificationDispatcher(List<NotificationChannel> channels) { this.channels = channels; }
}
```
Spring injects every matching bean; ordering controllable via `@Order`. A `Map<String, T>` keys by bean name.

## Production scenario: `@Primary` silently swallowing a real bug

A stray test-support `@Component` with no `@Primary` created latent ambiguity that autowiring's name-fallback rule inconsistently papered over, causing a failure to "appear from nowhere" after an unrelated refactor.

## Debugging scenario: `@Qualifier` typo compiles but fails at runtime

A misspelled qualifier name eliminates nothing, leaving full ambiguity and a `NoUniqueBeanDefinitionException` despite the qualifier being present.

# Part 6: Bean Scopes

## Built-in scopes

| Scope | Lifetime |
|---|---|
| `singleton` (default) | One per container |
| `prototype` | New instance every lookup/injection |
| `request` / `session` / `application` / `websocket` | Web-aware contexts only |

## `singleton` — what it guarantees

One instance per `ApplicationContext`, not per JVM. Singleton beans must be stateless or thread-safe, since they're shared across every concurrent thread.

## `prototype` — incomplete lifecycle management

The container manages creation/initialization but **not destruction** — no `@PreDestroy` callback ever fires.

## The scope mismatch problem

Injecting a `prototype` bean as a plain field into a `singleton` resolves it exactly once, defeating the purpose. Fixes:
1. Lookup via `ApplicationContext` directly.
2. `ObjectProvider<T>.getObject()` per use — the modern recommended approach.
3. Scoped proxy (`proxyMode = ScopedProxyMode.TARGET_CLASS`).

## Request/session scope

```java
@Component
@Scope(value = WebApplicationContext.SCOPE_REQUEST, proxyMode = ScopedProxyMode.TARGET_CLASS)
public class RequestAuditContext { }
```

## Production scenario: thread-safety bug from misapplied singleton state

A mutable `HashMap` field on a default-singleton `@Service` caused intermittent wrong tax amounts under concurrent load. Fix: request-scoped state, `ConcurrentHashMap`, or a real caching abstraction.

## Debugging scenario: `@PreDestroy` never firing on a prototype bean

File-descriptor leak from assuming prototype beans get full managed lifecycle. Fix: don't rely on `@PreDestroy` for prototype cleanup — use try-with-resources instead.

# Part 7: Bean Lifecycle

## The full pipeline, in order

```
1. Instantiation (constructor)
2. Populate properties (setter/field injection)
3. BeanNameAware.setBeanName()
4. BeanFactoryAware.setBeanFactory()
5. ApplicationContextAware.setApplicationContext()
6. BeanPostProcessor.postProcessBeforeInitialization()
7. @PostConstruct / InitializingBean.afterPropertiesSet() / init-method
8. BeanPostProcessor.postProcessAfterInitialization()
   ── bean ready ──
9. (bean lives)
   ── shutdown ──
10. @PreDestroy / DisposableBean.destroy() / destroy-method
```

Constructor injection happens during step 1; setter/field injection happens in step 2. `Aware` interfaces run before `@PostConstruct`. AOP proxies are created in `postProcessAfterInitialization`, after `@PostConstruct` — which is why self-invoked `@Transactional` calls from `@PostConstruct` don't get proxied.

## Three initialization/destruction hooks

`@PostConstruct`/`@PreDestroy` (recommended, framework-agnostic) vs `InitializingBean`/`DisposableBean` (Spring-coupled) vs `initMethod`/`destroyMethod` (for classes you don't own). Boot auto-detects `close()`/`shutdown()` methods as inferred destroy methods.

## Shutdown ordering and SIGTERM

Kubernetes sends `SIGTERM`, waits a grace period, then `SIGKILL`. If shutdown logic takes longer than the grace period, cleanup gets killed mid-flight.

## Production scenario: connection pool not draining on shutdown

Rolling deploys caused brief spikes of "Connection is closed" errors because the datasource closed before in-flight requests finished. Fix: enable Spring Boot graceful shutdown (`server.shutdown=graceful`).

## Debugging scenario: `@Transactional` silently not applying inside `@PostConstruct`

Calling a `@Transactional` method on `this` from `@PostConstruct` runs it unproxied — the proxy doesn't exist yet at that lifecycle point. Fix: use `ApplicationListener<ContextRefreshedEvent>` or `ApplicationRunner` instead, injecting the bean from outside.

# Part 8: BeanPostProcessor & BeanFactoryPostProcessor

## The distinction

| | `BeanFactoryPostProcessor` | `BeanPostProcessor` |
|---|---|---|
| Operates on | Bean definitions (metadata) | Bean instances |
| Runs | Once, before any bean instantiated | Once per bean, during its lifecycle |

`PropertySourcesPlaceholderConfigurer` (resolves `${...}`) is a `BeanFactoryPostProcessor`. `AnnotationAwareAspectJAutoProxyCreator` (implements `@Transactional`/`@Async`/etc via proxying) is a `BeanPostProcessor` running in `postProcessAfterInitialization`.

```java
public class LoggingBeanPostProcessor implements BeanPostProcessor {
    public Object postProcessBeforeInitialization(Object bean, String beanName) { return bean; }
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (bean instanceof PaymentGateway) { return Proxy.newProxyInstance(...); }
        return bean;
    }
}
```

## Registration and ordering

Registered as regular beans; ordering via `@Order`/`Ordered`/`PriorityOrdered`.

## Gotcha: BeanPostProcessor beans must be simple

Instantiated very early — their own dependencies may not be fully post-processed. Prefer `ObjectProvider`/lazy resolution for a processor's own dependencies.

## Production scenario: custom BeanPostProcessor causing "not eligible" warnings

Eagerly injecting `MeterRegistry` into a custom processor forced it to instantiate too early to receive its own post-processing. Fix: resolve lazily via `ObjectProvider` at use-time.

## Debugging scenario: `@Transactional` works on some beans, not others

A `final` class or `final`/`private` method can't be CGLIB-proxied — Spring silently skips proxying, no error. Fix: remove `final`, or restructure into a proxyable collaborator.

# Part 9: Circular Dependencies

## The problem

Two beans each requiring the other via their constructors can't be built — neither can complete first.

## The three-level cache (field/setter injection)

1. **singletonObjects** — fully initialized singletons.
2. **earlySingletonObjects** — raw, not-yet-initialized instances.
3. **singletonFactories** — factories producing early references.

An early (raw) reference to a bean-in-progress is handed to the other bean; because both share the same object identity, later field population is visible to whichever bean grabbed the early reference.

## Why constructor injection can't use this trick

No object exists at all until the constructor (which itself needs the other bean) completes — there's no valid halfway point. Spring throws `BeanCurrentlyInCreationException`. This is intentional — a design forcing function.

## Fixes, ranked

1. **Redesign** — extract a shared collaborator class (best).
2. **`@Lazy`** on one side — a legitimate stopgap, defers resolution via a proxy.
3. **Field/setter injection** — worst; silently permits the bad design to persist.

`ObjectProvider` is another legitimate, explicit escape hatch similar to `@Lazy`.

## Production scenario: circular dependency introduced silently by a refactor

CI caught a new `BeanCurrentlyInCreationException` immediately — the good outcome. Real fix: extract a shared `AuditContext`/`SecurityContext` collaborator rather than having the two services depend on each other.

## Debugging scenario: `@Lazy` "fix" causing a subtle later NPE

`@Lazy` converted a loud, immediate startup failure into a quiet, delayed, hard-to-reproduce runtime failure — a strictly worse trade unless redesign genuinely isn't feasible, and even then should be tracked as tech debt.

# Part 10: Component Scanning

## Mechanics

`ClassPathBeanDefinitionScanner` walks the classpath reading bytecode metadata (not loading classes), applies type filters, and registers `BeanDefinition`s for matches.

## Stereotype annotations

`@Component`, `@Service`, `@Repository`, `@Controller`, `@RestController`. `@Service` and `@Component` are functionally identical. `@Repository` has real behavior: `PersistenceExceptionTranslationPostProcessor` translates persistence exceptions into `DataAccessException`.

## Custom stereotypes

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Component
public @interface UseCase { }
```
Common in Clean Architecture-style codebases.

## `@ComponentScan` configuration

```java
@ComponentScan(
    basePackages = "com.acme.services",
    includeFilters = @Filter(type = FilterType.ANNOTATION, classes = UseCase.class),
    excludeFilters = @Filter(type = FilterType.REGEX, pattern = "com\\.acme\\.services\\.legacy\\..*"),
    useDefaultFilters = false
)
```
`@SpringBootApplication` bundles `@ComponentScan` defaulted to its own package — hence the "put the main class at the root package" convention.

## Production scenario: silently missing beans after a package restructure

A typo'd package fell outside the scan root; masked locally by a stale test-support config, caught only by CI. Fix: correct the package, add an ArchUnit-style guard.

## Debugging scenario: duplicate bean names in different packages

Two same-named classes in different packages collide on the default bean name. Fix: explicit bean names; remove the lingering duplicate.

# Part 11: Java Config Deep Dive

## `@Import`

Composes configuration classes; can import plain `@Component`s, `ImportSelector`s, or `ImportBeanDefinitionRegistrar`s. Foundation of Boot's auto-configuration.

## `@Enable*` pattern

Every `@Enable*` annotation wraps `@Import` of configuration classes/selectors registering the needed infrastructure.

## `@Conditional`

```java
@Bean
@Conditional(OnCloudEnvironmentCondition.class)
public MetricsExporter cloudMetricsExporter() { ... }
```
Foundation of `@ConditionalOnProperty`, `@ConditionalOnClass`, `@ConditionalOnBean`/`@ConditionalOnMissingBean`, `@ConditionalOnWebApplication`.

## `@Profile`

Implemented as `@Conditional(ProfileCondition.class)` — not a separate mechanism.

## `@Import` vs `@ComponentScan`

Scan is implicit/broad; Import is explicit/precise. Real codebases use both.

## Production scenario: `@ConditionalOnMissingBean` ordering surprise

A Boot upgrade reordered auto-configuration classes, causing a custom `ObjectMapper` bean to lose the "who registers first" race. Diagnosed via `--debug`'s `ConditionEvaluationReport`. Fix: `@AutoConfigureBefore`.

## Debugging scenario: `@Profile` typo in the active profile string

An unrecognized profile name silently excludes every gated bean, no warning. Fix: correct the typo; add a startup assertion validating active profiles.

# Part 12: Environment Abstraction — Profiles, PropertySources, `@Value`

## `Environment`

Unifies profiles and a merged, prioritized property view.

## Property source precedence (high to low)

1. Command-line args
2. `SPRING_APPLICATION_JSON`
3. Environment variables
4. Profile-specific `application-{profile}.yml`
5. `application.yml` (base)
6. `@PropertySource` files
7. Default properties

A property in multiple sources silently uses the highest-precedence one.

## `@Value`

```java
@Value("${mail.port:25}")
private int port;
```
Resolved via `PropertySourcesPlaceholderConfigurer` (a `BeanFactoryPostProcessor`) — ordering edge cases exist during complex bootstraps.

## `@ConfigurationProperties` — preferred for groups

```java
@ConfigurationProperties(prefix = "mail")
@Validated
public class MailProperties {
    @NotBlank private String host;
    @Min(1) @Max(65535) private int port = 25;
}
```
Type-safe grouping, relaxed binding, startup validation, IDE metadata support.

## Production scenario: a secret leaking via property precedence

A stale plaintext password in `application.yml` was still visible via `/actuator/env` even though the real connection used an env-var-sourced value. Fix: remove the stale value; restrict actuator `/env` exposure.

## Debugging scenario: `@ConfigurationProperties` binding silently fails on a nested list

Lombok's immutable `@Value` (unrelated to Spring's `@Value`) generated no setters, so Boot's relaxed binder silently produced an empty collection. Fix: mutable fields with setters, or `@ConstructorBinding`.

# Part 13: SpEL (Spring Expression Language)

## Where it shows up

`@Value`, `@PreAuthorize`/`@PostAuthorize`, `@Cacheable` key/condition, `@Scheduled(cron = "#{...}")`.

## Syntax essentials

`#{...}` = SpEL; `${...}` = plain placeholder substitution, resolved first. `@beanName`, `#variableName`, `T(...)` static access.

## Power: `@PostAuthorize("returnObject...")`

Only possible because SpEL can reference the method's actual return value.

## Danger: security

Never evaluate SpEL built from unsanitized user input — risk is RCE-class. Use `SimpleEvaluationContext` (restricted) rather than `StandardEvaluationContext` for any dynamic, user-influenced expressions.

## Production scenario: `@Cacheable` cache poisoning from a bad key expression

A key expression omitting user identity caused one user's recommendations to leak to others. Fix: include every dimension the result actually varies by in the key.

## Debugging scenario: `@Value` SpEL parse error at startup

`${...}` substitution happens before SpEL parsing — a malformed resolved property value corrupts the resulting SpEL syntax. Fix: keep SpEL in annotations simple; move branching logic into real Java code.

# Part 14: Resource Abstraction

## The `Resource` interface

Unifies filesystem, classpath, URL, and in-memory content behind one contract. Implementations: `ClassPathResource`, `FileSystemResource`, `UrlResource`, `ByteArrayResource`, `InputStreamResource`, `ServletContextResource`.

## `ResourceLoader` and prefixes

`classpath:`, `file:`. Every `ApplicationContext` is itself a `ResourceLoader`.

## `ResourcePatternResolver` — `classpath:` vs `classpath*:`

`classpath:` finds the first match and stops; `classpath*:` searches every classpath location and aggregates — critical in modular apps where multiple JARs contribute the same relative path.

## Production scenario: `getFile()` working locally, failing in production

`ClassPathResource.getFile()` throws inside a packaged JAR (zip entries aren't real files). Fix: use `getInputStream()` instead — always, for classpath resources that might live in a JAR.

## Debugging scenario: `classpath*:` returning fewer resources after uber-JAR shading

Merging JARs collapses same-path entries into one, so `classpath*:` has nothing distinct left to find. Fix: use Boot's nested-JAR fat-jar format instead of flat merging, or use plugin-specific file names.

# Part 15: Application Events

## Built-in pub/sub

`ApplicationContext` implements `ApplicationEventPublisher` — free, in-process, synchronous-by-default event bus.

## Modern pattern: `@EventListener`

```java
@Component
public class InventoryListener {
    @EventListener
    public void onOrderPlaced(OrderPlacedEvent event) { reserveStock(event.getOrder()); }

    @EventListener(condition = "#event.order.total > 1000")
    public void flagHighValueOrder(OrderPlacedEvent event) { ... }
}
```

## Synchronous by default — real consequences

Listener exceptions propagate to the publisher; slow listeners block the publishing thread; listeners inside a `@Transactional` method run before commit unless using `@TransactionalEventListener`.

## Async listeners

`@Async @EventListener` — requires `@EnableAsync` and a real `TaskExecutor` (the default `SimpleAsyncExecutor` is dangerous, unbounded thread creation).

## `@TransactionalEventListener`

```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlacedEvent event) { emailService.sendConfirmation(event.getOrder()); }
```
Prevents confirming actions before a transaction actually commits. Silently never fires if there's no active transaction.

## Built-in framework events

`ContextRefreshedEvent`, `ContextClosedEvent`, `ApplicationReadyEvent`, `ApplicationFailedEvent`.

## Production scenario: a slow synchronous listener silently degrading checkout latency

Incrementally added listeners each added latency directly to checkout response time. Fix: audit and convert non-essential listeners to `@Async` with a bounded executor.

## Debugging scenario: `@TransactionalEventListener` never firing in a test

A `@Transactional` test rolls back rather than committing, so `AFTER_COMMIT` never fires — expected behavior, not a bug.

# Part 16: AOP Concepts — Proxies, JDK Dynamic Proxy vs CGLIB

## Terminology

Aspect, join point (always method execution in Spring AOP), pointcut, advice, weaving, target object, AOP proxy.

## Mechanics: proxying, not bytecode weaving

Spring AOP wraps the target bean in a runtime proxy, implemented via `BeanPostProcessor` (`AnnotationAwareAspectJAutoProxyCreator`). Advice only applies to calls arriving through the proxy — self-invocation bypasses it (fully covered in Part 18).

## JDK dynamic proxy vs CGLIB

JDK proxy requires an interface and can only advise interface methods. CGLIB subclasses the target class at runtime — needed when no interface exists. Boot defaults to CGLIB for everything since 2.0.

CGLIB constraints: cannot proxy `final` classes, cannot override `final`/`private` methods.

## Spring AOP vs full AspectJ

| | Spring AOP | Full AspectJ |
|---|---|---|
| Weaving | Runtime proxying | Compile/load-time bytecode weaving |
| Join points | Method execution only | Method, field, constructor, more |
| Self-invocation | Broken | Works correctly |
| Overhead | Proxy call overhead | Near-zero |

## Production scenario: injecting the wrong type breaks a mock in tests

Mocking/injecting the concrete type instead of the interface caused mismatched references. Fix: always program against interfaces for anything that might be proxied.

## Debugging scenario: `ClassCastException` after switching proxy target mode

A JDK dynamic proxy is not a subclass of the concrete class — casting fails. CGLIB's proxy is a real subclass, which is part of why Boot defaults to it — but casting to concrete types is still bad practice.

# Part 17: AOP Implementation — `@Aspect`, Pointcut Expressions, Advice Types

## Enabling annotation AOP

`@EnableAspectJAutoProxy` — reuses AspectJ syntax, Spring AOP proxying underneath. Boot auto-configures this when `spring-boot-starter-aop`/Security is present.

## Defining an aspect

```java
@Aspect
@Component // required — @Aspect alone doesn't register a bean
public class LoggingAspect {
    @Pointcut("execution(* com.acme.services.*.*(..))")
    public void serviceLayer() {}
    @Before("serviceLayer()")
    public void logBefore(JoinPoint jp) { ... }
}
```

## `execution()` syntax and the single-dot vs double-dot gotcha

`com.acme.services.*` matches only that exact package; `com.acme.services..*` includes sub-packages too — a very common real bug source when packages get reorganized.

## Other designators

`within()`, `@annotation()`, `@within()`, `args()`, `bean()`. `@annotation()` combined with a custom annotation is a genuinely excellent real pattern (e.g., `@Auditable`).

## Five advice types

`@Before`, `@AfterReturning`, `@AfterThrowing`, `@After`, `@Around` (only type that fully controls execution — must call `pjp.proceed()`).

## Advice ordering

`@Order` — lower number = higher precedence, wraps outer.

## Production scenario: `@Around` deadlocking under load from a missing `finally`

A rate-limiting semaphore never released on exception paths, draining permits under routine business exceptions until every request hung. Fix: wrap `proceed()` in try/finally.

## Debugging scenario: `@Around` silently "swallowing" execution

A cache-key collision caused a real batch job to hit a stale cached (empty) result and never call `proceed()` at all. Fix: rigor around cache-key uniqueness in hand-rolled aspects, same as `@Cacheable`.

# Part 18: AOP Internals & Pitfalls — Self-Invocation, Proxy Limitations

## Self-invocation, precisely

A call to `this.someMethod()` is direct Java dispatch, never routed through the external proxy — so `@Transactional`/`@Async`/`@Cacheable`/etc. silently don't apply, with zero errors.

## Why it's so insidious

No exception, no warning; the code often even *appears* to work (an async method just runs synchronously instead), surfacing later as a vague non-functional-requirement complaint.

## Four fixes, ranked

1. **Extract into a separate collaborator bean** — architecturally cleanest, preferred long-term.
2. **Self-injection** with `@Lazy` — pragmatic.
3. **`AopContext.currentProxy()`** — works but couples to AOP internals.
4. **Full AspectJ weaving** — solves it at the root, usually disproportionate.

## Other proxy limitations

Static methods can never be advised. Constructors can never be advised. Package-private/protected methods can be advised via CGLIB but not JDK dynamic proxy.

## Production scenario: `@Cacheable` silently not caching, traced to self-invocation

0% hit rate for internal calls vs 85% for external calls to the same method — aggregate metrics blended the two and looked merely mediocre rather than obviously broken. Fix: extract into a separate lookup service.

## Debugging scenario: `@Transactional` "sometimes" rolling back for the same exception type

Not self-invocation this time — a caught-and-swallowed exception never reached the proxy boundary at all, so the transaction correctly (from the proxy's perspective) committed. Fix: rethrow, or explicitly call `setRollbackOnly()`.

# Part 19: Type Conversion & Data Binding

## Three mechanisms

`PropertyEditor` (legacy, stateful) → `Converter<S,T>`/`ConverterFactory`/`GenericConverter` (modern, stateless, type-safe) → `Formatter<T>` (locale-aware, bidirectional parse+print).

## `DataBinder`/`WebDataBinder`

```java
@InitBinder
public void initBinder(WebDataBinder binder) {
    binder.setDisallowedFields("id");
}
```
Collects binding/validation errors into `BindingResult` rather than throwing on the first bad field.

## Mass assignment / over-posting

Without `setAllowedFields`/`setDisallowedFields`, a malicious client can set unexpected fields like `isAdmin=true`. Mitigation: dedicated DTOs (never bind directly to entities) + explicit allowlisting.

## Production scenario: silent data corruption from swallowed conversion errors

An overly broad exception handler substituted `null` for an invalid date parameter instead of rejecting the request, causing a confusing downstream NPE far from the real cause. Fix: let binding failures surface as proper 400s.

## Debugging scenario: a custom `Converter` bean not picked up

Generic type erasure through an intermediate abstract base class prevented Spring from associating the converter with its type pair. Fix: implement `Converter<S,T>` directly, or register manually via `WebMvcConfigurer`.

# Part 20: Validation

## Spring's native `Validator`

```java
@Component
public class OrderValidator implements Validator {
    public boolean supports(Class<?> clazz) { return Order.class.isAssignableFrom(clazz); }
    public void validate(Object target, Errors errors) { ... }
}
```
Good for complex, context-dependent cross-field rules.

## JSR-303/Jakarta Bean Validation

`@NotBlank`, `@Email`, `@Min`/`@Max`, `@Future`, `@Valid` (cascades into nested objects), `@Size`.

**`@NotNull` vs `@NotEmpty` vs `@NotBlank`:** `@NotNull` rejects only null; `@NotEmpty` also rejects `""`; `@NotBlank` also rejects whitespace-only — almost always the right one for required text.

## `@Valid` vs `@Validated`

`@Valid` is standard JSR-303, no group support. `@Validated` (Spring's own) supports validation groups (different rules per operation) and enables method-level validation on `@Service` beans — which, being AOP-proxy-based, inherits the self-invocation limitation from Part 18.

## Custom constraints

```java
@Constraint(validatedBy = ValidSkuValidator.class)
public @interface ValidSku { ... }
```

## Validation runs after binding

A field failing type conversion skips constraint validation for that field but not others, all merged into the same `BindingResult`.

## Production scenario: silent validation bypass via method self-invocation

A batch job calling a validated method on `this` bypassed `@Min(0)` checking, occasionally writing negative stock. Fix: extract into a separate collaborator (same family as Part 18).

## Debugging scenario: `@NotBlank` "not working" — missing `@Valid` cascade

JSR-303 doesn't auto-cascade into nested objects; a missing `@Valid` on the containing field means the nested object's constraints are never evaluated at all.

# Part 21: Task Execution & Scheduling

## `@Async`

```java
@Override
public Executor getAsyncExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(10); executor.setMaxPoolSize(50); executor.setQueueCapacity(100);
    executor.initialize();
    return executor;
}
```
**Dangerous default:** no custom executor → `SimpleAsyncTaskExecutor`, a new unpooled thread per invocation — a real production risk under load.

Return type matters: `void` (exceptions silently swallowed without a handler), `Future`/`CompletableFuture` (result/exception propagate), anything else (unsupported, result lost).

## `@Scheduled`

`fixedRate` (from start of previous run — can overlap/back up if slow) vs `fixedDelay` (from end of previous run — self-paces).

**Dangerous default:** `@EnableScheduling` uses a single-threaded scheduler by default — one slow/hanging job silently delays every other scheduled job in the app.

```java
@Bean
public TaskScheduler taskScheduler() {
    ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
    scheduler.setPoolSize(10);
    return scheduler;
}
```

## Production scenario: a hung external API call starving every scheduled job

A partner API health-check with no read timeout hung intermittently, and because scheduling defaulted to single-threaded, every unrelated job queued up behind it, delaying a critical nightly job by 40+ minutes. Fix: add HTTP timeouts (mitigate) + configure a real multi-threaded `TaskScheduler` (systemic fix).

## Debugging scenario: `@Async` method silently running synchronously

Either self-invocation (Part 18) or an unproxyable `final` class/method. Distinguish by whether the caller is internal or external.

# Part 22: FactoryBean & Advanced Bean Creation

## `FactoryBean<T>` vs `BeanFactory` — not the same thing

`FactoryBean<T>` is a bean you write whose job is to produce another object as the actual registered bean.

```java
public class ConnectionPoolFactoryBean implements FactoryBean<ConnectionPool> {
    public ConnectionPool getObject() throws Exception { ... }
    public Class<?> getObjectType() { return ConnectionPool.class; }
    public boolean isSingleton() { return true; }
}
```
`getBean("x")` returns the *product*, not the `FactoryBean` itself; prefix with `&` to get the `FactoryBean` instance.

## Where you encounter it

`LocalContainerEntityManagerFactoryBean`, `MapperFactoryBean` — rarely written directly in application code today (`@Bean` methods cover the same need).

## Static/instance factory methods (legacy XML)

Java-config equivalent: call the static/instance method directly inside a `@Bean` method.

## `ObjectFactory<T>`/`ObjectProvider<T>` vs `FactoryBean<T>`

Consumer-side (lazily obtain a bean) vs producer-side (define how a bean is created) — easy to conflate by name alone.

## Production scenario: ambiguous type match from a misregistered FactoryBean

`getObjectType()` returning `Object.class` degraded the container's ability to reason about the bean's type, worsening an unrelated ambiguity error's clarity. Fix: return the precise product type.

## Debugging scenario: NPE from calling a FactoryBean's properties before they're set

Setter-injected config on a `FactoryBean` could be read by `getObject()` before injection completed. Fix: prefer constructor injection for the FactoryBean's own configuration.

# Part 23: ApplicationContext Hierarchies

## One-directional visibility

A child context can see its parent's beans; a parent can never see a child's beans.

## Classic example: root + servlet context split

Root: services/repositories/data access. Web child: controllers/MVC infrastructure. Enables multiple `DispatcherServlet`s to share business logic beans while keeping web layers isolated.

## `BeanPostProcessor`s don't automatically span the hierarchy

A processor registered in root doesn't apply to beans created only in a child context.

## Modern Boot: mostly a single flat context

Hierarchies still appear in: Spring Cloud bootstrap contexts, test context hierarchies, legacy multi-`DispatcherServlet` apps.

## Production scenario: a shared cache bean instantiated twice due to an undocumented legacy hierarchy

A `CacheManager` defined only in the child context was invisible to root beans, which built a redundant second instance via a workaround. Fix: move the bean to the shared root context.

## Debugging scenario: a custom BeanPostProcessor "not working" for controllers only

Processor registered only in root's scan; controllers live in the isolated child context. Fix: register in both, or consolidate to a single flat context.

# Part 24: Testing Spring Applications

## The context cache

Spring caches `ApplicationContext` instances keyed by exact configuration (profiles, properties, `@MockBean`s, customizers, config classes). Identical configs share a context; any difference forces a rebuild.

## `@MockBean`/`@SpyBean` and the cache

`@MockBean` replaces the bean definition in the context itself, affecting every dependent bean — and every distinct mock combination is effectively its own cache key, a major source of suite slowdown at scale.

## `@DirtiesContext`

Deliberately evicts a context from the cache; use sparingly — often signals a test-isolation design problem.

## Slice testing

`@WebMvcTest`, `@DataJpaTest`, etc. — smaller, faster, focused contexts, still cacheable among themselves.

## `@TestConfiguration`

Excluded from regular component scanning — test-only beans can't leak into the production context.

## Production scenario: a 45-minute CI suite traced to context cache fragmentation

Dozens of `@SpringBootTest` classes each with ad-hoc, slightly different `@MockBean` combinations produced 60+ distinct contexts. Fix: consolidate onto shared base configurations; shift more tests to slice/unit tests.

## Debugging scenario: a test passes alone but fails in the full suite

An earlier test mutated shared cached-context singleton state without resetting it. Fix: `@DirtiesContext` (accepting the cost) or, better, avoid mutating shared singleton state at all.

# Part 25: Production/Debugging Capstone — Synthesizing Everything

## Capstone Incident 1: The Friday-afternoon checkout outage

A seemingly small feature-flag check triggered 500s under load. Root chain: self-invocation (harmless on its own) + an under-specified `@Cacheable` key on a flag-lookup service + `@Transactional(REQUIRES_NEW)` suspending/resuming the caller's transaction + connection-pool saturation under concurrent load, combining into intermittent `TransactionRequiredException`s. Lesson: when a small change fails only under load, ask what shared, cacheable, or pooled resource the new code path touches.

## Capstone Incident 2: The silent data-loss bug that took three weeks to notice

A `prototype`-scoped `ReportBuilder` was field-injected into a singleton `ReportService` (Part 6's classic mistake), so every "fresh" report actually reused one shared instance. A buffer cleared at the *end* of `build()` raced against a concurrently-running `@Async` invocation sharing that same instance, silently producing empty reports with no exception. Found only by correlating timestamps against thread-pool activity. Fix: `ObjectProvider<ReportBuilder>` for genuinely fresh instances per call.

## The six root mechanisms behind nearly every tricky Spring Core bug

1. Proxy boundaries bypassed (self-invocation, `final`, `static`, `private`).
2. Scope mismatches (narrow-scoped bean injected into a wider-scoped one).
3. Shared mutable state on a singleton.
4. Under-specified cache/lookup keys.
5. Silent condition/configuration mismatches (profiles, conditionals, property precedence).
6. Lifecycle-ordering assumptions.

As an interview framework: running a candidate explanation through this six-item list, out loud, in order, demonstrates systematic reasoning from a real mental model rather than guessing.

---

*End of course — 25 parts covering IoC/DI, the container, configuration styles, dependency injection mechanics, autowiring, scopes, lifecycle, post-processors, circular dependencies, component scanning, Java config, environment/profiles, SpEL, resources, events, AOP (concepts, implementation, and internals/pitfalls), type conversion, validation, task execution/scheduling, FactoryBean, context hierarchies, testing, and a synthesizing capstone.*


---



### Practice Exercises & Answers


---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. IoC vs DI, without "container"?</summary>

IoC is the general principle that control over object creation/flow is handed to an external mechanism. DI is the specific technique of supplying dependencies from outside rather than self-construction.

</details>

<details class="qa-item">
<summary>2. Rewrite `ReportGenerator` with constructor injection:</summary>

```java
interface Exporter { void export(Report r); }
class PdfExporter implements Exporter { public void export(Report r) { } }
class ReportGenerator {
    private final Exporter exporter;
    ReportGenerator(Exporter exporter) { this.exporter = exporter; }
}
```
Benefit: tests can pass a `FakeExporter` instead of a real one.

</details>

<details class="qa-item">
<summary>3. True/false: every bean must be `@Component`?</summary>

False. `BeanDefinition` is the common thread; `@Bean` methods, XML, and programmatic registration all work too.

---

</details>

<details class="qa-item">
<summary>1. Why is fail-fast a feature?</summary>

Surfaces broken config deterministically at startup/deploy rather than unpredictably in production traffic.

</details>

<details class="qa-item">
<summary>2. "I'll use BeanFactory directly, it's lighter"</summary>

Loses automatic post-processor registration, meaning `@Autowired`/`@Transactional`/AOP would need manual wiring; the "savings" aren't worth it.

</details>

<details class="qa-item">
<summary>3. Another null-`@Autowired` case</summary>

Objects created via plain `new` inside a `@Bean` method body, or deserialized from JSON/a queue payload — neither goes through the container.

---

</details>

<details class="qa-item">
<summary>1. `RestTemplate`</summary>

`@Bean`, since you don't own its source.

</details>

<details class="qa-item">
<summary>2. CGLIB proxying of `@Configuration` prevents a `@Bean` method called from another `@Bean` method within the class from creating a second, duplicate instance</summary>

it redirects the call to fetch the existing singleton.

</details>

<details class="qa-item">
<summary>3. With `proxyBeanMethods = false`, declare dependencies as method parameters rather than calling other `@Bean` methods directly.</summary>

---

</details>

<details class="qa-item">
<summary>1. Three reasons for constructor injection: immutability, guaranteed non-null state, testability without a container (plus circular-dependency fail-fast and visible design smells).</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. Setter injection is right when a dependency is genuinely optional.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. ```java</summary>

@Service
@RequiredArgsConstructor
public class InvoiceService {
    private final TaxCalculator taxCalculator;
    private final PdfGenerator pdfGenerator;
}
```

---

</details>

<details class="qa-item">
<summary>1. Forcing explicit disambiguation everywhere: use `@Qualifier` on every site, avoid `@Primary` (which creates a silent default).</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. `@Autowired`+`@Qualifier` resolves by type first; `@Resource` resolves by name first.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. ```java</summary>

@Service
public class NotificationDispatcher {
    private final Map<String, NotificationChannel> channels;
    public NotificationDispatcher(Map<String, NotificationChannel> channels) { this.channels = channels; }
    void notifyVia(String channelName, String msg) { channels.get(channelName).send(msg); }
}
```
Use case: dispatch by a user's stored channel preference without an if/else chain.

---

</details>

<details class="qa-item">
<summary>1. Field-injecting a prototype into a singleton resolves once at construction. Fixes: `ObjectProvider` or scoped proxy.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. "Singleton means thread-safe" is wrong</summary>

one shared instance actually increases the need for thread-safety discipline.

</details>

<details class="qa-item">
<summary>3. The container hands off prototype instances and loses track of them</summary>

no way to know when it's safe to destroy.

---

</details>

<details class="qa-item">
<summary>1. Order: constructor → setter injection → `postProcessBeforeInitialization` → `@PostConstruct` → `postProcessAfterInitialization`.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. `@PostConstruct` runs after `Aware` callbacks and any setter/field injection, and keeps initialization separately testable from field assignment.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. `SIGKILL` before graceful shutdown/`@PreDestroy` completes. Fix: enable graceful shutdown and a sufficient grace period.</summary>

---

</details>

<details class="qa-item">
<summary>1. `BeanFactoryPostProcessor` touches definitions/metadata pre-instantiation; `BeanPostProcessor` touches instances during lifecycle.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. `AnnotationAwareAspectJAutoProxyCreator`; runs in `postProcessAfterInitialization` so it wraps the fully-initialized bean.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. CGLIB can't subclass a `final` class</summary>

proxying is silently skipped or the method isn't overridden.

---

</details>

<details class="qa-item">
<summary>1. Field injection can hand out a raw, shared-identity instance early; constructor injection has no partially-built object to hand out.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. Most to least preferable: extract shared collaborator > `@Lazy` > field/setter injection.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. A conditional/profile-gated bean differs between environments, so the cycle only manifests where both sides are actually active.</summary>

---

</details>

<details class="qa-item">
<summary>1. `@Service` = `@Component`, no functional difference. `@Repository` does differ (exception translation).</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. A sibling package isn't scanned by default. Fixes: widen `basePackages`, or move the app class to the common parent package.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. `useDefaultFilters = false` disables auto-detection of stereotypes entirely; useful for plugin-style architectures with a custom marker annotation.</summary>

---

</details>

<details class="qa-item">
<summary>1. `@EnableAsync` uses `@Import` internally to pull in the config registering the `@Async`-detecting `BeanPostProcessor`.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. `@ConditionalOnBean` requires a match to exist; `@ConditionalOnMissingBean` requires none to exist yet</summary>

ordering determines which config class "wins" the race.

</details>

<details class="qa-item">
<summary>3. A custom `Condition` via raw `@Conditional`, checking the environment variable directly.</summary>

---

</details>

<details class="qa-item">
<summary>1. Env var wins</summary>

higher precedence, relaxed-bound to the same key.

</details>

<details class="qa-item">
<summary>2. Type-safe group binding + nested structure support (any two of the listed reasons).</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. It's still exposed via version control, artifacts, and introspection tooling like `/actuator/env`, regardless of whether it drives runtime behavior.</summary>

---

</details>

<details class="qa-item">
<summary>1. `${...}` is plain substitution; `#{...}` is full SpEL; nested, the placeholder resolves first, then the result is parsed as SpEL.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. `@PostAuthorize` needs `returnObject`</summary>

only a full expression language can reference a value that only exists at evaluation time.

</details>

<details class="qa-item">
<summary>3. RCE-class risk from unrestricted method/constructor invocation; use `SimpleEvaluationContext` or a constrained purpose-built syntax instead of raw SpEL.</summary>

---

</details>

<details class="qa-item">
<summary>1. No valid filesystem path exists for a JAR zip entry; use `getInputStream()`.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. `classpath:` = first match only; `classpath*:` = all matches across every classpath root. Wrong choice silently drops contributions from some modules.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. `@PropertySource(value = "file:...", ignoreResourceNotFound = true)`.</summary>

---

</details>

<details class="qa-item">
<summary>1. Synchronous by default. Consequences: latency is additive; listener exceptions can break the publisher's operation.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. A plain listener fires before commit</summary>

a rolled-back transaction still triggers the "confirmation," a real data inconsistency, not just performance.

</details>

<details class="qa-item">
<summary>3. `@Transactional` tests roll back rather than commit, so the commit event the listener needs never occurs.</summary>

---

</details>

<details class="qa-item">
<summary>1. Join point = a point where advice could apply; pointcut = expression selecting which join points; advice = the code that runs at matches.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. CGLIB. Constraints: can't proxy `final` classes/methods; can never advise `private` methods.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. AspectJ weaves directly into bytecode, so `this` calls are advised too; Spring AOP's proxy is a separate external object that `this` calls never pass through.</summary>

---

</details>

<details class="qa-item">
<summary>1. `execution(public * com.acme.orders..*.*(..))`</summary>

single dot excludes sub-packages.

</details>

<details class="qa-item">
<summary>2. `@Around`; must call `pjp.proceed()`.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. `SecurityAspect` (lower `@Order`) runs first for `@Before` advice.</summary>

---

</details>

<details class="qa-item">
<summary>1. Direct dispatch on `this` never routes through the separate external proxy object; the proxy is only reached via DI-injected references from outside.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. Extraction > self-injection > `AopContext.currentProxy()` > full AspectJ, because extraction also fixes the likely underlying design issue.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. Nothing</summary>

`@Transactional` on a `static` method is silently ignored, since AOP proxying only intercepts instance method dispatch.

---

</details>

<details class="qa-item">
<summary>1. `Converter` is plain, locale-agnostic, one-directional; `Formatter` is locale-aware and bidirectional</summary>

needed for user-facing display/input.

</details>

<details class="qa-item">
<summary>2. Mass assignment: blind binding of any request field onto a target object. Mitigations: dedicated DTOs, explicit allowlisting.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. Generic type parameters unresolvable via reflection due to an intermediate generic abstract base class.</summary>

---

</details>

<details class="qa-item">
<summary>1. `@NotNull` rejects only null; `@NotEmpty` also rejects empty string; `@NotBlank` also rejects whitespace-only</summary>

the right choice for required text.

</details>

<details class="qa-item">
<summary>2. Validation groups: `@Validated(Group.class)` + `groups = {...}` on constraints.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. Method validation is AOP-proxy-based (`MethodValidationPostProcessor`), so it inherits the same self-invocation bypass as `@Transactional`/`@Async`/`@Cacheable`.</summary>

---

</details>

<details class="qa-item">
<summary>1. `SimpleAsyncTaskExecutor`</summary>

unbounded thread-per-invocation, real OOM/exhaustion risk under load.

</details>

<details class="qa-item">
<summary>2. `fixedRate` measures from start (can back up under slow execution); `fixedDelay` measures from end (self-paces).</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. All nine other jobs queue behind the hung one on the shared single thread. Fix: configure a multi-threaded `ThreadPoolTaskScheduler`.</summary>

---

</details>

<details class="qa-item">
<summary>1. You get the product (`Widget`), not the `FactoryBean` itself; use `&beanName` for the latter.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. Precise `getObjectType()` lets the container reason about type before instantiating, improving autowiring resolution and error clarity.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. `ObjectFactory`/`ObjectProvider` = consumer-side (lazy obtain); `FactoryBean` = producer-side (defines creation).</summary>

---

</details>

<details class="qa-item">
<summary>1. Child sees parent; parent never sees child</summary>

the parent has no structural awareness that children exist.

</details>

<details class="qa-item">
<summary>2. Multiple `DispatcherServlet`s sharing common business-layer beans without duplication, while keeping web layers independent.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. Each context manages its own post-processor registrations and lifecycle independently</summary>

no automatic cross-context reach.

---

</details>

<details class="qa-item">
<summary>1. Exact match of config classes, profiles, properties, and especially `@MockBean`/`@SpyBean` set/customizers.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>2. Each distinct mock combination is its own cache key, silently multiplying rebuilt contexts across a large, uncoordinated suite.</summary>

_Work through this on your own first — detailed answer not included in the source note._

</details>

<details class="qa-item">
<summary>3. Shared cached-context singleton state mutation by an earlier test</summary>

only manifests when tests run together sharing the cache.

---

</details>
