## Notes on implementation deltas

- **Fast-refresh ESLint rule forced a small file split.** `useAuth` lives in [src/lib/auth-context.ts](../../../devFlowFrontend/src/lib/auth-context.ts) and `AuthProvider` lives in [src/lib/auth.tsx](../../../devFlowFrontend/src/lib/auth.tsx). All consumers import `useAuth` from `@/lib/auth-context` and `AuthProvider` from `@/lib/auth`. Spec talked about a single `auth.tsx`; the split is mechanical and the public API is the same.
- **The Navbar already had a working logout dropdown** keyed on `localStorage.devflow_user`. The change is purely a data-source swap to `useAuth()`. No new UI was added.
- **The OAuth callback cookie** ([src/controllers/auth.controller.js](src/controllers/auth.controller.js)) was updated to use the same environment-dependent `SameSite`/`Secure` attributes as the password flow — both flows share the cookie shape.
- **The logout handler's cookie-deletion attributes** ([src/controllers/auth.controller.js](src/controllers/auth.controller.js#L86)) were updated to match the set attributes. Without this, browsers silently keep the old cookie.
- One-time `localStorage.removeItem('devflow_user')` calls were left in Login + Register pages to clean up the leftover key from the previous mocked auth. These can be removed in a follow-up after the deploy has been live long enough that no user still has the stale key.
- **The `console.warn` calls do NOT need `eslint-disable-next-line`** in this repo's eslint config. The unused-directive warnings made that clear; removed.

## 1. Backend: CORS allowlist + cookie attributes

- [x] 1.1 [src/server.js](src/server.js) replaced `app.use(cors())` with an explicit allowlist config: `origin` function reads `CORS_ALLOWED_ORIGINS` per-request, allows requests with no `Origin` header, `credentials: true`
- [x] 1.2 [src/controllers/password-auth.controller.js](src/controllers/password-auth.controller.js) `setSessionCookie` uses `sameSite: isProd ? 'none' : 'lax'`
- [x] 1.3 [src/controllers/auth.controller.js](src/controllers/auth.controller.js) OAuth callback's `res.cookie('session', ...)` updated to the same pattern
- [x] 1.4 [src/controllers/auth.controller.js](src/controllers/auth.controller.js) `logout()` cookie-deletion attributes now match the set attributes
- [x] 1.5 Inline comments added at each cookie call site

## 2. Backend: env documentation

- [x] 2.1 `CORS_ALLOWED_ORIGINS` documented in [docs/frontend-auth.md](../../../docs/frontend-auth.md) (new file dedicated to the integration; the env table is there)
- [x] 2.2 [.env.example](.env.example) updated with `CORS_ALLOWED_ORIGINS` showing both a localhost dev origin and the production frontend URL

## 3. Frontend: API client

- [x] 3.1 [src/lib/api.ts](../../../devFlowFrontend/src/lib/api.ts) created exporting `login`, `register`, `me`, `logout`
- [x] 3.2 `API_BASE_URL` derived from `import.meta.env.VITE_API_URL` with localhost fallback + production warning via `console.warn` when hostname isn't localhost
- [x] 3.3 `User` and `AuthProvider` types exported, matching the backend's `AuthResponse`
- [x] 3.4 `request()` helper throws typed `ApiError` with `{ status, message }` for non-2xx; network failures throw `ApiError(0, ...)` with a connection-error message
- [x] 3.5 `me()` returns `null` on 401 (not an error); other failures propagate

## 4. Frontend: AuthProvider context

- [x] 4.1 [src/lib/auth.tsx](../../../devFlowFrontend/src/lib/auth.tsx) (provider) and [src/lib/auth-context.ts](../../../devFlowFrontend/src/lib/auth-context.ts) (context + `useAuth` hook) — split to satisfy `react-refresh/only-export-components`
- [x] 4.2 `AuthProvider` calls `me()` on mount via `useEffect`; sets `isLoading: false` in `finally`
- [x] 4.3 `login`/`register` call the API and then `refresh()`; throw `ApiError` for the form to catch
- [x] 4.4 `logout()` always clears local state, even if the server call fails
- [x] 4.5 `useAuth()` throws if used outside the provider
- [x] 4.6 [src/App.tsx](../../../devFlowFrontend/src/App.tsx) wraps the routed app in `<AuthProvider>`

