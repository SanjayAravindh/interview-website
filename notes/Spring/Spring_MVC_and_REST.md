# Spring MVC and REST Mastery — Senior Production Reference

Spring Boot 3.x / Spring MVC 6.x servlet stack. This is not a tutorial on `@GetMapping`. It is the map of what actually breaks in production after years of shipping REST APIs on embedded Tomcat — thread exhaustion, Jackson surprises, path-matching regressions, and the filter chain order that nobody documents until 2 a.m.

---

## Table of Contents

1. [Mental Model: DispatcherServlet](#1-mental-model-dispatcherservlet)
2. [DispatcherServlet Lifecycle](#2-dispatcherservlet-lifecycle)
3. [HandlerMapping](#3-handlermapping)
4. [HandlerAdapter](#4-handleradapter)
5. [View Resolution, HttpMessageConverter, and JSON](#5-view-resolution-httpmessageconverter-and-json)
6. [@RestController vs @Controller](#6-restcontroller-vs-controller)
7. [@RequestMapping Variants and Path Matching](#7-requestmapping-variants-and-path-matching)
8. [Path Variables, Request Params, and Headers](#8-path-variables-request-params-and-headers)
9. [Content Negotiation](#9-content-negotiation)
10. [Content Negotiation Depth: Accept Parsing, Converters, and Media-Type Versioning](#10-content-negotiation-depth-accept-parsing-converters-and-media-type-versioning)
11. [@RequestBody and @ResponseBody](#11-requestbody-and-responsebody)
12. [Jackson Integration](#12-jackson-integration)
13. [Validation: @Valid, @Validated, and Groups](#13-validation-valid-validated-and-groups)
14. [Exception Handling: @ControllerAdvice and ProblemDetail (RFC 7807)](#14-exception-handling-controlleradvice-and-problemdetail-rfc-7807)
15. [Problem Details in Depth: RFC 7807, RFC 9457, and ErrorResponse](#15-problem-details-in-depth-rfc-7807-rfc-9457-and-errorresponse)
16. [Filters vs Interceptors vs Security Filter Chain Order](#16-filters-vs-interceptors-vs-security-filter-chain-order)
17. [Rate Limiting and Abuse Protection at the MVC Layer](#17-rate-limiting-and-abuse-protection-at-the-mvc-layer)
18. [Embedded Tomcat Thread Pool and maxThreads](#18-embedded-tomcat-thread-pool-and-maxthreads)
19. [Virtual Threads (Boot 3.2+)](#19-virtual-threads-boot-32)
20. [Timeouts End to End](#20-timeouts-end-to-end)
21. [Multipart Uploads and File Download](#21-multipart-uploads-and-file-download)
22. [CORS and Static Resources](#22-cors-and-static-resources)
23. [Async MVC: DeferredResult, Callable, and @Async](#23-async-mvc-deferredresult-callable-and-async)
24. [Server-Sent Events on the Servlet Stack](#24-server-sent-events-on-the-servlet-stack)
25. [OpenAPI, springdoc, Pageable, and HATEOAS (Brief)](#25-openapi-springdoc-pageable-and-hateoas-brief)
26. [Production Pitfalls: OSIV, Jackson, Lazy Load, Threads, Timeouts, MVC vs WebFlux](#26-production-pitfalls-osiv-jackson-lazy-load-threads-timeouts-mvc-vs-webflux)
27. [Production Debugging Playbook](#27-production-debugging-playbook)
28. [Quick Decision Matrix](#28-quick-decision-matrix)

---


## 1. Mental Model: DispatcherServlet

### Core concept

Spring MVC is not "annotations on methods." It is a **front controller** (`DispatcherServlet`) that delegates every HTTP request through a fixed pipeline: find a handler, invoke it through the right adapter, then render a view or write a body via `HttpMessageConverter`s. Your `@RestController` is the last step in that pipeline, not the entry point.

Everything before the controller — filters, security, mapping, binding, conversion — determines whether your business logic ever runs and what shape the bytes are in when it does.

### Internal working

```
HTTP request
  └─ Servlet container filter chain (Servlet Filters)
       ├─ CharacterEncodingFilter
       ├─ springSecurityFilterChain (DelegatingFilterProxy)
       ├─ Your custom Filter @Order(...)
       └─ DispatcherServlet  ("Front Controller")
            ├─ HandlerMapping        → which @RequestMapping method?
            ├─ HandlerExecutionChain → handler + HandlerInterceptor pre/post
            ├─ HandlerAdapter          → invoke handler (RequestMappingHandlerAdapter)
            │    ├─ argument resolvers (@PathVariable, @RequestBody, ...)
            │    ├─ return value handlers (@ResponseBody, ResponseEntity, ...)
            │    └─ HttpMessageConverter read/write (Jackson, etc.)
            ├─ ViewResolver (if not @ResponseBody) → Thymeleaf, redirect, ...
            └─ HttpMessageConverter (write JSON/XML/bytes)
                 └─ HTTP response
```

Three objects you must keep distinct:

| Object | Question it answers | Typical 6.x type |
|---|---|---|
| `HandlerMapping` | Which controller method handles this URL + method + headers? | `RequestMappingHandlerMapping` |
| `HandlerAdapter` | How do I invoke that handler and bind arguments? | `RequestMappingHandlerAdapter` |
| `HttpMessageConverter` | How do I turn bytes ↔ Java objects? | `MappingJackson2HttpMessageConverter` |

Status code mental map:

| Code | Usually means in MVC |
|---|---|
| 404 | No `HandlerMapping` matched |
| 405 | Mapping exists, HTTP method wrong |
| 415 | No converter for request `Content-Type` |
| 406 | Content negotiation failed on response |
| 400 | Binding / validation / type mismatch |

Mixing those up leads to "fixing" Jackson when the real bug is path matching.

### Production scenario: "Controller not hit" but breakpoint in service fires

**Problem.** Team adds logging filter and swears the controller is skipped; only service layer logs appear for some requests.

**Cause.** Not MVC skipping the controller — a **servlet filter** or **security** layer forwards internally, or traffic hits a different pod without the new controller mapping, or actuator/management port serves a different context. Less commonly: AOP on service called from scheduled job, not HTTP.

**Solution.** Trace one request ID from edge to controller:

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
public class DispatchTraceFilter extends OncePerRequestFilter {
    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        log.debug("pre-dispatch {} {} servletPath={}", req.getMethod(), req.getRequestURI(), req.getServletPath());
        chain.doFilter(req, res);
        log.debug("post-dispatch status={}", res.getStatus());
    }
}
```

Enable `DispatcherServlet` DEBUG to see `Mapped to ...` for the same correlation ID.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Treating `@RestController` as the entry point | Misdiagnose filter/security/converter issues as "business logic bugs" |
| Confusing 404 with 401 | Security rejects before mapping; logs show no `Mapped to` |
| Multiple dispatcher servlets | Intermittent routing to wrong servlet |
| Ignoring `context-path` in mental model | Works in IDE, fails behind gateway |

### Debugging scenario

**Observe.** Intermittent 404 on a path that "definitely exists."

**Diagnose.** Log `request.getServletPath()` vs `@RequestMapping` pattern. Check trailing slash (Spring 6 default no match). Check HTTP method.

**Fix.** Align gateway rewrite with servlet-relative paths; add integration test with production path layout.

```yaml
logging:
  level:
    org.springframework.web.servlet.DispatcherServlet: DEBUG
```

Look for `GET "/api/orders/1", parameters={}` followed by either `Mapped to` or `No mapping`.

---

## 2. DispatcherServlet Lifecycle

### Core concept

`DispatcherServlet` extends `FrameworkServlet`, which extends `HttpServlet`. Boot auto-registers it mapped to `/` (or your `spring.mvc.servlet.path`) via `DispatcherServletAutoConfiguration`. One instance serves all requests; it is **not** request-scoped. Thread safety comes from stateless handlers plus request-scoped beans, not from a new servlet per call.

Boot 3.x default: `DispatcherServlet` is registered with `load-on-startup = -1` (lazy init unless configured). First request pays initialization cost unless you set `spring.mvc.servlet.load-on-startup=1`.

### Internal working

Startup sequence (simplified):

```
1. Servlet container calls DispatcherServlet.init()
2. FrameworkServlet.initServletBean()
3. WebApplicationContext refreshed (if not already)
4. DispatcherServlet.onRefresh()
5. initStrategies() registers default + custom:
     - MultipartResolver
     - LocaleResolver / ThemeResolver
     - HandlerMapping beans (ordered)
     - HandlerAdapter beans (ordered)
     - HandlerExceptionResolver beans
     - ViewResolver beans
     - RequestToViewNameTranslator
     - FlashMapManager
6. Ready to service requests
```

Per-request sequence in `doDispatch()`:

```
1. getHandler(processedRequest)           → HandlerExecutionChain or null
2. getHandlerAdapter(handler)             → must support handler type
3. mappedHandler.applyPreHandle()         → interceptors; false = stop
4. ha.handle(processedRequest, response, handler)
5. applyPostHandle()                      → interceptors (reverse order)
6. processDispatchResult()                → view or direct write
7. triggerAfterCompletion()               → always in finally (except async)
```

If `HandlerInterceptor.preHandle` returns `false`, the handler is **not** invoked, but `afterCompletion` still runs for interceptors that returned true earlier in the chain.

Async path: when handler returns `DeferredResult`, `Callable`, `WebAsyncTask`, or `StreamingResponseBody`, `doDispatch` starts async processing, releases the container thread, and completes the response later on another thread (or virtual thread).

### Production scenario: slow first request after deploy

**Problem.** After every deploy, the first API call takes 8–15 seconds; subsequent calls are fine. Monitoring shows no DB slowness.

**Cause.** Lazy servlet init + cold JIT + Jackson module registration + Hibernate metadata if something touches persistence on first hit. `DispatcherServlet` and the full `ApplicationContext` initialize on first request when `load-on-startup` is default.

**Solution.**

```yaml
spring:
  mvc:
    servlet:
      load-on-startup: 1
  main:
    lazy-initialization: false  # do not enable globally in prod without reason
```

Add a readiness probe that hits a lightweight endpoint **after** context refresh, not only `/actuator/health` (which may pass before servlet init). Warm-up job in CI/staging that exercises critical mappings before traffic shift.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Multiple `DispatcherServlet` beans with overlapping `urlMappings` | Unpredictable handler selection; one servlet 404s what the other serves |
| `spring.mvc.servlet.path=/api` forgotten in gateway routing | Gateway forwards `/orders` but app expects `/api/orders` → 404 |
| Custom `DispatcherServlet` without copying Boot defaults | Missing converters, wrong exception resolver order |
| `lazy-initialization: true` globally | First-request latency spikes across all endpoints |
| Disabling `DispatcherServletAutoConfiguration` without replacement | Blank 404 from container, no Spring error handling |

### Debugging scenario

**Observe.** Static files work; every `@RestController` returns Whitelabel 404.

**Diagnose.** Check component scan: controllers not in `@SpringBootApplication` package subtree. Verify `@RestController` / `@Controller` present. Log at DEBUG:

```yaml
logging:
  level:
    org.springframework.web.servlet.DispatcherServlet: DEBUG
    org.springframework.web.servlet.handler: DEBUG
```

Look for `No mapping for GET /foo`. If empty handler mappings at startup, scan path is wrong.

**Fix.** `@ComponentScan("com.company.api")` or move controllers under the application root package.

---

## 3. HandlerMapping

### Core concept

`HandlerMapping` maps an incoming request to a `HandlerExecutionChain`: a handler object (usually a `HandlerMethod` wrapping your controller method) plus zero or more `HandlerInterceptor`s. Spring MVC 6 registers several mappings; the one you care about is `RequestMappingHandlerMapping`.

Other mappings still matter:

| HandlerMapping | Purpose |
|---|---|
| `RequestMappingHandlerMapping` | `@RequestMapping` on `@Controller` methods |
| `RouterFunctionMapping` | Functional routing (`RouterFunction`) — Boot 3 coexists with annotation MVC |
| `SimpleUrlHandlerMapping` | Static resource handlers, `/webjars/**` |
| `BeanNameUrlHandlerMapping` | Legacy: bean name = URL path |

First mapping that returns a non-null chain wins (ordered list).

### Internal working

At startup, `RequestMappingHandlerMapping`:

1. Detects `@Controller` / `@RequestMapping` beans
2. Builds `RequestMappingInfo` per method (paths, methods, params, headers, consumes, produces, custom conditions)
3. Registers in a lookup structure optimized for path patterns

At request time:

```
RequestMappingHandlerMapping.getHandler(request)
  → Match path via PathPatternParser (Boot 3 default since 2.6+)
  → Filter by HTTP method, Content-Type (consumes), Accept (produces), params, headers
  → Best match wins (most specific pattern)
  → Return HandlerExecutionChain(handlerMethod, interceptors)
```

Boot 3.x uses **`PathPattern`** (parsed at startup) instead of legacy `AntPathMatcher` for MVC path matching. `**` semantics and trailing slash behavior differ slightly — this is a migration footgun from Boot 2.

`HandlerMethod` captures: bean instance, `Method`, resolved type parameters (important for generics on `@RequestBody`).

### Production scenario: controller exists but 404 on one environment

**Problem.** `GET /api/v2/orders/{id}` works locally, 404 in staging. Same JAR, same branch.

**Cause.** Gateway in staging strips `/api` prefix; app mapping is `/api/v2/orders/{id}` but servlet sees `/v2/orders/{id}`. Or `server.servlet.context-path=/api` double-applied with gateway prefix.

**Solution.** Document **what path the servlet sees** (after context path, after gateway rewrite). Align `RequestMapping` with servlet path, not public URL, unless you control rewrite consistently.

```java
@RestController
@RequestMapping("/v2/orders")  // servlet-relative if gateway strips /api
public class OrderControllerV2 {

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable UUID id) {
        return orderService.findById(id);
    }
}
```

Use `server.forward-headers-strategy=framework` when behind trusted reverse proxies so `ForwardedHeaderFilter` reconstructs scheme/host/port — affects redirects and absolute links, not path matching unless `X-Forwarded-Prefix` is used.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Duplicate `@RequestMapping` paths on two methods | `Ambiguous mapping` at startup — app fails fast (good) |
| `@RequestMapping` on class without leading `/` | Works but confusing; inconsistent with static handlers |
| Mixing `AntPathMatcher` config with Boot 3 defaults | Subtle pattern mismatches after upgrade |
| `@Controller` without `@ResponseBody` on REST method | 200 with empty body or view name resolution error |
| Case-sensitive paths on Linux vs dev on Windows | `/API` vs `/api` 404 only in prod |

### Debugging scenario

**Observe.** Intermittent 404: same URL sometimes hits controller, sometimes not.

**Diagnose.** Two instances with different `context-path` config. Or two `@Order` `HandlerMapping` beans where `SimpleUrlHandlerMapping` catches the path first on one profile.

Enable mapping dump at startup:

```yaml
logging:
  level:
    org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping: TRACE
```

At TRACE, every registered mapping is logged during context refresh.

**Fix.** Single source of truth for public path; integration test with `MockMvc` using production-like `context-path`.

---

## 4. HandlerAdapter

### Core concept

The servlet API knows `HttpServlet.service()`. Your handler is a `@RequestMapping` method with arbitrary parameters and return types. **`HandlerAdapter`** bridges that gap. For annotation-driven MVC, **`RequestMappingHandlerAdapter`** is the adapter that matters.

It owns:

- **Argument resolvers** — populate method parameters
- **Return value handlers** — process return type (`@ResponseBody`, `ResponseEntity`, `ModelAndView`, etc.)
- **`WebDataBinder` factory** — validation binding
- **`SessionAttributeStore`**, `CacheControl` support, etc.

### Internal working

Invocation flow inside `RequestMappingHandlerAdapter.handle()`:

```
1. ServletWebRequest wraps HttpServletRequest/Response
2. HandlerMethod validated (session attributes, etc.)
3. createInvocableHandlerMethod(handlerMethod)
4. For each parameter:
     for (HandlerMethodArgumentResolver resolver : resolvers):
         if resolver.supportsParameter(param):
             arg = resolver.resolveArgument(...)
5. method.invoke(controller, args...)
6. For return value:
     for (HandlerMethodReturnValueHandler handler : returnValueHandlers):
         if handler.supportsReturnType(...):
             handler.handleReturnValue(returnValue, ...)
             break
```

Key resolvers (not exhaustive):

| Resolver | Parameter |
|---|---|
| `PathVariableMethodArgumentResolver` | `@PathVariable` |
| `RequestParamMethodArgumentResolver` | `@RequestParam`, `@RequestHeader`, `@CookieValue` |
| `RequestResponseBodyMethodProcessor` | `@RequestBody`, `@ResponseBody` on method/class |
| `ServletRequestMethodArgumentResolver` | `HttpServletRequest`, `HttpServletResponse` |
| `RequestHeaderMethodArgumentResolver` | `@RequestHeader` object binding |

Key return value handlers:

| Handler | Return type |
|---|---|
| `RequestResponseBodyMethodProcessor` | `@ResponseBody`, `@RestController` |
| `HttpEntityMethodProcessor` | `ResponseEntity<T>` |
| `ViewNameMethodReturnValueHandler` | `String` view name |
| `ModelAndViewMethodReturnValueHandler` | `ModelAndView` |

Order matters: first supporting resolver/handler wins. Custom resolvers via `WebMvcConfigurer.addArgumentResolvers` insert at a position you choose — wrong order causes "could not resolve parameter" at runtime.

### Production scenario: custom argument resolver never runs

**Problem.** Team adds `TenantArgumentResolver` for `@CurrentTenant TenantContext`. Always get "Could not resolve parameter."

**Cause.** Resolver bean not registered with MVC, or registered after resolvers that throw `UnsupportedOperationException` incorrectly, or resolver not added via `WebMvcConfigurer`.

**Solution.**

```java
@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final TenantArgumentResolver tenantArgumentResolver;

    public WebMvcConfig(TenantArgumentResolver tenantArgumentResolver) {
        this.tenantArgumentResolver = tenantArgumentResolver;
    }

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(0, tenantArgumentResolver); // early if competing with defaults
    }
}

@Component
public class TenantArgumentResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return parameter.hasParameterAnnotation(CurrentTenant.class)
            && TenantContext.class.isAssignableFrom(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                  NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
        return TenantContextHolder.getRequired();
    }
}
```

Verify `supportsParameter` is strict — overly broad resolvers break unrelated endpoints.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@InitBinder` on wrong controller | Binding rules not applied cross-controller |
| Custom `HandlerMethodReturnValueHandler` without `supportsReturnType` guard | Swallows return types it cannot handle → blank response |
| `@RequestBody` on two parameters | Only one body allowed — startup or runtime failure |
| Returning raw `Object` with mixed types | Wrong converter chosen; serialization surprises |

### Debugging scenario

**Observe.** `POST` with valid JSON returns 400 "Required request body is missing."

**Diagnose.** Filter consumed `InputStream` before `DispatcherServlet`. Common culprits: custom filter reading body for logging, WAF wrapper, repeated `@RequestBody` read. Security filter rarely reads body for JWT (header-based).

**Fix.** Use `ContentCachingRequestWrapper` only in a filter that runs once and caches bytes; or log body in `HandlerInterceptor` after dispatch setup; or use reactive WebClient on client side and ensure single read server-side.

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class CachingRequestBodyFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        if (request instanceof ContentCachingRequestWrapper) {
            filterChain.doFilter(request, response);
            return;
        }
        filterChain.doFilter(new ContentCachingRequestWrapper(request), response);
    }
}
```

---

## 5. View Resolution, HttpMessageConverter, and JSON

### Core concept

After handler invocation, Spring either:

1. **Resolves a view** — HTML template, redirect, forward (`ViewResolver` chain)
2. **Writes the body directly** — `@ResponseBody` / `@RestController` via `HttpMessageConverter`

REST APIs live almost entirely in path (2). The converter list is negotiated from `Content-Type` (request) and `Accept` (response), plus `@RequestMapping(consumes/produces)`.

Default converters (Boot 3, Jackson on classpath):

| Converter | Media types |
|---|---|
| `MappingJackson2HttpMessageConverter` | `application/json`, `application/*+json` |
| `MappingJackson2XmlHttpMessageConverter` | `application/xml` (if Jackson XML present) |
| `StringHttpMessageConverter` | `text/plain`, `*/*` |
| `ByteArrayHttpMessageConverter` | `application/octet-stream`, `*/*` |
| `ResourceHttpMessageConverter` | `*/*` |
| `AllEncompassingFormHttpMessageConverter` | `multipart/form-data`, `application/x-www-form-urlencoded` |
| `MappingJackson2HttpMessageConverter` (Kotlin) | if kotlin-reflect present |

### Internal working

**Reading `@RequestBody`:**

```
RequestResponseBodyMethodProcessor.readWithMessageConverters()
  → get Content-Type from request
  → iterate HttpMessageConverter.canRead(targetType, contentType)
  → first match: converter.read(type, HttpInputMessage)
  → if none: HttpMediaTypeNotSupportedException → 415
```

**Writing `@ResponseBody`:**

```
RequestResponseBodyMethodProcessor.writeWithMessageConverters()
  → negotiate producible types (method produces, Accept header, defaults)
  → select converter.canWrite(returnType, contentType)
  → converter.write(body, contentType, HttpOutputMessage)
  → if none: HttpMediaTypeNotAcceptableException → 406
```

View resolution path (MVC UI):

```
InternalResourceViewResolver → /WEB-INF/views/{name}.jsp
ThymeleafViewResolver → templates/{name}.html
ContentNegotiatingViewResolver → picks by Accept
```

`@RestController` = `@Controller` + `@ResponseBody` at class level — skips view resolution entirely for return values handled by message converters.

### Production scenario: JSON API returns XML to one client

**Problem.** Mobile app sends `Accept: */*`. Some users get XML responses after adding `jackson-dataformat-xml`.

**Cause.** `ContentNegotiationManager` selects XML when both JSON and XML converters match and XML has equal or higher priority. `Accept: */*` is permissive.

**Solution.**

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {
        configurer
            .defaultContentType(MediaType.APPLICATION_JSON)
            .mediaType("json", MediaType.APPLICATION_JSON)
            .mediaType("xml", MediaType.APPLICATION_XML);
    }
}
```

Or restrict at controller level:

```java
@RestController
@RequestMapping(value = "/api/orders", produces = MediaType.APPLICATION_JSON_VALUE)
public class OrderController { }
```

Prefer explicit `produces = APPLICATION_JSON_VALUE` on public REST APIs.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Custom `ObjectMapper` bean not wired to HTTP converter | `@RequestBody` uses different config than `@JsonSerialize` in service |
| Returning `String` containing JSON manually | Double-encoded JSON string in response body |
| `produces = "application/json"` but returning `byte[]` | Converter mismatch; 406 or wrong content type |
| Removing `spring-boot-starter-json` | No Jackson converter; 415 on all JSON endpoints |

### Debugging scenario

**Observe.** Field renamed in DTO; clients still see old JSON property names.

**Diagnose.** Two `ObjectMapper` beans — one for HTTP, one for Redis/cache. Or `@JsonProperty` on entity not on DTO. Or response is cached at gateway with stale schema.

**Fix.** Single `@Primary ObjectMapper` for HTTP; use DTOs at boundary; verify `MappingJackson2HttpMessageConverter` uses the same mapper:

```java
@Bean
@Primary
ObjectMapper objectMapper(Jackson2ObjectMapperBuilder builder) {
    return builder
        .serializationInclusion(JsonInclude.Include.NON_NULL)
        .featuresToDisable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .build();
}
```

Boot's `JacksonAutoConfiguration` wires this into MVC automatically when you customize via builder.

---

## 6. @RestController vs @Controller

### Core concept

`@Controller` marks a Spring MVC stereotype: handler methods return **logical view names** or `ModelAndView` unless annotated with `@ResponseBody`. `@RestController` is a composed annotation: `@Controller` + `@ResponseBody` on every handler method.

Use `@Controller` when rendering HTML (Thymeleaf, JSP), redirects, or mixed REST + server-rendered pages in one class (discouraged at scale — split modules). Use `@RestController` for JSON/XML APIs.

| Aspect | `@Controller` | `@RestController` |
|---|---|---|
| Default return semantics | View name | Serialized body |
| Typical stack | Thymeleaf + form posts | Jackson + validation |
| Error pages | `@ExceptionHandler` + error view | `@ControllerAdvice` + `ProblemDetail` |
| CSRF | Relevant for browser forms | Usually N/A (Bearer APIs) |

### Internal working

`RestControllerAnnotationBeanPostProcessor` (via `@RestController` meta) ensures class-level `@ResponseBody` semantics. Return value processing goes to `RequestResponseBodyMethodProcessor`, not `ViewNameMethodReturnValueHandler`.

You can override per method on `@Controller`:

```java
@Controller
public class MixedController {

    @GetMapping("/page")
    public String page(Model model) {
        model.addAttribute("title", "Home");
        return "home"; // → home.html
    }

    @GetMapping("/api/status")
    @ResponseBody
    public Map<String, String> status() {
        return Map.of("status", "UP");
    }
}
```

Returning `ResponseEntity<String>` from `@Controller` without `@ResponseBody` still goes through entity processor if registered — prefer explicit `@ResponseBody` or use `@RestController` for API classes to avoid ambiguity.

### Production scenario: API returns HTML error page on validation failure

**Problem.** REST clients parse JSON errors; after adding Thymeleaf, some validation failures return HTML `<!DOCTYPE html>`.

**Cause.** `@ControllerAdvice` class also used for MVC pages, or default `/error` Whitelabel HTML. Exception handler method returns `String` view name without `@ResponseBody` and without `produces = JSON`.

**Solution.** Separate advice beans or explicit produces:

```java
@RestControllerAdvice(assignableTypes = OrderApiController.class)
public class OrderApiExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ProblemDetail> handleValidation(MethodArgumentNotValidException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(
            HttpStatus.BAD_REQUEST, "Validation failed");
        pd.setProperty("errors", ex.getBindingResult().getFieldErrors().stream()
            .map(fe -> Map.of("field", fe.getField(), "message", fe.getDefaultMessage()))
            .toList());
        return ResponseEntity.badRequest().body(pd);
    }
}
```

Use `@RestControllerAdvice` (includes `@ResponseBody` on handler methods) for API-only advice.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Controller` + forgot `@ResponseBody` on JSON endpoint | 200 with view name `"orderDto"` as literal or 404 view |
| Splitting API and UI in same `@Controller` | Security matcher complexity; harder testing |
| `@RestController` returning `"redirect:/login"` | JSON string `"redirect:/login"` instead of redirect |
| `@ControllerAdvice` without `@ResponseBody` on exception methods | HTML or empty body for API errors |

### Debugging scenario

**Observe.** Swagger shows endpoint; response body is empty with 200.

**Diagnose.** Method returns `void` — valid, empty body. Or returns domain object but getter-less / all fields null and `JsonInclude.NON_EMPTY` strips everything. Or `@RestController` method returns `Optional.empty()` incorrectly (should return 404 via `ResponseEntity`).

**Fix.**

```java
@GetMapping("/{id}")
public ResponseEntity<OrderDto> get(@PathVariable UUID id) {
    return orderService.findById(id)
        .map(ResponseEntity::ok)
        .orElse(ResponseEntity.notFound().build());
}
```

---

## 7. @RequestMapping Variants and Path Matching

### Core concept

HTTP mapping annotations are composed `@RequestMapping`:

| Annotation | HTTP method |
|---|---|
| `@GetMapping` | GET |
| `@PostMapping` | POST |
| `@PutMapping` | PUT |
| `@PatchMapping` | PATCH |
| `@DeleteMapping` | DELETE |

Class-level `@RequestMapping("/api/orders")` + method-level `@GetMapping("/{id}")` → `/api/orders/{id}`.

Boot 3 / Spring Framework 6 defaults:

- **PathPattern** matching (not Ant unless configured)
- **`trailingSlashMatch = false`** by default (since 6.0) — `/users` and `/users/` are different
- **Case-sensitive** paths on case-sensitive filesystems

### Internal working

`RequestMappingHandlerMapping` builds `RequestMappingInfo`:

```
Paths:     PathPatternsRequestCondition
Methods:   RequestMethodsRequestCondition
Params:    RequestParamsRequestCondition      (@RequestMapping(params="debug=true"))
Headers:   RequestHeadersRequestCondition
Consumes:  ConsumesRequestCondition           (Content-Type)
Produces:  ProducesRequestCondition           (Accept)
Custom:    CustomRequestCondition              (e.g. @ApiVersion)
```

Matching algorithm picks **best pattern** among candidates — more literal segments beat `{variables}`; longer paths beat shorter.

PathPattern syntax highlights:

```
/users/{id}           → one segment variable
/users/{id:\\d+}      → regex constraint on path variable
/files/{*path}        → capture rest of path (Servlet 5 / PathPattern)
/users/**             → sub-path wildcard (careful with security matchers)
```

Legacy `AntPathMatcher` used `**` differently at middle positions — audit when migrating Boot 2 → 3.

### Production scenario: PATCH endpoint never called, PUT works

**Problem.** Client sends `PATCH /api/items/1`. Server returns 405; logs show mapped to `PUT` only.

**Cause.** Method not annotated with `@PatchMapping`; or gateway blocks PATCH; or Spring Security `HttpMethod` rule denies PATCH.

**Solution.**

```java
@PatchMapping("/{id}")
public OrderDto partialUpdate(@PathVariable UUID id,
                              @RequestBody JsonMergePatch patch) {
    return orderService.applyPatch(id, patch);
}
```

Verify infrastructure: some proxies only allow GET/POST. For partial updates without PATCH support, expose `POST /{id}:partialUpdate` (RPC-style) or document PUT-only semantics.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Duplicate paths, different methods, one forgotten | 405 instead of expected method |
| `/**` in middle of pattern with PathPattern | Parse error or unexpected match |
| Trailing slash mismatch after Spring 6 upgrade | 404 on `/resource/` when mapped `/resource` |
| `@RequestMapping` without method on class + method | All HTTP verbs hit same handler — surprise DELETE |

### Debugging scenario

**Observe.** Actuator `/mappings` shows endpoint; real requests 404.

**Diagnose.** Compare servlet path vs pattern. Enable:

```yaml
logging:
  level:
    org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping: DEBUG
```

Request log: `Mapped to org.example.OrderController#get(UUID)`. If "No mapping", dump `request.getRequestURI()`, `getServletPath()`, `getContextPath()`.

**Fix.** Align gateway rewrite, context path, and `@RequestMapping` on servlet-relative paths.

---

## 8. Path Variables, Request Params, and Headers

### Core concept

Three ways to pass data on GET (and others):

| Mechanism | Source | Example |
|---|---|---|
| `@PathVariable` | URI template | `/orders/{orderId}` |
| `@RequestParam` | Query string (or form field) | `?page=0&size=20` |
| `@RequestHeader` | HTTP header | `X-Request-Id`, `Accept-Language` |

Also: `@CookieValue`, `@MatrixVariable` (rare), `@RequestAttribute` (forward/include attributes).

Required by default for `@RequestParam` without default value — missing param → 400. `@PathVariable` missing if pattern didn't match (404). Optional: `@RequestParam(required = false)` or `Optional<T>` / `@Nullable`.

### Internal working

**Path variables:** extracted from matched `PathPattern` URI template variables map. Name default = parameter name (requires `-parameters` compiler flag for Java, enabled in Boot parent POM). Explicit: `@PathVariable("orderId")`.

**Request params:** `ServletRequest.getParameter()` / `getParameterValues()`. Multi-value: `List<String> tags` or `String[] tags`.

**Headers:** single value or `List<String>` for repeated headers. Type conversion via `ConversionService` (String → int, UUID, enum, ISO date if registered).

**Optional binding:**

```java
@GetMapping("/search")
public Page<OrderDto> search(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "20") @Max(100) int size,
        @RequestParam(required = false) OrderStatus status,
        @RequestHeader(value = "X-Tenant-Id", required = false) UUID tenantId) {
    return orderService.search(page, size, status, tenantId);
}
```

UUID conversion fails → 400 `MethodArgumentTypeMismatchException` unless handled in advice.

### Production scenario: enum query param works in dev, 400 in prod

**Problem.** `?status=SHIPPED` returns 400 Bad Request in production only.

**Cause.** Client sends `status=shipped` (lowercase); Spring enum binding is case-sensitive by default. Dev tests always used uppercase.

**Solution.** Custom converter or `@InitBinder`:

```java
@InitBinder
public void initBinder(WebDataBinder binder) {
    binder.registerCustomEditor(OrderStatus.class, new CaseInsensitiveEnumEditor(OrderStatus.class));
}
```

Or accept String and map explicitly in service with clear error messages. Document API contract in OpenAPI `enum` values.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@PathVariable` name mismatch (no `-parameters`) | 400 IllegalArgumentException at startup or runtime |
| `@RequestParam` on large payload field | Wrong — use `@RequestBody` |
| Duplicate query keys, single `String` param | First or last wins (container-dependent); use `List` |
| `@RequestHeader("Authorization")` in controller | Leaks into logs; prefer `Authentication` injection |

### Debugging scenario

**Observe.** `@PathVariable UUID id` throws 400 for valid-looking UUID.

**Diagnose.** Hidden characters in URL (`%0A`, trailing space). Wrong segment — `/orders/not-a-uuid/items` if mapping loose.

**Fix.** Log raw URI at DEBUG; validate with `@Pattern` on String path var then parse in service for clearer errors.

```java
@GetMapping("/{id}")
public OrderDto get(@PathVariable @Pattern(regexp = UUID_REGEX) String id) {
    return orderService.findById(UUID.fromString(id));
}
```

---

## 9. Content Negotiation

### Core concept

Content negotiation decides **representation format** for the response (and sometimes which handler variant runs). Inputs:

- `Accept` request header
- `?format=json` query param (if configured)
- Path extension `.json` (deprecated pattern — avoid)
- `@RequestMapping(produces = ...)`

Spring MVC's `ContentNegotiationManager` resolves a `MediaType` for the response. Failure → **406 Not Acceptable**.

### Internal working

```
ContentNegotiationManager.resolveMediaTypes(NativeWebRequest)
  → ContentNegotiationStrategy chain:
       1. HeaderContentNegotiationStrategy (Accept header)
       2. ParameterContentNegotiationStrategy (format param)
       3. FixedContentNegotiationStrategy (default)
  → List<MediaType> requested
  → intersect with handler produces + converter supported types
  → pick highest priority/q compatible type
```

`Accept: application/json, application/xml;q=0.9` prefers JSON. `Accept: */*` accepts anything — default content type applies.

`ContentNegotiationConfigurer` in `WebMvcConfigurer`:

```java
@Override
public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {
    configurer
        .favorParameter(false)           // do not use ?format= — cache poisoning risk
        .ignoreAcceptHeader(false)
        .defaultContentType(MediaType.APPLICATION_JSON)
        .mediaType("json", MediaType.APPLICATION_JSON)
        .mediaType("xml", MediaType.APPLICATION_XML);
}
```

### Production scenario: CDN caches wrong representation

**Problem.** Same URL serves JSON to API clients and accidentally cached XML from an admin browser `Accept: text/html, application/xml`.

**Cause.** Cache key at CDN ignores `Accept` header. First response format wins for all clients.

**Solution.** Separate URLs for formats (`/api/orders` JSON only with `produces`), or `Vary: Accept` on responses (Spring can add via filter), or disable caching on content-negotiated endpoints. Prefer **one format per public API URL**.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `favorPathExtension(true)` on modern Spring | Removed/deprecated; security issues |
| Multiple converters, no default | 406 for `Accept: */*` edge cases |
| `produces` mismatch with actual return type | 406 despite valid JSON body possible |
| Ignoring `Accept` globally | Always default JSON — OK for pure APIs |

### Debugging scenario

**Observe.** Client sends `Accept: application/vnd.company.order+json`; gets 406.

**Diagnose.** No converter registered for custom media type. Custom type needs `MappingJackson2HttpMessageConverter` subclass or `@RequestMapping(produces = "application/vnd.company.order+json")` with Jackson only if you treat it as JSON (register supported media type on converter bean).

**Fix.**

```java
@Bean
MappingJackson2HttpMessageConverter customJsonConverter(ObjectMapper mapper) {
    MappingJackson2HttpMessageConverter converter = new MappingJackson2HttpMessageConverter(mapper);
    converter.setSupportedMediaTypes(List.of(
        MediaType.APPLICATION_JSON,
        MediaType.parseMediaType("application/vnd.company.order+json")));
    return converter;
}
```

Register via `WebMvcConfigurer.extendMessageConverters` — avoid duplicating default converters incorrectly.

---

## 10. Content Negotiation Depth: Accept Parsing, Converters, and Media-Type Versioning

### Core concept

Section 9 covered the mechanism. This section is the part that generates production incidents: **how `Accept` is actually parsed**, **why 406 and 415 are constantly confused**, **how converter ordering silently changes behavior**, and **how to use media types as a versioning axis without breaking every client**.

Two rules to internalize:

- **415 Unsupported Media Type is about the request.** The server cannot *read* what the client sent. Look at `Content-Type` and `consumes`.
- **406 Not Acceptable is about the response.** The server cannot *write* anything the client said it would take. Look at `Accept` and `produces`.

Both are "media type problems," and engineers reflexively debug Jackson for both. The header you inspect is different in each case.

### Internal working

**`Accept` parsing and quality values.** `MediaType.parseMediaTypes(...)` produces a list, then `MediaType.sortBySpecificityAndQuality(...)` orders it. Specificity beats `q`, and `q` breaks ties:

```
Accept: text/*;q=0.5, application/json;q=0.9, application/*+json;q=0.9, */*;q=0.1

parsed + sorted:
  1. application/json            q=0.9   (fully concrete)
  2. application/*+json          q=0.9   (concrete type, wildcard subtype suffix)
  3. text/*                      q=0.5
  4. */*                         q=0.1
```

Notes that bite:

- `q` ranges `0.0`–`1.0`, max **three** decimals. `q=0` means "explicitly not acceptable."
- Missing `q` implies `q=1.0`.
- A malformed `Accept` (for example `application/json;q=abc`) throws `InvalidMediaTypeException` → Spring returns **400**, not 406. That surprises people debugging a "negotiation" bug.
- `*/*` accepts anything, so `defaultContentType` decides. Most mobile SDKs send `*/*` — your default is your real contract.

**Producible-type resolution.** `AbstractMessageConverterMethodProcessor.writeWithMessageConverters()`:

```
1. requested   = contentNegotiationManager.resolveMediaTypes(request)     // Accept / param / default
2. producible  = request attribute PRODUCIBLE_MEDIA_TYPES_ATTRIBUTE       // set by @RequestMapping(produces=...)
                 else union of converter.getSupportedMediaTypes(returnType)
3. compatible  = for each requested r, for each producible p:
                     if r.isCompatibleWith(p) -> add mostSpecific(r, p)
4. sort compatible by specificity + quality
5. skip wildcard-only entries, skip q=0
6. first converter whose canWrite(returnType, selected) == true wins
7. nothing left -> HttpMediaTypeNotAcceptableException -> 406
```

Step 2 is the one people miss: **`produces` on the mapping is a hard narrowing.** If `produces = "application/json"` and the client sends `Accept: application/xml`, you get **406 at the mapping level** (`HttpMediaTypeNotAcceptableException` from `ProducesRequestCondition`) — the converter list never matters. This is a feature: it makes the contract explicit rather than letting negotiation drift.

**`consumes` narrowing.** `ConsumesRequestCondition` compares `Content-Type` against `consumes`. If the path+method matched but no `consumes` matched, you get **415** and, importantly, `Accept`/`produces` are never consulted. Debugging tip: if you see 415, `Accept` is irrelevant — stop looking at it.

**`ContentNegotiationConfigurer`: parameter vs header.**

```java
@Configuration
public class NegotiationConfig implements WebMvcConfigurer {

    @Override
    public void configureContentNegotiation(ContentNegotiationConfigurer configurer) {
        configurer
            // Header strategy: standards-compliant, cache-friendly with Vary: Accept
            .ignoreAcceptHeader(false)
            // Parameter strategy: ?format=xml. Convenient for browsers, dangerous for caches.
            .favorParameter(false)
            .parameterName("format")
            // Path extension strategy was removed in Spring 6 — do not look for it.
            .defaultContentType(MediaType.APPLICATION_JSON)
            .mediaType("json", MediaType.APPLICATION_JSON)
            .mediaType("csv", MediaType.parseMediaType("text/csv"));
    }
}
```

| Strategy | Pros | Cons |
|---|---|---|
| `Accept` header (default) | Standards compliant; one canonical URL | Needs `Vary: Accept` for caches; clients send `*/*` sloppily |
| `?format=json` parameter | Trivially testable in a browser; distinct cache keys per URL | Two URLs for one resource; easy to forget in links; can be abused to bypass a `produces` contract |
| Path extension (`.json`) | — | **Removed in Spring Framework 6**; had RFD/content-sniffing security issues |

If you enable `favorParameter`, remember it is checked **before** the header, so `?format=csv` overrides `Accept: application/json`.

**Custom media types for versioning.** A vendor media type carries the version in the type itself:

```
Accept: application/vnd.acme.order.v2+json
```

Register the type on a Jackson converter so it is treated as JSON, and pin mappings with `produces`:

```java
public final class AcmeMediaTypes {
    public static final String ORDER_V1 = "application/vnd.acme.order.v1+json";
    public static final String ORDER_V2 = "application/vnd.acme.order.v2+json";
    public static final MediaType ORDER_V1_TYPE = MediaType.parseMediaType(ORDER_V1);
    public static final MediaType ORDER_V2_TYPE = MediaType.parseMediaType(ORDER_V2);
    private AcmeMediaTypes() {}
}

@Configuration
public class VendorMediaTypeConfig implements WebMvcConfigurer {

    // extendMessageConverters: adjust the existing list. Do NOT use configureMessageConverters
    // unless you intend to replace every Boot default.
    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jackson) {
                List<MediaType> supported = new ArrayList<>(jackson.getSupportedMediaTypes());
                supported.add(AcmeMediaTypes.ORDER_V1_TYPE);
                supported.add(AcmeMediaTypes.ORDER_V2_TYPE);
                jackson.setSupportedMediaTypes(supported);
            }
        }
    }
}

@RestController
@RequestMapping("/api/orders")
public class OrderNegotiatedController {

    @GetMapping(value = "/{id}", produces = AcmeMediaTypes.ORDER_V1_TYPE_VALUE)
    public OrderV1Dto getV1(@PathVariable UUID id) {
        return orderService.findV1(id);
    }

    @GetMapping(value = "/{id}", produces = AcmeMediaTypes.ORDER_V2_TYPE_VALUE)
    public OrderV2Dto getV2(@PathVariable UUID id) {
        return orderService.findV2(id);
    }
}
```

Two methods, **same path and method**, disambiguated only by `produces`. That is legal — `ProducesRequestCondition` is part of the mapping key. A client sending `Accept: */*` gets the **first registered** match, which is registration-order dependent and therefore a latent bug. Always add an explicit default:

```java
@GetMapping(value = "/{id}", produces = MediaType.APPLICATION_JSON_VALUE)
public OrderV1Dto getDefault(@PathVariable UUID id) {   // "unversioned" == v1 forever
    return orderService.findV1(id);
}
```

**Registering a genuinely custom converter** (not JSON — for example CSV export):

```java
@Component
public class CsvHttpMessageConverter extends AbstractHttpMessageConverter<CsvExport> {

    public CsvHttpMessageConverter() {
        super(StandardCharsets.UTF_8, MediaType.parseMediaType("text/csv"));
    }

    @Override
    protected boolean supports(Class<?> clazz) {
        return CsvExport.class.isAssignableFrom(clazz);
    }

    @Override
    protected CsvExport readInternal(Class<? extends CsvExport> clazz, HttpInputMessage message) {
        throw new HttpMessageNotReadableException("CSV upload not supported", message);
    }

    @Override
    protected void writeInternal(CsvExport export, HttpOutputMessage message) throws IOException {
        try (Writer writer = new OutputStreamWriter(message.getBody(), StandardCharsets.UTF_8)) {
            writer.write(String.join(",", export.headers()));
            writer.write('\n');
            for (List<String> row : export.rows()) {
                writer.write(String.join(",", row));
                writer.write('\n');
            }
        }
    }
}

@Configuration
class CsvConverterConfig implements WebMvcConfigurer {
    private final CsvHttpMessageConverter csv;

    CsvConverterConfig(CsvHttpMessageConverter csv) { this.csv = csv; }

    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        // Index 0: must beat StringHttpMessageConverter and ByteArrayHttpMessageConverter,
        // both of which advertise */* and would otherwise claim the write.
        converters.add(0, csv);
    }
}
```

**Ordering rules that actually matter:**

1. `StringHttpMessageConverter`, `ByteArrayHttpMessageConverter`, and `ResourceHttpMessageConverter` all advertise `*/*`. Anything specialized must be registered **before** them.
2. `MappingJackson2XmlHttpMessageConverter` is added when `jackson-dataformat-xml` is on the classpath — merely adding that dependency changes negotiation for every `Accept: */*` client.
3. `configureMessageConverters()` **replaces** the whole list (you lose Jackson, form, resource converters). `extendMessageConverters()` mutates the Boot-built list. Use the latter in 99% of cases.

### Production scenario: adding an Excel export broke every mobile client

**Problem.** A reporting team added an XLSX export converter registered via `configureMessageConverters()`. The next morning, every mobile client received `415` on `POST /api/orders` and the web app got `406` on `GET /api/orders`.

**Cause.** `configureMessageConverters()` overrode the default converter list entirely. Jackson was gone, so nothing could read `application/json` (→ 415 on POST) and nothing could write JSON (→ 406 on GET). The reporting endpoint itself worked perfectly, which is why the change passed review — the test suite only covered the new endpoint.

**Solution.** Use `extendMessageConverters`, and add a contract test that asserts the registered converter media types.

```java
@Configuration
public class ExportConverterConfig implements WebMvcConfigurer {

    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        converters.add(0, new XlsxHttpMessageConverter());
    }
}

@SpringBootTest
class ConverterContractTest {

    @Autowired
    RequestMappingHandlerAdapter adapter;

    @Test
    void jsonConverterMustRemainRegistered() {
        boolean jsonPresent = adapter.getMessageConverters().stream()
            .anyMatch(c -> c.getSupportedMediaTypes().contains(MediaType.APPLICATION_JSON));
        assertThat(jsonPresent)
            .as("Jackson JSON converter must never be evicted from the MVC converter list")
            .isTrue();
    }

    @Test
    void xlsxConverterMustPrecedeWildcardConverters() {
        List<HttpMessageConverter<?>> converters = adapter.getMessageConverters();
        int xlsx = indexOfType(converters, XlsxHttpMessageConverter.class);
        int string = indexOfType(converters, StringHttpMessageConverter.class);
        assertThat(xlsx).isLessThan(string);
    }
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `configureMessageConverters()` instead of `extendMessageConverters()` | Mass 415 on POST and 406 on GET; only the new endpoint works |
| Custom converter registered after `StringHttpMessageConverter` | Converter never used; response is `toString()` or 406 |
| `jackson-dataformat-xml` added transitively | `Accept: */*` clients silently start receiving XML |
| `favorParameter(true)` left on in production | `?format=` bypasses the `produces` contract; CDN caches the wrong representation |
| Two mappings differing only by `produces`, no JSON default | `Accept: */*` resolution depends on bean registration order — flaky across deploys |
| Malformed `Accept` from a legacy client | 400 `InvalidMediaTypeException`, misdiagnosed as a negotiation failure |
| Vendor media type used without registering it on a converter | 406 even though the DTO serializes fine |

### Debugging scenario

**Observe.** One partner gets `406` on `GET /api/orders/{id}`. Everyone else is fine. The partner insists they send `Accept: application/vnd.acme.order.v2+json`.

**Diagnose.** Three checks, in order:

1. Log the raw header — the partner actually sends `application/vnd.acme.order.v2` with no `+json` suffix, so no Jackson converter claims it.
2. Confirm the mapping-level narrowing by looking for `HttpMediaTypeNotAcceptableException` versus a converter-level failure:

```yaml
logging:
  level:
    org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerAdapter: DEBUG
    org.springframework.web.accept: DEBUG
    org.springframework.web.servlet.mvc.method.annotation.ExceptionHandlerExceptionResolver: DEBUG
```

3. Dump what the server considers producible:

```java
@RestControllerAdvice
public class NegotiationDiagnosticsAdvice {

    @ExceptionHandler(HttpMediaTypeNotAcceptableException.class)
    public ProblemDetail handleNotAcceptable(HttpMediaTypeNotAcceptableException ex,
                                            HttpServletRequest request) {
        log.warn("406 on {} accept='{}' supported={}",
            request.getRequestURI(), request.getHeader(HttpHeaders.ACCEPT), ex.getSupportedMediaTypes());
        ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.NOT_ACCEPTABLE);
        pd.setTitle("Not Acceptable");
        pd.setDetail("No representation available for the requested Accept header");
        pd.setProperty("supported", ex.getSupportedMediaTypes().stream().map(MediaType::toString).toList());
        return pd;
    }
}
```

**Fix.** Accept both spellings by registering `application/vnd.acme.order.v2` **and** `...v2+json` on the Jackson converter during the partner's migration window, publish the canonical suffixed form in the docs, and add a deprecation log for the unsuffixed variant so you can retire it once traffic hits zero.

---

## 11. @RequestBody and @ResponseBody

### Core concept

`@RequestBody` maps the HTTP message body to a Java object via `HttpMessageConverter`. One body per request. `@ResponseBody` (or `@RestController`) serializes the return value to the HTTP response body.

Streaming alternatives: `InputStream` / `Resource` for uploads/downloads; `StreamingResponseBody` for chunked output.

Binding is **not** the same as validation — `@Valid` triggers Bean Validation after binding.

### Internal working

Request path:

```
1. Client Content-Type: application/json
2. RequestResponseBodyMethodProcessor supports @RequestBody parameter
3. MappingJackson2HttpMessageConverter.read(OrderCreateRequest.class, inputMessage)
4. Jackson ObjectMapper deserializes JSON → object
5. If @Valid present → Validator.validate(object) → BindingResult or exception
6. Controller method invoked with populated object
```

Response path:

```
1. Controller returns OrderDto
2. RequestResponseBodyMethodProcessor.handleReturnValue
3. Negotiate Content-Type from produces / Accept
4. MappingJackson2HttpMessageConverter.write(dto, ...)
5. Content-Type: application/json in response
```

Generic types preserved via `MethodParameter.getGenericParameterType()` — `List<OrderDto>` works; raw types lose element type info.

`HttpEntity<OrderDto>` / `ResponseEntity<OrderDto>` add status and headers; body still converted the same way.

### Production scenario: large JSON payload causes OOM

**Problem.** `POST /api/import` with 200 MB JSON kills heap.

**Cause.** Default Jackson reads entire stream into memory. `@RequestBody List<RowDto>` materializes full list.

**Solution.** Stream with `InputStream` + Jackson `JsonParser`, or multipart file upload, or batch endpoint with pagination. For true streaming upload, consider WebFlux or servlet 3.1 async read patterns.

```java
@PostMapping(value = "/import", consumes = MediaType.APPLICATION_JSON_VALUE)
public ImportResult importOrders(@RequestBody InputStream body) throws IOException {
    try (JsonParser parser = objectMapper.getFactory().createParser(body)) {
        return orderImportService.processStream(parser);
    }
}
```

Set Tomcat `maxSwallowSize` and connection limits; reject oversized bodies at gateway.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@RequestBody` on GET | Semantically wrong; some clients/proxies strip body |
| Missing `@RequestBody` on JSON POST | All fields null; silent logic bugs |
| `@RequestBody String` expecting raw JSON | Works but bypasses validation structure |
| `@ResponseBody` on `Optional<OrderDto>` | Serializes as JSON object `{"present":true,...}` — not 404 semantics |

### Debugging scenario

**Observe.** Client sends JSON; server says "Content type 'application/json' not supported" (415).

**Diagnose.** Missing Jackson on classpath; custom `WebMvcConfigurer` replaced all converters; `@RequestMapping(consumes = "application/xml")` on method.

**Fix.** Restore `MappingJackson2HttpMessageConverter`; align `consumes` with client `Content-Type` including charset (`application/json;charset=UTF-8` usually still matches).

---

## 12. Jackson Integration

### Core concept

Jackson is the default JSON engine for Spring MVC via `MappingJackson2HttpMessageConverter`. Configuration surfaces:

- **`ObjectMapper` `@Bean`** — global JSON behavior
- **`Jackson2ObjectMapperBuilder`** — Boot-friendly customization
- **Annotations** — `@JsonProperty`, `@JsonIgnore`, `@JsonFormat` on DTOs
- **`application.properties`** — `spring.jackson.*` namespace

Keep **persistence entities off the wire** — map to DTOs. Entities carry lazy proxies, circular refs, and schema churn.

### Internal working

Boot `JacksonAutoConfiguration`:

```
Jackson2ObjectMapperBuilder (customizable)
  → ObjectMapper bean (@Primary)
  → MappingJackson2HttpMessageConverter registered in HttpMessageConverters
```

Key `spring.jackson` properties:

```yaml
spring:
  jackson:
    serialization:
      write-dates-as-timestamps: false
      indent-output: false
    deserialization:
      fail-on-unknown-properties: false
    default-property-inclusion: non_null
    property-naming-strategy: SNAKE_CASE  # careful with existing clients
```

Modules auto-registered: Java 8 dates (`JavaTimeModule`), parameter names, Kotlin (if present).

Custom module example:

```java
@Bean
Jackson2ObjectMapperBuilderCustomizer moneyModuleCustomizer() {
    return builder -> builder.modules(new SimpleModule()
        .addSerializer(Money.class, new MoneySerializer())
        .addDeserializer(Money.class, new MoneyDeserializer()));
}
```

HTTP-specific vs general `ObjectMapper`: if you `@Autowired ObjectMapper` in services and customize HTTP separately, you get drift. Prefer one `@Primary` mapper or explicit `@Qualifier("httpObjectMapper")`.

### Production scenario: Instant serialized as epoch millis after upgrade

**Problem.** Mobile clients expect ISO-8601 strings; after Boot 3 upgrade they receive numbers.

**Cause.** Custom `ObjectMapper` replaced Boot defaults without `JavaTimeModule` and with `WRITE_DATES_AS_TIMESTAMPS` enabled.

**Solution.**

```java
@Bean
@Primary
ObjectMapper objectMapper(Jackson2ObjectMapperBuilder builder) {
    return builder
        .modules(new JavaTimeModule())
        .featuresToDisable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .build();
}
```

Contract-test JSON snapshots in CI for public APIs.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@JsonIgnore` on entity field needed in API | Missing field in response — use DTO |
| `FAIL_ON_UNKNOWN_PROPERTIES=true` for public API | Client 400 on extra fields during rollout |
| Polymorphic types without `@JsonTypeInfo` | Deserialize as LinkedHashMap or fail |
| Hibernate proxy serialized | `LazyInitializationException` or empty `{}` for lazy fields |

### Debugging scenario

**Observe.** Circular reference between `Order` and `Customer` → 500 or infinite JSON.

**Diagnose.** Jackson `InvalidDefinitionException: direct self-reference`. Entity graph returned from `@RestController`.

**Fix.** DTO projection; or `@JsonManagedReference` / `@JsonBackReference` (fragile); or `@JsonIdentityInfo` (verbose). Best: break cycle in mapping layer.

```java
public OrderDto toDto(Order order) {
    return new OrderDto(
        order.getId(),
        order.getTotal(),
        new CustomerSummary(order.getCustomer().getId(), order.getCustomer().getName())
    );
}
```

---

## 13. Validation: @Valid, @Validated, and Groups

### Core concept

Bean Validation (Jakarta Validation 3.x / Hibernate Validator) validates object graphs at runtime. In MVC:

- **`@Valid`** on `@RequestBody`, `@ModelAttribute`, or method params — triggers validation after binding
- **`@Validated`** on class level — enables method-level validation and validation groups on `@RequestParam` / service methods
- **Groups** — interface markers like `Create.class`, `Update.class` select which constraints apply

Validation failures before controller body: `MethodArgumentNotValidException` (`@RequestBody`) or `BindException` (`@ModelAttribute`).

### Internal working

```
RequestMappingHandlerAdapter invokes handler
  → RequestResponseBodyMethodProcessor resolves @RequestBody
  → WebDataBinder / validator (OptionalValidatorFactoryBean)
  → if @Valid: validator.validate(object, validationGroups...)
  → if BindingResult has errors:
       throw MethodArgumentNotValidException (no @ExceptionHandler → 500 default)
  → else invoke controller method
```

Group selection:

```java
public interface OnCreate {}
public interface OnUpdate {}

public record OrderRequest(
    @Null(groups = OnCreate.class)
    @NotNull(groups = OnUpdate.class)
    UUID id,

    @NotBlank(groups = {OnCreate.class, OnUpdate.class})
    String sku
) {}

@PostMapping
public ResponseEntity<OrderDto> create(@RequestBody @Validated(OnCreate.class) OrderRequest req) { }

@PutMapping("/{id}")
public OrderDto update(@PathVariable UUID id,
                       @RequestBody @Validated(OnUpdate.class) OrderRequest req) { }
```

`@Validated` on `@Configuration` service classes enables `@NotNull` on method parameters when called through Spring proxy (not self-invocation).

### Production scenario: validation works in Postman, bypassed in production

**Problem.** Invalid emails stored in DB. Logs show controller receives bad data without 400.

**Cause.** Validation on service interface but controller calls `this.createInternal()` (self-invocation) bypassing AOP proxy. Or `@Valid` missing on `@RequestBody`.

**Solution.** Validate at boundary:

```java
@PostMapping
public ResponseEntity<OrderDto> create(@Valid @RequestBody OrderCreateRequest request) {
    return ResponseEntity.status(HttpStatus.CREATED).body(orderService.create(request));
}
```

Service layer validation is defense in depth, not a substitute for MVC `@Valid`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Valid` without jakarta.validation-api on classpath | Silent no-op or startup failure |
| Constraints on interface, validated impl not proxied | Validation skipped |
| `@NotEmpty` on `@RequestParam int` | Wrong annotation for type |
| Custom validator accessing DB without transaction | Lazy init errors or stale reads |

### Debugging scenario

**Observe.** Field error message is generic `"must not be null"`; clients need field names.

**Diagnose.** Default `MethodArgumentNotValidException` handler missing or returns plain text.

**Fix.** Structured `ProblemDetail` with field errors (see sections 14 and 15). Enable `server.error.include-binding-errors=never` in prod for security on non-API endpoints.

```java
@ExceptionHandler(MethodArgumentNotValidException.class)
public ResponseEntity<ProblemDetail> handle(MethodArgumentNotValidException ex) {
    ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
    pd.setTitle("Validation failed");
    pd.setProperty("violations", ex.getBindingResult().getFieldErrors().stream()
        .map(fe -> Map.of(
            "field", fe.getField(),
            "rejectedValue", fe.getRejectedValue(),
            "message", fe.getDefaultMessage()))
        .toList());
    return ResponseEntity.badRequest().body(pd);
}
```

---

## 14. Exception Handling: @ControllerAdvice and ProblemDetail (RFC 7807)

### Core concept

Unhandled exceptions from controllers propagate to **`HandlerExceptionResolver`** chain. `@ControllerAdvice` + `@ExceptionHandler` methods are the production pattern for consistent API errors.

Spring Framework 6 / Boot 3 ships **`ProblemDetail`** (RFC 7807) for machine-readable errors:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "Order 7c9e6679-7425-40de-944b-e07fc1f90ae7 not found",
  "instance": "/api/orders/7c9e6679-7425-40de-944b-e07fc1f90ae7"
}
```

Use `@RestControllerAdvice` for JSON APIs. Order multiple `@ExceptionHandler` methods from specific to general.

### Internal working

Resolver chain (simplified order):

```
1. ExceptionHandlerExceptionResolver  → @ExceptionHandler in @ControllerAdvice
2. ResponseStatusExceptionResolver    → @ResponseStatus on exception class
3. DefaultHandlerExceptionResolver    → Spring MVC standard exceptions → status codes
4. (Custom resolvers)
```

`ExceptionHandlerExceptionResolver` selects best matching `@ExceptionHandler` method by exception type distance. `@ControllerAdvice` scoping:

```java
@RestControllerAdvice(basePackageClasses = ApiControllers.class)
@RestControllerAdvice(assignableTypes = {OrderController.class})
@RestControllerAdvice(annotations = RestApi.class)
```

Boot 3 **`ProblemDetail`** integration:

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(OrderNotFoundException.class)
    public ProblemDetail handleNotFound(OrderNotFoundException ex, HttpServletRequest request) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setType(URI.create("https://api.company.com/problems/order-not-found"));
        pd.setInstance(URI.create(request.getRequestURI()));
        pd.setProperty("orderId", ex.getOrderId());
        return pd;
    }

    @ExceptionHandler(Exception.class)
    public ProblemDetail handleUnexpected(Exception ex, HttpServletRequest request) {
        log.error("Unhandled error on {}", request.getRequestURI(), ex);
        ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.INTERNAL_SERVER_ERROR);
        pd.setDetail("An unexpected error occurred");
        return pd;
    }
}
```

`ResponseEntityExceptionHandler` subclass for fine control over Spring's own exceptions (`MethodArgumentNotValidException`, etc.).

Enable RFC 7807 content type (Boot 3.2+):

```yaml
spring:
  mvc:
    problemdetails:
      enabled: true
```

### Production scenario: stack traces leak to clients

**Problem.** Security scan finds `500` responses include Java stack traces and SQL fragments.

**Cause.** `server.error.include-stacktrace=always` in prod profile copy-paste; or custom handler puts `ex.getMessage()` from Hibernate/SQL exceptions into `detail`.

**Solution.**

```yaml
server:
  error:
    include-stacktrace: never
    include-message: never
    include-binding-errors: never
```

Map domain exceptions to safe messages; log full exception server-side with correlation ID in `ProblemDetail` extension property.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Multiple `@ControllerAdvice` beans, overlapping handlers | Unpredictable handler wins by `@Order` |
| `@ExceptionHandler` in controller only | Not applied to other controllers |
| Returning wrong status in `ResponseEntity` body only | HTTP status still 200 with error JSON |
| `ProblemDetail` without `@RestControllerAdvice` | Serialized wrong or as view |

### Debugging scenario

**Observe.** Custom `BusinessException` returns 500 instead of 409.

**Diagnose.** Handler method signature wrong exception type; or more general `@ExceptionHandler(Exception.class)` declared first without `@Order`; or exception wrapped in `ServletException`.

**Fix.**

```java
@ExceptionHandler(BusinessException.class)
@ResponseStatus(HttpStatus.CONFLICT)
public ProblemDetail handleBusiness(BusinessException ex) {
    return ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, ex.getUserMessage());
}
```

Log `ex.getCause()` chain in handler to detect wrapping.

---

## 15. Problem Details in Depth: RFC 7807, RFC 9457, and ErrorResponse

### Core concept

RFC 7807 defined `application/problem+json`. **RFC 9457 obsoletes it** (published July 2023) — the wire format is unchanged, but 9457 tightens the language around extension members and explicitly permits multiple problem types per response family. Practically: if you built to 7807, you are already compliant with 9457. Spring's Javadoc still says 7807; that is a documentation lag, not a format difference.

The object model in Spring Framework 6:

| Type | Role |
|---|---|
| `ProblemDetail` | The payload. Mutable bean with `type`, `title`, `status`, `detail`, `instance`, plus a `Map<String,Object>` of extensions. |
| `ErrorResponse` | Interface: "an exception that knows its own HTTP status, headers, and `ProblemDetail`." |
| `ErrorResponseException` | Ready-made `ErrorResponse` implementation you can throw or subclass. |
| `ResponseEntityExceptionHandler` | Base advice class that already maps every Spring MVC exception to `ProblemDetail`. |
| `ProblemDetailsExceptionHandler` | Boot's auto-configured advice, enabled by `spring.mvc.problemdetails.enabled=true`. |

The five standard members:

```json
{
  "type": "https://api.acme.com/problems/insufficient-funds",
  "title": "Insufficient funds",
  "status": 409,
  "detail": "Account ACC-8891 has a balance of 12.40 EUR; 89.00 EUR required",
  "instance": "/api/accounts/ACC-8891/withdrawals"
}
```

- **`type`** — a URI that identifies the *problem class*. It is an identifier, not necessarily a dereferenceable URL. Default `about:blank`, which means "the status code is the whole story."
- **`title`** — short, human-readable, **stable per `type`**. Do not put per-request data here.
- **`status`** — must equal the HTTP status. Duplication is intentional (proxies mangle statuses).
- **`detail`** — human-readable and request-specific. This is where interpolated values belong.
- **`instance`** — URI identifying *this occurrence*. Either the request URI or an error-ID URI.

**Clients must key logic off `type`, never off `title` or `detail`.** Titles get reworded, details get translated. That is the whole point of the split.

### Internal working

**Boot's auto-configured handler.** Setting the flag registers `ProblemDetailsExceptionHandler` (an `@ControllerAdvice` extending `ResponseEntityExceptionHandler`) at `Ordered.LOWEST_PRECEDENCE - 10`:

```yaml
spring:
  mvc:
    problemdetails:
      enabled: true
```

Effects:

- Every Spring MVC exception (`MethodArgumentNotValidException`, `HttpMessageNotReadableException`, `NoResourceFoundException`, `HttpMediaTypeNotAcceptableException`, ...) now returns `application/problem+json` instead of Boot's `{"timestamp","status","error","path"}` shape.
- **The default error DTO disappears for those exceptions.** Any client parsing `error` or `timestamp` breaks. This is a breaking change disguised as a config flag.
- It does **not** cover your own exceptions. Those still need an `@ExceptionHandler` or must implement `ErrorResponse`.
- If you already extend `ResponseEntityExceptionHandler` yourself, leave the flag **off** — two advices competing over the same exceptions resolves by `@Order`, and the loser is silently ignored.

**Self-describing exceptions via `ErrorResponse`.** This removes the need for a handler method per exception:

```java
public class InsufficientFundsException extends ErrorResponseException {

    private static final URI TYPE =
        URI.create("https://api.acme.com/problems/insufficient-funds");

    public InsufficientFundsException(String accountId, Money balance, Money requested) {
        super(HttpStatus.CONFLICT, problemDetail(accountId, balance, requested), null);
        // messageDetailCode drives i18n lookup; see the i18n block below
        setDetailMessageCode("problemDetail.insufficientFunds");
        setDetailMessageArguments(new Object[] { accountId, balance, requested });
    }

    private static ProblemDetail problemDetail(String accountId, Money balance, Money requested) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT,
            "Account %s has a balance of %s; %s required".formatted(accountId, balance, requested));
        pd.setType(TYPE);
        pd.setTitle("Insufficient funds");
        pd.setProperty("accountId", accountId);
        pd.setProperty("balance", balance.amount());
        pd.setProperty("requested", requested.amount());
        pd.setProperty("currency", balance.currency().getCurrencyCode());
        return pd;
    }
}
```

`ResponseEntityExceptionHandler` handles any `ErrorResponse` generically, so throwing this from a service produces a correct 409 `problem+json` with **no advice code at all**.

**Extension members.** `setProperty(...)` writes into the extensions map, serialized flat at the top level (not nested). Rules from RFC 9457:

- Extension names must not collide with the five standard members.
- Clients must ignore unknown extensions, so **adding** an extension is backward compatible; **removing or retyping** one is not.
- Keep them machine-readable: `"balance": 12.40`, not `"balance": "12.40 EUR"`.

**`type` URI conventions.** Pick one scheme and never deviate:

```
https://api.acme.com/problems/{kebab-case-problem-name}
```

| Convention | Verdict |
|---|---|
| `https://api.acme.com/problems/order-not-found` | Best. Namespaced, stable, resolvable to docs. |
| `urn:acme:problem:order-not-found` | Fine. Honest about not being fetchable. |
| `about:blank` | Only when the status code alone is the full meaning. |
| `/problems/order-not-found` (relative) | Resolved against the request URI by clients — same problem gets different identities on different hosts. Avoid. |
| `https://acme.com/errors/E4021` | Opaque codes force a lookup table; kebab names are self-documenting. |

Rule: **a `type` URI is forever.** Once a client branches on it, it is API surface. Version the *shape* via extensions, never by minting `...order-not-found-v2`.

Centralize them:

```java
public final class ProblemTypes {

    private static final String BASE = "https://api.acme.com/problems/";

    public static final URI ORDER_NOT_FOUND      = URI.create(BASE + "order-not-found");
    public static final URI VALIDATION_FAILED    = URI.create(BASE + "validation-failed");
    public static final URI INSUFFICIENT_FUNDS   = URI.create(BASE + "insufficient-funds");
    public static final URI CONCURRENT_MODIFIED  = URI.create(BASE + "concurrent-modification");
    public static final URI RATE_LIMIT_EXCEEDED  = URI.create(BASE + "rate-limit-exceeded");
    public static final URI IDEMPOTENCY_CONFLICT = URI.create(BASE + "idempotency-key-reuse");

    private ProblemTypes() {}
}
```

**i18n of `detail`.** `ResponseEntityExceptionHandler` resolves `detail` through the `MessageSource` using `getDetailMessageCode()` and `getDetailMessageArguments()`. Wire it up:

```yaml
spring:
  messages:
    basename: messages,problems
    encoding: UTF-8
    fallback-to-system-locale: false
```

```properties
# problems_en.properties
problemDetail.insufficientFunds=Account {0} has a balance of {1}; {2} required
problemDetail.title.insufficientFunds=Insufficient funds
problemDetail.org.springframework.web.bind.MethodArgumentNotValidException=Request body failed validation

# problems_de.properties
problemDetail.insufficientFunds=Konto {0} hat ein Guthaben von {1}; {2} erforderlich
problemDetail.title.insufficientFunds=Nicht ausreichende Deckung
```

Spring's built-in exceptions use the code pattern `problemDetail.<fully.qualified.ExceptionClassName>` and `problemDetail.title.<...>`. Locale comes from the `LocaleResolver` — for APIs, drive it from `Accept-Language`:

```java
@Bean
LocaleResolver localeResolver() {
    AcceptHeaderLocaleResolver resolver = new AcceptHeaderLocaleResolver();
    resolver.setSupportedLocales(List.of(Locale.ENGLISH, Locale.GERMAN, Locale.FRENCH));
    resolver.setDefaultLocale(Locale.ENGLISH);
    return resolver;
}
```

**Critical i18n rule:** translate `title` and `detail`; **never** translate `type`, extension names, or extension enum values. And if you translate error responses, you must emit `Vary: Accept-Language` or a cache will serve German errors to English clients (see section 24).

### Production scenario: migrating a bespoke error DTO without breaking clients

**Problem.** A five-year-old API returns a homegrown error envelope. Forty-plus known consumers parse it, including two partners with a six-month release cycle:

```json
{
  "success": false,
  "errorCode": "ORDER_NOT_FOUND",
  "errorMessage": "Order 7c9e6679 not found",
  "timestamp": "2026-03-11T09:14:02Z",
  "fieldErrors": [{ "field": "quantity", "reason": "must be positive" }]
}
```

The platform team wants RFC 9457. Flipping `spring.mvc.problemdetails.enabled=true` in staging broke 11 of 14 partner smoke tests immediately.

**Cause.** A hard cutover changes the response body shape for every existing consumer at once. `errorCode` had also become a de-facto contract: partners `switch` on those strings, and there is no mapping table anywhere.

**Solution.** A three-phase migration where the union payload is valid under both contracts, gated by negotiation rather than a deploy date.

**Phase 1 — superset body.** Emit `problem+json` members *and* keep every legacy field. Both parsers succeed on the same bytes.

```java
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE + 100)
public class MigratingErrorAdvice extends ResponseEntityExceptionHandler {

    private final ErrorCodeCatalog catalog;   // legacy errorCode <-> problem type mapping
    private final Clock clock;

    public MigratingErrorAdvice(ErrorCodeCatalog catalog, Clock clock) {
        this.catalog = catalog;
        this.clock = clock;
    }

    @ExceptionHandler(OrderNotFoundException.class)
    public ResponseEntity<ProblemDetail> handleOrderNotFound(OrderNotFoundException ex,
                                                            HttpServletRequest request) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setType(ProblemTypes.ORDER_NOT_FOUND);
        pd.setTitle("Order not found");
        pd.setInstance(URI.create(request.getRequestURI()));
        pd.setProperty("orderId", ex.getOrderId());
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
            .contentType(negotiatedErrorType(request))
            .body(withLegacyFields(pd, "ORDER_NOT_FOUND", ex.getMessage(), request));
    }

    // Every Spring MVC exception funnels through this hook in ResponseEntityExceptionHandler.
    @Override
    protected ResponseEntity<Object> createResponseEntity(Object body, HttpHeaders headers,
                                                          HttpStatusCode status, WebRequest request) {
        if (body instanceof ProblemDetail pd && request instanceof ServletWebRequest swr) {
            String legacyCode = catalog.legacyCodeFor(pd.getType(), status);
            withLegacyFields(pd, legacyCode, pd.getDetail(), swr.getRequest());
        }
        return super.createResponseEntity(body, headers, status, request);
    }

    private ProblemDetail withLegacyFields(ProblemDetail pd, String errorCode,
                                           String message, HttpServletRequest request) {
        // Deprecated extension members: removed in phase 3.
        pd.setProperty("success", false);
        pd.setProperty("errorCode", errorCode);
        pd.setProperty("errorMessage", message);
        pd.setProperty("timestamp", clock.instant().toString());
        legacyClientMetrics.increment(request.getHeader("X-Client-Id"), errorCode);
        return pd;
    }

    // problem+json only for clients that asked for it; legacy clients keep application/json.
    private MediaType negotiatedErrorType(HttpServletRequest request) {
        String accept = Objects.requireNonNullElse(request.getHeader(HttpHeaders.ACCEPT), "");
        return accept.contains(MediaType.APPLICATION_PROBLEM_JSON_VALUE)
            ? MediaType.APPLICATION_PROBLEM_JSON
            : MediaType.APPLICATION_JSON;
    }
}
```

Wire response:

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
Deprecation: version="2026-03-11"
Sunset: Wed, 30 Sep 2026 00:00:00 GMT
Link: <https://docs.acme.com/migrations/problem-details>; rel="deprecation"

{
  "type": "https://api.acme.com/problems/order-not-found",
  "title": "Order not found",
  "status": 404,
  "detail": "Order 7c9e6679 not found",
  "instance": "/api/orders/7c9e6679",
  "orderId": "7c9e6679",
  "success": false,
  "errorCode": "ORDER_NOT_FOUND",
  "errorMessage": "Order 7c9e6679 not found",
  "timestamp": "2026-03-11T09:14:02Z"
}
```

**Phase 2 — measure, do not guess.** `legacyClientMetrics` tags every error response with `X-Client-Id`. Build one dashboard question: *which clients still receive a response where the legacy fields are the only ones they could be using?* You cannot see client-side parsing directly, so use `Accept` as the proxy: a client sending `Accept: application/problem+json` has migrated. Chase the rest by name. Do not proceed while any tagged client is above zero.

**Phase 3 — drop the legacy members.** Delete `withLegacyFields`, remove `Deprecation`/`Sunset`, return `application/problem+json` unconditionally, and delete `ErrorCodeCatalog`. Keep the `type` URIs forever.

Preserve the `errorCode` semantics as a first-class extension so nothing is actually lost:

```java
pd.setProperty("code", "ORDER_NOT_FOUND");   // machine-stable, documented, permanent
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `spring.mvc.problemdetails.enabled=true` flipped without client audit | Silent breakage of every consumer parsing `timestamp`/`error`; usually found in partner support tickets |
| Flag enabled **and** a custom `ResponseEntityExceptionHandler` | One advice wins by `@Order`; the other's mappings vanish with no warning |
| `type` left as `about:blank` everywhere | Clients cannot distinguish problem classes; they regex `detail` and break on rewording |
| Relative `type` URI | Same logical problem gets different identities per host/path |
| Request-specific data in `title` | Cache keys explode; clients that dedupe by title flood |
| Exception message piped straight into `detail` | SQL fragments, table names, internal hostnames leak to clients |
| `ProblemDetail` returned from a plain `@ControllerAdvice` (no `@ResponseBody`) | Treated as a view name → 500 or blank body |
| `Content-Type: application/json` on a problem body | Compliant clients don't recognize it as a problem; content-type sniffers mis-handle it |
| i18n applied to `type` or extension keys | Clients branching on German type URIs; contract fragmentation |
| Translated errors without `Vary: Accept-Language` | Cached German errors served to English clients |

### Debugging scenario

**Observe.** Validation failures return a correct `problem+json` body, but a custom `PaymentDeclinedException` returns Boot's Whitelabel `{"timestamp":...,"error":"Internal Server Error"}` with status 500 — even though the exception is annotated `@ResponseStatus(HttpStatus.PAYMENT_REQUIRED)`.

**Diagnose.** Two distinct failures stacked:

1. `spring.mvc.problemdetails.enabled=true` covers only Spring's own exceptions. `PaymentDeclinedException` is not one, so it falls through to `ErrorMvcAutoConfiguration`'s `/error` dispatch.
2. The 500 rather than 402 means `ResponseStatusExceptionResolver` never saw the annotation — the exception was wrapped. Check for `UndeclaredThrowableException` (checked exception thrown through a proxied interface) or `CompletionException` (thrown inside a `CompletableFuture`).

Confirm both:

```yaml
logging:
  level:
    org.springframework.web.servlet.mvc.method.annotation.ExceptionHandlerExceptionResolver: DEBUG
    org.springframework.boot.autoconfigure.web.servlet.error: DEBUG
```

```java
@ExceptionHandler(Exception.class)
public ProblemDetail lastResort(Exception ex, HttpServletRequest request) {
    // Log the whole cause chain: the useful frame is rarely the outermost one.
    for (Throwable t = ex; t != null && t != t.getCause(); t = t.getCause()) {
        log.error("cause[{}] {}: {}", t.getClass().getSimpleName(), t.getClass().getName(), t.getMessage());
    }
    String errorId = UUID.randomUUID().toString();
    log.error("unhandled errorId={} uri={}", errorId, request.getRequestURI(), ex);
    ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.INTERNAL_SERVER_ERROR);
    pd.setType(URI.create("https://api.acme.com/problems/internal-error"));
    pd.setTitle("Internal error");
    pd.setDetail("An unexpected error occurred. Quote the errorId when contacting support.");
    pd.setProperty("errorId", errorId);   // safe: correlates to logs, leaks nothing
    return pd;
}
```

**Fix.** Make the domain exception self-describing so wrapping cannot lose its status, and add an explicit unwrapping handler:

```java
public class PaymentDeclinedException extends ErrorResponseException {
    public PaymentDeclinedException(String declineCode) {
        super(HttpStatus.PAYMENT_REQUIRED, build(declineCode), null);
    }

    private static ProblemDetail build(String declineCode) {
        ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.PAYMENT_REQUIRED);
        pd.setType(URI.create("https://api.acme.com/problems/payment-declined"));
        pd.setTitle("Payment declined");
        pd.setProperty("declineCode", declineCode);
        return pd;
    }
}

@ExceptionHandler({ CompletionException.class, UndeclaredThrowableException.class })
public ResponseEntity<Object> unwrap(Exception ex, WebRequest request) throws Exception {
    Throwable cause = ex.getCause();
    if (cause instanceof ErrorResponse er) {
        return ResponseEntity.status(er.getStatusCode()).headers(er.getHeaders()).body(er.getBody());
    }
    throw ex;   // no special knowledge: let the next resolver decide
}
```

---

## 16. Filters vs Interceptors vs Security Filter Chain Order

### Core concept

Three extension points, three different chains:

| Layer | Interface | Runs in | Typical use |
|---|---|---|---|
| Servlet Filter | `Filter` / `OncePerRequestFilter` | Container chain, **before** DispatcherServlet | Encoding, tracing, request logging, caching body |
| Spring Security | `SecurityFilterChain` | Container chain via `DelegatingFilterProxy` | Authn/authz, CSRF, CORS (security) |
| HandlerInterceptor | `HandlerInterceptor` | Inside DispatcherServlet, around handler | Tenant context, timing, MVC-specific checks |

**Order rule of thumb:** Servlet Filters → Security → DispatcherServlet → Interceptors → Controller.

Security filters are **not** `HandlerInterceptor`s — they run earlier and can reject before any handler mapping.

### Internal working

Container filter order (Boot defaults approximate):

```
CharacterEncodingFilter         (Ordered.HIGHEST_PRECEDENCE)
...
springSecurityFilterChain       (Spring Security FilterRegistrationBean order ~ -100)
...
RequestContextFilter
FormContentFilter
OncePerRequestFilter (your custom) if registered via FilterRegistrationBean
DispatcherServlet
```

Register custom filters:

```java
@Bean
FilterRegistrationBean<CorrelationIdFilter> correlationFilter() {
    FilterRegistrationBean<CorrelationIdFilter> bean = new FilterRegistrationBean<>();
    bean.setFilter(new CorrelationIdFilter());
    bean.setOrder(Ordered.HIGHEST_PRECEDENCE + 5);
    bean.addUrlPatterns("/*");
    return bean;
}
```

**HandlerInterceptor** registration:

```java
@Override
public void addInterceptors(InterceptorRegistry registry) {
    registry.addInterceptor(tenantInterceptor)
        .addPathPatterns("/api/**")
        .excludePathPatterns("/api/public/**")
        .order(0);
}
```

`preHandle` order = registration order; `postHandle` / `afterCompletion` reverse.

Security vs MVC CORS: if CORS preflight fails with 401, **`CorsFilter` in security chain** must run before auth. MVC `@CrossOrigin` adds interceptor at DispatcherServlet level — too late if security rejected OPTIONS.

### Production scenario: correlation ID missing in controller logs

**Problem.** MDC has `traceId` in access logs but empty in `@Service` logs.

**Cause.** ID set in `HandlerInterceptor` — runs **after** security filters and only for mapped handlers. Async handoff loses MDC without `TaskDecorator`.

**Solution.** Set correlation ID in a **`OncePerRequestFilter`** at high precedence:

```java
public class CorrelationIdFilter extends OncePerRequestFilter {

    static final String HEADER = "X-Correlation-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String id = Optional.ofNullable(request.getHeader(HEADER))
            .filter(s -> !s.isBlank())
            .orElse(UUID.randomUUID().toString());
        MDC.put("correlationId", id);
        response.setHeader(HEADER, id);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.clear();
        }
    }
}
```

For `@Async`, configure `ThreadPoolTaskExecutor.setTaskDecorator` to copy MDC.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Component Filter` without order | Runs after security; auth fails before tenant filter |
| Interceptor for auth | Bypassed by unmapped paths, static resources, error dispatch |
| Double CORS (security + `@CrossOrigin`) | Duplicate headers; browser rejects |
| Interceptor `preHandle false` without response written | Blank 200 or ambiguous status |

### Debugging scenario

**Observe.** Filter clearly runs (log statement) but `@RequestBody` empty.

**Diagnose.** Filter read `InputStream` without wrapping/caching.

**Fix.** `ContentCachingRequestWrapper`; read body only once; place filter after security if body needed post-auth.

---

## 17. Rate Limiting and Abuse Protection at the MVC Layer

### Core concept

Rate limiting protects a **finite resource** — Tomcat threads, DB connections, a paid downstream API — from a client that is either hostile or merely retrying badly. It is not the same as authorization: a valid, authenticated, authorized client can still take you down.

Three placement options, in descending order of preference:

| Layer | Pros | Cons |
|---|---|---|
| **Edge / API gateway / WAF** | Blocks before a socket reaches your JVM; shared state built in; no app deploy to tune | Coarse keying (often IP only); no knowledge of plan tiers or per-endpoint cost |
| **Servlet `Filter`** in the app | Cheap (runs before mapping, binding, security if ordered early); can see headers | Consumes a Tomcat thread to reject; needs distributed state; must be ordered correctly |
| **`HandlerInterceptor`** | Knows the matched `HandlerMethod`, so per-endpoint annotations work | Runs *inside* `DispatcherServlet` — after mapping, security, and body parsing; too late to be cheap |

**Prefer the gateway.** Application-level limiting still costs a thread, a request parse, and often a Redis round trip per rejected request — so it cannot protect you from a volumetric flood. Its real job is *fairness and cost control* (per-tenant quotas, per-plan tiers, protecting an expensive endpoint), which the gateway usually cannot express.

**`Filter` vs `HandlerInterceptor` placement:**

```
socket → Tomcat thread → [Filter: rate limit]  ← cheapest useful rejection point
                       → [Security filters]
                       → DispatcherServlet
                            → HandlerMapping    ← handler now known
                            → [HandlerInterceptor: per-endpoint limit]
                            → argument binding (body parsed here!)
                            → controller
```

If the limit key is the authenticated principal, the filter must run **after** authentication — so either order it after `springSecurityFilterChain`, or register it *inside* the security chain via `http.addFilterAfter(...)`. If the key is an API key header or IP, run it first.

### Internal working

**Response headers.** Two families exist; emit both during any migration.

Legacy but universally understood:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1772352000
```

The IETF draft (`draft-ietf-httpapi-ratelimit-headers`), which is what new clients expect:

```
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 42
RateLimit-Policy: 100;w=60
```

`RateLimit-Reset` is **seconds until reset** (a delta), while `X-RateLimit-Reset` was conventionally a Unix epoch timestamp. Mixing those up is the most common client-side bug: a client that treats a delta as an epoch sleeps until 1970 (i.e. not at all) and hammers you.

`Retry-After` is the normative one (RFC 9110) and accepts either delta-seconds or an HTTP-date. **Always send `Retry-After` on 429 and 503.** Well-behaved HTTP libraries honour it automatically.

**Bucket4j token-bucket filter.** Dependency:

```xml
<dependency>
  <groupId>com.bucket4j</groupId>
  <artifactId>bucket4j_jdk17-core</artifactId>
  <version>8.14.0</version>
</dependency>
<!-- distributed backend -->
<dependency>
  <groupId>com.bucket4j</groupId>
  <artifactId>bucket4j_jdk17-redis-common</artifactId>
  <version>8.14.0</version>
</dependency>
```

Token bucket semantics: capacity `C` refilled at `R` tokens per interval. Capacity is your **burst allowance**; refill rate is your **sustained rate**. `C = R` means no burst tolerance at all and will reject legitimate parallel clients; `C = 2R` is a sane starting point.

```java
public record RateLimitPolicy(String name, long capacity, long refillTokens, Duration refillPeriod) {

    public Bandwidth toBandwidth() {
        return Bandwidth.builder()
            .capacity(capacity)
            // greedy: tokens trickle back continuously rather than all at once at the boundary.
            // Intervally refill causes synchronized client stampedes on the interval edge.
            .refillGreedy(refillTokens, refillPeriod)
            .build();
    }

    public long windowSeconds() { return refillPeriod.toSeconds(); }
}
```

```java
@Component
public class RateLimitFilter extends OncePerRequestFilter {

    private static final String PROBLEM_TYPE = "https://api.acme.com/problems/rate-limit-exceeded";

    private final RateLimitKeyResolver keyResolver;
    private final ProxyManager<String> proxyManager;   // Redis/Hazelcast-backed
    private final RateLimitPolicyResolver policyResolver;
    private final ObjectMapper objectMapper;
    private final MeterRegistry meterRegistry;

    // constructor omitted

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Never rate-limit liveness/readiness: a throttled probe restarts the pod
        // and turns a traffic spike into an outage.
        String path = request.getRequestURI();
        return path.startsWith("/actuator/health") || HttpMethod.OPTIONS.matches(request.getMethod());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {

        RateLimitKey key = keyResolver.resolve(request);
        RateLimitPolicy policy = policyResolver.resolve(key, request);

        Bucket bucket = proxyManager.builder()
            .build(key.asCacheKey(), () -> BucketConfiguration.builder()
                .addLimit(policy.toBandwidth())
                .build());

        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);

        // Emit limit headers on EVERY response, not only 429. Clients cannot
        // self-throttle if they only learn the budget after exceeding it.
        response.setHeader("RateLimit-Policy", policy.capacity() + ";w=" + policy.windowSeconds());
        response.setHeader("RateLimit-Limit", Long.toString(policy.capacity()));
        response.setHeader("RateLimit-Remaining", Long.toString(Math.max(0, probe.getRemainingTokens())));

        long resetSeconds = Math.max(1, Duration.ofNanos(probe.getNanosToWaitForRefill()).toSeconds());

        if (probe.isConsumed()) {
            response.setHeader("RateLimit-Reset", Long.toString(resetSeconds));
            chain.doFilter(request, response);
            return;
        }

        meterRegistry.counter("http.ratelimit.rejected",
            "policy", policy.name(), "keyType", key.type().name()).increment();

        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setHeader(HttpHeaders.RETRY_AFTER, Long.toString(resetSeconds));
        response.setHeader("RateLimit-Reset", Long.toString(resetSeconds));
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);

        ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.TOO_MANY_REQUESTS);
        pd.setType(URI.create(PROBLEM_TYPE));
        pd.setTitle("Rate limit exceeded");
        pd.setDetail("Request rate exceeded for this " + key.type().description()
            + ". Retry after " + resetSeconds + "s.");
        pd.setInstance(URI.create(request.getRequestURI()));
        pd.setProperty("policy", policy.name());
        pd.setProperty("limit", policy.capacity());
        pd.setProperty("windowSeconds", policy.windowSeconds());
        pd.setProperty("retryAfterSeconds", resetSeconds);

        objectMapper.writeValue(response.getOutputStream(), pd);
    }
}
```

Registration and ordering:

```java
@Bean
FilterRegistrationBean<RateLimitFilter> rateLimitFilterRegistration(RateLimitFilter filter) {
    FilterRegistrationBean<RateLimitFilter> bean = new FilterRegistrationBean<>(filter);
    // After Spring Security (~ -100) so the authenticated principal is available as a key,
    // but before DispatcherServlet so we reject without binding a request body.
    bean.setOrder(Ordered.HIGHEST_PRECEDENCE + 200);
    bean.addUrlPatterns("/api/*");
    return bean;
}
```

**Per-key limiting.** Key choice is the whole design. Pick the most specific identity available:

```java
@Component
public class RateLimitKeyResolver {

    public RateLimitKey resolve(HttpServletRequest request) {
        // 1. API key: most specific, cannot be spoofed if validated upstream
        String apiKey = request.getHeader("X-Api-Key");
        if (StringUtils.hasText(apiKey)) {
            return new RateLimitKey(KeyType.API_KEY, sha256Hex(apiKey));
        }

        // 2. Authenticated principal: correct for user-facing quotas
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated() && !(auth instanceof AnonymousAuthenticationToken)) {
            if (auth instanceof JwtAuthenticationToken jwt) {
                String tenant = jwt.getToken().getClaimAsString("tenant_id");
                return new RateLimitKey(KeyType.TENANT, tenant + ":" + auth.getName());
            }
            return new RateLimitKey(KeyType.USER, auth.getName());
        }

        // 3. IP: last resort for unauthenticated endpoints (login, signup, password reset)
        return new RateLimitKey(KeyType.IP, clientIp(request));
    }

    private String clientIp(HttpServletRequest request) {
        // NEVER trust X-Forwarded-For unless a trusted proxy sets it. Configure
        // server.forward-headers-strategy=framework and read the remote addr, or
        // take the Nth-from-right XFF entry matching your proxy hop count.
        return request.getRemoteAddr();
    }
}
```

Key-choice failure modes:

| Key | Fails when |
|---|---|
| IP | Corporate NAT / mobile carrier CGNAT — thousands of users share one IP; you throttle a whole customer |
| IP | IPv6 — attacker rotates within a /64; limit on the /64 prefix, not the /128 address |
| User ID | Attack happens **before** login; login and signup must be IP-limited |
| API key | One key shared across a customer's fleet — limit is per key, so their scaling breaks your quota |
| Tenant | One tenant's batch job starves that tenant's interactive users; add a second per-user layer |

Layer them: a coarse IP limit (anti-abuse) plus a per-tenant limit (fairness) plus a per-endpoint limit on expensive routes.

**Distributed counters in Redis.** Two pods with in-memory buckets means the effective limit is `2 × configured`. Autoscaling makes your limit a function of replica count, which is absurd. Move state to Redis:

```java
@Bean
ProxyManager<String> lettuceProxyManager(RedisClient redisClient) {
    StatefulRedisConnection<String, byte[]> connection =
        redisClient.connect(RedisCodec.of(StringCodec.UTF8, ByteArrayCodec.INSTANCE));

    return LettuceBasedProxyManager.builderFor(connection)
        .withExpirationStrategy(
            // Let Redis reclaim idle buckets; without a TTL the keyspace grows without bound.
            ExpirationAfterWriteStrategy.basedOnTimeForRefillingBucketUpToMax(Duration.ofMinutes(10)))
        .build();
}
```

Bucket4j executes its compare-and-set logic as a Lua script server-side, so the read-modify-write is atomic without a distributed lock.

**Redis must not become a hard dependency.** Fail open on infrastructure errors, fail closed only for a deliberate lockdown:

```java
private ConsumptionProbe tryConsume(Bucket bucket, RateLimitPolicy policy) {
    try {
        return bucket.tryConsumeAndReturnRemaining(1);
    } catch (RedisException | RedisCommandTimeoutException ex) {
        meterRegistry.counter("http.ratelimit.backend.failure").increment();
        log.warn("Rate limit backend unavailable; failing open for policy {}", policy.name(), ex);
        // Availability beats perfect fairness. Alert on this counter; a silent
        // fail-open that nobody monitors is an unlimited API.
        return ConsumptionProbe.consumed(policy.capacity(), 0L);
    }
}
```

**Per-endpoint limits need the handler**, which means an interceptor:

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface RateLimited {
    String policy();
    long cost() default 1;
}

@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!(handler instanceof HandlerMethod method)) {
            return true;
        }
        RateLimited annotation = method.getMethodAnnotation(RateLimited.class);
        if (annotation == null) {
            return true;
        }
        // cost > 1 for expensive endpoints: a report costing 50 tokens is throttled
        // 50x harder than a cheap lookup out of the same budget.
        return rateLimitService.tryConsume(request, annotation.policy(), annotation.cost(), response);
    }
}

@PostMapping("/reports/annual")
@RateLimited(policy = "heavy-report", cost = 50)
public ReportDto annualReport(@RequestBody ReportRequest request) { ... }
```

Note the tradeoff: by the time `preHandle` runs, the request body has *not* yet been parsed (binding happens in the adapter), but mapping and security have. So an interceptor is cheaper than the controller but far more expensive than a filter.

**Request size limits** are the other half of abuse protection — an unbounded body is a memory DoS regardless of request rate:

```yaml
server:
  tomcat:
    max-http-form-post-size: 256KB   # form bodies
    max-swallow-size: 2MB            # bytes Tomcat will read+discard after an error response
    max-http-request-header-size: 16KB
    connection-timeout: 20s
spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 15MB
```

For JSON bodies (not covered by `max-http-form-post-size`), enforce a limit explicitly:

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 50)
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    private static final long MAX_JSON_BYTES = 1024 * 1024;   // 1 MB

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        long declared = request.getContentLengthLong();
        if (declared > MAX_JSON_BYTES) {
            // Cheap path: reject on the declared header without reading a byte.
            reject(response, declared);
            return;
        }
        // Chunked requests declare -1: wrap the stream and count as it is read.
        chain.doFilter(new LimitedBodyRequestWrapper(request, MAX_JSON_BYTES), response);
    }
}
```

### Production scenario: one tenant's retry storm consumed the whole thread pool

**Problem.** A multi-tenant order API ran fine for two years at 400 req/s. One Tuesday, p99 went from 180 ms to 45 s and health checks began failing. Thread dumps showed 200/200 `http-nio-8080-exec-*` threads inside `OrderSearchService.search`. CPU was 22%. Total inbound traffic was 2,900 req/s — 2,500 of it from a single tenant.

**Cause.** That tenant deployed a client with a retry loop that had no backoff and no jitter: on any error it retried immediately, forever. The first slow response (a cold cache after a deploy) caused retries, retries caused thread contention, contention caused more slow responses. A classic retry storm — a self-sustaining feedback loop. The API had **no** rate limiting because "the gateway handles it," and the gateway limited only per-IP; every one of those requests came from three NAT'd egress IPs, each well under the IP limit.

**Solution.** Three changes, in the order they were shipped.

**1. Per-tenant limit with burst headroom**, deployed within the hour:

```yaml
acme:
  ratelimit:
    policies:
      tenant-default:   { capacity: 600, refill-tokens: 300, refill-period: 1s }   # 300/s sustained, 600 burst
      tenant-premium:   { capacity: 2000, refill-tokens: 1000, refill-period: 1s }
      unauthenticated:  { capacity: 20,  refill-tokens: 10,  refill-period: 1s }
      heavy-report:     { capacity: 100, refill-tokens: 100, refill-period: 60s }
```

**2. Make 429 informative enough that a competent client self-heals.** The tenant's client honoured `Retry-After` once it existed:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 2
RateLimit-Limit: 600
RateLimit-Remaining: 0
RateLimit-Reset: 2
RateLimit-Policy: 600;w=1

{
  "type": "https://api.acme.com/problems/rate-limit-exceeded",
  "title": "Rate limit exceeded",
  "status": 429,
  "detail": "Request rate exceeded for this tenant. Retry after 2s.",
  "instance": "/api/orders/search",
  "policy": "tenant-default",
  "limit": 600,
  "windowSeconds": 1,
  "retryAfterSeconds": 2
}
```

**3. A concurrency bulkhead, because rate limiting alone does not bound thread usage.** 300 req/s at 2 s latency still needs 600 threads:

```java
@Component
public class TenantBulkhead {

    // Hard cap on concurrent in-flight requests per tenant, independent of arrival rate.
    private final Map<String, Semaphore> permits = new ConcurrentHashMap<>();
    private final int permitsPerTenant;

    public <T> T call(String tenantId, Supplier<T> work) {
        Semaphore semaphore = permits.computeIfAbsent(tenantId, k -> new Semaphore(permitsPerTenant));
        if (!semaphore.tryAcquire()) {
            throw new TenantOverloadedException(tenantId);   // -> 503 + Retry-After
        }
        try {
            return work.get();
        } finally {
            semaphore.release();
        }
    }
}
```

Result: the tenant's storm now sheds at 600 concurrent burst / 300 req/s sustained, rejected in a filter for ~0.4 ms of CPU instead of holding a thread for 45 s. p99 for every other tenant returned to 190 ms while the storm was still in progress.

Also fixed on the client side, and worth stating in your API docs as a requirement: **retries must use exponential backoff with full jitter and a retry budget.**

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| In-memory buckets with >1 replica | Effective limit = `limit × replicas`; changes every autoscale event |
| No `Retry-After` on 429 | Clients retry immediately; the 429 itself becomes the load |
| `RateLimit-Reset` sent as an epoch timestamp | Clients computing a delta sleep 0 s and hammer; or sleep 55 years |
| Rate limit headers only on 429 | Clients cannot self-throttle; they discover the limit by hitting it |
| Limiting by `X-Forwarded-For` without a trusted-proxy config | Trivially spoofed — attacker sends a random XFF per request and is never limited |
| Health/readiness endpoints included in the limit | Throttled probe → pod restart → fewer pods → more load → cascade |
| Rejecting in a `HandlerInterceptor` only | Body already parsed, security already ran; expensive rejection under flood |
| Redis unavailable → fail closed | Rate limiter outage becomes a full API outage |
| Redis fail-open with no alert | Limits silently absent for days |
| `capacity == refillTokens` | Zero burst tolerance; legitimate parallel clients get 429 at low average rate |
| No bucket TTL in Redis | Unbounded keyspace growth; eventual OOM eviction of live buckets |
| 429 without a machine-readable body | Client code cannot distinguish "slow down" from "you are banned" |
| Rate limiting but no concurrency bulkhead | Thread pool still exhausts when latency rises |

### Debugging scenario

**Observe.** A customer reports intermittent 429s "at maybe 40 requests per second" against a documented limit of 300/s. Your dashboard shows the rejection counter firing, and the tenant's own graphs show nothing near the limit.

**Diagnose.** Four candidate causes; distinguish them with the key that was actually used, which is why the metric must be tagged:

```java
meterRegistry.counter("http.ratelimit.rejected",
    "policy", policy.name(),
    "keyType", key.type().name(),
    "keyHash", key.shortHash()).increment();
```

1. **Wrong key type.** If `keyType=IP`, the resolver never saw an authenticated principal — the filter is ordered *before* Spring Security, so `SecurityContextHolder` was empty and everything fell through to the IP bucket. Multiple tenants behind one NAT then share a 20/s unauthenticated bucket.
2. **Cost weighting.** If `policy=heavy-report`, they are hitting an endpoint with `cost = 50`, so 40 req/s consumes 2,000 tokens/s.
3. **Bucket key cardinality.** If `keyHash` changes on every request, the key includes something volatile (a timestamp, a request ID, an unstable `getRemoteAddr` behind a proxy), so every request gets a fresh full bucket — or, with a cost above 1, an immediately-empty one.
4. **Clock/refill mode.** `refillIntervally` refills the whole allowance at a window boundary, so all clients synchronize on the boundary and burst together; `refillGreedy` smooths it.

Confirm with a request-scoped debug header on a canary instance only:

```java
if (debugProperties.exposeRateLimitDiagnostics()) {
    response.setHeader("X-RateLimit-Debug",
        "keyType=" + key.type() + ";policy=" + policy.name() + ";cost=" + cost);
}
```

**Fix.** In this case it was cause 1. Move the filter after authentication so the tenant key resolves:

```java
@Configuration
public class SecurityRateLimitConfig {

    @Bean
    SecurityFilterChain apiChain(HttpSecurity http, RateLimitFilter rateLimitFilter) throws Exception {
        return http
            .securityMatcher("/api/**")
            .oauth2ResourceServer(o -> o.jwt(Customizer.withDefaults()))
            // Inside the security chain, after the bearer filter populates the context,
            // so RateLimitKeyResolver can read the tenant claim.
            .addFilterAfter(rateLimitFilter, BearerTokenAuthenticationFilter.class)
            .authorizeHttpRequests(a -> a.anyRequest().authenticated())
            .build();
    }
}
```

Then add an assertion that the key type is never `IP` on authenticated routes:

```java
if (key.type() == KeyType.IP && request.getRequestURI().startsWith("/api/")) {
    log.error("Rate limit fell back to IP on an authenticated route: {} — filter ordering bug",
        request.getRequestURI());
}
```

---

## 18. Embedded Tomcat Thread Pool and maxThreads

### Core concept

Spring Boot embeds Tomcat by default. Each HTTP request (sync MVC) holds a **Tomcat worker thread** for the duration of handler + filters + I/O. Pool exhaustion manifests as requests **queued or timed out** with CPU still low.

Key settings:

```yaml
server:
  tomcat:
    threads:
      max: 200          # default 200
      min-spare: 10
    accept-count: 100   # queue when all threads busy
    connection-timeout: 20000
    max-connections: 8192
```

### Internal working

```
Client TCP connect
  → Acceptor thread accepts
  → Poller (NIO) registers interest
  → Worker thread allocated from pool
  → Entire filter chain + DispatcherServlet + controller + JDBC (blocking)
  → Worker returned to pool
```

Throughput ≈ `maxThreads / avg_latency_seconds`. Blocking JDBC/HTTP holds threads.

Monitor: `tomcat.threads.busy`, thread dumps, JDBC pool wait times.

### Production scenario: thread pool starvation at peak

**Problem.** p99 latency 60s; 200/200 Tomcat threads blocked in external payment API call.

**Cause.** Synchronous RestClient without read timeout.

**Solution.** Timeouts + circuit breaker; fix latency; virtual threads as complementary (section 19).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `maxThreads=2000` on small box | CPU thrashing |
| No outbound timeout | Cascading hangs |
| Pool size × pods > DB max_connections | DB rejects connections |

### Debugging scenario

**Observe.** Health UP, API hangs, CPU low.

**Diagnose.** Thread dump — all `http-nio-*-exec-*` blocked on same frame.

**Fix.** Timeouts, bulkheads, reduce blocking scope.

---

## 19. Virtual Threads (Boot 3.2+)

### Core concept

Java 21 virtual threads reduce cost of blocking I/O on servlet stack:

```yaml
spring:
  threads:
    virtual:
      enabled: true
```

Tomcat schedules each request on a virtual thread. Blocking JDBC parks the virtual thread instead of hoarding OS threads.

### Internal working

Boot customizes Tomcat protocol handler to use `Executors.newVirtualThreadPerTaskExecutor()`. `@Async` and custom executors need separate virtual thread configuration.

Watch JFR `jdk.VirtualThreadPinned` — synchronized blocks in drivers/libraries pin carriers.

### Production scenario: enabled virtual threads, no gain

**Problem.** Throughput unchanged after enabling.

**Cause.** CPU-bound workload, or pinning in connection pool, or not on Tomcat.

**Solution.** Profile pinning; virtual threads help I/O wait-heavy CRUD, not CPU-heavy transforms.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Platform thread pool for `@Async` still saturated | Mixed model confusion |
| ThreadLocal without cleanup | Context leaks |
| Java 17 runtime | Feature unavailable |

### Debugging scenario

**Observe.** SecurityContext empty after parallel step.

**Diagnose.** Manual platform thread pool or `parallelStream()` in request path.

**Fix.** Stay on request virtual thread; propagate context explicitly for async hops.

---

## 20. Timeouts End to End

### Core concept

There is no such thing as "the timeout." A single request crosses six or seven independent deadlines, each configured in a different file by a different team. When they are ordered wrongly, you get the two canonical failures:

- **Deadline inversion (inner > outer):** the load balancer gives up while the app is still working. The client sees 502/504, the app logs a *success*, and the client retries — so the work happens twice. This is how duplicate orders are created.
- **Idle-timeout mismatch:** the load balancer closes a pooled keep-alive connection that the app still believes is open. The next request is written into a dead socket → **502**, seemingly at random, typically at a rate proportional to how idle the system is.

The rule: **deadlines must increase strictly outward.** Every layer's timeout must be shorter than the timeout of the layer that calls it, and idle timeouts must increase *inward* (the server must close idle connections before the client does).

### Internal working

**The full deadline stack** for `browser → CDN → ALB → Tomcat → controller → RestClient → downstream`:

| # | Layer | Setting | What it measures |
|---|---|---|---|
| 1 | Browser / SDK | `fetch` `AbortController`, OkHttp `callTimeout` | Total call wall time |
| 2 | CDN | origin response timeout | Time to first byte from origin |
| 3 | Load balancer | idle timeout (ALB default **60 s**) | Seconds with **no bytes** in either direction |
| 4 | Tomcat | `server.tomcat.connection-timeout` | Time to receive the request **line and headers** after connect |
| 5 | Tomcat | `server.tomcat.keep-alive-timeout` | Idle time on a keep-alive connection between requests |
| 6 | Tomcat | `server.tomcat.max-keep-alive-requests` | Requests served per connection before forced close |
| 7 | Spring MVC | `spring.mvc.async.request-timeout` | Wall time for `Callable`/`DeferredResult`/`SseEmitter` |
| 8 | Outbound client | connect / read / total | Per-hop downstream deadlines |
| 9 | JDBC | pool `connection-timeout`, `validation-timeout` | Waiting for a pooled connection |
| 10 | Database | `statement_timeout`, JPA `jakarta.persistence.query.timeout` | Query execution |

**The Tomcat settings that get confused.** These three are genuinely different things:

```yaml
server:
  tomcat:
    # 1. How long to wait for the request LINE + HEADERS after the TCP connection opens.
    #    Slowloris defence. Has nothing to do with how long your handler may run.
    connection-timeout: 20s

    # 2. How long an IDLE keep-alive connection is held open between requests.
    #    Defaults to connection-timeout when unset. THIS is the one that must be
    #    tuned against the load balancer idle timeout.
    keep-alive-timeout: 75s

    # 3. Requests served on one connection before Tomcat sends `Connection: close`.
    #    Default 100. Set to -1 for unlimited when behind a fixed set of proxies;
    #    a low value causes constant reconnects and TLS handshake overhead.
    max-keep-alive-requests: -1

    max-connections: 8192
    accept-count: 100
    threads:
      max: 200
```

**Why `keep-alive-timeout` must exceed the LB idle timeout.** Consider ALB idle timeout 60 s and Tomcat `keep-alive-timeout` 20 s (a common accident, since it silently inherits `connection-timeout`):

```
t=0s    ALB opens connection to Tomcat, sends request, gets response
t=20s   Tomcat closes the idle connection (keep-alive-timeout)
        ALB has not yet noticed -- its own idle timer is at 60s
t=25s   New client request arrives; ALB reuses its cached connection
        and writes the request into a socket Tomcat already closed
        -> TCP RST -> ALB returns 502 to the client
```

The fix is to make the **server** the one that closes late, and the **proxy** the one that closes first:

```
keep-alive-timeout (server)  >  idle timeout (load balancer)  >  client pool idle timeout
75s                          >  60s                           >  30s
```

Same logic applies to your own outbound connection pools: pool idle-eviction must be **shorter** than the downstream server's keep-alive timeout, or you write into sockets the peer has closed.

**Recommended relative values.** Anchor everything to one number: the endpoint's SLO. For a 2 s p99 API:

| Layer | Setting | Value | Relationship |
|---|---|---|---|
| Database | `statement_timeout` | **2 s** | Innermost. The actual work budget. |
| JPA query hint | `jakarta.persistence.query.timeout` | 2000 ms | Match the DB. |
| HikariCP | `connection-timeout` | 3 s | Must be < downstream call budget; failing fast beats queueing. |
| Outbound HTTP | connect timeout | **1 s** | Connect is fast or broken; never set this high. |
| Outbound HTTP | read timeout | **3 s** | > DB budget, < total request budget. |
| Outbound HTTP | total/call timeout | 5 s | Bounds connect + read + retries. |
| Application | per-request deadline | **8 s** | Sum of the slowest realistic path, plus headroom. |
| Spring MVC | `spring.mvc.async.request-timeout` | **10 s** | > application deadline. |
| Tomcat | `connection-timeout` | 20 s | Header read only; unrelated to work time. |
| Load balancer | idle timeout | **30 s** | ≥ 3× app deadline; the outermost server-side deadline. |
| Tomcat | `keep-alive-timeout` | **35 s** | **> LB idle timeout.** Prevents the 502 race above. |
| CDN | origin timeout | 35 s | > LB idle timeout. |
| Client SDK | total call timeout | **40 s** | Outermost. |
| Client | retries | 2, exponential + jitter | Retry budget ≤ 10% of requests. |

Multiplier heuristic: **each layer outward gets roughly 1.2×–1.5× the layer inside it**, except the keep-alive pair, which must be ordered as shown regardless of the work budget.

**Async request timeout** is not the servlet's total request timeout — it applies only from the moment async processing starts:

```java
@Configuration
public class AsyncTimeoutConfig implements WebMvcConfigurer {

    @Override
    public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
        configurer.setDefaultTimeout(10_000);
        configurer.registerCallableInterceptors(new TimeoutCallableProcessingInterceptor());
    }
}

// Per-endpoint override, plus an explicit timeout result instead of a 503 from the container.
@GetMapping("/reports/{id}")
public WebAsyncTask<ReportDto> report(@PathVariable UUID id) {
    WebAsyncTask<ReportDto> task = new WebAsyncTask<>(30_000L, "reportExecutor",
        () -> reportService.build(id));
    task.onTimeout(() -> {
        reportService.cancel(id);   // stop the work; otherwise you pay for an abandoned result
        throw new ReportTimeoutException(id);
    });
    task.onError(() -> { throw new ReportFailedException(id); });
    return task;
}
```

When an async request times out, Spring dispatches back to the container with an `AsyncRequestTimeoutException`, which `DefaultHandlerExceptionResolver` maps to **503 Service Unavailable**. Handle it deliberately:

```java
@ExceptionHandler(AsyncRequestTimeoutException.class)
public ProblemDetail handleAsyncTimeout(AsyncRequestTimeoutException ex, HttpServletRequest request) {
    ProblemDetail pd = ProblemDetail.forStatus(HttpStatus.SERVICE_UNAVAILABLE);
    pd.setType(URI.create("https://api.acme.com/problems/request-timeout"));
    pd.setTitle("Request timed out");
    pd.setDetail("The operation exceeded its time budget. Retry, or poll the async job endpoint.");
    pd.setProperty("retryAfterSeconds", 5);
    return pd;
}
```

**Client-side read timeout** with `RestClient` on Apache HttpClient 5 (see section 29):

```java
@Bean
RestClient inventoryClient(RestClient.Builder builder) {
    ConnectionConfig connectionConfig = ConnectionConfig.custom()
        .setConnectTimeout(Timeout.ofSeconds(1))
        .setSocketTimeout(Timeout.ofSeconds(3))          // read timeout
        .setValidateAfterInactivity(TimeValue.ofSeconds(2))  // revalidate idle pooled conns
        .build();

    PoolingHttpClientConnectionManager cm = PoolingHttpClientConnectionManagerBuilder.create()
        .setDefaultConnectionConfig(connectionConfig)
        .setMaxConnTotal(200)
        .setMaxConnPerRoute(50)
        // Evict before the downstream's keep-alive timeout expires.
        .setConnectionTimeToLive(TimeValue.ofSeconds(25))
        .build();

    CloseableHttpClient httpClient = HttpClients.custom()
        .setConnectionManager(cm)
        .setDefaultRequestConfig(RequestConfig.custom()
            .setConnectionRequestTimeout(Timeout.ofMillis(500))  // wait for a pool slot
            .setResponseTimeout(Timeout.ofSeconds(3))
            .build())
        .evictIdleConnections(TimeValue.ofSeconds(20))
        .build();

    return builder
        .requestFactory(new HttpComponentsClientHttpRequestFactory(httpClient))
        .build();
}
```

`connectionRequestTimeout` is the forgotten one: with an exhausted pool, threads block *waiting for a connection* with no deadline at all, which looks exactly like a slow downstream in a thread dump.

### Production scenario: 502s that only happened during quiet hours

**Problem.** A checkout API served 1,200 req/s with a 0.002% error rate during business hours. Between 02:00 and 05:00, when traffic fell to ~20 req/s, the error rate rose to **1.8%** — all 502s from the ALB, all on `POST /api/checkout`. Application logs showed no errors whatsoever for those requests: no exception, no 5xx, nothing. Access logs showed the request never arrived.

**Cause.** Tomcat's `keep-alive-timeout` was unset, so it inherited `connection-timeout: 20s`. The ALB idle timeout was the default 60 s. During busy periods, connections were reused every few milliseconds and never idled long enough for Tomcat's 20 s timer to fire. At 20 req/s across 6 pods and 2 ALB nodes, individual connections routinely sat idle for 25–40 s — long enough for Tomcat to close them and short enough that the ALB still had them pooled. Every such reuse produced a TCP RST and a 502. The application never saw the request, which is exactly why there were no logs. Low traffic caused the errors; that inverted intuition is what made it take three weeks to find.

**Solution.** Order the idle timeouts correctly and prove it with a test.

```yaml
server:
  tomcat:
    connection-timeout: 20s
    # MUST exceed the ALB idle timeout (60s) so the LB always closes first.
    keep-alive-timeout: 75s
    max-keep-alive-requests: -1
```

```hcl
# Terraform: make the relationship explicit and reviewable
resource "aws_lb" "api" {
  idle_timeout = 60   # MUST be < server.tomcat.keep-alive-timeout (75s). See ADR-114.
}
```

Guard against regression with a startup assertion, because this is a config relationship no unit test naturally covers:

```java
@Component
public class TimeoutOrderingValidator {

    private final ServerProperties serverProperties;
    private final InfraProperties infra;   // LB idle timeout, injected from env

    @EventListener(ApplicationReadyEvent.class)
    void validate() {
        Duration keepAlive = Optional.ofNullable(serverProperties.getTomcat().getKeepAliveTimeout())
            .orElse(serverProperties.getTomcat().getConnectionTimeout());
        Duration lbIdle = infra.loadBalancerIdleTimeout();

        if (keepAlive.compareTo(lbIdle) <= 0) {
            // Fail startup: shipping this config guarantees intermittent 502s.
            throw new IllegalStateException(
                "server.tomcat.keep-alive-timeout (%s) must exceed load balancer idle timeout (%s); "
                    .formatted(keepAlive, lbIdle)
                + "otherwise the LB reuses connections Tomcat has already closed -> 502");
        }
        log.info("Timeout ordering OK: keepAlive={} > lbIdle={}", keepAlive, lbIdle);
    }
}
```

Result: 502 rate during quiet hours went from 1.8% to 0.000%. The secondary fix was on the outbound side — `connectionTimeToLive` of 25 s against downstream services whose own keep-alive was 30 s, which had been producing the same class of error one hop deeper.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `keep-alive-timeout` < LB idle timeout | Intermittent 502s with **no application log line**; rate rises as traffic falls |
| Outbound pool TTL > downstream keep-alive | Same 502/RST class, one hop deeper; `NoHttpResponseException` in logs |
| Gateway timeout < app timeout | 504 to client while the app completes the work; client retries → duplicate side effects |
| No `connectionRequestTimeout` on the HTTP client | Threads block forever waiting for a pool slot; thread dump looks like a slow downstream |
| No outbound read timeout | One slow dependency exhausts all 200 Tomcat threads (section 18) |
| `spring.mvc.async.request-timeout` treated as the total request timeout | Sync endpoints unaffected; engineers "set the timeout" and nothing changes |
| Async timeout fires but work is not cancelled | Client gets 503, server keeps burning CPU/DB on an abandoned request |
| `statement_timeout` unset in the database | A single bad plan holds a connection for minutes; pool exhausts |
| `max-keep-alive-requests: 100` behind a busy proxy | Constant reconnect + TLS handshake churn; unexplained latency floor |
| Timeouts set per-layer by different teams with no ADR | Deadline inversion reappears at the next infra change |
| Retries at three layers simultaneously | 2 × 2 × 2 = 8× amplification on a downstream that is already struggling |

### Debugging scenario

**Observe.** Clients report sporadic 504s. Your app's p99 is 900 ms and there are no slow-query logs. The gateway reports upstream timeouts of exactly 30.000 s.

**Diagnose.** An exact, repeated timeout value is always a configured deadline, never a coincidence — find which layer owns 30 s. Then determine whether the app was still working when the client gave up:

1. Log the request duration **from the app's own perspective** including the async phase, and log the fact of client disconnect:

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestDeadlineFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        long start = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } catch (ClientAbortException ex) {
            // Tomcat throws this when the socket is gone: the client/LB gave up first.
            // Definitive proof of deadline inversion.
            log.warn("client aborted after {}ms uri={}",
                Duration.ofNanos(System.nanoTime() - start).toMillis(), request.getRequestURI());
            throw ex;
        } finally {
            long ms = Duration.ofNanos(System.nanoTime() - start).toMillis();
            if (ms > 5_000) {
                log.warn("slow request {}ms status={} uri={} async={}",
                    ms, response.getStatus(), request.getRequestURI(), request.isAsyncStarted());
            }
        }
    }
}
```

2. `request.isAsyncStarted()` distinguishes the two very different cases: a sync request blocked for 30 s (thread held; look at thread dumps) versus an async request that exceeded `spring.mvc.async.request-timeout`.

3. Check `%D` (duration) in the Tomcat access log against the gateway's own timing. If Tomcat logs 31,400 ms with status 200 and the gateway logs a 30,000 ms timeout, the app finished *after* the client left — deadline inversion confirmed.

```yaml
server:
  tomcat:
    accesslog:
      enabled: true
      pattern: '%h %t "%r" %s %b %D %{X-Correlation-Id}i'
```

**Fix.** Two parts. First, correct the ordering so the app always gives up before the gateway:

```yaml
spring:
  mvc:
    async:
      request-timeout: 25s     # < gateway 30s, so the client gets our ProblemDetail, not a 504
```

Second, make long work explicitly asynchronous rather than trying to fit it under an HTTP deadline:

```java
@PostMapping("/exports")
public ResponseEntity<ExportJobDto> startExport(@RequestBody @Valid ExportRequest request) {
    ExportJob job = exportService.enqueue(request);
    return ResponseEntity.accepted()
        .location(URI.create("/api/exports/" + job.id()))
        .header(HttpHeaders.RETRY_AFTER, "5")
        .body(ExportJobDto.from(job));   // 202 Accepted + poll URL
}
```

A 202 with a poll URL is the correct answer for any operation whose duration cannot be bounded well below the smallest deadline in the chain. No amount of timeout tuning fixes an operation that legitimately takes two minutes.

---

## 21. Multipart Uploads and File Download

### Core concept

Uploads: `multipart/form-data` via `MultipartResolver` / `@RequestParam MultipartFile`.

Downloads: `ResponseEntity<Resource>`, `StreamingResponseBody`.

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 10MB
      max-request-size: 15MB
      file-size-threshold: 2MB
```

### Internal working

```
POST multipart → resolveMultipart() → MultipartHttpServletRequest
  → @RequestParam MultipartFile / @ModelAttribute
  → Temp disk or memory per threshold
```

```java
@PostMapping(value = "/documents", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
public DocumentDto upload(@RequestParam("file") MultipartFile file) {
    if (file.isEmpty()) throw new BadRequestException("Empty file");
    return documentService.store(file);
}

@GetMapping("/files/{id}")
public ResponseEntity<Resource> download(@PathVariable UUID id) {
    StoredFile sf = fileService.load(id);
    return ResponseEntity.ok()
        .header(HttpHeaders.CONTENT_DISPOSITION,
            ContentDisposition.attachment().filename(sf.name(), StandardCharsets.UTF_8).build().toString())
        .contentType(MediaType.parseMediaType(sf.contentType()))
        .body(sf.resource());
}
```

### Production scenario: 413 in prod, works locally

**Problem.** Upload fails at gateway.

**Cause.** Ingress `client_max_body_size` smaller than Spring limit.

**Solution.** Align gateway, Tomcat, Spring limits; return `ProblemDetail` 413.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@RequestBody` for file | Does not bind |
| Full file as `byte[]` for GB files | OOM |
| Trust client Content-Type only | Malware upload |

### Debugging scenario

**Observe.** `MultipartFile` null.

**Diagnose.** Wrong field name; body consumed by filter.

**Fix.** Match `@RequestParam("file")`; use `ContentCachingRequestWrapper`.

---

## 22. CORS and Static Resources

### Core concept

**CORS** (Cross-Origin Resource Sharing) is enforced by browsers, not by curl. Spring can emit CORS headers from:

1. **Spring Security** `CorsFilter` / `http.cors()` — preferred for API + security integration
2. **`WebMvcConfigurer.addCorsMappings`** — global MVC CORS
3. **`@CrossOrigin`** on controller/class

**Static resources** served from `classpath:/static/`, `classpath:/public/`, `classpath:/resources/`, `classpath:/META-INF/resources/` via `ResourceHttpRequestHandler`, or explicit `addResourceHandlers`.

### Internal working

MVC resource handling:

```
GET /static/app.js
  → SimpleUrlHandlerMapping (/**) with ResourceHttpRequestHandler
  → Bypasses @RestController mappings if matched first
  → Cache-Control from WebMvcConfigurer.resourceChain
```

CORS preflight:

```
OPTIONS /api/orders
  → Must return Access-Control-Allow-Origin / Methods / Headers
  → Security CorsFilter handles before AuthorizationFilter
  → Actual GET/POST includes ACAO on response
```

Global CORS config:

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
            .allowedOrigins("https://app.company.com")
            .allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
            .allowedHeaders("*")
            .exposedHeaders("X-Correlation-Id")
            .allowCredentials(true)
            .maxAge(3600);
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/assets/**")
            .addResourceLocations("classpath:/static/assets/")
            .setCacheControl(CacheControl.maxAge(365, TimeUnit.DAYS).cachePublic());
    }
}
```

Boot 3: prefer `allowedOriginPatterns("https://*.company.com")` over `allowedOrigins("*")` with credentials.

### Production scenario: SPA gets CORS error on 401 response

**Problem.** Browser console: "CORS policy blocked" when JWT expired; Postman shows 401 JSON fine.

**Cause.** `AuthenticationEntryPoint` response written without CORS headers because `CorsFilter` not on that security chain or runs after failed auth path.

**Solution.** Enable CORS on API security chain:

```java
http.cors(Customizer.withDefaults());
// and CorsConfigurationSource @Bean
@Bean
CorsConfigurationSource corsConfigurationSource() {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOriginPatterns(List.of("https://*.company.com"));
    config.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
    config.setAllowedHeaders(List.of("*"));
    config.setAllowCredentials(true);
    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", config);
    return source;
}
```

Ensure error responses from `ExceptionTranslationFilter` also pass through CORS filter.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `allowedOrigins("*")` + `allowCredentials(true)` | Illegal config / browser rejects |
| CORS only on MVC, not security | Preflight 401 |
| Static handler catches `/api/**` accidentally | 404 or wrong MIME for API paths |
| Missing cache headers on static assets | CDN miss; slow SPA loads |

### Debugging scenario

**Observe.** `@RestController` mapping wins over static file with same path.

**Diagnose.** Handler mapping order — `RequestMappingHandlerMapping` usually beats resource handler for same path only if pattern specificity differs.

**Fix.** Separate namespaces: `/api/**` controllers, `/assets/**` static.

---

## 23. Async MVC: DeferredResult, Callable, and @Async

### Core concept

Servlet 3 async releases the container thread while work continues elsewhere. Spring MVC supports:

| Type | Semantics |
|---|---|
| `Callable<T>` | Run on `TaskExecutor`, return value when done |
| `DeferredResult<T>` | Manual completion from any thread |
| `WebAsyncTask<T>` | Callable + timeout / error callback |
| `@Async` on service | Separate concern — different thread pool, not MVC return type |

Without async, long work blocks Tomcat thread (section 15).

### Internal working

```
DispatcherServlet detects async return type
  → AsyncWebRequest.startAsync()
  → CallableProcessingInterceptor submits to TaskExecutor
  → Container thread released to pool
  → On completion: asyncContext.dispatch() → write response
```

Timeout default configurable:

```java
@Configuration
public class AsyncConfig implements WebMvcConfigurer {

    @Override
    public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
        configurer.setDefaultTimeout(30_000);
        configurer.setTaskExecutor(mvcAsyncExecutor());
    }

    @Bean
    TaskExecutor mvcAsyncExecutor() {
        ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
        ex.setCorePoolSize(8);
        ex.setMaxPoolSize(32);
        ex.setQueueCapacity(200);
        ex.setThreadNamePrefix("mvc-async-");
        ex.initialize();
        return ex;
    }
}
```

Example:

```java
@GetMapping("/report")
public Callable<ReportDto> generate() {
    return () -> reportService.buildHeavyReport(); // runs on mvc-async thread
}

@GetMapping("/notifications")
public DeferredResult<List<Notification>> waitForNotifications() {
    DeferredResult<List<Notification>> result = new DeferredResult<>(60_000L);
    notificationService.registerWaiter(result);
    return result;
}
```

`@Async` service method returns `Future`/`CompletableFuture` — controller must still compose correctly; do not call `.get()` on request thread.

### Production scenario: async Callable exhausts custom pool

**Problem.** Under load, requests hang then 503; `mvc-async-*` queue full.

**Cause.** Pool too small; Callable tasks block on JDBC same as HTTP threads.

**Solution.** Size pool with backpressure; timeout; bulkhead; fix blocking. Async MVC is not magic — it moves blocking to another pool.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Async` without `@EnableAsync` | Sync execution |
| `DeferredResult` never set | Client hangs until timeout |
| Lost SecurityContext on async thread | 403 in downstream checks |
| Same pool for MVC async and `@Scheduled` | Starvation |

### Debugging scenario

**Observe.** `LazyInitializationException` in Callable after OSIV disabled.

**Diagnose.** Hibernate session closed at end of `preHandle` equivalent; async runs outside request-bound session.

**Fix.** Fetch DTO inside transactional service before returning Callable; or `@Transactional` on service method that prepares data fully.

---

## 24. Server-Sent Events on the Servlet Stack

### Core concept

**SSE** (`text/event-stream`) pushes server → client over HTTP. On servlet stack:

- `SseEmitter` (Spring MVC)
- `ResponseBodyEmitter` / `StreamingResponseBody`

Client uses `EventSource` API. One-way; for bidirectional use WebSocket.

### Internal working

```java
@GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter streamEvents(@RequestParam UUID userId) {
    SseEmitter emitter = new SseEmitter(0L); // no timeout, or set ms
    subscriptionService.subscribe(userId, emitter);
    emitter.onCompletion(() -> subscriptionService.unsubscribe(userId));
    emitter.onTimeout(() -> subscriptionService.unsubscribe(userId));
    return emitter;
}

// Service pushes:
public void push(UUID userId, Event event) throws IOException {
    SseEmitter emitter = subscribers.get(userId);
    if (emitter != null) {
        emitter.send(SseEmitter.event()
            .id(event.id())
            .name(event.type())
            .data(event.payload(), MediaType.APPLICATION_JSON));
    }
}
```

Proxy/load balancer requirements:

- Disable response buffering (`X-Accel-Buffering: no`)
- Increase idle timeout (ALB default 60s)
- Send comment heartbeat `: ping\n\n` every 30s

### Production scenario: SSE works direct to pod, fails through gateway

**Problem.** Events arrive in bursts after 30s behind corporate gateway.

**Cause.** Proxy buffering entire response until buffer full.

**Solution.** Gateway route disables buffering; set `Cache-Control: no-cache`; heartbeat events.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@RestController` returns `Flux` on servlet stack | Needs reactive dependency; prefer SseEmitter |
| Tomcat async timeout too short | Stream drops at fixed interval |
| No backpressure on fast producer | Memory growth in emitter queue |
| Missing CORS on EventSource cross-origin | Browser silent failure |

### Debugging scenario

**Observe.** Connection closes at exactly 60 seconds.

**Diagnose.** ALB/nginx idle timeout.

**Fix.** Heartbeat + increase proxy idle timeout.

---

## 25. OpenAPI, springdoc, Pageable, and HATEOAS (Brief)

### Core concept

**springdoc-openapi** (Boot 3: `org.springdoc:springdoc-openapi-starter-webmvc-ui`) generates OpenAPI 3 from MVC mappings at runtime.

**Pageable** — Spring Data resolves `?page=0&size=20&sort=createdAt,desc` into `Pageable` parameter.

**HATEOAS** — `RepresentationModel` / `EntityModel` add `_links`; optional for internal APIs, useful for discoverable public APIs.

### Internal working

Dependencies:

```xml
<dependency>
  <groupId>org.springdoc</groupId>
  <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
  <version>2.6.0</version>
</dependency>
```

UI at `/swagger-ui.html`; spec at `/v3/api-docs`.

Pageable in controller:

```java
@GetMapping
public Page<OrderDto> list(@ParameterObject Pageable pageable) {
    return orderService.findAll(pageable);
}
```

OpenAPI documents page params via `@ParameterObject` (springdoc) or explicit `@Parameter` annotations.

HATEOAS:

```java
@GetMapping("/{id}")
public EntityModel<OrderDto> get(@PathVariable UUID id) {
    OrderDto dto = orderService.findById(id);
    return EntityModel.of(dto,
        linkTo(methodOn(OrderController.class).get(id)).withSelfRel(),
        linkTo(methodOn(OrderController.class).list(Pageable.unpaged())).withRel("orders"));
}
```

Requires `@EnableHypermediaSupport` (Boot 3 auto when spring-hateoas on classpath).

Secure swagger in prod:

```yaml
springdoc:
  swagger-ui:
    enabled: ${SWAGGER_ENABLED:false}
  api-docs:
    enabled: ${SWAGGER_ENABLED:false}
```

### Production scenario: Pageable injection abuse

**Problem.** Client sends `?size=1000000`; DB OOM or timeout.

**Cause.** Unbounded `Pageable` — default max page size not capped.

**Solution.**

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public PageableHandlerMethodArgumentResolver customizePageableResolver(
            PageableHandlerMethodArgumentResolver resolver) {
        resolver.setMaxPageSize(100);
        resolver.setFallbackPageable(PageRequest.of(0, 20));
        return resolver;
    }
}
```

Or validate in `@ControllerAdvice` / custom argument resolver.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| springdoc + springfox together | Startup failure |
| Entity in OpenAPI schema | Massive schema, lazy props |
| HATEOAS on every DTO | Payload bloat |
| Public swagger in prod | Attack surface |

### Debugging scenario

**Observe.** Endpoint missing from OpenAPI doc.

**Diagnose.** `@Hidden` on controller; not scanned package; wrong `GroupedOpenApi` path filter.

**Fix.** `@Operation` + verify `springdoc.packages-to-scan`.

---

## 26. Production Pitfalls: OSIV, Jackson, Lazy Load, Threads, Timeouts, MVC vs WebFlux

### Core concept

This section ties together the failure modes that survive code review:

| Pitfall | One-line symptom |
|---|---|
| OSIV (`spring.jpa.open-in-view=true`) | Lazy loads during JSON serialization — N+1, slow, `LazyInitializationException` when disabled |
| Jackson on entities | Proxies, cycles, accidental schema leak |
| Thread exhaustion | Low CPU, all Tomcat threads blocked |
| Missing timeouts | Cascading latency |
| Wrong stack (MVC vs WebFlux) | Blocking JPA on Netty event loop |

Boot default **OSIV enabled** — convenient in dev, toxic in prod at scale.

### Internal working

OSIV filter (`OpenEntityManagerInViewFilter`) keeps JPA `EntityManager` open from filter entry until view rendering completes — including Jackson serializing `@RestController` response on the way out. Each lazy collection touch may fire a query **during HTTP response write**.

Disable for APIs:

```yaml
spring:
  jpa:
    open-in-view: false
```

Then every lazy access outside `@Transactional` service method fails fast — forces explicit fetch joins / DTO mapping (correct for REST).

MVC vs WebFlux decision:

```
Blocking stack (JDBC, JPA, blocking HTTP client):
  → Spring MVC + Tomcat (+ virtual threads Boot 3.2+)

True streaming / high fan-out I/O multiplexing with reactive drivers:
  → WebFlux + Netty + R2DBC/reactive Mongo

Hybrid "WebFlux with JPA on boundedElastic":
  → Usually worse than MVC + virtual threads unless strategic migration
```

Timeout stack:

```yaml
server:
  tomcat:
    connection-timeout: 20s
spring:
  mvc:
    async:
      request-timeout: 30s
# RestClient/WebClient read timeouts per client
# DB query timeout via @QueryHint or JDBC
# Gateway timeout > app timeout (or client sees 504 while app still working)
```

### Production scenario: OSIV masked N+1 for years

**Problem.** `GET /orders` returns 50 orders; one endpoint, 2001 SQL queries (1 + 50×40 lines).

**Cause.** OSIV + `@JsonSerialize` traversing lazy `orderLines` and nested `product` on entities returned directly.

**Solution.**

```java
@GetMapping
public Page<OrderSummaryDto> list(Pageable pageable) {
    return orderRepository.findAll(pageable).map(orderMapper::toSummary);
}

// Repository
@Query("SELECT o FROM Order o LEFT JOIN FETCH o.customer WHERE o.id = :id")
Optional<Order> findDetailedById(UUID id);
```

Disable OSIV; use fetch plan or DTO projection; add query count test in CI (datasource-proxy, Hibernate statistics).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| OSIV on + returning entities | Random N+1 after "harmless" entity graph change |
| OSIV off without fetch plan | Mass `LazyInitializationException` after deploy |
| WebFlux + JPA blocking | Event loop blocked, worse than MVC |
| Gateway timeout 30s, app 120s | 504 to client, work continues, duplicate retries |
| No `@Transactional(readOnly=true)` on reads | Connection held, write txn overhead |

### Debugging scenario

**Observe.** p99 spikes only on endpoints returning domain graphs; SQL count correlates with result size.

**Diagnose.** Enable Hibernate statistics in staging:

```yaml
spring.jpa.properties.hibernate.generate_statistics: true
```

Log `SessionMetrics` or use Micrometer `hibernate_sessions_open`.

**Fix.** DTO boundary; `@EntityGraph`; OSIV false; integration test asserting query count.

---

## 27. Production Debugging Playbook

When an MVC bug is "random," it is usually **wrong path seen by servlet**, **filter order**, **converter/negotiation**, or **thread pool starvation**.

1. **Classify the status code.** 404 = mapping/path. 405 = method. 415 = request Content-Type. 406 = Accept/produces. 400 = binding/validation. 401/403 = security (before MVC). 500 = unhandled exception — check `@ControllerAdvice`.

2. **Log servlet path triplet** on a canary filter: `requestURI`, `contextPath`, `servletPath`. Compare to `@RequestMapping` patterns.

3. **Enable targeted DEBUG** (not full TRACE in prod):

   ```yaml
   logging.level.org.springframework.web.servlet.DispatcherServlet: DEBUG
   logging.level.org.springframework.web.servlet.mvc.method.annotation: DEBUG
   ```

   Read `Mapped to ...` vs `No mapping for GET ...`.

4. **Dump registered mappings** via Actuator `/actuator/mappings` (secure it). Confirm handler exists for verb + path.

5. **For 415/406:** log `Content-Type` and `Accept` headers; inspect `@RequestMapping(consumes/produces)`; list registered `HttpMessageConverter` media types.

6. **For empty/wrong JSON:** verify single `ObjectMapper` for HTTP; check DTO vs entity; check `@Json*` annotations; verify no filter consumed body.

7. **For lazy load / N+1:** SQL log or Hibernate statistics; reproduce with OSIV disabled; count queries vs rows.

8. **For hangs:** thread dump immediately. All Tomcat threads blocked → find frame (JDBC, HTTP, lock). CPU high → different problem (GC, infinite loop).

9. **For async/SSE drops:** check proxy idle timeout, async timeout, heartbeat.

10. **For CORS "errors":** reproduce in browser network tab; verify OPTIONS response headers; security chain CORS before auth.

11. **Turn DEBUG off** after incident. Do not log `@RequestBody` payloads with PII in prod.

12. **Reproduce with MockMvc** using production `context-path`, security, and headers — curl alone misses CORS and gateway rewrite issues.

---

## 28. Quick Decision Matrix

| Situation | Do this |
|---|---|
| JSON REST API | `@RestController` + DTOs + `@Valid` + `@RestControllerAdvice` + `ProblemDetail` |
| Server-rendered HTML | `@Controller` + Thymeleaf; CSRF on; separate from API module |
| Public API pagination | `Pageable` with `maxPageSize` cap; document in OpenAPI |
| File upload | `MultipartFile` + size limits at gateway and Spring; virus scan async |
| Long-running report | `Callable`/`DeferredResult` with dedicated executor + timeout |
| Live notifications to browser | SSE + heartbeat + proxy buffering disabled |
| Behind API gateway | Map on servlet path; document strip prefix; forward headers for redirects |
| JPA + REST | OSIV **off**; fetch join or DTO; never serialize entities |
| Java 21 + blocking JDBC | MVC + `spring.threads.virtual.enabled=true`; monitor pinning |
| Need OpenAPI | springdoc; disable swagger UI in prod or protect with auth |
| Custom request context | `OncePerRequestFilter` at known `@Order`, not interceptor only |
| Mixed security UI + API | Separate `SecurityFilterChain`s (see Security doc) |
| Client-specific media types | Explicit `produces = APPLICATION_JSON_VALUE`; avoid ambiguous negotiation |
| Choosing MVC vs WebFlux | MVC for JPA/JDBC; WebFlux for reactive data + streaming; don't block Netty |
| Validation groups create/update | `@Validated(OnCreate.class)` / `@Validated(OnUpdate.class)` on `@RequestBody` |
| Error format for machines | RFC 7807 `ProblemDetail`; never stack traces in prod |
| Thread pool exhaustion | Timeouts first; then bulkhead; then virtual threads; last resort raise maxThreads |

---

## Practice Questions & Answers

<details class="qa-item">
<summary>1. Your `@RestController` returns a JPA entity graph. Tests pass with one row; production p99 explodes with 500 rows. What happened?</summary>

Open Session In View keeps the persistence context open through Jackson serialization. Each lazy association touched during JSON writing triggers an extra SQL query — classic N+1. Tests used one entity; production list size multiplied queries. Fix: disable OSIV for APIs, return DTOs with explicit fetch plans or `@EntityGraph`, add query-count integration tests.

</details>

<details class="qa-item">
<summary>2. `POST /api/orders` returns 415 with `Content-Type: application/json`. curl works from your laptop but not from the partner integration.</summary>

Partner sends `Content-Type: application/json; charset=ISO-8859-1` or typo `application/jso n`. Or method-level `consumes = APPLICATION_JSON_VALUE` without charset tolerance while gateway strips/modifies header. Fix: log raw Content-Type; relax consumes if safe; ensure `MappingJackson2HttpMessageConverter` registered; partner sends UTF-8 standard header.

</details>

<details class="qa-item">
<summary>3. Actuator shows your handler mapped. Gateway returns 404. Direct pod call works. List three causes.</summary>

(1) Gateway path rewrite strips/adds prefix mismatching `@RequestMapping`. (2) Wrong service/port upstream. (3) Gateway method restriction (only GET allowed). Fix: compare `servletPath` on pod vs public URL; align rewrite rules with controller base path.

</details>

<details class="qa-item">
<summary>4. After Spring Boot 3 upgrade, `/api/users/` (trailing slash) 404s but `/api/users` works. Why?</summary>

Spring Framework 6 defaults `trailingSlashMatch = false`. Boot 2 often behaved leniently. Fix: redirect in gateway, update clients, or temporarily `pathmatch.matching-strategy` / `trailingSlashMatch` via config (prefer client fix).

</details>

<details class="qa-item">
<summary>5. Custom `Filter` logs request body but controller `@RequestBody` is always empty. Explain.</summary>

Servlet input stream is single-read. Filter consumed bytes before `DispatcherServlet`. Fix: wrap with `ContentCachingRequestWrapper` in a `OncePerRequestFilter` at highest precedence; read from cache after chain or only in interceptor after dispatch.

</details>

<details class="qa-item">
<summary>6. `GET` with `Accept: application/xml` returns XML after you added Jackson XML module. Mobile clients break. Fix?</summary>

Mobile sends `Accept: */*` or lists XML. Content negotiation picks XML when converter registered. Fix: `produces = APPLICATION_JSON_VALUE` on API controllers, or set default content type JSON and remove XML converter from MVC if not needed publicly.

</details>

<details class="qa-item">
<summary>7. Thread dump shows 200/200 `http-nio-*` threads in `HttpURLConnection.getInputStream`. CPU 8%. Diagnosis and fix?</summary>

Synchronous outbound HTTP without timeouts during traffic spike — thread pool starvation, not CPU saturation. Fix: RestClient/WebClient with connect/read timeouts, circuit breaker, reduce call count, cache, or async handoff with bounded pool. Raising maxThreads alone postpones failure.

</details>

<details class="qa-item">
<summary>8. `@Valid` on `@RequestBody` but invalid payloads reach the service layer in production.</summary>

Missing `@Valid` on the controller parameter (only on service), or self-invocation bypassing validated proxy, or wrong controller method wired (old deployment). Fix: `@Valid @RequestBody` at boundary; `@RestControllerAdvice` for `MethodArgumentNotValidException`; verify deployed artifact.

</details>

<details class="qa-item">
<summary>9. CORS error in browser on 401; same request works in Postman.</summary>

Browser requires CORS headers even on error responses. Security chain rejected before `CorsFilter`, or entry point omits ACAO. Fix: `http.cors()` on JWT chain; `CorsConfigurationSource` bean; ensure OPTIONS permitted.

</details>

<details class="qa-item">
<summary>10. `LazyInitializationException` after setting `spring.jpa.open-in-view=false`. Was disabling OSIV wrong?</summary>

Disabling OSIV is correct for REST; the exception exposes lazy loading outside transactions. Fix: fetch required data inside `@Transactional` service methods into DTOs; use `@EntityGraph` or join fetch; do not touch lazy fields in controller or during JSON mapping.

</details>

<details class="qa-item">
<summary>11. SSE stream freezes behind ALB until buffer fills, then burps events. Cause and fix?</summary>

Proxy response buffering. Fix: disable buffering (`X-Accel-Buffering: no`), `Cache-Control: no-cache`, periodic SSE comment heartbeat, increase idle timeout above heartbeat interval.

</details>

<details class="qa-item">
<summary>12. `DeferredResult` never completes; clients hang until 503.</summary>

No thread called `setResult` / `setErrorResult`; or async timeout too long; or executor queue full so callback never runs. Fix: ensure completion on all paths; timeout callback; size thread pool; log subscriber registration leaks.

</details>

<details class="qa-item">
<summary>13. Two `@ControllerAdvice` beans — sometimes validation returns ProblemDetail, sometimes Whitelabel HTML.</summary>

Advice ordering and scope differ; HTML advice catches broader exceptions for MVC controllers. Fix: `@Order(Ordered.HIGHEST_PRECEDENCE)` on API advice; `@RestControllerAdvice(basePackageClasses = ...)` scoped to API; separate UI exception handling.

</details>

<details class="qa-item">
<summary>14. Pageable `?sort=password` allows sorting by sensitive column. How do you prevent?</summary>

Spring Data binds sort fields directly unless restricted. Fix: `Pageable` `@PageableDefault` + `SortHandlerMethodArgumentResolver` with allowed properties whitelist, or custom `Pageable` resolver rejecting unknown properties, or DTO projection query with fixed ORDER BY.

</details>

<details class="qa-item">
<summary>15. Virtual threads enabled but JFR shows heavy `VirtualThreadPinned`. Next step?</summary>

Pinning negates benefit — often `synchronized` in JDBC driver, pool, or legacy library. Fix: upgrade driver, reduce synchronized blocks, try unpinned alternative pool, profile pinned stacks; virtual threads still help but less than expected until pinning fixed.

</details>

<details class="qa-item">
<summary>16. Multipart upload 413 only through ingress; pod accepts 8MB file.</summary>

Ingress/gateway body size limit lower than Spring `max-file-size`. Fix: raise `client_max_body_size` / equivalent; align all layers; return structured 413 body from app when possible.

</details>

<details class="qa-item">
<summary>17. MockMvc test passes; production security returns 403 on POST.</summary>

Test excludes security (`@WebMvcTest` without `@Import(SecurityConfig.class)`) or CSRF disabled in test only. Production CSRF on cookie session. Fix: `@AutoConfigureMockMvc(addFilters = true)` with security test slice; match CSRF rules prod uses or use Bearer in both.

</details>

<details class="qa-item">
<summary>18. `@PathVariable UUID id` throws 400 for valid UUID string copied from Excel.</summary>

Hidden BOM, zero-width characters, or trailing `\r` in path segment. Fix: trim in custom converter; validate with `@Pattern`; log hex bytes of captured segment in DEBUG.

</details>

<details class="qa-item">
<summary>19. When should you choose WebFlux over MVC for a new Spring Boot 3.2 service using PostgreSQL?</summary>

Choose MVC + virtual threads if using JDBC/JPA (blocking). Choose WebFlux if committing to R2DBC/reactive driver end-to-end, or need reactive streaming integration with backpressure as first-class. Do not choose WebFlux for CRUD JPA wrapped in `Mono.fromCallable` — operational cost without benefit.

</details>

<details class="qa-item">
<summary>20. Client reports duplicate JSON keys after Map serialized in response. Is Jackson broken?</summary>

Jackson serializes `Map` with string keys as-is; duplicate keys possible if map implementation allows (unusual) or custom serializer merges wrong. More often: client parses incorrectly or middleware duplicates body. Fix: use typed DTO instead of `Map<String,Object>` for stable schema.

</details>

<details class="qa-item">
<summary>21. `springdoc` documents endpoint twice with different paths.</summary>

Duplicate `@RequestMapping` on method + interface, or context-path configured in springdoc and servlet, or multiple `GroupedOpenApi` overlap. Fix: single mapping declaration; configure `server.servlet.context-path` once; narrow group paths.

</details>

<details class="qa-item">
<summary>22. Gateway timeout 30s; app continues processing; client retries create duplicate orders. Fix?</summary>

Timeout mismatch — client sees 504, server still running. Fix: idempotency keys on POST; align gateway timeout with app SLA; shorter server-side deadline; return 202 Accepted for long work with poll URL; cancel work on client disconnect if detectable.

</details>

<details class="qa-item">
<summary>23. Static `index.html` served instead of SPA fallback breaking deep links to `/orders/123`.</summary>

Resource handler serves files only; no fallback to `index.html` for client routes. Fix: `WebMvcConfigurer` view controller or nginx `try_files` forwarding unknown paths to `index.html`; keep API under `/api/**` separate from SPA routes.

</details>

<details class="qa-item">
<summary>24. Hibernate `@Version` optimistic lock exception returns 500 to client. Best HTTP mapping?</summary>

Map `OptimisticLockException` / `ObjectOptimisticLockingFailureException` in `@RestControllerAdvice` to 409 Conflict with `ProblemDetail` explaining concurrent modification; client refreshes and retries. Do not expose stack trace.

</details>

---

*Spring MVC looks simple because annotations hide a pipeline. Production failures live in that pipeline — path matching, filter order, message converters, thread pools, and the moment Jackson touches a lazy proxy. Map the request end-to-end, keep entities off the wire, and pick WebFlux only when the data path is actually reactive.*
