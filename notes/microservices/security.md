# Microservices Security Mastery — Senior Production Reference

Spring Boot 3.x / Spring Security 6.x / Spring Cloud 2023.x. Servlet stack and reactive (WebFlux) paths are both covered; mesh and gateway patterns are explicit. This is not a getting-started guide. It is the map of what actually breaks in production after shipping OAuth2, JWT, mTLS, and "internal only" APIs that were never actually internal.

---

## Table of Contents

1. [Mental Model: One Request Through the Security Mesh](#1-mental-model-one-request-through-the-security-mesh)
2. [Microservices Security — Defense in Depth](#2-microservices-security-defense-in-depth)
3. [Authentication — Who Is Calling?](#3-authentication-who-is-calling)
4. [Authorization — May They Do This?](#4-authorization-may-they-do-this)
5. [OAuth2 — Grants, Clients, Resource Servers](#5-oauth2-grants-clients-resource-servers)
6. [OpenID Connect — Identity on Top of OAuth2](#6-openid-connect-identity-on-top-of-oauth2)
7. [JWT — Tokens, Validation, Failure Modes](#7-jwt-tokens-validation-failure-modes)
8. [Service-to-Service Authentication](#8-service-to-service-authentication)
9. [Token Propagation](#9-token-propagation)
10. [mTLS — Mutual TLS and Workload Identity](#10-mtls-mutual-tls-and-workload-identity)
11. [Secrets Management](#11-secrets-management)
12. [Zero Trust Architecture](#12-zero-trust-architecture)
13. [API Security — Gateway, Rate Limits, Validation](#13-api-security-gateway-rate-limits-validation)
14. [CORS in Microservices](#14-cors-in-microservices)
15. [CSRF in Distributed and SPA Architectures](#15-csrf-in-distributed-and-spa-architectures)
16. [Certificate Management](#16-certificate-management)
17. [Key Rotation](#17-key-rotation)
18. [Encryption at Rest](#18-encryption-at-rest)
19. [Encryption in Transit](#19-encryption-in-transit)
20. [Production Debugging Playbook](#20-production-debugging-playbook)
21. [Quick Decision Matrix](#21-quick-decision-matrix)
22. [Interview Q&A](#22-interview-qa)

---

## 1. Mental Model: One Request Through the Security Mesh

Microservice security is not "put Spring Security on each service." It is a **layered trust boundary** where every hop — browser → gateway → BFF → domain service → database — can independently authenticate, authorize, encrypt, and audit. A token that was valid at the edge can be wrong downstream. A service on a "private" VPC is still reachable from a compromised pod.

```
Browser / Mobile
  └─ TLS 1.3 (public cert, HSTS)
       └─ API Gateway / WAF
            ├─ JWT validation (iss, aud, exp, signature)
            ├─ rate limit, IP allowlist, bot detection
            └─ route to BFF or service
                 └─ BFF (session or token exchange)
                      ├─ propagate user JWT OR mint downstream token
                      └─ Feign/WebClient → Order Service
                           ├─ resource server: validate JWT / mTLS peer
                           ├─ authorizeHttpRequests + @PreAuthorize
                           └─ JDBC with tenant predicate (not filter-only)
                                └─ encrypted column / TDE at DB layer
```

Three objects you must keep distinct at every layer:

| Object | Question it answers | Typical microservices artifact |
|---|---|---|
| **Authentication** | Who is the caller? | User JWT, client-credentials token, SPIFFE SVID, mTLS cert subject |
| **Authorization** | Is this action allowed on this resource? | RBAC scopes, OPA policy, row-level tenant filter |
| **Transport security** | Are bytes protected on the wire? | TLS, mTLS, mesh sidecar |

A **401** at the gateway means the client never proved identity (missing/expired/invalid token). A **403** means identity was established but policy denied. A **502/503** from the gateway while the backend returns **401** means the gateway misconfigured auth or the upstream rejected the forwarded credential — do not confuse network failure with auth failure.

The golden rule: **never trust the network**. Internal REST without auth is a liability that becomes an incident the day one SSRF, compromised dependency, or mis-routed ingress exposes it.

---

## 2. Microservices Security — Defense in Depth

### Core concept

Defense in depth stacks **independent controls** so one failure does not open the system. In microservices that means:

| Layer | Control | What it stops |
|---|---|---|
| Edge | WAF, DDoS, geo block | Obvious abuse, volumetric attacks |
| Gateway | OAuth2, JWT validation, rate limits | Unauthenticated traffic, token replay at scale |
| Service | Resource server, method security | Lateral movement after one breach |
| Data | Encryption at rest, column-level crypto | Disk theft, backup leak |
| Network | mTLS, network policies | Pod-to-pod impersonation |
| Ops | Secrets vault, audit logs, key rotation | Long-lived credential theft |

"Microservice" boundaries are **organizational and deployable**, not security perimeters. Treat every service API as **zero-trust**: authenticate the caller, authorize the operation, log the decision.

### Internal working (Spring ecosystem)

1. **Spring Cloud Gateway** — reactive gateway with `TokenRelay`, `Spring Security` filters, Redis rate limiting.
2. **Spring Authorization Server** (or Keycloak, Okta, Auth0) — issues tokens; services are resource servers.
3. **Spring Security OAuth2 Resource Server** — `oauth2ResourceServer().jwt()` validates Bearer tokens per request.
4. **Service mesh** (Istio/Linkerd) — mTLS and optional JWT validation at sidecar without app code.

Each service should have its own **security filter chain** for actuator vs API paths (see Spring Security reference). Gateway validation does not remove the need for service-side validation — gateway bypass via direct pod access, misconfigured NetworkPolicy, or debug port is routine in incidents.

### Production scenario: "internal" API with no auth

**Problem.** Inventory service exposes `POST /api/v1/stock/{sku}/adjust` on the cluster network only. Security review assumed "not public." A compromised marketing-site pod (SSRF) hits `http://inventory-service.default.svc.cluster.local/api/v1/stock/ABC/adjust` and wipes stock. Logs show no `Authorization` header — service never checked.

**Solution.**

```java
@Bean
@Order(2)
SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
    http
        .securityMatcher("/api/**")
        .authorizeHttpRequests(auth -> auth
            .requestMatchers("/api/v1/stock/**").hasAuthority("SCOPE_inventory.write")
            .anyRequest().authenticated()
        )
        .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()))
        .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .csrf(AbstractHttpConfigurer::disable);
    return http.build();
}
```

Pair with **NetworkPolicy** denying ingress except from order-service and gateway namespaces. Network policy is not auth — it limits blast radius.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auth only at gateway | Direct service call bypasses all security |
| Shared JWT secret across envs | Staging token works in prod |
| One global `permitAll()` for `/api/**` in dev that ships to prod | Open API in production |
| Trusting `X-User-Id` header from client | Header spoofing — identity must come from validated token |
| Logging full JWT in application logs | Credential leak in log aggregator |

### Debugging scenario

**Observe.** Pen test finds unauthenticated access to `/api/v1/admin/users` on port 8080 inside the cluster.

**Diagnose.** `kubectl exec` into any pod, curl service ClusterIP. Check which `SecurityFilterChain` matched — actuator chain with `permitAll` too broad, or missing `securityMatcher` so wrong chain runs.

**Fix.** Narrow matchers, require authentication on all business APIs, verify with in-cluster curl **without** token expecting 401.

---

## 3. Authentication — Who Is Calling?

### Core concept

Authentication establishes **identity** (human user, service account, device). In microservices you usually have **multiple authentication modes** on different paths:

| Caller type | Typical mechanism | Token shape |
|---|---|---|
| Human via browser | OIDC login → session at BFF, or SPA Bearer | Session cookie or access JWT |
| Mobile app | OAuth2 authorization code + PKCE | Short-lived access JWT |
| Partner API | Client credentials or mTLS + API key | JWT or opaque token |
| Service-to-service | Client credentials, workload identity, mTLS | JWT with `aud` = target service |

Spring Security 6: authentication happens in **filters** (`BearerTokenAuthenticationFilter`, `OAuth2LoginAuthenticationFilter`) before `AuthorizationFilter`.

### Internal working

`BearerTokenAuthenticationFilter` extracts `Authorization: Bearer <token>`, delegates to `AuthenticationManager` backed by `JwtAuthenticationProvider` or `OpaqueTokenAuthenticationProvider`.

For JWT:

1. Parse header (alg, kid).
2. Resolve signing key from JWK Set URI or local `JwtDecoder` bean.
3. Validate `exp`, `nbf`, `iss`, `aud` (if configured).
4. Build `Jwt` object and `JwtAuthenticationToken` with authorities from `JwtAuthenticationConverter`.

Clock skew: default leeway is small — pods with drifted clocks see intermittent 401.

### Production scenario: intermittent 401 on JWT validation

**Problem.** Mobile users report random logouts. Metrics show spikes of 401 on resource servers. All pods healthy. IdP status green.

Cause: **clock skew** on two nodes (NTP drift) plus **short access token TTL** (60s). Tokens appear expired on skewed pods. Secondary cause: **JWK rotation** — old `kid` removed from JWKS before all pods refreshed.

**Solution.**

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.example.com/realms/prod
          # Boot builds JwtDecoder from issuer metadata
```

Ensure NTP on all nodes. For custom decoder:

```java
@Bean
JwtDecoder jwtDecoder() {
    NimbusJwtDecoder decoder = NimbusJwtDecoder
        .withJwkSetUri("https://auth.example.com/realms/prod/protocol/openid-connect/certs")
        .build();
    decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
        JwtValidators.createDefaultWithIssuer("https://auth.example.com/realms/prod"),
        new JwtTimestampValidator(Duration.ofSeconds(30)) // leeway
    ));
    return decoder;
}
```

Stagger JWK publishing: keep old key in JWKS until all decoders have cached new key (overlap window).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `issuer-uri` wrong for environment | 401 every request |
| Missing `aud` validation | Token from another API accepted |
| `alg: none` accepted (custom decoder) | Critical vulnerability |
| Principal is JWT string, not claims | `@PreAuthorize` on custom principal fails |

### Debugging scenario

**Observe.** 401 with `BearerTokenAuthenticationError` in logs: "An error occurred while attempting to decode the Jwt: Signed JWT rejected: Invalid signature".

**Diagnose.** Decode JWT header offline (jwt.io only in dev — never paste prod tokens into third parties). Compare `kid` with JWKS. Check if gateway re-signed token with different key. Verify `issuer-uri` matches token `iss`.

**Fix.** Align signing keys, configure `issuer-uri`, ensure gateway does not strip `Authorization`.

---

## 4. Authorization — May They Do This?

### Core concept

Authorization answers **whether an authenticated principal may perform an action on a resource**. Microservices need authorization at:

1. **HTTP layer** — `authorizeHttpRequests` (path + method).
2. **Method layer** — `@PreAuthorize`, `@PostAuthorize`.
3. **Data layer** — tenant/owner filter in repository queries.

Relying only on gateway route rules is insufficient — services must enforce policy. **RBAC** (roles), **ABAC** (attributes: tenant, region, resource owner), and **policy engines** (OPA, Cedar) scale differently.

| Model | Fits when | Spring expression |
|---|---|---|
| RBAC | Fixed roles, few dimensions | `hasRole('ADMIN')`, `hasAuthority('SCOPE_orders.read')` |
| ABAC | Multi-tenant, owner checks | `@PreAuthorize("@authz.canAccessOrder(#id)")` |
| ReBAC | Graph relationships | External OPA query |

OAuth2 scopes map to authorities: `SCOPE_orders.read` from `scope` claim or custom converter.

### Internal working

`AuthorizationFilter` (HTTP) and `MethodSecurityInterceptor` (AOP) call `AuthorizationManager`. SpEL in `@PreAuthorize` runs after authentication — if authentication is anonymous, `authenticated()` expressions fail.

Multi-tenant: tenant id must be in **token** (or derived from validated identity) and in **every SQL query** — not only in a gateway header you trust without validation.

### Production scenario: admin role in JWT but 403 on service

**Problem.** User has `admin` in Keycloak realm role. API gateway allows `/api/admin/**`. Order service returns 403. TRACE shows `JwtAuthenticationToken` with authorities `[SCOPE_openid, SCOPE_profile]` only — no `ROLE_admin`.

Cause: **JwtAuthenticationConverter** not mapping realm roles to `GrantedAuthority`. Default converter only maps `scope` claim.

**Solution.**

```java
@Bean
JwtAuthenticationConverter jwtAuthenticationConverter() {
    JwtGrantedAuthoritiesConverter scopes = new JwtGrantedAuthoritiesConverter();
    scopes.setAuthorityPrefix("SCOPE_");

    Converter<Jwt, Collection<GrantedAuthority>> realmRoles = jwt -> {
        Map<String, Object> realmAccess = jwt.getClaimAsMap("realm_access");
        if (realmAccess == null) return List.of();
        @SuppressWarnings("unchecked")
        List<String> roles = (List<String>) realmAccess.get("roles");
        return roles.stream()
            .map(r -> new SimpleGrantedAuthority("ROLE_" + r))
            .collect(Collectors.toList());
    };

    JwtAuthenticationConverter converter = new JwtAuthenticationConverter();
    converter.setJwtGrantedAuthoritiesConverter(jwt -> {
        Collection<GrantedAuthority> combined = new ArrayList<>();
        combined.addAll(scopes.convert(jwt));
        combined.addAll(realmRoles.convert(jwt));
        return combined;
    });
    return converter;
}
```

Register on resource server:

```java
http.oauth2ResourceServer(oauth -> oauth
    .jwt(jwt -> jwt.jwtAuthenticationConverter(jwtAuthenticationConverter())));
```

### Production scenario: horizontal privilege escalation via missing tenant filter

**Problem.** User A sees User B's orders. Both authenticated. `@PreAuthorize("hasAuthority('SCOPE_orders.read')")` passes. Repository method `findById(id)` has no tenant check.

**Solution.**

```java
@PreAuthorize("@orderAuth.canRead(#id)")
public OrderDto getOrder(long id) { ... }

@Component
public class OrderAuth {
    public boolean canRead(long orderId) {
        String tenant = TenantContext.require();
        return orderRepository.existsByIdAndTenantId(orderId, tenant);
    }
}
```

Never use client-supplied `X-Tenant-Id` without matching token claim `tenant_id`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `hasRole("ADMIN")` vs authority `ADMIN` without ROLE_ prefix | Silent 403 for all admins |
| Method security disabled | HTTP secured, service methods open from scheduler |
| Self-invocation without proxy | `@PreAuthorize` skipped on internal `this.cancel()` |
| Gateway-only authorization | Bypass via internal network |

### Debugging scenario

**Observe.** 403 on `DELETE /api/v1/orders/42` for user who "owns" the order.

**Diagnose.** Log authorities on `JwtAuthenticationToken`. Check HTTP matcher order — `anyRequest().authenticated()` before owner check. Enable `AuthorizationFilter` TRACE. Verify `@EnableMethodSecurity` present.

**Fix.** Owner SpEL or policy service; ensure DELETE matcher requires correct scope `SCOPE_orders.delete` or custom `canDelete`.

---

## 5. OAuth2 — Grants, Clients, Resource Servers

### Core concept

OAuth2 is an **authorization framework** — it delegates access without sharing the user's password with every microservice. Components:

| Role | Responsibility | Spring Boot artifact |
|---|---|---|
| Authorization Server | Issues tokens, manages clients | Spring Authorization Server, Keycloak |
| Client | Obtains token on behalf of user or itself | `OAuth2AuthorizedClientManager`, gateway |
| Resource Server | Validates token, serves protected API | `oauth2ResourceServer()` |

**Grants** (what you actually use in prod):

| Grant | Use case | Never use when |
|---|---|---|
| Authorization Code + PKCE | Browser, mobile, SPA with BFF | N/A for public clients without PKCE |
| Client Credentials | Service-to-service | Human login |
| Refresh Token | Long-lived session without re-login | Stored insecurely in SPA |
| Device Code | TV, CLI | High-security without user education |

**Deprecated / forbidden:** Implicit grant, Resource Owner Password Credentials in new systems.

### Internal working (Client Credentials)

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
            .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()));
        return http.build();
    }
}

@Configuration
public class OAuthClientConfig {

    @Bean
    OAuth2AuthorizedClientManager authorizedClientManager(
            ClientRegistrationRepository clients,
            OAuth2AuthorizedClientService clientService) {
        OAuth2AuthorizedClientProvider provider = OAuth2AuthorizedClientProviderBuilder.builder()
            .clientCredentials()
            .build();
        AuthorizedClientServiceOAuth2AuthorizedClientManager manager =
            new AuthorizedClientServiceOAuth2AuthorizedClientManager(clients, clientService);
        manager.setAuthorizedClientProvider(provider);
        return manager;
    }
}
```

Feign interceptor:

```java
@Bean
public RequestInterceptor oauth2FeignInterceptor(OAuth2AuthorizedClientManager manager) {
    return template -> {
        OAuth2AuthorizeRequest request = OAuth2AuthorizeRequest
            .withClientRegistrationId("inventory-client")
            .principal("inventory-service")
            .build();
        OAuth2AuthorizedClient client = manager.authorize(request);
        if (client != null) {
            template.header(HttpHeaders.AUTHORIZATION,
                "Bearer " + client.getAccessToken().getTokenValue());
        }
    };
}
```

### Production scenario: token audience mismatch

**Problem.** Order service obtains client-credentials token from Keycloak. Inventory service returns 401. Inventory validates `aud` must contain `inventory-api`. Token `aud` is `account` or client id only.

**Solution.** Configure authorization server **audience mapper** or **client scope** so access token includes `aud: inventory-api`. On resource server:

```java
decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
    JwtValidators.createDefaultWithIssuer(issuer),
    new JwtClaimValidator<List<String>>("aud", aud -> aud != null && aud.contains("inventory-api"))
));
```

Document **audience per downstream** — one mega-token for all services violates least privilege.

### Production scenario: refresh token rotation failure

**Problem.** BFF stores refresh token in encrypted cookie. After Keycloak enables refresh token rotation, old refresh reused → entire session revoked, mass logout.

**Solution.** BFF must store **new** refresh token on every refresh response. Single-use refresh handling in `OAuth2AuthorizedClientService` update path. Monitor `invalid_grant` rates.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Client secret in frontend | Secret stolen, client impersonation |
| No PKCE on public SPA client | Authorization code interception |
| Long-lived access token (hours) | Stolen token window huge |
| Same client id for all services | Cannot revoke one caller |

### Debugging scenario

**Observe.** `invalid_client` on token endpoint.

**Diagnose.** Client auth method: `client_secret_basic` vs `client_secret_post` vs `private_key_jwt`. Keycloak client "Service accounts" enabled for client credentials.

**Fix.** Align registration in `application.yml` with IdP admin console.

---

## 6. OpenID Connect — Identity on Top of OAuth2

### Core concept

OIDC adds **identity layer** to OAuth2: standardized ID Token (JWT), UserInfo endpoint, discovery (`/.well-known/openid-configuration`). Use OIDC when you need **who the user is** (subject, email, groups), not only **what they can access** (scopes).

| Token | Purpose | Validate on |
|---|---|---|
| ID Token | Identity proof for client | BFF / browser client (not usually forwarded to microservices) |
| Access Token | API authorization | Resource servers |

**Discovery** — Boot resolves endpoints from issuer:

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-id: bff-app
            client-secret: ${KEYCLOAK_SECRET}
            scope: openid,profile,email
        provider:
          keycloak:
            issuer-uri: https://auth.example.com/realms/prod
```

### Internal working (`oauth2Login`)

1. Redirect to authorization endpoint with `response_type=code`, `scope=openid`, PKCE.
2. Callback with `code` → token endpoint exchange.
3. `OidcUserService` loads `OidcUser` from ID Token + optional UserInfo.
4. Session created (if not STATELESS) with authenticated principal.

BFF pattern: browser has **session cookie** to BFF only; BFF holds tokens server-side and calls microservices with access token or exchanges for downstream token.

### Production scenario: ID token sent to microservices

**Problem.** SPA sends `id_token` as Bearer to order API. Service accepts it because signature valid. ID token is for **client authentication of user identity**, not API access — wrong `aud` (client id), wrong lifetime semantics, increases leak surface.

**Solution.** Resource servers accept **access tokens only**. Reject tokens with `typ` or use scope-only validation. Educate frontend teams.

### Production scenario: logout does not log out

**Problem.** User clicks logout on SPA; local storage cleared. Keycloak session still active; silent renew succeeds.

**Solution.** RP-initiated logout:

```java
http.logout(logout -> logout
    .logoutSuccessHandler(oidcLogoutSuccessHandler()));
```

Redirect to IdP end-session endpoint with `id_token_hint` and `post_logout_redirect_uri`. For BFF, clear server session and IdP session together.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `openid` scope omitted | No ID token, broken login |
| Wrong redirect URI | `redirect_uri_mismatch` |
| HTTP redirect URI in prod | Token interception |
| Trusting `email` claim without verification | Account takeover via IdP misconfig |

### Debugging scenario

**Observe.** `oauth2Login` 401 after successful IdP login.

**Diagnose.** Cookie `SameSite`, reverse proxy `X-Forwarded-Proto`, session cookie not set on HTTPS. Check `OAuth2LoginAuthenticationFilter` TRACE.

**Fix.** `server.forward-headers-strategy=framework`, secure cookie, correct public URL in IdP.

---

## 7. JWT — Tokens, Validation, Failure Modes

### Core concept

JWT is a **signed (or MACed) JSON payload**, not encrypted by default. Anyone can read claims — do not put secrets in JWT. Structure: `header.payload.signature`.

| Claim | Meaning | Validation |
|---|---|---|
| `iss` | Issuer | Must match configured issuer |
| `sub` | Subject (user or client id) | Identity key |
| `aud` | Intended recipients | Must include this API |
| `exp` / `iat` / `nbf` | Time bounds | Clock skew leeway |
| `scope` / `scp` | OAuth scopes | Authorization |
| `tenant_id` | Multi-tenant | Must match data access |

**Signing algorithms:** RS256/ES256 ( asymmetric, JWKS) preferred for distributed validators. HS256 shared secret only when **one** issuer and all validators can hold secret securely.

### Internal working (validation pipeline)

```
Bearer token
  → parse JWS
  → resolve key by kid from JWKS
  → verify signature
  → validate temporal claims
  → validate iss/aud custom validators
  → JwtAuthenticationConverter → authorities
  → SecurityContext
```

**JWE** (encrypted JWT) — rare in internal microservices; use TLS for transport confidentiality.

### Production scenario: JWT bloat breaks gateways

**Problem.** Keycloak mapper adds full group hierarchy, permissions JSON, and profile blob to access token. Tokens exceed 8KB. Nginx returns 400, Envoy resets connection. Latency spikes on every request (huge headers).

**Solution.** Minimal access token: `sub`, `scope`, `tenant_id`, short TTL. Load permissions via **token exchange**, local cache, or dedicated authorization service on demand. Use **reference tokens** (opaque) at edge if size unfixable.

### Production scenario: algorithm confusion

**Problem.** Custom `JwtDecoder` allows `alg: HS256` with public key bytes misused as HMAC secret (legacy vulnerability pattern).

**Solution.** Use `NimbusJwtDecoder.withJwkSetUri` — restricts algorithms to JWKS key types. Never accept `none`. Pin expected algorithms in decoder builder.

### Production scenario: stolen JWT replay

**Problem.** Attacker captures JWT from logs or MITM on misconfigured endpoint. Replays until `exp`.

**Mitigations:**

| Control | Effect |
|---|---|
| Short TTL (5–15 min access) | Limits replay window |
| Refresh token rotation | Stolen refresh detected |
| DPoP / mTLS binding | Token bound to client key |
| `jti` + replay cache | One-time tokens for high-risk ops |

Spring Authorization Server supports **custom validators** for `jti` denylist.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| PII in JWT | GDPR leak via logs, browser storage |
| No `aud` check | Cross-service token reuse |
| Symmetric key in 50 services | Rotation nightmare, leak blast radius |
| Trusting unverified claims in gateway only | Bypass by calling service directly |

### Debugging scenario

**Observe.** Valid token works on gateway, 401 on service.

**Diagnose.** Different `issuer-uri`, different `aud` validator, gateway strips `Authorization`, service behind strip prefix changes path not auth.

**Fix.** Align decoder config; use service mesh tap to compare headers.

---

## 8. Service-to-Service Authentication

### Core concept

Human JWTs should not be the only inter-service credential. Patterns:

| Pattern | Identity | Pros | Cons |
|---|---|---|---|
| Client credentials JWT | `client_id` as `sub` | Standard OAuth2, scopes | Token management, rotation |
| mTLS | SPIFFE ID in cert SAN | Strong peer binding, no bearer in app | PKI ops, cert lifecycle |
| Workload identity (K8s/AWS) | IAM role / K8s SA token | Cloud-native | Cloud-specific |
| Signed requests (AWS SigV4) | Access key / IAM | No bearer token | Not OAuth ecosystem |

**Golden rule:** service identity ≠ user identity. When order service calls inventory **on behalf of user**, use **delegation** (propagate user token if audience allows) or **token exchange** (trade user token for inventory-scoped token). When calling **system action**, use **client credentials**.

### Internal working (Kubernetes service account token)

```java
// Projected SA token mounted at path — use for K8s API or cloud OIDC federation
String token = Files.readString(Path.of("/var/run/secrets/kubernetes.io/serviceaccount/token"));
// Exchange via cloud provider OIDC for AWS/GCP role — not for arbitrary microservice REST without platform support
```

For generic microservices on K8s, **client credentials to IdP** or **mesh mTLS** is more portable than SA tokens to every app.

### Production scenario: every service uses same client secret

**Problem.** One `internal-services` client, shared secret in 40 ConfigMaps. Developer laptop leak exposes all service auth.

**Solution.** **One OAuth2 client per service** (or per deployment unit) with **client credentials** and scoped `aud`. Secrets in Vault; rotate per client. CI audits secret duplication.

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          order-to-inventory:
            provider: keycloak
            client-id: order-service
            client-secret: ${ORDER_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: inventory.read
```

### Production scenario: service chain without delegation limits

**Problem.** User with `orders.read` calls BFF → order → inventory → pricing. Each hop forwards same user JWT. Pricing token scope includes `pricing.admin` because pricing never validates scope — user escalates via path.

**Solution.** **Token exchange** at each hop or **policy on each service**. Pricing validates `SCOPE_pricing.read` only. Consider **downscoping** via OAuth2 Token Exchange (RFC 8693) — Spring Authorization Server 1.x / Keycloak token exchange.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Static API keys in query string | Keys in access logs |
| Mutual TLS optional | Downgrade to plaintext inside mesh misconfig |
| No credential rotation | Years-old secrets in git history |

### Debugging scenario

**Observe.** Feign calls return 401 after IdP upgrade.

**Diagnose.** Client authentication method changed to `private_key_jwt`. Feign still sends `client_secret_post`.

**Fix.** Update client registration; use `ClientAuthenticationMethod.CLIENT_SECRET_BASIC` or JWT assertion per IdP docs.

---

## 9. Token Propagation

### Core concept

Token propagation is **how user context flows** across service boundaries:

```
Option A — Pass-through: forward incoming Bearer JWT to downstream
Option B — BFF holds token: server-side only, browser never sees access token
Option C — Token exchange: trade token for new token with narrower aud/scope
Option D — Session cookie: only BFF sees cookie; microservices see service token + user id header signed by BFF
```

| Option | Leak risk | Complexity | Downstream aud |
|---|---|---|---|
| Pass-through | High if many hops | Low | Must accept same issuer |
| BFF | Lower | Medium | Service token per downstream |
| Exchange | Lower | High | Per-service audience |
| Signed internal header | Medium (trust BFF) | Medium | Must verify signature |

**Never** propagate tokens to external SaaS without review. **Never** log `Authorization` header.

### Internal working (Spring Cloud Gateway TokenRelay)

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: order-api
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
          filters:
            - TokenRelay
```

`TokenRelay` forwards OAuth2 access token from `ServerOAuth2AuthorizedClientExchangeFilterFunction` or security context.

Feign pass-through from incoming request:

```java
@Bean
RequestInterceptor userTokenRelayInterceptor() {
    return template -> {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof JwtAuthenticationToken jwtAuth) {
            // Only if downstream accepts same token — verify aud
            String token = jwtAuth.getToken().getTokenValue();
            template.header(HttpHeaders.AUTHORIZATION, "Bearer " + token);
        }
    };
}
```

Capture on request thread — `@Async` loses request context.

### Production scenario: lost token in async saga

**Problem.** Order saga `@Async` step calls inventory via Feign. `SecurityContextHolder` empty. Feign sends no Bearer. Inventory 401. Saga stuck.

**Solution.** Pass `accessToken` or `userId` + `tenantId` as saga payload at start. Use client credentials for system steps; user-scoped steps use token captured at saga initiation:

```java
public void startSaga(OrderRequest req, String bearerToken) {
    sagaStateStore.save(new SagaState(req, bearerToken));
    executeNextStep(sagaId);
}

@Bean
RequestInterceptor sagaTokenInterceptor(SagaContext sagaContext) {
    return template -> sagaContext.getBearerToken()
        .ifPresent(t -> template.header(HttpHeaders.AUTHORIZATION, "Bearer " + t));
}
```

Or `DelegatingSecurityContextRunnable` if token already in context on async boundary.

### Production scenario: gateway double Bearer

**Problem.** Client sends Bearer; gateway adds second `Authorization` header. Downstream parser confused, random 401.

**Solution.** Gateway filter: replace don't append. Validate single Bearer regex.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Token relay without aud check downstream | Over-privileged lateral movement |
| WebClient from @Async without capture | Anonymous downstream calls |
| Propagate ID token | Wrong token type, aud failures |

### Debugging scenario

**Observe.** Downstream logs show `Authorization: Bearer null`.

**Diagnose.** Thread hop without context. Feign interceptor runs on different thread than controller.

**Fix.** Request-scoped token holder; reactive: `ReactiveSecurityContextHolder` + `contextWrite`.

---

## 10. mTLS — Mutual TLS and Workload Identity

### Core concept

mTLS: **both client and server present X.509 certificates** during TLS handshake. Server validates client cert against trust store; client validates server cert. Identity = certificate **Subject** or **SAN URI** (SPIFFE: `spiffe://trust.domain/ns/default/sa/order-service`).

| Deployment | Who terminates mTLS | App awareness |
|---|---|---|
| Service mesh sidecar | Sidecar | Optional (localhost) |
| Ingress with mTLS | Ingress / gateway | HTTP behind proxy |
| App-level mTLS | Spring Boot `server.ssl.*` + client auth | Full — need trust store |

Mesh benefits: uniform policy, no Bearer token in app for east-west, automatic cert rotation via Istio CA / Linkerd.

### Internal working (Spring Boot server mTLS)

```yaml
server:
  port: 8443
  ssl:
    enabled: true
    client-auth: need
    key-store: classpath:server.p12
    key-store-password: ${SSL_KEYSTORE_PASSWORD}
    trust-store: classpath:truststore.p12
    trust-store-password: ${SSL_TRUSTSTORE_PASSWORD}
```

```java
http.authorizeHttpRequests(auth -> auth
    .anyRequest().authenticated())
.x509(x509 -> x509
    .subjectPrincipalRegex("CN=(.*?)(?:,|$)")
    .userDetailsService(certUserDetailsService()));
```

SPIFFE/SPIRE issues SVIDs; mesh maps to policy.

### Production scenario: mesh mTLS strict, legacy service plaintext

**Problem.** Istio `PeerAuthentication` STRICT. Legacy inventory pod not in mesh. Order sidecar rejects plaintext. All calls fail with UF (upstream connection failure).

**Solution.** Gradual rollout: `PERMISSIVE` mode, inject sidecar into inventory, migrate, then STRICT. Or `DestinationRule` port-level exceptions **temporarily** with ticket to fix.

### Production scenario: certificate expiry Friday 5pm

**Problem.** Internal CA certs valid 90 days; automation failed. East-west TLS handshake fails fleet-wide.

**Solution.** cert-manager `Certificate` resources with auto-renew at 2/3 lifetime. Alert on `ssl_certificate_expiry` 30/7/1 days. Runbook for manual renew. Mesh CA usually handles — still alert.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `client-auth: want` vs `need` | Optional client cert — attacker skips |
| Shared private key across services | One leak impersonates all |
| Trust store with root CA too broad | Any cert from corp CA accepted |

### Debugging scenario

**Observe.** `SSLHandshakeException: Received fatal alert: certificate_unknown`.

**Diagnose.** Client cert not signed by server trust CA. Wrong intermediate chain. SNI mismatch on server cert.

**Fix.** Import correct chain; use `openssl s_client -connect host:443 -showcerts` and mesh `istioctl proxy-config secret`.

---

## 11. Secrets Management

### Core concept

Secrets: client secrets, DB passwords, API keys, signing keys, TLS private keys, encryption keys. **Never** in git, **never** in plain ConfigMap, **never** in application logs.

| Store | Use when | Spring integration |
|---|---|---|
| HashiCorp Vault | Central policy, dynamic secrets | `spring-cloud-vault` |
| AWS Secrets Manager / GCP SM | Cloud-native | Spring Cloud AWS, custom |
| K8s Secrets (encrypted etcd) | Baseline K8s | `volumeMount`, External Secrets Operator |
| Sealed Secrets / SOPS | GitOps encrypted blobs | Flux/Argo decrypt at deploy |

**Dynamic secrets:** Vault creates **short-lived DB credentials** per pod start — limits blast radius.

### Internal working (Vault)

```yaml
spring:
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

```java
@Value("${spring.datasource.password}")
private String dbPassword; // injected from Vault at bootstrap
```

Bootstrap context loads secrets before main application context.

### Production scenario: secret in git history

**Problem.** `application-prod.yml` committed with `client-secret`. Even after delete, history contains it. Scanner alerts.

**Solution.** Rotate secret immediately. `git filter-repo` or BFG — painful. Prefer prevention: pre-commit hook, Gitleaks CI, **no secrets in repo ever**. Reference `${ENV_VAR}` only.

### Production scenario: K8s Secret readable by all namespaces

**Problem.** Secret mounted as env var in pod; RBAC allows `get secrets` cluster-wide. Compromised dev tool leaks production DB password.

**Solution.** Namespace-scoped RBAC. External Secrets Operator with IRSA/workload identity. Prefer **file mount** over env (some dump env in crash reports). Rotate on incident.

### Production scenario: Vault token on disk forever

**Problem.** App uses static Vault token in file. Token never renewed. 90-day expiry kills prod at midnight.

**Solution.** Kubernetes auth with **short-lived token** and automatic renewal. Agent sidecar injects secrets.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Same DB password all services | One leak, full DB access |
| Secrets in Spring Actuator `/env` | Unsanitized actuator exposure |
| Logging datasource URL with password | Password in log stack |

### Debugging scenario

**Observe.** Boot fails `Could not resolve placeholder 'KEYCLOAK_CLIENT_SECRET'`.

**Diagnose.** Secret not mounted; wrong key name in ExternalSecret; Vault policy denies path.

**Fix.** `kubectl describe externalsecret`; Vault audit log; align key path with `@Value` / `spring.config.import`.

---

## 12. Zero Trust Architecture

### Core concept

Zero trust: **no implicit trust based on network location**. Every request authenticated and authorized. Microservices implement zero trust by:

1. **Identity for every workload** (mTLS / SPIFFE / client credentials).
2. **Least privilege scopes** per API and per caller.
3. **Continuous verification** — short TTLs, policy updates without "trusted subnet."
4. **Assume breach** — encrypt data, audit, segment with network policies.
5. **Strong device/user signals** at edge (MFA, conditional access) — IdP responsibility.

Not a product — a set of principles applied across gateway, mesh, services, data.

### Architecture pattern

```
                    ┌─────────────────────────────────────┐
                    │  Policy Admin (OPA bundles, RBAC)   │
                    └─────────────────────────────────────┘
                                      │
    User ──► IdP ──► Gateway (authZ) ──► Mesh (mTLS) ──► Service (authZ) ──► Data (encrypt)
              │              │                │                  │
              MFA         rate limit      L4 policy          tenant SQL
```

### Production scenario: "VPC = trust" collapse

**Problem.** All services in one flat VPC. Contractor VPN access. Lateral scan finds unauthenticated Elasticsearch, Redis without auth, admin Actuator.

**Solution.** Network micro-segmentation. Authenticate every data store. Remove Actuator exposure. Zero trust rollout checklist per service:

| Check | Pass criteria |
|---|---|
| API requires auth | 401 without credential |
| Service identity | mTLS or client credentials |
| Data store auth | Password/Vault, not open port |
| Admin endpoints | Separate chain, IP allowlist or SSO |
| Audit | Who accessed what resource |

### Production scenario: OPA policy drift

**Problem.** OPA sidecar policies updated manually on 3 of 20 pods during incident. Rest enforce old policy — inconsistent authorization.

**Solution.** GitOps for Rego bundles; Styra/OPA bundle server; Kubernetes ConfigMap versioned with deployment. Integration test: deny admin without MFA claim.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Zero trust slogan, flat network | Pen test finds open ports |
| MFA only at VPN, not apps | Stolen VPN creds = full access |
| Policy only in gateway | Internal bypass |

### Debugging scenario

**Observe.** Security team says zero trust deployed; developers curl internal APIs without tokens "for speed."

**Diagnose.** Culture + missing CI check. No contract test enforcing 401.

**Fix.** CI smoke test: unauthenticated call must fail. Break builds on `permitAll` in prod profile.

---

## 13. API Security — Gateway, Rate Limits, Validation

### Core concept

API security beyond auth:

| Control | Purpose | Implementation |
|---|---|---|
| Rate limiting | Abuse, brute force, cost control | Gateway Redis, Bucket4j, WAF |
| Input validation | Injection, oversized payloads | `@Valid`, JSON schema, max body size |
| Output encoding | XSS in error messages | Problem Details, no stack traces |
| API versioning | Safe deprecation | `/v1/`, header versioning |
| Idempotency | Replay safety | `Idempotency-Key` header |

Spring Cloud Gateway rate limit:

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: public-api
          uri: lb://order-service
          filters:
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100
                redis-rate-limiter.burstCapacity: 200
                key-resolver: "#{@ipKeyResolver}"
```

```java
@Bean
KeyResolver ipKeyResolver() {
    return exchange -> Mono.just(
        exchange.getRequest().getRemoteAddress().getAddress().getHostAddress());
}
```

### Production scenario: rate limit bypass via distributed botnet

**Problem.** IP-based limiter ineffective. 10k IPs, each 99 req/min — aggregate overwhelms order service.

**Solution.** Layer limits: per IP, per `client_id` (from JWT), per API key, global circuit. WAF bot management. Captcha on auth endpoints. GraphQL query cost analysis if applicable.

### Production scenario: mass assignment via JSON

**Problem.** `PUT /users/me` accepts `UserDto` with `role` field. Client sets `role: ADMIN`. Controller binds all fields.

**Solution.** Separate DTOs: `UserUpdateRequest` without privileged fields. `@JsonIgnoreProperties(ignoreUnknown = true)`. Authorize role changes on admin endpoint only.

```java
public record UserUpdateRequest(String displayName, String locale) {}
// NOT the full User entity
```

### Production scenario: Actuator heapdump exposed

**Problem.** Gateway routes `/actuator/**` to service for "debugging." Public DNS resolves actuator. Heap dump contains secrets.

**Solution.** Separate management port on internal network only. `management.endpoints.web.exposure.include=health,info` in prod. Security filter chain on management port.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No max request size | OOM from large JSON |
| Swagger UI in prod without auth | API map for attackers |
| Error responses include SQL | Information disclosure |

### Debugging scenario

**Observe.** Sudden 429 from gateway for legitimate mobile app.

**Diagnose.** Shared `client_id` rate limit key; one bad app version retry storm.

**Fix.** Per-user key resolver from JWT `sub`. Exponential backoff on client.

---

## 14. CORS in Microservices

### Core concept

CORS is a **browser enforcement** — servers send `Access-Control-*` headers; browsers block JS from reading cross-origin responses without them. **Not a substitute for auth.** Server-side attackers ignore CORS.

Microservices CORS pain: **browser talks to BFF or gateway**, not 12 services directly. If SPA calls every service origin, you duplicate CORS on each — use **single BFF origin** or **gateway CORS** only.

| Header | Meaning |
|---|---|
| `Access-Control-Allow-Origin` | Which origins may read response — never `*` with credentials |
| `Access-Control-Allow-Credentials` | Cookies allowed — requires specific origin, not `*` |
| `Access-Control-Allow-Methods` | POST, GET, ... |
| `Access-Control-Allow-Headers` | Authorization, Content-Type, custom headers |

Preflight: `OPTIONS` before non-simple cross-origin request. **CorsFilter must run before auth** — otherwise 401 on OPTIONS without CORS headers looks like CORS failure in browser.

### Internal working (Spring Security 6)

```java
@Bean
SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
    http
        .cors(cors -> cors.configurationSource(corsConfigurationSource()))
        .authorizeHttpRequests(auth -> auth.anyRequest().authenticated())
        .oauth2ResourceServer(oauth -> oauth.jwt(Customizer.withDefaults()));
    return http.build();
}

@Bean
CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOrigins(List.of("https://app.example.com"));
    config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
    config.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Request-Id"));
    config.setAllowCredentials(true);
    config.setMaxAge(3600L);
    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", config);
    return source;
}
```

Gateway global CORS:

```yaml
spring:
  cloud:
    gateway:
      globalcors:
        cors-configurations:
          '[/**]':
            allowedOrigins: "https://app.example.com"
            allowedMethods: "*"
            allowedHeaders: "*"
            allowCredentials: true
```

### Production scenario: CORS error but API returns 401

**Problem.** Dev sees browser console CORS error on API call. Network tab shows 401 without `Access-Control-Allow-Origin`. Developer blames CORS; real issue expired JWT.

**Solution.** Fix auth first. Ensure `ExceptionTranslationFilter` and entry point add CORS headers on 401/403 via `CorsConfigurationSource` on that security chain. Spring Security CorsFilter ordering — CORS before BearerToken filter outcomes.

### Production scenario: `allowedOrigins: *` with credentials

**Problem.** Config uses `*` and `allowCredentials: true` — browser rejects. Dev "fixes" by removing credentials while using cookies — broken auth.

**Solution.** Explicit origin list per environment. Staging origin separate from prod.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| CORS on every microservice | Inconsistent origins, maintenance hell |
| Reflect any Origin header | Origin reflection attack |
| Missing OPTIONS permit | Preflight 403 |

### Debugging scenario

**Observe.** Works in Postman, fails in browser.

**Diagnose.** Cross-origin. Check preflight OPTIONS response headers.

**Fix.** Gateway CORS; verify `Vary: Origin`.

---

## 15. CSRF in Distributed and SPA Architectures

### Core concept

CSRF: attacker tricks **browser** into sending authenticated request (cookie session) to your API. Relevant when:

- Session cookie authentication (BFF, traditional MVC).
- Browser automatically attaches cookies cross-site (mitigated by SameSite).

**Not relevant** when:

- Pure Bearer token in `Authorization` header (SPA stores in memory — attacker needs token).
- Pure client credentials service-to-service.

Microservices: **CSRF at BFF** if cookie session; **disable CSRF on stateless JWT APIs** consumed by non-browser clients.

### Internal working (Spring Security 6 CSRF)

CSRF token in session or cookie (double-submit). `CsrfFilter` validates unsafe methods. SPA patterns:

| Pattern | CSRF |
|---|---|
| BFF + SameSite cookie session | CSRF on BFF state-changing routes |
| SPA + Bearer in memory | CSRF off on resource API |
| SPA + cookie auth cross-site | SameSite=None + CSRF mandatory |

### Production scenario: CSRF on stateless API breaks mobile

**Problem.** API chain has CSRF enabled (copied from web config). Mobile POST returns 403 `Invalid CSRF token`.

**Solution.** Separate chains: web (CSRF on), API (CSRF off, JWT). Document which routes are browser vs machine.

### Production scenario: BFF CSRF missing

**Problem.** SPA uses cookie session to BFF. Attacker site POSTs `https://bff.example.com/api/transfer` from victim browser. Cookie sent. Money moved.

**Solution.** CSRF token in SPA from BFF on load; send `X-XSRF-TOKEN` header. SameSite=Lax on session cookie. Critical ops: re-auth or step-up MFA.

```java
http
    .csrf(csrf -> csrf
        .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
        .csrfTokenRequestHandler(new SpaCsrfTokenRequestHandler()));
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| CSRF on + JWT API | 403 on POST from mobile |
| CSRF off + cookie API | CSRF vulnerability |
| CORS `*` + cookie creds | Broken or dangerous combo |

### Debugging scenario

**Observe.** 403 on POST only from browser, curl works.

**Diagnose.** CSRF or CORS. TRACE shows `CsrfFilter` denying.

**Fix.** Intentional CSRF config per chain; SPA sends token.

---

## 16. Certificate Management

### Core concept

Certificate lifecycle: **generate key pair → CSR → CA sign → deploy → renew → revoke**.

| Cert type | Typical lifetime | Renewal |
|---|---|---|
| Public TLS (Let's Encrypt) | 90 days | cert-manager auto |
| Internal mesh CA | 24h–7d | Mesh control plane |
| Corporate CA | 1–3 years | Manual/automation ticket |

**Trust stores** on clients must include issuing CA (not always leaf). **Intermediate chain** incomplete causes Java trust failures while openssl succeeds.

### Internal working (cert-manager K8s)

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
  namespace: prod
spec:
  secretName: api-tls-secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - api.example.com
```

Spring Boot mounts secret:

```yaml
server:
  ssl:
    key-store-type: PKCS12
    key-store: /etc/tls/keystore.p12
```

### Production scenario: wrong cert on wrong domain

**Problem.** Wildcard `*.example.com` on `api.example.com` but SPA on `app.example.com` calls `api.internal.example.com` — cert mismatch.

**Solution.** SAN covers all hostnames clients use. Document internal vs external DNS. mTLS separate trust domain from public TLS.

### Production scenario: private key in container image

**Problem.** Dockerfile `COPY tls/key.pem` — key in every image layer; registry leak exposes.

**Solution.** Mount secrets at runtime. Init container fetches from Vault. Never bake keys into image.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Expired intermediate | Intermittent trust errors |
| Self-signed in prod without trust install | Mobile app TLS fail |
| RSA 1024 keys | Policy violation, weak crypto |

### Debugging scenario

**Observe.** Java client fails TLS; curl to same host works.

**Diagnose.** Java trust store missing corp CA. TLS version mismatch (Java 8 defaults).

**Fix.** Import CA to truststore; `-Djavax.net.ssl.trustStore`; upgrade TLS.

---

## 17. Key Rotation

### Core concept

Rotation limits exposure when keys leak. Types:

| Key material | Rotation trigger | Zero-downtime pattern |
|---|---|---|
| JWT signing (JWK) | Schedule + incident | Publish new `kid`, overlap validation window |
| TLS cert | Expiry automation | Dual cert, gradual rollout |
| Client secrets | Schedule + leak | Two active secrets, stagger service updates |
| DB encryption key | Policy / KMS | Re-encrypt data background job |
| HMAC webhook secrets | Partner coordination | Dual verification period |

### Internal working (JWT signing key rotation)

Authorization server:

1. Add new key to JWKS with new `kid`.
2. Sign new tokens with new key only.
3. Keep old key in JWKS for `exp` max of outstanding tokens.
4. Remove old key after TTL + buffer.

Resource server: `NimbusJwtDecoder` refreshes JWKS periodically — ensure cache TTL < rotation frequency.

### Production scenario: emergency JWT key rotation

**Problem.** HSM backup leak suspicion. Must rotate signing key in 1 hour.

**Runbook:**

1. Generate new key pair; add to JWKS with new `kid`.
2. Force all authorization servers to sign with new key.
3. Verify resource servers fetch updated JWKS (check cache).
4. Revoke outstanding access tokens if IdP supports (Keycloak admin revoke session).
5. Shorten access token TTL temporarily during incident.
6. Remove old key after max token lifetime elapsed.
7. Audit logs for anomalous token use with old `kid`.

### Production scenario: TLS cert rotation breaks old Android

**Problem.** New cert uses ECDSA only; old Android lacks root. User base can't connect.

**Solution.** Maintain RSA chain during transition. Test against min supported client matrix.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Instant old key removal | Mass 401 until users re-login |
| Secrets rotated, ConfigMap not restarted | Pods use stale secret until roll |
| No rotation automation | Expiry outage |

### Debugging scenario

**Observe.** 401 spike exactly at top of hour.

**Diagnose.** Automated cert or key rotation; JWKS cache stale 60 min.

**Fix.** Overlap keys; reduce JWKS cache; rolling pod restart after secret update.

---

## 18. Encryption at Rest

### Core concept

Encryption at rest protects data on disk, backups, and snapshots when **filesystem or media** is stolen — not when app is compromised (attacker reads decrypted data via app).

| Layer | What | Who manages keys |
|---|---|---|
| Disk/volume | LUKS, cloud volume encryption | Cloud provider / ops |
| Database TDE | Transparent encryption | DBA / KMS |
| Application-level | Field encryption (PII columns) | App + Vault/KMS |
| Object storage | S3 SSE-KMS, GCS CMEK | Cloud IAM |

Microservices: **each service DB** should be encrypted at volume level minimum. **PII fields** (email, PAN) — column encryption or tokenization for defense in depth.

### Internal working (Spring + KMS field encryption)

```java
@Entity
public class Customer {
    @Id private Long id;
    @Convert(converter = EncryptedStringConverter.class)
    private String email;
}

@Component
public class EncryptedStringConverter implements AttributeConverter<String, String> {
  @Override
  public String convertToDatabaseColumn(String attribute) {
    return encryptionService.encrypt(attribute);
  }
  @Override
  public String convertToEntityAttribute(String dbData) {
    return encryptionService.decrypt(dbData);
  }
}
```

Key from Vault transit engine — never static key in code.

### Production scenario: backup leak without at-rest encryption

**Problem.** S3 bucket snapshot of RDS backup public misconfiguration. Full customer DB downloadable.

**Solution.** RDS encryption enabled at creation (cannot always retrofit easily — plan early). S3 bucket policies deny public. Backup encryption with KMS CMK. Regular audit with tools (ScoutSuite, Prowler).

### Production scenario: app-level key in properties file

**Problem.** `encryption.key=base64...` in `application.yml`. Attacker with RCE reads file; all PII decryptable.

**Solution.** Envelope encryption: data key per record or per tenant, master key in KMS/HSM. Vault Transit encrypt API per write — latency tradeoff.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Encrypted volume, plaintext DB connection | Sniff on internal network |
| Logs print decrypted PII | Encryption pointless |
| Same DEK for all tenants | One leak, all tenants |

### Debugging scenario

**Observe.** Performance regression after field encryption.

**Diagnose.** Encrypt per row on every read without caching data keys.

**Fix.** Cache KMS decrypt results with TTL; batch; use AES-GCM with local DEK from KMS GenerateDataKey.

---

## 19. Encryption in Transit

### Core concept

TLS protects bytes on the wire between client-server and service-service. Requirements:

| Connection | Minimum | Preferred |
|---|---|---|
| Public internet | TLS 1.2+ | TLS 1.3 |
| East-west internal | TLS 1.2+ mTLS | Mesh automatic |
| Database | TLS to DB | verify server cert |

**HSTS** on public endpoints — browser refuses HTTP downgrade.

```java
// Enforce HTTPS in Spring Security
http.requiresChannel(channel -> channel.anyRequest().requiresSecure());
```

Internal: **do not use HTTP** between services in production — mesh mTLS or app TLS.

### Internal working

TLS handshake: ClientHello → Server cert chain → key exchange → encrypted application data.

Spring Boot 3:

```yaml
server:
  ssl:
    enabled: true
    protocol: TLS
    enabled-protocols: TLSv1.3,TLSv1.2
    ciphers: TLS_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
```

Feign/WebClient HTTPS:

```java
WebClient.builder()
    .clientConnector(new ReactorClientHttpConnector(
        HttpClient.create().secure(ssl -> ssl.sslContext(sslContext))))
    .build();
```

### Production scenario: TLS terminated too early

**Problem.** TLS ends at load balancer; HTTP inside VPC to pods. Compromised pod sniffs traffic — JWTs and PII visible.

**Solution.** Re-encrypt to pod (TLS pass-through or mesh). Or accept mesh mTLS on localhost between sidecar and app still HTTP — encrypted on wire between nodes.

### Production scenario: weak cipher suite

**Problem.** Legacy config enables `TLS_RSA_WITH_AES_128_CBC_SHA`. Pen test flags POODLE/TLS issues.

**Solution.** Modern cipher suite only. Disable TLS 1.0/1.1. Test with `sslscan`, Mozilla SSL Config Generator.

### Production scenario: certificate pinning in mobile breaks rotation

**Problem.** Mobile app pins leaf cert. Cert renews — app cannot connect until update.

**Solution.** Pin public key (SPKI) or backup pin; plan rotation in app release before cert change.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `ssl.verification-mode=none` on JDBC | MITM on DB path |
| Mixed content HTTP assets on HTTPS page | Browser warnings, leak |
| Long-lived session without secure cookie | Session hijack |

### Debugging scenario

**Observe.** `javax.net.ssl.SSLHandshakeException: PKIX path building failed`.

**Diagnose.** Corporate proxy MITM cert not in Java truststore.

**Fix.** Import proxy CA to JVM truststore or use system trust store.

---

## 20. Production Debugging Playbook

When security is "random," it is usually **wrong chain**, **wrong token type**, **clock skew**, **aud/iss mismatch**, or **context lost on async**.

1. **Classify status code.** 401 = authentication. 403 = authorization or CSRF. Browser CORS error with 401 = fix auth + CORS headers on error path. 302 to login = session/form chain matched instead of JWT.

2. **Identify token type.** Access vs ID vs client-credentials. Decode header (`alg`, `kid`) — never log full token in prod.

3. **Validate offline (staging token only).** `iss`, `aud`, `exp`, `scope`, custom claims (`tenant_id`). Compare with resource server `issuer-uri` and validators.

4. **Trace the hop.** Gateway → BFF → service. Is `Authorization` present at each hop? Mesh tap or structured log of `hasAuthHeader` boolean.

5. **JWKS health.** curl JWK URI from app pod (network path). Cache stale? `kid` missing?

6. **Clock sync.** `ntp` on nodes; JWT `iat`/`exp` skew.

7. **Security filter chain.** Which chain matched? Actuator `permitAll` too broad?

8. **Method security.** Self-invocation? Wrong principal type for SpEL?

9. **mTLS.** `openssl s_client` and mesh proxy config. Cert expiry?

10. **Secrets freshness.** Pod started before secret rotation? Restart deployment after Vault update.

11. **Rate limit / WAF.** 429 vs 403 — don't tune JWT when gateway throttles.

12. **Turn off TRACE.** Logs tokens, CSRF secrets, PII. Canary only.

13. **Actuator exposure.** `/actuator/env`, `/heapdump` — incident vector.

**Incident severity guide:**

| Signal | Likely cause | First action |
|---|---|---|
| Fleet-wide 401 | Key rotation, JWKS, clock | Check IdP status, JWKS `kid` |
| Single service 401 | Decoder config, aud | Compare working vs broken service yaml |
| Spike 403 after deploy | Matcher order, converter | Rollback or fix `authorizeHttpRequests` order |
| Data leak report | Missing tenant filter | Audit query logs, hotfix predicate |

---

## 21. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Browser app, same origin | BFF + session cookie + CSRF + SameSite Lax |
| SPA cross-origin | BFF same-origin **or** Bearer in memory + strict CORS origins |
| Mobile app | OAuth2 code + PKCE; short access token; refresh rotation |
| Public partner API | Client credentials or API key + mTLS; per-partner scopes |
| Service-to-service sync | Client credentials with `aud` per target **or** mesh mTLS |
| User context to downstream | Token exchange or pass-through if aud allows — not ID token |
| Human + service mixed | Separate filter chains: web vs API vs actuator |
| Multi-tenant SaaS | `tenant_id` in token + every SQL query — never header alone |
| High-security finance | Short TTL, step-up MFA, DPoP or mTLS token binding |
| Internal "trusted" VPC | Still authenticate — network policy is adjunct, not auth |
| Secrets in K8s | External Secrets Operator + Vault; no plain git |
| TLS public edge | TLS 1.3, HSTS, auto cert-manager renew |
| East-west traffic | Service mesh mTLS STRICT or app-level TLS |
| JWT signing keys | RS256 + JWKS rotation with overlap window |
| PII in database | Volume encryption + field-level for sensitive columns |
| Debugging prod auth | Canary TRACE, compare headers hop-by-hop, no token logging |
| CSRF | On cookie-session BFF only; off stateless JWT APIs |
| CORS | Gateway or BFF single origin policy — not 15 services |
| Admin / Actuator | Separate port, SSO, deny public ingress |
| Zero trust rollout | 401 without cred on every API CI test |

---

## 22. Interview Q&A

### Q1. Why must microservices validate JWT at the service layer if the API gateway already validates?

**A.** Gateway bypass is routine: direct ClusterIP access, misconfigured ingress, debug ports, SSRF from another service, future architecture change without gateway. Defense in depth — each service is a **resource server** that validates `iss`, `aud`, `exp`, and signature. Gateway reduces attack volume; services enforce authorization truth.

### Q2. What is the difference between authentication and authorization in a distributed system?

**A.** **Authentication** proves identity (user JWT, client credentials, mTLS cert). **Authorization** decides if that identity may perform an action on a resource (scopes, roles, OPA policy, owner checks). You can be authenticated (valid token) but forbidden (403) if scope lacks `orders.delete`. Confusing 401 vs 403 misroutes debugging.

### Q3. When do you use client credentials vs propagating the user JWT?

**A.** **Client credentials** for **system** actions with no user context (nightly batch, saga compensation, health sync) or when downstream trusts service identity only. **Propagate user JWT** when downstream must enforce **user-level** permissions (user can only see own orders). Prefer **token exchange** to downscope `aud` and scopes for downstream when passing full user token is too broad.

### Q4. Explain OAuth2 authorization code flow with PKCE for a mobile app.

**A.** Mobile app is public client (no secret). App generates `code_verifier` / `code_challenge`, opens system browser to IdP authorize URL with `response_type=code`, `scope`, PKCE challenge. User logs in; IdP redirects to app with `code`. App exchanges code + `code_verifier` at token endpoint for access + refresh tokens. PKCE prevents intercepted code from being redeemed without verifier. Store refresh securely (Keychain/Keystore).

### Q5. What is the difference between an access token and an ID token in OIDC?

**A.** **ID token** proves authentication event to the **client** (who logged in); `aud` is client id; not for API access. **Access token** authorizes **resource server** APIs; contains scopes; validated by microservices. Sending ID token to order service is a common misconfiguration — wrong audience and semantics.

### Q6. How do you implement multi-tenant authorization in microservices?

**A.** Put `tenant_id` (or org id) in **signed token claim** from IdP. On every request, extract tenant into trusted context after JWT validation. **Every** data access includes tenant predicate — `WHERE tenant_id = ?`. Never trust client `X-Tenant-Id` without matching token. Gateway may route by tenant but service enforces isolation.

### Q7. What is mTLS and when would you choose it over Bearer tokens for service-to-service?

**A.** **mTLS** mutual TLS — client and server present certificates; identity bound to cryptographic key. Choose mTLS (often via mesh) for **uniform east-west encryption + strong peer identity** without passing Bearer through every app. Bearer client-credentials fits **OAuth ecosystem**, fine-grained scopes, and heterogeneous callers outside mesh. Many systems use **both**: mesh mTLS for transport + JWT for user context.

### Q8. How does token propagation break in async and reactive code?

**A.** `SecurityContextHolder` is ThreadLocal — `@Async`, `CompletableFuture`, reactive `publishOn` lose context. Feign/WebClient interceptors read empty context → no `Authorization` header downstream. Fix: capture token on request thread; pass explicitly in saga state; use `DelegatingSecurityContext*` executors; reactive: `ReactiveSecurityContextHolder` + `contextWrite` / `contextCapture`.

### Q9. What claims must you validate on a JWT resource server?

**A.** Signature (via JWKS), `exp`/`nbf`/`iat` with skew, `iss` matches configured issuer, `aud` includes this API (or authorized party), algorithm not `none`. Optionally `azp`, custom `tenant_id`. Map `scope` to authorities. Do not trust claims without signature verification.

### Q10. How do you rotate JWT signing keys without downtime?

**A.** Add new key to JWKS with new `kid`; sign new tokens with new key only; keep old key in JWKS until all outstanding access tokens expire (TTL + buffer); resource servers refresh JWKS cache periodically; remove old `kid` after overlap window. For emergency, shorten access token TTL and revoke sessions at IdP if supported.

### Q11. What is zero trust architecture in microservices?

**A.** No implicit trust by network location. Every workload and user request is **authenticated and authorized**. Encrypt traffic, least-privilege scopes, short-lived credentials, assume breach (segmentation, audit). Implemented via gateway auth, mesh mTLS, per-service resource servers, Vault secrets, and CI tests proving unauthenticated calls fail.

### Q12. How do you manage secrets in Kubernetes microservices?

**A.** Never plain secrets in git. Use **Vault** or cloud secret manager with **External Secrets Operator** syncing to K8s Secrets. Mount as files or env; rotate via Vault dynamic secrets or scheduled rotation. Restrict RBAC `get secrets`. Sanitize Actuator. One secret per service/client — no shared prod password across 40 apps.

### Q13. When is CSRF a risk in microservices and when do you disable it?

**A.** **Risk:** browser cookie-based sessions (BFF) — attacker site triggers state-changing POST with victim's cookie. **Disable CSRF** on **stateless JWT APIs** where browser does not auto-send token (Authorization header only). Separate Spring Security chains for web vs API. Cross-site cookie auth needs SameSite + CSRF tokens.

### Q14. How should CORS be configured in a microservices architecture?

**A.** Prefer **single entry** (gateway or BFF) for browser CORS — not duplicated on every service. Explicit `allowedOrigins` list per environment; never `*` with `allowCredentials`. Ensure CORS filter runs **before** auth so 401 responses include CORS headers. Internal service-to-service calls are not CORS — no headers needed.

### Q15. What is encryption at rest vs encryption in transit?

**A.** **In transit:** TLS/mTLS protects data on the network between client-server and service-service — prevents wire sniffing. **At rest:** encryption on disk, DB TDE, backup encryption, field-level PII encryption — protects stolen drives/backups. Both required; neither stops compromised app reading live data. Keys for at-rest often in KMS/Vault.

### Q16. How do you secure an API gateway in production?

**A.** Validate JWT (iss, aud, sig), rate limit per IP/client_id, WAF rules, TLS termination with modern ciphers, request size limits, strip sensitive headers from clients, optional mTLS for partners, route to internal services only, no Actuator exposure, audit access logs, separate admin config, TokenRelay only when appropriate.

### Q17. What is OAuth2 token exchange (RFC 8693) and why use it?

**A.** Trade one token for another with different `aud`, scope, or subject — e.g. BFF exchanges user token for inventory-scoped token. Reduces pass-through of over-privileged JWT. Keycloak and Spring Authorization Server support variants. Use when downstream should not accept full user token from another audience.

### Q18. How do certificate expiry incidents happen in microservices and how to prevent them?

**A.** Causes: manual 1-year certs without monitoring, failed cert-manager renewal, mesh CA misconfig, forgotten internal CA. Prevention: cert-manager with alerts 30/7/1 days, automated mesh cert rotation, runbooks, integration tests on TLS connect, never bake certs in images, overlap during rotation.

### Q19. What is the BFF pattern for security?

**A.** **Backend for Frontend** — browser talks only to BFF (same origin). BFF holds OAuth tokens server-side in session or encrypted store; microservices never exposed to browser directly. Simplifies CORS/CSRF, hides client secrets, enables token exchange per downstream. Tradeoff: BFF becomes critical tier — scale and secure it like a gateway.

### Q20. How do you detect horizontal privilege escalation in microservices?

**A.** Integration tests: user A token cannot read user B resource id. Code review: every `findById` has tenant/owner check. Pen test IDOR on sequential ids. Audit logs with `sub` + resource id. `@PreAuthorize` on service layer not only controller. Repository query always includes tenant from token context.

### Q21. What are SPIFFE and SPIRE in service identity?

**A.** **SPIFFE** defines workload identity format (`spiffe://trust/domain/workload`). **SPIRE** issues **SVIDs** (SPIFFE Verifiable Identity Document) — short-lived certs for mTLS. Mesh and platforms use them for **cryptographic service identity** replacing shared API keys. Spring apps often consume via mesh sidecar rather than direct SPIRE SDK.

### Q22. How do you handle API key authentication vs OAuth2 for partners?

**A.** **API keys** simple for low-risk read-only partners — key in header, rate limit, rotate, audit. Weak for fine-grained consent and rotation at scale. **OAuth2 client credentials** better for scopes, standard revocation, audit per client, short-lived tokens. High-trust partners: mTLS + client credentials. Never API key in URL query string.

### Q23. What Spring Security 6 configuration separates actuator from API security?

**A.** Multiple `SecurityFilterChain` beans with `@Order`: `@Order(1)` `securityMatcher("/actuator/**")` with restricted roles or separate management port; `@Order(2)` `securityMatcher("/api/**")` JWT resource server STATELESS; `@Order(3)` web login if needed. First match wins — most specific first.

### Q24. How does a service mesh help security without changing Spring code?

**A.** Sidecar provides **mTLS** east-west, **L4/L7 policy** (which SA can call which), **telemetry** without token in app logs, optional JWT validation at proxy. App may still validate JWT for user authorization — mesh does not replace app-level authZ on user data. Enables STRICT mTLS gradually.

### Q25. What should you log for security audit without leaking credentials?

**A.** Log: timestamp, `sub`, `client_id`, tenant, HTTP method/path, decision (allow/deny), trace id, source IP, user agent. **Never** log: full JWT, refresh tokens, passwords, client secrets, decrypted PII. Structured JSON to SIEM. Alert on anomaly: spike 401/403, admin scope from new geo, after-hours bulk export.

### Q26. How do you encrypt sensitive database columns in a microservice?

**A.** Application-level `AttributeConverter` or transparent helpers calling **Vault Transit** or **KMS GenerateDataKey**. Envelope encryption: KMS wraps DEK, DEK encrypts column. Cache DEKs with TTL. Volume-level RDS encryption is baseline; column encryption protects backup/DBA paths. Key rotation requires re-encrypt job.

### Q27. What is the difference between RBAC and ABAC for microservice authorization?

**A.** **RBAC:** roles/scopes (`ROLE_ADMIN`, `SCOPE_orders.read`) — static, easy with OAuth scopes. **ABAC:** attributes (tenant, region, resource owner, time, device trust) — `user.tenant == resource.tenant`. Microservices often combine: scopes for coarse API access, ABAC/ custom `@PreAuthorize` for row-level. OPA/Cedar for complex policy across services.

### Q28. Why is trusting internal network IP for authentication dangerous?

**A.** IPs are not identity — spoofable in some topologies, shared by many pods via NAT, change on reschedule. Attackers pivot from compromised workload to "internal" IPs. SSRF from public app reaches internal URLs. **Authenticate every call** with token or mTLS regardless of source IP. IP allowlists are adjunct for admin endpoints only.

---

*The gateway authenticates traffic; each service must still ask who is calling and whether they may act. Bind tokens to audience, tenants to queries, secrets to Vault, and east-west to TLS — then test unauthenticated calls in CI so "internal only" never ships as open API again.*
