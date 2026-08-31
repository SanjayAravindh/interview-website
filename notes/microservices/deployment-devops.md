# Microservices Deployment & DevOps Mastery — Senior Production Reference

Spring Boot 3.x / Java 17+. Kubernetes 1.28+. Docker 24+. This is not a "hello kubectl" tutorial. It is the map of what actually breaks in production after you containerize fifteen services, wire CI/CD, adopt GitOps, and discover that **deploying is easy — deploying without taking checkout offline is the job**.

The focus is container platforms, release mechanics, configuration/secrets hygiene, progressive delivery, database migration safety, and the operational patterns that separate "we pushed to prod" from "we shipped safely at 2 PM on a Tuesday."

---

## Table of Contents

1. [Mental Model: One Release Through the Platform](#1-mental-model-one-release-through-the-platform)
2. [Docker & Containerization](#2-docker-containerization)
3. [Kubernetes — Workloads and Lifecycle](#3-kubernetes-workloads-and-lifecycle)
4. [Kubernetes Networking](#4-kubernetes-networking)
5. [Ingress — Edge Routing and TLS](#5-ingress-edge-routing-and-tls)
6. [Network Policies — Zero-Trust Inside the Cluster](#6-network-policies-zero-trust-inside-the-cluster)
7. [ConfigMaps — Configuration Without Rebuilds](#7-configmaps-configuration-without-rebuilds)
8. [Secrets — Credentials, Rotation, and Leak Prevention](#8-secrets-credentials-rotation-and-leak-prevention)
9. [Helm — Packaging and Templating Releases](#9-helm-packaging-and-templating-releases)
10. [Service Mesh — Traffic, Security, and Observability](#10-service-mesh-traffic-security-and-observability)
11. [CI/CD — Build, Test, Artifact, Promote](#11-cicd-build-test-artifact-promote)
12. [Infrastructure as Code (IaC)](#12-infrastructure-as-code-iac)
13. [GitOps — Declarative Operations from Git](#13-gitops-declarative-operations-from-git)
14. [Continuous Delivery vs Continuous Deployment](#14-continuous-delivery-vs-continuous-deployment)
15. [Blue-Green Deployment](#15-blue-green-deployment)
16. [Canary Deployment](#16-canary-deployment)
17. [Rolling Deployment](#17-rolling-deployment)
18. [Rolling Update Strategies](#18-rolling-update-strategies)
19. [Zero-Downtime Deployment](#19-zero-downtime-deployment)
20. [Feature Flags in Release Strategy](#20-feature-flags-in-release-strategy)
21. [Backward and Forward Compatible Deployments](#21-backward-and-forward-compatible-deployments)
22. [Database Deployment Strategies](#22-database-deployment-strategies)
23. [Production Debugging Playbook](#23-production-debugging-playbook)
24. [Quick Decision Matrix](#24-quick-decision-matrix)
25. [Scenario-Based Questions](#25-scenario-based-questions)

---

## 1. Mental Model: One Release Through the Platform

Deployment is not `docker push` and `kubectl apply`. It is a **pipeline of immutable artifacts** moving through **environments** with **health gates**, **traffic shifting**, and **rollback contracts**. The platform (Kubernetes + Ingress + mesh + CI) enforces *where* code runs; your release strategy enforces *how* users experience the change.

```
Developer merge (main)
  └─ CI: compile, unit test, SAST, build image (digest pinned)
       └─ Push to registry (ECR/GCR/ACR/Harbor)
            └─ CD: promote tag/digest to env manifest (GitOps commit or pipeline)
                 └─ Kubernetes controller reconciles desired state
                      ├─ Pull image → create Pod
                      ├─ Readiness probe passes → EndpointSlice updated
                      ├─ Ingress / Gateway routes traffic
                      ├─ (Optional) Service mesh: weighted routes, mTLS
                      └─ Old ReplicaSet scaled down after maxUnavailable window
                           └─ Metrics/alerts: error rate, latency, saturation
                                └─ Auto-rollback OR human promote/abort
```

Five objects you must keep distinct:

| Object | Question it answers | Typical artifact |
|---|---|---|
| **Artifact** | What exactly is running? | Container image digest `sha256:abc…`, not `:latest` |
| **Configuration** | What settings does this instance use? | ConfigMap, Secret, Spring profile, external config server |
| **Release strategy** | How do old and new versions coexist? | Rolling, blue-green, canary, feature flags |
| **Health gate** | When is it safe to send traffic? | Readiness probe, smoke test job, SLO check in CD |
| **Rollback lever** | How fast can we revert? | Previous image digest in Helm history, Argo Rollout undo, DNS swap |

A **502 from Ingress** during deploy usually means **no ready backends** (all pods failing readiness, wrong Service selector, port mismatch). A **spike in 500s after deploy** with pods Ready means **application-level incompatibility** (schema, serialization, feature flag default). Mixing those up sends you to restart pods when you need to roll back the image.

### The deployment safety triangle

```
                    ┌─────────────────┐
                    │  Backward-compat │
                    │  contracts/API   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────────┐     │     ┌────────▼────────┐
     │ Health probes +  │     │     │ Observability +  │
     │ graceful shutdown│     │     │ automated rollback│
     └─────────────────┘     │     └─────────────────┘
                             │
                    ┌────────▼────────┐
                    │ Release strategy │
                    │ (roll/canary/BG) │
                    └─────────────────┘
```

Remove any leg and "zero downtime" becomes "we got lucky."

### Production scenario: green pipeline, red prod

**Problem.** GitHub Actions shows green. Argo CD syncs Healthy. Users report checkout broken. Grafana shows 40% 500 on `POST /api/orders`.

**Cause chain:** CI ran unit tests only. Integration tests mocked DB. New version expects column `orders.discount_code` but Flyway migration job failed silently (wrong `FLYWAY_BASELINE` in staging). Pods start (liveness OK), first real query throws `PSQLException`, readiness still passes because health check hits `/actuator/health` with `db` indicator disabled in prod profile.

**Solution checklist:**

```yaml
# Readiness must reflect real dependencies for write paths
management:
  endpoint:
    health:
      group:
        readiness:
          include: readinessState,db,kafka
  health:
    readiness-state:
      enabled: true
```

```yaml
# CI: migration dry-run against ephemeral DB + contract tests
# CD: post-deploy smoke test job before traffic shift
apiVersion: batch/v1
kind: Job
metadata:
  name: orders-smoke-{{ .Values.image.tag }}
spec:
  template:
    spec:
      containers:
        - name: smoke
          image: curlimages/curl
          command: ["sh", "-c", "curl -sf http://orders-service:8080/api/v1/orders/health/deep"]
      restartPolicy: Never
```

Rules that save incidents:

- **Readiness ≠ liveness.** Never put optional deps in liveness; always put critical deps in readiness for services on the request path.
- **Migrations are part of the release**, not an SSH side quest.
- **Smoke tests after sync**, before increasing canary weight.
- **Pin digests** in prod manifests; tags are for humans, digests are for truth.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `:latest` tag in prod | Mystery version running; rollback impossible |
| Readiness = TCP socket only | Pods receive traffic before app ready; 500 burst on deploy |
| No `preStop` hook / short `terminationGracePeriodSeconds` | In-flight requests killed mid-transaction |
| ConfigMap change without pod restart | "We updated config but nothing changed" |
| Single replica + `RollingUpdate` maxUnavailable 25% | Downtime window (0.25 × 1 rounds down to 0 unavailable allowed only with surge) |
| Secrets in Git plaintext | Credential leak; compliance incident |
| Flyway in app startup on N replicas | Race on migration locks; flaky deploy |

### Debugging scenario

**Observe.** Deploy at 14:02 correlates with error rate spike. Pods all `Running`/`Ready`. Rollback "fixes" it.

**Diagnose.**

```bash
kubectl rollout history deployment/orders-service -n checkout
kubectl describe rs -n checkout | grep -A2 Image
kubectl logs deploy/orders-service -n checkout --since=10m | grep -i exception
```

Compare **image digest** not tag. Check **schema version** endpoint or Flyway `flyway_schema_history`. Trace one failing request — often deserialization or missing column.

**Fix.** Roll back digest. Forward fix: expand-contract migration, enable DB in readiness, add post-deploy smoke to pipeline.

---

## 2. Docker & Containerization

### Core concept

A **container** is a process (or tree of processes) isolated by Linux namespaces and cgroups, sharing the host kernel. An **image** is an immutable layered filesystem + metadata describing how to start the default process. For Java microservices, the container is the **unit of deployment**; the JAR inside is the unit of build.

Docker (or containerd/CRI-O under Kubernetes) solves "works on my machine" by shipping the runtime dependencies with the app. It does **not** solve distributed systems problems — it concentrates them into image size, startup time, signal handling, and JVM memory inside cgroup limits.

Production goals for Java containers:

| Goal | Why |
|---|---|
| **Non-root user** | Container escape → limited host damage |
| **Single concern per container** | One JVM, one service; sidecars for mesh/logging |
| **Immutable tags + digests** | Reproducible rollbacks |
| **Fast, deterministic builds** | Layer cache, multi-stage, reproducible base |
| **Correct PID 1 signal handling** | Graceful shutdown on SIGTERM |
| **Explicit memory/CPU** | JVM `-XX:MaxRAMPercentage` vs cgroup limit |

### Internal working: image layers and runtime

```
Dockerfile instructions → layers (cached by instruction hash)
  └─ docker build → local image
       └─ docker push → registry manifest (tag → digest)
            └─ kubelet pull → extract layers to graph driver
                 └─ containerd runs OCI bundle
                      └─ JVM process (PID 1 unless tini/dumb-init)
```

Layer caching rule: **order Dockerfile from least to most frequently changing**. Base image and OS packages first; application JAR last.

### Production Dockerfile — Spring Boot 3

```dockerfile
# syntax=docker/dockerfile:1

FROM eclipse-temurin:21-jre-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Copy only the fat jar — build stage omitted here for brevity;
# in CI, use multi-stage: maven/eclipse-temurin:21-jdk-alpine → build → copy target/*.jar
COPY target/orders-service-*.jar app.jar

USER app
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:+UseContainerSupport -Djava.security.egd=file:/dev/./urandom"

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
```

Multi-stage build (preferred in CI):

```dockerfile
FROM eclipse-temurin:21-jdk-alpine AS build
WORKDIR /src
COPY pom.xml .
COPY .mvn .mvn
RUN ./mvnw -B dependency:go-offline
COPY src ./src
RUN ./mvnw -B -DskipTests package

FROM eclipse-temurin:21-jre-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /src/target/orders-service-*.jar app.jar
USER app
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:+UseContainerSupport"
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
```

### JVM and cgroup memory — the #1 Java container incident

**Problem.** Pod OOMKilled at 512Mi limit. Local run fine at 2Gi heap.

**Cause.** JVM before JDK 10 ignored cgroup limits. Even with container support, setting `-Xmx2g` in a 512Mi limit guarantees OOMKill. Off-heap (metaspace, threads, direct buffers, native libs) adds overhead.

**Solution.**

```dockerfile
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:MaxMetaspaceSize=128m -XX:+ExitOnOutOfMemoryError"
```

```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "768Mi"   # headroom above heap for non-heap
    cpu: "2000m"
```

Never set `-Xmx` and `-Xms` to the container limit unless you deeply understand native memory. Prefer `MaxRAMPercentage`.

### Graceful shutdown in containers

Kubernetes sends **SIGTERM** to PID 1, waits `terminationGracePeriodSeconds` (default 30s), then **SIGKILL**.

Spring Boot 2.3+:

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
```

Kubernetes:

```yaml
spec:
  terminationGracePeriodSeconds: 60
  containers:
    - name: app
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "sleep 5"]
```

The `preStop` sleep lets Endpoints propagate removal before SIGTERM — reduces in-flight request cuts during rollouts.

### Production scenario: image builds differ between dev and CI

**Problem.** Works in developer Docker Desktop. CI image missing native lib / wrong timezone / different locale sorting in SQL.

**Cause.** Dev bind-mounts source and runs `mvn spring-boot:run`; CI builds fat JAR. Or dev uses `latest` base pulled weeks ago; CI pulls new base with breaking change.

**Solution.** One Dockerfile path for all envs. Pin base image digest in CI:

```dockerfile
FROM eclipse-temurin:21-jre-alpine@sha256:abc123...
```

SBOM generation (`docker scout`, `syft`) in CI for supply chain audit.

### .dockerignore

```
target/
.git/
.idea/
*.md
.env
```

Without `.dockerignore`, `COPY . .` invalidates cache on any doc change and may leak secrets.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Run as root | Security audit failure; write escapes |
| No HEALTHCHECK / wrong port | Orchestrator marks unhealthy incorrectly (K8s uses probes instead) |
| Fat image with JDK in prod | Slow pull; larger attack surface |
| Logging to files inside container | Logs lost on restart; use stdout |
| `:latest` only tag | Cannot correlate running version to Git SHA |
| Missing `dumb-init` when shell wrapper PID 1 | SIGTERM not forwarded to Java child |

### Debugging scenario

**Observe.** Pod restart loop, exit code 137.

**Diagnose.** `kubectl describe pod` → `Last State: Terminated, Reason: OOMKilled`. Check `resources.limits.memory` vs JVM flags. `kubectl top pod` under load.

**Fix.** Raise limit or lower `MaxRAMPercentage`. Add memory request for scheduling. Profile heap in staging.

---

## 3. Kubernetes — Workloads and Lifecycle

### Core concept

Kubernetes is a **declarative control plane** that reconciles desired state (Pods, Deployments, Services) with actual cluster state. For microservices, you rarely create Pods directly — you manage **Deployments** (or **StatefulSets** for stable identity), **Services** for stable DNS, and **Ingress/Gateway** for north-south traffic.

Key workload types:

| Kind | Use when |
|---|---|
| **Deployment** | Stateless HTTP/gRPC workers; rolling updates |
| **StatefulSet** | Stable network ID, ordered deploy, persistent volumes (Kafka, DB — prefer managed DB) |
| **DaemonSet** | One pod per node (log agents, node exporters) |
| **Job / CronJob** | Migrations, batch, smoke tests |
| **HPA** | CPU/memory/custom metrics scale replicas |

### Internal working: Deployment rollout

```
kubectl apply Deployment spec
  └─ Deployment controller creates new ReplicaSet (RS)
       └─ RS controller creates Pods
            └─ Scheduler binds Pod to Node
                 └─ kubelet pulls image, starts container
                      └─ Readiness probe success → EndpointSlice adds IP
                           └─ Old RS scaled down per strategy
```

ReplicaSet is immutable for a given Pod template hash. Each template change = new RS. Rollback = scale up previous RS.

### Production Deployment manifest — Spring Boot service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-service
  labels:
    app: orders-service
    team: checkout
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orders-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: orders-service
        version: v2.4.1
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/path: "/actuator/prometheus"
        prometheus.io/port: "8080"
    spec:
      serviceAccountName: orders-service
      terminationGracePeriodSeconds: 60
      containers:
        - name: app
          image: 123456789.dkr.ecr.us-east-1.amazonaws.com/orders-service:2.4.1@sha256:deadbeef...
          ports:
            - name: http
              containerPort: 8080
          envFrom:
            - configMapRef:
                name: orders-service-config
            - secretRef:
                name: orders-service-secrets
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 768Mi
          startupProbe:
            httpGet:
              path: /actuator/health/liveness
              port: http
            failureThreshold: 30
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: http
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: http
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: ["sh", "-c", "sleep 5"]
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: orders-service
                topologyKey: kubernetes.io/hostname
```

### Probes — startup vs liveness vs readiness

| Probe | Fails → | Include DB? |
|---|---|---|
| **startup** | Kill pod (after failures) | Light checks only; protects slow JVM start |
| **liveness** | Kill pod | **Never** external deps — deadlock detection only |
| **readiness** | Remove from Service endpoints | **Yes** for critical deps on sync write path |

**Production incident:** Liveness includes Kafka check. Broker blip → all pods restarted → thundering herd → prolonged outage.

### Resource requests and limits

**Requests** drive scheduling. **Limits** cap usage (CPU throttled, memory OOMKill).

Set requests from p95 usage in prod (or load test). Limits ≥ requests. For Java, memory limit must exceed heap + metaspace + overhead.

### HPA example

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders-service
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: http_server_requests_seconds_count
        target:
          type: AverageValue
          averageValue: "100"
```

Prefer custom metrics (request rate, queue lag) over CPU alone for JVM services — GC spikes cause false scale signals.

### Production scenario: Deployment stuck "Progress deadline exceeded"

**Problem.** `kubectl rollout status` hangs. New RS has pods CrashLoopBackOff; old RS still serves traffic (if maxUnavailable allows).

**Cause.** New image bad; or ConfigMap reference broken; or image pull secret missing on new node pool.

**Diagnose.**

```bash
kubectl rollout status deployment/orders-service
kubectl get pods -l app=orders-service
kubectl describe pod <failing-pod>
kubectl logs <failing-pod> --previous
```

**Fix.** `kubectl rollout undo deployment/orders-service`. Fix forward in CI. Set `progressDeadlineSeconds` (default 600) to fail fast and trigger alert.

### PodDisruptionBudget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orders-service-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: orders-service
```

Protects against voluntary evictions (node drain) taking all replicas offline. Does not stop involuntary failures.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `replicas: 1` in prod | Any node drain = outage |
| No PDB | Cluster upgrade kills all pods at once |
| `imagePullPolicy: Always` + rate limit | Intermittent ImagePullBackOff |
| Wrong `containerPort` vs app port | Ready probe fails forever |
| Missing resource requests | Noisy neighbor; unpredictable scheduling |
| Anti-affinity required not preferred | Pending pods — cannot schedule |

### Debugging scenario

**Observe.** After node upgrade, service unavailable though pods exist.

**Diagnose.** PDB blocked drain? `kubectl get pdb`. Check pod distribution across zones: `kubectl get pods -o wide`. Single-AZ cluster lost AZ → no replicas.

**Fix.** Spread across topology zones (`topologySpreadConstraints`). Minimum 3 replicas for HA.

---

## 4. Kubernetes Networking

### Core concept

Kubernetes networking assigns every Pod a **cluster-routable IP** (flat network model). Services provide **stable virtual IPs and DNS names** that load-balance to ready Pod endpoints via kube-proxy (iptables/IPVS) or eBPF (Cilium). Microservices talk to each other by **Service DNS**: `orders-service.checkout.svc.cluster.local`.

Three traffic planes:

| Plane | Path | Tooling |
|---|---|---|
| **Pod ↔ Pod** | Direct IP or Service ClusterIP | CNI plugin (Calico, Cilium, AWS VPC-CNI) |
| **Pod ↔ external** | NAT via node or egress gateway | NetworkPolicy egress, NAT gateway |
| **External ↔ Pod** | LoadBalancer / NodePort / Ingress | Cloud LB, NGINX Ingress, Gateway API |

### Internal working: Service → Endpoints → kube-proxy

```
Service orders-service (ClusterIP 10.96.1.42:80)
  └─ EndpointSlice: 10.244.1.5:8080, 10.244.2.7:8080, 10.244.3.9:8080
       └─ kube-proxy / eBPF programs DNAT to Pod IP:containerPort
            └─ CNI routes packet to target node
```

DNS resolution (CoreDNS):

```
orders-service                    → ClusterIP (same namespace)
orders-service.checkout           → ClusterIP (cross-namespace short)
orders-service.checkout.svc.cluster.local → FQDN
```

Headless Service (`clusterIP: None`) returns Pod A records directly — used for StatefulSets and some client-side discovery patterns.

### Service types

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders-service
  namespace: checkout
spec:
  type: ClusterIP
  selector:
    app: orders-service
  ports:
    - name: http
      port: 80
      targetPort: http   # references containerPort name
```

| type | When |
|---|---|
| **ClusterIP** | Default; internal only |
| **NodePort** | Legacy dev/debug; avoid in prod edge |
| **LoadBalancer** | Cloud LB to Service; often paired with Ingress |
| **ExternalName** | CNAME to external DNS (legacy SaaS) |

### DNS and Spring Boot service URLs

```yaml
# Prefer K8s DNS over hard-coded IPs
inventory:
  url: http://inventory-service.inventory.svc.cluster.local
```

Spring Cloud Kubernetes can discover services by label; plain RestTemplate/WebClient uses DNS + client-side LB or mesh.

### Production scenario: intermittent "Connection refused" between services

**Problem.** Order service calls inventory at `http://inventory-service:8080`. Works 95% of time; 5% connection refused.

**Cause.** Calling **Pod IP directly** from a cached list (custom discovery) while pods roll. Or Service `targetPort` mismatch (Service 8080 → container 8080 but app listens 8081). Or hitting Service before Endpoints populated.

**Solution.** Always use Service DNS. Set `spring.cloud.loadbalancer.cache.ttl=5s` if using Spring Cloud LoadBalancer with K8s discovery. Verify:

```bash
kubectl get endpoints inventory-service -o wide
kubectl run tmp --rm -it --image=busybox -- wget -qO- http://inventory-service.inventory:8080/actuator/health
```

### Dual-stack, MTU, and CNI gotchas

| Issue | Symptom |
|---|---|
| MTU mismatch (overlay vs VPC) | Large responses hang; TLS handshake weird failures |
| NetworkPolicy default deny without egress allow | DNS timeout (must allow kube-dns:53) |
| IP exhaustion | Pods stuck Pending — expand CIDR or use secondary ranges |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Service selector label mismatch | Empty Endpoints → permanent 503 |
| `targetPort` wrong | Probe passes on sidecar, Service hits wrong port |
| Hard-coded Pod IPs in config | Failures during rollouts |
| No timeout on HTTP clients | Hang on stale connections after pod death |
| Mixing `hostNetwork: true` without understanding | Port conflicts; security exposure |

### Debugging scenario

**Observe.** Only one consumer service fails to reach payment-service; others fine.

**Diagnose.** NetworkPolicy egress on consumer namespace? `kubectl describe networkpolicy`. DNS resolution from consumer pod: `nslookup payment-service.payment`. Compare labels on payment pods vs Service selector.

**Fix.** Add egress rule to payment namespace/port or fix selector typo.

---

## 5. Ingress — Edge Routing and TLS

### Core concept

**Ingress** (or **Gateway API** — the modern successor) terminates north-south HTTP(S) traffic and routes to in-cluster Services by host and path. It is the edge counterpart to internal Service DNS — where TLS, WAF integration, rate limits, and path-based routing to dozens of microservices live.

```
Internet → Cloud LB → Ingress Controller (NGINX, Traefik, AWS LB Controller)
  └─ Ingress rules: host api.example.com path /orders → orders-service:80
       └─ TLS cert from cert-manager (Let's Encrypt or internal CA)
            └─ Service → Pods
```

### Internal working: Ingress controller reconciliation

1. You create `Ingress` resource with rules and TLS spec.
2. Ingress controller watches Ingress objects.
3. Controller generates data plane config (nginx.conf, ALB listener rules).
4. Cloud LB forwards to controller pods or directly to targets (AWS Load Balancer Controller pattern).
5. cert-manager creates/renews Certificate CRDs → stores TLS in Secret → Ingress references Secret.

### Production Ingress — NGINX + cert-manager

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: checkout
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-example-com-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api/v1/orders
            pathType: Prefix
            backend:
              service:
                name: orders-service
                port:
                  number: 80
          - path: /api/v1/inventory
            pathType: Prefix
            backend:
              service:
                name: inventory-service
                port:
                  number: 80
```

cert-manager ClusterIssuer:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
```

### Gateway API (successor pattern)

Gateway API separates **Gateway** (infra, TLS termination) from **HTTPRoute** (app team routes):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: orders-route
spec:
  parentRefs:
    - name: external-gateway
  hostnames:
    - api.example.com
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/orders
      backendRefs:
        - name: orders-service
          port: 80
```

Prefer Gateway API for multi-team shared gateways and clearer RBAC split.

### Production scenario: 404 on valid path after deploy

**Problem.** `GET /api/v1/orders/123` returns 404 from Ingress but 200 via port-forward to pod.

**Cause.** Path strip mismatch — Ingress forwards `/api/v1/orders/123` but app expects `/orders/123`. Or trailing slash redirect loop. Or wrong `pathType: ImplementationSpecific` behavior.

**Solution.**

```yaml
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /$2
# path: /api/v1/orders(/|$)(.*)
```

Better: app serves at same path as external contract (`/api/v1/orders`) — avoid rewrite magic.

### TLS and HSTS

Terminate TLS at Ingress; use **mTLS inside** cluster (mesh or NetworkPolicy + cert rotation) for service-to-service. Enable HSTS at edge for browser clients. Watch cert expiry — cert-manager alerts on renewal failure (DNS challenge misconfig common).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Ingress class mismatch | Ingress ignored — 404 default backend |
| Backend Service has no ready endpoints | 502/503 |
| Annotation typo (`nginx.ingress...`) | Silent ignore — default timeouts break uploads |
| Wildcard cert wrong SAN | TLS error on subdomain |
| Rate limit only at app, not edge | DDoS reaches cluster |

### Debugging scenario

**Observe.** 502 Bad Gateway only through Ingress; in-cluster curl works.

**Diagnose.** Ingress controller logs. Endpoint count. Timeout annotations vs app p99. `kubectl describe ingress api-ingress`.

**Fix.** Increase `proxy-read-timeout`. Scale controller. Fix readiness on backends.

---

## 6. Network Policies — Zero-Trust Inside the Cluster

### Core concept

By default, Kubernetes allows **any Pod to talk to any Pod**. NetworkPolicy is a firewall at L3/L4 (and L7 with Cilium) that restricts ingress/egress by label. For microservices, default-deny plus explicit allow is the production baseline — limits lateral movement after compromise and enforces **least privilege** between teams' namespaces.

### Internal working

NetworkPolicy is enforced by the CNI plugin (not all CNIs support it equally). Rules are additive — if any policy selects a pod, traffic must match at least one allow rule (depending on CNI default deny semantics).

```
Pod orders-service (label app=orders)
  └─ NetworkPolicy: ingress only from namespace ingress-nginx AND label app=api-gateway
  └─ egress to inventory-service:8080, postgres:5432, kube-dns:53
```

### Production NetworkPolicy examples

Default deny all ingress in namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: checkout
spec:
  podSelector: {}
  policyTypes:
    - Ingress
```

Allow orders-service ingress from gateway only:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: orders-ingress-from-gateway
  namespace: checkout
spec:
  podSelector:
    matchLabels:
      app: orders-service
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
```

Egress with DNS allow (critical):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: orders-egress
  namespace: checkout
spec:
  podSelector:
    matchLabels:
      app: orders-service
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - podSelector:
            matchLabels:
              app: inventory-service
          namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: inventory
      ports:
        - protocol: TCP
          port: 8080
    - to:
        - ipBlock:
            cidr: 10.20.0.0/16   # RDS subnet
      ports:
        - protocol: TCP
          port: 5432
```

### Production scenario: deploy succeeds, all internal calls timeout

**Problem.** After enabling default-deny NetworkPolicies, services return 504 to each other.

**Cause.** Forgot egress allow for DNS, kube-apiserver (if using webhooks), or Kafka broker IPs.

**Solution.** Document required egress per service in service catalog. CI policy test (e.g. netpol-validator) before apply. Staged rollout: audit mode (Cilium Hubble) before enforce.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Default deny without DNS egress | `UnknownHostException`, intermittent failures |
| Label selector typo on namespace | Silent deny — works in staging without policies |
| Policies not supported by CNI | "We applied policy but nothing changed" — false security |
| Allow overly broad `0.0.0.0/0` egress | Defeats purpose |

### Debugging scenario

**Observe.** New service cannot reach Postgres; old services can.

**Diagnose.** `kubectl describe networkpolicy -n checkout`. Compare pod labels. Test with `kubectl exec` and `nc -zv`.

**Fix.** Add egress rule for RDS CIDR or namespace-scoped postgres proxy.

---

## 7. ConfigMaps — Configuration Without Rebuilds

### Core concept

**ConfigMap** stores non-sensitive configuration as key-value pairs or files, mounted as env vars or volumes. Twelve-Factor config: **strict separation** of config from code. For Spring Boot, externalize `application.yml` fragments, feature toggles, and log levels without rebuilding the JAR.

ConfigMaps are **not** for secrets (they are base64 in etcd without encryption at rest by default — use Secrets + encryption provider).

### Internal working

```
ConfigMap created/updated
  └─ Pods reference via envFrom / volumeMount
       └─ kubelet projects files into container filesystem
            └─ Spring Boot reads /config/application.yaml (optional import)
```

**Critical:** Updating ConfigMap **does not restart pods**. Running containers keep old env until restart. Use Reloader, Stakater Reloader, or roll restart on config change.

### Production patterns

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: orders-service-config
  namespace: checkout
data:
  SPRING_PROFILES_ACTIVE: "prod,kubernetes"
  MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE: "health,info,prometheus"
  INVENTORY_URL: "http://inventory-service.inventory.svc.cluster.local"
  application.yaml: |
    server:
      shutdown: graceful
    spring:
      kafka:
        consumer:
          group-id: orders-service-${HOSTNAME}
    orders:
      reservation-ttl-minutes: 15
```

Volume mount for full YAML:

```yaml
volumeMounts:
  - name: config
    mountPath: /config
    readOnly: true
volumes:
  - name: config
    configMap:
      name: orders-service-config
      items:
        - key: application.yaml
          path: application.yaml
```

Spring Boot 2.4+ import:

```yaml
spring:
  config:
    import: optional:file:/config/application.yaml
```

### Production scenario: "we changed ConfigMap but app still old behavior"

**Problem.** Team updates log level in ConfigMap. No effect.

**Cause.** Env vars injected at pod start are immutable. File mounts update on kubelet sync (~60s) but Spring does not reload without `@RefreshScope` + actuator refresh or restart.

**Solution.**

```yaml
# Stakater Reloader annotation on Deployment
metadata:
  annotations:
    reloader.stakater.com/auto: "true"
```

Or Spring Cloud Config + Bus for dynamic refresh (heavier). For most teams: **roll restart on config change** is simplest and predictable.

### ConfigMap size limits

Max ~1Mi per ConfigMap. Large JSON configs belong in object storage or config server, not giant ConfigMaps.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Secrets in ConfigMap | Credential leak in etcd backups |
| No version tracking | Cannot correlate behavior to config revision |
| Hot reload without testing | Mid-traffic config half-applied |
| Duplicate keys env + file | Precedence confusion — document order |

### Debugging scenario

**Observe.** Staging works, prod misconfigured URLs.

**Diagnose.** `kubectl get configmap orders-service-config -o yaml` in both envs. Diff Helm values. Check env inside pod: `kubectl exec ... env | sort`.

**Fix.** GitOps diff should catch drift. Single source of truth per env in values file.

---

## 8. Secrets — Credentials, Rotation, and Leak Prevention

### Core concept

**Secret** stores sensitive data (DB passwords, API keys, TLS keys) in etcd (base64 encoded — **not encrypted** unless EncryptionConfiguration enabled). Production adds: external secret managers (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager), rotation, RBAC, and never committing plaintext to Git.

### Internal working

```
External vault / cloud SM
  └─ External Secrets Operator syncs to K8s Secret
       └─ Pod mounts as env or volume (tmpfs memory-backed)
            └─ Spring reads SPRING_DATASOURCE_PASSWORD
```

### External Secrets Operator pattern

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: orders-service-db
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: orders-service-secrets
  data:
    - secretKey: SPRING_DATASOURCE_PASSWORD
      remoteRef:
        key: prod/checkout/orders-service
        property: db_password
```

Deployment reference unchanged — still `secretRef: orders-service-secrets`.

### Spring Boot and secrets

```yaml
env:
  - name: SPRING_DATASOURCE_PASSWORD
    valueFrom:
      secretKeyRef:
        name: orders-service-secrets
        key: SPRING_DATASOURCE_PASSWORD
```

Prefer file mount for rotation without pod restart (app must watch file — Spring Cloud Vault or custom):

```yaml
volumeMounts:
  - name: db-secret
    mountPath: /secrets/db
    readOnly: true
```

### Production scenario: secret rotated, app still uses old password

**Problem.** DBA rotates RDS password in Secrets Manager. Pods crash with auth failure.

**Cause.** K8s Secret synced but env var stale until pod restart. Or app caches DataSource at startup forever.

**Solution.** External Secrets refresh + Reloader on Secret change. Or use IAM database auth (RDS IAM) to avoid static passwords. Document rotation runbook: sync → rolling restart → verify connection pool metrics.

### RBAC least privilege

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: orders-service-secret-reader
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["orders-service-secrets"]
    verbs: ["get"]
```

ServiceAccount bound to Role — pod only reads its Secret.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Secrets in Git / Helm values plaintext | Git history leak forever |
| `kubectl describe secret` in runbooks | Values visible in events/logs |
| Shared Secret across envs | Staging test wipes prod DB |
| No encryption at rest for etcd | Compliance failure |
| Logging env at startup | Password in log aggregation |

### Debugging scenario

**Observe.** `Access denied for user 'orders_app'@'...'` after deploy only on new pods.

**Diagnose.** Compare Secret version mounted in old vs new pod. Check ExternalSecret status. Verify IAM role on new node pool (IRSA).

**Fix.** Force sync and rollout. Fix ServiceAccount annotation for AWS role.

---

## 9. Helm — Packaging and Templating Releases

### Core concept

**Helm** is the package manager for Kubernetes — charts templatize manifests with values per environment. It adds **release lifecycle** (install, upgrade, rollback, history) on top of raw YAML. For microservices platforms, Helm charts standardize Deployments, Services, Ingress, HPA, and config across fifty services.

### Internal working

```
helm upgrade orders ./charts/orders -f values-prod.yaml --set image.tag=2.4.1
  └─ Render templates → manifest bundle
       └─ Apply with 3-way strategic merge patch
            └─ Release revision N stored in Secret (helm.sh/release.v1)
                 └─ Rollback = apply revision N-1
```

### Chart structure

```
orders-service/
  Chart.yaml
  values.yaml
  templates/
    deployment.yaml
    service.yaml
    ingress.yaml
    hpa.yaml
    configmap.yaml
    _helpers.tpl
```

### Production values layering

```
values.yaml              # defaults
values-staging.yaml      # staging overrides
values-prod.yaml         # prod replicas, resources, ingress host
```

```yaml
# values-prod.yaml
replicaCount: 5
image:
  repository: 123456789.dkr.ecr.us-east-1.amazonaws.com/orders-service
  tag: "2.4.1"
  digest: "sha256:deadbeef..."
ingress:
  enabled: true
  host: api.example.com
resources:
  requests:
    memory: 512Mi
    cpu: 500m
```

Template snippet:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "orders.fullname" . }}
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}@{{ .Values.image.digest }}"
```

### Helm hooks for migrations

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "orders.fullname" . }}-migrate
  annotations:
    "helm.sh/hook": pre-upgrade
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    spec:
      containers:
        - name: flyway
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["java", "-jar", "app.jar", "--spring.profiles.active=migrate"]
      restartPolicy: Never
```

Run DB migrations **once per release** before new pods take traffic.

### Production scenario: helm upgrade stuck on pending hook

**Problem.** `helm upgrade` hangs; pre-upgrade migration Job CrashLoopBackOff.

**Cause.** Migration incompatible; hook has no timeout; failed hook blocks release.

**Solution.** `helm rollback`. Fix migration. Set Job `activeDeadlineSeconds`. Use `--wait --timeout 10m` in CI. For GitOps (Argo CD), prefer separate migration Job as sync wave, not hidden hook failure.

### helm vs kustomize vs raw YAML

| Tool | Best for |
|---|---|
| **Helm** | Reusable charts, multi-service platform, release history |
| **Kustomize** | Patch overlays per env, no templating logic |
| **Raw + GitOps** | Small teams, explicit manifests |

Many orgs use **Helm charts rendered in CI** → committed manifests for Argo CD (helm template).

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| `--set` in prod without audit trail | Untracked config drift |
| Chart upgrade without diff | Surprise resource deletion |
| Templated secrets in values git | Leak |
| No resource limits in chart defaults | OOM in every new service copy-paste |

### Debugging scenario

**Observe.** After helm upgrade, Ingress deleted.

**Diagnose.** `helm get manifest orders -n checkout` revision diff. Check `helm.sh/resource-policy` annotations. `helm history orders`.

**Fix.** `helm rollback orders 47`. Add `keep` policy for critical resources or move Ingress to separate chart.

---

## 10. Service Mesh — Traffic, Security, and Observability

### Core concept

A **service mesh** (Istio, Linkerd, Consul Connect) injects **sidecar proxies** (Envoy) alongside each pod to handle mTLS, retries, timeouts, traffic splitting, and telemetry without embedding all logic in application code. Control plane (istiod) pushes config to data plane proxies.

When to adopt:

| Signal | Mesh helps |
|---|---|
| 20+ services, mTLS mandate | Uniform TLS, no app changes |
| Canary at L7 without custom LB | Weighted routes by header/version |
| Deep L7 metrics per route | Golden signals per service pair |
| Complex retry/timeout policies | Central policy, consistent |

When to **defer**: small cluster, strong app-level resilience (Resilience4j), team lacks mesh ops maturity — mesh adds control plane failure modes.

### Internal working: request through sidecar

```
orders-pod: app:8080 ←→ localhost:15001 sidecar (Envoy)
  └─ mTLS to inventory-pod sidecar
       └─ inventory app:8080
            └─ spans exported to Zipkin/Jaeger
                 └─ metrics: istio_requests_total{destination_service=inventory}
```

### Istio — canary traffic split

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: orders-service
spec:
  hosts:
    - orders-service
  http:
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: orders-service
            subset: v2
          weight: 100
    - route:
        - destination:
            host: orders-service
            subset: v1
          weight: 95
        - destination:
            host: orders-service
            subset: v2
          weight: 5
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: orders-service
spec:
  host: orders-service
  subsets:
    - name: v1
      labels:
        version: v1
    - name: v2
      labels:
        version: v2
  trafficPolicy:
    tls:
      mode: ISTIO_MUTUAL
```

### Production scenario: mesh enabled, latency doubles

**Problem.** P99 jumps from 80ms to 180ms on all internal calls after Istio injection.

**Cause.** Double proxy hop + mTLS + access log I/O. Misconfigured retry (2 app retries × 3 mesh retries). CPU throttling on sidecar.

**Solution.** Right-size sidecar resources. Disable redundant app retries when mesh handles them. Tune `holdApplicationUntilProxyStarts`. Measure with and without mesh on one service before fleet-wide.

### Linkerd vs Istio (pragmatic)

| | Linkerd | Istio |
|---|---|---|
| Complexity | Lower | Higher feature set |
| Proxy | linkerd2-proxy (Rust) | Envoy |
| Best for | Simpler mTLS + metrics | Full traffic management, WASM filters |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Sidecar not ready before app | Connection refused on startup |
| mTLS STRICT before all workloads meshed | 503 UF (upstream connection failure) |
| Retry on non-idempotent POST at mesh | Duplicate orders |
| Exclude kube-dns / apiserver incorrectly | Control plane broken |

### Debugging scenario

**Observe.** 503 with flag `UO` (upstream overflow) in Envoy stats.

**Diagnose.** `istioctl proxy-config cluster orders-pod`. Check circuit breaking, outlier detection ejection.

**Fix.** Adjust outlier detection or fix unhealthy upstream pods.

---

## 11. CI/CD — Build, Test, Artifact, Promote

### Core concept

**CI/CD** automates the path from commit to running software. **CI** (Continuous Integration) validates every change: build, unit test, static analysis, container image build. **CD** (Continuous Delivery/Deployment) promotes **immutable artifacts** through environments with gates.

Pipeline stages for Java microservices:

```
1. Checkout + cache deps (Maven/Gradle)
2. Unit tests + ArchUnit + Checkstyle/SpotBugs
3. Integration tests (Testcontainers)
4. Build JAR + Docker image (multi-stage)
5. Scan image (Trivy, Grype) — fail on CRITICAL
6. Push image: registry/org/service:git-sha + semver tag
7. Update deployment manifest (GitOps commit or CD trigger)
8. Deploy to staging → smoke → e2e
9. Manual/auto promote to prod
10. Post-deploy verification (SLO, synthetic checks)
```

### GitHub Actions example — build and push

```yaml
name: orders-service-ci
on:
  push:
    branches: [main]
    paths: ['orders-service/**']

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'
          cache: maven

      - name: Test
        working-directory: orders-service
        run: ./mvnw -B verify

      - name: Build image
        working-directory: orders-service
        run: |
          docker build -t ${{ env.REGISTRY }}/orders-service:${{ github.sha }} .
          docker push ${{ env.REGISTRY }}/orders-service:${{ github.sha }}

      - name: Scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/orders-service:${{ github.sha }}
          severity: CRITICAL,HIGH
          exit-code: 1
```

### Artifact immutability

| Practice | Anti-pattern |
|---|---|
| Tag `git SHA` + semver on release | Rebuild same tag with different content |
| Pin digest in prod manifest | `:latest` in prod |
| SBOM attached to release | "We know what's running" — no you don't |

### Production scenario: CI green, prod missing fix

**Problem.** Bug fixed in main. Prod still broken three days later.

**Cause.** CD stops at artifact push — no auto-promote. Or staging-only deploy. Or GitOps repo not updated. Or prod pinned to old chart version.

**Solution.** Single "source of truth" promotion path. Argo CD Image Updater or CI bot commits digest to env repo. Dashboard showing **running digest vs main HEAD**.

### DORA metrics connection

| Metric | Deployment practice impact |
|---|---|
| Deployment frequency | Small batches, automated pipeline |
| Lead time for changes | CI parallelism, no manual handoffs |
| Change failure rate | Smoke tests, canaries, rollbacks |
| MTTR | Helm/Argo rollback, feature flags kill switch |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| No integration tests in CI | Schema/API breaks in prod |
| Shared pipeline without path filters | 45 min build for typo in README |
| Secrets in CI logs | Credential rotation incident |
| Deploy without database migration ordering | App ahead of schema |

### Debugging scenario

**Observe.** Pipeline fails at "push image" intermittently.

**Diagnose.** Registry rate limit? OIDC token expiry? Layer too large?

**Fix.** ECR pull-through cache, optimize Dockerfile layers, retry with backoff.

---

## 12. Infrastructure as Code (IaC)

### Core concept

**Infrastructure as Code** declares cloud and cluster resources in version-controlled files (Terraform, OpenTofu, Pulumi, CloudFormation, Crossplane). Same principles as app code: review, test, plan/apply, drift detection.

Scope for microservices platforms:

| Layer | Tool examples |
|---|---|
| Network/VPC/subnets | Terraform |
| EKS/GKE/AKS cluster | Terraform modules |
| RDS, Kafka, Redis | Terraform + provider |
| In-cluster addons (Ingress, cert-manager) | Terraform helm_release or GitOps |
| App workloads | GitOps (Argo CD) — often separate repo from infra |

### Terraform pattern — EKS + node groups

```hcl
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "prod-platform"
  cluster_version = "1.29"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  eks_managed_node_groups = {
    general = {
      min_size     = 3
      max_size     = 20
      desired_size = 5
      instance_types = ["m6i.large"]
    }
  }

  enable_cluster_creator_admin_permissions = true
}
```

### State and environments

| Practice | Why |
|---|---|
| Remote state (S3 + DynamoDB lock) | Team collaboration, no local state loss |
| Separate state per env | Blast radius containment |
| Module versioning | Pin module git ref / registry version |
| `terraform plan` in CI | Review before apply |

### Production scenario: terraform apply deleted prod RDS

**Problem.** Engineer runs apply with wrong var; `prevent_destroy` missing.

**Cause.** Manual apply from laptop. No plan review. Shared module default changed.

**Solution.** CI-only apply for prod. `lifecycle { prevent_destroy = true }` on stateful resources. Drift detection daily. Break-glass procedure documented.

### IaC vs GitOps boundary

**Terraform** provisions **slow-changing infra** (cluster, VPC, RDS). **GitOps** reconciles **fast-changing app manifests** (Deployments, ConfigMaps). Mixing app Deployments in Terraform couples unrelated lifecycles — anti-pattern for high-frequency deploys.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Local state on laptop | State loss; team overwrite |
| Secrets in tfvars committed | Vault leak |
| No module pins | Surprise breaking upgrade |
| Giant monolith module | 45 min plan; fear of change |

### Debugging scenario

**Observe.** New node pool cannot pull images from ECR.

**Diagnose.** IAM role on node group? VPC endpoints for ECR in private subnet?

**Fix.** Terraform module output → verify `iam_role_additional_policies`.

---

## 13. GitOps — Declarative Operations from Git

### Core concept

**GitOps** uses Git as the single source of truth for **desired cluster state**. An operator (Argo CD, Flux) continuously reconciles cluster ↔ repo. Deploy = merge PR changing image digest. Rollback = revert commit or `argocd app rollback`.

```
Dev merges PR → updates envs/prod/orders-service/kustomization.yaml (new digest)
  └─ Argo CD detects drift
       └─ Sync → kubectl apply
            └─ Health assessment (Deployment ready, Job succeeded)
                 └─ Slack notification / promotion gate
```

### Argo CD Application

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: orders-service-prod
  namespace: argocd
spec:
  project: checkout
  source:
    repoURL: https://github.com/org/k8s-manifests.git
    targetRevision: main
    path: envs/prod/orders-service
  destination:
    server: https://kubernetes.default.svc
    namespace: checkout
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas   # HPA owns replicas
```

### Sync waves for ordering

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "1"   # Namespace, CRDs
# migration Job wave 2
# Deployment wave 3
# Ingress wave 4
```

Migrations before app pods. CRDs before operators.

### Production scenario: Argo CD auto-sync pruned production Ingress

**Problem.** Weekend outage — Ingress deleted.

**Cause.** `prune: true` + resource removed from Git during refactor. Or wrong `Application` path pointed at incomplete kustomization.

**Solution.** `Prune=false` for critical shared infra or separate Application with manual sync. Use `resource.exclusions`. Preview `argocd app diff` in CI on PR.

### GitOps vs push-based CD

| Push (Jenkins kubectl) | GitOps (Argo/Flux) |
|---|---|
| Cluster creds in CI | CI only writes Git |
| Hard to audit "what should run" | Git history = audit |
| Drift invisible | Self-heal or drift alert |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auto-sync prod without review | Bad merge → immediate outage |
| Encrypted secrets in Git without SOPS/SealedSecrets | Plaintext leak |
| One Application for entire cluster | Blast radius; slow sync |
| Ignore HPA replica drift missing | Sync fight — deploy flapping |

### Debugging scenario

**Observe.** Argo CD "Progressing" forever.

**Diagnose.** `argocd app get orders-service-prod`. Failed hooks? CrashLoop pods? Compare desired vs live manifest.

**Fix.** Sync wave ordering. Fix health check custom resource definition.

---

## 14. Continuous Delivery vs Continuous Deployment

### Core concept

| Term | Meaning |
|---|---|
| **Continuous Integration (CI)** | Every commit integrated and tested automatically |
| **Continuous Delivery (CDel)** | Every commit is **release-ready**; promotion to prod is a **manual business decision** (button/trigger) |
| **Continuous Deployment (CDep)** | Every commit that passes pipeline **automatically** goes to production |

Continuous Delivery = always deployable + human gate. Continuous Deployment = no human gate (feature flags and strong automation replace human approval).

### Maturity ladder

```
Level 0: Manual build, SSH deploy
Level 1: CI builds artifact
Level 2: Automated deploy to staging
Level 3: Continuous Delivery — one-click prod
Level 4: Continuous Deployment — auto prod with automated rollback
Level 5: Progressive delivery — canary analysis drives promotion
```

### When manual prod gate is correct

| Context | Prefer |
|---|---|
| Regulated (finance, healthcare) | Continuous Delivery + audit trail |
| Small team, strong tests + canary | Continuous Deployment |
| B2B with maintenance windows | Continuous Delivery + scheduled promote |
| Early product-market fit | Continuous Delivery — control narrative |

### Production scenario: "we do CD" but releases monthly

**Problem.** Team claims Continuous Deployment. Reality: 4-week QA cycle, manual regression, Friday deploy moratorium.

**Cause.** Pipeline deploys automatically to **staging only**. Prod requires change advisory board. Test gap fear.

**Solution.** Honest maturity assessment. Invest in automated e2e, contract tests, canaries — shrink batch size. Monthly big-bang increases failure size (DORA change failure rate).

### Feature flags bridge the gap

Continuous Deployment with **trunk-based development** often pairs with **flags off in prod** until validated — deploy code ≠ expose feature.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Auto-deploy without rollback automation | Long MTTR |
| Manual gate without SLA | Queue of 200 "ready" builds |
| Same pipeline name for staging and prod | Confusion in incident comms |

### Debugging scenario

**Observe.** Stakeholders ask "is fix in prod?" — team debates 20 minutes.

**Diagnose.** No single dashboard for digest per env. Tags differ (`2.4.1` vs `2.4.1-hotfix`).

**Fix.** GitOps commit SHA → image digest → Argo CD sync status. One URL for release truth.

---

## 15. Blue-Green Deployment

### Core concept

**Blue-green** runs two **identical environments**: Blue (current prod) and Green (new version). Switch traffic atomically (DNS, LB, Ingress swap). Rollback = switch back to Blue.

```
                    ┌─────────┐
  Users ───────────►│   LB    │
                    └────┬────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        ┌──────────┐         ┌──────────┐
        │  Blue    │         │  Green   │
        │  v2.4.0  │         │  v2.4.1  │
        └──────────┘         └──────────┘
              ▲                     │
              │   swap pointer      │
              └─────────────────────┘
```

### Kubernetes implementation patterns

| Pattern | Mechanism |
|---|---|
| Two Deployments + Service selector switch | Change Service `selector` version label |
| Two Services + Ingress backend swap | Update Ingress annotation |
| Argo Rollouts blueGreen strategy | Automated promotion/rollback |
| Cloud LB target group swap | AWS CodeDeploy, ALB weighted |

### Argo Rollouts blue-green

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: orders-service
spec:
  replicas: 5
  strategy:
    blueGreen:
      activeService: orders-active
      previewService: orders-preview
      autoPromotionEnabled: false
      scaleDownDelaySeconds: 300
  selector:
    matchLabels:
      app: orders-service
  template:
    metadata:
      labels:
        app: orders-service
    spec:
      containers:
        - name: app
          image: orders-service:2.4.1
```

Test Green via `orders-preview` Service before promoting to `orders-active`.

### Database coupling — the hard part

Blue and Green must be **compatible with same database schema** during switch unless you clone DB (expensive). Use expand-contract migrations: Green reads/writes columns both versions understand.

### Production scenario: green deployed, switch causes 500, rollback slow

**Problem.** Traffic swapped to Green. Error rate 30%. Rollback takes 8 minutes — DNS TTL 300s.

**Cause.** DNS-based switch without low TTL prep. Green incompatible with prod data edge case.

**Solution.** LB/Ingress instant switch (no DNS). Pre-switch smoke on preview Service. Automated rollback on SLO breach. Keep Blue warm 24h.

### When blue-green fits

| Fit | Misfit |
|---|---|
| Need instant rollback | Cost of 2× prod capacity long-term |
| Stateful session on LB (sticky) — careful | Tiny services where roll is enough |
| Compliance requires parallel validation | Database schema breaking change without expand |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Green shares in-memory cache with Blue | N/A — must not share unless designed |
| Schema migration only on Green | Blue breaks if rollback after destructive migration |
| Forgot to warm Green | Cold start latency spike on switch |

### Debugging scenario

**Observe.** Preview URL healthy; active swap fails users.

**Diagnose.** Different config/secrets between Services? Session affinity to old pods?

**Fix.** Parity checklist: ConfigMap, Secret, env, HPA, NetworkPolicy identical except image.

---

## 16. Canary Deployment

### Core concept

**Canary** routes a **small fraction** of traffic to the new version while monitoring metrics. Increase weight if SLOs hold; abort if error rate or latency regresses. Finer-grained than blue-green; less capacity duplication.

```
100% traffic ──► v1 (stable)
 5% traffic ──► v2 (canary)  ── metrics: error rate, p99, business KPI
```

### Implementation options

| Layer | Tool |
|---|---|
| Ingress / Gateway | NGINX canary annotation, Gateway API weights |
| Service mesh | Istio VirtualService weights |
| Argo Rollouts | Automated analysis + promotion |
| App gateway | Custom header routing (`x-canary: true`) |

### Argo Rollouts canary with analysis

```yaml
strategy:
  canary:
    steps:
      - setWeight: 5
      - pause: { duration: 10m }
      - analysis:
          templates:
            - templateName: success-rate
          args:
            - name: service-name
              value: orders-service
      - setWeight: 25
      - pause: { duration: 10m }
      - setWeight: 50
      - pause: { duration: 10m }
      - setWeight: 100
```

Analysis template queries Prometheus:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  metrics:
    - name: success-rate
      interval: 1m
      successCondition: result[0] >= 0.99
      provider:
        prometheus:
          address: http://prometheus:9090
          query: |
            sum(rate(http_server_requests_seconds_count{service="orders-service",status!~"5.."}[2m]))
            /
            sum(rate(http_server_requests_seconds_count{service="orders-service"}[2m]))
```

### Production scenario: canary looks healthy, full promote fails

**Problem.** 5% canary error rate 0.1%. At 50% weight, checkout payment failures spike.

**Cause.** **Cardinality** — canary too small for rare code paths. Payment provider rate limit hit only at scale. Cache warm on canary pods only.

**Solution.** Longer pause at low weight. Business metric gates (successful payment count). Load test canary path before promote. Synthetic transactions in analysis.

### Canary vs A/B testing

Canary validates **safety** of release. A/B tests **product hypothesis**. Same traffic split machinery; different success criteria and duration.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Canary by random without session stickiness | User sees inconsistent API behavior |
| Only CPU metrics in analysis | Miss logic bugs |
| Shared Kafka consumer group v1+v2 | Rebalance chaos — use separate group or rolling only |

### Debugging scenario

**Observe.** Canary pods healthy but no traffic.

**Diagnose.** Weight config on wrong VirtualService host. Service selector includes both versions on stable Service.

**Fix.** Separate subset labels; verify with `istioctl proxy-config routes`.

---

## 17. Rolling Deployment

### Core concept

**Rolling deployment** replaces pods incrementally: old pods terminate as new pods become ready. Default Kubernetes `Deployment` strategy. No duplicate environment cost; rollback = undo rollout to previous ReplicaSet.

```
Replicas: 3, maxSurge: 1, maxUnavailable: 0

Step 1: [v1][v1][v1] → create v2 pod
Step 2: [v1][v1][v1][v2] → v2 ready → terminate v1
Step 3: [v1][v1][v2] → repeat until all v2
```

### Production scenario: rolling deploy causes brief 503

**Problem.** During roll, load balancer sends traffic to terminating pod.

**Cause.** No `preStop` hook; Endpoints lag; `terminationGracePeriodSeconds` too short; client keep-alive to dead pod.

**Solution.** `preStop sleep 5`; graceful shutdown; readiness fails before liveness on shutdown; `maxUnavailable: 0`.

### When rolling is enough

| Fit | Consider canary/blue-green instead |
|---|---|
| Backward-compatible change | High-risk payment path |
| ≥3 replicas, good probes | Schema migration with dual-write complexity |
| Stateless services | Need instant full rollback |

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| 1 replica rolling | Downtime |
| maxUnavailable 50% with 2 replicas | Half capacity gone — timeouts |
| New version fails readiness slowly | Stuck roll, mixed versions long window |

### Debugging scenario

**Observe.** Rollout paused at 50%.

**Diagnose.** `kubectl rollout status`. New RS pods CrashLoop? PDB blocking?

**Fix.** Fix new version or `kubectl rollout undo`.

---

## 18. Rolling Update Strategies

### Core concept

Kubernetes `Deployment.strategy.rollingUpdate` knobs:

| Field | Effect |
|---|---|
| `maxSurge` | Extra pods above desired count during update (absolute or %) |
| `maxUnavailable` | Pods that can be down during update |
| `minReadySeconds` | Pod must be ready N seconds before counted available |
| `progressDeadlineSeconds` | Fail rollout if no progress |

### Strategy presets

**Zero-downtime (recommended default):**

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```

**Fast replace (accept brief capacity hit):**

```yaml
rollingUpdate:
  maxSurge: 100%
  maxUnavailable: 25%
```

**Recreate (downtime — rare):**

```yaml
strategy:
  type: Recreate
```

Use Recreate only when **two versions cannot coexist** (breaking port bind, incompatible singleton).

### Surge math example

`replicas: 10`, `maxSurge: 3`, `maxUnavailable: 0` → up to 13 pods during roll (10 old + 3 new starting). Ensure cluster capacity and HPA headroom.

### Production scenario: cluster autoscaler lag during surge

**Problem.** Rollout Pending pods — insufficient CPU.

**Cause.** Surge creates extra pods; cluster at capacity; CA slow to provision nodes.

**Solution.** Pre-scale node pool before big deploy. Lower maxSurge. Over-provision requests buffer.

### StatefulSet rolling — ordered

StatefulSets roll **in order** (reverse on scale down). Critical for quorum systems. Spring microservices usually use Deployment, not StatefulSet.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Percent surge on small replica count | Rounds unexpectedly — read K8s rounding rules |
| No PodDisruptionBudget with maxUnavailable | Node drain kills too many |
| minReadySeconds 0 on slow JVM | Traffic before JIT warm — latency spike |

### Debugging scenario

**Observe.** Deploy takes 40 minutes for 3 replicas.

**Diagnose.** `minReadySeconds: 300`? Startup probe failureThreshold × period too long?

**Fix.** Tune startup probe for JVM; separate warm-up Job if needed.

---

## 19. Zero-Downtime Deployment

### Core concept

**Zero-downtime** means users perceive no service interruption during release. Requires **all** of:

1. **Capacity** — always enough ready pods to serve load
2. **Graceful termination** — drain in-flight work
3. **Health gates** — no traffic until ready
4. **Compatible versions** — old and new coexist during roll
5. **Safe migrations** — DB schema ahead of or compatible with both app versions

Checklist:

```
□ replicas ≥ 3 (or 2 min with PDB and surge)
□ maxUnavailable: 0
□ preStop + graceful shutdown + adequate terminationGracePeriodSeconds
□ readiness includes critical dependencies
□ backward-compatible API and schema (expand-contract)
□ connection draining at LB (deregistration delay)
□ idempotent consumers for async paths
□ feature flags for risky logic — deploy dark
```

### Load balancer connection draining

AWS ALB `deregistration_delay.timeout_seconds` default 300s — align with app shutdown. NGINX `proxy-next-upstream` on errors during roll.

### Production scenario: "zero downtime" deploy still drops websocket orders

**Problem.** HTTP APIs fine; websocket order stream disconnects on every deploy.

**Cause.** Rolling kill without client reconnect; sticky sessions to dying pod; no resume token.

**Solution.** Client reconnect with backoff; server-side session migration or sticky to Service not pod; consider longer grace for websocket endpoint; separate Deployment for websocket handlers if needed.

### Zero-downtime database migrations

See [Database Deployment Strategies](#22-database-deployment-strategies). App deploy without migration discipline is the #1 source of fake "zero downtime."

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Single replica | Guaranteed downtime on roll |
| Kill pod on liveness DB blip | Cascading restart during deploy |
| No client retry on idempotent GET | User-visible blips |

### Debugging scenario

**Observe.** Synthetic monitor blip 30s every deploy.

**Diagnose.** Align synthetic interval with roll timeline. Check endpoint propagation delay.

**Fix.** Increase preStop; verify maxUnavailable 0; run synthetics from outside cluster.

---

## 20. Feature Flags in Release Strategy

### Core concept

**Feature flags** decouple **deployment** (code in prod) from **release** (feature visible to users). Enables trunk-based development, kill switches, and gradual audience rollout without separate canary infrastructure — though best combined with canary for infra-level validation.

Flag types:

| Type | Example |
|---|---|
| **Release flag** | New checkout flow — remove after stable |
| **Ops kill switch** | Disable recommendations if ES cluster red |
| **Experiment / A/B** | Pricing page variant |
| **Permission** | Beta feature for tenant list |

### Spring Boot integration — LaunchDarkly / Unleash / custom

```java
@Service
public class CheckoutService {
    private final FeatureFlags flags;

    public CheckoutResult checkout(CheckoutRequest req) {
        if (flags.isEnabled("new-payment-rail", req.tenantId())) {
            return newRail.checkout(req);
        }
        return legacyRail.checkout(req);
    }
}
```

```yaml
# Unleash via env
UNLEASH_URL: http://unleash.unleash.svc.cluster.local:4242/api
UNLEASH_APP_NAME: orders-service
```

### Production scenario: flag left on, dead code path rots

**Problem.** `new-payment-rail` flag enabled 100% for 2 years. Legacy rail untested; flag removal breaks prod.

**Cause.** No flag lifecycle — "temporary" became permanent.

**Solution.** Flag catalog with owner and expiry. Quarterly cleanup sprint. Default new flags **off** in prod; enable via progressive targeting.

### Flags vs config

Config = environment constants (URLs, pool sizes). Flags = **runtime behavior toggles** with targeting and audit. Do not use ConfigMap for per-tenant experiments — need evaluation service.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Flag check only in UI, not API | Bypass vulnerability |
| Client-side flag only | User enables feature via devtools |
| No default when flag service down | Fail open vs fail closed — pick explicitly |
| 500 flags in one method | Untestable combinatorial explosion |

### Debugging scenario

**Observe.** Feature works for employees, not customers.

**Diagnose.** Targeting rule: `userId in internal-list`. Flag SDK key wrong env (staging key in prod pod).

**Fix.** Separate SDK keys per env via Secret. Integration test both flag states.

---

## 21. Backward and Forward Compatible Deployments

### Core concept

**Backward compatible** (new consumer, old provider): new app version works with old API/DB schema. **Forward compatible** (old consumer, new provider): old app works with new API/DB schema. Safe rolling deploy requires **both directions** during the transition window.

Expand-contract pattern for APIs and schema:

```
Phase 1 EXPAND:  Add new column/API field (optional, nullable)
Phase 2 MIGRATE: Dual-write or backfill data
Phase 3 SWITCH:  New code reads new path
Phase 4 CONTRACT: Remove old column/API (only when no old code runs)
```

### API compatibility rules

| Change | Safe rolling? |
|---|---|
| Add optional JSON field | Yes |
| Remove field | No — contract first |
| Rename field | No — add new, deprecate old |
| Change enum meaning | No |
| Tighten validation | Risky — old clients may break |

Protobuf / OpenAPI with **breaking change detection** in CI:

```bash
buf breaking --against '.git#branch=main'
```

### Production scenario: deploy v2, v1 pods crash on deserialize

**Problem.** Mixed v1/v2 during roll. v1 pods throw `UnrecognizedPropertyException` on internal event with new field.

**Cause.** Kafka event schema added required field without default. v1 consumers not updated.

**Solution.** Schema registry compatibility mode `BACKWARD` or `FULL`. New fields optional with defaults. Deploy consumers before producers or use dual publishing.

### Spring/Jackson

```java
@JsonIgnoreProperties(ignoreUnknown = true)
public record OrderEvent(String orderId, String status) {}
```

Prefer explicit schema versioning: `OrderEventV2` topic or `schemaVersion` header.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Big-bang schema drop | Rollback impossible |
| Shared library DTO across services | One team's field rename breaks six services |
| No contract tests in CI | Green build, red prod |

### Debugging scenario

**Observe.** Errors only during deploy window, then stable.

**Diagnose.** Mixed version metrics by `version` label. Compare serialization logs.

**Fix.** Expand-contract; deploy order: schema → provider → consumer.

---

## 22. Database Deployment Strategies

### Core concept

Database migrations are the **hardest part** of zero-downtime microservices. Each service owns its DB (database-per-service). Migration tools: Flyway, Liquibase. Rule: **migrations must be compatible with at least two app versions** during rolling deploy.

### Expand-contract in SQL

**Phase 1 — Expand:**

```sql
-- V47__add_discount_code.sql
ALTER TABLE orders ADD COLUMN discount_code VARCHAR(64) NULL;
CREATE INDEX CONCURRENTLY idx_orders_discount ON orders(discount_code) WHERE discount_code IS NOT NULL;
```

**Phase 2 — App v2 reads/writes new column; v1 ignores it**

**Phase 3 — Backfill (Job or trigger)**

```sql
UPDATE orders SET discount_code = legacy_promo WHERE discount_code IS NULL AND legacy_promo IS NOT NULL;
```

**Phase 4 — Contract (after all pods v2+):**

```sql
ALTER TABLE orders DROP COLUMN legacy_promo;
```

### Migration execution models

| Model | Pros | Cons |
|---|---|---|
| **Init container / Job per deploy** | Runs once | Must not run parallel on N replicas |
| **Embedded Flyway on startup** | Simple | Race on multi-replica; slow start |
| **Separate migration pipeline** | Clear ordering | Another system to maintain |
| **Online schema change tools** | Large table rewrites | gh-ost, pt-online-schema-change ops complexity |

### Flyway Job (recommended)

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: orders-flyway-2-4-1
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: flyway
          image: flyway/flyway:10
          args:
            - migrate
          env:
            - name: FLYWAY_URL
              valueFrom:
                secretKeyRef:
                  name: orders-db
                  key: jdbc_url
            - name: FLYWAY_USER
              valueFrom:
                secretKeyRef:
                  name: orders-db
                  key: username
            - name: FLYWAY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: orders-db
                  key: password
          volumeMounts:
            - name: migrations
              mountPath: /flyway/sql
      volumes:
        - name: migrations
          configMap:
            name: orders-flyway-sql-2-4-1
```

Argo CD sync wave: Job completes → Deployment syncs.

### Destructive migration anti-patterns

| Anti-pattern | Result |
|---|---|
| `DROP COLUMN` before app stop using it | Immediate 500 on rollback |
| `NOT NULL` without default on existing rows | Migration fail or lock |
| Long table lock on hot table | Outage |
| Rename column in place | Old code breaks |

Use `CREATE INDEX CONCURRENTLY` on Postgres for large tables. Avoid Flyway `clean` in prod — ever.

### Production scenario: Flyway checksum mismatch blocks deploy

**Problem.** All new pods CrashLoop — Flyway validate failed.

**Cause.** Developer edited applied migration file locally instead of adding V48.

**Solution.** Never mutate applied migrations. Add repair procedure (break-glass). CI checksum validation. `flyway repair` only with ticket.

### Cross-service database dependencies

**Forbidden:** Order service migration depends on inventory table. **Allowed:** Order service calls inventory API; each DB independent.

### Common misconfigurations and symptoms

| Misconfiguration | Symptom |
|---|---|
| Migration after traffic shift | New code hits old schema |
| No rollback plan for DDL | Restore from backup only — hours RTO |
| Liquibase/Flyway on all replicas | Lock contention |
| Missing index before query deploy | Full table scan — prod fire |

### Debugging scenario

**Observe.** Deploy OK; queries timeout after migration.

**Diagnose.** Missing index; bad query plan; lock from failed migration.

**Fix.** `EXPLAIN ANALYZE` in staging with prod volume snapshot. Roll forward index migration.

---

## 23. Production Debugging Playbook

When an incident correlates with a deploy, work **time-boxed** and **evidence-first** — do not restart everything before identifying artifact and strategy failure mode.

### 1. Confirm deploy correlation

```bash
kubectl rollout history deployment/orders-service -n checkout
kubectl get pods -n checkout -l app=orders-service -o wide
kubectl describe deployment orders-service -n checkout | grep -A5 Image
```

Compare incident start time to `kubectl rollout status` completion. Check CI pipeline run for same Git SHA.

### 2. Classify the failure surface

| Signal | Likely layer |
|---|---|
| 502/503 from Ingress | No ready endpoints, wrong Service, probe misconfig |
| 500 from app with Ready pods | Code/schema/compat bug |
| Timeout only under load | Resource limits, pool exhaustion, missing index post-migration |
| Partial user impact | Canary weight, feature flag targeting, AZ imbalance |
| All services | Platform (DNS, CNI, cert-manager) not single app |

### 3. Immediate mitigation order

1. **Stop the bleed** — `kubectl rollout undo` or Argo CD rollback to last healthy revision
2. **Disable feature flag** kill switch if code deploy is correct but logic bad
3. **Scale up** stable revision if capacity-related (temporary)
4. **Do not** run destructive DB rollback without restore plan — prefer roll forward compatible fix

### 4. Endpoint and probe verification

```bash
kubectl get endpoints orders-service -n checkout
kubectl get events -n checkout --sort-by='.lastTimestamp' | tail -20
curl -s http://orders-service.checkout.svc/actuator/health/readiness | jq
```

Empty endpoints + Ready pods = Service selector mismatch. Not Ready + Running = readiness failing.

### 5. Compare configurations across revisions

```bash
helm get values orders -n checkout --revision 47
helm get values orders -n checkout --revision 48
kubectl get configmap orders-service-config -o yaml | sha256sum
```

Config drift between canary and stable causes "works at 5%, fails at 100%."

### 6. Database migration state

```sql
SELECT version, description, success, installed_on
FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 10;
```

App log grep: `FlywayException`, `PSQLException`, `BadSqlGrammarException`.

### 7. Traffic and mesh inspection

```bash
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller --since=15m | grep orders
istioctl proxy-config routes orders-pod -n checkout
```

Verify canary weights, upstream health flags.

### 8. Resource and OOM

```bash
kubectl top pods -n checkout -l app=orders-service
kubectl describe pod <pod> | grep -A3 Last State
```

Exit 137 = OOMKill — not "random restart."

### 9. Communication template

```
Impact: checkout POST 15% 500 (EU)
Deploy: orders-service 2.4.1 @ sha256:abc… at 14:02 UTC
Action: rolled back to 2.4.0 @ sha256:def… 14:18 UTC
Hypothesis: migration V47 column mismatch — validating
Next update: 14:30 UTC
```

### 10. Post-incident hardening

| Root cause | Action |
|---|---|
| Bad migration ordering | Sync-wave Job + expand-contract review |
| Missing smoke test | Post-sync Job in GitOps |
| Canary too small | Add business metric to analysis |
| Secret stale on roll | Reloader + rotation runbook |
| No digest pin | Enforce digest in prod PR check |

---

## 24. Quick Decision Matrix

| Situation | Do this |
|---|---|
| First containerized Spring Boot service | Multi-stage Dockerfile, non-root, MaxRAMPercentage, 3 replicas, probes |
| Internal service-to-service only | ClusterIP + NetworkPolicy default deny + explicit egress |
| Public HTTP API | Ingress/Gateway API + cert-manager + WAF at edge |
| Config changes frequently | ConfigMap + Reloader or GitOps roll restart |
| Credentials / API keys | External Secrets Operator + Vault/SM; never ConfigMap |
| Package 50 similar services | Helm chart library + values per env |
| mTLS mandate, L7 traffic split | Service mesh (Linkerd if simple; Istio if complex) |
| Ship commit to staging automatically | CI push image + GitOps sync staging |
| Regulated prod promotions | Continuous Delivery — manual approve after staging SLO |
| Strong test + canary automation | Continuous Deployment + Argo Rollouts analysis |
| Need instant full revert | Blue-green or Helm/Argo rollback to previous digest |
| High-risk payment path | Canary 1→5→25→50→100 with payment success metric |
| Default K8s deploy, compatible schema | RollingUpdate maxSurge 1, maxUnavailable 0 |
| Two versions cannot coexist | Recreate strategy or blue-green with maintenance window |
| Zero-downtime requirement | Graceful shutdown + probes + expand-contract DB + ≥3 replicas |
| Hide incomplete feature in prod | Feature flag default off; deploy code dark |
| Add DB column | Expand (nullable) → deploy app → backfill → contract later |
| Drop DB column | Contract only after **zero** old-version pods + event replay drained |
| Terraform VPC/EKS/RDS | IaC repo, remote state, CI plan/apply |
| App Deployments 10×/day | GitOps repo separate from Terraform; Argo CD not terraform apply |
| JVM OOMKilled in K8s | Remove fixed -Xmx; MaxRAMPercentage; raise limit headroom |
| Deploy breaks only websockets | Separate handler deployment or client reconnect contract |
| Image vulnerability gate | Trivy/Grype fail CRITICAL in CI |
| Drift between staging and prod | Same Helm chart; diff values only; no snowflake manifests |

---

## 25. Scenario-Based Questions

### Q1. Deploy succeeds but Ingress returns 502 for ten minutes. Pods show Running and Ready. What do you check?

**Root cause pattern:** Service **`targetPort` mismatch**, Ingress backend pointing to wrong Service/port, or Endpoints empty due to **selector label typo** while probes hit a different port (management sidecar).

**Fix:** `kubectl get endpoints` — if empty, fix selector. Port-forward pod directly vs curl via Service vs curl via Ingress to isolate layer. Verify container listens on `server.port` matching `targetPort`.

---

### Q2. After enabling NetworkPolicy default-deny, all services fail DNS resolution. Why?

**Root cause:** Egress to **kube-dns** (UDP/TCP 53) not allowed. Policies are enforced by CNI; without DNS allow, `inventory-service.checkout.svc.cluster.local` fails intermittently or always.

**Fix:** Add egress rule to kube-system/kube-dns for every namespace with default-deny. Document standard policy template.

---

### Q3. Team updates ConfigMap log level but running pods unchanged. Is Kubernetes broken?

**Root cause:** ConfigMap updates **do not restart pods**. Env vars injected at start are immutable. File mounts may update but Spring Boot does not reload without refresh endpoint or restart.

**Fix:** Stakater Reloader annotation, `kubectl rollout restart`, or Spring Cloud Bus. Treat config change as release event.

---

### Q4. Rolling deploy of single-replica service causes user-visible downtime. Expected?

**Root cause:** Yes — with **one replica** and `RollingUpdate`, unless surge creates second pod first (`maxSurge ≥ 1` and cluster capacity), old pod terminates before new is ready.

**Fix:** Minimum 2–3 replicas for HA; `maxUnavailable: 0`; `maxSurge: 1`. PDB `minAvailable: 1`.

---

### Q5. Flyway migration runs on every pod startup; deploy sometimes hangs on migration lock. Fix?

**Root cause:** **Concurrent migration** from N replicas — Flyway advisory lock contention; race on startup.

**Fix:** Run Flyway once as **Helm pre-upgrade Job** or Argo sync-wave Job. Disable embedded Flyway in app pods or use `spring.flyway.enabled=false` in runtime profile.

---

### Q6. Canary at 5% shows 0.01% errors; at 50% payment failures spike. Canary lied?

**Root cause:** Sample size too small for **rare path**; downstream rate limits; cache warming; **anti-affinity** causing canary pods on weak nodes only at low weight.

**Fix:** Analysis on business metrics (payment success rate). Longer bake time at 5%. Ensure canary pods representative (spread constraints). Load test before full promote.

---

### Q7. Blue-green switch completed in 30 seconds but users report errors for 5 minutes.

**Root cause:** **DNS TTL** caching old IP; mobile app connection pool; **websocket** sticky sessions; CDN cache of error responses.

**Fix:** Switch at load balancer/Ingress not DNS. Lower TTL before migration event. Client reconnect logic. Invalidate CDN if applicable.

---

### Q8. GitOps auto-sync removed production Ingress during refactor. Prevention?

**Root cause:** `prune: true` + resource deleted from Git; or wrong Application path.

**Fix:** Separate Applications for shared infra; `Prune=false` for critical resources; PR preview with `argocd app diff`; sync windows for prod.

---

### Q9. New pods OOMKilled immediately; local Docker run fine with same JAR.

**Root cause:** JVM **heap larger than cgroup memory limit**; missing `UseContainerSupport`/`MaxRAMPercentage`; fixed `-Xmx2g` with 512Mi limit.

**Fix:** `JAVA_TOOL_OPTIONS=-XX:MaxRAMPercentage=75.0`; align limits with heap + metaspace + overhead; remove fixed -Xmx.

---

### Q10. Continuous Deployment vs Continuous Delivery — which for a bank's payment API?

**Root cause pattern (interview):** Regulatory change control, audit trails, and human accountability favor **Continuous Delivery** — automated pipeline to prod-ready artifact with **manual promotion** and evidence. Continuous Deployment can exist for lower-risk internal services with same rigor.

**Fix:** Tier services by risk; payment on CDel + canary + manual approve; internal tools on CDep if automated rollback proven.

---

### Q11. Schema migration adds `NOT NULL` column without default on 50M row table. Deploy Friday. Outcome?

**Root cause:** Table rewrite lock or migration failure; **backward incompatibility** if migration runs before expand phase complete.

**Fix:** Expand: nullable column → backfill Job → set NOT NULL in later migration after backfill. Use `CREATE INDEX CONCURRENTLY`. Never Friday.

---

### Q12. Two versions running during roll; v1 consumers fail on Kafka events from v2. Why?

**Root cause:** **Forward compatibility** broken — v2 adds required field or changes semantics; no schema registry compatibility check.

**Fix:** BACKWARD compatible schema changes only; optional fields with defaults; deploy consumers before producers; contract tests in CI with buf/Schema Registry.

---

### Q13. Helm upgrade stuck on pre-upgrade migration hook Job CrashLoopBackOff. Fleet blocked?

**Root cause:** Bad SQL in migration; hook has no timeout; `--wait` blocks release.

**Fix:** `helm rollback`. Fix migration in forward fix. Set Job `activeDeadlineSeconds`. Test migrations against prod-size snapshot in CI.

---

### Q14. Istio mTLS STRICT enabled cluster-wide; legacy VM service breaks. Expected?

**Root cause:** VM not in mesh — cannot present client cert. Strict mTLS rejects plain HTTP from legacy.

**Fix:** PERMISSIVE mode during migration; egress gateway; or mesh-external ServiceEntry + TLS origination at sidecar. Do not STRICT until all callers meshed.

---

### Q15. Feature flag "new-checkout" enabled for 100% but rollback deploy still needed for bug. Why aren't flags enough?

**Root cause:** Bug in **shared code path** outside flag guard; memory leak; dependency upgrade; flag evaluation doesn't cover failing branch; flag service latency caused fallback bug.

**Fix:** Flags complement deploy rollback — narrow blast radius for logic; infra/code bugs still need digest rollback. Always wrap risky paths; test flag-off path in CI.

---

### Q16. Terraform apply changed node group IAM; new pods ImagePullBackOff. Link?

**Root cause:** Node group lost **ECR pull permissions** or VPC endpoint policy broke private ECR access.

**Fix:** Restore IAM policy via terraform revert. Verify `AmazonEC2ContainerRegistryReadOnly` on node role. Test in staging node pool first.

---

### Q17. Zero-downtime claimed but `/actuator/health` liveness includes Kafka. Broker restart killed all pods. Mistake?

**Root cause:** **Liveness must not depend on external systems** — Kafka blip → all pods restart → thundering herd → extended outage.

**Fix:** Kafka in **readiness** only if sync write path requires it; liveness = JVM/thread health only. Outbox pattern decouples publish from request path.

---

### Q18. Argo CD and HPA both modify Deployment replicas; sync flapping. Fix?

**Root cause:** Git declares `replicas: 3`; HPA scales to 10; Argo self-heal resets to 3.

**Fix:** `ignoreDifferences` on `/spec/replicas` in Application spec. Git documents min replicas; HPA owns runtime scale.

---

### Q19. Backward compatible API change — which is safe during rolling deploy?

**Root cause pattern:** Adding **optional** response field and **optional** request field with server ignoring unknowns is safe. Removing/renaming/tightening validation is not.

**Fix:** OpenAPI diff in CI; consumer-driven contracts; expand-contract for events (Protobuf field numbers never reuse).

---

### Q20. Database expand-contract — when is it safe to DROP old column?

**Root cause pattern:** Only when **no running pod** reads/writes old column — verify via deployment revision, metrics labels, and Kafka consumer lag for events referencing old shape.

**Fix:** Phase 4 contract migration in separate release after monitoring confirms 0 traffic on old code path. Keep backup/snapshot before DROP.

---

### Q21. CI builds `:latest` and prod manifest says `:latest`. Rollback how?

**Root cause:** **Mutable tag** — `:latest` now points to broken image; previous digest unknown unless registry retention/list.

**Fix:** Pin **digest** in prod GitOps manifest. Tag git SHA for traceability. Registry immutability policy. Rollback = previous digest in Git revert.

---

### Q22. Spring `server.shutdown=graceful` but requests still fail on deploy. Missing piece?

**Root cause:** No **`preStop` sleep** — kubelet removes Endpoints concurrently with SIGTERM; LB still sends traffic. `terminationGracePeriodSeconds` too short for long requests.

**Fix:** preStop `sleep 5`; terminationGracePeriodSeconds 60; readiness fails on shutdown hook; align LB deregistration delay.

---

*Deploying microservices is a contract between immutable artifacts, compatible schemas, honest health signals, and a release strategy that matches your risk. If you cannot name the digest running in prod, the migration phase you are in, and the rollback command — you are not doing zero-downtime; you are hoping.*

---


