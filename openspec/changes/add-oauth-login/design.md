## Context

The backend currently has:
- An Express app at [src/server.js](src/server.js) with helmet, cors, json body parsing, and a global error handler.
- A `User` Sequelize model ([src/models/user.model.js](src/models/user.model.js)) with `id` (UUID), `username` (unique, NOT NULL), `email` (unique, nullable).
- A telemetry pipeline that today trusts `req.body.user_id` and rejects unknown users with `404`.
- Two clients planned: a web app (which doesn't exist yet but will be hosted under `WEB_APP_URL`) and a VS Code extension that runs on the user's machine.

Industry practice for "one backend, two client surfaces, no password storage" is:

1. **OAuth 2.0 Authorization Code flow with PKCE** as the user-facing handshake — same flow for both clients, no client secret in the browser or the extension.
2. **The backend holds the OAuth client secret** and is the only party that talks directly to Google's/GitHub's token endpoints.
3. **The backend issues its own JWT** after the OAuth handshake completes. Clients never touch Google's/GitHub's tokens after that; they hold our JWT.
4. **Transport differs by client**:
   - Browsers get the JWT in an `httpOnly`, `Secure`, `SameSite=Lax` cookie (immune to XSS exfiltration).
   - The VS Code extension receives the JWT via a registered `vscode://` deep link or, as a fallback, via a short-lived authorization code that the extension exchanges over HTTPS.

The `add-telemetry-controller` change already established the rule "controllers never create User rows except in the auth flow." This change is what makes that rule load-bearing.

## Goals / Non-Goals

**Goals:**
- Single-source-of-truth user identity backed by Google or GitHub OAuth.
- One implementation that serves both the web app and the VS Code extension.
- Stateless authentication for the telemetry hot path (JWT verify, no DB lookup per request).
- The existing telemetry controller works with a one-line change: read `req.user.id` instead of `req.body.user_id`.

**Non-Goals:**
- Refresh tokens. Access tokens are short-lived (e.g. 7 days); the user re-runs the OAuth flow when they expire. Adding refresh adds a rotation/revocation table and isn't necessary for hackathon-scale.
- Account linking. If a user signs in with Google then later GitHub using the same email, they get two distinct `User` rows. Linking is a follow-up.
- Email/password, magic links, SAML, custom IdPs.
- Role-based access control. All authenticated users are equal until a role system is designed.
- Persistent OAuth state across server restarts. State entries are short-lived (5 min); a server restart invalidates in-flight logins, which is acceptable.

## Decisions

### 1. Authorization Code flow with PKCE for both clients
**Decision:** Both web and extension use Authorization Code + PKCE. The backend is the OAuth client (holds `CLIENT_SECRET`); the client surfaces redirect users to the backend's `/auth/:provider` endpoint, not directly to Google/GitHub.

**Why:** The web app is a public client (no secret can be embedded in JS); the VS Code extension is also effectively public (anyone can unpack it). PKCE is the standard answer for public clients. By making the backend the OAuth client and bouncing through `/auth/:provider`, we avoid embedding `CLIENT_SECRET` anywhere outside the server, and we centralize the find-or-create-user logic.

**Alternative considered:** Treat each client as its own OAuth client (separate `CLIENT_ID`s, direct redirect to Google/GitHub from the client). Rejected — duplicates the find-or-create logic on the client side and forces the client to call our backend with the provider's access token, which is a second auth model to maintain.

### 2. Backend issues its own JWT (HS256) — not the provider's token
**Decision:** After the OAuth callback completes, the backend mints a signed JWT containing `{ sub: user.id, provider, iat, exp }`. The provider's access token is discarded.

**Why:**
- We don't need to call Google/GitHub APIs on the user's behalf — we only needed them to vouch for the identity, once. Storing or forwarding the provider's token would be pointless and risky.
- Our own JWT means we control expiry, claims, and signing keys without depending on the provider.
- HS256 (symmetric) is fine because only the backend issues and verifies tokens. Asymmetric (RS256) would be needed if a different service had to verify — not the case here.

**Trade-off:** If `JWT_SECRET` leaks, every active token is compromised. Mitigation: keep it in `.env` (gitignored), rotate on suspicion (invalidates everyone, by design).

### 3. JWT transport: cookie OR Authorization header
**Decision:** The auth middleware accepts both:
- `Authorization: Bearer <jwt>` (extension, server-to-server, curl)
- `Cookie: session=<jwt>` (browser)

The callback handler chooses which one to set based on a `client_type` parameter on the original `/auth/:provider` call (`web` or `vscode`, default `web`).

**Why:** Browsers shouldn't hold JWTs in JS (XSS exfil risk), so the cookie is mandatory there. The VS Code extension can't easily share cookies with our backend (different origin, no browser context for the actual API calls from the extension), so it needs the header.

### 4. PKCE/state storage: in-memory Map with TTL
**Decision:** A `Map<state, { codeVerifier, provider, clientType, createdAt }>` keyed by the `state` we send to the OAuth provider, with entries TTL'd to 5 minutes. On callback we look up `state`, validate it matches, consume the entry, complete the flow.

**Why:** OAuth state entries are short-lived (the user has minutes to complete consent) and don't need to survive restarts — a restart mid-login just means the user clicks "Continue with Google" again. A DB table would be over-engineered.

**Trade-off:** Doesn't scale beyond one process. Acceptable today; if we go multi-instance, swap the Map for Redis with the same interface.

### 5. User uniqueness: `(provider, provider_user_id)`
**Decision:** Add `provider` (`enum('google','github')`) and `provider_user_id` (TEXT) columns on `users`. Composite unique index. `findOrCreate({ where: { provider, provider_user_id }, defaults: { username, email } })`.

**Why:** Email is not a reliable primary key for OAuth — users can change email at the provider, and we'd risk merging two different humans. The provider's stable user ID is the only safe key.

**Username generation:** `username` is currently NOT NULL UNIQUE. We synthesize it as `${provider}-${provider_user_id_first_8}` if the provider's preferred name is taken. Long-term, a user-edit endpoint should let people pick their own.

**Trade-off:** Same human signing in via Google then GitHub becomes two `User` rows. Documented as non-goal; account linking is future work.

### 6. Cookie attributes (web only)
**Decision:** `httpOnly: true`, `secure: true` (forced in prod), `sameSite: 'lax'`, `path: '/'`, `maxAge` = JWT expiry. Cookie name: `session`.

**Why:** `httpOnly` prevents JS access (XSS resistance). `SameSite=Lax` is the right default — blocks cross-site POSTs but lets top-level navigations (e.g. the OAuth redirect itself) carry the cookie.

### 7. Deep link for VS Code (`vscode://<publisher>.<extension>/auth-callback?token=…`)
**Decision:** The callback endpoint, when called with `client_type=vscode`, performs a `302` redirect to the deep link URL with the JWT in the query string. The extension registers a URI handler to capture it.

**Why:** This is the official VS Code pattern (`vscode.window.registerUriHandler`) and avoids polling or websockets. The JWT in a query string is acceptable because the redirect target is the OS deep-link handler, not a remote server with logs.

**Trade-off:** JWT briefly lives in the URL → could be logged by the browser's history. Acceptable because (a) the URL never hits a remote server, (b) the JWT is short-lived, (c) the alternative (a code-for-token exchange) doubles the round-trips for marginal benefit on a desktop extension.

### 8. Telemetry endpoint becomes auth-protected
**Decision:** Mount `verifyJwt` middleware on `/api/v1/telemetry`. Controller reads `req.user.id`. The `TelemetryBatch` schema in `openspec.yaml` drops the `user_id` field.

**Why:** Closes the loop on the trusted-`user_id` non-goal in `add-telemetry-controller`. Anyone who can call telemetry has been authenticated by Google or GitHub.

**Breaking change** documented in proposal.

## Risks / Trade-offs

- **JWT_SECRET leak compromises every active session** → Mitigation: keep in `.env`, rotate on suspicion (forces everyone to re-login, by design). Add a `kid` claim later if rotation needs to be graceful.
- **OAuth provider downtime blocks all new logins** → Mitigation: existing JWTs keep working until expiry; only fresh logins fail. Document the dependency.
- **Username collisions when synthesizing from provider names** → Mitigation: fallback to `${provider}-${provider_user_id_short}`; if even that collides, append `-${random}`.
- **JWT in query string for VS Code deep link** → Mitigation: short TTL, document that operators should never log the deep-link URL.
- **In-memory state Map loses entries on restart** → Mitigation: 5-min TTL means worst case the user re-clicks "Continue with Google". Acceptable for one-process deploy.
- **Telemetry breaking change** → Mitigation: explicit in proposal. The VS Code extension PR that picks up this backend must ship at the same time.

## Migration Plan

- **Database migration**: additive — adds `provider`, `provider_user_id` columns to `users` (nullable initially), creates the composite unique index, then in a follow-up makes the columns NOT NULL once existing rows are backfilled or removed. For hackathon-scale, simplest path: drop existing `users` rows (only test data) and make the columns NOT NULL from the start. `tasks.md` documents both options.
- **Deploy order**: backend ships first (auth endpoints live, telemetry still accepts body `user_id` for one release as a soft-deprecation). Then web app and extension ship with the JWT integration. Then a follow-up release flips telemetry to require auth.
  - **Hackathon shortcut**: ship everything together, accept the brief breakage.
- **Rollback**: revert the commit. JWT-issued users remain in the DB but become unreachable until OAuth is back. No data loss.

## Open Questions

- Should `/auth/logout` revoke the JWT server-side (requires a token blacklist) or just clear the cookie and rely on the client to discard the token? Current plan: clear cookie only — simpler, accepts that a leaked JWT is valid until expiry. Revisit if we ship refresh tokens.
- Username generation policy when the provider's `username`/`login` field collides with an existing user — append random suffix vs. show an error and let the user pick? Current plan: random suffix to keep the flow non-interactive; user-edit endpoint comes later.
- Should `/auth/me` include the `email` field, or only `id` + `username`? Current plan: include email for the web UI; document in the spec.
