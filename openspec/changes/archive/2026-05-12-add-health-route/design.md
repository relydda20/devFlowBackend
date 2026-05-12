## Context

The Express app from `add-telemetry-controller` is the first server in this repo. There is no operational endpoint to check liveness yet. The telemetry endpoint requires a valid `TelemetryBatch` and a database round-trip, so a 200 from it doesn't prove "the process is up" — it proves "the process is up *and* the DB is reachable *and* a valid payload was constructed." Those are three different things to verify, and an operator wants the simplest one first.

## Goals / Non-Goals

**Goals:**
- One GET endpoint that returns 200 with a constant body, with no I/O of any kind.
- Reachable at a stable path so probes can be configured once and forgotten.
- Survives DB outages — proves the Node process is alive even when Postgres is down.

**Non-Goals:**
- Readiness checks (DB ping, dependency health). Those belong in a separate `/ready` endpoint added later, not here.
- Version/build metadata. Useful eventually, but not needed for a "routes work" smoke test.
- Inclusion in the OpenAPI contract (`openspec.yaml`). Health is an operational concern; product APIs go in the spec.

## Decisions

### Path: `/api/v1/health`
**Decision:** Mount under the same `/api/v1` prefix as `telemetry`.

**Why:** Consistent with the existing route structure; one prefix to remember. Some teams put `/health` at the root (outside the version prefix) to make it survive API version changes — defensible, but a non-issue today because we have one version.

### No middleware
**Decision:** The handler runs without `helmet` overrides, without `validateRequest`, without any per-route middleware.

**Why:** Global `helmet`/`cors` already apply. Adding per-route validation would defeat the "no dependencies" goal of a liveness probe.

### Response body: `{ status: "ok" }`
**Decision:** Constant JSON, no timestamp, no uptime.

**Why:** Keeps the response cacheable and trivial to assert on. Adding a timestamp every request makes the body non-deterministic without providing useful operational signal — a probe just needs the 200.

## Risks / Trade-offs

- **No DB check means a "healthy" server can still fail real traffic** → Mitigation: by design. This is a liveness probe, not a readiness probe. When we add `/ready` it will do the DB check; orchestrators should hit both.
- **Endpoint outside OpenAPI contract** → Mitigation: documented in the proposal as intentional. Operational endpoints don't need client SDK generation.
