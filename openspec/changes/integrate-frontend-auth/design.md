## Context

The backend at [src/controllers/password-auth.controller.js](src/controllers/password-auth.controller.js) already implements the full password-auth flow: it validates the request body, hashes the password with bcrypt, creates the `User` row, signs a JWT, sets it as an httpOnly cookie named `session`, and also returns the token in the response body. The OAuth flow in [src/controllers/auth.controller.js](src/controllers/auth.controller.js) uses the same cookie pattern.

The frontend at [devFlowFrontend/src/pages/Login.tsx](../../../devFlowFrontend/src/pages/Login.tsx) and [Register.tsx](../../../devFlowFrontend/src/pages/Register.tsx) never talks to any backend. Each form's submit handler stuffs the email string into `localStorage.devflow_user` and redirects. The two route guards ([ProtectedRoute.tsx](../../../devFlowFrontend/src/components/auth/ProtectedRoute.tsx), [PublicRoute.tsx](../../../devFlowFrontend/src/components/auth/PublicRoute.tsx)) gate purely on the presence of that localStorage key.

Both frontend and backend run in the same Kubernetes cluster (per user). The frontend is reachable at `https://who-goes-to-try.hackathon.sev-2.com/`. CI deploys on merge to main. The cluster has working HTTPS and TLS termination; the infra team handles the manifest/Helm/Ingress side.

Two design questions sit at the center of this change: (1) how does authentication state live on the frontend, and (2) how does the browser carry credentials between two origins that are *related* but not *same-origin*.

## Goals / Non-Goals

**Goals:**
- The frontend treats the backend as the single source of truth for "is this user logged in." No more state inferred from localStorage.
- Cross-origin requests carry the session cookie automatically. The frontend code does not pass tokens around; the browser handles the credentialed handshake.
- A misconfigured deployment (e.g., the frontend pod missing `VITE_API_URL`, or the backend missing `CORS_ALLOWED_ORIGINS`) fails *loudly and locally* during development, not silently in production.
- Backwards compatibility with the VS Code extension: the `dvf_` API token path through [auth.middleware.js](src/middleware/auth.middleware.js) is untouched.

**Non-Goals:**
- OAuth wiring on the frontend (Google / GitHub buttons). The backend already has the flow; surfacing it on the React side is a separate change.
- A custom token storage scheme. We use what the backend already issues (`session` cookie + JWT in body). Frontend ignores the body token; the browser handles the cookie.
- Server-side rendering, session timers, or auto-refresh. The JWT is 7 days; if it expires, the next `/auth/me` call returns 401 and the user is sent to /login.
- Multi-tenant origin support beyond a simple comma-separated allowlist.
- A logout-everywhere ("kill all sessions") feature. Logout is local: it clears the cookie. The JWT remains valid until expiry — but without the cookie, it isn't presented anywhere.

## Decisions

### Auth state lives in a React context driven by `GET /auth/me`

On app mount, `AuthProvider` issues a single `GET /auth/me` with `credentials: 'include'`. The response decides initial state:
- 200 → `{ user, isAuthenticated: true, isLoading: false }`
- 401 → `{ user: null, isAuthenticated: false, isLoading: false }`
- Network error → `{ user: null, isAuthenticated: false, isLoading: false, error: ... }`. Treat as logged-out; the user can retry by signing in.

Mutations (`login`, `register`, `logout`) update the context optimistically from their HTTP response, then call `refresh()` (re-`me`) to confirm.

**Why a context instead of a state library:** the surface is tiny (`user`, `isAuthenticated`, 4 actions). Adding Zustand or Redux is overkill at the scale of "one piece of global state."

**Why `me` instead of decoding the JWT client-side:** we can't decode it — it's in an httpOnly cookie the JS can't read. That's the *point* of httpOnly. `me` is the authoritative answer regardless of what JS sees.

**Alternative considered:** store the user in localStorage and skip `me` on mount. Rejected — that's exactly the bug we're getting rid of. localStorage drifts from server state silently; `me` doesn't.

### Route guards block on the loading state, don't flash

`ProtectedRoute` and `PublicRoute` currently make an instant decision from localStorage. After the change, they read `isLoading`/`isAuthenticated` from context. While `me` is pending (`isLoading === true`), both guards render a minimal centered spinner (or `null` — see below) rather than redirecting.

**Why:** otherwise a logged-in user reloading `/dashboard` would briefly see `/login` before `me` resolves and redirects back. That flash is the classic SPA-auth bug and it confuses users.

**Choice of spinner vs null:** a small spinner. A blank flash is worse than a brief loading state. The `me` call typically completes in <100ms; users barely see it.

### Httponly cookie + `credentials: 'include'`, not Authorization header

The frontend never reads the JWT. Every `fetch` includes `credentials: 'include'`; the browser attaches the `session` cookie. The backend reads `req.cookies.session` first (via [cookie-parser](src/server.js)), falling back to `Authorization: Bearer <jwt>` for non-browser clients.

**Why:** httpOnly cookies are immune to XSS — no script on the page can read the token, period. The trade-off is CSRF, which we mitigate with `SameSite=Lax` in development. In production we have to relax to `SameSite=None` because the frontend and backend are on different subdomains; the missing CSRF defense is then provided by:
- The browser refusing to send cookies unless `Secure=true` and HTTPS is in use (both are true in cluster).
- Origin checking on state-changing endpoints (covered by the CORS allowlist — only known origins can issue credentialed requests at all).

**Alternative considered:** Store the JWT in memory (a JS variable inside the React tree) and attach to every request as a header. Rejected because every page reload loses it, forcing a re-login or a refresh-token mechanism we don't have. Cookies survive reloads for free.

