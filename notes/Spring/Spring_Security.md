# Spring Security Mastery — Senior Production Reference

Spring Security 6.x / Spring Boot 3.x. Servlet stack is the default path; reactive differences are called out explicitly. This is not a getting-started guide. It is the map of what actually breaks in production after ~10 years of shipping backends.

---

## Table of Contents

1. [Mental Model: One Request Through the Stack](#1-mental-model-one-request-through-the-stack)
2. [Filter Chain Architecture](#2-filter-chain-architecture)
3. [SecurityFilterChain](#3-securityfilterchain)
4. [AuthenticationManager / ProviderManager](#4-authenticationmanager-providermanager)
5. [UserDetailsService](#5-userdetailsservice)
6. [Password Encoding](#6-password-encoding)
7. [Session Management](#7-session-management)
8. [CSRF](#8-csrf)
9. [CORS](#9-cors)
10. [Method Security](#10-method-security)
11. [OAuth2 / OIDC — Client and Resource Server](#11-oauth2-oidc-client-and-resource-server)
12. [JWT-Based Authentication](#12-jwt-based-authentication)
13. [SAML 2.0 Basics](#13-saml-20-basics)
14. [Multi-Factor Authentication](#14-multi-factor-authentication)
15. [Access Control Lists (ACL)](#15-access-control-lists-acl)
16. [Custom Filters](#16-custom-filters)
17. [Exception Handling](#17-exception-handling)
18. [Security Context Propagation](#18-security-context-propagation)
19. [Testing Security Configurations](#19-testing-security-configurations)
20. [Spring Security 6.x Changes](#20-spring-security-6x-changes)
21. [Production Debugging Playbook](#21-production-debugging-playbook)
22. [Quick Decision Matrix](#22-quick-decision-matrix)

---





## 1. Mental Model: One Request Through the Stack

Spring Security is not a library you "turn on." It is a **servlet `Filter`** (`DelegatingFilterProxy` named `springSecurityFilterChain`) that sits in front of the DispatcherServlet, plus an optional **AOP layer** for method security. Everything else — login forms, JWT, OAuth2, CSRF, sessions — is a filter, an `AuthenticationProvider`, or an `AuthorizationManager` plugged into that pipeline.

```
HTTP request
  └─ Servlet container filter chain
       └─ DelegatingFilterProxy("springSecurityFilterChain")
            └─ FilterChainProxy
                 ├─ HttpFirewall (reject malformed URIs)
                 ├─ pick SecurityFilterChain by RequestMatcher (first match wins)
                 └─ that chain's ordered List<Filter>
                      ├─ SecurityContextHolderFilter      restore/clear context
                      ├─ CorsFilter / CsrfFilter
                      ├─ LogoutFilter
                      ├─ Authentication filters (form, basic, bearer, SAML, OAuth2)
                      ├─ AnonymousAuthenticationFilter    if still unauthenticated
                      ├─ SessionManagementFilter
                      ├─ ExceptionTranslationFilter       catch authz failures
                      └─ AuthorizationFilter              HTTP authorization
                           └─ DispatcherServlet → controllers
                                └─ method-security advisor (AOP) if enabled
```

Three objects you must keep distinct:

| Object | Question it answers | Typical 6.x type |
|---|---|---|
| `Authentication` | Who is this? | `UsernamePasswordAuthenticationToken`, `JwtAuthenticationToken`, `OAuth2AuthenticationToken` |
| `SecurityContext` | Where is that `Authentication` stored for this request? | Held by `SecurityContextHolder` (ThreadLocal by default) |
| `Authorization` | May this principal do this? | `AuthorizationManager` / `AuthorizationFilter` / method interceptor |

A 401 means **no valid Authentication** (or the entry point decided the client must authenticate). A 403 means **there is an Authentication** (including anonymous) that failed an authorization check. Mixing those two up is the single most common senior misdiagnosis.

---

## 2. Filter Chain Architecture

### Core concept

The servlet container sees **one** filter: `DelegatingFilterProxy`. That proxy looks up a Spring bean named `springSecurityFilterChain`, which is a `FilterChainProxy`. `FilterChainProxy` owns **N** `SecurityFilterChain` instances and, per request, selects **one** of them. That selected chain is a virtual filter list — those filters are **not** registered individually with the servlet container.

This is why adding a `@Component` that implements `Filter` does **not** insert it into Spring Security's chain. It lands in the container chain, usually in the wrong place, often **after** security has already authorized (or rejected) the request.

### Internal working

1. Boot auto-config registers `DelegatingFilterProxyRegistrationBean` for `springSecurityFilterChain` with `targetBeanName = "springSecurityFilterChain"`.
2. `FilterChainProxy.doFilter()` wraps the request with `HttpFirewall.getFirewalledRequest()` (`StrictHttpFirewall` by default). Semicolons, `//`, `%2e%2e`, encoded slashes, etc. are rejected here — **before** any of your matchers run. That is why a "perfectly valid" encoded path 400s with `RequestRejectedException`.
3. `FilterChainProxy` iterates `securityFilterChains` in `@Order`. First `chain.matches(request) == true` wins. Remaining chains are ignored for that request.
4. It then runs `chain.getFilters()` via `VirtualFilterChain` — a nested `doFilter` walk, **not** the container's chain.
5. After the security chain returns, `FilterChainProxy` continues the **container** chain (DispatcherServlet).
6. `OncePerRequestFilter` (almost every Spring Security filter extends it) records a request attribute so the same filter does not run twice on FORWARD/INCLUDE/ERROR/ASYNC unless configured to. In 6.x, error-dispatch behavior changed; see [Custom Filters](#16-custom-filters) and [6.x](#20-spring-security-6x-changes).

Default filter order is defined by `FilterOrderRegistration` / `SecurityFilterChain` builder insertion points. Approximate 6.x order inside a typical `HttpSecurity` chain:

| Relative position | Filter | Job |
|---|---|---|
| Very first | `DisableEncodeUrlFilter` | Stop `HttpServletResponse.encodeURL` from leaking `;jsessionid=` |
| Early | `SecurityContextHolderFilter` | Load context (if a repository is configured), always clear in `finally` |
| Early | `HeaderWriterFilter` | Security headers (`X-Content-Type-Options`, `X-Frame-Options`, CSP, HSTS) |
| Early | `CorsFilter` | Preflight + CORS headers — **must** be before auth filters |
| Early | `CsrfFilter` | Reject unsafe methods without a valid token |
| Mid | `LogoutFilter` | Must run before login filters so `/logout` is not treated as a login POST |
| Mid | Authn filters | Form, Basic, Bearer, OAuth2, SAML — each tries to authenticate **or** pass through |
| Mid | `AnonymousAuthenticationFilter` | If `SecurityContext` is still empty, plant `AnonymousAuthenticationToken` |
| Mid | `SessionManagementFilter` | Session fixation, concurrency, creation policy |
| Late | `ExceptionTranslationFilter` | Convert `AuthenticationException` / `AccessDeniedException` into HTTP |
| Last | `AuthorizationFilter` | HTTP `authorizeHttpRequests` rules. Replaced `FilterSecurityInterceptor`. |

`AnonymousAuthenticationFilter` is why `authenticated()` rejects a request that "has no login": there **is** an Authentication, it is anonymous, and `authenticated()` fails. `permitAll()` and `anonymous()` care about that distinction; `denyAll()` does not.

### Production scenario: actuator vs API chains, wrong order

**Problem.** A platform team adds JWT resource-server security for `/api/**`. Ops already had a basic-auth chain for `/actuator/**`. After deploy, Prometheus scrapes start getting 401, and a public health check behind the load balancer starts failing. Logs show `BearerTokenAuthenticationFilter` running on `/actuator/health`.

Cause: two `SecurityFilterChain` beans, but the API chain used `anyRequest()` (matches everything) and was `@Order(1)`. First match wins, so the actuator chain never ran.

**Solution.**

```java
@Configuration
@EnableWebSecurity
public class SecurityChainsConfig {

    @Bean
    @Order(1)
    SecurityFilterChain actuatorChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/actuator/**")
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .anyRequest().hasRole("ACTUATOR")
            )
            .httpBasic(Customizer.withDefaults())
            .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(csrf -> csrf.disable()); // actuator is not a browser form
        return http.build();
    }

    @Bean
    @Order(2)
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher("/api/**")
            .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
            .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
            .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .csrf(csrf -> csrf.disable());
        return http.build();
    }

    @Bean
    @Order(3)
    SecurityFilterChain webChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/login", "/css/**", "/error").permitAll()
                .anyRequest().authenticated()
            )
            .formLogin(Customizer.withDefaults());
        return http.build();
    }
}
```

Rules that save incidents:

- `securityMatcher(...)` defines **which requests this chain claims**. Without it, the chain claims **everything**.
- Most specific chains first (`@Order` lower number = higher precedence).
- Never put `anyRequest()` matchers on an early chain unless that chain is intentionally the catch-all.
- A request is processed by **exactly one** `SecurityFilterChain`. Method security still applies afterward if the request reaches a secured bean.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Component` custom `Filter` instead of `http.addFilter*` | Filter runs in container order; JWT parsed after authorization, or CORS headers missing on 401 |
| Two chains, neither uses `securityMatcher` | Both claim `anyRequest`; only `@Order` first chain ever runs |
| `http.securityMatcher("/api/**")` but controller is `/api/v1/...` behind a gateway that strips `/api` | All API calls fall through to the web/form chain → unexpected 302 to `/login` |
| Relaxed `HttpFirewall` copy-pasted from a Stack Overflow post | Path-traversal / semicolon cache-poisoning vectors reopened |
| `FilterRegistrationBean.setEnabled(false)` missing for a filter that is also a Spring bean | Filter executes **twice** (container + security chain) |

### Debugging scenario

**Observe.** Request to `/api/orders` returns 302 to `/login` even though you "enabled JWT."

**Diagnose.**

```http
# Hit a debug-friendly endpoint and read WWW-Authenticate / Location
GET /api/orders HTTP/1.1
Authorization: Bearer eyJ...
```

Enable:

```yaml
logging:
  level:
    org.springframework.security: TRACE
    org.springframework.security.web.FilterChainProxy: DEBUG
```

Look for: `Securing GET /api/orders` then `Set SecurityContextHolder to ...` then which chain: `Checking match of request : '/api/orders'; against '/actuator/**'`. If you see `UsernamePasswordAuthenticationFilter` and a `SavedRequest`, the request landed on the **form-login** chain.

Temporary in-process dump (never leave this on in prod):

```java
@Bean
ApplicationListener<WebSourceAuthenticationFailureEvent> authFailLogger() {
    return event -> log.warn("auth fail: {}", event.getException().toString());
}
```

Better: set a breakpoint in `FilterChainProxy.getFilters(HttpServletRequest)` and inspect which chain matched.

**Fix.** Give the JWT chain `securityMatcher("/api/**")` and `@Order` ahead of the form-login chain. Confirm TRACE shows `BearerTokenAuthenticationFilter` and `AuthorizationFilter` only — no `UsernamePasswordAuthenticationFilter`.

---

## 3. SecurityFilterChain

### Core concept

`SecurityFilterChain` is the built object: a `RequestMatcher` plus an ordered `List<Filter>`. You almost never construct it by hand. You configure `HttpSecurity` (a builder with many `*Configurer`s) and call `http.build()`, which:

1. applies each configurer (`CsrfConfigurer`, `AuthorizeHttpRequestsConfigurer`, …)
2. sorts filters
3. returns a `DefaultSecurityFilterChain`

`authorizeHttpRequests` is **HTTP-level** authorization. It is evaluated in `AuthorizationFilter` **before** the controller runs. It does not see method-security annotations. Both can apply; HTTP runs first.

### Internal working

`AuthorizeHttpRequestsConfigurer` collects `RequestMatcher` → `AuthorizationManager<RequestAuthorizationContext>` mappings. At request time `AuthorizationFilter` calls `AuthorizationManager.authorize(supplierAuthentication, request)`.

Important 6.x semantics:

- `requestMatchers("/admin/**").hasRole("ADMIN")` — `hasRole` prepends `ROLE_` unless you customized `GrantedAuthorityDefaults`.
- `hasAuthority("ADMIN")` does **not** prepend `ROLE_`. Mixing `hasRole("ADMIN")` with authorities stored as `ADMIN` (no prefix) is a silent 403 factory.
- `authenticated()` rejects anonymous; `permitAll()` does not even look at Authentication; `denyAll()` always denies (and still goes through `ExceptionTranslationFilter`).
- Matchers are evaluated **in declaration order**. First match wins, same as MVC. `anyRequest()` must be last inside a chain.
- `requestMatchers(HttpMethod.GET, "/api/public/**")` is not the same as `requestMatchers("/api/public/**")` — the latter matches POST too.

`HttpSecurity` is **request-scoped as a builder but the built chain is a singleton**. Do not call `http.authorizeHttpRequests(...)` in a request thread. Do not inject `HttpSecurity` into a prototype bean and rebuild.

### Production scenario: "public" API still requires auth

**Problem.** Product wants `GET /api/catalog/**` public, everything else authenticated. Config looks correct. Mobile app still gets 401 on `GET /api/catalog/items`. TRACE shows `AuthorizationFilter` denying.

Cause: a **more general matcher declared first**:

```java
// WRONG — first match wins
.authorizeHttpRequests(auth -> auth
    .requestMatchers("/api/**").authenticated()
    .requestMatchers("/api/catalog/**").permitAll() // dead code
    .anyRequest().authenticated()
)
```

**Solution.**

```java
@Bean
SecurityFilterChain api(HttpSecurity http) throws Exception {
    http
        .securityMatcher("/api/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.GET, "/api/catalog/**").permitAll()
            .requestMatchers("/api/internal/**").hasAuthority("SCOPE_internal")
            .anyRequest().authenticated()
        )
        .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
        .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(AbstractHttpConfigurer::disable);
    return http.build();
}
```

If a gateway strips the `/api` prefix, `securityMatcher("/api/**")` never matches. Match on what the **app** actually sees (`/catalog/**`), or stop stripping.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `hasRole("ROLE_ADMIN")` | Looks for `ROLE_ROLE_ADMIN` → 403 for every admin |
| `mvcMatchers` leftover from 5.x XML/Java mix | Compile error on 6.x; or worse, `antMatchers` surviving on Boot 2 and behaving differently than MVC matching |
| `permitAll()` on `/error` missing | Failed auth → forward to `/error` → `/error` secured → infinite 401/500 |
| Authorizing on `DispatcherType.ERROR` without intending to | Custom 403 JSON never rendered; client sees empty 403 |
| `csrf.disable()` + cookie sessions for a browser app | Classic CSRF on state-changing cookie-authenticated endpoints |
| `authorizeHttpRequests` used, but also `http.authorizeRequests()` (deprecated adapter leftover) | Duplicate/conflicting rules; one silently ignored depending on version |

### Debugging scenario

**Observe.** `POST /api/orders` is 401, `GET /api/orders` is 200 with the same Bearer token.

**Diagnose.** You likely authorized `GET` only:

```java
.requestMatchers(HttpMethod.GET, "/api/orders/**").authenticated()
.anyRequest().denyAll() // or authenticated() behind a matcher that doesn't include POST
```

Or CSRF is still on for the API chain (`POST` dies in `CsrfFilter` **before** JWT is considered a "session" — actually CSRF runs whether or not you have a session; a 403 with `Invalid CSRF token` in TRACE is the tell). CSRF failures are **403**, not 401 — if you truly see 401, look at `BearerTokenAuthenticationFilter` (malformed/expired JWT) or a matcher that never called `oauth2ResourceServer`.

**Fix.** Authorize the methods you actually serve; disable CSRF on token-authenticated API chains; log `CsrfFilter` vs `AuthorizationFilter` from TRACE to see which one rejected.

---

## 4. AuthenticationManager / ProviderManager

### Core concept

`AuthenticationManager` is a strategy: take an `Authentication` (often unauthenticated, `authenticated=false`, credentials still present) and return an **authenticated** `Authentication` (credentials usually cleared, authorities populated) or throw `AuthenticationException`.

The only implementation you will see in production is `ProviderManager`: a list of `AuthenticationProvider` plus an optional **parent** `AuthenticationManager`.

```
ProviderManager.authenticate(authentication)
  for provider in providers:
      if provider.supports(authentication.getClass()):
          try result = provider.authenticate(authentication)
          if result != null: return result          // authenticated or still null-skip
          // null means "I support the type but I'm abstaining"
      catch AccountStatusException: rethrow         // locked/disabled — do not try others
      catch AuthenticationException: save and continue
  if parent != null: return parent.authenticate(...)
  if lastException != null: throw lastException
  else throw ProviderNotFoundException
```

A provider returning `null` is **not** a failure. A provider throwing `BadCredentialsException` **is**. `ProviderManager` continues after `BadCredentialsException` so a later provider might succeed (e.g. LDAP after DAO). `AccountStatusException` short-circuits — a locked user must not fall through to another source that might still accept the password.

### Internal working

`DaoAuthenticationProvider` (form/basic username-password):

1. `retrieveUser(username, token)` → `UserDetailsService.loadUserByUsername`
2. If user not found: by default `hideUserNotFoundExceptions=true`, so it throws `BadCredentialsException`, **not** `UsernameNotFoundException` (user enumeration hardening)
3. `additionalAuthenticationChecks` → `PasswordEncoder.matches(presented, stored)`
4. `preAuthenticationChecks` / `postAuthenticationChecks` → expired, locked, credentials expired, disabled
5. Creates a new `UsernamePasswordAuthenticationToken(userDetails, null, authorities)` — credentials erased

`AuthenticationConfiguration.getAuthenticationManager()` is how Boot exposes the global manager. Building a **local** `AuthenticationManager` per `HttpSecurity` (via `http.authenticationManager(...)` or `http.userDetailsService(...)`) is a different instance. This is the #1 cause of "my custom `AuthenticationProvider` `@Bean` is ignored": you registered it globally, but that chain built a local manager that does not include it.

In 6.x the recommended pattern is: expose `AuthenticationManager` as a `@Bean` **or** add providers via `AuthenticationManagerBuilder` **once**, and inject that bean into `HttpSecurity`. Avoid mixing `http.userDetailsService()`, a custom `DaoAuthenticationProvider` `@Bean`, and `AuthenticationConfiguration.getAuthenticationManager()` in the same config — you will get either a circular dependency at startup or two managers.

`ProviderManager.setEraseCredentialsAfterAuthentication(true)` (default) nulls credentials on the **result**. The original object is not what gets stored. If a custom filter keeps a reference to the **input** token and reads `getCredentials()` later, it is still populated; if it reads from `SecurityContext`, credentials are gone. That is intentional.

### Production scenario: circular dependency exposing AuthenticationManager

**Problem.** After migrating off `WebSecurityConfigurerAdapter`, startup fails:

```
The dependencies of some of the beans in the application context form a cycle:
┌─────┐
|  securityFilterChain defined in SecurityConfig
↑     ↓
|  authenticationManager defined in SecurityConfig
└─────┘
```

Typical broken 5.7 "migration snippet":

```java
@Bean
public AuthenticationManager authenticationManager(HttpSecurity http) throws Exception {
    return http.getSharedObject(AuthenticationManagerBuilder.class).build();
}

@Bean
public SecurityFilterChain chain(HttpSecurity http, AuthenticationManager am) throws Exception {
    http.authenticationManager(am);
    return http.build();
}
```

`HttpSecurity` is created by `HttpSecurityConfiguration`, which already asks for `AuthenticationConfiguration.getAuthenticationManager()`. You just closed a loop.

**Solution — expose providers, let Boot build the manager:**

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    UserDetailsService userDetailsService(UserRepository users) {
        return new JpaUserDetailsService(users);
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }

    @Bean
    AuthenticationProvider ldapFallback(LdapContextSource ctx) {
        LdapAuthenticationProvider provider = /* build */;
        return provider;
    }

    @Bean
    SecurityFilterChain app(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .formLogin(Customizer.withDefaults());
        // DaoAuthenticationProvider is auto-wired from UserDetailsService + PasswordEncoder
        // ldapFallback @Bean is picked up by InitializeUserDetailsBeanManagerConfigurer / AuthenticationConfiguration
        return http.build();
    }
}
```

If you **must** construct the manager yourself (custom `AuthenticationProvider` that is not a bean, or you need a parent):

```java
@Bean
AuthenticationManager authenticationManager(
        UserDetailsService uds,
        PasswordEncoder encoder,
        AuthenticationProvider ldapFallback) {
    DaoAuthenticationProvider dao = new DaoAuthenticationProvider(uds);
    dao.setPasswordEncoder(encoder);
    return new ProviderManager(List.of(dao, ldapFallback));
}

@Bean
SecurityFilterChain app(HttpSecurity http, AuthenticationManager authenticationManager) throws Exception {
    http.authenticationManager(authenticationManager);
    // ...
    return http.build();
}
```

Do **not** take `HttpSecurity` as a parameter to the `AuthenticationManager` `@Bean`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Custom `AuthenticationProvider` `@Bean` + `http.userDetailsService()` on that chain | Local manager wins; LDAP/custom provider never called |
| Provider `supports()` returns true for a superclass but `authenticate()` assumes a subclass | `ClassCastException` inside authenticate, wrapped as 500 instead of 401 |
| Parent `AuthenticationManager` pointing at itself | Infinite recursion, stack overflow on login |
| `hideUserNotFoundExceptions=false` in prod | Different error messages / timings for unknown user vs bad password |
| Forgetting `AuthenticationProvider.supports()` | `ProviderNotFoundException: No AuthenticationProvider found for ...` on a token type you thought you handled |
| Publishing `AuthenticationManager` `@Bean` **and** calling `http.authenticationProvider()` with a different instance | Two providers of the same type; confusing double `UserDetailsService` hits |

### Debugging scenario

**Observe.** Login with a valid LDAP user fails with `BadCredentialsException`. DB users work. `LdapAuthenticationProvider` is a `@Bean`.

**Diagnose.** Put a breakpoint in `ProviderManager.authenticate` and inspect `this.providers`. If you only see `DaoAuthenticationProvider` and `AnonymousAuthenticationProvider`, the LDAP bean is not in **this** manager.

Also check exception type: if `DaoAuthenticationProvider` runs first, supports `UsernamePasswordAuthenticationToken` (it does), and throws `BadCredentialsException` because the user is not in the DB, `ProviderManager` **continues** to LDAP — unless someone set `eraseCredentialsAfterAuthentication` and a buggy provider consumed the password, or the DAO provider is configured as parent and the child already threw `AccountStatusException`.

If TRACE shows only one provider, your chain built a local manager. Inject and set the global `AuthenticationManager` explicitly as in the solution above.

**Fix.** Single `ProviderManager` with DAO then LDAP. Confirm `supports(UsernamePasswordAuthenticationToken.class)` is true for both. Keep `hideUserNotFoundExceptions=true`. Do not log passwords.

---

## 5. UserDetailsService

### Core concept

`UserDetailsService` is a **user lookup**, not an authenticator. Its contract is: given a username, return a `UserDetails` or throw `UsernameNotFoundException`. It must **not** check passwords. Password checking is `PasswordEncoder` inside `DaoAuthenticationProvider`.

`UserDetails` is the contract the rest of the framework understands: username, password hash, authorities, and four boolean flags (`accountNonExpired`, `accountNonLocked`, `credentialsNonExpired`, `enabled`).

`UserDetailsManager` extends it with create/update/delete (InMemory, JDBC). Production apps almost always implement only `UserDetailsService` against their account table.

### Internal working

`DaoAuthenticationProvider.retrieveUser`:

- Calls `loadUserByUsername`.
- **Returning `null` is a bug.** The contract says throw `UsernameNotFoundException`. A null return becomes `InternalAuthenticationServiceException` (500), not a clean 401.
- `CachingUserDetailsService` (used by some remember-me / namespace leftovers) caches `UserDetails` including the **password hash**. A password change will not take effect until cache expiry. Prefer Spring Cache with an explicit eviction on password change, or don't cache here.

Authorities: `UserDetails.getAuthorities()` is snapshotted onto the `Authentication` at login. Changing a user's role in the DB does **not** update existing sessions. You must expire those sessions (`SessionRegistry`) or force re-auth. For JWTs, you must issue a new token; the old one keeps old claims until expiry (or revocation).

A custom `UserDetails` implementation that adds `tenantId`, `orgId`, `passwordChangedAt` is the right extension point. Do **not** stuff tenant into `GrantedAuthority` unless it really is an authority.

`User.withUsername(...).password(...).roles("ADMIN")` adds `ROLE_ADMIN`. `authorities("ADMIN")` does not. Pick one convention and use it in both `UserDetailsService` and `hasRole`/`hasAuthority`.

### Production scenario: tenant user lookup on a shared username space

**Problem.** SaaS app: emails are unique **per tenant**, not globally. `loadUserByUsername("ada@x.com")` returns the first match. Users in tenant B can be authenticated as tenant A's row if the password happens to match (it usually won't) — or more commonly, the **wrong user's hash** is used and login randomly fails. Worse: a custom filter puts `X-Tenant-Id` on the request, but `UserDetailsService` has no access to it because `DaoAuthenticationProvider` only passes the username.

**Solution.** Do not use vanilla `DaoAuthenticationProvider` for this. Carry tenant in a custom `Authentication` token and a custom provider.

```java
public final class TenantUsernamePasswordToken extends UsernamePasswordAuthenticationToken {
    private final String tenantId;
    public TenantUsernamePasswordToken(String tenantId, String principal, Object credentials) {
        super(principal, credentials);
        this.tenantId = tenantId;
    }
    public String tenantId() { return tenantId; }
}

public class TenantDaoAuthenticationProvider extends DaoAuthenticationProvider {
    private final TenantUserRepository users;

    public TenantDaoAuthenticationProvider(TenantUserRepository users, PasswordEncoder encoder) {
        super(); // we'll override retrieveUser
        setPasswordEncoder(encoder);
        this.users = users;
        setUserDetailsService(username -> {
            throw new IllegalStateException("use retrieveUser override");
        });
    }

    @Override
    protected UserDetails retrieveUser(String username, UsernamePasswordAuthenticationToken token) {
        String tenantId = (token instanceof TenantUsernamePasswordToken t)
            ? t.tenantId()
            : throwBad();
        return users.findByTenantIdAndEmail(tenantId, username)
            .map(this::toUserDetails)
            .orElseThrow(() -> new UsernameNotFoundException(username));
    }

    private static String throwBad() {
        throw new BadCredentialsException("tenant required");
    }

    private UserDetails toUserDetails(Account a) {
        return User.builder()
            .username(a.getEmail())
            .password(a.getPasswordHash())
            .disabled(!a.isEnabled())
            .accountLocked(a.isLocked())
            .authorities(a.getRoles().stream().map(r -> "ROLE_" + r).toArray(String[]::new))
            .build();
    }
}
```

The login filter must construct `TenantUsernamePasswordToken` from the form field / header / subdomain, **not** a bare `UsernamePasswordAuthenticationToken`. `supports()` should accept `TenantUsernamePasswordToken`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `loadUserByUsername` returns `null` | 500 `InternalAuthenticationServiceException` |
| Loading roles lazily inside `getAuthorities()` after the Hibernate session is closed | `LazyInitializationException` on every request that touches the principal |
| Mutating the `UserDetails` stored in the session | Race conditions; use immutable `UserDetails` |
| Using email as username but login form still posts `username=` from a copied snippet | Always `BadCredentials` |
| `User.withDefaultPasswordEncoder()` anywhere except a test | Hashes with a well-known default; treated as a secret leak |

### Debugging scenario

**Observe.** Intermittent `LazyInitializationException: could not initialize proxy [Role] - no Session` after login, only on pages that render `authentication.authorities`.

**Diagnose.** `UserDetails` holds a JPA entity with lazy `roles`. At login the session is open. After login the entity is stored in the HTTP session (or in `SecurityContext` bound to the servlet thread) and the persistence context is gone.

**Fix.** Map to a detached snapshot in `loadUserByUsername`:

```java
@Override
@Transactional(readOnly = true)
public UserDetails loadUserByUsername(String username) {
    Account a = accounts.findByEmail(username)
        .orElseThrow(() -> new UsernameNotFoundException(username));
    List<GrantedAuthority> auths = a.getRoles().stream()
        .map(Role::getName)
        .map(SimpleGrantedAuthority::new)
        .toList();
    return new User(a.getEmail(), a.getPasswordHash(), a.isEnabled(),
        true, true, !a.isLocked(), auths);
}
```

Never store a managed JPA entity in `SecurityContext`.

---

## 6. Password Encoding

### Core concept

`PasswordEncoder` has two operations: `encode` (hash for storage) and `matches(raw, encoded)` (constant-time compare against the stored form). You **never** "decrypt" a password. You **never** log raw or encoded passwords.

The production default is `DelegatingPasswordEncoder`: stored values look like `{bcrypt}$2a$10$...`. The id in braces selects the encoder used for `matches`. `encode()` uses the **default id** (bcrypt unless you changed it).

### Internal working

```java
PasswordEncoder encoder = PasswordEncoderFactories.createDelegatingPasswordEncoder();
```

This builds a map: `bcrypt`, `pbkdf2`, `scrypt`, `argon2`, `sha256`, plus a few historical ones. `DelegatingPasswordEncoder.matches`:

1. If the stored value has `{id}`, delegate to that encoder.
2. If it has no prefix, use the **default matches encoder** if configured via `setDefaultPasswordEncoderForMatches`, else throw `IllegalArgumentException: There is no PasswordEncoder mapped for the id "null"`.

That `id "null"` error is the classic post-migration production outage: leftover plaintext or `{noop}`-less hashes in the DB after switching to delegating encoder.

`BCryptPasswordEncoder` truncates at 72 bytes. Passwords longer than 72 bytes silently lose entropy. For high-assurance systems use Argon2 (`Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8()`) or hash-then-bcrypt with SHA-384 first (know what you are doing).

`upgradeEncoding` / `DaoAuthenticationProvider.setUserDetailsPasswordService`: after a successful match with a weaker id, Spring can re-hash with the current default and persist. Wire `UserDetailsPasswordService` or a custom success handler if you are migrating `{sha256}` → `{bcrypt}`.

Timing: `matches` is designed to be constant-time **within one encoder**. User enumeration via `loadUserByUsername` still exists if you skip hashing when the user is missing. `DaoAuthenticationProvider` uses a dummy password check on some paths; still, **rate-limit login** and keep `hideUserNotFoundExceptions=true`.

### Production scenario: Boot 3 upgrade, every login throws `id "null"`

**Problem.** After upgrading, login is 100% broken. Stack:

```
java.lang.IllegalArgumentException: There is no PasswordEncoder mapped for the id "null"
    at DelegatingPasswordEncoder$UnmappedIdPasswordEncoder.matches
```

Stored hashes are raw bcrypt (`$2a$10$...`) **without** `{bcrypt}`.

**Solution.** Either migrate data or accept unprefixed bcrypt during matches:

```java
@Bean
PasswordEncoder passwordEncoder() {
    DelegatingPasswordEncoder dpe =
        (DelegatingPasswordEncoder) PasswordEncoderFactories.createDelegatingPasswordEncoder();
    dpe.setDefaultPasswordEncoderForMatches(new BCryptPasswordEncoder());
    return dpe;
}
```

And run a one-off migration so new and old rows converge:

```sql
UPDATE account
SET password_hash = '{bcrypt}' || password_hash
WHERE password_hash LIKE '$2a$%' AND password_hash NOT LIKE '{%';
```

For a mixed estate (`{noop}` test users that escaped into a shared env, SHA-256 leftovers):

```java
@Bean
PasswordEncoder passwordEncoder() {
    Map<String, PasswordEncoder> encoders = new HashMap<>();
    encoders.put("bcrypt", new BCryptPasswordEncoder(12));
    encoders.put("argon2", Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8());
    encoders.put("pbkdf2", Pbkdf2PasswordEncoder.defaultsForSpringSecurity_v5_8());
    // do NOT put noop in production maps
    DelegatingPasswordEncoder dpe = new DelegatingPasswordEncoder("bcrypt", encoders);
    dpe.setDefaultPasswordEncoderForMatches(encoders.get("bcrypt"));
    return dpe;
}
```

Bump BCrypt strength only after measuring login CPU. 10 → 12 is a noticeable hit on a burst of logins; 12 → 14 can take down a small pod under a credential-stuffing attack. Pair with lockout / WAF rate limits.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `new BCryptPasswordEncoder()` in one bean and `createDelegatingPasswordEncoder()` in another | New users stored `{bcrypt}$2a$...` but login uses raw bcrypt encoder against the whole string including `{bcrypt}` → always fail |
| `NoOpPasswordEncoder` in prod | Passwords stored plaintext; PCI/SOC2 finding; credential leak = game over |
| Calling `encode()` on login instead of `matches()` | Hash-of-hash; nobody can log in; DB slowly fills with new hashes if someone "helpfully" writes them back |
| BCrypt cost 16 on a 2-vCPU login service | Login p99 in seconds; thread pool exhaustion looks like a "deadlock" |
| Logging `token.getCredentials()` | Secret in logs/SIEM; rotate every exposed password |

### Debugging scenario

**Observe.** A subset of users cannot log in after a data import from a legacy system. Others work. No `id "null"` exception — just `BadCredentialsException`.

**Diagnose.** Pull **one** failing hash (from a staging copy). If it starts with `$2b$` or `$2y$` vs `$2a$`, `BCryptPasswordEncoder` in older Spring may not accept `$2b$`. If it is hex SHA-1, `DelegatingPasswordEncoder` will not match unless you add a `{sha1}` encoder **and** prefix the rows.

Never debug this by printing the presented password. Compare **lengths and prefixes** of stored hashes, and unit-test `encoder.matches("known-plaintext-from-legacy-test-user", stored)`.

**Fix.** Normalize prefixes in a migration, register the legacy encoder only for `matches`, encode all **new** passwords with bcrypt/argon2, and enable `UserDetailsPasswordService` so a successful legacy match upgrades the stored hash.

---

## 7. Session Management

### Core concept

HTTP session is where Spring stores the `SecurityContext` **by default** (servlet stack). Session policy, fixation protection, concurrency, and cookies are all `SessionManagementConfigurer`.

`SessionCreationPolicy`:

| Policy | Behavior |
|---|---|
| `IF_REQUIRED` (default) | Create a session when Security needs one (successful form login, CSRF token in session, etc.) |
| `ALWAYS` | Create even for anonymous — almost never what you want |
| `NEVER` | Use a session if it already exists; never create |
| `STATELESS` | Do not create or use an HTTP session for SecurityContext; `SecurityContextRepository` is a no-op |

`STATELESS` does **not** magically disable `HttpSession` for the whole app. Your own code, Spring Session, or a CSRF repository that uses the session can still create one. It means **Spring Security will not read/write SecurityContext to the session**.

### Internal working

6.x replaced `SecurityContextPersistenceFilter` with `SecurityContextHolderFilter` + `HttpSessionSecurityContextRepository` (when stateful). Flow:

1. `SecurityContextHolderFilter` calls `securityContextRepository.loadDeferredContext(request)`.
2. Context is deferred (supplier) so anonymous requests do not eagerly create sessions.
3. Authentication filters, on success, call `securityContextRepository.saveContext(...)` via `SecurityContextRepository` / `SessionAuthenticationStrategy`.
4. `finally`: `SecurityContextHolder.clearContext()` — **always**. This is why the context is gone after the request, and why `@Async` without wrapping loses the principal.

Session fixation: default is `changeSessionId()` (Servlet 3.1+). On login, the session id is rotated so an attacker who planted `JSESSIONID` cannot inherit the authenticated session. `migrateSession()` copies attributes to a new session (older). `none()` is for environments where changing the id breaks a gateway that keys affinity on the original cookie — and it is a fixation hole unless something else mitigates it.

Concurrent session control: `sessionRegistry` + `ConcurrentSessionFilter` + `HttpSessionEventPublisher` (this last one is **required** or logouts/timeouts never notify the registry). `maxSessions(1).maxSessionsPreventsLogin(true)` means the second login is rejected; `false` means the first session is expired (default mental model of "kick the other device").

Cookie flags: `HttpOnly` (default for JSESSIONID from the container), `Secure`, `SameSite`. Spring Session and the servlet container split ownership; Boot's `server.servlet.session.cookie.*` is the knob for the container cookie.

### Production scenario: "stateless JWT API" still sets `JSESSIONID`, sticky sessions break

**Problem.** A JWT API sits behind an L7 load balancer without stickiness. After deploy, a fraction of requests lose auth, or you see `JSESSIONID` in responses. Horizontal scale "requires sticky sessions" even though you thought you were stateless. CSRF was disabled. TRACE shows `HttpSessionSecurityContextRepository` saving a context.

Cause: something still created a session — common culprits:

- `SessionCreationPolicy` not set (default `IF_REQUIRED`)
- A custom filter calling `request.getSession(true)`
- Spring Boot Actuator / DevTools
- `RequestCache` saving the original request on 401 (form-login chain leaking into the API chain)
- `CsrfTokenRepository` default (session) on a chain you forgot to disable

**Solution.**

```java
@Bean
SecurityFilterChain api(HttpSecurity http) throws Exception {
    http
        .securityMatcher("/api/**")
        .csrf(AbstractHttpConfigurer::disable)
        .requestCache(cache -> cache.disable())
        .securityContext(sc -> sc.securityContextRepository(new NullSecurityContextRepository()))
        .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
        .authorizeHttpRequests(a -> a.anyRequest().authenticated());
    return http.build();
}
```

And stop the container from issuing a session cookie if **nothing** else needs it:

```yaml
server:
  servlet:
    session:
      tracking-modes: cookie
      cookie:
        http-only: true
        secure: true
        same-site: strict
```

If you still see `JSESSIONID`, grep the app for `getSession(true)`, `httpSession`, `@EnableRedisHttpSession`. Stateless security does not disable Spring Session.

For a **browser** app with Redis-backed sessions (the actual production pattern when you have >1 instance and cookie auth):

```yaml
spring:
  session:
    store-type: redis
    redis:
      namespace: "app:session"
server:
  servlet:
    session:
      timeout: 30m
      cookie:
        name: APPSESSION
        http-only: true
        secure: true
        same-site: lax
```

Register:

```java
@Bean
HttpSessionEventPublisher httpSessionEventPublisher() {
    return new HttpSessionEventPublisher();
}
```

Without `HttpSessionEventPublisher`, concurrent-session control and "logout everywhere" lie to you: `SessionRegistry` never learns about destroyed sessions.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `STATELESS` but form login on the same chain | Login appears to work then immediately 401; no session to store context |
| Concurrent sessions without `HttpSessionEventPublisher` | `maxSessions(1)` never kicks the first device; registry leaks memory |
| Session fixation `none()` behind a poorly configured CDN that caches `Set-Cookie` | Users steal each other's sessions |
| `SameSite=Strict` on a site that returns from a payment IdP | User comes back logged out (cookie not sent on top-level cross-site GET) |
| Session cookie missing `Secure` on a site behind TLS-terminating proxy without forwarding | Cookie sent on http:// internal probes; or Secure never set because the app thinks requests are HTTP |

### Debugging scenario

**Observe.** After login, the next XHR from the SPA is unauthenticated. The login response has `Set-Cookie: JSESSIONID=...; Secure`. The XHR is on `http://localhost:5173` to `http://localhost:8080`.

**Diagnose.** Cross-site (different ports = different origins). `SameSite=Lax` will not send the cookie on cross-site XHR POST. `Secure` cookies are not sent to `http://` origins. CORS `allowCredentials` may also be wrong (see CORS).

This is not a SessionManagementFilter bug. Confirm in the browser Network tab: is the cookie stored under the **API** origin? Is it sent on the XHR? If stored but not sent: SameSite/Secure/Domain. If not stored: `Set-Cookie` rejected (Secure on http, or `Domain=.prod.com` used on localhost).

**Fix.** Dev: `Secure` false, `SameSite=Lax` or `None` with HTTPS, CORS `allowCredentials=true` with explicit origin. Prod SPA: prefer Authorization header (JWT/BFF) over cross-site cookies. If cookies: **BFF same-origin** so SameSite is not cross-site.

---

## 8. CSRF

### Core concept

CSRF is an attack where the browser **automatically attaches cookies** (or uses cached HTTP Basic) to a forged request from another origin. CSRF protection is required when **cookie-based** (or basic) auth is in play. It is **not** what protects you from a stolen JWT in `localStorage` (that's XSS). It is **not** needed when the browser has no credential that it will attach automatically — e.g. `Authorization: Bearer` set by JavaScript on a same-API SPA **if** you do not also use cookies.

Default in Spring Security: CSRF **on**. Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) require a token. `GET`/`HEAD`/`TRACE`/`OPTIONS` are skipped.

### Internal working

`CsrfFilter`:

1. Asks `CsrfTokenRequestHandler` to make the token available as a request attribute (`_csrf`) for the rest of the request (forms, Thymeleaf).
2. For unsafe methods, loads the expected token from `CsrfTokenRepository` and compares with the request (header `X-XSRF-TOKEN` or `X-CSRF-TOKEN`, or param `_csrf`).
3. Mismatch → `AccessDeniedException` → 403 (not 401).

Spring Security 6 **changed two things that broke almost every SPA**:

**Deferred tokens.** The token is not generated until something reads it. A SPA that expects a cookie on the first `GET /api/me` gets **no cookie**, then its `POST` 403s.

**XOR / BREACH protection.** `XorCsrfTokenRequestAttributeHandler` (default) does not put the raw token in the response. The browser must send a **masked** token. A SPA that reads the cookie and echoes it as `X-XSRF-TOKEN` fails the compare because it sent the raw cookie value, not the XOR'd request token. This was deliberate (BREACH: secrets in compressed HTTPS responses).

Repositories:

- `HttpSessionCsrfTokenRepository` — default; token in session
- `CookieCsrfTokenRepository` — cookie `XSRF-TOKEN` (Angular convention). `withHttpOnlyFalse()` is required if JS must read it (double-submit). HttpOnly true = JS cannot read = SPA cannot echo the header.

### Production scenario: SPA 403 on every POST after Boot 3 / Security 6 upgrade

**Problem.** Angular/React app worked on Boot 2.7. After upgrade, login GET works, every mutating call is 403 `Invalid CSRF token`. Cookie `XSRF-TOKEN` is present (after you "fixed" deferred by reading the token). Header matches the cookie. Still 403.

Cause: XOR handler. The cookie holds the **raw** token; the header must hold the **masked** token from the request attribute, **or** you opt out of XOR.

**Solution — SPA + cookie session (double-submit, Boot 3 compatible):**

```java
@Bean
SecurityFilterChain spa(HttpSecurity http) throws Exception {
    CookieCsrfTokenRepository repo = CookieCsrfTokenRepository.withHttpOnlyFalse();
    CsrfTokenRequestAttributeHandler requestHandler = new CsrfTokenRequestAttributeHandler();
    // raw token in header/param — SPA echoes cookie. Disables XOR/BREACH mitigation.
    requestHandler.setCsrfRequestAttributeName("_csrf");

    http
        .csrf(csrf -> csrf
            .csrfTokenRepository(repo)
            .csrfTokenRequestHandler(requestHandler)
        )
        .addFilterAfter(new CsrfCookieFilter(), CsrfFilter.class)
        .authorizeHttpRequests(a -> a
            .requestMatchers("/index.html", "/assets/**", "/login").permitAll()
            .anyRequest().authenticated()
        )
        .formLogin(Customizer.withDefaults());
    return http.build();
}

/** Forces token generation so the cookie is written (defeats deferred CSRF). */
final class CsrfCookieFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        CsrfToken token = (CsrfToken) req.getAttribute(CsrfToken.class.getName());
        if (token != null) {
            token.getToken(); // subscribe / materialize
        }
        chain.doFilter(req, res);
    }
}
```

**Better architecture for a separate-origin SPA:** don't use cookie session + CSRF at all. Use a BFF (same origin) or Bearer tokens. Then:

```java
http.csrf(AbstractHttpConfigurer::disable)
    .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
    .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()));
```

Disabling CSRF on a **cookie-authenticated** browser API is a vulnerability, not a cleanup. Disable it only when the browser will not auto-attach the credential.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| CSRF disabled on cookie-auth browser API | Account takeover via drive-by POST from evil.example |
| CSRF enabled on Bearer-only API | Random 403 from mobile clients that don't send tokens; TRACE: `Invalid CSRF token found for` |
| `XorCsrfTokenRequestAttributeHandler` + SPA echoing cookie | 403 even when cookie and header "look" equal |
| Thymeleaf form missing `_csrf` because fragment isn't using `th:action` | 403 only on that form |
| Multipart upload: CSRF param in body parsed **after** CSRF filter | 403 on file upload; put token in header or query |
| `ignoringRequestMatchers("/api/**")` as a blunt hammer | CSRF hole on any cookie-auth endpoint under `/api` |

### Debugging scenario

**Observe.** 403 only on `POST /api/files` (multipart). Other POSTs with JSON work. CSRF is enabled.

**Diagnose.** `CsrfFilter` runs before `MultipartFilter`. The token is in the multipart body; the CSRF filter never sees it. JSON POSTs send `X-XSRF-TOKEN` header — those work.

**Fix.** Send CSRF in a header for uploads, or register `MultipartFilter` **before** Spring Security in the container (via `FilterRegistrationBean` order) so the body is parsed first — with a size limit, because you are now parsing multipart before authz. Header is the safer fix.

```javascript
const form = new FormData();
form.append("file", file);
fetch("/api/files", {
  method: "POST",
  headers: { "X-XSRF-TOKEN": readCookie("XSRF-TOKEN") },
  body: form,
  credentials: "include"
});
```

---

## 9. CORS

### Core concept

CORS is a **browser** rule. `curl`, Postman, server-to-server, and mobile apps are not subject to it. If Postman works and the browser console shows `blocked by CORS policy`, it is CORS (or a mix of CORS + the browser hiding the real status).

Spring has two CORS knobs that people stack accidentally:

1. `CorsFilter` in the **security** chain (`http.cors(...)`)
2. Spring MVC `CORS` (`@CrossOrigin`, `WebMvcConfigurer.addCorsMappings`)

For a secured app, **Security's `CorsFilter` must run inside the security chain, before auth filters**, so a preflight `OPTIONS` can get `Access-Control-Allow-Origin` even when the request is unauthenticated. If only MVC CORS is configured, preflight hits `AuthorizationFilter` first → 401 → browser reports a CORS failure and hides the 401.

### Internal working

Preflight: `OPTIONS` + `Origin` + `Access-Control-Request-Method` (+ maybe `Access-Control-Request-Headers`). `CorsFilter` responds **200** with ACAO/ACAC/ACAM headers and **does not continue the chain** when it handles a preflight.

`UrlBasedCorsConfigurationSource` maps paths to `CorsConfiguration`:

- `setAllowedOrigins(List.of("https://app.example.com"))` — exact origins
- `setAllowedOriginPatterns` — patterns (needed for `*` + credentials? **No.** Credentials + wildcard origin is invalid per spec and Spring will refuse to echo `*`)
- `setAllowCredentials(true)` — browser will send cookies. You **must** echo a specific origin, not `*`
- `setAllowedMethods`, `setAllowedHeaders` (`*` is OK for headers in modern Spring), `setExposedHeaders` (Authorization, custom pagination headers — **not** exposed by default)
- `setMaxAge` — cache preflight

`http.cors(Customizer.withDefaults())` looks up a bean of type `CorsConfigurationSource`. If none exists, it falls back to MVC's CORS config. If **neither** exists, `http.cors()` does nothing useful.

### Production scenario: SPA on `https://app.example.com`, API on `https://api.example.com`, cookies, "CORS works in staging"

**Problem.** Staging SPA and API are same-origin behind one ingress path. Production splits subdomains. Browser: `The value of the 'Access-Control-Allow-Origin' header in the response must not be the wildcard '*' when the request's credentials mode is 'include'`. Or: CORS looks fine on GET, POST preflight fails. Or: 401 on preflight.

**Solution.**

```java
@Bean
CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration c = new CorsConfiguration();
    c.setAllowedOrigins(List.of("https://app.example.com"));
    c.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
    c.setAllowedHeaders(List.of("*"));
    c.setExposedHeaders(List.of("Authorization", "Link", "X-Total-Count"));
    c.setAllowCredentials(true);
    c.setMaxAge(Duration.ofHours(1));

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", c);
    return source;
}

@Bean
SecurityFilterChain api(HttpSecurity http) throws Exception {
    http
        .securityMatcher("/api/**")
        .cors(Customizer.withDefaults()) // picks up the bean above
        .csrf(AbstractHttpConfigurer::disable) // bearer-only API; keep CSRF if this API is cookie-authenticated
        .authorizeHttpRequests(a -> a)
            .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll() // belt; CorsFilter should already short-circuit
            .anyRequest().authenticated()
        );
    return http.build();
}
```

Do **not** also slap `@CrossOrigin(origins = "*")` on controllers. Two layers disagree and you will debug ghosts.

If the API uses Bearer tokens and the SPA sends `Authorization` without cookies, `allowCredentials` can be false and you can use a tighter header list. Prefer that over credentialed CORS.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| MVC `@CrossOrigin` only, no `http.cors()` | Browser CORS error; network tab shows 401 on OPTIONS |
| `allowedOrigins("*")` + `allowCredentials(true)` | Spring logs a warning; header omitted; browser blocks |
| Allowed origin `https://app.example.com/` (trailing slash) | Origin match fails; no ACAO |
| `exposedHeaders` missing `Authorization` | SPA cannot read a refreshed token from the response |
| Gateway adds CORS **and** the app adds CORS | Duplicate `Access-Control-Allow-Origin` → browser rejects |
| `allowedHeaders` missing `X-XSRF-TOKEN` | Preflight fails only on mutating calls |

### Debugging scenario

**Observe.** Chrome: CORS error. Network: OPTIONS 200, GET 200, but JS `fetch` fails. Response on GET has `Access-Control-Allow-Origin: https://app.example.com` **twice**.

**Diagnose.** Ingress (nginx `add_always`) and Spring both set ACAO. Browsers reject duplicate ACAO.

**Fix.** CORS in **one** place: usually the app (it knows credentials/headers) **or** the gateway (it knows origins), not both. If the gateway terminates CORS, disable `http.cors()` and `@CrossOrigin`.

---

## 10. Method Security

### Core concept

HTTP authorization is coarse (`/api/orders/**`). Method security is **per-operation and per-argument**: `@PreAuthorize("hasPermission(#id, 'Order', 'READ')")`, `@PostAuthorize("returnObject.ownerId == authentication.name")`, `@PreFilter` / `@PostFilter` on collections.

6.x: `@EnableMethodSecurity` (not `@EnableGlobalMethodSecurity`). It registers an AOP interceptor that runs an `AuthorizationManager<MethodInvocation>`.

Annotations:

| Annotation | When | Typical use |
|---|---|---|
| `@PreAuthorize` | Before the call | Role/permission/SpEL on args |
| `@PostAuthorize` | After the call, before return to caller | Filter by returned entity fields |
| `@PreFilter` | Before, mutates a collection argument | Remove unauthorized ids from `List<Long> ids` |
| `@PostFilter` | After, mutates returned collection | Strip elements from a list |
| `@Secured` | Before | Simple role names; less SpEL |
| `@RolesAllowed` | Before | JSR-250; enable with `@EnableMethodSecurity(jsr250Enabled = true)` |

### Internal working

JDK proxy (interface) or CGLIB (class). **Self-invocation does not hit the proxy.** `this.export(order)` inside the same class bypasses `@PreAuthorize` on `export`. This is identical to `@Transactional` self-invocation and is the most expensive production hole in method security.

SpEL root is `MethodSecurityExpressionOperations`: `authentication`, `principal`, `hasRole`, `hasPermission`, `filterObject`, `returnObject`. Beans: `@beanName.method(#arg)`.

6.x uses `AuthorizationManager` by default (`useAuthorizationManager=true`). The old `AccessDecisionManager` / `AffirmativeBased` / voters path is legacy. Custom voters should be rewritten as `AuthorizationManager` or as a `PermissionEvaluator`.

`@PostFilter` on a large collection is an in-memory scan **after** the DB query. It will not scale. Push the constraint to SQL (`WHERE owner_id = ?`) and use `@PreAuthorize` as a safety net, not as the query.

`@PreAuthorize` on controllers works but doubles up with HTTP security. Prefer HTTP for "is this user logged in / is this a public GET", method security for domain rules. Putting both `hasRole("ADMIN")` on HTTP and `@PreAuthorize("hasRole('ADMIN')")` on the method is fine; putting **different** rules is how you get "works in MockMvc, 403 in prod" (you only tested one layer).

### Production scenario: `@PreAuthorize` bypassed by an internal export job

**Problem.** `OrderService.cancel` is `@PreAuthorize("hasRole('OPS') or #order.customerId == principal.customerId")`. A new `OrderExportService` in the same class (or calling via `this`) batch-cancels stale orders. It works in production — including cancelling other tenants' orders — because the scheduler thread has no security context **and** the call is self-invocation. Later a REST endpoint calling `cancel` is correctly denied. Audit finds cancelled orders with no OPS user.

**Solution.**

1. Split so the secured method is on another bean (proxy applies).
2. For system jobs, use an explicit `RunAs` / `SecurityContext` with a `SYSTEM` principal, not "no context."
3. Enforce tenant in the **repository** (see ACL / permission evaluator), not only in SpEL.

```java
@Service
public class OrderService {
    private final OrderCommands commands; // another bean — proxy applies

    public void cancelFromApi(long id) {
        commands.cancel(id); // goes through proxy
    }
}

@Service
public class OrderCommands {
    @PreAuthorize("@orderAuth.canCancel(authentication, #id)")
    public void cancel(long id) { /* ... */ }
}

@Component("orderAuth")
public class OrderAuth {
    public boolean canCancel(Authentication auth, long id) {
        if (auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_OPS"))) {
            return true;
        }
        PrincipalUser p = (PrincipalUser) auth.getPrincipal();
        return orders.findById(id).map(o -> o.getCustomerId().equals(p.getCustomerId())).orElse(false);
    }
}

@Component
public class StaleOrderJob {
    private final OrderCommands commands;

    @Scheduled(cron = "0 0 * * * *")
    public void run() {
        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(new UsernamePasswordAuthenticationToken(
            "system-job", "N/A", List.of(new SimpleGrantedAuthority("ROLE_OPS"))));
        SecurityContextHolder.setContext(ctx);
        try {
            staleIds.forEach(commands::cancel);
        } finally {
            SecurityContextHolder.clearContext();
        }
    }
}
```

Prefer a dedicated `AuthorizationManager` over huge SpEL strings. SpEL is hard to test and easy to get wrong with `==` on Long vs long, or `principal.customerId` when principal is a String.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Self-invocation | Annotation never runs; open access |
| `@EnableMethodSecurity` missing | Annotations ignored; no error |
| `@PreAuthorize` on `private` method | Ignored (proxy can't intercept private) |
| `hasRole('ADMIN')` vs authority `ADMIN` | 403 for everyone with the "right" role |
| `@PostFilter` on a 200k-row report | Heap/GC death; p99 explosion |
| SpEL `principal.id` but principal is `String` username | `SpelEvaluationException` → 500 |
| Method security on a `@Configuration` `@Bean` factory method | Meaningless; not a runtime invocation |
| Testing with `@WithMockUser(roles="ADMIN")` but SpEL uses custom `PrincipalUser` | Tests green, prod 500 |

### Debugging scenario

**Observe.** `AccessDeniedException` on a method whose SpEL looks correct. HTTP layer permitted the request. User has `ROLE_FINANCE`.

**Diagnose.** Enable:

```yaml
logging:
  level:
    org.springframework.security.access: TRACE
    org.springframework.security.authorization: TRACE
```

Or a unit test that prints `SecurityContextHolder.getContext().getAuthentication().getAuthorities()`. Check for `ROLE_FINANCE` vs `FINANCE`. Check whether the interceptor is in the call stack (if you don't see `AuthorizationManagerBeforeMethodInterceptor`, you are missing a proxy — self-invocation or calling a concrete class that isn't a Spring bean).

**Fix.** Align `hasRole`/`hasAuthority` with how authorities are stored. Extract SpEL to `@orderAuth.can...` and unit-test that bean with a real `TestingAuthenticationToken`.

---

## 11. OAuth2 / OIDC — Client and Resource Server

### Core concept

Three different hats, constantly confused:

| Hat | Spring dependency / DSL | This app's job |
|---|---|---|
| **OAuth2 Client** | `spring-boot-starter-oauth2-client` / `http.oauth2Client()` | Call another API with an access token (client credentials, or on-behalf-of a user) |
| **OAuth2 Login (OIDC)** | same starter / `http.oauth2Login()` | This app **is** the relying party; users log in via Google/Okta/Keycloak |
| **Resource Server** | `spring-boot-starter-oauth2-resource-server` / `http.oauth2ResourceServer()` | This app **is** the API; it **validates** bearer tokens |

OIDC is OAuth2 + identity: an **ID token** (JWT about the user) plus UserInfo. An **access token** is for the resource server and may be opaque. Treating an ID token as an access token (sending it to your API) is a common SPA bug — it will work against a sloppy resource server that only checks signature, and fail against one that checks `aud`.

### Internal working — login

1. User hits a protected page → `ExceptionTranslationFilter` → `LoginUrlAuthenticationEntryPoint` → `/oauth2/authorization/{registrationId}`.
2. `OAuth2AuthorizationRequestRedirectFilter` builds the authorization request (PKCE in 6.x for public/confidential as configured), stores it in `AuthorizationRequestRepository` (session by default), redirects to the IdP.
3. IdP redirects to `{baseUrl}/login/oauth2/code/{registrationId}`.
4. `OAuth2LoginAuthenticationFilter` exchanges the code at the token endpoint (`NimbusAuthorizationCodeTokenResponseClient`), validates ID token (nonce, issuer, audience, signature via JWK), optionally hits UserInfo, produces `OAuth2AuthenticationToken` with `OAuth2User` / `OidcUser`.
5. Session is created; this is **stateful** by default. `STATELESS` + `oauth2Login` is a contradiction unless you immediately mint your own JWT (BFF/session-in-cookie is the usual fix).

`ClientRegistration` comes from `spring.security.oauth2.client.registration.*` + provider issuer metadata (`/.well-known/openid-configuration`).

### Internal working — resource server

`BearerTokenAuthenticationFilter` extracts `Authorization: Bearer`, then:

- **JWT:** `JwtAuthenticationProvider` + `JwtDecoder` (Nimbus). Validate `iss`, `exp`, `nbf`, signature against JWK Set. Convert to `JwtAuthenticationToken` via `JwtAuthenticationConverter`.
- **Opaque:** `OpaqueTokenAuthenticationProvider` introspects at the IdP (`/introspect`). Higher latency, easier revocation.

Default `JwtGrantedAuthoritiesConverter` looks at claim `scope` or `scp`, splits on space, prefixes `SCOPE_`. It does **not** read `roles` or `realm_access.roles` (Keycloak). That is why Keycloak-secured APIs 403 until you write a converter.

### Production scenario: one app is both the UI (OAuth2 login) and the API (resource server) — redirect loops and 401s

**Problem.** Boot app serves Thymeleaf **and** `/api/**`. Config:

```java
http.oauth2Login(Customizer.withDefaults())
    .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
    .authorizeHttpRequests(a -> a.anyRequest().authenticated());
```

Browser navigation works (session). SPA fetch to `/api` with Bearer works. Browser fetch to `/api` **with session cookie, no Bearer** gets 401 from `BearerTokenAuthenticationFilter` / entry point that doesn't redirect. Or: missing token → resource-server entry point returns 401 JSON instead of redirect to IdP for HTML.

Cause: **one chain, two entry points.** The last `exceptionHandling` / resource-server configurer wins. Bearer filter may also reject requests that would have been fine as session-authenticated.

**Solution — two chains.**

```java
@Bean
@Order(1)
SecurityFilterChain api(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/**")
        .authorizeHttpRequests(a -> a.anyRequest().authenticated())
        .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()))
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(AbstractHttpConfigurer::disable);
    return http.build();
}

@Bean
@Order(2)
SecurityFilterChain ui(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(a -> a
            .requestMatchers("/login", "/webjars/**").permitAll()
            .anyRequest().authenticated())
        .oauth2Login(login -> login.loginPage("/login"))
        .csrf(Customizer.withDefaults());
    return http.build();
}
```

Token relay when the UI calls a downstream API as the user:

```java
@Bean
OAuth2AuthorizedClientManager authorizedClientManager(
        ClientRegistrationRepository regs,
        OAuth2AuthorizedClientRepository clients) {
    var provider = OAuth2AuthorizedClientProviderBuilder.builder()
        .authorizationCode()
        .refreshToken()
        .clientCredentials()
        .build();
    var mgr = new DefaultOAuth2AuthorizedClientManager(regs, clients);
    mgr.setAuthorizedClientProvider(provider);
    return mgr;
}

// WebClient filter: ServletOAuth2AuthorizedClientExchangeFilterFunction
```

Refresh-token failures (IdP rotated, refresh reused, reuse detection) surface as `ClientAuthorizationException` on a **random API call**, not at login. Catch it and force re-login; do not retry blindly (refresh reuse detection will revoke the family).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `issuer-uri` trailing slash mismatch vs token `iss` | `JwtValidationException: The iss claim is not valid` |
| Clock skew > 30s between API and IdP | Intermittent `Jwt expired` / `not before` |
| Using ID token as access token; `aud` is the client-id, resource server expects API audience | 401 `invalid_token` |
| Confidential client secret in a public SPA | Secret extracted; attackers mint tokens |
| Authorization code flow without PKCE for a public client | Codes intercepted on mobile/custom URI schemes |
| Mixing `oauth2Login` session with `STATELESS` | Immediate logout / redirect loop |
| `scope` converter only, Keycloak roles in `realm_access` | Authenticated but every `@PreAuthorize("hasRole('X')")` fails |
| Client credentials token cached globally, used for user-specific data | Cross-tenant data leak |

### Debugging scenario

**Observe.** Login succeeds, then bounce: `/oauth2/authorization/okta` → IdP → `/login/oauth2/code/okta` → 401 → loop. Session cookie appears then disappears.

**Diagnose.** Common causes:

1. `SameSite` / `Secure` / HTTPS mismatch so the session that stored `OAUTH2_AUTHORIZATION_REQUEST` is not sent on the callback → `authorization_request_not_found`.
2. App has multiple instances, session in memory, callback hits the other instance.
3. `redirect-uri` registered at IdP is `http://localhost:8080/...` but the app is behind a proxy and generates `http://internal:8080/...` (`server.forward-headers-strategy=framework` missing).
4. Context path / servlet path not in `redirect-uri`.

TRACE `OAuth2LoginAuthenticationFilter` and `HttpSessionOAuth2AuthorizationRequestRepository`.

**Fix.** Spring Session (Redis) or sticky sessions for the login dance; correct public URL (`spring.security.oauth2.client.registration.*.redirect-uri=https://app.example.com/login/oauth2/code/{registrationId}`); forward headers; PKCE enabled (default for Servlet in recent 6.x for certain clients).

---

## 12. JWT-Based Authentication

### Core concept

A JWT is a signed (JWS) or encrypted (JWE) JSON object. Resource servers **validate**, they do not "decrypt the user." HS256 uses a shared secret; RS256/ES256 use IdP private key + published JWKs. **Algorithm confusion:** an attacker takes an RS256 token, changes `alg` to `HS256`, and signs with the **public key** as if it were an HMAC secret. NimbusJwtDecoder configured from JWK Set will not accept `alg=none` or alg switches; a homemade parser might.

Prefer IdP-issued JWTs (OAuth2 resource server) over rolling your own. If you mint your own (internal microservices), you **become** an IdP: key rotation, `iss`, `aud`, `exp`, revocation, clock skew.

### Internal working

`NimbusJwtDecoder.withJwkSetUri(uri).build()`:

1. Fetch JWK Set (cached, refreshed on unknown `kid`).
2. Verify signature with the key matching `kid`.
3. Validate `exp` / `nbf` with 60s clock skew by default (`JwtTimestampValidator`).
4. `JwtIssuerValidator` if issuer was set.
5. Custom validators via `jwtDecoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(iss))` plus `aud`.

`JwtAuthenticationConverter`:

- Principal name: `sub` by default. For usernames you want `preferred_username` — override `setPrincipalClaimName`.
- Authorities: `scope` → `SCOPE_*`. Custom converter for roles.

A successful JWT auth does **not** create a session (`BearerTokenAuthenticationFilter` + typically `STATELESS`). Each request re-validates. Revocation before `exp` requires denylist, short TTL + refresh, or opaque tokens + introspection.

### Production scenario: multi-tenant API, tokens from two issuers, missing `aud` check

**Problem.** Company migrates from Auth0 to Okta. During dual-run, `jwt().jwkSetUri(...)` is a single decoder. Someone points `issuer-uri` at Okta. Auth0 tokens start failing. They "fix" it by disabling issuer validation. A leftover test IdP token (or a malicious token with `alg` matching a configured HMAC fallback) is accepted. `aud` was never checked, so an access token minted for another internal app (`aud=payments-admin`) is accepted by the customer-data API.

**Solution.**

```java
@Bean
JwtDecoder jwtDecoder() {
    var okta = NimbusJwtDecoder.withIssuerLocation("https://company.okta.com/oauth2/default").build();
    var auth0 = NimbusJwtDecoder.withIssuerLocation("https://company.us.auth0.com/").build();

    OAuth2TokenValidator<Jwt> audience = new JwtClaimValidator<List<String>>(
        "aud", aud -> aud != null && aud.contains("customer-api"));

    okta.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
        JwtValidators.createDefaultWithIssuer("https://company.okta.com/oauth2/default"),
        audience));
    auth0.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
        JwtValidators.createDefaultWithIssuer("https://company.us.auth0.com/"),
        audience));

    Map<String, JwtDecoder> byIss = Map.of(
        "https://company.okta.com/oauth2/default", okta,
        "https://company.us.auth0.com/", auth0);

    return token -> {
        String iss = JWTParser.parse(token).getJWTClaimsSet().getIssuer();
        JwtDecoder d = byIss.get(iss);
        if (d == null) throw new JwtException("unknown issuer");
        return d.decode(token);
    };
}

@Bean
JwtAuthenticationConverter jwtAuthenticationConverter() {
    JwtGrantedAuthoritiesConverter scopes = new JwtGrantedAuthoritiesConverter();
    // keep SCOPE_ from scope/scp

    JwtAuthenticationConverter conv = new JwtAuthenticationConverter();
    conv.setPrincipalClaimName("preferred_username");
    conv.setJwtGrantedAuthoritiesConverter(jwt -> {
        Collection<GrantedAuthority> out = new ArrayList<>(scopes.convert(jwt));
        List<String> roles = jwt.getClaimAsStringList("roles");
        if (roles != null) {
            roles.stream()
                .map(r -> r.startsWith("ROLE_") ? r : "ROLE_" + r)
                .map(SimpleGrantedAuthority::new)
                .forEach(out::add);
        }
        return out;
    });
    return conv;
}

@Bean
SecurityFilterChain api(HttpSecurity http, JwtDecoder jwtDecoder,
                        JwtAuthenticationConverter jwtAuthenticationConverter) throws Exception {
    http.securityMatcher("/api/**")
        .csrf(AbstractHttpConfigurer::disable)
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .oauth2ResourceServer(oauth -> oauth
            .jwt(jwt -> jwt.decoder(jwtDecoder).jwtAuthenticationConverter(jwtAuthenticationConverter)))
        .authorizeHttpRequests(a -> a
            .requestMatchers(HttpMethod.GET, "/api/public/**").permitAll()
            .anyRequest().authenticated());
    return http.build();
}
```

Also pin algorithms. Do not add an HS256 decoder "for tests" that remains active in prod profiles.

Key rotation: when `kid` changes, Nimbus refreshes the JWK Set. If you cache JWTs' **introspection results** yourself, you must not cache signature-ok forever without respecting `exp`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No `aud` validation | Tokens for other APIs accepted |
| HS256 secret = something guessable / the public key PEM | Forged tokens |
| `exp` 24h on an access token stored in localStorage | XSS = long-lived account takeover |
| Clock skew: API in UTC-wrong TZ using `Instant.now()` vs numeric `exp` | Fine — `exp` is UTC seconds; the bug is usually NTP, not TZ |
| Putting PII in JWT, logging Authorization headers | GDPR incident |
| Custom filter that only Base64-decodes payload, never verifies signature | Trivial forgery |
| `jwk-set-uri` via HTTP (not HTTPS) in prod | MITM keys, accept attacker tokens |

### Debugging scenario

**Observe.** 401 `invalid_token` with no useful body. Works in one region, fails in another.

**Diagnose.** Decode payload (jwt.io **offline**, never paste prod tokens into websites). Check `iss` exact string, `aud`, `exp`, `nbf`, `kid`. Compare to decoder config. Enable:

```yaml
logging:
  level:
    org.springframework.security.oauth2.server.resource: TRACE
    com.nimbusds: DEBUG
```

Look for `JwtExpiredException`, `BadJWSException` (signature/`kid`), `JwtClaimValidator`. Regional failure is often: JWK Set URL blocked by egress policy, stale DNS, or a replica with drifted clock.

**Fix.** Validate clock (NTP); pin issuer; add audience validator; confirm egress to the JWK Set; never disable signature verification to "unblock."

---

## 13. SAML 2.0 Basics

### Core concept

SAML 2.0 Web SSO: the app is a **Service Provider (SP / Relying Party)**; the enterprise IdP (ADFS, Okta, Ping) is the **Identity Provider**. The user authenticates at the IdP; the SP consumes an **Assertion** (XML, signed, often encrypted). Spring Security SAML2 (not the old abandoned `spring-security-saml` extension) lives in `spring-security-saml2-service-provider`.

Mental mapping to OIDC: AuthnRequest ≈ authorization request; ACS (Assertion Consumer Service) ≈ redirect URI; Assertion ≈ ID token; metadata XML ≈ discovery document.

### Internal working

1. `Saml2WebSsoAuthenticationRequestFilter` (`/saml2/authenticate/{registrationId}`) builds and optionally signs an `AuthnRequest`, redirects (or POSTs via browser) to the IdP SSO URL.
2. IdP POSTs a `SAMLResponse` to the ACS (`/login/saml2/sso/{registrationId}`).
3. `Saml2WebSsoAuthenticationFilter` inflates/decodes, verifies signature against IdP metadata certs, decrypts assertion if needed, checks `Conditions` (`NotBefore`/`NotOnOrAfter`, audience, destination), produces `Saml2AuthenticatedPrincipal`.
4. Session created — SAML login is stateful.

`RelyingPartyRegistration` is the analog of `ClientRegistration`: ACS URL, entity IDs, signing/decryption credentials, IdP metadata location.

Clock skew on `NotOnOrAfter` is a classic ADFS vs AWS clock issue — same as JWT `exp`.

### Production scenario: metadata refresh and ACS URL behind a proxy

**Problem.** SAML works in lower environments. Production IdP admin loaded SP metadata generated as `http://10.2.3.4:8080/login/saml2/sso/okta`. Assertions fail `destination` validation. Or: IdP rotated signing certs; login dies with signature failures until a pod restart.

**Solution.**

```yaml
spring:
  security:
    saml2:
      relyingparty:
        registration:
          okta:
            assertingparty:
              metadata-uri: https://idp.example.com/app/abc/sso/saml/metadata
            acs:
              location: https://app.example.com/login/saml2/sso/okta
            entity-id: https://app.example.com/saml2/service-provider-metadata/okta
```

```java
@Bean
SecurityFilterChain saml(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(a -> a
            .requestMatchers("/login", "/saml2/**").permitAll()
            .anyRequest().authenticated())
        .saml2Login(Customizer.withDefaults())
        .saml2Logout(Customizer.withDefaults());
    return http.build();
}
```

Publish **stable** SP metadata at `/saml2/service-provider-metadata/{registrationId}` over the public HTTPS hostname. Configure `server.forward-headers-strategy=framework` and the proxy `X-Forwarded-Proto: https`. Decrypting assertions requires the SP private key in `relyingparty.registration.*.credentials` — a missing decryption key looks like a signature error if you don't read the OpenSAML exception cause.

For cert rotation: `metadata-uri` is re-fetched (cache TTL). If you pasted a static cert into YAML, you **will** outage at IdP rotation. Prefer metadata URL.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| ACS http vs https | `destination` mismatch |
| Clock skew | `Conditions` validity failure, intermittent |
| Encrypted assertion, no SP private key | Unreadable assertion / 401 |
| `WantAssertionsSigned=false` in a custom OpenSAML stack | Unsigned assertions accepted — don't do this |
| SP entity ID changed without updating IdP | IdP rejects AuthnRequest |
| Logout (SLO) not configured; only local session invalidated | User "logs out" and SSO bounce logs them right back in |

### Debugging scenario

**Observe.** Browser POSTs `SAMLResponse` to ACS, app returns 401. TRACE: `invalid_assertion`.

**Diagnose.** Do **not** paste production SAMLResponses into public decoders. On a staging IdP, decode the assertion: check `Audience`, `Recipient`, `Destination`, `NotOnOrAfter`, signature cert vs metadata. Enable `org.springframework.security.saml2: TRACE` and OpenSAML (noisy). Compare entity IDs character-for-character (trailing slash).

**Fix.** Align ACS/entity IDs with public URL; fix clocks; refresh IdP metadata; add decryption credential if `EncryptedAssertion` is present.

---

## 14. Multi-Factor Authentication

### Core concept

MFA means **two successful authentications of different factors** (something you know / have / are) before a fully privileged `Authentication` is granted. Spring does not have a single `http.mfa()` that is universally used. You compose:

- **Factor 1:** `UsernamePasswordAuthenticationFilter` (or OAuth2/SAML — IdP may already have done MFA via ACR)
- **Factor 2:** TOTP, WebAuthn/passkeys, email OTP, Duo

Until factor 2 succeeds, the `Authentication` should be **partial**: authenticated enough to hit `/mfa` but not `@PreAuthorize` / `anyRequest().authenticated()` in the sense of full access. The usual implementation is a custom `Authentication` with a `MFA_PENDING` authority and HTTP rules that only permit the MFA endpoints.

Spring Security 6.4+ added **one-time token login** and **WebAuthn/passkeys** support. For many enterprises, MFA is **delegated to the IdP** (OIDC `acr_values=phr`, SAML `RequestedAuthnContext`). Do that when you can — rolling your own TOTP is a secret-storage and recovery-code problem.

### Internal working (custom TOTP, the thing seniors actually ship)

1. Factor 1 succeeds → do **not** call the default `SavedRequestAwareAuthenticationSuccessHandler` that sends the user into the app. Instead, save a `MfaAuthenticationToken` (principal + `ROLE_MFA_PENDING`, `authenticated=true` so the session exists) and redirect to `/mfa`.
2. `AuthorizationFilter`: `/mfa/**` permitted for `ROLE_MFA_PENDING`; everything else requires `ROLE_USER` (full).
3. Factor 2 filter on `POST /mfa`: load TOTP secret (encrypted at rest), verify code with a library (e.g. `TimeBasedOneTimePasswordGenerator`), replace context with a full `UsernamePasswordAuthenticationToken` including real roles.
4. Session fixation: rotate session id **after factor 2**, not only after factor 1, or an attacker who hijacked the MFA-pending session still wins when the user types the code (less likely) — rotate on both.

WebAuthn: challenge stored server-side, origin/RP ID must match the public hostname, attestation policy is a product decision. Passkeys break on localhost vs prod RP IDs if misconfigured — same class of bug as OAuth redirect URIs.

### Production scenario: remember-me bypasses MFA

**Problem.** MFA was added on the form-login success path. `RememberMeAuthenticationFilter` still reconstitutes a **full** `Authentication` from a cookie, skipping both password and TOTP. A stolen remember-me cookie on a shared laptop is full account takeover — worse than before MFA shipped, because security theater increased trust.

**Solution.** Treat remember-me as factor 1 only, or disable remember-me, or bind remember-me to a device that already completed WebAuthn.

```java
public class MfaRememberMeAuthProvider implements AuthenticationProvider {
    private final RememberMeAuthenticationProvider delegate;
    @Override
    public Authentication authenticate(Authentication authentication) throws AuthenticationException {
        Authentication full = delegate.authenticate(authentication);
        if (full == null) return null;
        return MfaAuthenticationToken.pending(full.getPrincipal()); // not full authorities
    }
    @Override
    public boolean supports(Class<?> t) {
        return RememberMeAuthenticationToken.class.isAssignableFrom(t);
    }
}
```

And never put `ROLE_USER` on a remember-me token until TOTP/WebAuthn succeeds for that session. Product alternative: remember-me allowed only for low-risk `GET`, step-up for mutations (`hasAuthority("MFA_COMPLETED")` on POST in method security).

If MFA is at the IdP, request it:

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          okta:
            scope: openid,profile,email
        provider:
          okta:
            issuer-uri: https://company.okta.com
```

Plus a custom `OAuth2AuthorizationRequestResolver` that adds `acr_values=urn:okta:loa:2fa:any` (IdP-specific). Then **trust** `amr`/`acr` claims in the ID token; do not invent a second TOTP.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Full authorities granted after password only | MFA page is skippable by hitting `/home` |
| TOTP secret stored plaintext | DB dump = every user's second factor stolen |
| Window of ±0 steps on TOTP | Clock drift → lockouts; ±1 is common, ±10 is a brute-force gift |
| Recovery codes logged | Same as stolen TOTP |
| WebAuthn RP ID = `localhost` in prod build | Registration works in dev, prod "NotAllowedError" |
| MFA cookie `HttpOnly=false` | XSS steals MFA session |

### Debugging scenario

**Observe.** Some users loop: password → MFA page → submit code → back to MFA page. Code is valid in a local TOTP app.

**Diagnose.** Session lost between GET `/mfa` and POST (SameSite, load balancer, session cookie domain). Or: factor 2 success handler saves a new Authentication but `SessionAuthenticationStrategy` doesn't, and `SecurityContextHolderFilter` loads the **old** pending token from the session. Or: TOTP verified against the wrong user's secret because `SecurityContext` was anonymous (session missing) and the form posted only the code.

**Fix.** Confirm `JSESSIONID` on both GET and POST. On success, `SecurityContextRepository.saveContext` explicitly. Bound TOTP verify to `authentication.getName()` from the pending session principal, not a hidden form username field (attacker would swap it).

---

## 15. Access Control Lists (ACL)

### Core concept

RBAC (`hasRole`) answers "is this user an admin?" ACL answers "**this user** may **WRITE** **this Order #4821**." Spring Security ACL is a separate module (`spring-security-acl`) with JDBC tables: `acl_sid`, `acl_class`, `acl_object_identity`, `acl_entry`. It is powerful, old, chatty with the DB, and the wrong default for most greenfield apps.

Use ACL when you have **per-instance sharing** that is not a simple `owner_id` column (Google-Docs-style ACLs, folder trees with inheritance). Use a `owner_id` / `org_id` predicate in SQL plus `@PreAuthorize` when sharing is not a product feature. Seniors overuse ACL because it feels "more secure." It often becomes an N+1 production incident.

### Internal working

- **SID** (`PrincipalSid` / `GrantedAuthoritySid`): who.
- **ObjectIdentity**: `(type, id)` e.g. `order:4821`.
- **ACL**: the list of ACEs for that object, optionally inheriting from a parent object identity.
- **ACE:** SID + mask (READ=1, WRITE=2, CREATE=4, DELETE=8, ADMINISTRATION=16) + granting bit.
- `AclService.readAclById` → `PermissionEvaluator.hasPermission(auth, targetId, type, permission)` hooked from SpEL `hasPermission(#id, 'com.acme.Order', 'READ')`.
- `JdbcMutableAclService` for writes. Caching via `SpringCacheBasedAclCache`. Without cache, **each** `hasPermission` is multiple SQL queries. `@PostFilter("hasPermission(filterObject, 'READ')")` on a list of 100 entities is hundreds of queries.

ACL inheritance: documents in a folder inherit folder ACEs unless a child ACE overrides. Misconfigured lookup strategy (`BasicLookupStrategy`) plus deep trees = timeout.

### Production scenario: list endpoint dies after ACL is added

**Problem.** `GET /api/docs` used to be `select * from doc where org_id=?`. Someone added `@PostFilter("hasPermission(filterObject, 'READ')")`. p99 goes from 40ms to 8s. DB CPU pegged. `acl_entry` is huge, no cache.

**Solution.** Do not `@PostFilter` lists. Query ACL in SQL or maintain a **read model**.

Option A — SQL join (when ACL tables are source of truth):

```sql
SELECT d.*
FROM doc d
JOIN acl_object_identity oi ON oi.object_id_identity = d.id AND oi.object_id_class = :classId
JOIN acl_entry e ON e.acl_object_identity = oi.id
JOIN acl_sid sid ON sid.id = e.sid
WHERE e.granting = true
  AND e.mask & :readMask = :readMask
  AND (sid.sid = :username OR sid.sid IN (:authorities))
```

Option B — denormalized `doc_permission(user_id, doc_id, mask)` updated in the same transaction as `MutableAclService.insertAce`. List from that table. ACL remains for odd sharing cases / admin UI.

Option C — if sharing isn't required, drop ACL:

```java
@PreAuthorize("@docs.canRead(authentication, #id)")
public Doc get(long id) { ... }
```

```java
public boolean canRead(Authentication auth, long id) {
    return docs.findById(id)
        .filter(d -> d.getOrgId().equals(((P) auth.getPrincipal()).getOrgId()))
        .isPresent();
}
```

If you keep Spring ACL, mandatory production setup:

```java
@Bean
AclCache aclCache(CacheManager cm) {
    return new SpringCacheBasedAclCache(
        cm.getCache("acl"),
        new DefaultPermissionGrantingStrategy(new ConsoleAuditLogger()),
        new AclAuthorizationStrategyImpl(new SimpleGrantedAuthority("ROLE_ACL_ADMIN")));
}

@Bean
LookupStrategy lookupStrategy(DataSource ds, AclCache cache) {
    return new BasicLookupStrategy(ds, cache, aclAuthz(), new ConsoleAuditLogger());
}
```

Cache eviction on every ACE change or you will serve stale deny/allow. That bug is a security incident, not a performance one.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@PostFilter` + no ACL cache | DB meltdown on list endpoints |
| Stale ACL cache after sharing change | User still sees / cannot see a doc after permissions change |
| Bit masks used as if they were roles | Wrong ACE matches (`mask=1` vs `BasePermission.READ`) |
| Object class name refactor (`com.old.Doc` vs `com.new.Doc`) | All ACLs miss; everyone 403 |
| Granting ACE and denying ACE order | `DefaultPermissionGrantingStrategy` first matching ACE wins — deny must be ordered correctly |
| Admin UI uses JDBC ACL without `ROLE_ACL_ADMIN` | `NotFoundException` / cannot create ACL |

### Debugging scenario

**Observe.** Owner cannot READ their newly created object. Insert of the domain row succeeded. `hasPermission` false.

**Diagnose.** Code created the entity but never `aclService.createAcl(oid)` + `insertAce` for the owner SID. Or created ACL in a transaction that rolled back after the entity commit (two resources, no XA). Or `ObjectIdentityImpl` used `id` of type `Long` vs `String` inconsistently.

**Fix.** One transactional service: save entity, create ACL, insert owner ADMINISTRATION ACE. Integration-test that path. Log `acl_object_identity` rows for the id after create.

---

## 16. Custom Filters

### Core concept

Write a filter when you must **inspect or wrap the HTTP request/response** (correlation IDs, wrapping `HttpServletRequest` to read a custom header as a token, MDC). Write an `AuthenticationProvider` when you have credentials and need to authenticate. Write an `AuthorizationManager` when the principal is already there and you need an allow/deny decision. Custom filters that call `userRepository.find...` and `SecurityContextHolder.setContext` duplicate `BearerTokenAuthenticationFilter` and skip every validator you would have gotten for free.

Always extend `OncePerRequestFilter` unless you have a specific reason not to. Insert with `http.addFilterBefore/After/At(filter, SomeSecurityFilter.class)` so the filter lives **in the security chain**. A servlet `@Component Filter` is the wrong chain.

### Internal working

`HttpSecurity.addFilterBefore(f, CsrfFilter.class)` looks up the **registered order** of `CsrfFilter` and inserts relative to it. If that class is not in **this** chain, `http.build()` throws `IllegalArgumentException: Cannot register after unregistered Filter`. That happens when you `addFilterAfter(jwtFilter, UsernamePasswordAuthenticationFilter.class)` on a resource-server chain that **has no** form-login filter.

`addFilterAt` **replaces** the slot; you can knock out `UsernamePasswordAuthenticationFilter` by accident.

`OncePerRequestFilter.shouldNotFilterErrorDispatch()` in 6.x defaults to skipping ERROR dispatch. A filter that was expected to add CORS headers on a 500 may no longer run. Override if you must wrap error responses — or use `HeaderWriterFilter` / `CorsFilter` which are already ordered correctly.

Async: `OncePerRequestFilter` also has `shouldNotFilterAsyncDispatch`. Security context on async dispatches is handled by `WebAsyncManagerIntegrationFilter`. Custom filters that set ThreadLocal MDC must clear it in `finally` or you leak principals across pooled threads.

### Production scenario: API-key filter that broke CSRF and internal MVC forwards

**Problem.** Partner API-key filter:

```java
@Component // WRONG chain
public class ApiKeyFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(...) {
        String key = request.getHeader("X-API-Key");
        if (key != null) {
            SecurityContextHolder.getContext().setAuthentication(authenticate(key));
        }
        chain.doFilter(request, response);
    }
}
```

Symptoms: (1) filter runs **after** `AuthorizationFilter` depending on container order — 401 then later the context is set for a filter that never runs. (2) Duplicate execution on FORWARD to `/error`. (3) API key in logs via access log of headers. (4) Failed keys throw `BadCredentialsException` **outside** `ExceptionTranslationFilter` → 500 instead of 401.

**Solution.**

```java
public class ApiKeyAuthenticationFilter extends OncePerRequestFilter {
    private final AuthenticationManager authenticationManager;
    private final AuthenticationEntryPoint entryPoint = new BearerTokenAuthenticationEntryPoint();

    public ApiKeyAuthenticationFilter(AuthenticationManager authenticationManager) {
        this.authenticationManager = authenticationManager;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String key = request.getHeader("X-API-Key");
        if (key == null) {
            chain.doFilter(request, response);
            return;
        }
        try {
            Authentication unauth = new ApiKeyAuthenticationToken(key);
            Authentication auth = authenticationManager.authenticate(unauth);
            SecurityContext ctx = SecurityContextHolder.createEmptyContext();
            ctx.setAuthentication(auth);
            SecurityContextHolder.setContext(ctx);
            chain.doFilter(request, response);
        } catch (AuthenticationException ex) {
            SecurityContextHolder.clearContext();
            entryPoint.commence(request, response, ex);
        }
    }
}

@Bean
@Order(1)
SecurityFilterChain partners(HttpSecurity http, AuthenticationManager am) throws Exception {
    http.securityMatcher("/partner/**")
        .addFilterBefore(new ApiKeyAuthenticationFilter(am), AuthorizationFilter.class)
        .authorizeHttpRequests(a -> a.anyRequest().authenticated())
        .csrf(AbstractHttpConfigurer::disable)
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
    return http.build();
}
```

`ApiKeyAuthenticationProvider` does the DB lookup, constant-time compare (hashed keys at rest), and returns authorities. The filter does not touch the database.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Component` Filter | Wrong order; double execution |
| `addFilterAfter(..., UsernamePasswordAuthenticationFilter.class)` on JWT-only chain | Startup failure: unregistered Filter |
| Not catching `AuthenticationException` | 500 instead of 401 |
| Setting context without `createEmptyContext()` | Mutating a shared/empty context incorrectly under some strategies |
| Wrapping request and not overriding `getRequestURI` consistently | Matchers see original URI, controller sees wrapped — or vice versa |
| Filter does I/O on every request including static assets | Latency; apply `shouldNotFilter` |

### Debugging scenario

**Observe.** TRACE shows your filter `doFilterInternal` running, Authentication is set, then `AnonymousAuthenticationFilter` **overwrites** it with anonymous, then 401.

**Diagnose.** `AnonymousAuthenticationFilter` only sets anonymous if `SecurityContext` has **no** authentication (`== null`). If you set it **after** AnonymousAuthenticationFilter ran, you're fine. If you set it and then something `clearContext`'d, anonymous wins. More common: you set authentication on the context, but `SecurityContextHolderFilter`'s deferred save / another filter replaced the context. Or you used `MODE_INHERITABLETHREADLOCAL` and a child thread's clear wiped it.

Order: custom auth filter must run **before** `AnonymousAuthenticationFilter` and **before** `AuthorizationFilter`. Use `addFilterBefore(filter, AnonymousAuthenticationFilter.class)`.

**Fix.** Confirm order in TRACE (`FilterChainProxy` logs the list at DEBUG). Insert before anonymous. Do not `clearContext` in a `finally` before the rest of the chain runs.

---

## 17. Exception Handling

### Core concept

`ExceptionTranslationFilter` sits immediately **before** `AuthorizationFilter` and wraps the rest of the chain (including the servlet). It catches:

- `AuthenticationException` → `AuthenticationEntryPoint.commence` → typically **401** (or 302 to login)
- `AccessDeniedException` → if the user is anonymous (or remember-me, configurable) → treat as authentication needed (entry point); else `AccessDeniedHandler.handle` → typically **403**

Exceptions thrown **after** the security chain has left (e.g. in an MVC `@ExceptionHandler` that rethrows, or in a container error page that is itself unsecured) do not go through this filter unless the ERROR dispatch re-enters the chain.

`AuthenticationEntryPoint` = "we don't know who you are (or we won't talk to you until you authenticate)." `AccessDeniedHandler` = "we know who you are; you can't do this."

Expired JWT is `AuthenticationException` (401). Valid JWT with wrong role is `AccessDeniedException` (403). Anonymous hitting a protected resource is **401** via the "anonymous is not really authenticated" branch, not 403 — unless you configured it otherwise. Seniors arguing 401 vs 403 on SPA routes usually missed that anonymous is an Authentication.

### Internal working

```
ExceptionTranslationFilter.doFilter
  try
      chain.doFilter
  catch AuthenticationException ex
      sendStartAuthentication → entryPoint.commence
  catch AccessDeniedException ex
      if authenticationTrustResolver.isAnonymous(auth) || isRememberMe
          sendStartAuthentication
      else
          accessDeniedHandler.handle
```

Default servlet entry points:

- Form login: `LoginUrlAuthenticationEntryPoint` — 302 `Location: /login`
- HTTP Basic: `BasicAuthenticationEntryPoint` — 401 + `WWW-Authenticate: Basic`
- Resource server: `BearerTokenAuthenticationEntryPoint` — 401 + `WWW-Authenticate: Bearer error="invalid_token"`

`AccessDeniedHandlerImpl` — 403 empty body (or error page). SPAs need a JSON body; use `AccessDeniedHandler` that writes RFC 7807.

`AuthorizationFilter` throws `AccessDeniedException` wrapping `AuthorizationDeniedException` in 6.x. Your `@ExceptionHandler(AccessDeniedException.class)` in a `@RestControllerAdvice` **may not run** for security-layer denials because they are handled inside the filter **before** DispatcherServlet. HTTP-layer 403 never hits MVC advice. Method-security denials occur **inside** the controller invocation, so they **do** hit MVC advice **unless** `ExceptionTranslationFilter` already translated them — method security throws `AccessDeniedException` from the interceptor, which is still inside the filter's `try`, so **ExceptionTranslationFilter handles it first**. MVC `@ExceptionHandler` for `AccessDeniedException` is therefore often **dead code** for method security too.

To customize JSON for both 401 and 403, implement entry point + access denied handler, not only `@RestControllerAdvice`.

### Production scenario: SPA receives HTML login page (200/302) instead of 401 JSON

**Problem.** Same API used by a mobile app and a browser SPA. `http.formLogin()` exists for an admin UI on the same origin. Mobile treats a 302 HTML as a parse error. SPA router dumps the user to a blank page.

**Solution.** `AuthenticationEntryPoint` that branches on `Accept` / `X-Requested-With` / path.

```java
public class RestAuthEntryPoint implements AuthenticationEntryPoint {
    @Override
    public void commence(HttpServletRequest req, HttpServletResponse res,
                         AuthenticationException ex) throws IOException {
        res.setStatus(HttpStatus.UNAUTHORIZED.value());
        res.setContentType("application/problem+json");
        res.getWriter().write("""
            {"type":"about:blank","title":"Unauthorized","status":401,"detail":"%s"}
            """.formatted(escape(ex.getMessage())));
    }
}

public class RestAccessDeniedHandler implements AccessDeniedHandler {
    @Override
    public void handle(HttpServletRequest req, HttpServletResponse res,
                       AccessDeniedException ex) throws IOException {
        res.setStatus(HttpStatus.FORBIDDEN.value());
        res.setContentType("application/problem+json");
        res.getWriter().write("""
            {"type":"about:blank","title":"Forbidden","status":403,"detail":"insufficient_permission"}
            """);
    }
}

@Bean
@Order(1)
SecurityFilterChain api(HttpSecurity http) throws Exception {
    http.securityMatcher("/api/**")
        .exceptionHandling(e -> e
            .authenticationEntryPoint(new RestAuthEntryPoint())
            .accessDeniedHandler(new RestAccessDeniedHandler()))
        .oauth2ResourceServer(oauth -> oauth
            .jwt(Customizer.withDefaults())
            .authenticationEntryPoint(new RestAuthEntryPoint())
            .accessDeniedHandler(new RestAccessDeniedHandler()));
    return http.build();
}

@Bean
@Order(2)
SecurityFilterChain adminUi(HttpSecurity http) throws Exception {
    http.authorizeHttpRequests(a -> a.anyRequest().authenticated())
        .formLogin(Customizer.withDefaults());
    return http.build();
}
```

Do not put `ex.getMessage()` from `BadCredentialsException` into the body in prod if it distinguishes unknown user vs bad password. Use a generic `invalid_token` / `unauthorized`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Only `@RestControllerAdvice` for 401/403 | HTML/empty body; advice never called |
| Resource server + form login one chain | HTML 302 for API clients |
| `http.exceptionHandling` then `oauth2ResourceServer` overwrites entry point | Your JSON handler silently unused |
| Logging stack traces for every 401 | Log flood during credential stuffing; cost + noise |
| Returning 401 for authenticated-but-forbidden | SPA clears tokens and forces login in a loop |
| Custom entry point that doesn't send `WWW-Authenticate` on Basic/Bearer | Some clients never retry with credentials |

### Debugging scenario

**Observe.** Authenticated user, wrong role, client sees **401** and wipes the session. You expected 403.

**Diagnose.** `AccessDeniedException` was thrown, but `AuthenticationTrustResolverImpl.isAnonymous` or `isRememberMe` returned true — e.g. you used a custom token that doesn't extend `AbstractAuthenticationToken` correctly (`isAuthenticated` false), or you left `ROLE_ANONYMOUS` in authorities on a "real" user. ExceptionTranslationFilter then **commences login** (401/302) instead of 403.

Alternatively: JWT expired (401) vs role missing (403) — the client lumped both as "auth failed." Log `ex.getClass()` in both handlers.

**Fix.** Ensure successful auth sets `authenticated=true` and does not include `ROLE_ANONYMOUS`. Keep 401 and 403 handlers distinct; teach the SPA: 401 → re-auth, 403 → show forbidden.

---

## 18. Security Context Propagation

### Core concept

`SecurityContextHolder` default strategy is `MODE_THREADLOCAL`. The context is a ThreadLocal. It does **not** follow `@Async`, `@Scheduled`, `Executor.execute`, WebClient on another thread, or `parallelStream()`. It **does** follow the same servlet thread through the filter chain and controller.

Strategies:

| Mode | Behavior |
|---|---|
| `MODE_THREADLOCAL` (default) | Fast; no inheritance |
| `MODE_INHERITABLETHREADLOCAL` | Child threads created with `new Thread` inherit a **copy** at create time. Thread **pools** reuse threads — you will leak the previous task's user. Almost never correct in production. |
| `MODE_GLOBAL` | One context JVM-wide. Test-only. |

Reactive (WebFlux): there is **no** ThreadLocal by default. The context lives in Reactor `Context` via `ReactiveSecurityContextHolder`. Mixing `SecurityContextHolder.getContext()` inside a WebFlux app returns empty unless you enable context propagation (`ReactorContextWebFilter` / `SecurityContextHolder` hook in 6.x for imperative calls).

### Internal working — servlet

`DelegatingSecurityContextRunnable` / `DelegatingSecurityContextExecutor` capture the context at **schedule** time and restore it for the duration of `run()`, then clear. `@Async` does not do this unless you wrap the executor:

```java
@Bean
TaskExecutor taskExecutor() {
    var exec = new ThreadPoolTaskExecutor();
    exec.setCorePoolSize(8);
    exec.initialize();
    return new DelegatingSecurityContextAsyncTaskExecutor(exec);
}
```

Spring Security 6.2+ / Boot 3.2+ can integrate with Micrometer Context Propagation so Reactor and executors pick up ThreadLocals if you add `context-propagation` and configure it. Do not assume it's on.

Virtual threads (Java 21): still ThreadLocal per virtual thread. Propagation across `ExecutorService` still needs wrapping. Do not use `MODE_INHERITABLETHREADLOCAL` with virtual thread pools.

### Internal working — WebFlux

`AuthenticationWebFilter` writes into Reactor Context. `ReactiveSecurityContextHolder.getContext()` is a `Mono`. Blocking `SecurityContextHolder.getContext()` inside `flatMap` is empty. `publishOn(Schedulers.boundedElastic())` **drops** context unless you use `contextWrite` / `contextCapture` (reactor-core 3.5+ `contextCapture()`).

```java
return ReactiveSecurityContextHolder.getContext()
    .map(SecurityContext::getAuthentication)
    .flatMap(auth -> repo.findByOwner(auth.getName()));
```

### Production scenario: `@Async` email sends as the wrong user (or as anonymous)

**Problem.** After an order is placed, `@Async void sendReceipt(Order order)` loads `SecurityContextHolder` to get the email from the principal. Intermittently: NPE, or worse, **another customer's email** when `MODE_INHERITABLETHREADLOCAL` was "fixed" in by a senior who read a blog, on a pool of 8 threads.

**Solution.** Pass the data you need as arguments. Do not read ThreadLocal in async workers. If you must (audit library you don't own):

```java
@Bean(name = "applicationTaskExecutor")
AsyncTaskExecutor applicationTaskExecutor() {
    ThreadPoolTaskExecutor e = new ThreadPoolTaskExecutor();
    e.setThreadNamePrefix("app-async-");
    e.initialize();
    return new DelegatingSecurityContextAsyncTaskExecutor(e);
}
```

```java
@Async
public void sendReceipt(String recipientEmail, long orderId) {
    mail.send(recipientEmail, render(orderId));
}
```

For WebClient in servlet MVC calling a downstream with the user token:

```java
@Bean
WebClient webClient(OAuth2AuthorizedClientManager mgr) {
    ServletOAuth2AuthorizedClientExchangeFilterFunction oauth =
        new ServletOAuth2AuthorizedClientExchangeFilterFunction(mgr);
    oauth.setDefaultOAuth2AuthorizedClient(true);
    return WebClient.builder().apply(oauth.oauth2Configuration()).build();
}
```

That filter reads the request from `RequestContextHolder` — also ThreadLocal. Calling this WebClient from `@Async` without the request = fail. Capture the access token **on the request thread** and pass it.

Reactive:

```java
Hooks.enableAutomaticContextPropagation(); // reactor + micrometer-context-propagation on classpath
```

Still prefer explicit `ReactiveSecurityContextHolder` over hoping ThreadLocal hops the event loop.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `MODE_INHERITABLETHREADLOCAL` + pool | Cross-user data leak — security incident |
| `@Async` + `SecurityContextHolder` | Anonymous / NPE |
| WebFlux + blocking `getContext()` | Empty authentication, 500 or open queries without owner filter |
| `parallelStream()` in a request | Inheritable not set; workers see null; or fork-join common pool pollution |
| Not clearing context in a custom executor | Next task on that thread is authenticated as the previous user |

### Debugging scenario

**Observe.** Audit log shows user A deleted user B's resource. The HTTP request was user B. Deletion ran on `app-async-3`.

**Diagnose.** Thread dump / MDC: if you put `userId` in MDC in a filter and don't wrap async, MDC can leak the same way (Logback MDC is ThreadLocal too). Check `DelegatingSecurityContext*` usage. Check whether a static `SecurityContextHolder.setStrategyName(MODE_INHERITABLETHREADLOCAL)` exists in a `ApplicationRunner`.

**Fix.** Remove inheritable mode. Wrap executors. Pass identifiers as method args. Add a regression test that two concurrent `@Async` tasks do not swap principals (CountDownLatch, two users).

---

## 19. Testing Security Configurations

### Core concept

Security tests that `@SpringBootTest` the whole app and click through MockMvc with a real DB are slow and still miss matcher order. Slice tests with `spring-security-test` are the high-leverage tool. Test **both** layers: HTTP matchers and method security. A green HTTP test with `permitAll` will not catch a `@PreAuthorize` you added on the service.

Key artifacts:

- `@WithMockUser` — synthesizes a `UsernamePasswordAuthenticationToken` with roles. **Does not** call `UserDetailsService`.
- `@WithUserDetails("ada")` — **does** call `UserDetailsService`. Use when SpEL/principal is a custom type.
- `@WithAnonymousUser` / `@WithSecurityContext` for custom tokens (JWT, MFA pending).
- `SecurityMockMvcRequestPostProcessors`: `user()`, `jwt()`, `opaqueToken()`, `csrf()`, `authentication()`.
- `springSecurity()` in `MockMvcBuilders` or `@AutoConfigureMockMvc` (Boot).

### Internal working

`@WithMockUser` is a `TestExecutionListener` that sets `SecurityContextHolder` **before** the test method and clears after. MockMvc still runs the filter chain. If your chain is `STATELESS` JWT-only, `@WithMockUser` may be **overwritten** by `BearerTokenAuthenticationFilter` finding no token — you get anonymous, then 401. For resource servers, use `.with(jwt())`, not `@WithMockUser`.

`csrf()` postprocessor puts a valid token in the request (and session if session-based). Forgetting it is the #1 false-red on POST tests after enabling security.

`@Import(SecurityConfig.class)` on `@WebMvcTest` is required because WebMvcTest does not pull the full security configuration by default in all setups — Boot's `@AutoConfigureMockMvc` + Security auto-config may apply **default** security (any request authenticated) if your `@EnableWebSecurity` config is excluded. Symptom: every WebMvcTest 401 after adding Spring Security, tests that never imported your `permitAll` matchers.

### Production scenario: tests green, prod 403 on JWT roles

**Problem.**

```java
@WebMvcTest(OrderController.class)
class OrderControllerTest {
    @Test
    @WithMockUser(roles = "ADMIN")
    void list() throws Exception {
        mvc.perform(get("/api/orders")).andExpect(status().isOk());
    }
}
```

Production uses Keycloak JWTs; roles are in `realm_access.roles` without `ROLE_` prefix until the converter adds it. Tests never load `JwtAuthenticationConverter`. HTTP tests pass because `@WithMockUser(roles="ADMIN")` adds `ROLE_ADMIN`. Prod tokens have `ROLE_admin` or `SCOPE_orders`.

**Solution.** Test the converter in isolation **and** MockMvc with a fake JWT.

```java
@Test
void jwt_admin_can_list() throws Exception {
    mvc.perform(get("/api/orders")
            .with(jwt().jwt(jwt -> jwt.claim("roles", List.of("ADMIN")))
                .authorities(new SimpleGrantedAuthority("ROLE_ADMIN"))))
        .andExpect(status().isOk());
}

@Test
void jwt_missing_role_is_403() throws Exception {
    mvc.perform(get("/api/orders")
            .with(jwt().jwt(jwt -> jwt.subject("ada"))))
        .andExpect(status().isForbidden());
}

@Test
void converter_maps_keycloak_realm_roles() {
    Jwt jwt = Jwt.withTokenValue("t").header("alg", "none")
        .claim("sub", "ada")
        .claim("realm_access", Map.of("roles", List.of("admin")))
        .build();
    Collection<GrantedAuthority> auths = converter.convert(jwt);
    assertThat(auths).extracting(GrantedAuthority::getAuthority).contains("ROLE_admin");
}
```

Method security:

```java
@SpringJUnitConfig({OrderCommands.class, OrderAuth.class, MethodSecurityConfig.class})
class OrderCommandsSecurityTest {
    @Autowired OrderCommands commands;

    @Test
    @WithMockUser(roles = "OPS")
    void ops_can_cancel() { commands.cancel(1L); }

    @Test
    @WithMockUser(username = "ada")
    void owner_mismatch_denied() {
        assertThatThrownBy(() -> commands.cancel(1L)).isInstanceOf(AccessDeniedException.class);
    }
}
```

If `OrderAuth` needs a custom principal, `@WithMockUser` is the wrong tool — write `@WithSecurityContext(factory = PrincipalUserFactory.class)`.

CSRF:

```java
mvc.perform(post("/api/profile").with(csrf()).with(user("ada")).contentType(APPLICATION_JSON).content("{}"))
   .andExpect(status().isOk());
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No `csrf()` on POST | 403 in tests, "security is broken" |
| `@WithMockUser` on resource-server tests | 401; filter ignored the mock user |
| `@WebMvcTest` without security config | Default 401 everywhere |
| Testing only MVC, never method security | Open service methods callable from a scheduled job |
| `jwt().authorities(...)` **and** a converter that overwrites them | Test doesn't match prod converter behavior — know which one MockMvc uses |
| `@WithUserDetails` but no `UserDetailsService` bean in slice | Test context fail |

### Debugging scenario

**Observe.** `@WebMvcTest` returns 401 for `permitAll` matcher `/api/public/health`.

**Diagnose.** Your `SecurityFilterChain` bean is not in the slice. Boot's default user (`user`/`security.user.password`) is in play, or default auto-config `anyRequest().authenticated()`. Print `mvc.perform(get("/api/public/health")).andDo(print())` and look at which filters ran.

**Fix.** `@Import(SecurityConfig.class)` or `@SpringBootTest` + `@AutoConfigureMockMvc`. Assert TRACE in a failing test. Add a smoke test that `GET /api/public/health` is 200 **without** user().

---

## 20. Spring Security 6.x Changes

### Core concept

Spring Security 6 ships with Spring Boot 3 / Jakarta EE 9+ (`javax.*` → `jakarta.*`). The philosophical shift: **authorization is `AuthorizationManager`, configuration is lambda DSL, adapters are gone, CSRF is deferred + XOR, session context is deferred, observability is first-class.**

If you migrated by "making it compile," you missed CSRF SPA breakage, `authorizeRequests` deprecation semantics, and `FilterSecurityInterceptor` replacement.

### WebSecurityConfigurerAdapter is gone

Removed in 5.7 as deprecated; **absent in 6.0**. There is no subclass. Every `configure(HttpSecurity http)` becomes a `@Bean SecurityFilterChain`. Every `configure(AuthenticationManagerBuilder auth)` becomes provider/userDetailsService/passwordEncoder beans (or an explicit `ProviderManager` `@Bean`). Every `configure(WebSecurity web)` `ignoring()` becomes:

```java
@Bean
WebSecurityCustomizer webSecurityCustomizer() {
    return web -> web.ignoring().requestMatchers("/static/**");
}
```

**Do not ignore** security for `/api/**` to "make performance better." `ignoring()` bypasses **the entire chain** including headers, CSRF, and logging. Use `permitAll()` instead.

### Lambda DSL

```java
// 5.x style (gone)
http.csrf().disable().authorizeRequests().antMatchers("/api/**").authenticated().and().httpBasic();

// 6.x
http
    .csrf(AbstractHttpConfigurer::disable)
    .authorizeHttpRequests(a -> a.requestMatchers("/api/**").authenticated())
    .httpBasic(Customizer.withDefaults());
```

There is no `.and()`. Nested configurers take a `Customizer<T>`. `Customizer.withDefaults()` means "enable this feature with defaults."

### `authorizeRequests` → `authorizeHttpRequests`

`authorizeRequests()` used `FilterSecurityInterceptor` + `AccessDecisionManager` + voters. `authorizeHttpRequests()` uses `AuthorizationFilter` + `AuthorizationManager`. Mixing both on one `HttpSecurity` is undefined-territory. Use only `authorizeHttpRequests`.

`antMatchers` / `mvcMatchers` / `regexMatchers` → `requestMatchers`. `requestMatchers` uses MVC matchers **if** Spring MVC is on the classpath, otherwise Ant. Trailing-slash and path-pattern parsing follow Spring Framework 6 PathPattern (`/api/{id}`), which is stricter than legacy Ant in some edge cases (`**` in the middle).

### CSRF deferred + XOR

Covered in [CSRF](#8-csrf). Boot 3 + SPA + cookie = you must materialize the token and decide XOR vs raw. This is the highest-volume 6.x production regression.

### SecurityContextPersistenceFilter → SecurityContextHolderFilter

Context load is deferred. `request.getSession()` in an early filter is more likely to **create** sessions you didn't see in 5.x, or **not** create ones you expected if nothing reads the context. Explicit `SessionCreationPolicy.STATELESS` + `NullSecurityContextRepository` for APIs.

### Method security

`@EnableGlobalMethodSecurity(prePostEnabled = true)` → `@EnableMethodSecurity`. Default is pre-post on. `mode = AdviceMode.PROXY` still misses self-invocation. `AuthorizationManager` customization via `ObjectPostProcessor` or `AuthorizationManagerBeforeMethodInterceptor`.

### Observability (6.1+)

Micrometer observations around authentications and authorizations. Useful; also **PII risk** if you include usernames in high-cardinality tags. Tune:

```yaml
management:
  observations:
    enable:
      spring.security.authentications: true
```

Don't put tokens in span attributes.

### Other 6.x landmines

| Change | Production effect |
|---|---|
| Jakarta namespace | `javax.servlet` filters from old libraries never fire |
| `OncePerRequestFilter` skips ERROR dispatch more aggressively | Missing headers on `/error` |
| Default `requestCache` still saves requests | Stateless APIs unexpectedly redirect; disable request cache |
| `PasswordEncoderFactories` unchanged but Boot 3 apps more often hit `{id null}` during upgrades | See password section |
| `StrictHttpFirewall` still rejects `%0a`, `;`, `//` | Clients encoding path params break with 400 `RequestRejectedException` — not a 401 |
| Session cookie SameSite Boot defaults | Cross-site SPAs lose session |
| `FilterChainProxy` + multiple chains required for mixed architectures | Single-chain OAuth2 login + resource server fights over entry points |
| 6.4 WebAuthn / OTT | New surface; RP ID / origin misconfig |

### Production scenario: mechanical adapter migration that compiled and still used `authorizeRequests`

**Problem.** Team replaced the class but kept:

```java
@Bean
SecurityFilterChain chain(HttpSecurity http) throws Exception {
    http.authorizeRequests().antMatchers("/actuator/health").permitAll()
        .anyRequest().authenticated();
    return http.build();
}
```

On 6.1 this is deprecated; on later 6.x it may fail to compile. Worse intermediate: it compiles, MVC `PathPattern` vs Ant mismatch, `/actuator/health/` 401s, Kubernetes kills the pod.

**Solution — canonical 6.x skeleton:**

```java
@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain app(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.ignoringRequestMatchers("/api/**")) // only if /api is bearer-only
            .headers(h -> h.contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'self'")))
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
            .authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .requestMatchers("/api/**").authenticated()
                .anyRequest().denyAll())
            .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()))
            .exceptionHandling(e -> e
                .authenticationEntryPoint(new BearerTokenAuthenticationEntryPoint())
                .accessDeniedHandler(new BearerTokenAccessDeniedHandler()));
        return http.build();
    }
}
```

Then split chains when you add a UI. Do not leave `authorizeRequests` in a "we'll fix warnings later" state.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `web.ignoring()` for APIs | No security headers, no logs, open CSRF if cookies exist |
| SPA CSRF not updated for XOR/deferred | 403 on all POST after upgrade |
| One chain for login + resource server | Redirect vs JSON lottery |
| `antMatchers` copied into `requestMatchers` with `**` in the middle | Pattern parse errors or missed matches |
| Leaving `WebSecurityConfigurerAdapter` on the classpath via an old starter | Two competing security setups, duplicate filters, random 401 |

### Debugging scenario

**Observe.** After Boot 3 upgrade, only the SPA breaks (403 CSRF). curl with Bearer still works. Form login in Thymeleaf still works (`th:action` injects CSRF).

**Diagnose.** Classic 6.x CSRF XOR + deferred. Thymeleaf uses the request attribute (masked token). SPA echoes the cookie (raw). TRACE `CsrfFilter` shows token mismatch, both values logged in TRACE — do not enable TRACE in prod with real tokens.

**Fix.** Section 8 solution: materialize cookie + `CsrfTokenRequestAttributeHandler` (non-XOR) **or** have the SPA read the token from a JSON endpoint / response header that Spring renders via the request handler. Prefer BFF so the SPA isn't in the CSRF business.

---

## 21. Production Debugging Playbook

When a security bug is "random," it is usually **which chain matched**, **which filter rejected**, or **which thread lost the context**.

1. **Classify the status code.** 400 `RequestRejectedException` = firewall. 401 = authentication. 403 = authorization or CSRF. 302 to `/login` = form-login entry point. CORS error in the **console** with a hidden 401 = CORS filter missing on that chain.

2. **Enable targeted TRACE on a canary instance**, not the whole fleet:

   ```yaml
   logging.level.org.springframework.security=TRACE
   ```

   Read `FilterChainProxy` "will use the filter chain" line. Then the first filter that calls `sendError` / `commence` / `AccessDenied`.

3. **Dump the Authentication** (never credentials) in a staging-only filter: class name, `authenticated`, authorities, principal class. `JwtAuthenticationToken` vs `AnonymousAuthenticationToken` vs `OAuth2AuthenticationToken` tells you which filter "won."

4. **Confirm what the app saw as URI.** Gateway prefix strip, context path, `Forwarded` headers. Matchers match the **servlet** path.

5. **For JWT:** decode payload offline, check `iss`/`aud`/`exp`/`kid`, JWK endpoint reachability, clock.

6. **For method security:** is the interceptor in the stack? Self-invocation? Principal type?

7. **For async/reactive:** which thread, is it a pool, is the context empty?

8. **Turn TRACE off.** It logs tokens, CSRF secrets, and usernames.

Actuator `sbom` / `/actuator/env` will leak `spring.security.oauth2.client.registration.*.client-secret` if not sanitized. Keep `keys-to-sanitize` current.

---

## 22. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Browser app, same origin, cookies | Session + CSRF on + SameSite Lax + Spring Session if >1 node |
| SPA on another origin | BFF same-origin **or** Bearer + CORS without credentials; do not cookie-auth cross-site unless you fully understand SameSite=None + CSRF |
| Public API, mobile, machine clients | Resource server JWT/opaque, CSRF off, STATELESS, no JSESSIONID |
| Users login via Okta/Google | `oauth2Login` (session) or BFF; don't mint homemade JWTs in the SPA |
| Service-to-service | Client credentials, `aud` restricted, short TTL |
| Enterprise SSO XML | SAML2 SP, metadata URL, public ACS HTTPS |
| Per-document sharing | ACL or a permission table; never `@PostFilter` a big list |
| Per-tenant isolation | Tenant in the token **and** in every SQL predicate; not only in SpEL |
| MFA | Prefer IdP ACR; if local, pending authority until factor 2; never remember-me full auth |
| Mixed UI + API | **Two** `SecurityFilterChain`s, not one clever entry point |

---

*Spring Security will not save a missing tenant predicate in SQL. The filter chain authenticates; your domain rules authorize. Keep those layers explicit, test both, and never debug production with TRACE left on.*
