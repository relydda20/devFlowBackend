## ADDED Requirements

### Requirement: Code-churn read endpoint

The system SHALL expose `GET /api/v1/metrics/churn`, JWT-protected, that returns the code-churn ratio for the authenticated user over a requested date range. The endpoint MUST accept `from` (ISO 8601 date), `to` (ISO 8601 date), and `grain` (`daily` or `session`, default `daily`). The response MUST include both the ratio and the underlying totals.

The churn ratio is defined as `min(1, total_lines_deleted / total_lines_added)` when `total_lines_added > 0`, else `null` (distinguishing "no churn" from "no writing").

#### Scenario: Successful daily churn query
- **WHEN** an authenticated user GETs `/api/v1/metrics/churn?from=2026-05-01&to=2026-05-13&grain=daily`
- **THEN** the system responds with HTTP `200` and a JSON body
- **AND** the body includes `{ ratio: <number|null>, total_lines_added: <int>, total_lines_deleted: <int>, definition: "typing-heuristic", from: "...", to: "...", grain: "daily" }`
- **AND** the numbers reflect only the authenticated user's data

#### Scenario: Range with no activity
- **WHEN** the requested range contains no `text_change` events for the user
- **THEN** the response body has `ratio: null`, `total_lines_added: 0`, `total_lines_deleted: 0`

#### Scenario: User isolation
- **WHEN** user A and user B both have data in the same date range
- **THEN** user A's request returns only user A's totals
- **AND** user B's data is not visible

#### Scenario: Missing required parameters
- **WHEN** the request omits `from` or `to`
- **THEN** the system responds with HTTP `400` and a validation error

#### Scenario: Unauthenticated request
- **WHEN** the request has no `Authorization` header or an invalid token
- **THEN** the system responds with HTTP `401`

#### Scenario: Session-grain query returns per-session rows
- **WHEN** the request uses `grain=session`
- **THEN** the response body is `{ sessions: [{ session_id, ratio, total_lines_added, total_lines_deleted, ... }], definition: "typing-heuristic" }`
- **AND** only sessions overlapping the date range are included

### Requirement: Context-switching read endpoint

The system SHALL expose `GET /api/v1/metrics/context-switching`, JWT-protected, that returns the total number of editor switches for the authenticated user over a requested date range, along with a ranked list of most-visited file paths. The endpoint MUST accept `from`, `to`, `grain` (`daily` or `session`, default `daily`), and `top_n` (integer 1–20, default 10).

#### Scenario: Successful daily switch query
- **WHEN** an authenticated user GETs `/api/v1/metrics/context-switching?from=2026-05-01&to=2026-05-13&grain=daily&top_n=5`
- **THEN** the system responds with HTTP `200`
- **AND** the body includes `{ switch_count: <int>, rapid_switch_count: <int>, top_files: [{ path: "...", count: <int> }, ...], from: "...", to: "...", grain: "daily" }`
- **AND** `top_files` has at most `top_n` entries, sorted by `count` descending

#### Scenario: top_n above the stored cap
- **WHEN** the user requests `top_n=50`
- **THEN** the response is HTTP `400` (validation error) because top_n max is 20

#### Scenario: Range with no switches
- **WHEN** the requested range contains no `editor_switch` events for the user
- **THEN** the body has `switch_count: 0`, `rapid_switch_count: 0`, `top_files: []`

#### Scenario: Session-grain query
- **WHEN** the request uses `grain=session`
- **THEN** the response is `{ sessions: [{ session_id, switch_count, rapid_switch_count, top_files, ... }] }`

#### Scenario: User isolation
- **WHEN** user A and user B have switches in the same range
- **THEN** user A's request returns only user A's counts and only files user A visited

### Requirement: Response shape stability

Both metrics endpoints SHALL include a `definition` field naming the metric methodology (`"typing-heuristic"` for churn, `"editor-switch-count"` for context switching). Clients (including the future dashboard) MAY rely on this field being present.

#### Scenario: Definition field is always present
- **WHEN** any metrics endpoint returns a 200 response
- **THEN** the body contains a `definition` field with a string value
