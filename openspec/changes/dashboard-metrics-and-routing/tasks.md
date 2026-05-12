## Notes on implementation deltas

- **AI Insights card kept (per user request mid-implementation).** The original plan removed it; the user wants it for the dashboard and future extension surface. Instead of removal, the card is **marked as a "Preview" badge** and the buttons are disabled, so it's obviously a placeholder, not a misleading data-driven claim. Task 10 was rewritten accordingly.
- **Workflow Vitality chart: removed, not rebuilt.** The original task offered "rebuild OR remove" — I chose remove. A real per-day chart requires either 7 parallel API calls (heavy for v1) or a new backend endpoint (out of scope). The chart is replaced by a 4-stat "Activity overview" card that shows the same week-range data in a clearer numerical layout. Recharts is no longer imported — production bundle dropped ~300KB as a side effect.
- **`useMetric` hook signature**: the caller MUST pass a stable `fetcher` (via `useCallback`). Documented inline. Dashboard wraps its 4 fetchers in `useCallback` for this reason.
- **`react-hooks/set-state-in-effect`** required one targeted eslint-disable on the `setLoading(true)` call inside the fetch effect — the bootstrap pattern is correct here, the rule is overly conservative.
- **Bundle size win.** The build artifact dropped from ~690KB to ~395KB after removing the unused Recharts import. Unintended cleanup.

## 1. Routing: guard the Landing route

- [x] 1.1 [src/components/auth/LandingRoute.tsx](../../../devFlowFrontend/src/components/auth/LandingRoute.tsx) created — same shape as `PublicRoute`, redirects authenticated users to `/dashboard` while loading shows `<AuthLoading />`
- [x] 1.2 [App.tsx](../../../devFlowFrontend/src/App.tsx) wraps the `/` route in `<LandingRoute>`

## 2. Navbar: logo destination depends on auth

- [x] 2.1 [Navbar.tsx](../../../devFlowFrontend/src/components/layout/Navbar.tsx): `logoTarget = isAuthenticated ? '/dashboard' : '/'`
- [x] 2.2 While `isLoading`, the logo renders as a plain `<span>` wrapper around `<img>` (no `<Link>`), avoiding misclicks during load
- [x] 2.3 No other navbar changes

## 3. Frontend: metrics API client

- [x] 3.1 [src/lib/metrics.ts](../../../devFlowFrontend/src/lib/metrics.ts) exports `getChurn` and `getContextSwitching`
- [x] 3.2 `ChurnResponse`, `ContextSwitchingResponse`, `TopFile`, `Grain` types exported
- [x] 3.3 401 propagates as `ApiError(401, ...)` for the hook to detect

## 4. Frontend: useMetric hook

- [x] 4.1 [src/lib/useMetric.ts](../../../devFlowFrontend/src/lib/useMetric.ts) returns `{ data, isLoading, error, refetch }`
- [x] 4.2 Fires on mount via `useEffect` keyed on `trigger` state
- [x] 4.3 Subscribes to `document.visibilitychange`; bumps trigger when visible AND >1s since last fetch start
- [x] 4.4 On 401, calls `auth.logout()` and skips setting an error
- [x] 4.5 Other errors stored in state
- [x] 4.6 Listener cleaned up on unmount via the effect's return

## 5. Dashboard: date range computation

- [x] 5.1 `computeRange()` returns `{ weekFrom, weekTo, todayFrom, todayTo }` in UTC `YYYY-MM-DD` format
- [x] 5.2 Range computed via `useState(() => computeRange())` so it doesn't churn across renders

## 6. Dashboard: Code Churn card

- [x] 6.1 Hardcoded `+34%` replaced with `useMetric(fetchWeekChurn)` value
- [x] 6.2 Four states: loading skeleton / error+retry / empty (`ratio === null` → "—" + caption) / data (`Math.round(ratio * 100)%`)
- [x] 6.3 Footer caption shows `total_lines_added` and `total_lines_deleted`
- [x] 6.4 Badge: orange "High instability detected" when `ratio > 0.5`, green "Stable rewrite rate" otherwise. Threshold documented inline as a `HIGH_CHURN_RATIO` constant.

## 7. Dashboard: Context Switching card

- [x] 7.1 Hardcoded `8.4` replaced with `switch_count` from `useMetric(fetchWeekSwitching)`
- [x] 7.2 Four states: loading / error / empty / data (`<n> switches / 7d`)
- [x] 7.3 Top-N file list rendered below the count (up to 5)
- [x] 7.4 Tri-color badge based on `switch_count / 7` against `LOW_SWITCH_PER_DAY` and `HIGH_SWITCH_PER_DAY` constants. Documented inline.

## 8. Dashboard: Daily Metrics card (replaces Agentic Logs)

- [x] 8.1 "Agentic Logs / Copilot efficiency 72%" card removed (Bot icon retained — used for the new Today card)
- [x] 8.2 "Today" card shows today's `switch_count` plus today's `lines_added`/`lines_deleted` via two parallel `useMetric` calls
- [x] 8.3 Empty state when both today's calls return zeros: "No activity today yet."

## 9. Dashboard: Workflow Vitality chart — removed (option 9.2 from the original plan)

- [x] 9.1 Did NOT attempt the 7-parallel-call rebuild
- [x] 9.2 Chart removed entirely. Replaced with an "Activity overview" 4-stat card (switches, rapid switches, lines written, lines deleted) derived from existing week-range calls.
- [x] 9.3 `vitalityData` constant and all Recharts imports removed. Bundle shrank ~300KB.

## 10. Dashboard: AI Insights card — KEPT and marked Preview

- [x] 10.1 Card retained per user request mid-implementation
- [x] 10.2 Title gets a "Preview" badge. Copy rewritten to "Example insight (placeholder)" + "When wired up, this card will surface AI suggestions..." so it's honest about being a stub.
- [x] 10.3 "View Activity" and "Take a Break" buttons retained but `disabled` until the AI flow is real.

## 11. Frontend: lint + build

- [x] 11.1 `npm run lint` — clean
- [x] 11.2 `npm run build` — clean. Bundle: 395KB JS gzip 123KB (down from ~690KB / ~212KB).

## 12. Manual verification

- [ ] 12.1 With backend + frontend running locally, sign in and land on `/dashboard`; confirm the three top cards show real values
- [ ] 12.2 Click the navbar logo while signed in — confirm navigation to `/dashboard`, not `/`
- [ ] 12.3 Type `/` in the address bar while signed in — confirm immediate redirect to `/dashboard` with no Landing flash
- [ ] 12.4 Sign out, navigate to `/` — confirm Landing page renders as before
- [ ] 12.5 Switch tabs, come back — confirm cards refetch (brief loading state visible)
- [ ] 12.6 Stop the backend, reload dashboard — confirm error state + retry on each card
- [ ] 12.7 With backend running but zero telemetry in the last 7 days — confirm "No activity in this range" empty state
- [ ] 12.8 Force a 401 (clear the session cookie in devtools) and trigger a refetch — confirm sign-out + redirect to /login

## 13. Documentation

- [x] 13.1 Dashboard section added to [docs/frontend-auth.md](../../../docs/frontend-auth.md) describing card states, default range, refetch behavior, 401 handling, and routing
