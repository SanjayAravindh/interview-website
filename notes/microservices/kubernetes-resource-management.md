# Kubernetes Resource Management Mastery — Senior Production Reference

Kubernetes 1.28+ / containerd / CNI (Calico/Cilium/AWS VPC CNI). Spring Boot 3.x / Java 17+ JVM workloads are the default examples; stateless APIs, batch jobs, and data-heavy services are called out explicitly. This is not a `kubectl explain resources` cheat sheet. It is the map of what actually breaks in production after you set `requests: cpu: 100m`, enable HPA, trust VPA recommendations, and discover that **scheduling is easy — staying scheduled under load, node failure, and cluster upgrades is the job**.

The focus is requests/limits, QoS and eviction, autoscaling at pod/node/cluster layers, disruption budgets during voluntary maintenance, and the operational patterns that separate "we have HPA" from "we scale safely without OOM loops, pending pods, and surprise node bills."

---

## Table of Contents

1. [1. Mental Model: One Pod Through the Scheduler and Autoscalers](#1-mental-model-one-pod-through-the-scheduler-and-autoscalers)
2. [2. Resource Requests & Limits](#2-resource-requests--limits)
3. [3. QoS Classes, Eviction, and OOM Behavior](#3-qos-classes-eviction-and-oom-behavior)
4. [4. LimitRanges & ResourceQuotas](#4-limitranges--resourcequotas)
5. [5. Horizontal Pod Autoscaler (HPA)](#5-horizontal-pod-autoscaler-hpa)
6. [6. Vertical Pod Autoscaler (VPA)](#6-vertical-pod-autoscaler-vpa)
7. [7. Cluster Autoscaler](#7-cluster-autoscaler)
8. [8. Pod Disruption Budget (PDB)](#8-pod-disruption-budget-pdb)
9. [9. Combining HPA, VPA, Cluster Autoscaler, and PDB](#9-combining-hpa-vpa-cluster-autoscaler-and-pdb)
10. [10. JVM and Workload-Specific Sizing](#10-jvm-and-workload-specific-sizing)
11. [11. Production Debugging Playbook](#11-production-debugging-playbook)
12. [12. Quick Decision Matrix](#12-quick-decision-matrix)
13. [13. Scenario-Based Questions](#13-scenario-based-questions)

---

## 1. Mental Model: One Pod Through the Scheduler and Autoscalers

Kubernetes resource management is not "set memory and forget." It is a **pipeline of admission, scheduling, cgroup enforcement, eviction, autoscaling decisions, and voluntary disruption gates** that run continuously while traffic, node health, and cloud billing change underneath you.

```
Pod spec (requests/limits)
  └─ Admission: LimitRange / ResourceQuota / VPA webhook (mutating)
       └─ Scheduler: filter nodes with allocatable ≥ sum(requests)
            └─ kubelet: cgroup v2 limits CPU/memory; CFS quota for CPU
                 ├─ Container runtime starts process
                 ├─ metrics-server / Prometheus → HPA controller
                 ├─ VPA recommender → VPA updater (optional mutate)
                 └─ Under pressure: kubelet evicts BestEffort → Burstable → Guaranteed (by priority)
                      └─ Cluster Autoscaler watches Pending pods + node utilization
                           └─ Scale-up ASG/MIG/VMSS OR scale-down empty/underutilized nodes
                                └─ Voluntary disruption: drain node → PDB checks minAvailable
                                     └─ Rolling update / cluster upgrade proceeds or blocks
```

Five objects you must keep distinct:

| Object | Question it answers | Who enforces it |
|---|---|---|
| **Request** | How much capacity must the scheduler **reserve** on a node? | Scheduler (placement); used in `Request/Limit` ratio for QoS |
| **Limit** | What is the **hard ceiling** the container may consume? | kubelet + cgroup; OOM kill if memory exceeded |
| **HPA** | How many **replicas** should this workload run? | HPA controller → Deployment/StatefulSet `.spec.replicas` |
| **VPA** | How big should each **pod** be (CPU/memory)? | VPA recommender/updater → Pod spec resources |
| **PDB** | How many pods may be **voluntarily** disrupted at once? | eviction API / `kubectl drain` / Deployment controller |

A pod stuck in **Pending** usually means **no node has enough allocatable capacity for its requests** (or affinity/taint blocks placement) — not that the cluster is "full" in a human sense. A pod in **Running** that gets **OOMKilled** means **memory limit exceeded** (or node-level OOM picked your container) — not that HPA failed. A deployment that **never finishes rolling** during node drain usually means **PDB blocked eviction** or **Cluster Autoscaler couldn't add capacity**. Mixing those three up sends you to tweak HPA when you need to fix requests.

### The resource safety triangle

```
                    ┌─────────────────┐
                    │ Honest requests  │
                    │ (scheduling truth)│
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────────┐     │     ┌────────▼────────┐
     │ Limits + QoS that │     │     │ Autoscaling stack │
     │ match real usage  │     │     │ (HPA/VPA/CA/PDB)  │
     └─────────────────┘     │     └─────────────────┘
                             │
                    ┌────────▼────────┐
                    │ Observability on │
                    │ saturation signals│
                    └─────────────────┘
```

Remove any leg and "autoscaling works" becomes "we got lucky until Black Friday."

### Production scenario: green metrics, red scheduling

**Problem.** `orders-service` HPA shows CPU at 40%. No scale-up. Latency P99 spikes. `kubectl get pods` shows three pods **Pending** for twenty minutes. Events: `0/12 nodes are available: 12 Insufficient cpu`.

**Cause chain:** Last deploy raised `replicas` via HPA to 12 during a sale. Each pod requests `cpu: 2000m` because someone copied a template from the batch job. Cluster has twelve nodes × ~7900m allocatable after system/kube-reserved — total schedulable CPU ~95 cores. Twelve pods × 2 cores = 24 cores requested for this Deployment alone, but **other workloads already consume the slack**. Pending pods are not "waiting for HPA" — they are **unschedulable**.

**Solution checklist:**

```yaml
# Right-size requests from production metrics (P95 utilization + headroom)
resources:
  requests:
    cpu: "500m"
    memory: "768Mi"
  limits:
    cpu: "2000m"      # allow burst; CPU is compressible
    memory: "1Gi"     # hard cap; must exceed JVM heap + native + metaspace
```

```bash
# Diagnose scheduling
kubectl describe pod orders-service-xxx | grep -A5 Events
kubectl describe node | grep -A20 Allocated
kubectl top pods -n checkout --containers
```

Rules that save incidents:

- **Requests are scheduling promises.** Inflated requests cause Pending pods; deflated requests cause node overload and eviction storms.
- **HPA scales replicas, not node size.** Pending pods with "Insufficient resources" need smaller requests, more nodes (Cluster Autoscaler), or quota increase — not a higher HPA max.
- **Always check Pending before blaming the app.** The scheduler is a gate most developers forget exists.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No requests/limits set | BestEffort QoS; first evicted; no fair scheduling; HPA CPU % meaningless |
| `requests == limits` on CPU for all pods | No CPU burst; throttling at request ceiling; latency spikes under load |
| Memory request << actual RSS | Node overcommit; node-level OOM; random pod kills |
| Memory limit == JVM `-Xmx` | OOMKilled — no room for metaspace, thread stacks, direct buffers |
| HPA on Deployment Git-managed replicas | GitOps fight; flapping between Git and HPA |
| VPA Auto + HPA on same CPU metric | Fight; unstable replica count and pod sizes |
| PDB `minAvailable: 100%` on single-replica Deployment | Any drain/upgrade blocked forever |
| Cluster Autoscaler max nodes too low | Permanent Pending pods during scale events |

### Debugging scenario

**Observe.** After deploy, new pods Pending. Old pods fine. No OOM. HPA desired replicas = 8, current = 5, ready = 5.

**Diagnose.**

```bash
kubectl get pods -l app=orders-service -o wide
kubectl describe pod <pending-pod> | tail -20
kubectl get events --field-selector reason=FailedScheduling --sort-by='.lastTimestamp'
kubectl describe nodes | grep -E "Name:|Allocatable:|Allocated resources:" -A6
```

Read the scheduler message verbatim: `Insufficient cpu`, `Insufficient memory`, `didn't match Pod's node affinity`, `Too many pods`, `node(s) had taint`. Each has a different fix.

**Fix.** If `Insufficient cpu`: reduce requests or add nodes. If affinity: fix topology spread or node pool labels. If taint: add toleration or use correct node pool. Do not raise HPA max until scheduling succeeds.

---

## 2. Resource Requests & Limits

### Core concept

Every container in a pod may declare **requests** and **limits** for `cpu` and `memory` (and optionally `hugepages`, `ephemeral-storage`, `nvidia.com/gpu`, etc.). These are not suggestions — they drive **scheduling**, **QoS class**, **cgroup enforcement**, and **HPA utilization math**.

| Field | Scheduler | kubelet cgroup | Behavior when exceeded |
|---|---|---|---|
| `requests.cpu` | Subtracts from node allocatable | CPU shares / weight | N/A — request is not a cap |
| `limits.cpu` | Ignored for placement | CFS quota (`cpu.max`) | Throttling (compressible) |
| `requests.memory` | Subtracts from node allocatable | May affect accounting | N/A |
| `limits.memory` | Ignored for placement | `memory.max` | OOM kill (incompressible) |

**CPU is compressible.** A container can be throttled below its limit when the node is busy. **Memory is not compressible.** Exceeding memory limit → kernel OOM killer inside the cgroup → container restart with `OOMKilled`.

Extended resources (GPUs, custom FPGA devices) use the same request/limit pattern but are **non-compressible** like memory — scheduling is all-or-nothing.

### Internal working

1. **Admission:** API server accepts pod; mutating webhooks (VPA, policy engines) may patch resources. `LimitRange` defaults apply if container omits fields. `ResourceQuota` rejects if namespace totals exceeded.
2. **Scheduling:** `kube-scheduler` scores nodes where `sum(requests) + new pod requests ≤ node allocatable`. Limits do **not** affect whether a pod fits — only requests do. This is why a node can accept pods whose **limits sum to more than physical capacity** (overcommit).
3. **Binding:** Pod assigned to node; kubelet admits if still within quota and cgroup hierarchy can be created.
4. **Execution:** kubelet sets cgroup limits. For CPU: CFS quota = `limit.cpu × period` (default period 100ms). For memory: `memory.max = limit`. If no limit, memory is unbounded at container level (node OOM risk).
5. **Accounting:** `kubectl top` uses metrics-server (cAdvisor summary). HPA uses `metrics.k8s.io` API — typically CPU average **as fraction of request**, not limit.

**CPU unit math:**

| Value | Meaning |
|---|---|
| `1` or `1000m` | One logical CPU (one hyperthread on most clouds) |
| `500m` | Half a core |
| `0.1` | 100 millicores |

**Memory unit math:**

| Value | Meaning |
|---|---|
| `128974848` | Bytes (avoid in YAML) |
| `129Mi` | Mebibytes (2^20) — preferred |
| `128M` | Megabytes (10^6) — cloud billing often uses decimal |

Always use `Mi`/`Gi` in manifests to match kubelet/cgroup reporting.

### Init containers and sidecars

Resources on **init containers** use the **max** of init container requests/limits across all inits for scheduling purposes (the pod must fit the worst init peak). Regular containers **sum**. With **sidecars** (native sidecar containers in 1.28+ `restartPolicy: Always`), sidecars count in the sum like any container.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: checkout
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orders-api
  template:
    metadata:
      labels:
        app: orders-api
    spec:
      containers:
        - name: app
          image: registry.example.com/orders-api:sha256:abc123
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "500m"
              memory: "768Mi"
            limits:
              cpu: "2000m"
              memory: "1Gi"
          # Spring Boot: see section 10 for JVM alignment
        - name: otel-agent
          image: otel/opentelemetry-collector-contrib:0.96.0
          resources:
            requests:
              cpu: "50m"
              memory: "128Mi"
            limits:
              cpu: "200m"
              memory: "256Mi"
```

Pod-level effective request: CPU `550m`, memory `896Mi`. Forgetting the sidecar in capacity planning is a classic "mysterious Pending" during mesh/observability rollouts.

### Production scenario: copy-paste limits from the laptop

**Problem.** Developer runs Spring Boot locally with `-Xmx2g` on a 16 GB machine. Production manifest:

```yaml
resources:
  requests:
    memory: "2Gi"
  limits:
    memory: "2Gi"
```

Pods OOMKilled within minutes under load. JVM heap is 2 Gi but **container limit is 2 Gi** — metaspace (~100–256 Mi), thread stacks, Netty direct memory, and GC overhead exceed the cgroup cap. Exit code 137.

**Solution:**

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "768Mi"
  limits:
    cpu: "2000m"
    memory: "1536Mi"   # ~1.5 Gi total; heap capped at ~1 Gi via MaxRAMPercentage
env:
  - name: JAVA_TOOL_OPTIONS
    value: "-XX:MaxRAMPercentage=65.0 -XX:+ExitOnOutOfMemoryError"
```

Sizing workflow that survives audits:

1. Run load test in staging with **no memory limit**; observe P95 RSS via Prometheus `container_memory_working_set_bytes`.
2. Set **request** ≈ P95 steady-state (or P80 if cost-sensitive).
3. Set **limit** ≈ P99 peak + 15–20% headroom for spikes.
4. Set JVM heap via `MaxRAMPercentage` of **limit**, not request.

### Production scenario: CPU throttling with requests equal to limits

**Problem.** Latency SLO missed during business hours. Grafana shows CPU throttling:

```
rate(container_cpu_cfs_throttled_seconds_total[5m]) > 0
```

Manifest has `requests.cpu: 1000m` and `limits.cpu: 1000m`. Java GC and servlet threads spike briefly; CFS quota prevents burst; requests queue; P99 latency climbs while average CPU looks "fine."

**Solution.** Separate request from limit — request reflects **sustained** need; limit reflects **burst tolerance**:

```yaml
resources:
  requests:
    cpu: "500m"     # scheduler placement; HPA denominator
  limits:
    cpu: "2000m"    # burst headroom
```

For latency-critical services, also check **thread pool sizing** and **GC** — throttling is a symptom; fixing only limits without understanding load pattern recreates the issue at higher scale.

### Production scenario: no limits — node OOM kills the wrong pod

**Problem.** Data team deploys Spark executor pods with memory **requests only**, no limits. Batch job allocates large off-heap buffers. Node memory exhausted. Kernel OOM killer selects a pod on the same node — often **checkout-service** with Guaranteed QoS but high reclaim cost, or a BestEffort logging agent. Intermittent 502s unrelated to the batch job's namespace.

**Solution.** Always set memory **limits** for workloads that can grow heap/off-heap. Isolate batch on dedicated node pools with taints:

```yaml
# Batch namespace — strict limits
resources:
  requests:
    memory: "4Gi"
    cpu: "2"
  limits:
    memory: "4Gi"    # equal → Guaranteed for batch stability
    cpu: "4"
tolerations:
  - key: "workload"
    operator: "Equal"
    value: "batch"
    effect: "NoSchedule"
nodeSelector:
  nodepool: batch
```

Use **LimitRange** (section 4) to prevent unlimited containers in tenant namespaces.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Limits without requests | Scheduler may not reserve; unpredictable placement; QoS Burstable with odd ratios |
| `cpu: 0` request with limit | Treated as unset request in older docs; use explicit small request |
| Huge CPU request, tiny usage | Node "full" while `kubectl top` shows 5% utilization; wasted cloud spend |
| Ephemeral storage ignored | Disk pressure eviction; emptyDir fills; logs unrotated |
| Different resources per environment not in Git | Staging "works"; prod Pending or OOM |
| Forgot pod overhead (1.28+) | Very tight nodes fail admission — rare but real on tiny instances |

### Debugging scenario

**Observe.** Container restart count climbing. `kubectl describe pod` shows `Last State: Terminated, Reason: OOMKilled, Exit Code: 137`.

**Diagnose.**

```bash
kubectl describe pod <pod> | grep -E "Limits|Requests|State|Reason"
kubectl logs <pod> --previous | tail -50
# Prometheus
# container_memory_working_set_bytes vs kube_pod_container_resource_limits
```

Distinguish **cgroup OOM** (137, limit in describe) from **JVM OutOfMemoryError** (exit 1, heap dump in logs). Fix path differs: cgroup → raise limit / lower heap; heap → leak or undersized `-Xmx`.

**Fix.** Align limit, JVM MaxRAMPercentage, and actual RSS from metrics. Add memory alert at 85% of limit for early warning.

---

## 3. QoS Classes, Eviction, and OOM Behavior

### Core concept

Kubernetes assigns each pod a **Quality of Service (QoS) class** based solely on resource fields — no annotation required:

| QoS class | Condition | Eviction order (node pressure) |
|---|---|---|
| **Guaranteed** | Every container has memory & CPU limits set; limits == requests (for memory and CPU) | Last evicted |
| **Burstable** | At least one container has request or limit; not all Guaranteed | Middle |
| **BestEffort** | No requests/limits on any container | First evicted |

Eviction is **not** the same as OOM kill. **Eviction** is kubelet proactively deleting pods when node signals `DiskPressure`, `MemoryPressure`, or `PIDPressure`. **OOM kill** is kernel killing a process inside a cgroup when memory limit exceeded.

PriorityClass adds another axis: higher `priorityClassName` values are less likely evicted when `Priority` feature enabled and kubelet uses `priority` in eviction sorting.

### Internal working

When node memory pressure crosses thresholds (`memory.available` soft/hard eviction thresholds in kubelet config):

1. kubelet sets `NodeCondition MemoryPressure=True`.
2. kubelet ranks pods: BestEffort first, then Burstable pods exceeding requests, then others by usage vs request.
3. Pod terminated with reason `Evicted`; controller recreates if owned by ReplicaSet (subject to PDB and scheduling).
4. For cgroup OOM: only the offending container in that pod dies; kubelet restarts per `restartPolicy`.

Guaranteed pods **can still be OOMKilled** if they exceed memory limit — QoS protects against **node-level** eviction, not **self-inflicted** limit breach.

### Production scenario: logging agent BestEffort takes down the node

**Problem.** DaemonSet log forwarder shipped without resources:

```yaml
containers:
  - name: fluent-bit
    image: fluent/fluent-bit:2.2
    # no resources block
```

Under log spike, fluent-bit buffers in memory (BestEffort). Node hits MemoryPressure. kubelet evicts random application pods. HPA adds replicas; they land on same pressured nodes; cascade.

**Solution:**

```yaml
resources:
  requests:
    cpu: "100m"
    memory: "128Mi"
  limits:
    memory: "512Mi"
```

For DaemonSets, **requests matter for scheduling** on every node — size for peak buffer, not idle. Consider `priorityClassName: system-node-critical` only for truly critical agents (with platform team approval).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| All pods Guaranteed with limits == requests | Safe from eviction but no CPU burst; expensive; throttling |
| Mix BestEffort app pods with strict SLO | First casualties during any node stress |
| Ignoring PriorityClass | Critical platform pods evicted before junk |
| Liveness probe on memory-hungry path | Restart loops instead of eviction; harder to debug |

### Debugging scenario

**Observe.** Pods disappear with `Reason: Evicted`, message `The node was low on resource: memory`.

**Diagnose.** Check node conditions, pod QoS, and who else was on the node:

```bash
kubectl describe node <node> | grep -A5 Conditions
kubectl get pods --field-selector spec.nodeName=<node> -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
```

**Fix.** Right-size or isolate noisy neighbors; add nodes; fix memory leaks; set limits on DaemonSets; use dedicated node pools for memory-heavy workloads.

---

## 4. LimitRanges & ResourceQuotas

### Core concept

**LimitRange** sets **defaults/constraints per pod/container** in a namespace. **ResourceQuota** sets **aggregate caps** for the namespace. Together they prevent one team from submitting a thousand zero-request pods or a single pod requesting 128 cores.

| Resource | Scope | Typical use |
|---|---|---|
| `LimitRange` | Pod/container min/max/default | Default 256Mi request; max 4Gi limit per container |
| `ResourceQuota` | Namespace sum | Max 20 CPU requests, 40Gi memory requests total |

### Internal working

On pod **create/update**, admission controller `LimitRange` plugin:

- Applies default requests/limits if container omits them.
- Rejects if below min or above max per LimitRange.
- Validates pod-level min/max if configured.

`ResourceQuota` plugin sums existing pods' requests/limits + new pod; rejects with `exceeded quota` if over cap. Quota counts **terminating** pods until fully gone — bursts during rollouts can hit quota temporarily.

**Quota scopes:** `BestEffort`, `NotBestEffort`, `Terminating`, `NotTerminating`, `PriorityClass` — allows different quotas for prod vs batch priority.

### Production scenario: namespace quota blocks HPA scale-up

**Problem.** HPA wants 50 replicas; stuck at 30. Events: `failed quota: cpu: must be less than or equal to 30`. Each pod requests `1` CPU; quota `requests.cpu: "30"`.

**Solution.** Raise quota after capacity review, or reduce per-pod requests with evidence from metrics:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: checkout-compute
  namespace: checkout
spec:
  hard:
    requests.cpu: "80"
    requests.memory: 160Gi
    limits.cpu: "160"
    pods: "200"
```

Document quota changes in the same change ticket as HPA max adjustment — they are one decision.

### Production scenario: LimitRange defaults create hidden HPA denominator shift

**Problem.** LimitRange injects `requests.cpu: 500m` default. Team deploys app expecting `100m` request. HPA target 70% CPU now means 350m absolute — never triggers scale-up while latency degrades from thread starvation.

**Solution.** Explicit requests on every production container; treat LimitRange defaults as **dev namespace only**:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: dev-sane-defaults
  namespace: dev
spec:
  limits:
    - default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 256Mi
      type: Container
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Quota on limits but not requests | Scheduler overcommits requests; node thrashing |
| No object count quota | etcd/API stress from thousands of pods |
| Same quota for dev and prod namespaces | Dev blocked or prod unbounded |
| Forgot quota for `persistentvolumeclaims` | Storage sprawl |

---

## 5. Horizontal Pod Autoscaler (HPA)

### Core concept

HPA adjusts **replica count** of a scalable resource (`Deployment`, `StatefulSet`, `ReplicaSet`, or custom scale target via CRD) based on observed metrics compared to targets. It does **not** change pod CPU/memory size — that is VPA. It does **not** add nodes — that is Cluster Autoscaler when Pending pods result.

Supported metric sources (metrics API v2):

| Metric type | Example | Notes |
|---|---|---|
| Resource | CPU, memory utilization % | Utilization = usage / **request** (not limit) |
| Pods | Custom pod metrics | Per-pod average |
| Object | Ingress QPS, Service metric | Requires metric adapter |
| External | CloudWatch, Pub/Sub lag | Cluster-wide; requires adapter |

### Internal working

1. **HPA controller** (control plane) polls metrics every `syncPeriod` (default 15s; `--horizontal-pod-autoscaler-sync-period`).
2. For each metric, computes desired replicas:

   ```
   desiredReplicas = ceil(currentReplicas × (currentMetricValue / targetMetricValue))
   ```

   For multiple metrics, takes **max** of desired counts (most conservative scale-up).
3. Applies **tolerance** (default 10% — no change if within band) and **stabilization windows** (scale-down slow, scale-up can be fast since 1.18+ behavior policies).
4. Clamps to `minReplicas` / `maxReplicas`. Writes `scale` subresource.
5. Deployment controller reconciles ReplicaSet; scheduler places new pods.

**Important defaults (1.28+):**

- `autoscaling/v2` is the stable API; v1 (CPU only) is legacy.
- Scale-down stabilization default 300s prevents flapping.
- `--horizontal-pod-autoscaler-cpu-initialization-period` (5 min): ignores CPU samples on new pods until warmup.

### Example manifest — production-grade HPA

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders-api
  namespace: checkout
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders-api
  minReplicas: 3
  maxReplicas: 40
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 75
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
        - type: Pods
          value: 4
          periodSeconds: 60
      selectPolicy: Min    # take slower of policies to avoid shock
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
```

Custom metric example (Kafka lag via Prometheus adapter):

```yaml
    - type: External
      external:
        metric:
          name: kafka_consumer_group_lag
          selector:
            matchLabels:
              consumergroup: orders-processor
              topic: order-events
        target:
          type: AverageValue
          averageValue: "1000"
```

### Production scenario: HPA never scales — CPU metric missing

**Problem.** HPA status: `<unknown>` for CPU. `kubectl describe hpa` → `unable to get metric cpu: unable to fetch metrics from resource metrics API`.

**Cause:** metrics-server not installed, broken, or network policy blocks kubelet scrape. Without metrics-server, resource metrics API empty.

**Solution:**

```bash
kubectl top nodes
kubectl get apiservice v1beta1.metrics.k8s.io -o yaml
kubectl logs -n kube-system -l k8s-app=metrics-server
```

Fix metrics-server TLS/kubelet cert config. For custom metrics, verify Prometheus adapter registers APIService.

### Production scenario: HPA scales wildly on Java CPU during warmup

**Problem.** Deploy at 9 AM; HPA ramps 3 → 40 replicas in ten minutes; most pods idle; Cluster Autoscaler adds nodes; bill spikes. JVM JIT + class loading drives CPU to 100% of **request** on every new pod during first 3 minutes.

**Solution.**

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 120
    policies:
      - type: Pods
        value: 2
        periodSeconds: 60
spec:
  minReplicas: 3   # never below HA floor
```

Add **readiness** that includes warmup (e.g., Spring `ApplicationReadyEvent` + synthetic check). Consider **requests** based on steady-state CPU so initialization spike is lower **relative** to target. Use **PodDisruptionBudget** and **maxSurge** so rollouts don't trigger scale storm.

### Production scenario: memory-based HPA OOM loop

**Problem.** HPA on memory utilization at 80%. Scales up replicas. Memory per pod unchanged (RSS per instance constant). Total cluster memory rises linearly with replicas. Eventually node OOM or all pods memory-high — **memory utilization % does not improve** by adding replicas for stateful-in-memory caches.

**Cause:** Memory HPA works when memory scales with **per-request footprint** (some queue workers). It fails when each replica holds **full cache copy** — more replicas = more total memory.

**Solution.** Fix architecture (distributed cache, smaller heap) or scale **vertically** (VPA/larger requests) not horizontally. Use CPU + custom lag metrics for scale signal; memory as **ceiling** alert only.

### Production scenario: GitOps vs HPA replica fight

**Problem.** Argo CD `selfHeal: true`. Git says `replicas: 3`. HPA scales to 12. Argo reverts to 3. Traffic overload. Users see intermittent errors during sync windows.

**Solution.** Remove `spec.replicas` from Git (use Kustomize `replicas` field omitted + HPA) or configure ignore:

```yaml
# Argo CD Application
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
```

Document `minReplicas` in Git as comment or HPA manifest; runtime replicas owned by HPA.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| HPA maxReplicas > schedulable capacity | Pending pods; partial scale |
| Target CPU on I/O-bound app | Never scales; latency bad |
| No minReplicas ≥ 2 for HA | Scale to 1; outage on node drain |
| v1 HPA with memory | CPU only in v1 |
| Missing metrics adapter for custom metric | HPA stuck at min |
| Too aggressive scale-down | Cold start latency; cache loss |
| HPA on StatefulSet with ordered readiness | Slow scale; consider partitioning |

### Debugging scenario

**Observe.** HPA `DESIRED` flickers. Replica count oscillates.

**Diagnose.**

```bash
kubectl describe hpa orders-api
kubectl get --raw "/apis/autoscaling/v2/namespaces/checkout/horizontalpodautoscalers/orders-api/status" | jq .
```

Check `currentMetrics`, `conditions`, events. Look for conflicting metrics (CPU says scale up, memory says scale down — max wins).

**Fix.** Widen tolerance; increase scale-down stabilization; fix mis-set requests; remove redundant memory metric if counterproductive.

---

## 6. Vertical Pod Autoscaler (VPA)

### Core concept

VPA recommends and optionally **mutates** CPU/memory **requests and limits** for containers based on historical and current usage. It answers: "Should this pod be **bigger or smaller**?" — not "Should there be **more** pods?"

VPA components (installed separately — not in default cluster):

| Component | Role |
|---|---|
| **Recommender** | Computes recommended requests from usage time series |
| **Updater** | Evicts pods to apply new resources (in Auto mode) |
| **Admission Webhook** | Sets resources on pod create (Auto/Initial modes) |

Update modes:

| Mode | Behavior |
|---|---|
| `Off` | Recommendations only (view in VPA object status) |
| `Initial` | Set resources on pod **creation** only; no updates |
| `Recreate` | Apply changes by evicting pods when recommendation shifts |
| `Auto` | Deprecated alias for Recreate in many versions — evicts to update |

**Critical:** VPA historically **does not support** pods controlled by HPA on the **same CPU/memory metrics** without conflict. Use VPA for requests + HPA on custom/external metrics, or VPA `Off` for recommendations applied manually in Git.

### Internal working

1. Recommender reads metrics (metrics-server / Prometheus depending on install) per container.
2. Computes target request with safety margin (percentile + headroom); may adjust limits if configured.
3. In `Recreate`/`Auto`, Updater compares live pod resources to recommendation; if diff exceeds threshold and within `minReplicas`/budget, **evicts** pod (graceful); controller recreates with webhook-injected resources.
4. Admission webhook patches pod spec at create time.

VPA object example:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: orders-api-vpa
  namespace: checkout
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders-api
  updatePolicy:
    updateMode: "Recreate"
  resourcePolicy:
    containerPolicies:
      - containerName: app
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 4
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits   # or RequestsOnly
      - containerName: otel-agent
        mode: "Off"   # do not autoscale sidecar
```

View recommendations without applying:

```yaml
  updatePolicy:
    updateMode: "Off"
```

```bash
kubectl describe vpa orders-api-vpa
# read status.recommendation
```

### Production scenario: VPA evictions during peak traffic

**Problem.** VPA `Auto` on payment-service. Recommendation jumps at noon (legitimate traffic shape change). Updater evicts 6 of 10 pods simultaneously to resize. PDB allows 30% unavailable. Latency spike; payment timeouts.

**Solution.**

```yaml
updatePolicy:
  updateMode: Recreate
resourcePolicy:
  containerPolicies:
    - containerName: app
      minReplicas: 5   # if supported in your VPA version via update constraints
```

Operational pattern: VPA `Off` in prod peak hours; apply Git changes from recommendations in maintenance window. Or use **`Initial` only** for new deploys. Limit VPA maxAllowed to prevent runaway sizing. Coordinate with PDB `minAvailable`.

### Production scenario: VPA + HPA CPU fight

**Problem.** VPA lowers CPU request based on low idle usage overnight. Morning traffic: same absolute CPU now reads as **high utilization %** (usage/request). HPA scales out massively. VPA sees per-pod CPU drop, lowers requests again. Chaos by 10 AM.

**Solution — pick a split:**

| Pattern | VPA | HPA |
|---|---|---|
| Request tuning + traffic scale | `Off` or `Initial`; manual Git updates weekly | CPU or custom metrics |
| Automated sizing, fixed replicas | `Recreate` on requests | Disabled or fixed replicas |
| Mature split | VPA on memory requests only | HPA on CPU + external lag |

Google's guidance evolved — check your VPA version docs for "HPA compatible" recommender flags. When in doubt: **VPA Off for recommendations, human promotes to Git, HPA on CPU.**

### Production scenario: VPA breaks JVM heap assumptions

**Problem.** VPA raises memory request to 3 Gi; limit follows. JVM still configured with fixed `-Xmx1g`. Process uses 1.2 Gi RSS; VPA thinks pod is underutilized; lowers request next week; limit drops; OOM during GC spike.

**Solution.** Use `MaxRAMPercentage` tied to cgroup, not fixed `-Xmx`. Exclude JVM apps from VPA Auto until heap is container-aware:

```yaml
resourcePolicy:
  containerPolicies:
    - containerName: app
      mode: "Off"
```

Apply recommendations manually with JVM flags adjusted in same change.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| VPA Auto on single-replica Deployment | Eviction = downtime |
| VPA on DaemonSet | Unsupported / destructive |
| VPA on Job/CronJob | Wrong model — use job parallelism |
| No maxAllowed | One pod consumes entire node request |
| VPA on all containers including mesh | Sidecar resized incorrectly |
| Ignored recommendations in Off mode | Never act — drift continues |

### Debugging scenario

**Observe.** Pods restart frequently with `Evicted by VPA` or similar events (wording varies by version).

**Diagnose.**

```bash
kubectl describe vpa orders-api-vpa
kubectl get events --field-selector reason=Evicted -A
```

Compare `status.recommendation` vs live pod resources.

**Fix.** Switch to `Off`/`Initial`; tighten minAllowed/maxAllowed; schedule recommendation application in low-traffic window; fix HPA interaction.

---

## 7. Cluster Autoscaler

### Core concept

Cluster Autoscaler (CA) adjusts **node count** in a node group (AWS ASG, GKE MIG, AKS VMSS, Cluster API) so that **Pending pods can schedule** and **underutilized nodes can be removed** without violating scheduling constraints. It is **not** aware of application SLOs — only schedulable pod backlog and node utilization signals.

CA loop (simplified):

```
Every scan interval (~10s):
  IF pod Pending due to insufficient resources
    AND pod is schedulable (not affinity-trapped forever)
    AND pod passes CA priority/expendable filters
    AND node group below maxSize
    → scale up node group (+1 or burst per config)
  IF node underutilized (CPU+memory request utilization < threshold)
    AND all pods movable to other nodes
    AND no PDB/local storage blocking
    AND above minSize
    → drain and delete node
```

CA **simulates** scheduling with a fake scheduler predicate — if Pending pod wouldn't fit on a new node of that pool (e.g., GPU pod on non-GPU pool), no scale-up.

### Internal working

**Scale-up triggers:**

- Pod status `Pending`, event `FailedScheduling`, reason includes `Insufficient cpu/memory/pods`.
- Pod must request resources (BestEffort often **not** trigger scale-up — nothing to reserve).
- Pod must not exceed max node size (e.g., requests 64 CPU, node type 16 CPU — **never** scales).

**Scale-down triggers:**

- Node utilization below `--scale-down-utilization-threshold` (default 0.5 = 50% of **request** allocation).
- All pods on node can be rescheduled elsewhere in simulation.
- Respects `--skip-nodes-with-local-storage`, `--skip-nodes-with-system-pods`, PDB during drain.

**Expendable pods:** Pods with annotation `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` block scale-down of their node. Mirror pods, kube-system often protected.

Important flags (awareness for interviews and incidents):

| Flag | Effect |
|---|---|
| `--max-node-provision-time` | If node not Ready in time, CA may delete and retry |
| `--balance-similar-node-groups` | Spread scale-up across similar ASGs |
| `--skip-nodes-with-local-storage` | Default true — blocks scale-down |
| `--scale-down-delay-after-add` | Cooldown after scale-up before scale-down (default 10m) |
| `--scale-down-unneeded-time` | How long underutilized before candidate (default 10m) |

### Production scenario: Pending pods, CA silent

**Problem.** HPA scaled to 40 replicas; 15 Pending. CA logs show no scale-up. Events: `pod didn't trigger scale-up: 3 max node group size reached`.

**Cause:** ASG `maxSize=12` hit. Or: pod needs `gpu` resource; node group has no GPU. Or: topology spread `maxSkew=1` with 3 zones and imbalanced — CA adds node but scheduler still can't spread.

**Solution.**

```bash
kubectl logs -n kube-system deployment/cluster-autoscaler | tail -100
kubectl describe pod <pending> | grep -i "scale-up"
```

Raise maxSize with finance approval; add node pool matching pod requirements; relax spread constraints if overly strict; reduce pod requests.

### Production scenario: CA scale-down evicts during batch job

**Problem.** Nightly ETL runs as Job pods complete. CA sees node "empty enough." Scales down. Long-running checkout pods rescheduled; brief latency; PDB allows one disruption; still user-visible.

**Solution.** Separate node pools — **stable** pool with CA scale-down disabled or higher utilization threshold; **batch** pool with scale-to-zero pattern:

```yaml
# Node pool annotation (GKE example pattern)
# cloud.google.com/enable-autoscaling: "true"
# cluster-autoscaler.kubernetes.io/scale-down-disabled: "true"  on stable pool
```

Mark critical long-running pods:

```yaml
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
```

Use sparingly — blocks node consolidation, increases cost.

### Production scenario: over-provisioned cluster, CA won't scale down

**Problem.** Weekend traffic low. 30 nodes at 20% utilization. CA not removing nodes. Many pods have `safe-to-evict: false` from Helm chart copy-paste. DaemonSets and local storage on nodes.

**Solution.** Audit annotations. Remove false `safe-to-evict` unless justified. Use `--skip-nodes-with-local-storage` awareness — emptyDir-heavy pods block drain. Consider second pass: lower requests (VPA Off recommendations) so utilization threshold math improves.

### Production scenario: CA and cluster upgrade race

**Problem.** Platform upgrades node AMI. New nodes join. CA simultaneously scales up for Pending sale traffic. Quota on cloud account max instances hit. Half the cluster NotReady.

**Solution.** Freeze CA during platform maintenance window:

```bash
kubectl -n kube-system scale deployment cluster-autoscaler --replicas=0
# after maintenance
kubectl -n kube-system scale deployment cluster-autoscaler --replicas=1
```

Or use cloud-specific autoscaling suspend. Coordinate HPA max reduction during known maintenance.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Multiple CA leaders (split brain) | Duplicate scale-up; race — ensure one replica with leader election |
| CA version ≠ K8s minor version skew policy | Weird bugs; check compatibility matrix |
| Pod without requests | Pending forever; CA ignores |
| Pod too large for any node type | Permanent Pending; CA useless |
| Ignored PDB during scale-down | CA respects drain failure; node stays |
| ASG launch template mismatch | Nodes join NotReady; CA thrashes |

### Debugging scenario

**Observe.** Nodes added but pods still Pending.

**Diagnose.** CA log line `Scale-up failed` vs scheduler `FailedScheduling` after new node Ready. If new node has taint without toleration, pod stays Pending — CA won't help.

**Fix.** Align node pool labels/taints with pod `nodeSelector`/`tolerations`. Fix instance type SKU.

---

## 8. Pod Disruption Budget (PDB)

### Core concept

PDB limits **voluntary disruptions** — evictions caused by human or controller intent: `kubectl drain`, rolling update maxUnavailable, VPA eviction, CA scale-down drain. It does **not** stop **involuntary** disruptions: node hardware failure, kubelet kill, OOM, zone outage.

Two spec styles (mutually exclusive):

| Field | Meaning |
|---|---|
| `minAvailable` | At least N pods or N% must stay **available** |
| `maxUnavailable` | At most N pods or N% may be **unavailable** |

`minAvailable: 100%` on a Deployment with 3 replicas means **zero** voluntary disruptions allowed — drains and rollouts stall.

**Available** pod (for PDB): phase Running AND Ready condition True AND not terminating.

### Internal working

1. Eviction API `POST /api/v1/namespaces/{ns}/pods/{name}/eviction` checked against PDB.
2. If eviction would violate budget → HTTP 429 Too Many Requests; drain blocks.
3. Deployment rolling update respects PDB when calculating max unavailable pods.
4. Involuntary deletion bypasses PDB — design for redundancy across nodes/zones.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orders-api-pdb
  namespace: checkout
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: orders-api
```

For percentage workloads with HPA (3–40 replicas), prefer **`maxUnavailable: 25%`** or **`minAvailable: 75%`** over fixed `minAvailable: 2` which becomes too weak at high scale:

```yaml
spec:
  maxUnavailable: 25%
  selector:
    matchLabels:
      app: orders-api
```

### Production scenario: cluster upgrade stuck for six hours

**Problem.** Platform team drains nodes for kubelet upgrade. `kubectl drain` hangs: `Cannot evict pod orders-api-xxx: would violate PodDisruptionBudget`. PDB `minAvailable: 3`; Deployment currently has 3 replicas (one unhealthy Not Ready — counts as unavailable).

**Cause:** Effective available = 2 < minAvailable 3. Drain impossible until fourth healthy replica or PDB adjusted.

**Solution.**

```bash
kubectl get pdb -n checkout
kubectl get pods -l app=orders-api
# Fix Not Ready pod first — often bad deploy
kubectl describe pod orders-api-yyy
```

Temporary PDB patch only with change control:

```yaml
spec:
  minAvailable: 2   # was 3 during incident — revert after
```

Long-term: ensure **minReplicas** HPA ≥ minAvailable + headroom; fix unhealthy pods before maintenance.

### Production scenario: PDB minAvailable 100% on HA service

**Problem.** PDB copied from wiki: `minAvailable: 100%`. Any rolling deploy or node drain blocked. CI/CD pipeline timeout. Team deletes PDB "to unbreak" — next maintenance takes down all pods.

**Solution.** For 3-replica HA:

```yaml
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: orders-api
```

Allows one voluntary disruption; maintains quorum for 3-replica service.

### Production scenario: single-replica admin tool PDB

**Problem.** Internal admin UI: 1 replica. PDB `minAvailable: 1`. Every node drain blocked for this pod — platform escalates.

**Solution.** Either accept **no PDB** (admin can tolerate brief downtime during drain) or run **2 replicas** with session affinity and PDB. Do not set `minAvailable: 1` on 1 replica without acknowledging zero disruption tolerance.

### Production scenario: PDB selector mismatch — false confidence

**Problem.** PDB selects `app: orders-api`. Deploy adds label `version: v2` but keeps `app` label. Still matched. Good. Alternative failure: canary pods with label `app: orders-api-canary` **not** covered by PDB — drain kills all canaries silently (maybe OK). Worse: two Deployments share label `app: orders` — PDB protects both unintentionally; rollouts interfere.

**Solution.** PDB selector must match **exactly** the pods you intend. Use consistent label strategy:

```yaml
selector:
  matchLabels:
    app: orders-api
    tier: backend
```

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No PDB on critical Deployment | Node drain takes all pods; outage |
| minAvailable: 100% | All voluntary ops blocked |
| PDB with wrong selector | Unprotected pods evicted |
| Fixed minAvailable with large HPA max | Too many simultaneous disruptions allowed at high scale |
| PDB on StatefulSet without reading ordered readiness | Surprising sequential behavior |

### Debugging scenario

**Observe.** `kubectl drain` fails repeatedly.

**Diagnose.**

```bash
kubectl get pdb -A
kubectl describe pdb orders-api-pdb
# Look at DisruptionsAllowed — if 0, drain blocked
kubectl get pods -l app=orders-api -o wide
```

**Fix.** Restore healthy replica count; adjust PDB; fix Not Ready pods; temporarily scale up before drain to increase allowed disruptions.

---

## 9. Combining HPA, VPA, Cluster Autoscaler, and PDB

### Core concept

These four controls operate at different layers. They **interact** — rarely fail independently.

```
Traffic ↑
  → HPA increases replicas
    → If schedulable capacity exists: new pods Running
    → If Pending (Insufficient resources):
         → Cluster Autoscaler adds nodes (if configured)
         → If CA maxed or pod unschedulable: HPA blocked at partial scale
  → VPA (if Auto/Recreate) may evict pods to resize
    → PDB limits concurrent evictions
    → HPA may react to changed request denominators
  → Node drain (upgrade)
    → PDB limits evictions
    → CA may scale up elsewhere to absorb relocated pods
```

### Reference architecture — stateless Spring API (production)

```yaml
# Deployment: explicit resources; JVM tuned
# HPA: min 3, max 40, CPU 65%, slow scale-down
# VPA: Off — weekly review recommendations → Git PR
# PDB: maxUnavailable 25%
# Node pool: CA enabled, min 3 max 20, instance m6i.xlarge
# GitOps: ignore Deployment replicas
```

Decision flow during incident:

1. Pending pods? → Scheduler/CA/quota (sections 1, 4, 7).
2. OOMKilled? → Limits/JVM (sections 2, 10).
3. High latency, low CPU? → Throttling, DB, thread pools — not HPA (section 5).
4. Drain stuck? → PDB + unhealthy pods (section 8).
5. Bill spike? → HPA max, CA max, requests inflation, VPA maxAllowed (all).

### Production scenario: perfect storm Black Friday

**Timeline.**

- 08:00 — Traffic 3× normal. HPA scales 3 → 35 replicas in 20 minutes.
- 08:15 — 8 pods Pending. CA scales node pool 12 → 18.
- 08:20 — Namespace CPU quota at cap (forgotten from last year). HPA stuck at 27 replicas.
- 08:25 — On-call raises quota. Pending pods schedule.
- 08:30 — VPA `Auto` (misconfigured) evicts 10 pods for memory resize during peak. PDB allows 25% — 8 disruptions. Latency alert fires.
- 08:45 — VPA switched to Off; incident mitigated.

**Post-incident actions:**

1. Quota automation tied to HPA max × request.
2. VPA → Off with weekly Git workflow.
3. Load test validates CA max node and quota headroom at 2× expected peak.
4. Runbook documents disable order for VPA/CA during known events.

### Production scenario: cost optimization Friday

**Goal.** Reduce spend. Team lowers requests globally by 50%, enables aggressive CA scale-down, raises HPA target CPU to 80%, sets VPA Auto.

**Outcome Monday.** Widespread throttling; morning cold-start latency; two OOM incidents on memory-heavy services; checkout PDB blocked node recycle — savings real but SLO breached.

**Lesson.** Optimize **per service** with metrics — never global halving. Cost wins: right-size from VPA recommendations in Off mode, CA on batch pools only, retain HA minReplicas and PDB headroom.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| All four enabled defaults with no coordination | Incident roulette |
| No load test at HPA max × request | Surprise quota/CA ceiling |
| PDB too strict + aggressive VPA | Drain and resize both block or spike |
| Single node pool for batch and API | CA keeps batch nodes alive; API noisy neighbor |

---

## 10. JVM and Workload-Specific Sizing

### Core concept

Java containers violate naive "set limit = heap" intuition. The JVM consumes **heap + metaspace + code cache + thread stacks + direct memory + native GC structures**. Spring Boot 3 on Java 17+ respects cgroup limits when `UseContainerSupport` is default — but **you must leave headroom**.

Recommended pattern:

```yaml
env:
  - name: JAVA_TOOL_OPTIONS
    value: >-
      -XX:MaxRAMPercentage=65.0
      -XX:InitialRAMPercentage=50.0
      -XX:+UseG1GC
      -XX:+ExitOnOutOfMemoryError
resources:
  requests:
    cpu: "500m"
    memory: "768Mi"
  limits:
    cpu: "2000m"
    memory: "1536Mi"
```

| Workload type | Request strategy | HPA metric | VPA |
|---|---|---|---|
| Stateless REST API | P95 CPU/memory steady | CPU + optional RPS | Off → Git |
| Kafka consumer | Lag external metric | External lag | Memory Initial only |
| Batch Job | Fixed to peak | None (Job parallelism) | Off |
| Redis/cache | Memory ≈ data set | None or custom | Dangerous — size manually |
| NGINX proxy | Low CPU, conn-bound | CPU or custom | Off |

### Production scenario: Native memory leak mistaken for bad limits

**Problem.** Pod OOM at 2 Gi limit. Heap dump shows only 800 Mi used. Direct buffers (Netty/gRPC) grow unbounded.

**Solution.** Fix leak or cap direct memory:

```
-XX:MaxDirectMemorySize=256m
```

Raise limit only after understanding native footprint — otherwise delaying root cause.

---

## 11. Production Debugging Playbook

When scaling or scheduling is "random," it is usually **which controller owns the field**, **Pending vs Running failure**, or **PDB/eviction gate**.

1. **Classify the symptom.**

   | Signal | First look |
   |---|---|
   | `Pending` | Scheduler events, requests, CA logs, quota |
   | `OOMKilled` / 137 | Limits vs JVM vs leak |
   | HPA not scaling | metrics-server, requests denominator, target metric |
   | HPA scaling too much | warmup, wrong metric, request too low |
   | Drain stuck | PDB DisruptionsAllowed, Not Ready pods |
   | Node count wrong | CA flags, maxSize, safe-to-evict |
   | Latency high, CPU low | Throttling, I/O, downstream — not HPA |

2. **Pending pod triage (always first):**

   ```bash
   kubectl describe pod <pod> | tail -25
   kubectl get events -A --field-selector reason=FailedScheduling --sort-by='.lastTimestamp' | tail -20
   kubectl describe quota -n <ns>
   kubectl logs -n kube-system deployment/cluster-autoscaler | tail -50
   ```

3. **Resource truth on nodes:**

   ```bash
   kubectl describe node <node> | grep -A15 "Allocated resources"
   kubectl top nodes
   kubectl top pods -n <ns> --sort-by=memory
   ```

4. **HPA status:**

   ```bash
   kubectl describe hpa <name> -n <ns>
   kubectl get --raw "/apis/autoscaling/v2/namespaces/<ns>/horizontalpodautoscalers/<name>/status" | jq .
   ```

5. **PDB during maintenance:**

   ```bash
   kubectl get pdb -n <ns>
   kubectl describe pdb <name>
   # DisruptionsAllowed: 0 → fix replicas or PDB before drain
   ```

6. **VPA (if installed):**

   ```bash
   kubectl describe vpa <name> -n <ns>
   kubectl get vpa -A -o custom-columns=NAME:.metadata.name,MODE:.spec.updatePolicy.updateMode,REC:.status.recommendation
   ```

7. **Prometheus queries (if available):**

   ```promql
   # CPU throttling
   rate(container_cpu_cfs_throttled_seconds_total{namespace="checkout", pod=~"orders.*"}[5m])

   # Memory vs limit
   container_memory_working_set_bytes / kube_pod_container_resource_limits{resource="memory"}

   # HPA desired vs current
   kube_horizontalpodautoscaler_status_desired_replicas
   kube_horizontalpodautoscaler_status_current_replicas
   ```

8. **Change levers (in order of safety).**

   - Fix Not Ready pods (deploy rollback).
   - Adjust PDB temporarily (with ticket).
   - Scale up node pool max / raise quota.
   - Tune HPA behavior (stabilization).
   - Apply VPA recommendation via Git (not Auto during peak).
   - Never remove PDB without understanding blast radius.

9. **Turn off experimental autoscalers during incidents** before chasing app bugs.

10. **Document the math:** At HPA max replicas R, request CPU r, memory m — required schedulable capacity ≥ R×r (plus system pods overhead). If that exceeds cluster max — **design failure**, not on-call failure.

---

## 12. Quick Decision Matrix

| Situation | Do this |
|---|---|
| Stateless API, variable traffic | HPA on CPU (65–70%) + minReplicas ≥ 3 + PDB maxUnavailable 25% |
| JVM Spring Boot service | MaxRAMPercentage + memory limit > heap + metaspace headroom |
| Pod stuck Pending | Read FailedScheduling; fix requests/quota/CA/node pool — not HPA max |
| OOMKilled container | Raise limit **and** tune JVM; check direct memory leaks |
| CPU throttling, latency high | Raise CPU limit above request; verify request isn't absurdly high |
| Cost reduction initiative | VPA Off recommendations → Git; don't slash requests globally |
| Night batch + day API same nodes | Separate node pools; taints/tolerations; CA per pool |
| GitOps + HPA | ignoreDifferences on `/spec/replicas` |
| VPA + HPA together | VPA Off/Initial on memory OR HPA on custom metrics only — avoid CPU fight |
| Cluster upgrade / drain | Check PDB DisruptionsAllowed; scale up replicas before drain |
| Single replica tool | No PDB or accept downtime; don't use minAvailable 100% |
| Kafka consumer scaling | HPA on external lag metric; memory sized for batch fetch |
| Black Friday / known peak | Pre-scale minReplicas; verify CA max and quota; freeze VPA Auto |
| BestEffort pods in prod | Add requests/limits immediately — LimitRange defaults |
| GPU / special hardware | Dedicated node pool; requests match whole device; CA on that ASG |
| Memory doesn't drop when scaling out | Don't use memory HPA — fix cache architecture or scale vertically |
| CA not scaling up | Check maxSize, pod requests, instance type fit, CA logs |
| CA not scaling down | Audit safe-to-evict false; local storage; low utilization threshold |
| Namespace multi-tenant | ResourceQuota + LimitRange; separate priority classes |
| Latency SLO, flat CPU | Check throttling, DB, GC — HPA won't help |

---

## 13. Scenario-Based Questions

### Q1. HPA shows desired replicas 20, but only 12 Running; eight Pending. What happened?

**Root cause pattern:** Scheduler cannot place pods — **Insufficient cpu/memory**, **ResourceQuota**, or **Cluster Autoscaler at maxSize**. HPA did its job; placement failed downstream.

**Fix:** `kubectl describe pod` on Pending; read FailedScheduling message. Raise quota, reduce requests, add node capacity, or lower HPA max to schedulable ceiling.

---

### Q2. Pods OOMKilled with limit 1Gi and `-Xmx1g`. Local Docker works. Why?

**Root cause:** JVM heap is 1 Gi inside a 1 Gi **container** limit — no room for metaspace, threads, native memory, GC overhead. Cgroup kills container (137).

**Fix:** Limit ≥ 1.3–1.5× heap target; use `MaxRAMPercentage=65` of limit; never set `-Xmx` equal to limit.

---

### Q3. HPA CPU utilization stuck at 15% but users report slow responses. HPA won't scale. Correct?

**Root cause:** CPU is wrong signal — I/O bound (DB/API), **CPU throttling** at low absolute usage, thread pool exhaustion, or **requests set too high** (denominator inflates, utilization looks low).

**Fix:** Check `container_cpu_cfs_throttled_seconds_total`, dependency latency, consider custom/RPS metrics; right-size CPU requests from actual usage.

---

### Q4. After enabling HPA, Argo CD keeps resetting replicas to 3. Who wins?

**Root cause:** GitOps **selfHeal** on Deployment `spec.replicas` fights HPA scale subresource.

**Fix:** Remove replicas from Git manifest or `ignoreDifferences` on `/spec/replicas`; keep HPA min/max in Git.

---

### Q5. `kubectl drain` hangs on a node. PDB shows DisruptionsAllowed: 0. Steps?

**Root cause:** Too few **Ready** pods vs `minAvailable`, or one pod Not Ready reducing available count.

**Fix:** Fix unhealthy pods; temporarily scale Deployment up; adjust PDB with change ticket; never delete PDB without understanding impact.

---

### Q6. Cluster Autoscaler adds nodes but pods stay Pending. CA bug?

**Root cause pattern:** New nodes don't match **nodeSelector/taint**, pod **too large** for instance type, **affinity/topology spread** impossible, or **GPU/resource** mismatch — CA simulated scheduling still fails.

**Fix:** Align pod requirements with node pool; read CA and scheduler events together.

---

### Q7. VPA Auto enabled; pods evicted during business hours; latency spikes. Expected?

**Root cause:** VPA **Recreate/Auto** evicts to apply new resources; concurrent evictions bounded by PDB but still hurt tail latency.

**Fix:** VPA `Off` or `Initial`; apply sizing in maintenance window via Git; tighten maxAllowed.

---

### Q8. Memory HPA scales 5 → 30 replicas; total memory usage climbs; OOM on nodes. Why?

**Root cause:** Each replica holds **full in-memory cache** — memory per request doesn't improve with more pods; aggregate memory rises.

**Fix:** External cache (Redis), partition data, or vertical scaling; remove memory from HPA; use CPU/lag metrics.

---

### Q9. All pods Guaranteed QoS with limits equal requests. Safe?

**Root cause pattern:** Eviction-safe and predictable, but **no CPU burst** — throttling under spike; **expensive** scheduling (low node packing). Good for critical small services; bad default for all Java APIs.

**Fix:** Burstable pattern: request = steady, limit > request for CPU; memory limit with headroom above request.

---

### Q10. Namespace ResourceQuota `requests.cpu: 30` — HPA max 50 with 500m request each. Problem?

**Root cause:** Max schedulable CPU for namespace = 30 cores regardless of HPA — partial scale ceiling at 60 pods if only CPU counted, but quota stops at 30/0.5 = 60... actually 50×0.5=25 fits. At 500m, 30/0.5=60 max pods. At 1 CPU request, max 30 pods. **Quota must be ≥ HPA max × request.**

**Fix:** Align quota with HPA max and requests; automate check in CI.

---

### Q11. DaemonSet without resources causes app pod evictions. Mechanism?

**Root cause:** Fluent-bit or agent runs **BestEffort**, grows under log load, triggers **MemoryPressure**, kubelet evicts other pods (often Burstable apps first).

**Fix:** Set agent requests/limits; isolate logging disk/memory; priority classes for platform agents.

---

### Q12. HPA v2 with CPU and memory metrics — CPU says scale up, memory says scale down. Which wins?

**Root cause:** HPA takes **maximum** desired replica count across metrics — scale-up wins.

**Fix:** Remove counterproductive memory metric if architecture doesn't support memory-based horizontal scale.

---

### Q13. Pod Pending: `0/12 nodes available: 12 Insufficient cpu`. Average node CPU 30% in Grafana. Paradox?

**Root cause:** Grafana shows **actual usage**; scheduler uses **requests**. Nodes fully **requested** at 30% actual utilization — common with inflated requests.

**Fix:** Right-size requests from metrics; overcommit strategy is intentional only with platform approval.

---

### Q14. Black Friday: pre-scale HPA minReplicas 3 → 15. Still Pending at peak. Missed what?

**Root cause:** Pre-scaled **replicas** but not **nodes/quota** — 15 × request may exceed cluster; CA maxSize or quota blocks.

**Fix:** Load test at minReplicas peak; pre-warm node pool; raise CA max temporarily; verify PDB still allows rollouts.

---

### Q15. Java service: VPA recommends 200m CPU request; HPA scales to max at noon. Interaction?

**Root cause:** Lower request → same absolute CPU = **higher utilization %** → aggressive HPA — classic VPA/HPA CPU fight.

**Fix:** VPA Off with manual Git updates; HPA on custom metrics; or VPA on memory only.

---

### Q16. PDB `minAvailable: 2`, Deployment replicas 2, one pod CrashLoopBackOff. Can drain node?

**Root cause:** Only one pod Available; `minAvailable: 2` → **DisruptionsAllowed: 0**.

**Fix:** Fix crash loop first; scale to 3+ temporarily; adjust PDB to `maxUnavailable: 1` for 2-replica service (accepts brief risk).

---

### Q17. Cluster Autoscaler removes nodes over weekend; Monday latency on cold pods. Why?

**Root cause:** Scale-down evicted pods to fewer nodes; Monday traffic hits **cold JVM** (JIT, caches) on surviving pods; HPA slow to add replicas due to scale-down stabilization.

**Fix:** Maintain minReplicas for HA; reduce scale-down aggressiveness; pre-warm before known traffic; separate stable pool with scale-down disabled.

---

### Q18. LimitRange defaultRequest cpu 500m injected; dev apps work; prod HPA never triggers. Link?

**Root cause:** Prod relied on implicit 500m request; actual usage 100m → HPA sees 20% of target 70%.

**Fix:** Explicit requests per container in prod manifests; dev-only LimitRange.

---

### Q19. Spot/preemptible nodes + PDB + CA — eviction loop?

**Root cause pattern:** Spot interruption = **involuntary** (PDB doesn't help); CA adds on-demand; workload reschedules; spot cheap but churn hurts JVM/cache; PDB only affects voluntary drain.

**Fix:** Spot for fault-tolerant batch; on-demand pool for API; tolerate spot with graceful shutdown; don't rely on PDB for spot survival.

---

### Q20. `kubectl top pod` shows 900Mi memory; limit 1Gi; still OOMKilled. How?

**Root cause:** **Working set** metric lags spike; sudden allocation (heap, direct buffer) exceeds limit before sampling; or **node-level OOM** if limit unset on another container in pod.

**Fix:** Alert on memory >85% limit; load test peaks; increase limit with JVM alignment; check all containers in pod.

---

### Q21. HPA scale-down removes pods with active WebSocket sessions. User disconnects. Fix?

**Root cause:** HPA evicts pods without connection draining; no **preStop** / graceful shutdown; scale-down too fast.

**Fix:** `preStop` hook + sleep; graceful shutdown in app; PodDisruptionBudget; longer scaleDown stabilization; consider custom metric excluding connection-heavy pods from early termination.

---

### Q22. Three zones, topologySpreadConstraints maxSkew 1, HPA scales to 40, Pending pods. Cause?

**Root cause:** Uneven zone capacity or imbalanced node counts — spread constraint can't place pod without violating skew.

**Fix:** Balance node groups per zone; relax maxSkew for non-critical tiers; ensure CA balances similar node groups across zones.

---

### Q23. Interview: requests vs limits — one sentence each for scheduler and kubelet?

**Answer:** **Requests** tell the **scheduler** how much capacity to reserve on a node for placement and fair sharing. **Limits** tell the **kubelet** the maximum CPU (throttle) and memory (OOM kill) enforced by cgroups at runtime. Limits do not affect scheduling; requests do not cap usage.

---

### Q24. Interview: order of eviction for QoS under node memory pressure?

**Answer:** **BestEffort** first (no requests/limits), then **Burstable** pods exceeding memory **requests**, then others; **Guaranteed** last (limits == requests). PriorityClass can override ordering among same QoS.

---

### Q25. Platform mandates `limits.memory == requests.memory` for all prod pods. Your Java API objection?

**Answer:** Equal memory request/limit creates **Guaranteed** QoS (good for eviction) but **zero burst headroom** for JVM native/memory spikes — OOM risk unless limit sized with full native overhead. Prefer equal only after profiling P99 RSS; otherwise request < limit with careful monitoring, or Guaranteed with generously padded limit from load tests.

---

*Kubernetes resource management is a contract between honest requests, enforced limits, autoscaling controllers that don't fight each other, and disruption budgets that protect users during platform change. If you cannot name your pod's QoS class, HPA metric denominator, PDB DisruptionsAllowed, and what happens at HPA max × request — you are not autoscaling; you are hoping the scheduler has spare capacity nobody counted.*

---
