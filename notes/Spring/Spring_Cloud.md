# Spring Cloud — Senior Production Reference

Spring Cloud 2023.0.x (Leyton) / 2024.0.x (Moorgate) on Spring Boot 3.2–3.4. This is the **implementation layer**: annotations, YAML, startup ordering, failure modes, version traps. The architectural theory — why you want a gateway, what a circuit breaker is for, saga vs 2PC, CAP trade-offs — lives in `notes/microservices/*.md` and is deliberately not repeated here. When a section says "see the microservices note," go read it; this document assumes you already agree with the pattern and now have to make it survive a Tuesday deploy.

---

## Table of Contents

1. [Mental Model: Spring Cloud Is a BOM, Not a Framework](#1-mental-model-spring-cloud-is-a-bom-not-a-framework)
2. [Spring Cloud Config Server](#2-spring-cloud-config-server)
3. [Refreshing Configuration at Runtime](#3-refreshing-configuration-at-runtime)
4. [Does the server serve the new value?](#1-does-the-server-serve-the-new-value)
5. [Which label is the client actually asking for?](#2-which-label-is-the-client-actually-asking-for)
6. [Did the client cache a commit?](#3-did-the-client-cache-a-commit)
7. [Spring Cloud Kubernetes](#4-spring-cloud-kubernetes)
8. [Service Discovery: Eureka, Consul, Zookeeper, Kubernetes](#5-service-discovery-eureka-consul-zookeeper-kubernetes)
9. [What does the registry claim?](#1-what-does-the-registry-claim)
10. [What does this specific caller's cache hold?](#2-what-does-this-specific-callers-cache-hold)
11. [What actually exists?](#3-what-actually-exists)
12. [Spring Cloud LoadBalancer](#6-spring-cloud-loadbalancer)
13. [OpenFeign](#7-openfeign)
14. [Spring Cloud Gateway](#8-spring-cloud-gateway)
15. [Resilience4j + Spring Cloud CircuitBreaker](#9-resilience4j-spring-cloud-circuitbreaker)
16. [Distributed Tracing (Micrometer Tracing)](#10-distributed-tracing-micrometer-tracing)
17. [Spring Cloud Stream](#11-spring-cloud-stream)
18. [Spring Cloud Function (brief)](#12-spring-cloud-function-brief)
19. [Spring Cloud Contract (brief)](#13-spring-cloud-contract-brief)
20. [Migration Guides](#14-migration-guides)
21. [Configuration Precedence Across Cloud Stack](#15-configuration-precedence-across-cloud-stack)
22. [Security in Spring Cloud Stack](#16-security-in-spring-cloud-stack)
23. [Service Mesh vs Spring Cloud](#17-service-mesh-vs-spring-cloud)
24. [Observability & Actuator in Cloud Deployment](#18-observability-actuator-in-cloud-deployment)
25. [Production Debugging Playbook](#19-production-debugging-playbook)
26. [Quick Decision Matrix](#20-quick-decision-matrix)

---


## 1. Mental Model: Spring Cloud Is a BOM, Not a Framework

There is no `spring-cloud.jar`. "Spring Cloud" is a **release train** — a BOM (`spring-cloud-dependencies`) that pins the versions of ~18 independently developed, independently versioned projects so they work together on one Spring Boot generation.

```
spring-cloud-dependencies:2024.0.x   (the BOM — this is "Spring Cloud")
  ├─ spring-cloud-commons      4.2.x   DiscoveryClient, LoadBalancer, @LoadBalanced, ServiceRegistry
  ├─ spring-cloud-config       4.2.x   Config Server + client, spring.config.import=configserver:
  ├─ spring-cloud-netflix      4.2.x   Eureka client + Eureka server ONLY (Ribbon/Hystrix/Zuul removed)
  ├─ spring-cloud-openfeign    4.2.x   @FeignClient
  ├─ spring-cloud-gateway      4.2.x   reactive gateway + Gateway MVC
  ├─ spring-cloud-circuitbreaker 3.2.x Resilience4j / Spring Retry adapters
  ├─ spring-cloud-stream       4.2.x   Kafka / Rabbit binders, functional model
  ├─ spring-cloud-function     4.2.x   Supplier/Function/Consumer + serverless adapters
  ├─ spring-cloud-bus          4.2.x   broadcast refresh over Kafka/Rabbit
  ├─ spring-cloud-kubernetes   3.2.x   ConfigMap/Secret property sources, K8s discovery
  ├─ spring-cloud-vault        4.2.x   secrets as property sources
  ├─ spring-cloud-consul       4.2.x   discovery + KV config
  ├─ spring-cloud-zookeeper    4.2.x   discovery + KV config
  ├─ spring-cloud-contract     4.2.x   CDC testing, stub runner
  └─ spring-cloud-task         3.2.x   short-lived JVM tasks
```

Two consequences that catch people:

1. **You never write a version on a Spring Cloud starter.** You import the BOM and let it decide. Writing `<version>4.1.0</version>` on `spring-cloud-starter-openfeign` inside a 2024.0 project is how you get `NoSuchMethodError` at 3 a.m.
2. **Module version numbers do not match the train name.** Gateway 4.2.x lives in train 2024.0.x. A Stack Overflow answer about "Spring Cloud Gateway 4.1" is about train 2023.0.x. Always translate.

### Release train naming

Trains used codenames from London Underground stations in alphabetical order (Angel, Brixton, … Hoxton) until the CalVer switch in 2020. Since then the version **is** `YYYY.MINOR.PATCH`, with a codename kept for continuity:

| Release train | Codename | Spring Boot generation |
|---|---|---|
| 2025.1.x | Oakwood | 4.0.x (4.1.x from 2025.1.2) |
| 2025.0.x | Northfields | 3.5.x |
| 2024.0.x | Moorgate | 3.4.x |
| 2023.0.x | Leyton | 3.2.x, 3.3.x (3.3 from 2023.0.2) |
| 2022.0.x | Kilburn | 3.0.x, 3.1.x (3.1 from 2022.0.3) |
| 2021.0.x | Jubilee | 2.6.x, 2.7.x |
| 2020.0.x | Ilford | 2.4.x, 2.5.x |
| Hoxton | — | 2.2.x, 2.3.x |

`2024.0` reads "the first minor of the 2024 line," not "January 2024." Patch releases used to be called service releases (`Hoxton.SR12`); CalVer trains just use `2024.0.3`.

### What actually breaks on a Boot ↔ Cloud mismatch

Spring Cloud ships a **compatibility verifier** (`spring-cloud-context`'s `CompatibilityVerifierAutoConfiguration`). On a known-bad pairing you get a fast, explicit failure:

```
***************************
APPLICATION FAILED TO START
***************************

Description:
Spring Boot [3.5.0] is not compatible with this Spring Cloud release train

Action:
Change Spring Boot version to one of the following versions [3.4.x] .
```

That is the **good** case. The verifier only knows ranges the train was built with. Silent failure modes on near-miss versions:

| Mismatch | Typical symptom |
|---|---|
| Cloud train one generation behind Boot | `NoSuchMethodError` / `NoClassDefFoundError` deep in `ClientHttpRequestFactory`, `RestClient`, or Micrometer during the first outbound call |
| Boot BOM imported **after** Cloud BOM in Maven | Cloud's transitively-managed Boot version wins; you ship a Boot you did not choose |
| Someone pins `micrometer-tracing-bom` manually | Bridge and exporter versions diverge; spans build but never export, no error logged |
| Gradle `implementation platform(...)` missing for the Cloud BOM | Starters resolve to whatever a transitive dependency dragged in |
| `spring-cloud-starter-bootstrap` left on the classpath after a Boot 3 upgrade | Bootstrap context reappears, two `Environment`s exist, `@Value` resolves differently in `@Configuration` vs `@Bean` |

Escape hatch (use only to unblock a controlled upgrade, never as a permanent setting):

```yaml
spring:
  cloud:
    compatibility-verifier:
      enabled: false
```

Correct Maven ordering — Boot as parent, Cloud BOM imported:

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.4.5</version>
</parent>

<properties>
  <spring-cloud.version>2024.0.1</spring-cloud.version>
</properties>

<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-dependencies</artifactId>
      <version>${spring-cloud.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

Verify what you actually resolved, not what you think you declared:

```bash
mvn dependency:tree -Dincludes=org.springframework.cloud
mvn help:evaluate -Dexpression=spring-boot.version -q -DforceStdout
./gradlew dependencyInsight --dependency spring-cloud-commons --configuration runtimeClasspath
```

### What is dead, and what replaced it

The 2020.0 (Ilford) train removed the Netflix OSS stack. This is the single biggest source of stale tutorials.

| Dead / deprecated | Status | Modern replacement |
|---|---|---|
| Netflix Ribbon | Removed in 2020.0 | **Spring Cloud LoadBalancer** (`spring-cloud-commons`) |
| Netflix Hystrix | Removed in 2020.0, upstream in maintenance since 2018 | **Resilience4j** via `spring-cloud-starter-circuitbreaker-resilience4j` |
| Hystrix Dashboard / Turbine | Removed | Micrometer metrics → Prometheus + Grafana |
| Netflix Zuul 1 | Removed in 2020.0 (blocking servlet filters) | **Spring Cloud Gateway** (reactive) or **Gateway MVC** (blocking) |
| Netflix Archaius | Removed | Boot `Environment` + Config Server / ConfigMaps |
| Spring Cloud Sleuth | **EOL** — last train 2021.0.x | **Micrometer Tracing** (`micrometer-tracing-bridge-brave` or `-bridge-otel`) |
| Bootstrap context (`bootstrap.yml`) | Off by default since 2020.0 | `spring.config.import=configserver:` / `vault://` |
| `feign.client.config.*` properties | Renamed in 4.0 (train 2022.0) | `spring.cloud.openfeign.client.config.*` |
| Netflix Eureka | **Alive**, still maintained in `spring-cloud-netflix`, but effectively legacy | Kubernetes DNS + Services, or Consul, if you are on K8s |
| Spring Cloud Config Server | Alive and healthy | Still correct off-K8s; on K8s many teams use ConfigMaps + Secrets + external secrets operator |

Eureka deserves a nuance. It is not deprecated — `spring-cloud-netflix` 4.x is actively released and Eureka Server still works on Boot 3. But it is a **client-side discovery registry**, and on Kubernetes you already have a registry (etcd), a resolver (CoreDNS), and health-based endpoint management (kubelet + Services). Running Eureka on K8s means two registries with different liveness opinions, and the incident in section 5 is the predictable result. Greenfield on K8s: skip it. Existing VM/ECS fleet: Eureka is fine and boring.

Similarly, Spring Cloud Config Server is not obsolete — it gives you git-backed, versioned, PR-reviewed configuration with encryption and audit history, which a raw ConfigMap does not. The question is whether you want a **runtime dependency in the startup path** of every service. Section 4 covers the trade.

---

## 2. Spring Cloud Config Server

### Core concept

Config Server is a small Spring Boot app that turns a backend (git, filesystem, Vault, JDBC, AWS S3/Parameter Store) into an HTTP API returning Spring `PropertySource`s. Clients fetch their properties **at startup**, before the main `ApplicationContext` refreshes, and merge them into the `Environment`.

Server:

```java
@SpringBootApplication
@EnableConfigServer
public class ConfigServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(ConfigServerApplication.class, args);
    }
}
```

```yaml
server:
  port: 8888
spring:
  application:
    name: config-server
  cloud:
    config:
      server:
        git:
          uri: https://github.com/acme/service-config.git
          default-label: main
          search-paths: '{application},shared'
          clone-on-start: true
          timeout: 10
          force-pull: true
          basedir: /var/cache/config-repo
          skip-ssl-validation: false
        # fail fast if git is unreachable at startup rather than serving an empty context
        fail-on-composite-error: true
management:
  endpoints:
    web:
      exposure:
        include: health,info,refresh,env,metrics
```

Client (Boot 3 — no `bootstrap.yml`):

```yaml
spring:
  application:
    name: order-service
  profiles:
    active: prod
  config:
    import: "optional:configserver:http://config-server:8888"
  cloud:
    config:
      fail-fast: true
      request-connect-timeout: 3000
      request-read-timeout: 5000
      retry:
        initial-interval: 1000
        multiplier: 1.5
        max-interval: 10000
        max-attempts: 6
      username: ${CONFIG_USER}
      password: ${CONFIG_PASS}
```

### Internal working

The resolution contract is `/{application}/{profile}[/{label}]`:

| Placeholder | Source on the client | Default |
|---|---|---|
| `{application}` | `spring.application.name` (**not** `spring.cloud.config.name` unless set) | `application` |
| `{profile}` | `spring.profiles.active`, comma-joined | `default` |
| `{label}` | `spring.cloud.config.label` — a git branch, tag, or commit id | server's `default-label` (`main`) |

The server builds a list of property sources from most to least specific and returns them **in precedence order**:

```
GET /order-service/prod,eu-west/main
→ propertySources[0]  order-service-prod.yml      ← highest precedence
  propertySources[1]  order-service-eu-west.yml
  propertySources[2]  order-service.yml
  propertySources[3]  application-prod.yml
  propertySources[4]  application-eu-west.yml
  propertySources[5]  application.yml             ← lowest, the shared defaults
```

Rules worth memorising:

- `application.yml` in the config repo is the **global fallback for every service**. Put only genuinely universal things there (logging patterns, actuator exposure, tracing defaults).
- Profile-specific beats profile-less; application-specific beats global.
- With multiple active profiles, **later profiles in the list win** (`prod,eu-west` → `eu-west` beats `prod`).
- The whole returned document set sits in the client `Environment` as a composite source named `configserver:<uri>`.

Other endpoints the server exposes:

```
GET /order-service/prod                  JSON envelope with propertySources[]
GET /order-service/prod/main
GET /order-service-prod.yml              rendered, merged YAML  (handy for humans)
GET /order-service-prod.properties       rendered, merged properties
GET /main/order-service-prod.yml         label in path
GET /order-service/prod/main/logback.xml plain-text file passthrough (serve-plain-text)
POST /encrypt   /decrypt                 crypto endpoints
POST /monitor                            git webhook receiver (with spring-cloud-config-monitor)
```

Backends beyond git:

```yaml
spring:
  profiles:
    active: composite
  cloud:
    config:
      server:
        composite:
          - type: git
            uri: https://github.com/acme/service-config.git
            order: 2
          - type: vault
            host: vault.internal
            port: 8200
            scheme: https
            backend: secret
            kv-version: 2
            order: 1        # lower order = higher precedence
        vault:
          authentication: KUBERNETES
          kubernetes:
            role: config-server
            service-account-token-file: /var/run/secrets/kubernetes.io/serviceaccount/token
```

`native` (filesystem/classpath) backend is for local dev and tests only:

```yaml
spring:
  profiles:
    active: native
  cloud:
    config:
      server:
        native:
          search-locations: file:///opt/config-repo,classpath:/config
```

### The Boot 3 bootstrap removal

Before Boot 2.4 / Cloud 2020.0, config clients ran a **bootstrap `ApplicationContext`** — a parent context built from `bootstrap.yml`, whose only job was to fetch remote config and hand the resulting `Environment` to the main context. That mechanism is off by default now. The replacement is Boot's **Config Data API**: `spring.config.import` is processed during normal `Environment` preparation, no second context.

What this changes in practice:

| Legacy bootstrap | Boot 3 config data |
|---|---|
| `bootstrap.yml` / `bootstrap-<profile>.yml` | `application.yml` with `spring.config.import` |
| `spring.cloud.config.uri` in `bootstrap.yml` | `spring.config.import: "configserver:http://host:8888"` (URI inside the import) |
| Two `Environment`s, parent/child bean resolution | One `Environment` |
| Remote config always overrode local | Standard config-data ordering: an import is a document inserted **below** the one that declared it, so imported values beat the importing file — but env vars, system properties, and CLI args still beat both |
| Failure = bootstrap context failure, confusing stack trace | Failure = `ConfigDataResourceNotFoundException` or `ConfigClientFailFastException`, clear message |

Legacy escape hatch (do not ship this in new code):

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-bootstrap</artifactId>
</dependency>
```

or `spring.cloud.bootstrap.enabled=true` as a **system property / env var** (it must be readable before the bootstrap phase, so putting it in `application.yml` does nothing). Keeping this around after the upgrade is a slow-burning trap: you now have two `Environment` objects and property placeholder resolution differs subtly between them.

The `optional:` prefix matters:

- `spring.config.import: "configserver:"` — hard requirement. If Config Server is unreachable the app **fails to start**. Combined with `fail-fast: true` and retry, this is usually what you want in production.
- `spring.config.import: "optional:configserver:"` — the app starts with local config only if the server is down. Good for local dev and for tests; dangerous in prod because a service silently boots with defaults (wrong datasource, wrong feature flags) instead of crash-looping visibly.

A pattern that gets both:

```yaml
# application.yml (in the jar)
spring:
  config:
    import: "optional:configserver:"
---
spring:
  config:
    activate:
      on-profile: prod
    import: "configserver:http://config-server:8888"   # mandatory in prod
  cloud:
    config:
      fail-fast: true
```

### Production scenario: Config Server outage takes down every rolling deploy

**Problem.** A node pool is recycled at 02:00. Eleven services enter `CrashLoopBackOff`. Logs all show:

```
java.lang.IllegalStateException: Could not locate PropertySource and the fail fast property is set,
  failing: Could not locate PropertySource: I/O error on GET request for
  "http://config-server:8888/order-service/prod": Connection refused
```

Config Server itself is one pod, and its node was the one recycled. Nothing is wrong with any of the eleven services; they simply cannot boot without their configuration.

**Cause.** Config Server was deployed as a **singleton with a startup-time hard dependency from every other service**, with `fail-fast: true` and only three retry attempts (~4 seconds of backoff). Under a cold start where Config Server also needs to clone a large git repo, four seconds is nowhere near enough. The single replica made it a true SPOF, and no client had a local fallback.

**Solution.** Four independent fixes, all of which you want:

1. **Run at least two replicas with a PodDisruptionBudget**, and make them stateless by pre-cloning at startup:

```yaml
spring:
  cloud:
    config:
      server:
        git:
          clone-on-start: true
          basedir: /var/cache/config-repo   # emptyDir volume, not the container FS
          refresh-rate: 30                  # seconds between git fetches; 0 = every request
```

`refresh-rate: 0` (the default) means every client request triggers a `git fetch`. With 200 pods restarting simultaneously that is a self-inflicted DDoS against your git host. Set it to 30–60s.

2. **Give clients a real retry budget**, and add `spring-retry` + `spring-boot-starter-aop` to the classpath (without them the retry properties are silently ignored):

```xml
<dependency>
  <groupId>org.springframework.retry</groupId>
  <artifactId>spring-retry</artifactId>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    config:
      fail-fast: true
      retry:
        max-attempts: 10
        initial-interval: 1000
        multiplier: 1.5
        max-interval: 15000
```

That is roughly 90 seconds of tolerance — long enough for Config Server to come back, short enough that a genuine misconfiguration still surfaces.

3. **Stop being the only source of truth for boot-critical values.** Datasource URL, broker addresses, and port belong in the deployment manifest (env vars / ConfigMap) so a pod can start and report unhealthy, rather than never starting at all. Config Server then supplies business tunables.

4. **Decouple the startup ordering** in Kubernetes with a readiness gate rather than a hard init container — an init container that waits for Config Server converts a soft dependency into a hard one.

Post-incident, the correct mental model is: *Config Server is part of your control plane. Treat its availability target as at least equal to the services that depend on it.*

### Encryption and secrets

Symmetric key (fine for a small setup, key lives in the server's own environment):

```yaml
encrypt:
  key: ${CONFIG_ENCRYPT_KEY}   # never in the repo, never in the image
```

Asymmetric (preferred — only the server needs the private key):

```yaml
encrypt:
  key-store:
    location: file:/etc/config-server/keystore.jks
    password: ${KEYSTORE_PASSWORD}
    alias: configkey
    secret: ${KEY_PASSWORD}
```

Usage:

```bash
curl -s -X POST --data-urlencode "mysecret" http://config-server:8888/encrypt
# → AQBc0z9Kk... (base64 blob)
```

```yaml
# order-service-prod.yml in the git repo
datasource:
  password: '{cipher}AQBc0z9Kk...'
```

Mechanics that bite:

- The server decrypts **before** sending, by default. Clients receive plaintext over the wire — so Config Server must be behind TLS and authenticated, or you have merely obfuscated the git repo.
- `spring.cloud.config.server.encrypt.enabled: false` makes the server return the `{cipher}` value verbatim and the **client** decrypts. That requires the key on every client, which usually defeats the point.
- Always single-quote the value in YAML. `{cipher}...` unquoted is parsed by SnakeYAML as a flow mapping and you get a cryptic parse error.
- `/encrypt` and `/decrypt` must not be publicly exposed. `/decrypt` is a decryption oracle.
- If `encrypt.key` is missing, the server starts and `/encrypt` returns `{"description":"No key was installed for encryption service","status":"NO_KEY"}` — a 4xx that is easy to miss in a CI script.

**Secrets that should not be in Config Server at all.** Git-backed config gives you history, which is exactly wrong for credentials: rotating a password leaves the old one in the git log forever, readable by anyone with repo access. Use Vault (`spring-cloud-vault`, section 16) or a cloud secret manager for anything that can be rotated or leaked — DB passwords, API keys, signing keys, TLS material. Keep Config Server for non-secret configuration: timeouts, feature flags, routing tables, log levels, connection pool sizes.

### High availability and config drift

Two HA models:

- **Multiple stateless replicas behind a Service/ALB.** Simple, and what almost everyone should do. Each replica clones the repo independently.
- **Config Server registered in discovery** (`spring.cloud.config.discovery.enabled=true` on clients). This inverts the startup dependency onto Eureka, which then becomes the SPOF, and adds a discovery round-trip before config. Rarely worth it.

Config drift is the more common quiet failure: replica A fetched commit `abc123`, replica B is still on `def456` because its `git fetch` failed with a transient 500 and `force-pull` was off. Half your pods get last week's timeout values. Defenses:

```yaml
spring:
  cloud:
    config:
      server:
        git:
          force-pull: true        # discard local changes, always match origin
          delete-untracked-branches: true
          refresh-rate: 30
```

And make clients report what they got:

```java
@Component
class ConfigProvenanceLogger {

    private static final Logger log = LoggerFactory.getLogger(ConfigProvenanceLogger.class);

    ConfigProvenanceLogger(ConfigurableEnvironment env) {
        env.getPropertySources().stream()
            .filter(ps -> ps.getName().startsWith("configserver:")
                       || ps.getName().startsWith("configClient"))
            .forEach(ps -> log.info("config source active: {}", ps.getName()));
        Object version = env.getProperty("config.client.version");
        log.info("config-server git commit: {}", version);
    }
}
```

`config.client.version` is populated with the git commit hash the server served. Ship it as a metric tag or a `/actuator/info` field and a Grafana panel of `count by (config_version)` makes drift visible in seconds.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `spring.application.name` set in `application.yml` but overridden later, or missing | Server resolves `{application}=application`, client gets only global defaults, everything uses fallback values |
| `bootstrap.yml` kept after Boot 3 upgrade without `spring-cloud-starter-bootstrap` | File is silently ignored; app boots with local defaults and no error |
| `spring.config.import` with `optional:` in production | Config Server down → app boots with wrong config instead of failing loudly |
| `spring-retry` missing | `spring.cloud.config.retry.*` silently ignored; single attempt, immediate failure |
| Profile `native` accidentally active in prod | Server serves files from its own filesystem/classpath, usually empty → clients get nothing |
| `search-paths` without `{application}` placeholder | Every service reads the same directory |
| `{cipher}` value unquoted in YAML | `ScannerException: mapping values are not allowed here` |
| `/encrypt`, `/decrypt`, `/env` exposed without auth | Decryption oracle and full config dump on the network |
| Client sets `spring.cloud.config.uri` but not `spring.config.import` | In Boot 3 the URI is read but nothing imports it; no config fetched, no warning |
| Large monorepo config with `refresh-rate: 0` | Git host rate-limits during a mass restart; Config Server latency spikes to seconds |

### Debugging scenario

**Observe.** `order-service` in `prod` uses a 30-second HTTP timeout instead of the 2 seconds set in `order-service-prod.yml`. Config Server is up; other services look correct.

**Diagnose.** Ask the server directly what it thinks this app/profile/label resolves to — this removes the client from the equation:

```bash
curl -s -u user:pass http://config-server:8888/order-service/prod/main | jq '.propertySources[].name'
```

```
"https://github.com/acme/service-config.git/order-service-prod.yml"
"https://github.com/acme/service-config.git/application.yml"
```

If `order-service-prod.yml` is absent from that list, the file name, `search-paths`, or the label is wrong. If it is present, check the value:

```bash
curl -s http://config-server:8888/order-service-prod.yml | grep -A2 timeout
```

Then ask the client what won:

```bash
curl -s localhost:8080/actuator/env/http.client.read-timeout | jq
```

```json
{
  "property": { "source": "systemEnvironment", "value": "30000" },
  "activeProfiles": ["prod"],
  "propertySources": [
    { "name": "systemEnvironment", "property": { "value": "30000" } },
    { "name": "configserver:http://config-server:8888", "property": { "value": "2000" } }
  ]
}
```

**Fix.** An `HTTP_CLIENT_READ_TIMEOUT=30000` env var from an old Helm values file outranks Config Server — relaxed binding maps it onto `http.client.read-timeout`. Environment variables beat imported config data, always. Remove the env var. This is the single most common "Config Server isn't working" report and it is almost never Config Server. See section 15.

---

## 3. Refreshing Configuration at Runtime

### Core concept

`/actuator/refresh` rebuilds the `Environment` from all its sources and then **destroys** every bean in the `refresh` scope so that the next call re-creates it with fresh values. It does **not** restart the context, does not re-run `@PostConstruct` on singletons, and does not touch anything already captured in a field.

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,refresh,refreshscope,env,configprops,busrefresh
```

```bash
curl -X POST localhost:8080/actuator/refresh
["config.client.version","pricing.discount-rate","http.client.read-timeout"]
```

The response is the list of property **keys whose value changed**. An empty array means nothing changed — which, when you expected a change, is your first diagnostic signal (the server did not serve what you thought).

### Internal working — `@RefreshScope`

`@RefreshScope` is `@Scope("refresh")` with `proxyMode = TARGET_CLASS`. Three moving parts:

1. **`RefreshScope`** (extends `GenericScope`) keeps a `ConcurrentHashMap<String, BeanLifecycleWrapper>` cache of instantiated beans.
2. Because of the scoped proxy, every injection point holds a **CGLIB proxy**, not the instance. Each method call goes proxy → `RefreshScope.get(name, objectFactory)` → cache hit or fresh instantiation.
3. `ContextRefresher.refresh()` does:
   - build a throwaway Spring application with the same sources to obtain a fresh `Environment`
   - diff old vs new, copy changed values into the live `ConfigurableEnvironment`
   - publish `EnvironmentChangeEvent(changedKeys)`
   - call `refreshScope.refreshAll()` → `destroy()` on every cached wrapper (invoking `@PreDestroy` / `DisposableBean`) and clear the cache
   - publish `RefreshScopeRefreshedEvent`

The next method call through the proxy instantiates a brand-new bean, with dependencies re-injected and `@Value` re-resolved.

```java
@Service
@RefreshScope
public class PricingService {

    private final BigDecimal discountRate;

    // re-resolved on every refresh because the bean is re-constructed
    public PricingService(@Value("${pricing.discount-rate}") BigDecimal discountRate) {
        this.discountRate = discountRate;
    }

    public BigDecimal apply(BigDecimal amount) {
        return amount.multiply(BigDecimal.ONE.subtract(discountRate));
    }
}
```

`@ConfigurationProperties` beans are different and better: they are rebound **without** `@RefreshScope`. `ConfigurationPropertiesRebinder` listens for `EnvironmentChangeEvent` and calls `destroy()` + `afterPropertiesSet()` on each `@ConfigurationProperties` bean, re-binding fields in place. Same object identity, new field values — so no proxy, no scope, no surprises for callers holding a reference.

```java
@Component
@ConfigurationProperties(prefix = "pricing")
@Validated
public class PricingProperties {

    @NotNull private BigDecimal discountRate;
    @Min(1)  private int maxItems = 50;
    private Duration cacheTtl = Duration.ofMinutes(5);

    // getters and setters required for rebinding
}
```

**This is the pattern to standardise on.** `@ConfigurationProperties` + constructor-injected properties object + read the getter at call time. It refreshes reliably, validates, shows up in `/actuator/configprops`, and gives you IDE metadata.

One caveat: `@ConfigurationProperties` bound via a **constructor** (`@ConstructorBinding` / immutable records) cannot be rebound in place. If you want refreshability, use setter binding, or wrap the record holder in `@RefreshScope`.

### What does NOT refresh

This list is the whole reason refresh incidents happen.

| Thing | Refreshes? | Why / what to do |
|---|---|---|
| `@Value` in a plain singleton | **No** | Resolved once at construction. Add `@RefreshScope` to the bean or move to `@ConfigurationProperties`. |
| `@Value` captured into a `static` field | **No** | Never do this. |
| `@ConfigurationProperties` (setter-bound) | **Yes** | Rebound by `ConfigurationPropertiesRebinder`. |
| `@ConfigurationProperties` (constructor-bound / record) | **No** | Immutable; needs `@RefreshScope` on the holder. |
| HikariCP pool size / JDBC URL | **No** | The `DataSource` is already open with live connections. Needs a restart, or a `@RefreshScope` `DataSource` (dangerous — in-flight transactions). |
| `server.port`, servlet context path | **No** | Connector already bound. Restart. |
| Kafka consumer `group.id`, `bootstrap.servers` | **No** | Consumer is running; needs container stop/start. |
| Logging levels | **Yes** | Via `LoggingRebinder` on `EnvironmentChangeEvent`, or `/actuator/loggers` directly. |
| Feign client timeouts | **Partly** | Config is read per-request from the `FeignClientProperties` bean; `@RefreshScope` on Feign is enabled by `spring.cloud.openfeign.client.refresh-enabled: true`. |
| Gateway routes from properties | **Yes** | `/actuator/gateway/refresh` or `RefreshRoutesEvent`. |
| Resilience4j instance config | **Partly** | Some properties are re-readable; thresholds on an existing `CircuitBreaker` instance are not. Use the `CircuitBreakerRegistry` API to replace the config. |
| `@Scheduled(fixedDelayString = "${...}")` | **No** | The trigger was registered at startup. |
| Beans injected **into** a `@RefreshScope` bean | N/A | They are re-injected, but they themselves are not re-created unless also refresh-scoped. |

The subtle one: **a singleton holding a reference to a `@RefreshScope` bean is fine** (it holds the proxy). But a `@RefreshScope` bean holding a reference to another `@RefreshScope` bean gets the proxy too, so both refresh — that part works. What breaks is a singleton that reads a value **from** a refresh-scoped bean once and caches it.

### Production scenario: feature flag flipped, nothing happened, then everything happened

**Problem.** Ops flips `features.new-pricing=true` in git, hits `/actuator/refresh` on all 40 pods via a script, and confirms 200 responses. Nothing changes. Four hours later a routine deploy rolls the pods and the new pricing engine goes live — unannounced, during peak, with a bug — because the flag had been "on" in config for four hours.

**Cause.** The flag was read like this:

```java
@Service
public class CheckoutService {

    private final boolean newPricing;                     // captured at construction

    public CheckoutService(@Value("${features.new-pricing}") boolean newPricing) {
        this.newPricing = newPricing;
    }
}
```

No `@RefreshScope`. `/actuator/refresh` correctly returned `["features.new-pricing"]` — the *Environment* changed. The *bean* did not. Nobody checked the response body, and the 200 was taken as success.

**Solution.**

```java
@Component
@ConfigurationProperties(prefix = "features")
public class FeatureFlags {
    private boolean newPricing;
    public boolean isNewPricing() { return newPricing; }
    public void setNewPricing(boolean newPricing) { this.newPricing = newPricing; }
}

@Service
public class CheckoutService {

    private final FeatureFlags flags;

    public CheckoutService(FeatureFlags flags) {   // holds the rebindable bean
        this.flags = flags;
    }

    public Receipt checkout(Cart cart) {
        return flags.isNewPricing() ? newEngine.price(cart) : legacyEngine.price(cart);
    }
}
```

Read the flag **at call time**, never at construction. Then verify the effect rather than the HTTP status:

```java
@Component
class RefreshAuditor {

    private static final Logger log = LoggerFactory.getLogger(RefreshAuditor.class);

    @EventListener
    public void onChange(EnvironmentChangeEvent event) {
        log.warn("environment changed: {}", event.getKeys());
    }

    @EventListener
    public void onRefreshed(RefreshScopeRefreshedEvent event) {
        log.warn("refresh scope rebuilt: {}", event.getName());
    }
}
```

And expose the effective value so a smoke test can assert it:

```java
@ReadOperation
public Map<String, Object> flags() { ... }   // or just /actuator/configprops
```

The organisational fix matters as much as the code: a config change that needs a refresh should be **verified by reading back the effective value from every instance**, not by counting 200s. A flag that is dark for four hours and then activates on deploy is functionally a time bomb.

### Spring Cloud Bus — fan-out refresh

Calling `/actuator/refresh` on 200 pods behind a load balancer is not possible (you cannot address individual pods through a Service). Spring Cloud Bus links instances over a broker so one call fans out.

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-bus-amqp</artifactId>
</dependency>
<!-- or -->
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-bus-kafka</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    bus:
      enabled: true
      destination: springCloudBus     # exchange/topic name
      refresh:
        enabled: true
      env:
        enabled: false                # /actuator/busenv can push arbitrary values — keep OFF
  rabbitmq:
    host: rabbit.internal
    username: ${RABBIT_USER}
    password: ${RABBIT_PASS}
management:
  endpoints:
    web:
      exposure:
        include: busrefresh
```

```bash
# refresh everyone
curl -X POST http://any-instance:8080/actuator/busrefresh

# refresh only one service
curl -X POST http://any-instance:8080/actuator/busrefresh/order-service:**

# refresh one instance
curl -X POST http://any-instance:8080/actuator/busrefresh/order-service:8080:9a3f
```

Under the hood Bus is a Spring Cloud Stream application: it publishes a `RefreshRemoteApplicationEvent` carrying an `originService` and a `destinationService` pattern. Each instance filters on `spring.cloud.bus.id` (default `${spring.application.name}:${server.port}:${context-id}`) and, if matched, runs `ContextRefresher.refresh()` locally.

Operational notes:

- Bus with Kafka creates a topic (`springCloudBus`) — make sure auto-topic-creation is allowed or pre-create it, otherwise refresh silently does nothing.
- Every instance consumes **every** bus message. At 500 pods a stray broadcast means 500 simultaneous Config Server fetches. Stagger or scope the destination.
- Wire the git webhook to Config Server's `/monitor` endpoint (`spring-cloud-config-monitor`) and you get commit → bus → fleet refresh with no human in the loop. Powerful and genuinely dangerous: a bad commit is now a fleet-wide instant change with no canary. Most mature teams disable auto-monitor and require an explicit, audited refresh step in the pipeline.
- `busenv` lets anyone with actuator access set arbitrary properties across the fleet. Keep it disabled.

### Safe refresh patterns

1. **Refresh is for tunables, not for topology.** Timeouts, thresholds, flags, log levels, rate limits — yes. Datasource, broker, ports, security config — no; roll the deployment.
2. **Make refreshability explicit and tested.** A unit test that changes a property in a `MockEnvironment`, publishes `EnvironmentChangeEvent`, and asserts the bean sees the new value.
3. **Canary the refresh.** Refresh one instance, verify, then fan out. `busrefresh/{service}:{port}:{id}` supports this.
4. **Log every refresh with the resulting config version** so you can correlate a latency graph with a config change instead of guessing.
5. **Beware `@PreDestroy` on refresh-scoped beans.** Refresh calls it. A bean that closes a shared thread pool in `@PreDestroy` will break the application on refresh, not on shutdown.
6. **Do not put `@RefreshScope` on `@Configuration` classes** unless you understand that every bean defined there is re-created; `@Bean` methods returning singletons will produce new instances that existing singleton holders never see.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Value` in a singleton, no `@RefreshScope` | Refresh returns changed keys, behaviour unchanged until restart |
| `@RefreshScope` on a bean injected as a concrete class with `final` methods | CGLIB proxy cannot override; stale values, or `IllegalArgumentException` at startup |
| `@RefreshScope` on a `@Controller` | Every request creates the proxy indirection; also `@RequestMapping` registrations are unaffected — route changes do not apply |
| Refresh-scoped `DataSource` | Refresh closes the pool mid-transaction; `HikariPool has been shutdown` on in-flight requests |
| Bus enabled but broker credentials wrong | Startup succeeds, `busrefresh` returns 200, nothing propagates (check for AMQP connect retries in logs) |
| `management.endpoints.web.exposure.include: "*"` on a public port | Anyone can `POST /actuator/refresh` or `/actuator/shutdown` |
| Constructor-bound `@ConfigurationProperties` expected to refresh | Silent no-op |
| Refresh while a `@Scheduled` job is mid-run inside a refresh-scoped bean | Bean destroyed underneath the running job; `BeanCreationNotAllowedException` or NPEs |

### Debugging scenario

**Observe.** `POST /actuator/refresh` returns `[]` on every pod, but the git repo definitely has the new value and the commit is merged to `main`.

**Diagnose.** Work outward from the client.

```bash
# 1. Does the server serve the new value?
curl -s http://config-server:8888/order-service/prod/main \
  | jq '.propertySources[0].source["pricing.discount-rate"]'

# 2. Which label is the client actually asking for?
curl -s localhost:8080/actuator/env | jq '.propertySources[].name' | grep configserver

# 3. Did the client cache a commit?
curl -s localhost:8080/actuator/env/config.client.version | jq
```

If (1) shows the old value, Config Server has a stale clone — `force-pull` off, or `refresh-rate` long, or it is on a different branch than you think. `curl http://config-server:8888/actuator/env | grep -i label`.

If (1) is new and (3) is old, the client's HTTP fetch is being served from somewhere else: a caching proxy between the pods and Config Server (an nginx sidecar with `proxy_cache`, or an ALB with caching on) will happily serve a 200 from cache. Confirm with a cache-busting query param.

If both are new and refresh still returns `[]`, the property is not actually different — check for an env var of the same name shadowing it (`/actuator/env/<key>` shows all contributing sources in precedence order; the winner is the top one).

**Fix.** In the real incident behind this pattern, the cause was `spring.cloud.config.label: release-2024-11` pinned in a Helm values file from a previous release cut. The server was serving that (stale) branch perfectly correctly. Add the resolved label to `/actuator/info` so it is visible on a dashboard.

---
## 4. Spring Cloud Kubernetes

### Core concept

`spring-cloud-kubernetes` makes Kubernetes primitives look like Spring abstractions: ConfigMaps and Secrets become `PropertySource`s, Kubernetes `Endpoints`/`Service` objects back `DiscoveryClient`, and pod readiness integrates with actuator health.

Two client implementations — pick one, never both:

| Starter | Underlying client | Notes |
|---|---|---|
| `spring-cloud-starter-kubernetes-client-config` | official `io.kubernetes:client-java` | Default choice on 2023.0+; smaller, actively aligned upstream |
| `spring-cloud-starter-kubernetes-fabric8-config` | Fabric8 `kubernetes-client` | Older, richer DSL, heavier |

Discovery variants mirror this (`...-kubernetes-client-discovery`, `...-kubernetes-fabric8-discovery`), plus an HTTP-based `spring-cloud-kubernetes-discoveryserver` for clusters where you do not want to grant every pod list/watch RBAC.

### Internal working — ConfigMap and Secret property sources

```yaml
spring:
  application:
    name: order-service
  config:
    import:
      - "kubernetes:"                       # ConfigMap + Secret for this app
  cloud:
    kubernetes:
      config:
        enabled: true
        name: order-service                 # defaults to spring.application.name
        namespace: payments
        sources:
          - name: order-service             # app-specific
          - name: common-config             # shared, lower precedence (listed first = lower)
        fail-fast: true
      secrets:
        enabled: true
        name: order-service-secrets
        namespace: payments
        paths:                              # read from mounted files instead of the API
          - /etc/secrets
      reload:
        enabled: true
        mode: event                         # polling | event
        strategy: refresh                   # refresh | restart_context | shutdown
        period: 15000                       # polling mode only
        monitoring-config-maps: true
        monitoring-secrets: false
```

The property source reader handles three ConfigMap shapes:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: order-service
data:
  # (a) flat keys — become properties directly
  pricing.discount-rate: "0.15"

  # (b) a full YAML document under a well-known key
  application.yaml: |
    pricing:
      max-items: 50
    logging:
      level:
        com.acme: DEBUG

  # (c) profile-specific document
  application-prod.yaml: |
    pricing:
      max-items: 200
```

Shape (b)/(c) is what you want — one reviewable YAML blob rather than 60 flat keys, and it supports the same profile semantics as `application-<profile>.yml`.

**Reload strategies:**

| Strategy | Effect | Use when |
|---|---|---|
| `refresh` | Fires `RefreshEvent` → same semantics as `/actuator/refresh` | Default. Tunables and flags. |
| `restart_context` | Closes and restarts the whole `ApplicationContext` (not the JVM) | You need `@Value` singletons, pools, or listeners rebuilt. Causes a brief in-process outage — combine with readiness. |
| `shutdown` | Calls `SpringApplication.exit()`; the container restarts | Cleanest and most honest on K8s: let the Deployment do the restart. |

**Reload modes:**

- `polling` — a scheduled task re-reads the ConfigMap/Secret every `period` ms and diffs. No RBAC `watch` verb needed, costs one API call per pod per period. At 500 pods × 15s that is 33 requests/sec against the API server just for config polling; raise the period.
- `event` — a `watch` on the ConfigMap/Secret. Near-instant, one long-lived connection per pod, requires the `watch` verb. Watches can silently die on API server restarts; the client reconnects, but there is a window.

A third option that beats both: **do not use reload at all.** Mount the ConfigMap as a volume and let the change roll the Deployment via a checksum annotation. You get the same outcome with normal rollout safety (surge, readiness, rollback):

```yaml
# Deployment template
metadata:
  annotations:
    checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

### RBAC

Nothing works without it, and the failure mode is a warning, not an error:

```
io.kubernetes.client.openapi.ApiException: Forbidden
  configmaps is forbidden: User "system:serviceaccount:payments:order-service"
  cannot list resource "configmaps" in API group "" in the namespace "payments"
```

If `fail-fast: false` (the default for some versions), the app starts anyway with **no** ConfigMap properties. Always set `spring.cloud.kubernetes.config.fail-fast: true`.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-service
  namespace: payments
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: order-service-config
  namespace: payments
rules:
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list", "watch"]        # watch only needed for reload.mode=event
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods"]
    verbs: ["get", "list", "watch"]        # discovery
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: order-service-config
  namespace: payments
subjects:
  - kind: ServiceAccount
    name: order-service
roleRef:
  kind: Role
  name: order-service-config
  apiGroup: rbac.authorization.k8s.io
```

Granting `secrets: get,list` to an application service account means **any code in that pod can read every Secret in the namespace**, including other services'. Prefer mounting only the secrets the pod needs as files (`spring.cloud.kubernetes.secrets.paths`) and dropping the `secrets` RBAC rule entirely. Better still: an external-secrets operator syncs from Vault into a Secret, and the pod only mounts it.

### Kubernetes discovery

```yaml
spring:
  cloud:
    kubernetes:
      discovery:
        enabled: true
        all-namespaces: false
        namespaces: [payments, shared]
        include-not-ready-addresses: false
        service-labels:
          discoverable: "true"
        primary-port-name: http
```

This gives you a `DiscoveryClient` backed by `Endpoints`, which means `@LoadBalanced RestTemplate` and `lb://order-service` URIs work exactly as they do with Eureka. Two things to understand:

1. **Client-side load balancing bypasses the Service's kube-proxy balancing.** You get per-instance pod IPs and Spring Cloud LoadBalancer picks one. That is useful (zone-aware routing, sticky hints) and also means you have opted out of `Service` semantics like session affinity and topology-aware hints.
2. **Endpoints readiness is authoritative.** A pod that fails its readiness probe is removed from `Endpoints`, so it disappears from `DiscoveryClient` in seconds — much faster and more truthful than Eureka's lease expiry. Set `include-not-ready-addresses: false` (default) and let kubelet be the source of truth.

### When to prefer plain env vars and DNS

The honest default on Kubernetes for most teams:

```yaml
# no spring-cloud-kubernetes at all
spring:
  application:
    name: order-service
inventory:
  base-url: http://inventory-service.inventory.svc.cluster.local:8080
```

```java
@Bean
RestClient inventoryClient(RestClient.Builder builder,
                           @Value("${inventory.base-url}") String baseUrl) {
    return builder.baseUrl(baseUrl)
        .requestFactory(ClientHttpRequestFactoryBuilder.jdk()
            .build(ClientHttpRequestFactorySettings.defaults()
                .withConnectTimeout(Duration.ofSeconds(2))
                .withReadTimeout(Duration.ofSeconds(3))))
        .build();
}
```

Kubernetes `Service` + CoreDNS already does discovery, health-based membership, and L4 load balancing, with **zero application dependency, zero RBAC, and zero startup coupling**. Use `spring-cloud-kubernetes` when you specifically need one of:

- client-side load balancing decisions the Service cannot make (zone preference, weighted canaries driven by instance metadata, hedged requests)
- ConfigMap-driven refresh without a rollout
- an existing codebase full of `DiscoveryClient` / `lb://` that you are lifting into K8s

### Why teams drop Config Server on Kubernetes

| Concern | Config Server | ConfigMap / Secret |
|---|---|---|
| Availability in the startup path | Extra service that must be up | Already present as a mounted volume / env |
| Change history and review | Git — excellent | Whatever your GitOps repo gives you (also git, if you use Argo/Flux) |
| Encryption | `{cipher}` + server-side key | Sealed Secrets / external-secrets / KMS |
| Rollout safety | Refresh is instant and fleet-wide, no canary | Deployment rollout with surge, readiness, and `kubectl rollout undo` |
| Multi-environment | Profiles and labels | Kustomize overlays / Helm values |
| Operational surface | A Java service to patch, scale, and monitor | None |

With Argo CD or Flux you already have git-backed, PR-reviewed, versioned configuration with rollback. Config Server duplicates that and adds a runtime dependency. The strong case for keeping it: a heterogeneous estate (VMs + K8s + serverless) needing one config plane, or a need for dynamic change without rollout (feature-flag-style). Otherwise ConfigMaps win on K8s, and dedicated flag tooling wins for flags.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Missing RBAC and `fail-fast: false` | App starts with default config; nobody notices until behaviour is wrong |
| Both fabric8 and official client starters on the classpath | Duplicate `DiscoveryClient` beans, `NoUniqueBeanDefinitionException` or nondeterministic wiring |
| `spring.config.import: "kubernetes:"` missing (only `spring.cloud.kubernetes.config.*` set) | No ConfigMap is loaded — the import is what triggers it in Boot 3 |
| `reload.strategy: restart_context` with a slow context | Repeated in-process restarts under a flapping ConfigMap; readiness thrashes |
| `reload.mode: polling` with `period: 1000` at scale | API server throttling (`429`), cluster-wide degradation |
| `namespace` unset in a cluster where the pod's namespace file is not mounted | Reads from `default`, gets nothing |
| ConfigMap key `application.properties` while the app expects YAML shape | Values load but nested keys are literal strings |
| Secrets mounted **and** read via API, with different values | Whichever property source has higher precedence wins, unpredictably |

### Debugging scenario

**Observe.** A ConfigMap change is applied; `kubectl get configmap` shows the new value; the app never picks it up. `reload.enabled: true`, `mode: event`.

**Diagnose.**

```bash
# does the pod's service account have watch?
kubectl auth can-i watch configmaps \
  --as=system:serviceaccount:payments:order-service -n payments

# is the property source even present?
kubectl exec deploy/order-service -- \
  curl -s localhost:8080/actuator/env | jq '.propertySources[].name'
```

Expect a source like `configmap.order-service.payments.default`. If it is absent, the ConfigMap was never loaded — check the `spring.config.import` entry and RBAC. If it is present but stale, the watch died; look for:

```
Reloadable condition was not satisfied, ignoring ConfigMap update
```

which means the ConfigMap that changed is not one of the monitored `sources`, or `monitoring-config-maps: false`.

**Fix.** In the common case, `spring.cloud.kubernetes.config.sources` listed only `common-config`, so changes to the app-specific ConfigMap were seen by the watch and then filtered out. Adding it to `sources` fixed the reload. The durable fix was moving to a checksum-annotated rollout so config changes go through the same deploy pipeline as code.

---

## 5. Service Discovery: Eureka, Consul, Zookeeper, Kubernetes

Discovery theory — client-side vs server-side, registry consistency models, the CAP position of AP registries — is covered in `notes/microservices/service-management.md` and `notes/microservices/service-communication.md`. This section is about the Spring implementations and their timing behaviour, because **every discovery incident is a timing incident**.

### The `DiscoveryClient` abstraction

`spring-cloud-commons` defines the seam that makes backends interchangeable:

```java
public interface DiscoveryClient extends Ordered {
    String description();
    List<ServiceInstance> getInstances(String serviceId);
    List<String> getServices();
    default void probe() { getServices(); }
}
```

```java
@Service
public class InventoryLocator {

    private final DiscoveryClient discoveryClient;

    public InventoryLocator(DiscoveryClient discoveryClient) {
        this.discoveryClient = discoveryClient;
    }

    public List<String> uris() {
        return discoveryClient.getInstances("inventory-service").stream()
            .map(i -> i.getUri() + " zone=" + i.getMetadata().get("zone"))
            .toList();
    }
}
```

With multiple providers on the classpath, Boot creates a `CompositeDiscoveryClient` that merges them in `Ordered` sequence. That is almost never what you want in production — it hides which registry answered. Disable the ones you are not using:

```yaml
spring:
  cloud:
    discovery:
      enabled: true               # master switch; false disables all DiscoveryClients
    kubernetes:
      discovery:
        enabled: false
eureka:
  client:
    enabled: true
```

`spring.cloud.discovery.enabled: false` is the correct switch for tests and for local runs — it stops `@LoadBalanced` clients from trying to resolve `lb://` and gives a clean failure rather than a 30-second Eureka timeout.

### Eureka: client and server

Server:

```java
@SpringBootApplication
@EnableEurekaServer
public class EurekaServerApplication { }
```

```yaml
server:
  port: 8761
spring:
  application:
    name: eureka-server
eureka:
  instance:
    hostname: ${HOSTNAME}
  client:
    register-with-eureka: true      # true for peer replication in a cluster
    fetch-registry: true
    service-url:
      defaultZone: http://eureka-1:8761/eureka/,http://eureka-2:8761/eureka/
  server:
    enable-self-preservation: true
    renewal-percent-threshold: 0.85
    eviction-interval-timer-in-ms: 60000
    response-cache-update-interval-ms: 30000
    peer-eureka-nodes-update-interval-ms: 600000
```

Client:

```yaml
eureka:
  client:
    service-url:
      defaultZone: http://eureka-1:8761/eureka/,http://eureka-2:8761/eureka/
    registry-fetch-interval-seconds: 30
    initial-instance-info-replication-interval-seconds: 40
    healthcheck:
      enabled: true                 # report actuator health, not just "UP because the process runs"
  instance:
    prefer-ip-address: true
    instance-id: ${spring.application.name}:${spring.application.instance-id:${random.value}}
    lease-renewal-interval-in-seconds: 30
    lease-expiration-duration-in-seconds: 90
    metadata-map:
      zone: ${AWS_AZ:unknown}
      version: ${BUILD_VERSION:dev}
```

`eureka.client.healthcheck.enabled: true` is not the default and matters enormously: without it, an instance whose database is down still reports `UP` to Eureka because the JVM is alive. With it, `HealthCheckHandler` maps actuator health to Eureka status, so a broken instance takes itself out of rotation.

### Internal working — the timing chain

This is the table to have in your head during an incident. Every number is a default.

| Step | Mechanism | Default timing |
|---|---|---|
| Instance registers | `POST /eureka/apps/{app}` on startup | after context refresh, then replicated |
| Instance renews lease | `PUT /eureka/apps/{app}/{id}` heartbeat | every **30s** (`lease-renewal-interval-in-seconds`) |
| Server marks lease expired | no heartbeat for `lease-expiration-duration-in-seconds` | **90s** |
| Eviction task removes it | scheduled sweep | every **60s** (`eviction-interval-timer-in-ms`) |
| Server response cache updated | `ResponseCache` read-write → read-only | every **30s** (`response-cache-update-interval-ms`) |
| Peer replication | async, best-effort, per-write | ~seconds, no consistency guarantee |
| Client fetches registry delta | `GET /eureka/apps/delta` | every **30s** (`registry-fetch-interval-seconds`) |
| LoadBalancer instance cache | Caffeine cache in `CachingServiceInstanceListSupplier` | TTL **35s** (`spring.cloud.loadbalancer.cache.ttl`) |

Worst case for a **hard kill** (SIGKILL, node loss) to disappear from a caller's view:

```
90s lease expiry
+ 60s eviction sweep (worst case)
+ 30s response cache
+ 30s client registry fetch
+ 35s LoadBalancer cache
≈ 245s — over four minutes of routing to a dead instance
```

That is not a bug. It is the AP design: Eureka prefers serving a possibly-stale registry over refusing to answer. The mitigation is **not** to shrink all the timers (that multiplies heartbeat load and makes false evictions likely during GC pauses); it is to (a) always shut down gracefully so the instance de-registers itself, and (b) make the caller resilient so a dead instance costs one fast-failing request, not a hang.

Graceful de-registration:

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
eureka:
  client:
    should-unregister-on-shutdown: true    # default true — verify nobody turned it off
```

On Kubernetes add a `preStop` sleep so the de-registration has time to propagate before the process dies:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 20"]
terminationGracePeriodSeconds: 60
```

### Self-preservation mode

Eureka counts expected heartbeats per minute (`instances × 2 × renewal-percent-threshold`). If actual renewals drop below that threshold, it concludes **the network is partitioned, not that the instances died**, and stops evicting anything. The dashboard shows:

```
EMERGENCY! EUREKA MAY BE INCORRECTLY CLAIMING INSTANCES ARE UP WHEN THEY'RE NOT.
RENEWALS ARE LESSER THAN THRESHOLD AND HENCE THE INSTANCES ARE NOT BEING EXPIRED JUST TO BE SAFE.
```

This is correct behaviour for the failure it was designed for (a datacenter network split where instances are healthy but unreachable by the registry) and catastrophic for the failure you usually have (a bad deploy that killed half the fleet).

### Production scenario: "instances are down but Eureka still lists them"

**Problem.** A deploy scales `payment-service` from 20 pods to 6 as part of a cost exercise. Fourteen instances are terminated. Twenty minutes later, callers are still getting `Connection refused` on roughly 60% of requests. The Eureka dashboard lists all 20 instances as `UP`, with the red self-preservation banner.

**Cause.** Chain of three:

1. The 14 pods were terminated with SIGKILL after a too-short `terminationGracePeriodSeconds`, so none of them de-registered.
2. Losing 70% of heartbeats at once dropped renewals far below `renewal-percent-threshold: 0.85`. Self-preservation engaged and **eviction stopped entirely** — the 14 dead leases would never expire.
3. Callers used `@LoadBalanced RestTemplate` with no health-check supplier and no circuit breaker, so every request to a dead instance burned a full connect timeout.

**Solution.**

Immediate (during the incident):

```bash
# take a specific dead instance out by hand
curl -X DELETE http://eureka-1:8761/eureka/apps/PAYMENT-SERVICE/payment-service:10.4.2.19:8080

# or force it OUT_OF_SERVICE (replicates to peers)
curl -X PUT "http://eureka-1:8761/eureka/apps/PAYMENT-SERVICE/payment-service:10.4.2.19:8080/status?value=OUT_OF_SERVICE"
```

Structural, in order of value:

1. **Graceful shutdown everywhere.** `server.shutdown: graceful`, `preStop` sleep, `terminationGracePeriodSeconds` greater than the sum. A de-registering instance never becomes a stale lease.

2. **Client-side health checks** so the load balancer refuses to hand out an instance that does not answer:

```yaml
spring:
  cloud:
    loadbalancer:
      configurations: health-check
      health-check:
        initial-delay: 0s
        interval: 10s
        path:
          default: /actuator/health
      cache:
        ttl: 10s
        capacity: 256
```

3. **Tune self-preservation deliberately** rather than leaving the defaults on a fleet with elastic scaling:

```yaml
eureka:
  server:
    enable-self-preservation: true
    renewal-percent-threshold: 0.49    # tolerate losing up to half the fleet before freezing
    eviction-interval-timer-in-ms: 15000
```

Turning self-preservation **off** entirely is the common overreaction. It converts a "stale instances" problem into a "brief network blip empties the registry and takes down everything" problem, which is strictly worse. Lower the threshold instead.

4. **Fail fast on the client.** A 2-second connect timeout plus a circuit breaker turns "60% of requests hang for 30 seconds" into "60% of requests fail in 2 seconds and then the breaker opens" — still an outage, but a survivable, observable one.

5. **Alert on registry lies.** Compare Eureka's instance count against your orchestrator's:

```
eureka_server_registry_size{application="payment-service"}
  != kube_deployment_status_replicas_available{deployment="payment-service"}
```

An alert on that divergence for more than 3 minutes would have caught this in minute four instead of minute twenty.

### Consul and Zookeeper

Consul (CP-ish with Raft, plus a real health-check system and a KV store):

```yaml
spring:
  cloud:
    consul:
      host: consul.internal
      port: 8500
      discovery:
        register: true
        prefer-ip-address: true
        instance-id: ${spring.application.name}-${random.value}
        health-check-path: /actuator/health
        health-check-interval: 10s
        health-check-critical-timeout: 30s     # deregister after 30s critical
        tags:
          - zone=eu-west-1a
          - version=${BUILD_VERSION}
      config:
        enabled: true
        format: YAML
        prefix: config
        default-context: application
        data-key: data
        watch:
          enabled: true
          delay: 1000
  config:
    import: "consul:consul.internal:8500"
```

Consul's key advantage over Eureka is that **the agent actively health-checks** rather than trusting heartbeats, and `health-check-critical-timeout` gives automatic deregistration of dead nodes. It also gives you KV config, so it can replace Config Server.

Zookeeper (`spring-cloud-zookeeper`, Curator-based, ephemeral znodes):

```yaml
spring:
  cloud:
    zookeeper:
      connect-string: zk1:2181,zk2:2181,zk3:2181
      discovery:
        enabled: true
        register: true
        root: /services
      config:
        enabled: true
        root: /config
```

Ephemeral znodes disappear when the session dies, so deregistration is fast and automatic — no lease timers. The cost is Zookeeper itself: a CP system that will refuse writes during a partition, and an operational burden most teams no longer want. Use it if you already run it for Kafka/HBase; do not adopt it fresh for discovery.

### Kubernetes DNS as the alternative

```
inventory-service.payments.svc.cluster.local  →  ClusterIP  →  kube-proxy  →  a ready pod
```

| Property | Eureka | K8s Service + DNS |
|---|---|---|
| Registration | app calls the registry | kubelet updates Endpoints from probes |
| Deregistration on hard kill | 90s + eviction sweep | seconds (kubelet notices, Endpoints updated) |
| Health truth | app's self-report | readiness probe, enforced externally |
| Load balancing | client-side, app-controlled | kube-proxy (iptables/IPVS), L4 |
| Zone awareness | metadata + `ZonePreferenceServiceInstanceListSupplier` | topology-aware routing hints |
| Failure blast radius | registry down = no new discovery | CoreDNS down = cluster-wide, but it is HA and cached |
| App dependency | a client library, a config block, a startup call | a hostname string |

If you are on Kubernetes and someone proposes adding Eureka, the burden of proof is on them. The one legitimate reason is a hybrid estate mid-migration, where VM-hosted services and pods must find each other through one registry.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `eureka.client.healthcheck.enabled` left `false` | Instances with a dead DB stay `UP` and keep receiving traffic |
| `prefer-ip-address: false` in a container | Registers the pod hostname; callers outside the cluster cannot resolve it |
| Non-unique `instance-id` (e.g. hardcoded) | Instances overwrite each other's registration; registry shows one instance for a fleet of ten |
| Self-preservation on with aggressive autoscaling | Registry freezes during scale-down, dead instances served for hours |
| `register-with-eureka: true` on the Eureka server itself in a single-node setup | Server registers with itself; noisy logs, harmless but confusing |
| Both Eureka and K8s discovery enabled | `CompositeDiscoveryClient` returns duplicated/conflicting instances |
| Shrinking `lease-renewal-interval` to 5s on 1000 instances | 200 heartbeat writes/sec plus peer replication; Eureka CPU-bound, latency spikes |
| Client `service-url.defaultZone` pointing at one peer | That peer's restart blackholes registration for everyone pointed at it |
| No `preStop` hook on K8s | Every rollout leaves stale leases for ~2–4 minutes |

### Debugging scenario

**Observe.** Intermittent `java.net.ConnectException: Connection refused` calling `inventory-service`, roughly one request in five, only after deploys.

**Diagnose.** Establish who believes what, in order:

```bash
# 1. What does the registry claim?
curl -s -H "Accept: application/json" http://eureka-1:8761/eureka/apps/INVENTORY-SERVICE \
  | jq '.application.instance[] | {id: .instanceId, status: .status, ip: .ipAddr, lastRenewal: .leaseInfo.lastRenewalTimestamp}'

# 2. What does this specific caller's cache hold?
curl -s localhost:8080/actuator/serviceregistry
curl -s localhost:8080/actuator/metrics/spring.cloud.loadbalancer.requests

# 3. What actually exists?
kubectl get pods -l app=inventory-service -o wide
```

Compare instance IPs across the three. A pod IP present in (1) and (2) but absent from (3) is a stale lease. Check whether the number of stale entries matches the number of pods replaced in the last rollout — if so it is a graceful-shutdown problem, not an Eureka problem.

Add temporary visibility on the caller:

```java
@Bean
ApplicationRunner instanceDump(DiscoveryClient dc) {
    return args -> Executors.newSingleThreadScheduledExecutor().scheduleAtFixedRate(
        () -> log.info("inventory instances: {}",
            dc.getInstances("inventory-service").stream().map(ServiceInstance::getUri).toList()),
        0, 15, TimeUnit.SECONDS);
}
```

**Fix.** Confirmed stale leases from SIGKILLed pods. Added `preStop: sleep 20`, raised `terminationGracePeriodSeconds` to 60, enabled the health-check `ServiceInstanceListSupplier`, and dropped the LoadBalancer cache TTL to 10s. Failure rate after deploys went to zero. The health-check supplier alone would have masked the symptom; the graceful shutdown fixed the cause.

---

## 6. Spring Cloud LoadBalancer

### Core concept

Spring Cloud LoadBalancer (SCLB) is the Ribbon replacement, living in `spring-cloud-commons`. It is **client-side**: your process holds the instance list and picks one per request. Two entry points:

```java
@Configuration
public class HttpClientConfig {

    @Bean
    @LoadBalanced
    RestTemplate restTemplate(RestTemplateBuilder builder) {
        return builder
            .connectTimeout(Duration.ofSeconds(2))
            .readTimeout(Duration.ofSeconds(3))
            .build();
    }

    @Bean
    @LoadBalanced
    WebClient.Builder webClientBuilder() {
        return WebClient.builder();
    }

    @Bean
    @LoadBalanced
    RestClient.Builder restClientBuilder() {          // Boot 3.2+
        return RestClient.builder();
    }
}
```

```java
// the host segment is a serviceId, resolved through DiscoveryClient
Inventory inv = restTemplate.getForObject("http://inventory-service/api/items/{id}", Inventory.class, id);

Mono<Inventory> mono = webClient.get()
    .uri("http://inventory-service/api/items/{id}", id)
    .retrieve()
    .bodyToMono(Inventory.class);
```

`@LoadBalanced` adds a `ClientHttpRequestInterceptor` (blocking) or `ExchangeFilterFunction` (reactive) that swaps the serviceId host for a chosen instance's host:port. **Without the annotation** you get `UnknownHostException: inventory-service`, which is the single most common SCLB error and always means a missing `@LoadBalanced` or an injected raw `RestTemplate`.

### Internal working

```
request to http://inventory-service/api/items/42
  └─ LoadBalancerInterceptor / DeferringLoadBalancerExchangeFilterFunction
       └─ LoadBalancerClient.choose("inventory-service")
            └─ ReactiveLoadBalancer<ServiceInstance>  (default: RoundRobinLoadBalancer)
                 └─ ServiceInstanceListSupplier.get(request)   ← the pipeline
                      └─ DiscoveryClientServiceInstanceListSupplier
                           └─ DiscoveryClient (Eureka / Consul / K8s)
       └─ rewrite URI to http://10.4.2.19:8080/api/items/42
       └─ execute
       └─ LoadBalancerLifecycle callbacks (metrics, retries)
```

`ServiceInstanceListSupplier` is the extension point that matters. It is a decorator chain, built with a fluent builder:

```java
public class CustomLoadBalancerConfiguration {

    @Bean
    ServiceInstanceListSupplier instanceSupplier(ConfigurableApplicationContext context) {
        return ServiceInstanceListSupplier.builder()
            .withDiscoveryClient()      // base: query the registry
            .withHealthChecks()         // ping /actuator/health, filter out failures
            .withZonePreference()       // prefer same-zone instances
            .withCaching()              // Caffeine cache — MUST be last
            .build(context);
    }
}
```

Order is meaningful: `withCaching()` last means the cache wraps everything below it, so health checks and zone filtering are not re-run per request. Putting caching in the middle caches the raw discovery list and then filters on every call — correct results, wasted CPU.

Built-in suppliers:

| Supplier | Behaviour |
|---|---|
| `DiscoveryClientServiceInstanceListSupplier` | Base — one call to `DiscoveryClient` per request |
| `CachingServiceInstanceListSupplier` | Caffeine cache, TTL `spring.cloud.loadbalancer.cache.ttl` (35s), capacity 256 |
| `HealthCheckServiceInstanceListSupplier` | Background pings; only instances that answered are returned |
| `ZonePreferenceServiceInstanceListSupplier` | Filters to instances whose `zone` metadata matches `spring.cloud.loadbalancer.zone` |
| `SameInstancePreferenceServiceInstanceListSupplier` | Sticky: reuse the previously chosen instance if still available |
| `RequestBasedStickySessionServiceInstanceListSupplier` | Sticky by a cookie / `instanceIdCookieName` |
| `RetryAwareServiceInstanceListSupplier` | On retry, prefer an instance **other** than the one that just failed |
| `WeightedServiceInstanceListSupplier` | Honours a `weight` metadata key — useful for canaries |
| `SubsetServiceInstanceListSupplier` | Deterministic subset — reduces connection fan-out in very large fleets |

Property shortcuts for common combinations:

```yaml
spring:
  cloud:
    loadbalancer:
      configurations: health-check      # or: zone-preference, weighted, default
      zone: ${AWS_AZ:eu-west-1a}
      cache:
        enabled: true
        ttl: 20s
        capacity: 512
      health-check:
        initial-delay: 5s
        interval: 10s
        refetch-instances: true
        refetch-instances-interval: 25s
        repeat-health-check: true
        path:
          default: /actuator/health
          inventory-service: /internal/ping
      retry:
        enabled: true
        max-retries-on-same-service-instance: 0
        max-retries-on-next-service-instance: 1
        retry-on-all-operations: false
        retryable-status-codes: [502, 503, 504]
        backoff:
          enabled: true
          min-backoff: 50ms
          max-backoff: 500ms
          jitter: 0.5
      sticky-session:
        add-service-instance-cookie: false
        instance-id-cookie-name: sc-lb-instance-id
```

Default algorithm is **round-robin** (`RoundRobinLoadBalancer`), using an `AtomicInteger` position modulo instance count. `RandomLoadBalancer` also ships. There is no built-in least-connections or latency-weighted policy — if you need one, implement `ReactorServiceInstanceLoadBalancer`.

### Per-service configuration

`@LoadBalancerClient` configuration classes are **child contexts**, one per serviceId. They must **not** be `@Configuration`-scanned by the main context, or their beans become global.

```java
@Configuration
@LoadBalancerClients({
    @LoadBalancerClient(name = "inventory-service", configuration = InventoryLbConfig.class),
    @LoadBalancerClient(name = "pricing-service",   configuration = StickyLbConfig.class)
})
public class LoadBalancerClientsConfig { }
```

```java
// NOT annotated with @Configuration, and NOT in a @ComponentScan-ed package
public class InventoryLbConfig {

    @Bean
    ReactorLoadBalancer<ServiceInstance> randomLoadBalancer(
            Environment environment,
            LoadBalancerClientFactory factory) {
        String name = environment.getProperty(LoadBalancerClientFactory.PROPERTY_NAME);
        return new RandomLoadBalancer(
            factory.getLazyProvider(name, ServiceInstanceListSupplier.class), name);
    }

    @Bean
    ServiceInstanceListSupplier supplier(ConfigurableApplicationContext ctx) {
        return ServiceInstanceListSupplier.builder()
            .withDiscoveryClient()
            .withHealthChecks()
            .withRetryAwareness()
            .withCaching()
            .build(ctx);
    }
}
```

Putting `@Configuration` on `InventoryLbConfig` while it sits under the main package is the classic mistake: the beans are registered in the parent context, every service gets the "inventory-only" policy, and the per-client override silently does nothing.

A custom weighted canary supplier, since this is a common real requirement:

```java
public class CanaryAwareSupplier extends DelegatingServiceInstanceListSupplier {

    private final int canaryPercent;

    public CanaryAwareSupplier(ServiceInstanceListSupplier delegate, int canaryPercent) {
        super(delegate);
        this.canaryPercent = canaryPercent;
    }

    @Override
    public Flux<List<ServiceInstance>> get(Request request) {
        return getDelegate().get(request).map(instances -> {
            boolean toCanary = ThreadLocalRandom.current().nextInt(100) < canaryPercent;
            List<ServiceInstance> filtered = instances.stream()
                .filter(i -> toCanary == "canary".equals(i.getMetadata().get("track")))
                .toList();
            return filtered.isEmpty() ? instances : filtered;   // never return empty
        });
    }
}
```

The `filtered.isEmpty() ? instances : filtered` guard is not optional. A supplier that returns an empty list produces `No instances available for inventory-service` and a 503 with no useful cause.

### Retries and the Resilience4j interaction

`spring.cloud.loadbalancer.retry.enabled` defaults to `true`, **but for the blocking `RestTemplate` path it only takes effect if `spring-retry` is on the classpath**. Without it, the properties are read and ignored. This is a frequent "I configured retries and nothing retried" report.

```xml
<dependency>
  <groupId>org.springframework.retry</groupId>
  <artifactId>spring-retry</artifactId>
</dependency>
```

Semantics:

- `max-retries-on-same-service-instance` — retry against the instance that just failed. Set to `0` unless you are retrying a transient local error; retrying a dead instance is pure latency.
- `max-retries-on-next-service-instance` — retry against a different instance. This is the useful one.
- `retry-on-all-operations: false` (default) retries only idempotent HTTP methods (GET, HEAD, OPTIONS, etc.). Setting it to `true` will retry POSTs — only do that if every POST endpoint you call is idempotent (see `notes/microservices/data-reliability.md` on idempotency keys).
- `retryable-status-codes` retries on responses; connection failures and timeouts are retried regardless.

**Layering with Resilience4j.** The two retry mechanisms compose multiplicatively and nobody notices until an outage:

```
Resilience4j @Retry maxAttempts=3
  × LoadBalancer max-retries-on-next-service-instance=2 (→ 3 tries)
  × Feign Retryer (if configured)
  = up to 9–27 requests for one logical call
```

Pick **one** retry layer per hop. The recommended arrangement:

| Layer | Responsibility |
|---|---|
| LoadBalancer retry | Retry a *connection-level* failure on a **different instance**, 1 extra attempt, no backoff needed |
| Resilience4j `@Retry` | Retry a *business-level* transient failure (429, 503 with Retry-After), with exponential backoff and jitter |
| Feign `Retryer` | **Disable it** (`Retryer.NEVER_RETRY`) — it predates both and has no backoff coordination |
| Circuit breaker | Must wrap the retries, so a persistently failing dependency stops being retried at all |

Ordering matters: the circuit breaker should see one logical call (including its retries) as a single success/failure, otherwise retries inflate the call count and the failure-rate percentage never crosses the threshold. In practice that means `@CircuitBreaker` outside `@Retry`… except Resilience4j's default aspect order is the opposite (Retry outermost). Section 9 covers this in detail; it is the single most-missed configuration in the whole stack.

### Production scenario: round-robin across zones triples p99 latency and the AWS bill

**Problem.** A service is deployed across three AZs. After migrating from Ribbon to SCLB, p99 latency for `inventory-service` calls rises from 40 ms to 130 ms, and the cross-AZ data transfer line on the cloud bill roughly triples.

**Cause.** Ribbon had `ZoneAvoidanceRule` on by default. SCLB's default is plain round-robin with **no zone awareness**, so two out of every three calls cross an availability zone — adding ~1 ms of RTT each way at best, far more under load, and incurring inter-AZ transfer charges.

**Solution.**

```yaml
spring:
  cloud:
    loadbalancer:
      configurations: zone-preference
      zone: ${TOPOLOGY_ZONE}          # injected from the node label
```

```yaml
# Kubernetes: expose the node's zone to the pod
env:
  - name: TOPOLOGY_ZONE
    valueFrom:
      fieldRef:
        fieldPath: metadata.labels['topology.kubernetes.io/zone']
```

And make sure the **registered instances carry the zone** — zone preference filters on instance metadata, so if the metadata is absent every instance looks like "unknown zone" and the filter is a no-op:

```yaml
eureka:
  instance:
    metadata-map:
      zone: ${TOPOLOGY_ZONE}
```

`ZonePreferenceServiceInstanceListSupplier` falls back to the full list when no same-zone instance exists, so a zone outage does not black-hole traffic. Verify with a metric split by target zone:

```java
@Bean
LoadBalancerLifecycle<Object, Object, ServiceInstance> zoneMetrics(MeterRegistry registry) {
    return new LoadBalancerLifecycle<>() {
        @Override public void onStart(Request<Object> request) { }
        @Override public void onStartRequest(Request<Object> request, Response<ServiceInstance> lbResponse) {
            if (lbResponse.hasServer()) {
                registry.counter("lb.choice",
                    "service", lbResponse.getServer().getServiceId(),
                    "zone", String.valueOf(lbResponse.getServer().getMetadata().get("zone"))).increment();
            }
        }
        @Override public void onComplete(CompletionContext<Object, ServiceInstance, Object> ctx) { }
    };
}
```

After the change, `sum by (zone) (rate(lb_choice_total[5m]))` should be overwhelmingly the local zone.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Missing `@LoadBalanced` | `UnknownHostException: inventory-service` |
| Two `RestTemplate` beans, one load-balanced, wrong one injected | Same `UnknownHostException`, but only on some call sites |
| `@LoadBalanced` on a `WebClient` (not the `Builder`) | Filter not applied; the built client is immutable |
| Per-client config class annotated `@Configuration` in a scanned package | Policy leaks to every service |
| Caching supplier not last in the builder chain | Health checks re-executed per request; latency and health-endpoint load |
| `spring-retry` absent | LoadBalancer retry properties silently ignored |
| LoadBalancer retry + Feign Retryer + Resilience4j retry all on | Retry storm; one client outage saturates the callee |
| Cache TTL 35s with a fast-scaling fleet | Requests routed to terminated instances for up to 35s after they leave the registry |
| Custom supplier returning an empty list | `No instances available for X`, 503, no root cause in the message |
| Health-check supplier pointed at a path requiring auth | All instances filtered out; total outage of that dependency |

### Debugging scenario

**Observe.** `java.lang.IllegalStateException: No instances available for pricing-service` in one environment only; the registry clearly shows four healthy instances.

**Diagnose.**

```yaml
logging:
  level:
    org.springframework.cloud.loadbalancer: DEBUG
    org.springframework.cloud.client.loadbalancer: DEBUG
```

Look for the supplier chain output:

```
DEBUG ... RoundRobinLoadBalancer : No servers available for service: pricing-service
DEBUG ... HealthCheckServiceInstanceListSupplier : Health check failed for instance
        pricing-service 10.4.9.7:8080, path /actuator/health, status 401
```

That last line is the answer: the health-check supplier is filtering out every instance because the health endpoint requires authentication in this environment.

Confirm by querying the supplier directly:

```java
@RestController
class LbDebugController {

    private final LoadBalancerClientFactory factory;

    LbDebugController(LoadBalancerClientFactory factory) { this.factory = factory; }

    @GetMapping("/internal/lb/{service}")
    Mono<List<String>> instances(@PathVariable String service) {
        ServiceInstanceListSupplier supplier =
            factory.getInstance(service, ServiceInstanceListSupplier.class);
        return supplier.get().next()
            .map(list -> list.stream().map(i -> i.getUri().toString()).toList());
    }
}
```

**Fix.** Either expose `/actuator/health` unauthenticated on the internal port (standard: a separate `management.server.port` bound to the pod network only), or point the health check at a permitted path:

```yaml
management:
  server:
    port: 8081                 # not exposed via Service/Ingress
spring:
  cloud:
    loadbalancer:
      health-check:
        path:
          pricing-service: /actuator/health/readiness
```

---

## 7. OpenFeign

### Core concept

OpenFeign is a declarative HTTP client: you write an interface, Spring generates a proxy that handles URL construction, serialization, and — when combined with Spring Cloud — service discovery and load balancing. It sits on top of whatever HTTP client you configure (`HttpURLConnection`, Apache HttpClient 5, OkHttp, or Spring's `HttpClient`/`RestClient` adapters).

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-openfeign</artifactId>
</dependency>
```

```java
@SpringBootApplication
@EnableFeignClients
public class OrderApplication { }

@FeignClient(name = "inventory-service", path = "/api/v1")
public interface InventoryClient {

    @GetMapping("/items/{id}")
    InventoryDto getItem(@PathVariable("id") Long id);

    @PostMapping("/items/reserve")
    ReservationDto reserve(@RequestBody ReserveRequest request);
}
```

The `name` attribute is the **serviceId** resolved by Spring Cloud LoadBalancer — not a hostname. `url = "http://inventory-service"` would bypass discovery entirely and is only appropriate for fixed endpoints or local dev.

### Internal working

```
@FeignClient proxy method call
  └─ FeignInvocationHandler
       └─ Contract (SpringMvcContract maps @GetMapping etc.)
       └─ Encoder / Decoder (Jackson by default)
       └─ RequestInterceptor chain (OAuth2, tracing headers, custom)
       └─ Client
            └─ LoadBalancerFeignClient (wraps the underlying Client)
                 └─ LoadBalancerClient.choose("inventory-service")
                 └─ rewrite target host → chosen instance
       └─ ErrorDecoder (maps 4xx/5xx → exceptions)
       └─ Retryer (Feign's own — separate from Resilience4j / LoadBalancer retry)
```

Three retry layers can stack if you are not careful: **Feign Retryer**, **LoadBalancer retry** (section 6), and **Resilience4j retry** (section 9). Enable at most one for outbound calls unless you have explicit backoff budgets.

### Configuration

Global defaults via `application.yml`:

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          default:
            connectTimeout: 2000
            readTimeout: 5000
            loggerLevel: BASIC          # NONE | BASIC | HEADERS | FULL
            dismiss404: false
          inventory-service:            # per-client overrides
            readTimeout: 3000
            retryer: feign.Retryer.NEVER_RETRY
```

Per-client Java config (must **not** be `@Configuration`-scanned globally):

```java
public class InventoryFeignConfig {

    @Bean
    Logger.Level feignLoggerLevel() {
        return Logger.Level.BASIC;
    }

    @Bean
    ErrorDecoder inventoryErrorDecoder() {
        return (methodKey, response) -> {
            if (response.status() == 404) {
                return new ItemNotFoundException(methodKey);
            }
            return new ErrorDecoder.Default().decode(methodKey, response);
        };
    }

    @Bean
    RequestInterceptor correlationIdInterceptor() {
        return template -> {
            String traceId = MDC.get("traceId");
            if (traceId != null) {
                template.header("X-Correlation-Id", traceId);
            }
        };
    }
}
```

```java
@FeignClient(name = "inventory-service", configuration = InventoryFeignConfig.class)
public interface InventoryClient { /* ... */ }
```

### Boot 3 / Spring Cloud 2023+ specifics

- **Feign + `@RefreshScope`**: Feign clients are singletons. Timeout changes from Config Server require either `@RefreshScope` on a wrapper bean or a custom `Request.Options` bean that reads from `Environment` on each call. Most teams restart pods on config change instead.
- **`spring.cloud.openfeign.oauth2.enabled`**: replaced by Spring Security's `OAuth2AuthorizedClientManager` integration — configure `OAuth2AccessTokenInterceptor` as a `RequestInterceptor`.
- **HttpClient 5** is the default when `feign-hc5` is on the classpath (Boot 3.2+ starter pulls it transitively). Tune pool size:

```yaml
spring:
  cloud:
    openfeign:
      httpclient:
        hc5:
          enabled: true
          pool-reuse-policy: fifo
          pool-concurrency-policy: strict
          socket-timeout: 5
          socket-timeout-unit: seconds
          connection-request-timeout: 3
          connection-request-timeout-unit: seconds
```

### Fallbacks and resilience integration

Raw Feign `fallback` / `fallbackFactory` still work, but prefer **Resilience4j circuit breaker** wrapping (section 9) for metrics and consistency:

```java
@FeignClient(name = "inventory-service", fallbackFactory = InventoryFallbackFactory.class)
public interface InventoryClient { /* ... */ }

@Component
public class InventoryFallbackFactory implements FallbackFactory<InventoryClient> {
    @Override
    public InventoryClient create(Throwable cause) {
        return new InventoryClient() {
            @Override
            public InventoryDto getItem(Long id) {
                log.warn("inventory fallback for id={}: {}", id, cause.toString());
                return InventoryDto.unavailable(id);
            }
            // ...
        };
    }
}
```

`FallbackFactory` gives you the **cause** — essential for distinguishing timeout vs 503 vs circuit-open.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@EnableFeignClients` missing or wrong `basePackages` | `NoSuchBeanDefinitionException` at injection time |
| `name` typo vs Eureka registration | `UnknownHostException` or `No instances available` |
| Feign Retryer + Resilience4j retry + LB retry all enabled | Retry storm; callee saturated during partial outage |
| `@FeignClient` config class annotated `@Configuration` in scanned package | Config beans leak to every Feign client |
| `url` attribute set alongside `name` expecting LB | Fixed URL used; discovery bypassed silently |
| Missing `@LoadBalanced`-equivalent (Feign handles this internally) | N/A for Feign — but custom `Client` bean without LB wrapper breaks resolution |
| `LoggerLevel.FULL` in production | Log volume explosion; PII in headers logged |
| DTO mismatch after provider deploy | `DecodeException` / `JsonMappingException` at runtime — contract tests catch this (section 13) |

### Debugging scenario

**Observe.** `order-service` logs `feign.RetryableException: inventory-service executing GET http://inventory-service/api/v1/items/42` with nested `SocketTimeoutException: Read timed out`. Only under load; single requests succeed.

**Diagnose.**

```yaml
logging:
  level:
    feign: DEBUG
    org.springframework.cloud.openfeign: DEBUG
```

Look for pool exhaustion:

```
DEBUG feign.Client$Default : Connection pool exhausted, waiting for connection
```

Check active connections vs pool max. With HC5, enable metrics:

```java
@Bean
MeterRegistryCustomizer<MeterRegistry> feignMetrics() {
    return registry -> registry.config().commonTags("application", "order-service");
}
```

Query `http.client.pool.active` and compare to `http.client.pool.max`.

**Fix.** Increase pool size and align read timeout with upstream SLA:

```yaml
spring:
  cloud:
    openfeign:
      client:
        config:
          inventory-service:
            readTimeout: 8000
      httpclient:
        hc5:
          max-connections: 200
          max-connections-per-route: 50
```

Also verify inventory-service p99 latency — a timeout fix without capacity fix just delays failure.

---

## 8. Spring Cloud Gateway

### Core concept

Spring Cloud Gateway is the **reactive** edge router (WebFlux / Netty). It replaces Netflix Zuul 1. Every request passes through a chain of **GlobalFilters** and **Route-specific GatewayFilters** before being proxied to a downstream service via `WebClient` + LoadBalancer.

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-gateway</artifactId>
</dependency>
```

```yaml
spring:
  cloud:
    gateway:
      discovery:
        locator:
          enabled: true
          lower-case-service-id: true
      routes:
        - id: orders
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
          filters:
            - StripPrefix=1
            - name: CircuitBreaker
              args:
                name: orderCb
                fallbackUri: forward:/fallback/orders
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
                key-resolver: "#{@userKeyResolver}"
        - id: inventory
          uri: lb://inventory-service
          predicates:
            - Path=/api/inventory/**
          filters:
            - StripPrefix=1
            - AddRequestHeader=X-Gateway-Source, edge
```

`lb://` scheme triggers LoadBalancer — same mechanism as `@LoadBalanced RestTemplate`.

### Internal working

```
Client → Gateway (Netty)
  └─ RoutePredicateHandlerMapping matches route
  └─ FilteringWebHandler
       └─ GlobalFilter chain (ordered by getOrder())
            ├─ NettyRoutingFilter          (proxies to downstream)
            ├─ LoadBalancerClientFilter      (resolves lb://)
            ├─ CircuitBreakerFilter          (Resilience4j)
            ├─ RequestRateLimiterGatewayFilter
            ├─ RetryGatewayFilter
            └─ RouteToRequestUrlFilter
       └─ WebClient call to chosen instance
  └─ Response back through filter chain (response filters run in reverse)
```

Filter order matters. `GlobalFilter` with `getOrder() = -1` runs before `0`. Built-in filters use `Ordered` constants — consult `NettyRoutingFilter.ORDER` when inserting custom filters.

### Gateway MVC (blocking alternative)

For teams stuck on servlet stack or needing blocking I/O integration, **Spring Cloud Gateway MVC** (`spring-cloud-starter-gateway-mvc`) provides the same route model on Tomcat/Jetty:

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-gateway-mvc</artifactId>
</dependency>
```

Use Gateway (reactive) for high-concurrency edge; Gateway MVC when the rest of the stack is servlet-only and thread pool sizing is acceptable. Do not run both in the same process.

### Dynamic routes

Static YAML routes are fine for small deployments. Production usually loads routes from Config Server, a database, or Kubernetes CRDs:

```java
@Component
public class DynamicRouteService {

    private final RouteDefinitionWriter routeWriter;
    private final ApplicationEventPublisher publisher;

    public Mono<Void> add(RouteDefinition definition) {
        return routeWriter.save(Mono.just(definition))
            .then(Mono.fromRunnable(() ->
                publisher.publishEvent(new RefreshRoutesEvent(this))));
    }
}
```

After adding routes programmatically, publish `RefreshRoutesEvent` or the gateway will not pick them up until restart.

### Security at the edge

Gateway is the natural place for JWT validation, API key checks, and CORS — before traffic hits microservices:

```yaml
spring:
  cloud:
    gateway:
      default-filters:
        - TokenRelay=
        - DedupeResponseHeader=Access-Control-Allow-Origin Access-Control-Allow-Credentials, RETAIN_UNIQUE
      globalcors:
        corsConfigurations:
          '[/**]':
            allowedOrigins: "https://app.example.com"
            allowedMethods: [GET, POST, PUT, DELETE]
            allowedHeaders: "*"
            allowCredentials: true
```

```java
@Bean
public RouteLocator customRoutes(RouteLocatorBuilder builder) {
    return builder.routes()
        .route("secure-orders", r -> r
            .path("/api/orders/**")
            .filters(f -> f
                .filter(new JwtValidationGatewayFilter())  // custom GlobalFilter
                .circuitBreaker(c -> c.setName("orders").setFallbackUri("forward:/fallback")))
            .uri("lb://order-service"))
        .build();
}
```

See section 16 for OAuth2 resource server patterns.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `StripPrefix` count wrong | Downstream receives `/api/orders/...` instead of `/orders/...`, 404 |
| Missing `lb://` scheme | `UnknownHostException` for service name |
| Rate limiter Redis not configured | Gateway fails to start or 500 on every request |
| CORS configured on gateway AND downstream | Duplicate `Access-Control-Allow-Origin` headers; browser rejects |
| Circuit breaker fallback route not registered | 500 instead of graceful fallback |
| Large file upload through gateway without `spring.codec.max-in-memory-size` | `DataBufferLimitException` |
| Custom filter throws before `chain.filter()` | Request hangs or 500 with no downstream call logged |

### Debugging scenario

**Observe.** Gateway returns 504 Gateway Timeout for `/api/orders/**` but direct calls to `order-service` pods succeed.

**Diagnose.**

```yaml
logging:
  level:
    org.springframework.cloud.gateway: DEBUG
    reactor.netty.http.client: DEBUG
```

Look for:

```
DEBUG o.s.c.g.f.h.o.ObservedRequestHttpHeadersFilter : Client observation  ...
DEBUG r.n.http.client.HttpClientConnect : [abc123, L:/10.0.1.5:54321 - R:order-service/10.4.2.19:8080] Connected
```

If connection succeeds but no response line appears, the downstream is slow. If `LoadBalancer` shows `No instances available`, discovery is the problem — not the downstream.

Enable actuator route introspection:

```yaml
management:
  endpoint:
    gateway:
      enabled: true
  endpoints:
    web:
      exposure:
        include: gateway,health,metrics
```

```bash
curl -s localhost:8080/actuator/gateway/routes | jq '.[] | select(.route_id=="orders")'
```

**Fix.** Often a read timeout mismatch:

```yaml
spring:
  cloud:
    gateway:
      httpclient:
        connect-timeout: 3000
        response-timeout: 10s
```

`response-timeout` is the gateway-side wait for the full downstream response. Set it above downstream p99 but below client-facing SLA.

---

## 9. Resilience4j + Spring Cloud CircuitBreaker

### Core concept

Netflix Hystrix is dead. **Resilience4j** is a lightweight fault-tolerance library; **Spring Cloud CircuitBreaker** (`spring-cloud-circuitbreaker`) provides a vendor-neutral abstraction with Resilience4j and Spring Retry implementations.

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-circuitbreaker-resilience4j</artifactId>
</dependency>
```

Two integration styles:

1. **Imperative** — `CircuitBreakerFactory` / `@CircuitBreaker` (Spring Cloud CircuitBreaker)
2. **Declarative** — Resilience4j annotations (`@CircuitBreaker`, `@Retry`, `@Bulkhead`, `@RateLimiter`, `@TimeLimiter`)

```java
@Service
public class PricingService {

    private final CircuitBreakerFactory circuitBreakerFactory;
    private final PricingClient pricingClient;

    public BigDecimal getPrice(Long skuId) {
        CircuitBreaker cb = circuitBreakerFactory.create("pricing");
        return cb.run(
            () -> pricingClient.getPrice(skuId),
            throwable -> BigDecimal.valueOf(-1)   // fallback
        );
    }
}
```

Reactive variant:

```java
@Bean
public Customizer<ReactiveResilience4JCircuitBreakerFactory> defaultCustomizer() {
    return factory -> factory.configureDefault(id -> new Resilience4JConfigBuilder(id)
        .circuitBreakerConfig(CircuitBreakerConfig.custom()
            .slidingWindowSize(20)
            .failureRateThreshold(50)
            .waitDurationInOpenState(Duration.ofSeconds(30))
            .permittedNumberOfCallsInHalfOpenState(5)
            .build())
        .timeLimiterConfig(TimeLimiterConfig.custom()
            .timeoutDuration(Duration.ofSeconds(3))
            .build())
        .build());
}
```

### Resilience4j modules

| Module | Purpose |
|---|---|
| `circuitbreaker` | Fail fast when error rate exceeds threshold |
| `retry` | Retry transient failures with backoff |
| `bulkhead` | Limit concurrent calls (thread pool or semaphore) |
| `ratelimiter` | Limit call rate |
| `timelimiter` | Timeout wrapper |
| `cache` | Result caching |

```yaml
resilience4j:
  circuitbreaker:
    configs:
      default:
        slidingWindowSize: 20
        minimumNumberOfCalls: 10
        failureRateThreshold: 50
        waitDurationInOpenState: 30s
        permittedNumberOfCallsInHalfOpenState: 5
        automaticTransitionFromOpenToHalfOpenEnabled: true
    instances:
      pricing:
        baseConfig: default
        failureRateThreshold: 30
  retry:
    instances:
      pricing:
        maxAttempts: 3
        waitDuration: 200ms
        enableExponentialBackoff: true
        exponentialBackoffMultiplier: 2
        retryExceptions:
          - java.net.SocketTimeoutException
          - org.springframework.web.client.HttpServerErrorException
  bulkhead:
    instances:
      pricing:
        maxConcurrentCalls: 25
        maxWaitDuration: 500ms
  timelimiter:
    instances:
      pricing:
        timeoutDuration: 3s
        cancelRunningFuture: true
```

### Gateway + Feign integration

Gateway circuit breaker filter:

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: pricing
          uri: lb://pricing-service
          filters:
            - name: CircuitBreaker
              args:
                name: pricingCb
                fallbackUri: forward:/fallback/pricing
```

Feign does not have a first-class circuit breaker annotation — wrap the client call in `CircuitBreakerFactory` or use Resilience4j `@CircuitBreaker` on the service method that calls Feign.

### Metrics and health

Resilience4j exposes Micrometer metrics automatically when `resilience4j-micrometer` is present:

```
resilience4j_circuitbreaker_state{name="pricing",state="closed"} 1
resilience4j_circuitbreaker_failure_rate{name="pricing"} 0.05
resilience4j_bulkhead_available_concurrent_calls{name="pricing"} 20
```

Actuator health indicator:

```yaml
management:
  health:
    circuitbreakers:
      enabled: true
  endpoint:
    health:
      show-details: when_authorized
```

`/actuator/health` includes `circuitBreakers` section showing OPEN/CLOSED state per instance.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `minimumNumberOfCalls` too high for low traffic | Circuit never opens; failures pass through indefinitely |
| Retry + circuit breaker ordering wrong | Retries count as failures; circuit opens prematurely |
| Bulkhead thread pool too small | `BulkheadFullException` under normal load |
| TimeLimiter on blocking code without `@Bulkhead(type=THREADPOOL)` | Thread blocked anyway; timeout does not help |
| Same Resilience4j instance name for different dependencies | Shared state; one bad service opens circuit for another |
| Fallback method not on same class / not public | `NoSuchMethodException` at runtime |

### Debugging scenario

**Observe.** `pricing-service` is healthy but `order-service` logs `CallNotPermittedException: CircuitBreaker 'pricing' is OPEN` intermittently.

**Diagnose.**

```bash
curl -s localhost:8080/actuator/circuitbreakers | jq '.circuitBreakers.pricing'
curl -s localhost:8080/actuator/metrics/resilience4j.circuitbreaker.failure.rate?tag=name:pricing
```

Check if failures are real or misconfigured timeouts:

```yaml
logging:
  level:
    io.github.resilience4j: DEBUG
```

Look for `Recorded a failure` entries — if every failure is `TimeoutException` with 3s limit but pricing p99 is 2.8s, the time limiter is too aggressive.

**Fix.**

```yaml
resilience4j:
  timelimiter:
    instances:
      pricing:
        timeoutDuration: 5s
  circuitbreaker:
    instances:
      pricing:
        failureRateThreshold: 60
        waitDurationInOpenState: 15s
        slowCallDurationThreshold: 4s
        slowCallRateThreshold: 80
```

Enable slow-call detection so latency spikes trip the breaker before hard failures cascade.

---

## 10. Distributed Tracing (Micrometer Tracing)

### Core concept

Spring Cloud Sleuth is **EOL**. Micrometer Tracing (`io.micrometer:micrometer-tracing`) is the replacement, integrated with Boot 3's observability stack. It propagates trace context (W3C `traceparent` by default) across HTTP, messaging, and Feign/Gateway calls.

```xml
<dependency>
  <groupId>io.micrometer</groupId>
  <artifactId>micrometer-tracing-bridge-brave</artifactId>
</dependency>
<dependency>
  <groupId>io.zipkin.reporter2</groupId>
  <artifactId>zipkin-reporter-brave</artifactId>
</dependency>
<!-- OR for OpenTelemetry -->
<dependency>
  <groupId>io.micrometer</groupId>
  <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
  <groupId>io.opentelemetry</groupId>
  <artifactId>opentelemetry-exporter-zipkin</artifactId>
</dependency>
```

```yaml
management:
  tracing:
    sampling:
      probability: 1.0          # 1.0 in dev; 0.1 or adaptive in prod
    propagation:
      type: w3c                 # w3c | b3 | b3_multi
  zipkin:
    tracing:
      endpoint: http://zipkin:9411/api/v2/spans
```

Boot auto-configures:
- `Tracer` bean (Brave or OTel bridge)
- HTTP client/server instrumentation
- `@NewSpan` / `@ContinueSpan` support
- MDC population (`traceId`, `spanId`) for log correlation

### Propagation across Spring Cloud components

| Component | Automatic? | Notes |
|---|---|---|
| `@LoadBalanced RestTemplate` / `WebClient` | Yes | Trace headers injected on outbound |
| OpenFeign | Yes | Via `FeignObservationInterceptor` |
| Spring Cloud Gateway | Yes | Creates root/child spans per route |
| Spring Cloud Stream | Yes | Headers propagated in message headers |
| `@Async` | Partial | Must use `@Async` with context propagation enabled |
| Kafka native producer | Manual | Use `KafkaTemplate` observation or Brave Kafka instrumentation |

```java
@RestController
public class OrderController {

    private final Tracer tracer;

    @GetMapping("/orders/{id}")
    public Order get(@PathVariable Long id) {
        Span span = tracer.nextSpan().name("fetch-order").start();
        try (Tracer.SpanInScope ws = tracer.withSpan(span)) {
            span.tag("order.id", String.valueOf(id));
            return orderService.find(id);
        } finally {
            span.end();
        }
    }
}
```

Prefer `@Observed` (Micrometer Observation API) over manual spans in new code:

```java
@Observed(name = "order.fetch", contextualName = "fetch-order")
public Order find(Long id) { /* ... */ }
```

### Baggage

Baggage propagates business context (tenant ID, user ID) alongside trace context:

```yaml
management:
  tracing:
    baggage:
      remote-fields: tenant-id, user-id
      correlation:
        fields: tenant-id, user-id
```

```java
tracer.createBaggageInScope("tenant-id", tenantId);
```

Downstream services receive baggage as headers. **Do not put secrets in baggage** — headers traverse every hop and appear in logs.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Brave + OTel bridges both on classpath | Duplicate spans, conflicting `Tracer` beans |
| Sampling 1.0 in production | Trace backend overwhelmed; storage costs spike |
| B3 propagation with W3C-only downstream | Broken traces at service boundaries |
| Missing exporter dependency | Spans created locally but never leave the JVM |
| `@Async` without context propagation | Child work orphaned from parent span |
| Manual `span.end()` forgotten | Memory leak in span queue; incomplete traces |

### Debugging scenario

**Observe.** Logs show `traceId` in `order-service` but downstream `inventory-service` logs have a different `traceId` for the same request.

**Diagnose.** Check propagation type alignment:

```bash
curl -v -H "traceparent: 00-abc123-def456-01" http://gateway:8080/api/orders/1
```

Inspect outbound headers from gateway:

```yaml
logging:
  level:
    org.springframework.cloud.gateway.filter: DEBUG
    io.micrometer.tracing: DEBUG
```

Verify Feign is not stripping headers via a custom `RequestInterceptor` that replaces all headers.

**Fix.** Standardize propagation:

```yaml
management:
  tracing:
    propagation:
      type: w3c,b3          # dual propagation during migration
```

After all services support W3C, drop B3.

---

## 11. Spring Cloud Stream

### Core concept

Spring Cloud Stream is the **binder abstraction** for event-driven microservices. You write against `StreamBridge`, functional beans (`Consumer`/`Function`/`Supplier`), or `@StreamListener` (legacy), and bind to Kafka, RabbitMQ, or other brokers via starter binders.

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-stream-kafka</artifactId>
</dependency>
```

Functional model (preferred since Stream 3.x):

```java
@Configuration
public class OrderEventsConfig {

    @Bean
    public Function<OrderCreated, Message<InventoryReserve>> orderCreatedHandler() {
        return event -> MessageBuilder.withPayload(new InventoryReserve(event))
            .setHeader("orderId", event.getId())
            .build();
    }

    @Bean
    public Consumer<PaymentConfirmed> paymentConfirmedHandler() {
        return event -> orderService.markPaid(event.getOrderId());
    }
}
```

```yaml
spring:
  cloud:
    stream:
      function:
        definition: orderCreatedHandler;paymentConfirmedHandler
      bindings:
        orderCreatedHandler-in-0:
          destination: order.created
          group: order-service
          consumer:
            max-attempts: 3
        orderCreatedHandler-out-0:
          destination: inventory.reserve
        paymentConfirmedHandler-in-0:
          destination: payment.confirmed
          group: order-service
      kafka:
        binder:
          brokers: kafka:9092
          auto-create-topics: false
        bindings:
          orderCreatedHandler-in-0:
            consumer:
              enable-dlq: true
              dlq-name: order.created.dlq
              configuration:
                max.poll.records: 50
                isolation.level: read_committed
```

### StreamBridge (imperative send)

When you need to publish outside a functional pipeline:

```java
@Service
public class OrderEventPublisher {

    private final StreamBridge streamBridge;

    public void publishOrderCreated(OrderCreated event) {
        streamBridge.send("order-created-out-0", MessageBuilder.withPayload(event).build());
    }
}
```

```yaml
spring:
  cloud:
    stream:
      bindings:
        order-created-out-0:
          destination: order.created
```

### Error handling and DLQ

Production requires explicit error handling — default is log-and-continue or infinite retry depending on binder:

```yaml
spring:
  cloud:
    stream:
      kafka:
        bindings:
          paymentConfirmedHandler-in-0:
            consumer:
              enable-dlq: true
              dlq-name: payment.confirmed.dlq
              dlq-partitions: 3
              auto-commit-on-error: false
      default:
        consumer:
          max-attempts: 3
          back-off-initial-interval: 1000
          back-off-max-interval: 10000
          back-off-multiplier: 2.0
```

Custom error handler:

```java
@Bean
public Consumer<Message<?>> handleErrors() {
    return msg -> log.error("DLQ message: headers={}, payload={}",
        msg.getHeaders(), msg.getPayload());
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `function.definition` bean name typo | Binding not created; no error at startup in some versions |
| Missing `group` on consumer | Every instance receives every message (pub/sub, not queue) |
| `auto-create-topics: true` in prod | Topics created with default partitions/replication |
| Serialization mismatch (Avro vs JSON) | `SerializationException` at runtime |
| No DLQ configured | Poison messages block partition indefinitely |
| Transactional producer without `read_committed` consumer | Consumer reads uncommitted messages |

### Debugging scenario

**Observe.** `payment.confirmed` messages are produced but `order-service` never processes them. Consumer lag is zero — messages are not being consumed at all.

**Diagnose.**

```bash
curl -s localhost:8080/actuator/bindings | jq
```

Look for binding state:

```json
{
  "name": "paymentConfirmedHandler-in-0",
  "state": "failed",
  "group": "order-service"
}
```

Check logs for:

```
Failed to construct kafka consumer due to missing group.id
```

Or:

```
No qualifying bean of type 'java.util.function.Consumer<PaymentConfirmed>'
```

**Fix.** Ensure `function.definition` matches bean method names exactly:

```yaml
spring:
  cloud:
    stream:
      function:
        definition: paymentConfirmedHandler
```

And the consumer group is set:

```yaml
spring:
  cloud:
    stream:
      bindings:
        paymentConfirmedHandler-in-0:
          group: order-service
          destination: payment.confirmed
```

---

## 12. Spring Cloud Function (brief)

Spring Cloud Function (`spring-cloud-function`) is the **programming model** underneath Stream — plain `Function`/`Consumer`/`Supplier` beans that can run as web endpoints, stream bindings, or serverless handlers (AWS Lambda, Azure Functions) via adapters.

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-function-web</artifactId>
</dependency>
```

```java
@Bean
public Function<String, String> uppercase() {
    return String::toUpperCase;
}
```

Exposed at `POST /uppercase` automatically when function-web is on the classpath.

**When to use what:**

| Need | Use |
|---|---|
| Kafka/Rabbit messaging with binders | Spring Cloud Stream (section 11) |
| Simple HTTP function endpoint | Spring Cloud Function Web |
| AWS Lambda / Azure Functions | `spring-cloud-function-adapter-aws` |
| Composition (`Function<A,B>` → `Function<B,C>`) | `FunctionCatalog` composition API |

Stream 4.x **is** Function underneath — do not add both programming models for the same event flow. Pick functional beans + Stream bindings.

---

## 13. Spring Cloud Contract (brief)

Spring Cloud Contract generates **consumer-driven contract tests** from Groovy/YAML DSL or Java contracts. The producer verifies against generated tests; consumers get stubs for isolated testing.

```xml
<dependency>
  <groupId>org.springframework.cloud</groupId>
  <artifactId>spring-cloud-starter-contract-verifier</artifactId>
  <scope>test</scope>
</dependency>
```

```groovy
// contracts/inventory/shouldReturnItem.groovy
Contract.make {
    request {
        method GET()
        url '/api/v1/items/42'
    }
    response {
        status 200
        headers { contentType(applicationJson()) }
        body(id: 42, name: "Widget", quantity: 100)
    }
}
```

```yaml
# application-test.yml
spring:
  cloud:
    contract:
      verifier:
        fail-on-no-contracts: true
```

**This note does not duplicate the full contract-testing workflow.** For Pact vs SCC trade-offs, broker setup, CI integration, and the "green pipeline, broken deploy" scenario, see `notes/microservices/testing.md` sections 6–7.

Use Spring Cloud Contract when both consumer and producer are Java/Spring teams in one org. Use Pact when consumers and providers are independently owned or polyglot.

---

## 14. Migration Guides

These are the four migrations every team upgrading from Spring Cloud Hoxton/2020.0 or Boot 2.x eventually hits.

### Sleuth → Micrometer Tracing

| Sleuth (dead) | Micrometer Tracing |
|---|---|
| `spring-cloud-starter-sleuth` | `micrometer-tracing-bridge-brave` or `-bridge-otel` |
| `spring.sleuth.sampler.probability` | `management.tracing.sampling.probability` |
| `spring.sleuth.baggage-keys` | `management.tracing.baggage.remote-fields` |
| `spring.sleuth.web.skipPattern` | `management.tracing.enabled` + custom `ObservationPredicate` |
| Brave span reporting via Sleuth | Explicit exporter: `zipkin-reporter-brave` or OTel exporter |
| `@NewSpan` from Sleuth | `@NewSpan` from Micrometer (same annotation, different artifact) |

Steps:
1. Remove all `spring-cloud-sleuth-*` dependencies.
2. Add bridge + exporter (section 10).
3. Run dual B3 + W3C propagation during rollout.
4. Verify `/actuator/metrics/trace` or Zipkin/Jaeger UI shows spans.
5. Update log pattern to use `%mdc{traceId}` — key name unchanged.

### Hystrix → Resilience4j

| Hystrix | Resilience4j + Spring Cloud CircuitBreaker |
|---|---|
| `@HystrixCommand` | `@CircuitBreaker` (Resilience4j) or `CircuitBreakerFactory` |
| `hystrix.command.default.execution.isolation.thread.timeoutInMilliseconds` | `resilience4j.timelimiter.instances.*.timeoutDuration` |
| `circuitBreaker.requestVolumeThreshold` | `minimumNumberOfCalls` + `slidingWindowSize` |
| `fallbackMethod` | Same pattern; must remain on same class |
| Hystrix Dashboard | Grafana + `resilience4j_circuitbreaker_*` metrics |
| Thread pool isolation | `resilience4j.bulkhead.instances.*` (semaphore or thread pool) |

There is no drop-in annotation swap. Rewrite commands one service at a time. Gateway routes need `CircuitBreaker` filter instead of Hystrix filter.

### Zuul → Spring Cloud Gateway

| Zuul 1 | Spring Cloud Gateway |
|---|---|
| Servlet filter stack (blocking) | WebFlux / Netty (reactive) |
| `zuul.routes.*` | `spring.cloud.gateway.routes` |
| `ZuulFilter` | `GlobalFilter` / `GatewayFilter` |
| `Ribbon` for `serviceId` | `lb://serviceId` + LoadBalancer |
| `zuul.retryable` | `RetryGatewayFilter` |
| `PreDecorationFilter` route matching | `RoutePredicateFactory` |

Migration checklist:
1. Map each `zuul.routes` entry to a `spring.cloud.gateway.routes` entry.
2. Rewrite custom Zuul filters as `GlobalFilter` with explicit `getOrder()`.
3. Replace Hystrix filters with Resilience4j `CircuitBreaker` filter.
4. Load test — reactive gateway handles concurrency differently from servlet thread pools.
5. If blocking is required, evaluate Gateway MVC instead of forcing reactive.

### Ribbon → Spring Cloud LoadBalancer

Covered in detail in section 6. Summary:

| Ribbon | Spring Cloud LoadBalancer |
|---|---|
| `@RibbonClient` | `@LoadBalancerClient` |
| `IRule` (RoundRobin, WeightedResponseTime) | `ReactorServiceInstanceLoadBalancer` |
| `IPing` health checks | `HealthCheckServiceInstanceListSupplier` |
| `@RibbonClient` configuration | `@LoadBalancerClient(configuration=...)` |
| `NIWSServerListFilter` zone affinity | `ZonePreferenceServiceInstanceListSupplier` |
| Archaius dynamic properties | Boot `Environment` + Config Server |

Remove all `spring-cloud-starter-netflix-ribbon` and `@RibbonClient` annotations. Add `@LoadBalanced` to HTTP clients. Verify with `UnknownHostException` test — if you see it, annotation is missing.

---

## 15. Configuration Precedence Across Cloud Stack

Boot 3 property source ordering is the foundation; Spring Cloud adds imported sources on top. **Last source wins** for scalar properties.

### Boot 3 base order (highest priority first)

```
1. Devtools global settings (if devtools active)
2. Command line args (--key=val)
3. SPRING_APPLICATION_JSON (inline JSON env var)
4. ServletConfig init params
5. ServletContext init params
6. JNDI attributes
7. Java System properties (-Dkey=val)
8. OS environment variables
9. RandomValuePropertySource
10. Profile-specific application-{profile}.properties OUTSIDE the jar
11. Profile-specific application-{profile}.properties INSIDE the jar
12. application.properties OUTSIDE the jar
13. application.properties INSIDE the jar
14. @PropertySource annotations
15. Default properties (SpringApplication.setDefaultProperties)
```

### Where Cloud sources land

```
spring.config.import=optional:configserver:,optional:kubernetes:
```

Import order in `spring.config.import` matters — **later imports override earlier ones**:

```yaml
spring:
  config:
    import:
      - optional:configserver:http://config-server:8888
      - optional:kubernetes:
```

Effective stack for a typical K8s + Config Server deployment:

| Priority (high → low) | Source |
|---|---|
| 1 | Command line / env vars (`SPRING_*`, `K8S_*`) |
| 2 | `kubernetes:` ConfigMap/Secret (Spring Cloud K8s) |
| 3 | `configserver:` imported properties |
| 4 | Local `application-{profile}.yml` in the jar |
| 5 | Local `application.yml` in the jar |
| 6 | Cloud `bootstrap` context (only if bootstrap starter present — avoid) |

### The traps

**Env var beats Config Server, always.** `SPRING_CLOUD_GATEWAY_ROUTES_0_URI=http://wrong:8080` overrides YAML in git. This is the #1 "Config Server isn't working" report (also section 2).

**Relaxed binding maps aggressively:**

```
HTTP_CLIENT_READ_TIMEOUT  →  http.client.read-timeout
SPRING_CLOUD_GATEWAY_HTTPCLIENT_CONNECT_TIMEOUT  →  spring.cloud.gateway.httpclient.connect-timeout
```

**Kubernetes Secret vs ConfigMap vs Config Server:**

```yaml
# deployment.yaml — highest precedence
env:
  - name: PRICING_TIMEOUT
    value: "5000"
```

That 5000 wins over Config Server's 2000 even if Config Server is imported later — because env vars rank above imported config in Boot 3.

**@ConfigurationProperties refresh:** Only `@RefreshScope` beans rebind. Plain `@ConfigurationProperties` beans are refreshed by the `/actuator/refresh` endpoint but only if the bean is `@RefreshScope` or `@ConfigurationPropertiesScan` with `@RefreshScope` wrapper.

Diagnostic command:

```bash
curl -s localhost:8080/actuator/env/my.property.key | jq '.propertySources[] | {name, value: .property.value}'
```

Read top to bottom — first entry is the winner.

---

## 16. Security in Spring Cloud Stack

### OAuth2 / OIDC patterns

**Gateway as resource server** (validates JWT at edge):

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com/realms/acme
```

```java
@Bean
SecurityWebFilterChain springSecurityFilterChain(ServerHttpSecurity http) {
    return http
        .csrf(ServerHttpSecurity.CsrfSpec::disable)
        .authorizeExchange(ex -> ex
            .pathMatchers("/actuator/health", "/actuator/info").permitAll()
            .pathMatchers("/api/public/**").permitAll()
            .anyExchange().authenticated())
        .oauth2ResourceServer(oauth2 -> oauth2.jwt(Customizer.withDefaults()))
        .build();
}
```

**Token relay to downstream services:**

```yaml
spring:
  cloud:
    gateway:
      default-filters:
        - TokenRelay=
```

Gateway forwards the incoming Bearer token to downstream `lb://` calls. Downstream services must also validate — defense in depth, not trust-the-network.

**Feign OAuth2 client credentials:**

```java
@Bean
RequestInterceptor oauth2FeignRequestInterceptor(OAuth2AuthorizedClientManager manager) {
    return template -> {
        OAuth2AuthorizeRequest request = OAuth2AuthorizeRequest
            .withClientRegistrationId("inventory-client")
            .principal("feign-client")
            .build();
        OAuth2AuthorizedClient client = manager.authorize(request);
        template.header("Authorization", "Bearer " + client.getAccessToken().getTokenValue());
    };
}
```

### Config Server security

```yaml
spring:
  security:
    user:
      name: ${CONFIG_USER}
      password: ${CONFIG_PASSWORD}
```

```yaml
# client
spring:
  cloud:
    config:
      username: ${CONFIG_USER}
      password: ${CONFIG_PASSWORD}
```

Never expose `/encrypt`, `/decrypt`, `/env` without authentication. Use TLS between client and Config Server.

### Vault for secrets

For rotatable secrets, prefer Vault over encrypted git:

```yaml
spring:
  config:
    import: vault://
  cloud:
    vault:
      uri: https://vault.example.com
      authentication: KUBERNETES
      kubernetes:
        role: order-service
      kv:
        enabled: true
        backend: secret
        default-context: order-service
```

Vault properties integrate as a property source — same precedence rules as section 15.

### mTLS between services

For zero-trust internal communication:

```yaml
server:
  ssl:
    enabled: true
    key-store: classpath:keystore.p12
    key-store-password: ${KEYSTORE_PASSWORD}
    trust-store: classpath:truststore.p12
    trust-store-password: ${TRUSTSTORE_PASSWORD}
    client-auth: need
```

Feign / RestTemplate need matching SSL context beans. In Kubernetes, service mesh sidecars often handle mTLS transparently (section 17).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Gateway validates JWT but downstream does not | Compromised internal traffic accepted by services |
| Token relay with expired token | Downstream 401; no token refresh at gateway |
| Config Server credentials in git | Credential leak; use env vars or K8s Secret |
| CORS `*` with credentials | Browser blocks; security false sense |
| Actuator endpoints public on internet | Full env dump, heap dump, shutdown |

---

## 17. Service Mesh vs Spring Cloud

### What each layer solves

```
┌─────────────────────────────────────────────────────────┐
│  Service Mesh (Istio/Linkerd)                           │
│  mTLS, L7 routing, retries, telemetry at sidecar level  │
├─────────────────────────────────────────────────────────┤
│  Spring Cloud Gateway                                    │
│  Edge routing, auth, rate limiting, API aggregation     │
├─────────────────────────────────────────────────────────┤
│  Spring Cloud (Feign, LB, Circuit Breaker, Config)      │
│  Application-level patterns, business-aware fallbacks   │
├─────────────────────────────────────────────────────────┤
│  Spring Boot services                                    │
└─────────────────────────────────────────────────────────┘
```

| Concern | Spring Cloud | Service Mesh |
|---|---|---|
| Client-side load balancing | LoadBalancer (section 6) | Sidecar proxy (Envoy) |
| Circuit breaking | Resilience4j (section 9) | Outlier detection / circuit breaking in Envoy |
| Retries | Feign / Resilience4j / Gateway | VirtualService retry policies |
| mTLS | Manual or Boot SSL config | Automatic sidecar mTLS |
| Distributed tracing | Micrometer Tracing (section 10) | Mesh-generated spans + app spans |
| Config / secrets | Config Server / Vault / K8s | K8s ConfigMap/Secret (no app library) |
| Rate limiting | Gateway Redis limiter | Envoy rate limit service |
| Traffic splitting (canary) | Custom LoadBalancer weights | VirtualService weight / Flagger |

### When to use both

Most mature K8s deployments use **Gateway + mesh**:
- **Gateway** handles edge auth, CORS, API versioning, public routing.
- **Mesh** handles east-west mTLS, fine-grained retries, and observability without code changes.
- **Spring Cloud** handles business logic resilience (fallbacks, bulkheads) that a sidecar cannot express.

### When to drop Spring Cloud components

| Component | Drop when... |
|---|---|
| Eureka | Running on Kubernetes with native service discovery (section 5) |
| Config Server | ConfigMaps + Secrets + External Secrets Operator suffice |
| LoadBalancer | Mesh handles routing; use plain `http://service.namespace.svc.cluster.local` |
| Sleuth (already dead) | Mesh + Micrometer Tracing cover propagation |

Keep **Resilience4j** even with a mesh — sidecar circuit breaking is connection-level; it does not know your fallback business logic.

### Double retry / double CB problem

If both mesh and Spring Cloud apply retries:

```
Client → Gateway (retry 3x) → Mesh sidecar (retry 3x) → Service (Resilience4j retry 3x)
= up to 27 attempts
```

Pick **one layer** for retries. Convention: mesh handles transient network failures (1–2 retries); application handles business fallbacks. Disable others:

```yaml
# Istio VirtualService — disable retries for this route
spec:
  http:
    - route:
        - destination:
            host: inventory-service
      retries:
        attempts: 0
```

---

## 18. Observability & Actuator in Cloud Deployment

### Essential actuator endpoints

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus,env,configprops,refresh,gateway,circuitbreakers,bindings
  endpoint:
    health:
      show-details: when_authorized
      probes:
        enabled: true
      group:
        liveness:
          include: livenessState,diskSpace
        readiness:
          include: readinessState,db,binders,circuitBreakers
  metrics:
    tags:
      application: ${spring.application.name}
      environment: ${ENVIRONMENT:local}
    distribution:
      percentiles-histogram:
        http.server.requests: true
      slo:
        http.server.requests: 100ms,500ms,1s,5s
  prometheus:
    metrics:
      export:
        enabled: true
  tracing:
    sampling:
      probability: 0.1
```

### Kubernetes probe configuration

```yaml
# deployment.yaml
livenessProbe:
  httpGet:
    path: /actuator/health/liveness
    port: 8081
  initialDelaySeconds: 30
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8081
  initialDelaySeconds: 10
  periodSeconds: 5
```

Separate management port (`management.server.port: 8081`) keeps probes off the public service port and avoids exposing actuator on the ingress.

### Key metrics to alert on

| Metric | Alert condition | Meaning |
|---|---|---|
| `resilience4j_circuitbreaker_state{state="open"}` | > 0 for 2 min | Dependency failing |
| `http_server_requests_seconds_count{status="5xx"}` | Rate > baseline | Service degradation |
| `spring_cloud_gateway_requests_seconds` | p99 > SLA | Gateway or downstream slow |
| `kafka_consumer_lag` | Growing | Consumer cannot keep up |
| `jvm_memory_used_bytes{area="heap"}` | > 85% sustained | Memory pressure / leak |
| `disk_free_bytes` | < 10% | Log volume or temp files |
| `config_client_version` | Mixed versions across pods | Config drift (section 2) |

### Grafana dashboard structure

One row per concern:
1. **RED** — Rate, Errors, Duration per service
2. **Circuit breakers** — state timeline per dependency
3. **Gateway** — route-level request rate and latency
4. **JVM** — heap, GC, threads
5. **Infrastructure** — CPU, memory, pod restarts

### Log correlation

```xml
<!-- logback-spring.xml -->
<pattern>%d{ISO8601} [%thread] %-5level [%X{traceId:-},%X{spanId:-}] %logger{36} - %msg%n</pattern>
```

Ship logs to ELK/Loki with `traceId` indexed. Jump from metric spike → trace → logs via shared `traceId`.

---

## 19. Production Debugging Playbook

Systematic triage for Spring Cloud incidents. Run top to bottom; stop when you find the root cause.

### Step 1: Is it one service or the platform?

```bash
# All services down?
kubectl get pods -n production
curl -s http://eureka:8761/eureka/apps | xmllint --format - | grep -E '<status>|UP|DOWN'

# Single service?
kubectl logs deployment/order-service --tail=100
curl -s http://order-service:8081/actuator/health | jq
```

| Pattern | Likely layer |
|---|---|
| All services failing same dependency | Config Server, Eureka, Kafka, or shared DB |
| Single service 503 | That service's pods, circuit breaker, or its dependency |
| Gateway 504 only | Gateway timeout or downstream slowness |
| Intermittent failures | LB cache stale instances, retry storm, or circuit flapping |

### Step 2: Config drift check

```bash
# What config does the server serve?
curl -s http://config-server:8888/order-service/prod/main | jq '.propertySources[].name'

# What did the client actually get?
curl -s http://order-service:8081/actuator/env | jq '.propertySources[].name'
curl -s http://order-service:8081/actuator/info | jq '.config'
```

Compare `config.client.version` across pods:

```bash
kubectl exec -it order-service-abc -- curl -s localhost:8081/actuator/info | jq '.config.version'
kubectl exec -it order-service-def -- curl -s localhost:8081/actuator/info | jq '.config.version'
```

Mismatch → config drift (section 2, 15).

### Step 3: Discovery and load balancing

```bash
# Registry view
curl -s http://eureka:8761/eureka/apps/INVENTORY-SERVICE | grep -E 'hostName|status|port'

# Client-side view
curl -s http://order-service:8081/internal/lb/inventory-service   # if debug endpoint exists (section 6)
```

`UnknownHostException` → missing `@LoadBalanced` or `@FeignClient` name mismatch.
`No instances available` → registry empty, health-check supplier filtering all instances, or wrong zone.

### Step 4: Trace the request

1. Get `traceId` from gateway access log or response header.
2. Search Zipkin/Jaeger: `traceId=abc123`.
3. Find the span that failed — note service, duration, error tag.
4. Pull logs for that service filtered by `traceId`.

Broken trace (missing spans) → propagation mismatch (section 10).

### Step 5: Circuit breaker state

```bash
curl -s http://order-service:8081/actuator/circuitbreakers | jq
curl -s http://order-service:8081/actuator/metrics/resilience4j.circuitbreaker.state?tag=name:inventory
```

OPEN → check downstream health. HALF_OPEN flapping → tune thresholds (section 9).

### Step 6: Message pipeline

```bash
curl -s http://order-service:8081/actuator/bindings | jq '.contexts.application.bindings'
kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group order-service
```

Growing lag + `failed` binding state → consumer crash loop or poison message. Check DLQ topic.

### Step 7: Recent changes

```bash
git log --oneline -5 config-repo/
kubectl rollout history deployment/order-service
```

Correlate deploy time with incident start. Rollback if needed:

```bash
kubectl rollout undo deployment/order-service
```

### Quick reference card

| Symptom | First check | Section |
|---|---|---|
| Wrong config value | `/actuator/env/{key}` source chain | 15 |
| Config not updating | `/actuator/refresh` + `@RefreshScope` | 3 |
| UnknownHostException | `@LoadBalanced` / Feign name | 6, 7 |
| 504 from gateway | Gateway `response-timeout` + downstream p99 | 8 |
| CallNotPermittedException | `/actuator/circuitbreakers` | 9 |
| Broken distributed trace | Propagation type alignment | 10 |
| Messages not consumed | `/actuator/bindings` state | 11 |
| 401 between services | Token relay / OAuth2 config | 16 |

---

## 20. Quick Decision Matrix

| I need to... | Use | Not |
|---|---|---|
| Share config across 50 microservices | Config Server + git repo | Hardcoded YAML in each jar |
| Externalize secrets with rotation | Vault / cloud secret manager | `{cipher}` in git |
| Refresh a `@Value` field at runtime | `@RefreshScope` + `/actuator/refresh` | Restart pod for every flag change |
| Call another service by name | OpenFeign or `@LoadBalanced RestTemplate` | Raw hostname / IP |
| Route external traffic | Spring Cloud Gateway | Zuul (dead) |
| Block servlet-only team from WebFlux | Gateway MVC | Force reactive gateway |
| Stop cascade failures | Resilience4j circuit breaker + bulkhead | Hystrix (dead) |
| Retry failed HTTP calls | One layer: Resilience4j OR LB retry | All three retry mechanisms |
| Trace requests across services | Micrometer Tracing + W3C propagation | Sleuth (dead) |
| Publish domain events | Spring Cloud Stream + Kafka binder | Ad-hoc KafkaTemplate only |
| Verify API compatibility | Spring Cloud Contract or Pact | Manual integration tests only |
| Run on Kubernetes | K8s discovery + ConfigMaps; skip Eureka | Eureka inside K8s (usually) |
| mTLS between all pods | Service mesh | Manual keystore per service |
| Edge authentication | Gateway OAuth2 resource server | Per-service auth with no gateway |
| Canary deployment | Mesh traffic split or weighted LB | Big-bang deploy |
| Debug "works locally, fails in prod" | `/actuator/env` precedence chain | Guess-and-change YAML |

### Version selection (September 2026)

| Starting point | Target |
|---|---|
| Boot 3.4.x | Spring Cloud 2024.0.x (Moorgate) |
| Boot 3.3.x / 3.2.x | Spring Cloud 2023.0.x (Leyton) |
| Boot 3.5.x | Spring Cloud 2025.0.x (Northfields) |
| Boot 2.7.x (legacy) | Spring Cloud 2021.0.x — plan Boot 3 migration |
| Sleuth on classpath | Remove; add Micrometer Tracing immediately |
| Hystrix / Ribbon / Zuul | Remove; see section 14 |

---



















































---


---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. What does the `name` attribute in `@FeignClient` actually resolve to?</summary>

The **serviceId** registered in discovery (Eureka, Consul, or Kubernetes). Spring Cloud LoadBalancer uses it to fetch instances and pick one. It is not a DNS hostname unless you also set `url`.

</details>

<details class="qa-item">
<summary>2. Why should Feign Retryer, LoadBalancer retry, and Resilience4j retry not all be enabled?</summary>

They stack multiplicatively. One failed request can become 3 × 3 × 3 = 27 outbound attempts, saturating a recovering dependency and turning a partial outage into a full one.

</details>

<details class="qa-item">
<summary>3. What does `lb://order-service` mean in a Gateway route?</summary>

"Resolve `order-service` through the LoadBalancer." The gateway's `LoadBalancerClientFilter` replaces the logical name with a concrete host:port from discovery, same as `@LoadBalanced RestTemplate`.

</details>

<details class="qa-item">
<summary>4. Gateway returns 504 but downstream is healthy — first place to look?</summary>

Gateway `spring.cloud.gateway.httpclient.response-timeout`. It is shorter than downstream p99 latency. Increase it above downstream p99 but below the client-facing SLA.

</details>

<details class="qa-item">
<summary>5. Hystrix is on our classpath from a legacy lib. What breaks?</summary>

Nothing immediately — it is in maintenance mode and not integrated with Boot 3 observability. But you get no metrics, no dashboard, and no support. Migrate to Resilience4j (section 9, 14).

</details>

<details class="qa-item">
<summary>6. Sleuth `spring.sleuth.sampler.probability` — what's the Boot 3 equivalent?</summary>

`management.tracing.sampling.probability`. Also replace `spring-cloud-starter-sleuth` with `micrometer-tracing-bridge-brave` (or OTel) plus an exporter.

</details>

<details class="qa-item">
<summary>7. Config Server has the right value but the app uses the wrong one. Why?</summary>

An environment variable outranks imported config in Boot 3. Check `/actuator/env/{key}` — if `systemEnvironment` is the winning source, remove the env var (section 15).

</details>

<details class="qa-item">
<summary>8. `@RefreshScope` bean still has the old value after `/actuator/refresh`. Why?</summary>

Either the property key did not change (empty refresh response), the bean is not proxied (self-invocation bypasses proxy), or the value was captured in a non-refreshable singleton at startup.

</details>

<details class="qa-item">
<summary>9. Every pod receives every Kafka message — what is missing?</summary>

Consumer `group` on the Stream binding. Without a group, Spring Cloud Stream creates an anonymous pub/sub consumer per instance.

</details>

<details class="qa-item">
<summary>10. When should I use Spring Cloud Contract vs Pact?</summary>

SCC when both sides are Spring/Java in one org and you want generated producer tests. Pact when teams are independent or polyglot. Full workflow: `notes/microservices/testing.md`.

</details>

<details class="qa-item">
<summary>11. Do I need Eureka if I run on Kubernetes?</summary>

Usually no. K8s Services provide DNS-based discovery. Use `spring-cloud-starter-kubernetes-client` or plain K8s DNS. Eureka adds operational overhead with little benefit inside K8s (section 5, 17).

</details>

<details class="qa-item">
<summary>12. Service mesh replaces Spring Cloud — true or false?</summary>

Partially. Mesh handles mTLS, L7 routing, and telemetry at the network layer. Spring Cloud still needed for business-aware fallbacks (Resilience4j), Config Server, Gateway edge auth, and `@FeignClient` contracts (section 17).

</details>

<details class="qa-item">
<summary>13. What is `CallNotPermittedException`?</summary>

Resilience4j circuit breaker is **OPEN** — it is rejecting calls to protect the system. Check `/actuator/circuitbreakers` and the downstream dependency health.

</details>

<details class="qa-item">
<summary>14. How do I propagate JWT from gateway to downstream services?</summary>

Add `TokenRelay` to gateway default filters. Downstream services must still validate the token — gateway validation alone is not sufficient (section 16).

</details>

<details class="qa-item">
<summary>15. `UnknownHostException: inventory-service` with Feign — cause?</summary>

Feign uses LoadBalancer internally, so this means either the service is not registered in discovery, the `name` does not match registration, or there are zero healthy instances.

</details>

<details class="qa-item">
<summary>16. What is the difference between Gateway and Gateway MVC?</summary>

Gateway is reactive (WebFlux/Netty) — higher concurrency, non-blocking. Gateway MVC is servlet-based (Tomcat) — blocking, simpler for servlet-only teams. Do not run both in one process (section 8).

</details>

<details class="qa-item">
<summary>17. Why are traces broken at service boundaries after Sleuth migration?</summary>

Propagation format mismatch. Sleuth defaulted to B3; Micrometer defaults to W3C. Use dual propagation (`type: w3c,b3`) during migration (section 10, 14).

</details>

<details class="qa-item">
<summary>18. Where should rate limiting live — gateway or service?</summary>

Both have roles. Gateway rate limiting protects the platform from external traffic spikes. Service-level rate limiting (Resilience4j RateLimiter) protects individual service resources. Edge first, then fine-grained.

</details>

<details class="qa-item">
<summary>19. Actuator `/env` dumps secrets. How to prevent?</summary>

Do not expose `/env` publicly. Use separate management port not reachable from ingress. Sanitize sensitive keys with `management.endpoint.env.keys-to-sanitize`. Require auth for actuator endpoints (section 16, 18).

</details>

<details class="qa-item">
<summary>20. Boot 3.4 + Spring Cloud 2023.0 — will it work?</summary>

The compatibility verifier will likely fail at startup. Use Cloud 2024.0.x (Moorgate) with Boot 3.4.x. Check the Spring Cloud release train compatibility table (section 1, 20).

</details>

<details class="qa-item">
<summary>21. How do I verify LoadBalancer is choosing the right zone?</summary>

Register instances with `eureka.instance.metadata-map.zone`, set `spring.cloud.loadbalancer.configurations: zone-preference`, and metric `lb.choice` by zone tag (section 6).

</details>

<details class="qa-item">
<summary>22. What does `optional:configserver:` in spring.config.import do?</summary>

App boots even if Config Server is unreachable — using local defaults only. Fine for dev; dangerous in production where you want fail-fast (section 2).

</details>

<details class="qa-item">
<summary>23. Can I use @CircuitBreaker on a @FeignClient interface directly?</summary>

Not cleanly. Put `@CircuitBreaker` on the service method that calls the Feign client, or use `CircuitBreakerFactory` wrapper / fallback factory (sections 7, 9).

</details>

<details class="qa-item">
<summary>24. Spring Cloud Stream `function.definition` — what happens if the name is wrong?</summary>

The binding is never created. The app may start without error but no messages are consumed or produced. Always verify with `/actuator/bindings` (section 11).

</details>

<details class="qa-item">
<summary>25. What is the production debugging first step for a 503 on one endpoint?</summary>

Check `/actuator/health`, then `/actuator/circuitbreakers`, then registry instance count, then trace the request (section 19). Do not restart blindly.

</details>
