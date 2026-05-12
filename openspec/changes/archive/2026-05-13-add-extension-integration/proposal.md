## Why

The `devFlowExtension` (DevVital AI VS Code extension) and `devFlowBackend` were built in parallel and do not currently interoperate. The extension POSTs anonymous, richly-typed telemetry payloads to `http://localhost:3000/api/v1/telemetry`, while the backend's `telemetry-ingestion` capability requires a JWT-authenticated batch in a different, flatter shape (`event_type`, `session_id`, `file_path`, `metadata`). Until the two sides agree on auth and payload, the extension cannot deliver a single event to the backend — every sync returns `401`, the extension's in-memory buffer is the only "storage," and no `Activity` rows are produced for analysis.

This change closes that gap: the extension authenticates with a long-lived API token, identifies itself with a per-window `session_id`, and the backend accepts the extension's existing rich payload shape (workspace, machine_timestamp, session aggregates, typed events) and translates it into `Activity` rows.

## What Changes

- **BREAKING** Replace the current `TelemetryBatch` schema in `openspec.yaml` with a richer `TelemetryPayload` that mirrors the extension's payload (top-level `workspace`, `machine_timestamp`, `session` aggregates, and an `events` array of typed `TelemetryEvent` entries with `type`, `timestamp`, `session_id`, and event-specific blocks).
- Add an extension-side `session_id` (UUID generated at `activate()`) and include it on every event in the payload.
- Add an API-token issuance endpoint on the backend (`POST /api/v1/auth/tokens`, JWT-protected) so a signed-in user can mint a long-lived bearer token to paste into VS Code.
- Add an extension command `DevVital AI: Sign In` that prompts for the token and stores it in VS Code SecretStorage.
- Update `SyncService` to attach `Authorization: Bearer <token>` and `session_id` to every POST, and surface `401` distinctly from network errors.
- Update the backend's `submitTelemetry` controller / `ingestBatch` service to flatten the typed events into `Activity` rows (mapping `type` → `event_type`, lifting `file.path` → `file_path`, persisting the remaining typed block as JSONB `metadata`) and to upsert a `Session` per `session_id` using the batch's earliest event timestamp.
- Document the integration contract (payload, auth, error semantics) in the new `extension-integration` capability spec.

## Capabilities

### New Capabilities
- `extension-integration`: End-to-end contract between the VS Code extension and the backend — token issuance, the `TelemetryPayload` shape on the wire, `session_id` semantics, and error/retry behavior visible to the extension.
- `api-tokens`: Long-lived bearer tokens for non-interactive clients (the extension). Covers issuing, storing (hashed), revoking, and verifying tokens, distinct from the short-lived user-session JWTs used by the web flow.

### Modified Capabilities
- `telemetry-ingestion`: The accepted request body changes from a flat `{ events: [...] }` array to the extension's `TelemetryPayload` shape. The persistence rules (one `Activity` per event, session auto-upsert, atomic batch, JWT-protected) are preserved, but the field-mapping rule changes (`type` → `event_type`, `file.path` → `file_path`, typed event block → `metadata` JSONB).
- `password-auth`: A signed-in user gains the ability to mint and revoke API tokens via the new endpoints; the password login flow itself is unchanged.

## Impact

- **Backend code**: `openspec.yaml` (new schema), [src/routes/telemetry.routes.js](src/routes/telemetry.routes.js), [src/controllers/telemetry.controller.js](src/controllers/telemetry.controller.js), [src/services/telemetry.service.js](src/services/telemetry.service.js), new `src/routes/token.routes.js` + `src/controllers/token.controller.js` + `src/services/api-token.service.js`, new `ApiToken` Sequelize model + migration, [src/middleware/auth.middleware.js](src/middleware/auth.middleware.js) (accept bearer tokens that resolve to either a JWT user or an API-token user).
- **Extension code**: [devFlowExtension/src/extension.ts](../../../devFlowExtension/src/extension.ts) (session UUID, sign-in command), [devFlowExtension/src/services/syncService.ts](../../../devFlowExtension/src/services/syncService.ts) (attach bearer + session_id, handle 401), new `src/services/authService.ts` (SecretStorage wrapper), [devFlowExtension/src/types/telemetry.ts](../../../devFlowExtension/src/types/telemetry.ts) (add `session_id` to event types), [devFlowExtension/package.json](../../../devFlowExtension/package.json) (new commands & settings).
- **Database**: New `api_tokens` table (`id`, `user_id`, `token_hash`, `name`, `last_used_at`, `revoked_at`, `created_at`).
- **Docs**: Update `devFlowExtension/README.md` with sign-in instructions; backend OpenAPI / openspec.yaml schemas regenerated.
- **No impact** on `oauth-login`, `health-check`, or `validation` capabilities (the validation middleware itself is reused for the new schema).
