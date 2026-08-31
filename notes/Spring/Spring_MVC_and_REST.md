# Spring MVC and REST Mastery — Senior Production Reference

Spring Boot 3.x / Spring MVC 6.x servlet stack. This is not a tutorial on `@GetMapping`. It is the map of what actually breaks in production after years of shipping REST APIs on embedded Tomcat — thread exhaustion, Jackson surprises, path-matching regressions, and the filter chain order that nobody documents until 2 a.m.

---

## Table of Contents

1. [1. Mental Model: DispatcherServlet](#1-mental-model-dispatcherservlet)
2. [2. DispatcherServlet Lifecycle](#2-dispatcherservlet-lifecycle)
3. [3. HandlerMapping](#3-handlermapping)
4. [4. HandlerAdapter](#4-handleradapter)
5. [5. View Resolution, HttpMessageConverter, and JSON](#5-view-resolution-httpmessageconverter-and-json)
6. [6. @RestController vs @Controller](#6-restcontroller-vs-controller)
7. [7. @RequestMapping Variants and Path Matching](#7-requestmapping-variants-and-path-matching)
8. [8. Path Variables, Request Params, and Headers](#8-path-variables-request-params-and-headers)
9. [9. Content Negotiation](#9-content-negotiation)
10. [10. @RequestBody and @ResponseBody](#10-requestbody-and-responsebody)
11. [11. Jackson Integration](#11-jackson-integration)
12. [12. Validation: @Valid, @Validated, and Groups](#12-validation-valid-validated-and-groups)
13. [13. Exception Handling: @ControllerAdvice and ProblemDetail (RFC 7807)](#13-exception-handling-controlleradvice-and-problemdetail-rfc-7807)
14. [14. Filters vs Interceptors vs Security Filter Chain Order](#14-filters-vs-interceptors-vs-security-filter-chain-order)
15. [15. Embedded Tomcat Thread Pool and maxThreads](#15-embedded-tomcat-thread-pool-and-maxthreads)
16. [16. Virtual Threads (Boot 3.2+)](#16-virtual-threads-boot-32)
17. [17. Multipart Uploads and File Download](#17-multipart-uploads-and-file-download)
18. [18. CORS and Static Resources](#18-cors-and-static-resources)
19. [19. Async MVC: DeferredResult, Callable, and @Async](#19-async-mvc-deferredresult-callable-and-async)
20. [20. Server-Sent Events on the Servlet Stack](#20-server-sent-events-on-the-servlet-stack)
21. [21. OpenAPI, springdoc, Pageable, and HATEOAS (Brief)](#21-openapi-springdoc-pageable-and-hateoas-brief)
22. [22. Production Pitfalls: OSIV, Jackson, Lazy Load, Threads, Timeouts, MVC vs WebFlux](#22-production-pitfalls-osiv-jackson-lazy-load-threads-timeouts-mvc-vs-webflux)
23. [23. Production Debugging Playbook](#23-production-debugging-playbook)
24. [24. Quick Decision Matrix](#24-quick-decision-matrix)

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

## 10. @RequestBody and @ResponseBody

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

## 11. Jackson Integration

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

## 12. Validation: @Valid, @Validated, and Groups

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

**Fix.** Structured `ProblemDetail` with field errors (see section 13). Enable `server.error.include-binding-errors=never` in prod for security on non-API endpoints.

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

## 13. Exception Handling: @ControllerAdvice and ProblemDetail (RFC 7807)

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

## 14. Filters vs Interceptors vs Security Filter Chain Order

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

## 15. Embedded Tomcat Thread Pool and maxThreads

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

**Solution.** Timeouts + circuit breaker; fix latency; virtual threads as complementary (section 16).

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

## 16. Virtual Threads (Boot 3.2+)

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

## 17. Multipart Uploads and File Download

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

## 18. CORS and Static Resources

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

## 19. Async MVC: DeferredResult, Callable, and @Async

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

## 20. Server-Sent Events on the Servlet Stack

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

## 21. OpenAPI, springdoc, Pageable, and HATEOAS (Brief)

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

## 22. Production Pitfalls: OSIV, Jackson, Lazy Load, Threads, Timeouts, MVC vs WebFlux

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

## 23. Production Debugging Playbook

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

## 24. Quick Decision Matrix

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

## Scenario-Based Questions

### 1. Your `@RestController` returns a JPA entity graph. Tests pass with one row; production p99 explodes with 500 rows. What happened?

**Answer.** Open Session In View keeps the persistence context open through Jackson serialization. Each lazy association touched during JSON writing triggers an extra SQL query — classic N+1. Tests used one entity; production list size multiplied queries. Fix: disable OSIV for APIs, return DTOs with explicit fetch plans or `@EntityGraph`, add query-count integration tests.

### 2. `POST /api/orders` returns 415 with `Content-Type: application/json`. curl works from your laptop but not from the partner integration.

**Answer.** Partner sends `Content-Type: application/json; charset=ISO-8859-1` or typo `application/jso n`. Or method-level `consumes = APPLICATION_JSON_VALUE` without charset tolerance while gateway strips/modifies header. Fix: log raw Content-Type; relax consumes if safe; ensure `MappingJackson2HttpMessageConverter` registered; partner sends UTF-8 standard header.

### 3. Actuator shows your handler mapped. Gateway returns 404. Direct pod call works. List three causes.

**Answer.** (1) Gateway path rewrite strips/adds prefix mismatching `@RequestMapping`. (2) Wrong service/port upstream. (3) Gateway method restriction (only GET allowed). Fix: compare `servletPath` on pod vs public URL; align rewrite rules with controller base path.

### 4. After Spring Boot 3 upgrade, `/api/users/` (trailing slash) 404s but `/api/users` works. Why?

**Answer.** Spring Framework 6 defaults `trailingSlashMatch = false`. Boot 2 often behaved leniently. Fix: redirect in gateway, update clients, or temporarily `pathmatch.matching-strategy` / `trailingSlashMatch` via config (prefer client fix).

### 5. Custom `Filter` logs request body but controller `@RequestBody` is always empty. Explain.

**Answer.** Servlet input stream is single-read. Filter consumed bytes before `DispatcherServlet`. Fix: wrap with `ContentCachingRequestWrapper` in a `OncePerRequestFilter` at highest precedence; read from cache after chain or only in interceptor after dispatch.

### 6. `GET` with `Accept: application/xml` returns XML after you added Jackson XML module. Mobile clients break. Fix?

**Answer.** Mobile sends `Accept: */*` or lists XML. Content negotiation picks XML when converter registered. Fix: `produces = APPLICATION_JSON_VALUE` on API controllers, or set default content type JSON and remove XML converter from MVC if not needed publicly.

### 7. Thread dump shows 200/200 `http-nio-*` threads in `HttpURLConnection.getInputStream`. CPU 8%. Diagnosis and fix?

**Answer.** Synchronous outbound HTTP without timeouts during traffic spike — thread pool starvation, not CPU saturation. Fix: RestClient/WebClient with connect/read timeouts, circuit breaker, reduce call count, cache, or async handoff with bounded pool. Raising maxThreads alone postpones failure.

### 8. `@Valid` on `@RequestBody` but invalid payloads reach the service layer in production.

**Answer.** Missing `@Valid` on the controller parameter (only on service), or self-invocation bypassing validated proxy, or wrong controller method wired (old deployment). Fix: `@Valid @RequestBody` at boundary; `@RestControllerAdvice` for `MethodArgumentNotValidException`; verify deployed artifact.

### 9. CORS error in browser on 401; same request works in Postman.

**Answer.** Browser requires CORS headers even on error responses. Security chain rejected before `CorsFilter`, or entry point omits ACAO. Fix: `http.cors()` on JWT chain; `CorsConfigurationSource` bean; ensure OPTIONS permitted.

### 10. `LazyInitializationException` after setting `spring.jpa.open-in-view=false`. Was disabling OSIV wrong?

**Answer.** Disabling OSIV is correct for REST; the exception exposes lazy loading outside transactions. Fix: fetch required data inside `@Transactional` service methods into DTOs; use `@EntityGraph` or join fetch; do not touch lazy fields in controller or during JSON mapping.

### 11. SSE stream freezes behind ALB until buffer fills, then burps events. Cause and fix?

**Answer.** Proxy response buffering. Fix: disable buffering (`X-Accel-Buffering: no`), `Cache-Control: no-cache`, periodic SSE comment heartbeat, increase idle timeout above heartbeat interval.

### 12. `DeferredResult` never completes; clients hang until 503.

**Answer.** No thread called `setResult` / `setErrorResult`; or async timeout too long; or executor queue full so callback never runs. Fix: ensure completion on all paths; timeout callback; size thread pool; log subscriber registration leaks.

### 13. Two `@ControllerAdvice` beans — sometimes validation returns ProblemDetail, sometimes Whitelabel HTML.

**Answer.** Advice ordering and scope differ; HTML advice catches broader exceptions for MVC controllers. Fix: `@Order(Ordered.HIGHEST_PRECEDENCE)` on API advice; `@RestControllerAdvice(basePackageClasses = ...)` scoped to API; separate UI exception handling.

### 14. Pageable `?sort=password` allows sorting by sensitive column. How do you prevent?

**Answer.** Spring Data binds sort fields directly unless restricted. Fix: `Pageable` `@PageableDefault` + `SortHandlerMethodArgumentResolver` with allowed properties whitelist, or custom `Pageable` resolver rejecting unknown properties, or DTO projection query with fixed ORDER BY.

### 15. Virtual threads enabled but JFR shows heavy `VirtualThreadPinned`. Next step?

**Answer.** Pinning negates benefit — often `synchronized` in JDBC driver, pool, or legacy library. Fix: upgrade driver, reduce synchronized blocks, try unpinned alternative pool, profile pinned stacks; virtual threads still help but less than expected until pinning fixed.

### 16. Multipart upload 413 only through ingress; pod accepts 8MB file.

**Answer.** Ingress/gateway body size limit lower than Spring `max-file-size`. Fix: raise `client_max_body_size` / equivalent; align all layers; return structured 413 body from app when possible.

### 17. MockMvc test passes; production security returns 403 on POST.

**Answer.** Test excludes security (`@WebMvcTest` without `@Import(SecurityConfig.class)`) or CSRF disabled in test only. Production CSRF on cookie session. Fix: `@AutoConfigureMockMvc(addFilters = true)` with security test slice; match CSRF rules prod uses or use Bearer in both.

### 18. `@PathVariable UUID id` throws 400 for valid UUID string copied from Excel.

**Answer.** Hidden BOM, zero-width characters, or trailing `\r` in path segment. Fix: trim in custom converter; validate with `@Pattern`; log hex bytes of captured segment in DEBUG.

### 19. When should you choose WebFlux over MVC for a new Spring Boot 3.2 service using PostgreSQL?

**Answer.** Choose MVC + virtual threads if using JDBC/JPA (blocking). Choose WebFlux if committing to R2DBC/reactive driver end-to-end, or need reactive streaming integration with backpressure as first-class. Do not choose WebFlux for CRUD JPA wrapped in `Mono.fromCallable` — operational cost without benefit.

### 20. Client reports duplicate JSON keys after Map serialized in response. Is Jackson broken?

**Answer.** Jackson serializes `Map` with string keys as-is; duplicate keys possible if map implementation allows (unusual) or custom serializer merges wrong. More often: client parses incorrectly or middleware duplicates body. Fix: use typed DTO instead of `Map<String,Object>` for stable schema.

### 21. `springdoc` documents endpoint twice with different paths.

**Answer.** Duplicate `@RequestMapping` on method + interface, or context-path configured in springdoc and servlet, or multiple `GroupedOpenApi` overlap. Fix: single mapping declaration; configure `server.servlet.context-path` once; narrow group paths.

### 22. Gateway timeout 30s; app continues processing; client retries create duplicate orders. Fix?

**Answer.** Timeout mismatch — client sees 504, server still running. Fix: idempotency keys on POST; align gateway timeout with app SLA; shorter server-side deadline; return 202 Accepted for long work with poll URL; cancel work on client disconnect if detectable.

### 23. Static `index.html` served instead of SPA fallback breaking deep links to `/orders/123`.

**Answer.** Resource handler serves files only; no fallback to `index.html` for client routes. Fix: `WebMvcConfigurer` view controller or nginx `try_files` forwarding unknown paths to `index.html`; keep API under `/api/**` separate from SPA routes.

### 24. Hibernate `@Version` optimistic lock exception returns 500 to client. Best HTTP mapping?

**Answer.** Map `OptimisticLockException` / `ObjectOptimisticLockingFailureException` in `@RestControllerAdvice` to 409 Conflict with `ProblemDetail` explaining concurrent modification; client refreshes and retries. Do not expose stack trace.

---

*Spring MVC looks simple because annotations hide a pipeline. Production failures live in that pipeline — path matching, filter order, message converters, thread pools, and the moment Jackson touches a lazy proxy. Map the request end-to-end, keep entities off the wire, and pick WebFlux only when the data path is actually reactive.*
