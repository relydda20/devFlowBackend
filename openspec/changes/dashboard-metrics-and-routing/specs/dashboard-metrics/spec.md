## ADDED Requirements

### Requirement: Dashboard fetches real metrics on mount

The Dashboard page SHALL fetch its metric data from the backend on mount. It MUST NOT render hardcoded placeholder values in production. Each metric (`churn`, `context-switching`, today's daily metrics, and any chart) MUST fire its own independent request — a slow or failed call on one MUST NOT block another from rendering.

#### Scenario: Dashboard mounts and issues metric calls
- **WHEN** an authenticated user navigates to `/dashboard`
- **THEN** the page issues `GET /api/v1/metrics/churn?from=<7 days ago>&to=<today>&grain=daily` and `GET /api/v1/metrics/context-switching?from=<7 days ago>&to=<today>&grain=daily&top_n=5` in parallel
- **AND** the page also issues today-only versions of the same endpoints for the Daily Metrics card
- **AND** each request includes `credentials: 'include'`

#### Scenario: One metric fails, others succeed
- **WHEN** the churn call fails (network error or 5xx) but the context-switching call returns 200
- **THEN** the churn card shows an error state with a retry option
- **AND** the context-switching card renders its data normally

### Requirement: Each metric card distinguishes loading, error, and empty states

Each metric card SHALL render one of four states: `loading` (spinner or skeleton), `error` (message + retry), `empty` (no activity in this range), or `data` (the actual value). The empty state MUST be distinct from `0` — a user who wrote no code SHALL see "No activity in this range" rather than a misleading "0%".

#### Scenario: Loading state
- **WHEN** a metric request is in flight
- **THEN** the card renders a loading placeholder (spinner or skeleton)
- **AND** no value is shown

#### Scenario: Error state
- **WHEN** a metric request returns a non-401 error or a network failure
- **THEN** the card renders an inline error message
- **AND** a retry control is available

#### Scenario: Empty state for churn
- **WHEN** the churn endpoint returns `{ ratio: null, total_lines_added: 0, total_lines_deleted: 0 }`
- **THEN** the Code Churn card shows "—" as the value
- **AND** a caption reads "No activity in this range" (or equivalent)

#### Scenario: Empty state for context switching
- **WHEN** the context-switching endpoint returns `{ switch_count: 0, rapid_switch_count: 0, top_files: [] }`
- **THEN** the Context Switching card shows "0" with caption "No file switches in this range" (or equivalent)
- **AND** the top-files list is hidden

#### Scenario: Data state
- **WHEN** a metric request returns a 200 with non-empty data
- **THEN** the card renders the value
- **AND** no error or empty messaging is shown

### Requirement: 401 on a metrics call signs the user out

When any metric request returns HTTP `401 Unauthorized`, the Dashboard SHALL treat the session as invalid: it MUST call `auth.logout()` (which clears local state) and let `ProtectedRoute` redirect the user to `/login` on the next render.

#### Scenario: Session expires mid-page-view
- **WHEN** a metric request returns 401
- **THEN** the dashboard calls `auth.logout()`
- **AND** the user is redirected to `/login` by the existing `ProtectedRoute` guard
- **AND** no individual error message is shown for the metric — the redirect is the user signal

### Requirement: Dashboard refetches on tab return

The Dashboard SHALL refetch its metrics when the document becomes visible (`document.visibilityState === 'visible'` after being hidden). The refetch MUST be debounced so that two visibility-changes within 1 second only trigger one refetch. The Dashboard MUST NOT use a polling timer.

#### Scenario: User switches away and back
- **WHEN** the user navigates to another tab and back to the dashboard tab
- **THEN** all metric cards refetch
- **AND** loading states show during the refetch

#### Scenario: Rapid visibility-change debounce
- **WHEN** a `visibilitychange` event fires within 1 second of a previous fetch's start
- **THEN** the refetch is skipped
- **AND** the existing data continues to render

#### Scenario: No polling
- **WHEN** the dashboard is open and visible
- **THEN** no `setInterval` or `setTimeout`-driven refetch occurs
- **AND** the metric data updates only on mount and on tab return

### Requirement: Date range defaults to last 7 days

The Dashboard SHALL default to a 7-day window ending today (inclusive). The range MUST be computed at mount time. There is no user-facing date-range picker in this change.

#### Scenario: Range computed at mount
- **WHEN** the dashboard mounts on date `2026-05-13`
- **THEN** the `to` parameter on metric requests is `2026-05-13`
- **AND** the `from` parameter is `2026-05-07` (7 days inclusive)

#### Scenario: Daily Metrics card uses today-only range
- **WHEN** the Daily Metrics card mounts on date `2026-05-13`
- **THEN** its metric requests use `from=2026-05-13&to=2026-05-13`
