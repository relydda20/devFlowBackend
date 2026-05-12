## ADDED Requirements

### Requirement: Token issuance endpoint
The system SHALL expose `POST /api/v1/auth/tokens`, protected by JWT auth middleware, that accepts `{ name }` (1–64 chars), generates a 32-byte random secret, persists `ApiToken { user_id, name, token_hash: sha256(prefix + secret), token_prefix: <first 6 chars of secret>, last_used_at: null, revoked_at: null }`, and returns the unhashed token exactly once as `dvf_<secret>`.

#### Scenario: Authenticated user mints a token
- **WHEN** a JWT-authenticated user POSTs `{ name: "Work laptop" }` to `/api/v1/auth/tokens`
- **THEN** the server responds with HTTP `201` and body `{ id, name, token: "dvf_<secret>", token_prefix, created_at }`, and a new `ApiToken` row exists with `user_id` equal to the JWT subject

#### Scenario: Unauthenticated request is rejected
- **WHEN** a client POSTs to `/api/v1/auth/tokens` without a valid JWT (an API token is NOT accepted on this endpoint)
- **THEN** the server responds with HTTP `401`

#### Scenario: Schema-invalid request
- **WHEN** a client posts `{}` or `{ name: "" }` or `{ name: <65+ chars> }`
- **THEN** the server responds with HTTP `400` and `{ error: "Validation failed", details: [...] }`; no token is issued

#### Scenario: Token is returned exactly once
- **WHEN** a token is issued via `POST /api/v1/auth/tokens`
- **THEN** the unhashed `token` field appears in the response body of that call and in no subsequent listing, retrieval, or log

### Requirement: Token storage uses irreversible hash
The system SHALL persist API tokens as SHA-256 hashes of the unhashed secret; the plaintext token SHALL NOT be stored in the database or any persistent log.

#### Scenario: token_hash is not the plaintext
- **WHEN** an `ApiToken` row exists
- **THEN** its `token_hash` column is a 64-character lowercase hex string and is NOT equal to (or substring of) the unhashed secret

#### Scenario: Plaintext is absent from logs
- **WHEN** a token is issued, used, or revoked
- **THEN** the plaintext `dvf_<secret>` value does NOT appear in any winston log entry, request log, or error stack

### Requirement: Token verification
The system SHALL verify a bearer token of form `dvf_<secret>` by computing SHA-256 of the secret and looking up an active `ApiToken` row (`revoked_at IS NULL`) whose `token_hash` matches; on match it SHALL load the associated `User` and attach `req.user = { id, auth_method: 'api_token', token_id }` to the request.

#### Scenario: Active token verifies
- **WHEN** the middleware processes a request with `Authorization: Bearer dvf_<secret>` whose hash matches an active row
- **THEN** the request proceeds with `req.user.id` set to the token's `user_id` and `req.user.auth_method` set to `'api_token'`

#### Scenario: Revoked token does not verify
- **WHEN** the middleware processes a request with a token whose row has `revoked_at != NULL`
- **THEN** the request is rejected with HTTP `401`

#### Scenario: Non-existent hash does not verify
- **WHEN** the middleware processes a `dvf_`-prefixed token whose hash matches no row
- **THEN** the request is rejected with HTTP `401`

#### Scenario: last_used_at is updated on each successful verification
- **WHEN** a request authenticates successfully with an API token
- **THEN** the corresponding `ApiToken` row's `last_used_at` is updated to the current UTC time (within the same request lifecycle)

### Requirement: Token revocation endpoint
The system SHALL expose `DELETE /api/v1/auth/tokens/:id`, protected by JWT auth middleware, that marks the caller's own `ApiToken` row as revoked by setting `revoked_at = NOW()`. Users SHALL only be able to revoke tokens they own.

#### Scenario: User revokes their own token
- **WHEN** a JWT-authenticated user calls `DELETE /api/v1/auth/tokens/<their-token-id>`
- **THEN** the server responds with HTTP `204`, the row's `revoked_at` is set, and subsequent requests using that token receive HTTP `401`

#### Scenario: User cannot revoke another user's token
- **WHEN** a JWT-authenticated user calls `DELETE /api/v1/auth/tokens/<other-users-token-id>`
- **THEN** the server responds with HTTP `404` (treated identically to a non-existent token, to prevent enumeration); the other user's token remains active

#### Scenario: API token cannot revoke tokens
- **WHEN** a client authenticated by an API token (not a JWT) calls `DELETE /api/v1/auth/tokens/<any-id>`
- **THEN** the server responds with HTTP `403` and the token is not revoked

### Requirement: Token listing endpoint
The system SHALL expose `GET /api/v1/auth/tokens`, protected by JWT auth middleware, that returns the caller's tokens with `id`, `name`, `token_prefix`, `last_used_at`, `created_at`, and `revoked_at`, but never the plaintext token or its hash.

#### Scenario: User lists their tokens
- **WHEN** a JWT-authenticated user calls `GET /api/v1/auth/tokens`
- **THEN** the response is HTTP `200` and body `{ tokens: [{ id, name, token_prefix, last_used_at, created_at, revoked_at }, ...] }`, including both active and revoked tokens, and NEVER including `token_hash` or any plaintext value

#### Scenario: Listing is scoped to caller
- **WHEN** user A and user B each have tokens, and user A calls `GET /api/v1/auth/tokens`
- **THEN** the response contains only user A's tokens
