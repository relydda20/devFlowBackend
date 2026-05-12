## ADDED Requirements

### Requirement: Pairing creation endpoint

The system SHALL expose `POST /api/v1/auth/pairings` (no authentication required) that creates a new pending pairing row and returns the identifiers the extension needs to direct the user to the browser and to poll for completion. The response body SHALL be `{ pairing_id: <UUID v4>, user_code: <8-char readable code>, verification_uri: "<frontend-origin>/extension/pair", expires_in: 600 }`. The `user_code` SHALL be drawn from the alphabet `BCDFGHJKMNPQRSTVWXZ23456789` (no vowels, no `0/O/1/I/l`) and formatted as `XXXX-XXXX`. A new `PairingCode` row SHALL be persisted with `status='pending'`, `expires_at = NOW() + 10 minutes`, and `user_id`, `api_token_id`, `token_plaintext` all `NULL`.

#### Scenario: Extension requests a pairing
- **WHEN** an unauthenticated client POSTs to `/api/v1/auth/pairings`
- **THEN** the server responds with HTTP `201` and body `{ pairing_id, user_code, verification_uri, expires_in: 600 }`, and a new `pairing_codes` row exists with `status='pending'` and `expires_at` roughly ten minutes in the future

#### Scenario: user_code uses unambiguous alphabet
- **WHEN** the server generates a `user_code`
- **THEN** the code contains only characters from `BCDFGHJKMNPQRSTVWXZ23456789` and matches the regex `^[BCDFGHJKMNPQRSTVWXZ23456789]{4}-[BCDFGHJKMNPQRSTVWXZ23456789]{4}$`

#### Scenario: pairing_id is not derivable from user_code
- **WHEN** two pairings are created
- **THEN** their `pairing_id` UUIDs are unrelated to their `user_code` values (the `user_code` cannot be used to look up the `pairing_id`, and the response is the only place both values appear together)

### Requirement: Pairing approval endpoint

The system SHALL expose `POST /api/v1/auth/pairings/:user_code/approve`, protected by JWT authentication, that the frontend calls when a logged-in user clicks **Approve** on the pairing page. The endpoint SHALL: locate the pending `PairingCode` row by `user_code`, reject if missing or expired or already-approved, mint a `dvf_` API token via `issueToken(req.user.id, "VSCode (paired YYYY-MM-DD)")`, and update the row to `status='approved'`, `user_id=req.user.id`, `api_token_id=<issued.id>`, `token_plaintext=<issued.token>` atomically. The response SHALL be HTTP `200` with body `{ ok: true }` — the plaintext token SHALL NOT appear in the approve response.

#### Scenario: Logged-in user approves a pending pairing
- **WHEN** a JWT-authenticated user POSTs to `/api/v1/auth/pairings/BRWN-4F2X/approve` for an existing pending row
- **THEN** the server responds with HTTP `200` body `{ ok: true }`; the row's `status` is now `'approved'`, `user_id` equals the JWT subject, `api_token_id` references a freshly created active `ApiToken` row, and `token_plaintext` holds the `dvf_<secret>` value

#### Scenario: Approve without authentication is rejected
- **WHEN** an unauthenticated client POSTs to `/api/v1/auth/pairings/<user_code>/approve`
- **THEN** the server responds with HTTP `401` and the row is unchanged

#### Scenario: API-token-authenticated client cannot approve
- **WHEN** a client authenticated by an API token (not a JWT) POSTs to `/api/v1/auth/pairings/<user_code>/approve`
- **THEN** the server responds with HTTP `403` and the row is unchanged (an extension cannot use its own token to approve another pairing)

#### Scenario: Approving an unknown user_code is a 404
- **WHEN** a JWT-authenticated user POSTs to `/api/v1/auth/pairings/ZZZZ-ZZZZ/approve` and no row matches
- **THEN** the server responds with HTTP `404` and `{ error: "Pairing not found or expired" }`

#### Scenario: Approving an expired pairing is rejected
- **WHEN** a JWT-authenticated user POSTs `/approve` for a row whose `expires_at < NOW()`
- **THEN** the server responds with HTTP `410` `{ error: "Pairing expired" }`; the row is deleted; no token is issued

