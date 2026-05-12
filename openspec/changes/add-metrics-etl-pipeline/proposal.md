## Why

We persist rich telemetry into the `activities` table but never roll it up into anything useful. Two specific productivity-wellness signals already live in the raw `metadata` JSONB but are invisible without scanning every row: **code churn** (how much of what a developer writes gets deleted shortly after) and **context switching** (how often a developer hops between files). Without an ETL step, every dashboard query would have to scan every event, JSONB-extract, and sum on the fly — which won't scale and which the future dashboard frontend can't depend on.

This change introduces a small periodic ETL job that reads new `text_change` and `editor_switch` events, computes the two metrics, and writes pre-aggregated rows. It also exposes JWT-protected REST endpoints so a future dashboard (and the existing extension, if desired) can read the numbers cheaply.

## What Changes

- Add an `EtlJob` Sequelize model + table that records the watermark (the latest `activity.id` consumed) so the job is incremental and idempotent.
- Add two aggregate tables:
  - `metrics_daily` — one row per `(user_id, date)` with rolled-up churn and context-switching counters.
  - `metrics_session` — one row per `session_id` with the same counters scoped to a single session.
- Add a periodic backend job (default: every 5 minutes) that:
  - Reads new `text_change` events since the last watermark, derives `lines_added` / `lines_deleted` from each event's `metadata.metrics.affected_line_ranges` and `metadata.metrics.characters_added/deleted`, and increments the relevant `(user_id, date)` and `session_id` rows.
  - Reads new `editor_switch` events, counts switches per `(user_id, date)` and per `session_id`, and keeps a top-N list of file paths visited (stored as JSONB).
  - Advances the watermark in a single transaction with the aggregate writes — so a crash mid-run cannot double-count or lose events.
- Add a metrics service that exposes the two derived numbers:
  - **Churn ratio** = `sum(lines_deleted) / sum(lines_added)` over a date range, clamped to `[0, 1]` (deletes capped at adds; pure deletes from elsewhere don't inflate the ratio above 1).
  - **Context-switching count** = `sum(editor_switch_count)` over a date range, plus the top-N most-visited file paths in that range.
- Add new REST endpoints under `/api/v1/metrics`, JWT-protected, returning JSON:
  - `GET /api/v1/metrics/churn?from=<iso>&to=<iso>&grain=daily|session` — returns the churn ratio and the underlying `lines_added` / `lines_deleted` totals.
  - `GET /api/v1/metrics/context-switching?from=<iso>&to=<iso>&grain=daily|session&top_n=<int>` — returns total switch count and a ranked list of file paths.
- Add operational endpoints for testing and backfill:
  - `POST /api/v1/metrics/etl/run` (admin-only — gated by a config flag) — triggers a single ETL pass immediately, useful for the test runbook and for ad-hoc backfills.

## Capabilities

### New Capabilities
- `metrics-etl`: The incremental ETL job that reads `activities` and writes the aggregate tables — watermark management, line-counting heuristics, transactional advance, idempotency, and recovery behavior.
- `productivity-metrics`: The read-side API surface — the churn ratio and context-switching count definitions, the `GET /metrics/*` endpoints, query parameters, response shape, and auth rules.

### Modified Capabilities
<!-- None. The activities/sessions schema and the telemetry-ingestion contract are unchanged. -->

## Impact

- **Backend code**: new [src/models/etl-job.model.js], [src/models/metrics-daily.model.js], [src/models/metrics-session.model.js], new [src/services/metrics-etl.service.js], new [src/services/metrics.service.js], new [src/controllers/metrics.controller.js], new [src/routes/metrics.routes.js], small additions to [src/server.js] to start the scheduler on boot.
- **Database**: three new tables (`etl_jobs`, `metrics_daily`, `metrics_session`). Index on `activities (id)` already exists via primary key; we may add a partial index on `activities (event_type)` if scan cost becomes a concern (deferred unless profiling shows it).
- **No changes** to the extension. Line counting is derived from already-captured `affected_line_ranges` + `characters_added/deleted`. No new fields, no version bump.
- **No changes** to the telemetry-ingestion contract. The activities table remains the source of truth; the aggregates are derived.
- **Out of scope (deliberately, for follow-up changes)**: removing unused listeners (`file_save`, `debug`, `terminal`, `git`) and their ingestion paths; dashboard frontend; AI-suggestions feature.
