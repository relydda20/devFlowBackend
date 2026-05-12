## ADDED Requirements

### Requirement: Wire-level telemetry contract
The system SHALL accept telemetry from the DevVital AI VS Code extension as a single `TelemetryPayload` JSON document containing top-level `workspace` (string), `machine_timestamp` (ISO 8601 string), `session` aggregate (an object with `active_minutes`, `idle_minutes`, `total_events_collected`, `save_frequency`, `editor_switch_frequency`), and `events` (a non-empty array of typed `TelemetryEvent` entries). Each event MUST include `type`, `timestamp`, `workspace`, and `session_id`. The schema MUST be defined declaratively in `openspec.yaml` and enforced by the existing `validateRequest` middleware.

#### Scenario: Well-formed payload from extension is accepted
- **WHEN** the extension POSTs a `TelemetryPayload` with one or more typed events and a valid bearer token
- **THEN** the server responds with HTTP `202` and body `{ message, accepted_count }` equal to `events.length`, and each event becomes one `Activity` row

#### Scenario: Payload missing top-level field is rejected
- **WHEN** a payload omits `workspace`, `machine_timestamp`, `session`, or `events`
- **THEN** the server responds with HTTP `400` and body `{ error: "Validation failed", details: [...] }`, and no rows are written

#### Scenario: Event missing session_id is rejected
- **WHEN** any event in the `events` array omits `session_id`
- **THEN** the server responds with HTTP `400` and body `{ error: "Validation failed", details: [...] }`, and no rows are written

#### Scenario: Empty events array is rejected
- **WHEN** the extension POSTs a payload with `events: []`
- **THEN** the server responds with HTTP `400`

### Requirement: Session identifier semantics
The system SHALL treat the extension-provided `session_id` (UUID v4 string, generated once per VS Code window activation) as the canonical session identifier for that batch and all subsequent batches from the same window, persisting it unchanged in the `sessions.id` column.

#### Scenario: First batch creates a Session row
- **WHEN** a payload arrives with a `session_id` that has no corresponding `Session` row
- **THEN** the server creates `Session { id: session_id, user_id: <from auth>, start_time: <earliest event timestamp in batch>, is_active: true }` and inserts each event's `Activity` row against it

#### Scenario: Subsequent batches with the same session_id append
- **WHEN** a payload arrives with a `session_id` that already has a `Session` row owned by the same user
- **THEN** activities are inserted against the existing session and no duplicate `Session` is created

#### Scenario: session_id collision across users is rejected
- **WHEN** a payload arrives with a `session_id` that exists but is owned by a different `user_id`
- **THEN** the server responds with HTTP `409` and body `{ error: "Session ownership conflict" }`, and no rows from the batch are written

### Requirement: Typed event mapping
The system SHALL translate each `TelemetryEvent` to one `Activity` row using a deterministic mapping: `type` → `event_type`, `timestamp` → `timestamp`, `session_id` → `session_id`, `file.path` → `file_path` (NULL if `file` absent), and every remaining typed field of the event (e.g., `metrics`, `debug`, `terminal`, `git`, `file` block, `workspace`, `from`, `to`) → `metadata` JSONB.

#### Scenario: file_save event maps to file_path
- **WHEN** a `file_save` event with `file: { path: "src/foo.js", language: "javascript", ... }` is persisted
- **THEN** the resulting `Activity` row has `event_type="file_save"`, `file_path="src/foo.js"`, and `metadata` containing the full `file` block

#### Scenario: text_change event preserves metrics
- **WHEN** a `text_change` event with a `metrics` block (characters_added, edit_duration_ms, is_large_paste, etc.) is persisted
- **THEN** the `metadata` JSONB column contains the entire `metrics` block verbatim, alongside the `file` block

#### Scenario: editor_switch event with no file_path
- **WHEN** an `editor_switch` event arrives (which has `from`/`to` objects but no top-level `file`)
- **THEN** the `Activity` row has `file_path = NULL`, `event_type = "editor_switch"`, and `metadata` containing both `from` and `to` blocks plus `metrics`

