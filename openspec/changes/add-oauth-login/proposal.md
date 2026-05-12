## Why

Today there is no authentication: the telemetry endpoint trusts whatever `user_id` the client puts in the payload (flagged as a non-goal in `add-telemetry-controller`), and `User` rows can only be created by manual `INSERT`. The web app has nothing to log into, and the VS Code extension has no identity it can prove. Without auth, the API is unsafe to expose beyond localhost.

We need a single auth mechanism that works for two clients (the web app and the VS Code extension), avoids password storage entirely, and produces a credential that's drop-in compatible with the existing `/api/v1/telemetry` controller.

## What Changes

- Add OAuth 2.0 Authorization Code flow with PKCE for two providers: Google and GitHub.
- Add `GET /api/v1/auth/:provider` — starts the flow (issues PKCE challenge + `state`, redirects to provider).
- Add `GET /api/v1/auth/:provider/callback` — completes the flow, finds-or-creates a `User` keyed on `(provider, provider_user_id)`, issues a signed JWT.
  - For browser clients: sets the JWT in an `httpOnly`, `Secure`, `SameSite=Lax` cookie and redirects to the configured web app URL.
  - For VS Code extension clients: redirects to a registered deep link (`vscode://<publisher>.<extension>/auth-callback?token=...`) so the extension picks the JWT up directly.
- Add `GET /api/v1/auth/me` — returns the current user (decoded from JWT). Useful for both clients to confirm login.
- Add `POST /api/v1/auth/logout` — for the cookie flow, clears the cookie. (Stateless JWT means there's nothing to "log out" of for the extension beyond discarding the token.)
- Add `verifyJwt` middleware that:
  - Reads `Authorization: Bearer <jwt>` OR the `session` cookie.
  - Decodes + verifies signature and expiry.
  - Attaches `req.user = { id, provider }` to the request.
- Wire the middleware into `/api/v1/telemetry` and replace `req.body.user_id` with `req.user.id` (the one-line swap previewed in `add-telemetry-controller`).
- **BREAKING**: `POST /api/v1/telemetry` no longer accepts `user_id` in the body. Requests without a valid JWT are rejected `401`.

## Capabilities

### New Capabilities
- `oauth-login`: OAuth 2.0 PKCE flow for Google and GitHub, JWT issuance, JWT verification middleware, `/auth/me` and `/auth/logout` endpoints.

### Modified Capabilities
- `telemetry-ingestion`: `POST /telemetry` now derives `user_id` from the verified JWT instead of the request body. Unauthenticated requests return `401`.

## Impact

- **New columns on `users` table** (additive migration): `provider` (`'google'` | `'github'`), `provider_user_id` (text, unique per provider), `email` already exists. A composite unique constraint on `(provider, provider_user_id)` enforces one User per OAuth identity.
- **New env vars**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `OAUTH_CALLBACK_BASE_URL`, `WEB_APP_URL`, `VSCODE_DEEPLINK`.
- **New dependencies**: `jsonwebtoken`, `cookie-parser`, `node-fetch` (or use built-in fetch on Node 20+).
- **New files**: `src/routes/auth.routes.js`, `src/controllers/auth.controller.js`, `src/services/oauth.service.js`, `src/services/jwt.service.js`, `src/middleware/auth.middleware.js`, a small in-memory store for pending PKCE/state values (or a `auth_states` table if we want persistence across restarts — see design).
- **Schema changes**:
  - `User` model gains `provider`, `provider_user_id` columns and the composite unique index.
  - `openspec.yaml` gets `/auth/:provider`, `/auth/:provider/callback`, `/auth/me`, `/auth/logout` and a `securitySchemes.bearerAuth` entry applied to `/telemetry`.
  - `TelemetryBatch` schema in `openspec.yaml` loses `user_id` (or it becomes ignored).
- **Out of scope**:
  - Email/password login, magic links, SSO/SAML — providers only.
  - Refresh tokens (we ship short JWT + re-login). Listed as a follow-up.
  - Role/permission system. Every authenticated user has the same access for now.
  - Account linking (one OAuth identity per User; if the same email signs in via both Google and GitHub, two `User` rows are created).
