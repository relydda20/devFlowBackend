## ADDED Requirements

### Requirement: Incremental watermark-based reads

The ETL job SHALL process `activities` rows incrementally using a single watermark stored in an `etl_jobs` row. Each pass MUST read rows with `id` strictly greater than the stored watermark, ordered by `id` ascending, limited to a configurable batch size. The job MUST NOT use `timestamp` as the watermark.

#### Scenario: First-ever ETL pass
- **WHEN** the ETL runs and no `etl_jobs` row exists for the `metrics` job key
- **THEN** the job initializes the watermark to `0` (or `NULL` treated as `-1`) and reads from the smallest `activities.id`

#### Scenario: Subsequent ETL pass advances the watermark
- **WHEN** a pass reads rows with `id` in the range `(watermark, max_id]`
- **AND** the pass completes its aggregate writes successfully
- **THEN** the watermark is updated to `max_id` within the same transaction

#### Scenario: ETL pass with no new rows
- **WHEN** the ETL runs and no `activities.id > watermark` exist
- **THEN** the pass exits cleanly without modifying any aggregate table
- **AND** the watermark is unchanged

### Requirement: Transactional aggregate writes

Each ETL pass SHALL perform all of its aggregate increments and the watermark advance within a single database transaction. A failure at any point MUST roll back both the aggregate changes and the watermark update.

#### Scenario: Crash before commit
- **WHEN** the ETL is mid-pass and the process crashes before the transaction commits
- **THEN** the database state is identical to before the pass started
- **AND** the next pass reprocesses the same range and produces the same aggregates

#### Scenario: Aggregate upsert failure
- **WHEN** an upsert into `metrics_daily` or `metrics_session` fails
- **THEN** the transaction rolls back
- **AND** the watermark is not advanced

### Requirement: Idempotent reruns

Running the ETL twice over the same range SHALL produce the same aggregate values as running it once. Reruns MUST NOT cause double-counting.

#### Scenario: Manual rerun on the same range
- **WHEN** an operator triggers `POST /api/v1/metrics/etl/run` after a pass has already advanced the watermark past a range
- **THEN** that range is not reprocessed
- **AND** the aggregates are unchanged

### Requirement: Line-count derivation for text_change events

For each `text_change` event consumed, the ETL SHALL derive `lines_added` and `lines_deleted` from the event's stored `metadata.metrics`:

- `lines_added`: if `metadata.metrics.characters_added > 0`, sum `(end - start + 1)` across `metadata.metrics.affected_line_ranges`; otherwise `0`.
- `lines_deleted`: if `metadata.metrics.characters_deleted > 0`, sum `(end - start + 1)` across `metadata.metrics.affected_line_ranges`; otherwise `0`.

A single text-change event with both `characters_added > 0` and `characters_deleted > 0` MUST contribute to both totals.

#### Scenario: Pure insertion
- **WHEN** a `text_change` event has `characters_added=120, characters_deleted=0, affected_line_ranges=[{start:10,end:14}]`
- **THEN** `lines_added = 5`
- **AND** `lines_deleted = 0`

#### Scenario: Pure deletion
- **WHEN** a `text_change` event has `characters_added=0, characters_deleted=80, affected_line_ranges=[{start:20,end:22}]`
- **THEN** `lines_added = 0`
- **AND** `lines_deleted = 3`

#### Scenario: In-place modify (add and delete in the same range)
- **WHEN** a `text_change` event has `characters_added=50, characters_deleted=30, affected_line_ranges=[{start:5,end:7}]`
- **THEN** `lines_added = 3`
- **AND** `lines_deleted = 3`

#### Scenario: Missing affected_line_ranges
- **WHEN** a `text_change` event has no `metadata.metrics.affected_line_ranges` or it is empty
- **THEN** the event contributes `lines_added = 0` and `lines_deleted = 0`
- **AND** the ETL emits a warning to logs but does NOT fail the pass

### Requirement: Editor-switch counting and top-N files

For each `editor_switch` event consumed, the ETL SHALL increment the `editor_switch_count` for the appropriate `(user_id, date)` and `session_id` rows, and update the per-day `top_files` JSONB so that it contains the 20 most-visited destination file paths for that day, sorted by visit count descending.

#### Scenario: Single switch updates counters
- **WHEN** an `editor_switch` event has `metadata.to.file = "src/app.ts"`
- **THEN** the row's `editor_switch_count` increments by 1
- **AND** `top_files` includes `{ path: "src/app.ts", count: <previous + 1> }`

#### Scenario: top_files is bounded at 20
- **WHEN** more than 20 distinct file paths have been visited in a day
- **THEN** `top_files` contains exactly 20 entries
- **AND** they are the 20 highest-count entries

#### Scenario: Rapid-switch flag is preserved as a separate counter
- **WHEN** an `editor_switch` event has `metadata.metrics.is_rapid_context_switching = true`
- **THEN** the row's `rapid_switch_count` increments by 1
- **AND** the regular `editor_switch_count` also increments by 1

### Requirement: ETL ignores non-relevant event types

The ETL SHALL only consume `text_change` and `editor_switch` events. All other event types (including `file_save`, `debug`, `terminal`, `git`, `session_start`, etc.) MUST be skipped and MUST NOT block watermark advancement.

#### Scenario: Mixed batch with irrelevant events
- **WHEN** a batch contains 100 events: 40 `text_change`, 20 `editor_switch`, and 40 of other types
- **THEN** only the 60 relevant events contribute to aggregates
- **AND** the watermark advances past all 100

### Requirement: Periodic scheduler with single-pass mutex

The ETL job SHALL be invoked automatically on a configurable interval (default 300 seconds, controlled by `METRICS_ETL_INTERVAL_SECONDS`). Only one pass at a time SHALL be in flight; if a pass is still running when the next tick fires, the new invocation MUST exit immediately without queuing.

#### Scenario: Overlapping ticks
- **WHEN** an ETL pass takes 400 seconds and the interval is 300 seconds
- **THEN** the second tick at t=300s sees the in-memory mutex held and skips
- **AND** the third tick at t=600s runs normally (the first pass having completed at t=400s)

#### Scenario: Configurable interval
- **WHEN** `METRICS_ETL_INTERVAL_SECONDS` is set to `60`
- **THEN** the job runs every 60 seconds

### Requirement: Operational endpoint to trigger an immediate pass

The system SHALL expose `POST /api/v1/metrics/etl/run`, accepting no body, that triggers a single ETL pass immediately and returns its result summary. The endpoint MUST be JWT-protected and gated to admin users (via an `ADMIN_USER_IDS` allow-list).

#### Scenario: Admin triggers a pass
- **WHEN** an admin user POSTs to `/api/v1/metrics/etl/run`
- **THEN** an ETL pass starts immediately (subject to the in-memory mutex)
- **AND** the response includes `{ processed_count, watermark_before, watermark_after, duration_ms }`

#### Scenario: Non-admin user attempts to trigger
- **WHEN** a non-admin authenticated user POSTs to the endpoint
- **THEN** the system responds with HTTP `403 Forbidden`

#### Scenario: Trigger while a pass is in flight
- **WHEN** an admin POSTs while another pass holds the mutex
- **THEN** the system responds with HTTP `409 Conflict` and a body indicating the in-flight state
- **AND** no second pass starts
