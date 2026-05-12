## 1. Preconditions

- [ ] 1.1 Archive `add-telemetry-controller` first (`/opsx:archive add-telemetry-controller`) so the `telemetry-ingestion` canonical spec exists for our MODIFIED delta
- [ ] 1.2 Register an OAuth app at https://console.cloud.google.com/apis/credentials with `redirect_uri = ${OAUTH_CALLBACK_BASE_URL}/api/v1/auth/google/callback`; capture `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- [ ] 1.3 Register an OAuth app at https://github.com/settings/developers with the same callback shape for `github`; capture `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- [ ] 1.4 Add to `.env` (and `.env.example` with placeholders): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET` (32+ random bytes), `OAUTH_CALLBACK_BASE_URL=http://localhost:3000`, `WEB_APP_URL=http://localhost:5173`, `VSCODE_DEEPLINK=vscode://devflow.devflow/auth-callback`

## 2. Dependencies and model

- [ ] 2.1 `npm install jsonwebtoken cookie-parser`
- [ ] 2.2 Add to `src/models/user.model.js`: `provider` (`ENUM('google','github')`, NOT NULL), `provider_user_id` (TEXT, NOT NULL), composite unique index on `(provider, provider_user_id)`. Make `username` allow auto-synthesized values (no schema change needed; just generation logic in service).
- [ ] 2.3 Drop and recreate `users` (hackathon shortcut): run a one-liner that does `User.sync({ force: true })` — only safe because existing rows are test data
- [ ] 2.4 Update `openspec.yaml`: add `components.securitySchemes.bearerAuth` (type: http, scheme: bearer, bearerFormat: JWT) and apply `security: [{ bearerAuth: [] }]` to `POST /telemetry`. Remove `user_id` from the `TelemetryBatch` schema. Add the four new auth paths (`/auth/:provider`, `/auth/:provider/callback`, `/auth/me`, `/auth/logout`).

## 3. Services

- [ ] 3.1 Create `src/services/jwt.service.js` exporting `sign({ sub, provider })` (HS256, 7-day expiry) and `verify(token)` returning `{ sub, provider }` or throwing
- [ ] 3.2 Create `src/services/oauth-state.store.js` — an in-memory `Map<state, { codeVerifier, provider, clientType, createdAt }>` with `set`, `consume`, and a 5-minute TTL sweep on each access
- [ ] 3.3 Create `src/services/oauth.service.js` exporting:
  - `buildAuthorizeUrl({ provider, clientType })` → returns `{ url, state }` and stores the entry
  - `completeCallback({ provider, code, state })` → consumes state, exchanges code for tokens at the provider's token endpoint, fetches the user profile, returns `{ providerUserId, email, username, clientType }`
- [ ] 3.4 Create `src/services/user-auth.service.js` exporting `findOrCreateOAuthUser({ provider, providerUserId, email, username })` that uses `User.findOrCreate` on the composite key; on `username` uniqueness collision, append `-${providerUserId.slice(0,8)}` then `-${random6}` as fallbacks

## 4. Middleware

- [ ] 4.1 Create `src/middleware/auth.middleware.js` exporting `verifyJwt(req, res, next)` that reads from `Authorization: Bearer <jwt>` OR `req.cookies.session`, calls `jwt.verify`, sets `req.user = { id: payload.sub, provider: payload.provider }`, and on any failure responds `401` with the appropriate body (`Authentication required` / `Invalid token` / `Token expired`)

## 5. Controllers and routes

- [ ] 5.1 Create `src/controllers/auth.controller.js` with `startOAuth`, `oauthCallback`, `getMe`, `logout`
  - `startOAuth`: reads `:provider` and `client_type` from query (default `web`), calls `buildAuthorizeUrl`, `res.redirect(302, url)`
  - `oauthCallback`: reads `:provider`, `code`, `state` (and `error` for provider failures); calls `completeCallback` then `findOrCreateOAuthUser`; signs a JWT; for `clientType === 'web'` sets `session` cookie + redirects to `WEB_APP_URL`; for `vscode` redirects to `${VSCODE_DEEPLINK}?token=<jwt>`
  - `getMe`: returns `{ id, username, email, provider }` from `req.user` (resolves `username`/`email` via `User.findByPk`)
  - `logout`: clears `session` cookie, returns `204`