### CORS allowlist, not `Access-Control-Allow-Origin: *`

[server.js](src/server.js) currently calls `app.use(cors())` which is `*` and no credentials. We replace it with:

```js
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);             // curl, server-to-server
    const allowed = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    return cb(null, allowed.includes(origin));
  },
  credentials: true,
}));
```

**Why a function rather than a static list:** lets the rule be one-place and the env var be parsed once per request without a cold-start dance. The cost is one `.split()` per request, which is unmeasurable.

**Why `if (!origin)`:** the `Origin` header is absent on same-origin requests, on server-to-server calls, and on `curl`. We don't want to block our own health checks or the extension's API token POSTs (which also lack `Origin`). The auth check still happens; CORS is the gate for *browsers cross-origin*, not a general firewall.

**Alternative considered:** Wildcard pattern matching (`*.hackathon.sev-2.com`). Rejected — pattern matching in CORS has caused subtle production bugs in many shops (subdomain takeover, regex escape, etc.). Explicit list of full origins is harder to misconfigure.

### Cookie attributes: `SameSite=Lax` in dev, `SameSite=None; Secure` in prod

[password-auth.controller.js](src/controllers/password-auth.controller.js) and [auth.controller.js](src/controllers/auth.controller.js) currently set `sameSite: 'lax'`, `secure: isProd`. That works for same-origin or `localhost`, but it does NOT work when frontend and backend are on different production origins — browsers refuse to send `Lax` cookies on cross-site POSTs.

We change to:
- Production: `{ sameSite: 'none', secure: true }` — cookie travels cross-site, but only over HTTPS, and only when the request originates from a CORS-allowed origin.
- Development: `{ sameSite: 'lax', secure: false }` — current behavior; works with the localhost dev server and `npm run dev`.

**Why two modes:** the dev shortcut (`localhost`) is treated specially by browsers and doesn't need `Secure`. Forcing `Secure=true` everywhere would break local dev.

### Vite reads `VITE_API_URL` at build time, not runtime

Vite inlines `import.meta.env.VITE_API_URL` at build time. The frontend pod's image is therefore tied to one backend URL per build. For two environments (staging vs prod) the CI builds twice with different env vars.

**Why this is fine:** the frontend rarely changes backend host in flight, and Vite's pattern is what every shop using Vite does. The alternative (a runtime-fetched `/config.json`) adds an extra request and a moving part for ~no benefit at this scale.

**Failure mode:** if `VITE_API_URL` is unset at build time, the api client falls back to `http://localhost:3000`, which will obviously fail in the cluster. Mitigation: the client logs a clear warning to the browser console at module load if it's using the localhost fallback in a non-localhost context. CI is free to add a check that fails the build if the var is missing in non-dev environments.

### Form submissions are typed end-to-end

The frontend client functions look like:

```ts
type RegisterRequest = { email: string; password: string; username?: string };
type RegisterResponse = { user: User; token: string };

async function register(body: RegisterRequest): Promise<RegisterResponse> { ... }
```

with a thin `User` type that mirrors what the backend's `AuthResponse.user` returns (`{ id, username, email, provider }`).

**Why:** typos in field names are the single most common bug at the auth boundary. End-to-end types catch them at build time. We don't need a code generator for two endpoints; hand-written matches the openspec.yaml schema.

### Logout is server-acknowledged but client-trusted

`logout()` calls `POST /api/v1/auth/logout` (which clears the cookie server-side) and unconditionally sets context state to logged-out. Errors from the logout call are logged and ignored — we want logout to always *appear* to succeed locally; if the cookie clearing failed, the next `me` will catch it.

**Why:** the worst UX is "I clicked logout and nothing happened." If the network is broken, we still want the UI to behave as if logged out.

## Risks / Trade-offs

- **[Risk] A misconfigured `CORS_ALLOWED_ORIGINS` lets a malicious origin make credentialed requests** → Mitigation: list is explicit (no wildcards), reviewed in the env-var config, and the failure is loud (the bad origin's requests will work, but only if it's been added to the list by hand — so the threat model collapses to "the team has typoed an evil origin into the allowlist," which is detectable in code review).
- **[Risk] `SameSite=None; Secure` cookie is dropped by some older or privacy-strict browsers** → Mitigation: documented limitation. Users on Safari with cross-site cookies disabled will not stay logged in. Acceptable for v1; an SSO-style same-origin reverse proxy would be the next level of fix.
- **[Risk] CSRF on state-changing endpoints, since `SameSite=None` removes the same-site protection** → Mitigation: the CORS allowlist plus origin checking is the gate. We could additionally add a CSRF token; deferred until we have a real reason (e.g., a payments endpoint), because the cost (every form needs a token) outweighs the benefit at this stage.
- **[Trade-off] `VITE_API_URL` baked at build time means one image per backend host** → Acceptable. The alternative (runtime config) trades a build-time guarantee for a runtime fragility.
- **[Trade-off] The 7-day JWT can outlive logout because we don't blocklist it** → Same trade-off we accepted in [extension-sign-out-flow]. If a JWT is leaked we have no kill switch except expiry. Documented and acceptable for now.
- **[Risk] If the infra team adds a new frontend origin (staging, preview deploys), forgetting to add it to `CORS_ALLOWED_ORIGINS` produces opaque "CORS error" failures in the browser** → Mitigation: documented as part of the deployment runbook (which is part of this change's docs output).
- **[Trade-off] The frontend's `AuthProvider` always issues one `/auth/me` on mount, even for users who are obviously logged out (e.g., first visitor)** → Cost is one HTTP round-trip per page load. Acceptable. Could be avoided by remembering "I've been unauthenticated before" in `sessionStorage`, but the complexity isn't worth it.
