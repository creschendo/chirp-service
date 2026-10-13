# Deployment

> Goal: practice deploying chirp-service to a local Kubernetes cluster. Outline only; manifests in `k8s/` are stubs.

## Local cluster
- Choosing between kind and k3d (ingress support, built-in registry, load balancer)
- Creating and deleting the cluster
- Installing an ingress controller

## Building and loading images
- What the Dockerfile needs to do (base image, production deps, non-root user, start command)
- What `.dockerignore` excludes and why
- Getting the image into the cluster (`kind load` / `k3d image import` vs. a local registry)
- Image tagging strategy (avoiding stale `latest` images)

## Kustomize layout
- What goes in `k8s/base/` vs. `k8s/overlays/local/`
- How a future overlay (e.g. a cloud environment) would differ

## Config and secrets
- Which env vars go in a ConfigMap vs. a Secret
- How secrets are created locally without committing them (`secret.example.yaml` as a template only)
- How config changes roll out to running pods

## Running migrations as a Job
- When the migration Job runs relative to a new deployment
- Making sure only one migration runs at a time
- What happens if a migration fails
- Using the same image as the API vs. a separate one

## Health probes
- Liveness vs. readiness vs. startup probes and what each one checks (see `src/health/`)
- Probe timing (initial delay, period, failure threshold)

## Graceful shutdown on SIGTERM
- What Kubernetes does when a pod is terminated (SIGTERM, grace period, SIGKILL)
- Ordering: fail readiness, stop accepting connections, finish in-flight requests, close sockets, close the DB pool
- Making sure the process receives SIGTERM (start command, PID 1)
- What connected Socket.IO clients experience during a rollout

## Postgres: in-cluster vs. managed
- In-cluster StatefulSet for local practice: persistent volumes, data surviving restarts
- Tradeoffs vs. a managed database (backups, upgrades, failover)
- How the API finds the database in each case

## Ingress and WebSockets
- Routing HTTP and WebSocket traffic through the ingress
- Timeouts for long-lived connections
- Local hostnames and CORS for chirp-client

## Scaling replicas
- What must be stateless for multiple API replicas to work
- Effect of multiple replicas on Socket.IO (see milestone 8 in [roadmap.md](roadmap.md))
- Resource requests/limits; whether to try a HorizontalPodAutoscaler

## Observability
- Reading logs from stdout with kubectl
- Debugging failed pods (events, describe, exec)

## Open questions
- How will Socket.IO events reach users connected to a different pod?
- Do WebSocket connections need sticky sessions?
- kind or k3d, and why?
- Should migrations run as a Job, an init container, or a Helm/Kustomize hook-style step?
- How will you manage secrets beyond local practice (sealed secrets, external secret store)?
- What should the grace period be, given long-lived socket connections?
- Will Redis run in-cluster for milestone 8? As a Deployment or a StatefulSet?
