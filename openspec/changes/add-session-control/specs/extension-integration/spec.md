## MODIFIED Requirements

### Requirement: Extension session lifecycle

The extension SHALL generate a UUID v4 `session_id` on each `activate()` call and attach it to every event emitted by listeners. The `session_id` MAY be rotated to a new UUID v4 mid-window under three conditions: (a) the user explicitly invokes `DevVital AI: Start New Session`, (b) the user explicitly invokes `DevVital AI: End Session`, or (c) an idle-cap is exceeded — defined as no event having been collected for at least `IDLE_SESSION_TIMEOUT_MS` (configurable via the `devvitalAI.idleSessionTimeoutMinutes` setting, default 30 minutes).

When the `session_id` rotates, the extension MUST zero out its in-memory session aggregates (`active_minutes`, `idle_minutes`, `total_events_collected`, `save_frequency`, `editor_switch_frequency`, and the `startedAt` / `lastActivityAt` timestamps) so that the new session reports counters scoped only to events recorded after the rotation. The previous session is NOT explicitly closed on the backend — the backend continues to own its row unchanged.

A `session_id` MUST NOT be reused across activations.

#### Scenario: New window has new session_id
- **WHEN** the user opens two separate VS Code windows
- **THEN** each window's extension instance generates its own `session_id`
- **AND** the backend sees two distinct `Session` rows

#### Scenario: Window reload generates a new session_id
- **WHEN** the user runs `Developer: Reload Window` in VS Code
- **THEN** the new activation generates a fresh `session_id`
- **AND** subsequent events are tied to the new session
- **AND** the previous session row remains untouched

#### Scenario: Idle-cap rotates the session on the next event
- **WHEN** no event has been recorded for at least `IDLE_SESSION_TIMEOUT_MS`
- **AND** a new event then arrives
- **THEN** the extension rotates `session_id` to a fresh UUID v4 BEFORE recording the new event
- **AND** the triggering event is tagged with the new `session_id` in the next telemetry payload
- **AND** the session aggregates are reset to zero before the event is counted

#### Scenario: Manual Start New Session command
- **WHEN** the user invokes `DevVital AI: Start New Session`
- **THEN** the extension rotates `session_id` immediately, regardless of idle state
- **AND** the session aggregates are reset
- **AND** the rotation is logged to the `DevVital AI` output channel

#### Scenario: Manual End Session command
- **WHEN** the user invokes `DevVital AI: End Session`
- **THEN** the extension rotates `session_id` immediately
- **AND** the session aggregates are reset
- **AND** the next collected event opens a fresh session on the backend
- **AND** no notification is shown (output-channel log only)

#### Scenario: Rotation on a fresh session is honored
- **WHEN** the user invokes `DevVital AI: Start New Session` shortly after activation
- **AND** the current session has recorded zero or very few events
- **THEN** the rotation still occurs (no "you just started" guard)
- **AND** the backend will hold a near-empty row for the prior session

#### Scenario: Idle check does not fire on an idle laptop with no events
- **WHEN** the extension is idle and no events are arriving
- **THEN** no timer fires, no rotation occurs, and the extension consumes no measurable CPU
- **AND** the rotation only happens once the next event arrives after idle

#### Scenario: Aggregates after rotation reflect the new session only
- **WHEN** a session has 500 collected events and is then rotated
- **AND** five new events are recorded after the rotation
- **THEN** the next telemetry payload's `session.total_events_collected` reads `5`, not `505`

## ADDED Requirements

### Requirement: Extension session-control commands

The extension SHALL expose two new VS Code commands for explicit session boundary control: `DevVital AI: Start New Session` (command id `devvitalAI.startNewSession`) and `DevVital AI: End Session` (command id `devvitalAI.endSession`). Both commands MUST be available from the command palette. Both commands MUST be no-ops with no error when invoked while the extension is signed out — the user is informed via a single info notification that they must sign in first.

#### Scenario: Start New Session while signed in
- **WHEN** the user is signed in and invokes `DevVital AI: Start New Session`
- **THEN** the current `session_id` rotates
- **AND** the user sees an information notification confirming the new session

#### Scenario: End Session while signed in
- **WHEN** the user is signed in and invokes `DevVital AI: End Session`
- **THEN** the current `session_id` rotates
- **AND** the user sees an information notification confirming the session ended

#### Scenario: Session commands while signed out
- **WHEN** the user is signed out and invokes either session command
- **THEN** a single informational notification advises them to sign in first
- **AND** no rotation occurs
- **AND** no error is thrown

### Requirement: Idle-cap configuration

The extension SHALL expose a VS Code configuration setting `devvitalAI.idleSessionTimeoutMinutes` (number, minimum 1, default 30) that controls the idle-cap threshold. Changes to the setting MUST take effect on the next idle check without requiring a window reload.

#### Scenario: Setting at default
- **WHEN** the setting is unset
- **THEN** the idle-cap is treated as 30 minutes

#### Scenario: User sets a custom value
- **WHEN** the user sets `devvitalAI.idleSessionTimeoutMinutes` to `15`
- **THEN** the next idle check uses a threshold of 15 minutes
- **AND** no window reload is required

#### Scenario: Setting below the minimum is rejected
- **WHEN** the user attempts to set the value to `0` or a negative number
- **THEN** VS Code rejects the value at the settings UI level (by the schema's `minimum: 1` constraint)
- **AND** the previous value remains in effect
