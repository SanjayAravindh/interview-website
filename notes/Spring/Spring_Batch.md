# Spring Batch Mastery — Senior Production Reference

Spring Boot 3.x / Spring Batch 5.x. This is not a getting-started guide. It is the map of what actually breaks in production after years of shipping nightly ETL, payment reconciliation, migration jobs, and file-ingest pipelines on JVM backends.

---

## Table of Contents

1. [Mental Model: Job, Step, Execution, ExecutionContext](#1-mental-model-job-step-execution-executioncontext)
2. [JobRepository and BATCH_* Metadata Tables](#2-jobrepository-and-batch_-metadata-tables)
3. [Item-Oriented Processing: Reader, Processor, Writer](#3-item-oriented-processing-reader-processor-writer)
4. [Chunk-Oriented Steps: Size, Skip, Retry](#4-chunk-oriented-steps-size-skip-retry)
5. [Tasklet Steps vs Chunk Steps](#5-tasklet-steps-vs-chunk-steps)
6. [Job Parameters, Incrementer, Run ID](#6-job-parameters-incrementer-run-id)
7. [Partitioning](#7-partitioning)
8. [Remote Chunking](#8-remote-chunking)
9. [Multi-Threaded Steps and Synchronized Readers](#9-multi-threaded-steps-and-synchronized-readers)
10. [Job Restart, Recovery, NO_RESTART](#10-job-restart-recovery-no_restart)
11. [Listeners: Job, Step, Item, Chunk](#11-listeners-job-step-item-chunk)
12. [Scheduling Spring Batch Jobs](#12-scheduling-spring-batch-jobs)
13. [Transaction Boundaries in Batch](#13-transaction-boundaries-in-batch)
14. [Idempotency and Duplicate Processing](#14-idempotency-and-duplicate-processing)
15. [Large Files, Streaming, Flat Files](#15-large-files-streaming-flat-files)
16. [JDBC vs JPA Readers/Writers Pitfalls](#16-jdbc-vs-jpa-readerswriters-pitfalls)
17. [Spring Batch Integration](#17-spring-batch-integration)
18. [Monitoring: Micrometer, Actuator, Metrics](#18-monitoring-micrometer-actuator-metrics)
19. [Cloud: Kubernetes CronJob and Scaling Pitfalls](#19-cloud-kubernetes-cronjob-and-scaling-pitfalls)
20. [Testing Batch Jobs](#20-testing-batch-jobs)
21. [Production Debugging Playbook](#21-production-debugging-playbook)
22. [Quick Decision Matrix](#22-quick-decision-matrix)

---

## 1. Mental Model: Job, Step, Execution, ExecutionContext

Spring Batch is not "a cron that loops over a list." It is a **stateful job orchestration framework** built around a `JobRepository` that persists execution metadata so jobs can be restarted, audited, and coordinated across JVMs. The unit of work you configure is a `Job`; a `Job` contains ordered `Step`s; each `Step` runs as a `StepExecution` inside a `JobExecution`.

```
Job (configuration blueprint)
  └─ Step 1 (chunk or tasklet)
  └─ Step 2
  └─ Step 3

JobExecution (one run of the Job)
  ├─ JobParameters (input to this run: file path, date, run.id)
  ├─ ExecutionContext (job-level persistent key/value bag)
  └─ StepExecution(s)
       ├─ readCount, writeCount, skipCount, commitCount
       ├─ status (STARTING, STARTED, COMPLETED, FAILED, ...)
       └─ ExecutionContext (step-level persistent key/value bag)
```

Four objects you must keep distinct:

| Object | Question it answers | Persisted? |
|---|---|---|
| `Job` / `Step` | What is the pipeline definition? | No — Spring beans |
| `JobExecution` / `StepExecution` | What happened on run #N? | Yes — `BATCH_JOB_EXECUTION`, `BATCH_STEP_EXECUTION` |
| `JobParameters` | What inputs did this run receive? | Yes — `BATCH_JOB_EXECUTION_PARAMS` |
| `ExecutionContext` | What checkpoint state must restart use? | Yes — `BATCH_JOB_EXECUTION_CONTEXT`, `BATCH_STEP_EXECUTION_CONTEXT` |

A **failed** job is not necessarily a bug. Spring Batch marks `FAILED` when an exception propagates out of a step (or when you set failure explicitly). A **stopped** job (`STOPPED`) is an operator interrupt. A **completed** job with `exitStatus=COMPLETED` may still have skipped records — check `skipCount`, not just exit code.

`ExecutionContext` is a `Map<String,Object>` with serialization rules. Only types that `ExecutionContext` can serialize (primitives, strings, dates, etc.) survive restart. Putting a non-serializable object (open JDBC connection, custom POJO without converter) into context **silently breaks restart** or fails on commit to `BATCH_STEP_EXECUTION_CONTEXT`.

### Internal working

1. `JobLauncher.run(job, jobParameters)` creates a `JobExecution` via `JobRepository.createJobExecution()`.
2. `SimpleJob` iterates steps. For each step, `JobRepository.createStepExecution()` attaches a `StepExecution` to the parent `JobExecution`.
3. Chunk steps delegate to `ChunkOrientedTasklet`, which loops: read → process → buffer until chunk size → write in one transaction → update `StepExecution` counts and `ExecutionContext` (reader checkpoint).
4. On failure, the **current chunk's transaction rolls back** (typical config). Previously committed chunks remain. Restart reads `ExecutionContext` to resume the reader from the last committed checkpoint.
5. `JobRepository` updates rows on every chunk commit (configurable with `BatchConfigurer` / repository isolation levels). High commit frequency = high metadata DB write load.

Boot auto-config (`BatchAutoConfiguration`) registers `JobRepository`, `JobLauncher`, `JobExplorer`, and optionally `JobOperator` when `spring.batch.job.enabled` is true (default). `@EnableBatchProcessing` is still valid but Boot 3 often suffices with `spring-boot-starter-batch` + datasource.

### Production scenario: job "completes" but re-processes half the file on restart

**Problem.** Nightly ingest of 10M rows. Job failed at 6M due to downstream timeout. Operator restarts. Logs show reader starting from row 0. Duplicate key violations or doubled business events.

**Cause.** Custom `ItemReader` stores cursor in a **local field** but never calls `ExecutionContext.put("cursor", cursor)` in `update(ExecutionContext)` or reads it in `open(ExecutionContext)`. Spring Batch has no magic — restart only knows what you persisted.

**Solution.**

```java
public class AccountFlatFileItemReader implements ItemStreamReader<Account> {

    private final FlatFileItemReader<Account> delegate;
    private long lineNumber = 0;

  public AccountFlatFileItemReader(Resource resource) {
    this.delegate = new FlatFileItemReaderBuilder<Account>()
        .name("accountReader")
        .resource(resource)
        .linesToSkip(1)
        .fieldSetMapper(new BeanWrapperFieldSetMapper<>() {{
          setTargetType(Account.class);
        }})
        .delimited().names("id", "name", "balance")
        .build();
  }

  @Override
  public void open(ExecutionContext ctx) throws ItemStreamException {
    if (ctx.containsKey("lineNumber")) {
      lineNumber = ctx.getLong("lineNumber");
      // FlatFileItemReader uses ExecutionContext internally when registered as ItemStream
    }
    if (delegate instanceof ItemStream stream) {
      stream.open(ctx);
    }
  }

  @Override
  public Account read() throws Exception {
    Account item = delegate.read();
    if (item != null) {
      lineNumber++;
    }
    return item;
  }

  @Override
  public void update(ExecutionContext ctx) throws ItemStreamException {
    ctx.putLong("lineNumber", lineNumber);
    if (delegate instanceof ItemStream stream) {
      stream.update(ctx);
    }
  }

  @Override
  public void close() throws ItemStreamException {
    if (delegate instanceof ItemStream stream) {
      stream.close();
    }
  }
}
```

Prefer built-in `FlatFileItemReader` / `JdbcPagingItemReader` — they implement `ItemStream` correctly. Custom readers are where restart bugs live.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Reader not registered as `ItemStream` on step | Restart from beginning; `ExecutionContext` empty for reader |
| Storing non-serializable state in `ExecutionContext` | `ExecutionContextSerializationException` on commit |
| Confusing `JobInstance` with `JobExecution` | "Same job ran twice" — actually two executions of same instance (same identifying parameters) |
| Expecting `@StepScope` bean to survive across steps | Bean recreated per step execution; state lost if stored only in bean field without context |
| Running chunk job without `JobRepository` (in-memory repo in tests ported to prod) | No restart, no audit, lost on JVM crash |

### Debugging scenario

**Observe.** `BATCH_STEP_EXECUTION.READ_COUNT` shows 5M but business table only has 2.5M rows. Job `COMPLETED`.

**Diagnose.** `filterCount` / `writeCount` vs `readCount`. Processor returning `null` filters items (not counted as write). Skips counted separately. Or writer uses `MERGE` that updates instead of insert — read count still increments.

```sql
SELECT STEP_NAME, READ_COUNT, WRITE_COUNT, FILTER_COUNT, SKIP_COUNT, COMMIT_COUNT, STATUS
FROM BATCH_STEP_EXECUTION
WHERE JOB_EXECUTION_ID = :id;
```

**Fix.** Align metrics with business SLA: track processed vs written in a `StepExecutionListener` or Micrometer counter. Do not use `readCount` as "rows delivered."

---

## 2. JobRepository and BATCH_* Metadata Tables

### Core concept

`JobRepository` is the persistence layer for all batch metadata. It is **not** your business database abstraction — it is the audit and checkpoint store. Production systems almost always dedicate the metadata schema (same DB or separate) and tune it for write-heavy small-row updates.

Spring Batch 5 / Boot 3 default schema prefix: `BATCH_`. Six core tables (plus sequences on some DBs):

| Table | Holds |
|---|---|
| `BATCH_JOB_INSTANCE` | Logical job identity (job name + identifying parameters hash) |
| `BATCH_JOB_EXECUTION` | Each run: status, start/end times, exit code |
| `BATCH_JOB_EXECUTION_PARAMS` | Parameter key/value/type for that execution |
| `BATCH_JOB_EXECUTION_CONTEXT` | Serialized job-level `ExecutionContext` |
| `BATCH_STEP_EXECUTION` | Per-step metrics and status for a job execution |
| `BATCH_STEP_EXECUTION_CONTEXT` | Serialized step-level `ExecutionContext` |

`JobInstance` = "the `importAccountsJob` for `fileDate=2026-08-31`". `JobExecution` = "the third attempt to run that instance tonight."

Identifying vs non-identifying parameters matter: parameters marked identifying (default for most types) participate in `JobInstance` identity. Two runs with same identifying params cannot both be `STARTED`/`COMPLETED` if you use `JobParametersIncrementer` correctly — but **re-running with identical identifying params** may throw `JobInstanceAlreadyCompleteException` unless you increment `run.id` or use `JobOperator.startNextInstance()`.

### Internal working

`JobRepository` implementation: `SimpleJobRepository` backed by `JobExecutionDao`, `StepExecutionDao`, `ExecutionContextDao` ( JDBC ). Each chunk commit typically:

1. Updates `BATCH_STEP_EXECUTION` counts and `VERSION` (optimistic locking).
2. Merges `ExecutionContext` into `BATCH_STEP_EXECUTION_CONTEXT`.
3. On step completion, updates step status and job execution status.

`VERSION` column: concurrent updates to same execution throw `OptimisticLockingFailureException`. You see this when **two JVMs run the same job execution** (Kubernetes double pod, manual restart during running job, partitioned workers incorrectly sharing one `StepExecution`).

Schema initialization: `spring.batch.jdbc.initialize-schema=always|embedded|never`. Production: `never` — apply DDL via Flyway/Liquibase. Embedded default only for in-memory DBs.

Isolation: `ISOLATION_READ_COMMITTED` default for `JobRepository` creation. Some teams raise isolation for metadata commits under heavy partition load — measure lock contention first.

### Production scenario: metadata DB becomes the bottleneck

**Problem.** Partitioned job with 64 workers, chunk size 500, 200 commits/sec to metadata tables. Oracle `BATCH_STEP_EXECUTION` row lock waits. Job wall time dominated by metadata, not business I/O.

**Cause.** Every chunk commit updates metadata. 64 partitions × (rows/sec / 500) = huge update rate on `BATCH_STEP_EXECUTION` and context tables.

**Solution.**

```java
@Bean
public Step masterStep(JobRepository jobRepository, PlatformTransactionManager tx) {
  return new StepBuilder("masterStep", jobRepository)
      .partitioner("workerStep", partitioner())
      .step(workerStep(jobRepository, tx))
      .gridSize(16)           // reduce partition count vs threads
      .taskExecutor(batchTaskExecutor())
      .build();
}

@Bean
public Step workerStep(JobRepository jobRepository, PlatformTransactionManager tx) {
  return new StepBuilder("workerStep", jobRepository)
      .<Account, Account>chunk(5000, tx)  // larger chunks → fewer metadata commits
      .reader(reader(null))
      .processor(processor())
      .writer(writer())
      .build();
}
```

Also: separate metadata datasource on fast storage, index `JOB_EXECUTION_ID` on step table, archive old executions. For extreme scale, evaluate Spring Batch's `ResourcelessTransactionManager` only for non-restartable throwaway jobs (loses restart).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `initialize-schema=always` in prod | DDL on every deploy; lost indexes; migration fights Flyway |
| Sharing business DS without pool sizing for metadata writes | Connection pool starvation; business + batch compete |
| No retention policy on `BATCH_*` tables | Multi-million row tables; slow `JobExplorer` queries |
| Ignoring `OptimisticLockingFailureException` in logs | Random step failures under multi-threading |
| Wrong parameter identifying flag | Duplicate instances or cannot restart "same" logical job |

### Debugging scenario

**Observe.** `JobInstanceAlreadyCompleteException` when ops reruns tonight's file.

**Diagnose.**

```sql
SELECT ji.JOB_NAME, je.JOB_EXECUTION_ID, je.STATUS, je.START_TIME, p.KEY_NAME, p.STRING_VAL, p.TYPE_CD
FROM BATCH_JOB_INSTANCE ji
JOIN BATCH_JOB_EXECUTION je ON je.JOB_INSTANCE_ID = ji.JOB_INSTANCE_ID
JOIN BATCH_JOB_EXECUTION_PARAMS p ON p.JOB_EXECUTION_ID = je.JOB_EXECUTION_ID
WHERE ji.JOB_NAME = 'importJob'
ORDER BY je.START_TIME DESC;
```

If `fileName` is identifying and prior run `COMPLETED`, Spring Batch correctly refuses. Need new `run.id` or non-identifying `fileName` with identifying `run.id` only.

**Fix.**

```java
@Bean
public Job importJob(JobRepository repo, Step step) {
  return new JobBuilder("importJob", repo)
      .incrementer(new RunIdIncrementer())
      .start(step)
      .build();
}
```

---

## 3. Item-Oriented Processing: Reader, Processor, Writer

### Core concept

Item-oriented processing is the default Spring Batch model: **pull** items from `ItemReader`, optionally transform via `ItemProcessor`, **push** aggregates via `ItemWriter`. The framework drives the loop (chunk tasklet), not your `while` loop.

Contracts:

- `ItemReader<T>.read()` returns one item or **`null` at end of input** (EOF). Never return null to mean "skip this item" — use processor filter (`return null`) or skip policy.
- `ItemProcessor<I,O>.process(item)` returns transformed item, **`null` to filter**, or throws to fail/skip/retry.
- `ItemWriter<T>.write(Chunk<T> items)` receives a **chunk** (list) per commit boundary in chunk steps.

`ItemStream` (open/update/close) extends readers/writers that need lifecycle and checkpointing. Framework wraps streams automatically when registered on step builder.

### Internal working

`ChunkOrientedTasklet` loop:

```text
repeat:
  item = reader.read()
  if item == null: break
  processed = processor.process(item)  // may be null
  if processed != null: chunk.add(processed)
  if chunk.size() >= commitInterval:
    writer.write(chunk)
    transaction.commit()
    jobRepository.update(stepExecution)  // counts + context
    chunk.clear()
```

`SynchronizedItemStreamReader` wraps reader when step is multi-threaded — `read()` delegates with lock.

Composite patterns: `CompositeItemProcessor`, `ClassifierCompositeItemWriter`, `ItemWriter` delegating to multiple writers via `CompositeItemWriter` (fan-out same chunk to DB + file).

### Production scenario: processor throws, entire job dies on one bad row

**Problem.** 50M row CSV, one malformed line at row 34M. Job fails. No partial delivery. Ops wants bad rows in quarantine, good rows committed.

**Cause.** Default fault tolerance off. Any exception aborts chunk, rolls back chunk, propagates.

**Solution.** See section 4 for skip/retry. Minimal pattern:

```java
return new StepBuilder("importStep", jobRepository)
    .<RawRow, Account>chunk(1000, transactionManager)
    .reader(csvReader())
    .processor(validatingProcessor())
    .writer(accountWriter())
    .faultTolerant()
    .skip(ValidationException.class)
    .skipLimit(10000)
    .listener(skipListener())
    .build();
```

`SkipListener.onSkipInRead` / `onSkipInProcess` / `onSkipInWrite` — log to quarantine table or dead-letter file.

### Production scenario: writer not flushing until chunk full at EOF

**Problem.** Job processes last 237 rows but DB shows 0. Reader hit EOF mid-chunk.

**Cause.** Misunderstanding chunk commit — **partial final chunk is still written** on normal EOF. If you see 0 rows, reader returned null before any read, writer failed silently, or transaction rolled back. If custom tasklet mimics chunk loop incorrectly, last partial batch may be dropped.

**Solution.** Do not hand-roll chunk loops in tasklets unless you understand commit boundaries. Use chunk step. Verify with integration test that 237 rows (chunk size 1000) still persist.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `read()` returns null for "skip" | Premature EOF; job stops early |
| Processor mutates input object shared with reader buffer | Subtle data corruption in multi-threaded steps |
| `ItemWriter` not `@StepScope` but depends on job parameters | Stale or null `fileName` from first job only |
| `CompositeItemWriter` without `failOnEmpty=false` on inner writer | One empty delegate fails whole write |
| Stateful reader without `ItemStream` | Restart duplicates or skips |

### Debugging scenario

**Observe.** Infinite loop — job never completes, CPU pegged, `read_count` climbing in metadata.

**Diagnose.** Reader never returns null — classic bug in custom reader: `while` in `read()` without EOF sentinel. Or JDBC reader with bad `sortKey` causing same row repeatedly.

**Fix.** Ensure `read()` returns null once. For JDBC paging, verify `ORDER BY` includes unique key.

---

## 4. Chunk-Oriented Steps: Size, Skip, Retry

### Core concept

A **chunk** is the unit of transaction and (usually) the unit of metadata checkpoint. `chunk(n, transactionManager)` sets commit interval = n items (after filtering). One transaction per successful chunk: read n items (with retries), process, write, commit.

Fault tolerance (`faultTolerant()`):

- **Retry** — same item re-processed when transient failure (network blip, deadlock). `retryLimit`, `retry(Exception.class)`.
- **Skip** — item abandoned after retries exhausted or immediately for skippable exceptions. `skipLimit`, `skip(Exception.class)`.
- **No rollback** — `noRollback(ValidationException.class)` keeps transaction commitable when that exception occurs (use carefully — can leave partial chunk state inconsistent unless skip handles it).

Retry and skip are **not** interchangeable. Retry = "try again before giving up." Skip = "give up on this item and continue."

### Internal working

On failure inside chunk:

1. Transaction rolls back (default for runtime exceptions).
2. Chunk items may be re-read if reader is not `@StepScope` stateful — **idempotency required**.
3. Retry policy resets per item within chunk loop semantics (see `FaultTolerantChunkProcessor`).

`skipLimit` is global for the step, not per chunk. Exceeding skip limit fails the step.

`chunk` vs `chunk(int)` vs `chunk(CompletionPolicy)`: custom `CompletionPolicy` for size-based + timeout-based commits (commit every 1000 items OR every 30 seconds).

### Production scenario: chunk size 1 brings down Oracle

**Problem.** Team sets `chunk(1)` "for safety" on high-volume JDBC writer. 20k inserts/sec becomes 20k transactions/sec. UNDO table explodes, job runs 8 hours.

**Cause.** Transaction overhead dominates. Each commit flushes metadata + DB commit.

**Solution.** Tune chunk size against:

- DB batch insert support (`JdbcBatchItemWriter` with `batchSize`)
- Memory (large objects in chunk buffer)
- Failure blast radius (chunk fails = re-process whole chunk on retry)

```java
@Bean
public JdbcBatchItemWriter<Account> writer(DataSource ds) {
  return new JdbcBatchItemWriterBuilder<Account>()
      .dataSource(ds)
      .sql("INSERT INTO account (id, name, balance) VALUES (:id, :name, :balance)")
      .beanMapped()
      .assertUpdates(false)
      .build();
}

// chunk(500) with batch writer → 500 reads, 1-10 JDBC batch round trips per chunk depending on driver
```

Start with 500–5000 for JDBC bulk; 100–1000 for JPA; measure.

### Production scenario: retry on non-idempotent writer causes duplicates

**Problem.** `retry(DeadlockLoserDataAccessException.class)` enabled. Writer inserts into `payments`. Deadlock on chunk commit. Retry re-inserts same payments. Unique constraint violations or duplicates if constraint missing.

**Cause.** Chunk rolled back but reader checkpoint not advanced until commit — actually on rollback, reader context not updated, so retry re-reads same items. If partial commit happened (wrong `noRollback` config), duplicates possible.

**Solution.** Idempotent writes: `INSERT ... ON CONFLICT`, natural key upsert, or business-level dedup. Limit retry to true transients. See section 14.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `skip` without `faultTolerant()` | Config ignored |
| `retry` + `skip` on same exception class | Undefined precedence confusion — order matters |
| `skipLimit(0)` default with skip policy | First skip fails step |
| Huge chunk + wide rows | OOM in chunk buffer |
| `retryLimit` exceeded on one bad item | Step fails even with skip configured for other exceptions |

### Debugging scenario

**Observe.** `SKIP_COUNT` increases but quarantine table empty.

**Diagnose.** `SkipListener` not registered or only registered on step without fault tolerance. Or skips happening in read phase but listener only implements `onSkipInWrite`.

**Fix.**

```java
public class QuarantineSkipListener implements SkipListener<RawRow, Account> {
  @Override
 public void onSkipInRead(Throwable t) { log(t); }
  @Override
  public void onSkipInWrite(Account item, Throwable t) { quarantine(item, t); }
  @Override
  public void onSkipInProcess(RawRow item, Throwable t) { quarantine(item, t); }
}
```

---

## 5. Tasklet Steps vs Chunk Steps

### Core concept

**Chunk step** — framework-driven read/process/write loop with built-in metrics, restart, fault tolerance.

**Tasklet step** — `Tasklet.execute(StepContribution, ChunkContext)` runs arbitrary logic; return `RepeatStatus.FINISHED` or `CONTINUABLE`. One transaction per tasklet invocation by default (configurable with `transactionManager` + step config).

Use tasklet for: single stored procedure, copy one file, HTTP call, purge table, loop until condition with manual `RepeatStatus.CONTINUABLE`.

Use chunk for: streaming many homogeneous items with standard metrics.

### Internal working

`TaskletStep` wraps tasklet in transaction template. Each `CONTINUABLE` repeats tasklet in same step execution until `FINISHED`. `ChunkContext` provides `StepContext` / `JobParameters` access.

`StepContribution` allows incrementing read/write/filter counts manually for monitoring:

```java
contribution.incrementWriteCount(1);
```

Partitioned remote chunking uses tasklets on master and chunk handlers on workers — hybrid model.

### Production scenario: tasklet COPY job not restartable

**Problem.** Tasklet runs `COPY accounts FROM '/data/big.csv'`. JVM killed at 70%. Restart reruns entire COPY — duplicate rows or PK violations.

**Cause.** Tasklet marked `allowStartIfComplete(true)` only helps if step completed; mid-flight failure has no checkpoint. `ExecutionContext` never updated during COPY.

**Solution.** Either switch to chunk-based `FlatFileItemReader` + JDBC writer (restartable), or tasklet with manual checkpointing:

```java
@Bean
@StepScope
public Tasklet resumableCopyTasklet(
    DataSource dataSource,
    @Value("#{jobParameters['filePath']}") String filePath) {
  return (contribution, chunkContext) -> {
    ExecutionContext ctx = chunkContext.getStepContext().getStepExecution().getExecutionContext();
    long offset = ctx.containsKey("byteOffset") ? ctx.getLong("byteOffset") : 0L;
    long newOffset = copyFromOffset(dataSource, filePath, offset, 100_000);
    ctx.putLong("byteOffset", newOffset);
    contribution.incrementReadCount((int) (newOffset - offset));
    return newOffset >= fileSize(filePath) ? RepeatStatus.FINISHED : RepeatStatus.CONTINUABLE;
  };
}
```

Or use PostgreSQL `COPY` only for idempotent staging table truncate-reload pattern with exclusive lock.

### Production scenario: chunk step forced for "one API call"

**Problem.** Developers wrap single REST call in `ItemReader` returning one item, chunk step, fake writer — 15 lines of framework for `restTemplate.post()`.

**Solution.** Tasklet:

```java
return new StepBuilder("notifyDownstreamStep", jobRepository)
    .tasklet((contribution, context) -> {
      String batchId = context.getStepContext().getJobParameters().get("batchId");
      downstreamClient.ack(batchId);
      return RepeatStatus.FINISHED;
    }, transactionManager)
    .build();
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Long tasklet without `CONTINUABLE` | Single transaction holds locks for hours |
| Tasklet with `@Transactional` on bean + step transaction | Double transaction boundaries, partial commit bugs |
| Chunk step for non-item work | Awkward readers, wrong metrics |
| `allowStartIfComplete(false)` on cleanup tasklet | Cleanup skipped on job restart after partial success |

### Debugging scenario

**Observe.** Tasklet step shows `READ_COUNT=0` in ops dashboard.

**Diagnose.** Tasklet doesn't increment contribution unless you do manually. Not a bug — chunk metrics don't apply.

**Fix.** Increment appropriate counters or expose custom Micrometer metrics.

---

## 6. Job Parameters, Incrementer, Run ID

### Core concept

`JobParameters` are **immutable** inputs to a `JobExecution`. Typed: string, long, double, date. Access in `@StepScope` beans:

```java
@Value("#{jobParameters['runDate']}")
```

Or `StepExecution` / `ChunkContext` in listeners.

**Identifying parameters** define `JobInstance` uniqueness. Default: all parameters identifying except those explicitly marked non-identifying when built via `JobParametersBuilder`.

`JobParametersIncrementer` runs before new execution to add parameters (typically `run.id` long incremented). `RunIdIncrementer` is standard — makes every run a new `JobInstance` even if business params identical.

`JobParametersValidator` rejects bad combos before execution starts (`DefaultJobParametersValidator` for required keys).

### Internal working

`JobLauncher.run()` → incrementer adds params → validator → `JobRepository.createJobExecution()`.

`JobOperator.start(jobName, parameters)` and `JobExplorer` retrieve historical params from `BATCH_JOB_EXECUTION_PARAMS`.

Spring Batch 5: prefer `JobParameter` typed API in builders:

```java
new JobParametersBuilder()
    .addString("fileName", path, false)  // non-identifying
    .addLong("run.id", System.currentTimeMillis())
    .toJobParameters();
```

### Production scenario: scheduled job won't run second night

**Problem.** Cron launches `importJob` with only `fileDate=yesterday`. First night succeeds. Second night: `JobInstanceAlreadyCompleteException`.

**Cause.** `fileDate` identifying + same date rerun OR incrementer missing so same instance considered complete.

**Solution.**

```java
@Bean
public Job importJob(JobRepository repo, Step step) {
  return new JobBuilder("importJob", repo)
      .incrementer(new RunIdIncrementer())
      .validator(new DefaultJobParametersValidator(new String[]{"fileDate"}, new String[]{}))
      .start(step)
      .build();
}

// Scheduler passes unique run.id OR rely on RunIdIncrementer
```

For "one successful run per fileDate" business rule, use identifying `fileDate` **without** incrementer but custom `JobExecutionAlreadyRunningException` handler and ops playbook for manual reruns (new param `force=true` non-identifying + listener logic).

### Production scenario: `@StepScope` bean sees stale job parameters

**Problem.** Multi-step job: step1 sets something in execution context; step2 bean still uses original `fileName` from parameters but file was rotated.

**Solution.** Pass dynamic state via `ExecutionContext` promotion:

```java
jobExecution.getExecutionContext().putString("outputPath", computedPath);
```

`@StepScope` `@Value("#{jobExecutionContext['outputPath']}")` in step2 bean.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No incrementer, identifying business params | Cannot rerun same logical batch |
| All params non-identifying | Unintended instance merging; restart confusion |
| Date param as String without timezone | Wrong file picked when server TZ changes |
| Huge param values in DB | `BATCH_JOB_EXECUTION_PARAMS` bloat |

### Debugging scenario

**Observe.** Wrong file processed — metadata shows correct `fileName` in params table.

**Diagnose.** Bean not `@StepScope` — singleton reader constructed once at startup with default resource. Or SpEL wrong: `#{jobParameters[fileName]}` missing quotes.

**Fix.** `@StepScope` on reader bean; verify proxy in debugger.

---

## 7. Partitioning

### Core concept

**Partitioning** splits one logical step into N **partition** `StepExecutions` (worker steps) each with its own `ExecutionContext` (partition key range, grid size). Master step (`PartitionStep`) delegates to `Partitioner` that creates `Map<String, ExecutionContext>` of partition names → context.

Workers are usually the same step definition with different partition metadata (e.g. `minId=1,maxId=50000`).

Local partitioning: workers run in same JVM via `TaskExecutor`. Remote partitioning: master on one JVM, workers on others (Spring Integration, messaging, or custom).

### Internal working

`Partitioner.partition(int gridSize)` returns partition map. `PartitionStep` creates worker `StepExecution` per partition, runs worker step (often `Step` bean) with merged contexts, aggregates results on master.

`gridSize` vs partition map size: `PartitionStepBuilder.gridSize(n)` hints partitioner; partitioner may return fewer or more partitions.

Worker step must be **restartable independently** per partition. Failed partition can restart without redoing completed partitions (if job configured for it).

### Production scenario: uneven partitions — straggler worker

**Problem.** Partition by `hash(id) % 64`. One hot merchant has 40% of rows in partition 7. Job wall time = slowest partition.

**Cause.** Hash partitioning without range awareness on skewed data.

**Solution.** Range partition by ID bands from precomputed histogram, or dynamic partitioner querying `COUNT` per bucket:

```java
public class IdRangePartitioner implements Partitioner {
  @Override
  public Map<String, ExecutionContext> partition(int gridSize) {
    long min = jdbc.queryForObject("SELECT MIN(id) FROM staging", Long.class);
    long max = jdbc.queryForObject("SELECT MAX(id) FROM staging", Long.class);
    long target = (max - min + 1) / gridSize;
    Map<String, ExecutionContext> map = new HashMap<>();
    long start = min;
    for (int i = 0; i < gridSize; i++) {
      ExecutionContext ctx = new ExecutionContext();
      long end = (i == gridSize - 1) ? max : start + target - 1;
      ctx.putLong("minId", start);
      ctx.putLong("maxId", end);
      map.put("partition" + i, ctx);
      start = end + 1;
    }
    return map;
  }
}
```

Reader: `WHERE id BETWEEN :minId AND :maxId`.

### Production scenario: 64 partitions on 8-core box

**Problem.** CPU thrashing, context switching, DB connection pool exhausted (64 readers).

**Solution.** `gridSize` ≈ sensible parallelism (cores × 2 for I/O bound). Partition count ≠ performance magic.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Partition keys overlap | Duplicate processing |
| Gaps in partition ranges | Missing records |
| Shared mutable singleton reader | Race conditions |
| Master step transaction wrapping workers | Long lock, wrong semantics |

### Debugging scenario

**Observe.** Only 3 of 16 partitions `COMPLETED`, rest `FAILED` with OOM.

**Diagnose.** Each partition loads huge collection into memory in processor. Partition exacerbates memory × parallelism.

**Fix.** Stream processing, smaller chunk, reduce grid size.

---

## 8. Remote Chunking

### Core concept

**Remote chunking** (distinct from partitioning): master reads items and **ships chunks** to remote workers via middleware (historically Spring Integration channels). Workers write and reply; master commits metadata. Alternative modern pattern: **partitioned workers** each with full read/write path (more common today than classic remote chunking).

Classic remote chunking master: `ChunkMessageChannelItemWriter`. Worker: `ChunkProcessorChunkHandler`. Requires durable messaging, idempotent handling, timeout/retry discipline.

Most teams in 2026 choose: **partitioned step + horizontal pod autoscaler** or **split file externally** (S3 prefixes) rather than Spring Integration remote chunking complexity.

### Internal working

Master holds reader and `JobRepository` commits. Workers receive `ChunkRequest`, process `ChunkProcessor`, return `ChunkResponse`. If worker dies mid-chunk, master must retry chunk — reader must support re-read.

Spring Batch Integration module provides `RemoteChunkingManagerStepBuilder` / worker step builders.

### Production scenario: remote chunking worker timeout

**Problem.** Master waits for worker reply 30m, chunk times out, master retries, worker still processing first attempt — double write.

**Cause.** At-least-once delivery without idempotent writer.

**Solution.** Idempotent writes; worker dedup key; shorter chunks; `MessagingException` handling. Often re-architect to partitioned local/remote workers with own readers (each worker reads subset) to avoid shipping large chunks over wire.

### Production scenario: choosing remote chunking vs partitioning

**Problem.** Team implements remote chunking because "it's more enterprise."

**Solution decision:**

| Factor | Prefer partitioning | Prefer remote chunking |
|---|---|---|
| Item size | Large payloads expensive to ship | Small items |
| Reader location | DB/file can be split by key | Single sequential reader (rare) |
| Infra | K8s jobs / task queue | Existing SI messaging bus |
| Ops maturity | Higher (simpler) | Lower tolerance for duplicate risk |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Non-serializable items in remote chunks | Marshalling failure |
| Shared reader cursor on master only | Workers idle, master bottleneck |
| No dead-letter on poison chunk | Infinite retry loop |

### Debugging scenario

**Observe.** Master `READ_COUNT` high, worker `WRITE_COUNT` low, queue depth growing.

**Diagnose.** Worker slower than master read rate; master backpressure misconfigured.

**Fix.** Throttle master, increase workers, or partition instead.

---

## 9. Multi-Threaded Steps and Synchronized Readers

### Core concept

`.taskExecutor(taskExecutor)` on chunk step allows **multiple threads** processing **different chunks** concurrently within **one** `StepExecution`. Single reader instance must be thread-safe — framework wraps with `SynchronizedItemStreamReader` when reader is `ItemStream`.

**Throttle limit** (`throttleLimit`) caps concurrent chunks (deprecated API in some versions — check 5.x `TaskExecutor` queue + pool size).

Multi-threaded step ≠ partitioned step. MT step: one partition, parallel chunks. Partitioning: multiple step executions.

### Internal working

Each thread runs chunk loop independently. `JobRepository` updates same `StepExecution` — optimistic locking critical. `SynchronizedItemStreamReader` serializes `read()` — **bottleneck** if read is slow; parallelizes process/write.

Processor/writer must be thread-safe or `@StepScope` (one per thread proxy).

### Production scenario: synchronized reader negates parallelism

**Problem.** 16-thread step, DB reader — CPU low, throughput same as single thread.

**Cause.** `JdbcCursorItemReader` single cursor + synchronized read — reads serialized.

**Solution.** Partition by key range instead of MT step, or `JdbcPagingItemReader` per thread with partition (each partition own reader), or `AbstractPagingItemReader` with separate connections per partition.

### Production scenario: non-thread-safe processor mutable state

**Problem.** Processor accumulates `List` in field. Random `ConcurrentModificationException` and wrong aggregates.

**Solution.** No mutable shared state. Use `ExecutionContext` or thread-local only with care. `@StepScope` processor per thread.

```java
@Bean
@StepScope
public ItemProcessor<Row, Row> processor() {
  return row -> transform(row); // new instance per step execution thread proxy
}
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| MT step + cursor reader | Serialized read |
| `OptimisticLockingFailureException` storm | Too many threads updating same StepExecution |
| Shared `@Service` processor with state | Race bugs |
| Forgetting `SynchronizedItemStreamReader` on custom reader | Duplicate reads / corrupted cursor |

### Debugging scenario

**Observe.** Under MT step, duplicate keys appear though single-threaded repro clean.

**Diagnose.** Reader not synchronized; two threads read same item before cursor advances.

**Fix.** Partition instead, or synchronize read path.

---

## 10. Job Restart, Recovery, NO_RESTART

### Core concept

**Restart** = new `JobExecution` for same `JobInstance` (failed/stopped previous execution). Spring Batch walks steps: completed steps skipped (by default), failed step restarted from checkpoint.

`RunIdIncrementer` creates **new instance** — not a restart, full rerun.

`JobRegistry` + `JobOperator.restart(executionId)` triggers restart semantics.

`allowStartIfComplete(true)` on step: re-execute even if prior execution completed (dangerous for non-idempotent steps).

`startLimit(n)` on step: max executions per job instance — prevents infinite restart loops.

`NO_RESTART` / `DisallowRestartJob`: job cannot restart after any completion state — use for one-shot destructive migrations.

### Internal working

On restart, `JobExecution` status `FAILED` or `STOPPED` required. `JobRepository` creates new execution linked to same instance.

Step execution tracking: for failed step, new `StepExecution` created; `ExecutionContext` loaded from last failed attempt's committed checkpoints.

`CompositeStepExecutionListener` / flow: `FlowBuilder` conditional steps affect what runs on restart.

### Production scenario: restart skips "completed" step that lied

**Problem.** Step1 exports file, step2 imports. Step1 marked `COMPLETED` but file partial (buggy tasklet returned FINISHED early). Restart skips step1, step2 fails on bad file forever.

**Cause.** Restart trusts step status without verifying business outcome.

**Solution.** Validation step between; `JobExecutionDecider`; or `allowStartIfComplete(false)` on export; tasklet only FINISHED when file checksum validated. Ops: `abandon` job execution and start new instance with `RunIdIncrementer`.

```java
jobOperator.abandon(executionId);
jobLauncher.run(job, new JobParametersBuilder()
    .addLong("run.id", System.currentTimeMillis())
    .addString("fileDate", "2026-08-31")
    .toJobParameters());
```

### Production scenario: infinite restart loop on bad config

**Problem.** Step always fails at first item. Ops auto-restart script loops forever.

**Solution.** `startLimit(3)`; alerting on `FAILED`; fix root cause. `JobParametersIncrementer` won't help restart — same instance retries.

### Production scenario: NO_RESTART for truncate-and-load

**Problem.** Job truncates staging table step1, loads step2. Failed mid step2. Restart skips truncate (complete), loads duplicate into non-empty staging.

**Solution.**

```java
return new JobBuilder("stagingJob", repo)
    .preventRestart()
    .start(truncateStep)
    .next(loadStep)
    .build();
```

Ops must run fresh job instance with new parameters after failure (manual truncate).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `preventRestart` misunderstood | Ops cannot resume long jobs after infra blip |
| Completed step not idempotent with `allowStartIfComplete(true)` | Duplicates on re-run |
| Restart with changed code/schema | Checkpoint incompatible with new reader |
| Abandoned executions pile up | `JobExplorer` shows many FAILED blocking business rules |

### Debugging scenario

**Observe.** `JobRestartException: JobInstance already complete`.

**Diagnose.** Trying to restart completed instance vs start new. Check `JobInstance` last execution status.

**Fix.** New `run.id` for deliberate full rerun; `restart()` only for FAILED.

---

## 11. Listeners: Job, Step, Item, Chunk

### Core concept

Listeners observe lifecycle without polluting business logic. Register on job/step builder or as `@Bean` global listeners (careful — applies to all jobs).

| Listener | When |
|---|---|
| `JobExecutionListener` | before/after job |
| `StepExecutionListener` | before/after step |
| `ItemReadListener` | before/after/onError read |
| `ItemProcessListener` | before/after/onError process |
| `ItemWriteListener` | before/after/onError write |
| `ChunkListener` | before/after chunk (after transaction commit timing — know `afterChunk` vs `afterChunkError`) |

`ChunkListener.afterChunk()` runs after successful commit — safe to publish events that must not roll back with chunk.

### Internal working

Listeners invoked by `CompositeItemListener` / step listener chain. Order matters when multiple listeners registered — registration order = invocation order for before*, reverse for after* (stack-like for step listeners in some cases — verify in tests).

`@StepScope` listeners can hold step state.

Annotation-driven: `@BeforeStep`, `@AfterStep` on methods in bean registered via `listener()`.

### Production scenario: publishing Kafka message in ItemWriteListener.beforeWrite

**Problem.** Downstream consumes events for rows that roll back on chunk failure.

**Cause.** `beforeWrite` runs inside transaction — actually before write but still same transaction. If chunk fails after partial write in listener side effect, inconsistency. Worse: `afterWrite` still before commit in some versions — use `afterChunk` for post-commit.

**Solution.**

```java
@Override
public void afterChunk(ChunkContext context) {
  eventPublisher.publishEventsCommitted(context); // afterChunk = post-commit
}
```

Or transactional outbox in same DB transaction as writer.

### Production scenario: listener opens DB connection per item

**Problem.** `ItemProcessListener.afterProcess` logs to audit table per row. 10M inserts from listener, job 10× slower than writer alone.

**Solution.** Batch audit in `ChunkListener` or writer composite; or async append-only log.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Heavy work in `beforeChunk` | Extends transaction hold time |
| Listener throws unchecked exception | Chunk fails / skip confusion |
| Global listener assumes all jobs have same params | NPE on missing `fileName` |
| `afterJob` sends success email before validating skipped records | False green notifications |

### Debugging scenario

**Observe.** Listener not invoked.

**Diagnose.** Bean not registered — `@Component` listener needs `@EnableBatchProcessing` component scan + `registerListeners` or explicit `.listener(bean)`.

**Fix.** `.listener(auditListener)` on step builder.

---

## 12. Scheduling Spring Batch Jobs

### Core concept

Spring Batch does **not** schedule jobs. **`@Scheduled`**, Quartz, K8s CronJob, or external orchestrator (Airflow, Control-M) launches `JobLauncher.run()`.

Critical distinction:

- `@Scheduled` method calling business logic directly — **no** Batch metadata, no restart, no `JobRepository`.
- `@Scheduled` calling `JobLauncher.run(job, params)` — proper batch execution.

Boot 2.5+ `spring.batch.job.enabled=true` auto-runs all jobs on startup — **production footgun**. Disable:

```yaml
spring:
  batch:
    job:
      enabled: false
```

### Internal working

Scheduler thread invokes launcher. `JobLauncher` sync (`SimpleJobLauncher`) blocks scheduler thread until job completes — long job blocks subsequent scheduled ticks unless `pool` configured on scheduler.

`TaskExecutorJobLauncher` runs job async — scheduler returns immediately; risk overlapping runs if not guarded.

Guard overlapping:

```java
@Scheduled(cron = "0 0 2 * * *")
public void launchImport() {
  JobParameters params = new JobParametersBuilder()
      .addString("fileDate", LocalDate.now().minusDays(1).toString())
      .addLong("run.id", System.currentTimeMillis())
      .toJobParameters();
  try {
    jobLauncher.run(importJob, params);
  } catch (JobExecutionAlreadyRunningException e) {
    log.warn("Import already running, skipping");
  } catch (JobInstanceAlreadyCompleteException e) {
    log.warn("Import already completed for params");
  }
}
```

Better: `JobOperator.startNextInstance` + `JobExplorer.findRunningJobExecutions`.

Quartz: `QuartzJobBean` delegates to launcher; cluster Quartz prevents duplicate fire.

### Production scenario: double run at 2am — @Scheduled + K8s CronJob

**Problem.** Two pods both `@Scheduled` 2am. Two imports corrupt state.

**Cause.** Scheduler not clustered; K8s deployment replicas > 1 with embedded scheduler.

**Solution.** Single scheduler replica, or Quartz JDBC cluster, or **only** K8s CronJob with `Job` resource (one pod), disable `@Scheduled` in app. Use `JobExplorer` guard.

### Production scenario: auto-run on deploy processes half file

**Problem.** Every deploy during business hours triggers `spring.batch.job.enabled` default — job starts, deploy kills pod.

**Solution.** `enabled: false`; explicit launcher only.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `enabled: true` in prod | Surprise job on every restart |
| No overlap guard | Duplicate concurrent executions |
| `@Scheduled` on `@StepScope` bean | Broken proxy / wrong lifecycle |
| Cron TZ unspecified | DST surprises |

### Debugging scenario

**Observe.** Job runs twice same minute.

**Diagnose.** Two schedulers (Quartz + @Scheduled); or two pods; or `CONTINUABLE` tasklet + scheduler re-entry.

**Fix.** Single orchestration path; leader election.

---

## 13. Transaction Boundaries in Batch

### Core concept

Default chunk step: **one transaction per chunk**. Read/process for N items, write chunk, commit. Rollback on unchecked exception (configurable).

Readers often use `Connection` with `autoCommit=false` participating in step transaction or hold separate read-only transaction — **cursor readers** may block writers on same table if isolation wrong.

`PlatformTransactionManager` per step — can assign `JpaTransactionManager` for JPA writer and `DataSourceTransactionManager` for JDBC — **chained transactions not automatic** — mixed JPA+JDBC same chunk needs `ChainedTransactionManager` (deprecated removed — prefer single resource or transactional outbox).

`Propagation.NOT_SUPPORTED` on processor `@Transactional` suspends outer chunk transaction — dangerous: partial commits outside chunk semantics.

### Internal working

`TransactionTemplate` in `ChunkOrientedTasklet`. `ChunkProvider` reads outside write transaction in some configurations — understand read-your-writes within chunk.

`ItemWriter` JPA `flush` at chunk commit. `JdbcBatchItemWriter` executes batch at commit.

### Production scenario: reading and writing same table — lock escalation

**Problem.** Chunk job updates `orders` via cursor reader on `orders` same TX. Throughput collapses, lock timeouts.

**Cause.** Shared locks on read cursor + update same rows.

**Solution.** Read from staging snapshot table; `READ UNCOMMITTED` / snapshot isolation (DB-specific); or key-set pagination instead of cursor; or partition IDs.

### Production scenario: @Transactional processor splits transaction

**Problem.** Developer adds `@Transactional` on processor calling repository. Partial items committed before chunk write. Chunk fails — inconsistent.

**Solution.** Remove nested transaction; let chunk boundary govern. Use `REQUIRED` only if intentional and tested.

### Production scenario: custom ItemWriter without participating in transaction

**Problem.** Writer opens manual connection with autocommit true. Chunk rollback doesn't undo writer.

**Solution.** Use `DataSourceUtils.getConnection(dataSource)` tied to transaction manager.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Long `@Transactional` on read listener | Holds locks across items |
| JPA clear() missing between chunks | Growing persistence context OOM |
| Two datasources one chunk | Partial commit |
| `Propagation.REQUIRES_NEW` in skip listener | Committed skips, rolled back writes |

### Debugging scenario

**Observe.** Rollback logged but data persists.

**Diagnose.** Writer not transactional; or NO_AUTO_COMMIT DataSource misconfigured; or non-transactional resource (Kafka).

**Fix.** Align resource participation; outbox pattern for messaging.

---

## 14. Idempotency and Duplicate Processing

### Core concept

Batch **at-least-once** semantics under retry/restart/partitioning/multi-threading imply duplicates possible. Design for **idempotency**:

- Natural key upsert (`ON CONFLICT DO UPDATE`)
- Idempotency key table (processed message IDs)
- Staging → merge pattern with `MERGE` statement
- Object store etag/version check

Restart idempotency: reader checkpoint + writer idempotency together.

### Internal working

On chunk rollback, items re-processed. Skip/retry amplify duplicates if writer not idempotent.

`JobParameters` `run.id` change = new instance = full rerun — business dedup must handle.

### Production scenario: payment file replay

**Problem.** Bank resends file. Job reruns. Double credits.

**Solution.**

```java
public class IdempotentPaymentWriter implements ItemWriter<Payment> {
  @Override
  public void write(Chunk<? extends Payment> chunk) {
    for (Payment p : chunk) {
      jdbc.update(
          "INSERT INTO payments (id, amount, status) VALUES (?, ?, ?) " +
          "ON CONFLICT (id) DO NOTHING",
          p.getId(), p.getAmount(), p.getStatus());
    }
  }
}
```

Track `file_hash` in `processed_files` table in job listener — reject or skip duplicate file.

### Production scenario: Kafka offset commit vs chunk commit order

**Problem.** `KafkaItemReader` manual ack after write. Crash after DB commit before ack — redelivery duplicates.

**Solution.** Store offsets in same DB transaction as writes (consumer txn); or idempotent consumer; or process-once via dedup table.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `INSERT` only | PK violations on restart |
| UUID per row insert without business key | Duplicates invisible |
| Side effect before idempotency check | Double charges |

### Debugging scenario

**Observe.** Duplicates only after deadlock retry enabled.

**Diagnose.** Retry re-executes writer for chunk.

**Fix.** Idempotent writer + narrow retry policy.

---

## 15. Large Files, Streaming, Flat Files

### Core concept

Process files **streaming** — never `Files.readAllLines` for GB files. `FlatFileItemReader` streams line by line. `MultiResourceItemReader` chains files. `JsonItemReader` / custom parsers stream.

Encoding: specify `encoding` on flat file reader (UTF-8 vs ISO-8859-1). BOM handling for Excel-exported CSV.

`linesToSkip` / `recordSeparatorPolicy` for header/footer rows. `DefaultRecordSeparatorPolicy` treats blank lines as separators — blank data rows skipped silently.

### Internal working

`BufferedReader` under the hood. `LineMapper` maps String → object. `FieldSet` for delimited. `FixedLengthTokenizer` for fixed width.

`FlatFileItemReader.setSaveState(true)` persists line number in `ExecutionContext` — restart friendly.

For gzip: `Resource` `GzipResource` or `CompressedResource`.

### Production scenario: OOM on "streaming" job

**Problem.** Reader streams but processor builds `List<Line>` per customer in memory map — heap exhausted.

**Cause.** Unbounded aggregation in processor.

**Solution.** DB staging + SQL aggregation step; or sort file by key + chunk-oriented group writer (`ClassifierCompositeItemWriter`).

### Production scenario: CSV with embedded commas and broken RFC4180

**Problem.** `DelimitedLineTokenizer` splits wrong fields.

**Solution.** `CustomFieldSetFactory`, quote character config, or use univocity parser library in custom `LineMapper`.

```java
@Bean
@StepScope
public FlatFileItemReader<Trade> tradeReader(@Value("#{jobParameters['filePath']}") String path) {
  return new FlatFileItemReaderBuilder<Trade>()
      .name("tradeReader")
      .resource(new FileSystemResource(path))
      .delimited()
      .delimiter(",")
      .quoteCharacter('"')
      .names("id", "symbol", "qty", "price")
      .fieldSetMapper(new BeanWrapperFieldSetMapper<>() {{
        setTargetType(Trade.class);
      }})
      .linesToSkip(1)
      .build();
}
```

### Production scenario: 500GB file — single machine impractical

**Solution.** Pre-split files (split -l / S3 multipart upload parts), parallel jobs per file with `MultiResourceItemReader` or K8s indexed job per file. HDFS block parallel read outside Batch semantics.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No encoding set | Mojibake on international data |
| `saveState(false)` on restartable job | Full re-read on failure |
| Loading entire file to count lines in partitioner | OOM / slow start |
| Footer line treated as data | Bad row or skipped totals |

### Debugging scenario

**Observe.** First chunk slow, then fast.

**Diagnose.** DB connection pool warmup, or reader skipping index build on staging table mid-job.

**Fix.** Warmup step; indexes before load.

---

## 16. JDBC vs JPA Readers/Writers Pitfalls

### Core concept

**JDBC** readers/writers: explicit SQL, predictable memory, batch-friendly. `JdbcCursorItemReader`, `JdbcPagingItemReader`, `JdbcBatchItemWriter`.

**JPA** readers/writers: `JpaCursorItemReader`, `JpaPagingItemReader`, `JpaItemWriter`. Persistence context overhead, lazy loading traps, flush ordering.

Rule of thumb for high-volume batch: **JDBC in, JDBC out**. JPA acceptable for low-volume enrichment or domain-heavy transforms with small chunks.

### Internal working

`JdbcPagingItemReader` requires **sort key** (unique). Generates `WHERE (sort > :last) ORDER BY sort LIMIT page`. Missing unique sort → duplicate/missing rows across pages.

`JpaItemWriter` merges entities — triggers lifecycle callbacks, cascade, optimistic locking version checks.

`JdbcBatchItemWriter` uses `PreparedStatement.addBatch()` — driver `reWriteBatchedInserts` (PostgreSQL) matters.

### Production scenario: JpaPagingItemReader duplicates across pages

**Problem.** Page size 1000, sort on `updated_at` only — many rows share timestamp, paging skips/duplicates.

**Cause.** Non-unique sort key.

**Solution.** `ORDER BY updated_at, id` with unique `id` in sort keys.

```java
@Bean
@StepScope
public JdbcPagingItemReader<Account> accountReader(DataSource ds,
    @Value("#{jobParameters['minId']}") Long minId) {
  Map<String, Order> sort = Map.of("id", Order.ASCENDING);
  PostgreSqlPagingQueryProvider queryProvider = new PostgreSqlPagingQueryProvider();
  queryProvider.setSelectClause("SELECT id, name, balance");
  queryProvider.setFromClause("FROM account");
  queryProvider.setWhereClause("WHERE id >= " + minId);
  queryProvider.setSortKeys(sort);

  return new JdbcPagingItemReaderBuilder<Account>()
      .name("accountReader")
      .dataSource(ds)
      .queryProvider(queryProvider)
      .rowMapper(new BeanPropertyRowMapper<>(Account.class))
      .pageSize(1000)
      .build();
}
```

### Production scenario: JPA writer OOM — persistence context not cleared

**Problem.** 2M entities processed, heap grows until OOM.

**Cause.** `EntityManager` holds all managed entities until cleared.

**Solution.**

```java
@Bean
public JpaItemWriter<Account> jpaWriter(EntityManagerFactory emf) {
  JpaItemWriter<Account> writer = new JpaItemWriter<>();
  writer.setEntityManagerFactory(emf);
  return writer;
}

// In step listener afterChunk:
em.flush();
em.clear();
```

Or switch to `JdbcBatchItemWriter`.

### Production scenario: lazy collection accessed in processor N+1

**Problem.** JPA reader returns `Order` entity; processor touches `order.getLines()` — 1 query per row.

**Solution.** `JOIN FETCH` in custom query reader, or `@EntityGraph`, or JDBC reader with join SQL.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Cursor reader + same TX writer same table | Locks |
| `assertUpdates(true)` on writer with upsert | `EmptyResultDataAccessException` |
| JPA without `saveState` awareness | Detached entity on restart |
| Mixing JPA reader JDBC writer without clearing EM | Stale session |

### Debugging scenario

**Observe.** `JdbcBatchItemWriter` slow — batch size 5000 but driver sends row-by-row.

**Diagnose.** `rewriteBatchedStatements=true` (MySQL) or PG driver properties missing.

**Fix.** JDBC URL tuning + verify `BatchUpdateException` logging.

---

## 17. Spring Batch Integration

### Core concept

`spring-batch-integration` bridges Batch with Spring Integration (SI): remote chunking, remote partitioning via messaging, `JobLaunchingGateway`, polling adapters launching jobs from files arriving on SFTP.

Patterns:

- `FileReadingMessageSource` → SI flow → `JobLaunchingMessageHandler`
- `RemoteChunkingManagerStepBuilder` / worker builders
- `PartitionHandler` messaging implementation

Use when enterprise already runs SI bus (Kafka, Rabbit, JMS) and team expertise exists. Otherwise K8s-native patterns often simpler.

### Internal working

Messages carry `ChunkRequest`, `StepExecutionRequest`, etc. Serializers must handle item types. DLQ for poison messages.

`@EnableIntegration` + batch integration namespace (Java config: `RemoteChunkingManagerStepBuilder`).

### Production scenario: SFTP file arrival launches job before upload complete

**Problem.** Partial file processed.

**Cause.** SI adapter fires on file create not rename-complete.

**Solution.** Upload to `.tmp`, rename to `.csv` on complete; SI filter `*.csv` only; or checksum file sidecar.

### Production scenario: JobLaunchingGateway without unique parameters

**Problem.** Second file same night rejected — instance complete.

**Solution.** `RunIdIncrementer` + file name param identifying per file.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Poison message infinite redelivery | Stuck job |
| Large message payloads | Broker limits |
| No correlation on remote replies | Hung master step |

### Debugging scenario

**Observe.** SI flow silent — no job launched.

**Diagnose.** Poller metadata store; advice chain exception swallowed. Enable SI debug logging.

**Fix.** Error channel to DLQ + alert.

---

## 18. Monitoring: Micrometer, Actuator, Metrics

### Core concept

Spring Batch 5 integrates Micrometer: `BatchMetrics` registers timers/counters for job/step execution. Boot Actuator exposes `/actuator/metrics`, health.

Key metrics to dashboard:

- `spring.batch.job.active` — running jobs
- `spring.batch.job` — completed/failed counts, duration
- Step-level: read/write/skip counts from `StepExecution` (query metadata or export via listener)

Custom metrics:

```java
@Bean
public MeterBinder batchBusinessMetrics() {
  return registry -> registry.counter("payments.processed");
}
```

Tag cardinality: do not tag Micrometer with `jobExecutionId` high cardinality in prod.

### Internal working

`JobRegistrySmartInitializingSingleton` / `MicrometerJobListener` (auto when micrometer present). Observations for job lifecycle in recent versions.

Actuator health `BatchObservabilityBeanPostProcessor` — batch components health.

Export `BATCH_*` metrics via scheduled query to Prometheus for historical skip rates.

### Production scenario: green job metric but business wrong

**Problem.** Dashboard shows job success rate 99%. Finance finds 5% rows missing — skips below alert threshold.

**Solution.** Alert on `skipCount > 0` for financial jobs; `ExitStatus.COMPLETED` with `exitDescription` warnings; business reconciliation step mandatory.

```java
@Override
public void afterJob(JobExecution jobExecution) {
  if (jobExecution.getStatus() == BatchStatus.COMPLETED) {
    Collection<StepExecution> steps = jobExecution.getStepExecutions();
    long skips = steps.stream().mapToLong(StepExecution::getSkipCount).sum();
    if (skips > 0) {
      jobExecution.setExitStatus(new ExitStatus("COMPLETED_WITH_SKIPS", "skips=" + skips));
      alertService.warn("Job completed with skips: " + skips);
    }
  }
}
```

### Production scenario: metadata DB monitoring ignored

**Problem.** `BATCH_STEP_EXECUTION` table 500GB, queries timeout, restart hangs.

**Solution.** Retention job (tasklet deleting old executions), archive to cold storage, index maintenance.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| High-cardinality tags | Prometheus explosion |
| No alert on FAILED | Silent data loss until downstream complains |
| Relying only on logs | No trend on skip rate creep |

### Debugging scenario

**Observe.** Micrometer shows no batch metrics.

**Diagnose.** `micrometer-core` missing; custom `JobLauncher` bypassing listeners; metrics disabled.

**Fix.** `implementation 'io.micrometer:micrometer-core'` + use Boot launcher.

---

## 19. Cloud: Kubernetes CronJob and Scaling Pitfalls

### Core concept

K8s `CronJob` creates `Job` pod(s) on schedule. Spring Batch app runs `JobLauncher.run()` in main or `ApplicationRunner`, exits — pod completes.

**Never** scale Batch worker deployment replicas > 1 with embedded scheduler unless leader election.

Patterns:

1. **CronJob → one-shot pod** — launches batch, exits 0/1. Ideal.
2. **Long-running service** with `@Scheduled` — replica=1 only.
3. **Partitioned work** — Indexed Job (`completionMode=Indexed`) with `JOB_COMPLETION_INDEX` for static splits.

Horizontal scaling pitfalls:

- Two pods same `JobParameters` → duplicate processing, `JobExecutionAlreadyRunningException`, or worse both run if race before metadata lock.
- Shared file on PVC without exclusive lock — both read same file.
- `spring.batch.job.enabled=true` on rolling deploy — every new pod starts job.

### Internal working

`JobRepository` DB lock prevents two `JobExecution` same instance STARTED — but race window exists if two launchers bypass repository (direct step invocation).

For K8s: use `parallelism: 1` on Job unless partitioned indexed model.

Sidecar / init container: download file from S3 to local volume before batch container starts.

### Production scenario: HPA scales batch deployment during peak

**Problem.** HPA sees CPU spike from batch job, scales to 4 pods, 4 jobs run.

**Cause.** Batch deployment treated as stateless API.

**Solution.** Separate deployments: API (HPA) vs Batch CronJob (no HPA). Or `concurrencyPolicy: Forbid` on CronJob.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-import
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: batch
              image: payments/batch:3.2.1
              env:
                - name: SPRING_BATCH_JOB_ENABLED
                  value: "false"
              args:
                - "--spring.batch.job.name=importJob"
                - "--fileDate=$(FILE_DATE)"
```

Boot 3: `SpringApplication.exit()` after job for clean pod completion.

### Production scenario: CronJob starts before DB migration job finishes

**Problem.** Flyway migration job and batch CronJob race on deploy night.

**Solution.** Init dependencies; Helm hook ordering; batch image requires migration version.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| replicas=3 + @Scheduled | Triple execution |
| Missing `concurrencyPolicy: Forbid` | Overlapping CronJob pods |
| Liveness probe kills long job pod | Partial job, restart duplicates |
| Shared RWO volume multi pod | Second pod crash loop |

### Debugging scenario

**Observe.** Two `JOB_EXECUTION_ID` same minute, same instance.

**Diagnose.** `kubectl get pods` — overlapping CronJob; check `JobExecutionAlreadyRunningException` logs ignored in catch block.

**Fix.** Forbid concurrency; idempotent business layer.

---

## 20. Testing Batch Jobs

### Core concept

Test pyramid for batch:

1. **Unit** — `ItemProcessor`, `LineMapper`, partitioner logic (pure Java).
2. **Slice** — `@SpringBatchTest` + `JobLauncherTestUtils` launches job against in-memory or Testcontainers DB.
3. **Integration** — full job with sample file, assert DB + metadata tables.

`@SpringBatchTest` provides `JobLauncherTestUtils`, `JobRepositoryTestUtils` for restart tests.

`TestJobLauncher` sync launcher for tests.

Use `@Autowired Job job` with unique `RunIdIncrementer` params per test method.

### Internal working

`JobRepositoryTestUtils.createJobExecution()` for listener unit tests without full job.

`StepRunner` utility runs single step.

Testcontainers: real PostgreSQL for `JdbcBatchItemWriter` batch semantics.

Reset metadata: `JobRepositoryTestUtils.removeJobExecutions()` or delete from `BATCH_*` in `@BeforeEach`.

### Production scenario: tests pass with H2, fail on Oracle

**Problem.** H2 lenient on SQL; Oracle batch insert syntax differs; paging query wrong.

**Solution.** Testcontainers + same DDL as prod. `@DynamicPropertySource` datasource.

```java
@SpringBatchTest
@SpringBootTest
@Testcontainers
class ImportJobIT {

  @Container
  static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

  @Autowired JobLauncherTestUtils jobLauncherTestUtils;
  @Autowired Job importJob;

  @BeforeEach
  void clean() {
    jdbcTemplate.execute("TRUNCATE account, BATCH_STEP_EXECUTION_CONTEXT, BATCH_STEP_EXECUTION, " +
        "BATCH_JOB_EXECUTION_CONTEXT, BATCH_JOB_EXECUTION_PARAMS, BATCH_JOB_EXECUTION, BATCH_JOB_INSTANCE CASCADE");
  }

  @Test
  void importInsertsRows() throws Exception {
    JobParameters params = new JobParametersBuilder()
        .addString("filePath", "src/test/resources/sample.csv")
        .addLong("run.id", 1L)
        .toJobParameters();
    JobExecution execution = jobLauncherTestUtils.launchJob(importJob, params);
    assertThat(execution.getStatus()).isEqualTo(BatchStatus.COMPLETED);
    assertThat(jdbcTemplate.queryForObject("SELECT COUNT(*) FROM account", Long.class)).isEqualTo(100L);
  }

  @Test
  void restartAfterFailureSkipsCompletedChunks() throws Exception {
    // launch job with failing writer mock at chunk 2, restart, assert counts
  }
}
```

### Production scenario: no restart test — production restart bug

**Problem.** Custom reader restart broken; CI never tested `JobOperator.restart()`.

**Solution.** Integration test: process half file, kill step, `jobRepositoryTestUtils.updateStepExecution` simulate fail, restart, assert line count.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `@SpringBootTest` without disabling auto job | Flaky parallel tests |
| Shared `run.id` across tests | `JobInstanceAlreadyCompleteException` |
| No assert on skip count | Green test, bad data |
| Mock writer only — never reader integration | Reader SQL bugs in prod |

### Debugging scenario

**Observe.** Flaky test — sometimes 99 rows, sometimes 100.

**Diagnose.** Parallel test methods share DB; `@DirtiesContext` missing; static temp file overwritten.

**Fix.** Isolated schemas per test; unique job params.

---

## 21. Production Debugging Playbook

When a batch incident is "random," it is usually **duplicate launchers**, **restart without idempotency**, **metadata vs business DB mismatch**, or **transaction boundaries**.

1. **Classify the failure surface.** `FAILED` step vs `COMPLETED` with skips vs hung `STARTED`. Query metadata first:

   ```sql
   SELECT je.JOB_EXECUTION_ID, je.STATUS, je.START_TIME, je.END_TIME, je.EXIT_CODE,
          se.STEP_NAME, se.STATUS, se.READ_COUNT, se.WRITE_COUNT, se.SKIP_COUNT, se.COMMIT_COUNT
   FROM BATCH_JOB_EXECUTION je
   JOIN BATCH_STEP_EXECUTION se ON se.JOB_EXECUTION_ID = je.JOB_EXECUTION_ID
   WHERE je.JOB_EXECUTION_ID = ?
   ORDER BY se.STEP_EXECUTION_ID;
   ```

2. **Compare metadata counts to business truth.** `WRITE_COUNT` ≠ business row count → filters, failed writer partial commit, or wrong table.

3. **Check for duplicate executions.**

   ```sql
   SELECT JOB_INSTANCE_ID, COUNT(*) AS executions, SUM(CASE WHEN STATUS='FAILED' THEN 1 ELSE 0 END) AS failed
   FROM BATCH_JOB_EXECUTION
   WHERE CREATE_TIME > NOW() - INTERVAL '24 hours'
   GROUP BY JOB_INSTANCE_ID
   HAVING COUNT(*) > 1;
   ```

4. **Inspect `ExecutionContext` for failed step** — reader checkpoint present? Serialized size exploding?

5. **Restart vs new instance.** `JobOperator.restart(executionId)` only for FAILED/STOPPED. Completed instance needs new `run.id`. Abandon hung executions: `jobOperator.abandon(executionId)`.

6. **Transaction evidence.** DB lock graphs during chunk (Oracle `V$SESSION`, PG `pg_locks`). Long-running TX = chunk too big or listener holding TX.

7. **File and parameter sanity.** Pod env `fileDate`, mount paths, partial files, charset. `@StepScope` bean wrong params in multi-step job.

8. **Partition skew.** Wall time ≈ max partition duration. Query per-partition counts if logged.

9. **Enable targeted logging on canary** — not full prod fleet:

   ```yaml
   logging.level.org.springframework.batch.core.step.item=DEBUG
   logging.level.org.springframework.batch.repeat=DEBUG
   ```

   Read skip/retry stack traces; `FaultTolerantChunkProcessor` logs retry attempts.

10. **Infra layer.** K8s CronJob `concurrencyPolicy`, pod overlap, OOMKilled mid-chunk, liveness killing job, Flyway not applied.

11. **Turn DEBUG off.** Large jobs generate GB logs if item-level DEBUG enabled.

Metadata retention: archive jobs older than N days — `BATCH_*` bloat slows every debugging query during incident.

---

## 22. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Millions of homogeneous rows | Chunk step + JDBC paging reader + JDBC batch writer |
| Single stored proc / one-shot action | Tasklet step |
| Skewed key distribution | Range partitioner with pre-analyzed histogram, not naive hash |
| Sequential file, single machine | `FlatFileItemReader` + chunk; gzip resource; `linesToSkip` header |
| File too large for one machine | Pre-split files + multi-resource reader or indexed K8s jobs |
| Must survive JVM kill mid-job | `ItemStream` checkpoint + idempotent writer + `JobRepository` persisted |
| One successful run per business key per day | Identifying job param (`fileDate`) + no `RunIdIncrementer`; ops rerun uses new param or abandon |
| Nightly reruns same param intentionally | `RunIdIncrementer` or non-identifying params |
| Transient DB deadlocks | `retry(DeadlockLoserDataAccessException.class)` + idempotent writer |
| Bad records in file | `skip` + `SkipListener` + quarantine table; alert if `skipCount > 0` |
| JPA domain model, low volume | `JpaPagingItemReader` + `clear()` each chunk |
| High volume, performance critical | JDBC/SQL only; tune chunk 500–5000; driver batch URL flags |
| Avoid shipping items over network | Partition with local readers per worker, not remote chunking |
| Schedule in K8s | CronJob `concurrencyPolicy: Forbid`, `spring.batch.job.enabled=false`, pod exits |
| Multiple app replicas | No embedded `@Scheduled` batch on scaled deployment |
| Trigger on file arrival | SI / object event → launcher with unique params; `.tmp` rename pattern |
| Exactly-once to Kafka | Transactional outbox or idempotent consumer — not raw `afterWrite` publish |
| Mixed JDBC + JPA in one chunk | Avoid; single TX manager or split steps |
| Job must not restart after failure | `preventRestart()` + ops playbook for manual cleanup |
| Test restart semantics | `@SpringBatchTest` + `JobRepositoryTestUtils` + Testcontainers |

---

## Scenario-Based Questions

**Q1: A chunk job shows `COMPLETED` but 12,000 rows are missing. `SKIP_COUNT` is 12,000. Finance escalates. What happened and what do you do?**

**A:** The job intentionally or configurably skipped 12k items — likely validation failures, parse errors, or write constraint violations covered by `skip(...)`. Cause is not "batch lost data" but fault tolerance absorbing errors. Pull quarantine logs / `SkipListener` output; query dead-letter table. Fix source file or mapping; do not rerun without idempotency check on the 88k written rows. Add alert: `skipCount > 0` → page on-call for financial jobs. Reprocess only bad keys from quarantine with a dedicated repair job.

**Q2: Operators restart a failed job but it processes the entire file again. Duplicates appear. Root cause?**

**A:** Reader not implementing `ItemStream` checkpointing (`open`/`update`/`close`), or `saveState(false)` on flat file reader, or custom reader storing cursor only in instance field. Restart loaded empty `ExecutionContext` and started from beginning. Writer was non-idempotent (`INSERT` only). Fix reader state + upsert writer; backfill dedup script; use `RunIdIncrementer` only when full rerun is intended.

**Q3: Two Kubernetes pods start the same import at 02:00. One succeeds, one throws `JobExecutionAlreadyRunningException` — but you still see duplicate rows. How?**

**A:** Race before `JobRepository` lock: two launchers if one bypassed launcher (manual step trigger) or second job used slightly different parameters (different `run.id`, non-identifying file path typo). Or duplicates from **partial first run + restart**, not concurrent pods. Check two `JOB_EXECUTION_ID` with overlapping times; compare `BATCH_JOB_EXECUTION_PARAMS`. Enforce `CronJob concurrencyPolicy: Forbid`, single scheduler, `JobExecutionAlreadyRunningException` not swallowed, idempotent writes as backstop.

**Q4: `OptimisticLockingFailureException` in metadata tables during partitioned job. Why?**

**A:** Too many workers updating master's or shared `StepExecution` metadata concurrently, or multi-threaded step with high chunk commit rate on single step execution. Reduce partition count, increase chunk size, tune pool, or separate metadata DB. Ensure each partition has distinct worker `StepExecution` (partitioning model correct).

**Q5: Job hangs at `STARTED` forever. No CPU. What do you check?**

**A:** Blocked reader — JDBC cursor waiting on lock, SFTP hung connection, infinite blocking queue in remote chunking, or thread pool deadlock. Thread dump all pods. DB `pg_locks` / Oracle blocking sessions. Check external file mount availability. Hung partition straggler in partition step — master waits for all partitions. K8s liveness not killing because thread blocked in native I/O.

**Q6: After Boot upgrade, job fails with `JobInstanceAlreadyCompleteException` on first deploy night.**

**A:** Parameters identical to previous successful run without `RunIdIncrementer`. Or scheduler sends same `fileDate` and identifying params. Add incrementer or change identifying param strategy. Educate ops: restart vs rerun. Check test data in prod DB from manual run same params.

**Q7: Chunk size 5000 causes OOM but 500 is slow. Strategy?**

**A:** OOM from large item payload or JPA persistence context — not chunk size alone. If objects are huge, reduce chunk, stream fields, JDBC not JPA, process to staging narrow rows. If objects small, OOM may be processor aggregation — fix memory leak. Tune JDBC batch and connection pool instead of tiny chunks. Consider partition parallelism over micro-chunks.

**Q8: `JdbcPagingItemReader` returns duplicates after DB maintenance rebuilt index.**

**A:** Sort key not unique — typical `ORDER BY updated_at` without `id`. Concurrent updates during job shift pages. Fix sort keys to unique composite. Maintenance unrelated unless index on sort column missing caused bad plan — verify explain plan, add index on `(updated_at, id)`.

**Q9: Tasklet truncate-and-load job failed mid-load. Why is restart dangerous?**

**A:** Truncate step `COMPLETED`; restart skips truncate, load continues into partially filled staging → duplicates or PK violations. Use `preventRestart()` on job or `allowStartIfComplete(false)` on truncate with manual ops playbook, or staging table swap pattern (load to `staging_new`, atomic rename). NO_RESTART jobs need runbook.

**Q10: Multi-threaded step with `JdbcCursorItemReader` — no speedup. Expected?**

**A:** Yes. Cursor + synchronized read serializes all threads. Switch to partitioning with `JdbcPagingItemReader` per partition or key-range splits. MT step helps when read is cheap and process/write expensive **and** reader supports concurrent read (rare with cursor).

**Q11: How do you schedule a batch job without `@Scheduled` inside a 10-replica API deployment?**

**A:** K8s CronJob separate workload; or dedicated batch runner pod; Quartz cluster with JDBC store; external orchestrator hitting admin endpoint protected by auth. API replicas run `spring.batch.job.enabled=false`. Never `@Scheduled` job launcher on scaled API.

**Q12: ItemWriteListener publishes to Kafka `afterWrite`. Downstream sees duplicates on job restart. Fix?**

**A:** `afterWrite` still inside chunk transaction boundary depending configuration; restart/redelivery duplicates regardless. Use transactional outbox in same DB TX as writer, or publish in `afterChunk` post-commit with idempotent consumers, or dedup key in downstream. Prefer outbox for exactly-once semantics.

**Q13: `READ_COUNT` is 1M, `WRITE_COUNT` is 0, job `COMPLETED`. Explain.**

**A:** Processor filters all (`return null`) — check `FILTER_COUNT`. Or writer writing to different datasource than verification query. Or `assertUpdates(false)` and SQL matched zero rows silently. Or job completed wrong step only. Misconfigured `Flow` skipped write step. Investigate processor logic and `FILTER_COUNT`, flow graph, writer datasource.

**Q14: Partition 7 of 16 always times out. Others fine.**

**A:** Data skew — hot key range in partitioner bounds. Rebalance ranges using quantile stats from `SELECT id, ntile(16) OVER (ORDER BY id)`. Consider salting hot keys in source. Straggler partition dominates job time.

**Q15: Spring Batch Integration remote chunking — master CPU high, workers idle.**

**A:** Master-bound reader shipping chunks — classic remote chunking bottleneck. Master reads every item. Remedy: partition with local readers per worker, or increase chunk shipping efficiency, or abandon remote chunking for partition model. Check queue routing misconfiguration starving workers.

**Q16: Test H2 green, production Oracle `ORA-08103` during batch read.**

**A:** Cursor reader on table undergoing partition maintenance or `DELETE`/`INSERT` bulk ops same table. Use paging reader with snapshot isolation, read from staging copy, or run batch during maintenance window. H2 doesn't reproduce Oracle MVCC behavior.

**Q17: Job parameters `fileDate` wrong timezone — processed yesterday's file on UTC vs EST cron.**

**A:** Scheduler uses `LocalDate.now()` server TZ; cron TZ differs from business TZ. Standardize `ZoneId` in parameter builder: `LocalDate.now(ZoneId.of("America/New_York"))`. Document in runbook. Use K8s `timezone` in CronJob spec (1.27+).

**Q18: `spring.batch.job.enabled=true` caused job on every deploy. One-time mitigation and permanent fix?**

**A:** Mitigation: kill running execution, reconcile business data if partial. Permanent: `spring.batch.job.enabled=false`, explicit launcher; readiness probe shouldn't trigger job. Add deploy checklist. Use `ApplicationRunner` guarded by profile `batch-runner` only on CronJob image.

**Q19: How to test restart behavior without flaky 2-hour jobs?**

**A:** `@SpringBatchTest` with small fixture file (100 lines), mock failing writer on second chunk using `ItemWriter` proxy throws once, `JobRepositoryTestUtils` update execution to FAILED, `JobOperator.restart()`, assert line 51-100 only written once cumulatively, not 1-100 twice. Testcontainers metadata tables.

**Q20: Metadata DB grew to 400GB. JobExplorer UI unusable. Architecture response?**

**A:** Retention tasklet: delete executions older than 90 days in batches. Archive to S3 parquet if audit required. Index `JOB_EXECUTION_ID`, `CREATE_TIME`. Consider separate metadata RDS instance. `RunIdIncrementer` inflates instances — retention mandatory. Do not store large blobs in `EXIT_MESSAGE`.

---

*Spring Batch will not make a non-idempotent pipeline safe. The framework checkpoints reads and counts writes; your job design owns deduplication, skew, scheduling, and the reconciliation that proves the numbers match finance.*
