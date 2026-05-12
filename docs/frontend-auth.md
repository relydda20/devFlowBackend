# Frontend Auth Integration

How the React frontend at `devFlowFrontend/` authenticates against this backend.

## Shape

- Backend issues a JWT, sets it as the `session` cookie (`HttpOnly`), AND returns it in the response body.
- Frontend ignores the body token. It uses `credentials: 'include'` on every fetch and lets the browser carry the cookie.
- `AuthProvider` on the React side calls `GET /api/v1/auth/me` once on mount to derive the current user. Route guards block on the `isLoading` state to avoid the classic `/login` flash on reload.
- Logout calls `POST /api/v1/auth/logout` which clears the cookie. The local UI transitions to logged-out unconditionally — the cookie clearing is best-effort.

## Required environment variables

### Frontend (build time — Vite inlines these)

| Variable | Example | Notes |
| --- | --- | --- |
| `VITE_API_URL` | `https://api.who-goes-to-try.hackathon.sev-2.com` | Absolute URL to the backend, no trailing slash. If unset, falls back to `http://localhost:3000` and emits a `console.warn` when the page is loaded on a non-localhost host. **CI must inject this before `npm run build`** — Vite inlines it at build time. |

### Backend (runtime)

| Variable | Example | Notes |
| --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | `https://who-goes-to-try.hackathon.sev-2.com,http://localhost:5173` | Comma-separated browser origins allowed to make credentialed requests. Exact match, no wildcards. Empty/unset disables browser cross-origin entirely (requests with no `Origin` header still work — covers the VS Code extension, curl, and server-to-server). |
| `NODE_ENV` | `production` | When `production`, the `session` cookie is set with `SameSite=None; Secure; HttpOnly`. Anything else uses `SameSite=Lax; HttpOnly` (for localhost dev). |

## Cookie attributes — and why they matter for cross-origin

In production the frontend and backend live on different origins. Browsers only send cookies on cross-site requests if `SameSite=None; Secure`. `Secure` requires HTTPS. So:

- The backend must be served over HTTPS (it already is in cluster).
- The Set-Cookie header includes `SameSite=None; Secure; HttpOnly`.
- The frontend always passes `credentials: 'include'`.
- The CORS response sends `Access-Control-Allow-Credentials: true` and mirrors the allow-listed origin in `Access-Control-Allow-Origin` (no `*`).

If any one of these is misconfigured, the symptom is the same: the cookie is set in the browser but never sent on subsequent requests, so `/auth/me` returns 401 forever.

## CSRF posture

We rely on the CORS allowlist plus `SameSite=None; Secure` over HTTPS as the defense. There is no CSRF token.

This is fine for the current endpoint surface (auth, telemetry, metrics reads) because:
- Only browser origins in `CORS_ALLOWED_ORIGINS` can make credentialed requests at all — a malicious origin's fetch is rejected by the browser.
- `Secure` ensures cookies never travel over plaintext.
- All state-changing endpoints check `req.user.id` against the resource owner, so even a same-origin XSS would be constrained to the user's own data.

If a future endpoint widens the threat model (e.g., payments, admin actions visible to other users), add a per-request CSRF token at that point.

## Operational checklist for the infra team

1. Set `NODE_ENV=production` on the backend pod.
2. Set `CORS_ALLOWED_ORIGINS` on the backend pod to the comma-separated list of frontend origins that should be allowed (production, staging if applicable, preview deploys if applicable).
3. Set `VITE_API_URL` in the **build env** for the frontend pod's Docker image (e.g., in the CI step before `npm run build`).
4. Ensure both backend and frontend are served over HTTPS — `Secure` cookies won't be sent over HTTP.

A misconfigured `CORS_ALLOWED_ORIGINS` produces opaque `CORS error` failures in the browser. Add a smoke test that hits `GET /api/v1/auth/me` from the deployed frontend origin to catch this in CI.

## Dashboard

The `/dashboard` page reads from the metrics endpoints described in [metrics.md](metrics.md). Each card fetches independently — a slow `churn` call doesn't block `context-switching` from rendering.

**Default range:** last 7 days, inclusive of today. Computed at mount in UTC. There's no date-range picker yet.

**Refetch behavior:** mount + `visibilitychange` (when the tab returns to the foreground). A 1-second debounce skips redundant refetches when the visibility flips rapidly. **No polling timer** — the ETL is server-side, refreshes every ~5 minutes, and the dashboard's job is to ask for the latest only when the user is actually looking.

**Card states.** Each metric card renders one of four states:
- `loading` — skeleton placeholder
- `error` — message + a retry button
- `empty` — distinct from `0`. Shows "—" with a caption like "No activity in this range" so a no-writing day doesn't look like a 0%-churn win
- `data` — the real value

**401 handling.** If any metric call returns 401 (session died mid-page-view), the `useMetric` hook calls `auth.logout()` immediately. `ProtectedRoute` then redirects to `/login`. No misleading per-card error is shown.

**Routing.** Signed-in users are redirected away from `/` to `/dashboard`. The navbar logo points to `/dashboard` when signed in and `/` when signed out. While auth state is loading, the logo renders as a non-link image to prevent a misclick during the load.

## Known limitations

- A 7-day JWT can outlive a logout because we don't blocklist tokens. Without the cookie, the JWT isn't presented; but a copy held elsewhere remains valid until expiry. Acceptable for the current threat model.
- Cross-site cookies are blocked by some privacy-strict browser modes (e.g., Safari with "Prevent Cross-Site Tracking"). Affected users won't stay logged in. An SSO-style same-origin reverse proxy is the long-term fix if this becomes important.
- The `AuthProvider` always issues one `/auth/me` on mount, even for first-time visitors. One round-trip per page load — acceptable.
