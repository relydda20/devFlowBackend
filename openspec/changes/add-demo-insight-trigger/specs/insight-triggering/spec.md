## ADDED Requirements

### Requirement: On-demand insight trigger endpoint

The backend SHALL expose `POST /api/v1/recommendations/trigger`, authenticated identically to other `/recommendations/*` routes (JWT cookie or `Authorization: Bearer <dvf_… or jwt>`). The endpoint SHALL accept a JSON body `{ mode: "real" | "force" | "demo" }` where `mode` defaults to `"real"` when omitted or null, and SHALL reject any other value with HTTP 400.

#### Scenario: Unauthenticated request

- **WHEN** the endpoint is called with no JWT or API token
- **THEN** the response SHALL be HTTP 401 and no recommendation row SHALL be created

#### Scenario: Invalid mode value

- **WHEN** the endpoint is called with `{ "mode": "production" }` by an authenticated user
- **THEN** the response SHALL be HTTP 400 with an error message naming the valid modes (`real`, `force`, `demo`)

#### Scenario: Missing body defaults to real

- **WHEN** the endpoint is called by an authenticated user with no body or `{}`
- **THEN** the server SHALL treat the request as `mode: "real"`

### Requirement: Real mode mirrors scheduler behaviour

The `real` mode SHALL invoke the same `evaluateUser(userId)` code path used by the scheduler, with no parameter changes. It SHALL respect the Gemini-configured gate, the cooldown gate, the no-session gate, the no-rule-fired gate, and the LLM-failed gate. The endpoint SHALL return the structured `{ skipped, reason }` or `{ skipped: false, rule, state_type, recommendation_id }` result as JSON, HTTP 200.

#### Scenario: Real mode during cooldown

- **WHEN** the user already has a recommendation created < `INSIGHT_COOLDOWN_MINUTES` ago and calls trigger with `mode: "real"`
- **THEN** the response SHALL be HTTP 200 with `{ skipped: true, reason: "cooldown" }` and no new `Recommendation` row SHALL be created

#### Scenario: Real mode with no active rule

- **WHEN** the user has activity but no rule fires, and calls trigger with `mode: "real"`
- **THEN** the response SHALL be HTTP 200 with `{ skipped: true, reason: "no_rule_fired" }` and no new `Recommendation` row SHALL be created

#### Scenario: Real mode succeeds end-to-end

- **WHEN** a rule fires and the LLM returns a non-normal state for `mode: "real"`
- **THEN** the response SHALL be HTTP 200 with `{ skipped: false, ..., recommendation_id: <number> }` and exactly one new `Recommendation` row SHALL be created for the user

### Requirement: Force mode bypasses cooldown

The `force` mode SHALL, before invoking `evaluateUser`, expire (set `user_action = 'expired'`) the user's most recent pending recommendation if any. The remaining gates (Gemini-configured, no-session, no-rule-fired, LLM-failed) SHALL still apply. Force mode SHALL NOT alter recommendations belonging to other users.

#### Scenario: Force expires latest then evaluates

- **WHEN** the user has a pending recommendation < `INSIGHT_COOLDOWN_MINUTES` old, and calls trigger with `mode: "force"`
- **THEN** the previously-pending recommendation SHALL be marked `user_action = 'expired'`, `evaluateUser` SHALL run, and if a rule fires a new `Recommendation` SHALL be created in the same call

#### Scenario: Force still skips when no rule fires

- **WHEN** the user calls trigger with `mode: "force"` but no rule fires
- **THEN** the response SHALL be HTTP 200 with `{ skipped: true, reason: "no_rule_fired" }`

#### Scenario: Force does not touch other users

- **WHEN** user A calls trigger with `mode: "force"` while user B has a pending recommendation
- **THEN** user B's recommendation SHALL remain `user_action = null` (untouched)

### Requirement: Demo mode fabricates a canned recommendation

The `demo` mode SHALL bypass `evaluateUser` entirely. It SHALL create exactly one `WorkflowState` (with `state_type = 'demo'`, `confidence_score = 1.0`, attached to the user's current session) and exactly one `Recommendation` (`recommendation_type = 'execute'`, hardcoded `recommendation_text`, `code_context.triggered_rule = 'demo_trigger'`, `user_action = null`). Demo mode SHALL succeed even when Gemini is not configured. If the user has no `Session` row, demo mode SHALL return HTTP 409 with reason `no_session` rather than fabricating a session.

#### Scenario: Demo with active session

- **WHEN** an authenticated user with an existing `Session` calls trigger with `mode: "demo"`
- **THEN** a new `WorkflowState` with `state_type = 'demo'` and a new `Recommendation` SHALL be created, and the response SHALL be HTTP 200 with `{ skipped: false, mode: "demo", recommendation_id: <number> }`

#### Scenario: Demo when Gemini is unconfigured

- **WHEN** `GOOGLE_API_KEY` is unset on the server and the user calls trigger with `mode: "demo"`
- **THEN** the request SHALL still succeed and create the canned recommendation row, because demo mode never invokes the LLM

#### Scenario: Demo when the user has no session

- **WHEN** an authenticated user with no `Session` row calls trigger with `mode: "demo"`
- **THEN** the response SHALL be HTTP 409 with `{ skipped: true, reason: "no_session" }`

### Requirement: All trigger calls are logged

Every successful `POST /recommendations/trigger` invocation SHALL emit a single `logger.info` entry tagged `recommendation-trigger` recording `user_id`, `mode`, and the outcome (`skipped` + `reason`, or `recommendation_id`). Failed authentication SHALL NOT emit this log.

#### Scenario: Demo invocation is logged

- **WHEN** an authenticated user calls trigger with `mode: "demo"` and a row is created
- **THEN** the backend logs SHALL contain a line including `recommendation-trigger`, `user_id`, `mode=demo`, and the new `recommendation_id`

### Requirement: Extension command for triggering insights

The extension SHALL register a command `devvitalAI.triggerInsight` titled **DevVital AI: Trigger Insight** in its `contributes.commands`. When invoked, the command SHALL present a `vscode.window.showQuickPick` of three options (`Real check`, `Force (bypass cooldown)`, `Demo popup`), POST the user's selection to `<apiBase>/api/v1/recommendations/trigger`, then call `recommendationService.pollAndNotify()` once so the popup appears on the next poll tick. The command SHALL be disabled (no-op with a warning to the output channel) when the user is signed out.

#### Scenario: Command is registered in the palette

- **WHEN** the extension activates and the user opens the VSCode command palette
- **THEN** **DevVital AI: Trigger Insight** SHALL appear as a runnable command

#### Scenario: User selects Demo from the quick-pick

- **WHEN** the user runs the command and selects `Demo popup`
- **THEN** the extension SHALL POST `{ mode: "demo" }` with the stored auth token, then invoke `pollAndNotify()`, causing the next poll (≤ 60s, typically immediate) to surface the canned recommendation as an information toast

#### Scenario: User runs the command while signed out

- **WHEN** the user invokes **DevVital AI: Trigger Insight** but has no stored API token
- **THEN** the extension SHALL skip the POST, write a warning to the DevVital AI output channel, and not invoke `pollAndNotify()`