#### Scenario: Approving an already-approved pairing is rejected
- **WHEN** a JWT-authenticated user POSTs `/approve` for a row whose `status != 'pending'`
- **THEN** the server responds with HTTP `409` `{ error: "Pairing already used" }` and no second token is issued

### Requirement: Pairing exchange (polling) endpoint

The system SHALL expose `POST /api/v1/auth/pairings/:pairing_id/exchange` (no authentication required) that the extension polls. The response SHALL be one of:
- `{ status: "pending" }` with HTTP `200` while the row is `status='pending'`
- `{ status: "approved", token: "dvf_<secret>" }` with HTTP `200` on the FIRST call while `status='approved'` — in the same database transaction the row SHALL be updated to `status='consumed'` and `token_plaintext=NULL`
- `{ status: "consumed" }` with HTTP `200` on any subsequent call after the token has been delivered
- `{ status: "expired" }` with HTTP `410` if the row is missing or `expires_at < NOW()`

The endpoint SHALL be rate-limited per `pairing_id` to at most one request per second; excess requests SHALL receive HTTP `429`.

#### Scenario: Extension polls while pending
- **WHEN** the extension POSTs to `/api/v1/auth/pairings/<pairing_id>/exchange` and the row's `status` is `'pending'`
- **THEN** the response is HTTP `200` body `{ status: "pending" }` and no row state changes

#### Scenario: First exchange after approval returns the token
- **WHEN** the extension POSTs to `/exchange` and the row's `status` is `'approved'` with `token_plaintext` set
- **THEN** the response is HTTP `200` body `{ status: "approved", token: "dvf_<secret>" }`; the row is updated in the same transaction to `status='consumed'` and `token_plaintext=NULL`

#### Scenario: Second exchange after delivery returns consumed
- **WHEN** a second client POSTs to `/exchange` for a `pairing_id` whose status is already `'consumed'`
- **THEN** the response is HTTP `200` body `{ status: "consumed" }` and no token is returned

#### Scenario: Expired pairing returns 410
- **WHEN** the extension POSTs to `/exchange` for a `pairing_id` whose row is missing OR whose `expires_at < NOW()`
- **THEN** the response is HTTP `410` body `{ status: "expired" }`; if the row still exists it is deleted

#### Scenario: Rate limit prevents rapid polling
- **WHEN** an extension POSTs to `/exchange` for the same `pairing_id` more than once within a single second
- **THEN** the second request receives HTTP `429` `{ error: "Too many requests" }` and the underlying row state is not consulted

#### Scenario: Plaintext token is never logged
- **WHEN** the exchange endpoint serves an `approved` response
- **THEN** the `dvf_<secret>` value does not appear in any winston log entry, request log line, or error stack from this request

### Requirement: Pairing data lifecycle

The system SHALL persist pairing rows in a `pairing_codes` table with columns `id (UUID, PK)`, `user_code (varchar(9), unique while pending)`, `status (enum: pending|approved|consumed)`, `user_id (FK users.id, nullable)`, `api_token_id (FK api_tokens.id, nullable)`, `token_plaintext (text, nullable)`, `expires_at (timestamptz)`, `created_at (timestamptz)`. Rows SHALL be deleted on exchange-after-expiry, and a periodic cleanup SHALL delete rows with `expires_at < NOW() - 1 hour` for hygiene.

#### Scenario: Schema and indexes
- **WHEN** the migration runs
- **THEN** a `pairing_codes` table exists with the specified columns, an index on `user_code` for fast approve lookups, and an index on `expires_at` for the cleanup sweep

#### Scenario: Periodic cleanup removes stale rows
- **WHEN** the periodic cleanup runs
- **THEN** every row with `expires_at < NOW() - 1 hour` is deleted; rows still within their expiry window are untouched; rows in `status='approved'` waiting for first exchange (within their TTL) are NOT deleted

#### Scenario: token_plaintext is never read after consumption
- **WHEN** a row's `status` is `'consumed'`
- **THEN** its `token_plaintext` column is `NULL` (set in the same transaction that returned the token)

### Requirement: Frontend approval page

