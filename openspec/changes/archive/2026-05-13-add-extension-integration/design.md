## Context

The extension and backend exist in separate git repos but the same workspace:
- **devFlowExtension** ([devFlowExtension/src/extension.ts](../../../devFlowExtension/src/extension.ts)) registers six listeners (file save, text change, editor switch, debug, terminal, git), buffers events in `TelemetryBufferService`, and POSTs every 60s through [services/syncService.ts](../../../devFlowExtension/src/services/syncService.ts). Today there is no auth header and no `session_id`. The payload shape is defined in [types/telemetry.ts](../../../devFlowExtension/src/types/telemetry.ts).
- **devFlowBackend** ([src/server.js](src/server.js)) wires `helmet`, `cors`, `cookieParser`, and three routers (health, auth, telemetry). The telemetry route is JWT-protected via `verifyJwt` and AJV-validated through [openspec.yaml](openspec.yaml)'s `TelemetryBatch` schema. The controller in [src/controllers/telemetry.controller.js](src/controllers/telemetry.controller.js) hands off to [src/services/telemetry.service.js](src/services/telemetry.service.js), which upserts a `Session` per `session_id` and bulk-inserts `Activity` rows in one transaction.

Concretely, today's mismatch:

| Concern | Extension sends | Backend expects |
| --- | --- | --- |
| Auth | (none) | `Authorization: Bearer <jwt>` or `dev_session` cookie |
| Top-level | `{ workspace, machine_timestamp, session, events }` | `{ events }` |
| Event identifier | `type` | `event_type` |
| Session identifier | (none) | `session_id` required per event |
| File path | `event.file.path` (object) | `file_path` (string) |
| Free-form data | typed event block (`metrics`, `debug`, `terminal`, `git`) | `metadata` JSONB |

The extension is the harder side to change: it's distributed to users, has no persistent storage beyond `SecretStorage`, and we already have the rich shape on the wire. The backend is a single deployment we control. So we adapt the backend.

Per-user constraints:
- Telemetry can be high-volume (sub-second `text_change` events on rapid typing). Auth check must be cheap.
- The extension already retries on next interval with the buffer intact, so transient `5xx` and network errors are handled. We must distinguish *non-retryable* `401`/`403` so the extension stops re-sending until the user re-authenticates.

## Goals / Non-Goals

**Goals:**
- One working end-to-end flow: user signs in on the web → mints an API token → pastes it into VS Code → telemetry batches land as `Activity` rows tied to that user.
- Backend accepts the extension's existing rich payload without changes to extension event shape (only additive: `session_id`).
- API tokens are stored hashed (never reversible from the DB), revocable, and distinguishable from short-lived user-session JWTs.
- The validation middleware ([src/middleware/validation.middleware.js](src/middleware/validation.middleware.js)) is reused for the new schema — no hand-rolled validation in the controller.
- Per-event mapping is deterministic and pure (no business logic in the controller).

**Non-Goals:**
- Web UI for managing tokens. The first iteration exposes only the API endpoints; users mint tokens via `curl` or a future settings page.
- OAuth device flow from VS Code (explicitly considered and rejected for v1; tracked as a follow-up).
- End-to-end encryption of telemetry payloads beyond TLS.
- Rate limiting per token (the global `express-rate-limit` is enough for now).
- Backfilling or migrating any production telemetry — none exists yet.
- Refresh-token rotation for API tokens; they're long-lived until revoked.

## Decisions

### Decision 1: Long-lived API tokens, not reusing the user-session JWT

Mint a separate `ApiToken` (random 32-byte secret, returned **once**, stored as a SHA-256 hash). The bearer the extension sends is `dvf_<base64url-secret>`. Verification: hash incoming token, look up by hash, load user, update `last_used_at`.

**Why not the existing JWT?** User-session JWTs are short-lived (15m–1h) and rotated; an extension that runs for days would need refresh logic and a refresh endpoint. API tokens sidestep that entirely.

**Why not OAuth?** The device flow is the right long-term answer but adds at least a week of work (callback handling, polling endpoint, UX). Token-paste is something the user does once per machine.

**Alternative considered**: Issue a *very* long-lived JWT (90 days) signed with a different key, no refresh. Rejected because revocation requires a deny-list (defeating the point of stateless JWTs), so we may as well store rows.

### Decision 2: Auth middleware accepts both JWTs and API tokens

Extend [src/middleware/auth.middleware.js](src/middleware/auth.middleware.js) to:
1. Read `Authorization: Bearer <value>`.
2. If `value` starts with `dvf_`, treat it as an API token: SHA-256, look up active row, attach `req.user = { id: row.user_id, auth_method: 'api_token', token_id: row.id }`.
3. Otherwise, fall through to current `jwt.verify` path; attach `req.user = { id, auth_method: 'jwt' }`.
4. Both paths reject with `401` and identical JSON shape `{ error: 'Unauthorized' }` so extensions don't have to branch on the body.

This keeps the controller agnostic: it just reads `req.user.id`. The `auth_method` field is logged but not gated on.

**Alternative considered**: A separate `verifyApiToken` middleware mounted only on `/api/v1/telemetry`. Rejected because token-minting and token-revoking endpoints will themselves want JWT-only access, and we'd end up duplicating the negation logic.

### Decision 3: Backend translates the extension payload at the controller boundary

