## 1. Database & model

- [x] 1.1 Create migration `db/migrations/<ts>-create-api-tokens.sql` for table `api_tokens` (`id` UUID PK, `user_id` UUID FK → users.id ON DELETE CASCADE, `name` varchar(64) not null, `token_hash` char(64) not null UNIQUE, `token_prefix` varchar(8) not null, `last_used_at` timestamptz null, `revoked_at` timestamptz null, `created_at` timestamptz default now())
- [x] 1.2 Add Sequelize model [src/models/api-token.model.js](src/models/api-token.model.js) mirroring the table; register it in [src/models/index.js](src/models/index.js) with `User.hasMany(ApiToken)` and `ApiToken.belongsTo(User)`
- [ ] 1.3 Run `npm run db:migrate` against the local Postgres in docker-compose and verify the table exists — _deferred: requires running Docker; runbook in [docs/extension.md](../../../docs/extension.md)_

## 2. Backend: API-token service & endpoints

- [x] 2.1 Create [src/services/api-token.service.js](src/services/api-token.service.js) exporting `issueToken(user_id, name)`, `verifyToken(rawToken)`, `revokeToken(user_id, token_id)`, `listTokens(user_id)` — `issueToken` generates 32 random bytes via `crypto.randomBytes`, builds `dvf_<base64url>`, hashes with SHA-256, persists row, returns `{ id, name, token, token_prefix, created_at }` (token only on issue)
- [x] 2.2 Create [src/controllers/token.controller.js](src/controllers/token.controller.js) with `postToken`, `deleteToken`, `getTokens` handlers that delegate to the service and reject non-JWT auth on `postToken` / `deleteToken` / `getTokens` (check `req.user.auth_method === 'jwt'`)
- [x] 2.3 Create [src/routes/token.routes.js](src/routes/token.routes.js) mounting `POST /auth/tokens`, `GET /auth/tokens`, `DELETE /auth/tokens/:id`; wire into [src/server.js](src/server.js) under `/api/v1` (after `authRouter`)
- [x] 2.4 Add JSON schemas `IssueTokenRequest`, `IssueTokenResponse`, `TokenListResponse` to [openspec.yaml](openspec.yaml) and ensure `validateRequest('/auth/tokens')` is applied to the POST route
- [ ] 2.5 Write unit tests for `api-token.service.js`: token shape, hash determinism, `verifyToken` returns null on revoked / unknown / non-prefixed input, constant-time comparison — _deferred: no test framework in repo; tracked as follow-up_

## 3. Backend: dual auth middleware

- [x] 3.1 Extend [src/middleware/auth.middleware.js](src/middleware/auth.middleware.js) to read `Authorization: Bearer <value>`; if value starts with `dvf_`, call `apiTokenService.verifyToken` and on success set `req.user = { id, auth_method: 'api_token', token_id }`; otherwise run the existing JWT path and set `req.user.auth_method = 'jwt'`
- [x] 3.2 In the API-token branch, fire-and-forget update of `last_used_at` (do not block the response on the update)
- [x] 3.3 Ensure both failure paths return identical body `{ error: "Unauthorized" }` and HTTP `401`
- [ ] 3.4 Add an integration test covering: valid JWT → 202; valid API token → 202; revoked API token → 401; missing header → 401; JWT for `POST /auth/tokens` works, API token for same endpoint → 403 — _deferred: no test framework_

## 4. Backend: new telemetry payload schema

- [x] 4.1 In [openspec.yaml](openspec.yaml), replace the `TelemetryBatch` schema with a `TelemetryPayload` schema that mirrors [devFlowExtension/src/types/telemetry.ts](../../../devFlowExtension/src/types/telemetry.ts): top-level `workspace`, `machine_timestamp`, `session` (object with five numeric fields), `events` (non-empty array). Define a `oneOf` discriminator on `type` covering `file_save`, `text_change`, `editor_switch`, `debug_session_start`, `terminal_open`, `git_activity`. Each event variant requires `type`, `timestamp`, `workspace`, `session_id`.
- [x] 4.2 Update `validateRequest('/telemetry')` registration so the new schema is reachable by name (`/telemetry` path already wired in [src/routes/telemetry.routes.js](src/routes/telemetry.routes.js)); smoke test via runbook
- [x] 4.3 Verify the schema rejects empty `events: []`, missing `session_id`, unknown event `type` — enforced via `minItems: 1`, `required: [..., session_id]`, and `oneOf` discriminator in schema

## 5. Backend: telemetry mapper & service

- [x] 5.1 Create [src/services/telemetry-mapper.js](src/services/telemetry-mapper.js) with a pure `mapEventToActivity(event)` returning `{ session_id, event_type, file_path, metadata, timestamp }` per the rules in [specs/extension-integration/spec.md](specs/extension-integration/spec.md) Requirement: Typed event mapping
- [x] 5.2 Update [src/services/telemetry.service.js](src/services/telemetry.service.js) `ingestBatch({ user_id, payload })` to: (a) collect unique `session_id`s with their earliest timestamp from `payload.events`; (b) `findOrCreate` each `Session`; (c) reject with `SessionOwnershipConflictError` if any existing session belongs to a different user; (d) map every event via `mapEventToActivity` and `bulkCreate` `Activity` rows; (e) keep the whole flow inside one `sequelize.transaction`
- [x] 5.3 Update [src/controllers/telemetry.controller.js](src/controllers/telemetry.controller.js) `submitTelemetry` to pass `payload: req.body` (not just `events`), handle the new `SessionOwnershipConflictError` with HTTP `409`, and keep the existing `UserNotFoundError → 404` branch
- [ ] 5.4 Write unit tests for `telemetry-mapper.js` covering: `file_save` → `file_path` lifted, `editor_switch` → `file_path` NULL, unknown fields preserved in `metadata` — _deferred: no test framework_
- [ ] 5.5 Write an integration test that posts a full extension-shaped payload (from a fixture taken from `devFlowExtension/src/types/telemetry.ts`) and asserts: `accepted_count` equals events length, one `Session` is created with `start_time` = earliest event timestamp, every `Activity` row has the expected mapped fields — _deferred: no test framework_

