## ADDED Requirements

### Requirement: Register endpoint
The system SHALL expose `POST /api/v1/auth/register` that accepts `{ email, password, username? }`, creates a `User` row with `provider='password'`, hashes the password with bcrypt (cost factor 12), and returns the newly created user plus a JWT.

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

### Requirement: Login endpoint
The system SHALL expose `POST /api/v1/auth/login` that accepts `{ email, password }`, verifies the password against the stored bcrypt hash, and returns a JWT on success.

#### Scenario: Correct credentials
- **WHEN** a registered user posts their correct email and password
- **THEN** the server responds with HTTP `200` and body `{ user: { id, username, email, provider }, token }`, and sets the `session` cookie to the token

#### Scenario: Wrong password
- **WHEN** a registered user posts their email with a wrong password
- **THEN** the server responds with HTTP `401` and body `{ error: "Invalid credentials" }` — same response shape and timing as for a non-existent email

#### Scenario: Email not registered
- **WHEN** a client posts an email that has no corresponding `provider='password'` user
- **THEN** the server responds with HTTP `401` and body `{ error: "Invalid credentials" }` — identical to the wrong-password case, to prevent account enumeration

#### Scenario: Email is normalized for lookup
- **WHEN** a user registered as `Alice@Example.com` posts `alice@example.com` (lowercased) at login
- **THEN** the login succeeds — both forms map to the same `User`

### Requirement: Password hashing
The system SHALL hash passwords with bcrypt using a cost factor of at least 12 before storing, and SHALL never store, log, or return the plaintext password.

#### Scenario: Hash is not the plaintext
- **WHEN** a registration completes
- **THEN** the `password_hash` column stores a bcrypt hash beginning with `$2`, of length ≥ 60, and not equal to the submitted password

#### Scenario: Password is never returned
- **WHEN** any auth endpoint returns a response
- **THEN** the response body and headers MUST NOT contain the plaintext password or the bcrypt hash

### Requirement: Logout works for password users
The system SHALL accept `POST /api/v1/auth/logout` from password-authenticated clients and clear the `session` cookie in the same way as for OAuth-authenticated clients.

#### Scenario: Browser logout
- **WHEN** a client with a password-issued `session` cookie posts to `/api/v1/auth/logout`
- **THEN** the response sets `session=` with `Max-Age=0` and returns HTTP `204`

### Requirement: Password JWTs are interchangeable with OAuth JWTs
The system SHALL accept JWTs issued by the password-auth flow on every authenticated endpoint that already accepts OAuth-issued JWTs, with no per-endpoint changes.

#### Scenario: Password JWT works for telemetry
- **WHEN** a password-authenticated client posts to `POST /api/v1/telemetry` with their JWT in `Authorization: Bearer ...`
- **THEN** the request succeeds with the same behavior as an OAuth-authenticated client, and the resulting `Activity` rows are linked to the password user's id

#### Scenario: Password JWT works for /auth/me
- **WHEN** a password-authenticated client calls `GET /api/v1/auth/me`
- **THEN** the response contains `{ id, username, email, provider: 'password' }`