The new schema in `openspec.yaml` mirrors `TelemetryPayload`. In the service layer, before insertion, each `TelemetryEvent` is normalized to an `Activity` row using a small pure mapper:

```text
type             → event_type
timestamp        → timestamp
session_id       → session_id          (required on each event; see Decision 4)
file?.path       → file_path           (null when absent)
{everything else} → metadata           (JSONB)
```

The "everything else" preserves the typed block as-is (`metrics`, `debug`, `terminal`, `git`, plus a copy of `workspace`). The mapper lives in `src/services/telemetry-mapper.js` and is imported by `telemetry.service.js`. Keeping it pure means it can be unit-tested without spinning up a DB.

**Why translate in the service, not the controller?** Validation already happens before the controller via AJV; the controller stays a thin HTTP shim (extracts `req.user.id`, delegates, responds). Mapping touches DB column names, which is a service concern.

**Alternative considered**: Store the entire payload as JSON in a new `telemetry_batches` table and project to `activities` async. Rejected — adds infrastructure (worker, queue) for a problem we don't yet have, and the current synchronous insert path is well under load budget.

### Decision 4: Extension generates `session_id` once per `activate()`

In [extension.ts](../../../devFlowExtension/src/extension.ts), generate a UUID v4 on activation, store it on `SessionService`, and have `TelemetryAggregator` stamp it on every event it produces. The aggregator already wraps every listener output, so the change is contained to one method.

**Why per-activation, not per-batch?** The backend's session model expects "one session = one continuous run of work." A batch is an arbitrary sync interval. A VS Code window lifetime is a meaningful unit (it ends when the user closes the editor or reloads the window).

**Why client-generated UUID, not "ask the backend for one"?** Avoids an extra round trip on cold start and lets the extension keep buffering events offline before it's ever authenticated.

**Alternative considered**: Hash `(user_id, workspace_path)`. Rejected — stable across restarts means we can never distinguish "today's coding session" from "last week's," which we'll want for the recommendations capability.

### Decision 5: Extension surfaces auth state separately from network state

`SyncService.sync()` returns `SyncResult { ok, sentCount, errorMessage }` today. Extend it to `SyncResult { ok, sentCount, errorMessage, authFailure?: boolean }`. On HTTP `401`/`403`, set `authFailure: true` and **stop** the interval timer. The status bar transitions to "Sign in required" and clicking it triggers the sign-in command.

**Why stop the timer?** The buffer keeps filling; on next sign-in we flush it. If we kept retrying every 60s with a bad token we'd waste backend cycles on guaranteed-401s and (worse) pile up rate-limit hits.

**Why not auto-clear the buffer on `401`?** The user signed in once before; if the token is revoked we don't want to silently drop the developer's last hour of telemetry. Buffer survives until either flushed successfully or the user explicitly runs `Flush Telemetry` with an empty token (no-op).

## Risks / Trade-offs

- **[Risk] Long-lived tokens leak via screenshots/logs of `settings.json`** → Mitigation: store in `SecretStorage` only (never in `settings.json`), log a warning if a user tries to put it in plaintext config, and document in `README.md` that the token is OS-keychain-encrypted.
- **[Risk] Backend schema change breaks the archived `telemetry-ingestion` capability** → Mitigation: this proposal explicitly marks `telemetry-ingestion` as Modified, the existing scenarios are rewritten in the spec delta to reference the new payload shape, and the AJV schema is updated atomically with the controller.
- **[Risk] Hashing tokens means we can't show "your token starts with abc…"** → Mitigation: persist a `token_prefix` column (first 6 chars of the unhashed secret) so the user can recognize tokens in a future list view.
- **[Risk] Per-event `session_id` increases payload size** → Trade-off: ~36 bytes × events-per-batch. With a 60s sync interval and typical event volume (<200 events), this is <8 KB additional. Acceptable.
- **[Risk] Two auth modes in one middleware confuses future contributors** → Mitigation: middleware reads as a flat `if/else` with explicit comments; both branches end at the same `req.user` shape so the rest of the codebase doesn't need to know which path was taken.
- **[Trade-off] Adapting backend means archived spec evolves; archive history shows the old shape never shipped to extension users** → Acceptable: nothing in production today depends on the old shape.

## Migration Plan

No production data exists; this is greenfield integration. Sequence:

1. Add `api_tokens` table via Sequelize migration (additive).
2. Land backend changes (new schema in `openspec.yaml`, mapper, controller update, token endpoints, auth middleware extension). Backend now accepts *both* old and new shapes via AJV `oneOf` during a brief window.
3. Land extension changes (session_id, sign-in command, bearer header).
4. Manually verify end-to-end against local backend.
5. Remove the old shape from `oneOf` in `openspec.yaml`; the schema is now only the new payload.

**Rollback**: Revert the spec delta and the four touched backend files. Drop the `api_tokens` table. Extension users will see `401`s and the status bar warning until they uninstall — acceptable since the extension is pre-release.

## Open Questions

- Should `last_used_at` update on every request (write amplification) or be debounced to ~1/min per token? Decision deferred to tasks; default to per-request for now and measure.
- What's the right `token_prefix` length to avoid collision in a future "list my tokens" UI? Six chars feels right but is unverified. Park until we build the UI.
- Do we need a `scopes` column on `api_tokens` (e.g., `telemetry:write`)? Not for v1 — every API token has full user authority. Add when we have a second API surface that an extension might call.
