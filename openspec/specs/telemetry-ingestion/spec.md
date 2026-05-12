# telemetry-ingestion

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

### Requirement: Session auto-resolution
The system SHALL ensure a `Session` row exists for each unique `session_id` present in a batch before inserting its activities, creating one tied to the batch's `user_id` if absent.

#### Scenario: Session already exists
- **WHEN** the batch references a `session_id` that already has a `Session` row
- **THEN** activities are inserted against the existing session and no duplicate `Session` row is created

#### Scenario: Session does not exist yet
- **WHEN** the batch references a `session_id` with no corresponding `Session` row
- **THEN** the server creates a `Session` with that `session_id`, `user_id` from the batch, `is_active = true`, and `start_time` equal to the earliest event timestamp in the batch, then inserts the activities against it

### Requirement: Activity persistence shape
The system SHALL store each event as one `Activity` row capturing `session_id`, `event_type`, `file_path` (when provided), `metadata` (when provided), and `timestamp`.

#### Scenario: Event fields map to columns
- **WHEN** an event with `event_type`, `timestamp`, `session_id`, and optional `file_path` and `metadata` is persisted
- **THEN** an `Activity` row exists with those values, `metadata` stored as JSONB (defaulting to `{}` when omitted), and `file_path` stored as `NULL` when omitted

### Requirement: Atomic batch persistence
The system SHALL persist all events in a single batch within one database transaction, committing only if every insert succeeds.

#### Scenario: Mid-batch failure
- **WHEN** the first N events insert successfully but event N+1 fails
- **THEN** the transaction is rolled back, no events from the batch are visible in `activities`, and any session created during the batch is also rolled back

### Requirement: Declarative schema validation
The system SHALL validate `POST /api/v1/telemetry` payloads using the `TelemetryBatch` schema defined in `openspec.yaml`, via the existing `validateRequest` middleware, with no duplicated validation logic in the controller.

#### Scenario: Schema change propagates without controller edits
- **WHEN** the `TelemetryBatch` schema in `openspec.yaml` is amended (e.g., a new required field is added)
- **THEN** subsequent requests missing the new field are rejected with HTTP `400` without any change to controller or service code
