## ADDED Requirements

### Requirement: Threshold-gated LLM trigger

The system SHALL operate a scheduled trigger that, every `INSIGHT_CHECK_INTERVAL_SECONDS` (default 600), evaluates each active user against a set of rules. The LLM (Gemini) MUST be invoked only when at least one rule fires for that user. The system MUST NOT invoke the LLM on a fixed schedule independent of rules.

A user is "active" if they have at least one `activity` row with `timestamp > NOW() - INSIGHT_ACTIVITY_WINDOW_MINUTES` (default 30).

#### Scenario: Active user with no triggering rule
- **WHEN** the trigger evaluates an active user
- **AND** no threshold rule fires
- **THEN** no LLM call is made
- **AND** no row is written to `workflow_states` or `recommendations`

#### Scenario: Active user with a triggering rule
- **WHEN** the trigger evaluates an active user
- **AND** a threshold rule (e.g., session length > 2h AND churn > 0.4) fires
- **THEN** the system invokes Gemini exactly once with the user's metrics + session + top files + the name of the triggering rule

#### Scenario: Inactive user
- **WHEN** a user has no activity in the last `INSIGHT_ACTIVITY_WINDOW_MINUTES`
- **THEN** the trigger skips them entirely; no LLM call

#### Scenario: Insights disabled via env var
- **WHEN** `INSIGHTS_ENABLED` is `false`
- **THEN** the scheduler does not run
- **AND** existing data continues to be served by the read endpoints

### Requirement: LLM response is strict JSON and validated against the canonical enums

The Gemini call SHALL request JSON output (`responseMimeType: 'application/json'`) and the response MUST conform to a JSON Schema with these fields: `state_type` (one of `stuck_loop | lost_in_codebase | ai_dependency_trap | integration_hell | analysis_paralysis | normal`), `confidence_score` (number 0–1), `recommendation_type` (one of `change_approach | map_system | stop_using_ai | simplify_problem | execute`), `recommendation_text` (string ≤ 240 chars), `reasoning` (string ≤ 600 chars). Responses that fail to parse or fail validation MUST NOT be persisted.

#### Scenario: Valid response
- **WHEN** Gemini returns valid JSON conforming to the schema
- **THEN** one `WorkflowState` row and one linked `Recommendation` row are inserted
- **AND** the new recommendation's `user_action` is `NULL` (pending)

#### Scenario: state_type is "normal"
- **WHEN** Gemini returns `state_type: "normal"` (the LLM judges the rule trigger as a false positive)
- **THEN** the system records a `WorkflowState` with `state_type='normal'` but does NOT insert a `Recommendation` row
- **AND** the user sees no popup

#### Scenario: Invalid JSON
- **WHEN** Gemini returns text that cannot be JSON-parsed
- **THEN** no rows are inserted
- **AND** the failure is logged with the rule name and a truncated response snippet
- **AND** the trigger does not retry within this tick

#### Scenario: Schema-invalid JSON
- **WHEN** Gemini returns parseable JSON that fails AJV validation (e.g., `state_type: "stuck loop"` with a space)
- **THEN** no rows are inserted
- **AND** the failure is logged

#### Scenario: Gemini API failure
- **WHEN** the Gemini SDK throws (network error, 5xx, rate-limit, invalid API key)
- **THEN** the trigger logs the error
- **AND** no rows are inserted
- **AND** the next tick re-evaluates normally

### Requirement: One pending recommendation per user

The system SHALL maintain the invariant that each user has at most one recommendation with `user_action IS NULL` (pending). When a new recommendation is generated, any prior pending recommendations for the same user MUST be updated to `user_action = 'expired'` in the same database transaction as the new insertion.

#### Scenario: New recommendation expires the old pending one
- **WHEN** a user already has one pending recommendation
- **AND** the trigger fires again and the LLM produces a new recommendation
- **THEN** the old pending recommendation's `user_action` is set to `'expired'`
- **AND** the new recommendation is inserted with `user_action = NULL`
- **AND** both updates commit atomically

#### Scenario: Acted recommendations are not affected
- **WHEN** a user has a recommendation with `user_action = 'accepted'` (or `dismissed` / `snoozed`)
- **AND** the trigger fires and inserts a new pending recommendation
- **THEN** the acted-on recommendation is unchanged

### Requirement: Cooldown and snooze suppress re-firing

After a recommendation is generated for a user, the trigger SHALL ignore that user for `INSIGHT_COOLDOWN_MINUTES` (default 45) — measured from the recommendation's `created_at`. If the user marks a recommendation as `snoozed`, the snooze duration is `SNOOZE_DURATION_MINUTES` (default 30) measured from the moment of the snooze action.

