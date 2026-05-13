# devFlow Backend

Node.js + Express + Sequelize + PostgreSQL service that ingests developer activity telemetry from the VSCode extension, aggregates it into per-day / per-session metrics, and surfaces LLM-driven workflow recommendations to the user.

This is the **API and background-jobs** half of devFlow. The companion repos are [devFlowExtension](../devFlowExtension) (VSCode extension that emits telemetry and shows recommendation popups) and [devFlowFrontend](../devFlowFrontend) (dashboard SPA).

## Architecture at a glance

```
                                    ┌────────────────────────┐
                                    │  PostgreSQL            │
                                    │   activities (raw)     │
                                    │   metrics_daily        │
                                    │   metrics_session      │
                                    │   workflow_states      │
                                    │   recommendations      │
                                    │   sessions / users     │
                                    │   api_tokens           │
                                    │   pairing_codes        │
                                    └─────────▲──────────────┘
                                              │
       ┌──────────────────────┐       ┌───────┴───────────────┐       ┌──────────────────────┐
       │  devFlowExtension    │POST   │  Express API          │POST   │  Google Gemini       │
       │  (VSCode)            │──────►│  /api/v1/*            │──────►│  gemini-2.5-flash    │
       │  emits text_change,  │       │                       │       │  (LLM)               │
       │  editor_switch,      │       │  Background jobs:     │       └──────────────────────┘
       │  file_save events    │       │  • metrics-etl        │
       │                      │       │  • insight-scheduler  │
       │  GET /recommend...   │◄──────│  • pairing-cleanup    │
       └──────────────────────┘       └───────▲───────────────┘
                                              │
       ┌──────────────────────┐               │
       │  devFlowFrontend     │ GET           │
       │  (React dashboard)   │───────────────┘
       │  /metrics/churn      │
       │  /recommendations    │
       └──────────────────────┘
```

Three independent flows share one Express process:

- **Telemetry ingest** — extension posts batched events, server stores them raw in `activities`, ETL aggregates into `metrics_daily` / `metrics_session`.
- **Insights** — scheduler ticks every N seconds, runs rule heuristics over `metrics_daily`, asks Gemini for a recommendation, stores it in `recommendations`. Extension polls and shows a popup.
- **Auth** — JWT sessions for the web frontend, `dvf_…` API tokens for the extension. Device-code pairing flow links the two.

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit DB_*, GOOGLE_API_KEY at minimum.

# 3. Migrate
npm run db:migrate