The frontend SHALL serve a route at `/extension/pair` that reads the `code` query parameter, displays it prominently for visual confirmation against what the extension shows, and renders an **Approve** button. The route SHALL be wrapped in the existing `ProtectedRoute` so that unauthenticated visitors are redirected to `/login?redirect=/extension/pair?code=<code>` and brought back after login. Clicking **Approve** SHALL POST to `/api/v1/auth/pairings/<code>/approve` with credentials and surface a success or error state inline.

#### Scenario: Logged-in user sees the approval page
- **WHEN** an authenticated user opens `/extension/pair?code=BRWN-4F2X`
- **THEN** the page renders the code `BRWN-4F2X` prominently and an enabled **Approve** button

#### Scenario: Unauthenticated user is redirected
- **WHEN** an unauthenticated user opens `/extension/pair?code=BRWN-4F2X`
- **THEN** the user is redirected to `/login?redirect=%2Fextension%2Fpair%3Fcode%3DBRWN-4F2X`, and after successful login is brought back to the approval page with the code intact

#### Scenario: Approve click succeeds
- **WHEN** an authenticated user clicks **Approve** on `/extension/pair?code=BRWN-4F2X` for a valid pending pairing
- **THEN** the page calls `POST /api/v1/auth/pairings/BRWN-4F2X/approve` with `credentials: 'include'`, receives HTTP `200`, and shows a success message such as "Extension approved — you can return to VSCode"

#### Scenario: Approve click on expired or missing pairing
- **WHEN** an authenticated user clicks **Approve** and the backend responds with HTTP `404` or `410`
- **THEN** the page shows an inline error such as "This pairing code is no longer valid. Please start a new sign-in from VSCode."

### Requirement: Extension browser-pairing sign-in command

The extension SHALL register the `devvitalAI.signIn` command to perform browser pairing: call `POST /api/v1/auth/pairings`, open `<verification_uri>?code=<user_code>` via `vscode.env.openExternal`, show a progress notification displaying the `user_code` with a Cancel action, and poll `POST /api/v1/auth/pairings/<pairing_id>/exchange` every 2 seconds. On `{ status: 'approved', token }` the extension SHALL store the token via the existing `AuthService.setToken` and dismiss the notification with a success message. On expired/cancelled/expired-status the extension SHALL surface an error and store nothing.

#### Scenario: Successful pairing
- **WHEN** the user runs `DevVital AI: Sign In`, approves in the browser within the TTL, and the extension's next poll returns `{ status: 'approved', token: 'dvf_...' }`
- **THEN** the extension calls `auth.setToken('dvf_...')`, dismisses the progress notification, shows "DevVital AI: signed in.", and starts the sync service

#### Scenario: User cancels the progress notification
- **WHEN** the user clicks Cancel on the progress notification before approval
- **THEN** the polling loop terminates within one poll interval, no token is stored, and no error toast is shown (cancellation is a deliberate user action, not a failure)

#### Scenario: Pairing expires before approval
- **WHEN** polling returns HTTP `410` `{ status: 'expired' }`
- **THEN** the extension stops polling, dismisses the progress notification, shows "DevVital AI: pairing expired — please try again.", and no token is stored

#### Scenario: Transient polling failure recovers
- **WHEN** a poll returns a 5xx or network error
- **THEN** the extension backs off (2s → 4s → 8s → 16s, cap 30s) and continues polling until either success, expiry, or user cancel — a single transient failure does not abort the flow

### Requirement: Extension token-paste fallback command

The extension SHALL register a separate command `devvitalAI.signInWithToken` that runs the legacy paste-token UX (`vscode.window.showInputBox` validating the `dvf_` prefix, then `auth.setToken`) for users who cannot open a browser. This command SHALL be discoverable in the Command Palette and SHALL behave identically to the pre-change `signIn` command body.

#### Scenario: Headless user pastes a token
- **WHEN** the user runs `DevVital AI: Sign In with Token`, pastes `dvf_<secret>`, and submits
- **THEN** the extension validates the prefix, calls `auth.setToken`, runs a sync to confirm the token is accepted, and on success shows "DevVital AI: signed in."

#### Scenario: Re-auth prompt offers both options
- **WHEN** the extension surfaces a re-auth prompt after a 401 from the backend
- **THEN** the prompt offers Sign In (browser pairing) as the primary action; the user can also reach the paste-token flow via the Command Palette without further prompting