#### Scenario: Cooldown after recommendation
- **WHEN** a recommendation was generated 20 minutes ago and `INSIGHT_COOLDOWN_MINUTES=45`
- **AND** the trigger evaluates the same user
- **THEN** the user is skipped without rule evaluation
- **AND** no LLM call is made

#### Scenario: Cooldown elapsed
- **WHEN** a recommendation was generated 60 minutes ago and `INSIGHT_COOLDOWN_MINUTES=45`
- **AND** rule evaluation succeeds for the user
- **THEN** a new recommendation may be generated

#### Scenario: Snooze overrides cooldown
- **WHEN** a recommendation is snoozed 10 minutes ago and `SNOOZE_DURATION_MINUTES=30`
- **AND** `INSIGHT_COOLDOWN_MINUTES=45` would otherwise allow re-firing earlier
- **THEN** the snooze period applies: the user is skipped until the snooze expires

### Requirement: Pending-recommendation read endpoint

The system SHALL expose `GET /api/v1/recommendations/pending`, JWT or API-token authenticated, that returns the single pending recommendation for the authenticated user, or `{ recommendation: null }` if none.

#### Scenario: User has a pending recommendation
- **WHEN** a user has a recommendation with `user_action IS NULL`
- **THEN** the response is `{ recommendation: { id, state_type, recommendation_type, recommendation_text, reasoning, created_at } }`

#### Scenario: User has no pending recommendation
- **WHEN** all recommendations for the user are acted-on or none exist
- **THEN** the response is `{ recommendation: null }` with HTTP 200 (not 404)

#### Scenario: Unauthenticated request
- **WHEN** the request has no valid auth
- **THEN** the response is HTTP 401

### Requirement: Recommendation history read endpoint

The system SHALL expose `GET /api/v1/recommendations?limit=N`, returning the N most recent recommendations for the authenticated user, ordered by `created_at DESC`. The default `limit` is 20; maximum 100.

#### Scenario: Default listing
- **WHEN** an authenticated user requests `/api/v1/recommendations`
- **THEN** the response is `{ recommendations: [ ... ] }` with up to 20 entries
- **AND** each entry contains `id, state_type, confidence_score, recommendation_type, recommendation_text, reasoning, user_action, created_at`

#### Scenario: Limit clamped
- **WHEN** the user requests `?limit=500`
- **THEN** the response contains at most 100 entries

#### Scenario: Empty history
- **WHEN** the user has never had a recommendation
- **THEN** the response is `{ recommendations: [] }` with HTTP 200

### Requirement: User-action endpoint records feedback

The system SHALL expose `POST /api/v1/recommendations/:id/action` with body `{ action: 'accepted' | 'dismissed' | 'snoozed' }`. The endpoint updates the named recommendation's `user_action` column. The endpoint MUST verify the authenticated user owns the recommendation; otherwise it returns 403.

#### Scenario: User accepts a recommendation
- **WHEN** the owner POSTs `{ action: 'accepted' }`
- **THEN** the recommendation's `user_action` becomes `'accepted'`
- **AND** the response is HTTP 200

#### Scenario: User snoozes a recommendation
- **WHEN** the owner POSTs `{ action: 'snoozed' }`
- **THEN** `user_action` becomes `'snoozed'`
- **AND** the trigger engine ignores the user for `SNOOZE_DURATION_MINUTES` (per the cooldown requirement)

#### Scenario: User dismisses a recommendation
- **WHEN** the owner POSTs `{ action: 'dismissed' }`
- **THEN** `user_action` becomes `'dismissed'`

#### Scenario: Recommendation not owned by caller
- **WHEN** a user POSTs to `/recommendations/<other-user-id>/action`
- **THEN** the response is HTTP 403
- **AND** no row is modified

#### Scenario: Recommendation already acted-on
- **WHEN** a recommendation's `user_action` is non-null and the user POSTs another action
- **THEN** the response is HTTP 409 `{ error: 'Recommendation already acted on' }`
- **AND** the existing `user_action` is preserved

#### Scenario: Invalid action value
- **WHEN** the body's `action` is not one of the three allowed values
- **THEN** the response is HTTP 400 with a validation error

### Requirement: Gemini service is the only path to the LLM

All LLM calls SHALL go through [src/services/llm/gemini.service.js](src/services/llm/gemini.service.js). The module MUST NOT log the API key. Other modules MUST NOT import the `@google/generative-ai` SDK directly.

#### Scenario: API key never logged
- **WHEN** the Gemini service is instantiated or invoked
- **THEN** no log line contains the value of `GOOGLE_API_KEY`
- **AND** even on error, the logged message does not include the key

#### Scenario: API key missing at startup
- **WHEN** the server starts with `INSIGHTS_ENABLED=true` but `GOOGLE_API_KEY` unset
- **THEN** the insight scheduler logs a single warning at boot and disables itself for the process lifetime
- **AND** the rest of the server starts and runs normally