- [ ] 5.2 Create `src/routes/auth.routes.js` mounting all four endpoints; `auth/me` and `auth/logout` use `verifyJwt`
- [ ] 5.3 In `src/server.js`: add `cookie-parser` middleware, mount `auth.routes.js` at `/api/v1`

## 6. Wire auth into telemetry

- [ ] 6.1 Update `src/routes/telemetry.routes.js`: prepend `verifyJwt` before `validateRequest`
- [ ] 6.2 Update `src/controllers/telemetry.controller.js`: replace `req.body` with `{ user_id: req.user.id, events: req.body.events }` when calling `ingestBatch`
- [ ] 6.3 Update `src/services/telemetry.service.js`: drop the `UserNotFoundError` path — the JWT guarantees the user exists at issuance time, but keep a defensive `findByPk` because the user could have been deleted between issuance and use (still throw `UserNotFoundError`, still mapped to 404 by the controller — this case now means "your account was deleted")
- [ ] 6.4 Update the `TelemetryBatch` JSON schema reference in `validation.middleware.js` (no code change needed if it pulls from `openspec.yaml` at runtime — verify `user_id` is gone from the openapi doc and reload behaves)

## 7. Manual verification — Google web flow

- [ ] 7.1 Start server (`node src/server.js`). Open `http://localhost:3000/api/v1/auth/google?client_type=web` in a browser
- [ ] 7.2 Complete Google consent. Expect to be redirected to `WEB_APP_URL` with a `session` cookie set (verify in DevTools → Application → Cookies; httpOnly, Lax)
- [ ] 7.3 In the same browser tab, `fetch('/api/v1/auth/me').then(r => r.json())` should return `{ id, username, email, provider: 'google' }`
- [ ] 7.4 `psql` to confirm exactly one `users` row exists for that Google identity

## 8. Manual verification — GitHub VS Code flow

- [ ] 8.1 Open `http://localhost:3000/api/v1/auth/github?client_type=vscode` in a browser
- [ ] 8.2 Complete GitHub consent. Expect a `302` to `vscode://devflow.devflow/auth-callback?token=<jwt>`. The browser will prompt to open VS Code — for verification, copy the `token` query param manually
- [ ] 8.3 `curl -H "Authorization: Bearer <jwt>" http://localhost:3000/api/v1/auth/me` should return the user's profile

## 9. Manual verification — telemetry under auth

- [ ] 9.1 With a fresh JWT in hand, `curl -X POST http://localhost:3000/api/v1/telemetry -H "Authorization: Bearer <jwt>" -H 'Content-Type: application/json' -d '{"events":[{"event_type":"file_save","timestamp":"2026-05-12T15:00:00Z","session_id":"<uuid>","file_path":"src/x.js","metadata":{"lines_added":3}}]}'` — expect `202` (note: no `user_id` in the body)
- [ ] 9.2 Same call without the Authorization header — expect `401 {"error":"Authentication required"}`, no rows written
- [ ] 9.3 Same call with a tampered JWT (flip one character in the signature) — expect `401 {"error":"Invalid token"}`
- [ ] 9.4 Same call with a JWT whose `exp` is in the past (mint a test token with `exp: 1` for this) — expect `401 {"error":"Token expired"}`
- [ ] 9.5 `psql` to confirm activities are linked to the correct `user_id` (the JWT's `sub`), not whatever was in the body

## 10. Manual verification — edge cases

- [ ] 10.1 Hit `/api/v1/auth/facebook` — expect `400 {"error":"Unsupported provider"}`
- [ ] 10.2 Hit `/api/v1/auth/google/callback?code=fake&state=never-issued` — expect `400 {"error":"Invalid or expired state"}`
- [ ] 10.3 Replay a successful callback URL — expect `400` on the second hit (state was consumed)
- [ ] 10.4 Wait 6 minutes after starting an OAuth flow without completing it; complete it — expect `400 {"error":"Invalid or expired state"}`
- [ ] 10.5 `POST /api/v1/auth/logout` with the cookie set — verify response is `204` and `Set-Cookie: session=; Max-Age=0`