## 5. Frontend: Form integration

- [x] 5.1 [Login.tsx](../../../devFlowFrontend/src/pages/Login.tsx) calls `auth.login(email, password)`, shows inline `ApiError.message` on failure, clears password on error, disables submit while pending
- [x] 5.2 [Register.tsx](../../../devFlowFrontend/src/pages/Register.tsx) same shape with `auth.register(email, password)`
- [x] 5.3 All `localStorage.getItem/setItem('devflow_user', ...)` calls removed from ProtectedRoute, PublicRoute, Login, Register, and Navbar. Verified via grep — only the intentional `removeItem` calls in Login and Register remain.
- [x] 5.4 Login and Register call `localStorage.removeItem('devflow_user')` on mount (one-time migration cleanup of the leftover key)

## 6. Frontend: Route guards

- [x] 6.1 [ProtectedRoute.tsx](../../../devFlowFrontend/src/components/auth/ProtectedRoute.tsx) reads `{ isAuthenticated, isLoading }` from `useAuth()`; loading → `<AuthLoading />`, then redirect
- [x] 6.2 [PublicRoute.tsx](../../../devFlowFrontend/src/components/auth/PublicRoute.tsx) same pattern, opposite redirect
- [x] 6.3 [AuthLoading.tsx](../../../devFlowFrontend/src/components/auth/AuthLoading.tsx) shared spinner component

## 7. Frontend: Logout surface

- [x] 7.1 [Navbar.tsx](../../../devFlowFrontend/src/components/layout/Navbar.tsx) data source swapped from `localStorage` to `useAuth()`; gating uses `isAuthenticated`; the existing dropdown's `Log out` item now calls `auth.logout()` and navigates to `/`
- [x] 7.2 No separate dashboard logout button needed — the navbar dropdown is reachable from every authenticated view

## 8. Frontend: build + lint

- [x] 8.1 `npm run lint` — clean
- [x] 8.2 `npm run build` — clean production build. The pre-existing 500KB-chunk warning is unrelated to this change.

## 9. Manual verification (end-to-end against deployed backend)

- [ ] 9.1 Set `CORS_ALLOWED_ORIGINS` to include the frontend origin on the deployed backend; redeploy.
- [ ] 9.2 Set `VITE_API_URL` to the backend URL in the frontend's CI build env; redeploy.
- [ ] 9.3 Open the deployed frontend. Visit `/register`. Submit a new email + password. Confirm HTTP 201, `Set-Cookie: session=...` with `SameSite=None; Secure; HttpOnly`, redirect to `/dashboard`, and `document.cookie` does NOT show `session` (httpOnly).
- [ ] 9.4 Reload `/dashboard`. Confirm the user stays logged in and the auth context resolves via `/auth/me` without flashing `/login`.
- [ ] 9.5 Click the Navbar dropdown → Log out. Confirm `POST /auth/logout` returns 204, the cookie is cleared, and the user is sent to `/`.
- [ ] 9.6 Visit `/login`, enter the same credentials, confirm successful login + dashboard.
- [ ] 9.7 Try logging in with a wrong password. Confirm the inline "Invalid credentials" error and the password field clears.
- [ ] 9.8 From browser devtools on a different domain try `fetch(API_URL + '/auth/me', { credentials: 'include' })` — confirm CORS rejects it.
- [ ] 9.9 Confirm the VS Code extension can still POST telemetry (no-Origin path is unaffected).

## 10. Documentation

- [x] 10.1 [docs/frontend-auth.md](../../../docs/frontend-auth.md) created covering: env vars (frontend + backend), cookie-attribute modes, CSRF posture, infra checklist, and known limitations
- [x] 10.2 CSRF posture documented in docs/frontend-auth.md with the reasoning for why we don't ship a CSRF token today
