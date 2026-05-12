## Context

The dashboard at [Dashboard.tsx](../../../devFlowFrontend/src/pages/Dashboard.tsx) is a stub: three cards with hardcoded values (`+34%`, `8.4`, `72%`), a chart with hardcoded `vitalityData`, and an AI insights card with hardcoded copy. None of it touches the backend.

Meanwhile the backend ships two metrics endpoints (built in `add-metrics-etl-pipeline`):

- `GET /api/v1/metrics/churn?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=daily|session` → `{ ratio: number|null, total_lines_added, total_lines_deleted, definition, from, to, grain }`.
- `GET /api/v1/metrics/context-switching?from=YYYY-MM-DD&to=YYYY-MM-DD&grain=daily|session&top_n=N` → `{ switch_count, rapid_switch_count, top_files: [...], definition, from, to, grain }`.

Both are JWT-protected and accept the session cookie via the existing `verifyJwt` middleware. The frontend already has cookie-based auth working end-to-end (the `integrate-frontend-auth` change).

On the navigation side: [App.tsx](../../../devFlowFrontend/src/App.tsx) routes `/` to `Landing` with no guard. [Navbar.tsx:63](../../../devFlowFrontend/src/components/layout/Navbar.tsx#L63) always renders `<Link to="/">` around the logo. The two are independent — fixing one without the other leaves a hole (typed URL still works, or the logo still escapes).

## Goals / Non-Goals

**Goals:**
- A signed-in user never lands on the marketing page. The dashboard is their home.
- The dashboard's three top cards show real, user-specific numbers within a single request round-trip after page load.
- Each metric card renders independently: a slow or failed call on one does not gate the others.
- Network failures and "no data yet" both produce a clear, non-spooky state in each card.

**Non-Goals:**
- A date-range picker. Hard-coded last-7-days for v1; we add the picker when there's a concrete reason.
- Caching, deduplication, refetch-on-focus retries — i.e., a data layer. Native `fetch` + `useEffect` is enough for the current surface.
- AI insights / suggestions. The "AI Insights" placeholder is removed.
- The Workflow Vitality area chart's full overhaul — it either becomes a real chart based on real data, or it gets removed. We don't keep fake `vitalityData` around.
- Per-session ("show me last Friday's deep work block") views. The endpoints support `grain=session` already; surfacing that is a future change.
- Mobile-specific dashboard adjustments beyond what the existing Tailwind grid already gives us.

## Decisions

### Route guard for `/` rather than client-side conditional component

We wrap the Landing route in a small guard component (e.g., `LandingRoute`) that checks `useAuth()` and `<Navigate to="/dashboard" replace />` when authenticated, just like `ProtectedRoute` does in reverse. Reusing `PublicRoute` is tempting but wrong: `PublicRoute` is for pages that shouldn't be reachable when signed in *and* don't have meaningful content for signed-in users (login, register). Landing's case is similar but worth its own component so the redirect rules are explicit per route — if we later decide signed-in users *should* see the landing (e.g., to read the homepage marketing), we change one place.

**Alternative considered:** Add a top-level `useEffect` in `Landing` itself that navigates away. Rejected — it renders the landing for a frame before redirecting, which is the classic visual flash we just fixed for `ProtectedRoute`. Route-level guard avoids the mount.

### Navbar logo's `to` is computed, not removed

When `isAuthenticated`, the logo points to `/dashboard`. When signed out, it points to `/`. We keep the link so the logo remains a clickable affordance (users expect "click logo → home of app"). Removing the link makes the navbar feel broken on the dashboard.

**Alternative considered:** Render the logo as a plain `<img>` (no link) when signed in. Rejected: it changes the navbar's behavior in a way users might find surprising ("why doesn't this click anywhere?"). If the user really wants "no escape," the route guard already prevents the landing visit; the logo just doesn't help them get there.

### Per-card fetch, not a single "fetch all metrics" call

Each dashboard card owns its data: it fires its own request, manages its own `isLoading`/`error`/`data` state. The `useMetrics` hook is a thin wrapper around `fetch` + `useEffect` + `useState`, parametrized by `(endpoint, queryParams)`.

**Why:** the alternative — a single parent component that fetches both metrics and passes them down — couples the cards' rendering to the slowest call. With independent fetches, the churn card renders the moment its call resolves, even if context-switching is still pending. Smaller change, simpler state, no Promise.all dance.

**Alternative considered:** A single `useDashboardMetrics()` hook that does `Promise.all` and returns `{ churn, contextSwitching, isLoading, error }`. Rejected for the coupling above. Reasonable for v2 if we add 5+ metrics that all live in the same database query.

### Refetch on `visibilitychange`, not on a timer

When the document becomes visible (`document.visibilityState === 'visible'`), the hook refetches. No `setInterval`.

**Why:** the user's mental model of a dashboard is "I check it, do work, come back later, check again." A polling timer makes the page chew bandwidth and CPU when no one is looking. Visibility-based refresh hits exactly the moments the user cares about the freshness. The ETL itself runs every 5 minutes server-side, so the data can't be more than 5 minutes stale anyway — polling at a faster rate produces no extra value.

**Alternative considered:** SWR or TanStack Query with focus-based refetch. Same behavior, an extra 4-12KB dependency. Not worth the cost for two endpoints.

### Date range is computed in the browser's local timezone

The dashboard computes `to = new Date().toISOString().slice(0, 10)` (today, UTC date) and `from = <7 days ago in the same way>`. Note: this uses **UTC date**, not local date. The trade-off:

- Using UTC: a user in Sydney looking at their dashboard at 8 AM local Sunday sees "last 7 days" ending Saturday UTC, which is correct enough for a productivity tool that's not minute-accurate.
- Using local timezone via `toLocaleDateString` or similar: matches the user's perception of "today" exactly, but introduces timezone-shift bugs at midnight boundaries (cards re-rendering across midnight, etc.).

UTC is the simpler choice and the off-by-a-day edge case at midnight is minor. We document it as a known limitation. If users complain about Sunday-morning dashboards looking off, we revisit.

### "No data" and "no writing" are distinct states

The churn endpoint returns `ratio: null` when `total_lines_added === 0`. The context-switching endpoint returns `switch_count: 0` when there are no switches. The dashboard distinguishes:

- **Loading** → spinner / skeleton
- **Error** → "Couldn't load this metric" with a small retry button
- **No data** (the calls succeeded but there's nothing) → "—" with a caption like "No activity in this range" rather than a misleading "0%" that looks like a result

Showing `0%` for churn when the user wrote nothing is technically true but conveys the wrong story ("zero churn = great!" when actually it's "no writing happened"). The "—" + caption pattern is the honest version.

### "Daily metrics" card replaces "Agentic Logs"

The third placeholder card ("Agentic Logs / Copilot efficiency 72%") had no backing data and no plausible source. We replace it with a Daily Metrics card showing **today's** numbers (today's switch count, today's lines added/deleted). This gives the user a "what did I do today" view alongside the "what did I do this week" view in the other two cards.

The card calls `/metrics/context-switching?from=<today>&to=<today>` and `/metrics/churn?from=<today>&to=<today>` — two more requests. With per-card fetches this is automatic.

### The Workflow Vitality chart is rebuilt or removed

The existing area chart uses `vitalityData` which is hardcoded fake data. We have two options at implementation time:

- **Rebuild:** call `/metrics/context-switching?grain=daily&from=<7 days ago>&to=<today>` once and plot `switch_count` per day. Recharts already imported.
- **Remove:** drop the chart entirely in this change; revisit when we have a clearer story for what "workflow vitality" should mean.

I'd lean toward **rebuild** because we have real per-day data via the daily grain. The endpoint currently returns aggregate totals for the range, not per-day buckets, so we'd either (a) loop 7 calls (one per day, in parallel) or (b) extend the endpoint to optionally return a per-day breakdown. Option (a) is acceptable for v1 and contains the scope; option (b) is a backend change we don't need yet.

If the implementation step finds that 7 parallel calls feel heavy in the dev experience, the fallback is to **remove the chart in this change** and ticket "add per-day metrics endpoint" separately. Both are fine outcomes. The task list reflects "rebuild OR remove — pick during implementation."

## Risks / Trade-offs

- **[Risk] The refetch-on-visibility logic doubles up with refresh-on-mount on tab restore in some browsers** → Mitigation: the hook tracks the last fetch timestamp and skips a refetch if the previous one resolved less than 1 second ago. Trivial debounce, prevents the "two requests fire on tab return" wart.
- **[Risk] A user with zero events ever sees a sad-looking dashboard at first login** → Mitigation: each card has a clear "No activity in this range" message that explains *why*, not just shows `0`/`—`. Empty state is the new-user state and deserves intentional copy.
- **[Risk] If `/auth/me` returns 401 *during* a metrics call (e.g., session expired mid-page-view), the metrics call also returns 401 and the card shows "Couldn't load this metric"** → Could be confusing — the user is silently logged out but doesn't know. Mitigation: the `useMetrics` hook detects 401 specifically and calls `auth.logout()` to clear state and route to /login (which the auth context already redirects from `ProtectedRoute`). A 401 on a metric == "your session died." Subtle but correct.
- **[Trade-off] Three to seven HTTP requests per page load** → Acceptable. Each is small, all are credentialed cookie requests handled by the same backend, all parallelized. The dashboard is a low-traffic page (one user, occasional refresh) and the visibility-based refetch keeps the steady-state request rate near zero.
- **[Trade-off] Removing "AI Insights" makes the dashboard look smaller until we build a real insights feature** → Acceptable. A small honest dashboard is better than a big dashboard full of lies.
- **[Risk] Logo-click destination depends on auth state at render time; if the auth context is still `isLoading`, the link briefly points to `/` and then updates to `/dashboard`** → Mitigation: while `isLoading`, the logo doesn't render as a link at all (it renders as a plain `<img>` for a moment, then becomes a link once auth settles). Tiny visual hitch, prevents a misclick during the load.
