## Context

Today, every telemetry event lands in [src/models/activity.model.js](src/models/activity.model.js) as one row with a JSONB `metadata` column. The two events that carry the signals we need are `text_change` (with `metadata.metrics.characters_added`, `characters_deleted`, and `affected_line_ranges`) and `editor_switch` (with `metadata.from.file`, `metadata.to.file`, `metadata.metrics.switch_interval_seconds`). Other event types (`file_save`, `debug`, `terminal`, `git`, `session_start`) exist in the table but are not consumed by this ETL.

The activities table has no derived/aggregated form. Any dashboard reading from it directly would scan the JSONB on every page load, which is fine at 5k rows and an obvious bottleneck at 5M. We need a precomputed aggregate, refreshed periodically, that the dashboard can query in milliseconds.

A core constraint: the ETL must be **safely re-runnable**. Network blips, server restarts, and manual reruns must not double-count events or lose them. The standard pattern is a *watermark*: a small row that says "I've processed up to activity.id = N." Aggregate writes and watermark updates must commit together (one transaction) or not at all.

## Goals / Non-Goals

**Goals:**
- Cheap, indexed reads for the future dashboard: a churn ratio or switch count over a date range should be a single SQL query against a small aggregate table, not a JSONB scan.
- Idempotent and crash-safe: rerunning the ETL produces the same numbers; a crash mid-pass loses neither events nor accuracy.
- Incremental by default: each pass processes only events since the last watermark, so the job's cost is proportional to recent activity, not to the entire history.
- Heuristic-only line counting, no extension changes. Line counts are derived from data already in `metadata`.
- Reversibility: dropping the new tables and the scheduler removes the feature cleanly; the source-of-truth `activities` table is untouched.

**Non-Goals:**
- Real-time / streaming aggregates. A 5-minute lag is fine for a productivity dashboard.
- Dashboard frontend. Just the read API for it to call later.
- AI suggestions on top of the metrics. Separate change.
- Removing unused telemetry listeners. Tracked as a follow-up; see proposal.
- A pluggable rule engine for new metrics. We hardcode churn and context-switching for v1. If a third metric arrives, we copy-paste — three is still less code than an abstraction.
- Per-file-per-day aggregates. The top-N file list inside the daily row covers the "which files do I switch into" use case without exploding the table.

## Decisions

### Watermark on `activities.id`, not on `timestamp`

The ETL reads `SELECT * FROM activities WHERE id > :last_id ORDER BY id ASC LIMIT :batch_size`.

**Why:** `id` is monotonic, primary-key-indexed, and guaranteed unique. Using `timestamp` invites the classic ETL bug where two events have the same timestamp at the page boundary and one gets skipped or double-counted. The trade-off is that events ingested out of order (clock skew, late batches) might be processed in a non-time order — but because we aggregate by *event* `timestamp`, not by *processing* order, the final aggregates are deterministic regardless.

**Alternative considered:** `(timestamp, id)` composite watermark. Rejected — same correctness benefit as `id` alone, more code.

### Single-transaction commit per pass

Each ETL pass does, in one DB transaction:
1. `SELECT ... FROM activities WHERE id > :last_id LIMIT :batch_size FOR UPDATE SKIP LOCKED` (the `FOR UPDATE SKIP LOCKED` lets us run multiple workers later without changing this code).
2. Upsert into `metrics_daily` and `metrics_session` (`INSERT ... ON CONFLICT (...) DO UPDATE SET ... += EXCLUDED....`).
3. Update `etl_jobs.last_processed_activity_id = MAX(processed_id)`.
4. Commit.

**Why:** A crash before commit rolls back the increments AND leaves the watermark untouched — the next pass redoes the same range and produces identical numbers (because increments are deterministic functions of the source rows). A crash after commit is a no-op for the next pass. There is no failure mode where the watermark advances but the aggregates don't, or vice versa.

**Alternative considered:** Two-phase with a "checkpoint" table. Overkill — Postgres transactions already give us atomicity over multiple rows.

### Heuristic line counting, documented and clamped

