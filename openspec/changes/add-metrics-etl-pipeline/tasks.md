## Notes on implementation deltas

- **Task 1.5 was NOT executed as written.** The original `node src/test-models.js` script does `sequelize.sync({ force: true })`, which would DROP every existing table (`users`, `api_tokens`, `activities`, etc.) and recreate them, wiping production data. Instead, I created [src/bootstrap-metrics-tables.js](src/bootstrap-metrics-tables.js) which uses `Model.sync()` (no `force`) on only the three new models and seeds the initial `etl_jobs` row. **You need to run `node src/bootstrap-metrics-tables.js` once against your local Postgres before the ETL or endpoints will work.**
- Query-param validation for the GET endpoints is done **inline in the controller**, not via the shared `validateRequest` middleware. Reason: [src/middleware/validation.middleware.js](src/middleware/validation.middleware.js) only validates POST bodies (`getSchemaForEndpoint(..., 'post', ...)`). Extending it to also do query params would be scope creep. The metrics endpoints are documented in [openspec.yaml](openspec.yaml) for OpenAPI completeness even though that schema isn't enforced at runtime today.
- The `POST /metrics/etl/run` endpoint additionally requires `auth_method === 'jwt'` (API tokens are rejected with 403), mirroring the pattern in [src/controllers/token.controller.js](src/controllers/token.controller.js). The two read endpoints accept either auth method.

## 1. Database models and migrations

- [x] 1.1 Create `EtlJob` Sequelize model at [src/models/etl-job.model.js](src/models/etl-job.model.js)
- [x] 1.2 Create `MetricsDaily` model at [src/models/metrics-daily.model.js](src/models/metrics-daily.model.js) with composite PK `(user_id, date)`
- [x] 1.3 Create `MetricsSession` model at [src/models/metrics-session.model.js](src/models/metrics-session.model.js) with PK `session_id`
- [x] 1.4 Register the three new models in [src/models/index.js](src/models/index.js)
- [ ] 1.5 Run the bootstrap script: `node src/bootstrap-metrics-tables.js` — _user action: not yet run; safe to run (no force-drop), creates only the three new tables and seeds the watermark row_

## 2. ETL service: core pass logic

- [x] 2.1 Create [src/services/metrics-etl.service.js](src/services/metrics-etl.service.js) exporting `runOnce`
- [x] 2.2 Transactional watermark read + batched activities fetch (joined to sessions for `user_id`)
- [x] 2.3 Group by event_type; ignore non-relevant types but advance watermark past them
- [x] 2.4 `aggregateTextChanges` with the line-count derivation rule (missing `affected_line_ranges` logs a warning, contributes 0)
- [x] 2.5 `aggregateEditorSwitches` builds per-key counters and a `top_files` Map from `metadata.to.file`
- [x] 2.6 `INSERT ... ON CONFLICT (user_id, date) DO UPDATE` with `+=` for counters and full-replace for `top_files` (merged in app code with `FOR UPDATE` row lock)
- [x] 2.7 Same pattern for `metrics_session` on `(session_id)`
- [x] 2.8 Watermark advance via `INSERT ... ON CONFLICT (job_key) DO UPDATE` inside the same transaction
- [x] 2.9 Errors propagate; caller (scheduler / `triggerNow`) logs and surfaces

## 3. ETL scheduler

- [x] 3.1 `METRICS_ETL_INTERVAL_SECONDS` and `METRICS_ETL_BATCH_SIZE` read from env in the scheduler module
- [x] 3.2 [src/services/metrics-etl-scheduler.js](src/services/metrics-etl-scheduler.js) with `start`, `stop`, `triggerNow`, and an in-memory `isRunning` mutex
- [x] 3.3 [src/server.js](src/server.js) starts the scheduler after `listen()` succeeds; SIGTERM/SIGINT handlers call `stop()`
- [x] 3.4 `METRICS_ETL_ENABLED` defaults to `true`; set to `false` or `0` to disable

## 4. Metrics read service and controllers

- [x] 4.1 [src/services/metrics.service.js](src/services/metrics.service.js) with `getChurn` and `getContextSwitching`, both supporting `grain=daily` and `grain=session`
- [x] 4.2 `mergeTopFiles(rows, topN)` helper sums per-row `top_files` maps and returns the global top-N
- [x] 4.3 [src/controllers/metrics.controller.js](src/controllers/metrics.controller.js) with `getChurnHandler` and `getContextSwitchingHandler` — inline query-param validation, includes `definition` field in the response
- [x] 4.4 [src/controllers/metrics-etl.controller.js](src/controllers/metrics-etl.controller.js) with `postRunEtl` — checks `auth_method === 'jwt'` and `isAdmin`, surfaces `triggerNow` result
- [x] 4.5 `triggerNow()` on the scheduler respects the same `isRunning` mutex

## 5. Routes and validation schemas

- [x] 5.1 [src/routes/metrics.routes.js](src/routes/metrics.routes.js) with the three routes
- [x] 5.2 Router mounted at `/api/v1` in [src/server.js](src/server.js)
- [x] 5.3 [openspec.yaml](openspec.yaml) updated with `/metrics/churn`, `/metrics/context-switching`, `/metrics/etl/run` paths
- [x] 5.4 Inline validation in the controller rejects bad input with HTTP 400. The shared `validateRequest` middleware does not handle GET query params today; extending it was deferred (see notes).

## 6. Admin gating

- [x] 6.1 [src/utils/admin.js](src/utils/admin.js) reads `ADMIN_USER_IDS` and exposes `isAdmin(userId)`
- [x] 6.2 `postRunEtl` uses `isAdmin`; returns 403 when not admin or when caller used an API token
- [x] 6.3 Documented in [docs/metrics.md](docs/metrics.md)

## 7. Manual verification

- [ ] 7.1 Send `text_change` and `editor_switch` events; trigger `POST /api/v1/metrics/etl/run`; confirm `metrics_daily` / `metrics_session` rows appear
- [ ] 7.2 `GET /api/v1/metrics/churn?from=...&to=...` — confirm ratio matches a hand-calculation
- [ ] 7.3 `GET /api/v1/metrics/context-switching?from=...&to=...&top_n=5` — confirm counts and `top_files` ranking
- [ ] 7.4 Rerun the ETL — confirm aggregates unchanged (idempotency)
- [ ] 7.5 Kill the backend mid-pass and restart — confirm no double-counting, watermark resumes
- [ ] 7.6 Hit `POST /metrics/etl/run` as non-admin — expect 403
- [ ] 7.7 Hit `GET /metrics/churn` without a JWT — expect 401
- [ ] 7.8 Hit `GET /metrics/churn` with user A's token — confirm user B's data not visible

## 8. Documentation

- [x] 8.1 Created [docs/metrics.md](docs/metrics.md) covering metrics definitions, endpoints, ETL behavior, manual trigger, first-time setup, and limitations
- [x] 8.2 Env vars documented in [docs/metrics.md](docs/metrics.md): `METRICS_ETL_INTERVAL_SECONDS`, `METRICS_ETL_BATCH_SIZE`, `METRICS_ETL_ENABLED`, `ADMIN_USER_IDS`
