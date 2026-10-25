# health module

## Responsibility

- Liveness and readiness checks used by Kubernetes probes (and anyone else checking the service)

## What it needs to handle

- Liveness: is the process running and able to respond?
- Readiness: can this pod serve traffic right now (e.g. database reachable)?
- Reporting "not ready" while the server is shutting down
- Staying cheap and fast, without auth

## Interacts with

- `db/`: checking the database connection for readiness
- `server.js`: shutdown state during graceful shutdown
- `k8s/base/deployment.yaml`: probe configuration

## Open questions

- Which dependencies should readiness check: only Postgres, or Redis too once it's added?
- Should liveness ever check the database? (What happens if Postgres is down and every pod restarts?)
- How much detail should the response reveal?
- Should health routes skip request logging to avoid noisy logs?