For each `text_change` event, the ETL computes:
- `lines_added`: sum over `affected_line_ranges` of `(end - start + 1)` when `characters_added > 0`; **0** when `characters_added == 0` (pure delete).
- `lines_deleted`: sum over `affected_line_ranges` of `(end - start + 1)` when `characters_deleted > 0`; **0** when `characters_deleted == 0` (pure insert).
- A range that has both adds and deletes contributes to **both** (it's a "modify" — counted once on each side). This biases the metric slightly toward "more churn" for in-place edits, which matches intent: rewriting a function *is* churn.

**Why heuristic:** the extension does not currently emit explicit line counts. We have `affected_line_ranges` and character counts. The heuristic is honest about what it knows: a range from line 10–14 is "5 lines touched" — whether that's an add or delete depends on which character bucket is non-zero.

**Churn ratio formula:** `churn = min(1, total_lines_deleted / total_lines_added)` if `total_lines_added > 0`, else `null` (not zero — we distinguish "no churn" from "no writing"). The clamp prevents pathological ratios like 5.0 when a user pastes-then-deletes-a-larger-block; it also matches how this metric is commonly read ("what fraction of what I wrote did I throw away").

**Trade-off documented in the spec:** these are typing-session-level estimates, not VCS-level churn. If we later integrate with git diffs, those numbers will diverge and that's expected.

### Context switching counts every editor change, ignoring fast-flip noise via existing heuristic

`editor_switch_count` = number of `editor_switch` events in the window. We do NOT post-filter for rapid context switching — the extension's `editor_switch.metadata.metrics.is_rapid_context_switching` flag is captured but kept in the JSONB; the ETL aggregates can include a `rapid_switch_count` alongside `switch_count` to expose both numbers.

**Why:** The user asked for "how many times the user switches between files." That's literally `switch_count`. The "rapid" subset is a derived quality measure the dashboard can use as a secondary signal without us having to make a call now.

**Top-N file paths:** for each `(user_id, date)` we store `top_files JSONB`, a sorted array of `{ path, count }` truncated to top 20. We rebuild this in each pass over the new events, merging with the existing row's `top_files`. Twenty is enough for any reasonable "your most-switched-into files today" UI.

### Aggregate at two grains: `(user_id, date)` and `(session_id)`

`metrics_daily (user_id, date)` is for the dashboard — "show me my last 30 days of churn." `metrics_session (session_id)` is for per-session analysis — "show me my churn during the 4-hour session yesterday afternoon."

**Why both:** the user asked for both grains. They are both small (sessions are rarely > 1k per user, days are 365 per year per user) and the ETL writes them in the same transaction.

**No `(user_id, file_path, date)` grain:** ruled out for v1. The "which files churn most" question is partially answered by the per-day `top_files` for context switching, and if pure file-level churn becomes a requested feature we can add a third aggregate later without changing the existing two.

### Scheduling: in-process `setInterval`, not a separate worker or cron

The job starts in [src/server.js] on boot and runs every `METRICS_ETL_INTERVAL_SECONDS` (default 300). On shutdown, the interval is cleared.

**Why:** This service is single-instance for now. A separate worker process adds deployment complexity for no real gain at this scale. A cron job (system-level) would couple us to the host. Postgres advisory locks would let us run multi-instance safely later (`pg_try_advisory_lock(hash('metrics-etl'))`) but that's a future enhancement; for v1 the single-process invariant is enforced by deployment topology.

**Recovery:** if the process crashes mid-pass, the transaction rolls back; the next interval tick reruns the same range. If the process is down for hours, the next start catches up by chewing through accumulated events one batch at a time (batch_size default 5000).

### Read API: only what the proposal listed; no clever query DSL

The two GET endpoints accept a date range and optional grain. No GROUP BY, no facet filtering, no sub-paths. The dashboard can call them N times for N developers/dates if it needs to.

**Why:** YAGNI. Two endpoints today, more when there's a concrete dashboard requirement. Building a generic metrics-query DSL ahead of a single consumer is the kind of abstraction that ages badly.

## Risks / Trade-offs

- **[Risk] Heuristic line counting will produce numbers that disagree with `git diff` for the same code** → Mitigation: documented in the API response (the JSON includes a `definition: "typing-heuristic"` field so dashboard consumers know what they're reading). Acceptable because what we measure is *typing behavior*, not *VCS history*.
- **[Risk] A bug in the ETL silently produces wrong aggregates that nobody notices because the dashboard trusts them** → Mitigation: the `POST /metrics/etl/run` endpoint plus a small `--rebuild` operational mode (deferred to ops-as-needed) let us re-derive aggregates from the raw activities at any time. The raw events are the source of truth and are never modified by the ETL.
- **[Risk] Watermark advancement and clock skew between events ingested late** → Late events have larger `id` even if their `timestamp` is older. Daily aggregates use `timestamp` for the `date` key, so a late event with a 3-day-old timestamp correctly back-fills the 3-day-old row. No correctness issue, but dashboards reading "yesterday" before the late event arrived will see a slightly stale number — acceptable.
- **[Trade-off] In-process scheduler means an unrelated bug that crashes the API process also stops the ETL** → Mitigation: the next process start resumes from the watermark, so the loss is "delay," not "data." Worth revisiting if we move to a multi-replica deployment.
- **[Trade-off] `metrics_session` rows grow unboundedly with session count** → At realistic per-user session rates (~10/day) this is 3650 rows/user/year. Negligible for v1; if it becomes large we can TTL-prune sessions older than N months without affecting `metrics_daily`.
- **[Risk] `POST /metrics/etl/run` could be abused to run expensive backfills repeatedly** → Mitigation: admin-only (gated by `ADMIN_USER_IDS` env var or a flag on the user). Returns immediately if a pass is already in flight (in-memory mutex).
