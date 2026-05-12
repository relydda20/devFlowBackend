## Why

Two related gaps in the user experience after sign-in:

1. **Logged-in users can navigate back to the marketing landing page.** The navbar logo at [devFlowFrontend/src/components/layout/Navbar.tsx](../../../devFlowFrontend/src/components/layout/Navbar.tsx) always links to `/`, and `/` always renders the `Landing` page. A signed-in user clicking the logo lands on a marketing page that talks about the product they're already using. The fix is small but needs to be in two places (the logo's `to=` AND the route guard) because a user could also type `/` in the address bar.

2. **The dashboard shows hardcoded placeholder values for code churn and context switching.** [Dashboard.tsx](../../../devFlowFrontend/src/pages/Dashboard.tsx) hardcodes `+34%` for churn and `8.4` for switching. We just built the read endpoints (`GET /api/v1/metrics/churn`, `GET /api/v1/metrics/context-switching`) in the `add-metrics-etl-pipeline` change — the dashboard should actually call them.

Together these are a small "first useful dashboard" pass: the right landing for signed-in users (the dashboard) and the right content on it (their actual numbers).

## What Changes

**Routing / navigation**
- Guard the `/` Landing route: when `isAuthenticated`, redirect to `/dashboard`. Implemented as a new `LandingRoute` wrapper component or by reusing the existing `PublicRoute` pattern.
- In the navbar logo: when `isAuthenticated`, the logo points to `/dashboard` instead of `/`. When signed out, behavior is unchanged (logo → landing).
- No change to `/docs`, `/privacy-policy`, `/terms-of-service`, `/login`, `/register`. Those remain accessible to logged-in users in case they need legal docs or want to re-read the documentation. The Login/Register pages are already `PublicRoute`-guarded and continue to redirect signed-in users to `/dashboard`.

**Dashboard data**
- Add a small data layer alongside the existing API client at [devFlowFrontend/src/lib/api.ts](../../../devFlowFrontend/src/lib/api.ts): functions `getChurn` and `getContextSwitching` that hit the existing backend endpoints with `credentials: 'include'`.
- Add a `useMetrics` custom hook that takes the date range and returns `{ data, isLoading, error, refetch }` for each metric. Loading and error states are component-level.
- Replace the three placeholder cards in [Dashboard.tsx](../../../devFlowFrontend/src/pages/Dashboard.tsx):
  - **Code Churn** — pulls `ratio` from `/metrics/churn?grain=daily&from=<7 days ago>&to=<today>`. Displays as a percentage (`Math.round(ratio * 100)%`). Falls back to "—" when `ratio` is `null` (no writing in the window).
  - **Context Switching** — pulls `switch_count` from `/metrics/context-switching?grain=daily&from=<7 days ago>&to=<today>&top_n=5`. Displays the total count and the unit `switches/7d`. The card's tooltip / expandable surface shows the `top_files` list.
  - **Daily Metrics card (new third card, replacing "Agentic Logs")** — shows today's `switch_count`, today's `lines_added`/`lines_deleted`, and the day-of-week breakdown for the last 7 days as a small inline chart or sparkline. Same endpoints, different date range.
- The "Workflow Vitality" chart (the placeholder area chart with fake `vitalityData`) stays but is relabeled "Daily activity (last 7 days)" and plots `editor_switch_count + lines_added + lines_deleted` per day from a 7-day range. If that's not buildable cleanly in this scope, the chart is removed rather than left fake.
- The "AI Insights" card and its hardcoded copy are removed in this change. We don't have AI suggestions wired up yet, and the placeholder copy ("High code churn detected") is misleading when it's not actually derived from the user's data.

**Defaults and refresh**
- Default range: last 7 days, computed at mount in the user's local timezone. End of range is today (inclusive).
- The dashboard refetches on mount and on window focus (via `visibilitychange`) — no polling timer. Users typically check the dashboard, switch tabs to work, and come back; the focus-based refresh hits the right cadence without timers.
- Each metric is independent: a slow or failed `churn` call does not block `context-switching` rendering.

## Capabilities

### New Capabilities
<!-- None. We're extending an existing capability. -->

### Modified Capabilities
- `frontend-auth`: Add a requirement that the `/` Landing route is gated for unauthenticated users — signed-in users SHALL be redirected to `/dashboard`. The navbar logo SHALL point to `/dashboard` when signed in. (The capability already covers route guards for `/login`, `/register`, `/dashboard`; this extends the same pattern to the landing route.)

## Impact

- **Frontend**: [Dashboard.tsx](../../../devFlowFrontend/src/pages/Dashboard.tsx) (major rewrite of the three top cards + decision on the chart), [App.tsx](../../../devFlowFrontend/src/App.tsx) (wrap `Landing` in a guard), [Navbar.tsx](../../../devFlowFrontend/src/components/layout/Navbar.tsx) (logo target depends on auth state), new [src/lib/metrics.ts](../../../devFlowFrontend/src/lib/metrics.ts) (typed API calls), new [src/lib/useMetrics.ts](../../../devFlowFrontend/src/lib/useMetrics.ts) (hook).
- **Backend**: No changes. The endpoints exist and return what we need.
- **Database**: No changes.
- **Out of scope**: AI insights / suggestions, real-time push of new metrics, comparison to previous periods (today vs last 7 days), date-range picker UI, per-file drill-down beyond the top-N list, mobile-specific dashboard layouts.
- **Backwards-compatible** with the extension: no API contract changes.
