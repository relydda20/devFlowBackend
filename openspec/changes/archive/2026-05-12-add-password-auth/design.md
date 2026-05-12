## Context

After shipping `add-oauth-login`, the OAuth flow works on `localhost` but is breaking in the hackathon k8s environment for reasons that aren't fixable from the application alone (no/limited egress to Google, ingress quirks). Demo is at risk.

The existing infrastructure already gives us most of what we need for an alternative:
- JWT signing/verification ([src/services/jwt.service.js](src/services/jwt.service.js))
- `verifyJwt` middleware that pulls a token from `Authorization: Bearer` or the `session` cookie ([src/middleware/auth.middleware.js](src/middleware/auth.middleware.js))
- `User` Sequelize model with `provider` + `provider_user_id` columns
- Cookie machinery via `cookie-parser`
- Auth route file ([src/routes/auth.routes.js](src/routes/auth.routes.js)) that mounts under `/api/v1`

What's missing: a way to create a `User` row from credentials the server holds directly (instead of from a third-party identity assertion), plus the password-hash storage to verify those credentials later.

## Goals / Non-Goals

**Goals:**
- A self-contained, internet-free auth path so the hackathon demo works inside the cluster.
- Reuse the existing JWT pipeline so the telemetry endpoint and `/auth/me` need no changes.
- Same cookie-and-Bearer transport model as OAuth so frontends/extensions don't have to fork their logic.
- Easy to exercise from `curl` for testing.

**Non-Goals:**
- Removing or "fixing" the OAuth code. It stays where it is; if egress opens up, it'll work.
- Email verification, password reset, MFA, account recovery, account linking with OAuth identities by shared email.
- Brute-force protection / rate limiting / lockouts. Hackathon demo only.
- Password complexity rules beyond a minimum length.

## Decisions

### 1. Same `User` row shape, new `provider` value
**Decision:** Add `'password'` to the `provider` enum. For password users, `provider_user_id` is set to the user's `email` (lowercased) so the existing `(provider, provider_user_id)` unique index doubles as the unique-email-per-strategy guarantee.

**Why:** Keeps a single `users` table with one schema. Avoids inventing a second identity table. The `provider_user_id` field already represents "the identifier the provider knows this user by" — for a password user, that's just their email.

**Trade-off:** Re-using `provider_user_id` for email feels a little semantically loose. Acceptable because:
- The composite-key uniqueness logic just works.
- The JWT and middleware don't need to learn anything new.
- If we later split password users into their own table, the migration is straightforward (one INSERT/SELECT).

### 2. bcrypt with cost factor 12
**Decision:** Use the `bcrypt` library, cost factor 12 (default is 10; 12 gives a comfortable margin and is still fast enough on hackathon hardware — ~250 ms per hash).

**Why:** Battle-tested, widely understood, easy to swap to argon2 later if needed. Cost factor 12 hits a reasonable balance for a hackathon (slow enough to defeat trivial brute force, fast enough that login UX isn't painful).

### 3. Store hash in a new column, not abuse `provider_user_id`
**Decision:** New column `password_hash TEXT NULL`. NOT NULL would block OAuth users; nullable is fine.

**Why:** Keeping the hash in its own column is unambiguous and makes "is this a password user" trivially expressible as `WHERE provider = 'password' AND password_hash IS NOT NULL`.

### 4. Email normalization on the way in
**Decision:** Lowercase the email and trim whitespace before storing or looking up. Validate it matches a minimal regex (presence of `@`, no spaces).

**Why:** Avoids "but I registered with `Alice@Example.com` and now I can't log in with `alice@example.com`" support burden. Trimming kills the most common copy-paste mistake.

### 5. Same JWT shape as OAuth
**Decision:** `{ sub: user.id, provider: 'password' }`, same `JWT_SECRET`, same 7-day expiry. Set as the `session` cookie *and* returned in the response body for clients that prefer Bearer (CLI tools, the VS Code extension).

**Why:** The whole point of swapping providers is that the rest of the system shouldn't change. The middleware doesn't read `provider` for authorization (yet); when it eventually does, "password" is just another value to allow.

### 6. Register returns the token immediately — no separate "now log in" step
**Decision:** A successful `POST /auth/register` does the full register-then-issue-token flow in one round trip and responds with `{ user, token }` plus the cookie.

**Why:** It removes a useless extra round trip. Industry-standard behavior for hackathon-class APIs and most modern SaaS.

### 7. Login error messages are deliberately generic
**Decision:** `POST /auth/login` returns `401 { error: "Invalid credentials" }` whether the email doesn't exist or the password is wrong. Never `404 user not found` vs `401 wrong password`.

**Why:** Account enumeration prevention. Cheap to do, real best practice, doesn't hurt UX.

### 8. Validation lives in the route, not the model
**Decision:** Use AJV (the same library the telemetry endpoint uses via `validateRequest`) to validate `register` and `login` request bodies against schemas defined in `openspec.yaml`. Don't rely on Sequelize column constraints to produce user-friendly errors.

**Why:** Consistent with the existing pattern. Schema lives next to the rest of the API contract. Errors come back in a uniform shape.

## Risks / Trade-offs

- **No rate limiting** → Mitigation: documented as non-goal. The hackathon cluster is private and the API is not exposed beyond the team. If we ever expose this publicly, `express-rate-limit` (already in `package.json`) needs to be wired up to `/auth/login` and `/auth/register`.
- **No password reset** → Mitigation: hackathon scope. If someone forgets their password, they re-register with a different email (the unique key on `(provider, email-as-provider_user_id)` prevents reusing the same email).
- **No email verification** → Mitigation: documented as non-goal. Acceptable because the only client is internal testing right now.
- **bcrypt is a native module** → Mitigation: it's well-supported on Linux base images. The hackathon's Node image (running on the k8s pods) needs to have build tools, or use `bcryptjs` as a pure-JS fallback. Verify during the install task; swap to `bcryptjs` if it fails.
- **Storing email in `provider_user_id`** → Mitigation: documented. If/when we grow this, a one-shot migration backfills a dedicated column.

## Migration Plan

Two schema changes against the existing `users` table:
1. `ALTER TABLE users ADD COLUMN password_hash TEXT NULL;`
2. `ALTER TYPE enum_users_provider ADD VALUE 'password';` — Postgres lets you add enum values without rewriting tables.

For a hackathon, the simplest path is to run `User.sync({ alter: true })` once after the model changes, or just drop and recreate the `users` table if we don't care about existing OAuth rows. The tasks file calls out both options; pick the one that matches your DB state.

Rollback: drop the column; the enum value can stay (Postgres can't drop enum values cleanly, but having an extra value lying around is harmless).

## Open Questions

- Should the OAuth `/auth/:provider` route start returning a friendly "OAuth temporarily unavailable, use /auth/register" message when the new path is preferred? Current stance: no — leave OAuth as-is so it just keeps working once egress opens up. Don't paper over it.
- Username field on register: required or auto-generated? Current stance: optional in the request; if absent, derive from email's local-part (`alice@example.com` → `alice`). Same collision-resolution logic as the OAuth flow.
- Should we expose a `/auth/change-password` endpoint? Current stance: not now. Hackathon-only; users re-register if needed.
