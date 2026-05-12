## ADDED Requirements

### Requirement: Start OAuth flow
The system SHALL expose `GET /api/v1/auth/:provider` (where `:provider` is `google` or `github`) that initiates the OAuth 2.0 Authorization Code flow with PKCE and redirects the user to the provider's consent screen.

#### Scenario: Web client starts Google login
- **WHEN** a browser requests `GET /api/v1/auth/google?client_type=web`
- **THEN** the server generates a random `state` and `code_verifier`, stores them in the in-memory state map with a 5-minute TTL, and responds with HTTP `302` redirecting to Google's authorization endpoint with `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `scope`, and `state` query parameters

#### Scenario: Extension client starts GitHub login
- **WHEN** the VS Code extension opens `GET /api/v1/auth/github?client_type=vscode` in the user's browser
- **THEN** the server stores `clientType: 'vscode'` alongside the state entry so the callback knows to deep-link

#### Scenario: Unknown provider is rejected
- **WHEN** a client requests `GET /api/v1/auth/facebook`
- **THEN** the server responds with HTTP `400` and a body `{ error: "Unsupported provider" }`

### Requirement: Complete OAuth callback
The system SHALL expose `GET /api/v1/auth/:provider/callback` that finishes the OAuth handshake, finds-or-creates a `User` row, issues a signed JWT, and delivers it to the client per the client_type recorded at start.

#### Scenario: Successful Google callback for web client
- **WHEN** Google redirects back to `/api/v1/auth/google/callback?code=...&state=...` and the state matches a stored entry with `clientType: 'web'`
- **THEN** the server exchanges the code for tokens at Google's token endpoint (passing the stored `code_verifier`), fetches the user's profile, finds-or-creates a `User` keyed on `(provider='google', provider_user_id=<google_sub>)`, mints a JWT, sets it in an `httpOnly Secure SameSite=Lax` cookie named `session`, and responds with HTTP `302` redirecting to `WEB_APP_URL`

#### Scenario: Successful GitHub callback for VS Code client
- **WHEN** GitHub redirects back to `/api/v1/auth/github/callback?code=...&state=...` and the state matches a stored entry with `clientType: 'vscode'`
- **THEN** the server completes the same flow but instead responds with HTTP `302` redirecting to `${VSCODE_DEEPLINK}?token=<jwt>` and does NOT set a cookie

#### Scenario: State mismatch is rejected
- **WHEN** the callback arrives with a `state` value that is not in the state map (expired, never issued, or replay)
- **THEN** the server responds with HTTP `400` and a body `{ error: "Invalid or expired state" }`, no `User` is created, no JWT is issued

#### Scenario: State is single-use
- **WHEN** the callback succeeds and a state entry is consumed
- **THEN** a second request with the same `state` value responds with HTTP `400` (the state was deleted on first use)

#### Scenario: Provider returns an error
- **WHEN** the provider redirects to the callback with `?error=access_denied` instead of `?code=...`
- **THEN** the server responds with HTTP `400` and includes the provider's error code in the body, no `User` is created

### Requirement: User uniqueness per provider identity
The system SHALL ensure at most one `User` row exists for any `(provider, provider_user_id)` pair.

#### Scenario: Returning user signs in again
- **WHEN** a user who previously signed in via Google completes the Google OAuth flow again
- **THEN** no new `User` row is created; the existing row is loaded and its `id` is used in the issued JWT

#### Scenario: Same email across providers creates two Users
- **WHEN** a user signs in with `alice@example.com` via Google, then signs in with `alice@example.com` via GitHub
- **THEN** two distinct `User` rows exist (one per `(provider, provider_user_id)` pair), each with their own UUID

### Requirement: JWT issuance and claims
The system SHALL mint JWTs signed with `JWT_SECRET` (HS256) containing `sub` (User UUID), `provider`, `iat`, and `exp` claims.

#### Scenario: Token decodes to expected claims
- **WHEN** a JWT issued by the callback is decoded
- **THEN** it contains `sub` (matching the User's UUID), `provider` (`google` or `github`), `iat` (issued-at timestamp), and `exp` (expiry timestamp, no more than 7 days after `iat`)

### Requirement: JWT verification middleware
The system SHALL provide middleware that accepts a JWT from either `Authorization: Bearer <jwt>` or a `session` cookie, verifies it, and attaches `req.user = { id, provider }` on success.

#### Scenario: Valid Bearer token
- **WHEN** a request arrives with `Authorization: Bearer <valid-jwt>`
- **THEN** the middleware decodes and verifies the token, sets `req.user = { id: <sub>, provider: <provider> }`, and calls `next()`

#### Scenario: Valid session cookie
- **WHEN** a request arrives with `Cookie: session=<valid-jwt>` and no Authorization header
- **THEN** the middleware reads the cookie and the same flow applies

#### Scenario: Missing credential
- **WHEN** a request arrives with neither header nor cookie
- **THEN** the middleware responds with HTTP `401` and body `{ error: "Authentication required" }`, no downstream handler runs

#### Scenario: Invalid signature
- **WHEN** the token signature does not verify against `JWT_SECRET`
- **THEN** the middleware responds with HTTP `401` and body `{ error: "Invalid token" }`

#### Scenario: Expired token
- **WHEN** the token's `exp` is in the past
- **THEN** the middleware responds with HTTP `401` and body `{ error: "Token expired" }`

### Requirement: Current user endpoint
The system SHALL expose `GET /api/v1/auth/me` (auth-protected) that returns the current user's profile.

#### Scenario: Authenticated request
- **WHEN** a client calls `GET /api/v1/auth/me` with a valid JWT
- **THEN** the server responds with HTTP `200` and body `{ id, username, email, provider }`

#### Scenario: Unauthenticated request
- **WHEN** the JWT is missing or invalid
- **THEN** the server responds with HTTP `401` (handled by the middleware)

### Requirement: Logout clears the cookie
The system SHALL expose `POST /api/v1/auth/logout` that clears the `session` cookie (when present).

#### Scenario: Browser logout
- **WHEN** a browser posts to `/api/v1/auth/logout` with the `session` cookie set
- **THEN** the response sets `session` to an empty value with `Max-Age=0` and returns HTTP `204`

#### Scenario: Extension logout is client-side
- **WHEN** the VS Code extension wishes to "log out"
- **THEN** it discards its stored JWT locally; no server call is required, and any subsequent requests using the discarded token continue to validate until expiry (documented limitation)

### Requirement: OAuth secrets are not exposed to clients
The system SHALL keep `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, and `JWT_SECRET` server-side only, never returning them in any response and never logging them.

#### Scenario: Any response body
- **WHEN** any endpoint returns a response
- **THEN** the body MUST NOT contain `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`, or the provider's access token
