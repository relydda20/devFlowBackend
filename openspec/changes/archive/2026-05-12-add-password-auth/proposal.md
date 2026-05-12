## Why

The OAuth flow built in `add-oauth-login` works locally but is failing in the hackathon k8s environment for reasons outside the application's control (egress restrictions, ingress URL rewrites, callback handling). We need a self-contained authentication path that doesn't depend on outbound calls to Google/GitHub, so the team can demo and test end-to-end inside the cluster.

Email + password is the simplest fit: it requires zero external services, can be exercised entirely with `curl`, and reuses the JWT + middleware infrastructure already in place from the OAuth work.

## What Changes

- Add `POST /api/v1/auth/register` — accepts `{ email, password, username? }`, hashes the password with bcrypt, creates a `User` row with `provider='password'`, returns `{ user, token }`.
- Add `POST /api/v1/auth/login` — accepts `{ email, password }`, verifies against the bcrypt hash, returns `{ user, token }`. The token is **also** set as the `session` cookie so browser clients work the same way as the OAuth flow.
- Update `POST /api/v1/auth/logout` — it already clears the `session` cookie; behaviour stays the same. Both password and OAuth users use the same logout.
- Add new columns to `users`: `password_hash` (TEXT, nullable — only set for password users), `email` becomes required for password users.
- Extend the `provider` enum on `User` to include `'password'` (in addition to `'google'` and `'github'`).
- Keep OAuth code in place but not actively demoed.

## Capabilities

### New Capabilities
- `password-auth`: register, login, logout endpoints; bcrypt password hashing; email/password validation; JWT issuance compatible with the existing `verifyJwt` middleware.

### Modified Capabilities
- `oauth-login`: extended to acknowledge `provider='password'` as a valid value alongside `google` and `github`. The JWT verification middleware is unchanged because it doesn't care about the provider beyond passing it through.

## Impact

- **New dependency**: `bcrypt` (`^5.x`).
- **Schema migration**: `users.password_hash` column (nullable), `provider` enum gains `'password'` value. Additive — existing OAuth rows keep working.
- **New files**: `src/controllers/password-auth.controller.js`, `src/services/password.service.js`. Routes added to existing `src/routes/auth.routes.js`.
- **New env**: none — reuses `JWT_SECRET`, `WEB_APP_URL`, etc.
- **No changes to telemetry**: the `verifyJwt` middleware already accepts any JWT signed with `JWT_SECRET`, so password-issued tokens work for `POST /telemetry` immediately.
- **OpenAPI**: add `/auth/register` and `/auth/login` paths to `openspec.yaml`. Mark `password` as a valid `provider` enum where relevant.
- **Out of scope**:
  - Email verification / confirmation links — accounts are usable immediately. Acceptable for hackathon.
  - Password reset flow.
  - Account linking between password users and OAuth users with the same email — separate rows, no linking.
  - Rate limiting on login attempts. `express-rate-limit` is in `package.json` but isn't wired; a follow-up.
  - 2FA.