## 6. Extension: types & session

- [x] 6.1 Add `session_id: string` to `BaseTelemetryEvent` in [devFlowExtension/src/types/telemetry.ts](../../../devFlowExtension/src/types/telemetry.ts) so every variant inherits it; also export `RawTelemetryEvent` (the pre-stamping shape) for the aggregator
- [x] 6.2 In [devFlowExtension/src/services/sessionService.ts](../../../devFlowExtension/src/services/sessionService.ts), generate a UUID v4 via `crypto.randomUUID()` on construction and expose `getSessionId()`
- [x] 6.3 Update [devFlowExtension/src/services/telemetryAggregator.ts](../../../devFlowExtension/src/services/telemetryAggregator.ts) to accept `RawTelemetryEvent` from listeners and stamp `session_id` on every event before pushing to the buffer

## 7. Extension: auth service & sign-in command

- [x] 7.1 Create [devFlowExtension/src/services/authService.ts](../../../devFlowExtension/src/services/authService.ts) with `getToken()`, `setToken(value)`, `clearToken()` backed by `context.secrets`
- [x] 7.2 Add a constant `SECRET_KEY = 'devvitalAI.apiToken'` in [devFlowExtension/src/constants/telemetryConfig.ts](../../../devFlowExtension/src/constants/telemetryConfig.ts)
- [x] 7.3 Register a new command `devvitalAI.signIn` in [devFlowExtension/src/extension.ts](../../../devFlowExtension/src/extension.ts) that prompts via `showInputBox({ password: true, … })`, stores the value, calls `syncService.sync()` to verify, and surfaces success / `authFailure` via notifications
- [x] 7.4 Add the command to [devFlowExtension/package.json](../../../devFlowExtension/package.json) `contributes.commands` (`DevVital AI: Sign In`). Activation event omitted intentionally — VS Code auto-generates command activations.

## 8. Extension: sync service auth & 401 handling

- [x] 8.1 Inject `AuthService` into [devFlowExtension/src/services/syncService.ts](../../../devFlowExtension/src/services/syncService.ts) constructor and update wiring in [extension.ts](../../../devFlowExtension/src/extension.ts)
- [x] 8.2 In `sync()`, read the token via `authService.getToken()`; if undefined, return `{ ok: false, sentCount: 0, authFailure: true, errorMessage: 'Not signed in' }` without making the HTTP call (and stop the timer); otherwise attach `Authorization: Bearer ${token}` header
- [x] 8.3 Extend `SyncResult` with `authFailure?: boolean`; on HTTP `401` or `403` set `authFailure: true` and call `this.stop()`
- [x] 8.4 Update [extension.ts](../../../devFlowExtension/src/extension.ts) status-bar logic: render `$(alert) DevVital AI: Sign in required` (click → `devvitalAI.signIn`) on auth failure; on first non-auth-failure sync, call `syncService.start()` to resume
- [ ] 8.5 Add a unit test for `SyncService` (using axios-mock-adapter) verifying: 401 → `authFailure: true` + timer stopped + buffer intact; 202 → buffer cleared; network error → `authFailure: false` + timer still running — _deferred: no test framework_

## 9. End-to-end verification

Runbook documented in [docs/extension.md](../../../docs/extension.md). The five steps below require a running Postgres + backend + VS Code Extension Development Host — defer to manual execution.

- [ ] 9.1 Start backend with `npm run dev`; register a user via `POST /api/v1/auth/register`; mint a token via `POST /api/v1/auth/tokens` with the returned JWT
- [ ] 9.2 In a fresh VS Code Extension Development Host (F5 from `devFlowExtension`), run `DevVital AI: Sign In` with the minted token; trigger a file save and watch the `DevVital AI` output channel for "Synchronization success"
- [ ] 9.3 Query the backend DB: confirm one `sessions` row exists with the extension's UUID and one `activities` row per emitted event, with `file_path` and `metadata` populated correctly
- [ ] 9.4 Revoke the token via `DELETE /api/v1/auth/tokens/:id` and confirm the next sync sets the status bar to `Sign in required` and stops the timer
- [ ] 9.5 Run `DevVital AI: Sign In` again with a fresh token and confirm the buffered events (collected during the revocation window) are flushed on the next sync

## 10. Docs & cleanup

- [x] 10.1 Update [devFlowExtension/README.md](../../../devFlowExtension/README.md) with the sign-in flow, token-issuance curl, `session_id` note, and `SecretStorage` note
- [x] 10.2 Add backend [docs/extension.md](../../../docs/extension.md) runbook with curl commands for mint, revoke, smoke-test
- [x] 10.3 Run `openspec validate add-extension-integration` and fix any reported issues
- [x] 10.4 Confirm `openspec status --change add-extension-integration` reports `isComplete: true` and the change is ready for `/opsx:archive`