# 4. Run
npm run dev        # nodemon, NODE_ENV=development
# or
npm start          # node, no auto-reload
```

The server listens on `PORT` (default `3000`) and exposes `/api/v1/*`. Health check at `GET /api/v1/health`.

## Layout

```
src/
├── server.js                      # Express app, middleware chain, route mounting, scheduler startup
├── config/                        # database.js, OpenAPI loader, run-migrations.js, migration SQL
├── middleware/
│   ├── auth.middleware.js         # verifyJwt — accepts JWT cookie OR Bearer JWT OR Bearer dvf_ token
│   └── validation.middleware.js   # Ajv-based, schema sourced from openspec.yaml
├── routes/                        # Thin route → controller wiring, one file per resource
├── controllers/                   # HTTP layer: parse req, call service, shape response
├── services/                      # Business logic (testable, transport-agnostic)
├── models/                        # Sequelize models + associations
└── utils/                         # logger.js (winston), small helpers
```

The pattern is conventional: route → middleware → controller → service → model. Controllers don't talk to the DB; services don't touch `req` / `res`.

## API surface

All routes are prefixed with `/api/v1`. Auth column codes:

- **none** — no auth required
- **jwt** — JWT (cookie `dvf_session` or `Authorization: Bearer <jwt>`)
- **token** — `dvf_…` API token via `Authorization: Bearer dvf_…`
- **either** — JWT or API token both work

### Health

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness probe. Returns `{ status: 'ok' }`. Used by k8s readiness check. |

### Authentication

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/register` | none | Create a new password user. Body validated against openspec schema. |
| POST | `/auth/login` | none | Password login. Sets `dvf_session` cookie. |
| GET | `/auth/me` | jwt | Current user profile. |
| POST | `/auth/logout` | none | Clears the session cookie. |
| GET | `/auth/:provider` | none | Start OAuth flow (`google`, `github`). Redirects to provider. |
| GET | `/auth/:provider/callback` | none | OAuth provider callback. Sets cookie, redirects to frontend. |

OAuth state is held in-memory in [oauth-state.store.js](src/services/oauth-state.store.js) with a 5-minute TTL. Single-process only — does not survive a pod restart.

### API tokens (for the extension)

`dvf_…` tokens are long-lived bearer tokens scoped to one user. The extension stores one in VSCode `SecretStorage`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/tokens` | jwt | Mint a new API token. Plaintext returned **once**. |
| GET | `/auth/tokens` | jwt | List the caller's tokens (metadata only, no plaintext). |
| DELETE | `/auth/tokens/:id` | jwt | Revoke a token. |

Notably the `POST` requires a **JWT** — API tokens can't mint more API tokens.

### Device-code pairing

Lets the extension obtain a `dvf_…` token without typing it. Flow:

1. Extension `POST /auth/pairings` (no auth) → gets `{ pairing_id, user_code, verification_uri }`.
2. Extension opens `verification_uri?code=user_code` in the user's browser.
3. User (already logged in) clicks Approve; frontend calls `POST /auth/pairings/:user_code/approve` (jwt).
4. Extension polls `POST /auth/pairings/:pairing_id/exchange` every 2s; once approved gets the `dvf_…` token, **delivered exactly once**.

See [docs/extension-pairing.md](docs/extension-pairing.md) for the full state machine.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/pairings` | none | Start a pairing. Creates a row, returns the user code. |
| POST | `/auth/pairings/:user_code/approve` | jwt | User-confirmed approval. JWT only — not API tokens. |
| POST | `/auth/pairings/:pairing_id/exchange` | none | Extension polls. Rate-limited to 1 req/sec/pairing. |

### Telemetry ingest

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/telemetry` | either | Batch ingest of `text_change` / `editor_switch` / `file_save` / `debug_session_start` / `terminal_open` / `git_activity` events. Validated against the `TelemetryPayload` schema in [openspec.yaml](openspec.yaml). |

Events go through [telemetry-mapper.js](src/services/telemetry-mapper.js) which strips known top-level fields and dumps the rest into the `metadata` JSONB column. The schema-agnostic write is intentional: the extension can ship new fields ahead of the backend without breaking ingest.

### Metrics

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/metrics/churn?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=daily\|session` | jwt | Code churn ratio (deleted/added) over a range. Returns aggregate totals + a per-day `series` array (daily grain only). |
| GET | `/metrics/context-switching?from=…&to=…&grain=…&top_n=N` | jwt | Editor-switch counts and top-N most-visited files. Returns aggregate totals + per-day `series`. |
| POST | `/metrics/etl/run` | jwt + admin | Force the ETL to run now. Caller's user_id must be in `ADMIN_USER_IDS`. |

The per-day `series` is what feeds the Activity Overview chart in the dashboard.

### Recommendations / insights

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/recommendations/pending` | jwt | The user's single most-recent unactioned recommendation (or `null`). Used by the extension to surface popups. |
| GET | `/recommendations?limit=N` | jwt | Recent recommendations history. |
| POST | `/recommendations/trigger` | jwt | Manually invoke the insight pipeline. Body `{ mode: "real" \| "force" \| "demo" }`. See [docs/ai-insights.md](docs/ai-insights.md) — primarily a demo / debugging escape hatch. |
| POST | `/recommendations/:id/action` | jwt | Record the user's response: `accepted`, `dismissed`, or `snoozed`. |

## Services

The interesting code lives in services. One paragraph each:

- **[telemetry.service.js](src/services/telemetry.service.js)** — `ingestBatch()`. Owns the transactional insert of an event batch into `activities`, ensuring the caller's `user_id` matches `session.user_id` (throws `SessionOwnershipConflictError` on mismatch).
- **[telemetry-mapper.js](src/services/telemetry-mapper.js)** — One function `mapEventToActivity` that converts an incoming telemetry event into an `activities` row. Schema-agnostic: unknown fields land in `metadata` JSONB.
- **[metrics.service.js](src/services/metrics.service.js)** — `getChurn` / `getContextSwitching`. Read-only queries against `metrics_daily` / `metrics_session`. Builds aggregate totals **and** a per-day `series` array used by the dashboard chart.
- **[metrics-etl.service.js](src/services/metrics-etl.service.js)** — `runOnce({ batchSize })`. Reads `activities` past the watermark in `etl_jobs.last_processed_activity_id`, upserts increments into `metrics_daily` / `metrics_session`, advances the watermark in the same transaction (idempotent on crash). **Known issue:** the per-event line-count uses a width-based proxy that under-counts AI-driven multi-line inserts.
- **[metrics-etl-scheduler.js](src/services/metrics-etl-scheduler.js)** — Ticks the ETL on a `setInterval` driven by `METRICS_ETL_INTERVAL_SECONDS`. Re-entrant: if a pass is still running, the next tick skips. Default 300s in code; production set to 60s in cluster Secret.
- **[insight-trigger.service.js](src/services/insight-trigger.service.js)** — The core insight pipeline. `evaluateUser(userId)` gates on Gemini configured → cooldown → current session → at least one rule fires → LLM call → persistence. Also exposes `expireLatestRecommendation` and `createDemoRecommendation` for the manual trigger endpoint.
- **[insight-scheduler.js](src/services/insight-scheduler.js)** — Calls `evaluateUser` for every active user every `INSIGHT_CHECK_INTERVAL_SECONDS`. "Active" means activity within `INSIGHT_ACTIVITY_WINDOW_MINUTES`. Also drives `pairing.service.js#cleanupExpired` every 5 min.
- **[llm/gemini.service.js](src/services/llm/gemini.service.js)** — Wraps `@google/generative-ai`. Uses Gemini's `responseSchema` parameter so the model is forced to emit the right shape. Output goes through Ajv as a backstop plus a hallucination guard that rejects evidence citing values not in the input prompt.
- **[pairing.service.js](src/services/pairing.service.js)** — Implements the device-code state machine (`createPairing` / `approvePairing` / `exchangePairing` / `cleanupExpired`). Token plaintext is held on the pairing row until exactly-once exchange.
- **[api-token.service.js](src/services/api-token.service.js)** — `issueToken` / `verifyToken` / `revokeToken`. Tokens are SHA-256 hashed at rest; plaintext is shown only at creation time.
- **[jwt.service.js](src/services/jwt.service.js)** — Sign/verify the `dvf_session` JWT.
- **[user-auth.service.js](src/services/user-auth.service.js)** + **[password.service.js](src/services/password.service.js)** — Registration, password verification (bcrypt).
- **[oauth.service.js](src/services/oauth.service.js)** + **[oauth-state.store.js](src/services/oauth-state.store.js)** — `google` and `github` OAuth flows. State is in-memory with 5-min TTL.

## Database

PostgreSQL via Sequelize. Models in [src/models/](src/models/):

- **`users`** — id (UUID), email, name, password_hash, provider (`password` | `google` | `github`), provider_subject.
- **`sessions`** — id (UUID), user_id, start_time, end_reason. One session = one continuous block of activity in the extension. Rotates on idle or manual restart.
- **`activities`** — id, session_id, event_type, file_path, metadata (JSONB), timestamp. Raw telemetry, never aggregated in-place.
- **`metrics_daily`** — (user_id, date) PK, lines_added, lines_deleted, editor_switch_count, rapid_switch_count, top_files (JSONB). ETL-maintained.
- **`metrics_session`** — same shape but keyed on session_id.
- **`workflow_states`** — id, session_id, state_type (e.g., `stuck_loop`, `normal`, `demo`), confidence_score, created_at. One row per LLM evaluation.
- **`recommendations`** — id, workflow_state_id, recommendation_type, recommendation_text, code_context (JSONB — holds `reasoning`, `triggered_rule`, `evidence`), user_action (`accepted` | `dismissed` | `snoozed` | `expired` | NULL = pending), created_at.
- **`api_tokens`** — id, user_id, name, token_hash, last_used_at, revoked_at.
- **`pairing_codes`** — id, user_code, status, user_id, api_token_id, token_plaintext (transient), expires_at.
- **`etl_jobs`** — singleton row holding `last_processed_activity_id` watermark.

Migrations live in [src/config/migrations/](src/config/migrations/), run via `npm run db:migrate`.

## Background jobs

Three background loops, all on plain `setInterval` (no Bull / no Redis):

| Job | File | Default interval | Owns |
|---|---|---|---|
| Metrics ETL | [metrics-etl-scheduler.js](src/services/metrics-etl-scheduler.js) | 300s (60s in prod) | `metrics_daily`, `metrics_session`, `etl_jobs` watermark |
| Insight scheduler | [insight-scheduler.js](src/services/insight-scheduler.js) | 600s (60s in prod) | `workflow_states`, `recommendations` |
| Pairing cleanup | embedded in insight-scheduler | 300s | Deletes `pairing_codes` rows whose `expires_at` is > 1 hour in the past |

All three are started from `server.js` after the HTTP listener boots, and stop cleanly on `SIGTERM`.

## Authentication model

Two parallel auth schemes, both checked by [middleware/auth.middleware.js](src/middleware/auth.middleware.js):

1. **JWT** — Issued by `/auth/login` or the OAuth callback. Stored in the `dvf_session` cookie (HTTP-only, SameSite=Lax). Also accepted as `Authorization: Bearer <jwt>` for non-browser clients.
2. **API token** — `dvf_…` prefixed bearer token. Issued by `/auth/tokens` or device-code pairing. Stored in VSCode `SecretStorage` by the extension.

`verifyJwt` middleware accepts **either**. Some endpoints lock to JWT only (notably `/auth/pairings/:user_code/approve` and `/auth/tokens` creation): an API token can't mint more API tokens or approve a pairing for itself.

Sequence: see [docs/frontend-auth.md](docs/frontend-auth.md) for the web flow, [docs/extension-pairing.md](docs/extension-pairing.md) for the device-code flow.

## Validation

Request bodies are validated against the OpenAPI definition in [openspec.yaml](openspec.yaml) via [middleware/validation.middleware.js](src/middleware/validation.middleware.js):

```js
router.post('/telemetry', verifyJwt, validateRequest('/telemetry'), submitTelemetry);
```

The middleware looks up the schema by HTTP method + path from the loaded OpenAPI doc, compiles it once with Ajv, and validates `req.body`. Schema mismatch → HTTP 400 with the Ajv error path. Unknown endpoints log a warning and pass through (so adding a new route doesn't immediately break — but it has no validation until you add a schema entry).

OpenAPI also drives the validation for the LLM's response shape in [llm/gemini.service.js](src/services/llm/gemini.service.js) — see the inline `geminiResponseSchema` constant.

## Configuration

All config is env-driven. See [.env.example](.env.example) for the full list with comments. Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | Toggles cookie `secure` flag, log verbosity |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `localhost:5432/devflow_db` | Postgres connection |
| `JWT_SECRET` | — | **Required.** HMAC key for session JWTs |
| `GOOGLE_API_KEY` | — | Gemini API key. If unset, the insight scheduler logs once and disables itself; the rest of the API still runs |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Override to use Pro, Lite, or older Flash |
| `INSIGHTS_ENABLED` | `true` | Kill switch for the insight scheduler |
| `INSIGHT_CHECK_INTERVAL_SECONDS` | `600` | How often the scheduler ticks. Production: `60`. |
| `INSIGHT_COOLDOWN_MINUTES` | `45` | Minimum gap between pending recommendations for the same user |
| `SNOOZE_DURATION_MINUTES` | `30` | Replaces cooldown when the user snoozed |
| `INSIGHT_ACTIVITY_WINDOW_MINUTES` | `30` | Users without activity in this window are skipped (no LLM call) |
| `METRICS_ETL_INTERVAL_SECONDS` | `300` | How often the ETL ticks. Production: `60`. |
| `METRICS_ETL_BATCH_SIZE` | `5000` | Max `activities` rows per ETL pass |
| `METRICS_ETL_ENABLED` | `true` | Kill switch for the ETL scheduler |
| `RULE_VERY_LONG_SESSION_MIN` | `30` | Threshold for the `very_long_session` rule (min) |
| `RULE_LONG_SESSION_MIN` | `15` | Threshold for the `long_session` rule |
| `RULE_HIGH_CHURN_RATIO` | `0.3` | Threshold for the `high_churn` rule |
| `RULE_RAPID_SWITCH_COUNT` | `3` | Threshold for the `rapid_context_switching` rule |
| `RULE_DELETE_HEAVY_TOTAL` | `5` | Threshold for the `delete_heavy_rewriting` rule |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated browser origins for credentialed requests. Empty = browser cross-origin disabled. Requests without an Origin header (curl, the extension) are not blocked |
| `FRONTEND_URL` | hackathon URL hardcoded | Used to build the `verification_uri` in pairing |
| `ADMIN_USER_IDS` | — | Comma-separated UUIDs allowed to hit `POST /metrics/etl/run` |
| `LOG_LEVEL` | `info` | winston level (`debug`, `info`, `warn`, `error`) |

> The rule thresholds (`RULE_*`) are currently set to demo-friendly low values so the insight pipeline fires on modest activity. Production-realistic values: `240 / 120 / 0.4 / 30 / 50`.

## Deployment

The cluster manifests live in [k8s/](k8s/):

- [deployment.yaml](k8s/deployment.yaml) — single replica of `rafalll14/who-goes-to-try-backend:latest`. Env is injected from `who-goes-to-try-backend-secret`.
- [service.yaml](k8s/service.yaml) — ClusterIP exposing port 3000.
- [combined_ingress.yaml](k8s/combined_ingress.yaml) — Traefik ingress routing `who-goes-to-try.hackathon.sev-2.com/api` to backend, `/` to frontend.
- [middleware.yaml](k8s/middleware.yaml) — strip-prefix middleware (currently unused after the combined-ingress refactor).

To redeploy after a code change:

```bash
docker build -t rafalll14/who-goes-to-try-backend:latest .
docker push rafalll14/who-goes-to-try-backend:latest
kubectl -n who-goes-to-try rollout restart deploy/who-goes-to-try-backend
kubectl -n who-goes-to-try rollout status deploy/who-goes-to-try-backend
```

`imagePullPolicy: Always` means the *restart* is what triggers a re-pull. Without the restart, the running pod keeps its cached `:latest`.

## Detailed reading

| Topic | Doc |
|---|---|
| AI insights pipeline (rules + Gemini + cooldown) | [docs/ai-insights.md](docs/ai-insights.md) |
| Extension pairing flow (device code) | [docs/extension-pairing.md](docs/extension-pairing.md) |
| Extension contract (what events it sends, what it reads) | [docs/extension.md](docs/extension.md) |
| Frontend auth flow (cookies, OAuth, /auth/me) | [docs/frontend-auth.md](docs/frontend-auth.md) |
| Metrics ETL — schema, watermark, idempotency | [docs/metrics.md](docs/metrics.md) |
| OpenAPI specification (the source of truth for request/response shapes) | [openspec.yaml](openspec.yaml) |
| Spec-driven change proposals | [openspec/changes/](openspec/changes/) |

## Known issues / gotchas

- **The ETL line-count is a width-based proxy.** `metrics_daily.lines_added` / `lines_deleted` collapse multi-line inserts (especially AI-generated ones) to the *range width* of the change, which for single-point inserts is 1. This is why three of the four insight rules fire less than they should — they're starved of data. Fix is to compute line counts at the source in the extension and emit them; tracked but not yet implemented.
- **Cooldown semantics:** post-2026-05-13 the cooldown only gates *pending* (`null`) or *snoozed* recommendations. `dismissed` / `accepted` / `expired` no longer block new ones.
- **Demo recommendation rows have `state_type = 'demo'`** and live alongside real ones in `recommendations`. Easy to filter out with a SQL `WHERE ws.state_type != 'demo'` when you want production-only views.
- **OAuth state is in-process.** A pod restart loses any in-flight OAuth login. Acceptable at hackathon scale, would need Redis for multi-replica deployments.
- **Single replica.** Both background schedulers (`insight-scheduler` and `metrics-etl-scheduler`) use in-process `setInterval` with no leader election. Running multiple backend pods would double-tick everything. The `metrics_daily` upserts are idempotent so it wouldn't corrupt data, but the LLM cost would double.
