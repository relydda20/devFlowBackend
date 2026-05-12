## Why

The DevFlow API already defines `POST /telemetry` in `openspec.yaml` and has the data models (`Session`, `Activity`) plus an OpenSpec-driven validation middleware in place — but no controller, route, or service actually accepts telemetry batches today. Without this endpoint, the VS Code extension has nowhere to send editor events, and downstream features (stuck-state detection, recommendations) have no data to operate on.

## What Changes

- Add `POST /api/v1/telemetry` route, wired into the Express app, that accepts a `TelemetryBatch` payload (a `user_id` plus one-or-more `TelemetryEvent` entries).
- Add a `TelemetryController` that delegates persistence to a new `TelemetryService`.
- Add a `TelemetryService` that, for each event in the batch, ensures a `Session` row exists for the given `session_id`/`user_id` and inserts a corresponding `Activity` row (using a single transaction per batch).
- Apply the existing `validateRequest('/telemetry')` middleware so payloads are checked against the OpenAPI `TelemetryBatch` schema before reaching the controller.
- Return `202 Accepted` on success with `{ message, accepted_count }`; return `400` (handled by validation middleware) on schema failures; return `500` with a logged error on persistence failures.

## Capabilities

### New Capabilities
- `telemetry-ingestion`: HTTP endpoint and service layer that accept batched telemetry events from the VS Code extension and persist them as `Activity` rows tied to a `Session`.

### Modified Capabilities
<!-- None — `validation` capability is reused as-is. -->

## Impact

- **New files**: `src/routes/telemetry.routes.js`, `src/controllers/telemetry.controller.js`, `src/services/telemetry.service.js`.
- **New/updated entry point**: `src/server.js` (or `src/app.js`) to mount the router; must begin with `import 'dotenv/config'`.
- **Models**: read/write on `Session` and `Activity` — no schema changes.
- **APIs**: implements the already-specified `POST /telemetry` operation in `openspec.yaml`; no spec contract changes.
- **Dependencies**: none added — uses existing `express`, `sequelize`, `ajv`, and the in-repo validation middleware.
- **Out of scope**: workflow-state detection, recommendation generation, authentication of the `user_id` (treated as trusted for now).
