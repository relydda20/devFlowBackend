<!--
PRECONDITION: This delta MODIFIES requirements from the `telemetry-ingestion` capability
introduced in `add-telemetry-controller`. The telemetry change MUST be archived first
(`/opsx:archive add-telemetry-controller`) so the canonical spec exists at
`openspec/specs/telemetry-ingestion/spec.md` and the headers below resolve correctly.
-->

## MODIFIED Requirements

### Requirement: Telemetry batch endpoint
The system SHALL expose `POST /api/v1/telemetry`, protected by JWT authentication middleware, that accepts a JSON `TelemetryBatch` (a non-empty array of `TelemetryEvent` entries) and persists each event as an `Activity` row tied to the authenticated user. The request body MUST NOT contain a `user_id` field — the user is derived from the JWT.

#### Scenario: Valid batch is accepted
- **WHEN** an authenticated client posts a well-formed `TelemetryBatch` with one or more events
- **THEN** the server responds with HTTP `202` and a JSON body containing `message` and `accepted_count` equal to the number of events persisted, with all rows linked to the `user_id` derived from the JWT

#### Scenario: Missing or invalid JWT
- **WHEN** a client posts a batch without a valid JWT (no header, no cookie, expired, bad signature)
- **THEN** the server responds with HTTP `401` and no rows are written, before any validation or persistence runs

#### Scenario: Schema-invalid batch is rejected
- **WHEN** an authenticated client posts a body that fails the `TelemetryBatch` OpenAPI schema (missing required field, unknown `event_type`, malformed `timestamp`, empty `events` array)
- **THEN** the server responds with HTTP `400` and a body containing `error: "Validation failed"` and per-field `details`, and no rows are written

#### Scenario: Persistence failure rolls back the batch
- **WHEN** the database raises an error while inserting any event in the batch
- **THEN** the server responds with HTTP `500`, logs the error, and no rows from that batch remain in `activities` or `sessions`

## REMOVED Requirements

### Requirement: Unknown user is rejected
**Reason**: Replaced by JWT authentication. There is no longer a code path that accepts a `user_id` from request bodies, so the "unknown user" case cannot occur — unauthenticated requests are rejected `401` by the middleware before reaching the controller.
**Migration**: Clients must obtain a JWT via `GET /api/v1/auth/:provider` and send it in `Authorization: Bearer <jwt>` (or as a `session` cookie for browser clients). The `user_id` field is no longer read from the request body.