#### Scenario: Unknown typed fields pass through
- **WHEN** an event contains a field not yet known to the backend (e.g., a future `editor_focus` event introduces a `metrics.focus_duration_ms` field)
- **THEN** the unknown field is preserved verbatim in `metadata` JSONB and the row is written successfully

### Requirement: Authentication via API token
The system SHALL authenticate extension requests using an API token presented as `Authorization: Bearer <token>`, distinguished from a user-session JWT by a `dvf_` prefix on the token value.

#### Scenario: Valid API token authenticates the request
- **WHEN** the extension POSTs with `Authorization: Bearer dvf_<secret>` where the secret hashes to an active `ApiToken` row
- **THEN** the request proceeds, `req.user.id` equals the token's `user_id`, the response is HTTP `202`, and the token's `last_used_at` is updated

#### Scenario: Revoked or unknown token is rejected
- **WHEN** the extension POSTs with a `dvf_`-prefixed token whose hash matches no active `ApiToken` row (revoked or never issued)
- **THEN** the server responds with HTTP `401` and body `{ error: "Unauthorized" }`, no rows are written, and the response time is independent of whether the prefix was syntactically valid (constant-time comparison)

#### Scenario: Missing Authorization header is rejected
- **WHEN** the extension POSTs without an `Authorization` header
- **THEN** the server responds with HTTP `401` and body `{ error: "Unauthorized" }`

### Requirement: Extension auth-failure handling
The extension SHALL distinguish HTTP `401`/`403` responses from network failures: on auth failure it MUST stop the periodic sync timer, set the status-bar text to `DevVital AI: Sign in required`, surface a notification, and preserve the in-memory buffer for replay after the user re-authenticates.

#### Scenario: 401 triggers auth-failure state
- **WHEN** `SyncService.sync()` receives an HTTP `401` response
- **THEN** the returned `SyncResult` has `ok: false` and `authFailure: true`, the periodic timer is stopped, the status bar shows `Sign in required`, and the buffer is not cleared

#### Scenario: Network error does not trigger auth-failure state
- **WHEN** `SyncService.sync()` fails with a connection refused / DNS / timeout error
- **THEN** the returned `SyncResult` has `ok: false` and `authFailure: false`, the timer keeps running, and the next interval re-attempts the same batch

#### Scenario: Successful sign-in resumes telemetry
- **WHEN** the user runs `DevVital AI: Sign In`, pastes a valid token, and the next `SyncService.sync()` returns HTTP `202`
- **THEN** the status bar returns to `$(pulse) DevVital AI: <n> queued`, the periodic timer is restarted, and the buffered batch is flushed

### Requirement: Extension session lifecycle
The extension SHALL generate a UUID v4 `session_id` on each `activate()` call, attach it to every event emitted by listeners until `deactivate()`, and never reuse it across activations.

#### Scenario: New window has new session_id
- **WHEN** the user opens two separate VS Code windows
- **THEN** each window's extension instance generates its own `session_id` and the backend sees two distinct `Session` rows

#### Scenario: Window reload generates a new session_id
- **WHEN** the user runs `Developer: Reload Window` in VS Code
- **THEN** the new activation generates a fresh `session_id`, and subsequent events are tied to the new session (the previous session row remains untouched)

### Requirement: Extension sign-in command
The extension SHALL expose the command `DevVital AI: Sign In` which prompts the user for an API token, stores it in VS Code `SecretStorage` under a known key, and triggers an immediate sync attempt to verify the token.

#### Scenario: Successful sign-in
- **WHEN** the user runs `DevVital AI: Sign In`, pastes a valid token, and the verification POST returns HTTP `202` (or `400` for an empty buffer, which also indicates auth worked)
- **THEN** the token is stored in `SecretStorage`, an information notification confirms sign-in, and the status bar transitions out of `Sign in required`

#### Scenario: Sign-in with invalid token
- **WHEN** the user pastes a token and the verification POST returns HTTP `401`
- **THEN** the token is NOT stored, a warning notification reports the failure, and the status bar remains in `Sign in required`

#### Scenario: Token is never written to settings.json
- **WHEN** the sign-in command stores the token
- **THEN** the token is written only via `context.secrets.store(...)` and MUST NOT appear in `vscode.workspace.getConfiguration()` or any logged output
