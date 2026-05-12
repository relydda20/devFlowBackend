## Why

After wiring up the telemetry controller, there's no quick way to confirm the Express app is reachable without sending a full `TelemetryBatch`. A trivial `GET` endpoint that returns 200 makes it easy to check "is the server up?" from a browser, `curl`, a load balancer, or a Kubernetes probe — independent of database state.

## What Changes

- Add `GET /api/v1/health` that returns `200` with `{ status: "ok" }`.
- Mount it on the same router structure as the telemetry route so it proves the routing + middleware chain works end-to-end.
- No auth, no DB calls — this endpoint must succeed even when the database is unreachable, so it's a true liveness check.

## Capabilities

### New Capabilities
- `health-check`: a public, no-side-effects endpoint that reports the service is running.

### Modified Capabilities
<!-- None -->

## Impact

- **New files**: `src/routes/health.routes.js`.
- **Updated**: `src/server.js` mounts the new router (one line).
- **No dependencies added**, no DB schema changes, no spec changes to `openspec.yaml` (this endpoint is intentionally outside the OpenAPI contract since it's an operational concern, not a product API).
- **Out of scope**: readiness probes that check DB connectivity, version/build info, dependency-status reporting.
