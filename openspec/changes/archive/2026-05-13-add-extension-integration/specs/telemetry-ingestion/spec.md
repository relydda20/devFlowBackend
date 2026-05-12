## MODIFIED Requirements

### Requirement: Telemetry batch endpoint
The system SHALL expose `POST /api/v1/telemetry`, protected by auth middleware that accepts either a JWT or a `dvf_`-prefixed API token, that accepts a JSON `TelemetryPayload` (an object with `workspace`, `machine_timestamp`, `session` aggregate, and a non-empty `events` array of typed `TelemetryEvent` entries) and persists each event as an `Activity` row tied to the authenticated user. The request body MUST NOT contain a `user_id` field — the user is derived from the credential.

#### Scenario: Valid payload is accepted
- **WHEN** an authenticated client posts a well-formed `TelemetryPayload` with one or more events
- **THEN** the server responds with HTTP `202` and a JSON body containing `message` and `accepted_count` equal to the number of events persisted, with all rows linked to the `user_id` derived from the credential

#### Scenario: Missing or invalid credential
- **WHEN** a client posts a payload without a valid JWT or API token (no header, expired JWT, bad JWT signature, revoked or unknown API token)
- **THEN** the server responds with HTTP `401` and no rows are written, before any validation or persistence runs

#### Scenario: Schema-invalid payload is rejected
- **WHEN** an authenticated client posts a body that fails the `TelemetryPayload` OpenAPI schema (missing top-level `workspace` / `machine_timestamp` / `session` / `events`; unknown event `type`; event missing `session_id` or `timestamp`; empty `events` array)
- **THEN** the server responds with HTTP `400` and a body containing `error: "Validation failed"` and per-field `details`, and no rows are written

#### Scenario: Persistence failure rolls back the batch
- **WHEN** the database raises an error while inserting any event in the batch
- **THEN** the server responds with HTTP `500`, logs the error, and no rows from that batch remain in `activities` or `sessions`

### Requirement: Session auto-resolution
The system SHALL ensure a `Session` row exists for each unique `session_id` present in the payload's events before inserting their activities, creating one tied to the authenticated `user_id` if absent. `session_id` is supplied per event by the client; the server SHALL NOT generate it.

#### Scenario: Session already exists for the same user
- **WHEN** the payload references a `session_id` that already has a `Session` row owned by the authenticated user
- **THEN** activities are inserted against the existing session and no duplicate `Session` row is created

#### Scenario: Session does not exist yet
- **WHEN** the payload references a `session_id` with no corresponding `Session` row
- **THEN** the server creates a `Session` with that `session_id`, `user_id` from the credential, `is_active = true`, and `start_time` equal to the earliest event timestamp for that `session_id` in the payload, then inserts the activities against it

#### Scenario: Session belongs to a different user
- **WHEN** the payload references a `session_id` that already has a `Session` row owned by a different `user_id`
- **THEN** the server responds with HTTP `409` and body `{ error: "Session ownership conflict" }`, and no rows from the batch are written

### Requirement: Activity persistence shape
The system SHALL store each event as one `Activity` row capturing `session_id`, `event_type` (derived from event `type`), `file_path` (lifted from `file.path` when present, NULL otherwise), `metadata` (the event's remaining typed fields stored as JSONB), and `timestamp`.

#### Scenario: file_save event maps to columns
- **WHEN** a `file_save` event with `file: { path: "src/foo.js", language: "javascript", lines: 42, ... }` is persisted
- **THEN** an `Activity` row exists with `event_type="file_save"`, `file_path="src/foo.js"`, `metadata` containing the entire `file` block as JSONB, and matching `timestamp` and `session_id`

#### Scenario: editor_switch event with no top-level file
- **WHEN** an `editor_switch` event with `from`, `to`, and `metrics` blocks (no top-level `file`) is persisted
- **THEN** the `Activity` row has `file_path = NULL`, `event_type = "editor_switch"`, and `metadata` containing `from`, `to`, and `metrics`

#### Scenario: Unknown typed fields pass through to metadata
- **WHEN** an event carries a typed field not yet recognized by the controller (e.g., a future `metrics.focus_duration_ms`)
- **THEN** the field is preserved verbatim in `metadata` and the row is written successfully

### Requirement: Atomic batch persistence
The system SHALL persist all events in a single payload within one database transaction, committing only if every insert (including any session auto-create) succeeds.

#### Scenario: Mid-batch failure
- **WHEN** the first N events insert successfully but event N+1 fails
- **THEN** the transaction is rolled back, no events from the payload are visible in `activities`, and any session created during the payload is also rolled back

### Requirement: Declarative schema validation
The system SHALL validate `POST /api/v1/telemetry` payloads using the `TelemetryPayload` schema defined in `openspec.yaml`, via the existing `validateRequest` middleware, with no duplicated validation logic in the controller.

#### Scenario: Schema change propagates without controller edits
- **WHEN** the `TelemetryPayload` schema in `openspec.yaml` is amended (e.g., a new required field is added to a typed event)
- **THEN** subsequent requests missing the new field are rejected with HTTP `400` without any change to controller or service code
