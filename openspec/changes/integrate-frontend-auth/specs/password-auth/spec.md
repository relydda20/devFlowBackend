## MODIFIED Requirements

### Requirement: Register endpoint
The system SHALL expose `POST /api/v1/auth/register` that accepts `{ email, password, username? }`, creates a `User` row with `provider='password'`, hashes the password with bcrypt (cost factor 12), and returns the newly created user plus a JWT. The response MUST set a `session` cookie containing the same token. The cookie's `SameSite` and `Secure` attributes MUST adapt to the runtime environment so that the cookie functions on both same-origin local development and cross-origin production deployments.

When `NODE_ENV === 'production'`, the cookie MUST be set with `SameSite=None; Secure=true; HttpOnly=true`. In all other environments, the cookie MUST be set with `SameSite=Lax; Secure=false; HttpOnly=true`. Both modes use `Path=/` and `Max-Age` equal to the JWT lifetime (7 days).

#### Scenario: Successful registration
- **WHEN** a client posts `{ email: "alice@example.com", password: "correct horse battery staple" }`
- **THEN** the server creates a `User` with `provider='password'`, `provider_user_id='alice@example.com'`, `email='alice@example.com'`, a bcrypt hash in `password_hash`, and a username derived from the email's local-part (`alice`); the response is HTTP `201` with body `{ user: { id, username, email, provider }, token }` and a `session` cookie containing the same token

#### Scenario: Email already registered
- **WHEN** a client posts a registration with an email that already exists for `provider='password'`
- **THEN** the server responds with HTTP `409` and body `{ error: "Email already registered" }`; no row is written

#### Scenario: Schema-invalid request
- **WHEN** a client posts a body missing `email` or `password`, or with a password shorter than 8 characters, or with a malformed email
- **THEN** the server responds with HTTP `400` and body `{ error: "Validation failed", details: [...] }`; no row is written

#### Scenario: Username collision auto-resolves
- **WHEN** a client registers with email `alice@example.com` and a user named `alice` already exists
- **THEN** the new user is created with a fallback username (`alice-<random>`) so the unique constraint on `username` is not violated

#### Scenario: Production cookie attributes
- **WHEN** the server is running with `NODE_ENV=production` and a successful registration completes
- **THEN** the `Set-Cookie` header on the response includes `SameSite=None`, `Secure`, `HttpOnly`, `Path=/`, and `Max-Age=604800` (7 days)

#### Scenario: Development cookie attributes
- **WHEN** the server is running with `NODE_ENV` unset or non-production and a successful registration completes
- **THEN** the `Set-Cookie` header on the response includes `SameSite=Lax`, `HttpOnly`, `Path=/`, and `Max-Age=604800`, and does NOT include `Secure`

### Requirement: Login endpoint
The system SHALL expose `POST /api/v1/auth/login` that accepts `{ email, password }`, verifies the password against the stored bcrypt hash, and returns a JWT on success. The response MUST set the `session` cookie with the same environment-dependent attributes as the Register endpoint.

#### Scenario: Correct credentials
- **WHEN** a registered user posts their correct email and password
- **THEN** the server responds with HTTP `200` and body `{ user: { id, username, email, provider }, token }`, and sets the `session` cookie to the token using the same attributes documented in the Register endpoint scenarios

#### Scenario: Wrong password
- **WHEN** a registered user posts their email with a wrong password
- **THEN** the server responds with HTTP `401` and body `{ error: "Invalid credentials" }` — same response shape and timing as for a non-existent email

#### Scenario: Email not registered
- **WHEN** a client posts an email that has no corresponding `provider='password'` user
- **THEN** the server responds with HTTP `401` and body `{ error: "Invalid credentials" }` — identical to the wrong-password case, to prevent account enumeration

#### Scenario: Email is normalized for lookup
- **WHEN** a user registered as `Alice@Example.com` posts `alice@example.com` (lowercased) at login
- **THEN** the login succeeds — both forms map to the same `User`

## ADDED Requirements

### Requirement: Cross-origin requests with credentials are accepted from allow-listed origins

The system SHALL accept cross-origin requests with credentials (cookies) from origins listed in the `CORS_ALLOWED_ORIGINS` environment variable. The variable contains a comma-separated list of exact origins (no wildcards). Requests from any other origin MUST NOT succeed in a credentialed cross-site context.

The system MUST also accept requests with no `Origin` header (e.g., from `curl`, server-to-server calls, the VS Code extension's API token POSTs) — CORS gates browser cross-origin traffic, not all traffic.

#### Scenario: Login from an allow-listed origin
- **WHEN** the browser at `https://who-goes-to-try.hackathon.sev-2.com` issues `POST /api/v1/auth/login` with `credentials: 'include'`
- **AND** `CORS_ALLOWED_ORIGINS` includes `https://who-goes-to-try.hackathon.sev-2.com`
- **THEN** the response carries `Access-Control-Allow-Origin: https://who-goes-to-try.hackathon.sev-2.com` and `Access-Control-Allow-Credentials: true`
- **AND** the browser stores the `session` cookie
- **AND** subsequent credentialed requests from the same origin attach the cookie

#### Scenario: Request from a non-allow-listed origin
- **WHEN** a browser at `https://evil.example` issues a credentialed request to any API endpoint
- **AND** `https://evil.example` is not in `CORS_ALLOWED_ORIGINS`
- **THEN** the response does NOT carry an `Access-Control-Allow-Origin` header for `https://evil.example`
- **AND** the browser blocks the request from completing in JavaScript

#### Scenario: Request with no Origin header
- **WHEN** a client (curl, server, extension) issues a request with no `Origin` header
- **THEN** the request is processed normally (authentication still applies; CORS is not a barrier)

#### Scenario: Multiple origins in the allowlist
- **WHEN** `CORS_ALLOWED_ORIGINS` is `https://prod.example,https://staging.example`
- **THEN** both origins are accepted; the `Access-Control-Allow-Origin` response header mirrors the requesting origin (not a wildcard)

#### Scenario: Empty or unset allowlist
- **WHEN** `CORS_ALLOWED_ORIGINS` is unset or empty
- **THEN** no browser cross-origin request from any non-null Origin succeeds
- **AND** the server still serves requests with no `Origin` header (extension, curl)
