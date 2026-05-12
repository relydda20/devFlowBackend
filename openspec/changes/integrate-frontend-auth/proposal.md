## Why

The frontend at `https://who-goes-to-try.hackathon.sev-2.com/` currently has Login and Register pages whose `onSubmit` handlers write the email string to `localStorage` and redirect to `/dashboard` ([devFlowFrontend/src/pages/Login.tsx](../../../devFlowFrontend/src/pages/Login.tsx), [devFlowFrontend/src/pages/Register.tsx](../../../devFlowFrontend/src/pages/Register.tsx)). No HTTP request is made; no password is validated; anyone who types any email is "logged in." Route guards check for the same localStorage key, so the protection is purely cosmetic.

Meanwhile the backend already serves real `POST /api/v1/auth/register` and `POST /api/v1/auth/login` endpoints that return a JWT and set an httpOnly `session` cookie. The two halves have never been wired together.

Both run in the same Kubernetes cluster, so connecting them is a configuration + small-code-change exercise, not a deployment build-out: we need the frontend to actually call the backend, the backend to accept cross-origin requests with credentials from the frontend's origin, and the frontend's auth state to be derived from a real backend session rather than a string in localStorage.

## What Changes

**Frontend**
- Add an API client module that reads `VITE_API_URL` (defaults to `http://localhost:3000` in dev) and exposes typed `login`, `register`, `me`, and `logout` functions, each using `fetch` with `credentials: 'include'`.
- Replace the localStorage email hack in [Login.tsx](../../../devFlowFrontend/src/pages/Login.tsx) and [Register.tsx](../../../devFlowFrontend/src/pages/Register.tsx) with real calls to the API. On success, navigate to `/dashboard`; on failure, surface a clear error inline.
- Introduce an `AuthProvider` React context that:
  - On mount, calls `GET /api/v1/auth/me` to resolve current auth state.
  - Exposes `{ user, isAuthenticated, isLoading, login, register, logout, refresh }`.
  - Replaces the localStorage check in `ProtectedRoute` and `PublicRoute`. Both guards now read from context and render a small loading state while `me` is pending.
- Add a `Logout` action (in the navbar or dashboard — wherever an authenticated user lands) that calls `POST /api/v1/auth/logout` and refreshes auth state.
- Stop reading and writing `localStorage.devflow_user` everywhere. Delete the key during this change and add a note that nothing depends on it.

**Backend**
- Add a CORS allowlist driven by `CORS_ALLOWED_ORIGINS` (comma-separated). The current `cors()` call in [src/server.js](src/server.js) allows everything with no credentials, which is wrong both ways: too permissive (any origin) and too restrictive (no credentials, so cookies don't flow).
- Configure CORS with `origin: <allowlist function>`, `credentials: true`, and the necessary `methods` / `allowedHeaders`. Origins not in the allowlist get the default deny behavior.
- Set `SameSite=None; Secure` on the `session` cookie when in production (`NODE_ENV=production`), because the cookie must travel cross-site (frontend origin → backend origin). Keep `Lax` in development for the localhost flow.
- Add `Access-Control-Allow-Credentials: true` (covered by `credentials: true` on the `cors` middleware).

**Cluster / deploy**
- No new manifests or charts. Cluster wiring is documented as env vars the infra team sets:
  - Frontend pod: `VITE_API_URL=https://<backend-host>` (baked in at build time via Vite, so the build step needs the var present).
  - Backend pod: `CORS_ALLOWED_ORIGINS=https://who-goes-to-try.hackathon.sev-2.com` (and a dev/staging origin if applicable), `NODE_ENV=production`.
- Document the cookie's `SameSite=None; Secure` requirement so the infra team knows the backend must be served over HTTPS for cookies to flow (which it already is — flagged for completeness).

## Capabilities

### New Capabilities
- `frontend-auth`: How the React app authenticates a user, persists session state, gates routes, and surfaces login/logout. Covers the API client, the `AuthProvider` context, the form integration, the guards, and error handling.

### Modified Capabilities
- `password-auth`: The backend already implements password registration and login as a capability. This change adds two requirements: (1) cross-origin requests with credentials are accepted when the origin is in `CORS_ALLOWED_ORIGINS`, and (2) the `session` cookie uses `SameSite=None; Secure` in production.

## Impact

- **Frontend code**: new [devFlowFrontend/src/lib/api.ts](../../../devFlowFrontend/src/lib/api.ts), new [devFlowFrontend/src/lib/auth.tsx](../../../devFlowFrontend/src/lib/auth.tsx) (AuthProvider), changes to [Login.tsx](../../../devFlowFrontend/src/pages/Login.tsx), [Register.tsx](../../../devFlowFrontend/src/pages/Register.tsx), [App.tsx](../../../devFlowFrontend/src/App.tsx) (wrap with provider), [ProtectedRoute.tsx](../../../devFlowFrontend/src/components/auth/ProtectedRoute.tsx), [PublicRoute.tsx](../../../devFlowFrontend/src/components/auth/PublicRoute.tsx), and the navbar to surface logout.
- **Backend code**: [src/server.js](src/server.js) (replace `cors()` with the allowlist), [src/controllers/password-auth.controller.js](src/controllers/password-auth.controller.js) and [src/controllers/auth.controller.js](src/controllers/auth.controller.js) (cookie attributes — there are two places that call `res.cookie('session', ...)`).
- **Env vars**: `CORS_ALLOWED_ORIGINS` (backend), `VITE_API_URL` (frontend build).
- **No new dependencies.** The frontend already has `react-router-dom`; we use native `fetch` rather than adding axios.
- **No database changes, no new endpoints.** Pure plumbing.
- **Backwards-compatible** with the extension: the extension's `dvf_` API token path is untouched. JWT/cookie auth path adds CORS + cookie attribute changes only.
- **Out of scope** (deferred): OAuth flows (Google/GitHub) on the frontend, "Remember me" toggles, password reset, email verification, rate limiting on auth endpoints, a logout-everywhere feature.
