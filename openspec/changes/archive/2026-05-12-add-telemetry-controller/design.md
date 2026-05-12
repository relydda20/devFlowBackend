## Context

The repo already has:
- Sequelize models for `User`, `Session`, and `Activity` ([src/models/](src/models/)) — the persistence layer is ready.
- An OpenAPI contract for `POST /telemetry` accepting a `TelemetryBatch` ([openspec.yaml:159-185](openspec.yaml#L159-L185)).
- An AJV-based validation middleware that reads schemas from the OpenAPI doc at runtime ([src/middleware/validation.middleware.js](src/middleware/validation.middleware.js)).

What's missing is the glue: route → controller → service → DB. Empty directories exist for `controllers/`, `routes/`, `services/`. There is no `app.js`/`server.js` entry point yet (referenced by `package.json` `scripts.start` but not present on disk).

The VS Code extension is the only client and is treated as trusted for this iteration — no auth, no rate limiting beyond what's already pulled in (`express-rate-limit` is in `package.json` but not wired up).

## Goals / Non-Goals

**Goals:**
- Accept `TelemetryBatch` payloads at `POST /api/v1/telemetry` and persist each event as an `Activity` row.
- Validate the payload via the existing OpenSpec-driven middleware so the route stays declarative — when the OpenAPI schema changes, the route changes with it, no code edits.
- Be batch-safe: either all events in a batch persist, or none do (one transaction per request).
- Return promptly (`202 Accepted`) — telemetry ingestion is fire-and-forget from the extension's perspective, so the response body stays minimal.

**Non-Goals:**
- Workflow-state detection or recommendation generation (separate change).
- Authentication / authorization of `user_id` (out of scope for this iteration; `user_id` is taken from the payload at face value).
- Rate limiting and abuse protection (will be layered on later).
- Async/queue-based ingestion. We persist synchronously inside the request lifecycle. A queue may be added once volume justifies it.

## Decisions

### 1. Session resolution: find-or-create per batch
**Decision:** For each unique `session_id` in the batch, the service ensures a `Session` row exists (creating one with `user_id`, `start_time = earliest event timestamp`, `is_active = true` if absent). Events are then inserted referencing that session.

**Why:** The VS Code extension generates `session_id` client-side and may submit events before any explicit "session start" call exists. Failing the batch because the session row hasn't been created yet would force the client to manage extra round-trips. Server-side find-or-create keeps the client simple.

**Alternative considered:** Require an explicit `POST /sessions` before any telemetry. Rejected — it adds a round-trip and a failure mode (race between session create and first event) for no near-term benefit.

### 2. One transaction per batch
**Decision:** Wrap session resolution + all activity inserts in a single Sequelize transaction. If any event fails to persist, the whole batch is rolled back and the client gets `500`.

**Why:** Partial-batch persistence is the worst outcome — the client can't tell what got through and we'd need a per-event response array. All-or-nothing is simpler to reason about and the client can safely retry the whole batch.

**Trade-off:** A single malformed event poisons the whole batch. Acceptable because schema validation already happens upstream, so by the time we reach persistence the payload is well-formed; only DB-level failures (constraint violations, connection loss) should trigger rollback.

### 3. Service layer separation
**Decision:** Controller is thin (parse req, call service, shape response). All Sequelize calls live in `TelemetryService`.

**Why:** Keeps the controller testable without an HTTP harness and makes it trivial to call the same persistence logic from a future queue worker.

### 4. Validation stays at the middleware layer
**Decision:** Use the existing `validateRequest('/telemetry')` middleware unchanged. The controller assumes `req.body` is already a valid `TelemetryBatch`.

**Why:** The middleware is already OpenSpec-driven — re-validating in the controller would duplicate logic and drift over time.

### 5. Response shape: `202 Accepted` + minimal body
**Decision:** Return `202` with `{ message: "Telemetry accepted", accepted_count: <number> }`. No event IDs, no echo.

**Why:** Matches the OpenAPI contract (`202` with a `message` field) and keeps the response small. The client doesn't currently need per-event IDs.

## Risks / Trade-offs

- **Trusted `user_id` in payload** → Mitigation: explicitly flagged as non-goal; will be replaced by an auth-derived user once auth lands. Until then, document that `/telemetry` is not safe to expose to the public internet.
- **Synchronous persistence under load** → Mitigation: connection pool is already configured (`max: 10`). For hackathon-scale volume this is fine; revisit when sustained QPS exceeds the pool.
- **Find-or-create races on `session_id`** → Mitigation: rely on the `Session` primary-key uniqueness constraint and catch the unique-violation error path inside the transaction (retry the find). Sequelize's `findOrCreate` handles this internally.
- **Empty `events` array** → Mitigation: not a concern; the OpenAPI schema sets `minItems: 1`, so validation middleware rejects it before the controller runs.

## Migration Plan

This is an additive change — no migrations or rollbacks needed at the data layer. Deployment is just shipping the new files plus a minimal `src/server.js` entry point. Rollback is reverting the commit; no DB state is left behind because `Activity`/`Session` tables already exist.

## Open Questions

- Should the response include the resolved `session_id`s (in case the server created any)? Punted — the client already knows them.
- Should we accept events with timestamps in the future? Current stance: trust the client, but flag if this becomes a data-quality issue.
