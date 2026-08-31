# Spring Boot Mastery — Senior Production Reference

Spring Boot 3.x / Spring Framework 6.x / Jakarta EE 9+. Servlet stack is the default path; reactive (WebFlux/Netty) differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after ~10 years of shipping Boot apps — auto-config surprises, property precedence wars, actuator leaks, and test slices that lie about production behavior.

---

## Table of Contents

1. [1. Mental Model: Auto-Configuration](#1-mental-model-auto-configuration)
2. [2. @SpringBootApplication](#2-springbootapplication)
3. [3. @EnableAutoConfiguration](#3-enableautoconfiguration)
4. [4. spring.factories vs AutoConfiguration.imports (Boot 3)](#4-springfactories-vs-autoconfigurationimports-boot-3)
5. [5. @ConditionalOn* Family](#5-conditionalon-family)
6. [6. @AutoConfigureBefore / @AutoConfigureAfter / @AutoConfigureOrder](#6-autoconfigurebefore--autoconfigureafter--autoconfigureorder)
7. [7. Writing Custom Auto-Configuration](#7-writing-custom-auto-configuration)
8. [8. Starters Anatomy](#8-starters-anatomy)
9. [9. Dependency Management & BOM](#9-dependency-management--bom)
10. [10. Externalized Configuration Fundamentals](#10-externalized-configuration-fundamentals)
11. [11. Properties, YAML, Environment Variables](#11-properties-yaml-environment-variables)
12. [12. Profiles](#12-profiles)
13. [13. @ConfigurationProperties + Validation + Records](#13-configurationproperties--validation--records)
14. [14. PropertySource Order & Relaxed Binding](#14-propertysource-order--relaxed-binding)
15. [15. Spring Boot Actuator Overview](#15-spring-boot-actuator-overview)
16. [16. Health, Liveness, Readiness](#16-health-liveness-readiness)
17. [17. Metrics & Micrometer Integration](#17-metrics--micrometer-integration)
18. [18. Loggers, Env, Info Endpoints](#18-loggers-env-info-endpoints)
19. [19. Actuator Security](#19-actuator-security)
20. [20. Custom Health Indicators](#20-custom-health-indicators)
21. [21. Graceful Shutdown](#21-graceful-shutdown)
22. [22. Embedded Tomcat / Jetty / Netty Tuning](#22-embedded-tomcat--jetty--netty-tuning)
23. [23. DevTools (Dev Only)](#23-devtools-dev-only)
24. [24. Spring Boot Docker Layers & Container Images](#24-spring-boot-docker-layers--container-images)
25. [25. Build Info](#25-build-info)
26. [26. Test Slices](#26-test-slices)
27. [27. Production Scenarios Capstone](#27-production-scenarios-capstone)
28. [28. Production Debugging Playbook](#28-production-debugging-playbook)
29. [29. Quick Decision Matrix](#29-quick-decision-matrix)
30. [30. Interview Q&A (15+)](#30-interview-qa-15)

---

## 1. Mental Model: Auto-Configuration

Spring Boot is not "Spring with fewer XML files." It is **opinionated assembly**: a curated set of `@Configuration` classes registered via `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`, each guarded by `@ConditionalOn*` annotations, applied **after** your own `@Configuration` beans are registered but **before** the context is refreshed for use.

```
main()
  └─ SpringApplication.run(App.class, args)
       ├─ create SpringApplication (deduce web type, load listeners)
       ├─ prepareEnvironment (args, system props, env vars, application.properties)
       ├─ print banner (optional)
       ├─ create ApplicationContext (AnnotationConfigServletWebServerApplicationContext)
       ├─ prepareContext
       │    ├─ register @SpringBootApplication (component scan + @EnableAutoConfiguration)
       │    ├─ invoke ApplicationContextInitializer / listeners
       │    └─ load sources
       ├─ refreshContext
       │    ├─ parse @Configuration classes (yours first via component scan)
       │    ├─ AutoConfigurationImportSelector loads AutoConfiguration.imports
       │    ├─ filter auto-configs (@ConditionalOnClass, @ConditionalOnMissingBean, …)
       │    ├─ sort (@AutoConfigureBefore/After/Order)
       │    ├─ register bean definitions
       │    └─ finish refresh → embedded server starts (if web)
       └─ call runners (ApplicationRunner, CommandLineRunner)
```

Three layers you must keep distinct:

| Layer | Question it answers | Typical artifact |
|---|---|---|
| **Starter** | What jars are on the classpath? | `spring-boot-starter-web`, `spring-boot-starter-data-jpa` |
| **Auto-configuration** | What beans should exist given this classpath? | `DataSourceAutoConfiguration`, `JacksonAutoConfiguration` |
| **Your `@Configuration`** | What is unique to this service? | `SecurityConfig`, `PaymentClientConfig` |

A starter **without** matching auto-config does nothing useful. Auto-config **without** the starter's transitive dependencies fails `@ConditionalOnClass`. Your config **wins** over auto-config when you define the same bean (`@ConditionalOnMissingBean` on the auto-config side).

Boot's contract: **convention over configuration, escape hatches everywhere.** `spring.autoconfigure.exclude`, `@SpringBootApplication(exclude=...)`, `@ConditionalOnProperty`, and plain `@Bean` overrides are all first-class.

---

## 2. @SpringBootApplication

### Core concept

`@SpringBootApplication` is a composed annotation:

```java
@SpringBootConfiguration   // alias for @Configuration — marks this as a config class Boot should treat as the "main" source
@EnableAutoConfiguration   // imports AutoConfigurationImportSelector
@ComponentScan             // scans from the package of the annotated class downward
public @interface SpringBootApplication { ... }
```

It is **not** magic. It is three annotations that 99% of apps need together. Splitting them is valid when you need a non-default scan base:

```java
@SpringBootConfiguration
@EnableAutoConfiguration
@ComponentScan(basePackages = {"com.acme.orders", "com.acme.shared"})
public class OrdersApplication { }
```

### Internal working

1. `@SpringBootConfiguration` makes the class a source for `SpringApplication`. Boot's `SpringBootContextLoader` (tests) and `SpringApplication` register this class (and any additional sources passed to `run`) as configuration metadata.
2. `@ComponentScan` uses `AutoConfigurationPackages.register(package)` as a side effect — this registers the application's base package so auto-configurations like JPA can find `@Entity` classes without you specifying `entityScan` manually in simple apps.
3. `@EnableAutoConfiguration` imports `AutoConfigurationImportSelector`, which reads `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` from every jar on the classpath, deduplicates, filters, sorts, and registers surviving classes.

`SpringApplication.run` also:

- Sets `spring.application.name` default from the main class if not provided (deprecated behavior in 3.x — prefer explicit `spring.application.name`).
- Registers shutdown hook unless disabled.
- Publishes `ApplicationStartingEvent`, `ApplicationEnvironmentPreparedEvent`, `ApplicationPreparedEvent`, `ApplicationStartedEvent`, `ApplicationReadyEvent`, `ApplicationFailedEvent`.

### Production scenario: `@SpringBootApplication` in the wrong package

**Problem.** A team structures code as:

```
com.acme
  └─ OrdersApplication.java          ← @SpringBootApplication here
com.acme.orders
  ├─ api/
  ├─ domain/
  └─ infra/
com.acme.billing                 ← new module, separate package subtree
```

`com.acme.billing` beans are never scanned. Integration tests using `@SpringBootTest` pass because they `@Import(BillingConfig.class)` manually. Production fat jar silently omits billing beans until the first `@Autowired` failure — or worse, a `NoSuchBeanDefinitionException` only on a code path hit at 2 AM.

**Solution.**

```java
@SpringBootApplication(scanBasePackages = "com.acme")
// or move main class to com.acme and keep subpackages underneath
public class OrdersApplication { }
```

Rules:

- Component scan is **downward from the package of the annotated class**, not "the whole repo."
- Prefer one root package per deployable (`com.acme.orders`) with the main class at that root.
- Multi-module monorepos: either one app per module with its own main, or explicit `scanBasePackages`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Main class in `com.acme` but code in `com.acme.orders` and `com.acme.billing` | Random `NoSuchBeanDefinitionException` for one subtree |
| Two `@SpringBootApplication` classes in one module | Duplicate context in tests; wrong main in manifest |
| `@ComponentScan` on a `@Configuration` **and** `@SpringBootApplication` with overlapping bases | Duplicate bean definitions, `BeanDefinitionOverrideException` if allowed |
| `@SpringBootApplication` on a class that is not your entry point | IDE runs wrong main; actuator shows wrong `spring.application.name` |

### Debugging scenario

**Observe.** `@Service` in `com.acme.payments` not found; `@Repository` in `com.acme.orders` works.

**Diagnose.**

```bash
# Boot 3.2+ — condition evaluation report
java -jar app.jar --debug
# or
logging.level.org.springframework.boot.autoconfigure=DEBUG
```

Look for `Exclusions:` and scan base. Dump component scan:

```java
@SpringBootTest
class ScanDebugTest {
    @Autowired ApplicationContext ctx;
    @Test void dump() {
        Arrays.stream(ctx.getBeanDefinitionNames())
            .filter(n -> n.toLowerCase().contains("payment"))
            .forEach(System.out::println);
    }
}
```

**Fix.** Move main class or add `scanBasePackages`. Confirm with `--debug` that `com.acme.payments` appears in `Identified candidate component class` lines.

---

## 3. @EnableAutoConfiguration

### Core concept

`@EnableAutoConfiguration` tells Boot to register auto-configuration classes. It is imported by `@SpringBootApplication` and can be used standalone on a `@Configuration` class in advanced scenarios (e.g. library integration tests that need auto-config without component scan).

```java
@Configuration
@EnableAutoConfiguration
@Import(MyManualBeans.class)
public class MinimalTestConfig { }
```

Key attributes:

| Attribute | Purpose |
|---|---|
| `exclude` | Hard-remove specific auto-config classes (class literal — must be on compile classpath) |
| `excludeName` | Same, but by fully qualified name string (useful when class is not on classpath) |

### Internal working

`@EnableAutoConfiguration` imports `AutoConfigurationImportSelector` (since Boot 2.7+ also `AutoConfiguration` metadata). Flow:

1. Read all `AutoConfiguration.imports` files (Boot 3) or `EnableAutoConfiguration` entries in `spring.factories` (Boot 2 — removed in Boot 3 for auto-config).
2. Apply `spring.autoconfigure.exclude` property and `@EnableAutoConfiguration(exclude=...)`.
3. Run `AutoConfigurationImportFilter` implementations (e.g. `@ConditionalOnClass` pre-check via `OnClassCondition`).
4. Sort with `AutoConfigurationSorter` honoring `@AutoConfigureBefore`, `@AutoConfigureAfter`, `@AutoConfigureOrder`.
5. Register as configuration classes — they are full `@Configuration` classes, subject to `@Conditional` evaluation at bean-registration time.

`@EnableAutoConfiguration` does **not** scan components. It does **not** load `application.properties`. Those are separate mechanisms (`@ComponentScan`, `Environment` post-processing).

### Production scenario: excluding DataSource auto-config in a "stateless" worker

**Problem.** A Kafka consumer service includes `spring-boot-starter-data-jpa` transitively through a shared library. On startup:

```
Failed to configure a DataSource: 'url' attribute is not specified and no embedded datasource could be configured.
```

The team added `spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration` to `application.properties` but the shared library also has `@EnableAutoConfiguration` in a test `@Configuration` that gets `@Import`ed into the main app by mistake.

**Solution.**

```java
@SpringBootApplication(exclude = {
    DataSourceAutoConfiguration.class,
    HibernateJpaAutoConfiguration.class,
    DataSourceTransactionManagerAutoConfiguration.class
})
public class IndexerApplication { }
```

And fix the library — never ship `@EnableAutoConfiguration` in production `@Configuration` imported by apps. Use `spring.factories` / `AutoConfiguration.imports` for libraries.

Also set:

```yaml
spring:
  autoconfigure:
    exclude:
      - org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration
```

Redundant exclusions are fine; missing one JPA-related auto-config is not.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `exclude = Foo.class` but Foo not on classpath | Compile error; use `excludeName` |
| Excluding `SecurityAutoConfiguration` thinking it disables security | No security filters at all — or partial — depending on other deps |
| `@EnableAutoConfiguration` on every library config | Double auto-config, duplicate beans, slow startup |
| Excluding auto-config instead of defining required properties | Startup passes but NPE at runtime when bean missing |

### Debugging scenario

**Observe.** App starts on laptop but fails in CI with missing `DataSource`.

**Diagnose.** CI profile activates `test` stubs; local has H2 on classpath triggering `EmbeddedDatabaseConfiguration`. Check:

```yaml
logging.level.org.springframework.boot.autoconfigure.jdbc=DEBUG
```

`--debug` prints negative matches: `DataSourceAutoConfiguration matched: @ConditionalOnClass found required class 'javax.sql.DataSource'` vs `did not match`.

**Fix.** Align classpath between environments. Exclude explicitly or provide `spring.datasource.url`. Do not rely on accidental H2.

---

## 4. spring.factories vs AutoConfiguration.imports (Boot 3)

### Core concept

Boot 2.x registered auto-configuration in:

```
META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
com.example.FooAutoConfiguration,\
com.example.BarAutoConfiguration
```

Boot 3.x moved auto-configuration to a dedicated file:

```
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.FooAutoConfiguration
com.example.BarAutoConfiguration
```

`spring.factories` still exists in Boot 3 for other extension points:

| Extension | Boot 3 registration |
|---|---|
| `ApplicationContextInitializer` | `spring.factories` |
| `ApplicationListener` | `spring.factories` |
| `EnvironmentPostProcessor` | `spring.factories` |
| `FailureAnalyzer` | `spring.factories` |
| `AutoConfiguration` | **`AutoConfiguration.imports` only** |
| `AutoConfigurationImportFilter` | `spring.factories` |
| `EnableAutoConfiguration` (legacy) | **removed** — ignored in Boot 3 |

### Internal working

`AutoConfigurationImportSelector` (Boot 3) reads `AutoConfiguration.imports` via `ImportCandidates.load`. Each line is a fully qualified `@Configuration` class (typically `@AutoConfiguration`). No key=value format. Comments `#` are not officially supported — one class per line.

Migration tooling: Spring Boot 3 migration guide recommends moving entries manually or via OpenRewrite. Mixed Boot 2 + 3 libraries during migration: Boot 3 apps **ignore** `EnableAutoConfiguration` in `spring.factories` from old jars — those auto-configs silently stop loading. Symptom: "it worked on Boot 2.7, upgraded to 3.2, Redis cache vanished."

### Production scenario: internal starter still on spring.factories

**Problem.** `com.acme:acme-spring-boot-starter:4.0` still has:

```
# META-INF/spring.factories  (WRONG for Boot 3 auto-config)
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
com.acme.boot.AcmeTracingAutoConfiguration
```

App upgrades to Boot 3. Tracing beans disappear. No compile errors. Observability team blames Micrometer.

**Solution.**

Create `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`:

```
com.acme.boot.AcmeTracingAutoConfiguration
```

Annotate the class:

```java
@AutoConfiguration
@ConditionalOnClass(Tracer.class)
@EnableConfigurationProperties(AcmeTracingProperties.class)
public class AcmeTracingAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean
    Tracer acmeTracer(AcmeTracingProperties props) { ... }
}
```

Ship a minor version of the starter documented as "Boot 3 requires 4.1+."

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auto-config only in `spring.factories` on Boot 3 | Feature silently absent |
| Typo in imports file (extra space, wrong package) | `ClassNotFoundException` at startup |
| Auto-config class not annotated `@AutoConfiguration` | Works but ordering vs other auto-configs is undefined |
| Fat jar merge overwrites `AutoConfiguration.imports` | Missing auto-configs — check `maven-shade-plugin` transforms |

### Debugging scenario

**Observe.** Third-party starter docs say "zero config" but beans are missing.

**Diagnose.**

```bash
jar tf acme-spring-boot-starter.jar | grep -E 'AutoConfiguration.imports|spring.factories'
```

Unpack and read the imports file. Enable:

```properties
debug=true
logging.level.org.springframework.boot.autoconfigure=DEBUG
```

Search logs for the expected class name in `Positive matches` / `Negative matches`.

**Fix.** Upgrade starter, or fork with correct `AutoConfiguration.imports`. Temporary: `@Import(AcmeTracingAutoConfiguration.class)` on your `@SpringBootApplication`.

---

## 5. @ConditionalOn* Family

### Core concept

Auto-configuration is conditional configuration. The `@ConditionalOn*` meta-annotations are thin wrappers around `@Conditional` with Boot-specific `Condition` implementations.

| Annotation | Matches when |
|---|---|
| `@ConditionalOnClass` | Named classes present on classpath |
| `@ConditionalOnMissingClass` | Named classes absent |
| `@ConditionalOnBean` | Named bean types/ names already in context |
| `@ConditionalOnMissingBean` | No bean of type/name |
| `@ConditionalOnProperty` | `Environment` property has specific value |
| `@ConditionalOnResource` | Classpath resource exists |
| `@ConditionalOnWebApplication` | Servlet vs reactive vs none |
| `@ConditionalOnNotWebApplication` | Non-web app |
| `@ConditionalOnSingleCandidate` | Exactly one candidate bean of type (after primary) |
| `@ConditionalOnExpression` | SpEL true (use sparingly in auto-config) |
| `@ConditionalOnJava` | JVM version range |
| `@ConditionalOnCloudPlatform` | Kubernetes, Cloud Foundry, etc. |
| `@ConditionalOnWarDeployment` | Deployed as WAR in external container |

### Internal working

Conditions are evaluated at **bean definition registration** time (mostly). `@ConditionalOnBean` / `@ConditionalOnMissingBean` participate in a two-pass algorithm: some configurations are deferred because the bean they require does not exist yet. `AutoConfigurationImportSelector` uses `@ConditionalOnClass` **before** loading the configuration class (classpath-safe: uses `ImportCandidates` + ASM, does not load the class).

`@ConditionalOnProperty` nuances:

```java
@ConditionalOnProperty(prefix = "acme.feature", name = "enabled", havingValue = "true", matchIfMissing = false)
```

- `matchIfMissing = true` → enabled if property absent.
- `havingValue` empty string → property must exist and not be falsey (see docs — prefer explicit values).
- `relaxedNames` — `acme.feature.enabled` binds `ACME_FEATURE_ENABLED` env var.

Order of evaluation matters for `@ConditionalOnBean`: your `@Bean` in `@Configuration` registered before auto-config typically causes `@ConditionalOnMissingBean` in auto-config to back off.

### Production scenario: two DataSource beans, wrong one marked `@Primary`

**Problem.**

```java
@Bean @Primary
@ConfigurationProperties("app.datasource")
DataSource appDataSource() { return DataSourceBuilder.create().build(); }
```

`DataSourceAutoConfiguration` also creates a pool if properties exist. A library auto-config uses `@ConditionalOnSingleCandidate(DataSource.class)` and wires the wrong pool — or fails because two candidates exist and neither is primary in the library's view.

**Solution.**

```yaml
spring:
  datasource:
    url: jdbc:postgresql://...
    # let Boot own the primary DataSource
app:
  datasource:
    # use @Qualifier or @ConfigurationProperties on a @Bean method that wraps the primary
```

Or exclude `DataSourceAutoConfiguration` and own the entire matrix. **Never** have two pool beans without `@Qualifier` documentation.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@ConditionalOnMissingBean` on wrong type (interface vs impl) | Duplicate beans |
| `@ConditionalOnProperty` with `matchIfMissing=true` in library auto-config | Feature on in prod when you forgot to disable |
| `@ConditionalOnClass` referencing optional dep not marked optional in Maven | `ClassNotFoundException` during condition eval (rare if using string name) |
| Custom `@Bean` named `dispatcherServlet` | Breaks `DispatcherServletAutoConfiguration` assumptions |

### Debugging scenario

**Observe.** Redis cache auto-config not applied; `RedisTemplate` missing.

**Diagnose.** `--debug` output:

```
RedisAutoConfiguration:
  Did not match:
    - @ConditionalOnClass did not find required class 'org.springframework.data.redis.core.RedisOperations'
```

Or:

```
@ConditionalOnMissingBean (types: RedisTemplate) found beans of type 'RedisTemplate'
```

**Fix.** Add `spring-boot-starter-data-redis` or remove your custom `RedisTemplate` if it was a stub.

---

## 6. @AutoConfigureBefore / @AutoConfigureAfter / @AutoConfigureOrder

### Core concept

Auto-configuration classes form a DAG. Boot sorts them so infrastructure lands before consumers:

```java
@AutoConfiguration
@AutoConfigureAfter(DataSourceAutoConfiguration.class)
@AutoConfigureBefore(JpaRepositoriesAutoConfiguration.class)
public class HibernateJpaAutoConfiguration { }
```

`@AutoConfigureOrder` (on the class) sets coarse priority — lower runs earlier. Default is `0`. Use `Ordered.HIGHEST_PRECEDENCE` sparingly.

**Not** the same as `@Order` on a regular `@Configuration` — that affects bean creation order among user configs, not auto-config import order.

### Internal working

`AutoConfigurationSorter` builds a graph from `@AutoConfigureBefore/After` annotations on each auto-config class, then topologically sorts. Cycles are broken with deterministic rules and a warning in logs.

User `@Configuration` classes are generally processed **before** auto-configuration (since Boot 2.4+ `spring.config.import` and processing order changes — user configs still override via `@ConditionalOnMissingBean`). Exact ordering: `AutoConfiguration` classes are imported as `@Import` candidates **after** the main application class is processed but the relative order vs other `@Configuration` depends on `@Import` graph.

Practical rule: if you need your auto-config to run **after** user beans, use `@AutoConfigureAfter` referencing the user's config class **only in library code you control** — prefer `@ConditionalOnMissingBean` instead of fighting order.

### Production scenario: custom security before Boot's default

**Problem.** Library ships `@AutoConfigureBefore(SecurityAutoConfiguration.class)` and registers a `SecurityFilterChain` bean. App also defines a chain. Both exist; `@Order` on chains decides — library chain wins first match for `/api/**`.

**Solution.** Library should use `@ConditionalOnMissingBean(SecurityFilterChain.class)` or document that apps must exclude `SecurityAutoConfiguration`. Prefer:

```java
@AutoConfiguration
@ConditionalOnWebApplication
@ConditionalOnClass(SecurityFilterChain.class)
@AutoConfigureBefore(SecurityAutoConfiguration.class)
public class AcmeDefaultSecurityAutoConfiguration { ... }
```

Apps override by defining their own `SecurityFilterChain` bean — Boot 3 back off.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@AutoConfigureBefore` without being an `@AutoConfiguration` | Annotation ignored |
| Cycle between two third-party starters | Non-deterministic bean init order across Boot upgrades |
| Assuming `@AutoConfigureAfter(UserConfig.class)` works | User config is not an auto-config — reference fails silently in sorter |

### Debugging scenario

**Observe.** `FlywayAutoConfiguration` runs before `DataSourceAutoConfiguration` after merging two starters.

**Diagnose.** `--debug` shows sort order. Check for missing `@AutoConfigureAfter(DataSourceAutoConfiguration.class)` in a custom `FlywayAutoConfiguration` copy.

**Fix.** Upgrade starter; remove duplicate Flyway auto-config; or `@DependsOn("dataSource")` on the `Flyway` bean.

---

## 7. Writing Custom Auto-Configuration

### Core concept

Libraries ship auto-configuration; applications ship `@Configuration`. Pattern:

```
acme-spring-boot-starter/
  ├─ acme-core.jar          (no Spring dependencies)
  ├─ acme-spring-boot-autoconfigure.jar
  │    ├─ com.acme.boot.AcmeAutoConfiguration
  │    └─ META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
  └─ acme-spring-boot-starter.jar   (pom only — pulls autoconfigure + optional deps)
```

### Internal working

```java
@AutoConfiguration
@ConditionalOnClass(AcmeClient.class)
@EnableConfigurationProperties(AcmeProperties.class)
public class AcmeAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    AcmeClient acmeClient(AcmeProperties properties) {
        return new AcmeClient(properties.getBaseUrl(), properties.getApiKey());
    }

    @Bean
    @ConditionalOnProperty(prefix = "acme", name = "health-check", havingValue = "true")
    AcmeHealthIndicator acmeHealth(AcmeClient client) {
        return new AcmeHealthIndicator(client);
    }
}
```

```java
@ConfigurationProperties(prefix = "acme")
@Validated
public record AcmeProperties(
    @NotBlank String baseUrl,
    @NotBlank String apiKey,
    Duration timeout
) {
    public AcmeProperties {
        if (timeout == null) timeout = Duration.ofSeconds(5);
    }
}
```

Register additional extension points in `META-INF/spring.factories` only when needed:

```
org.springframework.boot.env.EnvironmentPostProcessor=com.acme.boot.AcmeSecretsEnvironmentPostProcessor
```

**Never** component-scan from auto-configuration. **Never** `@EntityScan` from a library auto-config without `@ConditionalOnProperty`.

### Production scenario: starter throws if API key missing

**Problem.** `AcmeProperties.apiKey` is `@NotBlank`. Every app that transitively depends on the starter fails startup in dev without keys — even when Acme integration is disabled.

**Solution.**

```java
@AutoConfiguration
@ConditionalOnProperty(prefix = "acme", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(AcmeProperties.class)
public class AcmeAutoConfiguration { ... }
```

```yaml
acme:
  enabled: false   # default in library META-INF/additional-spring-configuration-metadata.json
```

Use `@NestedConfigurationProperty` for nested config. Document properties in `additional-spring-configuration-metadata.json` for IDE completion.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auto-config does `@ComponentScan` | Duplicate beans across apps |
| Heavy work in `@Bean` method at init | Slow startup; failures block entire context |
| Missing `@ConditionalOnClass` on optional deps | `NoClassDefFoundError` |
| Properties record without `@EnableConfigurationProperties` on auto-config | Empty properties bean |

### Debugging scenario

**Observe.** Custom starter works in isolation test but not in app.

**Diagnose.** Check `AutoConfiguration.imports` is in the **autoconfigure** jar, not the starter pom-only jar. Run:

```bash
java -jar app.jar --debug 2>&1 | grep AcmeAutoConfiguration
```

**Fix.** Fix packaging; add `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` to `acme-spring-boot-autoconfigure.jar`.

---

## 8. Starters Anatomy

### Core concept

A starter is a **dependency aggregate** — a Maven/Gradle module with no (or minimal) code:

```xml
<!-- spring-boot-starter-web -->
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-json</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-tomcat</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework</groupId>
    <artifactId>spring-webmvc</artifactId>
  </dependency>
</dependencies>
```

`spring-boot-starter` (the "root" starter) pulls:

- `spring-boot`
- `spring-boot-autoconfigure`
- `spring-boot-starter-logging` (Logback by default)
- `jakarta.annotation-api`
- `snakeyaml` (for YAML binding)

### Internal working

Naming convention:

| Pattern | Meaning |
|---|---|
| `spring-boot-starter-*` | Official Spring Boot starters |
| `*-spring-boot-starter` | Third-party (e.g. `mybatis-spring-boot-starter`) |
| `spring-boot-starter-*-test` | Test scope aggregates (`spring-boot-starter-test`) |

Transitive dependency management: versions come from `spring-boot-dependencies` BOM imported by `spring-boot-starter-parent` or explicit `dependencyManagement` import.

Swapping embedded server:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-web</artifactId>
  <exclusions>
    <exclusion>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-tomcat</artifactId>
    </exclusion>
  </exclusions>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-jetty</artifactId>
</dependency>
```

WebFlux:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-webflux</artifactId>
</dependency>
```

**Do not** put both `spring-boot-starter-web` and `spring-boot-starter-webflux` on the classpath unless you know you need both stacks — increases memory, confuses `spring.main.web-application-type`.

### Production scenario: accidental logging starter conflict

**Problem.** A SDK brings `spring-boot-starter-log4j2` while the app uses default Logback. Startup warning:

```
LoggerFactory is not a Logback LoggerContext but Logback is on the classpath.
```

Or worse — silent log loss.

**Solution.** Exclude Log4j2 from the SDK or exclude default logging:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter</artifactId>
  <exclusions>
    <exclusion>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-logging</artifactId>
    </exclusion>
  </exclusions>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-log4j2</artifactId>
</dependency>
```

One logging implementation per app.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Depending on `spring-boot-autoconfigure` directly without `spring-boot` | Missing core hooks |
| Copy-pasting starter deps without BOM | Version skew, `NoSuchMethodError` at runtime |
| `spring-boot-starter-test` in compile scope | JUnit on production classpath |
| Two JSON stacks (Gson + Jackson) without preference | Wrong HTTP message converter order |

### Debugging scenario

**Observe.** `ClassNotFoundException` for `io.micrometer.tracing.Tracer` after adding a starter.

**Diagnose.** `mvn dependency:tree -Dincludes=io.micrometer` — starter may use `optional` scope for tracing.

**Fix.** Add `micrometer-tracing-bridge-otel` explicitly or use the complete observability starter combo documented for your Boot version.

---

## 9. Dependency Management & BOM

### Core concept

`spring-boot-dependencies` is a Maven BOM — a POM that only lists `<dependencyManagement>` versions, no jars. It aligns Spring projects **and** hundreds of third-party libraries (Netty, Jackson, Hibernate, JUnit, Testcontainers, etc.) to combinations Boot's CI actually tested.

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.3.4</version>
</parent>
```

Parent also sets:

- Java version property
- Resource filtering for `application.properties`
- Plugin versions (`spring-boot-maven-plugin`, `maven-compiler-plugin`)
- `repackage` goal defaults

Gradle equivalent:

```kotlin
plugins {
    id("org.springframework.boot") version "3.3.4"
    id("io.spring.dependency-management") version "1.1.6"
}
```

### Internal working

When you declare:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-data-jpa</artifactId>
</dependency>
```

Maven resolves version from BOM. Overriding a single library:

```xml
<properties>
  <jackson-bom.version>2.17.2</jackson-bom.version>
</properties>
```

Or explicit version on the dependency (wins over BOM — you own the fallout).

`spring-boot-starter-parent` → imports `spring-boot-dependencies`. Corporate parent POMs often import only the BOM:

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-dependencies</artifactId>
      <version>${spring-boot.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

### Production scenario: patched Spring Security CVE by bumping only security

**Problem.** Security team mandates `spring-security-bom` 6.3.4 but app stays on Boot 3.2.0 BOM (pulls 6.2.x). Developer overrides `spring-security-core` version only. `FilterChainProxy` `NoSuchMethodError` at runtime because Boot's `SecurityAutoConfiguration` was compiled against a different API.

**Solution.** Upgrade **Boot** patch version (3.2.11 → includes aligned Security). If impossible, import `spring-security-bom` explicitly **and** run full integration tests. Never override one Spring module in isolation on a LTS branch without platform approval.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No BOM — raw versions on 20 deps | Dependency hell, subtle bugs |
| Boot 3 app with `javax.*` libs | `ClassNotFoundException: javax.servlet.Servlet` |
| Mixing Spring Boot 3.3 with Spring Cloud 2022.0.x | `SpringBootVersionNotCompatibleException` |
| `spring-boot-maven-plugin` version ≠ parent Boot version | Repackaging wrong, wrong `loader` |

### Debugging scenario

**Observe.** `NoSuchMethodError` in `spring-data-jpa` after innocuous bump.

**Diagnose.**

```bash
mvn dependency:tree -Dverbose -Dincludes=org.springframework.data
```

Check for multiple Spring Data versions.

**Fix.** Align to Boot BOM; remove explicit versions; use `mvn enforcer:enforce` with `dependencyConvergence`.

---

## 10. Externalized Configuration Fundamentals

### Core concept

Boot externalizes config through the Spring `Environment` — a hierarchy of `PropertySource` objects. Boot adds:

- `application.properties` / `application.yml`
- Profile-specific files (`application-prod.yml`)
- `application-{profile}.properties` on classpath and file system
- `config/application.properties` (legacy search locations)
- `spring.config.import` (cloud config, vault, file trees)
- Command-line args (`--server.port=9090`)
- OS environment variables
- Java system properties

Everything binds to `@ConfigurationProperties`, `@Value`, or direct `Environment.getProperty`.

### Internal working

`ConfigDataEnvironment` (Boot 2.4+) loads config in **layers** with defined precedence. Later property sources override earlier **within the same layer**; between layers, rule table in [PropertySource Order](#14-propertysource-order--relaxed-binding).

`SpringApplication` prepares environment **before** context refresh so auto-config conditions see real properties.

Sensitive values: use Spring Cloud Config / Vault / AWS Secrets Manager via `spring.config.import`:

```yaml
spring:
  config:
    import: optional:vault://secret/acme/orders
```

`optional:` prefix — failure to connect does not abort startup (use carefully).

### Production scenario: k8s ConfigMap mounted but app still uses dev DB

**Problem.** ConfigMap mounted at `/config/application.yaml`. App still hits `jdbc:postgresql://localhost/dev`.

Cause: wrong mount path — Boot 3 default search includes `/config/` only when using `spring.config.additional-location` or standard k8s layout. Team mounted to `/app/config` but did not set:

```yaml
spring:
  config:
    additional-location: file:/app/config/
```

Or: ConfigMap key is `application.yaml` but profile `prod` loads `application-prod.properties` only on classpath — file naming mismatch.

**Solution.**

```yaml
# Helm values
env:
  - name: SPRING_CONFIG_ADDITIONAL_LOCATION
    value: "file:/config/"
```

Verify at runtime:

```bash
curl -s localhost:8080/actuator/env | jq '.propertySources[].name'
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Secrets in `application.properties` committed to git | Credential leak |
| Same property in 4 places, unclear winner | "I changed YAML but nothing happened" |
| `spring.profiles.active` hardcoded in jar | Prod runs with `dev` profile |
| Missing `optional:` on remote config import | Startup fails when Vault blips |

### Debugging scenario

**Observe.** `@Value("${acme.api-key}")` empty in prod.

**Diagnose.**

```bash
curl /actuator/env/acme.api-key
```

Check origin and property source name. Enable:

```yaml
logging.level.org.springframework.boot.context.config=DEBUG
```

**Fix.** Correct env var name (`ACME_API_KEY`); check relaxed binding; ensure profile-specific file is loaded.

---

## 11. Properties, YAML, Environment Variables

### Core concept

Boot accepts `.properties` (flat `key=value`) and `.yaml`/`.yml` (hierarchical). YAML is **not** a superset of magic — it is still flattened into property keys:

```yaml
server:
  port: 8080
  servlet:
    context-path: /api
```

equals `server.port=8080` and `server.servlet.context-path=/api`.

Environment variables use relaxed binding rules (see [Section 14](#14-propertysource-order--relaxed-binding)):

| Property | Environment variable |
|---|---|
| `server.port` | `SERVER_PORT` |
| `spring.datasource.url` | `SPRING_DATASOURCE_URL` |
| `acme.feature.enabled` | `ACME_FEATURE_ENABLED` |

Command-line args (highest precedence among common sources):

```bash
java -jar app.jar --server.port=9090 --spring.profiles.active=prod
```

### Internal working

`ConfigDataPropertySource` loads files. Multi-document YAML separated by `---`:

```yaml
spring:
  config:
    activate:
      on-profile: prod
server:
  port: 8080
---
spring:
  config:
    activate:
      on-profile: dev
server:
  port: 8081
```

Profile activation inside the same file — useful for single-file k8s ConfigMaps.

`application.properties` in `src/main/resources` is packaged into the jar. External overrides should use env vars, `spring.config.import`, or mounted files — not rebuilding the jar per environment.

### Production scenario: boolean property "false" still enables feature

**Problem.**

```yaml
acme:
  feature:
    enabled: false
```

In k8s:

```yaml
env:
  - name: ACME_FEATURE_ENABLED
    value: "false"
```

`@ConditionalOnProperty(..., havingValue = "true")` — string `"false"` is truthy in some older SpEL paths; Boot 3 treats `false`, `off`, `no` as false for `relaxedBoolean` binding. But:

```java
@ConditionalOnProperty(prefix = "acme.feature", name = "enabled")
```

matches **any** value including empty string — feature ON.

**Solution.** Always specify `havingValue = "true"` and `matchIfMissing = false`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Tabs in YAML | Parser errors, cryptic line numbers |
| `spring.profiles.active: prod` in `application-prod.yml` | Infinite profile recursion warning |
| Unquoted `on` / `off` in YAML 1.1 parsers | Treated as boolean incorrectly |
| Duplicate keys in YAML — last wins silently | "Ghost" config |

### Debugging scenario

**Observe.** Helm chart sets env vars; app ignores them.

**Diagnose.** Spring Boot binds env vars on startup only. Check for typos: `SPRING_DATASOURCE_URL` vs `SPRING_DATA_SOURCE_URL` (wrong — no underscore between DATA and SOURCE).

Use `/actuator/env` and search for `datasource.url`.

**Fix.** Follow relaxed binding table. Prefer `SPRING_APPLICATION_JSON` for complex structures in k8s:

```yaml
env:
  - name: SPRING_APPLICATION_JSON
    value: '{"server":{"port":8080},"acme":{"feature":{"enabled":true}}}'
```

---

## 12. Profiles

### Core concept

Profiles are conditional bean registration and config file activation:

```java
@Profile("prod")
@Bean
MeterRegistry meterRegistry() { return new PrometheusMeterRegistry(...); }

@Profile("!prod")
@Bean
MeterRegistry meterRegistry() { return new SimpleMeterRegistry(); }
```

Activate via:

```properties
spring.profiles.active=prod,cloud
spring.profiles.default=local
```

`spring.profiles.group` (Boot 2.4+):

```yaml
spring:
  profiles:
    group:
      production:
        - prod
        - metrics
        - tracing
```

Activating `production` activates all three.

### Internal working

`Environment.acceptsProfiles(Profiles.of("prod"))` drives `@Profile` on `@Bean`, `@Component`, `@Configuration`.

Config files: `application-{profile}.properties` loaded **after** base `application.properties` for matching profiles.

Order of profile activation sources (highest wins for `spring.profiles.active`):

1. Programmatic `SpringApplication.setAdditionalProfiles`
2. Command line `--spring.profiles.active`
3. `SPRING_PROFILES_ACTIVE` env var
4. `application.properties` value (discouraged for prod)

`@ActiveProfiles("test")` in tests — separate from production profile mechanics.

### Production scenario: `dev` profile in production jar

**Problem.** `application.properties` contains:

```properties
spring.profiles.active=dev
```

Docker image built once, runs in prod with dev H2 console enabled and `DEBUG` logging.

**Solution.**

```properties
# application.properties — no active profile
spring.profiles.default=local
```

```yaml
# k8s deployment
env:
  - name: SPRING_PROFILES_ACTIVE
    value: prod
```

CI gate: fail build if `spring.profiles.active` appears in packaged `application.properties`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Profile("prod")` on main `@SpringBootApplication` class | Bean not loaded — main class skipped |
| Profile-specific beans without default | Context fails when profile missing |
| `spring.profiles.active` in config data profile file | Surprising override order |
| Same bean name in two profiles without `@Primary` | `NoUniqueBeanDefinitionException` when both active |

### Debugging scenario

**Observe.** Beans in `@Profile("kafka")` missing in staging.

**Diagnose.**

```bash
curl /actuator/env/spring.profiles.active
```

Logs at startup: `The following 1 profile is active: "staging"` — note `kafka` not active.

**Fix.** Add `kafka` to profile group or `SPRING_PROFILES_ACTIVE=staging,kafka`.

---

## 13. @ConfigurationProperties + Validation + Records

### Core concept

Type-safe binding:

```java
@ConfigurationProperties(prefix = "orders")
@Validated
public record OrderSettings(
    @Min(1) int maxItems,
    @NotNull Duration fulfillmentTimeout,
    @Valid ShippingDefaults shipping
) {}

public record ShippingDefaults(
    @NotBlank String defaultCarrier,
    boolean expressEnabled
) {}
```

Enable on a `@Configuration` class:

```java
@Configuration
@EnableConfigurationProperties(OrderSettings.class)
public class OrderConfig { }
```

Or `@EnableConfigurationProperties` on `@SpringBootApplication` / auto-config.

Boot 3 supports **constructor binding** for records and immutable classes by default when a single constructor exists.

### Internal working

`ConfigurationPropertiesBindingPostProcessor` binds `Environment` → object using `JavaBeanBinder` or `ConstructorBinder`. Validation runs via `MethodValidationPostProcessor` if `@Validated` present.

`@ConfigurationPropertiesScan("com.acme")` — finds `@ConfigurationProperties` types without listing each one.

`@NestedConfigurationProperty` — nested POJO/record in a mutable class.

Metadata: `META-INF/additional-spring-configuration-metadata.json` for IDE hints:

```json
{
  "properties": [
    {
      "name": "orders.max-items",
      "type": "java.lang.Integer",
      "defaultValue": 50,
      "description": "Maximum line items per order."
    }
  ]
}
```

### Production scenario: record binding fails on k8s env-only deploy

**Problem.**

```java
@ConfigurationProperties(prefix = "payment")
public record PaymentProps(@NotBlank String webhookSecret) {}
```

No `payment.webhook-secret` in any file — team expects `PAYMENT_WEBHOOK_SECRET` env var. Works locally in IDE (env set in run config) but fails in k8s with validation error.

Cause: secret not in Deployment manifest; or wrong key `PAYMENT_WEBHOOK-SECRET`.

**Solution.** Mount secret; verify binding:

```yaml
env:
  - name: PAYMENT_WEBHOOK_SECRET
    valueFrom:
      secretKeyRef:
        name: payment-secrets
        key: webhook-secret
```

Add `@DefaultValue` (Boot 3.2+) only for non-secret defaults — never default secrets.

### Production scenario: mutable `@ConfigurationProperties` class modified at runtime

**Problem.** Team injects `AppProperties` and mutates fields in a request handler. Concurrent requests race; values leak between tenants.

**Solution.** Use **immutable** records; restart context for config changes; or use `@RefreshScope` (Spring Cloud) knowing it breaks singleton assumptions.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@ConfigurationProperties` without `@Enable` or scan | Bean exists but empty / defaults |
| `@Value` for 20 related keys instead of one properties class | Untestable config sprawl |
| Validation on properties but no `@Validated` | Constraints ignored |
| `Duration` binding without unit (`10` vs `10s`) | `ConversionFailedException` |

### Debugging scenario

**Observe.** `orders.max-items` binds as 0.

**Diagnose.** Typo in YAML `maxItems` vs `max-items`. Check:

```bash
curl /actuator/configprops | jq '.contexts.application.beans.ordersSettings'
```

**Fix.** Align property names; use metadata JSON for team documentation.

---

## 14. PropertySource Order & Relaxed Binding

### Core concept

When the same key exists in multiple sources, **precedence** decides the winner. Simplified Boot 3 order (highest precedence first — **wins**):

| Precedence | Source |
|---|---|
| 1 | Devtools global settings (dev only) |
| 2 | `@TestPropertySource` on test class |
| 3 | `properties` attribute on `@SpringBootTest` |
| 4 | Command-line arguments |
| 5 | `SPRING_APPLICATION_JSON` (inline JSON env var) |
| 6 | `ServletConfig` init params (web) |
| 7 | `ServletContext` init params (web) |
| 8 | `JNDI` attributes |
| 9 | `JAVA_SYSTEM_PROPERTIES` (`System.setProperty`) |
| 10 | OS environment variables |
| 11 | `RandomValuePropertySource` |
| 12 | `application-{profile}.properties` **outside** jar |
| 13 | `application-{profile}.properties` **inside** jar |
| 14 | `application.properties` **outside** jar |
| 15 | `application.properties` **inside** jar |
| 16 | `@PropertySource` on `@Configuration` classes |
| 17 | Default properties (`SpringApplication.setDefaultProperties`) |

Within `config/` imports via `spring.config.import`, later imports override earlier.

### Relaxed binding rules

| Property form | Accepted variants |
|---|---|
| `acme.my-service.url` | `ACME_MY_SERVICE_URL`, `acme.myService.url`, `ACME_MYSERVICE_URL` |
| `acme.active` (boolean) | `true`/`false`, `on`/`off`, `yes`/`no`, `1`/`0` |
| Lists | Comma-separated in properties; YAML array in yml |
| Maps | `acme.flags[key]=value` or YAML nested map |
| `Duration` | `10s`, `500ms`, `PT10S` (also numeric ms in some versions) |
| `DataSize` | `10MB`, `512KB` |

### Internal working

`Binder` API (Boot 2+) is the unified binding mechanism:

```java
Binder.get(environment).bind("acme.my-service", Bindable.of(MyServiceProps.class));
```

`ConfigurationPropertyName` canonicalizes kebab-case.

### Production scenario: Config Server vs local override fight

**Problem.**

```yaml
spring:
  config:
    import: configserver:https://config.acme.com
```

Also `application-prod.properties` in jar sets `spring.datasource.url`. Team expects Config Server to win; jar value wins because import order and profile file layering put classpath `application-prod.properties` after config server in some Boot 2.4 migrations.

**Solution.** Boot 3 config import order — put local overrides in `application-local.properties` (not packaged) or use `spring.cloud.config.allow-override=false` (Spring Cloud). Document precedence in platform runbook.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Assuming `.env` file auto-loaded | Boot does not load `.env` without dotenv library |
| `System.getenv` in `@PostConstruct` vs `@Value` | Different timing; env may not match bound value if changed |
| Property with special chars unquoted in shell | Broken URL in `SPRING_DATASOURCE_URL` |

### Debugging scenario

**Observe.** "I set SERVER_PORT=9090 but still on 8080."

**Diagnose.** Command-line `--server.port=8080` in `JAVA_TOOL_OPTIONS` wins over env. Check all sources in `/actuator/env`.

**Fix.** Remove conflicting higher-precedence source.

---

## 15. Spring Boot Actuator Overview

### Core concept

Actuator exposes **production-ready endpoints** over HTTP and JMX — health, metrics, env, loggers, etc. Enabled by:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

Base path defaults to `/actuator`. Individual endpoints enabled selectively:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
      base-path: /actuator
  endpoint:
    health:
      show-details: when_authorized
```

### Internal working

Each endpoint is an `@Endpoint` bean:

```java
@Endpoint(id = "health")
public class HealthEndpoint { ... }
```

`@WebEndpoint` / `@RestControllerEndpoint` expose over HTTP via `WebMvcEndpointHandlerMapping`.

`EndpointDiscoverer` collects endpoints; `ExposableEndpoint` filtered by `EndpointFilter` (security, cloud).

CORS, port separation:

```yaml
management:
  server:
    port: 9090
    address: 127.0.0.1
```

Management context on separate port — reduces attack surface; k8s probes hit 9090.

### Production scenario: all endpoints exposed with `include: '*'`

**Problem.** Pen test finds `/actuator/env` dumps `DATABASE_PASSWORD`, `/actuator/heapdump` downloads memory, `/actuator/shutdown` reachable.

**Solution.**

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    shutdown:
      enabled: false
    env:
      show-values: never   # Boot 3.3+
```

Network policy: only Prometheus scrapes management port. Never expose management on public LB.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Actuator on main port without security | Full env leak |
| `show-details: always` on health | Dependency names expose architecture |
| Missing `spring-boot-starter-actuator` | "Add actuator" in docs but no dependency |
| JMX endpoints open on shared JVM | MBean invoke from other apps on same host |

### Debugging scenario

**Observe.** `/actuator/health` returns 404.

**Diagnose.** Wrong context path — `server.servlet.context-path=/api` → health at `/api/actuator/health` unless `management.endpoints.web.base-path` changed.

**Fix.** Configure probe paths in k8s to match; or set `management.server.port` on separate listener.

---

## 16. Health, Liveness, Readiness

### Core concept

`HealthEndpoint` aggregates `HealthContributor` beans:

| Contributor | Default |
|---|---|
| `DiskSpaceHealthIndicator` | WARN if &lt; 10MB free |
| `PingHealthIndicator` | Always UP |
| `DataSourceHealthIndicator` | If JDBC present |
| `RedisHealthIndicator` | If Redis present |
| `LivenessStateHealthIndicator` | Boot 2.3+ |
| `ReadinessStateHealthIndicator` | Boot 2.3+ |

Response:

```json
{
  "status": "UP",
  "components": {
    "db": { "status": "UP", "details": { "database": "PostgreSQL" } },
    "diskSpace": { "status": "UP" },
    "readinessState": { "status": "UP" }
  }
}
```

Kubernetes probes (Boot 2.3+):

```yaml
management:
  endpoint:
    health:
      probes:
        enabled: true
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true
```

Exposes `/actuator/health/liveness` and `/actuator/health/readiness`.

### Internal working

`HealthIndicator` (singular) → legacy path; implement `HealthContributor` or extend `AbstractHealthIndicator`.

Application availability:

```java
ApplicationAvailability.getLivenessState();  // CORRECT / BROKEN
ApplicationAvailability.getReadinessState(); // ACCEPTING_TRAFFIC / REFUSING_TRAFFIC
```

Refuse traffic during warmup:

```java
@Component
public class WarmupManager {
    private final ApplicationAvailability availability;
    WarmupManager(ApplicationAvailability availability) {
        this.availability = availability;
        availability.changeReadinessState(ReadinessState.REFUSING_TRAFFIC);
    }
    @EventListener(ApplicationReadyEvent.class)
    void onReady() {
        // load caches...
        availability.changeReadinessState(ReadinessState.ACCEPTING_TRAFFIC);
    }
}
```

Group health for k8s:

```yaml
management:
  endpoint:
    health:
      group:
        readiness:
          include: readinessState,db,redis
        liveness:
          include: livenessState,ping
```

### Production scenario: DB blip kills entire pod during rolling deploy

**Problem.** `readinessProbe` hits `/actuator/health` which includes `db`. Transient connection pool timeout → `DOWN` → pod removed from service → thundering herd.

**Solution.** Split probes:

```yaml
management:
  endpoint:
    health:
      group:
        readiness:
          include: readinessState
        liveness:
          include: livenessState
```

Custom `readiness` includes DB only if you accept pod removal on DB failure. Often DB check belongs on **startup** probe, not readiness every 5s.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Liveness probe includes DB | Pod restart loop during DB maintenance |
| Health `DOWN` returns HTTP 503 | k8s kills pod — intended for readiness, not always liveness |
| Custom indicator throws exception | Overall health `DOWN` — use `Health.down().withException(e)` carefully |
| Reactive app — blocking JDBC in health | Event loop blocked |

### Debugging scenario

**Observe.** Health UP but k8s marks pod NotReady.

**Diagnose.** Probe hits wrong port/path; TLS mismatch; 401 because security not configured for actuator.

```bash
kubectl exec pod -- curl -s localhost:9090/actuator/health/readiness
```

**Fix.** Align probe config; permit health endpoints in security filter chain.

---

## 17. Metrics & Micrometer Integration

### Core concept

Boot 2+ uses **Micrometer** as metrics facade. Auto-configures registries:

| Registry | When |
|---|---|
| `SimpleMeterRegistry` | Default if nothing else |
| `PrometheusMeterRegistry` | `micrometer-registry-prometheus` on classpath |
| `StackdriverMeterRegistry` | GCP dep present |
| OTLP export | `micrometer-registry-otlp` + config |

```yaml
management:
  metrics:
    export:
      prometheus:
        enabled: true
    tags:
      application: ${spring.application.name}
      environment: ${spring.profiles.active:default}
  endpoints:
    web:
      exposure:
        include: prometheus
```

Scrape `/actuator/prometheus`.

### Internal working

`MeterRegistryCustomizer` beans add common tags. Auto-timing:

- `@Timed` (Micrometer) — method metrics
- `http.server.requests` — MVC/WebFlux auto-timing
- `jdbc.connections` — pool metrics (HikariCP)
- JVM, GC, memory, threads — `JvmMetricsAutoConfiguration`
- Logback metrics — `LogbackMetricsAutoConfiguration`

Observability (Boot 3.2+):

```xml
<dependency>
  <groupId>io.micrometer</groupId>
  <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
```

`management.tracing.enabled=true` — trace propagation headers.

### Production scenario: metric cardinality explosion

**Problem.** Custom metric:

```java
registry.counter("orders.created", "customerId", customerId).increment();
```

Prometheus OOM; Grafana slow; cardinality in millions.

**Solution.**

```java
registry.counter("orders.created", "tier", customerTier).increment();
```

Use `distribution.statistics` for SLIs; low-cardinality tags only. Use tracing for per-request detail.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Two `MeterRegistry` beans without `@Primary` | Metrics split across registries |
| Percentiles on every timer | Memory bloat |
| Missing `common tags` | Can't slice metrics per service in k8s |
| Scraping `/actuator/metrics` instead of prometheus endpoint | Incomplete histograms |

### Debugging scenario

**Observe.** HTTP metrics missing after WebFlux migration.

**Diagnose.** `WebFluxMetricsAutoConfiguration` requires `spring-boot-starter-webflux`. Check `management.metrics.enable.http=true`.

**Fix.** Add correct starter; verify filter `WebFluxObservationFilter` registered.

---

## 18. Loggers, Env, Info Endpoints

### Core concept

| Endpoint | Purpose |
|---|---|
| `/actuator/loggers` | GET/POST log levels at runtime |
| `/actuator/env` | Property sources and values |
| `/actuator/info` | Arbitrary app info from `InfoContributor` |
| `/actuator/configprops` | Bound `@ConfigurationProperties` beans |
| `/actuator/beans` | Full bean listing |
| `/actuator/conditions` | Auto-config condition report |
| `/actuator/threaddump` | JVM thread dump |
| `/actuator/heapdump` | HPROF download — **dangerous** |

Runtime log level change:

```bash
curl -X POST localhost:8080/actuator/loggers/com.acme.orders \
  -H 'Content-Type: application/json' \
  -d '{"configuredLevel": "DEBUG"}'
```

Resets on restart unless `logging.level.com.acme.orders=DEBUG` in config.

### Internal working

`LoggingSystem` abstraction — Logback by default. `loggers` endpoint calls `LoggingSystem.setLogLevel`.

`InfoContributor` beans merge into `/actuator/info`:

```java
@Component
public class BuildInfoContributor implements InfoContributor {
    @Override
    public void contribute(Builder builder) {
        builder.withDetail("build", Map.of(
            "version", buildProperties.getVersion(),
            "time", buildProperties.getTime()
        ));
    }
}
```

`EnvironmentEndpoint` sanitizes keys matching `management.endpoint.env.keys-to-sanitize` (password, secret, key, token, credentials).

### Production scenario: DEBUG left on via actuator during incident

**Problem.** On-call sets `org.hibernate.SQL=DEBUG` via actuator during incident, forgets to revert. Disk fills with logs; PII in SQL logs violates compliance.

**Solution.**

- Disable `loggers` endpoint in prod (`management.endpoint.loggers.enabled=false`) or restrict via security roles.
- Incident runbook: note original levels; automate revert.
- Prefer structured logging + trace IDs over blanket DEBUG.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `/actuator/env` exposed publicly | Credential leak even with partial sanitize |
| `info.git.mode=full` in regulated env | Source details exposed |
| `configprops` shows secret fields on properties beans | Bean holds secret in memory — mask in custom serializer |

### Debugging scenario

**Observe.** `info` endpoint empty.

**Diagnose.** No `InfoContributor`; `management.info.*` env vars not set:

```yaml
management:
  info:
    env:
      enabled: true
    java:
      enabled: true
```

**Fix.** Enable git plugin `git-commit-id-plugin` for `info.git.*`.

---

## 19. Actuator Security

### Core concept

Actuator endpoints are URLs. Secure them like admin APIs:

```java
@Bean
@Order(Ordered.HIGHEST_PRECEDENCE)
SecurityFilterChain actuatorSecurity(HttpSecurity http) throws Exception {
    http
        .securityMatcher(EndpointRequest.toAnyEndpoint())
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(EndpointRequest.to("health", "info")).permitAll()
            .requestMatchers(EndpointRequest.to("prometheus")).hasRole("METRICS")
            .anyRequest().hasRole("ACTUATOR"))
        .httpBasic(Customizer.withDefaults());
    return http.build();
}
```

Or separate management port on internal network only.

Spring Boot 3 **does not** auto-secure actuator separately — same security chain unless you split.

### Internal working

`EndpointRequest` builds `RequestMatcher` for actuator paths considering `management.endpoints.web.base-path` and `management.server.port`.

CORS rarely needed on management port. If on same port as API, CSRF applies to POST loggers — use token or disable CSRF for actuator matcher.

### Production scenario: Prometheus scrape gets 401

**Problem.** Security requires auth for all `/actuator/**`. Prometheus config has no credentials.

**Solution.**

```java
.requestMatchers(EndpointRequest.to("health", "info", "prometheus")).permitAll()
```

Network-restrict management port; mTLS between Prometheus and app is better than `permitAll` on public internet.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Actuator permitted but main API secured — same port | Accidental exposure via path guessing |
| Basic auth default password in `spring.security.user` | Trivially scraped |
| OAuth2 resource server applies to `/actuator/health` | k8s probes fail with 401 |

### Debugging scenario

**Observe.** 403 on POST `/actuator/loggers` with valid JWT.

**Diagnose.** CSRF or missing `ACTUATOR` scope/role. Check filter chain order.

**Fix.** Separate management context or explicit `csrf.ignoringRequestMatchers(EndpointRequest.toAnyEndpoint())` for stateless admin API.

---

## 20. Custom Health Indicators

### Core concept

```java
@Component
public class PaymentGatewayHealthIndicator implements HealthIndicator {

    private final PaymentClient client;

    PaymentGatewayHealthIndicator(PaymentClient client) {
        this.client = client;
    }

    @Override
    public Health health() {
        try {
            Duration latency = client.ping();
            if (latency.toMillis() > 2_000) {
                return Health.status("DEGRADED")
                    .withDetail("latencyMs", latency.toMillis())
                    .build();
            }
            return Health.up().withDetail("latencyMs", latency.toMillis()).build();
        } catch (Exception ex) {
            return Health.down(ex).build();
        }
    }
}
```

Custom status strings appear in JSON; k8s only understands UP/DOWN unless using custom `HttpStatusMapper`.

Reactive:

```java
@Component
public class PaymentReactiveHealthIndicator implements ReactiveHealthIndicator {
    @Override
    public Mono<Health> health() {
        return client.ping().map(latency -> Health.up().withDetail("latencyMs", latency).build())
            .timeout(Duration.ofSeconds(3))
            .onErrorResume(ex -> Mono.just(Health.down(ex).build()));
    }
}
```

### Internal working

`HealthContributorRegistry` collects all indicators. `HealthEndpoint` aggregates — worst status wins (DOWN &gt; OUT_OF_SERVICE &gt; UNKNOWN &gt; UP).

`HealthIndicatorReactiveAdapter` bridges reactive to servlet stack.

### Production scenario: health check calls paid API 1000 times per minute

**Problem.** Each k8s node probes every pod every 5s; health indicator calls Stripe `/v1/charges` — rate limited; costs money.

**Solution.** Check **cheap** dependency: TCP connect, cached status updated by background task, or `PingHealthIndicator` only on liveness.

```java
@Scheduled(fixedRate = 30_000)
void refreshGatewayStatus() { ... }

@Override
public Health health() {
    return lastKnownGood ? Health.up().build() : Health.down().build();
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Synchronous HTTP in reactive health | Blocked event loop |
| Health indicator `@Transactional` hits DB | Connection pool exhaustion under probe load |
| Throwing raw exception with PII in message | Details exposed in `/actuator/health` |

### Debugging scenario

**Observe.** Overall health DOWN but all components UP.

**Diagnose.** Custom status `OUT_OF_SERVICE` on one component; or `HealthEndpoint` group filter.

**Fix.** Inspect full JSON; check group `include`/`exclude` lists.

---

## 21. Graceful Shutdown

### Core concept

Boot 2.3+ supports graceful shutdown for embedded web servers:

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

On SIGTERM (k8s pod deletion):

1. Stop accepting new requests
2. Complete in-flight requests (up to timeout)
3. Close application context

### Internal working

`SmartLifecycle` beans stop in reverse order. `WebServerGracefulShutdownLifecycle` triggers:

- Tomcat: `Connector.pause()` + wait for active requests
- Jetty: `Server.setStopTimeout`
- Netty (WebFlux): `DisposableServer.dispose()` with grace period

Kubernetes:

```yaml
spec:
  terminationGracePeriodSeconds: 60
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 5"]
```

Allows load balancer to drain connections before SIGTERM hits app.

### Production scenario: messages lost on deploy

**Problem.** Kafka consumer pod killed mid-batch; no graceful stop; duplicates on restart without idempotency.

**Solution.**

```java
@Bean
ConcurrentKafkaListenerContainerFactory<String, String> factory() {
    factory.getContainerProperties().setShutdownTimeout(20_000);
    return factory;
}
```

```yaml
spring:
  kafka:
    listener:
      type: batch
server:
  shutdown: graceful
```

Align `terminationGracePeriodSeconds` &gt; `timeout-per-shutdown-phase` + preStop sleep.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `server.shutdown=immediate` (default pre-2.3) | 502s during rolling update |
| Grace period shorter than longest request | Forced kill mid-flight |
| `@PreDestroy` opens new HTTP calls | Hangs shutdown |
| Batch job without pause hook | Partial writes |

### Debugging scenario

**Observe.** 502 spikes every deploy.

**Diagnose.** LB removes pod before graceful completes; `timeout-per-shutdown-phase` too short.

**Fix.** Increase timeouts; configure preStop; verify `server.shutdown=graceful` in **prod** profile.

---

## 22. Embedded Tomcat / Jetty / Netty Tuning

### Core concept

Default servlet stack: **Tomcat**. Key properties:

```yaml
server:
  port: 8080
  tomcat:
    threads:
      max: 200
      min-spare: 10
    max-connections: 8192
    accept-count: 100
    connection-timeout: 5s
    max-http-form-post-size: 2MB
    max-swallow-size: 2MB
    accesslog:
      enabled: true
      pattern: '%h %l %u %t "%r" %s %b %D'
  compression:
    enabled: true
    mime-types: application/json,application/xml,text/html
  forward-headers-strategy: framework
```

Jetty: `server.jetty.threads.max`, `server.jetty.connection-idle-timeout`.

WebFlux Netty:

```yaml
server:
  netty:
    connection-timeout: 5s
    idle-timeout: 60s
spring:
  webflux:
    multipart:
      max-in-memory-size: 1MB
```

### Internal working

`ServletWebServerFactoryAutoConfiguration` creates `TomcatServletWebServerFactory` bean unless Jetty/Undertow on classpath.

Customizers:

```java
@Bean
WebServerFactoryCustomizer<TomcatServletWebServerFactory> tomcatCustomizer() {
    return factory -> factory.addConnectorCustomizers(connector -> {
        connector.setProperty("relaxedQueryChars", "[]|{}^`");
    });
}
```

HTTP/2: `server.http2.enabled=true` (TLS required in practice).

### Production scenario: thread pool exhaustion under load

**Problem.** Latency spikes; Tomcat thread pool saturated; `max-connections` not the bottleneck — threads are.

**Solution.**

```yaml
server:
  tomcat:
    threads:
      max: 400
```

But fix root cause: blocking calls on servlet threads (reactive migration, `@Async`, virtual threads in Boot 3.2+):

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

Profile before raising threads — more threads = more memory, context switching.

### Production scenario: wrong client IP behind ALB

**Problem.** Rate limiting uses `request.getRemoteAddr()` — always LB IP.

**Solution.**

```yaml
server:
  forward-headers-strategy: framework
```

Trust only when behind known proxy; validate `X-Forwarded-For` chain.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `max-http-header-size` too small for JWT cookies | 400 Bad Request |
| Access log disabled in prod | No request audit trail |
| Netty + blocking JDBC on event loop | Latency under load |
| Undertow + HTTP/2 in old Boot | Unsupported combo |

### Debugging scenario

**Observe.** `Connection reset` under upload.

**Diagnose.** `max-swallow-size` / multipart limits. Tomcat cancels upload.

**Fix.** Increase limits or stream to storage; don't buffer entire file in memory.

---

## 23. DevTools (Dev Only)

### Core concept

`spring-boot-devtools` provides:

- **Automatic restart** on classpath change (not JVM hot-swap of methods)
- **LiveReload** browser refresh
- **Development-only properties** (`spring.devtools.restart.enabled`)
- Remote dev support (deprecated pattern — avoid in prod)

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-devtools</artifactId>
  <scope>runtime</scope>
  <optional>true</optional>
</dependency>
```

### Internal working

`RestartClassLoader` loads user code; base classloader holds dependencies. Changes to `src/main/java` trigger context refresh — faster than cold start, slower than JRebel.

Excluded resources by default: `/static/**`, `/public/**`, templates can be tuned via `spring.devtools.restart.exclude`.

**Never** package DevTools in production:

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <configuration>
    <excludeDevtools>true</excludeDevtools>
  </configuration>
</plugin>
```

`optional=true` prevents transitive dep; `excludeDevtools` prevents repackaging.

### Production scenario: DevTools in prod fat jar

**Problem.** Pen test flags DevTools JAR; `RemoteDevTools` port accidentally exposed; restart endpoint allows DoS.

**Solution.** CI check:

```bash
jar tf app.jar | grep devtools && exit 1
```

Gradle: `developmentOnly` configuration.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| DevTools restart vs `@PreDestroy` | Beans not cleaned — connection leak in dev |
| LiveReload port conflict | Silent failure |
| DevTools PropertySource highest precedence | "Works in dev, breaks in prod" for flags |

### Debugging scenario

**Observe.** Context does not restart on save in IDE.

**Diagnose.** IDE not compiling to `target/classes`; project not on classpath; `spring.devtools.restart.enabled=false`.

**Fix.** Enable "Build project automatically"; verify output path.

---

## 24. Spring Boot Docker Layers & Container Images

### Core concept

Boot layers split fat jar for efficient Docker cache:

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <configuration>
    <layers>
      <enabled>true</enabled>
    </layers>
  </configuration>
</plugin>
```

Layers (default):

1. `dependencies` — third-party libs
2. `spring-boot-loader` — launcher
3. `snapshot-dependencies` — SNAPSHOT jars
4. `application` — your code

Dockerfile:

```dockerfile
FROM eclipse-temurin:21-jre as builder
WORKDIR /builder
ARG JAR_FILE=target/*.jar
COPY ${JAR_FILE} application.jar
RUN java -Djarmode=tools -jar application.jar extract --layers --destination extracted

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=builder /builder/extracted/dependencies/ ./
COPY --from=builder /builder/extracted/spring-boot-loader/ ./
COPY --from=builder /builder/extracted/snapshot-dependencies/ ./
COPY --from=builder /builder/extracted/application/ ./
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
```

`spring-boot:build-image` (Cloud Native Buildpacks):

```bash
mvn spring-boot:build-image -Dspring-boot.build-image.imageName=acme/orders:1.0
```

### Internal working

`JarLauncher` sets up classpath from nested jars. Layer tools (`layertools` / `jarmode=tools`) extract without full unpack at runtime.

Distroless / non-root:

```dockerfile
USER 1000:1000
ENV JAVA_TOOL_OPTIONS="-XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0"
```

### Production scenario: 800MB image, 5-minute CI

**Problem.** Single-layer `COPY app.jar` — any code change invalidates entire layer; push/pull slow.

**Solution.** Enable layers; multi-stage build; `.dockerignore` for `target/` except final jar.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Running fat jar without JRE modules | `ClassNotFoundException` for crypto on custom JRE |
| Missing `USE_CONTAINER_SUPPORT` | JVM ignores k8s memory limits |
| Building on Mac M1 for prod AMD64 without platform | Exec format error |

### Debugging scenario

**Observe.** `extract` layer step fails in CI.

**Diagnose.** Boot plugin version &lt; 2.3 or `jarmode` typo.

**Fix.** Upgrade plugin; use `java -Djarmode=tools -jar app.jar extract --layers`.

---

## 25. Build Info

### Core concept

Expose build metadata via actuator `/actuator/info` and runtime `BuildProperties`:

```xml
<plugin>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-maven-plugin</artifactId>
  <executions>
    <execution>
      <goals>
        <goal>build-info</goal>
      </goals>
    </execution>
  </executions>
  <configuration>
    <additionalProperties>
      <encoding.source>UTF-8</encoding.source>
      <team>orders-platform</team>
    </additionalProperties>
  </configuration>
</plugin>
```

Generates `META-INF/build-info.properties`:

```properties
build.artifact=orders-service
build.version=2.4.1
build.time=2026-08-31T12:00:00Z
```

```java
@RestController
class VersionController {
    private final BuildProperties build;
    VersionController(BuildProperties build) { this.build = build; }
    @GetMapping("/version")
    Map<String, String> version() {
        return Map.of("version", build.getVersion(), "time", build.getTime().toString());
    }
}
```

Git info via `git-commit-id-maven-plugin` → `info.git.commit.id`.

### Internal working

`BuildPropertiesAutoConfiguration` loads `build-info.properties` from classpath. Fails silently if missing — bean optional.

Gradle:

```kotlin
springBoot {
    buildInfo()
}
```

### Production scenario: cannot correlate logs with deployed version

**Problem.** Logs lack version; ops asks "which commit is prod?" during incident.

**Solution.** `build-info` + structured JSON logging field for `build.version`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `build-info` goal not bound to `package` | Empty `BuildProperties` |
| SNAPSHOT version in prod image tag only | `/info` still shows SNAPSHOT |
| Git plugin on shallow clone CI | `git.commit.id.abbrev` = `0000000` |

### Debugging scenario

**Observe.** `BuildProperties` bean missing.

**Diagnose.** `build-info.properties` not in jar — `jar tf app.jar | grep build-info`.

**Fix.** Add `build-info` execution to `spring-boot-maven-plugin`.

---

## 26. Test Slices

### Core concept

`@SpringBootTest` loads **full** context — slow, integrates everything. **Slices** load only one vertical:

| Annotation | Loads |
|---|---|
| `@WebMvcTest` | MVC, JSON, MockMvc — **not** `@Service`/`@Repository` unless `@Import` |
| `@WebFluxTest` | WebFlux controllers |
| `@DataJpaTest` | JPA, in-memory DB by default, `@Transactional` rollback |
| `@JdbcTest` | `JdbcTemplate`, no JPA |
| `@JsonTest` | Jackson `ObjectMapper`, `@JsonComponent` |
| `@RestClientTest` | `MockRestServiceServer`, REST clients |
| `@DataMongoTest` | Mongo repositories |
| `@DataRedisTest` | Redis |
| `@DataLdapTest` | LDAP |
| `@AutoConfigureMockMvc` | Add MockMvc to `@SpringBootTest` |
| `@AutoConfigureWebTestClient` | WebTestClient for WebFlux |
| `@MockBean` / `@SpyBean` | Replace bean in test context |

### Internal working

`@WebMvcTest(controllers = OrderController.class)` imports:

- `SpringBootAutoConfiguration` subset via `@ImportAutoConfiguration`
- `AutoConfigureWebMvc`
- Security auto-config **disabled by default** unless `@Import(SecurityConfig.class)`

`@DataJpaTest` uses `@TypeExcludeFilters` to exclude non-JPA beans. `@EntityScan` on test or rely on auto-config package of test class.

`@MockBean` registers Mockito mock in context **replacing** real bean definition.

### Production scenario: `@WebMvcTest` passes, prod 500

**Problem.** Controller test mocks `OrderService`; real service has `@Transactional` + validation + security rules never exercised.

**Solution.** Layer tests:

```java
@WebMvcTest(OrderController.class)
@Import(SecurityConfig.class)
class OrderControllerTest {
    @Autowired MockMvc mvc;
    @MockBean OrderService orders;
}

@DataJpaTest
class OrderRepositoryTest { ... }

@SpringBootTest
@AutoConfigureMockMvc
class OrderIntegrationTest { ... }
```

### Production scenario: `@DataJpaTest` hides missing `@EntityScan`

**Problem.** Test passes (uses default package); prod fails — entities not managed.

**Solution.**

```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = Replace.NONE)
@Import(JpaConfig.class)
class OrderRepositoryIT { ... }
```

Use Testcontainers for PostgreSQL parity.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@MockBean` on every dependency in `@SpringBootTest` | Test proves nothing |
| `@DataJpaTest` without `@Import` of custom `AuditorAware` | Audit fields null — false positive |
| `@WebMvcTest` + `@Autowired OrderService` | Context fail — service not loaded |
| Slice test with `@Transactional` on class | False green — rollback hides flush errors |

### Debugging scenario

**Observe.** `@WebMvcTest` all 401.

**Diagnose.** Security auto-config active; no `@WithMockUser`.

**Fix.** `@Import(SecurityConfig.class)` or `@WithMockUser`.

---

## 27. Production Scenarios Capstone

### Scenario A: Boot 3 migration — javax → jakarta

**Problem.** `ClassNotFoundException: javax.persistence.Entity` after upgrade.

**Fix.** Replace dependencies; Hibernate 6; update imports; run OpenRewrite. Check third-party libs still on `javax`.

### Scenario B: Two datasources — primary and read replica

```java
@Configuration
public class DataSourceConfig {

    @Bean @Primary
    @ConfigurationProperties("spring.datasource.primary")
    DataSource primaryDataSource() {
        return DataSourceBuilder.create().build();
    }

    @Bean
    @ConfigurationProperties("spring.datasource.replica")
    DataSource replicaDataSource() {
        return DataSourceBuilder.create().build();
    }
}
```

Exclude `DataSourceAutoConfiguration`; define two beans with `@Qualifier`; route read-only transactions via `AbstractRoutingDataSource`.

### Scenario C: Feature flags without redeploy

Use `@ConfigurationProperties` + `@RefreshScope` (Spring Cloud) or polling config service. Boot alone: restart required unless custom `EnvironmentChangeEvent` listener rebinds properties.

### Scenario D: Virtual threads on Boot 3.2+

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

Tomcat uses virtual threads for request handling. Profile JDBC drivers and synchronized blocks.

### Scenario E: Native image (GraalVM)

```bash
mvn -Pnative native:compile
```

Constraints: AOT processing; `@RegisterReflectionForBinding`; many libraries unsupported.

### Scenario F: Multi-document config in k8s

Single ConfigMap `application.yaml` with `---` separators per profile reduces ConfigMap sprawl.

### Scenario G: Observability end-to-end

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
  tracing:
    sampling:
      probability: 0.1
```

Correlate logs with `traceId`/`spanId` in Logback pattern via Micrometer tracing.

---

## 28. Production Debugging Playbook

When a Boot issue is "random," it is usually **property precedence**, **missing auto-config condition**, **wrong profile**, or **actuator showing a different reality than logs**.

1. **Classify the failure phase.** Startup (`ApplicationFailedEvent`) vs runtime vs shutdown. Startup: read `ConditionEvaluationReport` (`--debug` or `/actuator/conditions`).

2. **Print the Environment** on a canary pod:

   ```bash
   curl -s localhost:9090/actuator/env | jq '.propertySources[].name'
   curl -s localhost:9090/actuator/env/spring.datasource.url
   ```

3. **Verify active profiles and config imports.**

   ```bash
   curl -s localhost:9090/actuator/env/spring.profiles.active
   ```

4. **Auto-config report.** Look for `Positive matches` / `Negative matches` for the feature (Redis, Security, DataSource).

5. **Bean presence.**

   ```bash
   curl -s localhost:9090/actuator/beans | jq '.contexts[].beans | keys[]' | grep -i redis
   ```

6. **Health vs readiness.** Don't curl `/health` for liveness if DB is down — use `/health/liveness`.

7. **Thread and memory.** `threaddump`, `heapdump` (staging only), Prometheus `jvm_memory_used_bytes`.

8. **Compare classpath.** `java -jar app.jar --debug` locally with prod dependency tree. `mvn dependency:tree > tree.txt`.

9. **Logging levels targeted** — not blanket TRACE:

   ```yaml
   logging.level.org.springframework.boot.autoconfigure=DEBUG
   logging.level.org.springframework.context=DEBUG
   logging.level.com.zaxxer.hikari=DEBUG
   ```

10. **Turn DEBUG off.** Especially `org.springframework.web` — logs bodies with PII.

---

## 29. Quick Decision Matrix

| Situation | Do this |
|---|---|
| New REST service on Boot 3 | `spring-boot-starter-web` + `actuator` + `validation` + explicit `spring.application.name` |
| Need typed config | `@ConfigurationProperties` record + `@Validated` + metadata JSON |
| Library integration | Auto-config in `AutoConfiguration.imports`, not component scan |
| k8s deployment | Graceful shutdown + separate management port + readiness/liveness split + `MaxRAMPercentage` |
| Secrets | Vault/Secrets Manager via `spring.config.import` — not git |
| Local dev speed | DevTools `optional` + Testcontainers for integration parity |
| Testing controller HTTP | `@WebMvcTest` + `@Import` security |
| Testing persistence | `@DataJpaTest` + Testcontainers PostgreSQL |
| Full integration | `@SpringBootTest` + `@AutoConfigureMockMvc` — few tests |
| Metrics in Prometheus | `micrometer-registry-prometheus` + scrape management port |
| Custom health for k8s | Cheap checks; DB on readiness only if intentional |
| Docker CI | Layered jar + multi-stage Dockerfile |
| Version in incidents | `build-info` Maven goal + `/actuator/info` |
| Boot 2 → 3 migration | Jakarta, `AutoConfiguration.imports`, Security 6, Hibernate 6 |
| Blocking on servlet threads | Virtual threads (3.2+) or WebFlux — measure first |
| Property override not working | Check `/actuator/env` precedence — cmdline &gt; env &gt; file |

---

## 30. Interview Q&A (15+)

**Q1. What does `@SpringBootApplication` actually do?**

It combines `@SpringBootConfiguration` (a `@Configuration` marker), `@EnableAutoConfiguration` (imports auto-config via `AutoConfigurationImportSelector`), and `@ComponentScan` (registers beans in the package of the main class and subpackages). It also triggers `AutoConfigurationPackages.register` for the base package.

**Q2. How does auto-configuration work in Spring Boot 3?**

Classes listed in `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` are imported as `@Configuration`. Each is guarded by `@ConditionalOn*` annotations. They are sorted with `@AutoConfigureBefore/After` and register beans only if conditions match, typically using `@ConditionalOnMissingBean` to back off when you define your own.

**Q3. Difference between `spring.factories` and `AutoConfiguration.imports`?**

Boot 3 moved auto-configuration registration from `EnableAutoConfiguration` key in `spring.factories` to a dedicated `AutoConfiguration.imports` file (one class per line). Other extensions (`EnvironmentPostProcessor`, `ApplicationListener`) still use `spring.factories`.

**Q4. How do you disable a specific auto-configuration?**

`@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)`, `@EnableAutoConfiguration(excludeName = "...")`, or `spring.autoconfigure.exclude` in properties. Prefer exclude when the classpath triggers unwanted config.

**Q5. What wins — your `@Bean` or auto-configuration?**

Your `@Bean` wins if auto-config uses `@ConditionalOnMissingBean` (standard pattern). If you define a bean of the same type without the auto-config backing off, you may get `BeanDefinitionOverrideException` (overriding disabled by default since Boot 2.1).

**Q6. Explain property source precedence in Boot.**

Command-line args and `SPRING_APPLICATION_JSON` beat OS environment variables, which beat `application-{profile}.properties` files outside the jar, which beat files inside the jar. Use `/actuator/env` to see the winning source for a key.

**Q7. What is relaxed binding?**

Environment variables map to properties: `server.port` ↔ `SERVER_PORT`, `acme.my-service.url` ↔ `ACME_MY_SERVICE_URL`. Booleans accept `true/false/on/off/yes/no`. Lists can be comma-separated in `.properties` or YAML arrays.

**Q8. How do profiles work?**

`spring.profiles.active` activates profile-specific beans (`@Profile`) and config files (`application-prod.yml`). Profile groups bundle multiple profiles. Set via env `SPRING_PROFILES_ACTIVE`, not hardcoded in prod jars.

**Q9. `@ConfigurationProperties` vs `@Value`?**

`@ConfigurationProperties` binds a prefix to a structured, validated, type-safe object (ideal for many related settings). `@Value` injects single placeholders — fine for one-off keys, poor for groups and testing.

**Q10. Can you use records with `@ConfigurationProperties`?**

Yes in Boot 3. Records use constructor binding; immutable. Add `@Validated` and Jakarta validation annotations on components. Enable via `@EnableConfigurationProperties` or `@ConfigurationPropertiesScan`.

**Q11. What is the difference between liveness and readiness probes?**

**Liveness** — is the JVM/process alive? Should not depend on external systems (DB). Failure → restart pod. **Readiness** — should this instance receive traffic? Can include DB, caches, warmup state. Failure → remove from load balancer.

**Q12. How do you secure Actuator endpoints?**

Separate management port on internal network, or Spring Security `SecurityFilterChain` with `EndpointRequest.to(...)` matchers. Expose only `health`, `info`, `prometheus` publicly if needed. Sanitize `/env`. Never expose `heapdump`/`shutdown`.

**Q13. What is Micrometer's role?**

Facade for metrics in Boot. Auto-registers JVM, HTTP, JDBC pool metrics. Export via Prometheus, OTLP, etc. Use low-cardinality tags. Correlate with tracing in Boot 3.2+.

**Q14. Explain graceful shutdown.**

`server.shutdown=graceful` stops accepting new requests, waits for in-flight work up to `spring.lifecycle.timeout-per-shutdown-phase`, then closes context. Align k8s `terminationGracePeriodSeconds` and `preStop` hook with LB drain.

**Q15. What is `@WebMvcTest` vs `@SpringBootTest`?**

`@WebMvcTest` loads MVC layer only — controller, MockMvc, mocked services via `@MockBean`. Fast, narrow. `@SpringBootTest` loads full application context — integration tests, slower, use sparingly.

**Q16. What are Docker layers in Spring Boot?**

Layered jar splits dependencies, loader, and application code for Docker cache efficiency. Code changes only invalidate the application layer. Extract via `java -Djarmode=tools -jar app.jar extract --layers`.

**Q17. What does `spring-boot-starter-parent` provide?**

Maven parent importing `spring-boot-dependencies` BOM (aligned versions), default plugin config, Java version property, resource filtering. Gradle uses `io.spring.dependency-management` plugin instead.

**Q18. How do you write a custom starter?**

Split into `autoconfigure` module (`@AutoConfiguration`, `AutoConfiguration.imports`, `@EnableConfigurationProperties`) and `starter` module (dependency aggregator). Use `@ConditionalOnClass` and `@ConditionalOnMissingBean`. Document properties in metadata JSON.

**Q19. Why should DevTools never be in production?**

Automatic restart, LiveReload, and development property defaults add overhead and attack surface. Mark `optional`, `runtime` scope, and `excludeDevtools` in repackage plugin.

**Q20. How do you debug "property not applied"?**

Check `/actuator/env/{propertyName}` for value and source. Enable `logging.level.org.springframework.boot.context.config=DEBUG`. Verify profile active, env var naming (relaxed binding), and higher-precedence overrides (command-line).

**Q21. What is `build-info`?**

Maven/Gradle plugin goal generating `META-INF/build-info.properties` consumed by `BuildProperties` bean and `/actuator/info` — version, time, custom attributes for release traceability.

**Q22. Virtual threads in Boot 3.2+ — when?**

Enable `spring.threads.virtual.enabled=true` for servlet stack to use virtual threads for request handling — good for high concurrency with blocking I/O if libraries are compatible. Profile and load-test before production.

**Q23. How does `@ConditionalOnProperty` work?**

Registers beans when a property equals `havingValue` (or matches matchIfMissing semantics). Use explicit `havingValue="true"` — bare `@ConditionalOnProperty(name="enabled")` matches any value including empty string.

**Q24. What happens during `SpringApplication.run`?**

Create application instance → prepare Environment → print banner → create ApplicationContext → apply initializers → load sources → refresh context (bean creation, auto-config, embedded server start) → call runners → publish `ApplicationReadyEvent`.

**Q25. How do you test JPA without `@SpringBootTest`?**

`@DataJpaTest` imports JPA auto-config, uses embedded DB or Testcontainers with `@AutoConfigureTestDatabase(replace = NONE)`, rolls back `@Transactional` tests by default. Import entities/repos config as needed.

---

*Spring Boot will not fix a missing index on your database. Auto-configuration guesses; production requires explicit ownership of config, health probes, metrics cardinality, and test slices that mirror reality. Keep `/actuator/env` closed, `build-info` in every release, and `--debug` off in prod.*

