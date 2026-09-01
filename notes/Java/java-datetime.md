# Java Date & Time (java.time) — Senior Production Reference

Java 8 introduced `java.time` (JSR-310); Java 9+ refined parsing, `Clock` injection, and `InstantSource`. Hibernate 6, Jackson 2.12+, and JDBC 4.2 assume you know the difference between a **civil datetime** and an **instant on the timeline**. This is not a tutorial on `LocalDate.now()`. It is the map of what actually breaks in production when teams still think in `java.util.Date`, store `TIMESTAMP WITHOUT TIME ZONE` as "UTC," or schedule cron jobs across DST boundaries.

---

## Table of Contents

1. [Mental Model: Why Date and Calendar Failed](#1-mental-model-why-date-and-calendar-failed)
2. [Type Map: The java.time Hierarchy](#2-type-map-the-javatime-hierarchy)
3. [LocalDateTime Is NOT a Timestamp](#3-localdatetime-is-not-a-timestamp)
4. [Instant vs OffsetDateTime vs ZonedDateTime](#4-instant-vs-offsetdatetime-vs-zoneddatetime)
5. [ZoneId vs ZoneOffset, and tzdata](#5-zoneid-vs-zoneoffset-and-tzdata)
6. [DST Pitfalls and Scheduling](#6-dst-pitfalls-and-scheduling)
7. [Duration vs Period](#7-duration-vs-period)
8. [Arithmetic and TemporalAdjusters](#8-arithmetic-and-temporaladjusters)
9. [Formatting and Parsing: DateTimeFormatter Pitfalls](#9-formatting-and-parsing-datetimeformatter-pitfalls)
10. [Clock Injection for Tests](#10-clock-injection-for-tests)
11. [Precision and DB Round-Trip](#11-precision-and-db-round-trip)
12. [Persistence: JDBC, JPA, and Hibernate 6](#12-persistence-jdbc-jpa-and-hibernate-6)
13. [JSON: Jackson JavaTimeModule](#13-json-jackson-javatimemodule)
14. [Legacy Interop](#14-legacy-interop)
15. [Business Calendars](#15-business-calendars)
16. [Performance: Wall Clock vs nanoTime](#16-performance-wall-clock-vs-nanotime)
17. [Production Debugging Playbook](#17-production-debugging-playbook)
18. [Quick Decision Matrix](#18-quick-decision-matrix)

---


## 1. Mental Model: Why Date and Calendar Failed

Before `java.time`, Java had `java.util.Date`, `java.util.Calendar`, and `java.sql.*` date types. They were a design accident compounded over decades. Senior engineers do not "prefer" `java.time` for style — they use it because the legacy types encode **wrong mental models** that become production incidents.

### What `java.util.Date` actually was

`Date` stored milliseconds since the Unix epoch (1970-01-01T00:00:00Z) in a `long`, but most of its API pretended it was a **calendar date with civil fields** (`getMonth()`, `getDate()`, `getHours()`). Those civil fields were interpreted in the **JVM default time zone** at call time — not stored in the object.

```
Date object in memory:  one long — instant on the UTC timeline
Date API surface:       "what day is it?" — answered using JVM default ZoneId, today
```

That mismatch is the root of thousands of "off by one day" bugs around midnight and DST.

### Calendar: mutable, heavy, and easy to misuse

`Calendar` is mutable. Passing a `Calendar` to a method that adjusts fields for DST or month length **mutates the caller's object**. It is not thread-safe. `GregorianCalendar` has subtle rules (lenient vs non-lenient, week-year vs calendar-year) that differ from ISO-8601 business rules.

### The three questions every datetime API must answer

| Question | Legacy Java answer | `java.time` answer |
|---|---|---|
| **What instant on the timeline?** | `Date.getTime()`, `Instant` | `Instant` |
| **What civil date/time (no zone)?** | `Calendar` fields in default zone | `LocalDate`, `LocalTime`, `LocalDateTime` |
| **What civil date/time in a specific region?** | `Calendar` + manual zone | `ZonedDateTime`, `OffsetDateTime` |

If your domain model cannot state which row of this table it belongs in, you will ship bugs.

### Production scenario: "midnight UTC became yesterday"

**Problem.** A billing service stores `new Date()` in MySQL `DATETIME` (no time zone). JVM runs in `America/New_York`. At 2024-03-10 19:30 EST (which is 2024-03-11 00:30 UTC), a job formats the date with `SimpleDateFormat("yyyy-MM-dd")` using the default zone. Invoices show `2024-03-10` while the DB row's epoch millis correspond to `2024-03-11` UTC.

**Cause.** `Date` is an instant; `SimpleDateFormat` renders civil fields in the JVM zone; `DATETIME` stores whatever string/number you gave it with **no zone metadata**.

**Solution.** Pick one rule and enforce it in types:

```java
// At persistence boundary — always Instant or OffsetDateTime with explicit offset
Instant occurredAt = Instant.now(clock);
// JDBC: setObject(1, occurredAt, Types.TIMESTAMP_WITH_TIMEZONE)

// At display boundary — convert to user's zone once
ZonedDateTime userView = occurredAt.atZone(ZoneId.of("America/New_York"));
String label = DateTimeFormatter.ISO_LOCAL_DATE.format(userView);
```

### Common legacy misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `new Date()` + `DATETIME` column | Rows drift vs UTC logs; month-end reports wrong |
| `SimpleDateFormat` as static field | `NumberFormatException`, wrong dates under concurrency |
| `Calendar.getInstance()` in hot path | Allocation churn, accidental mutation |
| `date.getTimezoneOffset()` for "UTC conversion" | Double-applying offset around DST |
| Storing local civil time as epoch millis | Non-replayable; JVM zone change alters meaning |

### Debugging scenario

**Observe.** Integration test passes; production shows dates one day early for APAC users only.

**Diagnose.**

```java
log.info("instant={} defaultZone={} localDate={}",
    instant,
    ZoneId.systemDefault(),
    instant.atZone(ZoneId.systemDefault()).toLocalDate());
```

Check: DB column type, JDBC `setTimestamp` vs `setObject(OffsetDateTime)`, formatter zone, and whether the browser sends `YYYY-MM-DD` without offset.

**Fix.** `Instant` in DB as `TIMESTAMPTZ` (Postgres) or `DATETIME2` + documented UTC convention; never infer zone from the server.

---

## 2. Type Map: The java.time Hierarchy

`java.time` separates **timeline** types from **civil** types from **partial** types. Learn the interface graph once; every production bug is picking the wrong leaf type.

### Core interfaces

```
Temporal
  ├── TemporalAccessor   (read fields)
  └── Temporal           (read + adjust)
        ├── Instant
        ├── LocalDate, LocalTime, LocalDateTime
        ├── OffsetTime, OffsetDateTime
        └── ZonedDateTime
```

| Type | Contains | Zone / offset | Use when |
|---|---|---|---|
| `Instant` | Epoch seconds + nanos | Always UTC timeline | Event timestamps, audit logs, `created_at` |
| `LocalDate` | Year-month-day | None | Birthdays, due dates, fiscal periods |
| `LocalTime` | Hour-minute-second-nano | None | Daily cutoffs, opening hours (same every day) |
| `LocalDateTime` | Date + time | None | "Meeting at 3pm" without zone; **not** for instants |
| `OffsetDateTime` | Date + time + fixed offset | Fixed `+05:30`, not rules | ISO-8601 with offset; APIs; DB round-trip |
| `OffsetTime` | Time + fixed offset | Fixed offset | Rare; XML schema interop |
| `ZonedDateTime` | Date + time + `ZoneId` | Full rules (DST) | Scheduling, user-facing timestamps |
| `Year`, `YearMonth`, `MonthDay` | Partial dates | None | Billing cycles, recurring holidays |
| `Duration` | Seconds/nanos span | — | Time-based amount (2 hours) |
| `Period` | Years/months/days | — | Calendar-based amount (1 month) |

### Conversion cheat paths (not all exist)

```
Instant ──atZone(zone)──► ZonedDateTime ──toLocalDateTime()──► LocalDateTime
   ▲                              │
   └──toInstant()────────────────┘
LocalDateTime ──atZone(zone)──► ZonedDateTime
LocalDateTime ──atOffset(offset)──► OffsetDateTime   (no DST rules applied)
OffsetDateTime ──toInstant()──► Instant
```

There is **no** `LocalDateTime.toInstant()` without supplying zone or offset. That is intentional.

### Production scenario: wrong type in the DTO

**Problem.** REST API returns `"scheduledAt": "2024-07-15T15:00:00"` for a global webinar. US attendees show up an hour early after DST ends in EU.

**Cause.** `LocalDateTime` in JSON implies "no zone." Clients guess local zone.

**Solution.** Serialize instants or zoned times:

```java
// DTO field
private Instant scheduledAt; // or OffsetDateTime / ZonedDateTime

// Jackson (see Section 13)
@JsonFormat(shape = JsonFormat.Shape.STRING)
private Instant scheduledAt;
// "2024-07-15T15:00:00Z" or "2024-07-15T15:00:00+02:00"
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `LocalDateTime` for `createdAt` | Cannot order events across DST; ambiguous local times |
| `ZonedDateTime` in every entity | Unnecessary DST math for pure dates |
| `OffsetDateTime` for recurring meetings | Offset changes when rules change; use `LocalDateTime` + `ZoneId` separately |
| `Instant` for "date of birth" | Wrong day in western US when converted for display |

---

## 3. LocalDateTime Is NOT a Timestamp

This section exists because teams still store `LocalDateTime` in `created_at` columns and call it UTC.

### What `LocalDateTime` means

`LocalDateTime` is a **civil datetime**: wall-clock numbers with **no place on Earth** attached. `2024-03-10T02:30` might not exist (spring forward) or might exist twice (fall back) in `America/New_York`, but `LocalDateTime` does not know that — it is just numbers.

```
LocalDateTime  =  "the numbers on a hypothetical clock"
Instant        =  "a point on the universal timeline"
ZonedDateTime  =  "numbers on a clock in a specific region's rules"
```

### The fatal conversion

```java
// WRONG — uses JVM default zone silently
Instant wrong = localDateTime.toInstant(ZoneOffset.UTC); // only valid if you MEAN UTC civil time

// RIGHT — explicit zone that defines what the civil numbers meant
Instant right = localDateTime.atZone(ZoneId.of("Europe/Paris")).toInstant();
```

`LocalDateTime.atZone(zone)` uses the zone rules to resolve gaps/overlaps. `atOffset(offset)` **does not** apply DST transitions — it naively combines local numbers with a fixed offset.

### When `LocalDateTime` is correct

| Domain concept | Type | Why |
|---|---|---|
| "Ship on 2024-12-25" | `LocalDate` | No time, no zone |
| "Store opens at 09:00 every Monday" | `LocalTime` or pair with `LocalDate` | Repeating civil time |
| "Board meeting every 2nd Tuesday 14:00 in Chicago" | `LocalDateTime` + `ZoneId` stored separately | Rules applied at scheduling time |
| "Payment captured" | `Instant` | Single point in history |

### Production scenario: double timezone conversion

**Problem.** Service A stores `LocalDateTime.now()` (server in Dublin). Service B reads it, assumes UTC, converts to `America/Los_Angeles` for PDF. Reports show 8-hour shift.

**Cause.** `LocalDateTime.now()` captures Dublin wall clock without labeling Dublin. Reader invents UTC.

**Solution.**

```java
// Write path
Instant capturedAt = clock.instant();

// Or if you must use local civil (rare):
OffsetDateTime capturedAt = OffsetDateTime.now(clock); // includes offset
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `LocalDateTime.now()` for audit | Meaning changes if JVM zone changes |
| JSON without offset on API contracts | Clients interpret in local zone |
| Comparing two `LocalDateTime` from different zones | Lexicographic order ≠ chronological order |
| Hibernate maps `Instant` to `LocalDateTime` column | Silent truncation of zone |

---

## 4. Instant vs OffsetDateTime vs ZonedDateTime

All three can represent a point on the timeline (when used correctly). The difference is **what you keep** after conversion and **what survives serialization**.

### Instant

- Always UTC-based timeline.
- Best for: event ordering, metrics, `created_at` / `updated_at`, cross-region correlation.
- Loses: original zone, DST context, "local intent."

```java
Instant t = Instant.parse("2024-07-15T13:45:30Z");
```

### OffsetDateTime

- Civil datetime + fixed offset from UTC (`+02:00`).
- Best for: API payloads, JDBC `TIMESTAMP WITH TIME ZONE` where you want ISO-8601 with offset.
- Does **not** carry named zone rules — offset at capture time is frozen.

```java
OffsetDateTime odt = OffsetDateTime.parse("2024-07-15T15:45:30+02:00");
Instant same = odt.toInstant();
```

### ZonedDateTime

- Civil datetime + `ZoneId` (e.g. `Europe/Berlin`).
- Best for: user-facing scheduling, recurring rules, "next occurrence in this city."
- Heavier; equality includes zone. `withZoneSameInstant` vs `withZoneSameLocal` matter.

```java
ZonedDateTime zdt = ZonedDateTime.of(
    LocalDate.of(2024, 7, 15),
    LocalTime.of(15, 45),
    ZoneId.of("Europe/Berlin"));
```

### Comparison table

| Concern | Instant | OffsetDateTime | ZonedDateTime |
|---|---|---|---|
| Unambiguous timeline point | Yes | Yes | Yes |
| Preserves fixed offset in value | No (always Z) | Yes | Yes (via rules) |
| Survives DST rule changes for future recurrence | N/A | No | Yes (with zone id) |
| JSON ISO-8601 friendly | Yes (`Z`) | Yes | Yes (with offset) |
| JPA/Hibernate default ergonomics | Good (Hibernate 6) | Good | Awkward (use converter) |
| Sorting across systems | Preferred | Good | Good |

### Production scenario: recurring meeting after DST

**Problem.** Weekly standup stored as `Instant` series generated by `instant.plus(7, ChronoUnit.DAYS)`. After fall-back, meeting drifts to 9:00 instead of 10:00 local.

**Cause.** Adding 7×24 hours to an instant is not "same local time next week."

**Solution.**

```java
ZonedDateTime next = zoned.with(TemporalAdjusters.next(DayOfWeek.MONDAY))
    .with(LocalTime.of(10, 0));
// Or use a scheduler that understands zone (Quartz with timezone, cron in ZoneId)
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `Instant.plus(1, DAYS)` for business calendars | Skips/leaps across DST differently than civil day |
| Storing `ZonedDateTime` in DB as string | Zone id changes (deprecated zones) break parsing |
| Using `OffsetDateTime` for "user time zone" | Offset alone loses `America/New_York` post-rule updates |

---

## 5. ZoneId vs ZoneOffset, and tzdata

### ZoneOffset

A fixed difference from UTC: `+05:30`, `-08:00`. No DST, no political changes. Parsed from `+02:00` suffix in ISO-8601.

```java
ZoneOffset ist = ZoneOffset.ofHoursMinutes(5, 30);
OffsetDateTime odt = Instant.now().atOffset(ist);
```

### ZoneId

A named region rule set: `America/New_York`, `Europe/London`, `Asia/Kolkata`. Backed by **tzdata** (IANA Time Zone Database). Rules change when governments move DST.

```java
ZoneId ny = ZoneId.of("America/New_York");
ZonedDateTime zdt = instant.atZone(ny);
```

### Short IDs are dangerous

```java
ZoneId.of("EST");  // -05:00 fixed — NOT Eastern Time with DST
ZoneId.of("America/New_York"); // correct for US Eastern
```

`ZoneId.SHORT_IDS` maps `EST`, `PST`, etc. to **fixed** offsets. Production code should use IANA IDs.

### tzdata updates

The JVM loads tzdata from the JDK (and sometimes the OS). When Turkey or Morocco changes DST policy, you need:

1. JDK update with new tzdata, **or**
2. `java.time.zone.Version` check in diagnostics, **or**
3. External zone provider (rare; e.g. custom `ZoneRulesProvider`)

**Symptom after JDK upgrade without tzdata:** Correct instant, wrong local label for historical dates.

### Production scenario: "GMT" vs "Europe/London"

**Problem.** Logs show `GMT` offset in winter and `BST` in summer, but code used `ZoneOffset.of("+00:00")` for London reporting.

**Cause.** `Europe/London` has DST; fixed `+00:00` does not.

**Solution.** Always `ZoneId.of("Europe/London")` for UK civil time.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `ZoneId.systemDefault()` in server code | Docker image TZ=UTC vs developer laptop |
| Hard-coded `-05:00` for US East | Wrong for ~half the year |
| Parsing `Z` as `ZoneId` | `Z` is offset `+00:00`, not a region |
| Ignoring JDK tzdata version | Historical offsets wrong after rule change |

---

## 6. DST Pitfalls and Scheduling

DST is not a Java bug. It is governments moving clocks. Your job is to never assume 24 hours = 1 civil day in a zoned context.

### Gap (spring forward)

On spring-forward day, some local times **do not exist**. `2024-03-10T02:30` in `America/New_York` is invalid.

```java
LocalDateTime ldt = LocalDateTime.of(2024, 3, 10, 2, 30);
ZonedDateTime zdt = ldt.atZone(ZoneId.of("America/New_York"));
// Resolved using overlap/gap policy — default: shift forward to 3:30 EDT
```

### Overlap (fall back)

On fall-back day, some local times **occur twice**. `2024-11-03T01:30` happens in EDT and EST.

```java
// atZone uses overlap resolver — default: choose earlier offset (larger offset first in Java)
ZonedDateTime earlier = ldt.atZone(zone); // first occurrence
ZonedDateTime later = earlier.withLaterOffsetAtOverlap();
```

### Scheduling anti-patterns

| Anti-pattern | What breaks |
|---|---|
| `cron` in server local zone without documenting it | Jobs fire at wrong global time |
| `Duration.ofDays(1)` added to `ZonedDateTime` | Usually OK (adds exact 24h), but not "next calendar day" |
| `Period.ofDays(1)` added to `ZonedDateTime` | Adds calendar day — different across DST |
| Quartz `0 0 2 * * ?` in `America/New_York` | 2am job may not run or runs twice |
| Storing next run as `LocalDateTime` only | Ambiguous on overlap nights |

### Production scenario: missed billing run

**Problem.** Spring-forward night, 2:30am job never runs. Finance finds missing accruals.

**Cause.** Cron scheduled at non-existent local time.

**Solution.** Schedule in UTC for machine tasks, or use library-aware scheduling:

```java
// Machine / batch: prefer UTC
@Scheduled(cron = "0 30 7 * * *", zone = "UTC")

// User-local recurrence: store ZoneId + LocalTime, compute next with ZonedDateTime
ZonedDateTime nextRun = ZonedDateTime.now(zone)
    .with(TemporalAdjusters.next(DayOfWeek.MONDAY))
    .with(LocalTime.of(9, 0))
    .withEarlierOffsetAtOverlap(); // document policy
```

### Debugging scenario

**Observe.** "One hour off" bug only on two Sundays per year.

**Diagnose.** Log `ZoneId`, `ZoneOffset`, `ZonedDateTime` with `getZone().getRules().isDaylightSavings(instant)`.

**Fix.** Explicit zone in scheduler; never rely on `TimeZone.getDefault()`.

---

## 7. Duration vs Period

Both implement `TemporalAmount`, but they measure different things.

### Duration — exact time-based amount

- Stored as seconds + nanos.
- Attach to: `Instant`, `LocalTime`, `LocalDateTime` (time component), `OffsetDateTime`, `ZonedDateTime`.
- Good for: timeouts, SLA windows, `PT2H30M`, metrics.

```java
Duration d = Duration.ofHours(2).plusMinutes(30);
Instant deadline = start.plus(d);
```

### Period — calendar-based amount

- Stored as years, months, days.
- Attach to: `LocalDate`, `LocalDateTime`, `Period`-aware types.
- Good for: "bill monthly," "trial lasts 1 month," loan tenors.
- **Not** fixed seconds — `Period.ofMonths(1)` from Jan 31 → Feb 28/29.

```java
Period p = Period.ofMonths(1);
LocalDate nextBilling = billDate.plus(p);
```

### `ChronoUnit` bridge

```java
instant.plus(2, ChronoUnit.HOURS);     // Duration-like
localDate.plus(1, ChronoUnit.MONTHS);  // Period-like
```

Do not use `ChronoUnit.DAYS` on `Instant` expecting "business days."

### Production scenario: 30-day trial

**Problem.** `instant.plus(30, ChronoUnit.DAYS)` vs `localDate.plusDays(30)` give different user-visible end dates near DST.

**Cause.** ChronoUnit on instant adds exact 24h×30; local date adds civil days.

**Solution.** For user-facing trials tied to calendar: `LocalDate` + `Period`. For machine TTL: `Duration` + `Instant`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `Period.between` on `LocalDateTime` without converting to dates | Truncates time silently |
| `Duration.ofDays(365)` for "1 year" | Not a calendar year |
| Mixing `Period` with `Instant` | `UnsupportedTemporalTypeException` |

---

## 8. Arithmetic and TemporalAdjusters

### Basic arithmetic

```java
LocalDate d = LocalDate.of(2024, 1, 31);
LocalDate next = d.plusMonths(1); // 2024-02-29 — last valid day in Feb

ZonedDateTime z = ZonedDateTime.now(ZoneId.of("America/New_York"));
ZonedDateTime inTwoHours = z.plusHours(2); // timeline arithmetic
```

### `TemporalAdjusters` — domain language for dates

```java
import static java.time.temporal.TemporalAdjusters.*;

LocalDate lastDay = date.with(lastDayOfMonth());
LocalDate firstFriday = date.with(firstInMonth(DayOfWeek.FRIDAY));
LocalDate nextTuesday = date.with(next(DayOfWeek.TUESDAY));
```

### Custom adjuster

```java
TemporalAdjuster lastBusinessDay = temporal -> {
    LocalDate date = LocalDate.from(temporal);
    LocalDate d = date.with(lastDayOfMonth());
    while (d.getDayOfWeek() == SATURDAY || d.getDayOfWeek() == SUNDAY) {
        d = d.minusDays(1);
    }
    return d;
};
```

### `until` vs `between`

```java
Period age = Period.between(birthDate, today);
long days = ChronoUnit.DAYS.between(startInstant, endInstant);
```

`Period.between` is calendar-based (years/months/days). `ChronoUnit.DAYS.between` on instants is 24-hour chunks.

### Production scenario: "end of month" interest

**Problem.** Interest accrual uses `plusMonths(1)` on Jan 31 inconsistently.

**Solution.** Document rule: `with(lastDayOfMonth())` or `plusMonths(1).withDayOfMonth(Math.min(day, length))` — pick one and test Feb/Mar boundaries.

---

## 9. Formatting and Parsing: DateTimeFormatter Pitfalls

`DateTimeFormatter` is immutable and thread-safe (unlike `SimpleDateFormat`). Pitfalls move from concurrency to **pattern letters**.

### yyyy vs YYYY (week-based year)

| Pattern | Meaning |
|---|---|
| `yyyy` | Calendar year |
| `YY` / `YYYY` | Week-based year (ISO week date) |

```java
// Dec 31, 2024 is ISO week 1 of week-year 2025
LocalDate dec31 = LocalDate.of(2024, 12, 31);
DateTimeFormatter.ofPattern("YYYY-'W'ww").format(dec31); // 2025-W01 — NOT 2024
DateTimeFormatter.ofPattern("yyyy-MM-dd").format(dec31);  // 2024-12-31
```

**Production bug:** Log partitions keyed by `YYYY-MM` roll over wrong in late December.

### Other sharp edges

| Pattern | Gotcha |
|---|---|
| `D` | Day of year (1-365/366), not day of month |
| `d` | Day of month |
| `u` | Proleptic year (same as `yyyy` for AD) |
| `z` | Zone name (PST) — ambiguous |
| `VV` | Zone id (`America/Los_Angeles`) |
| `X`, `XX`, `XXX` | Offset without/colon/with colon |
| `parseBest` | Use when input may be `Instant` or `ZonedDateTime` |

### Lenient vs strict

```java
DateTimeFormatter f = DateTimeFormatter.ofPattern("uuuu-MM-dd")
    .withResolverStyle(ResolverStyle.STRICT);
// Feb 29 non-leap → DateTimeException
```

### Production scenario: parsed birthday off by one

**Problem.** `LocalDate.parse("2024-03-15", DateTimeFormatter.ofPattern("yyyy-MM-dd"))` works; US CSV uses `03/15/2024` with `MM/dd/yyyy` but some rows are `dd/MM/yyyy`.

**Solution.** Strict pattern per source; validate; consider `DateTimeFormatterBuilder` with optional sections; never guess locale.

```java
DateTimeFormatter US = DateTimeFormatter.ofPattern("MM/dd/yyyy")
    .withResolverStyle(ResolverStyle.STRICT)
    .withLocale(Locale.US);
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `YYYY` in filenames | December files land in next year folder |
| Formatting `Instant` without zone | Uses UTC only if you use `ISO_INSTANT` |
| `ofPattern` without locale | Month names wrong in Turkish locale |
| Parsing without `withZone` when pattern has no offset | Uses query zone default |

---

## 10. Clock Injection for Tests

`Instant.now()` and `LocalDateTime.now()` hide a static dependency on the system clock. Production code should use `Clock`.

### Pattern

```java
public class PaymentService {
    private final Clock clock;

    public PaymentService(Clock clock) {
        this.clock = clock;
    }

    public void capture() {
        Instant now = clock.instant();
        // ...
    }
}

// Production
PaymentService prod = new PaymentService(Clock.systemUTC());

// Test — fixed instant
Clock fixed = Clock.fixed(Instant.parse("2024-06-01T12:00:00Z"), ZoneOffset.UTC);
PaymentService test = new PaymentService(fixed);
```

### Spring

```java
@Bean
Clock clock() {
    return Clock.systemUTC();
}

// Test
@MockBean Clock clock;
when(clock.instant()).thenReturn(Instant.parse("2024-01-15T00:00:00Z"));
```

Or `@Clock` mock via `Clock.fixed` bean in `@TestConfiguration`.

### Tick and offset clocks

```java
Clock tick = Clock.tick(Clock.systemUTC(), Duration.ofSeconds(1)); // truncate sub-second
Clock shifted = Clock.offset(Clock.systemUTC(), Duration.ofHours(-24));
```

### Production scenario: flaky midnight test

**Problem.** CI fails at 00:00 UTC when `LocalDate.now()` rolls the date.

**Cause.** No injected clock; test assumes "today."

**Solution.** Freeze clock at `2024-06-15T23:59:59Z` and assert rollover explicitly.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `Instant.now()` in domain logic | Untestable time branches |
| Mocking `Instant.now()` with static mock | Fragile; breaks JDK internals |
| `Clock.systemDefaultZone()` in Docker | Tests pass locally, fail in CI (TZ=UTC) |

---

## 11. Precision and DB Round-Trip

### Nanoseconds vs milliseconds

`Instant` supports nanosecond precision. Many databases and JSON serializers truncate to microseconds or milliseconds.

```java
Instant a = Instant.parse("2024-01-01T00:00:00.123456789Z");
// Postgres TIMESTAMPTZ: often microsecond
// MySQL DATETIME(3): millisecond
// JSON default: often millisecond (Jackson WRITE_DATE_TIMESTAMPS_AS_NANOSECONDS)
```

**Symptom:** Ordering two events reverses after round-trip; equality checks fail in tests.

### Column type mapping (conceptual)

| DB type | Typical Java mapping | Notes |
|---|---|---|
| `TIMESTAMPTZ` (Postgres) | `Instant`, `OffsetDateTime` | Stores UTC; displays in session zone |
| `TIMESTAMP WITHOUT TIME ZONE` | **Avoid for instants** | Ambiguous |
| `DATETIME2` (SQL Server) | `LocalDateTime` or convention | Document UTC |
| `DATE` | `LocalDate` | |
| `TIME` | `LocalTime` | |

### Production scenario: duplicate key after retry

**Problem.** Idempotency key includes `Instant.now()` nanos; DB stores millis; retry within same millisecond collides differently than app expects.

**Solution.** Truncate consistently:

```java
Instant ts = clock.instant().truncatedTo(ChronoUnit.MILLIS);
```

Or use DB-generated `DEFAULT CURRENT_TIMESTAMP`.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `TIMESTAMP WITHOUT TIME ZONE` + `Instant` | Zone lost; double conversion |
| Comparing DB string to `Instant.toString()` | Format mismatch |
| Assuming nanos survive ORM round-trip | Flaky ordering |

---

## 12. Persistence: JDBC, JPA, and Hibernate 6

### JDBC 4.2+

```java
PreparedStatement ps = conn.prepareStatement(
    "INSERT INTO events (id, occurred_at) VALUES (?, ?)");
ps.setObject(1, id);
ps.setObject(2, instant, Types.TIMESTAMP_WITH_TIMEZONE);
```

```java
Instant read = rs.getObject("occurred_at", Instant.class);
LocalDate date = rs.getObject("birth_date", LocalDate.class);
```

### JPA attribute converters

```java
@Converter(autoApply = true)
public class InstantUtcConverter implements AttributeConverter<Instant, Timestamp> {
    @Override
    public Timestamp convertToDatabaseColumn(Instant attribute) {
        return attribute == null ? null : Timestamp.from(attribute);
    }
    @Override
    public Instant convertToEntityAttribute(Timestamp dbData) {
        return dbData == null ? null : dbData.toInstant();
    }
}
```

Prefer `Instant` + `TIMESTAMPTZ` over converter to `Timestamp` when driver supports it.

### Hibernate 6 defaults

Hibernate 6 maps JSR-310 types natively. Common mappings:

| Java type | Hibernate type | DDL hint |
|---|---|---|
| `Instant` | `InstantType` | `timestamp with time zone` |
| `LocalDate` | `LocalDateType` | `date` |
| `LocalDateTime` | `LocalDateTimeType` | `timestamp` (no zone) |
| `ZonedDateTime` | `ZonedDateTimeType` | stores instant + zone id |
| `OffsetDateTime` | `OffsetDateTimeType` | `timestamp with time zone` |

### Production scenario: Hibernate shifts time on read

**Problem.** Entity with `LocalDateTime createdAt`; DB has `2024-07-15 10:00:00`; JVM in UTC+2; some drivers apply zone on read → `08:00` displayed.

**Cause.** `LocalDateTime` + wrong column type + driver timezone conversion.

**Solution.** `Instant` + `timestamptz`, or `LocalDateTime` with `timestamp without time zone` and **no** driver zone conversion (`connectionTimeZone=UTC` in MySQL).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@Temporal(DATE)` on `java.util.Date` mixed with `Instant` | Legacy island |
| `hibernate.jdbc.time_zone` unset with MySQL | Server/driver drift |
| `ZonedDateTime` everywhere | Zone id string storage bloat |
| Liquibase `datetime` without timezone | Portable but ambiguous |

---

## 13. JSON: Jackson JavaTimeModule

### Registration

```java
ObjectMapper mapper = JsonMapper.builder()
    .addModule(new JavaTimeModule())
    .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
    .build();
```

Spring Boot auto-configures this when `jackson-datatype-jsr310` is on the classpath.

### Serialization shapes

```java
// Instant → "2024-07-15T13:45:30Z"
// LocalDate → "2024-07-15"
// LocalDateTime → "2024-07-15T13:45:30"  (no offset — dangerous for APIs)
// ZonedDateTime → "2024-07-15T15:45:30+02:00[Europe/Berlin]" or with offset only
```

### Field annotations

```java
@JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd")
private LocalDate birthDate;

@JsonFormat(shape = JsonFormat.Shape.STRING)
private Instant createdAt;
```

### Production scenario: frontend parses as Date

**Problem.** API returns epoch millis for `Instant`; JS `new Date(ms)` shows wrong local day.

**Solution.** ISO-8601 strings + `Instant`/`OffsetDateTime`; document contract. Never mix millis and strings across API versions.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No `JavaTimeModule` | `JsonMappingException` on `LocalDate` |
| `WRITE_DATES_AS_TIMESTAMPS` enabled | JS timezone bugs |
| `LocalDateTime` in public API | Ambiguous for global clients |
| Deserializing offset-less string to `Instant` | Uses UTC assumption — document it |

---

## 14. Legacy Interop

### java.util.Date ↔ java.time

```java
Instant instant = date.toInstant();
Date legacy = Date.from(instant);

// Calendar → ZonedDateTime
ZonedDateTime zdt = calendar.toInstant().atZone(calendar.getTimeZone().toZoneId());
```

### java.sql types

```java
Timestamp ts = Timestamp.from(instant);
Instant back = ts.toInstant();

// java.sql.Date is DATE-only — do not use for instants
LocalDate ld = sqlDate.toLocalDate();
```

### Migration strategy

1. **Boundary rule:** Convert at the edge (DAO, adapter). Domain uses `java.time` only.
2. **Column audit:** List every datetime column and assign `Instant` / `LocalDate` / `LocalDateTime`.
3. **API version:** v2 returns ISO-8601; v1 keeps millis until deprecated.
4. **Kill `SimpleDateFormat`:** Replace with `DateTimeFormatter`; grep CI gate.

### Production scenario: library still returns Date

**Problem.** AWS SDK v1 `Date` in metadata; your code uses `Instant`.

**Solution.**

```java
Instant uploaded = sdkDate.toInstant();
```

Watch null and pre-1970 dates (some legacy APIs use seconds).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `new Date(long)` with seconds not millis | 1970-ish timestamps |
| `java.sql.Date.valueOf(localDate)` mixed with `Timestamp` | Time component truncated |
| Partial migration in one service | Serialization schizophrenia |

---

## 15. Business Calendars

`java.time` provides ISO chronology by default. Business rules often need **non-ISO** calendars: US Federal holidays, TARGET2 settlement, fiscal 4-4-5.

### ISO vs business week

```java
LocalDate d = LocalDate.of(2024, 12, 31);
int weekYear = d.get(IsoFields.WEEK_BASED_YEAR); // may differ from getYear()
```

### Holiday calendars (typical approach)

JDK has no built-in holiday database. Options:

1. **Third-party:** `jollyday`, `finbif` holiday APIs, internal HR calendar table.
2. **Store holidays as `LocalDate` set** in DB; refresh annually.
3. **TemporalAdjuster** backed by holiday service.

```java
public TemporalAdjuster nextBusinessDay(HolidayCalendar holidays) {
    return temporal -> {
        LocalDate d = LocalDate.from(temporal);
        do {
            d = d.plusDays(1);
        } while (d.getDayOfWeek() == SATURDAY
                || d.getDayOfWeek() == SUNDAY
                || holidays.isHoliday(d));
        return d;
    };
}
```

### Fiscal periods

Model explicitly:

```java
public record FiscalPeriod(int fiscalYear, int period) {}
// Compute with rules table — not Period.ofMonths alone
```

### Production scenario: SLA "next business day"

**Problem.** `plusDays(1)` on Friday before a Monday holiday misses settlement.

**Solution.** Business-day adjuster with holiday feed; test NYSE calendar yearly.

---

## 16. Performance: Wall Clock vs nanoTime

### Do not use datetime for elapsed time

| API | Measures | Use |
|---|---|---|
| `Instant.now()` / `Clock` | Wall clock (epoch) | Timestamps, scheduling |
| `System.nanoTime()` | Monotonic elapsed | Benchmarks, timeouts, latency |
| `System.currentTimeMillis()` | Wall clock millis | Legacy; prefer `Instant` |

Wall clock **jumps** (NTP leap, manual adjustment). `nanoTime()` does not.

```java
long start = System.nanoTime();
// work
long elapsedNanos = System.nanoTime() - start;
Duration elapsed = Duration.ofNanos(elapsedNanos);
```

### Allocation and hot paths

- `ZonedDateTime.now()` allocates more than `Instant.now(clock)`.
- `DateTimeFormatter` is immutable — reuse static instances.
- Avoid `ZoneId.systemDefault()` per call in tight loops — cache in a `static final`.

### Production scenario: slow request logging

**Problem.** Logging pipeline calls `ZonedDateTime.now(ZoneId.of("America/New_York"))` per span.

**Solution.** Log `Instant` in UTC; convert at UI. One zone lookup per request max.

---

## 17. Production Debugging Playbook

When datetime bugs are "random," it is usually **zone default**, **column type**, or **formatter pattern**.

1. **Classify the symptom.** Off by whole hours → offset/DST. Off by one day → UTC vs local date boundary. Off by seconds → millis/nanos truncation. Only in December → `YYYY` bug.

2. **Log the triple** (staging only):

   ```java
   log.debug("event instant={} utc={} systemDefault={} userZone={}",
       instant,
       instant.atOffset(ZoneOffset.UTC),
       instant.atZone(ZoneId.systemDefault()),
       instant.atZone(userZoneId));
   ```

3. **Check JVM and container TZ:**

   ```bash
   java -XshowSettings:properties -version 2>&1 | grep user.timezone
   echo $TZ
   ```

4. **Check DB session timezone:**

   ```sql
   -- Postgres
   SHOW timezone;
   SELECT occurred_at, occurred_at AT TIME ZONE 'UTC' FROM events LIMIT 5;
   ```

5. **Inspect Hibernate SQL** with bind parameters; compare raw JDBC read vs entity field.

6. **Decode API payload** — is there `Z` or offset? Is it `LocalDateTime` without offset?

7. **tzdata version:**

   ```java
   log.info("tzdata {}", ZoneRulesProvider.getVersions("UTC"));
   ```

8. **Replay with fixed `Clock`** in a unit test using production inputs.

Turn off verbose logging of PII birthdates in prod.

---

## 18. Quick Decision Matrix

| Situation | Type / action |
|---|---|
| Audit `created_at` / `updated_at` | `Instant` + UTC storage (`TIMESTAMPTZ` or documented UTC) |
| User's birthday | `LocalDate` |
| "Expires in 30 days" (calendar) | `LocalDate` + `Period` |
| "Expires in 72 hours" (exact) | `Instant` + `Duration` |
| API event timestamp | `Instant` or `OffsetDateTime` as ISO-8601 string |
| Recurring meeting in a city | `LocalTime` + `ZoneId` + scheduler with zone |
| JDBC new code | `setObject(instant, TIMESTAMP_WITH_TIMEZONE)` |
| Legacy `Date` at boundary | `date.toInstant()` once, then only `java.time` |
| Filename month partition | `yyyy-MM`, never `YYYY-MM` |
| Benchmark / latency | `System.nanoTime()` |
| Holiday-aware business day | `LocalDate` + holiday calendar adjuster |
| Docker / K8s JVM | Set `TZ=UTC` or `-Duser.timezone=UTC`; inject `Clock` |
| Hibernate 6 greenfield | Native `Instant` / `LocalDate` mappings, no `@Temporal` |
| JSON public API | `JavaTimeModule`, ISO strings, no numeric epochs |
| DST-sensitive cron | UTC machine cron **or** zone-aware scheduler with tests on Mar/Nov Sundays |

---

*The timeline is universal; civil time is local politics. Store instants, display with explicit zones, test March and November, and never use `YYYY` in a filename.*


---

## Practice Questions & Answers

<details class="qa-item">
<summary>Q1. What is the difference between Instant and LocalDateTime?</summary>

`Instant` is a point on the UTC timeline (epoch seconds + nanos). `LocalDateTime` is a civil date-time **without** zone context — wall-clock numbers that are not anchored to the timeline until you supply a `ZoneId` or `ZoneOffset`.

```java
Instant i = Instant.parse("2024-07-15T12:00:00Z");
LocalDateTime ldt = LocalDateTime.of(2024, 7, 15, 12, 0);
// ldt is NOT "noon UTC" until you call ldt.atZone(ZoneOffset.UTC).toInstant()
```

Use `Instant` for events; use `LocalDateTime` only when the domain intentionally omits zone (e.g. "daily cutoff at 17:00" stored with a separate `ZoneId`).

</details>

<details class="qa-item">
<summary>Q2. How do you convert LocalDateTime to Instant correctly?</summary>

You must supply the zone or offset that defines what the local numbers meant:

```java
ZoneId zone = ZoneId.of("America/Chicago");
LocalDateTime ldt = LocalDateTime.of(2024, 3, 10, 2, 30); // gap day — resolved by rules
Instant instant = ldt.atZone(zone).toInstant();
```

Never use `toInstant(ZoneOffset.UTC)` unless the civil time was **defined as UTC**.

</details>

<details class="qa-item">
<summary>Q3. Why is LocalDateTime a bad choice for created_at?</summary>

`created_at` is an event on the universal timeline. `LocalDateTime` does not record which zone the server used when `now()` was called, cannot be compared across regions reliably, and encourages DB columns without time zone. Use `Instant` (or `OffsetDateTime` with explicit offset) and `TIMESTAMPTZ`.

</details>

<details class="qa-item">
<summary>Q4. yyyy vs YYYY — what breaks in production?</summary>

`yyyy` is the calendar year. `YYYY` is the **week-based year** (ISO-8601). Late December dates can format with `YYYY` as next year:

```java
LocalDate d = LocalDate.of(2024, 12, 31);
DateTimeFormatter.ofPattern("YYYY").format(d); // "2025"
DateTimeFormatter.ofPattern("yyyy").format(d); // "2024"
```

Use `yyyy` for partitions, billing years, and audit filenames.

</details>

<details class="qa-item">
<summary>Q5. Duration vs Period — when to use which?</summary>

`Duration` is exact time (seconds/nanos) — timeouts, SLAs, `PT2H`. `Period` is calendar-based (years/months/days) — billing cycles, `plusMonths(1)` on `LocalDate`.

```java
Duration.ofHours(24);        // always 24 hours
Period.ofDays(1);            // one calendar day on LocalDate
```

Do not add `Period` to `Instant`.

</details>

<details class="qa-item">
<summary>Q6. How does DST spring-forward affect atZone?</summary>

On gap days, some local times do not exist. `localDateTime.atZone(zone)` resolves using the zone rules (typically shifting forward):

```java
// America/New_York spring forward 2024-03-10 02:00 → 03:00
LocalDateTime ldt = LocalDateTime.of(2024, 3, 10, 2, 30);
ZonedDateTime zdt = ldt.atZone(ZoneId.of("America/New_York"));
// Not 02:30 — adjusted to valid time per rules
```

Document resolver policy for scheduling products.

</details>

<details class="qa-item">
<summary>Q7. How does DST fall-back create ambiguous local times?</summary>

When clocks repeat an hour, the same local clock time occurs twice with different offsets. `atZone` picks one occurrence by default; use `withEarlierOffsetAtOverlap()` / `withLaterOffsetAtOverlap()` when you need a specific one.

```java
LocalDateTime ldt = LocalDateTime.of(2024, 11, 3, 1, 30);
ZonedDateTime first = ldt.atZone(ZoneId.of("America/New_York"));
ZonedDateTime second = first.withLaterOffsetAtOverlap();
```

</details>

<details class="qa-item">
<summary>Q8. ZoneId vs ZoneOffset — EST trap</summary>

`ZoneOffset` is a fixed offset. `ZoneId` of `America/New_York` includes DST rules. `ZoneId.of("EST")` maps to fixed `-05:00` — **not** US Eastern with DST.

```java
ZoneId.of("America/New_York"); // correct for US Eastern civil time
ZoneId.of("EST");              // fixed offset — wrong half the year
```

</details>

<details class="qa-item">
<summary>Q9. How to inject Clock for unit tests?</summary>

```java
Clock fixed = Clock.fixed(
    Instant.parse("2024-06-15T12:00:00Z"),
    ZoneOffset.UTC);
Instant now = Instant.now(fixed);
LocalDate today = LocalDate.now(fixed);
```

In Spring, expose a `@Bean Clock` and replace with `Clock.fixed` in `@TestConfiguration`.

</details>

<details class="qa-item">
<summary>Q10. JDBC — set and read Instant</summary>

```java
ps.setObject(1, Instant.now(), Types.TIMESTAMP_WITH_TIMEZONE);
// ...
Instant i = rs.getObject("occurred_at", Instant.class);
```

Requires JDBC 4.2+ driver and appropriate column type (`TIMESTAMPTZ` on Postgres).

</details>

<details class="qa-item">
<summary>Q11. Hibernate 6 — map Instant entity field</summary>

```java
@Entity
class Event {
    @Column(name = "occurred_at", columnDefinition = "timestamptz")
    private Instant occurredAt;
}
```

Hibernate 6 maps `Instant` natively. Set `hibernate.jdbc.time_zone=UTC` when using MySQL to avoid driver surprises.

</details>

<details class="qa-item">
<summary>Q12. Jackson — serialize Instant as ISO-8601</summary>

```java
ObjectMapper mapper = JsonMapper.builder()
    .addModule(new JavaTimeModule())
    .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
    .build();

String json = mapper.writeValueAsString(Instant.parse("2024-07-15T12:00:00Z"));
// "2024-07-15T12:00:00Z"
```

</details>

<details class="qa-item">
<summary>Q13. Convert java.util.Date to Instant</summary>

```java
Date legacy = ...;
Instant instant = legacy.toInstant();
Date back = Date.from(instant);
```

Perform conversion once at system boundaries; keep internal code on `java.time`.

</details>

<details class="qa-item">
<summary>Q14. Parse ISO-8601 with offset</summary>

```java
OffsetDateTime odt = OffsetDateTime.parse("2024-07-15T15:30:00+02:00");
Instant instant = odt.toInstant();

ZonedDateTime zdt = ZonedDateTime.parse("2024-07-15T15:30:00+02:00[Europe/Paris]");
```

Prefer parsers that include offset or `Z` for API inputs.

</details>

<details class="qa-item">
<summary>Q15. TemporalAdjusters — last day of month</summary>

```java
import static java.time.temporal.TemporalAdjusters.*;

LocalDate last = LocalDate.of(2024, 2, 15).with(lastDayOfMonth()); // 2024-02-29
LocalDate nextFriday = today.with(next(DayOfWeek.FRIDAY));
```

</details>

<details class="qa-item">
<summary>Q16. Period.between vs ChronoUnit.DAYS.between</summary>

```java
LocalDate a = LocalDate.of(2024, 1, 1);
LocalDate b = LocalDate.of(2024, 1, 10);
Period p = Period.between(a, b);           // 0 years, 0 months, 9 days
long days = ChronoUnit.DAYS.between(a, b); // 9
```

On `Instant`, use `ChronoUnit` / `Duration`, not `Period.between`.

</details>

<details class="qa-item">
<summary>Q17. Why not use System.currentTimeMillis() for new code?</summary>

It returns wall-clock millis since epoch — same underlying idea as `Instant`, but without type safety, nanosecond precision, or rich API. Prefer `Instant.now(clock)` with injection. Use `System.nanoTime()` only for **elapsed** time, not timestamps.

</details>

<details class="qa-item">
<summary>Q18. Truncate Instant for DB millis precision</summary>

```java
Instant truncated = instant.truncatedTo(ChronoUnit.MILLIS);
```

Use when DB column is `datetime(3)` and nanos cause flaky equality after round-trip.

</details>

<details class="qa-item">
<summary>Q19. Format Instant for user in a specific zone</summary>

```java
ZoneId userZone = ZoneId.of("Asia/Tokyo");
String display = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z")
    .withZone(userZone)
    .format(instant);
```

Store `Instant`; format at display boundary with explicit zone.

</details>

<details class="qa-item">
<summary>Q20. LocalDate for birthday — why not Instant?</summary>

Birthdays are calendar dates without a meaningful global instant (midnight local varies). Store `LocalDate`; when you need an instant for reminders, combine with user's `ZoneId` at notification time.

```java
LocalDate dob = LocalDate.of(1990, 5, 20);
```

</details>

<details class="qa-item">
<summary>Q21. Compare instants from different systems</summary>

Normalize to `Instant` (UTC timeline) before compare:

```java
boolean after = instantA.isAfter(instantB);
```

Do not compare formatted strings or `LocalDateTime` values from different zones lexicographically expecting timeline order.

</details>

<details class="qa-item">
<summary>Q22. Scheduler — cron in UTC vs user zone</summary>

Machine batch jobs: `zone = "UTC"` on `@Scheduled` or Quartz `TimeZone.getTimeZone("UTC")`. User-facing "9am local every Monday": store `ZoneId` + `LocalTime`, compute next `ZonedDateTime`, test DST weekends.

</details>

<details class="qa-item">
<summary>Q23. ResolverStyle.STRICT parsing</summary>

```java
DateTimeFormatter f = DateTimeFormatter.ofPattern("uuuu-MM-dd")
    .withResolverStyle(ResolverStyle.STRICT);
LocalDate.parse("2023-02-29", f); // DateTimeException
```

Prevents silent rollover of invalid civil dates.

</details>

<details class="qa-item">
<summary>Q24. OffsetDateTime vs ZonedDateTime in APIs</summary>

`OffsetDateTime` freezes the offset at serialization — good for REST timestamps. `ZonedDateTime` carries `ZoneId` — better for recurrence and DST-aware UI. For public APIs, `Instant` or `OffsetDateTime` ISO strings are simplest.

</details>

<details class="qa-item">
<summary>Q25. java.sql.Timestamp vs Instant</summary>

`Timestamp` is a legacy JDBC type with nanos but confusing `toString()` (includes fake nanos). Prefer `rs.getObject(col, Instant.class)`. If stuck with `Timestamp`, use `timestamp.toInstant()` only at the boundary.

</details>

<details class="qa-item">
<summary>Q26. plusMonths on Jan 31</summary>

```java
LocalDate d = LocalDate.of(2024, 1, 31).plusMonths(1); // 2024-02-29 (last day of Feb)
LocalDate d2 = LocalDate.of(2024, 1, 30).plusMonths(1); // 2024-02-29
```

Month arithmetic adjusts to last valid day — document for billing rules.

</details>

<details class="qa-item">
<summary>Q27. Is ZonedDateTime equals stable across zones?</summary>

Two `ZonedDateTime` instances representing the same instant but different zones are **not** equal:

```java
ZonedDateTime ny = instant.atZone(ZoneId.of("America/New_York"));
ZonedDateTime la = instant.atZone(ZoneId.of("America/Los_Angeles"));
ny.equals(la); // false — compare toInstant() instead
```

</details>

<details class="qa-item">
<summary>Q28. Business days — skip weekends</summary>

```java
TemporalAdjuster nextBusinessDay = t -> {
    LocalDate d = LocalDate.from(t).plusDays(1);
    while (d.getDayOfWeek() == SATURDAY || d.getDayOfWeek() == SUNDAY) {
        d = d.plusDays(1);
    }
    return d;
};
LocalDate next = today.with(nextBusinessDay);
```

Add holiday set for production settlement logic.

</details>

<details class="qa-item">
<summary>Q29. Docker JVM timezone best practice</summary>

Set explicit zone for servers: `ENV TZ=UTC` or `-Duser.timezone=UTC`. Do not rely on developer laptop defaults. Still inject `Clock` — system default should be a safety net, not your business logic.

</details>

<details class="qa-item">
<summary>Q30. Guess the output — week-year formatting</summary>

```java
LocalDate d = LocalDate.of(2024, 12, 31);
String a = DateTimeFormatter.ofPattern("yyyy-MM-dd").format(d);
String b = DateTimeFormatter.ofPattern("YYYY-'W'ww-e").format(d);
// a = "2024-12-31"
// b involves week-year 2025 — ISO week 1 of 2025 starts before calendar year ends
```

Always use `yyyy` for calendar-year reporting.

</details>
